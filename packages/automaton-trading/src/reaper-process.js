#!/usr/bin/env node
/**
 * reaper-process.js — the Reaper as a separate OS process (D12).
 *
 *   node src/reaper-process.js --state-dir <dir> [--once]
 *
 * The engine has no handle to this process: it is launched detached, it reads the
 * broker and the persisted registry/ledger directly, it re-derives death on its own
 * (never trusting `deaths.json`), and it appends JSONL progress to `state/reaper.log`.
 * `grace_seconds = 0`. It exits cleanly on SIGINT/SIGTERM, and with code 0 after one
 * sweep when `--once` is given.
 *
 * Owned by mortality-core. Contract: docs/CONTRACTS.md ("Mortality modules").
 */

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadConfig, statePaths } from './config.js';
import { createBroker as createAlpacaBroker } from './broker-alpaca.js';
import { createBroker as createSimBroker } from './broker-sim.js';
import { createJournal } from './journal.js';
import { createLedger } from './ledger.js';
import { createReaper } from './reaper.js';
import { createRegistry } from './registry.js';
import { appendJsonl, ensureDir, errorInfo, fileExists, SYSTEM_CLOCK, writeJsonAtomic } from './util.js';

const USAGE = `Usage: node src/reaper-process.js --state-dir <dir> [--once]

Options:
  --state-dir <dir>  Directory holding config.json, registry.json, ledger.json,
                     obituaries.jsonl and the broker credentials (.env). Defaults to
                     $AUTOMATON_STATE_DIR or ./automaton-data.
  --once             Run exactly one sweep and exit with code 0.
  --help, -h         Show this help.

The Reaper is intentionally unreachable from the engine: this process is launched
detached and no tool, IPC or config path can stop, delay or disarm it.`;

/**
 * Parse the command line. Unknown flags are a usage error, not a silent no-op.
 * @param {string[]} argv
 * @returns {{ stateDir: string|null, once: boolean, help: boolean }}
 */
export function parseArgs(argv = []) {
  const parsed = { stateDir: null, once: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '');
    if (arg === '--state-dir' || arg === '-s') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error('--state-dir requires a directory path');
      }
      parsed.stateDir = value;
      index += 1;
    } else if (arg.startsWith('--state-dir=')) {
      const value = arg.slice('--state-dir='.length);
      if (value.trim() === '') throw new Error('--state-dir requires a directory path');
      parsed.stateDir = value;
    } else if (arg === '--once') {
      parsed.once = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg.trim() !== '') {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

/** Return a shallow config copy whose stateDir is exactly the CLI-selected directory. */
function withStateDir(config, stateDir) {
  if (config.paths && path.resolve(config.paths.stateDir) === stateDir) return config;
  return { ...config, paths: { ...(config.paths ?? {}), stateDir } };
}

/**
 * Build the broker for the configured mode. The Alpaca client takes the config and
 * resolves credentials from the process environment / .env; the sim broker is
 * deterministic. Both are imported statically: this process must fail fast rather than
 * fall back to a different venue.
 */
export function createConfiguredBroker(config, secrets = {}) {
  if (config.mode === 'sim') return createSimBroker(config, { secrets });
  return createAlpacaBroker(config, { secrets });
}

/**
 * One process lifetime: load config, load state, sweep forever (or once).
 *
 * @param {string[]} [argv]
 * @param {{ env?: Record<string, string|undefined> }} [options]
 * @returns {Promise<number>} process exit code (0 for a clean run, including --once)
 */
export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`[reaper] ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const stateDir = path.resolve(
    args.stateDir ?? env.AUTOMATON_STATE_DIR ?? path.join(process.cwd(), 'automaton-data'),
  );
  const configFile = path.join(stateDir, 'config.json');
  const envFileCandidate = path.join(stateDir, '.env');
  const loaded = loadConfig({
    configFile,
    envFile: fileExists(envFileCandidate) ? envFileCandidate : undefined,
    cwd: process.cwd(),
    env,
  });
  const config = withStateDir(loaded.config, stateDir);
  const paths = statePaths(config);
  await ensureDir(paths.stateDir);

  // The external Reaper exists to execute deaths against a REAL broker from persisted state.
  // Sim mode keeps its broker in the engine's memory, so a separate process would read a
  // different (empty) simulated account and could kill agents for the wrong reasons.
  if (config.mode === 'sim') {
    console.log('[reaper] refusing to run: sim mode executes death verdicts in-process in the engine');
    await appendJsonl(paths.reaperLog, {
      at: new Date().toISOString(),
      event: 'refused',
      reason: 'sim mode uses the in-process reaper; the external process needs a paper/live broker',
    }).catch(() => {});
    return 0;
  }

  // The .env secrets were parsed by loadConfig; make them visible to the broker client
  // through the process environment as well, so credential resolution has one seam.
  for (const [key, value] of Object.entries(loaded.secrets ?? {})) {
    if (/^ALPACA_/i.test(key) && typeof value === 'string' && env[key] === undefined) {
      env[key] = value;
    }
  }

  const clock = SYSTEM_CLOCK;
  const ledger = createLedger({ paths, config, clock });
  ledger.load();
  const registry = createRegistry({ paths, config, clock });
  registry.load();
  const journal = createJournal({ paths, config });
  const broker = createConfiguredBroker(config, loaded.secrets);
  const reaper = createReaper({ broker, registry, ledger, journal, config, paths, clock });

  /** @param {object} record */
  async function log(record) {
    try {
      await appendJsonl(paths.reaperLog, record);
    } catch (error) {
      console.error(`[reaper] could not write ${paths.reaperLog}: ${error?.message ?? error}`);
    }
  }

  await log({
    at: clock.iso(),
    event: 'start',
    pid: process.pid,
    mode: config.mode,
    stateDir: paths.stateDir,
    once: args.once,
    reaperIntervalSec: config.reaperIntervalSec,
  });
  console.log(
    `[reaper] started pid=${process.pid} mode=${config.mode} stateDir=${paths.stateDir} once=${args.once}`,
  );

  let stopping = false;
  let resolveStop;
  const stopRequested = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const requestStop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[reaper] ${signal} received, finishing current sweep`);
    resolveStop(signal);
  };
  process.once('SIGINT', () => requestStop('SIGINT'));
  process.once('SIGTERM', () => requestStop('SIGTERM'));

  const intervalMs = Math.max(1, Number(config.reaperIntervalSec) || 30) * 1000;
  let sweeps = 0;
  let lastError = null;

  do {
    const at = clock.iso();
    try {
      // Reload durable state BEFORE every sweep. The engine is a second writer; a Reaper
      // that kept saving the snapshot it loaded at process start would silently overwrite
      // newer state (observed: it reverted agent names / ledger costs every 30 seconds).
      try {
        registry.load();
        ledger.load();
      } catch (reloadError) {
        await log({ at, event: 'reload_error', error: errorInfo(reloadError) });
      }
      const result = await reaper.sweep();
      // The engine and the operator read registry.json/ledger.json; a death that is not
      // persisted here is not a death (the engine would keep funding a zombie).
      try {
        await registry.save();
        await ledger.save();
      } catch (saveError) {
        await log({ at, event: 'save_error', error: errorInfo(saveError) });
      }
      sweeps += 1;
      lastError = null;
      const summary = {
        at,
        event: 'sweep',
        checked: result.checked,
        killed: result.killed.length,
        killedAgents: result.killed.map((entry) => entry.agentId),
        skipped: result.skipped.length,
      };
      if (Array.isArray(result.errors) && result.errors.length > 0) summary.errors = result.errors;
      await log(summary);
      // Heartbeat lets the operator/panel see a live Reaper and detect an orphan.
      try {
        await writeJsonAtomic(paths.reaperHeartbeat, {
          pid: process.pid,
          at,
          sweeps,
          pidFile: paths.reaperPid,
          version: 2,
        });
      } catch (heartbeatError) {
        await log({ at, event: 'heartbeat_error', error: errorInfo(heartbeatError) });
      }
      console.log(
        `[reaper] ${at} checked=${result.checked} killed=${result.killed.length} skipped=${result.skipped.length}`,
      );
    } catch (error) {
      lastError = errorInfo(error);
      await log({ at, event: 'sweep_error', error: lastError });
      console.error(`[reaper] sweep failed: ${lastError.code}: ${lastError.message}`);
    }
    if (args.once) break;
    if (stopping) break;
    await Promise.race([
      new Promise((resolve) => {
        setTimeout(resolve, intervalMs);
      }),
      stopRequested,
    ]);
  } while (!stopping);

  await log({
    at: clock.iso(),
    event: 'shutdown',
    once: args.once,
    sweeps,
    lastError,
  });
  console.log(`[reaper] stopped after ${sweeps} sweep(s)`);
  return 0;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  process.argv[1] !== '' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[reaper] fatal: ${error?.code ?? 'ERROR'}: ${error?.message ?? error}`);
      process.exitCode = 1;
    });
}
