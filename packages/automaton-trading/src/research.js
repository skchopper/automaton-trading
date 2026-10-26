/**
 * RESEARCH SIDECAR — a per-agent, isolated hourly news analyst.
 *
 * Design contract: docs/RESEARCH.md.
 *
 * Each living population agent gets its own LLM briefing about ITS OWN book and news for ITS
 * symbols. The prompt is built from that agent's registry record, ledger snapshot, compiled spec,
 * news for its symbols and its own past briefings — never another agent's data, never another
 * role's memory, never a shared conversation. Each agent's journal is a separate JSONL file.
 *
 * The LLM is injected as `generate({system,user,maxTokens}) -> {text, usage}`:
 *   - inside the Harness plugin: the Host bridges to the Harness `llm` service;
 *   - headless CLI: a DeepSeek HTTP fallback (DEEPSEEK_API_KEY), or research is simply disabled.
 *
 * The researcher never places orders. The Executor consumes `latest(agentId)` as an optional gate
 * (veto/size/exit pressure); a missing or stale briefing means "trade exactly as before".
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { statePaths } from './config.js';
import {
  appendJsonl,
  createLogger,
  ensureDir,
  readJson,
  readJsonl,
  round2,
  round4,
  SYSTEM_CLOCK,
  writeJsonAtomic,
} from './util.js';

const log = createLogger('research');

const VERDICTS = ['HOLD', 'AVOID', 'ALERT'];
const MAX_CATALYSTS = 4;
const MAX_RISKS = 4;
const MAX_SOURCES = 6;
const MAX_SUMMARY = 400;
const MAX_SYMBOLS = 4;
const MAX_PRIOR_BRIEFINGS = 5;

const SYSTEM_PROMPT = [
  'You are the isolated news research analyst for exactly ONE automated trading bot.',
  'You receive only this bot\'s strategy genome, its own positions/cash, news items for its symbols,',
  'and a short digest of its own previous briefings. You have no knowledge of any other bot and you',
  'must not speculate about other bots or about the operator.',
  'You do not trade and you cannot place orders: your only output is a risk/sentiment briefing.',
  'Read the news items and assess them for THIS bot specifically (its strategy family, holding',
  'horizon and symbols). Be conservative: if the news is irrelevant, stale or ambiguous, answer',
  'HOLD with low confidence.',
  'Reply with ONE strict JSON object and nothing else (no markdown fences, no prose):',
  '{"sentiment": number between -1 and 1, "confidence": number between 0 and 1,',
  ' "verdict": "HOLD" | "AVOID" | "ALERT",',
  ' "catalysts": [up to 4 short strings], "risks": [up to 4 short strings],',
  ' "summary": "<=400 characters, factual, mention the date of the news when relevant",',
  ' "symbols": [subset of the symbols you were given],',
  ' "sources": [{"title": string, "source": string, "url": string|null, "at": ISO string}]}',
  'Rules: AVOID means "do not open a new position now"; ALERT means "existing position is at risk,',
  'consider reducing"; HOLD means "no action needed". Never give prices targets or financial advice.',
].join(' ');

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function numberOrNull(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Strip code fences / surrounding prose and parse the first complete JSON object. */
export function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') throw new Error('empty LLM reply');
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(fenced);
  } catch {
    /* fall through to brace scan */
  }
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in LLM reply');
  return JSON.parse(fenced.slice(start, end + 1));
}

function stringArray(value, max) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * Validate + clamp one raw briefing. Throws on a reply that cannot be trusted; unknown
 * fields are dropped so a crooked LLM cannot smuggle extra state into the ledger/panel.
 */
export function normalizeBriefing(raw, { symbols = [], news = [], allowExtraSymbols = false } = {}) {
  if (!isPlainObject(raw)) throw new Error('briefing is not an object');
  const sentiment = numberOrNull(raw.sentiment);
  const confidence = numberOrNull(raw.confidence);
  if (sentiment === null || confidence === null) throw new Error('briefing requires numeric sentiment and confidence');
  const verdict = String(raw.verdict ?? '').trim().toUpperCase();
  if (!VERDICTS.includes(verdict)) throw new Error(`briefing verdict must be one of ${VERDICTS.join('|')}`);
  const summary = String(raw.summary ?? '').trim().slice(0, MAX_SUMMARY);
  const allowedSymbols = new Set(symbols.map((symbol) => String(symbol).toUpperCase()));
  const rawSymbols = Array.isArray(raw.symbols) ? raw.symbols : [];
  const pickedSymbols = [];
  for (const symbol of rawSymbols) {
    const ticker = String(symbol ?? '').trim().toUpperCase();
    if (!ticker) continue;
    if (!allowExtraSymbols && allowedSymbols.size > 0 && !allowedSymbols.has(ticker)) continue;
    if (!pickedSymbols.includes(ticker)) pickedSymbols.push(ticker);
  }
  const sources = [];
  if (Array.isArray(raw.sources)) {
    for (const source of raw.sources.slice(0, MAX_SOURCES)) {
      if (!isPlainObject(source)) continue;
      const title = String(source.title ?? '').trim();
      if (!title) continue;
      sources.push({
        title: title.slice(0, 200),
        source: String(source.source ?? '').trim().slice(0, 120),
        url: typeof source.url === 'string' && /^https?:\/\//i.test(source.url) ? source.url.slice(0, 500) : null,
        at: typeof source.at === 'string' && !Number.isNaN(Date.parse(source.at)) ? new Date(Date.parse(source.at)).toISOString() : null,
      });
    }
  }
  return {
    sentiment: round4(clamp(sentiment, -1, 1)),
    confidence: round4(clamp(confidence, 0, 1)),
    verdict,
    catalysts: stringArray(raw.catalysts, MAX_CATALYSTS),
    risks: stringArray(raw.risks, MAX_RISKS),
    summary,
    symbols: pickedSymbols.length > 0 ? pickedSymbols : symbols.slice(0, MAX_SYMBOLS),
    sources,
    newsCount: news.length,
  };
}

function neutralBriefing(symbols, note, tickerSymbols = symbols) {
  return {
    sentiment: 0,
    confidence: 0,
    verdict: 'HOLD',
    catalysts: [],
    risks: [],
    summary: note,
    symbols: tickerSymbols.slice(0, MAX_SYMBOLS),
    sources: [],
    newsCount: 0,
  };
}

function compactNews(news) {
  return news.map((item) => ({
    headline: String(item.headline ?? '').slice(0, 220),
    source: String(item.source ?? '').slice(0, 60),
    at: item.createdAt ? new Date(item.createdAt).toISOString() : null,
    summary: String(item.summary ?? '').slice(0, 240),
    symbols: Array.isArray(item.symbols) ? item.symbols.slice(0, 4) : [],
    url: typeof item.url === 'string' ? item.url.slice(0, 300) : null,
  }));
}

function compactPrior(briefings) {
  return briefings.map((briefing) => ({
    at: briefing.at ?? null,
    verdict: briefing.verdict ?? 'HOLD',
    sentiment: briefing.sentiment ?? 0,
    confidence: briefing.confidence ?? 0,
    summary: String(briefing.summary ?? '').slice(0, 220),
  }));
}

/**
 * @param {{
 *   broker: object, registry: object, ledger: object, config: object,
 *   paths?: object, clock?: object, generate?: Function, logger?: object,
 * }} options
 */
export function createResearcher({ broker, registry, ledger, config, paths, clock, generate, specFor } = {}) {
  if (!broker || !registry || !ledger || !config) {
    throw new Error('createResearcher requires { broker, registry, ledger, config }');
  }
  const cfg = config.research ?? {};
  const currentClock = clock && typeof clock.now === 'function' ? clock : SYSTEM_CLOCK;
  const resolved = { ...statePaths(config), ...(paths ?? {}) };
  const researchDir = resolved.researchDir ?? path.join(resolved.stateDir, 'research');
  const stateFile = resolved.researchState ?? path.join(researchDir, 'state.json');
  const logger = log;
  const enabled = cfg.enabled !== false;
  const configured = typeof generate === 'function';
  const influence = cfg.influence === true;
  const intervalMs = Math.max(60, Number(cfg.intervalSec) || 3600) * 1000;
  const staggerMs = Math.max(0, Number(cfg.staggerSec) || 0) * 1000;
  const maxRunsPerCycle = Math.max(1, Math.min(10, Number(cfg.maxRunsPerCycle) || 3));
  const maxNews = Math.max(1, Math.min(20, Number(cfg.maxNewsPerAgent) || 6));
  const lookbackMs = Math.max(1, Number(cfg.newsLookbackHours) || 24) * 60 * 60 * 1000;
  const costPerRunUsd = Math.max(0, numberOrNull(cfg.costPerRunUsd) ?? 0);
  const maxAgeMs = Math.max(300, Number(cfg.maxAgeSec) || 7200) * 1000;
  const maxConcurrent = Math.max(1, Math.min(8, Number(cfg.maxConcurrent) || 1));
  const maxInputChars = Math.max(1000, Number(cfg.maxInputChars) || 12000);
  const maxOutputTokens = Math.max(128, Math.min(4000, Number(cfg.maxOutputTokens) || 1200));
  const logLimit = Math.max(20, Math.min(1000, Number(cfg.logLimit) || 120));
  const provider = cfg.provider ?? null;
  const model = cfg.model ?? null;

  let initialized = false;
  let startedAtMs = currentClock.now();
  /** @type {Map<string, {lastRunAt:number, latest:object|null}>} */
  const perAgent = new Map();
  let runs = 0;
  let errors = 0;
  let lastError = null;
  let lastRunAt = null;
  let lastProvider = provider;
  let lastModel = model;

  function logFile(agentId) {
    return path.join(researchDir, `${agentId}.jsonl`);
  }

  function ensureState(agentId) {
    if (!perAgent.has(agentId)) perAgent.set(agentId, { lastRunAt: 0, latest: null });
    return perAgent.get(agentId);
  }

  async function init() {
    if (initialized) return;
    await ensureDir(researchDir);
    const saved = await readJson(stateFile, null);
    if (isPlainObject(saved?.agents)) {
      for (const [agentId, entry] of Object.entries(saved.agents)) {
        perAgent.set(agentId, {
          lastRunAt: numberOrNull(entry?.lastRunAt) ?? 0,
          latest: isPlainObject(entry?.latest) ? entry.latest : null,
        });
      }
    }
    if (numberOrNull(saved?.startedAtMs) !== null) startedAtMs = numberOrNull(saved.startedAtMs);
    initialized = true;
  }

  async function saveState() {
    const agents = {};
    for (const [agentId, entry] of perAgent.entries()) agents[agentId] = entry;
    await writeJsonAtomic(stateFile, {
      version: 1,
      startedAtMs,
      lastRunAt,
      runs,
      errors,
      lastError,
      provider: lastProvider,
      model: lastModel,
      agents,
    });
  }

  /** Symbols this agent cares about: open positions first, then its spec/genome symbol. */
  function symbolsFor(agent) {
    const symbols = [];
    const add = (symbol) => {
      const ticker = String(symbol ?? '').trim().toUpperCase();
      if (ticker && !symbols.includes(ticker) && symbols.length < MAX_SYMBOLS) symbols.push(ticker);
    };
    try {
      const book = ledger.book(agent.id);
      for (const symbol of Object.keys(book?.positions ?? {})) add(symbol);
    } catch {
      /* no book yet */
    }
    add(agent?.specSymbol);
    add(agent?.genome?.symbol);
    return symbols;
  }

  function buildUserPrompt({ agent, snapshot, spec, symbols, news, prior }) {
    const book = compactPrior(prior);
    const sections = [
      `AGENT: ${agent.name ?? agent.id} (id ${agent.id}, generation ${agent.generation})`,
      `STRATEGY GENOME: ${JSON.stringify({
        family: agent?.genome?.family ?? null,
        symbol: agent?.genome?.symbol ?? null,
        lookback: agent?.genome?.lookback ?? null,
        entryZ: agent?.genome?.entryZ ?? null,
        exitZ: agent?.genome?.exitZ ?? null,
        stopPct: agent?.genome?.stopPct ?? null,
        targetPct: agent?.genome?.targetPct ?? null,
        maxHoldBars: agent?.genome?.maxHoldBars ?? null,
        sizePct: agent?.genome?.sizePct ?? null,
        sessionFilter: agent?.genome?.sessionFilter ?? null,
      })}`,
      `COMPILED SPEC: ${spec ? JSON.stringify({ symbol: spec.symbol, family: spec.family, params: spec.params ?? {} }) : 'none yet'}`,
      `BOOK: ${JSON.stringify({
        cashUsd: snapshot ? round2(snapshot.cashUsd) : null,
        positions: snapshot ? Object.fromEntries(Object.entries(snapshot.positions ?? {}).map(([symbol, position]) => [symbol, { qty: position.qty, avgPriceUsd: position.avgPriceUsd }])) : {},
        trades: snapshot?.trades ?? 0,
        realizedPlUsd: snapshot ? round2(snapshot.realizedPlUsd) : 0,
        unrealizedPlUsd: snapshot ? round2(snapshot.unrealizedPlUsd ?? 0) : 0,
      })}`,
      `SYMBOLS: ${symbols.join(', ')}`,
      `NEWS (${news.length} item(s), newest first): ${JSON.stringify(news)}`,
      `THIS BOT'S OWN PREVIOUS BRIEFINGS (oldest first, ≤${MAX_PRIOR_BRIEFINGS}): ${JSON.stringify(book)}`,
      'Return ONLY the JSON object specified in the system prompt.',
    ];
    let user = sections.join('\n');
    if (user.length > maxInputChars) user = `${user.slice(0, maxInputChars)}\n[truncated]`;
    return user;
  }

  async function readOwnPrior(agentId) {
    try {
      const rows = await readJsonl(logFile(agentId));
      return rows.slice(-MAX_PRIOR_BRIEFINGS);
    } catch {
      return [];
    }
  }

  async function trimLog(agentId) {
    try {
      const rows = await readJsonl(logFile(agentId));
      if (rows.length <= logLimit) return;
      const trimmed = rows.slice(-logLimit);
      await fsp.writeFile(logFile(agentId), `${trimmed.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    } catch {
      /* log rotation is best effort */
    }
  }

  /**
   * Research one agent. Returns a summary for the trace. Never throws.
   * @param {object} agent registry record
   * @param {number} nowMs
   */
  async function runOne(agent, nowMs) {
    const at = new Date(nowMs).toISOString();
    const outcome = { agentId: agent.id, verdict: null, sentiment: null, confidence: null, costUsd: 0, newsCount: 0, error: null };
    if (!configured) return outcome;
    const symbols = symbolsFor(agent);
    let news = [];
    try {
      if (symbols.length > 0 && typeof broker.getNews === 'function') {
        const fetched = await broker.getNews({ symbols, limit: maxNews, start: new Date(nowMs - lookbackMs).toISOString() });
        const wanted = new Set(symbols);
        news = (Array.isArray(fetched) ? fetched : [])
          .filter((item) => item && typeof item.headline === 'string' && item.headline.trim() !== '')
          // Keep only items that mention one of the agent's own symbols (or untagged general news).
          .filter((item) => {
            const itemSymbols = Array.isArray(item.symbols) ? item.symbols.map((symbol) => String(symbol).toUpperCase()) : [];
            return itemSymbols.length === 0 || itemSymbols.some((symbol) => wanted.has(symbol));
          });
        news.sort((left, right) => (numberOrNull(right.createdAt) ?? 0) - (numberOrNull(left.createdAt) ?? 0));
      }
    } catch (error) {
      outcome.error = `news: ${String(error?.message ?? error).slice(0, 160)}`;
      lastError = outcome.error;
      errors += 1;
      return outcome;
    }
    let snapshot = null;
    let spec = null;
    try {
      snapshot = ledger.snapshot(agent.id);
    } catch {
      snapshot = null;
    }
    try {
      spec = typeof specFor === 'function' ? specFor(agent.id) ?? agent.spec ?? null : agent.spec ?? null;
    } catch {
      spec = agent.spec ?? null;
    }
    outcome.newsCount = news.length;

    let briefing;
    let usedModel = model;
    let usedProvider = provider;
    let usage = null;
    let costUsd = 0;
    if (news.length === 0) {
      briefing = neutralBriefing(symbols, 'No relevant news in the lookback window; neutral HOLD.', symbols);
    } else {
      try {
        const prior = await readOwnPrior(agent.id);
        const user = buildUserPrompt({ agent, snapshot, spec: agent.spec ?? spec, symbols, news: compactNews(news), prior });
        const generated = await generate({ system: SYSTEM_PROMPT, user, maxTokens: maxOutputTokens, temperature: 0.2 });
        const text = typeof generated === 'string' ? generated : generated?.text;
        usage = generated?.usage ?? null;
        usedProvider = generated?.provider ?? usedProvider;
        usedModel = generated?.model ?? usedModel;
        const raw = extractJsonObject(text);
        briefing = normalizeBriefing(raw, { symbols, news, allowExtraSymbols: false });
        costUsd = costPerRunUsd;
      } catch (error) {
        outcome.error = `llm: ${String(error?.message ?? error).slice(0, 180)}`;
        lastError = outcome.error;
        errors += 1;
        return outcome;
      }
    }

    const record = {
      agentId: agent.id,
      name: agent.name ?? agent.id,
      at,
      atMs: nowMs,
      verdict: briefing.verdict,
      sentiment: briefing.sentiment,
      confidence: briefing.confidence,
      catalysts: briefing.catalysts,
      risks: briefing.risks,
      summary: briefing.summary,
      symbols: briefing.symbols,
      sources: briefing.sources,
      newsCount: briefing.newsCount,
      usage,
      provider: usedProvider,
      model: usedModel,
      costUsd: round4(costUsd),
    };
    try {
      await appendJsonl(logFile(agent.id), record);
      await trimLog(agent.id);
    } catch (error) {
      logger.warn('could not persist research log', { agentId: agent.id, error: String(error?.message ?? error) });
    }
    if (costUsd > 0) {
      try {
        await ledger.charge(agent.id, costUsd, {
          category: 'research',
          role: 'prospector',
          ref: `research:${at}`,
          at: nowMs,
        });
        outcome.costUsd = round4(costUsd);
      } catch (error) {
        outcome.error = `charge: ${String(error?.message ?? error).slice(0, 120)}`;
        lastError = outcome.error;
        errors += 1;
      }
    }
    const entry = ensureState(agent.id);
    entry.lastRunAt = nowMs;
    entry.latest = record;
    runs += 1;
    lastRunAt = nowMs;
    lastProvider = usedProvider;
    lastModel = usedModel;
    outcome.verdict = record.verdict;
    outcome.sentiment = record.sentiment;
    outcome.confidence = record.confidence;
    return outcome;
  }

  /** Agents whose research is due (interval + per-agent stagger). */
  function dueAgents(nowMs) {
    const alive = registry.alive();
    const due = [];
    alive.forEach((agent, index) => {
      const state = ensureState(agent.id);
      const firstDue = startedAtMs + index * staggerMs;
      const dueAt = state.lastRunAt > 0 ? state.lastRunAt + intervalMs : firstDue;
      if (nowMs >= dueAt) due.push(agent);
    });
    return due;
  }

  /**
   * One research pass. Called once per engine cycle; only agents whose hourly slot is due get a
   * briefing. Returns a compact trace summary.
   */
  async function tick() {
    await init();
    const nowMs = currentClock.now();
    if (!enabled || !configured) {
      return {
        enabled,
        configured,
        due: 0,
        ran: [],
        skipped: registry.alive().length,
        note: !enabled ? 'research disabled by config' : 'no LLM generator configured',
      };
    }
    const due = dueAgents(nowMs);
    // Cap LLM work per engine cycle: 30 hourly briefings must not block one trading cycle for
    // minutes. Due agents beyond the cap stay due and are picked up by the next cycle.
    const batch = due.slice(0, maxRunsPerCycle);
    const ran = [];
    const queue = [...batch];
    const workers = Array.from({ length: Math.min(maxConcurrent, Math.max(1, queue.length)) }, async () => {
      while (queue.length > 0) {
        const agent = queue.shift();
        // eslint-disable-next-line no-await-in-loop
        const outcome = await runOne(agent, currentClock.now());
        ran.push(outcome);
      }
    });
    await Promise.all(workers);
    await saveState();
    return {
      enabled,
      configured,
      due: due.length,
      ran,
      deferred: Math.max(0, due.length - batch.length),
      skipped: Math.max(0, registry.alive().length - due.length),
    };
  }

  /** Fresh briefing for the Executor; null when missing/stale/disabled. */
  function latest(agentId) {
    const entry = perAgent.get(agentId);
    if (!entry?.latest) return null;
    const ageMs = currentClock.now() - entry.latest.atMs;
    if (!(ageMs <= maxAgeMs)) return null;
    return {
      ...entry.latest,
      ageSec: Math.round(ageMs / 1000),
      stale: false,
    };
  }

  /** Any briefing (with `stale` flag) for the dashboard. */
  function latestAny(agentId) {
    const entry = perAgent.get(agentId);
    if (!entry?.latest) return null;
    const ageMs = currentClock.now() - entry.latest.atMs;
    return {
      ...entry.latest,
      ageSec: Math.round(ageMs / 1000),
      stale: !(ageMs <= maxAgeMs),
    };
  }

  function schedule() {
    const nowMs = currentClock.now();
    const alive = registry.alive();
    let nextDueAt = null;
    alive.forEach((agent, index) => {
      const state = ensureState(agent.id);
      const dueAt = state.lastRunAt > 0 ? state.lastRunAt + intervalMs : startedAtMs + index * staggerMs;
      if (nextDueAt === null || dueAt < nextDueAt) nextDueAt = dueAt;
    });
    return {
      enabled,
      configured,
      influence,
      intervalSec: Math.round(intervalMs / 1000),
      staggerSec: Math.round(staggerMs / 1000),
      maxRunsPerCycle,
      lastRunAt: lastRunAt === null ? null : new Date(lastRunAt).toISOString(),
      nextDueAt: nextDueAt === null ? null : new Date(nextDueAt).toISOString(),
      provider: lastProvider,
      model: lastModel,
      runs,
      errors,
      lastError,
      agents: alive.length,
    };
  }

  return { tick, latest, latestAny, schedule, init, _internals: { dueAgents, runOne, symbolsFor, SYSTEM_PROMPT } };
}

/** Default HTTP research generator for headless CLI runs (DeepSeek-compatible chat completion). */
export function createHttpResearchGenerator({ env = process.env, config, logger = log } = {}) {
  const research = config?.research ?? {};
  const apiKey = env.DEEPSEEK_API_KEY ?? env.RESEARCH_API_KEY;
  if (!apiKey) return null;
  const baseUrl = String(env.DEEPSEEK_BASE_URL ?? env.RESEARCH_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = research.model ?? env.DEEPSEEK_MODEL ?? env.RESEARCH_MODEL ?? 'deepseek-chat';
  return async function httpGenerate({ system, user, maxTokens = 700, temperature = 0.2 }) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`research LLM HTTP ${response.status}: ${text.slice(0, 180)}`);
      logger.warn('research LLM call failed', { status: response.status });
      throw error;
    }
    const body = JSON.parse(text);
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') throw new Error('research LLM returned no content');
    return {
      text: content,
      provider: 'deepseek',
      model,
      usage: {
        inputTokens: body?.usage?.prompt_tokens ?? null,
        outputTokens: body?.usage?.completion_tokens ?? null,
      },
    };
  };
}
