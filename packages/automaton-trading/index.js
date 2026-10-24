/**
 * Host half of the AUTOMATON TRADING bundle.
 *
 * Wires the mortality-engineered trading population into the Harness:
 *  - owns ONE engine handle created through the Lead-owned facade `./src/engine.js`
 *  - registers the ten model-facing `automaton_*` tools
 *  - serves the redacted `GET /automaton/state` snapshot for the Web UI dashboard
 *  - serves `POST /automaton/control` (loopback-only) for the operator control panel
 *  - disposes every registration and stops the loop when the plugin unloads
 *
 * Lifecycle: this plugin never starts the external Reaper and has no control surface
 * over it. The Reaper is a separate OS process owned by the engine; `automaton_stop`
 * only stops the in-process cycle loop.
 *
 * Test seam: `config.engineFactory` may be a function `(rowConfig) => engine`
 * (sync or async) that replaces the real `createEngine`. It exists so the plugin
 * contract can be tested without a broker, network, or state directory. It is not a
 * production configuration surface.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { BRAKES, MODES } from './src/contracts.js';
import { errorInfo, fileExists, redactSecrets, safeJson } from './src/util.js';

/** Cordis plugin name (row id is `automaton-trading` in cordis.patch.yml). */
export const name = 'automaton-trading';

/** Hard dependency: this plugin only makes sense with the tool registry. `webServer` is optional. */
export const inject = ['tools'];

const PLUGIN_ID = 'automaton-trading';
const ROUTE_PATH = '/automaton/state';
/** Operator-only control route used by the dashboard (loopback only). */
const CONTROL_PATH = '/automaton/control';
/** Whitelisted control actions; anything else is a 400. */
const CONTROL_ACTIONS = Object.freeze(['start', 'stop', 'emergency-stop', 'reaper-stop']);
const CONTROL_BODY_LIMIT_BYTES = 8192;
const MAX_ERROR_MESSAGE = 500;
const SIMULATION_LIMITS = Object.freeze({ cycles: [1, 5000], population: [1, 200] });

const WORKSPACE = process.cwd();

/** Safe fallbacks; the shipped cordis.patch.yml row supplies absolute paths. */
const DEFAULT_ROW_CONFIG = Object.freeze({
  stateDir: path.join(WORKSPACE, 'automaton-data'),
  envFile: path.join(WORKSPACE, '.env'),
  mode: 'paper',
  autoStart: false,
  allowLive: false,
});

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Merge a plugin-row config with safe defaults; unknown keys (e.g. `config`, `engineFactory`) survive. */
function normalizeRowConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const merged = { ...DEFAULT_ROW_CONFIG, ...input };
  const mode = String(merged.mode ?? '').toLowerCase();
  merged.mode = MODES.includes(mode) ? mode : 'paper';
  merged.autoStart = merged.autoStart === true;
  merged.allowLive = merged.allowLive === true;
  merged.stateDir = typeof input.stateDir === 'string' && input.stateDir.length > 0
    ? path.resolve(input.stateDir)
    : DEFAULT_ROW_CONFIG.stateDir;
  merged.envFile = typeof input.envFile === 'string' && input.envFile.length > 0
    ? path.resolve(input.envFile)
    : DEFAULT_ROW_CONFIG.envFile;
  // Only forward row keys the user actually set, so the engine's layered config file and
  // environment overrides are not masked by our safe defaults.
  const provided = new Set(Object.keys(input));
  merged.overrides = {};
  if (provided.has('stateDir')) merged.overrides.stateDir = merged.stateDir;
  if (provided.has('envFile')) merged.overrides.envFile = merged.envFile;
  if (provided.has('mode')) merged.overrides.mode = merged.mode;
  if (provided.has('autoStart')) merged.overrides.autoStart = merged.autoStart;
  if (provided.has('allowLive')) merged.overrides.allowLive = merged.allowLive;
  if (provided.has('populationCap')) merged.overrides.populationCap = input.populationCap;
  return merged;
}

/** Structured logger: prefer the Cordis logger, fall back to the package logger. */
function pluginLogger(ctx) {
  const sink = ctx?.logger;
  const write = (level) => (message, data) => {
    try {
      if (sink && typeof sink[level] === 'function') {
        if (data === undefined) sink[level](`[${PLUGIN_ID}] ${message}`);
        else sink[level](`[${PLUGIN_ID}] ${message} ${safeJson(data)}`);
      }
    } catch {
      /* logging must never fail plugin activation */
    }
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: () => {} };
}

/** Mask common credential shapes inside free-form error messages. */
function scrubMessage(message) {
  let text = String(message ?? '');
  text = text.replace(/(?:AKIA|ASIA)[A-Z0-9]{12,32}/g, '***');
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '***');
  text = text.replace(/\b(?:secret|token|password)\s*[=:]\s*\S+/gi, '***');
  return text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE)}…` : text;
}

/** Safe, secret-free error object for tool results and the HTTP route. */
function safeError(error) {
  let base;
  try {
    base = errorInfo(error);
  } catch {
    base = { code: 'ERROR', message: 'unknown error', details: {} };
  }
  const details = base.details && typeof base.details === 'object' && !Array.isArray(base.details)
    ? base.details
    : (base.details === undefined ? {} : { detail: base.details });
  return {
    code: typeof base.code === 'string' && base.code.length > 0 ? base.code : 'ERROR',
    message: scrubMessage(base.message),
    details: redactSecrets(details),
  };
}

function ok(payload = {}) {
  return { ok: true, ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload }) };
}

function failure(error) {
  return { ok: false, isError: true, error: safeError(error) };
}

/** Generic success/error envelope schema accepted by the Harness JSON-schema subset. */
const ENVELOPE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  description: 'Structured JSON result. `ok` is true on success; on failure `ok` is false, `isError` is true, and `error` carries a stable code and a secret-free message.',
  properties: {
    ok: { type: 'boolean', description: 'true when the operation succeeded.' },
    isError: { type: 'boolean', description: 'true when the operation failed (structured error envelope).' },
    error: {
      type: 'object',
      description: 'Stable error envelope: code, message, redacted details.',
      properties: {
        code: { type: 'string', description: 'Stable machine-readable error code, e.g. LIVE_NOT_ARMED.' },
        message: { type: 'string', description: 'Human-readable, secret-free message.' },
        details: {
          type: 'object',
          description: 'Redacted structured context.',
          additionalProperties: true,
        },
      },
      required: ['code', 'message'],
      additionalProperties: true,
    },
  },
  required: ['ok'],
  additionalProperties: true,
});

/** Model-facing text content for a tool result. */
function renderJson(_args, value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = safeJson(value);
  }
  if (typeof text !== 'string') text = safeJson(value);
  return [{ type: 'text', text }];
}

/**
 * Reduce a value to lossless JSON: drops `undefined` members, functions, and
 * symbols (the same projection the Harness stores), so an engine view that
 * carries an optional `undefined` field cannot fail output-schema validation.
 */
function toLosslessJson(value) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') {
    const error = new Error('tool result could not be serialized to JSON');
    error.code = 'SERIALIZATION_ERROR';
    throw error;
  }
  return JSON.parse(text);
}

/** Build one ToolDefinition with the shared envelope output contract. */
function defineTool({ toolName, description, parameters, execute, timeoutMs, isConcurrencySafe }) {
  /** @type {Record<string, unknown>} */
  const definition = {
    name: toolName,
    description,
    parameters,
    output: { schema: ENVELOPE_OUTPUT_SCHEMA, render: renderJson },
    async execute(args) {
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      try {
        return toLosslessJson(ok(await execute(input)));
      } catch (error) {
        return failure(error);
      }
    },
  };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) definition.timeoutMs = timeoutMs;
  if (typeof isConcurrencySafe === 'function') definition.isConcurrencySafe = isConcurrencySafe;
  return definition;
}

const EMPTY_PARAMS = Object.freeze({ type: 'object', properties: {} });

// ---------------------------------------------------------------------------
// engine lifecycle
// ---------------------------------------------------------------------------

/**
 * Default engine factory: lazily import the Lead-owned facade so this plugin shell
 * still activates (and reports a structured error) if the engine module is broken.
 * @param {object} row normalized plugin-row config
 */
async function defaultEngineFactory(row) {
  const module = await import('./src/engine.js');
  if (typeof module.createEngine !== 'function') {
    const error = new Error('src/engine.js does not export createEngine');
    error.code = 'ENGINE_UNAVAILABLE';
    throw error;
  }
  const overrides = { ...row.overrides };
  // The row may carry a nested `config` object with deeper overrides (engine.normalizeOverrides).
  if (row.config && typeof row.config === 'object' && !Array.isArray(row.config)) overrides.config = row.config;
  return module.createEngine({ overrides, envFile: row.envFile });
}

/**
 * One engine handle per plugin activation. Creation is lazy and memoized; a failed
 * creation is retried on the next call instead of poisoning the plugin.
 */
function createEngineHolder(row, log) {
  let engine = null;
  let enginePromise = null;

  function getEngine() {
    if (engine) return Promise.resolve(engine);
    if (enginePromise) return enginePromise;
    const factory = typeof row.engineFactory === 'function' ? row.engineFactory : defaultEngineFactory;
    enginePromise = Promise.resolve()
      .then(() => factory(row))
      .then((created) => {
        if (!created || typeof created !== 'object') {
          const error = new Error('engineFactory did not return an engine object');
          error.code = 'ENGINE_UNAVAILABLE';
          throw error;
        }
        engine = created;
        return created;
      })
      .catch((error) => {
        enginePromise = null;
        if (typeof row.engineFactory !== 'function') {
          log.warn('engine creation failed', safeError(error));
        }
        throw error;
      });
    return enginePromise;
  }

  async function call(method, ...args) {
    const instance = await getEngine();
    const fn = typeof instance[method] === 'function' ? instance[method] : null;
    if (!fn) {
      const error = new Error(`engine.${method}() is not available in this build`);
      error.code = 'NOT_IMPLEMENTED';
      throw error;
    }
    return fn.apply(instance, args);
  }

  function dispose() {
    const current = engine;
    const pending = enginePromise;
    engine = null;
    enginePromise = null;
    const stop = (instance) => {
      try {
        const result = typeof instance?.stop === 'function' ? instance.stop() : undefined;
        if (result && typeof result.then === 'function') result.catch(() => {});
      } catch (error) {
        log.warn('engine stop during plugin unload failed', safeError(error));
      }
    };
    if (current) stop(current);
    else if (pending) void pending.then(stop).catch(() => {});
  }

  return { getEngine, call, dispose, isCreated: () => Boolean(engine) };
}

// ---------------------------------------------------------------------------
// state snapshot shared by the tools and the HTTP route
// ---------------------------------------------------------------------------

function normalizeObituaries(result) {
  if (!result || typeof result !== 'object') return { stats: null, items: [] };
  if (Array.isArray(result)) return { stats: null, items: result };
  const items = Array.isArray(result.items) ? result.items : (Array.isArray(result.obituaries) ? result.obituaries : []);
  return { stats: result.stats ?? result.obituaries ?? null, items };
}

/**
 * Kill-switch state: the marker FILE is authoritative (the operator writes and deletes it
 * directly; persisted engine snapshots can be one tick stale). Fall back to the engine view
 * only when the state directory is unknown.
 */
function killSwitchActive(status, row, configView) {
  const stateDir = configView?.stateDir ?? row?.stateDir;
  if (typeof stateDir === 'string' && stateDir.length > 0) {
    try {
      return fileExists(path.join(stateDir, 'KILL_SWITCH'));
    } catch {
      return Boolean(status?.engine?.killSwitch);
    }
  }
  return Boolean(status?.engine?.killSwitch);
}

/**
 * Build the redacted dashboard/tool snapshot. Never contains credential material:
 * engine views are secret-free by construction and everything is passed through
 * `redactSecrets` as defense in depth.
 */
async function buildState(holder, row) {
  const engine = await holder.getEngine();
  const status = (await engine.status?.()) ?? {};
  let obituaries = { stats: null, items: [] };
  try {
    obituaries = normalizeObituaries(await engine.obituaries?.({ limit: 8, offset: 0 }));
  } catch {
    obituaries = normalizeObituaries(null);
  }
  let configView = null;
  try {
    configView = typeof engine.configView === 'function' ? engine.configView() : null;
  } catch {
    configView = null;
  }
  const summary = configView?.summary ?? status?.config ?? null;
  const effectiveConfig = configView?.config ?? null;
  const account = status?.account ?? null;
  const population = status?.population ?? null;
  const allocationCapPctRaw = Number(effectiveConfig?.account?.allocationCapPct);
  const allocationCapPct = Number.isFinite(allocationCapPctRaw) && allocationCapPctRaw > 0 ? allocationCapPctRaw : null;
  const equityUsd = Number(account?.equityUsd);
  const limits = {
    populationCap: population?.cap ?? effectiveConfig?.population?.cap ?? null,
    populationInitial: effectiveConfig?.population?.initial ?? null,
    allocationCapPct,
    allocationCapUsd: allocationCapPct !== null && Number.isFinite(equityUsd)
      ? Math.round(allocationCapPct * equityUsd * 100) / 100
      : null,
    endowmentUsd: effectiveConfig?.endowmentUsd ?? summary?.endowmentUsd ?? null,
    deathFloorUsd: summary?.deathFloorUsd ?? null,
    cycleIntervalSec: effectiveConfig?.cycleIntervalSec ?? summary?.cycleIntervalSec ?? null,
  };
  const snapshot = {
    ok: true,
    at: new Date().toISOString(),
    plugin: {
      name: '@local/automaton-trading',
      mode: row.mode,
      stateDir: configView?.stateDir ?? row.stateDir,
      envFile: configView?.envFile ?? row.envFile,
    },
    mode: status?.mode ?? summary?.mode ?? row.mode,
    engine: {
      running: Boolean(status?.engine?.running),
      reaper: status?.engine?.reaper ?? null,
      ...status?.engine,
      killSwitch: killSwitchActive(status, row, configView),
    },
    account: status?.account ?? null,
    treasury: status?.treasury ?? null,
    population: status?.population ?? null,
    limits,
    agents: Array.isArray(status?.agents) ? status.agents : [],
    obituaries: {
      stats: obituaries.stats ?? status?.obituaries ?? null,
      recent: obituaries.items.slice(0, 8),
    },
    halted: Boolean(status?.halted),
    haltReasons: Array.isArray(status?.haltReasons) ? status.haltReasons : [],
    brakes: { count: BRAKES.length, enforced: true, killSwitch: killSwitchActive(status, row, configView) },
    control: { route: CONTROL_PATH, loopbackOnly: true, actions: CONTROL_ACTIONS.slice() },
    config: summary,
  };
  return redactSecrets(snapshot);
}

/** GET /automaton/state — same redacted snapshot the panel polls. */
function createStateHandler(holder, row, log) {
  return async function stateHandler(req, res) {
    const send = (statusCode, body) => {
      try {
        res.statusCode = statusCode;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(body));
      } catch (error) {
        log.warn('failed to write /automaton/state response', safeError(error));
      }
    };
    const method = String(req?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      send(405, failure(Object.assign(new Error('GET only'), { code: 'METHOD_NOT_ALLOWED' })));
      return;
    }
    try {
      const snapshot = await buildState(holder, row);
      if (method === 'HEAD') {
        try {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end();
        } catch (error) {
          log.warn('failed to write /automaton/state response', safeError(error));
        }
        return;
      }
      send(200, snapshot);
    } catch (error) {
      log.warn('state snapshot failed', safeError(error));
      send(503, failure(error));
    }
  };
}

/**
 * POST /automaton/control — operator controls for the dashboard.
 * Loopback-only by design: this is a local operator surface, never a remote API.
 * Body: `{action: 'start'|'stop'|'emergency-stop'|'reaper-stop', confirm?}`.
 * `emergency-stop` and `reaper-stop` both require `confirm: "STOP"`.
 */
function createControlHandler(holder, row, log) {
  return async function controlHandler(req, res) {
    const send = (statusCode, body) => {
      try {
        res.statusCode = statusCode;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        res.end(JSON.stringify(body));
      } catch (error) {
        log.warn('failed to write /automaton/control response', safeError(error));
      }
    };
    const method = String(req?.method ?? '').toUpperCase();
    if (method !== 'POST') {
      send(405, failure(httpError('METHOD_NOT_ALLOWED', 'POST only')));
      return;
    }
    if (!isLoopbackRequest(req)) {
      log.warn('rejected non-loopback automaton control request');
      send(403, failure(httpError('FORBIDDEN', 'automaton control is loopback-only: the request did not arrive over a local connection')));
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      send(controlErrorStatus(error?.code), failure(error));
      return;
    }
    const action = typeof body.action === 'string' ? body.action : null;
    if (!CONTROL_ACTIONS.includes(action)) {
      send(400, failure(httpError(
        'BAD_ACTION',
        `unknown action ${JSON.stringify(action)}; expected ${CONTROL_ACTIONS.join(', ')}`,
      )));
      return;
    }
    try {
      let result;
      if (action === 'start') {
        await assertStartAllowed(holder, row);
        result = await holder.call('start');
      } else if (action === 'stop') {
        result = await holder.call('stop');
      } else if (action === 'reaper-stop') {
        if (body.confirm !== 'STOP') {
          send(400, failure(httpError('CONFIRM_REQUIRED', 'reaper-stop requires body {"confirm":"STOP"}')));
          return;
        }
        // Operator-only: the Reaper has NO engine control surface by design (D12); the
        // Host plugin terminates the external process by pid, exactly like `kill` in a
        // terminal. Never exposed as an agent tool.
        const outcome = await stopReaperOperator(holder, row);
        if (!outcome.ok) {
          const info = safeError(outcome.error ? Object.assign(new Error(outcome.error.message), { code: outcome.error.code }) : null);
          log.warn('REAPER STOP failed (operator control)', info);
          send(409, {
            ok: false,
            isError: true,
            error: outcome.error ?? { code: 'REAPER_STOP_FAILED', message: 'reaper stop failed' },
            hint: outcome.hint ?? 'stop it from the operating system terminal',
            pid: outcome.pid ?? null,
            heartbeat: outcome.heartbeat ?? null,
          });
          return;
        }
        result = {
          stopped: outcome.stopped === true,
          pid: outcome.pid ?? null,
          alive: false,
          reason: outcome.reason ?? null,
          signals: outcome.signals ?? null,
          heartbeat: outcome.heartbeat ?? null,
          pidFile: outcome.pidFile ?? null,
          note: 'operator surface: the Reaper is not reachable from the engine or any agent tool',
        };
        log.warn('REAPER STOP via dashboard (operator control)', { stopped: result.stopped, pid: result.pid });
      } else {
        if (body.confirm !== 'STOP') {
          send(400, failure(httpError('CONFIRM_REQUIRED', 'emergency-stop requires body {"confirm":"STOP"}')));
          return;
        }
        const reason = typeof body.reason === 'string' && body.reason.length > 0
          ? body.reason
          : 'control panel emergency stop';
        result = await emergencyStopEngine(holder, row, reason);
        log.warn('EMERGENCY STOP via control panel', { reason });
      }
      send(200, {
        ok: true,
        action,
        at: new Date().toISOString(),
        result: redactSecrets(result ?? null),
      });
    } catch (error) {
      const info = safeError(error);
      log.warn(`control action "${action}" failed`, info);
      send(controlErrorStatus(info.code), failure(error));
    }
  };
}

// ---------------------------------------------------------------------------
// tool helpers
// ---------------------------------------------------------------------------

function clampInteger(value, fallback, [min, max]) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Live mode is refused unless the operator marker says it is armed. */
async function assertStartAllowed(holder, row) {
  let mode = row.mode;
  let liveArmed = false;
  try {
    const engine = holder.isCreated() ? await holder.getEngine() : null;
    if (engine && typeof engine.configView === 'function') {
      const configView = engine.configView();
      mode = configView?.summary?.mode ?? configView?.config?.mode ?? mode;
    }
    if (engine && typeof engine.brakesView === 'function') {
      const brakesView = await engine.brakesView();
      liveArmed = Boolean(brakesView?.liveArmed);
    }
  } catch {
    /* fall through to the conservative default below */
  }
  if (mode === 'live' && !liveArmed) {
    const error = new Error(
      'live mode is not armed: set mode=live, allowLive=true and create the LIVE_ARMED operator marker before starting. Paper/sim modes are the default.',
    );
    error.code = 'LIVE_NOT_ARMED';
    error.details = { mode, liveArmed };
    throw error;
  }
  return { mode, liveArmed };
}

function normalizeAgentRow(agent, includeGenome) {
  const row = { ...agent };
  if (!includeGenome) delete row.genome;
  return row;
}

/** Effective state dir from the engine's redacted config view, falling back to the row config. */
function effectiveStateDir(engine, row) {
  try {
    const view = typeof engine?.configView === 'function' ? engine.configView() : null;
    const dir = view?.stateDir ?? view?.config?.paths?.stateDir;
    if (typeof dir === 'string' && dir.length > 0) return path.resolve(dir);
  } catch {
    /* fall back to the row config */
  }
  return row.stateDir;
}

/** Operator emergency stop shared by the tool and the control route. */
async function emergencyStopEngine(holder, row, reason = 'operator emergency stop') {
  const engine = await holder.getEngine();
  const marker = path.join(effectiveStateDir(engine, row), 'KILL_SWITCH');
  let result = null;
  if (typeof engine.emergencyStop === 'function') {
    result = await engine.emergencyStop();
  } else {
    // Defensive fallback: write the same marker file the brakes check, then stop the loop.
    await fsp.mkdir(path.dirname(marker), { recursive: true });
    await fsp.writeFile(marker, `${JSON.stringify({ armedAt: new Date().toISOString(), reason })}\n`, 'utf8');
    result = { killSwitch: true, stopped: Boolean(await engine.stop?.()) };
  }
  return { killSwitch: true, stopped: true, reason, marker, engine: result };
}

// ---------------------------------------------------------------------------
// operator-only Reaper stop
//
// The Reaper has no engine control surface by design (brake D12: "the Reaper lives
// outside the engine process; agent cannot switch it off"). The ONLY way to terminate
// an external Reaper is the operator acting on the OS process. This Host-plugin helper
// exists because a previous app generation can leave an orphaned stale-generation
// Reaper running; the dashboard surfaces it and the operator may stop it by pid from
// the Host process. It is not, and must never become, an agent tool.
// ---------------------------------------------------------------------------

const REAPER_PID_FILE = 'reaper.pid';
const REAPER_HEARTBEAT_FILE = 'reaper.heartbeat.json';
const REAPER_TERM_WAIT_MS = 400;
const REAPER_KILL_WAIT_MS = 200;

/** Whether `pid` names a live process (EPERM means alive but not ours). */
function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readJsonFileQuiet(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    if (text.trim().length === 0) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function removeFileQuiet(file) {
  try {
    await fsp.rm(file, { force: true });
  } catch {
    /* best effort: a locked/absent file must not fail the operator action */
  }
}

/** Read `reaper.heartbeat.json` if present (fresh Reapers write version 2 every sweep). */
async function readReaperHeartbeat(stateDir) {
  const heartbeat = await readJsonFileQuiet(path.join(stateDir, REAPER_HEARTBEAT_FILE));
  const info = heartbeat && typeof heartbeat === 'object' ? heartbeat : {};
  const rawVersion = Number(info.heartbeatVersion ?? info.version);
  const rawSweeps = Number(info.sweeps);
  return {
    heartbeatAt: typeof info.heartbeatAt === 'string' ? info.heartbeatAt : (typeof info.at === 'string' ? info.at : null),
    heartbeatVersion: Number.isFinite(rawVersion) ? rawVersion : null,
    sweeps: Number.isFinite(rawSweeps) ? rawSweeps : null,
  };
}

/**
 * Operator-only stop of the external Reaper process.
 *
 * Reads `<stateDir>/reaper.pid` (written by the engine) and
 * `<stateDir>/reaper.heartbeat.json`, SIGTERMs the pid, waits ~400 ms, SIGKILLs if it
 * is still alive, then removes the pid file. Never throws for ordinary OS outcomes:
 * EPERM and "still alive" come back as structured failures with an operator hint.
 *
 * @param {{getEngine?: Function}} holder plugin engine holder
 * @param {{stateDir: string}} row plugin-row config
 * @param {{kill?: Function, isAlive?: Function, sleep?: Function}} [deps] test seam
 * @returns {Promise<object>} `{ok:true, stopped, pid, alive, …}` or `{ok:false, error, hint, pid}`
 */
async function stopReaperOperator(holder, row, deps = {}) {
  const kill = typeof deps.kill === 'function' ? deps.kill : process.kill.bind(process);
  const isAlive = typeof deps.isAlive === 'function' ? deps.isAlive : isProcessAlive;
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let stateDir = row?.stateDir;
  try {
    if (holder && typeof holder.getEngine === 'function') {
      const engine = await holder.getEngine();
      stateDir = effectiveStateDir(engine, row);
    }
  } catch {
    /* engine unavailable: fall back to the row stateDir */
  }
  const pidFile = path.join(stateDir, REAPER_PID_FILE);
  const pidRecord = await readJsonFileQuiet(pidFile);
  const heartbeat = await readReaperHeartbeat(stateDir);
  const base = { stateDir, pidFile, heartbeat };
  const rawPid = Number(pidRecord && typeof pidRecord === 'object' ? pidRecord.pid : pidRecord);
  const pid = Number.isFinite(rawPid) && rawPid > 0 ? rawPid : null;

  if (pid === null) {
    const hadPidFile = pidRecord !== null || fileExists(pidFile);
    if (hadPidFile) await removeFileQuiet(pidFile);
    return {
      ok: true,
      stopped: false,
      reason: pidRecord === null ? 'no reaper pid file' : 'reaper pid file has no valid pid',
      pid: null,
      alive: false,
      ...base,
    };
  }

  if (!isAlive(pid)) {
    await removeFileQuiet(pidFile);
    return { ok: true, stopped: false, reason: 'reaper is not running', pid, alive: false, ...base };
  }

  const signals = [];
  try {
    kill(pid, 'SIGTERM');
    signals.push('SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') {
      await removeFileQuiet(pidFile);
      return { ok: true, stopped: false, reason: 'reaper already exited', pid, alive: false, ...base };
    }
    if (error?.code === 'EPERM') {
      return {
        ok: false,
        error: {
          code: 'EPERM',
          message: `not permitted to stop reaper pid ${pid} from the Host process`,
          details: { pid },
        },
        hint: 'stop it from the operating system terminal',
        pid,
        alive: true,
        ...base,
      };
    }
    return {
      ok: false,
      error: { code: error?.code ?? 'REAPER_STOP_FAILED', message: error?.message ?? 'failed to signal the reaper' },
      hint: 'stop it from the operating system terminal',
      pid,
      alive: isAlive(pid),
      ...base,
    };
  }

  await sleep(REAPER_TERM_WAIT_MS);
  let alive = isAlive(pid);
  if (alive) {
    try {
      kill(pid, 'SIGKILL');
      signals.push('SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        return {
          ok: false,
          error: { code: error?.code ?? 'REAPER_STOP_FAILED', message: error?.message ?? 'failed to SIGKILL the reaper' },
          hint: 'stop it from the operating system terminal',
          pid,
          alive: isAlive(pid),
          ...base,
        };
      }
    }
    await sleep(REAPER_KILL_WAIT_MS);
    alive = isAlive(pid);
  }

  if (alive) {
    return {
      ok: false,
      error: { code: 'REAPER_STOP_FAILED', message: `reaper pid ${pid} is still alive after SIGTERM/SIGKILL` },
      hint: 'stop it from the operating system terminal',
      pid,
      alive: true,
      ...base,
    };
  }

  await removeFileQuiet(pidFile);
  return { ok: true, stopped: true, pid, alive: false, signals, reason: null, ...base };
}

// ---------------------------------------------------------------------------
// HTTP request helpers (loopback-only control route)
// ---------------------------------------------------------------------------

/** True for IPv4/IPv6 loopback literals (`127.0.0.0/8`, `::1`, IPv4-mapped variants). */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.trim().toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipv4)) return false;
  const [first] = ipv4.split('.');
  return Number(first) === 127;
}

/** True when the request arrived over a loopback socket (the local Web UI). */
function isLoopbackRequest(req) {
  try {
    return isLoopbackAddress(req?.socket?.remoteAddress ?? req?.connection?.remoteAddress);
  } catch {
    return false;
  }
}

function httpError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

/** Map a control-route failure code onto its HTTP status. */
function controlErrorStatus(code) {
  if (code === 'METHOD_NOT_ALLOWED') return 405;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'BAD_JSON' || code === 'BAD_ACTION' || code === 'CONFIRM_REQUIRED' || code === 'PAYLOAD_TOO_LARGE') return 400;
  if (code === 'LIVE_NOT_ARMED' || code === 'MODE_FORBIDDEN' || code === 'KILL_SWITCH' || code === 'REAPER_UNAVAILABLE') return 409;
  if (code === 'NOT_IMPLEMENTED') return 501;
  return 500;
}

/** Read and parse a small JSON request body. Rejections carry a stable `code`. */
function readJsonBody(req, maxBytes = CONTROL_BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    if (typeof req?.on !== 'function') {
      reject(httpError('BAD_JSON', 'request body is unavailable'));
      return;
    }
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      reject(httpError(code, message));
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > maxBytes) {
        fail('PAYLOAD_TOO_LARGE', `request body exceeds ${maxBytes} bytes`);
        try {
          req.destroy?.();
        } catch {
          /* best effort */
        }
        return;
      }
      chunks.push(buffer);
    });
    req.on('error', (error) => fail('BAD_JSON', error?.message ?? 'failed to read request body'));
    req.on('aborted', () => fail('BAD_JSON', 'request aborted while reading the body'));
    req.on('close', () => {
      if (settled) return;
      fail('BAD_JSON', 'connection closed before the request body was read');
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        reject(httpError('BAD_JSON', 'request body is not valid JSON'));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(httpError('BAD_JSON', 'request body must be a JSON object'));
        return;
      }
      resolve(parsed);
    });
  });
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

/**
 * Build the ten model-facing tool definitions bound to one plugin activation.
 * @returns {Array<object>} ToolDefinition objects (name/description/parameters/output/execute)
 */
function buildToolDefinitions(ctx, row, holder) {
  const log = pluginLogger(ctx);
  const call = (method, ...args) => holder.call(method, ...args);

  const tools = [];

  tools.push(defineTool({
    toolName: 'automaton_status',
    description:
      'Read the AUTOMATON TRADING snapshot: mode (sim/paper/live), broker account equity, treasury state and runway hours, population alive/dead/cap, per-agent rows, recent obituaries, kill-switch state, and last tick time/error. Read-only and secret-free; this is the same JSON the dashboard polls at GET /automaton/state.',
    parameters: EMPTY_PARAMS,
    isConcurrencySafe: () => true,
    execute: async () => buildState(holder, row),
  }));

  tools.push(defineTool({
    toolName: 'automaton_start',
    description:
      'Start the population\'s in-process cycle loop (Treasurer -> Prospector -> Builder -> Executor -> Replicator). Refuses live mode unless the operator has armed LIVE_ARMED; never starts the external Reaper process, which the engine owns separately. Idempotent: starting an already-running loop returns the current status.',
    parameters: EMPTY_PARAMS,
    timeoutMs: 120_000,
    execute: async () => {
      const gate = await assertStartAllowed(holder, row);
      const status = await call('start');
      log.info('engine started', { mode: gate.mode });
      return { started: true, mode: gate.mode, status };
    },
  }));

  tools.push(defineTool({
    toolName: 'automaton_stop',
    description:
      'Stop the in-process cycle loop only. The external Reaper is a separate OS process with no control surface: it keeps liquidating condemned agents and cannot be stopped by this tool, by the engine, or by an agent.',
    parameters: EMPTY_PARAMS,
    timeoutMs: 60_000,
    execute: async () => {
      const status = await call('stop');
      return { stopped: true, status, note: 'external Reaper process is unaffected by design' };
    },
  }));

  tools.push(defineTool({
    toolName: 'automaton_tick',
    description:
      'Run exactly one trading cycle now (does not change the loop schedule). Returns the cycle trace and the refreshed status; a broker/data failure comes back as a structured error envelope instead of a crash.',
    parameters: EMPTY_PARAMS,
    timeoutMs: 180_000,
    execute: async () => call('tick'),
  }));

  tools.push(defineTool({
    toolName: 'automaton_agents',
    description:
      'List the population: agent id, generation, parent, status (alive/dead/condemned), equity, runway hours, treasury state, drawdown, and cause-of-death when dead. Set includeGenome=true for the inherited strategy genomes; includeDead=false omits dead agents.',
    parameters: {
      type: 'object',
      properties: {
        includeDead: { type: 'boolean', description: 'Include dead agents in the rows (default true).' },
        includeGenome: { type: 'boolean', description: 'Include the inherited strategy genome per agent (default false).' },
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const status = await call('status');
      const includeDead = args.includeDead !== false;
      const includeGenome = args.includeGenome === true;
      const agents = (Array.isArray(status?.agents) ? status.agents : [])
        .filter((agent) => includeDead || agent?.status !== 'dead')
        .map((agent) => normalizeAgentRow(agent, includeGenome));
      return { population: status?.population ?? null, agents };
    },
  }));

  tools.push(defineTool({
    toolName: 'automaton_obituaries',
    description:
      'Read the death journal: newest-first obituaries with genome, P&L, lifespan, cause, firstProfitAt, and inherited lessons. The journal is the dataset the living read; firstProfitAt=null is the single most valuable line. Filter by cause, bound the page with limit (1-200).',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Page size, 1-200 (default 20).' },
        cause: {
          type: 'string',
          description: 'Optional death-cause filter.',
          enum: ['insufficient_funds', 'drawdown_limit', 'daily_loss_limit', 'account_not_active', 'reconciliation_mismatch', 'risk_breach'],
        },
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const limit = clampInteger(args.limit, 20, [1, 200]);
      const cause = typeof args.cause === 'string' ? args.cause : null;
      const page = normalizeObituaries(await holder.call('obituaries', { limit: cause ? 200 : limit, offset: 0 }));
      const items = (cause ? page.items.filter((item) => item?.cause === cause) : page.items).slice(0, limit);
      return { cause, limit, stats: page.stats, count: items.length, items };
    },
  }));

  tools.push(defineTool({
    toolName: 'automaton_brakes',
    description:
      'Show the 14 hard brake rules (D1-D14) and the current kill-switch/live-armed state. When symbol is supplied, also run the operator dry-run pre-trade check through the real brakes chain (agentId, symbol, side, notionalUsd, priceUsd) and return its ALLOW/DENY decision, rule id, and reason. Advisory only: the dry run does not place an order.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent whose mandate, equity, and day stats are evaluated (default: none).' },
        symbol: { type: 'string', description: 'Symbol for the dry-run check; omit to only list the rules.' },
        side: { type: 'string', enum: ['buy', 'sell'], description: 'Order side for the dry-run check (default buy).' },
        notionalUsd: { type: 'number', description: 'Order notional in USD for the dry-run check.' },
        priceUsd: { type: 'number', description: 'Optional price for the dry-run check (defaults to the last known quote/mark).' },
      },
    },
    timeoutMs: 60_000,
    execute: async (args) => {
      let brakesView = null;
      try {
        brakesView = await holder.call('brakesView');
      } catch (error) {
        brakesView = { rules: BRAKES, rulesUnavailable: true, error: safeError(error) };
      }
      const rules = Array.isArray(brakesView?.rules) ? brakesView.rules : BRAKES;
      const result = {
        count: rules.length,
        rules,
        killSwitch: Boolean(brakesView?.killSwitch),
        liveArmed: Boolean(brakesView?.liveArmed),
        mode: brakesView?.mode ?? row.mode,
        check: null,
      };
      if (typeof args.symbol === 'string' && args.symbol.trim().length > 0) {
        const checkArgs = {
          agentId: typeof args.agentId === 'string' && args.agentId.length > 0 ? args.agentId : null,
          symbol: args.symbol.trim().toUpperCase(),
          side: args.side === 'sell' ? 'sell' : 'buy',
          notionalUsd: finiteNumber(args.notionalUsd),
          priceUsd: finiteNumber(args.priceUsd),
        };
        try {
          result.check = { dryRun: true, ...(await holder.call('preTradeCheck', checkArgs)) };
        } catch (error) {
          result.check = { dryRun: true, error: safeError(error) };
        }
      }
      return result;
    },
  }));

  tools.push(defineTool({
    toolName: 'automaton_simulate',
    description:
      'Run the accelerated mortality simulation (no broker, no network, deterministic by seed): cycles (1-5000, default 200), population (1-200, default 100), seed (default 7). Returns survival/replication/death statistics so a strategy niche can be evaluated before spending real paper capital.',
    parameters: {
      type: 'object',
      properties: {
        cycles: { type: 'integer', description: 'Simulated cycles, 1-5000 (default 200).' },
        population: { type: 'integer', description: 'Initial population, 1-200 (default 100).' },
        seed: { type: 'integer', description: 'Deterministic PRNG seed (default 7).' },
      },
    },
    timeoutMs: 300_000,
    execute: async (args) => {
      const params = {
        cycles: clampInteger(args.cycles, 200, SIMULATION_LIMITS.cycles),
        population: clampInteger(args.population, 100, SIMULATION_LIMITS.population),
        seed: Number.isFinite(Number(args.seed)) ? Math.trunc(Number(args.seed)) : 7,
      };
      const result = await holder.call('simulate', params);
      return { params, result };
    },
  }));

  tools.push(defineTool({
    toolName: 'automaton_config',
    description:
      'Read the effective redacted configuration (layered defaults <- config file <- plugin row <- environment): mode, allowLive, population, endowment/death floor, burn, replication gates, risk caps, state paths, and where each layer came from. Credentials are never returned; only the env-file path and the signature source are shown.',
    parameters: EMPTY_PARAMS,
    isConcurrencySafe: () => true,
    execute: async () => {
      let view = null;
      let viewError = null;
      try {
        view = await holder.call('configView');
      } catch (error) {
        viewError = safeError(error);
      }
      const payload = {
        row: { mode: row.mode, autoStart: row.autoStart, allowLive: row.allowLive, stateDir: row.stateDir, envFile: row.envFile },
        effective: view?.config ?? null,
        summary: view?.summary ?? null,
        sources: view?.sources ?? null,
        stateDir: view?.stateDir ?? row.stateDir,
        envFile: view?.envFile ?? row.envFile,
        credentials: 'resolved from the env file at broker construction; never exposed',
      };
      if (viewError) payload.error = viewError;
      return redactSecrets(payload);
    },
  }));

  tools.push(defineTool({
    toolName: 'automaton_emergency_stop',
    description:
      'OPERATOR EMERGENCY STOP. Requires confirm exactly "STOP". Arms the kill-switch marker file (checked before every order and every cycle), stops the in-process loop, and leaves the external Reaper running so condemned agents are still liquidated. Use only for a genuine emergency; clearing the kill switch is an operator-only filesystem action.',
    parameters: {
      type: 'object',
      properties: {
        confirm: { type: 'string', enum: ['STOP'], description: 'Must be exactly "STOP".' },
        reason: { type: 'string', description: 'Optional operator note recorded with the kill-switch marker.' },
      },
      required: ['confirm'],
    },
    timeoutMs: 60_000,
    execute: async (args) => {
      if (args.confirm !== 'STOP') {
        const error = new Error('emergency stop requires confirm: "STOP"');
        error.code = 'CONFIRM_REQUIRED';
        throw error;
      }
      const reason = typeof args.reason === 'string' && args.reason.length > 0 ? args.reason : 'operator emergency stop';
      const stopped = await emergencyStopEngine(holder, row, reason);
      log.warn('EMERGENCY STOP armed', { reason });
      return {
        ...stopped,
        reaper: 'external Reaper keeps running; this tool cannot stop it',
      };
    },
  }));

  return tools;
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

/**
 * Apply the Host half of the bundle.
 * @param {object} ctx Cordis plugin context with the `tools` service injected.
 * @param {object} [config] plugin-row config: {stateDir, envFile, mode, autoStart, allowLive, config?, engineFactory?}
 */
export function apply(ctx, config) {
  const row = normalizeRowConfig(config);
  const log = pluginLogger(ctx);
  const holder = createEngineHolder(row, log);

  ctx.effect(() => {
    const disposers = buildToolDefinitions(ctx, row, holder)
      .map((definition) => ctx.tools.register(definition));
    return () => {
      while (disposers.length > 0) {
        const dispose = disposers.pop();
        try {
          dispose();
        } catch (error) {
          log.warn('tool dispose failed', safeError(error));
        }
      }
    };
  }, `${PLUGIN_ID}: tools`);

  // Routes must be registered even when this plugin activates BEFORE the web server service
  // is mounted (observed in a fresh app boot: tools register, ctx.get('webServer') is still
  // undefined, and the panel gets 404s). Late-bind with a bounded poll and dispose cleanly.
  ctx.effect(() => {
    let disposed = false;
    let timer = null;
    /** @type {Array<() => void>} */
    let disposers = [];
    let attempts = 0;

    const registerRoutes = () => {
      if (disposed) return;
      const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
      if (webServer && typeof webServer.register === 'function') {
        try {
          disposers = [
            webServer.register({
              kind: 'exact',
              path: ROUTE_PATH,
              handler: createStateHandler(holder, row, log),
            }),
            webServer.register({
              kind: 'exact',
              path: CONTROL_PATH,
              handler: createControlHandler(holder, row, log),
            }),
          ];
          log.info(`routes registered: ${ROUTE_PATH}, ${CONTROL_PATH}`);
        } catch (error) {
          log.warn('route registration failed', safeError(error));
        }
        return;
      }
      attempts += 1;
      // A slow boot gets ~60s; after that, one info line and stop polling.
      if (attempts < 120) {
        timer = setTimeout(registerRoutes, 500);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
    };

    registerRoutes();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      while (disposers.length > 0) {
        const dispose = disposers.pop();
        try {
          dispose();
        } catch (error) {
          log.warn('route dispose failed', safeError(error));
        }
      }
    };
  }, `${PLUGIN_ID}: routes (${ROUTE_PATH}, ${CONTROL_PATH})`);

  ctx.effect(() => () => holder.dispose(), `${PLUGIN_ID}: engine`);

  // Auto-start is opt-in and never allowed for live mode (paper/sim only).
  if (row.autoStart === true) {
    if (row.mode === 'sim' || row.mode === 'paper') {
      void holder.getEngine()
        .then((engine) => (typeof engine.start === 'function' ? engine.start() : undefined))
        .then(() => log.info(`auto-started engine in ${row.mode} mode`))
        .catch((error) => log.warn('auto-start failed', safeError(error)));
    } else {
      log.warn('autoStart ignored: live mode is never auto-started');
    }
  }
}

// Exported for tests and for the CLI's static checks.
export const TOOL_NAMES = Object.freeze([
  'automaton_status',
  'automaton_start',
  'automaton_stop',
  'automaton_tick',
  'automaton_agents',
  'automaton_obituaries',
  'automaton_brakes',
  'automaton_simulate',
  'automaton_config',
  'automaton_emergency_stop',
]);

// Exported for tests: route paths, the operator-only Reaper helper (host side; never a
// tool), and the Reaper pid/heartbeat file names used by that helper.
export {
  ROUTE_PATH,
  CONTROL_PATH,
  stopReaperOperator,
  REAPER_PID_FILE,
  REAPER_HEARTBEAT_FILE,
};
