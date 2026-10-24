/**
 * Engine facade: what the Harness plugin, the CLI, and tests talk to.
 * Owned by the Lead.
 *
 * Responsibilities:
 *  - resolve layered config + secrets, expose paths
 *  - construct the broker for the configured mode (sim / paper / live)
 *  - construct the orchestrator and own its lifecycle
 *  - start the EXTERNAL Reaper process for paper/live (never for sim) and report its pid
 *  - serve read-only views (status, obituaries, brakes, config) that never leak secrets
 *
 * The Reaper deliberately has no stop/disable method here: once spawned, the engine has no
 * control surface over it. Only the operating system / the operator can end that process.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  configSummary,
  hasCredentials,
  liveArmed,
  loadConfig,
  publicConfig,
  resolveCredentials,
  statePaths,
} from './config.js';
import { createAutomaton } from './orchestrator.js';
import { createBroker as createAlpacaBroker } from './broker-alpaca.js';
import { createBroker as createSimBroker } from './broker-sim.js';
import { createJournal } from './journal.js';
import { createBrakes } from './brakes.js';
import {
  appendLog,
  createClock,
  createLogger,
  ensureDir,
  errorInfo,
  fileExists,
  readJson,
  removeFile,
  sleep,
  writeJsonAtomic,
} from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAPER_ENTRY = path.join(HERE, 'reaper-process.js');

/**
 * Accelerated simulation economics. The live operating config is deliberately gentle
 * (a trading agent's cost of existence is small relative to its capital), so a
 * minutes-long simulation would show no selection at all. This preset makes the
 * metabolism cost-dominant — exactly the article's regime ($5 wallet, $0.083/h burn):
 * agents must out-earn a visible cost-per-cycle or they die within a few hundred bars.
 * The result differs from the operating economics BY DESIGN; the returned summary labels
 * the preset so nobody mistakes a demo for a forecast.
 */
export const ACCELERATED_SIM_ECONOMICS = Object.freeze({
  endowmentUsd: 100,
  deathFloorUsd: 5,
  deathFloorPct: 0.05,
  maxDrawdownPct: 0.1,
  burn: { inferencePerCycleUsd: 0.01, dataPerCycleUsd: 0.002, hostingPerHourUsd: 0.001, committedMonthlyUsd: 0 },
  replication: { surplus7dUsd: 2, minRunwayHours: 24, childEndowmentUsd: 40 },
  risk: {
    maxPositionPct: 0.5,
    maxOpenPositions: 2,
    maxDailyOrders: 24,
    maxDailyLossPct: 0.3,
    maxOrderPctOfEquity: 0.5,
    maxOrderNotionalUsd: 60,
    minOrderNotionalUsd: 1,
    maxSpreadBps: 40,
    minPriceUsd: 1,
    maxSlippageBps: 60,
    maxOrdersPerCycle: 1,
  },
});

/** Translate plugin-row config into layered config overrides. */
export function normalizeOverrides(raw = {}) {
  const overrides = {};
  if (raw && typeof raw === 'object') {
    if (raw.stateDir) overrides.paths = { ...(overrides.paths ?? {}), stateDir: raw.stateDir };
    if (raw.mode) overrides.mode = raw.mode;
    if (raw.allowLive !== undefined) overrides.allowLive = Boolean(raw.allowLive);
    if (raw.autoStart !== undefined) overrides.engine = { ...(overrides.engine ?? {}), autoStart: Boolean(raw.autoStart) };
    if (raw.populationCap !== undefined) overrides.population = { cap: Number(raw.populationCap) };
    if (raw.config && typeof raw.config === 'object') {
      Object.assign(overrides, raw.config);
      if (raw.stateDir) overrides.paths = { ...(overrides.paths ?? {}), stateDir: raw.stateDir };
    }
  }
  return overrides;
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Best guess for a Node executable when running inside Electron or a bundled runtime. */
function resolveNodeBinary() {
  if (process.env.AUTOMATON_NODE_BIN) return { bin: process.env.AUTOMATON_NODE_BIN, execArgv: [] };
  if (process.versions.electron) {
    return { bin: process.execPath, execArgv: [], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { bin: process.execPath, execArgv: [] };
}

/**
 * Create an engine handle.
 * @param {{
 *   overrides?: object,     // plugin row config: {stateDir, envFile, mode, autoStart, config}
 *   configFile?: string,
 *   envFile?: string,
 *   cwd?: string,
 *   clock?: object,
 *   logger?: object,
 *   brokerFactory?: (mode: string, config: object, secrets: object) => object,  // test seam
 *   reaperSpawner?: (config: object, paths: object) => object,                    // test seam
 * }} [options]
 */
export function createEngine(options = {}) {
  const logger = options.logger ?? createLogger('engine');
  const clock = options.clock ?? createClock();
  const overrides = options.overrides ?? {};

  let loaded = null;
  let automaton = null;
  let broker = null;
  let reaper = { pid: null, startedAt: null, error: null };

  /**
   * Locate the layered config file. The Harness Host process usually runs with a different
   * cwd than the workspace, so `<cwd>/automaton.config.json` alone is not enough: also look
   * inside the configured state dir, which the plugin row always sets explicitly.
   */
  function resolveConfigFile() {
    if (options.configFile) return options.configFile;
    if (process.env.AUTOMATON_CONFIG_FILE) return process.env.AUTOMATON_CONFIG_FILE;
    const cwd = options.cwd ?? process.cwd();
    const normalized = normalizeOverrides(overrides);
    const candidates = [path.resolve(cwd, 'automaton.config.json')];
    const stateDir = normalized.paths?.stateDir;
    if (stateDir) candidates.push(path.resolve(cwd, stateDir, 'automaton.config.json'));
    // Default state dir (used by the CLI and by any caller without explicit overrides).
    candidates.push(path.resolve(cwd, 'automaton-data', 'automaton.config.json'));
    return candidates.find((candidate) => fileExists(candidate)) ?? candidates[0];
  }

  function configFromOptions() {
    return loadConfig({
      configFile: resolveConfigFile(),
      envFile: options.envFile ?? overrides.envFile,
      overrides: normalizeOverrides(overrides),
      cwd: options.cwd,
    });
  }

  /** Load config lazily; also persist a secret-free config snapshot for the external Reaper. */
  async function load() {
    if (loaded) return loaded;
    const result = configFromOptions();
    loaded = {
      ...result,
      paths: statePaths(result.config),
    };
    await ensureDir(loaded.paths.stateDir);
    await ensureDir(loaded.paths.specsDir);
    await writeJsonAtomic(loaded.paths.configFile, result.config);
    return loaded;
  }

  function makeBroker(config, secrets) {
    if (options.brokerFactory) return options.brokerFactory(config.mode, config, secrets);
    if (config.mode === 'sim') {
      return createSimBroker(config, { seed: overrides.seed ?? 7, accountEquityUsd: overrides.accountEquityUsd ?? 100000 });
    }
    resolveCredentials(config, secrets); // fail fast with a precise error for missing keys/live arming
    return createAlpacaBroker(config, { secrets });
  }

  async function ensureAutomaton() {
    const state = await load();
    if (automaton) return automaton;
    broker = makeBroker(state.config, state.secrets);
    automaton = await createAutomaton({
      config: state.config,
      paths: state.paths,
      broker,
      clock,
      logger,
    });
    return automaton;
  }

  /** Spawn the external Reaper (paper/live only). Returns {pid, reused, error}. */
  async function startReaper() {
    const state = loaded;
    if (!state) throw new Error('engine not loaded');
    if (state.config.mode === 'sim') {
      reaper = {
        pid: null,
        startedAt: null,
        error: null,
        skipped:
          'sim mode: the engine executes death verdicts in-process (synthetic broker is in-process); paper/live use the external Reaper process',
      };
      return reaper;
    }
    if (options.reaperSpawner) {
      reaper = options.reaperSpawner(state.config, state.paths);
      return reaper;
    }
    const pidFile = path.join(state.paths.stateDir, 'reaper.pid');
    const existing = await readJson(pidFile, null);
    if (existing && isProcessAlive(Number(existing.pid))) {
      // A Reaper from an older app generation has no heartbeat. Reusing it would keep a
      // stale writer that overwrites newer state, so refuse and ask the operator to stop it.
      const heartbeatFile = state.paths.reaperHeartbeat ?? path.join(state.paths.stateDir, 'reaper.heartbeat.json');
      const heartbeat = await readJson(heartbeatFile, null);
      if (!heartbeat || heartbeat.version !== 2 || Number(heartbeat.pid) !== Number(existing.pid)) {
        reaper = {
          pid: Number(existing.pid),
          startedAt: existing.startedAt ?? null,
          reused: false,
          error:
            `an existing Reaper (pid ${existing.pid}) is from an older generation (no matching heartbeat). ` +
            'Stop it with the operator control (POST /automaton/control {"action":"reaper-stop","confirm":"STOP"}) and start again.',
        };
        return reaper;
      }
      reaper = { pid: Number(existing.pid), startedAt: existing.startedAt ?? null, reused: true };
      return reaper;
    }
    if (!fileExists(REAPER_ENTRY)) {
      reaper = { pid: null, startedAt: null, error: `reaper entry not found: ${REAPER_ENTRY}` };
      return reaper;
    }
    const { bin, execArgv, env: extraEnv } = resolveNodeBinary();
    try {
      const child = spawn(bin, [...execArgv, REAPER_ENTRY, '--state-dir', state.paths.stateDir], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: state.paths.stateDir,
        env: { ...process.env, ...(extraEnv ?? {}) },
      });
      child.unref();
      reaper = { pid: child.pid ?? null, startedAt: new Date(clock.now()).toISOString(), reused: false };
      await writeJsonAtomic(pidFile, reaper);
      // Give it a moment to fail fast (bad config, missing keys) before we call start successful.
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (!isProcessAlive(Number(reaper.pid))) {
        reaper.error = 'reaper process exited immediately (see state/reaper.log)';
        await appendLog(state.paths.reaperLog, JSON.stringify({ at: clock.iso(), error: reaper.error }));
      }
      return reaper;
    } catch (error) {
      reaper = { pid: null, startedAt: null, error: error?.message ?? String(error) };
      return reaper;
    }
  }

  async function stopReaperIfSim() {
    // Sim never spawns; paper/live keep the Reaper running by design (no control surface).
    return reaper;
  }

  async function start() {
    const state = await load();
    const instance = await ensureAutomaton();
    await instance.init();
    await instance.start();
    if (state.config.mode !== 'sim') {
      const spawned = await startReaper();
      if (spawned.error) {
        // Mortality must be enforceable; refuse to run a paper/live population without a Reaper.
        await instance.stop();
        const error = new Error(
          `refusing to start ${state.config.mode} population: external Reaper unavailable (${spawned.error}). ` +
            'Death must execute outside the engine. Fix node executable/state dir or see state/reaper.log.',
        );
        error.code = 'REAPER_UNAVAILABLE';
        error.reaper = spawned;
        throw error;
      }
    }
    return status();
  }

  async function stop() {
    if (automaton) await automaton.stop();
    await stopReaperIfSim();
    return status();
  }

  /** Current external-Reaper view, read from disk so orphans from older processes show up. */
  async function reaperInfo(state) {
    if (state.config.mode === 'sim') {
      return {
        pid: null,
        alive: false,
        error: null,
        note: 'sim mode: death verdicts are executed in-process (synthetic broker)',
      };
    }
    const pidFile = state.paths.reaperPid ?? path.join(state.paths.stateDir, 'reaper.pid');
    const heartbeatFile = state.paths.reaperHeartbeat ?? path.join(state.paths.stateDir, 'reaper.heartbeat.json');
    const saved = await readJson(pidFile, null);
    const heartbeat = await readJson(heartbeatFile, null);
    const pid = Number(saved?.pid ?? reaper.pid ?? heartbeat?.pid) || null;
    const alive = pid ? isProcessAlive(pid) : false;
    return {
      pid,
      alive,
      startedAt: saved?.startedAt ?? null,
      heartbeatAt: heartbeat?.at ?? null,
      heartbeatVersion: heartbeat?.version ?? null,
      sweeps: heartbeat?.sweeps ?? null,
      error: reaper.error ?? null,
      note: alive
        ? 'external process; operator stop available'
        : 'not running (a running loop spawns it on start)',
    };
  }

  async function tick() {
    const instance = await ensureAutomaton();
    const trace = await instance.tick();
    return { trace, status: await status() };
  }

  async function status() {
    let state;
    try {
      state = await load();
    } catch (error) {
      return {
        at: new Date(clock.now()).toISOString(),
        mode: overrides.mode ?? 'unknown',
        engine: { running: false, error: errorInfo(error) },
        config: null,
      };
    }
    const base = automaton
      ? await automaton.status()
      : await staticStatus(state);
    return {
      ...base,
      engine: {
        ...base.engine,
        running: automaton ? automaton.isRunning() : false,
        reaper: await reaperInfo(state),
      },
    };
  }

  async function staticStatus(state) {
    const journal = createJournal({ paths: state.paths, config: state.config });
    const snapshot = await readJson(state.paths.stateFile, null);
    if (snapshot) return snapshot;
    return {
      at: new Date(clock.now()).toISOString(),
      mode: state.config.mode,
      engine: {
        running: false,
        initialized: false,
        ticks: 0,
        lastTickAt: null,
        lastError: null,
        killSwitch: fileExists(state.paths.killSwitch),
        liveArmed: liveArmed(state.config),
      },
      account: null,
      treasury: null,
      population: { total: 0, alive: 0, dead: 0, condemned: 0, cap: state.config.population.cap, byGeneration: {} },
      agents: [],
      obituaries: journal.stats ? await journal.stats() : null,
      halted: false,
      haltReasons: [],
      config: configSummary(state.config),
    };
  }

  /** Verify credentials + broker connectivity without starting the population. */
  async function probe() {
    const state = await load();
    const mode = state.config.mode;
    const result = {
      at: new Date(clock.now()).toISOString(),
      mode,
      hasCredentials: hasCredentials(state.secrets, mode),
      liveArmed: liveArmed(state.config),
      config: configSummary(state.config),
      account: null,
      clock: null,
      error: null,
    };
    try {
      const probeBroker = makeBroker(state.config, state.secrets);
      result.account = await probeBroker.getAccount();
      try {
        result.clock = await probeBroker.getClock();
      } catch {
        /* clock is optional for the probe */
      }
    } catch (error) {
      result.error = errorInfo(error);
    }
    return result;
  }

  async function obituaries({ limit = 50, offset = 0 } = {}) {
    const state = await load();
    const journal = createJournal({ paths: state.paths, config: state.config });
    return { stats: journal.stats ? await journal.stats() : null, items: await journal.list({ limit, offset }) };
  }

  async function brakesView() {
    const state = await load();
    const brakes = createBrakes({ config: state.config, paths: state.paths, clock });
    return {
      rules: brakes.describe(),
      killSwitch: Boolean(brakes.isKillSwitchActive?.()),
      liveArmed: liveArmed(state.config),
      mode: state.config.mode,
    };
  }

  async function preTradeCheck(args = {}) {
    const instance = await ensureAutomaton();
    return instance.preTradeCheck(args);
  }

  /**
   * Accelerated mortality simulation. `preset: 'accelerated'` (default) uses
   * cost-dominant demo economics so selection is observable in minutes; `preset: 'real'`
   * simulates the operating economics in the current config. The preset is echoed in the
   * result so a demo can never be mistaken for a forecast.
   */
  async function simulate({ cycles = 240, population = 100, seed = 7, preset = 'accelerated' } = {}) {
    const state = await load();
    const module = await import('./simulate.js');
    const config = { ...state.config, mode: 'sim' };
    const chosenPreset = preset === 'real' ? 'real' : 'accelerated';
    const configOverrides = chosenPreset === 'accelerated'
      ? {
          ...ACCELERATED_SIM_ECONOMICS,
          // Leave room for the Replicator to actually fire: the sim caps the population at
          // the seed size otherwise, and nothing could ever reproduce.
          population: { cap: Math.max(2, Math.floor(Number(population) || 0) * 2) },
        }
      : {};
    const options = { config, cycles, population, seed, configOverrides };
    let result;
    if (typeof module.createSimulation === 'function') {
      const runner = module.createSimulation(options);
      result = await runner.run({ cycles, population, seed });
    } else if (typeof module.runSimulation === 'function') {
      result = await module.runSimulation(options);
    } else if (typeof module.run === 'function') {
      result = await module.run(options);
    } else if (typeof module.simulate === 'function') {
      result = await module.simulate(options);
    } else {
      throw new Error('simulate.js does not export a simulation entry point');
    }
    if (result && typeof result === 'object') {
      result.preset = chosenPreset;
      result.economics = {
        note:
          chosenPreset === 'accelerated'
            ? 'accelerated demo economics: cost-dominant so mortality is observable in minutes; NOT the operating config'
            : 'operating economics from the current config',
        endowmentUsd: result.economics?.endowmentUsd ?? (configOverrides.endowmentUsd ?? config.endowmentUsd),
        burnPerCycleUsd: configOverrides.burn
          ? configOverrides.burn.inferencePerCycleUsd + configOverrides.burn.dataPerCycleUsd
          : config.burn.inferencePerCycleUsd + config.burn.dataPerCycleUsd,
        replication: configOverrides.replication ?? config.replication,
      };
    }
    return result;
  }

  /** Operator emergency stop: arm the kill switch (blocks every order/cycle) and stop the loop. */
  async function emergencyStop() {
    const state = await load();
    await ensureDir(state.paths.stateDir);
    await writeJsonAtomic(state.paths.killSwitch, {
      armedAt: new Date(clock.now()).toISOString(),
      reason: 'operator emergency stop',
    });
    if (automaton) await automaton.stop();
    return {
      killSwitch: true,
      running: automaton?.isRunning?.() ?? false,
      reaper: reaper.pid ? { pid: reaper.pid, alive: isProcessAlive(Number(reaper.pid)) } : null,
      note: 'orders and cycles are blocked; the external Reaper keeps liquidating condemned agents',
    };
  }

  async function clearEmergencyStop() {
    const state = await load();
    await removeFile(state.paths.killSwitch);
    return { killSwitch: false };
  }

  async function armsLive({ confirm } = {}) {
    const state = await load();
    if (state.config.mode !== 'live') {
      const error = new Error('mode must be live (and allowLive=true) before arming');
      error.code = 'MODE_FORBIDDEN';
      throw error;
    }
    if (confirm !== 'ARM LIVE') {
      const error = new Error('confirm must be exactly "ARM LIVE"');
      error.code = 'CONFIRM_REQUIRED';
      throw error;
    }
    await ensureDir(state.paths.stateDir);
    await writeJsonAtomic(state.paths.liveArmed, { armedAt: new Date(clock.now()).toISOString() });
    return { liveArmed: true };
  }

  function configView() {
    const state = loaded;
    if (!state) {
      const result = configFromOptions();
      return { config: publicConfig(result.config), summary: configSummary(result.config), sources: result.sources };
    }
    return {
      config: publicConfig(state.config),
      summary: configSummary(state.config),
      sources: state.sources,
      stateDir: state.paths.stateDir,
      envFile: state.paths.envFile,
    };
  }

  return {
    start,
    stop,
    tick,
    status,
    probe,
    obituaries,
    brakesView,
    preTradeCheck,
    simulate,
    emergencyStop,
    clearEmergencyStop,
    armsLive,
    configView,
    isRunning: () => Boolean(automaton && automaton.isRunning()),
    get config() {
      return loaded?.config ?? null;
    },
    get paths() {
      return loaded?.paths ?? null;
    },
    get reaper() {
      return reaper;
    },
    get automaton() {
      return automaton;
    },
  };
}

export const ENGINE_ENTRY = REAPER_ENTRY;
