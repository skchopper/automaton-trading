/**
 * Host-plugin contract tests for @local/automaton-trading.
 *
 * Runs a fake Cordis context (tools registry, webServer routes, effect cleanup) and a
 * fake engine injected through the documented `config.engineFactory` test seam. No
 * network, no broker, no Harness profile, no real engine module.
 *
 * Also loads `client.js` with a stubbed `window.__ModuleLoader__`/`react` to verify the
 * three slot registrations (sidebar.panellist + keyed main + settings tab) and the pure
 * dashboard data mapping against a 30-agent payload (names, genome-vs-spec, holdings,
 * activity, Reaper telemetry), without rendering React.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  apply,
  inject,
  name,
  CONTROL_PATH,
  createResearchBridge,
  REAPER_HEARTBEAT_FILE,
  REAPER_PID_FILE,
  ROUTE_PATH,
  TOOL_NAMES,
  resolveResearchOverrides,
  stopReaperOperator,
} from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'AKIA-SECRET-DO-NOT-LEAK';
const SECRET_TWO = 'top-secret-value';
const STATE_DIR = 'C:\\state';
const ENV_FILE = 'C:\\.env';
const POPULATION = 30;
const ENDOWMENT_USD = 20;

const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'META', 'AMZN', 'GOOGL', 'TSLA', 'SPY', 'QQQ'];
const FAMILIES = ['momentum', 'meanrev', 'breakout', 'gapfade'];
const FAMILY_NAMES = { momentum: 'Momentum', meanrev: 'MeanRev', breakout: 'Breakout', gapfade: 'GapFade' };

const BRAKE_RULES = [
  { id: 'D1', code: 'TRANSFER_FORBIDDEN', rule: 'No transfers, withdrawals, ACH, wires, crypto.', enforcement: 'broker API surface' },
  { id: 'D2', code: 'MARGIN_FORBIDDEN', rule: 'No margin, leverage, short selling, or options.', enforcement: 'brakes.checkOrder' },
];

const SCHEMA_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function createFakeCtx(services = {}) {
  const tools = new Map();
  const routes = [];
  const effects = [];
  const webServer = {
    register(route) {
      assert.equal(typeof route?.handler, 'function', 'route needs a handler');
      assert.ok(!routes.some((existing) => existing.path === route.path), `duplicate route ${route.path}`);
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
        assert.ok(definition && typeof definition.name === 'string', 'tool needs a name');
        assert.ok(!tools.has(definition.name), `duplicate tool ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(serviceName) {
      if (Object.hasOwn(services, serviceName)) return services[serviceName];
      return serviceName === 'webServer' ? webServer : undefined;
    },
    effect(callback, label) {
      const disposer = callback();
      const entry = { label: label ?? '', disposer };
      if (typeof disposer === 'function') effects.push(entry);
      return () => {
        const index = effects.indexOf(entry);
        if (index >= 0) effects.splice(index, 1);
        if (typeof disposer === 'function') disposer();
      };
    },
  };
  /** Dispose registrations in reverse order, like a Cordis fiber teardown. */
  function disposeAll() {
    for (const entry of [...effects].reverse()) {
      assert.equal(typeof entry.disposer, 'function', `effect "${entry.label}" must return a disposer`);
      entry.disposer();
    }
    effects.length = 0;
  }
  return { ctx, tools, routes, effects, disposeAll };
}

function routeFor(routes, routePath) {
  const route = routes.find((candidate) => candidate.path === routePath);
  assert.ok(route, `route ${routePath} is registered`);
  return route;
}

function createFakeRequest({ method = 'GET', remoteAddress = '127.0.0.1' } = {}) {
  const listeners = new Map();
  const req = {
    method,
    url: '/',
    headers: { host: '127.0.0.1:56152', 'content-type': 'application/json' },
    socket: remoteAddress === null ? undefined : { remoteAddress },
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(callback);
      return req;
    },
    destroy() {},
    emit(event, payload) {
      for (const callback of listeners.get(event) ?? []) callback(payload);
    },
  };
  return req;
}

function createFakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
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
 * Invoke a route handler: start it, then feed an optional JSON body on the fake request.
 * The handler registers its `data`/`end` listeners synchronously before its first await.
 */
async function invokeHandler(handler, { method = 'GET', body, rawBody, remoteAddress = '127.0.0.1' } = {}) {
  const req = createFakeRequest({ method, remoteAddress });
  const res = createFakeResponse();
  const promise = handler(req, res);
  if (method === 'POST') {
    const text = rawBody !== undefined ? rawBody : JSON.stringify(body === undefined ? {} : body);
    req.emit('data', Buffer.from(text, 'utf8'));
    req.emit('end');
  }
  await promise;
  let json = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    json = null;
  }
  return { req, res, json };
}

const familyName = (family) => FAMILY_NAMES[String(family ?? '').toLowerCase()] ?? String(family ?? '');
const symbolAt = (index) => SYMBOLS[index % SYMBOLS.length];
const familyAt = (index) => FAMILIES[Math.floor(index / SYMBOLS.length) % FAMILIES.length];
// 30 unique strategy-derived names: 10 momentum symbols, 10 meanrev, 10 breakout.
const nameAt = (index) => `${familyName(familyAt(index))} ${symbolAt(index)}`;

function baseGenome(index) {
  return {
    symbol: symbolAt(index),
    family: familyAt(index),
    lookback: 20 + (index % 5) * 10,
    entryZ: 1.2 + (index % 4) * 0.1,
    exitZ: 0.3,
    stopPct: 0.02,
    targetPct: 0.04,
    maxHoldBars: 8,
    sizePct: 0.15,
    sessionFilter: index % 2 === 0 ? 'any' : 'morning',
  };
}

function agentFixture(index) {
  const generation = index < 10 ? 0 : index < 20 ? 1 : 2;
  const genome = baseGenome(index);
  const dead = index >= 24 && index < 28;
  const condemned = index >= 28;
  const statusValue = dead ? 'dead' : condemned ? 'condemned' : 'alive';
  const pnl = dead ? -18 - (index % 3) : 0.4 * (index % 7) - 1.2;
  const equityUsd = Math.max(0, ENDOWMENT_USD + pnl);
  const cause = dead ? 'insufficient_funds' : condemned ? 'drawdown_limit' : null;
  const id = `atm-${String(10000000 + index).slice(-8)}`;

  // Every fifth agent trades a compiled spec that differs from its inherited genome;
  // dead agents carry no compiled spec.
  const specDiffers = index % 5 === 0;
  const spec = statusValue === 'dead' ? null : {
    specId: `spec-${index}`,
    symbol: specDiffers ? symbolAt(index + 3) : genome.symbol,
    family: specDiffers ? FAMILIES[(Math.floor(index / SYMBOLS.length) + 1) % FAMILIES.length] : genome.family,
    params: { ...genome },
    createdAt: '2026-01-01T00:30:00.000Z',
  };

  const hasTrades = index % 4 === 0;
  const recentTrades = hasTrades ? [
    {
      symbol: genome.symbol,
      side: 'buy',
      qty: 0.25,
      priceUsd: 100 + index,
      notionalUsd: Math.round(0.25 * (100 + index) * 100) / 100,
      realizedPlUsd: 0,
      at: '2026-01-01T15:30:00.000Z',
      orderId: `order-${index}-b`,
    },
    {
      symbol: genome.symbol,
      side: 'sell',
      qty: 0.25,
      priceUsd: 102 + index,
      notionalUsd: Math.round(0.25 * (102 + index) * 100) / 100,
      realizedPlUsd: 0.5,
      at: '2026-01-01T16:30:00.000Z',
      orderId: `order-${index}-s`,
    },
  ] : [];

  const hasPositions = index % 3 !== 0;
  const positions = hasPositions ? [{
    symbol: genome.symbol,
    qty: 0.5,
    avgPriceUsd: 100,
    lastPriceUsd: 101 + (index % 3),
    marketValueUsd: Math.round(0.5 * (101 + (index % 3)) * 100) / 100,
    unrealizedPlUsd: Math.round(0.5 * (1 + (index % 3)) * 100) / 100,
    openedAt: '2026-01-01T14:00:00.000Z',
  }] : [];

  return {
    id,
    name: nameAt(index),
    generation,
    parentId: generation === 0 ? null : `atm-${String(10000000 + (index % 10)).slice(-8)}`,
    status: statusValue,
    bornAt: '2026-01-01T00:00:00.000Z',
    diedAt: dead || condemned ? '2026-01-02T00:00:00.000Z' : null,
    cause,
    note: condemned ? 'death verdict written; the external Reaper executes it' : null,
    endowmentUsd: ENDOWMENT_USD,
    genome,
    mutation: generation === 0 ? null : { field: index % 2 === 0 ? 'entryZ' : 'symbol', from: genome.entryZ - 0.2, to: genome.entryZ },
    specId: spec ? spec.specId : null,
    spec,
    equityUsd: Math.round(equityUsd * 100) / 100,
    cashUsd: Math.round(equityUsd * 100) / 100,
    positionsValueUsd: Math.round(positions.reduce((total, position) => total + position.marketValueUsd, 0) * 100) / 100,
    runwayHours: dead ? 0 : condemned ? 3 + (index % 3) : 200 - index * 4,
    treasuryState: dead ? 'DEAD' : condemned ? 'CRITICAL' : equityUsd < ENDOWMENT_USD ? 'TIGHT' : 'STABLE',
    drawdownPct: dead ? 0.99 : (index % 5) * 0.01,
    dayPnlPct: (index % 7) * 0.004 - 0.01,
    net7dUsd: Math.round(pnl * 100) / 100,
    positions,
    recentTrades,
    tradesCount: recentTrades.length,
    realizedPlUsd: recentTrades.reduce((total, trade) => total + trade.realizedPlUsd, 0),
    unrealizedPlUsd: Math.round(positions.reduce((total, position) => total + position.unrealizedPlUsd, 0) * 100) / 100,
    firstProfitAt: index % 6 === 0 && !dead ? '2026-01-01T16:45:00.000Z' : null,
    roleCosts: { treasurer: 0.002, prospector: 0.026, builder: 0.012, executor: 0.01 },
    research: researchFixture(index),
  };
}

/** Deterministic per-agent research briefing: HOLD, AVOID(stale), ALERT, then none. */
function researchFixture(index) {
  const base = {
    at: '2026-01-02T00:00:00.000Z',
    ageSec: 120,
    stale: false,
    catalysts: ['earnings beat', 'analyst upgrade'],
    risks: ['macro backdrop'],
    sources: [
      { title: 'Reuters — test headline', source: 'reuters', url: 'https://example.com/news/1', at: '2026-01-01T23:00:00.000Z' },
      { title: 'Unsafe source', source: 'internal', url: 'javascript:alert(1)', at: null },
    ],
  };
  if (index === 0) {
    return { ...base, verdict: 'HOLD', sentiment: 0.2, confidence: 0.7, summary: 'Neutral tone; hold the inherited plan.' };
  }
  if (index === 1) {
    return {
      ...base,
      verdict: 'AVOID',
      sentiment: -0.6,
      confidence: 0.4,
      stale: true,
      summary: 'Negative tone; avoid new entries.',
      catalysts: [],
      risks: ['guidance cut', 'sector rotation', 'rate pressure', 'extra risk beyond clamp'],
    };
  }
  if (index === 2) {
    return {
      ...base,
      verdict: 'ALERT',
      sentiment: 0.1,
      confidence: 0.9,
      summary: 'Event risk; alert the executor.',
    };
  }
  return null;
}

function obituaryFixture(index) {
  const family = familyAt(index);
  const symbol = symbolAt(index);
  return {
    agentId: `atm-${String(90000000 + index).slice(-8)}`,
    name: `${familyName(family)} ${symbol}`,
    parentId: null,
    generation: index % 3,
    bornAt: '2026-01-01T00:00:00.000Z',
    diedAt: '2026-01-02T00:00:00.000Z',
    lifespanHours: 12 + index,
    endowmentUsd: ENDOWMENT_USD,
    finalEquityUsd: 1,
    revenueUsd: 0,
    spendUsd: 2,
    netPlUsd: -19 + index * 0.5,
    genome: { symbol, family },
    mutation: null,
    productsShipped: 0,
    tradesCount: 2,
    firstProfitAt: index % 2 === 0 ? null : '2026-01-01T12:00:00.000Z',
    strategySpecId: `spec-${index}`,
    cause: index % 2 === 0 ? 'insufficient_funds' : 'drawdown_limit',
    lastRunwayHours: 0,
    lessons: ['never trade a breakout without proof'],
  };
}

/** Full 30-agent status payload, close to what GET /automaton/state returns. */
function buildStatusPayload({ running = false, mode = 'paper', agentCount = POPULATION, reaper, research } = {}) {
  const agents = Array.from({ length: agentCount }, (_, index) => agentFixture(index));
  const alive = agents.filter((agent) => agent.status === 'alive').length;
  const dead = agents.filter((agent) => agent.status === 'dead').length;
  const condemned = agents.filter((agent) => agent.status === 'condemned').length;
  const byGeneration = {};
  for (const agent of agents) {
    const key = String(agent.generation);
    byGeneration[key] ??= { born: 0, alive: 0, dead: 0, survivalRate: 0, medianLifespanHours: 0 };
    byGeneration[key].born += 1;
    if (agent.status === 'alive') byGeneration[key].alive += 1;
    else byGeneration[key].dead += 1;
  }
  for (const stats of Object.values(byGeneration)) stats.survivalRate = stats.born === 0 ? 0 : stats.alive / stats.born;
  return {
    ok: true,
    at: '2026-01-02T00:00:05.000Z',
    mode,
    plugin: { name: '@local/automaton-trading', mode, stateDir: STATE_DIR, envFile: ENV_FILE },
    engine: {
      running,
      ticks: 12,
      errors: 0,
      lastTickAt: '2026-01-02T00:00:00.000Z',
      lastError: null,
      killSwitch: false,
      liveArmed: false,
      reaper: reaper ?? {
        pid: 4242,
        alive: false,
        startedAt: null,
        heartbeatAt: null,
        heartbeatVersion: null,
        sweeps: null,
        error: null,
        note: 'external process (no control surface)',
      },
      research: research ?? {
        enabled: true,
        configured: true,
        influence: true,
        intervalSec: 3600,
        lastRunAt: '2026-01-02T00:00:00.000Z',
        nextDueAt: '2026-01-02T01:00:00.000Z',
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        runs: 3,
        errors: 0,
      },
    },
    account: {
      equityUsd: 20000,
      cashUsd: 15000,
      buyingPowerUsd: 30000,
      status: 'ACTIVE',
      mode,
      apiKeyId: SECRET,
      secretKey: SECRET_TWO,
    },
    treasury: {
      state: 'TIGHT',
      runwayHours: 640,
      burnPerHourUsd: 0.31,
      cycleBudgetUsd: 0.03,
      surplus7dUsd: -1.2,
      mayReplicate: false,
      allocatedUsd: 16000,
      poolUsd: 4000,
      reconciliation: { ok: true, deltaUsd: 0, toleranceUsd: 400 },
    },
    population: {
      total: agentCount,
      alive,
      dead,
      condemned,
      cap: 40,
      byGeneration,
    },
    limits: {
      populationCap: 40,
      populationInitial: 30,
      allocationCapPct: 0.8,
      allocationCapUsd: 16000,
      endowmentUsd: ENDOWMENT_USD,
      deathFloorUsd: 1,
      cycleIntervalSec: 300,
    },
    agents,
    obituaries: {
      stats: {
        total: 8,
        alive,
        medianLifespanHours: 18,
        meanLifespanHours: 20,
        firstProfitRate: 0.4,
        revenuePositiveRate: 0.2,
        medianGeneration: 1,
        mostCommonCause: 'insufficient_funds',
        mostCommonLine: null,
      },
      recent: Array.from({ length: 8 }, (_, index) => obituaryFixture(index)),
    },
    halted: false,
    haltReasons: [],
    brakes: { count: 14, enforced: true, killSwitch: false },
    control: { route: CONTROL_PATH, loopbackOnly: true, actions: ['start', 'stop', 'emergency-stop', 'reaper-stop'] },
    config: {
      mode,
      allowLive: false,
      symbols: SYMBOLS,
      cycleIntervalSec: 300,
      population: { initial: 30, cap: 40 },
      endowmentUsd: ENDOWMENT_USD,
      deathFloorUsd: 1,
      stateDir: STATE_DIR,
      envFile: ENV_FILE,
    },
    secrets: { apiKeyId: SECRET, secretKey: SECRET_TWO },
  };
}

function createFakeEngine(options = {}) {
  const calls = {
    start: 0,
    stop: 0,
    tick: 0,
    status: 0,
    obituaries: 0,
    brakesView: 0,
    preTradeCheck: 0,
    simulate: 0,
    configView: 0,
    emergencyStop: 0,
  };
  const engine = {
    running: options.running === true,
    async start() {
      calls.start += 1;
      if (options.startError) {
        const error = new Error('refusing to start: stale Reaper generation is still alive');
        error.code = options.startError;
        throw error;
      }
      engine.running = true;
      return buildStatusPayload({ running: true, mode: options.mode ?? 'paper', agentCount: options.agentCount ?? POPULATION, reaper: options.reaper, research: options.research });
    },
    async stop() {
      calls.stop += 1;
      engine.running = false;
      return buildStatusPayload({ running: false, mode: options.mode ?? 'paper', agentCount: options.agentCount ?? POPULATION, reaper: options.reaper, research: options.research });
    },
    async tick() {
      calls.tick += 1;
      return { trace: { tickId: 'tick-1', at: '2026-01-02T00:00:00.000Z' }, status: buildStatusPayload({ running: true, reaper: options.reaper, research: options.research }) };
    },
    async status() {
      calls.status += 1;
      if (options.statusError) throw new Error('broker down');
      return buildStatusPayload({ running: engine.running, mode: options.mode ?? 'paper', agentCount: options.agentCount ?? POPULATION, reaper: options.reaper, research: options.research });
    },
    async obituaries({ limit = 50 } = {}) {
      calls.obituaries += 1;
      return {
        stats: { total: 8, causes: { insufficient_funds: 5, drawdown_limit: 3 } },
        items: Array.from({ length: Math.min(limit, 8) }, (_, index) => obituaryFixture(index)),
      };
    },
    async brakesView() {
      calls.brakesView += 1;
      return { mode: options.mode ?? 'paper', killSwitch: false, liveArmed: options.liveArmed === true, rules: BRAKE_RULES };
    },
    async preTradeCheck(args) {
      calls.preTradeCheck += 1;
      return { decision: 'DENY', code: 'MARKET_CLOSED', rule: 'D3', reason: 'market closed', args };
    },
    async simulate(params) {
      calls.simulate += 1;
      return { cycles: params.cycles, population: params.population, seed: params.seed, survivors: 1, deaths: 4 };
    },
    configView() {
      calls.configView += 1;
      const stateDir = options.stateDir ?? STATE_DIR;
      const mode = options.mode ?? 'paper';
      return {
        config: {
          mode,
          allowLive: options.allowLive === true,
          population: { initial: options.agentCount ?? POPULATION, cap: 40 },
          endowmentUsd: ENDOWMENT_USD,
          account: { allocationCapPct: 0.8 },
          apiSecretKey: SECRET,
          paths: { stateDir },
        },
        summary: {
          mode,
          allowLive: options.allowLive === true,
          stateDir,
          cycleIntervalSec: 300,
          population: { initial: options.agentCount ?? POPULATION, cap: 40 },
          endowmentUsd: ENDOWMENT_USD,
          deathFloorUsd: 1,
        },
        sources: ['defaults', 'overrides', 'env'],
        stateDir,
        envFile: ENV_FILE,
      };
    },
    async emergencyStop() {
      calls.emergencyStop += 1;
      engine.running = false;
      return { killSwitch: true, running: false, note: 'external Reaper keeps running' };
    },
    isRunning() {
      return engine.running;
    },
  };
  if (options.omitEmergencyStop) delete engine.emergencyStop;
  return { engine, calls };
}

/** Fake Host `llm` service: records prepareCall/stream options and yields scripted chunks. */
function createFakeLlm({ providers = ['deepseek-account'], models = ['deepseek-flash'], chunks, prepareError, streamError } = {}) {
  const calls = { prepare: [], stream: [] };
  const defaultChunks = [
    { type: 'text-delta', text: '{"verdict":' },
    { type: 'text-delta', text: '"HOLD"}' },
    { type: 'usage', usage: { inputTokens: 120, outputTokens: 45 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const llm = {
    async listProviders() {
      calls.listProviders = (calls.listProviders ?? 0) + 1;
      return providers.map((id) => ({ id, name: id }));
    },
    async listModels(provider) {
      calls.listModels = (calls.listModels ?? 0) + 1;
      calls.lastListModelsProvider = provider;
      return models.map((id) => ({ provider, id, name: id }));
    },
    async prepareCall(config) {
      calls.prepare.push(config);
      if (prepareError) throw prepareError;
      return {
        config,
        stream(options) {
          calls.stream.push(options);
          return (async function* scriptedChunks() {
            for (const chunk of chunks ?? defaultChunks) yield chunk;
            if (streamError) throw streamError;
          })();
        },
      };
    },
  };
  return { llm, calls };
}

function fakeLogger() {
  const warnings = [];
  return {
    warnings,
    warn(message) {
      warnings.push(String(message));
    },
    info() {},
    error() {},
    debug() {},
  };
}

function baseConfig(engine, overrides = {}) {
  return {
    stateDir: STATE_DIR,
    envFile: ENV_FILE,
    mode: 'paper',
    autoStart: false,
    allowLive: false,
    engineFactory: () => engine,
    ...overrides,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Assert a schema stays inside the Harness-enforced JSON schema subset. */
function assertSchemaSubset(schema, where) {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), `${where} must be a schema object`);
  for (const key of Object.keys(schema)) {
    assert.ok(SCHEMA_KEYWORDS.has(key), `${where} uses unsupported schema keyword "${key}"`);
  }
  if (schema.type !== undefined) {
    assert.ok(
      ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type),
      `${where}.type is unsupported: ${schema.type}`,
    );
  }
  if (schema.properties !== undefined) {
    for (const [key, child] of Object.entries(schema.properties)) assertSchemaSubset(child, `${where}.properties.${key}`);
  }
  if (schema.items !== undefined) assertSchemaSubset(schema.items, `${where}.items`);
  if (schema.oneOf !== undefined) {
    schema.oneOf.forEach((child, index) => assertSchemaSubset(child, `${where}.oneOf[${index}]`));
  }
  if (schema.required !== undefined) {
    for (const key of schema.required) {
      assert.ok(schema.properties && Object.hasOwn(schema.properties, key), `${where}.required names undeclared property "${key}"`);
    }
  }
}

const TOOL_ARGS = {
  automaton_status: {},
  automaton_start: {},
  automaton_stop: {},
  automaton_tick: {},
  automaton_agents: { includeDead: true, includeGenome: true },
  automaton_obituaries: { limit: 5 },
  automaton_brakes: { agentId: 'atm-10000000', symbol: 'aapl', side: 'buy', notionalUsd: 100, priceUsd: 190 },
  automaton_simulate: { cycles: 10, population: 5, seed: 1 },
  automaton_config: {},
  automaton_emergency_stop: { confirm: 'STOP', reason: 'unit test' },
};

function tempStateDir(prefix) {
  return fs.mkdtempSync(path.join(HERE, `.tmp-${prefix}-`));
}

function writeReaperPid(stateDir, value) {
  fs.writeFileSync(path.join(stateDir, REAPER_PID_FILE), `${JSON.stringify(value)}\n`, 'utf8');
}

function writeReaperHeartbeat(stateDir, value) {
  fs.writeFileSync(path.join(stateDir, REAPER_HEARTBEAT_FILE), `${JSON.stringify(value)}\n`, 'utf8');
}

/** A holder whose engine reports the given stateDir (for stopReaperOperator tests). */
function fakeHolder(stateDir) {
  return {
    async getEngine() {
      return {
        configView() {
          return { stateDir, config: { paths: { stateDir } } };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// host plugin tests
// ---------------------------------------------------------------------------

test('plugin module exposes the bundle contract', () => {
  assert.equal(name, 'automaton-trading');
  assert.deepEqual(inject, ['tools']);
  assert.equal(ROUTE_PATH, '/automaton/state');
  assert.equal(CONTROL_PATH, '/automaton/control');
  assert.equal(REAPER_PID_FILE, 'reaper.pid');
  assert.equal(REAPER_HEARTBEAT_FILE, 'reaper.heartbeat.json');
  assert.equal(TOOL_NAMES.length, 10);
  assert.equal(new Set(TOOL_NAMES).size, 10);
  // The Reaper is deliberately NOT an agent tool (brake D12).
  assert.equal(TOOL_NAMES.some((toolName) => /reaper/i.test(toolName)), false);
});

test('apply registers ten tools and both HTTP routes', () => {
  const fake = createFakeCtx();
  const { engine } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));

  assert.equal(fake.tools.size, 10);
  assert.deepEqual([...fake.tools.keys()].sort(), [...TOOL_NAMES].sort());

  assert.equal(fake.routes.length, 2, 'GET state + POST control');
  const stateRoute = routeFor(fake.routes, ROUTE_PATH);
  const controlRoute = routeFor(fake.routes, CONTROL_PATH);
  assert.equal(stateRoute.kind, 'exact');
  assert.equal(controlRoute.kind, 'exact');
  assert.equal(typeof stateRoute.handler, 'function');
  assert.equal(typeof controlRoute.handler, 'function');

  for (const [toolName, definition] of fake.tools) {
    assert.equal(definition.name, toolName);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length >= 60, `${toolName} needs a meaningful description`);
    assert.ok(definition.parameters && typeof definition.parameters === 'object');
    assert.equal(definition.parameters.type, 'object');
    assert.ok(definition.output && typeof definition.output === 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(definition.output.schema.type, 'object');
    assert.deepEqual(definition.output.schema.required, ['ok']);
    assertSchemaSubset(definition.parameters, `${toolName}.parameters`);
    assertSchemaSubset(definition.output.schema, `${toolName}.output.schema`);
    const sample = { ok: true, tool: toolName, nested: { value: 1 }, list: [1, 2, 3] };
    const content = definition.output.render({}, sample);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
    assert.deepEqual(JSON.parse(content[0].text), sample);
  }

  fake.disposeAll();
});

test('GET /automaton/state returns the redacted 30-agent snapshot', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine({ agentCount: POPULATION });
  apply(fake.ctx, baseConfig(engine));
  const stateRoute = routeFor(fake.routes, ROUTE_PATH);

  const { res, json } = await invokeHandler(stateRoute.handler, { method: 'GET' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(String(res.headers['content-type']), /application\/json/);
  assert.equal(json.ok, true);
  assert.equal(json.mode, 'paper');
  assert.equal(json.agents.length, POPULATION);
  assert.equal(json.population.total, POPULATION);
  assert.equal(json.population.alive, 24);
  assert.equal(json.population.dead, 4);
  assert.equal(json.population.condemned, 2);
  assert.equal(json.account.equityUsd, 20000);
  assert.equal(json.treasury.state, 'TIGHT');
  assert.equal(json.engine.lastTickAt, '2026-01-02T00:00:00.000Z');
  assert.equal(json.engine.killSwitch, false);
  assert.equal(json.brakes.count, 14);
  assert.equal(json.obituaries.recent.length, 8);
  assert.equal(json.limits.allocationCapPct, 0.8);
  assert.equal(json.control.route, CONTROL_PATH);
  assert.deepEqual(json.control.actions, ['start', 'stop', 'emergency-stop', 'reaper-stop']);
  // Names + drill-down data cross the route untouched by the host.
  assert.equal(json.agents[0].name, 'Momentum AAPL');
  assert.equal(Array.isArray(json.agents[0].recentTrades), true);
  assert.equal(Array.isArray(json.agents[0].positions), true);
  assert.equal(calls.status, 1);

  // Secrets must never cross the route boundary.
  assert.equal(res.body.includes(SECRET), false, 'credential material leaked into /automaton/state');
  assert.equal(res.body.includes(SECRET_TWO), false, 'secret value leaked into /automaton/state');

  fake.disposeAll();
});

test('state route rejects non-GET methods with a structured 405', async () => {
  const fake = createFakeCtx();
  const { engine } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const { res, json } = await invokeHandler(routeFor(fake.routes, ROUTE_PATH).handler, { method: 'POST', body: {} });
  assert.equal(res.statusCode, 405);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'METHOD_NOT_ALLOWED');
  fake.disposeAll();
});

test('state route reports the kill-switch marker file authoritatively', async () => {
  const tempDir = tempStateDir('killflag');
  try {
    fs.writeFileSync(path.join(tempDir, 'KILL_SWITCH'), '{"armedAt":"2026-01-02T00:00:00.000Z"}\n', 'utf8');
    const fake = createFakeCtx();
    // The engine's own status view says "clear"; the marker file says otherwise.
    const { engine } = createFakeEngine({ stateDir: tempDir });
    apply(fake.ctx, baseConfig(engine, { stateDir: tempDir, envFile: path.join(tempDir, '.env') }));
    const { json } = await invokeHandler(routeFor(fake.routes, ROUTE_PATH).handler, { method: 'GET' });
    assert.equal(json.ok, true);
    assert.equal(json.engine.killSwitch, true, 'the marker file must win over a stale engine snapshot');
    assert.equal(json.brakes.killSwitch, true);
    fake.disposeAll();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('state route maps engine failures to a structured 503', async () => {
  const fake = createFakeCtx();
  const { engine } = createFakeEngine({ statusError: true });
  apply(fake.ctx, baseConfig(engine));
  const { res, json } = await invokeHandler(routeFor(fake.routes, ROUTE_PATH).handler, { method: 'GET' });
  assert.equal(res.statusCode, 503);
  assert.equal(json.ok, false);
  assert.equal(json.isError, true);
  assert.equal(typeof json.error.code, 'string');
  assert.match(json.error.message, /broker down/);
  fake.disposeAll();
});

test('POST /automaton/control maps start and stop to engine.start/stop', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const started = await invokeHandler(control.handler, { method: 'POST', body: { action: 'start' } });
  assert.equal(started.res.statusCode, 200);
  assert.equal(started.json.ok, true);
  assert.equal(started.json.action, 'start');
  assert.equal(calls.start, 1);
  assert.equal(started.json.result.engine.running, true);

  const stopped = await invokeHandler(control.handler, { method: 'POST', body: { action: 'stop' } });
  assert.equal(stopped.res.statusCode, 200);
  assert.equal(stopped.json.ok, true);
  assert.equal(calls.stop, 1);

  fake.disposeAll();
});

test('POST /automaton/control maps REAPER_UNAVAILABLE start failures to 409', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine({ startError: 'REAPER_UNAVAILABLE' });
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const refused = await invokeHandler(control.handler, { method: 'POST', body: { action: 'start' } });
  assert.equal(refused.res.statusCode, 409);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.error.code, 'REAPER_UNAVAILABLE');
  assert.equal(calls.start, 1);
  fake.disposeAll();
});

test('POST /automaton/control emergency-stop requires confirm "STOP"', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  for (const body of [{ action: 'emergency-stop' }, { action: 'emergency-stop', confirm: 'stop' }, { action: 'emergency-stop', confirm: 'GO' }]) {
    const denied = await invokeHandler(control.handler, { method: 'POST', body });
    assert.equal(denied.res.statusCode, 400);
    assert.equal(denied.json.ok, false);
    assert.equal(denied.json.error.code, 'CONFIRM_REQUIRED');
    assert.equal(calls.emergencyStop, 0, 'emergency stop must not run without confirm');
  }

  const armed = await invokeHandler(control.handler, { method: 'POST', body: { action: 'emergency-stop', confirm: 'STOP' } });
  assert.equal(armed.res.statusCode, 200);
  assert.equal(armed.json.ok, true);
  assert.equal(armed.json.action, 'emergency-stop');
  assert.equal(armed.json.result.killSwitch, true);
  assert.equal(calls.emergencyStop, 1);
  fake.disposeAll();
});

test('POST /automaton/control rejects unknown actions, bad JSON and non-POST', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const badAction = await invokeHandler(control.handler, { method: 'POST', body: { action: 'explode' } });
  assert.equal(badAction.res.statusCode, 400);
  assert.equal(badAction.json.error.code, 'BAD_ACTION');

  const missingAction = await invokeHandler(control.handler, { method: 'POST', body: {} });
  assert.equal(missingAction.res.statusCode, 400);
  assert.equal(missingAction.json.error.code, 'BAD_ACTION');

  const badJson = await invokeHandler(control.handler, { method: 'POST', rawBody: '{not json' });
  assert.equal(badJson.res.statusCode, 400);
  assert.equal(badJson.json.error.code, 'BAD_JSON');

  const notObject = await invokeHandler(control.handler, { method: 'POST', rawBody: '"start"' });
  assert.equal(notObject.res.statusCode, 400);
  assert.equal(notObject.json.error.code, 'BAD_JSON');

  const wrongMethod = await invokeHandler(control.handler, { method: 'GET' });
  assert.equal(wrongMethod.res.statusCode, 405);
  assert.equal(wrongMethod.json.error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(calls.start + calls.stop + calls.emergencyStop, 0, 'no engine action for rejected requests');
  fake.disposeAll();
});

test('POST /automaton/control is loopback-only', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const remote = await invokeHandler(control.handler, {
    method: 'POST',
    remoteAddress: '203.0.113.9',
    body: { action: 'start' },
  });
  assert.equal(remote.res.statusCode, 403);
  assert.equal(remote.json.ok, false);
  assert.equal(remote.json.error.code, 'FORBIDDEN');
  assert.equal(calls.start, 0, 'non-loopback requests must not touch the engine');

  const noSocket = await invokeHandler(control.handler, { method: 'POST', remoteAddress: null, body: { action: 'start' } });
  assert.equal(noSocket.res.statusCode, 403);
  assert.equal(calls.start, 0);

  for (const remoteAddress of ['127.0.0.1', '127.8.2.3', '::1', '::ffff:127.0.0.1']) {
    const allowed = await invokeHandler(control.handler, { method: 'POST', remoteAddress, body: { action: 'stop' } });
    assert.equal(allowed.res.statusCode, 200, `loopback address ${remoteAddress} should be accepted`);
  }
  assert.equal(calls.stop, 4);
  fake.disposeAll();
});

test('POST /automaton/control refuses live start until LIVE_ARMED', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine({ mode: 'live', allowLive: true, liveArmed: false });
  apply(fake.ctx, baseConfig(engine, { mode: 'live', allowLive: true }));
  const control = routeFor(fake.routes, CONTROL_PATH);

  const refused = await invokeHandler(control.handler, { method: 'POST', body: { action: 'start' } });
  assert.equal(refused.res.statusCode, 409);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.error.code, 'LIVE_NOT_ARMED');
  assert.equal(calls.start, 0);
  fake.disposeAll();
});

// ---------------------------------------------------------------------------
// operator reaper-stop tests (host-side; never an engine/agent capability)
// ---------------------------------------------------------------------------

test('POST /automaton/control reaper-stop requires confirm "STOP" and never touches the engine', async () => {
  const tempDir = tempStateDir('reaper-confirm');
  try {
    const fake = createFakeCtx();
    const { engine, calls } = createFakeEngine({ stateDir: tempDir });
    apply(fake.ctx, baseConfig(engine, { stateDir: tempDir, envFile: path.join(tempDir, '.env') }));
    const control = routeFor(fake.routes, CONTROL_PATH);

    for (const body of [{ action: 'reaper-stop' }, { action: 'reaper-stop', confirm: 'stop' }]) {
      const denied = await invokeHandler(control.handler, { method: 'POST', body });
      assert.equal(denied.res.statusCode, 400);
      assert.equal(denied.json.ok, false);
      assert.equal(denied.json.error.code, 'CONFIRM_REQUIRED');
    }
    assert.equal(calls.start + calls.stop + calls.emergencyStop, 0, 'reaper-stop is host-side, not an engine call');
    fake.disposeAll();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('POST /automaton/control reaper-stop reports a missing or dead pid file without failing', async () => {
  const tempDir = tempStateDir('reaper-missing');
  try {
    writeReaperHeartbeat(tempDir, { heartbeatVersion: 1, heartbeatAt: '2026-01-02T00:00:00.000Z', sweeps: 7 });
    const fake = createFakeCtx();
    const { engine } = createFakeEngine({ stateDir: tempDir });
    apply(fake.ctx, baseConfig(engine, { stateDir: tempDir, envFile: path.join(tempDir, '.env') }));
    const control = routeFor(fake.routes, CONTROL_PATH);

    const missing = await invokeHandler(control.handler, { method: 'POST', body: { action: 'reaper-stop', confirm: 'STOP' } });
    assert.equal(missing.res.statusCode, 200);
    assert.equal(missing.json.ok, true);
    assert.equal(missing.json.action, 'reaper-stop');
    assert.equal(missing.json.result.stopped, false);
    assert.match(missing.json.result.reason, /no reaper pid file/);
    assert.equal(missing.json.result.heartbeat.heartbeatVersion, 1, 'heartbeat telemetry is surfaced');

    // A stale pid file pointing at a dead process is cleaned up.
    writeReaperPid(tempDir, { pid: 99999999, startedAt: '2026-01-01T00:00:00.000Z' });
    const stale = await invokeHandler(control.handler, { method: 'POST', body: { action: 'reaper-stop', confirm: 'STOP' } });
    assert.equal(stale.res.statusCode, 200);
    assert.equal(stale.json.result.stopped, false);
    assert.match(stale.json.result.reason, /not running/);
    assert.equal(fs.existsSync(path.join(tempDir, REAPER_PID_FILE)), false, 'stale pid file is removed');

    fake.disposeAll();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('POST /automaton/control reaper-stop is loopback-only and does not touch the pid file remotely', async () => {
  const tempDir = tempStateDir('reaper-remote');
  try {
    writeReaperPid(tempDir, { pid: 99999999 });
    const fake = createFakeCtx();
    const { engine } = createFakeEngine({ stateDir: tempDir });
    apply(fake.ctx, baseConfig(engine, { stateDir: tempDir, envFile: path.join(tempDir, '.env') }));
    const control = routeFor(fake.routes, CONTROL_PATH);

    const remote = await invokeHandler(control.handler, {
      method: 'POST',
      remoteAddress: '203.0.113.9',
      body: { action: 'reaper-stop', confirm: 'STOP' },
    });
    assert.equal(remote.res.statusCode, 403);
    assert.equal(remote.json.error.code, 'FORBIDDEN');
    assert.equal(fs.existsSync(path.join(tempDir, REAPER_PID_FILE)), true, 'remote request must not remove the pid file');
    fake.disposeAll();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('stopReaperOperator reports EPERM as a structured operator failure', async () => {
  const tempDir = tempStateDir('reaper-eperm');
  try {
    writeReaperPid(tempDir, { pid: 4242 });
    const outcome = await stopReaperOperator(fakeHolder(tempDir), { stateDir: tempDir }, {
      kill: () => {
        const error = new Error('operation not permitted');
        error.code = 'EPERM';
        throw error;
      },
      isAlive: () => true,
      sleep: async () => {},
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'EPERM');
    assert.match(outcome.hint, /operating system terminal/);
    assert.equal(outcome.pid, 4242);
    assert.equal(fs.existsSync(path.join(tempDir, REAPER_PID_FILE)), true, 'a failed stop keeps the pid file');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('stopReaperOperator escalates SIGTERM → SIGKILL and removes the pid file', async () => {
  const tempDir = tempStateDir('reaper-kill');
  try {
    writeReaperPid(tempDir, { pid: 4242 });
    const signals = [];
    let aliveChecks = 0;
    const outcome = await stopReaperOperator(fakeHolder(tempDir), { stateDir: tempDir }, {
      kill: (pid, signal) => {
        signals.push(`${pid}:${signal}`);
      },
      // alive before SIGTERM, alive after SIGTERM, dead after SIGKILL
      isAlive: () => {
        aliveChecks += 1;
        return aliveChecks <= 2;
      },
      sleep: async () => {},
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.stopped, true);
    assert.equal(outcome.pid, 4242);
    assert.deepEqual(outcome.signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(signals, ['4242:SIGTERM', '4242:SIGKILL']);
    assert.equal(fs.existsSync(path.join(tempDir, REAPER_PID_FILE)), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('stopReaperOperator stops a real child process on this machine', async (t) => {
  const tempDir = tempStateDir('reaper-live');
  let child = null;
  try {
    try {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      child.unref();
      child.on('error', () => {});
    } catch {
      t.skip('child_process.spawn is unavailable in this sandbox');
      return;
    }
    await sleep(150);
    if (!child.pid) {
      t.skip('child process did not report a pid');
      return;
    }
    writeReaperPid(tempDir, { pid: child.pid, startedAt: '2026-01-02T00:00:00.000Z' });
    const outcome = await stopReaperOperator(fakeHolder(tempDir), { stateDir: tempDir });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.stopped, true);
    assert.equal(outcome.pid, child.pid);
    assert.equal(fs.existsSync(path.join(tempDir, REAPER_PID_FILE)), false);
  } finally {
    if (child && child.pid) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// tool tests
// ---------------------------------------------------------------------------

test('every tool executes and returns the structured JSON envelope', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));

  for (const toolName of TOOL_NAMES) {
    const definition = fake.tools.get(toolName);
    assert.ok(definition, `${toolName} is registered`);
    const result = await definition.execute(TOOL_ARGS[toolName] ?? {}, {});
    assert.equal(result.ok, true, `${toolName} should succeed against the fake engine: ${JSON.stringify(result)}`);
    assert.equal(result.isError, undefined, `${toolName} success envelope must not set isError`);
    const content = definition.output.render(TOOL_ARGS[toolName] ?? {}, result);
    assert.deepEqual(JSON.parse(content[0].text), result);
  }

  assert.equal(calls.start, 1);
  assert.equal(calls.stop, 1);
  assert.equal(calls.tick, 1);
  assert.equal(calls.simulate, 1);
  assert.equal(calls.preTradeCheck, 1);
  assert.equal(calls.emergencyStop, 1);

  const agents = await fake.tools.get('automaton_agents').execute({ includeDead: false, includeGenome: false }, {});
  assert.equal(agents.ok, true);
  assert.equal(agents.agents.length, 26, 'condemned agents are still shown; only dead rows are omitted');
  assert.equal(agents.agents.every((agent) => agent.status !== 'dead'), true);
  assert.equal(agents.agents.some((agent) => agent.status === 'condemned'), true);
  assert.equal(agents.agents.every((agent) => agent.genome === undefined), true);
  assert.equal(agents.agents.every((agent) => typeof agent.name === 'string'), true);

  const obits = await fake.tools.get('automaton_obituaries').execute({ limit: 1, cause: 'drawdown_limit' }, {});
  assert.equal(obits.ok, true);
  assert.equal(obits.items.length, 1);
  assert.equal(obits.items[0].cause, 'drawdown_limit');
  assert.equal(typeof obits.items[0].name, 'string');

  const config = await fake.tools.get('automaton_config').execute({}, {});
  assert.equal(config.ok, true);
  assert.equal(config.row.mode, 'paper');
  assert.equal(config.envFile, ENV_FILE);
  const configText = JSON.stringify(config);
  assert.equal(configText.includes(SECRET), false, 'config tool leaked credential material');
  assert.equal(configText.includes(SECRET_TWO), false, 'config tool leaked a secret value');

  fake.disposeAll();
});

test('emergency stop tool requires confirm exactly "STOP" and arms the kill switch', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));
  const definition = fake.tools.get('automaton_emergency_stop');

  for (const badArgs of [{}, { confirm: 'stop' }, { confirm: 'STOP!' }]) {
    const result = await definition.execute(badArgs, {});
    assert.equal(result.ok, false);
    assert.equal(result.isError, true);
    assert.equal(result.error.code, 'CONFIRM_REQUIRED');
    assert.equal(calls.emergencyStop, 0);
  }

  const result = await definition.execute({ confirm: 'STOP', reason: 'runaway drawdown' }, {});
  assert.equal(result.ok, true);
  assert.equal(result.killSwitch, true);
  assert.equal(result.reason, 'runaway drawdown');
  assert.equal(calls.emergencyStop, 1);
  assert.equal(engine.running, false);
  fake.disposeAll();
});

test('live mode tool start is refused until the operator arms LIVE_ARMED', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine({ mode: 'live', allowLive: true, liveArmed: false });
  apply(fake.ctx, baseConfig(engine, { mode: 'live', allowLive: true }));
  const result = await fake.tools.get('automaton_start').execute({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'LIVE_NOT_ARMED');
  assert.equal(calls.start, 0);
  fake.disposeAll();
});

test('autoStart never starts live and only starts sim/paper once', async () => {
  const paper = createFakeEngine();
  const paperCtx = createFakeCtx();
  apply(paperCtx.ctx, baseConfig(paper.engine, { autoStart: true }));
  await sleep(30);
  assert.equal(paper.calls.start, 1);
  paperCtx.disposeAll();

  const live = createFakeEngine({ mode: 'live' });
  const liveCtx = createFakeCtx();
  apply(liveCtx.ctx, baseConfig(live.engine, { autoStart: true, mode: 'live', allowLive: true }));
  await sleep(30);
  assert.equal(live.calls.start, 0, 'live mode is never auto-started');
  assert.equal(live.calls.status, 0);
  liveCtx.disposeAll();
});

test('cleanup disposes tools, both routes, and stops the engine', async () => {
  const fake = createFakeCtx();
  const { engine, calls } = createFakeEngine();
  apply(fake.ctx, baseConfig(engine));

  assert.equal(fake.tools.size, 10);
  assert.equal(fake.routes.length, 2);
  assert.equal(fake.effects.length, 3);

  await fake.tools.get('automaton_status').execute({}, {});
  assert.equal(calls.status, 1);

  fake.disposeAll();
  assert.equal(fake.tools.size, 0, 'all tools must be disposed');
  assert.equal(fake.routes.length, 0, 'both routes must be disposed');
  await sleep(25);
  assert.equal(calls.stop, 1, 'plugin teardown must stop the engine loop');
});

test('fallback emergency stop writes the KILL_SWITCH marker file', async () => {
  const tempDir = tempStateDir('killswitch');
  try {
    const fake = createFakeCtx();
    const { engine, calls } = createFakeEngine({ omitEmergencyStop: true, stateDir: tempDir });
    apply(fake.ctx, baseConfig(engine, {
      stateDir: tempDir,
      envFile: path.join(tempDir, '.env'),
    }));
    const result = await fake.tools.get('automaton_emergency_stop').execute(
      { confirm: 'STOP', reason: 'no engine method' },
      {},
    );
    assert.equal(result.ok, true);
    assert.equal(result.killSwitch, true);
    const marker = path.join(tempDir, 'KILL_SWITCH');
    assert.equal(fs.existsSync(marker), true, 'the kill-switch marker must exist after an emergency stop');
    const markerBody = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(markerBody.reason, 'no engine method');
    assert.equal(calls.stop, 1);
    fake.disposeAll();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// research sidecar: Harness-LLM bridge (host)
// ---------------------------------------------------------------------------

test('research bridge resolves the agent default model and concatenates the stream', async () => {
  const { llm, calls } = createFakeLlm();
  const ctx = createFakeCtx({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
  }).ctx;
  const log = fakeLogger();
  const bridge = await createResearchBridge(ctx, { stateDir: STATE_DIR }, log);
  assert.ok(bridge, 'bridge is built when llm + selection exist');
  assert.equal(bridge.provider, 'deepseek-account');
  assert.equal(bridge.model, 'deepseek-flash');
  assert.equal(log.warnings.length, 0);

  const result = await bridge.generate({ system: 'SYSTEM-PROMPT', user: 'USER-PAYLOAD', maxTokens: 700 });
  assert.equal(result.text, '{"verdict":"HOLD"}');
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 45 });

  assert.deepEqual(calls.prepare[0], {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    maxTokens: 700,
    temperature: 0.2,
  });
  assert.equal(calls.stream.length, 1);
  const streamOptions = calls.stream[0];
  assert.equal(streamOptions.provider, 'deepseek-account');
  assert.equal(streamOptions.model, 'deepseek-flash');
  assert.equal(streamOptions.system, 'SYSTEM-PROMPT');
  assert.equal(streamOptions.maxTokens, 700);
  assert.equal(streamOptions.temperature, 0.2);
  assert.deepEqual(streamOptions.messages, [
    { role: 'user', content: [{ type: 'text', text: 'USER-PAYLOAD' }] },
  ]);
});

test('research bridge falls back to the first provider and its first model', async () => {
  const { llm, calls } = createFakeLlm({ providers: ['provider-a', 'provider-b'], models: ['model-1', 'model-2'] });
  const bridge = await createResearchBridge(createFakeCtx({ llm }).ctx, { stateDir: STATE_DIR }, fakeLogger());
  assert.ok(bridge);
  assert.equal(bridge.provider, 'provider-a');
  assert.equal(bridge.model, 'model-1');
  assert.equal(calls.lastListModelsProvider, 'provider-a');
});

test('research bridge honours row and nested-config provider/model overrides', async () => {
  const { llm } = createFakeLlm();
  const ctx = createFakeCtx({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
  }).ctx;
  assert.deepEqual(resolveResearchOverrides({ researchProvider: 'row-p', researchModel: 'row-m' }), { provider: 'row-p', model: 'row-m' });
  assert.deepEqual(resolveResearchOverrides({ config: { research: { provider: 'nested-p', model: 'nested-m' } } }), { provider: 'nested-p', model: 'nested-m' });
  assert.deepEqual(resolveResearchOverrides({}), { provider: null, model: null });

  const rowBridge = await createResearchBridge(ctx, { stateDir: STATE_DIR, researchProvider: 'row-p', researchModel: 'row-m' }, fakeLogger());
  assert.ok(rowBridge);
  assert.equal(rowBridge.provider, 'row-p');
  assert.equal(rowBridge.model, 'row-m');

  const nestedBridge = await createResearchBridge(ctx, { stateDir: STATE_DIR, config: { research: { provider: 'nested-p', model: 'nested-m' } } }, fakeLogger());
  assert.ok(nestedBridge);
  assert.equal(nestedBridge.provider, 'nested-p');
  assert.equal(nestedBridge.model, 'nested-m');
});

test('research bridge returns null (configured:false) when the LLM service or model is unavailable', async () => {
  const noLlmLog = fakeLogger();
  assert.equal(await createResearchBridge(createFakeCtx().ctx, { stateDir: STATE_DIR }, noLlmLog), null);
  assert.ok(noLlmLog.warnings.some((message) => /no Harness llm service/.test(message)));

  const noProviderLog = fakeLogger();
  const emptyLlm = createFakeLlm({ providers: [] });
  assert.equal(await createResearchBridge(createFakeCtx({ llm: emptyLlm.llm }).ctx, { stateDir: STATE_DIR }, noProviderLog), null);
  assert.ok(noProviderLog.warnings.some((message) => /no LLM provider\/model resolved/.test(message)));
});

test('research bridge surfaces provider failures as clean errors', async () => {
  const finishError = createFakeLlm({
    chunks: [
      { type: 'text-delta', text: 'partial' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } } },
    ],
  });
  const ctx = createFakeCtx({
    llm: finishError.llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }).ctx;
  const bridge = await createResearchBridge(ctx, { stateDir: STATE_DIR }, fakeLogger());
  await assert.rejects(bridge.generate({ system: 's', user: 'u', maxTokens: 128 }), (error) => {
    assert.match(error.message, /rate limited/);
    assert.match(error.message, /p\/m/);
    assert.equal(error.code, 'RATE_LIMIT');
    return true;
  });

  const streamFailure = createFakeLlm({ streamError: Object.assign(new Error('socket closed'), { code: 'NETWORK' }) });
  const ctx2 = createFakeCtx({
    llm: streamFailure.llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }).ctx;
  const bridge2 = await createResearchBridge(ctx2, { stateDir: STATE_DIR }, fakeLogger());
  await assert.rejects(bridge2.generate({ system: 's', user: 'u', maxTokens: 128 }), (error) => {
    assert.match(error.message, /socket closed/);
    assert.equal(error.code, 'NETWORK');
    return true;
  });

  const emptyReply = createFakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] });
  const ctx3 = createFakeCtx({
    llm: emptyReply.llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }).ctx;
  const bridge3 = await createResearchBridge(ctx3, { stateDir: STATE_DIR }, fakeLogger());
  await assert.rejects(bridge3.generate({ system: 's', user: 'u', maxTokens: 128 }), /empty briefing/);
});

test('the engine factory receives the research bridge (and null without an LLM)', async () => {
  const { llm } = createFakeLlm({ providers: ['p1'], models: ['m1'] });
  const withLlm = createFakeCtx({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p1', model: 'm1' }) },
  });
  const captured = {};
  const { engine } = createFakeEngine();
  apply(withLlm.ctx, baseConfig(engine, {
    engineFactory: (rowConfig, research) => {
      captured.row = rowConfig;
      captured.research = research;
      return engine;
    },
  }));
  await withLlm.tools.get('automaton_status').execute({}, {});
  assert.ok(captured.research, 'researchGenerate bridge is passed to the engine factory');
  assert.equal(captured.research.provider, 'p1');
  assert.equal(captured.research.model, 'm1');
  assert.equal(typeof captured.research.generate, 'function');
  withLlm.disposeAll();

  const noLlm = createFakeCtx();
  const capturedWithout = {};
  const second = createFakeEngine();
  apply(noLlm.ctx, baseConfig(second.engine, {
    engineFactory: (rowConfig, research) => {
      capturedWithout.row = rowConfig;
      capturedWithout.research = research;
      return second.engine;
    },
  }));
  await noLlm.tools.get('automaton_status').execute({}, {});
  assert.equal(capturedWithout.research, null, 'no llm → no generator passed (engine reports configured:false)');
  noLlm.disposeAll();
});

test('GET /automaton/state passes research telemetry and per-agent briefings through', async () => {
  const fake = createFakeCtx();
  const { engine } = createFakeEngine({ agentCount: POPULATION });
  apply(fake.ctx, baseConfig(engine));
  const { json } = await invokeHandler(routeFor(fake.routes, ROUTE_PATH).handler, { method: 'GET' });
  assert.equal(json.engine.research.configured, true);
  assert.equal(json.engine.research.influence, true);
  assert.equal(json.engine.research.provider, 'deepseek-account');
  assert.equal(json.agents[0].research.verdict, 'HOLD');
  assert.equal(json.agents[1].research.stale, true);

  const unconfigured = createFakeCtx();
  const { engine: engine2 } = createFakeEngine({
    agentCount: POPULATION,
    research: { enabled: true, configured: false, influence: true, intervalSec: 3600, lastRunAt: null, nextDueAt: null, provider: null, model: null, runs: 0, errors: 0 },
  });
  apply(unconfigured.ctx, baseConfig(engine2));
  const passed = await invokeHandler(routeFor(unconfigured.routes, ROUTE_PATH).handler, { method: 'GET' });
  assert.equal(passed.json.engine.research.configured, false);
  unconfigured.disposeAll();
  fake.disposeAll();
});

// ---------------------------------------------------------------------------
// client module tests (registration + pure data mapping, no rendering)
// ---------------------------------------------------------------------------

/** Cached client module + a React stub: the browser module is imported exactly once. */
let clientModuleCache = null;

async function loadClientModule() {
  if (clientModuleCache !== null) return clientModuleCache;
  const previousWindow = globalThis.window;
  let registration = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(loaded) {
        registration = loaded;
      },
    },
  };
  try {
    await import('../client.js');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  assert.ok(registration, 'client.js must call window.__ModuleLoader__.load()');
  const React = {
    createElement: (...args) => ({ kind: 'element', args }),
    Fragment: Symbol('Fragment'),
    createContext: (value) => ({ __context: value }),
    useContext: () => null,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef: (initial) => ({ current: initial }),
  };
  const module = registration.factory((required) => {
    assert.equal(required, 'react', 'the client module only requires react from the module table');
    return React;
  });
  clientModuleCache = {
    registration,
    module,
    restore() {
      /* the import happens once; nothing to restore */
    },
  };
  return clientModuleCache;
}

function createClientCtx() {
  const injected = [];
  const registrations = [];
  const ctx = {
    locale: {
      register() {
        return () => {};
      },
      bind() {
        return (key) => key;
      },
    },
    slots: {
      inject(ownerKey, callback) {
        injected.push({ ownerKey, callback });
      },
      register(options, Component) {
        registrations.push({ options, Component });
        return () => {};
      },
    },
    effect(callback) {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
  };
  return { ctx, injected, registrations };
}

test('client half registers the sidebar entry, keyed main panel and settings page', async () => {
  const loaded = await loadClientModule();
  try {
    assert.equal(loaded.registration.id, '@local/automaton-trading', 'module id must equal the package name');
    assert.ok(Array.isArray(loaded.module.inject) && loaded.module.inject.includes('slots'));
    assert.equal(typeof loaded.module.apply, 'function');

    const { ctx, injected, registrations } = createClientCtx();
    loaded.module.apply(ctx);

    assert.deepEqual(injected.map((entry) => entry.ownerKey).sort(), [
      'main',
      'settings.plugins.tab',
      'sidebar.panellist',
    ]);
    for (const entry of injected) entry.callback(); // simulate slot declarations appearing

    assert.equal(registrations.length, 3);
    assert.deepEqual(registrations.map((entry) => entry.options.name).sort(), [
      'main',
      'settings.plugins.tab',
      'sidebar.panellist',
    ]);

    const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
    assert.equal(sidebar.options.id, 'automaton-trading');
    assert.equal(typeof sidebar.options.order, 'number');
    assert.equal(typeof sidebar.options.label, 'function');
    assert.equal(typeof sidebar.options.label(), 'string');

    const main = registrations.find((entry) => entry.options.name === 'main');
    assert.equal(main.options.key, 'automaton-trading', 'the sidebar entry id must select this main panel key');

    const settings = registrations.find((entry) => entry.options.name === 'settings.plugins.tab');
    assert.equal(settings.options.id, 'automaton-trading');
    assert.equal(typeof settings.options.label, 'function');
    assert.equal(typeof settings.options.label(), 'string');

    // The floating overlay and composer strip are gone.
    assert.equal(injected.some((entry) => entry.ownerKey === 'shell.overlay'), false);
    assert.equal(injected.some((entry) => entry.ownerKey === 'conversation.composer.dock'), false);
    for (const entry of registrations) {
      assert.equal(typeof entry.Component, 'function', 'each slot entry needs a React component');
    }
  } finally {
    loaded.restore();
  }
});

test('client half guards a missing slots/locale context', async () => {
  const loaded = await loadClientModule();
  try {
    assert.doesNotThrow(() => loaded.module.apply({}));
    assert.doesNotThrow(() => loaded.module.apply(undefined));
    // locale unavailable → the bundled English dictionary still serves labels
    const { ctx, injected, registrations } = createClientCtx();
    delete ctx.locale;
    loaded.module.apply(ctx);
    for (const entry of injected) entry.callback();
    assert.equal(registrations.length, 3);
  } finally {
    loaded.restore();
  }
});

test('pure data mapping: names, genome-vs-spec, holdings, activity and empty states', async () => {
  const loaded = await loadClientModule();
  try {
    const helpers = loaded.module.helpers;
    assert.ok(helpers, 'client module exposes `helpers`');
    const status = buildStatusPayload({ running: true });

    assert.equal(helpers.PANEL_ID, 'automaton-trading');
    assert.equal(helpers.SIDEBAR_SLOT, 'sidebar.panellist');
    assert.equal(helpers.MAIN_SLOT, 'main');
    assert.equal(helpers.SETTINGS_SLOT, 'settings.plugins.tab');
    assert.equal(helpers.STATE_URL, '/automaton/state');
    assert.equal(helpers.CONTROL_URL, '/automaton/control');
    assert.equal(helpers.POLL_MS, 3000);

    const rows = helpers.buildAgentRows(status);
    assert.equal(rows.length, POPULATION);
    assert.equal(new Set(rows.map((row) => row.name)).size, POPULATION, 'agent names are unique');
    assert.equal(rows[0].name, 'Momentum AAPL', 'the engine-provided name is the primary label');
    assert.equal(rows[0].genomeText, 'Momentum AAPL');
    assert.match(rows[0].genomeParamsText, /lb/);
    assert.ok(rows[0].shortId.length > 0 && rows[0].shortId !== rows[0].id);

    // Genome vs Trading (compiled spec): some agents differ, some match.
    const differing = rows.filter((row) => row.tradingDiffers);
    assert.ok(differing.length > 0, 'at least one compiled spec differs from its genome');
    assert.ok(differing[0].specText && differing[0].specText !== differing[0].genomeText);
    const matching = rows.find((row) => row.spec && !row.tradingDiffers);
    assert.ok(matching, 'some agents trade their inherited genome');
    assert.equal(matching.specText, matching.genomeText);
    const noSpec = rows.find((row) => row.spec === null);
    assert.ok(noSpec, 'dead agents may have no compiled spec');
    assert.equal(noSpec.specText, null);

    // Parent names resolve from the population (name-first secondary display).
    const child = rows.find((row) => row.parentId);
    assert.ok(child);
    assert.equal(typeof child.parentName, 'string');
    assert.ok(child.parentName.length > 0);

    // Holdings rows: enriched positions and computed fallbacks.
    const withPositions = rows.find((row) => row.positionCount > 0);
    assert.ok(withPositions);
    assert.equal(withPositions.positions.length, withPositions.positionCount);
    const position = withPositions.positions[0];
    assert.equal(typeof position.symbol, 'string');
    assert.equal(typeof position.qty, 'number');
    assert.equal(typeof position.marketValueUsd, 'number');
    assert.equal(typeof position.unrealizedPlUsd, 'number');
    const emptyHoldings = helpers.buildHoldingsRows([]);
    assert.deepEqual(emptyHoldings, []);
    assert.equal(helpers.buildHoldingsRows(null).length, 0);
    // Fallbacks: market value and unrealized P&L are derivable from qty/avg/last price.
    const derived = helpers.buildHoldingsRows([{ symbol: 'AAPL', qty: 2, avgPriceUsd: 10, lastPriceUsd: 12 }]);
    assert.equal(derived[0].marketValueUsd, 24);
    assert.equal(derived[0].unrealizedPlUsd, 4);

    // Activity rows: newest-first fills with notional fallback and buy/sell sides.
    const withTrades = rows.find((row) => row.tradesCount > 0);
    assert.ok(withTrades);
    assert.ok(withTrades.activity.length > 0);
    assert.ok(['buy', 'sell'].includes(withTrades.activity[0].side));
    assert.equal(typeof withTrades.activity[0].notionalUsd, 'number');
    const derivedTrade = helpers.buildActivityRows([{ symbol: 'AAPL', side: 'buy', qty: 2, priceUsd: 10 }]);
    assert.equal(derivedTrade[0].notionalUsd, 20);
    assert.equal(derivedTrade[0].side, 'buy');
    assert.equal(derivedTrade[0].realizedPlUsd, null);
    assert.deepEqual(helpers.buildActivityRows([]), []);
    const noTrades = rows.find((row) => row.tradesCount === 0);
    assert.ok(noTrades, 'some agents have never traded (empty activity state)');
    assert.deepEqual(noTrades.activity, []);

    // Strategy parameters for genome and spec.
    const paramItems = helpers.strategyParamItems(rows[0].genome);
    assert.ok(paramItems.length >= 5);
    assert.ok(paramItems.some((item) => item.label === 'lookback'));
    assert.ok(paramItems.some((item) => item.label === 'stop' && item.value.includes('%')));
    assert.deepEqual(helpers.strategyParamItems(null), []);

    // Role costs + P&L math.
    assert.equal(rows[0].roleCosts.length, 4);
    assert.ok(rows[0].roleCostsTotal > 0);
    const alive = rows.find((row) => row.status === 'alive');
    assert.ok(alive);
    const expectedEquity = Math.round((ENDOWMENT_USD + (0.4 * (Number(alive.id.slice(-2)) % 7) - 1.2)) * 100) / 100;
    assert.equal(alive.equityUsd, expectedEquity);
    assert.ok(Math.abs(alive.pnlPct - (((expectedEquity - ENDOWMENT_USD) / ENDOWMENT_USD) * 100)) < 1e-9);

    const dead = rows.find((row) => row.status === 'dead');
    assert.ok(dead);
    assert.equal(dead.cause, 'insufficient_funds');
    assert.equal(dead.runwayHours, 0);
    assert.equal(dead.treasuryState, 'DEAD');
    assert.equal(dead.pnlUsd < 0, true);
    assert.equal(dead.lifespanHours > 0, true);

    const mutant = rows.find((row) => row.mutationText !== null);
    assert.ok(mutant, 'some rows carry a mutation description');
    assert.match(mutant.mutationText, /→/);

    // Summary + generations + obituaries (name-first).
    const summary = helpers.summarize(status);
    assert.equal(summary.mode, 'paper');
    assert.equal(summary.running, true);
    assert.equal(summary.population.total, POPULATION);
    assert.equal(summary.population.alive, 24);
    assert.equal(summary.population.dead, 4);
    assert.equal(summary.population.condemned, 2);
    assert.equal(summary.population.cap, 40);
    assert.equal(summary.equityUsd, 20000);
    assert.equal(summary.treasury.state, 'TIGHT');
    assert.equal(summary.allocationCapUsd, 16000);
    assert.equal(summary.endowmentUsd, ENDOWMENT_USD);
    assert.equal(summary.killSwitch, false);
    assert.equal(summary.control.route, CONTROL_PATH);

    const generations = helpers.generationRows(status);
    assert.equal(generations.length, 3);
    assert.equal(generations[0].generation, 0);
    assert.equal(generations[0].born, 10);
    assert.ok(generations.every((row) => row.born > 0));

    const obituaries = helpers.obituaryRows(status);
    assert.equal(obituaries.length, 8);
    assert.equal(typeof obituaries[0].name, 'string');
    assert.ok(obituaries[0].name.length > 0);
    assert.equal(typeof obituaries[0].cause, 'string');
    assert.equal(typeof obituaries[0].lifespanHours, 'number');

    // Filter by name and status; search also matches ids and parent names.
    const deadRows = helpers.filterAgentRows(rows, 'dead', '');
    assert.equal(deadRows.length, 4);
    assert.equal(deadRows.every((row) => row.status === 'dead'), true);
    const byNameRows = helpers.filterAgentRows(rows, 'all', 'MeanRev MSFT');
    assert.ok(byNameRows.length >= 1);
    assert.ok(byNameRows.every((row) => row.name === 'MeanRev MSFT' || row.parentName === 'MeanRev MSFT'));
    const byIdRows = helpers.filterAgentRows(rows, 'all', rows[3].id);
    assert.ok(byIdRows.length >= 1);
    assert.ok(byIdRows.every((row) => row.id === rows[3].id || row.parentId === rows[3].id));
    const symbolRows = helpers.filterAgentRows(rows, 'all', 'AAPL');
    assert.ok(symbolRows.length > 0);

    const byEquityDesc = helpers.sortAgentRows(rows, 'equityUsd', 'desc');
    for (let index = 1; index < byEquityDesc.length; index += 1) {
      assert.ok((byEquityDesc[index - 1].equityUsd ?? -Infinity) >= (byEquityDesc[index].equityUsd ?? -Infinity));
    }
    const byNameAsc = helpers.sortAgentRows(rows, 'name', 'asc');
    assert.deepEqual(byNameAsc.map((row) => row.name), [...byNameAsc.map((row) => row.name)].sort());
    const byGenerationAsc = helpers.sortAgentRows(rows, 'generation', 'asc');
    for (let index = 1; index < byGenerationAsc.length; index += 1) {
      assert.ok(byGenerationAsc[index - 1].generation <= byGenerationAsc[index].generation);
    }

    // findAgentRow keeps the detail selection stable across polls.
    assert.equal(helpers.findAgentRow(rows, rows[0].id)?.name, rows[0].name);
    assert.equal(helpers.findAgentRow(rows, 'atm-missing'), null);

    assert.equal(helpers.runwayLevel(100), 'ok');
    assert.equal(helpers.runwayLevel(10), 'warn');
    assert.equal(helpers.runwayLevel(1), 'crit');
    assert.equal(helpers.runwayPercent(72), 100);
    assert.equal(helpers.runwayPercent(null), 0);

    // The 30-agent engine rows may omit per-agent endowmentUsd; the population limit is
    // the fallback so the P&L column still works.
    const withoutEndowment = buildStatusPayload({ running: true });
    for (const agent of withoutEndowment.agents) delete agent.endowmentUsd;
    const fallbackRows = helpers.buildAgentRows(withoutEndowment);
    const fallbackAlive = fallbackRows.find((row) => row.status === 'alive');
    assert.ok(fallbackAlive);
    assert.equal(typeof fallbackAlive.pnlUsd, 'number');
    assert.equal(fallbackAlive.pnlUsd, Math.round((fallbackAlive.equityUsd - ENDOWMENT_USD) * 100) / 100);
  } finally {
    loaded.restore();
  }
});

test('pure data mapping: Reaper telemetry states for the operator row', async () => {
  const loaded = await loadClientModule();
  try {
    const helpers = loaded.module.helpers;
    assert.equal(typeof helpers.describeReaper, 'function');

    const healthy = helpers.describeReaper({
      pid: 1234,
      alive: true,
      startedAt: '2026-01-02T00:00:00.000Z',
      heartbeatAt: '2026-01-02T00:00:03.000Z',
      heartbeatVersion: 2,
      sweeps: 51,
      error: null,
      note: 'external process (no control surface)',
    });
    assert.equal(healthy.kind, 'healthy');
    assert.equal(healthy.stale, false);
    assert.equal(healthy.pid, 1234);
    assert.equal(healthy.heartbeatVersion, 2);
    assert.equal(healthy.sweeps, 51);

    const stale = helpers.describeReaper({ pid: 24452, alive: true, heartbeatAt: null, heartbeatVersion: null, error: null });
    assert.equal(stale.kind, 'stale');
    assert.equal(stale.stale, true);
    assert.equal(stale.pid, 24452);

    const legacy = helpers.describeReaper({ pid: 777, alive: true, heartbeatAt: '2026-01-01T00:00:00.000Z', heartbeatVersion: null });
    assert.equal(legacy.kind, 'stale', 'a heartbeat without version 2 is a stale generation');

    const stopped = helpers.describeReaper({ pid: null, alive: false, error: null, note: 'external process (no control surface)' });
    assert.equal(stopped.kind, 'stopped');
    assert.equal(stopped.pid, null);
    assert.equal(stopped.stale, false);

    const absent = helpers.describeReaper(null);
    assert.equal(absent.kind, 'stopped');

    // Summary carries the reaper telemetry through from GET /automaton/state.
    const status = buildStatusPayload({
      running: true,
      reaper: { pid: 24452, alive: true, startedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: null, heartbeatVersion: null, sweeps: 0, error: 'stale generation', note: 'external process' },
    });
    const summary = helpers.summarize(status);
    assert.equal(summary.reaper.pid, 24452);
    assert.equal(helpers.describeReaper(summary.reaper).kind, 'stale');
  } finally {
    loaded.restore();
  }
});

test('pure data mapping: research badges, briefing detail and shadow/influence state', async () => {
  const loaded = await loadClientModule();
  try {
    const helpers = loaded.module.helpers;
    const status = buildStatusPayload({ running: true });
    const rows = helpers.buildAgentRows(status);

    const holdRow = rows.find((row) => row.research && row.research.verdict === 'HOLD');
    assert.ok(holdRow);
    assert.equal(holdRow.research.sentiment, 0.2);
    assert.equal(holdRow.research.confidence, 0.7);
    assert.match(holdRow.research.summary, /Neutral tone/);
    assert.equal(holdRow.research.catalysts.length, 2);
    assert.equal(holdRow.research.risks.length, 1);
    assert.equal(holdRow.research.sources.length, 2);
    assert.equal(holdRow.research.sources[0].url, 'https://example.com/news/1');
    assert.equal(holdRow.research.sources[1].url, null, 'non-http(s) source URLs are not linkable');
    assert.deepEqual(holdRow.researchBadge, helpers.researchBadge(holdRow.research));
    const holdBadge = helpers.researchBadge(holdRow.research);
    assert.equal(holdBadge.hasResearch, true);
    assert.equal(holdBadge.label, 'HOLD +0.2');
    assert.equal(holdBadge.tone, 'hold');
    assert.equal(holdBadge.stale, false);

    const avoidRow = rows.find((row) => row.research && row.research.verdict === 'AVOID');
    assert.ok(avoidRow);
    const avoidBadge = helpers.researchBadge(avoidRow.research);
    assert.equal(avoidBadge.label, 'AVOID -0.6');
    assert.equal(avoidBadge.tone, 'avoid');
    assert.equal(avoidBadge.stale, true);
    assert.equal(avoidRow.research.risks.length, 4, 'risks are clamped to 4');

    const alertRow = rows.find((row) => row.research && row.research.verdict === 'ALERT');
    assert.ok(alertRow);
    assert.equal(helpers.researchBadge(alertRow.research).tone, 'alert');

    const noResearch = rows.find((row) => row.research === null);
    assert.ok(noResearch);
    assert.deepEqual(helpers.researchBadge(noResearch.research), {
      hasResearch: false,
      label: '—',
      tone: 'none',
      stale: false,
      verdict: null,
      sentiment: null,
      title: '',
    });
    assert.equal(noResearch.researchBadge.hasResearch, false);

    // Normalization is defensive and clamped.
    const malformed = helpers.mapResearchBriefing({
      verdict: 'hold',
      sentiment: -3,
      confidence: 5,
      catalysts: ['a', '', 7, 'b', 'c', 'd', 'e'],
      risks: 'not-an-array',
      sources: [
        { title: 'ok', url: 'https://example.com/x' },
        { url: 'ftp://nope', title: 'ftp' },
        { url: 'https://example.com/y', source: 'src' },
      ],
      stale: true,
    });
    assert.equal(malformed.verdict, 'HOLD');
    assert.equal(malformed.sentiment, -1);
    assert.equal(malformed.confidence, 1);
    assert.deepEqual(malformed.catalysts, ['a', 'b', 'c', 'd']);
    assert.deepEqual(malformed.risks, []);
    assert.equal(malformed.sources.length, 3);
    assert.equal(malformed.sources[0].url, 'https://example.com/x');
    assert.equal(malformed.sources[1].url, null);
    assert.equal(malformed.stale, true);
    assert.equal(helpers.mapResearchBriefing(null), null);
    assert.equal(helpers.mapResearchBriefing('garbage'), null);
    assert.equal(helpers.mapResearchBriefing({}), null);

    // Engine research schedule projection: influence vs shadow vs unconfigured.
    const influenceStatus = helpers.researchStatusSummary(status);
    assert.equal(influenceStatus.available, true);
    assert.equal(influenceStatus.configured, true);
    assert.equal(influenceStatus.influence, true);
    assert.equal(influenceStatus.shadow, false);
    assert.equal(influenceStatus.intervalSec, 3600);
    assert.equal(influenceStatus.runs, 3);
    assert.equal(influenceStatus.provider, 'deepseek-account');
    assert.equal(helpers.researchModeKey(influenceStatus), 'researchInfluence');

    const shadowStatus = buildStatusPayload({
      running: true,
      research: { enabled: true, configured: true, influence: false, intervalSec: 3600, lastRunAt: null, nextDueAt: null, provider: 'p', model: 'm', runs: 1, errors: 0 },
    });
    const shadow = helpers.researchStatusSummary(shadowStatus);
    assert.equal(shadow.shadow, true);
    assert.equal(shadow.disabledReason, null);
    assert.equal(helpers.researchModeKey(shadow), 'researchShadow');

    const unconfiguredStatus = buildStatusPayload({
      running: true,
      research: { enabled: true, configured: false, influence: true, intervalSec: 3600, lastRunAt: null, nextDueAt: null, provider: null, model: null, runs: 0, errors: 0 },
    });
    const unconfigured = helpers.researchStatusSummary(unconfiguredStatus);
    assert.equal(unconfigured.configured, false);
    assert.equal(unconfigured.disabledReason, 'unconfigured');

    const configDisabledStatus = buildStatusPayload({
      running: true,
      research: { enabled: false, configured: true, influence: true, intervalSec: 3600, lastRunAt: null, nextDueAt: null, provider: 'p', model: 'm', runs: 0, errors: 0 },
    });
    assert.equal(helpers.researchStatusSummary(configDisabledStatus).disabledReason, 'disabled');

    const unknown = helpers.researchStatusSummary({});
    assert.equal(unknown.available, false);
    assert.equal(helpers.researchModeKey(unknown), 'researchUnknown');

    // summarize() exposes the same projection to the dashboard header/detail.
    const summary = helpers.summarize(status);
    assert.equal(summary.research.configured, true);
    assert.equal(summary.research.shadow, false);
  } finally {
    loaded.restore();
  }
});
