/**
 * Lead verification of the defects reported by the independent verifier.
 * Run: node scripts/verify-fixes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, statePaths } from '../packages/automaton-trading/src/config.js';
import { createBroker } from '../packages/automaton-trading/src/broker-sim.js';
import { createAutomaton } from '../packages/automaton-trading/src/orchestrator.js';
import { createRegistry } from '../packages/automaton-trading/src/registry.js';
import { createJournal } from '../packages/automaton-trading/src/journal.js';
import { createClock } from '../packages/automaton-trading/src/util.js';

const root = 'D:/CounterStikers';
const failures = [];
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else {
    console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
    failures.push(name);
  }
};

function freshDir(name) {
  const dir = path.resolve(root, `.tmp-verify-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

// ---------------------------------------------------------------------------
// 1. death executes, persists, survives reload, writes gen-0 obituary, status dead
// ---------------------------------------------------------------------------
{
  const stateDir = freshDir('death');
  const { config } = loadConfig({
    cwd: root,
    env: {},
    overrides: {
      mode: 'sim',
      paths: { stateDir, envFile: path.join(root, '.env') },
      population: { initial: 1, cap: 2 },
      endowmentUsd: 100,
      deathFloorUsd: 100, // everything dies on the first marked cycle
      deathFloorPct: 0,
      // the paper config's costs are tiny; keep this scenario's metabolism explicit
      burn: { inferencePerCycleUsd: 0.03, dataPerCycleUsd: 0.005, hostingPerHourUsd: 0.001, committedMonthlyUsd: 0 },
      replication: { surplus7dUsd: 2, minRunwayHours: 24, childEndowmentUsd: 40 },
      cycleIntervalSec: 300,
    },
  });
  const paths = statePaths(config);
  const clock = createClock();
  const broker = createBroker(config, { seed: 3, accountEquityUsd: 1000 });
  const automaton = await createAutomaton({ config, paths, broker, clock });
  await automaton.init();
  const trace = await automaton.tick();

  check('death: verdict produced', (trace.deaths ?? []).length === 1, JSON.stringify(trace.deaths));
  check('death: executed in-process (sim)', (trace.deathsExecuted ?? []).length === 1, JSON.stringify(trace.deathsExecuted));

  const onDisk = JSON.parse(fs.readFileSync(paths.registry, 'utf8'));
  const record = onDisk.agents?.[trace.deaths[0]?.agentId] ?? null;
  check('death: persisted to registry.json', record?.status === 'dead', JSON.stringify(record && { id: record.id, status: record.status }));

  const reloaded = createRegistry({ paths, config });
  await reloaded.load();
  const agentId = trace.deaths[0].agentId;
  check('death: survives a fresh load (no resurrection)', reloaded.get(agentId)?.status === 'dead');

  const journal = createJournal({ paths, config });
  const obituary = (await journal.list({ limit: 5 }))[0];
  check('death: obituary written with generation 0', obituary?.agentId === agentId && obituary?.generation === 0, JSON.stringify(obituary && { gen: obituary.generation, cause: obituary.cause }));

  const status = await automaton.status();
  check('status: ticks incremented in snapshot', status.engine?.ticks === 1, JSON.stringify(status.engine?.ticks));
  check('status: population total = alive + dead', status.population.total === status.population.alive + status.population.dead, JSON.stringify(status.population));
  const deadRow = status.agents.find((agent) => agent.id === agentId);
  check('status: dead agent reported dead (not condemned)', deadRow?.status === 'dead', deadRow?.status);
}

// ---------------------------------------------------------------------------
// 2. normal sim: dry-run brake traversal can ALLOW, costs match burn, dayStats pnl real
// ---------------------------------------------------------------------------
{
  const stateDir = freshDir('run');
  const { config } = loadConfig({
    cwd: root,
    env: {},
    overrides: {
      mode: 'sim',
      paths: { stateDir, envFile: path.join(root, '.env') },
      population: { initial: 2, cap: 8 },
      endowmentUsd: 5000,
      // Keep this scenario on repo-scale economics independent of automaton.config.json
      // (the paper account's scaled config lives there).
      replication: { surplus7dUsd: 150, minRunwayHours: 72, childEndowmentUsd: 2500 },
      cycleIntervalSec: 300,
    },
  });
  const paths = statePaths(config);
  const clock = createClock();
  const broker = createBroker(config, { seed: 11, accountEquityUsd: 100000 });
  const automaton = await createAutomaton({ config, paths, broker, clock });
  await automaton.init();
  for (let i = 0; i < 3; i += 1) await automaton.tick();
  const status = await automaton.status();
  const agent = status.agents.find((row) => row.status === 'alive');
  const internals = automaton._internals;
  const ledgerSnapshot = internals.ledger.snapshot(agent.id);
  const expectedCost = 3 * (config.burn.inferencePerCycleUsd + config.burn.dataPerCycleUsd + config.burn.hostingPerHourUsd * (config.cycleIntervalSec / 3600));
  check(
    'costs: role-attributed costs match the burn formula',
    Math.abs(ledgerSnapshot.costsUsd - expectedCost) < 0.002,
    `costs ${ledgerSnapshot.costsUsd} vs expected ${expectedCost}`,
  );

  const checkResult = await automaton.preTradeCheck({
    agentId: agent.id,
    symbol: agent.genome.symbol,
    side: 'buy',
    notionalUsd: 50,
  });
  check(
    'brakes: dry run traverses the real chain (not a forced NO_PROOF)',
    checkResult?.decision === 'ALLOW' || (checkResult?.decision === 'DENY' && checkResult.code !== 'NO_PROOF'),
    JSON.stringify(checkResult),
  );

  const dayStats = JSON.parse(fs.readFileSync(paths.dayStats, 'utf8'));
  const entry = Object.values(dayStats.agents ?? {})[0] ?? {};
  check(
    'dayStats: start equity + P&L persisted for the daily-loss rule',
    Number.isFinite(entry.startEquityUsd) && Number.isFinite(entry.pnlUsd),
    JSON.stringify(entry),
  );

  // replication generation: a gen-0 parent must produce a gen-1 child
  const parent = await internals.registry.register({
    id: internals.registry.nextId(),
    parentId: null,
    generation: 0,
    bornAt: clock.iso(),
    status: 'alive',
    endowmentUsd: 5000,
    genome: { ...agent.genome },
    mutation: null,
    specId: null,
    notes: ['verify-parent'],
  });
  await internals.ledger.ensureAgent(parent.id, { endowmentUsd: 5000, at: clock.now() });
  await internals.ledger.grant(parent.id, 8000, { reason: 'verify' });
  const gate = { mayReplicate: true, surplus7dUsd: 999, runwayHours: 999, populationCapRemaining: 2 };
  try {
    const spawned = await internals.replicator.spawn(parent.id, gate);
    const child = spawned?.child ?? spawned;
    check('replication: child of gen-0 parent is gen-1', child?.generation === 1, JSON.stringify({ generation: child?.generation, mutation: spawned?.mutation }));
    check('replication: exactly one mutation recorded', Boolean(spawned?.mutation?.field), JSON.stringify(spawned?.mutation));
  } catch (error) {
    check('replication: child of gen-0 parent is gen-1', false, `${error?.code}: ${error?.message}`);
  }

  // R2: a birth that would push the parent under the drawdown death rule is refused.
  const doomedParent = await internals.registry.register({
    id: internals.registry.nextId(),
    parentId: null,
    generation: 0,
    bornAt: clock.iso(),
    status: 'alive',
    endowmentUsd: 5000,
    genome: { ...agent.genome },
    mutation: null,
    specId: null,
    notes: ['verify-doomed-parent'],
  });
  await internals.ledger.ensureAgent(doomedParent.id, { endowmentUsd: 5000, at: clock.now() });
  await internals.ledger.grant(doomedParent.id, 5600, { reason: 'verify' });
  let denied = null;
  try {
    await internals.replicator.spawn(doomedParent.id, gate);
  } catch (error) {
    denied = error;
  }
  check(
    'replication: refuses a birth that would kill the parent (drawdown rule)',
    denied?.code === 'REPLICATION_DENIED',
    denied ? `${denied.code}: ${denied.message}` : 'birth was allowed',
  );
}

// ---------------------------------------------------------------------------
// 3. daily_loss_limit is re-derivable and executable by the Reaper
// ---------------------------------------------------------------------------
{
  const stateDir = freshDir('dailyloss');
  const { config } = loadConfig({
    cwd: root,
    env: {},
    overrides: {
      mode: 'sim',
      paths: { stateDir, envFile: path.join(root, '.env') },
      population: { initial: 1, cap: 2 },
      endowmentUsd: 5000,
      cycleIntervalSec: 300,
      // explicit metabolism: the shipped paper config is scaled for a 30 x $20 population
      burn: { inferencePerCycleUsd: 0.5, dataPerCycleUsd: 0, hostingPerHourUsd: 0, committedMonthlyUsd: 0 },
      risk: { maxDailyLossPct: 0.0001 }, // one cycle of burn is already fatal
    },
  });
  const paths = statePaths(config);
  const clock = createClock();
  const broker = createBroker(config, { seed: 5, accountEquityUsd: 10000 });
  const automaton = await createAutomaton({ config, paths, broker, clock });
  await automaton.init();
  const traces = [];
  for (let i = 0; i < 5; i += 1) traces.push(await automaton.tick());
  const killed = traces.flatMap((trace) => trace.deathsExecuted ?? []).find((entry) => entry.cause === 'daily_loss_limit');
  check('daily_loss_limit: executed by the Reaper from persisted day P&L', Boolean(killed), JSON.stringify(traces.map((trace) => trace.deathsExecuted ?? [])));
  const journal = createJournal({ paths, config });
  const obituary = (await journal.list({ limit: 3 })).find((entryItem) => entryItem.cause === 'daily_loss_limit');
  check('daily_loss_limit: obituary written with that cause', Boolean(obituary), JSON.stringify((await journal.list({ limit: 3 })).map((item) => item.cause)));
}

// ---------------------------------------------------------------------------
// 3. external Reaper refuses sim mode
// ---------------------------------------------------------------------------
{
  const stateDir = freshDir('reaper');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ mode: 'sim', symbols: ['SPY'], paths: { stateDir } }));
  // The sandbox forbids piped stdio for spawned grandchildren (EPERM): use stdio 'ignore'
  // and verify the refusal through the process's own JSONL log instead.
  const result = spawnSync(process.execPath, ['packages/automaton-trading/src/reaper-process.js', '--state-dir', stateDir, '--once'], {
    cwd: root,
    stdio: 'ignore',
    timeout: 30000,
  });
  const logFile = path.join(stateDir, 'reaper.log');
  const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check(
    'reaper-process: refuses to run against sim mode',
    result.status === 0 && logText.includes('"event":"refused"'),
    `${result.status} ${logText.slice(0, 300)}`,
  );
}

// Leave no state behind
for (const name of ['death', 'run', 'reaper', 'dailyloss']) {
  fs.rmSync(path.resolve(root, `.tmp-verify-${name}`), { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
