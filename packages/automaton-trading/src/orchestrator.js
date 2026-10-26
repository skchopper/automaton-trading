/**
 * Orchestrator: composes the six roles into one cycle loop.
 * Owned by the Lead.
 *
 * The loop is deliberately boring: read the market once, let the Treasurer price the
 * population, let the Prospector/BUILDER produce executable specs, let the Executor
 * trade inside the mandate, let the Replicator breed, and record verdicts. Death
 * itself is NOT executed here — the external Reaper does that from its own process.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { statePaths, liveArmed } from './config.js';
import { HYPOTHESIS_FAMILIES } from './contracts.js';
import {
  createLogger,
  createClock,
  ensureDir,
  errorInfo,
  mulberry32,
  newId,
  readJson,
  round2,
  round4,
  safeJson,
  dayKey,
  writeJsonAtomic,
  appendJsonl,
} from './util.js';
import { createJournal } from './journal.js';
import { createRegistry } from './registry.js';
import { createLedger } from './ledger.js';
import { createBrakes } from './brakes.js';
import { createTreasurer } from './treasurer.js';
import { createReplicator } from './replicator.js';
import { createProspector } from './prospector.js';
import { createBuilder } from './builder.js';
import { createExecutor } from './executor.js';
import { createReaper } from './reaper.js';
import { createResearcher } from './research.js';
import { nextAgentName, usedNames } from './naming.js';

const log = createLogger('automaton');

const DEFAULT_GENOME = {
  family: 'momentum',
  lookback: 20,
  entryZ: 1.2,
  exitZ: 0.3,
  stopPct: 0.02,
  targetPct: 0.04,
  maxHoldBars: 8,
  sizePct: 0.15,
  sessionFilter: 'any',
};

const GENOME_LOOKBACKS = [10, 15, 20, 30, 40, 60];
const GENOME_HOLDS = [4, 6, 8, 12, 24];
const GENOME_SESSIONS = ['any', 'morning', 'afternoon'];

/**
 * Build a distinct, deterministic genome for each genesis agent.
 * - the (symbol, family) pair is unique for the first symbols x families agents, so with
 *   30 agents on 10 symbols every agent inherits a different strategy family/symbol;
 * - the numeric parameters are seeded-random within live-tradeable bounds, so no two
 *   agents are clones even when a later generation re-uses a pair;
 * - deterministic in (config.engine.seed, index): restarting the engine never reshuffles
 *   the population's genes.
 */
function genesisGenome(config, index) {
  const symbols = config.symbols.length > 0 ? config.symbols : ['SPY'];
  const seed = Number(config.engine?.seed ?? 7) >>> 0;
  const rng = mulberry32((seed * 2654435761 + index * 40503 + 1) >>> 0);
  const family = HYPOTHESIS_FAMILIES[Math.floor(index / symbols.length) % HYPOTHESIS_FAMILIES.length];
  const symbol = symbols[index % symbols.length];
  const round = (value, digits) => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  };
  return {
    ...DEFAULT_GENOME,
    symbol,
    family,
    lookback: GENOME_LOOKBACKS[Math.floor(rng() * GENOME_LOOKBACKS.length)],
    entryZ: round(0.8 + rng() * 1.4, 2),
    exitZ: round(0.1 + rng() * 0.7, 2),
    stopPct: round(0.01 + rng() * 0.03, 4),
    targetPct: round(0.02 + rng() * 0.06, 4),
    maxHoldBars: GENOME_HOLDS[Math.floor(rng() * GENOME_HOLDS.length)],
    // Never below 0.12: with a $20 endowment the mandate cap is ~$10, and a $1 minimum
    // notional means a smaller sizePct would round the order away.
    sizePct: round(0.12 + rng() * 0.23, 3),
    sessionFilter: GENOME_SESSIONS[Math.floor(rng() * GENOME_SESSIONS.length)],
  };
}

/** Last close (or last/ask fallback) per symbol, used for marking positions. */
function pricesFromBars(bars) {
  const prices = {};
  for (const [symbol, series] of Object.entries(bars ?? {})) {
    const last = Array.isArray(series) && series.length > 0 ? series[series.length - 1] : null;
    if (last && Number.isFinite(Number(last.c))) prices[symbol] = Number(last.c);
  }
  return prices;
}

/** Quotes for the executor: real bid/ask when the broker has them, otherwise a tight synthetic spread. */
async function readQuotes(broker, symbols, prices) {
  const quotes = {};
  await Promise.all(
    symbols.map(async (symbol) => {
      const last = prices[symbol];
      try {
        const quote = await broker.getLatestQuote(symbol);
        if (quote && Number.isFinite(Number(quote.ask)) && Number.isFinite(Number(quote.bid)) && Number(quote.ask) > 0) {
          quotes[symbol] = {
            bid: round2(Number(quote.bid)),
            ask: round2(Number(quote.ask)),
            last: round2(Number(quote.last) || last || Number(quote.ask)),
            ts: quote.ts ?? null,
          };
          return;
        }
      } catch {
        /* fall back to bar close */
      }
      if (Number.isFinite(last) && last > 0) {
        const half = Math.max(0.005, last * 0.00005); // ~1bp synthetic spread for marking/brake context
        quotes[symbol] = {
          bid: round2(last - half),
          ask: round2(last + half),
          last: round2(last),
          ts: null,
          synthetic: true,
        };
      }
    }),
  );
  return quotes;
}

/**
 * Compose the population engine.
 * @param {{
 *   config: object,
 *   paths?: object,
 *   broker: object,
 *   clock?: { now: () => number, iso: () => string },
 *   logger?: object,
 * }} options
 */
export async function createAutomaton(options = {}) {
  const { config, broker } = options;
  if (!config) throw new Error('createAutomaton requires config');
  if (!broker) throw new Error('createAutomaton requires a broker');
  const paths = options.paths ?? statePaths(config);
  const clock = options.clock ?? createClock();

  const journal = createJournal({ paths, config });
  const registry = createRegistry({ paths, config });
  const ledger = createLedger({ paths, config, clock });
  const brakes = createBrakes({ config, paths, clock });
  const treasurer = createTreasurer({ broker, ledger, registry, journal, config, paths, clock });
  const replicator = createReplicator({ treasurer, registry, ledger, journal, config, clock });
  const prospector = createProspector({ broker, config, journal, clock, paths });
  const builder = createBuilder({ config, brakes, clock });
  const executor = createExecutor({ broker, brakes, ledger, config, clock });

  const state = {
    initialized: false,
    running: false,
    ticking: false,
    ticks: 0,
    errors: 0,
    lastTickAt: null,
    lastError: null,
    lastTrace: null,
    lastTreasury: null,
    lastQuotes: null,
    lastPrices: null,
    lastMarketOpen: null,
    lastMarketClock: null,
    specs: new Map(),
    condemned: new Set(),
    inProcessReaper: null,
    dayStats: { dayKey: null, agents: {} },
    timer: null,
  };

  // Per-agent isolated research sidecar (docs/RESEARCH.md). `generate` is injected by the
  // Harness plugin (LLM bridge) or the CLI HTTP fallback; without it research is disabled and
  // trading behaves exactly as before.
  const researchGenerate = options.researchGenerate ?? options.generate ?? null;
  const researcher = createResearcher({
    broker,
    registry,
    ledger,
    config,
    paths,
    clock,
    generate: typeof researchGenerate === 'function' ? researchGenerate : undefined,
    specFor: (agentId) => {
      const agent = registry.get(agentId);
      return agent?.specId ? state.specs.get(agent.specId) ?? null : null;
    },
  });

  // -------------------------------------------------------------------------
  // persistence helpers
  // -------------------------------------------------------------------------

  async function loadDayStats(nowMs) {
    const saved = await readJson(paths.dayStats, null);
    const today = dayKey(nowMs, config.timeZone);
    if (saved && saved.dayKey === today && saved.agents) {
      state.dayStats = saved;
    } else {
      state.dayStats = { dayKey: today, agents: {} };
    }
    return state.dayStats;
  }

  async function saveDayStats() {
    await writeJsonAtomic(paths.dayStats, state.dayStats);
  }

  function dayStatsFor(agentId) {
    const entry = state.dayStats.agents[agentId] ?? { ordersCount: 0, startEquityUsd: null };
    const view = (state.lastTreasury?.agentViews ?? []).find((item) => item.agentId === agentId);
    const startEquityUsd = entry.startEquityUsd ?? view?.equityUsd ?? null;
    const pnlUsd =
      Number.isFinite(Number(view?.equityUsd)) && Number.isFinite(Number(startEquityUsd))
        ? Number(view.equityUsd) - Number(startEquityUsd)
        : 0;
    return {
      dayKey: state.dayStats.dayKey,
      ordersCount: entry.ordersCount ?? 0,
      startEquityUsd,
      pnlUsd: round2(pnlUsd),
    };
  }

  async function writeStateFile(snapshot) {
    await writeJsonAtomic(paths.stateFile, snapshot);
  }

  async function appendTrace(trace) {
    await appendJsonl(paths.traces, trace);
  }

  function genomeForSpec(agent) {
    return agent?.genome ?? null;
  }

  /**
   * Choose the hypothesis this agent will trade this cycle.
   * Preference chain keeps the population diverse instead of collapsing every agent
   * onto the single highest-ranked hypothesis:
   *   1. exact symbol+family match for the agent's inherited genome
   *   2. same family (genome's strategy family), any symbol
   *   3. a hypothesis no other agent is already using this cycle
   *   4. the top-ranked hypothesis
   */
  async function ensureSpec(agent, hypotheses, cycleBudgetUsd, usedPairs = new Set()) {
    const cached = agent.specId ? state.specs.get(agent.specId) : null;
    if (cached) {
      // A spec is executable only while its proof is fresh. Recompile from this cycle's
      // hypotheses when the proof has aged past half of maxProofAgeDays, but never
      // mid-position: exits must use the spec that opened the trade.
      const proofAgeMs = clock.now() - (Date.parse(cached.createdAt ?? '') || 0);
      const maxSpecAgeMs = Math.min(
        ((Number(config.data?.maxProofAgeDays) || 7) * 24 * 60 * 60 * 1000) / 2,
        12 * 60 * 60 * 1000,
      );
      const book = ledger.book?.(agent.id);
      const hasPosition = Boolean(book && Object.keys(book.positions ?? {}).length > 0);
      if (!Number.isFinite(proofAgeMs) || proofAgeMs <= maxSpecAgeMs || hasPosition) {
        return { spec: cached, cached: true };
      }
    }
    const ranked = [...(hypotheses ?? [])].sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));
    if (ranked.length === 0) return null;
    const genome = genomeForSpec(agent);
    const pairKey = (hypothesis) => `${hypothesis.symbol}:${hypothesis.family}`;
    const exact = ranked.find((h) => h.symbol === genome?.symbol && h.family === genome?.family);
    // Prefer a proven pair NO other agent is using before falling back to the same family:
    // with 30 agents and ~22 proven hypotheses this spreads the population across as many
    // distinct strategies as the data actually supports instead of piling onto one symbol.
    const unused = ranked.find((h) => !usedPairs.has(pairKey(h)));
    const sameFamily = ranked.find((h) => h.family === genome?.family);
    const match = exact ?? unused ?? sameFamily ?? ranked[0];
    usedPairs.add(pairKey(match));
    try {
      const compiled = await builder.compile({
        hypothesis: match,
        agentId: agent.id,
        cycleBudgetUsd,
        genome,
      });
      const spec = compiled?.spec ?? compiled;
      if (!spec || !spec.specId) return null;
      await ensureDir(paths.specsDir);
      await writeJsonAtomic(path.join(paths.specsDir, `${spec.specId}.json`), spec);
      state.specs.set(spec.specId, spec);
      await registry.update(agent.id, { specId: spec.specId });
      return { spec, cached: false };
    } catch (error) {
      return { __compileError: errorInfo(error), hypothesisId: match?.id };
    }
  }

  /** Charge one cycle of metabolism to one agent, attributed by role. */
  async function chargeCycleCosts(agent) {
    const cycleHours = config.cycleIntervalSec / 3600;
    const hostingUsd = (config.burn.hostingPerHourUsd + config.burn.committedMonthlyUsd / 730) * cycleHours;
    const inference = config.burn.inferencePerCycleUsd;
    const data = config.burn.dataPerCycleUsd;
    const charges = [
      { amount: hostingUsd, category: 'hosting', role: 'treasurer' },
      { amount: data, category: 'data', role: 'prospector' },
      { amount: inference * 0.4, category: 'inference', role: 'prospector' },
      { amount: inference * 0.25, category: 'inference', role: 'builder' },
      { amount: inference * 0.3, category: 'inference', role: 'executor' },
      { amount: inference * 0.05, category: 'inference', role: 'treasurer' },
    ];
    for (const charge of charges) {
      if (!(charge.amount > 0)) continue;
      try {
        await ledger.charge(agent.id, charge.amount, {
          category: charge.category,
          role: charge.role,
          ref: `cycle:${state.ticks + 1}`,
          at: clock.now(),
        });
      } catch (error) {
        if (error?.code === 'INSUFFICIENT_CASH') {
          // The metabolism cannot be paid — the Treasurer will declare death this cycle.
          return;
        }
        throw error;
      }
    }
  }

  // -------------------------------------------------------------------------
  // init / seed
  // -------------------------------------------------------------------------

  async function seedGenesis(accountEquityUsd) {
    if (registry.population() > 0) return;
    const count = Math.max(0, Number(config.population.initial) || 0);
    const required = count * config.endowmentUsd;
    const cap = accountEquityUsd * config.account.allocationCapPct;
    if (required > cap) {
      const error = new Error(
        `initial population needs ${round2(required)} USD but the allocation cap is ${round2(cap)} USD ` +
          `(account ${round2(accountEquityUsd)} x ${config.account.allocationCapPct}). ` +
          'Lower population.initial, endowmentUsd, or raise account.allocationCapPct.',
      );
      error.code = 'CONFIG_INVALID';
      throw error;
    }
    for (let i = 0; i < count; i += 1) {
      const genome = genesisGenome(config, i);
      const agent = await registry.register({
        id: registry.nextId(),
        name: nextAgentName(genome, usedNames(registry.all())),
        parentId: null,
        generation: 0,
        bornAt: clock.iso(),
        status: 'alive',
        endowmentUsd: config.endowmentUsd,
        genome,
        mutation: null,
        specId: null,
        notes: ['genesis'],
      });
      await ledger.ensureAgent(agent.id, { endowmentUsd: config.endowmentUsd, at: clock.now() });
      await treasurer.grantInitial(agent.id, config.endowmentUsd);
      state.dayStats.agents[agent.id] = { ordersCount: 0, startEquityUsd: config.endowmentUsd };
    }
    await registry.save();
    await ledger.save();
    log.info('genesis population seeded', { count, endowmentUsd: config.endowmentUsd });
  }

  /**
   * Operators see strategy-derived names, not random ids. Agents created before naming
   * existed are backfilled deterministically (living agents only; dead records are immutable
   * and their name is optional).
   */
  async function backfillAgentNames() {
    const agents = registry.all().filter((agent) => agent.status === 'alive' && !agent.name);
    if (agents.length === 0) return;
    const taken = usedNames(registry.all());
    let changed = 0;
    for (const agent of agents) {
      const name = nextAgentName(agent.genome ?? {}, [...taken]);
      taken.push(name);
      try {
        await registry.update(agent.id, { name });
        changed += 1;
      } catch {
        /* a dead/immutable record keeps its id as its label */
      }
    }
    if (changed > 0) {
      await registry.save();
      log.info('agent names backfilled', { count: changed });
    }
  }

  async function init() {
    if (state.initialized) return;
    await ensureDir(paths.stateDir);
    await ensureDir(paths.specsDir);
    await registry.load();
    await ledger.load();
    await loadDayStats(clock.now());
    await researcher.init();
    // Reload compiled specs from disk so a restart does not silently drop strategies.
    try {
      const specFiles = (await fsp.readdir(paths.specsDir)).filter((file) => file.endsWith('.json'));
      for (const file of specFiles) {
        const spec = await readJson(path.join(paths.specsDir, file), null);
        if (spec && spec.specId) state.specs.set(spec.specId, spec);
      }
    } catch {
      /* specs dir may be missing on a first run */
    }
    const account = await broker.getAccount();
    await seedGenesis(Number(account?.equityUsd) || 0);
    await backfillAgentNames();
    state.initialized = true;
    const snapshot = await buildSnapshot({ account, treasury: null, halted: false, haltReasons: [] });
    await writeStateFile(snapshot);
    log.info('automaton ready', {
      mode: config.mode,
      population: registry.population(),
      accountEquityUsd: round2(Number(account?.equityUsd) || 0),
    });
  }

  // -------------------------------------------------------------------------
  // the cycle
  // -------------------------------------------------------------------------

  async function tick() {
    if (state.ticking) return state.lastTrace ?? { skipped: 'tick_in_progress' };
    state.ticking = true;
    const startedAt = clock.now();
    const tickId = newId('tick');
    const trace = {
      tickId,
      at: new Date(startedAt).toISOString(),
      mode: config.mode,
      durationMs: 0,
      halted: false,
      haltReasons: [],
      account: null,
      treasury: null,
      market: { symbols: 0, bars: 0, quotes: 0 },
      prospector: null,
      research: null,
      builds: [],
      executions: [],
      replication: null,
      deaths: [],
      errors: [],
    };
    try {
      if (!state.initialized) await init();

      // D11 kill switch: checked before anything can spend or trade.
      try {
        brakes.assertKillSwitchClear();
      } catch (error) {
        trace.halted = true;
        trace.haltReasons.push(errorInfo(error).code ?? 'KILL_SWITCH');
        state.lastTrace = trace;
        return trace;
      }

      // Re-sync with disk before spending or trading: the external Reaper may have killed
      // agents and swept their residual cash since the last cycle. Disk is the truth; this
      // in-memory population must never keep trading an agent the Reaper has executed.
      try {
        await registry.load();
        await ledger.load();
      } catch (error) {
        trace.errors.push({ role: 'store', ...errorInfo(error) });
      }
      for (const agentId of [...state.condemned]) {
        if (registry.get(agentId)?.status === 'dead') state.condemned.delete(agentId);
      }
      state.ticks += 1;

      // 1. market snapshot (one data read for the whole population).
      // The broker clock is authoritative for D3: a weekday time-window check alone would
      // happily trade on a Saturday. A clock failure is not fatal (sim has none) but it
      // leaves marketOpen unknown, and the brakes then fall back to the window check.
      let marketClock = null;
      try {
        marketClock = await broker.getClock?.();
      } catch (error) {
        trace.errors.push({ role: 'clock', ...errorInfo(error) });
      }
      const marketOpen = marketClock && typeof marketClock.isOpen === 'boolean' ? marketClock.isOpen : null;
      state.lastMarketClock = marketClock;
      state.lastMarketOpen = marketOpen;
      trace.marketOpen = marketOpen;
      if (marketOpen === false) {
        // Still price the population and record exits, but no new entries: the brakes get
        // marketOpen=false and deny every order with D3.
        trace.marketClosed = true;
      }
      // In sim mode the synthetic market only moves when advanced, so each cycle is a
      // new bar — otherwise every cycle would see identical signals and never trade.
      if (config.mode === 'sim' && typeof broker.advanceBar === 'function') {
        broker.advanceBar(1);
      }
      const bars = await broker.getBars({
        symbols: config.symbols,
        timeframe: config.data.timeframe,
        limit: Math.min(Number(config.data.lookbackBars) || 60, 500),
      });
      const prices = pricesFromBars(bars);
      const quotes = await readQuotes(broker, config.symbols, prices);
      trace.market = {
        symbols: Object.keys(prices).length,
        bars: Object.values(bars ?? {}).reduce((n, series) => n + (Array.isArray(series) ? series.length : 0), 0),
        quotes: Object.keys(quotes).length,
      };
      state.lastPrices = prices;
      state.lastQuotes = quotes;

      // 2. metabolism: charge every living, non-condemned agent for this cycle
      const aliveAgents = registry.alive().filter((agent) => !state.condemned.has(agent.id));
      for (const agent of aliveAgents) await chargeCycleCosts(agent);
      await ledger.save();

      // 3. TREASURER prices the population, issues mandates and verdicts
      const dayStats = {};
      for (const agent of aliveAgents) {
        const eq = ledger.equity(agent.id, prices);
        const stored = state.dayStats.agents[agent.id] ?? { ordersCount: 0, startEquityUsd: null };
        if (stored.startEquityUsd == null) stored.startEquityUsd = round2(eq.equityUsd);
        state.dayStats.agents[agent.id] = stored;
        dayStats[agent.id] = {
          dayKey: state.dayStats.dayKey,
          ordersCount: stored.ordersCount ?? 0,
          startEquityUsd: round2(stored.startEquityUsd),
          // The daily-loss death rule needs real P&L, not a hardcoded zero.
          pnlUsd: round2(eq.equityUsd - stored.startEquityUsd),
        };
        // Persist the P&L too: the external Reaper re-derives daily_loss_limit from this
        // file, so a fatal verdict must be executable outside the engine.
        stored.pnlUsd = dayStats[agent.id].pnlUsd;
        stored.dayKey = state.dayStats.dayKey;
      }
      const treasuryView = await treasurer.tick({ prices, dayStats });
      state.lastTreasury = treasuryView;
      trace.account = treasuryView.account;
      trace.treasury = {
        state: treasuryView.state,
        runwayHours: treasuryView.runwayHours,
        burnPerHourUsd: treasuryView.burnPerHourUsd,
        cycleBudgetUsd: treasuryView.cycleBudgetUsd,
        surplus7dUsd: treasuryView.surplus7dUsd,
        mayReplicate: treasuryView.mayReplicate,
        allocatedUsd: treasuryView.allocatedUsd,
        reconciliation: treasuryView.reconciliation,
        halted: treasuryView.halted,
      };
      trace.halted = Boolean(treasuryView.halted);
      trace.haltReasons = treasuryView.haltReasons ?? [];

      for (const verdict of treasuryView.verdicts ?? []) {
        state.condemned.add(verdict.agentId);
        trace.deaths.push({ agentId: verdict.agentId, cause: verdict.cause, finalEquityUsd: verdict.finalEquityUsd });
      }
      if ((treasuryView.verdicts ?? []).length > 0) {
        await writeJsonAtomic(paths.deaths, { at: clock.iso(), verdicts: treasuryView.verdicts });
      }

      // In sim mode there is no separate broker process to share: the engine executes its
      // own verdicts in-process (DEMO MODE ONLY). Paper/live never take this path — their
      // deaths are executed by the external Reaper process from persisted state.
      if (config.mode === 'sim') {
        try {
          state.inProcessReaper = state.inProcessReaper
            ?? createReaper({ broker, registry, ledger, journal, config, paths, clock });
          const swept = await state.inProcessReaper.sweep({ prices });
          trace.deathsExecuted = (swept.killed ?? []).map((entry) => ({
            agentId: entry.agentId,
            cause: entry.cause,
            liquidated: (entry.liquidated ?? []).length,
            sweptUsd: entry.sweptUsd ?? 0,
          }));
          for (const killedAgent of swept.killed ?? []) state.condemned.delete(killedAgent.agentId);
          if ((swept.skipped ?? []).some((entry) => String(entry.reason ?? '').startsWith('kill_failed'))) {
            trace.errors.push({ role: 'reaper', code: 'KILL_SETTLE', message: 'one or more sim kills failed to settle' });
          }
        } catch (error) {
          trace.errors.push({ role: 'reaper', ...errorInfo(error) });
        }
      }

      // 3b. RESEARCH: per-agent isolated hourly news briefing (docs/RESEARCH.md).
      // Runs before the executor pass so a due briefing can veto/size/exit in THIS cycle.
      // It never trades, never reads another agent's book, and each briefing is paid for by
      // the agent's own ledger. Halted treasuries skip research (no spend while reconciling).
      if (!treasuryView.halted) {
        try {
          const researchRun = await researcher.tick();
          trace.research = {
            enabled: researchRun.enabled,
            configured: researchRun.configured,
            due: researchRun.due,
            ran: researchRun.ran.length,
            skipped: researchRun.skipped,
            errors: researchRun.ran.filter((entry) => entry.error).length,
            budgetUsd: round4(researchRun.ran.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)),
          };
          if (!researchRun.enabled || !researchRun.configured) {
            trace.research.note = !researchRun.enabled ? 'disabled by config' : 'no LLM generator configured';
          }
        } catch (error) {
          trace.errors.push({ role: 'research', ...errorInfo(error) });
        }
      }

      // 4. PROSPECTOR: dated-proof hypotheses (skipped entirely while halted)
      let hypotheses = [];
      if (!treasuryView.halted) {
        try {
          const prospected = await prospector.run({ budgetUsd: treasuryView.cycleBudgetUsd });
          hypotheses = prospected?.hypotheses ?? [];
          trace.prospector = {
            hypotheses: hypotheses.length,
            spentUsd: prospected?.spentUsd ?? 0,
            dataCalls: prospected?.dataCalls ?? 0,
            rejected: (prospected?.rejected ?? []).length,
          };
        } catch (error) {
          trace.errors.push({ role: 'prospector', ...errorInfo(error) });
        }
      }

      // 5. BUILDER + EXECUTOR per living agent, inside the Treasurer mandate
      const agentViews = new Map((treasuryView.agentViews ?? []).map((view) => [view.agentId, view]));
      const usedPairs = new Set();
      for (const agent of registry.alive()) {
        if (state.condemned.has(agent.id)) continue;
        const mandate = treasuryView.mandates?.[agent.id];
        const view = agentViews.get(agent.id);
        if (!mandate || !view) continue;
        if (treasuryView.halted && !mandate.allowExitOnly) continue;

        const built = await ensureSpec(agent, hypotheses, treasuryView.cycleBudgetUsd, usedPairs);
        if (!built) {
          trace.builds.push({ agentId: agent.id, specId: null, skipped: 'no_hypothesis' });
          continue;
        }
        if (built.__compileError) {
          trace.builds.push({ agentId: agent.id, specId: null, error: built.__compileError.code, hypothesisId: built.hypothesisId });
          continue;
        }
        const spec = built.spec;

        trace.builds.push({
          agentId: agent.id,
          specId: spec.specId,
          symbol: spec.symbol,
          family: spec.family,
          compiled: !built.cached,
        });
        try {
          const result = await executor.run({
            agent,
            spec,
            mandate,
            quotes,
            // One market read per cycle for the whole population: with 30 agents, letting
            // the executor refetch per agent would multiply data calls by 30.
            bars,
            dayStats: dayStats[agent.id],
            now: startedAt,
            marketOpen,
            marketClock,
            // Fresh per-agent briefing (null when missing/stale/disabled); the executor may
            // veto entries, scale size or force an exit — it can never place orders itself.
            research: researcher.latest(agent.id),
          });
          trace.executions.push({
            agentId: agent.id,
            specId: spec.specId,
            actions: result?.actions?.length ?? 0,
            orders: result?.orders?.length ?? 0,
            denied: result?.denied?.length ?? 0,
            spentUsd: result?.spentUsd ?? 0,
            detail: (result?.actions ?? []).slice(0, 4).map((action) => ({
              type: action.type,
              symbol: action.symbol,
              reason: action.reason,
            })),
          });
          const statsEntry = state.dayStats.agents[agent.id] ?? { ordersCount: 0, startEquityUsd: view.equityUsd };
          statsEntry.ordersCount = (statsEntry.ordersCount ?? 0) + (result?.orders?.length ?? 0);
          statsEntry.startEquityUsd = statsEntry.startEquityUsd ?? round2(view.equityUsd);
          state.dayStats.agents[agent.id] = statsEntry;
          if (result?.denied?.length) {
            for (const denial of result.denied.slice(0, 5)) {
              trace.errors.push({
                role: 'executor',
                agentId: agent.id,
                code: denial.code,
                message: denial.reason ?? 'brake denied',
              });
            }
          }
        } catch (error) {
          trace.errors.push({ role: 'executor', agentId: agent.id, ...errorInfo(error) });
        }
      }
      await saveDayStats();
      // Persist spec assignments: ensureSpec() updated the registry in memory; without this
      // save a restart (and the next cycle's disk re-sync) would forget every agent's spec.
      await registry.save();
      await ledger.save();

      // 6. REPLICATOR: only when the Treasurer's gate says so, one mutation, cap enforced
      if (treasuryView.mayReplicate && !treasuryView.halted) {
        const candidates = registry
          .alive()
          .filter((agent) => !state.condemned.has(agent.id))
          .map((agent) => ({ agent, view: agentViews.get(agent.id) }))
          .filter((entry) => entry.view && Number(entry.view.equityUsd) > 0)
          .sort((a, b) => (b.view.net7dUsd ?? 0) - (a.view.net7dUsd ?? 0));
        for (const candidate of candidates) {
          try {
            const spawned = await replicator.spawn(candidate.agent.id, treasuryView);
            trace.replication = {
              childId: spawned?.child?.id ?? spawned?.childId ?? null,
              parentId: candidate.agent.id,
              mutation: spawned?.mutation ?? null,
              lessons: spawned?.lessonCount ?? 0,
            };
            break;
          } catch (error) {
            const info = errorInfo(error);
            if (info.code === 'POPULATION_CAP' || info.code === 'REPLICATION_DENIED') {
              trace.replication = { blocked: info.code, message: info.message };
              break;
            }
            trace.errors.push({ role: 'replicator', ...info });
          }
        }
      }

      // 7. snapshot + trace
      // Mark completion BEFORE the snapshot: the persisted state.json (what the panel and
      // `automaton_status` read) must show this tick, not the previous one. A successful
      // cycle also clears a transient lastError (e.g. a one-off Windows file-lock retry), so
      // the panel does not keep showing a stale failure forever.
      state.lastTickAt = new Date(clock.now()).toISOString();
      state.lastTrace = trace;
      state.lastError = null;
      const snapshot = await buildSnapshot({
        account: treasuryView.account,
        treasury: treasuryView,
        halted: treasuryView.halted,
        haltReasons: treasuryView.haltReasons,
      });
      await writeStateFile(snapshot);
      trace.durationMs = clock.now() - startedAt;
      await appendTrace(trace);
      return trace;
    } catch (error) {
      state.errors += 1;
      state.lastError = errorInfo(error);
      trace.errors.push({ role: 'orchestrator', ...errorInfo(error) });
      trace.durationMs = clock.now() - startedAt;
      state.lastTrace = trace;
      log.error('tick failed', state.lastError);
      throw error;
    } finally {
      state.ticking = false;
    }
  }

  // -------------------------------------------------------------------------
  // snapshot for UI / tools
  // -------------------------------------------------------------------------

  async function buildSnapshot({ account, treasury, halted, haltReasons }) {
    const alive = registry.alive();
    const dead = registry.dead();
    const views = new Map((treasury?.agentViews ?? []).map((view) => [view.agentId, view]));
    const marks = state.lastPrices && typeof state.lastPrices === 'object' ? state.lastPrices : {};
    const agents = registry.all().map((agent) => {
      const view = views.get(agent.id) ?? null;
      const isDead = agent.status === 'dead';
      const isCondemned = !isDead && state.condemned.has(agent.id);
      // Holdings + activity for the control panel's per-agent drill-down. Bookkeeping only:
      // no broker call, no account equity, no secrets.
      let book = null;
      try {
        book = ledger.snapshot(agent.id);
      } catch {
        book = null;
      }
      let recentTrades = [];
      try {
        recentTrades = typeof ledger.history === 'function' ? ledger.history(agent.id, { limit: 12 }) : [];
      } catch {
        recentTrades = [];
      }
      const positions = Object.entries(book?.positions ?? {}).map(([symbol, position]) => {
        const qty = Number(position?.qty) || 0;
        const avgPriceUsd = Number(position?.avgPriceUsd) || 0;
        const lastPriceUsd = Number(marks[symbol]) > 0 ? Number(marks[symbol]) : avgPriceUsd;
        const marketValueUsd = round2(qty * lastPriceUsd);
        return {
          symbol,
          qty,
          avgPriceUsd: round4(avgPriceUsd),
          lastPriceUsd: round4(lastPriceUsd),
          marketValueUsd,
          unrealizedPlUsd: round2(marketValueUsd - qty * avgPriceUsd),
          openedAt: position?.openedAt ?? null,
        };
      });
      const spec = agent.specId ? state.specs.get(agent.specId) ?? null : null;
      return {
        id: agent.id,
        name: agent.name ?? agent.id,
        parentId: agent.parentId,
        generation: agent.generation,
        status: isDead ? 'dead' : isCondemned ? 'condemned' : agent.status,
        bornAt: agent.bornAt,
        diedAt: agent.diedAt,
        cause: agent.cause,
        endowmentUsd: agent.endowmentUsd,
        genome: agent.genome,
        mutation: agent.mutation,
        specId: agent.specId,
        spec: spec
          ? {
              specId: spec.specId,
              symbol: spec.symbol,
              family: spec.family,
              params: spec.params ?? {},
              createdAt: spec.createdAt ?? null,
            }
          : null,
        equityUsd: view?.equityUsd ?? null,
        cashUsd: view?.cashUsd ?? book?.cashUsd ?? null,
        positionsValueUsd: view?.positionsValueUsd ?? null,
        runwayHours: view?.runwayHours ?? null,
        treasuryState: view?.state ?? null,
        drawdownPct: view?.drawdownPct ?? null,
        dayPnlPct: view?.dayPnlPct ?? null,
        net7dUsd: view?.net7dUsd ?? null,
        positions,
        recentTrades,
        tradesCount: Number(book?.trades) || 0,
        realizedPlUsd: book?.realizedPlUsd ?? null,
        unrealizedPlUsd: book?.unrealizedPlUsd ?? null,
        firstProfitAt: book?.firstProfitAt ?? null,
        roleCosts: view?.roleCosts ?? {},
        // Isolated per-agent research briefing (fresh or stale, for the dashboard).
        research: researcher.latestAny(agent.id),
        note: isCondemned ? 'death verdict written; the external Reaper executes it' : null,
      };
    });
    const obituaryStats = journal.stats ? await journal.stats() : null;
    return {
      at: new Date(clock.now()).toISOString(),
      mode: config.mode,
      engine: {
        running: state.running,
        ticks: state.ticks,
        errors: state.errors,
        lastTickAt: state.lastTickAt,
        lastError: state.lastError,
        killSwitch: brakes.isKillSwitchActive?.(),
        liveArmed: liveArmed(config),
        research: researcher.schedule(),
      },
      account: account ?? null,
      treasury: treasury
        ? {
            state: treasury.state,
            runwayHours: treasury.runwayHours,
            burnPerHourUsd: treasury.burnPerHourUsd,
            cycleBudgetUsd: treasury.cycleBudgetUsd,
            surplus7dUsd: treasury.surplus7dUsd,
            mayReplicate: treasury.mayReplicate,
            allocatedUsd: treasury.allocatedUsd,
            poolUsd: treasury.poolUsd,
            reconciliation: treasury.reconciliation,
          }
        : null,
      population: {
        total: registry.all().length,
        alive: alive.length,
        dead: dead.length,
        condemned: state.condemned.size,
        cap: config.population.cap,
        byGeneration: registry.generationStats ? registry.generationStats() : {},
      },
      agents,
      obituaries: obituaryStats,
      halted: Boolean(halted),
      haltReasons: haltReasons ?? [],
      config: {
        cycleIntervalSec: config.cycleIntervalSec,
        deathFloorUsd: Math.max(config.deathFloorUsd, config.deathFloorPct * config.endowmentUsd),
        endowmentUsd: config.endowmentUsd,
        symbols: config.symbols,
      },
    };
  }

  async function status() {
    const snapshot = await readJson(paths.stateFile, null);
    if (!snapshot) {
      return {
        at: new Date(clock.now()).toISOString(),
        mode: config.mode,
        engine: {
          running: state.running,
          ticks: state.ticks,
          errors: state.errors,
          lastTickAt: state.lastTickAt,
          lastError: state.lastError,
          killSwitch: brakes.isKillSwitchActive?.(),
          liveArmed: liveArmed(config),
          initialized: state.initialized,
        },
        account: null,
        treasury: null,
        population: { total: 0, alive: 0, dead: 0, condemned: 0, cap: config.population.cap, byGeneration: {} },
        agents: [],
        obituaries: journal.stats ? await journal.stats() : null,
        halted: false,
        haltReasons: [],
        config: {
          cycleIntervalSec: config.cycleIntervalSec,
          deathFloorUsd: Math.max(config.deathFloorUsd, config.deathFloorPct * config.endowmentUsd),
          endowmentUsd: config.endowmentUsd,
          symbols: config.symbols,
        },
      };
    }
    return {
      ...snapshot,
      engine: { ...snapshot.engine, running: state.running, initialized: state.initialized },
    };
  }

  async function start() {
    if (state.running) return status();
    await init();
    state.running = true;
    const intervalMs = Math.max(1000, Number(config.cycleIntervalSec) * 1000);
    const loop = async () => {
      if (!state.running) return;
      try {
        await tick();
      } catch (error) {
        log.error('loop tick failed', errorInfo(error));
      }
      if (state.running) {
        state.timer = setTimeout(loop, intervalMs);
        if (typeof state.timer.unref === 'function') state.timer.unref();
      }
    };
    loop();
    return status();
  }

  async function stop() {
    state.running = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    return status();
  }

  function isRunning() {
    return state.running;
  }

  /** Operator-only dry-run pre-trade check (used by the automaton_brakes tool). */
  async function preTradeCheck({ agentId, symbol, side = 'buy', notionalUsd, priceUsd } = {}) {
    const market = { prices: state.lastPrices, quotes: state.lastQuotes };
    const treasuryView = state.lastTreasury;
    const agentView = (treasuryView?.agentViews ?? []).find((view) => view.agentId === agentId);
    const mandate = treasuryView?.mandates?.[agentId];
    const agent = registry.get(agentId);
    const quote = market.quotes?.[symbol] ?? null;
    const price = Number(priceUsd) || Number(quote?.ask) || Number(market.prices?.[symbol]) || 0;
    const notional = Number(notionalUsd) || (price > 0 ? price : 0);
    // The dry run must traverse the SAME proof check a real order would: load the agent's
    // full compiled spec (with proofRef) instead of a stub, or D9 always denies NO_PROOF.
    const spec = agent?.specId ? state.specs.get(agent.specId) ?? null : null;
    return brakes.checkOrder({
      mode: config.mode,
      now: clock.now(),
      agentId,
      dayStats: agentView ? dayStatsFor(agentId) : undefined,
      quote,
      order: { symbol, side, qty: price > 0 ? notional / price : 0, priceUsd: price, notionalUsd: notional },
      equityUsd: agentView?.equityUsd ?? 0,
      positions: agentView?.positions ?? [],
      mandate,
      spec,
      accountEquityUsd: treasuryView?.account?.equityUsd ?? 0,
      allocatedEquityUsd: treasuryView?.allocatedUsd ?? 0,
      spreadBps: quote && quote.bid > 0 ? ((quote.ask - quote.bid) / quote.bid) * 10000 : 0,
      // D3 with the broker's authoritative session state, not just the weekday window.
      marketOpen: state.lastMarketOpen ?? null,
      marketClock: state.lastMarketClock ?? null,
    });
  }

  return {
    // lifecycle
    init,
    tick,
    start,
    stop,
    isRunning,
    status,
    // views
    obituaries: async ({ limit = 50, offset = 0 } = {}) => ({
      stats: journal.stats ? await journal.stats() : null,
      items: await journal.list({ limit, offset }),
    }),
    brakesView: () => ({
      rules: brakes.describe(),
      killSwitch: Boolean(brakes.isKillSwitchActive?.()),
      liveArmed: liveArmed(config),
      mode: config.mode,
    }),
    preTradeCheck,
    // internals exposed for tests/tools (documented as operator surface, not agent surface)
    _internals: { registry, ledger, journal, treasurer, replicator, prospector, builder, executor, brakes, state },
    config,
    paths,
    broker,
  };
}

export { genesisGenome, pricesFromBars, readQuotes, safeJson };
