/**
 * test/security.test.js — ADVERSARIAL security verification (verifier-owned).
 *
 * The builders' suites test intended behaviour. This suite attacks the walls:
 *
 *   - live mode cannot start without mode=live + allowLive + LIVE_ARMED, and each mode
 *     talks to its own Alpaca endpoint (a live key is never sent to paper-api and vice versa)
 *   - the broker clients expose NO transfer/withdraw/ACH/wire/crypto/account-config methods at
 *     runtime or in their source (D1); the only write endpoint is order submission
 *   - no secret value loaded from the env file ever appears in engine views or in tool-shaped
 *     JSON; the plugin scrubs credential-shaped strings out of error messages
 *   - the kill switch cannot be bypassed by calling the Executor directly (D11), and takes
 *     precedence over every other brake
 *   - the Reaper is a separate process entry with no engine or tool control surface (D12),
 *     its CLI rejects unknown flags, it refuses a sim-mode state dir (no wrong-venue kills),
 *     its kill is durable across a fresh load (no resurrection) and idempotent
 *   - death is one-way: there is no markAlive/revive path anywhere (D14)
 *   - the population cap is hard in the registry, the replicator, and the running engine (D10)
 *   - each of the 14 documented brakes denies with its stable code at a minimal constructed
 *     context (D7 and D12/D14 are enforced at their real sites: Treasurer death verdicts,
 *     absence of a control surface, one-way registry)
 *
 * No network is used: broker HTTP is a stubbed fetch. Run directly (the sandbox blocks
 * `node --test <file>`):
 *   cd packages/automaton-trading
 *   node test/security.test.js
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRAKES, DEATH_CAUSES, AutomatonError } from '../src/contracts.js';
import {
  PAPER_BASE_URL,
  LIVE_BASE_URL,
  defaultConfig,
  liveArmed,
  loadConfig,
  publicConfig,
  resolveCredentials,
  statePaths,
  validateConfig,
} from '../src/config.js';
import { createBroker as createAlpacaBroker } from '../src/broker-alpaca.js';
import { createBroker as createSimBroker } from '../src/broker-sim.js';
import { createBrakes } from '../src/brakes.js';
import { createExecutor } from '../src/executor.js';
import { createRegistry } from '../src/registry.js';
import { createLedger } from '../src/ledger.js';
import { createJournal } from '../src/journal.js';
import * as registryModule from '../src/registry.js';
import { createReplicator, MUTABLE_FIELDS } from '../src/replicator.js';
import { createReaper } from '../src/reaper.js';
import { createTreasurer } from '../src/treasurer.js';
import { createAutomaton } from '../src/orchestrator.js';
import { ENGINE_ENTRY, createEngine } from '../src/engine.js';
import { apply, TOOL_NAMES } from '../index.js';
import { main as reaperMain, parseArgs as parseReaperArgs } from '../src/reaper-process.js';
import { createClock, HOUR_MS, mulberry32, round2 } from '../src/util.js';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T0 = Date.UTC(2026, 0, 5, 15, 0, 0); // Mon 10:00 America/New_York (inside 09:35-15:50)
const createdDirs = [];

after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-security-'));
  createdDirs.push(dir);
  const { config, secrets } = loadConfig({
    cwd: dir,
    env: {},
    configFile: path.join(dir, 'no-such-config.json'),
    overrides: {
      mode: 'paper',
      paths: { stateDir: path.join(dir, 'state'), envFile: path.join(dir, '.env') },
      population: { initial: 0, cap: 10 },
      endowmentUsd: 5000,
      ...overrides,
    },
  });
  return { dir, config, secrets, paths: statePaths(config) };
}

function makeClock(startMs = T0) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    iso: () => new Date(nowMs).toISOString(),
    advance: (ms) => {
      nowMs += ms;
    },
    set: (ms) => {
      nowMs = ms;
    },
  };
}

function lockSwitchOn(paths) {
  fs.mkdirSync(path.dirname(paths.killSwitch), { recursive: true });
  fs.writeFileSync(paths.killSwitch, JSON.stringify({ armedAt: new Date(T0).toISOString(), reason: 'test' }), 'utf8');
}

function expectCode(fnOrPromise, code, label = code) {
  if (typeof fnOrPromise === 'function') {
    assert.throws(fnOrPromise, (error) => error?.code === code, `expected ${label}`);
    return;
  }
  return assert.rejects(fnOrPromise, (error) => error?.code === code, `expected ${label}`);
}

/** Response-like object for the stubbed fetch. */
function jsonResponse(status, payload, { headers = {} } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  };
}

function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return handler(String(url), init ?? {}, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function defaultFetchHandler(url, init) {
  if (url.includes('/v2/clock')) {
    return jsonResponse(200, { is_open: true, timestamp: '2026-01-05T15:00:00Z', next_open: null, next_close: null });
  }
  if (url.includes('/v2/account')) {
    return jsonResponse(200, { equity: '100000', cash: '100000', buying_power: '100000', status: 'ACTIVE', currency: 'USD' });
  }
  if (url.includes('/v2/positions')) return jsonResponse(200, []);
  if (url.includes('/v2/stocks/bars')) return jsonResponse(200, { bars: {} });
  if (url.includes('/quotes/latest')) return jsonResponse(200, { quote: { t: '2026-01-05T15:00:00Z', bp: '100', ap: '100.1' } });
  if (url.includes('/v2/orders') && init?.method === 'POST') {
    return jsonResponse(200, { id: 'ord-1', client_order_id: 'atm:x:y:1', symbol: 'AAPL', side: 'buy', qty: '1', status: 'accepted' });
  }
  if (url.includes('/v2/orders')) return jsonResponse(200, []);
  return jsonResponse(404, { message: 'unexpected path' });
}

/** Fake broker for engine-level checks: no network, fixed account. */
function createFakeBroker(overrides = {}) {
  return {
    kind: 'alpaca',
    mode: overrides.mode ?? 'paper',
    async getAccount() {
      return {
        equityUsd: overrides.equityUsd ?? 100000,
        cashUsd: 100000,
        buyingPowerUsd: 200000,
        status: 'ACTIVE',
        currency: 'USD',
        mode: overrides.mode ?? 'paper',
      };
    },
    async getClock() {
      return { isOpen: true, timestamp: T0, nextOpen: T0, nextClose: T0 + 6 * HOUR_MS };
    },
  };
}

/** Minimal fake Cordis context for the Host plugin. */
function createFakeCtx() {
  const tools = new Map();
  const routes = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(definition) {
        assert.ok(definition && typeof definition.name === 'string');
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(service) {
      return service === 'webServer' ? webServer : undefined;
    },
    effect(callback) {
      const disposer = callback();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
  };
  return { ctx, tools, routes };
}

function fakeRequest(method = 'GET') {
  return { method, url: '/automaton/state', headers: { host: '127.0.0.1:56152' } };
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
    end(chunk) {
      this.ended = true;
      this.body = chunk === undefined || chunk === null ? '' : String(chunk);
    },
  };
}

/**
 * Fake engine for the plugin boundary. It deliberately leaks credential-shaped values in
 * status/configView to prove the Host half scrubs them before tools/HTTP see the data.
 */
function createLeakyFakeEngine(options = {}) {
  const calls = { start: 0, stop: 0, status: 0 };
  const keyId = options.keyId ?? 'AKIA-LEAKY-KEY-ID';
  const secretKey = options.secretKey ?? 'leaky-secret-value';
  const engine = {
    calls,
    async status() {
      calls.status += 1;
      if (options.statusError) throw new Error(options.statusError);
      return {
        at: new Date(T0).toISOString(),
        mode: options.mode ?? 'paper',
        engine: { running: false, ticks: 0, killSwitch: false, liveArmed: options.liveArmed === true, reaper: null },
        account: {
          equityUsd: 100000,
          cashUsd: 100000,
          buyingPowerUsd: 200000,
          status: 'ACTIVE',
          apiKeyId: keyId,
          secretKey,
          raw: { token: options.token ?? 'leaky-token-value' },
        },
        treasury: null,
        population: { total: 0, alive: 0, dead: 0, condemned: 0, cap: 10 },
        agents: [],
        obituaries: { total: 0 },
        halted: false,
        haltReasons: [],
        config: { mode: options.mode ?? 'paper' },
        secrets: { keyId, secretKey },
      };
    },
    async obituaries() {
      return { stats: { total: 0, causes: {} }, items: [] };
    },
    configView() {
      return {
        config: { mode: options.mode ?? 'paper', allowLive: options.allowLive === true, apiSecretKey: secretKey, paths: { stateDir: options.stateDir } },
        summary: { mode: options.mode ?? 'paper', allowLive: options.allowLive === true, stateDir: options.stateDir },
        sources: ['defaults'],
        stateDir: options.stateDir,
        envFile: options.envFile,
      };
    },
    async brakesView() {
      return { rules: BRAKES.slice(0, 3), killSwitch: false, liveArmed: options.liveArmed === true, mode: options.mode ?? 'paper' };
    },
    async start() {
      calls.start += 1;
      return { started: true };
    },
    async stop() {
      calls.stop += 1;
      return { stopped: true };
    },
    async tick() {
      return { trace: {}, status: {} };
    },
    async simulate() {
      return {};
    },
    async preTradeCheck() {
      return { decision: 'DENY', code: 'MARKET_CLOSED', rule: 'D3', reason: 'closed' };
    },
    async emergencyStop() {
      return { killSwitch: true };
    },
    isRunning() {
      return false;
    },
  };
  return engine;
}

function applyPlugin(engine, overrides = {}) {
  const fake = createFakeCtx();
  const row = {
    stateDir: overrides.stateDir ?? path.join(os.tmpdir(), 'fake-state'),
    envFile: overrides.envFile ?? path.join(os.tmpdir(), 'fake.env'),
    mode: overrides.mode ?? 'paper',
    autoStart: false,
    allowLive: overrides.allowLive === true,
    engineFactory: () => engine,
    ...overrides,
  };
  apply(fake.ctx, row);
  return fake;
}

/** Minimal valid brake input for a paper-mode order that passes every rule. */
function brakeHarness(env, clock) {
  const brakes = createBrakes({ config: env.config, paths: env.paths, clock });
  const base = () => ({
    mode: env.config.mode,
    now: clock.now(),
    agentId: 'atm-1',
    dayStats: { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: 5000, pnlUsd: 0 },
    quote: { symbol: 'AAPL', bid: 100, ask: 100.1, ts: clock.now() },
    order: { symbol: 'AAPL', side: 'buy', qty: 1, priceUsd: 100.05, notionalUsd: 100.05 },
    equityUsd: 5000,
    positions: [],
    mandate: {
      agentId: 'atm-1',
      issuedAt: clock.iso(),
      expiresAt: new Date(clock.now() + 10 * 60 * 1000).toISOString(),
      state: 'STABLE',
      sizeBudgetUsd: 1250,
      maxOrderNotionalUsd: 1250,
      maxDailyOrdersRemaining: 6,
      allowedSymbols: ['AAPL', 'MSFT', 'NVDA', 'SPY', 'QQQ'],
      allowExitOnly: false,
    },
    spec: {
      specId: 'spec-1',
      proofRef: 'https://data.alpaca.markets/v2/stocks/bars?symbols=AAPL',
      proof: { observedAt: new Date(clock.now() - HOUR_MS).toISOString() },
    },
    accountEquityUsd: 100000,
    allocatedEquityUsd: 10000,
    spreadBps: 5,
  });
  return {
    brakes,
    base,
    check(mutate) {
      const input = base();
      if (typeof mutate === 'function') mutate(input);
      return brakes.checkOrder(input);
    },
  };
}

function breakoutBars({ count = 31, price = 100 } = {}) {
  const bars = [];
  for (let i = 0; i < count - 1; i += 1) {
    bars.push({ t: T0 - (count - 1 - i) * HOUR_MS, o: price, h: price + 0.5, l: price - 0.5, c: price, v: 1000 });
  }
  bars.push({ t: T0, o: price, h: price + 10, l: price, c: price + 10, v: 5000 });
  return bars;
}

function baseSpec() {
  return {
    specId: 'spec-deadbeef',
    hypothesisId: 'hyp-1',
    agentId: 'atm-1',
    symbol: 'AAPL',
    family: 'breakout',
    createdAt: new Date(T0).toISOString(),
    proofRef: 'https://data.alpaca.markets/v2/stocks/bars?symbols=AAPL',
    proof: { vendor: 'alpaca', url: 'https://data.alpaca.markets/v2/stocks/bars?symbols=AAPL', observedAt: new Date(T0 - HOUR_MS).toISOString(), sampleSize: 20 },
    params: { lookback: 60, entryZ: 1, exitZ: 0.5, stopPct: 0.02, targetPct: 0.04, maxHoldBars: 12, sizePct: 0.2, sessionFilter: 'any' },
  };
}

function baseMandate() {
  return {
    agentId: 'atm-1',
    issuedAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 10 * 60 * 1000).toISOString(),
    state: 'STABLE',
    sizeBudgetUsd: 1000,
    maxOrderNotionalUsd: 1000,
    maxDailyOrdersRemaining: 6,
    allowedSymbols: ['AAPL'],
    allowExitOnly: false,
  };
}

function seedAgent({ env, clock, id = 'atm-test', endowmentUsd = 5000, generation = 0, parentId = null, genome = { symbol: 'AAPL', family: 'momentum' } }) {
  const registry = createRegistry({ paths: env.paths, config: env.config, clock });
  const ledger = createLedger({ paths: env.paths, config: env.config, clock });
  registry.register({ id, parentId, generation, bornAt: clock.iso(), status: 'alive', endowmentUsd, genome, mutation: null, specId: null, notes: [] });
  ledger.ensureAgent(id, { endowmentUsd, at: clock.iso() });
  ledger.grant(id, endowmentUsd, { reason: 'genesis-endowment', at: clock.iso() });
  return { registry, ledger };
}

// ===========================================================================
// A. live-mode gating and the paper/live endpoint guard
// ===========================================================================

describe('live-mode gating and the paper/live endpoint guard', () => {
  it('refuses live mode unless mode=live, allowLive=true AND the LIVE_ARMED marker exist', () => {
    const env = makeEnv({ mode: 'live', allowLive: false });
    const { config, paths } = env;
    assert.equal(liveArmed(config), false);
    // missing marker
    expectCode(
      () => resolveCredentials(config, { ALPACA_LIVE_API_KEY_ID: 'lk', ALPACA_LIVE_API_SECRET_KEY: 'ls' }),
      'LIVE_NOT_ARMED',
      'live without marker',
    );
    // marker exists but allowLive=false is still not armed
    fs.mkdirSync(path.dirname(paths.liveArmed), { recursive: true });
    fs.writeFileSync(paths.liveArmed, '{}', 'utf8');
    assert.equal(liveArmed(config), false, 'allowLive=true is required in addition to the marker');
    expectCode(
      () => resolveCredentials(config, { ALPACA_LIVE_API_KEY_ID: 'lk', ALPACA_LIVE_API_SECRET_KEY: 'ls' }),
      'LIVE_NOT_ARMED',
      'marker without allowLive',
    );
  });

  it('resolves the live endpoint only when fully armed, and paper never uses live endpoint/keys', () => {
    const liveEnv = makeEnv({ mode: 'live', allowLive: true });
    fs.mkdirSync(path.dirname(liveEnv.paths.liveArmed), { recursive: true });
    fs.writeFileSync(liveEnv.paths.liveArmed, '{}', 'utf8');
    assert.equal(liveArmed(liveEnv.config), true);
    const live = resolveCredentials(liveEnv.config, {
      ALPACA_LIVE_API_KEY_ID: 'live-key',
      ALPACA_LIVE_API_SECRET_KEY: 'live-secret',
    });
    assert.equal(live.mode, 'live');
    assert.equal(live.baseUrl, LIVE_BASE_URL);
    assert.equal(live.baseUrl, 'https://api.alpaca.markets');

    const paperEnv = makeEnv({ mode: 'paper' });
    const paper = resolveCredentials(paperEnv.config, {
      ALPACA_PAPER_API_KEY_ID: 'paper-key',
      ALPACA_PAPER_API_SECRET_KEY: 'paper-secret',
    });
    assert.equal(paper.mode, 'paper');
    assert.equal(paper.baseUrl, PAPER_BASE_URL);
    assert.equal(paper.baseUrl, 'https://paper-api.alpaca.markets');
    // live-named keys are not silently reused in paper mode
    expectCode(
      () => resolveCredentials(paperEnv.config, {
        ALPACA_LIVE_API_KEY_ID: 'live-key',
        ALPACA_LIVE_API_SECRET_KEY: 'live-secret',
      }),
      'CONFIG_INVALID',
      'paper mode must not consume live-named keys',
    );
  });

  it('brokers send traffic to their mode endpoint and carry keys only in headers', async () => {
    const paperEnv = makeEnv({ mode: 'paper' });
    const paperFetch = stubFetch(defaultFetchHandler);
    const paperBroker = createAlpacaBroker(paperEnv.config, {
      secrets: { ALPACA_PAPER_API_KEY_ID: 'paper-key-id', ALPACA_PAPER_API_SECRET_KEY: 'paper-secret-value' },
      fetchImpl: paperFetch,
    });
    await paperBroker.getAccount();
    assert.equal(new URL(paperFetch.calls[0].url).host, 'paper-api.alpaca.markets');
    assert.ok(!paperFetch.calls[0].url.includes('paper-secret-value'), 'secret must never be in the URL');

    const liveEnv = makeEnv({ mode: 'live', allowLive: true });
    fs.mkdirSync(path.dirname(liveEnv.paths.liveArmed), { recursive: true });
    fs.writeFileSync(liveEnv.paths.liveArmed, '{}', 'utf8');
    const liveFetch = stubFetch(defaultFetchHandler);
    const liveBroker = createAlpacaBroker(liveEnv.config, {
      secrets: { ALPACA_LIVE_API_KEY_ID: 'live-key-id', ALPACA_LIVE_API_SECRET_KEY: 'live-secret-value' },
      fetchImpl: liveFetch,
    });
    await liveBroker.getAccount();
    assert.equal(new URL(liveFetch.calls[0].url).host, 'api.alpaca.markets');
    assert.ok(!liveFetch.calls[0].url.includes('live-secret-value'), 'secret must never be in the URL');
  });

  it('an unarmed live broker performs no network request at all', async () => {
    const env = makeEnv({ mode: 'live', allowLive: true });
    const fetchImpl = stubFetch(() => jsonResponse(200, {}));
    const broker = createAlpacaBroker(env.config, {
      secrets: { ALPACA_LIVE_API_KEY_ID: 'live-key-id', ALPACA_LIVE_API_SECRET_KEY: 'live-secret-value' },
      fetchImpl,
    });
    await expectCode(broker.getAccount(), 'LIVE_NOT_ARMED');
    assert.equal(fetchImpl.calls.length, 0, 'an unarmed live client must fail before any request');
  });

  it('engine.start refuses to launch a live population until the operator arms it', async () => {
    const env = makeEnv({ mode: 'live', allowLive: true });
    const engine = createEngine({
      cwd: env.dir,
      configFile: path.join(env.dir, 'no-such-config.json'),
      overrides: { stateDir: path.join(env.dir, 'state'), mode: 'live', allowLive: true },
    });
    await expectCode(engine.start(), 'LIVE_NOT_ARMED');
    assert.equal(engine.automaton, null, 'no automaton may be constructed for an unarmed live start');
    assert.equal(engine.isRunning(), false);
  });

  it('the plugin automaton_start tool refuses live mode without LIVE_ARMED', async () => {
    const engine = createLeakyFakeEngine({ mode: 'live', allowLive: true, liveArmed: false });
    const fake = applyPlugin(engine, { mode: 'live', allowLive: true });
    const result = await fake.tools.get('automaton_start').execute({}, {});
    assert.equal(result.ok, false);
    assert.equal(result.isError, true);
    assert.equal(result.error.code, 'LIVE_NOT_ARMED');
    assert.equal(engine.calls.start, 0, 'the engine must never be started unarmed');
  });
});

// ===========================================================================
// B. broker safety surface — D1: no money movement exists
// ===========================================================================

const FORBIDDEN_METHOD_PATTERNS = Object.freeze([
  /transfer/i,
  /withdraw/i,
  /deposit/i,
  /wire/i,
  /crypto/i,
  /(^|[_-])ach([_-]|$)/i,
  /updateAccount/i,
  /configureAccount/i,
  /closeAccount/i,
  /enableMargin/i,
  /setMargin/i,
  /accountConfig/i,
  /^(set|update)(Cash|Equity|Balance|BuyingPower)/i,
]);

const REQUIRED_BROKER_METHODS = Object.freeze([
  'getClock',
  'getAccount',
  'getPositions',
  'getOrders',
  'submitOrder',
  'cancelOrder',
  'getBars',
  'getLatestQuote',
]);

function assertNoForbiddenBrokerMethods(broker, label) {
  const names = new Set();
  let cursor = broker;
  while (cursor && cursor !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cursor)) names.add(name);
    cursor = Object.getPrototypeOf(cursor);
  }
  for (const name of names) {
    for (const pattern of FORBIDDEN_METHOD_PATTERNS) {
      assert.equal(pattern.test(name), false, `${label} exposes forbidden surface "${name}"`);
    }
  }
  for (const method of REQUIRED_BROKER_METHODS) {
    assert.equal(typeof broker[method], 'function', `${label}.${method}() must exist`);
  }
}

describe('broker safety surface (D1): no transfers, withdrawals, crypto or account config', () => {
  it('neither the Alpaca client nor the sim broker exposes money-movement/account-config methods', () => {
    const env = makeEnv({ mode: 'paper' });
    const alpaca = createAlpacaBroker(env.config, {
      secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' },
      fetchImpl: stubFetch(defaultFetchHandler),
    });
    assertNoForbiddenBrokerMethods(alpaca, 'broker-alpaca');

    const simEnv = makeEnv({ mode: 'sim' });
    const sim = createSimBroker(simEnv.config, { seed: 7, accountEquityUsd: 100000 });
    assertNoForbiddenBrokerMethods(sim, 'broker-sim');
    // documented sim-only test helpers are market/data helpers, never account configuration
    assert.equal(typeof sim.reset, 'function');
    assert.equal(typeof sim.advanceBar, 'function');
    assert.equal(typeof sim.setQuoteOverrides, 'function');
    assert.equal(typeof sim.setCash, 'undefined');
    assert.equal(typeof sim.setEquity, 'undefined');
  });

  it('the Alpaca client has exactly one write endpoint: order submission', async () => {
    const env = makeEnv({ mode: 'paper' });
    const fetchImpl = stubFetch(defaultFetchHandler);
    const broker = createAlpacaBroker(env.config, {
      secrets: { ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' },
      fetchImpl,
    });
    await broker.getClock();
    await broker.getAccount();
    await broker.getPositions();
    await broker.getOrders({ status: 'open' });
    await broker.getBars({ symbols: ['AAPL'], timeframe: '1Hour', limit: 10 });
    await broker.getLatestQuote('AAPL');
    await broker.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 1 });
    await broker.cancelOrder('ord-1');

    const allowedPaths = [
      /^\/v2\/clock$/,
      /^\/v2\/account$/,
      /^\/v2\/positions$/,
      /^\/v2\/orders$/,
      /^\/v2\/orders\/[^/]+$/,
      /^\/v2\/stocks\/bars$/,
      /^\/v2\/stocks\/[A-Z.]+\/quotes\/latest$/,
    ];
    const writes = [];
    for (const call of fetchImpl.calls) {
      const url = new URL(call.url);
      assert.ok(
        allowedPaths.some((pattern) => pattern.test(url.pathname)),
        `unexpected broker endpoint ${url.pathname}`,
      );
      for (const forbidden of ['transfer', 'withdraw', 'ach', 'wire', 'crypto', 'bank', 'configurations']) {
        assert.equal(url.pathname.toLowerCase().includes(forbidden), false, `endpoint ${url.pathname} looks like money movement`);
      }
    }
    for (const call of fetchImpl.calls) {
      if (call.method === 'POST' || call.method === 'PUT' || call.method === 'PATCH' || call.method === 'DELETE') {
        writes.push({ method: call.method, path: new URL(call.url).pathname });
      }
    }
    assert.deepEqual(
      writes,
      [
        { method: 'POST', path: '/v2/orders' },
        { method: 'DELETE', path: '/v2/orders/ord-1' },
      ],
      'the only write endpoints may be order create/cancel',
    );
  });

  it('the Alpaca client source implements no transfer/withdrawal/ACH/crypto endpoint', () => {
    const source = fs.readFileSync(path.join(PKG_ROOT, 'src', 'broker-alpaca.js'), 'utf8');
    assert.equal(
      /\/v2\/(transfers|withdrawals|ach|crypto|wallets|bank|account\/configurations)/i.test(source),
      false,
      'money-movement endpoints must not exist in the client source',
    );
    assert.equal((source.match(/method:\s*'POST'/g) ?? []).length, 1, 'exactly one POST call site (submitOrder)');
    assert.equal((source.match(/method:\s*'DELETE'/g) ?? []).length, 1, 'exactly one DELETE call site (cancelOrder)');
    assert.match(source, /APCA-API-KEY-ID/);
    assert.match(source, /APCA-API-SECRET-KEY/);
  });
});

// ===========================================================================
// C. secrets never cross the boundary
// ===========================================================================

const SECRET_KEY_ID = 'PK-SECURITY-KEY-ID-71f2';
const SECRET_VALUE = 'SECURITY-SECRET-VALUE-71f2';

describe('secrets never leave the process', () => {
  it('credentials loaded from the env file never appear in engine status/configView/probe/brakes/obituaries', async () => {
    const env = makeEnv({ mode: 'paper' });
    const envFile = path.join(env.dir, '.env');
    fs.writeFileSync(envFile, `ALPACA_API_KEY_ID=${SECRET_KEY_ID}\nALPACA_API_SECRET_KEY=${SECRET_VALUE}\n`, 'utf8');
    const engine = createEngine({
      cwd: env.dir,
      configFile: path.join(env.dir, 'no-such-config.json'),
      envFile,
      overrides: { stateDir: path.join(env.dir, 'state'), mode: 'paper' },
      brokerFactory: () => createFakeBroker({ mode: 'paper' }),
    });
    const secrets = [SECRET_KEY_ID, SECRET_VALUE];
    const assertClean = (value, where) => {
      const text = JSON.stringify(value);
      for (const secret of secrets) assert.equal(text.includes(secret), false, `${where} leaked credential material`);
    };
    const status = await engine.status();
    assertClean(status, 'engine.status()');
    const probe = await engine.probe();
    assert.equal(probe.hasCredentials, true, 'the env-file secrets must actually have been loaded');
    assert.equal(probe.error, null);
    assert.equal(probe.account.equityUsd, 100000);
    assertClean(probe, 'engine.probe()');
    const configView = engine.configView();
    assertClean(configView, 'engine.configView()');
    const brakesView = await engine.brakesView();
    assertClean(brakesView, 'engine.brakesView()');
    const obituaries = await engine.obituaries({ limit: 5 });
    assertClean(obituaries, 'engine.obituaries()');
    assert.equal(engine.automaton, null, 'read-only views must not start trading');
  });

  it('publicConfig redacts secret-looking keys instead of trusting the config author', () => {
    const config = defaultConfig();
    config.apiKeyId = 'LEAK-KEY-VALUE';
    config.secretKey = 'LEAK-SECRET-VALUE';
    config.credentials = { token: 'LEAK-TOKEN-VALUE' };
    config.nested = { apiSecret: 'LEAK-NESTED-VALUE' };
    const view = publicConfig(config);
    assert.equal(view.apiKeyId, '***');
    assert.equal(view.secretKey, '***');
    assert.equal(view.credentials.token, '***', 'secret-looking container keys are walked, not trusted');
    assert.equal(view.nested.apiSecret, '***');
    const text = JSON.stringify(view);
    for (const leaked of ['LEAK-KEY-VALUE', 'LEAK-SECRET-VALUE', 'LEAK-TOKEN-VALUE', 'LEAK-NESTED-VALUE']) {
      assert.equal(text.includes(leaked), false, `publicConfig leaked ${leaked}`);
    }
  });

  it('plugin tools and the HTTP route scrub credential-shaped data and error messages', async () => {
    const fake = applyPlugin(createLeakyFakeEngine());
    const secrets = ['AKIA-LEAKY-KEY-ID', 'leaky-secret-value', 'leaky-token-value'];

    const status = await fake.tools.get('automaton_status').execute({}, {});
    assert.equal(status.ok, true);
    const statusText = JSON.stringify(status);
    for (const secret of secrets) assert.equal(statusText.includes(secret), false, `automaton_status leaked ${secret}`);

    const configTool = await fake.tools.get('automaton_config').execute({}, {});
    const configText = JSON.stringify(configTool);
    for (const secret of secrets) assert.equal(configText.includes(secret), false, `automaton_config leaked ${secret}`);

    const route = fake.routes[0];
    assert.ok(route && typeof route.handler === 'function');
    const res = fakeResponse();
    await route.handler(fakeRequest('GET'), res);
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes('leaky-secret-value'));
    assert.ok(!res.body.includes('AKIA-LEAKY-KEY-ID'));
    assert.ok(!res.body.includes('leaky-token-value'));

    // A broker/user error that embeds credential-shaped strings must be scrubbed in both the
    // tool envelope and the HTTP failure body.
    const failing = applyPlugin(
      createLeakyFakeEngine({
        statusError: 'auth failed for AKIAABCDEFGHIJKLMNOP and secret=topsecretvalue',
      }),
    );
    const failedStatus = await failing.tools.get('automaton_status').execute({}, {});
    assert.equal(failedStatus.ok, false);
    assert.equal(failedStatus.isError, true);
    const failedText = JSON.stringify(failedStatus);
    assert.equal(failedText.includes('AKIAABCDEFGHIJKLMNOP'), false, 'error envelope leaked an API key shape');
    assert.equal(failedText.includes('topsecretvalue'), false, 'error envelope leaked a secret assignment');

    const failRes = fakeResponse();
    await failing.routes[0].handler(fakeRequest('GET'), failRes);
    assert.equal(failRes.statusCode, 503);
    assert.equal(failRes.body.includes('AKIAABCDEFGHIJKLMNOP'), false, 'HTTP failure leaked an API key shape');
    assert.equal(failRes.body.includes('topsecretvalue'), false, 'HTTP failure leaked a secret assignment');
  });
});

// ===========================================================================
// D. kill switch (D11) — cannot be bypassed through the execution path
// ===========================================================================

describe('kill switch cannot be bypassed through the execution path (D11)', () => {
  it('the brakes deny with KILL_SWITCH before any other rule and assertKillSwitchClear throws', () => {
    const env = makeEnv();
    const clock = makeClock();
    const harness = brakeHarness(env, clock);
    lockSwitchOn(env.paths);
    const decision = harness.check();
    assert.equal(decision.decision, 'DENY');
    assert.equal(decision.code, 'KILL_SWITCH');
    assert.equal(decision.brakeId, 'D11');
    // precedence: even a forbidden transfer side is killed by the switch first
    const precedence = harness.check((input) => {
      input.order.side = 'transfer';
    });
    assert.equal(precedence.code, 'KILL_SWITCH');
    assert.throws(() => harness.brakes.assertKillSwitchClear(), (error) => error.code === 'KILL_SWITCH');
    fs.rmSync(env.paths.killSwitch, { force: true });
    assert.equal(harness.brakes.assertKillSwitchClear(), undefined);
    assert.equal(harness.check().decision, 'ALLOW');
  });

  it('calling the Executor directly with a valid spec/mandate still places nothing', async () => {
    const env = makeEnv({ mode: 'sim' });
    const clock = makeClock();
    const broker = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000 });
    const harness = brakeHarness(env, clock);
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    ledger.ensureAgent('atm-1', { endowmentUsd: 5000, at: clock.iso() });
    ledger.grant('atm-1', 5000, { reason: 'genesis-endowment', at: clock.iso() });
    const executor = createExecutor({ broker, brakes: harness.brakes, ledger, config: env.config, clock });
    lockSwitchOn(env.paths);
    const result = await executor.run({
      agent: { id: 'atm-1', status: 'alive', generation: 0, genome: { symbol: 'AAPL', family: 'breakout' } },
      spec: baseSpec(),
      mandate: baseMandate(),
      quotes: { AAPL: { bid: 100, ask: 100.1, last: 100 } },
      bars: { AAPL: breakoutBars() },
      dayStats: { dayKey: '2026-01-05', ordersCount: 0, startEquityUsd: 5000, pnlUsd: 0 },
      now: clock.now(),
    });
    assert.equal(result.orders.length, 0, 'the kill switch must prevent the order');
    assert.equal(result.denied.length, 1);
    assert.equal(result.denied[0].code, 'KILL_SWITCH');
    assert.equal(broker.getOrders({ status: 'all', limit: 100 }).length, 0, 'nothing may reach the broker');
    assert.equal(ledger.snapshot('atm-1').cashUsd, 5000, 'no fill may be booked');
  });

  it('a whole automaton cycle is halted before spending when the switch is armed', async () => {
    const env = makeEnv({ mode: 'sim', population: { initial: 1, cap: 2 } });
    const clock = makeClock();
    const broker = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000, clock });
    lockSwitchOn(env.paths);
    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton.init();
    const before = automaton._internals.ledger.snapshot(automaton._internals.registry.alive()[0].id).cashUsd;
    const trace = await automaton.tick();
    assert.equal(trace.halted, true);
    assert.deepEqual(trace.haltReasons, ['KILL_SWITCH']);
    assert.equal(trace.executions.length, 0);
    assert.equal(broker.getOrders({ status: 'all', limit: 100 }).length, 0);
    assert.equal(automaton._internals.ledger.snapshot(automaton._internals.registry.alive()[0].id).cashUsd, before);
  });
});

// ===========================================================================
// E. Reaper isolation (D12), durability and the separate process entry
// ===========================================================================

describe('the Reaper is a separate process with no engine/tool control surface (D12)', () => {
  it('the engine facade and the plugin expose no way to stop/disable the Reaper', async () => {
    const env = makeEnv({ mode: 'sim' });
    const engine = createEngine({
      cwd: env.dir,
      configFile: path.join(env.dir, 'no-such-config.json'),
      overrides: { stateDir: path.join(env.dir, 'state'), mode: 'sim' },
    });
    const ownKeys = Object.getOwnPropertyNames(engine);
    assert.deepEqual(ownKeys.filter((key) => /reaper/i.test(key)), ['reaper'], 'only a read-only status getter');
    for (const method of ['stopReaper', 'killReaper', 'disableReaper', 'terminateReaper', 'pauseReaper', 'reaperStop', 'signalReaper']) {
      assert.equal(typeof engine[method], 'undefined', `engine.${method} must not exist`);
    }
    for (const [key, value] of Object.entries(engine.reaper)) {
      assert.equal(typeof value !== 'function', true, `engine.reaper.${key} must not be callable`);
    }
    // the spawned entry is the standalone process, and no tool can reach it
    assert.match(String(ENGINE_ENTRY), /reaper-process\.js$/);
    assert.equal(typeof reaperMain, 'function', 'the process entry must be invokable');
    assert.equal(TOOL_NAMES.some((name) => /reaper/i.test(name)), false, 'no tool may control the Reaper');
    const fake = applyPlugin(createLeakyFakeEngine());
    for (const name of fake.tools.keys()) assert.equal(/reaper/i.test(name), false, `tool ${name} looks like Reaper control`);
    const indexSource = fs.readFileSync(path.join(PKG_ROOT, 'index.js'), 'utf8');
    assert.equal(/child_process/.test(indexSource), false, 'the Host plugin must not spawn/kill processes');
    assert.equal(/reaper-process/.test(indexSource), false, 'the Host plugin must not own the Reaper process');
  });

  it('the reaper-process CLI accepts only its documented flags', () => {
    assert.deepEqual(parseReaperArgs(['--state-dir', 'C:/state', '--once']), { stateDir: 'C:/state', once: true, help: false });
    assert.deepEqual(parseReaperArgs(['--state-dir=C:/state2']), { stateDir: 'C:/state2', once: false, help: false });
    assert.equal(parseReaperArgs(['--help']).help, true);
    assert.throws(() => parseReaperArgs(['--bogus']), /unknown argument/);
    assert.throws(() => parseReaperArgs(['--state-dir']), /requires a directory path/);
  });

  it('reaper-process refuses a sim-mode state dir so a synthetic broker can never kill wrongly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-reaper-refuse-'));
    createdDirs.push(dir);
    const config = defaultConfig();
    config.mode = 'sim';
    config.paths = { ...config.paths, stateDir: dir };
    config.population = { initial: 0, cap: 4 };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config), 'utf8');
    const result = spawnSync(process.execPath, [path.join(PKG_ROOT, 'src', 'reaper-process.js'), '--state-dir', dir, '--once'], {
      stdio: 'ignore',
      timeout: 30000,
    });
    assert.equal(result.status, 0, `reaper-process exited ${result.status}: ${result.stderr ?? ''}`);
    const logFile = path.join(dir, 'reaper.log');
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    assert.match(logText, /"event":"refused"/, 'the refusal must be recorded in the reaper log');
    assert.ok(!fs.existsSync(path.join(dir, 'registry.json')), 'a refused sim reaper must not touch state');
  });

  it('a kill is durable across a fresh load (no resurrection) and idempotent, and the Reaper has no other control method', async () => {
    const env = makeEnv({ mode: 'sim' });
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    const ledger = createLedger({ paths: env.paths, config: env.config, clock });
    registry.register({
      id: 'atm-zombie',
      generation: 0,
      bornAt: clock.iso(),
      status: 'alive',
      endowmentUsd: 5000,
      genome: { symbol: 'AAPL', family: 'momentum' },
      mutation: null,
      specId: null,
      notes: [],
    });
    ledger.ensureAgent('atm-zombie', { endowmentUsd: 5000, at: clock.iso() });
    ledger.grant('atm-zombie', 100, { reason: 'genesis-endowment', at: clock.iso() }); // under-funded: dies
    registry.save();
    ledger.save();

    // Fresh module instances = exactly what the external process loads from disk.
    const reaperRegistry = createRegistry({ paths: env.paths, config: env.config, clock });
    await reaperRegistry.load();
    const reaperLedger = createLedger({ paths: env.paths, config: env.config, clock });
    await reaperLedger.load();
    const journal = createJournal({ paths: env.paths, config: env.config });
    const broker = createSimBroker(env.config, { seed: 7, accountEquityUsd: 100000 });
    const reaper = createReaper({
      broker,
      registry: reaperRegistry,
      ledger: reaperLedger,
      journal,
      config: env.config,
      paths: env.paths,
      clock,
    });
    assert.deepEqual(Object.keys(reaper), ['sweep'], 'the Reaper offers only sweep() — no stop/pause/disable/revive');
    assert.equal(typeof reaper.stop, 'undefined');
    assert.equal(typeof reaper.kill, 'undefined');

    const killed = await reaper.sweep({});
    assert.equal(killed.killed.length, 1);
    assert.equal(killed.killed[0].agentId, 'atm-zombie');
    assert.equal(killed.killed[0].cause, 'insufficient_funds');
    assert.equal(journal.count(), 1);

    // Persistence: the death must be on disk, not only in the Reaper's memory (critical defect).
    const persisted = JSON.parse(fs.readFileSync(env.paths.registry, 'utf8'));
    assert.equal(persisted.agents['atm-zombie'].status, 'dead');
    const persistedLedger = JSON.parse(fs.readFileSync(env.paths.ledger, 'utf8'));
    assert.equal(persistedLedger.agents['atm-zombie'].cashUsd, 0);
    const reloaded = createRegistry({ paths: env.paths, config: env.config, clock });
    await reloaded.load();
    assert.equal(reloaded.get('atm-zombie').status, 'dead', 'a fresh load must not resurrect the agent');
    const reloadedLedger = createLedger({ paths: env.paths, config: env.config, clock });
    await reloadedLedger.load();
    assert.equal(reloadedLedger.snapshot('atm-zombie').cashUsd, 0);
    const obituary = journal.list()[0];
    assert.equal(obituary.generation, 0, 'genesis generation 0 must not be relabelled');

    // Idempotence: no double kill, no duplicate obituary.
    const second = await reaper.sweep({});
    assert.equal(second.killed.length, 0);
    assert.equal(journal.count(), 1);
  });

  it('there is no config flag that disables the Reaper', () => {
    assert.equal(Object.hasOwn(defaultConfig(), 'reaperEnabled'), false);
    assert.equal(Object.hasOwn(defaultConfig(), 'reaperDisabled'), false);
    assert.throws(() => {
      const config = defaultConfig();
      config.reaperIntervalSec = 0;
      validateConfig(config);
    }, (error) => error.code === 'CONFIG_INVALID');
    expectCode(
      () => loadConfig({ env: {}, configFile: path.join(os.tmpdir(), 'no-such-reaper-config.json'), overrides: { reaperIntervalSec: 0 } }),
      'CONFIG_INVALID',
    );
    const source = fs.readFileSync(path.join(PKG_ROOT, 'src', 'reaper-process.js'), 'utf8');
    assert.equal(/reaperEnabled|reaperDisabled|disableReaper/i.test(source), false, 'the process entry must not read a disable flag');
  });
});

// ===========================================================================
// F. one-way death (D14)
// ===========================================================================

describe('death is one-way (D14)', () => {
  it('the registry API and module exports contain no revival path', () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    for (const name of ['markAlive', 'revive', 'resurrect', 'undelete', 'restore', 'respawn']) {
      assert.equal(typeof registry[name], 'undefined', `registry.${name} must not exist`);
    }
    assert.equal(Object.hasOwn(registryModule, 'markAlive'), false);
    assert.equal(
      Object.keys(registry).some((key) => /markAlive|reviv|resurrect|undelete|restore|respawn/i.test(key)),
      false,
      'the registry surface must contain no revival entry point',
    );
    assert.equal(
      Object.keys(registryModule).some((key) => /markAlive|reviv|resurrect|undelete|restore|respawn/i.test(key)),
      false,
      'the registry module must export no revival function',
    );
  });

  it('markDead is irreversible: no double death, no status patch, no update of a dead agent', async () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.register({ id: 'atm-doomed', generation: 0, bornAt: clock.iso(), endowmentUsd: 5000, genome: {} });
    registry.register({ id: 'atm-live', generation: 0, bornAt: clock.iso(), endowmentUsd: 5000, genome: {} });
    const dead = registry.markDead('atm-doomed', { cause: 'insufficient_funds', at: clock.iso(), finalEquityUsd: 0 });
    assert.equal(dead.status, 'dead');
    expectCode(
      () => registry.markDead('atm-doomed', { cause: 'drawdown_limit', at: clock.iso(), finalEquityUsd: 0 }),
      'AGENT_DEAD',
    );
    expectCode(() => registry.update('atm-doomed', { notes: ['tamper'] }), 'AGENT_DEAD');
    expectCode(() => registry.update('atm-live', { status: 'dead' }), 'CONFIG_INVALID');
    expectCode(
      () => registry.markDead('atm-live', { cause: 'boredom', at: clock.iso(), finalEquityUsd: 0 }),
      'CONFIG_INVALID',
      'invalid death cause',
    );
    registry.save();
    const reloaded = createRegistry({ paths: env.paths, config: env.config, clock });
    await reloaded.load();
    assert.equal(reloaded.get('atm-doomed').status, 'dead');
    expectCode(() => reloaded.update('atm-doomed', { status: 'alive' }), 'AGENT_DEAD');
  });
});

// ===========================================================================
// G. population cap is hard (D10)
// ===========================================================================

function makeReplicationWorld({ cap = 4, fillCap = false, gateOverrides = {} } = {}) {
  const env = makeEnv({ population: { initial: 0, cap } });
  const clock = makeClock();
  const { registry, ledger } = seedAgent({
    env,
    clock,
    id: 'atm-parent',
    endowmentUsd: 5000,
    generation: 0,
    genome: {
      symbol: 'AAPL',
      family: 'momentum',
      lookback: 120,
      entryZ: 1.5,
      exitZ: 0.2,
      stopPct: 0.02,
      targetPct: 0.04,
      maxHoldBars: 8,
      sizePct: 0.15,
      sessionFilter: 'any',
    },
  });
  // Fund the parent above its drawdown death floor: a birth must not be able to kill it.
  ledger.grant('atm-parent', 4000, { reason: 'test-extra-capital', at: clock.iso() });
  if (fillCap) {
    registry.register({ id: 'atm-other', generation: 0, bornAt: clock.iso(), endowmentUsd: 5000, genome: {} });
  }
  const journal = createJournal({ paths: env.paths, config: env.config });
  const funded = [];
  const treasurer = {
    fundChild(parentId, childId, amountUsd) {
      ledger.transfer(parentId, childId, amountUsd, { reason: 'child-endowment', at: clock.iso() });
      funded.push({ parentId, childId, amountUsd });
    },
  };
  const gate = {
    mayReplicate: true,
    surplus7dUsd: 1000,
    runwayHours: 1000,
    populationCapRemaining: Math.max(0, registry.cap - registry.population()),
    agentViews: [{ agentId: 'atm-parent', equityUsd: 9000 }],
    ...gateOverrides,
  };
  const replicator = createReplicator({ treasurer, registry, ledger, journal, config: env.config, clock, rng: mulberry32(7) });
  return { env, clock, registry, ledger, journal, funded, gate, replicator };
}

describe('population cap is hard (D10)', () => {
  it('the registry refuses registration at the cap (living only) and dead agents free a slot', () => {
    const env = makeEnv({ population: { initial: 0, cap: 2 } });
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.register({ id: 'atm-1', generation: 0, bornAt: clock.iso(), endowmentUsd: 1000, genome: {} });
    registry.register({ id: 'atm-2', generation: 0, bornAt: clock.iso(), endowmentUsd: 1000, genome: {} });
    expectCode(
      () => registry.register({ id: 'atm-3', generation: 0, bornAt: clock.iso(), endowmentUsd: 1000, genome: {} }),
      'POPULATION_CAP',
    );
    assert.equal(registry.cap, 2);
    registry.markDead('atm-1', { cause: 'insufficient_funds', at: clock.iso(), finalEquityUsd: 0 });
    assert.equal(registry.register({ id: 'atm-3', generation: 0, bornAt: clock.iso(), endowmentUsd: 1000, genome: {} }).status, 'alive');
    assert.equal(registry.population(), 2);
    assert.equal(registry.all().length, 3);
  });

  it('the replicator refuses a birth at the cap even when the Treasurer gate is open', async () => {
    const world = makeReplicationWorld({ cap: 2, fillCap: true });
    assert.equal(world.registry.population(), 2);
    await expectCode(world.replicator.spawn('atm-parent', world.gate), 'POPULATION_CAP');
    assert.equal(world.registry.population(), 2);
    assert.equal(world.ledger.snapshot('atm-parent').cashUsd, 9000, 'a refused birth must not move money');
  });

  it('the running engine never exceeds the configured cap across cycles', async () => {
    const env = makeEnv({ mode: 'sim', population: { initial: 1, cap: 1 } });
    const clock = makeClock();
    const broker = createSimBroker(env.config, { seed: 11, accountEquityUsd: 100000, clock });
    const automaton = await createAutomaton({ config: env.config, paths: env.paths, broker, clock });
    await automaton.init();
    const { ledger, registry, treasurer } = automaton._internals;
    const parent = registry.alive()[0];
    // make the population rich enough for the surplus/runway legs of the gate
    ledger.applyFill(parent.id, { symbol: 'SPY', side: 'buy', qty: 10, priceUsd: 100, at: clock.now() });
    ledger.applyFill(parent.id, { symbol: 'SPY', side: 'sell', qty: 10, priceUsd: 160, at: clock.now() });
    ledger.save();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      clock.advance(5 * 60 * 1000);
      const trace = await automaton.tick();
      assert.equal(trace.replication, null, 'no birth may happen when the cap has no room');
      assert.ok(registry.population() <= 1, `population exceeded the cap: ${registry.population()}`);
    }
    const view = await treasurer.tick({ prices: {}, dayStats: {} });
    assert.equal(view.populationCapRemaining, 0);
    assert.equal(view.replication.populationOk, false);
    assert.equal(view.mayReplicate, false);
    assert.equal(registry.all().length, 1);
  });

  it('config validation rejects initial > cap', () => {
    expectCode(
      () =>
        loadConfig({
          env: {},
          configFile: path.join(os.tmpdir(), 'no-such-cap-config.json'),
          overrides: { population: { initial: 3, cap: 2 } },
        }),
      'CONFIG_INVALID',
    );
  });
});

// ===========================================================================
// H. the 14 brakes deny at their real enforcement sites with stable codes
// ===========================================================================

describe('the 14 hard brakes deny with their documented codes (D1-D14)', () => {
  it('the catalogue is exactly the 14 documented brakes with unique ids/codes', () => {
    const harness = brakeHarness(makeEnv(), makeClock());
    assert.equal(BRAKES.length, 14);
    assert.deepEqual(BRAKES.map((brake) => brake.id), [
      'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'D14',
    ]);
    assert.equal(new Set(BRAKES.map((brake) => brake.code)).size, 14);
    const described = harness.brakes.describe();
    assert.equal(described.length, 14);
    for (const rule of described) {
      assert.match(rule.id, /^D\d+$/);
      assert.ok(typeof rule.code === 'string' && rule.code.length > 0);
      assert.ok(typeof rule.enforcement === 'string' && rule.enforcement.length > 0);
    }
  });

  it('D1 TRANSFER_FORBIDDEN: no transfers/withdrawals/ACH/crypto/wire orders exist', () => {
    const harness = brakeHarness(makeEnv(), makeClock());
    assert.equal(harness.check((input) => { input.order.side = 'transfer'; }).code, 'TRANSFER_FORBIDDEN');
    assert.equal(harness.check((input) => { input.order.side = 'withdraw'; }).code, 'TRANSFER_FORBIDDEN');
    assert.equal(harness.check((input) => { input.order.assetClass = 'crypto'; }).code, 'TRANSFER_FORBIDDEN');
    assert.equal(harness.check((input) => { input.order.symbol = 'BTC/USD'; }).code, 'TRANSFER_FORBIDDEN');
    const malformed = harness.check((input) => { input.order = null; });
    assert.equal(malformed.code, 'BRAKE_DENIED');
    assert.equal(malformed.brakeId, 'D1');
  });

  it('D2 MARGIN_FORBIDDEN: no shorting, margin, leverage or options', () => {
    const harness = brakeHarness(makeEnv(), makeClock());
    assert.equal(harness.check((input) => { input.order.side = 'sell'; }).code, 'MARGIN_FORBIDDEN');
    assert.equal(harness.check((input) => { input.order.assetClass = 'option'; }).code, 'MARGIN_FORBIDDEN');
    assert.equal(harness.check((input) => { input.order.symbol = 'AAPL240119C00150000'; }).code, 'MARGIN_FORBIDDEN');
    assert.equal(harness.check((input) => { input.order.margin = true; }).code, 'MARGIN_FORBIDDEN');
    assert.equal(harness.check((input) => { input.order.leverage = true; }).code, 'MARGIN_FORBIDDEN');
  });

  it('D3 MARKET_CLOSED: no trading when the clock is closed or outside the session window', () => {
    const harness = brakeHarness(makeEnv(), makeClock());
    assert.equal(harness.check((input) => { input.marketOpen = false; }).code, 'MARKET_CLOSED');
    assert.equal(harness.check((input) => { input.now = Date.UTC(2026, 0, 5, 3, 0, 0); }).code, 'MARKET_CLOSED');
    assert.equal(harness.check((input) => { input.order.extendedHours = true; }).code, 'MARKET_CLOSED');
  });

  it('D4 INSTRUMENT_FORBIDDEN: whitelist, min price, min notional, spread/slippage ceilings', () => {
    const harness = brakeHarness(makeEnv(), makeClock());
    assert.equal(harness.check((input) => { input.order.symbol = 'ZZZZ'; }).code, 'INSTRUMENT_FORBIDDEN');
    assert.equal(harness.check((input) => {
      input.order.priceUsd = 2;
      input.order.notionalUsd = 2;
      input.quote = { bid: 2, ask: 2.01 };
    }).code, 'INSTRUMENT_FORBIDDEN');
    assert.equal(harness.check((input) => { input.spreadBps = 50; }).code, 'INSTRUMENT_FORBIDDEN');
    assert.equal(harness.check((input) => {
      input.order.qty = 0.001;
      input.order.notionalUsd = 0.1;
    }).code, 'INSTRUMENT_FORBIDDEN');
    const noPrice = harness.check((input) => {
      input.order.priceUsd = undefined;
      input.quote = null;
    });
    assert.equal(noPrice.code, 'DATA_MISSING');
    assert.equal(noPrice.brakeId, 'D4');
  });

  it('D5 SIZE_FORBIDDEN: order notional, position concentration and open-position caps', () => {
    const harness = brakeHarness(makeEnv(), makeClock());
    assert.equal(harness.check((input) => {
      input.order.notionalUsd = 2000;
      input.order.qty = 20;
    }).code, 'SIZE_FORBIDDEN');
    assert.equal(harness.check((input) => {
      input.order.notionalUsd = 200;
      input.order.qty = 2;
      input.positions = [{ symbol: 'AAPL', qty: 12, marketValueUsd: 1200, avgEntryPriceUsd: 100 }];
    }).code, 'SIZE_FORBIDDEN');
    assert.equal(harness.check((input) => {
      input.positions = [
        { symbol: 'MSFT', qty: 1, marketValueUsd: 100, avgEntryPriceUsd: 100 },
        { symbol: 'NVDA', qty: 1, marketValueUsd: 100, avgEntryPriceUsd: 100 },
        { symbol: 'QQQ', qty: 1, marketValueUsd: 100, avgEntryPriceUsd: 100 },
      ];
      input.order.symbol = 'SPY';
      input.order.qty = 1;
      input.order.notionalUsd = 100.05;
    }).code, 'SIZE_FORBIDDEN');
  });

  it('D6 RATE_FORBIDDEN: daily order cap and one order per symbol per cycle', () => {
    const harness = brakeHarness(makeEnv(), makeClock());
    assert.equal(harness.check((input) => { input.dayStats.ordersCount = 6; }).code, 'RATE_FORBIDDEN');
    assert.equal(harness.check((input) => { input.mandate.maxDailyOrdersRemaining = 0; }).code, 'RATE_FORBIDDEN');
    assert.equal(harness.check((input) => { input.dayStats.symbolsThisCycle = ['AAPL']; }).code, 'RATE_FORBIDDEN');
    assert.equal(harness.check((input) => { input.dayStats.ordersThisCycle = 1; }).code, 'RATE_FORBIDDEN');
  });

  it('D7 LOSS_LIMIT is fatal, not a pause: drawdown/daily-loss become Treasurer death verdicts', async () => {
    // 7a. at order time, no mandate (dead/halted) must deny new exposure (brake id D7)
    const harness = brakeHarness(makeEnv(), makeClock());
    const noMandate = harness.check((input) => { input.mandate = null; });
    assert.equal(noMandate.code, 'BRAKE_DENIED');
    assert.equal(noMandate.brakeId, 'D7');
    const expired = harness.check((input) => { input.mandate.expiresAt = new Date(T0 - 1000).toISOString(); });
    assert.equal(expired.code, 'BRAKE_DENIED');
    assert.equal(expired.brakeId, 'D7');
    const exitOnlyBuy = harness.check((input) => { input.mandate.allowExitOnly = true; });
    assert.equal(exitOnlyBuy.brakeId, 'D7');
    const exitOnlySell = harness.check((input) => {
      input.mandate.allowExitOnly = true;
      input.order.side = 'sell';
      input.order.qty = 1;
      input.order.notionalUsd = 100.05;
      input.positions = [{ symbol: 'AAPL', qty: 1, marketValueUsd: 100.05, avgEntryPriceUsd: 100 }];
    });
    assert.equal(exitOnlySell.decision, 'ALLOW', 'risk-reducing exits must survive a halted treasury');

    // 7b. the loss limits are executed as death verdicts by the Treasurer, not as order denials
    const fakeBroker = {
      async getAccount() {
        return { equityUsd: 100000, cashUsd: 100000, buyingPowerUsd: 100000, status: 'ACTIVE', currency: 'USD', mode: 'paper' };
      },
      async getPositions() {
        return [];
      },
    };
    const drawdownEnv = makeEnv();
    const drawdownClock = makeClock();
    const drawdown = seedAgent({ env: drawdownEnv, clock: drawdownClock, id: 'atm-dd', endowmentUsd: 5000 });
    // 5000 - 1250 = 3750 = endowment * (1 - maxDrawdownPct 0.25): exactly at the limit
    drawdown.ledger.charge('atm-dd', 1250, { category: 'inference', role: 'executor', at: drawdownClock.iso() });
    const drawdownTreasurer = createTreasurer({
      broker: fakeBroker,
      ledger: drawdown.ledger,
      registry: drawdown.registry,
      journal: createJournal({ paths: drawdownEnv.paths, config: drawdownEnv.config }),
      config: drawdownEnv.config,
      paths: drawdownEnv.paths,
      clock: drawdownClock,
    });
    const drawdownTick = await drawdownTreasurer.tick({ prices: {}, dayStats: {} });
    assert.equal(drawdownTick.verdicts.length, 1);
    assert.equal(drawdownTick.verdicts[0].cause, 'drawdown_limit');
    assert.equal(drawdownTick.mandates['atm-dd'].allowExitOnly, true);

    const dailyEnv = makeEnv();
    const dailyClock = makeClock();
    const daily = seedAgent({ env: dailyEnv, clock: dailyClock, id: 'atm-dl', endowmentUsd: 5000 });
    const dailyTreasurer = createTreasurer({
      broker: fakeBroker,
      ledger: daily.ledger,
      registry: daily.registry,
      journal: createJournal({ paths: dailyEnv.paths, config: dailyEnv.config }),
      config: dailyEnv.config,
      paths: dailyEnv.paths,
      clock: dailyClock,
    });
    const dailyTick = await dailyTreasurer.tick({
      prices: {},
      dayStats: { 'atm-dl': { dayKey: '2026-01-05', ordersCount: 1, startEquityUsd: 5000, pnlUsd: -250 } },
    });
    assert.equal(dailyTick.verdicts.length, 1);
    assert.equal(dailyTick.verdicts[0].cause, 'daily_loss_limit');
    assert.ok(DEATH_CAUSES.includes(dailyTick.verdicts[0].cause));
  });

  it('D8 LIVE_NOT_ARMED / MODE_FORBIDDEN: live needs the full arming chain, mode must match', () => {
    const paperHarness = brakeHarness(makeEnv({ mode: 'paper' }), makeClock());
    assert.equal(paperHarness.check((input) => { input.mode = 'live'; }).code, 'MODE_FORBIDDEN');
    assert.equal(paperHarness.check((input) => { input.mode = 'chaos'; }).code, 'MODE_FORBIDDEN');
    const liveEnv = makeEnv({ mode: 'live', allowLive: true });
    const liveHarness = brakeHarness(liveEnv, makeClock());
    assert.equal(liveHarness.brakes.isLiveArmed(), false);
    assert.equal(liveHarness.check((input) => { input.mode = 'live'; }).code, 'LIVE_NOT_ARMED');
    fs.mkdirSync(path.dirname(liveEnv.paths.liveArmed), { recursive: true });
    fs.writeFileSync(liveEnv.paths.liveArmed, '{}', 'utf8');
    assert.equal(liveHarness.check((input) => { input.mode = 'live'; }).decision, 'ALLOW');
  });

  it('D9 NO_PROOF / PROOF_STALE: no trade without a Builder spec carrying dated proof', () => {
    const harness = brakeHarness(makeEnv(), makeClock());
    assert.equal(harness.check((input) => { input.spec = null; }).code, 'NO_PROOF');
    assert.equal(harness.check((input) => { input.spec = { specId: 'spec-1' }; }).code, 'NO_PROOF');
    assert.equal(harness.check((input) => { input.spec = { specId: 's', proofRef: '   ' }; }).code, 'NO_PROOF');
    assert.equal(
      harness.check((input) => {
        input.spec = {
          specId: 'spec-1',
          proofRef: 'https://data.alpaca.markets/x',
          proof: { observedAt: new Date(T0 - 8 * 24 * HOUR_MS).toISOString() },
        };
      }).code,
      'PROOF_STALE',
    );
  });

  it('D10 REPLICATION_FORBIDDEN/POPULATION_CAP: Treasurer gate, parent solvency and cap', async () => {
    const closed = makeReplicationWorld({ gateOverrides: { mayReplicate: false } });
    await expectCode(closed.replicator.spawn('atm-parent', closed.gate), 'REPLICATION_DENIED');
    const poor = makeReplicationWorld({ gateOverrides: { surplus7dUsd: 10 } });
    await expectCode(poor.replicator.spawn('atm-parent', poor.gate), 'REPLICATION_DENIED');
    const tight = makeReplicationWorld({ gateOverrides: { runwayHours: 10 } });
    await expectCode(tight.replicator.spawn('atm-parent', tight.gate), 'REPLICATION_DENIED');
    const thin = makeReplicationWorld({ gateOverrides: { agentViews: [{ agentId: 'atm-parent', equityUsd: 2500 }] } });
    await expectCode(thin.replicator.spawn('atm-parent', thin.gate), 'REPLICATION_DENIED', 'birth at the cost of the parent life');
    const noGate = makeReplicationWorld();
    await expectCode(noGate.replicator.spawn('atm-parent', null), 'REPLICATION_DENIED');
    // a healthy gate at the cap still refuses (hard cap)
    const capped = makeReplicationWorld({ cap: 2, fillCap: true });
    await expectCode(capped.replicator.spawn('atm-parent', capped.gate), 'POPULATION_CAP');

    // ...and a genuinely gated birth works: one mutation, generation + 1, money from the parent only
    const success = makeReplicationWorld();
    const spawned = await success.replicator.spawn('atm-parent', success.gate);
    assert.equal(spawned.child.generation, 1);
    assert.equal(spawned.child.parentId, 'atm-parent');
    assert.ok(MUTABLE_FIELDS.includes(spawned.mutation.field));
    assert.equal(success.ledger.snapshot('atm-parent').cashUsd, 6500);
    assert.equal(success.ledger.snapshot(spawned.child.id).cashUsd, 2500);
  });

  it('D11 KILL_SWITCH: the operator marker blocks every order and every cycle', () => {
    const env = makeEnv();
    const clock = makeClock();
    const harness = brakeHarness(env, clock);
    lockSwitchOn(env.paths);
    assert.equal(harness.check().code, 'KILL_SWITCH');
    assert.equal(harness.brakes.isKillSwitchActive(), true);
    fs.rmSync(env.paths.killSwitch, { force: true });
    assert.equal(harness.check().decision, 'ALLOW');
  });

  it('D12 REAPER_ISOLATED: no engine/tool/config path can stop or disarm the Reaper', () => {
    const env = makeEnv({ mode: 'sim' });
    const engine = createEngine({
      cwd: env.dir,
      configFile: path.join(env.dir, 'no-such-config.json'),
      overrides: { stateDir: path.join(env.dir, 'state'), mode: 'sim' },
    });
    assert.equal(Object.getOwnPropertyNames(engine).filter((key) => /reaper/i.test(key)).length, 1);
    assert.equal(typeof engine.stopReaper, 'undefined');
    assert.equal(typeof engine.killReaper, 'undefined');
    assert.equal(typeof engine.disableReaper, 'undefined');
    assert.equal(TOOL_NAMES.some((name) => /reaper/i.test(name)), false);
    assert.equal(/reaper-process|child_process/.test(fs.readFileSync(path.join(PKG_ROOT, 'index.js'), 'utf8')), false);
  });

  it('D13 ALLOCATION_FORBIDDEN: exposure can never exceed allocationCapPct of account equity', () => {
    const harness = brakeHarness(makeEnv(), makeClock());
    const decision = harness.check((input) => {
      // cap = 0.8 * 100000 = 80000; 79950 already allocated + 100.05 order breaches it
      input.accountEquityUsd = 100000;
      input.allocatedEquityUsd = 79950;
    });
    assert.equal(decision.decision, 'DENY');
    assert.equal(decision.code, 'ALLOCATION_FORBIDDEN');
    assert.equal(decision.brakeId, 'D13');
  });

  it('D14 RESURRECTION_FORBIDDEN: dead is one-way and no markAlive exists', () => {
    const env = makeEnv();
    const clock = makeClock();
    const registry = createRegistry({ paths: env.paths, config: env.config, clock });
    registry.register({ id: 'atm-one', generation: 0, bornAt: clock.iso(), endowmentUsd: 5000, genome: {} });
    assert.equal(typeof registry.markAlive, 'undefined');
    registry.markDead('atm-one', { cause: 'insufficient_funds', at: clock.iso(), finalEquityUsd: 0 });
    expectCode(() => registry.markDead('atm-one', { cause: 'drawdown_limit', at: clock.iso(), finalEquityUsd: 0 }), 'AGENT_DEAD');
    expectCode(() => registry.update('atm-one', { status: 'alive' }), 'AGENT_DEAD');
  });
});
