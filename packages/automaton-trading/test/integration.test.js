/**
 * test/integration.test.js — INDEPENDENT end-to-end verification (verifier-owned).
 *
 * This suite deliberately does not reuse the builders' fixtures. It drives the real
 * composition (`createAutomaton`) against the deterministic SIM broker with a fixed,
 * advanceable clock in a throwaway state directory, then checks the system's claims:
 *
 *   - a genesis population is seeded and pays its own metabolism every cycle
 *   - the Treasurer issues mandates, computes runway/reconciliation, and writes death
 *     VERDICTS; in mode=sim only, the engine executes those verdicts in-process (demo),
 *     while in mode=paper the engine must never execute a death (the external Reaper owns it)
 *   - the Reaper's kill is durable: it persists registry/ledger so a fresh load cannot
 *     resurrect the agent, and the engine re-syncs from disk at the start of every cycle
 *   - the Executor really places orders through the brake wall with client_order_id
 *     attribution; the ledger keeps cash + positions = equity with no negative cash
 *   - replication opens only on the Treasurer gate, mutates exactly one genome field,
 *     keeps generation numbering correct (genesis = 0) and hands the child journal lessons
 *   - the operator kill switch blocks a whole cycle, and the engine facade
 *     (status/probe/obituaries/brakesView/configView) never trades, auto-starts or leaks
 *
 * Behaviour learned during this verification is encoded as assertions. Defects that were
 * found and fixed are re-verified here (they must stay fixed); the one residual gap
 * (a daily_loss_limit verdict is not executable by the Reaper, which only re-derives
 * equity-based causes) is encoded as a `todo` test and documented in docs/VERIFICATION.md.
 *
 * Run (the sandbox blocks `node --test <file>`, so run the file directly):
 *   cd packages/automaton-trading
 *   node test/integration.test.js
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, statePaths } from '../src/config.js';
import { createBroker as createSimBroker } from '../src/broker-sim.js';
import { createAutomaton, genesisGenome } from '../src/orchestrator.js';
import { createReaper } from '../src/reaper.js';
import { createEngine } from '../src/engine.js';
import { createJournal } from '../src/journal.js';
import { createLedger } from '../src/ledger.js';
import { createRegistry } from '../src/registry.js';
import { OBITUARY_FIELDS, validateObituary } from '../src/journal.js';
import { burnPerHour } from '../src/treasurer.js';
import { MUTABLE_FIELDS } from '../src/replicator.js';
import { createClock, round2 } from '../src/util.js';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T0 = Date.UTC(2026, 0, 5, 15, 0, 0); // Mon 10:00 America/New_York (inside 09:35-15:50)
const CYCLE_MS = 5 * 60 * 1000;
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

/** Fresh sim state dir + validated layered config (small population, cap 4). */
function makeEnv(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-integration-'));
  createdDirs.push(dir);
  const { config } = loadConfig({
    cwd: dir,
    env: {},
    configFile: path.join(dir, 'no-such-config.json'),
    overrides: {
      mode: 'sim',
      paths: { stateDir: path.join(dir, 'state'), envFile: path.join(dir, '.env') },
      population: { initial: 3, cap: 4 },
      endowmentUsd: 5000,
      ...overrides,
    },
  });
  return { dir, config, paths: statePaths(config) };
}

/** Deterministic advanceable clock: no wall-clock reads in domain logic under test. */
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

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonlLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function assertNoSecrets(value, secrets, where) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `${where} leaked credential material (${secret.slice(0, 4)}…)`);
  }
}

function expectedBurnPerCycle(config) {
  const cycleHours = Number(config.cycleIntervalSec) / 3600;
  return (
    Number(config.burn.inferencePerCycleUsd) +
    Number(config.burn.dataPerCycleUsd) +
    Number(config.burn.hostingPerHourUsd) * cycleHours +
    (Number(config.burn.committedMonthlyUsd) / 730) * cycleHours
  );
}

// ===========================================================================
// Main end-to-end world — mode=sim: engine executes sim verdicts in-process
// ===========================================================================

describe('end-to-end (mode=sim): population, metabolism, orders, demo death, persistence, replication', () => {
  const world = {};

  before(async () => {
    const env = makeEnv();
    world.env = env;
    world.config = env.config;
    world.paths = env.paths;
    world.clock = makeClock(T0);
    world.broker = createSimBroker(env.config, {
      seed: 6, // chosen deterministically: the sim population trades within a few cycles
      accountEquityUsd: 100000,
      clock: world.clock,
    });
    world.automaton = await createAutomaton({
      config: env.config,
      paths: env.paths,
      broker: world.broker,
      clock: world.clock,
    });
    await world.automaton.init();
    world.internals = world.automaton._internals;
    world.registry = world.internals.registry;
    world.ledger = world.internals.ledger;
    world.journal = world.internals.journal;

    // Snapshot the genesis population BEFORE anything mutates it.
    world.genesis = {
      population: world.registry.population(),
      cap: world.registry.cap,
      agents: world.registry.alive().map((agent) => ({
        id: agent.id,
        generation: agent.generation,
        status: agent.status,
        endowmentUsd: agent.endowmentUsd,
        genome: { ...agent.genome },
        parentId: agent.parentId,
      })),
      cashById: Object.fromEntries(
        world.registry.alive().map((agent) => [agent.id, world.ledger.snapshot(agent.id).cashUsd]),
      ),
      accountEquityUsd: world.broker.getAccount().equityUsd,
    };
    world.initStatus = await world.automaton.status();

    // Deliberately under-fund one agent: the Treasurer must write a verdict this cycle.
    world.victim = world.registry.alive()[0];
    const victimCash = world.ledger.snapshot(world.victim.id).cashUsd;
    world.ledger.charge(world.victim.id, victimCash, {
      category: 'inference',
      role: 'executor',
      at: world.clock.now(),
    });
    world.ledger.save();
    world.clock.advance(CYCLE_MS);
    world.verdictTick = await world.automaton.tick();
    world.deathsFileAfterVerdict = readJsonFile(world.paths.deaths);
    world.obituary = world.journal.list({ limit: 1 })[0] ?? null;

    // Several more full cycles with the remaining population.
    world.ticks = [world.verdictTick];
    for (let cycle = 0; cycle < 8; cycle += 1) {
      world.clock.advance(CYCLE_MS);
      world.ticks.push(await world.automaton.tick());
    }
    world.successfulTicks = world.ticks.length; // = 9
    world.statusAfterTicks = await world.automaton.status();
    world.lastTreasury = world.internals.treasurer.lastTick;
    world.lastPrices = world.internals.state.lastPrices;
    world.ordersAfterTicks = world.broker.getOrders({ status: 'all', limit: 500 });
    world.totalOrders = world.ticks.reduce(
      (total, trace) => total + trace.executions.reduce((n, execution) => n + execution.orders, 0),
      0,
    );
    world.roleCostsAfterTicks = Object.fromEntries(
      world.registry.alive().map((agent) => [agent.id, world.ledger.roleCosts(agent.id)]),
    );
    world.costsPerAgent = Object.fromEntries(
      world.registry.alive().map((agent) => [agent.id, world.ledger.snapshot(agent.id).costsUsd]),
    );
  });

  it('seeds the genesis population from config: 3 alive, generation 0, distinct deterministic strategies, funded', () => {
    const { genesis, config } = world;
    assert.equal(genesis.population, 3, 'population.initial agents must be seeded');
    assert.equal(genesis.cap, 4, 'registry cap comes from config.population.cap');
    assert.equal(genesis.agents.length, 3);
    const symbols = genesis.agents.map((agent) => agent.genome.symbol);
    const families = genesis.agents.map((agent) => agent.genome.family);
    // symbols rotate per index; families advance one step per symbols.length agents, so a
    // population of symbols x families gets a unique (symbol, family) strategy per agent.
    assert.deepEqual(symbols, [config.symbols[0], config.symbols[1], config.symbols[2]]);
    const familyOrder = ['momentum', 'meanrev', 'breakout', 'gapfade'];
    const expectedFamilies = symbols.map((_, index) => familyOrder[Math.floor(index / config.symbols.length) % familyOrder.length]);
    assert.deepEqual(families, expectedFamilies);
    // deterministic AND distinct: same config+index always yields the same genome, and a
    // full population of symbols x families has no duplicate strategy
    const populationSize = Math.min(30, config.symbols.length * familyOrder.length);
    const genomes = Array.from({ length: populationSize }, (_, index) => genesisGenome(config, index));
    assert.deepEqual(genesisGenome(config, 0), genomes[0], 'genesis genomes must be deterministic');
    const pairs = new Set(genomes.map((genome) => `${genome.symbol}:${genome.family}`));
    assert.equal(pairs.size, populationSize, 'every genesis agent must have its own strategy');
    for (const genome of genomes) {
      assert.ok(genome.entryZ >= 0.8 && genome.entryZ <= 2.2, `entryZ out of bounds: ${genome.entryZ}`);
      assert.ok(genome.sizePct >= 0.12 && genome.sizePct <= 0.35, `sizePct out of bounds: ${genome.sizePct}`);
      assert.ok(['any', 'morning', 'afternoon'].includes(genome.sessionFilter));
    }
    for (const agent of genesis.agents) {
      assert.equal(agent.generation, 0, 'genesis is generation 0, not 1');
      assert.equal(agent.status, 'alive');
      assert.equal(agent.parentId, null);
      assert.equal(agent.endowmentUsd, config.endowmentUsd);
      assert.equal(genesis.cashById[agent.id], config.endowmentUsd, 'genesis cash must be granted, not just declared');
      assert.match(agent.id, /^atm-[0-9a-f]{8}$/);
    }
    assert.equal(genesis.accountEquityUsd, 100000);
    assert.equal(world.initStatus.population.alive, 3);
    assert.equal(world.initStatus.population.dead, 0);
    assert.ok(
      genesis.population * config.endowmentUsd <= genesis.accountEquityUsd * config.account.allocationCapPct,
      'genesis endowment must fit inside allocationCapPct of broker equity',
    );
  });

  it('charges metabolism every cycle, attributes it by role, and the deducted burn matches the formula', () => {
    const { roleCostsAfterTicks, costsPerAgent, registry, ledger, config } = world;
    const cycles = world.successfulTicks;
    const configuredPerCycle = expectedBurnPerCycle(config);
    assert.ok(registry.alive().length >= 1, 'at least one agent should survive to measure costs');
    for (const agent of registry.alive()) {
      const roles = roleCostsAfterTicks[agent.id];
      const total = Object.values(roles).reduce((sum, value) => sum + Number(value || 0), 0);
      assert.ok(total > 0, `agent ${agent.id} paid nothing: ${JSON.stringify(roles)}`);
      assert.equal(roles.prospector > 0, true, 'the Prospector must pay for its own data/inference');
      assert.equal(roles.builder > 0, true, 'the Builder must pay for its own inference');
      assert.equal(roles.executor > 0, true, 'the Executor must pay for its own inference');
      assert.ok(Number.isFinite(Number(roles.treasurer)), 'treasurer cost line must be present');
      assert.ok(
        Math.abs(total - costsPerAgent[agent.id]) < 1e-6,
        `roleCosts ${total} must sum to the ledger costsUsd ${costsPerAgent[agent.id]}`,
      );
      // The deducted per-cycle burn must match the configured formula (regression: it used
      // to be rounded up to ~0.04/cycle and hosting used to round to zero).
      const measuredPerCycle = costsPerAgent[agent.id] / cycles;
      assert.ok(
        Math.abs(measuredPerCycle - configuredPerCycle) < 1e-6,
        `agent ${agent.id}: measured ${measuredPerCycle}/cycle vs configured ${configuredPerCycle}/cycle`,
      );
      // Equity decomposition: equity - endowment = realized + unrealized - costs.
      const equity = ledger.equity(agent.id, world.lastPrices);
      const snapshot = ledger.snapshot(agent.id);
      const expectedDelta = snapshot.realizedPlUsd + snapshot.unrealizedPlUsd - snapshot.costsUsd;
      assert.ok(
        Math.abs(round2(equity.equityUsd - config.endowmentUsd) - round2(expectedDelta)) <= 0.05,
        `metabolism accounting mismatch for ${agent.id}: delta ${round2(equity.equityUsd - config.endowmentUsd)} vs P&L ${round2(expectedDelta)}`,
      );
    }
  });

  it('Treasurer prices the population: mandates, runway, reconciliation, cycle budget, no halt', () => {
    const tick = world.lastTreasury;
    const { registry, config } = world;
    assert.ok(tick, 'treasurer.tick() result must be available after cycles');
    assert.equal(tick.mode, 'sim');
    assert.equal(tick.halted, false);
    assert.deepEqual(tick.haltReasons, []);
    assert.equal(tick.state, 'STABLE');
    assert.equal(tick.cycleBudgetUsd, config.cycleBudget.STABLE);
    assert.equal(tick.account.status, 'ACTIVE');
    assert.equal(tick.reconciliation.ok, true, JSON.stringify(tick.reconciliation));
    assert.equal(
      tick.reconciliation.toleranceUsd,
      round2(config.account.reconciliationTolerancePct * tick.account.equityUsd),
    );
    assert.equal(tick.agentViews.length, registry.alive().length);
    assert.equal(tick.burnPerHourUsd, burnPerHour(config, registry.alive().length));
    const aliveIds = registry.alive().map((agent) => agent.id).sort();
    assert.deepEqual(Object.keys(tick.mandates).sort(), aliveIds, 'one mandate per living agent');
    for (const agentId of aliveIds) {
      const mandate = tick.mandates[agentId];
      assert.equal(mandate.agentId, agentId);
      assert.ok(Date.parse(mandate.expiresAt) > Date.parse(mandate.issuedAt), 'mandate must expire after issue');
      assert.deepEqual(mandate.allowedSymbols, [...config.symbols]);
      assert.equal(mandate.allowExitOnly, false);
      assert.equal(mandate.sizeBudgetUsd, mandate.maxOrderNotionalUsd);
      assert.ok(mandate.sizeBudgetUsd > 0);
      assert.ok(Number.isFinite(mandate.maxDailyOrdersRemaining));
    }
    for (const view of tick.agentViews) {
      assert.ok(view.runwayHours > 0 && Number.isFinite(view.runwayHours), 'runway must be computed, not balance');
      assert.notEqual(view.state, 'DEAD', 'living agents must not be marked DEAD');
      assert.equal(round2(view.cashUsd + view.positionsValueUsd), view.equityUsd);
      assert.ok(view.roleCosts && typeof view.roleCosts === 'object');
    }
    assert.equal(tick.mayReplicate, false);
    assert.ok(tick.surplus7dUsd < config.replication.surplus7dUsd);
  });

  it('records executions and really places orders through the brake wall with attributable ids', () => {
    const { ticks, totalOrders, ordersAfterTicks, broker, registry, config } = world;
    assert.ok(ticks.every((trace) => trace.halted === false), 'no cycle may be halted in the happy path');
    assert.ok(
      ticks.every((trace) => Array.isArray(trace.executions) && trace.executions.length >= 1),
      'every cycle must report per-agent execution results',
    );
    const actionCount = ticks
      .flatMap((trace) => trace.executions)
      .reduce((total, execution) => total + execution.actions, 0);
    assert.ok(actionCount > 0, 'executor must record actions (hold/entry/exit/skip)');
    assert.ok(totalOrders >= 1, `the sim population should place at least one order; traces reported ${totalOrders}`);
    assert.equal(ordersAfterTicks.length, totalOrders, 'broker order count must equal the orders the traces claim');
    const agentIds = new Set(registry.all().map((agent) => agent.id));
    for (const order of ordersAfterTicks) {
      assert.match(
        String(order.clientOrderId),
        /^atm:atm-[0-9a-f]{8}:spec-[0-9a-f]{8}:\d+$/,
        'client_order_id must attribute the fill to agent + spec',
      );
      const [, orderAgent] = String(order.clientOrderId).split(':');
      assert.equal(agentIds.has(orderAgent), true, `order attribution ${orderAgent} is not a registered agent`);
      assert.ok(['buy', 'sell'].includes(order.side));
      assert.equal(order.status, 'filled');
      assert.match(String(order.symbol), /^[A-Z.]{1,10}$/);
    }
    // Slippage/spread and marks move the account only slightly in this tiny sample.
    const accountDrift = Math.abs(broker.getAccount().equityUsd - 100000);
    assert.ok(accountDrift < 1000, `sim broker account drifted unexpectedly: ${accountDrift}`);
    // the built specs were persisted and are the same ids the orders reference
    const specIds = new Set(ticks.flatMap((trace) => trace.builds.map((build) => build.specId)).filter(Boolean));
    assert.ok(specIds.size >= 1, 'at least one StrategySpec must be compiled');
    const specFiles = fs.readdirSync(world.paths.specsDir).filter((file) => file.endsWith('.json'));
    assert.ok(specFiles.length >= specIds.size, 'every built spec must be persisted to the specs dir');
    for (const order of ordersAfterTicks) {
      const specId = String(order.clientOrderId).split(':')[2];
      assert.match(specId, /^spec-[0-9a-f]{8}$/);
      assert.equal(fs.existsSync(path.join(world.paths.specsDir, `${specId}.json`)), true, `spec ${specId} must be on disk`);
    }
    for (const order of ordersAfterTicks) assert.ok(config.symbols.includes(order.symbol), `${order.symbol} outside universe`);
    for (const trace of ticks) {
      const fatal = trace.errors.filter((error) => error.code && error.code !== 'BRAKE_DENIED');
      assert.deepEqual(fatal, [], `unexpected cycle error: ${JSON.stringify(fatal)}`);
    }
  });

  it('writes a death verdict and executes it in-process ONLY because mode=sim, with a schema-valid generation-0 obituary', () => {
    const { verdictTick, victim, registry, journal, internals, config } = world;
    // 1) the Treasurer wrote the request (and the verdict file is durable)
    assert.equal(verdictTick.deaths.length, 1, 'the Treasurer must emit one death verdict for the underfunded agent');
    assert.equal(verdictTick.deaths[0].agentId, victim.id);
    assert.equal(verdictTick.deaths[0].cause, 'insufficient_funds');
    assert.equal(verdictTick.deaths[0].finalEquityUsd, 0);
    assert.equal(world.deathsFileAfterVerdict.verdicts.length, 1);
    assert.equal(world.deathsFileAfterVerdict.verdicts[0].agentId, victim.id);
    // 2) only the sim (demo) path executes the verdict inside the engine
    assert.ok(Array.isArray(verdictTick.deathsExecuted), 'sim mode must report in-process death execution');
    assert.equal(verdictTick.deathsExecuted.length, 1);
    assert.equal(verdictTick.deathsExecuted[0].agentId, victim.id);
    assert.equal(registry.get(victim.id).status, 'dead', 'sim mode executes the verdict in-process');
    assert.equal(registry.get(victim.id).cause, 'insufficient_funds');
    assert.equal(registry.population(), 2);
    assert.equal(internals.ledger.snapshot(victim.id).cashUsd, 0, 'residual cash must be swept to the treasury pool');
    assert.equal(internals.state.condemned.has(victim.id), false, 'a dead agent must not remain condemned');

    // 3) the obituary is schema-valid; generation 0 stayed 0 (regression: truthiness used to make it 1)
    const obituary = world.obituary;
    assert.ok(obituary, 'a death without an obituary is a bug');
    assert.equal(validateObituary(obituary), obituary, 'obituary must satisfy the documented schema');
    for (const field of OBITUARY_FIELDS) assert.ok(Object.hasOwn(obituary, field), `missing obituary field ${field}`);
    assert.equal(obituary.agentId, victim.id);
    assert.equal(obituary.cause, 'insufficient_funds');
    assert.equal(obituary.generation, 0, 'genesis generation 0 must survive into the dataset');
    assert.equal(obituary.endowmentUsd, config.endowmentUsd);
    assert.equal(obituary.finalEquityUsd, 0);
    assert.equal(obituary.netPlUsd, -config.endowmentUsd);
    assert.equal(obituary.firstProfitAt, null, 'firstProfitAt=null is the most valuable line in the journal');
    assert.equal(obituary.productsShipped, 0);
    assert.equal(obituary.tradesCount, 0);
    assert.equal(obituary.lessons.length, 0);
    assert.ok(Number.isFinite(Date.parse(obituary.bornAt)));
    assert.ok(Number.isFinite(Date.parse(obituary.diedAt)));
    assert.ok(obituary.lifespanHours >= 0);
    assert.equal(obituary.lastRunwayHours, 0);
    assert.ok(obituary.genome && typeof obituary.genome === 'object' && obituary.genome.symbol);
    assert.deepEqual(readJsonlLines(world.paths.journal).map((row) => row.agentId), [victim.id]);
    assert.equal(journal.stats().total, 1);
    assert.equal(journal.stats().mostCommonCause, 'insufficient_funds');
    assert.ok(journal.lessonsFor(obituary.genome, { limit: 5 }).length >= 1);
  });

  it('persists a trace and state.json every cycle plus the durable registry/ledger/journal', () => {
    const { paths, successfulTicks } = world;
    assert.equal(fs.existsSync(paths.traces), true);
    const traces = readJsonlLines(paths.traces);
    assert.equal(traces.length, successfulTicks, 'one trace line per completed cycle');
    for (const trace of traces) {
      assert.match(String(trace.tickId), /^tick-[0-9a-f]{8}$/);
      assert.ok(Number.isFinite(Date.parse(trace.at)));
      assert.equal(trace.mode, 'sim');
      assert.ok(trace.treasury && typeof trace.treasury.state === 'string');
      assert.ok(Array.isArray(trace.executions));
      assert.ok(Array.isArray(trace.builds));
    }
    const state = readJsonFile(paths.stateFile);
    assert.equal(state.mode, 'sim');
    assert.ok(Number.isFinite(Date.parse(state.at)));
    assert.equal(state.agents.length, 3, 'state.json must include dead agents in the graveyard');
    assert.equal(state.population.alive, 2);
    assert.equal(state.population.dead, 1);
    assert.equal(state.population.total, 3, 'population.total must count alive + dead');
    assert.equal(state.population.condemned, 0);
    assert.equal(state.engine.ticks, successfulTicks, 'the persisted snapshot must reflect the completed cycle');
    assert.equal(state.engine.running, false, 'a tick must not start the loop');
    assert.equal(world.statusAfterTicks.engine.initialized, true);
    const victimRow = state.agents.find((agent) => agent.id === world.victim.id);
    assert.equal(victimRow.status, 'dead', 'an executed agent must be reported dead, not condemned');
    // durable modules
    const registryFile = readJsonFile(paths.registry);
    assert.equal(Object.keys(registryFile.agents).length, 3);
    assert.equal(registryFile.agents[world.victim.id].status, 'dead');
    const ledgerFile = readJsonFile(paths.ledger);
    assert.equal(typeof ledgerFile.agents[world.victim.id].cashUsd, 'number');
    assert.equal(ledgerFile.agents[world.victim.id].cashUsd, 0);
    assert.equal(readJsonlLines(paths.journal).length, 1);
    const dayStats = readJsonFile(paths.dayStats);
    assert.equal(dayStats.dayKey, '2026-01-05');
    assert.ok(Object.keys(dayStats.agents).length >= 2);
    for (const entry of Object.values(dayStats.agents)) {
      assert.ok(Number.isFinite(entry.startEquityUsd), 'daily-loss rule needs a day-start equity');
    }
    const treasuryState = readJsonFile(paths.treasuryState);
    assert.equal(treasuryState.mode, 'sim');
    assert.equal(treasuryState.halted, false);
  });

  it('keeps ledger invariants: no negative cash, cash+positions=equity, broker agreement', () => {
    const { ledger, registry, broker, lastPrices, lastTreasury } = world;
    const allIds = ledger.ids().filter((agentId) => agentId !== '__treasury__');
    assert.ok(allIds.length >= 2);
    const brokerPositions = Object.fromEntries(
      broker.getPositions().map((position) => [position.symbol, position.qty]),
    );
    const ledgerPositions = {};
    for (const agentId of allIds) {
      const snapshot = ledger.snapshot(agentId);
      assert.ok(snapshot.cashUsd >= 0, `negative cash for ${agentId}: ${snapshot.cashUsd}`);
      const equity = ledger.equity(agentId, lastPrices);
      assert.equal(
        round2(equity.cashUsd + equity.positionsValueUsd),
        equity.equityUsd,
        `cash+positions != equity for ${agentId}`,
      );
      assert.ok(equity.equityUsd >= 0, `negative equity for ${agentId}`);
      for (const [symbol, position] of Object.entries(snapshot.positions)) {
        ledgerPositions[symbol] = round2((ledgerPositions[symbol] ?? 0) + Number(position.qty || 0));
      }
      if (registry.get(agentId)?.status === 'dead') assert.equal(snapshot.cashUsd, 0, 'the Reaper must sweep a dead estate');
    }
    for (const [symbol, qty] of Object.entries(brokerPositions)) {
      assert.equal(
        round2(qty),
        round2(ledgerPositions[symbol] ?? 0),
        `broker holds ${qty} ${symbol} but the agent ledgers sum to ${ledgerPositions[symbol] ?? 0}`,
      );
    }
    const pool = ledger.pool();
    const account = broker.getAccount();
    assert.ok(account.cashUsd >= 0, 'broker cash must never go negative');
    const delta = round2(account.equityUsd - pool.totalUsd);
    assert.equal(lastTreasury.reconciliation.ok, true);
    assert.ok(
      Math.abs(delta) <= lastTreasury.reconciliation.toleranceUsd,
      `virtual ${pool.totalUsd} vs broker ${account.equityUsd} delta ${delta} beyond tolerance`,
    );
    // the only expected drift is ledger-only cycle cost bookkeeping; it must stay small
    assert.ok(Math.abs(delta) <= 10, `unexpected bookkeeping drift of ${delta} USD`);
  });

  it('status surface is honest and the brake dry-run actually traverses the chain (D9 proof included)', async () => {
    const { automaton, broker, registry } = world;
    const status = world.statusAfterTicks;
    assert.equal(status.engine.running, false);
    assert.equal(status.engine.killSwitch, false);
    assert.equal(status.engine.liveArmed, false);
    assert.equal(status.engine.ticks, world.successfulTicks, 'status.engine.ticks must not lag the loop');
    assert.equal(status.mode, 'sim');
    assert.ok(Array.isArray(status.agents));
    assert.equal(status.obituaries.total, 1);
    assert.equal(status.population.total, status.population.alive + status.population.dead);
    assert.equal(status.population.condemned, 0, 'no condemned agent should be left behind');
    assert.equal(status.agents.find((agent) => agent.id === world.victim.id).status, 'dead');
    assert.equal(automaton.isRunning(), false);

    // Reads must not trade or mutate the population.
    const ordersBefore = broker.getOrders({ status: 'all', limit: 500 }).length;
    const populationBefore = registry.population();
    await automaton.status();
    await automaton.obituaries({ limit: 5 });
    automaton.brakesView();
    assert.equal(broker.getOrders({ status: 'all', limit: 500 }).length, ordersBefore);
    assert.equal(registry.population(), populationBefore);

    // A dry run on a real agent with a compiled spec must be able to ALLOW (regression:
    // it used to pass a {specId} stub and always deny NO_PROOF).
    const alive = registry.alive()[0];
    const decision = await automaton.preTradeCheck({
      agentId: alive.id,
      symbol: alive.genome.symbol,
      side: 'buy',
      notionalUsd: 100,
      priceUsd: world.lastPrices[alive.genome.symbol],
    });
    assert.equal(decision.decision, 'ALLOW', JSON.stringify(decision));
    assert.equal(decision.brakeId, null);
    // ...and it must still apply the whitelist brake truthfully.
    const bad = await automaton.preTradeCheck({ agentId: alive.id, symbol: 'ZZZZ', side: 'buy', notionalUsd: 100, priceUsd: 100 });
    assert.equal(bad.decision, 'DENY');
    assert.equal(bad.code, 'INSTRUMENT_FORBIDDEN');
    assert.equal(bad.brakeId, 'D4');
    assert.equal(broker.getOrders({ status: 'all', limit: 500 }).length, ordersBefore, 'dry runs must not place orders');
  });

  it('replication opens only when the Treasurer gate is funded: one mutation, gen+1, inherited lessons, no money creation', async () => {
    const { registry, ledger, journal, automaton, clock, config, internals } = world;
    assert.equal(journal.count(), 1, 'the journal must already contain a death for lessons to inherit');
    const parent = registry.alive()[0];
    const populationBefore = registry.population();
    const parentGenomeBefore = { ...parent.genome };
    const surplusBefore = ledger.snapshot(parent.id).net7dUsd;
    // Artificially fund the parent: realize +600 through the virtual book (the broker does
    // not know about this ledger-only trade; it stays inside the reconciliation tolerance).
    ledger.applyFill(parent.id, { symbol: 'SPY', side: 'buy', qty: 25, priceUsd: 100, at: clock.now() });
    ledger.applyFill(parent.id, { symbol: 'SPY', side: 'sell', qty: 25, priceUsd: 160, at: clock.now() });
    ledger.save();
    // The funding is ledger-only but already inside the virtual economy: capture the virtual
    // total AFTER it so "no money creation" measures the birth, not the injected profit.
    const totalBefore = ledger.pool().totalUsd;
    const funded = await internals.treasurer.tick({ prices: world.lastPrices, dayStats: {} });
    assert.equal(funded.mayReplicate, true, JSON.stringify(funded.replication));
    assert.equal(funded.halted, false);
    assert.ok(funded.surplus7dUsd > surplusBefore);
    assert.ok(funded.surplus7dUsd >= config.replication.surplus7dUsd);

    world.clock.advance(CYCLE_MS);
    const trace = await automaton.tick();
    world.replicationTick = trace;
    const replication = trace.replication;
    assert.ok(replication && replication.childId, `expected a child, got ${JSON.stringify(replication)}`);
    assert.equal(replication.parentId, parent.id);
    const child = registry.get(replication.childId);
    assert.ok(child, 'the spawned child must be registered');
    world.childId = child.id; // expose early so later tests can use the child even if a check below fails
    assert.equal(child.parentId, parent.id);
    assert.equal(child.status, 'alive');
    assert.equal(child.generation, parent.generation + 1, 'child generation must be parent + 1 (gen-0 parent -> gen-1)');
    assert.equal(registry.population(), populationBefore + 1);
    assert.ok(registry.population() <= registry.cap, 'replication must respect the population cap');

    // exactly ONE genome field mutates
    const changed = Object.keys({ ...parentGenomeBefore, ...child.genome }).filter(
      (field) => parentGenomeBefore[field] !== child.genome[field],
    );
    assert.equal(changed.length, 1, `expected exactly one mutation, changed: ${JSON.stringify(changed)}`);
    const field = changed[0];
    assert.equal(MUTABLE_FIELDS.includes(field), true, `${field} is not in the MUTABLE catalogue`);
    assert.deepEqual(child.mutation, { field, from: parentGenomeBefore[field], to: child.genome[field] });
    assert.deepEqual(replication.mutation, child.mutation);
    assert.notEqual(child.mutation.from, child.mutation.to, 'a mutation must actually change the value');

    // the child inherits the journal digest, not the parent's code
    assert.ok(replication.lessons >= 1, 'child must inherit lessons from the journal');
    assert.ok(Array.isArray(child.notes) && child.notes.length >= 1);
    assert.ok(child.notes.every((note) => typeof note === 'string' && note.length > 0));
    assert.ok(
      child.notes.some((note) => note.includes('insufficient_funds')),
      `child notes should carry the journal lesson; got ${JSON.stringify(child.notes)}`,
    );

    // child endowment is funded from the parent's cash only — no money is created
    assert.equal(child.endowmentUsd, config.replication.childEndowmentUsd);
    assert.equal(ledger.snapshot(child.id).cashUsd, config.replication.childEndowmentUsd);
    const totalAfter = ledger.pool().totalUsd;
    assert.ok(totalAfter <= totalBefore + 0.01, 'replication must not create money');
    assert.ok(totalBefore - totalAfter < 1, 'the only shrinkage may be this cycle\'s costs');
    assert.equal(fs.existsSync(world.paths.registry), true);
  });

  it('kill switch blocks the whole cycle and every order, and the Reaper still closes risk by design', async () => {
    const { automaton, internals, registry, ledger, journal, broker, paths, clock } = world;
    const target = registry.get(world.childId);
    assert.ok(target, 'the spawned child should still be alive');
    assert.deepEqual(ledger.book(target.id).positions, {}, 'fresh child must have no positions for a clean kill');
    fs.writeFileSync(paths.killSwitch, JSON.stringify({ armedAt: clock.iso(), reason: 'verifier test' }), 'utf8');
    assert.equal(internals.brakes.isKillSwitchActive(), true);
    const alive = registry.alive();
    const ordersBefore = broker.getOrders({ status: 'all', limit: 500 }).length;
    const cashBefore = alive.map((agent) => ledger.snapshot(agent.id).cashUsd);

    world.clock.advance(CYCLE_MS);
    const trace = await automaton.tick();
    assert.equal(trace.halted, true);
    assert.deepEqual(trace.haltReasons, ['KILL_SWITCH']);
    assert.equal(broker.getOrders({ status: 'all', limit: 500 }).length, ordersBefore, 'no order may reach the broker');
    assert.equal(trace.executions.length, 0, 'a killed cycle must not execute');
    assert.equal(trace.builds.length, 0, 'a killed cycle must not build');
    assert.deepEqual(alive.map((agent) => ledger.snapshot(agent.id).cashUsd), cashBefore, 'no metabolism may be charged');
    assert.throws(
      () => internals.brakes.assertKillSwitchClear(),
      (error) => error.code === 'KILL_SWITCH',
    );

    // The Reaper is not stopped by the kill switch: it keeps closing risk.
    const targetCash = ledger.snapshot(target.id).cashUsd;
    ledger.charge(target.id, targetCash, { category: 'inference', role: 'executor', at: clock.now() });
    ledger.save();
    const externalReaper = createReaper({
      broker,
      registry,
      ledger,
      journal,
      config: world.config,
      paths,
      clock,
    });
    const sweep = await externalReaper.sweep({});
    const targetKill = sweep.killed.find((entry) => entry.agentId === target.id);
    assert.ok(targetKill, `the Reaper must still liquidate the dead agent under the kill switch; got ${JSON.stringify(sweep.killed)}`);
    assert.equal(targetKill.cause, 'insufficient_funds');
    assert.equal(registry.get(target.id).status, 'dead');
    // FINDING: paying the child's endowment put the parent below its drawdown death
    // threshold (endowment * (1 - maxDrawdownPct)), so the independent Reaper also kills the
    // PARENT as drawdown_limit. The replication gate only checks 2 x deathFloor, not the
    // drawdown rule (see docs/VERIFICATION.md, residual findings).
    const parentId = world.replicationTick.replication.parentId;
    const parentKill = sweep.killed.find((entry) => entry.agentId === parentId);
    assert.equal(sweep.killed.length, parentKill ? 2 : 1, JSON.stringify(sweep.killed));
    if (parentKill) {
      assert.equal(parentKill.cause, 'drawdown_limit');
      assert.ok(parentKill.finalEquityUsd < world.config.endowmentUsd * (1 - world.config.maxDrawdownPct));
    }
    assert.equal(journal.count(), 1 + sweep.killed.length, 'one obituary per executed death, no duplicates');

    fs.rmSync(paths.killSwitch, { force: true });
    assert.equal(internals.brakes.isKillSwitchActive(), false);
    assert.doesNotThrow(() => internals.brakes.assertKillSwitchClear());
  });

  it('has no engine-side control surface over the Reaper, and in paper/live the engine never executes a death', () => {
    const { automaton } = world;
    // D12/editorial: the only in-engine death path is the sim demo branch; the Engine facade
    // that spawns the external Reaper exposes no stop/disable method.
    const orchestratorSource = fs.readFileSync(path.join(PKG_ROOT, 'src', 'orchestrator.js'), 'utf8');
    assert.match(
      orchestratorSource,
      /config\.mode === 'sim'[\s\S]{0,400}createReaper/,
      'the in-process Reaper may only exist behind the sim-mode guard',
    );
    assert.equal(/child_process/.test(orchestratorSource), false, 'the cycle loop must not spawn processes');
    // The separately-verified paper-mode world proves no in-engine death execution without sim.
    assert.equal(Object.hasOwn(automaton._internals, 'reaper'), false);
    for (const key of Object.keys(automaton)) {
      assert.equal(/reaper|killswitch|kill-switch/i.test(key), false, `engine exposes "${key}"`);
    }
    const brakesView = automaton.brakesView();
    assert.equal(brakesView.rules.length, 14);
    assert.deepEqual(brakesView.rules.map((rule) => rule.id), [
      'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'D14',
    ]);
  });
});

// ===========================================================================
// mode=paper: the engine writes a verdict; only the external Reaper executes it,
// durably, and the engine re-syncs from disk so it cannot keep trading a dead agent
// ===========================================================================

describe('death ownership (mode=paper): engine writes verdicts, external Reaper executes + persists', () => {
  const world = {};

  before(async () => {
    const env = makeEnv({ mode: 'paper' });
    world.env = env;
    world.config = env.config;
    world.paths = env.paths;
    world.clock = makeClock(T0);
    world.broker = createSimBroker(env.config, { seed: 6, accountEquityUsd: 100000, clock: world.clock });
    world.automaton = await createAutomaton({
      config: env.config,
      paths: env.paths,
      broker: world.broker,
      clock: world.clock,
    });
    await world.automaton.init();
    world.internals = world.automaton._internals;
    world.registry = world.internals.registry;
    world.ledger = world.internals.ledger;
    world.journal = world.internals.journal;

    // deliberately under-fund one agent
    world.victim = world.registry.alive()[0];
    world.ledger.charge(world.victim.id, world.ledger.snapshot(world.victim.id).cashUsd, {
      category: 'inference',
      role: 'executor',
      at: world.clock.now(),
    });
    world.ledger.save();
    world.clock.advance(CYCLE_MS);
    world.verdictTick = await world.automaton.tick();
    world.clock.advance(CYCLE_MS);
    world.secondTick = await world.automaton.tick();
  });

  it('the engine never executes the verdict in paper mode and does not trust a verdict file as death', () => {
    const { verdictTick, secondTick, registry, journal, automaton, paths } = world;
    assert.equal(verdictTick.deaths.length, 1);
    assert.equal(verdictTick.deaths[0].cause, 'insufficient_funds');
    assert.equal(Object.hasOwn(verdictTick, 'deathsExecuted'), false, 'paper/live must never execute deaths in-process');
    assert.equal(Object.hasOwn(secondTick, 'deathsExecuted'), false);
    assert.equal(registry.get(world.victim.id).status, 'alive', 'a verdict is a request, not an execution');
    assert.equal(automaton._internals.state.condemned.has(world.victim.id), true, 'the agent is condemned, not dead');
    assert.equal(journal.count(), 0, 'no obituary may be written by the engine');
    // The verdict is persisted as a request, and the engine stopped charging the condemned agent.
    const verdictFile = readJsonFile(paths.deaths);
    assert.equal(verdictFile.verdicts.length, 1);
    assert.equal(verdictFile.verdicts[0].agentId, world.victim.id);
  });

  it('an independent Reaper (fresh state instances, as the external process loads them) executes and persists the death', async () => {
    const { paths, config, broker, clock, victim } = world;
    // Fresh module instances = exactly what reaper-process.js does in its own OS process:
    // it loads state from disk and never shares the engine's memory.
    const reaperRegistry = createRegistry({ paths, config, clock });
    await reaperRegistry.load();
    const reaperLedger = createLedger({ paths, config, clock });
    await reaperLedger.load();
    const reaperJournal = createJournal({ paths, config });
    const reaper = createReaper({
      broker,
      registry: reaperRegistry,
      ledger: reaperLedger,
      journal: reaperJournal,
      config,
      paths,
      clock,
    });
    const swept = await reaper.sweep({ prices: world.internals.state.lastPrices });
    assert.equal(swept.killed.length, 1, JSON.stringify(swept.skipped));
    assert.equal(swept.killed[0].agentId, victim.id);
    assert.equal(swept.killed[0].cause, 'insufficient_funds');

    // Durability: the kill must be on disk, not only in the Reaper's memory (this was the
    // critical defect — the death used to resurrect on reload).
    const persistedRegistry = readJsonFile(paths.registry);
    assert.equal(persistedRegistry.agents[victim.id].status, 'dead');
    const persistedLedger = readJsonFile(paths.ledger);
    assert.equal(persistedLedger.agents[victim.id].cashUsd, 0);
    const reloaded = createRegistry({ paths, config, clock });
    await reloaded.load();
    assert.equal(reloaded.get(victim.id).status, 'dead', 'a fresh load must not resurrect the agent');
    const reloadedLedger = createLedger({ paths, config, clock });
    await reloadedLedger.load();
    assert.equal(reloadedLedger.snapshot(victim.id).cashUsd, 0);
    const obituary = reaperJournal.list()[0];
    assert.ok(obituary);
    assert.equal(validateObituary(obituary), obituary);
    assert.equal(obituary.generation, 0, 'genesis generation 0 must not be relabelled as 1');
    assert.equal(reaperJournal.count(), 1);

    // Idempotence: a second sweep must not duplicate the death.
    const second = await reaper.sweep({ prices: world.internals.state.lastPrices });
    assert.equal(second.killed.length, 0);
    assert.equal(reaperJournal.count(), 1);
    world.reaperJournal = reaperJournal;
  });

  it('the engine re-syncs from disk: killed agents are never charged/traded again and the death is not duplicated', async () => {
    const { automaton, registry, journal, ledger, broker, clock, config, paths } = world;
    world.clock.advance(CYCLE_MS);
    const trace = await automaton.tick();
    // The engine loaded registry/ledger from disk at the start of the cycle.
    assert.equal(registry.get(world.victim.id).status, 'dead');
    assert.equal(automaton._internals.state.condemned.has(world.victim.id), false, 'dead agents are pruned from the condemned set');
    assert.ok(!trace.executions.some((execution) => execution.agentId === world.victim.id), 'a dead agent must not be traded');
    assert.equal(journal.count(), 1, 'the engine must not duplicate the external obituary');
    const status = await automaton.status();
    assert.equal(status.population.alive, 2);
    assert.equal(status.population.dead, 1);
    assert.equal(status.population.total, 3);
    assert.equal(status.population.condemned, 0);
    assert.equal(status.agents.find((agent) => agent.id === world.victim.id).status, 'dead');
    // broker cash/positions remain consistent with the survivor ledgers
    const account = broker.getAccount();
    assert.ok(account.cashUsd >= 0);
    assert.ok(Number.isFinite(account.equityUsd));
    void ledger;
    void config;
    void paths;
  });
});

// ===========================================================================
// daily_loss_limit: the real day P&L now reaches the Treasurer (fixed)
// ===========================================================================

describe('daily_loss_limit death rule receives real day P&L (fixed), but the Reaper cannot execute it (residual gap)', () => {
  const world = {};

  before(async () => {
    const env = makeEnv({ population: { initial: 1, cap: 2 } });
    world.env = env;
    world.config = env.config;
    world.paths = env.paths;
    world.clock = makeClock(T0);
    world.broker = createSimBroker(env.config, { seed: 11, accountEquityUsd: 100000, clock: world.clock });
    world.automaton = await createAutomaton({
      config: env.config,
      paths: env.paths,
      broker: world.broker,
      clock: world.clock,
    });
    await world.automaton.init();
    world.internals = world.automaton._internals;
    world.agent = world.internals.registry.alive()[0];
    world.clock.advance(CYCLE_MS);
    await world.automaton.tick(); // records the day-start equity
    // Lose > maxDailyLossPct (5% of 5000 = 250) in one cycle, but stay above the drawdown
    // floor (25% = 1250) and the death floor (250), so only the daily-loss rule can fire.
    world.internals.ledger.charge(world.agent.id, 300, { category: 'inference', role: 'executor', at: world.clock.now() });
    world.internals.ledger.save();
    world.clock.advance(CYCLE_MS);
    world.trace = await world.automaton.tick();
  });

  it('fires the daily_loss_limit verdict from real P&L (not a hardcoded zero)', () => {
    const { trace, internals, agent, config } = world;
    assert.ok(trace.deaths.length >= 1, `expected a death verdict, got ${JSON.stringify(trace.deaths)}`);
    assert.equal(trace.deaths[0].agentId, agent.id);
    assert.equal(trace.deaths[0].cause, 'daily_loss_limit');
    assert.equal(internals.state.condemned.has(agent.id), true);
    assert.equal(internals.registry.get(agent.id).status, 'alive', 'the verdict is a request, not the execution');
    assert.equal(internals.journal.count(), 0);
    // the day P&L that produced it is the real equity change, not a constant
    assert.ok(config.risk.maxDailyLossPct * config.endowmentUsd >= 250);
  });

  it('daily_loss_limit is executable: the next sweep re-derives it from the persisted day record', async () => {
    const { internals, automaton, clock } = world;
    world.clock.advance(CYCLE_MS);
    const trace = await automaton.tick();
    assert.equal(internals.registry.get(world.agent.id).status, 'dead', 'the Reaper executes the verdict');
    const journal = createJournal({ paths: world.paths, config: world.config });
    const obituaries = await journal.list({ limit: 5 });
    assert.equal(obituaries.length, 1);
    assert.equal(obituaries[0].cause, 'daily_loss_limit');
    assert.ok(trace.deathsExecuted?.some((entry) => entry.agentId === world.agent.id && entry.cause === 'daily_loss_limit'));
  });
});

// ===========================================================================
// Engine facade (what the Harness plugin and the CLI talk to)
// ===========================================================================

describe('engine.js facade: read-only views, no secrets, never auto-starts trading', () => {
  const world = {};

  before(() => {
    const env = makeEnv();
    world.env = env;
    world.secretKeyId = 'PK-ENGINE-PROBE-KEY-9f3a2b';
    world.secretKey = 'ENGINE-PROBE-SECRET-9f3a2b';
    fs.writeFileSync(
      path.join(env.dir, '.env'),
      `ALPACA_API_KEY_ID=${world.secretKeyId}\nALPACA_API_SECRET_KEY=${world.secretKey}\n`,
      'utf8',
    );
    world.simPaths = statePaths(env.config);
    world.engine = createEngine({
      cwd: env.dir,
      configFile: path.join(env.dir, 'no-such-config.json'),
      envFile: path.join(env.dir, '.env'),
      overrides: {
        stateDir: path.join(env.dir, 'state'),
        mode: 'sim',
        seed: 6,
        accountEquityUsd: 100000,
      },
    });
    world.secrets = [world.secretKeyId, world.secretKey];
  });

  it('status/configView/brakesView/obituaries work without constructing the engine or starting trading', async () => {
    const { engine, secrets, simPaths } = world;
    const status = await engine.status();
    assert.equal(status.mode, 'sim');
    assert.equal(status.engine.running, false);
    assert.equal(engine.automaton, null, 'a read must not construct the trading automaton');
    assert.equal(engine.isRunning(), false);
    assert.equal(fs.existsSync(simPaths.stateFile), false, 'reading status must not write a trading snapshot');
    assertNoSecrets(status, secrets, 'engine.status()');

    const configView = engine.configView();
    assert.equal(configView.config.mode, 'sim');
    assert.equal(configView.config.allowLive, false);
    assert.equal(configView.summary.mode, 'sim');
    assert.ok(Array.isArray(configView.sources) && configView.sources.includes('defaults'));
    assert.equal(path.resolve(configView.stateDir), path.resolve(simPaths.stateDir));
    assertNoSecrets(configView, secrets, 'engine.configView()');

    const brakesView = await engine.brakesView();
    assert.equal(brakesView.rules.length, 14);
    assert.equal(brakesView.killSwitch, false);
    assert.equal(brakesView.liveArmed, false);
    assert.equal(brakesView.mode, 'sim');
    assertNoSecrets(brakesView, secrets, 'engine.brakesView()');

    const obituaries = await engine.obituaries({ limit: 5 });
    assert.equal(obituaries.stats.total, 0);
    assert.deepEqual(obituaries.items, []);
    assertNoSecrets(obituaries, secrets, 'engine.obituaries()');

    assert.equal(engine.automaton, null, 'read-only facade methods must never auto-start trading');
    assert.equal(engine.isRunning(), false);
  });

  it('exposes no way to stop, disable or re-arm the external Reaper (read-only status only)', () => {
    const { engine } = world;
    const reaperishKeys = Object.getOwnPropertyNames(engine).filter((key) => /reaper/i.test(key));
    assert.deepEqual(reaperishKeys, ['reaper'], 'the only Reaper surface is a read-only status getter');
    for (const method of [
      'stopReaper',
      'killReaper',
      'disableReaper',
      'terminateReaper',
      'pauseReaper',
      'reaperStop',
      'signalReaper',
      'restartReaper',
    ]) {
      assert.equal(typeof engine[method], 'undefined', `engine.${method} must not exist`);
    }
    const reaperStatus = engine.reaper;
    assert.ok(reaperStatus && typeof reaperStatus === 'object');
    for (const [key, value] of Object.entries(reaperStatus)) {
      assert.equal(typeof value !== 'function', true, `engine.reaper.${key} must not be callable`);
    }
  });

  it('probe checks the broker account/clock without starting the population or leaking secrets', async () => {
    const { engine } = world;
    const probe = await engine.probe();
    assert.equal(probe.mode, 'sim');
    assert.equal(probe.hasCredentials, true);
    assert.equal(probe.liveArmed, false);
    assert.equal(probe.error, null);
    assert.ok(probe.account, 'probe must read the broker account');
    assert.equal(probe.account.equityUsd, 100000);
    assert.equal(probe.account.status, 'ACTIVE');
    assert.ok(probe.clock && probe.clock.isOpen === true);
    assert.equal(engine.automaton, null, 'probe must not construct the trading automaton');
    assert.equal(engine.isRunning(), false);
    assertNoSecrets(probe, world.secrets, 'engine.probe()');
  });

  it('tick() initialises and runs one full cycle but leaves the loop stopped', async () => {
    const { engine, simPaths } = world;
    const result = await engine.tick();
    assert.match(String(result.trace.tickId), /^tick-[0-9a-f]{8}$/);
    assert.equal(result.trace.halted, false);
    assert.equal(result.status.population.alive, 3);
    assert.equal(result.status.engine.ticks, 1, 'status must reflect the completed tick immediately');
    assert.equal(fs.existsSync(simPaths.stateFile), true);
    assert.equal(engine.automaton === null, false);
    assert.equal(engine.isRunning(), false, 'tick must not start the recurring loop');
    assertNoSecrets(result, world.secrets, 'engine.tick()');
  });

  it('emergencyStop arms the kill switch, refuses the next cycle, and clear removes it', async () => {
    const { engine, simPaths } = world;
    const armed = await engine.emergencyStop();
    assert.equal(armed.killSwitch, true);
    assert.equal(fs.existsSync(simPaths.killSwitch), true);
    const view = await engine.brakesView();
    assert.equal(view.killSwitch, true);
    const refused = await engine.tick();
    assert.equal(refused.trace.halted, true);
    assert.deepEqual(refused.trace.haltReasons, ['KILL_SWITCH']);
    const cleared = await engine.clearEmergencyStop();
    assert.equal(cleared.killSwitch, false);
    assert.equal(fs.existsSync(simPaths.killSwitch), false);
    assert.equal(engine.isRunning(), false);
  });
});
