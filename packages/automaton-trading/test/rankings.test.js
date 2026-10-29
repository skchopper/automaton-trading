/**
 * test/rankings.test.js — rankings (leaderboards) + rewards (period payouts) modules.
 *
 * What is asserted (docs/CONTROL-PANEL.md § "Rankings module" / "Rewards module"):
 *   - period keys are UTC daily / ISO weekly / UTC monthly and are clock-driven
 *     (a fake clock in 1999 must not produce 2026 keys: no wall-clock/random reads);
 *   - a period's first observation is its baseline; a rollover carries the previous
 *     period's last equity forward (returns are measured from start of period);
 *   - leaderboards sort pnlPct desc, pnlUsd desc, name asc; ties break by name; missing
 *     baselines have null P&L and sort last; empty input -> empty arrays;
 *   - rankings persist atomically to stateDir/rankings.json and tolerate a corrupt file;
 *   - rewards anchor the initial partial period (no payout), then pay the completed
 *     period's top 3 = 5/3/2% of broker account CASH, once per period key;
 *   - payouts are proportionally scaled by the treasury pool / allocation-cap remaining /
 *     maxPerPeriodUsd, an all-zero payout is recorded as skipped (no transfer at all),
 *     winners without a measured P&L are skipped, and rewards move only virtual cash
 *     via ledger.transfer('__treasury__', agent, ...) so sum(equity)+pool is conserved;
 *   - history persists (last 50 entries) and survives a reload.
 *
 * Run directly (the sandbox blocks `node --test <file>`):
 *   cd packages/automaton-trading && node test/rankings.test.js
 *
 * Owner: market teammate.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, statePaths } from '../src/config.js';
import { createLedger, TREASURY_ID } from '../src/ledger.js';
import {
  createRankings,
  isoWeekKey,
  nextPeriodStartMs,
  periodKeyFor,
  periodKeys,
} from '../src/rankings.js';
import { createRewards, resolveRewardSettings, REWARD_DEFAULTS } from '../src/rewards.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Thursday 2026-10-29 12:00 UTC — ISO week 2026-W44, month 2026-10. */
const T1 = Date.parse('2026-10-29T12:00:00Z');
/** Friday 2026-10-30 00:05 UTC — the next daily boundary has just passed. */
const T2 = Date.parse('2026-10-30T00:05:00Z');
/** The daily boundary instant itself: the completed period ended here. */
const DAY_END = Date.parse('2026-10-30T00:00:00Z');

const tempDirs = [];

function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `automaton-${label}-`));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Controllable clock (no Date.now in domain logic under test). */
function makeClock(startMs = T1) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    iso: () => new Date(nowMs).toISOString(),
    advance: (byMs) => {
      nowMs += byMs;
      return nowMs;
    },
    set: (ms) => {
      nowMs = ms;
    },
    startMs,
  };
}

function makeConfig(dir, overrides = {}) {
  const { config } = loadConfig({
    configFile: path.join(dir, 'missing.config.json'),
    envFile: path.join(dir, 'missing.env'),
    overrides: {
      mode: 'sim',
      paths: { stateDir: dir },
      ...overrides,
    },
  });
  return config;
}

function agentsById(rows) {
  return Object.fromEntries(rows.map((row) => [row.agentId, row]));
}

function snapshotJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// ===========================================================================
// rankings
// ===========================================================================

describe('rankings: period keys, baselines, rollover, sorting, persistence', () => {
  const dir = makeTempDir('rankings');
  const clock = makeClock();
  const config = makeConfig(dir);
  const paths = statePaths(config);
  let rankings;

  it('computes UTC daily / ISO weekly / UTC monthly keys from the clock, not wall time', async () => {
    assert.deepEqual(periodKeys(T1), { daily: '2026-10-29', weekly: '2026-W44', monthly: '2026-10' });
    // Year-boundary correctness for the ISO week (Dec 29 2025 is Monday of 2026-W01).
    assert.equal(isoWeekKey(Date.parse('2025-12-29T00:00:00Z')), '2026-W01');
    assert.equal(isoWeekKey(Date.parse('2026-01-01T00:00:00Z')), '2026-W01');
    assert.deepEqual(periodKeys(Date.parse('2025-12-29T00:00:00Z')), {
      daily: '2025-12-29',
      weekly: '2026-W01',
      monthly: '2025-12',
    });
    assert.equal(periodKeyFor('daily', T1), '2026-10-29');
    assert.equal(periodKeyFor('weekly', T1), '2026-W44');
    assert.equal(periodKeyFor('monthly', T1), '2026-10');

    // next boundaries (used for rewards.nextRunAt)
    assert.equal(nextPeriodStartMs('daily', T1), Date.parse('2026-10-30T00:00:00Z'));
    assert.equal(nextPeriodStartMs('weekly', T1), Date.parse('2026-11-02T00:00:00Z'));
    assert.equal(nextPeriodStartMs('monthly', T1), Date.parse('2026-11-01T00:00:00Z'));

    // Clock-driven: a fake 1999 clock must produce 1999 keys, proving no Date.now().
    const oldDir = makeTempDir('rankings-1999');
    const oldClock = makeClock(Date.parse('1999-12-31T12:00:00Z'));
    const oldConfig = makeConfig(oldDir);
    const oldRankings = createRankings({ paths: statePaths(oldConfig), config: oldConfig, clock: oldClock });
    await oldRankings.load();
    await oldRankings.record({
      atMs: Date.parse('1999-12-31T12:00:00Z'),
      equityByAgent: { a: { name: 'Alpha', equityUsd: 100, trades: 0 } },
    });
    const oldState = oldRankings.getState();
    assert.equal(oldState.agents.a.baseline.daily.key, '1999-12-31');
    assert.equal(oldState.agents.a.baseline.weekly.key, '1999-W52');
    assert.equal(oldState.agents.a.baseline.monthly.key, '1999-12');
  });

  it('stores the first observation of a period as the baseline and ranks the latest equity', async () => {
    rankings = createRankings({ paths, config, clock });
    await rankings.load();

    await rankings.record({
      atMs: T1,
      equityByAgent: {
        a: { name: 'Alpha', equityUsd: 100, trades: 2 },
        b: { name: 'Beta', equityUsd: 200, trades: 5 },
        c: { name: 'Gamma', equityUsd: 50, trades: 0 },
      },
    });
    await rankings.record({
      atMs: T1 + HOUR,
      equityByAgent: {
        a: { name: 'Alpha', equityUsd: 110, trades: 3 },
        b: { name: 'Beta', equityUsd: 190, trades: 6 },
        c: { name: 'Gamma', equityUsd: 55, trades: 1 },
      },
    });

    const current = {
      a: { name: 'Alpha', equityUsd: 110, trades: 3 },
      b: { name: 'Beta', equityUsd: 190, trades: 6 },
      c: { name: 'Gamma', equityUsd: 55, trades: 1 },
    };
    const snapshot = rankings.compute({ atMs: T1 + 2 * HOUR, equityByAgent: current });
    assert.equal(snapshot.asOf, new Date(T1 + 2 * HOUR).toISOString());
    assert.deepEqual(snapshot.periodKeys, { daily: '2026-10-29', weekly: '2026-W44', monthly: '2026-10' });

    // daily: Alpha +10%/+$10, Gamma +10%/+$5 (tie on pct -> USD desc), Beta -5%/-$10
    assert.deepEqual(snapshot.periods.daily[0], {
      rank: 1,
      agentId: 'a',
      name: 'Alpha',
      equityUsd: 110,
      baselineEquityUsd: 100,
      pnlUsd: 10,
      pnlPct: 0.1,
      trades: 3,
    });
    assert.equal(snapshot.periods.daily[1].agentId, 'c');
    assert.equal(snapshot.periods.daily[1].rank, 2);
    assert.equal(snapshot.periods.daily[1].pnlPct, 0.1);
    assert.equal(snapshot.periods.daily[1].pnlUsd, 5);
    assert.equal(snapshot.periods.daily[2].agentId, 'b');
    assert.equal(snapshot.periods.daily[2].pnlPct, -0.05);
    assert.deepEqual(
      snapshot.periods.daily.map((row) => row.rank),
      [1, 2, 3],
    );
    // weekly/monthly baselines are the same first observation (same period as T1)
    assert.equal(snapshot.periods.weekly[0].baselineEquityUsd, 100);
    assert.equal(snapshot.periods.monthly[0].baselineEquityUsd, 100);

    // percent is rounded to 6 decimals (a 2dp USD move on a $3.00 baseline:
    // 3.01/3.00 - 1 = 0.003333...)
    await rankings.record({
      atMs: T1 + 3 * HOUR,
      equityByAgent: {
        a: { name: 'Alpha', equityUsd: 110, trades: 3 },
        e: { name: 'Epsilon', equityUsd: 3, trades: 0 },
      },
    });
    await rankings.record({
      atMs: T1 + 4 * HOUR,
      equityByAgent: { e: { name: 'Epsilon', equityUsd: 3.01, trades: 1 } },
    });
    const rounded = rankings.compute({
      atMs: T1 + 4 * HOUR,
      equityByAgent: { e: { name: 'Epsilon', equityUsd: 3.01, trades: 1 } },
    });
    assert.equal(rounded.periods.daily[0].pnlPct, 0.003333);
  });

  it('breaks exact ties by name (then agentId) deterministically', async () => {
    const tieDir = makeTempDir('rankings-ties');
    const tieConfig = makeConfig(tieDir);
    const tieRankings = createRankings({ paths: statePaths(tieConfig), config: tieConfig, clock: makeClock(T1) });
    await tieRankings.load();
    await tieRankings.record({
      atMs: T1,
      equityByAgent: {
        x: { name: 'Zed', equityUsd: 100, trades: 0 },
        y: { name: 'Amy', equityUsd: 100, trades: 0 },
      },
    });
    const equal = {
      x: { name: 'Zed', equityUsd: 110, trades: 0 },
      y: { name: 'Amy', equityUsd: 110, trades: 0 },
    };
    const snapshot = tieRankings.compute({ atMs: T1 + HOUR, equityByAgent: equal });
    assert.deepEqual(
      snapshot.periods.daily.map((row) => row.name),
      ['Amy', 'Zed'],
    );
    assert.deepEqual(
      snapshot.periods.daily.map((row) => row.rank),
      [1, 2],
    );
  });

  it('lists an agent without a current-period baseline last with null P&L; empty input is empty arrays', async () => {
    const current = {
      a: { name: 'Alpha', equityUsd: 120, trades: 2 },
      newcomer: { name: 'Newcomer', equityUsd: 500, trades: 0 },
    };
    const snapshot = rankings.compute({ atMs: T1 + 4 * HOUR, equityByAgent: current });
    const daily = agentsById(snapshot.periods.daily);
    assert.equal(daily.a.rank, 1);
    assert.equal(daily.newcomer.rank, 2);
    assert.equal(daily.newcomer.pnlPct, null);
    assert.equal(daily.newcomer.pnlUsd, null);
    assert.equal(daily.newcomer.baselineEquityUsd, null);
    assert.equal(daily.newcomer.equityUsd, 500);

    const empty = rankings.compute({ equityByAgent: {} });
    assert.deepEqual(empty.periods, { daily: [], weekly: [], monthly: [] });
    assert.deepEqual(rankings.compute().periods, { daily: [], weekly: [], monthly: [] });
  });

  it('rolls a new period baseline forward from the previous period last equity', async () => {
    const rollDir = makeTempDir('rankings-roll');
    const rollClock = makeClock(T1);
    const rollConfig = makeConfig(rollDir);
    const rollRankings = createRankings({ paths: statePaths(rollConfig), config: rollConfig, clock: rollClock });
    await rollRankings.load();

    // Day 1 (Thu 2026-10-29): baseline 100 -> last 110 for a.
    await rollRankings.record({
      atMs: T1,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 100, trades: 0 } },
    });
    await rollRankings.record({
      atMs: T1 + HOUR,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 110, trades: 1 } },
    });

    // Day 2 (Fri 2026-10-30): new daily baseline must be 110 (the prior period's last).
    rollClock.set(T2);
    await rollRankings.record({
      atMs: T2,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 121, trades: 2 } },
    });
    const day2 = rollRankings.compute({
      atMs: T2 + HOUR,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 121, trades: 2 } },
    });
    assert.equal(day2.periodKeys.daily, '2026-10-30');
    assert.equal(day2.periods.daily[0].baselineEquityUsd, 110);
    assert.equal(day2.periods.daily[0].pnlUsd, 11);
    assert.equal(day2.periods.daily[0].pnlPct, 0.1);

    // Friday is still the same ISO week / UTC month, so those baselines stay at 100.
    assert.equal(day2.periodKeys.weekly, '2026-W44');
    assert.equal(day2.periods.weekly[0].baselineEquityUsd, 100);
    assert.equal(day2.periods.weekly[0].equityUsd, 121);
    assert.equal(day2.periodKeys.monthly, '2026-10');
    assert.equal(day2.periods.monthly[0].baselineEquityUsd, 100);

    // Weekly/monthly rollover: advance to next Monday (2026-11-02) / next month.
    rollClock.set(Date.parse('2026-11-02T00:05:00Z'));
    await rollRankings.record({
      atMs: Date.parse('2026-11-02T00:05:00Z'),
      equityByAgent: { a: { name: 'Alpha', equityUsd: 133.1, trades: 3 } },
    });
    const nextWeek = rollRankings.compute({
      atMs: Date.parse('2026-11-02T00:05:00Z'),
      equityByAgent: { a: { name: 'Alpha', equityUsd: 133.1, trades: 3 } },
    });
    assert.equal(nextWeek.periodKeys.weekly, '2026-W45');
    assert.equal(nextWeek.periods.weekly[0].baselineEquityUsd, 121); // Friday's close carried over
    assert.equal(nextWeek.periodKeys.daily, '2026-11-02');
    assert.equal(nextWeek.periods.daily[0].baselineEquityUsd, 121); // Monday starts from Friday close
    assert.equal(nextWeek.periodKeys.monthly, '2026-11');
    assert.equal(nextWeek.periods.monthly[0].baselineEquityUsd, 121);
  });

  it('persists to stateDir/rankings.json, reloads, and tolerates a corrupt file', async () => {
    assert.ok(fs.existsSync(paths.rankings), 'record() must persist rankings.json');
    const raw = snapshotJson(JSON.parse(fs.readFileSync(paths.rankings, 'utf8')));
    assert.equal(raw.version, 1);
    assert.ok(raw.agents.a.baseline.daily.key);
    assert.ok(raw.agents.a.last.daily.equityUsd >= 0);

    // Reload in a fresh instance: baselines and rankings survive.
    const reloaded = createRankings({ paths, config, clock });
    await reloaded.load();
    const before = rankings.compute({
      atMs: T1 + 4 * HOUR,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 120, trades: 2 } },
    });
    const after = reloaded.compute({
      atMs: T1 + 4 * HOUR,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 120, trades: 2 } },
    });
    assert.deepEqual(after, before);

    // Corrupted state is not fatal: no history means null baselines, never a throw.
    const corruptDir = makeTempDir('rankings-corrupt');
    const corruptConfig = makeConfig(corruptDir);
    const corruptPaths = statePaths(corruptConfig);
    fs.mkdirSync(corruptPaths.stateDir, { recursive: true });
    fs.writeFileSync(corruptPaths.rankings, '{ this is not json', 'utf8');
    const corrupt = createRankings({ paths: corruptPaths, config: corruptConfig, clock });
    const loaded = await corrupt.load();
    assert.deepEqual(loaded.agents, {});
    const corruptSnapshot = corrupt.compute({
      atMs: T1,
      equityByAgent: { a: { name: 'Alpha', equityUsd: 100, trades: 0 } },
    });
    assert.equal(corruptSnapshot.periods.daily[0].pnlPct, null);
  });
});

// ===========================================================================
// rewards
// ===========================================================================

/**
 * Build a fully wired rewards scenario:
 *   - agents a/b/c/d each funded with $20 (ledger cash),
 *   - completed-day rankings from day 1: a +20%, b +10%, c -10%, d 0%,
 *   - treasury pool funded with `poolUsd`,
 *   - clock advanced just past the daily boundary (T2), rewards anchored on day 1.
 */
async function makeRewardsEnv({ rewardOverrides = {}, poolUsd = 1000, agentCashUsd = 20 } = {}) {
  const dir = makeTempDir('rewards');
  const clock = makeClock(T1);
  const overrides = { mode: 'sim', paths: { stateDir: dir } };
  if (rewardOverrides && Object.keys(rewardOverrides).length > 0) overrides.rewards = rewardOverrides;
  const config = makeConfig(dir, overrides);
  const paths = statePaths(config);
  const ledger = createLedger({ paths, config, clock });
  await ledger.load();
  const agents = {
    a: { id: 'atm-aaaa0001', name: 'Alpha' },
    b: { id: 'atm-bbbb0002', name: 'Beta' },
    c: { id: 'atm-cccc0003', name: 'Gamma' },
    d: { id: 'atm-dddd0004', name: 'Delta' },
  };
  for (const agent of Object.values(agents)) {
    ledger.ensureAgent(agent.id, { endowmentUsd: agentCashUsd, at: T1 });
    ledger.grant(agent.id, agentCashUsd, { reason: 'endowment', at: T1 });
  }
  if (poolUsd > 0) ledger.grant(TREASURY_ID, poolUsd, { reason: 'test-pool', at: T1 });

  // Completed-day leaderboard: first observation at noon, close at 23:00.
  const rankings = createRankings({ paths, config, clock });
  await rankings.load();
  await rankings.record({
    atMs: T1,
    equityByAgent: {
      [agents.a.id]: { name: 'Alpha', equityUsd: 100, trades: 1 },
      [agents.b.id]: { name: 'Beta', equityUsd: 100, trades: 1 },
      [agents.c.id]: { name: 'Gamma', equityUsd: 100, trades: 1 },
      [agents.d.id]: { name: 'Delta', equityUsd: 100, trades: 1 },
    },
  });
  await rankings.record({
    atMs: T1 + 11 * HOUR,
    equityByAgent: {
      [agents.a.id]: { name: 'Alpha', equityUsd: 120, trades: 4 },
      [agents.b.id]: { name: 'Beta', equityUsd: 110, trades: 3 },
      [agents.c.id]: { name: 'Gamma', equityUsd: 90, trades: 2 },
      [agents.d.id]: { name: 'Delta', equityUsd: 100, trades: 2 },
    },
  });

  const rewards = createRewards({ paths, config, clock });
  await rewards.load(); // anchors the initial partial period at day 1
  clock.set(T2); // the daily boundary has now passed
  // The completed-period leaderboard: rank the instant just before the boundary.
  const completed = rankings.compute({ atMs: DAY_END - 1, stored: true });
  return { dir, clock, config, paths, ledger, agents, rankings, rewards, completed };
}

function equityOfMatches(rows, agentIds) {
  const byId = agentsById(rows);
  return agentIds.map((agentId) => byId[agentId]);
}

describe('rewards: period-boundary payouts, caps, idempotency, persistence', () => {
  it('anchors the initial partial period and pays nothing before a boundary', async () => {
    const env = await makeRewardsEnv();
    const clockDay1 = makeClock(T1);
    const fresh = createRewards({ paths: env.paths, config: env.config, clock: clockDay1 });
    await fresh.load();
    assert.equal(fresh.duePeriod(T1 + HOUR), null, 'no payout inside the initial partial period');

    const status = env.rewards.status();
    assert.equal(status.enabled, true);
    assert.equal(status.period, 'daily');
    assert.deepEqual(status.rankPercents, [0.05, 0.03, 0.02]);
    assert.equal(status.basis, 'account-cash');
    assert.equal(status.historyCount, 0);
    assert.equal(status.lastPeriodKey, '2026-10-29');
    assert.equal(status.nextRunAt, new Date(Date.parse('2026-10-30T00:00:00Z')).toISOString());
    // Once the boundary passes the scheduler *reports* the completed period as due; it
    // still pays nothing until apply() is called, and the initial anchor never shifts.
    const dueAfterBoundary = fresh.duePeriod(T2);
    assert.ok(dueAfterBoundary);
    assert.equal(dueAfterBoundary.periodKey, '2026-10-29');
    assert.equal(fresh.status().historyCount, 0);

    // and nothing moved in the ledger
    assert.equal(env.ledger.pool().poolUsd, 1000);
  });

  it('pays 5/3/2% of broker account cash to the top 3 exactly once per period key', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const due = env.rewards.duePeriod(T2);
    assert.ok(due, 'a completed daily period must be due');
    assert.deepEqual(due, {
      period: 'daily',
      periodKey: '2026-10-29',
      completed: true,
      currentPeriodKey: '2026-10-30',
    });

    // account cash $2000 -> 1st 5% = $100, 2nd 3% = $60, 3rd 2% = $40
    const cashBefore = Object.fromEntries(
      Object.values(env.agents).map((agent) => [agent.id, env.ledger.snapshot(agent.id).cashUsd]),
    );
    const result = await env.rewards.apply({
      due,
      rankings: env.completed,
      accountCashUsd: 2000,
      poolUsd: env.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 500,
      ledger: env.ledger,
      nowMs: T2,
    });

    assert.equal(result.applied, true);
    assert.equal(result.skipped, false);
    assert.equal(result.period, 'daily');
    assert.equal(result.periodKey, '2026-10-29');
    assert.equal(result.winners.length, 3);
    // Alpha +20% -> rank 1, Beta +10% -> rank 2, Delta 0% -> rank 3 (Gamma -10% is 4th)
    assert.deepEqual(
      result.winners.map(({ rank, agentId, percent, amountUsd }) => ({ rank, agentId, percent, amountUsd })),
      [
        { rank: 1, agentId: env.agents.a.id, percent: 0.05, amountUsd: 100 },
        { rank: 2, agentId: env.agents.b.id, percent: 0.03, amountUsd: 60 },
        { rank: 3, agentId: env.agents.d.id, percent: 0.02, amountUsd: 40 },
      ],
    );
    assert.equal(result.winners[0].name, 'Alpha');

    // exactly $200 moved from the pool to the three agents (virtual cash only)
    assert.equal(env.ledger.pool().poolUsd, 800);
    assert.equal(env.ledger.snapshot(env.agents.a.id).cashUsd, cashBefore[env.agents.a.id] + 100);
    assert.equal(env.ledger.snapshot(env.agents.b.id).cashUsd, cashBefore[env.agents.b.id] + 60);
    assert.equal(env.ledger.snapshot(env.agents.d.id).cashUsd, cashBefore[env.agents.d.id] + 40);
    assert.equal(env.ledger.snapshot(env.agents.c.id).cashUsd, cashBefore[env.agents.c.id], '4th place is not paid');
    assert.equal(env.ledger.snapshot(TREASURY_ID).cashUsd, 800);

    // no double payment: same key is never paid twice
    assert.equal(env.rewards.duePeriod(T2), null, 'the anchor advanced to the new period');
    const before = env.ledger.snapshot(TREASURY_ID).cashUsd;
    const again = await env.rewards.apply({
      due,
      rankings: env.completed,
      accountCashUsd: 2000,
      poolUsd: env.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 500,
      ledger: env.ledger,
      nowMs: T2,
    });
    assert.equal(again.applied, false);
    assert.equal(again.reason, 'already_applied');
    assert.equal(again.winners.length, 0);
    assert.equal(env.ledger.snapshot(TREASURY_ID).cashUsd, before);
    assert.equal(env.rewards.status().historyCount, 1);

    // status exposes the last payout for the control panel
    const status = env.rewards.status();
    assert.equal(status.lastWinners.length, 3);
    assert.equal(status.lastWinners[0].periodKey, '2026-10-29');
    assert.equal(status.lastWinners[0].amountUsd, 100);
    assert.equal(status.nextRunAt, new Date(Date.parse('2026-10-31T00:00:00Z')).toISOString());
  });

  it('scales payouts proportionally when the treasury pool is short', async () => {
    const env = await makeRewardsEnv({ poolUsd: 300 });
    const due = env.rewards.duePeriod(T2);
    const result = await env.rewards.apply({
      due,
      rankings: env.completed,
      accountCashUsd: 10_000, // requested 500 + 300 + 200 = 1000, pool only has 300
      poolUsd: env.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 100_000,
      ledger: env.ledger,
      nowMs: T2,
    });
    assert.equal(result.skipped, false);
    assert.deepEqual(result.winners.map((winner) => winner.amountUsd), [150, 90, 60]);
    assert.equal(result.winners.reduce((sum, winner) => sum + winner.amountUsd, 0), 300);
    assert.equal(env.ledger.pool().poolUsd, 0, 'the pool is fully but exactly spent');
  });

  it('caps by maxPerPeriodUsd', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000, rewardOverrides: { maxPerPeriodUsd: 120 } });
    const due = env.rewards.duePeriod(T2);
    // requested 100 + 60 + 40 = 200, capped to 120 -> 60/36/24
    const result = await env.rewards.apply({
      due,
      rankings: env.completed,
      accountCashUsd: 2000,
      poolUsd: env.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 500,
      ledger: env.ledger,
      nowMs: T2,
    });
    assert.deepEqual(result.winners.map((winner) => winner.amountUsd), [60, 36, 24]);
    assert.equal(env.ledger.pool().poolUsd, 880);
  });

  it('caps by the remaining allocation cap', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const due = env.rewards.duePeriod(T2);
    const result = await env.rewards.apply({
      due,
      rankings: env.completed,
      accountCashUsd: 2000, // requested 100/60/40
      poolUsd: env.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 50, // only $50 may be allocated
      ledger: env.ledger,
      nowMs: T2,
    });
    assert.deepEqual(result.winners.map((winner) => winner.amountUsd), [25, 15, 10]);
    assert.equal(env.ledger.pool().poolUsd, 950);
  });

  it('records a skipped payout and moves nothing when the available pool is zero', async () => {
    const env = await makeRewardsEnv({ poolUsd: 0 });
    const due = env.rewards.duePeriod(T2);
    const result = await env.rewards.apply({
      due,
      rankings: env.completed,
      accountCashUsd: 2000,
      poolUsd: env.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 500,
      ledger: env.ledger,
      nowMs: T2,
    });
    assert.equal(result.applied, true);
    assert.equal(result.skipped, true);
    assert.ok(result.winners.every((winner) => winner.amountUsd === 0));
    assert.ok(result.winners.every((winner) => !Number.isNaN(Number(winner.amountUsd))));
    assert.equal(env.ledger.pool().poolUsd, 0);
    const history = env.rewards.getState().history;
    assert.equal(history.length, 1);
    assert.equal(history[0].skipped, true);
    assert.equal(history[0].periodKey, '2026-10-29');
    // the period is consumed even when nothing was paid (no retry loop next tick)
    assert.equal(env.rewards.duePeriod(T2), null);
  });

  it('skips winners without a measured P&L and pays fewer than three when needed', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const deltas = await env.rankings.compute({ atMs: DAY_END - 1, stored: true });
    const rows = deltas.periods.daily;
    assert.equal(rows.length, 4, 'the completed-period ranking has all four agents');
    // Corrupt one row's baseline comparison by ranking a non-eligible synthetic set.
    const manual = {
      asOf: new Date(T2 - 1).toISOString(),
      periods: {
        daily: [
          { rank: 1, agentId: env.agents.a.id, name: 'Alpha', pnlPct: 0.2, pnlUsd: 20 },
          { rank: 2, agentId: env.agents.b.id, name: 'Beta', pnlPct: null, pnlUsd: null },
          { rank: 3, agentId: env.agents.c.id, name: 'Gamma', pnlPct: 0.1, pnlUsd: 10 },
        ],
      },
    };
    assert.equal(rows.length, 4);
    const due = env.rewards.duePeriod(T2);
    const result = await env.rewards.apply({
      due,
      rankings: manual,
      accountCashUsd: 2000,
      poolUsd: env.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 500,
      ledger: env.ledger,
      nowMs: T2,
    });
    assert.equal(result.winners.length, 2);
    assert.deepEqual(result.winners.map((winner) => winner.amountUsd), [100, 60]);
    assert.deepEqual(result.winners.map((winner) => winner.rank), [1, 2]);
    assert.equal(result.winners[1].agentId, env.agents.c.id);
  });

  it('weekly and monthly periods boundary on the ISO week / UTC month', async () => {
    const weeklyDir = makeTempDir('rewards-weekly');
    const weeklyClock = makeClock(T1);
    const weeklyConfig = makeConfig(weeklyDir, { rewards: { period: 'weekly' } });
    const weeklyPaths = statePaths(weeklyConfig);
    const weeklyLedger = createLedger({ paths: weeklyPaths, config: weeklyConfig, clock: weeklyClock });
    await weeklyLedger.load();
    weeklyLedger.ensureAgent('atm-aaaa0001', { endowmentUsd: 20 });
    weeklyLedger.grant('atm-aaaa0001', 20, { reason: 'endowment' });
    weeklyLedger.grant(TREASURY_ID, 1000, { reason: 'test-pool' });
    const weeklyRankings = createRankings({ paths: weeklyPaths, config: weeklyConfig, clock: weeklyClock });
    await weeklyRankings.load();
    await weeklyRankings.record({ atMs: T1, equityByAgent: { 'atm-aaaa0001': { name: 'Alpha', equityUsd: 100, trades: 0 } } });
    await weeklyRankings.record({ atMs: T1 + 11 * HOUR, equityByAgent: { 'atm-aaaa0001': { name: 'Alpha', equityUsd: 110, trades: 1 } } });
    const weeklyRewards = createRewards({ paths: weeklyPaths, config: weeklyConfig, clock: weeklyClock });
    await weeklyRewards.load();
    assert.equal(weeklyRewards.status().lastPeriodKey, '2026-W44');
    assert.equal(weeklyRewards.status().nextRunAt, new Date(Date.parse('2026-11-02T00:00:00Z')).toISOString());

    // Thursday -> Friday is not a weekly boundary
    weeklyClock.set(T2);
    assert.equal(weeklyRewards.duePeriod(T2), null);
    // Monday 2026-11-02 00:05 is
    const monday = Date.parse('2026-11-02T00:05:00Z');
    weeklyClock.set(monday);
    const due = weeklyRewards.duePeriod(monday);
    assert.deepEqual(due, {
      period: 'weekly',
      periodKey: '2026-W44',
      completed: true,
      currentPeriodKey: '2026-W45',
    });
    const result = await weeklyRewards.apply({
      due,
      rankings: weeklyRankings, // module path: computes the completed-period snapshot itself
      accountCashUsd: 2000,
      poolUsd: weeklyLedger.pool().poolUsd,
      allocationCapRemainingUsd: 1000,
      ledger: weeklyLedger,
      nowMs: monday,
    });
    assert.equal(result.period, 'weekly');
    assert.equal(result.periodKey, '2026-W44');
    assert.equal(result.winners.length, 1);
    assert.equal(result.winners[0].amountUsd, 100); // 5% of $2000
    assert.equal(weeklyRewards.status().nextRunAt, new Date(Date.parse('2026-11-09T00:00:00Z')).toISOString());

    // monthly boundary: 2026-11-01T00:00Z
    const monthlyDir = makeTempDir('rewards-monthly');
    const monthlyClock = makeClock(T1);
    const monthlyConfig = makeConfig(monthlyDir, { rewards: { period: 'monthly' } });
    const monthlyRewards = createRewards({ paths: statePaths(monthlyConfig), config: monthlyConfig, clock: monthlyClock });
    await monthlyRewards.load();
    assert.equal(monthlyRewards.status().lastPeriodKey, '2026-10');
    assert.equal(monthlyRewards.status().nextRunAt, new Date(Date.parse('2026-11-01T00:00:00Z')).toISOString());
    monthlyClock.set(Date.parse('2026-11-01T00:05:00Z'));
    const monthlyDue = monthlyRewards.duePeriod(Date.parse('2026-11-01T00:05:00Z'));
    assert.equal(monthlyDue.period, 'monthly');
    assert.equal(monthlyDue.periodKey, '2026-10');
  });

  it('persists history (last 50) and survives a reload; disabled config never pays', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    const due = env.rewards.duePeriod(T2);
    await env.rewards.apply({
      due,
      rankings: env.completed,
      accountCashUsd: 2000,
      poolUsd: env.ledger.pool().poolUsd,
      allocationCapRemainingUsd: 500,
      ledger: env.ledger,
      nowMs: T2,
    });
    assert.ok(fs.existsSync(env.paths.rewardsFile), 'apply() must persist rewards.json');
    const persisted = JSON.parse(fs.readFileSync(env.paths.rewardsFile, 'utf8'));
    assert.equal(persisted.history.length, 1);
    assert.equal(persisted.lastPeriodKey, '2026-10-30');
    assert.equal(persisted.history[0].periodKey, '2026-10-29');
    assert.deepEqual(
      persisted.history[0].winners.map((winner) => winner.amountUsd),
      [100, 60, 40],
    );

    // Reload a fresh instance: state survives.
    const reloaded = createRewards({ paths: env.paths, config: env.config, clock: env.clock });
    await reloaded.load();
    assert.equal(reloaded.status().historyCount, 1);
    assert.equal(reloaded.status().lastRunAt, new Date(T2).toISOString());
    assert.deepEqual(reloaded.status().lastWinners.map((winner) => winner.amountUsd), [100, 60, 40]);
    assert.equal(reloaded.duePeriod(T2), null);

    // History trimming: 55 synthetic boundaries must keep only the last 50 entries.
    let prevKey = reloaded.status().lastPeriodKey;
    for (let i = 0; i < 55; i += 1) {
      const currentKey = `synthetic-${String(i).padStart(3, '0')}`;
      const skippedDue = { period: 'daily', periodKey: prevKey, completed: true, currentPeriodKey: currentKey };
      // Empty leaderboard: records skipped history without moving money.
      // eslint-disable-next-line no-await-in-loop
      const padded = await reloaded.apply({
        due: skippedDue,
        rankings: { asOf: new Date(T2).toISOString(), periods: { daily: [] } },
        accountCashUsd: 2000,
        poolUsd: 0,
        allocationCapRemainingUsd: 0,
        ledger: env.ledger,
        nowMs: T2 + (i + 1) * 1000,
      });
      assert.equal(padded.applied, true);
      assert.equal(padded.skipped, true);
      prevKey = currentKey;
    }
    assert.equal(reloaded.status().historyCount, 50);
    assert.equal(reloaded.getState().history.length, 50);
    await reloaded.load();
    assert.equal(reloaded.getState().history.length, 50);
    // History entries record the COMPLETED key; the anchor is the current one.
    assert.equal(reloaded.getState().history.at(-1).periodKey, 'synthetic-053');
    assert.equal(reloaded.status().lastPeriodKey, 'synthetic-054');

    // Disabled rewards never pay and never report a due period.
    const disabledDir = makeTempDir('rewards-disabled');
    const disabledClock = makeClock(T1);
    const disabledConfig = makeConfig(disabledDir, { rewards: { enabled: false } });
    const disabled = createRewards({ paths: statePaths(disabledConfig), config: disabledConfig, clock: disabledClock });
    await disabled.load();
    disabledClock.set(T2);
    assert.equal(disabled.duePeriod(T2), null);
    assert.equal(disabled.status().enabled, false);
    const disabledApply = await disabled.apply({
      due: { period: 'daily', periodKey: '2026-10-29', completed: true, currentPeriodKey: '2026-10-30' },
      rankings: { asOf: new Date(T2).toISOString(), periods: { daily: [] } },
      accountCashUsd: 2000,
      poolUsd: 1000,
      allocationCapRemainingUsd: 500,
      ledger: { transfer: () => { throw new Error('must not transfer while disabled'); } },
      nowMs: T2,
    });
    assert.equal(disabledApply.applied, false);
    assert.equal(disabledApply.reason, 'disabled');
    assert.equal(disabledApply.skipped, true);
    assert.equal(disabled.status().historyCount, 0);
  });

  it('resolves settings from config.rewards with own fallbacks and supports live reconfigure', async () => {
    const env = await makeRewardsEnv({ poolUsd: 1000 });
    assert.deepEqual(resolveRewardSettings({}), { ...REWARD_DEFAULTS, rankPercents: [0.05, 0.03, 0.02] });
    assert.deepEqual(resolveRewardSettings({ rewards: { rankPercents: [0.1, 0.02, 0.01], period: 'weekly' } }), {
      enabled: true,
      period: 'weekly',
      rankPercents: [0.1, 0.02, 0.01],
      basis: 'account-cash',
      maxPerPeriodUsd: null,
    });
    // malformed values fall back rather than throwing (config validation is the Lead's)
    assert.deepEqual(resolveRewardSettings({ rewards: { period: 'hourly', rankPercents: [0.9], basis: 'x', maxPerPeriodUsd: -1 } }), {
      enabled: true,
      period: 'daily',
      rankPercents: [0.05, 0.03, 0.02],
      basis: 'account-cash',
      maxPerPeriodUsd: null,
    });

    const reconfigured = env.rewards.reconfigure({
      rewards: { enabled: true, period: 'weekly', rankPercents: [0.1, 0.05, 0.02], maxPerPeriodUsd: 500 },
    });
    assert.equal(reconfigured.period, 'weekly');
    assert.deepEqual(reconfigured.rankPercents, [0.1, 0.05, 0.02]);
    assert.equal(reconfigured.lastPeriodKey, '2026-W44');
    assert.equal(env.rewards.duePeriod(T2), null, 'reconfiguring re-anchors instead of paying a partial period');
  });
});
