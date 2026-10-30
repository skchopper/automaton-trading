/**
 * ACCELERATED POPULATION SIMULATION — mortality, observed without real money.
 *
 * Composes the same roles the live engine uses — simulated broker + market, registry,
 * ledger, journal, brakes, treasurer, replicator, builder, prospector, executor — and
 * runs a seeded population forward for many cycles with one hourly bar per cycle.
 * No network, no real orders, no wall-clock dependence in the domain logic.
 *
 * Death itself is normally executed by the external Reaper; in-process simulation has
 * no separate process, so this module applies the Treasurer's verdicts directly
 * (liquidate at the last mark, mark dead, append the obituary, sweep the residual to
 * `__treasury__`). That is the same kill sequence, minus process isolation, and is
 * documented here so it is never mistaken for the production Reaper.
 *
 * Output is the survival dataset the article is about: who lived, who died, why, how
 * long they lived, and which genomes earned their continuation.
 *
 * Contract: docs/CONTRACTS.md § "Plugin" (`automaton_simulate`) + task spec.
 * Owner: market teammate.
 *
 * @module simulate
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HYPOTHESIS_FAMILIES } from './contracts.js';
import { defaultConfig, statePaths } from './config.js';
import { createBroker as createSimBroker, SIM_MARKET_EPOCH_MS } from './broker-sim.js';
import { createJournal } from './journal.js';
import { createRegistry } from './registry.js';
import { createLedger } from './ledger.js';
import { createBrakes } from './brakes.js';
import { createTreasurer } from './treasurer.js';
import { createReplicator } from './replicator.js';
import { createProspector } from './prospector.js';
import { createBuilder } from './builder.js';
import { createExecutor } from './executor.js';
import { liquidatePositions } from './reaper.js';
import {
  createClock,
  HOUR_MS,
  mean,
  median,
  round2,
  round4,
  safeJson,
} from './util.js';

/**
 * One simulated cycle consumes one simulated TRADING DAY (24 hourly bars).
 * Accelerating the clock (rather than the population) is what keeps a 200-cycle run
 * both fast and meaningful: mortality needs weeks of trader life, and the ledger's
 * rolling 7-day event window stays bounded instead of growing without limit.
 */
const SIM_CYCLE_HOURS = 24;
const CYCLE_MS = SIM_CYCLE_HOURS * HOUR_MS;

/** Keep one Intl formatter instead of building one per day-key lookup. */
function makeDayKeyFn(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (ms) => {
    const parts = formatter.formatToParts(new Date(ms));
    const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
}

const DEFAULT_GENOME = Object.freeze({
  family: 'momentum',
  lookback: 60,
  entryZ: 1.2,
  exitZ: 0.3,
  stopPct: 0.02,
  targetPct: 0.04,
  maxHoldBars: 12,
  sizePct: 0.2,
  sessionFilter: 'any',
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Deep merge plain objects; arrays/scalars from source replace the target. */
export function mergeConfig(target, source) {
  if (!isPlainObject(source)) return target;
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeConfig(out[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Genesis genome for simulation: deterministic genome per initial agent index. */
export function simGenome(config, index) {
  const symbols = Array.isArray(config.symbols) && config.symbols.length > 0 ? config.symbols : ['SPY'];
  return {
    ...DEFAULT_GENOME,
    symbol: symbols[index % symbols.length],
    family: HYPOTHESIS_FAMILIES[index % HYPOTHESIS_FAMILIES.length],
  };
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function equityOf(ledger, agentId, prices) {
  try {
    const view = ledger.equity(agentId, prices);
    return numberOrZero(view?.equityUsd);
  } catch {
    return 0;
  }
}

function safeSnapshot(ledger, agentId) {
  try {
    return ledger.snapshot(agentId);
  } catch {
    return null;
  }
}

/** Build the obituary the journal requires (same fields the Reaper writes). */
function buildObituary({ agent, ledger, nowMs, cause, finalEquityUsd, lastRunwayHours }) {
  const snapshot = safeSnapshot(ledger, agent.id) ?? {};
  const bornMs = Date.parse(String(agent.bornAt));
  const lifespanHours = Number.isFinite(bornMs) ? Math.max(0, round2((nowMs - bornMs) / HOUR_MS)) : 0;
  const endowmentUsd = numberOrZero(agent.endowmentUsd);
  // The journal requires a finite lastRunwayHours and a null-or-ISO firstProfitAt.
  const firstProfitAt = (() => {
    const value = snapshot.firstProfitAt;
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  })();
  return {
    agentId: agent.id,
    parentId: agent.parentId ?? null,
    generation: Number(agent.generation) || 0,
    bornAt: agent.bornAt,
    diedAt: new Date(nowMs).toISOString(),
    lifespanHours,
    endowmentUsd,
    finalEquityUsd: round2(numberOrZero(finalEquityUsd)),
    revenueUsd: round2(numberOrZero(snapshot.grossRevenueUsd)),
    spendUsd: round2(numberOrZero(snapshot.costsUsd)),
    netPlUsd: round2(numberOrZero(finalEquityUsd) - endowmentUsd),
    genome: agent.genome && typeof agent.genome === 'object' ? agent.genome : {},
    mutation: agent.mutation ?? null,
    productsShipped: 0,
    tradesCount: Math.max(0, Number(snapshot.trades) || 0),
    firstProfitAt,
    strategySpecId: typeof agent.specId === 'string' ? agent.specId : null,
    cause,
    lastRunwayHours: round2(numberOrZero(lastRunwayHours)),
    lessons: [],
  };
}

// ---------------------------------------------------------------------------
// config for a run
// ---------------------------------------------------------------------------

/**
 * Build the sim config: base config + overrides, forced to mode=sim with a temporary
 * state directory, population seeded to `population`, and one simulated TRADING DAY
 * per cycle (24 hourly market bars).
 */
function buildSimConfig({ baseConfig, population, configOverrides, stateDir }) {
  const base = baseConfig && typeof baseConfig === 'object' ? baseConfig : defaultConfig();
  let config = mergeConfig(base, {
    mode: 'sim',
    cycleIntervalSec: SIM_CYCLE_HOURS * 3600, // one cycle == one simulated trading day
    reaperIntervalSec: 30,
    population: { initial: population, cap: population },
    data: { timeframe: '1Hour' },
    engine: { autoStart: false },
    paths: { ...(base.paths ?? {}), stateDir },
  });
  config = mergeConfig(config, configOverrides ?? {});
  config.mode = 'sim';
  config.cycleIntervalSec = SIM_CYCLE_HOURS * 3600;
  config.paths = { ...(config.paths ?? {}), stateDir };
  config.population = {
    ...(config.population ?? {}),
    initial: population,
    cap: Math.max(population, Number(configOverrides?.population?.cap ?? population)),
  };
  return config;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

/**
 * Accelerated mortality simulation.
 *
 * @param {{
 *   cycles?: number,
 *   population?: number,
 *   seed?: number,
 *   configOverrides?: object,
 *   config?: object,
 *   stateDir?: string,        // optional explicit state dir (tests); else temp
 *   keepStateDir?: boolean,
 * }} [options]
 * @returns {Promise<object>} survival statistics
 */
export async function runSimulation({
  cycles = 200,
  population = 150,
  seed = 7,
  configOverrides = {},
  config: baseConfig,
  stateDir = null,
  keepStateDir = false,
} = {}) {
  const startedAt = performance.now();
  const cycleCount = Math.max(1, Math.floor(Number(cycles) || 1));
  const populationSize = Math.max(1, Math.floor(Number(population) || 1));
  const resolvedSeed = Number.isFinite(Number(seed)) ? Number(seed) : 7;

  const tempDir = stateDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'automaton-sim-')));
  const shouldClean = !keepStateDir && !stateDir;

  try {
    const config = buildSimConfig({
      baseConfig,
      population: populationSize,
      configOverrides,
      stateDir: tempDir,
    });
    const paths = statePaths(config);

    // --- clock + broker: 24 hourly bars per accelerated daily cycle -------------
    const historyBars = Math.max(400, numberOrZero(config.data?.lookbackBars) + 60);
    // Broker history is generated on an hourly grid; the simulated clock starts at
    // the moment after the last history bar.
    const startMs = SIM_MARKET_EPOCH_MS + historyBars * HOUR_MS;
    const clock = createClock({ now: () => startMs });
    const dayKeyOf = makeDayKeyFn(config.timeZone ?? 'America/New_York');
    // Refresh the Prospector well inside the maxProofAgeDays window (e.g. every 3
    // simulated days for a 7-day max age) so no spec ever trades on stale proof.
    const maxProofAgeDays = numberOrZero(config.data?.maxProofAgeDays) || 7;
    const hoursPerCycle = SIM_CYCLE_HOURS;
    const prospectRefreshCycles = Math.max(
      1,
      Math.floor((maxProofAgeDays * 0.5 * 24) / hoursPerCycle),
    );
    const allocationCapPct = numberOrZero(config.account?.allocationCapPct) || 0.8;
    const endowmentUsd = numberOrZero(config.endowmentUsd) || 5000;
    const accountEquityUsd = Math.max(
      100_000,
      Math.ceil((populationSize * endowmentUsd) / allocationCapPct * 1.1),
    );
    const broker = createSimBroker(
      config,
      { seed: resolvedSeed, clock, accountEquityUsd },
      { seed: resolvedSeed, accountEquityUsd },
    );

    // --- mortality + market roles ---------------------------------------------
    const journal = createJournal({ paths, config });
    const registry = createRegistry({ paths, config });
    const ledgerRole = createLedger({ paths, config, clock });
    const brakes = createBrakes({ config, paths, clock });
    const treasurer = createTreasurer({ broker, ledger: ledgerRole, registry, journal, config, paths, clock });
    const replicator = createReplicator({ treasurer, registry, ledger: ledgerRole, journal, config, clock });
    const prospector = createProspector({ broker, config, journal, clock, paths });
    const builder = createBuilder({ config, brakes, clock });
    const executor = createExecutor({ broker, brakes, ledger: ledgerRole, config, clock });

    await registry.load();
    await ledgerRole.load();

    // --- genesis population ----------------------------------------------------
    const genomes = new Map();
    const specs = new Map(); // agentId -> StrategySpec
    const errors = [];
    const deaths = [];
    const causes = {};
    const dayStatsByAgent = {};
    let currentDayKey = null;

    for (let i = 0; i < populationSize; i += 1) {
      const genome = simGenome(config, i);
      const agent = await registry.register({
        id: registry.nextId(),
        parentId: null,
        generation: 0,
        bornAt: clock.iso(),
        status: 'alive',
        endowmentUsd,
        genome,
        mutation: null,
        specId: null,
        notes: ['sim-genesis'],
      });
      await ledgerRole.ensureAgent(agent.id, { endowmentUsd, at: clock.now() });
      await treasurer.grantInitial(agent.id, endowmentUsd);
      genomes.set(agent.id, genome);
    }

    // --- hypothesis cache (the population shares one data fetch) ----------------
    let hypotheses = [];
    let hypothesesAtCycle = -Infinity;
    let dataCalls = 0;
    let dataSpendUsd = 0;

    // --- death execution (in-process stand-in for the external Reaper) ----------
    async function applyVerdict(verdict, prices) {
      const agent = registry.get(verdict.agentId);
      if (!agent || agent.status === 'dead') return;
      const finalEquityUsd = numberOrZero(verdict.finalEquityUsd) || equityOf(ledgerRole, agent.id, prices);
      // Close every position the v3 ledger can hold: long/short stock and option legs
      // (incl. spread legs) via the same signed/option liquidation helper the Reaper uses.
      await liquidatePositions({
        broker,
        ledger: ledgerRole,
        agentId: agent.id,
        marks: prices ?? {},
        at: clock.iso(),
        marketOpen: true,
        clientOrderIdPrefix: `atm:${agent.id}:sim-reaper`,
        errors,
        bookOnFailure: true, // simulation has no external truth: always clear the book
      });
      const afterLiquidation = equityOf(ledgerRole, agent.id, prices);
      await registry.markDead(agent.id, {
        cause: verdict.cause,
        at: clock.iso(),
        finalEquityUsd: round2(afterLiquidation || finalEquityUsd),
      });
      const obituary = buildObituary({
        agent,
        ledger: ledgerRole,
        nowMs: clock.now(),
        cause: verdict.cause,
        finalEquityUsd: afterLiquidation || finalEquityUsd,
        lastRunwayHours: verdict.lastRunwayHours,
      });
      try {
        await journal.append(obituary);
      } catch (error) {
        errors.push({ role: 'journal', agentId: agent.id, code: error?.code ?? 'ERROR', message: error?.message ?? String(error) });
      }
      // Sweep residual virtual cash to the treasury pool; a margined estate's debt is
      // absorbed by the pool so the dead book does not keep a negative balance.
      try {
        const exactCashUsd = numberOrZero(ledgerRole.get?.(agent.id)?.cashUsd);
        if (exactCashUsd > 0) {
          await ledgerRole.transfer(agent.id, '__treasury__', exactCashUsd, { reason: 'death', at: clock.now() });
        } else if (exactCashUsd < 0) {
          await ledgerRole.transfer('__treasury__', agent.id, -exactCashUsd, {
            reason: 'death_debt_absorb',
            at: clock.now(),
          });
        }
      } catch {
        /* a zero residual is not transferable; death still stands */
      }
      deaths.push(obituary);
      causes[obituary.cause] = (causes[obituary.cause] ?? 0) + 1;
    }

    /** Charge one cycle of metabolism, attributed by role (same split as the orchestrator). */
    async function chargeCycleCosts(agent) {
      const inference = numberOrZero(config.burn?.inferencePerCycleUsd);
      const hosting = (numberOrZero(config.burn?.hostingPerHourUsd)
        + numberOrZero(config.burn?.committedMonthlyUsd) / 730) * (config.cycleIntervalSec / 3600);
      const data = numberOrZero(config.burn?.dataPerCycleUsd);
      const charges = [
        { amount: hosting, category: 'hosting', role: 'treasurer' },
        { amount: data, category: 'data', role: 'prospector' },
        { amount: inference * 0.4, category: 'inference', role: 'prospector' },
        { amount: inference * 0.25, category: 'inference', role: 'builder' },
        { amount: inference * 0.3, category: 'inference', role: 'executor' },
        { amount: inference * 0.05, category: 'inference', role: 'treasurer' },
      ];
      for (const charge of charges) {
        if (!(charge.amount > 0)) continue;
        try {
          await ledgerRole.charge(agent.id, round4(charge.amount), {
            category: charge.category,
            role: charge.role,
            ref: 'sim-cycle',
            at: clock.now(),
          });
        } catch (error) {
          if (error?.code === 'INSUFFICIENT_CASH') return;
          throw error;
        }
      }
    }

    /**
     * Ensure one alive agent has a current, executable spec compiled from the freshest
     * hypothesis batch. A spec is executable only while its dated proof is fresh: when the
     * proof ages past half of maxProofAgeDays the agent recompiles from this cycle's batch
     * (never mid-position — the exit must use the spec that opened the trade). Without this,
     * a long simulation stops trading after day 7 and every agent dies of uniform cost drain.
     */
    async function ensureSpec(agent, cycleBudgetUsd, usedPairs = new Set()) {
      const known = specs.get(agent.id);
      if (known) {
        const ageMs = clock.now() - (Date.parse(known.createdAt ?? '') || 0);
        const maxAgeMs = Math.min(
          ((numberOrZero(config.data?.maxProofAgeDays) || 7) * 24 * 60 * 60 * 1000) / 2,
          12 * 60 * 60 * 1000,
        );
        let hasPosition = false;
        try {
          hasPosition = Object.keys(ledgerRole.book(agent.id)?.positions ?? {}).length > 0;
        } catch {
          hasPosition = false;
        }
        if (!Number.isFinite(ageMs) || ageMs <= maxAgeMs || hasPosition) return known;
        specs.delete(agent.id);
      }
      if (hypotheses.length === 0) return null;
      const genome = genomes.get(agent.id) ?? agent.genome ?? {};
      const ranked = [...hypotheses].sort((a, b) => numberOrZero(b.rankScore) - numberOrZero(a.rankScore));
      const pairKey = (hypothesis) => `${hypothesis.symbol}:${hypothesis.family}`;
      const match = ranked.find((h) => h.symbol === genome.symbol && h.family === genome.family)
        ?? ranked.find((h) => !usedPairs.has(pairKey(h)))
        ?? ranked.find((h) => h.family === genome.family)
        ?? ranked[0];
      usedPairs.add(pairKey(match));
      try {
        const compiled = await builder.compile({ hypothesis: match, agentId: agent.id, cycleBudgetUsd, genome });
        const spec = compiled?.spec ?? compiled;
        if (!spec || !spec.specId) return null;
        specs.set(agent.id, spec);
        trading.specsCompiled += 1;
        try {
          await registry.update(agent.id, { specId: spec.specId });
        } catch {
          /* spec id is only bookkeeping in simulation */
        }
        return spec;
      } catch (error) {
        if (!['NO_PROOF', 'PROOF_STALE', 'BUDGET_EXCEEDED'].includes(error?.code)) {
          errors.push({ role: 'builder', agentId: agent.id, code: error?.code ?? 'ERROR', message: error?.message ?? String(error) });
        }
        return null;
      }
    }

    const equitySeries = [];
    let replicationCount = 0;
    let knownTotal = populationSize;
    /** Trading diagnostics: the difference between "no edge" and "every order denied". */
    const trading = {
      specsCompiled: 0,
      executions: 0,
      orders: 0,
      entries: 0,
      exits: 0,
      entrySignals: 0,
      denied: {},
      skipReasons: {},
    };

    // =========================================================================
    // cycle loop
    // =========================================================================
    for (let cycle = 1; cycle <= cycleCount; cycle += 1) {
      const atMs = clock.now();
      const at = new Date(atMs).toISOString();
      broker.advanceBar(SIM_CYCLE_HOURS);
      clock.advance(CYCLE_MS);
      // One registry read per cycle: registry.alive() returns clones, so the cycle's
      // living list is read once and verdicts are tracked in `condemned`.
      const aliveAgents = registry.alive();
      const condemned = new Set();

      // one market read for the whole population
      const barsBySymbol = await broker.getBars({
        symbols: config.symbols,
        timeframe: config.data?.timeframe ?? '1Hour',
        limit: Math.min(Number(config.data?.lookbackBars) || 120, 500),
      });
      const prices = {};
      for (const [symbol, series] of Object.entries(barsBySymbol ?? {})) {
        const last = Array.isArray(series) && series.length > 0 ? series[series.length - 1] : null;
        if (last && Number.isFinite(Number(last.c))) prices[symbol] = round4(Number(last.c));
      }
      const quotes = {};
      for (const symbol of config.symbols) {
        try {
          const quote = await broker.getLatestQuote(symbol);
          if (quote && Number.isFinite(Number(quote.bid)) && Number.isFinite(Number(quote.ask))) {
            quotes[symbol] = {
              bid: round4(Number(quote.bid)),
              ask: round4(Number(quote.ask)),
              last: round4(Number(quote.last) || Number(quote.ask)),
              ts: quote.ts ?? atMs,
            };
          }
        } catch {
          /* mark from bars below */
        }
        if (!quotes[symbol] && Number.isFinite(prices[symbol])) {
          quotes[symbol] = { bid: prices[symbol], ask: prices[symbol], last: prices[symbol], ts: atMs };
        }
      }

      // day rollover for the daily order/loss stats
      const todayKey = dayKeyOf(atMs);
      if (todayKey !== currentDayKey) {
        currentDayKey = todayKey;
        for (const key of Object.keys(dayStatsByAgent)) delete dayStatsByAgent[key];
      }
      const dayStats = {};
      for (const agent of aliveAgents) {
        const eq = equityOf(ledgerRole, agent.id, prices);
        const entry = dayStatsByAgent[agent.id] ?? { ordersCount: 0, startEquityUsd: eq };
        if (!Number.isFinite(entry.startEquityUsd) || entry.startEquityUsd <= 0) entry.startEquityUsd = eq;
        dayStatsByAgent[agent.id] = entry;
        dayStats[agent.id] = {
          dayKey: currentDayKey,
          ordersCount: entry.ordersCount,
          startEquityUsd: round2(entry.startEquityUsd),
          pnlUsd: round2(eq - entry.startEquityUsd),
        };
      }

      // metabolism: every living agent pays for the cycle
      for (const agent of aliveAgents) {
        try {
          await chargeCycleCosts(agent);
        } catch (error) {
          errors.push({ role: 'ledger', agentId: agent.id, code: error?.code ?? 'ERROR', message: error?.message ?? String(error) });
        }
      }

      let treasuryView;
      try {
        treasuryView = await treasurer.tick({ prices, dayStats });
      } catch (error) {
        errors.push({ role: 'treasurer', code: error?.code ?? 'ERROR', message: error?.message ?? String(error) });
        break;
      }

      for (const verdict of treasuryView?.verdicts ?? []) {
        try {
          await applyVerdict(verdict, prices);
          condemned.add(verdict.agentId);
        } catch (error) {
          errors.push({ role: 'sim-reaper', agentId: verdict?.agentId, code: error?.code ?? 'ERROR', message: error?.message ?? String(error) });
        }
      }

      // prospector: refresh the dated-proof hypothesis batch periodically
      if (!treasuryView?.halted && (hypotheses.length === 0 || cycle - hypothesesAtCycle >= prospectRefreshCycles)) {
        try {
          const prospected = await prospector.run({ budgetUsd: treasuryView?.cycleBudgetUsd });
          hypotheses = prospected?.hypotheses ?? [];
          hypothesesAtCycle = cycle;
          dataCalls += prospected?.dataCalls ?? 0;
          dataSpendUsd = round4(dataSpendUsd + numberOrZero(prospected?.spentUsd));
        } catch (error) {
          errors.push({ role: 'prospector', code: error?.code ?? 'ERROR', message: error?.message ?? String(error) });
        }
      }

      // builder + executor per living agent, inside the Treasurer mandate
      const executing = aliveAgents.filter((agent) => !condemned.has(agent.id));
      const usedPairs = new Set();
      for (const agent of executing) {
        const mandate = treasuryView?.mandates?.[agent.id];
        if (!mandate) continue;
        if (treasuryView?.halted && !mandate.allowExitOnly) continue;
        const spec = await ensureSpec(agent, treasuryView?.cycleBudgetUsd, usedPairs);
        if (!spec) continue;
        try {
          const result = await executor.run({
            agent,
            spec,
            mandate,
            quotes,
            bars: barsBySymbol,
            dayStats: dayStats[agent.id],
            now: clock.now(),
          });
          trading.executions += 1;
          trading.orders += result?.orders?.length ?? 0;
          for (const action of result?.actions ?? []) {
            if (action.type === 'entry') trading.entries += 1;
            else if (action.type === 'exit') trading.exits += 1;
            else if (action.type === 'skip') {
              const reason = String(action.reason ?? 'unknown');
              trading.skipReasons[reason] = (trading.skipReasons[reason] ?? 0) + 1;
            } else if (action.type === 'hold' && action.reason !== 'in_position' && action.reason !== 'within_bounds') {
              trading.skipReasons[action.reason] = (trading.skipReasons[action.reason] ?? 0) + 1;
            }
          }
          for (const denial of result?.denied ?? []) {
            const code = String(denial.code ?? 'BRAKE_DENIED');
            trading.denied[code] = (trading.denied[code] ?? 0) + 1;
          }
          const entry = dayStatsByAgent[agent.id];
          if (entry) entry.ordersCount += result?.orders?.length ?? 0;
        } catch (error) {
          errors.push({ role: 'executor', agentId: agent.id, code: error?.code ?? 'ERROR', message: error?.message ?? String(error) });
        }
      }

      // replication: only if the Treasurer's gate says yes
      if (treasuryView?.mayReplicate && !treasuryView?.halted && replicationCount < cycleCount) {
        try {
          const candidates = executing
            .filter((agent) => (agent.generation ?? 0) >= 0)
            .sort((a, b) => equityOf(ledgerRole, b.id, prices) - equityOf(ledgerRole, a.id, prices));
          if (candidates.length > 0) {
            const spawned = await replicator.spawn(candidates[0].id, treasuryView);
            const child = spawned?.child ?? null;
            if (child?.id) {
              genomes.set(child.id, child.genome ?? spawned?.genome ?? {});
              replicationCount += 1;
              knownTotal += 1;
            }
          }
        } catch (error) {
          const code = error?.code ?? 'ERROR';
          if (!['REPLICATION_DENIED', 'POPULATION_CAP'].includes(code)) {
            errors.push({ role: 'replicator', code, message: error?.message ?? String(error) });
          }
        }
      }

      // equity series snapshot
      const aliveAfter = executing;
      let aliveEquity = 0;
      for (const agent of aliveAfter) aliveEquity += equityOf(ledgerRole, agent.id, prices);
      const accountEquity = numberOrZero(treasuryView?.account?.equityUsd) || aliveEquity;
      equitySeries.push({
        cycle,
        at,
        treasuryState: treasuryView?.state ?? null,
        totalEquityUsd: round2(accountEquity),
        aliveEquityUsd: round2(aliveEquity),
        alive: aliveAfter.length,
        dead: knownTotal - aliveAfter.length,
      });

      if (aliveAfter.length === 0) break; // extinction
    }

    // =========================================================================
    // survival dataset
    // =========================================================================
    const allAgents = registry.all();
    const alive = registry.alive();
    const dead = registry.dead();
    const lifespanHours = deaths.map((obituary) => numberOrZero(obituary.lifespanHours));
    const firstProfits = deaths.filter((obituary) => Boolean(obituary.firstProfitAt)).length;
    const lastPrices = {};
    try {
      for (const symbol of config.symbols) {
        const quote = await broker.getLatestQuote(symbol);
        lastPrices[symbol] = round4(numberOrZero(quote?.last));
      }
    } catch {
      /* final marks are best-effort */
    }
    const bestGenomes = alive
      .map((agent) => ({
        agentId: agent.id,
        generation: Number(agent.generation) || 0,
        equityUsd: round2(equityOf(ledgerRole, agent.id, lastPrices)),
        netPlUsd: round2(equityOf(ledgerRole, agent.id, lastPrices) - numberOrZero(agent.endowmentUsd)),
        genome: genomes.get(agent.id) ?? agent.genome ?? {},
        specId: specs.get(agent.id)?.specId ?? agent.specId ?? null,
      }))
      .sort((a, b) => b.equityUsd - a.equityUsd)
      .slice(0, 5);

    let generations = {};
    try {
      generations = registry.generationStats ? registry.generationStats() : {};
    } catch (error) {
      errors.push({ role: 'registry', code: error?.code ?? 'ERROR', message: error?.message ?? String(error) });
    }
    // Persist the final registry so journal.stats() can report `alive` accurately.
    try {
      await registry.save();
    } catch {
      /* best-effort: the dataset above already carries the survival counts */
    }
    let journalStats = null;
    try {
      journalStats = journal.stats ? await journal.stats() : null;
    } catch {
      journalStats = null;
    }

    const durationMs = round2(performance.now() - startedAt);
    const sampleObituaries = deaths.slice(-5);

    return {
      at: new Date(clock.now()).toISOString(),
      mode: 'sim',
      seed: resolvedSeed,
      cyclesRequested: cycleCount,
      cyclesRun: equitySeries.length,
      durationMs,
      total: allAgents.length,
      survived: alive.length,
      died: dead.length,
      causes: { ...causes },
      generations,
      medianLifespanHours: round2(median(lifespanHours)),
      meanLifespanHours: round2(mean(lifespanHours)),
      firstProfitRate: deaths.length > 0 ? round4(firstProfits / deaths.length) : 0,
      journalStats,
      population: { initial: populationSize, final: allAgents.length, alive: alive.length, dead: dead.length, cap: config.population?.cap ?? null },
      equitySeries,
      sampleObituaries,
      obituaries: sampleObituaries,
      bestGenomes,
      market: { symbols: config.symbols.length, seed: resolvedSeed, dataCalls, dataSpendUsd },
      replicationCount,
      trading,
      errors: errors.slice(0, 20),
      errorCount: errors.length,
    };
  } finally {
    if (shouldClean) {
      try {
        await fsp.rm(tempDir, { recursive: true, force: true });
      } catch {
        /* temp cleanup is best-effort */
      }
    }
  }
}

/**
 * Task-spec entry point: `run({ cycles, population, seed, configOverrides })`.
 * @param {{cycles?: number, population?: number, seed?: number, configOverrides?: object}} [opts]
 */
export async function run(opts = {}) {
  return runSimulation(opts);
}

/** Alias for engine.js discovery (`module.simulate`). */
export async function simulate(opts = {}) {
  return runSimulation(opts);
}

/** Small helper for tooling/tests: a short deterministic smoke run. */
export async function smoke({ cycles = 5, population = 3, seed = 7 } = {}) {
  return runSimulation({ cycles, population, seed });
}

export { safeJson };
export default runSimulation;
