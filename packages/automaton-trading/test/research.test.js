/**
 * test/research.test.js — Lead-owned verification for the per-agent research sidecar.
 *
 * What is asserted (docs/RESEARCH.md):
 *   - strict per-agent isolation: a prompt never contains another agent's id/name/book/journal
 *   - the briefing schema is validated and clamped (a crooked LLM cannot smuggle extra state)
 *   - failures are contained: malformed reply / LLM error -> no briefing, no charge, error logged
 *   - each successful briefing is charged to THAT agent's ledger (role: prospector, category: research)
 *   - an hourly schedule per agent (due once per interval, staggered), with fresh/stale semantics
 *   - no-news runs produce a neutral HOLD without spending an LLM call
 *   - the per-agent journals are separate files
 *   - the headless HTTP generator is absent without a key and maps DeepSeek responses correctly
 *
 * Run directly (sandbox blocks `node --test <file>`):
 *   cd packages/automaton-trading && node test/research.test.js
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, statePaths } from '../src/config.js';
import { createRegistry } from '../src/registry.js';
import { createLedger } from '../src/ledger.js';
import { createResearcher, createHttpResearchGenerator, extractJsonObject, normalizeBriefing } from '../src/research.js';

const HOUR = 60 * 60 * 1000;

function makeClock(startMs = Date.parse('2026-10-26T14:00:00Z')) {
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

function makeAgent(id, name, symbol, family = 'meanrev') {
  return {
    id,
    name,
    generation: 0,
    bornAt: '2026-10-26T13:00:00.000Z',
    status: 'alive',
    endowmentUsd: 20,
    genome: { symbol, family, lookback: 24, entryZ: 1.2, exitZ: 0.4, stopPct: 0.02, targetPct: 0.04, maxHoldBars: 12, sizePct: 0.2, sessionFilter: 'any' },
  };
}

function jsonReply(overrides = {}) {
  return JSON.stringify({
    sentiment: 0.3,
    confidence: 0.7,
    verdict: 'HOLD',
    catalysts: ['earnings beat'],
    risks: [],
    summary: 'Nothing material for this strategy today.',
    symbols: ['AAPL'],
    sources: [{ title: 'Headline', source: 'wire', url: 'https://example.com/a', at: '2026-10-26T13:30:00.000Z' }],
    ...overrides,
  });
}

describe('research: isolation, schema, economics, scheduling', () => {
  let dir;
  let clock;
  let config;
  let paths;
  let registry;
  let ledger;
  let broker;
  let prompts;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automaton-research-'));
    clock = makeClock();
    config = loadConfig({
      configFile: path.join(dir, 'missing.config.json'),
      envFile: path.join(dir, 'missing.env'),
      overrides: {
        mode: 'sim',
        paths: { stateDir: dir },
        population: { initial: 2, cap: 10 },
        research: {
          enabled: true,
          influence: true,
          intervalSec: 3600,
          staggerSec: 0,
          maxNewsPerAgent: 3,
          newsLookbackHours: 24,
          costPerRunUsd: 0.001,
          maxAgeSec: 7200,
          maxConcurrent: 1,
          maxInputChars: 12000,
          maxOutputTokens: 400,
          logLimit: 40,
        },
      },
    }).config;
    paths = statePaths(config);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    registry = createRegistry({ paths, config, clock });
    ledger = createLedger({ paths, config, clock });
    for (const agent of [
      makeAgent('atm-aaaaaaaa', 'MeanRev AAPL', 'AAPL', 'meanrev'),
      makeAgent('atm-bbbbbbbb', 'Momentum MSFT', 'MSFT', 'momentum'),
    ]) {
      registry.register(agent);
      ledger.ensureAgent(agent.id, { endowmentUsd: 20 });
      ledger.grant(agent.id, 20, { reason: 'endowment' });
    }
    registry.save();
    ledger.save();
    broker = {
      async getNews({ symbols }) {
        const symbol = symbols[0];
        const other = symbol === 'AAPL' ? 'MSFT' : 'AAPL';
        return [
          { id: `n-${symbol}-1`, headline: `${symbol} beats estimates`, summary: `${symbol} quarterly results beat consensus.`, source: 'wire', url: `https://example.com/${symbol}`, symbols: [symbol], createdAt: clock.now() - 2 * HOUR },
          { id: `n-${symbol}-2`, headline: `${other} unrelated headline`, summary: 'Should never appear in another agent prompt.', source: 'wire', url: `https://example.com/${other}`, symbols: [other], createdAt: clock.now() - 3 * HOUR },
        ];
      },
    };
    prompts = [];
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeGenerator(provider = 'fake') {
    return async ({ system, user }) => {
      const record = { system, user };
      prompts.push(record);
      const agent = /MeanRev AAPL/.test(user) ? 'AAPL' : 'MSFT';
      return { text: jsonReply({ symbols: [agent] }), provider, model: 'fake-model', usage: { inputTokens: 10, outputTokens: 20 } };
    };
  }

  function makeResearcher(overrides = {}) {
    return createResearcher({
      broker,
      registry,
      ledger,
      config: { ...config, research: { ...config.research, ...overrides } },
      paths,
      clock,
      generate: makeGenerator(),
    });
  }

  function advancePastInterval() {
    clock.advance(HOUR + 60 * 1000);
  }

  it('parses fenced JSON and clamps/validates the briefing', () => {
    const raw = extractJsonObject('```json\n{"sentiment": 3.2, "confidence": -1, "verdict": "hold", "catalysts": ["a"], "risks": ["b"], "summary": "s", "symbols": ["AAPL", "TSLA"], "sources": [{"title": "t", "source": "s", "url": "javascript:bad", "at": "nope"}]}\n```');
    const briefing = normalizeBriefing(raw, { symbols: ['AAPL'], news: [{}, {}] });
    assert.equal(briefing.sentiment, 1);
    assert.equal(briefing.confidence, 0);
    assert.equal(briefing.verdict, 'HOLD');
    assert.deepEqual(briefing.symbols, ['AAPL']); // TSLA was not offered -> dropped
    assert.equal(briefing.sources.length, 1);
    assert.equal(briefing.sources[0].url, null); // non-http url dropped
    assert.equal(briefing.newsCount, 2);
    assert.throws(() => normalizeBriefing({ sentiment: 'x' }, { symbols: [] }), /numeric/);
    assert.throws(() => normalizeBriefing({ sentiment: 0, confidence: 0, verdict: 'BUY' }, { symbols: [] }), /verdict/);
  });

  it('keeps each prompt strictly isolated to one agent (no cross-agent memory)', async () => {
    advancePastInterval();
    prompts.length = 0;
    const researcher = makeResearcher();
    const run = await researcher.tick();
    assert.equal(run.ran.length, 2);
    assert.equal(prompts.length, 2);
    const aaplPrompt = prompts.find((entry) => entry.user.includes('MeanRev AAPL'));
    const msftPrompt = prompts.find((entry) => entry.user.includes('Momentum MSFT'));
    assert.ok(aaplPrompt && msftPrompt);
    assert.ok(aaplPrompt.user.includes('AAPL'));
    assert.ok(aaplPrompt.user.includes('AAPL beats estimates'));
    assert.equal(aaplPrompt.user.includes('Momentum MSFT'), false);
    assert.equal(aaplPrompt.user.includes('atm-bbbbbbbb'), false);
    assert.equal(aaplPrompt.user.includes('MSFT beats estimates'), false);
    assert.equal(msftPrompt.user.includes('MeanRev AAPL'), false);
    assert.equal(msftPrompt.user.includes('atm-aaaaaaaa'), false);
    assert.ok(aaplPrompt.system.includes('exactly ONE automated trading bot'));
  });

  it('parses, stores and charges one briefing per agent to its own ledger', async () => {
    advancePastInterval();
    const researcher = makeResearcher();
    const journalFile = path.join(paths.researchDir, 'atm-aaaaaaaa.jsonl');
    const journalBefore = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const beforeCash = ledger.snapshot('atm-aaaaaaaa').cashUsd;
    await researcher.tick();
    const briefing = researcher.latest('atm-aaaaaaaa');
    assert.ok(briefing);
    assert.equal(briefing.verdict, 'HOLD');
    assert.equal(briefing.atMs, clock.now());
    const aaplCash = ledger.snapshot('atm-aaaaaaaa').cashUsd;
    assert.ok(Math.abs(aaplCash - (beforeCash - 0.001)) < 1e-9);
    const roleCosts = ledger.roleCosts('atm-aaaaaaaa');
    assert.ok(roleCosts.prospector >= 0.001 - 1e-9);
    const journal = fs.readFileSync(journalFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(journal.length, journalBefore + 1);
    assert.equal(journal[journal.length - 1].agentId, 'atm-aaaaaaaa');
    assert.equal(fs.existsSync(path.join(paths.researchDir, 'atm-bbbbbbbb.jsonl')), true);
  });

  it('contains a malformed LLM reply: no briefing, no charge, error recorded', async () => {
    advancePastInterval();
    const researcher = createResearcher({
      broker,
      registry,
      ledger,
      config,
      paths,
      clock,
      generate: async () => ({ text: 'I think the stock will go up!', provider: 'fake', model: 'fake-model' }),
    });
    const cashBefore = ledger.snapshot('atm-aaaaaaaa').costsUsd;
    const run = await researcher.tick();
    assert.equal(run.ran.length, 2);
    assert.match(run.ran[0].error, /llm:/);
    assert.equal(run.ran.every((entry) => Boolean(entry.error)), true);
    assert.equal(ledger.snapshot('atm-aaaaaaaa').costsUsd, cashBefore);
  });

  it('an empty news window yields a neutral HOLD without an LLM call or charge', async () => {
    advancePastInterval();
    let calls = 0;
    const researcher = createResearcher({
      broker: { async getNews() { return []; } },
      registry,
      ledger,
      config,
      paths,
      clock,
      generate: async () => {
        calls += 1;
        return { text: jsonReply(), provider: 'fake', model: 'fake-model' };
      },
    });
    const costsBefore = ledger.snapshot('atm-aaaaaaaa').costsUsd;
    const run = await researcher.tick();
    assert.equal(calls, 0);
    assert.equal(run.ran.length, 2);
    assert.equal(run.ran[0].verdict, 'HOLD');
    assert.equal(run.ran[0].costUsd, 0);
    assert.equal(ledger.snapshot('atm-aaaaaaaa').costsUsd, costsBefore);
    assert.match(researcher.latest('atm-aaaaaaaa').summary, /No relevant news/);
  });

  it('schedules hourly per agent: due once, then skipped, then due again', async () => {
    clock.advance(3 * HOUR);
    const researcher = makeResearcher();
    const first = await researcher.tick();
    assert.equal(first.due, 2);
    assert.equal(first.ran.length, 2);
    const second = await researcher.tick();
    assert.equal(second.due, 0);
    assert.equal(second.ran.length, 0);
    assert.equal(second.skipped, 2);
    clock.advance(HOUR + 1);
    const third = await researcher.tick();
    assert.equal(third.due, 2);
    assert.equal(third.ran.length, 2);
  });

  it('expires stale briefings for the executor but keeps them for the dashboard', async () => {
    clock.advance(3 * HOUR);
    const researcher = makeResearcher({ maxAgeSec: 600 });
    const run = await researcher.tick();
    assert.equal(run.ran.length, 2);
    assert.ok(researcher.latest('atm-aaaaaaaa'));
    clock.advance(601 * 1000);
    assert.equal(researcher.latest('atm-aaaaaaaa'), null);
    const stale = researcher.latestAny('atm-aaaaaaaa');
    assert.ok(stale && stale.stale === true);
  });

  it('repairs malformed/truncated model JSON before giving up', async () => {
    // trailing comma + smart quotes + truncated tail (live failure observed: array cut mid-element)
    const repaired = extractJsonObject(
      '```json\n{\u201Csentiment\u201D: 0.1, \u201Cconfidence\u201D: 0.2, \u201Cverdict\u201D: \u201CHOLD\u201D, \u201Ccatalysts\u201D: [\u201Ca\u201D, \u201Cb\u201D, ], \u201Crisks\u201D: [], \u201Csummary\u201D: \u201Cok\u201D, \u201Csymbols\u201D: [\u201CAAPL\u201D\n```',
    );
    assert.equal(repaired.sentiment, 0.1);
    assert.deepEqual(repaired.catalysts, ['a', 'b']);
    const truncated = extractJsonObject('{"sentiment":0.1,"confidence":0.2,"verdict":"HOLD","catalysts":["a","b');
    assert.deepEqual(truncated.catalysts, ['a', 'b']);
    // genuinely broken payloads still fail with a retriable code
    assert.throws(
      () => extractJsonObject('I think the stock will go up!'),
      (error) => error.code === 'BRIEFING_JSON_INVALID',
    );
  });

  it('retries once on a malformed reply, then books and charges the good briefing', async () => {
    advancePastInterval();
    const calls = [];
    const researcher = createResearcher({
      broker,
      registry,
      ledger,
      config,
      paths,
      clock,
      generate: async ({ user }) => {
        calls.push(user);
        if (calls.length === 1) return { text: '{"sentiment":0.1,"verdict":"HOLD"', provider: 'fake', model: 'fake-model' };
        return { text: jsonReply(), provider: 'fake', model: 'fake-model', usage: { inputTokens: 5, outputTokens: 5 } };
      },
    });
    const journalFile = path.join(paths.researchDir, 'atm-aaaaaaaa.jsonl');
    const journalBefore = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const costsBefore = ledger.snapshot('atm-aaaaaaaa').costsUsd;
    const run = await researcher.tick();
    assert.equal(run.ran.length, 2);
    assert.equal(run.ran.every((entry) => entry.error === null), true);
    // agent 1: bad reply -> schema failure -> one retry (2 calls); agent 2: good first try (1 call)
    assert.equal(calls.length, 3);
    assert.ok(calls[1].includes('previous reply was rejected as invalid JSON'));
    const journal = fs.readFileSync(journalFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(journal.length, journalBefore + 1); // only agent 1 is in this journal
    assert.notEqual(ledger.snapshot('atm-aaaaaaaa').costsUsd, costsBefore);
  });

  it('gives up after two malformed replies with no charge', async () => {
    advancePastInterval();
    const researcher = createResearcher({
      broker,
      registry,
      ledger,
      config,
      paths,
      clock,
      generate: async () => ({ text: 'not json at all', provider: 'fake', model: 'fake-model' }),
    });
    const costsBefore = ledger.snapshot('atm-aaaaaaaa').costsUsd;
    const run = await researcher.tick();
    assert.equal(run.ran.length, 2);
    assert.equal(run.ran.every((entry) => /llm:/.test(entry.error ?? '')), true);
    assert.equal(ledger.snapshot('atm-aaaaaaaa').costsUsd, costsBefore);
    const journalFile = path.join(paths.researchDir, 'atm-aaaaaaaa.jsonl');
    const rows = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const after = await researcher.tick();
    assert.equal(after.ran.length, 2); // failed agents stay due and are retried next cycle
    assert.equal(fs.existsSync(journalFile) ? fs.readFileSync(journalFile, 'utf8').trim().split('\n').filter(Boolean).length : 0, rows);
  });

  it('reports disabled/unconfigured without throwing', async () => {
    const disabled = makeResearcher({ enabled: false });
    const run = await disabled.tick();
    assert.equal(run.enabled, false);
    assert.equal(run.ran.length, 0);
    assert.match(run.note, /disabled/);
    const unconfigured = createResearcher({ broker, registry, ledger, config, paths, clock, generate: null });
    const run2 = await unconfigured.tick();
    assert.equal(run2.configured, false);
    assert.equal(run2.ran.length, 0);
    assert.match(run2.note, /no LLM generator/);
  });

  it('http fallback generator: absent without a key, maps a DeepSeek response with one', async () => {
    assert.equal(createHttpResearchGenerator({ env: {}, config }), null);
    const originalFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ choices: [{ message: { content: '{"sentiment":0,"confidence":0,"verdict":"HOLD","catalysts":[],"risks":[],"summary":"x","symbols":[],"sources":[]}' } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
        },
      };
    };
    try {
      const generate = createHttpResearchGenerator({ env: { DEEPSEEK_API_KEY: 'test-key' }, config });
      const result = await generate({ system: 'sys', user: 'usr', maxTokens: 123 });
      assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
      assert.equal(captured.body.model, 'deepseek-chat');
      assert.equal(captured.body.max_tokens, 123);
      assert.equal(result.provider, 'deepseek');
      assert.equal(result.usage.inputTokens, 5);
      assert.match(result.text, /HOLD/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
