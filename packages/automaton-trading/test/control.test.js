/**
 * test/control.test.js — Lead-owned verification for the operator control-panel engine work:
 * research schedule modes + live reconfigure, settings overlay persistence, leaderboards, rewards
 * payouts (period boundary, once-per-period, caps), strategy plans, transactions and engine status.
 *
 * Run directly (the sandbox blocks `node --test <file>`):
 *   cd packages/automaton-trading && node test/control.test.js
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, statePaths } from '../src/config.js';
import { createBroker as createSimBroker } from '../src/broker-sim.js';
import { createAutomaton } from '../src/orchestrator.js';
import { createResearcher } from '../src/research.js';
import { createEngine } from '../src/engine.js';
import { createLedger } from '../src/ledger.js';
import { createRegistry } from '../src/registry.js';

const HOUR = 60 * 60 * 1000;

function makeClock(startMs) {
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
  };
}

function tempConfig(dir, overrides = {}) {
  return loadConfig({
    configFile: path.join(dir, 'missing.config.json'),
    envFile: path.join(dir, 'missing.env'),
    overrides: {
      mode: 'sim',
      paths: { stateDir: dir },
      population: { initial: 3, cap: 10 },
      ...overrides,
    },
  }).config;
}

const RESEARCH_JSON = JSON.stringify({
  sentiment: 0.2,
  confidence: 0.6,
  verdict: 'HOLD',
  catalysts: ['fixture catalyst'],
  risks: [],
  summary: 'Fixture briefing.',
  symbols: [],
  sources: [],
});

function fakeGenerate() {
  return async () => ({ text: RESEARCH_JSON, provider: 'fake', model: 'fake-model', usage: { inputTokens: 5, outputTokens: 5 } });
}

// ---------------------------------------------------------------------------
// research schedule modes
// ---------------------------------------------------------------------------

describe('research schedule modes (operator-selectable cadence)', () => {
  let dir;
  let config;
  let paths;
  let registry;
  let ledger;
  let clock;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-research-'));
    clock = makeClock(Date.parse('2026-10-29T14:00:00Z'));
    config = tempConfig(dir, {
      research: { enabled: true, influence: false, intervalSec: 3600, staggerSec: 0, maxRunsPerCycle: 3 },
      rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
    });
    paths = statePaths(config);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    registry = createRegistry({ paths, config, clock });
    ledger = createLedger({ paths, config, clock });
    for (let index = 0; index < 3; index += 1) {
      registry.register({
        id: `atm-agent-${index}`,
        name: `Agent ${index}`,
        generation: 0,
        status: 'alive',
        bornAt: new Date(clock.now()).toISOString(),
        endowmentUsd: 20,
        genome: { family: 'meanrev', symbol: ['AAPL', 'MSFT', 'NVDA'][index], entryZ: 1.2 },
      });
      ledger.ensureAgent(`atm-agent-${index}`, { endowmentUsd: 20 });
      ledger.grant(`atm-agent-${index}`, 20, { reason: 'endowment' });
    }
    registry.save();
    ledger.save();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeResearcher(overrides = {}) {
    return createResearcher({
      broker: { async getNews() { return []; } },
      registry,
      ledger,
      config: { ...config, research: { ...config.research, ...overrides } },
      paths,
      clock,
      generate: fakeGenerate(),
    });
  }

  it('interval mode is due once per interval; reconfigure to pre-open switches to the window', async () => {
    const researcher = makeResearcher();
    const first = await researcher.tick();
    assert.equal(first.due, 3);
    const second = await researcher.tick();
    assert.equal(second.due, 0, 'same interval: not due again');
    // Live reconfigure to a pre-open window 10 minutes before the next open.
    const schedule = researcher.reconfigure({ scheduleMode: 'pre-open', preMarketOffsetMin: 30 });
    assert.equal(schedule.scheduleMode, 'pre-open');
    const nextOpen = clock.now() + 10 * 60 * 1000;
    const marketClock = { isOpen: false, nextOpen, nextClose: clock.now() + 5 * HOUR };
    const beforeWindow = await researcher.tick({ marketClock: { isOpen: false, nextOpen: clock.now() + 3 * HOUR, nextClose: clock.now() + 9 * HOUR } });
    assert.equal(beforeWindow.due, 0, 'outside the pre-open window nothing is due');
    const inWindow = await researcher.tick({ marketClock });
    assert.equal(inWindow.due, 3, 'pre-open window makes all agents due');
    assert.equal(inWindow.ran.length, 3);
  });

  it('post-close window opens when the market closes and is served once', async () => {
    const researcher = makeResearcher({ scheduleMode: 'post-close', postCloseOffsetMin: 30 });
    const openClock = { isOpen: true, nextOpen: clock.now() - HOUR, nextClose: clock.now() + 2 * HOUR };
    await researcher.tick({ marketClock: openClock });
    clock.advance(2 * HOUR + 5 * 60 * 1000); // session closed a few minutes ago
    const closedClock = { isOpen: false, nextOpen: clock.now() + 16 * HOUR, nextClose: clock.now() + 22 * HOUR };
    const due = await researcher.tick({ marketClock: closedClock });
    assert.ok(due.due > 0, 'post-close window should be due right after the close');
    const again = await researcher.tick({ marketClock: closedClock });
    assert.equal(again.due, 0, 'the post-close window is served once per close');
  });

  it('engine persists research schedule to the settings overlay and exposes configurable options', async () => {
    const engineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-engine-'));
    try {
      const engine = createEngine({
        cwd: engineDir,
        configFile: path.join(engineDir, 'missing.config.json'),
        envFile: path.join(engineDir, 'missing.env'),
        overrides: {
          mode: 'sim',
          stateDir: path.join(engineDir, 'state'),
          config: {
            population: { initial: 2, cap: 5 },
            research: { enabled: true, influence: false },
            rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
          },
        },
      });
      const result = await engine.updateResearchSettings({ mode: 'pre-open', preMarketOffsetMin: 20 });
      assert.equal(result.settings.scheduleMode, 'pre-open');
      assert.equal(result.settings.preMarketOffsetMin, 20);
      const settingsPath = path.join(engineDir, 'state', 'settings.json');
      assert.equal(fs.existsSync(settingsPath), true);
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.equal(saved.research.scheduleMode, 'pre-open');
      // A fresh engine (restart equivalent) reads the overlay back.
      const reread = createEngine({
        cwd: engineDir,
        configFile: path.join(engineDir, 'missing.config.json'),
        envFile: path.join(engineDir, 'missing.env'),
        overrides: {
          mode: 'sim',
          stateDir: path.join(engineDir, 'state'),
          config: {
            population: { initial: 2, cap: 5 },
            research: { enabled: true, influence: false },
            rewards: { enabled: false, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: null },
          },
        },
      });
      const view = reread.configView();
      assert.equal(view.summary.research.scheduleMode, 'pre-open');
      assert.equal(view.summary.research.preMarketOffsetMin, 20);
      // Invalid values are rejected and the overlay is rolled back.
      await assert.rejects(() => engine.updateResearchSettings({ intervalSec: 12345 }), /CONFIG_INVALID|intervalSec/);
      const afterInvalid = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.equal(afterInvalid.research.scheduleMode, 'pre-open');
    } finally {
      fs.rmSync(engineDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// orchestrator: plan, transactions, rankings, rewards, status
// ---------------------------------------------------------------------------

describe('control-panel status + leaderboards + rewards payouts', () => {
  let dir;
  let config;
  let broker;
  let clock;
  let automaton;
  let paths;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-control-rewards-'));
    clock = makeClock(Date.parse('2026-10-28T15:00:00Z'));
    config = tempConfig(dir, {
      population: { initial: 3, cap: 10 },
      research: { enabled: true, influence: false, intervalSec: 3600, staggerSec: 0 },
      rewards: { enabled: true, period: 'daily', rankPercents: [0.05, 0.03, 0.02], maxPerPeriodUsd: 300 },
    });
    paths = statePaths(config);
    broker = createSimBroker(config, { seed: 11, accountEquityUsd: 100000 });
    automaton = await createAutomaton({ config, broker, clock, generate: fakeGenerate() });
    await automaton.init();
    await automaton.tick();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exposes strategy plan, transactions and P&L per agent', async () => {
    const status = await automaton.status();
    assert.ok(status.agents.length >= 3);
    for (const agent of status.agents) {
      assert.ok(agent.plan, `${agent.name} should have a plan`);
      assert.equal(typeof agent.plan.summary, 'string');
      assert.ok(agent.plan.summary.length > 20);
      assert.ok(agent.plan.entryRule.length > 10);
      assert.ok(Array.isArray(agent.plan.exitRules) && agent.plan.exitRules.length >= 3);
      assert.ok(agent.plan.nextStep.length > 20);
      assert.ok(agent.plan.triggers && typeof agent.plan.triggers.family === 'string');
      assert.ok(Array.isArray(agent.orders));
      assert.ok(agent.pnl && typeof agent.pnl === 'object');
      assert.ok(agent.rankings && typeof agent.rankings.dayRank === 'number');
    }
  });

  it('exposes leaderboards for daily, weekly and monthly periods', async () => {
    const status = await automaton.status();
    assert.ok(status.rankings);
    for (const period of ['daily', 'weekly', 'monthly']) {
      const rows = status.rankings.periods[period];
      assert.ok(Array.isArray(rows) && rows.length >= 3, `${period} ranking rows`);
      assert.equal(rows[0].rank, 1);
      assert.ok(typeof rows[0].pnlUsd === 'number');
      assert.ok(status.rankings.periodKeys[period]);
    }
    assert.equal(status.engine.rewards.enabled, true);
    assert.deepEqual(status.engine.rewards.rankPercents, [0.05, 0.03, 0.02]);
    assert.equal(status.engine.research.scheduleMode, 'interval');
    assert.ok(Array.isArray(status.engine.research.configurable.intervalOptionsSec));
    assert.deepEqual(status.engine.research.configurable.intervalOptionsSec, [3600, 10800, 21600, 86400]);
  });

  it('pays the top-3 once when a period completes, capped and reconciling', async () => {
    const before = await automaton.status();
    const poolBefore = before.engine.rewards.poolUsd;
    const ledgerBefore = automaton._internals.ledger;
    const cashBefore = Object.fromEntries(before.agents.map((agent) => [agent.id, agent.cashUsd]));
    clock.advance(24 * HOUR); // cross the daily boundary
    const trace = await automaton.tick();
    assert.ok(trace.rewards && trace.rewards.winners.length === 3, JSON.stringify(trace.rewards));
    const totalPaid = trace.rewards.winners.reduce((sum, winner) => sum + winner.amountUsd, 0);
    assert.ok(Math.abs(totalPaid - 300) < 0.5, `maxPerPeriodUsd cap should bound the payout, got ${totalPaid}`);
    const status = await automaton.status();
    assert.equal(status.engine.rewards.lastWinners.length, 3);
    assert.ok(status.engine.rewards.poolUsd < poolBefore + 1e-9);
    for (const winner of trace.rewards.winners) {
      assert.ok(status.agents.find((agent) => agent.id === winner.agentId));
      assert.ok(winner.amountUsd > 0);
    }
    const newCash = Object.fromEntries(status.agents.map((agent) => [agent.id, agent.cashUsd]));
    const increased = Object.keys(cashBefore).filter((id) => newCash[id] > cashBefore[id] + 1e-9);
    assert.ok(increased.length >= 1, 'at least one agent must have received a reward');
    assert.ok(ledgerBefore.pool().poolUsd < poolBefore + 1e-9);
    // The next tick must not pay the same period again.
    const again = await automaton.tick();
    assert.equal((again.rewards?.winners ?? []).length, 0);
  });

  it('live reward settings apply immediately and are reflected in status', async () => {
    const result = await automaton.updateRewardSettings({ period: 'weekly', rankPercents: [0.02, 0.01, 0.005], maxPerPeriodUsd: 50 });
    assert.equal(result.settings.period, 'weekly');
    const status = await automaton.status();
    assert.equal(status.engine.rewards.period, 'weekly');
    assert.deepEqual(status.engine.rewards.rankPercents, [0.02, 0.01, 0.005]);
  });
});
