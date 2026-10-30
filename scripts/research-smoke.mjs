/**
 * scripts/research-smoke.mjs — end-to-end smoke for the per-agent research sidecar.
 *
 * Runs the REAL composition (createAutomaton) against the deterministic SIM broker with a
 * fake LLM generator, in a throwaway state dir, then asserts:
 *   - the researcher runs for due agents and each one gets an isolated briefing
 *   - status/agents[].research + engine.research are populated for the panel/tools
 *   - each briefing is charged to that agent's ledger (category research, role prospector)
 *   - the executor receives the briefing (trace/actions show influence is wired)
 *
 * Run: node scripts/research-smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, statePaths } from '../packages/automaton-trading/src/config.js';
import { createBroker as createSimBroker } from '../packages/automaton-trading/src/broker-sim.js';
import { createAutomaton } from '../packages/automaton-trading/src/orchestrator.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-research-smoke-'));
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

let nowMs = Date.parse('2026-10-26T14:00:00Z');
const clock = {
  now: () => nowMs,
  iso: () => new Date(nowMs).toISOString(),
  advance: (byMs) => {
    nowMs += byMs;
  },
};

const config = loadConfig({
  configFile: path.join(dir, 'missing.config.json'),
  envFile: path.join(dir, 'missing.env'),
  overrides: {
    mode: 'sim',
    paths: { stateDir: dir },
    population: { initial: 3, cap: 10 },
    engine: { seed: 11 },
    research: { enabled: true, influence: true, intervalSec: 3600, staggerSec: 0, costPerRunUsd: 0.001, maxConcurrent: 2 },
  },
}).config;
const paths = statePaths(config);
const simBroker = createSimBroker(config, { seed: 11, accountEquityUsd: 100000 });
// The sim news feed's synthetic hours are sparse; this smoke supplies deterministic headlines
// so the ORCHESTRATION path (not the sim news generator) is what gets exercised here.
const broker = Object.create(simBroker);
broker.getNews = async ({ symbols = [] } = {}) =>
  symbols.flatMap((symbol) => [
    {
      id: `smoke-${symbol}-1`,
      headline: `${symbol} smoke headline`,
      summary: 'Smoke fixture.',
      source: 'Smoke Wire',
      url: null,
      symbols: [symbol],
      createdAt: clock.now() - 2 * 3600_000,
    },
  ]);

const prompts = [];
const generate = async ({ system, user }) => {
  prompts.push({ system, user });
  // The same LLM seam also drives the per-bot agent brain (v2.3.0). Answer each prompt kind with
  // its own schema so both subsystems succeed during the smoke run.
  if (String(system).includes('private trading agent')) {
    return {
      text: JSON.stringify({
        stance: 'trade',
        sizeMultiplier: 0.8,
        riskMultiplier: 1,
        exitPressure: 'none',
        confidence: 0.6,
        thesis: 'Smoke agent review.',
        plan: ['hold'],
        watch: [],
      }),
      provider: 'smoke-agent',
      model: 'smoke-agent-model',
      usage: { inputTokens: 80, outputTokens: 40 },
    };
  }
  return {
    text: JSON.stringify({
      sentiment: 0.2,
      confidence: 0.6,
      verdict: 'HOLD',
      catalysts: ['smoke catalyst'],
      risks: [],
      summary: 'Smoke briefing: neutral tone.',
      symbols: [],
      sources: [],
    }),
    provider: 'smoke-fake',
    model: 'smoke-model',
    usage: { inputTokens: 100, outputTokens: 60 },
  };
};

try {
  const automaton = await createAutomaton({ config, clock, broker, generate });
  await automaton.init();
  const trace = await automaton.tick();
  const status = await automaton.status();

  const alive = status.agents.filter((agent) => agent.status === 'alive');
  check('population seeded', alive.length === 3, `alive=${alive.length}`);
  check('research trace ran', Boolean(trace.research && trace.research.ran >= 1), JSON.stringify(trace.research));
  check(
    'engine.research configured',
    status.engine.research?.configured === true && status.engine.research?.influence === true,
    JSON.stringify(status.engine.research),
  );
  const withBriefing = alive.filter((agent) => agent.research && agent.research.verdict === 'HOLD');
  check('agents carry isolated briefings', withBriefing.length === alive.length, `${withBriefing.length}/${alive.length}`);
  const charged = alive.filter((agent) => (agent.roleCosts?.prospector ?? 0) >= 0.001 - 1e-9);
  check('each briefing charged to its own ledger', charged.length === alive.length, `${charged.length}/${alive.length}`);
  // Research prompts only: the same generator also serves the per-bot agent brain, which must not
  // distort the per-agent briefing-scoping assertion.
  const researchPrompts = prompts.filter((entry) => String(entry.system).includes('news research analyst'));
  const firstLines = researchPrompts.map((entry) => entry.user.split('\n')[0]);
  check(
    'briefings are agent-scoped',
    researchPrompts.length === alive.length && new Set(firstLines).size === alive.length,
    `researchPrompts=${researchPrompts.length}`,
  );
  const researchJournal = path.join(dir, 'research');
  check('per-agent journals on disk', fs.readdirSync(researchJournal).filter((name) => name.endsWith('.jsonl')).length === alive.length);
  check(
    'briefing payload mapped to agents',
    alive.every((agent) => Array.isArray(agent.research?.catalysts) && agent.research.catalysts.includes('smoke catalyst')),
  );

  // A second cycle (not due) must not run research or charge for it again.
  const runsBefore = status.engine.research.runs;
  await automaton.tick();
  const after = await automaton.status();
  check(
    'hourly cadence: second cycle does not re-run research',
    after.engine.research.runs === runsBefore,
    `runs ${runsBefore} -> ${after.engine.research.runs}`,
  );

  // Advance an hour: due again.
  clock.advance(3_600_000);
  const due = await automaton.tick();
  check('next hour is due again', Boolean(due.research && due.research.ran >= 1), JSON.stringify(due.research));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
