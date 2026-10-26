# RESEARCH SIDECAR — per-agent isolated news analyst

**Goal.** Every living population agent gets an **isolated** hourly LLM research call about *its own*
holdings/strategy. The analyst sees only that agent's data plus its own past briefings — never another
agent's book, another role's memory, or a shared conversation. The resulting briefing can veto entries,
shrink size, or force an exit. The agent pays for the research from its own ledger (Mortality
Engineering: a role must pay for its own inference).

Architecture: **A2 now** (one isolated LLM call per agent, private journal) with the journal format
designed so a bot can later be promoted to its own DeepSeek Harness agent (**A1**) without changing
anything above the `ResearchProvider` seam.

## Config (Lead-owned, `src/config.js`)

```js
research: {
  enabled: true,
  influence: true,            // false = shadow: log briefings only
  intervalSec: 3600,          // per-agent cadence
  staggerSec: 120,            // spread agents across the hour (ceil(interval/agents))
  maxRunsPerCycle: 3,         // hard cap on LLM work inside one trading cycle
  maxNewsPerAgent: 6,
  newsLookbackHours: 24,
  costPerRunUsd: 0.001,       // charged to the agent's ledger per successful briefing
  maxAgeSec: 7200,            // briefings older than this are ignored by the executor
  maxConcurrent: 1,
  maxInputChars: 12000,
  maxOutputTokens: 700,
  logLimit: 120,              // per-agent briefing log length
  provider: null,             // optional override; Harness bridge resolves the default model
  model: null,
}
```

Validation in `validateConfig`: intervalSec >= 60, maxNewsPerAgent 1..20, costPerRunUsd >= 0,
maxAgeSec >= 300, maxOutputTokens 128..4000, logLimit 20..1000, maxRunsPerCycle 1..10.

Scheduling: each agent's slots are phase-shifted by `index * staggerSec` (with 30 agents and a
3600 s interval, `staggerSec=120` spreads the hourly load to ~2–3 briefings per 5-minute cycle),
and a cycle runs at most `maxRunsPerCycle` briefings so research can never stall one trading
cycle for minutes; agents beyond the cap stay due and are picked up by later cycles.

Harness bridge note: the Host `llm` service validates dispatch by comparing the options passed to
`prepared.stream(...)` field-by-field against the frozen configuration returned by
`prepareCall(config)` — including adapter defaults materialised during preparation (e.g.
`reasoningEffort`). The bridge therefore echoes `prepared.config` back and adds only `system` and
`messages`; sending a narrower config is rejected with `INVALID_PREPARED_CALL` before any provider
request. Output budget defaults to 1200 tokens so reasoning models cannot spend the whole budget on
reasoning and return empty content.

## Broker extension (market teammate)

Both brokers gain:

```js
broker.getNews({ symbols, limit, start, end }) -> Promise<Array<{
  id: string, headline: string, summary: string, source: string, url: string|null,
  symbols: string[], createdAt: number,        // epoch ms
}>>
```

- Alpaca: `GET https://data.alpaca.markets/v1beta1/news?symbols=A,B&limit=N&start=ISO` with the usual
  headers. Map `id`, `headline`, `summary`, `source`, `url`, `symbols`, `created_at`. Filter out items
  older than `start` and empty headlines. Tolerate missing fields. Verified available on the paper keys.
- Sim broker: deterministic synthetic headlines per symbol (seeded), so tests/sim mode behave.

## Research module (Lead-owned, `src/research.js`)

```js
export function createResearcher({
  broker, registry, ledger, config, paths, clock,
  generate,                 // ResearchProvider, see below
}) => {
  tick({ prices }): Promise<{ ran: Array<{agentId, verdict, sentiment, confidence, costUsd, error?}>,
                              skipped: number, due: number }>
  latest(agentId): Briefing | null      // fresh briefing (age <= maxAgeSec) or null
  schedule(): { enabled, configured, lastRunAt, nextDueAt, provider, model }
  _internals?                // for tests
}
```

`generate` is the only LLM seam:

```js
generate({ system, user, maxTokens }) -> Promise<{ text: string, usage?: { inputTokens, outputTokens } }>
```

The plugin supplies a Harness-LLM implementation. The CLI supplies an HTTP fallback when
`DEEPSEEK_API_KEY` is set (`https://api.deepseek.com/chat/completions`, `deepseek-chat`); when neither
is available, research is disabled and reports `configured:false` (trading continues unchanged).

### Briefing schema (strict JSON reply; validated + clamped)

```js
{
  sentiment: -1..1,            // news tone for this agent's symbols
  confidence: 0..1,
  verdict: 'HOLD' | 'AVOID' | 'ALERT',
  catalysts: [string],         // max 4
  risks: [string],             // max 4
  summary: string,             // <= 400 chars
  symbols: [string],           // subset of symbols the agent asked about
  sources: [{ title, source, url, at }]   // included when present
}
```

A malformed/failed reply never crashes the cycle: it is logged with the error and no briefing is stored
(and no cost is charged). Briefing persisted fields: `{ agentId, at, interview model/provider, symbols,
newsCount, ...briefing }` appended to `state/research/<agentId>.jsonl`, latest cached in memory and in
`state/research/state.json` (lastRunAt per agent, for restart continuity).

### Isolation rules (must hold in tests)

- The prompt contains **only** this agent's id/name/genome, positions, cash/P&L, the news items for its
  symbols, and its own last ≤5 briefings.
- No other agent ids, names, positions, P&L, or shared conversation are included.
- Per-agent journal files are the only memory; two agents with identical strategies still get separate
  briefings, logs and costs.
- Research never places orders and never writes to registry/ledger except the cost charge.

### Prompt shape

- `system`: "You are the isolated news analyst for exactly one trading bot. You see only this bot's
  book and news. Reply with ONE strict JSON object per schema; no prose. You do not trade."
- `user`: compact JSON-ish sections: agent (name, strategy genome), book (positions, cash, equity,
  day/net7d), news items (headline/source/time/summary ≤ 200 chars), and the bot's own previous
  briefings (≤5). No news → return neutral HOLD sentiment 0 confidence 0 with a note.
- Determinism for tests: the module does not call Date.now/Math.random; it uses `clock`; summaries and
  logs are deterministic given the fake generator.

## Executor integration (market teammate)

`executor.run({ ..., research })` where `research` is `research.latest(agentId)` (or null). Only when
`config.research.enabled && config.research.influence` and the briefing is fresh (`maxAgeSec`):

- **Entry veto**: if verdict is `AVOID`, or sentiment <= -0.35, or risks.length >= 2 → skip the entry
  with action `type:'skip'`, `reason:'research_veto'` (never a brake denial). `ALERT` also vetoes entries.
- **Size scaling** (entries that pass): multiply the computed notional by
  `clamp(0.5 + confidence * 0.5, 0.4, 1.0)` when sentiment > 0, else `0.6`; never above the mandate cap.
- **Exit pressure** for held positions: if verdict is `ALERT` or sentiment <= -0.5 → exit with
  `reason:'research_alert'` (risk-reducing; runs in the exit pass, before entries).
- Missing/stale research or `influence:false` → behaviour exactly as today.
- Record the applied effect in `result.actions` so traces/tests can assert it.

## Orchestrator / engine (Lead)

- `createAutomaton({ ..., generate })` creates the researcher and calls `await researcher.tick()` once
  per cycle **after** the executor pass: LLM latency (up to ~1 min for the capped batch) can never
  delay an entry/exit, and a due briefing is applied by the **next** cycle's executor (briefings stay
  fresh for `maxAgeSec = 2 h`, irrelevant for hourly news). Exits, entries, brakes and P&L are
  therefore never blocked by a slow provider.
- Resilience: a malformed/truncated model reply is first **repaired** (fence strip, smart quotes,
  trailing commas, unterminated string/array/object closure) and, if it still fails schema
  validation, **retried exactly once** with an explicit "reply with one compact valid JSON object"
  instruction. A failed agent keeps its slot due, so the next cycle retries it automatically; a
  briefing is stored/charged only on success.
- Cost charging: on a successful briefing, `ledger.charge(agentId, costPerRunUsd, { category:'research',
  role:'prospector', ref:'research' })`. A failed charge (insufficient cash) marks the agent for the
  normal death path; research continues best-effort.
- Status payload: each agent row gains `research: { at, ageSec, verdict, sentiment, confidence, summary,
  risks, sources, stale } | null`; `status.engine.research` exposes `schedule()`; `automaton_agents`
  and the panel use it.
- The engine facade accepts `researchGenerate` / `researchProvider` / `researchModel` options (plugin
  supplies them). CLI builds the HTTP fallback from env; otherwise research is `configured:false`.
  Briefing records store the actual `provider`/`model` reported by the generator (the Harness bridge
  returns the resolved route), so journals/state show the real model even when config names none.

## Plugin (plugin teammate)

- `index.js`: build the Harness-LLM `generate` bridge and pass it into `createEngine({ researchGenerate })`.
  Resolve provider/model from `ctx.get('agentDefaultModel')?.currentSelection()` (fallback: first
  `llm.listProviders()` + `llm.listModels()`); call `llm.prepareCall(...)`, `stream(...)`, concatenate
  `text-delta`, return `{text, usage}` from the `usage` chunk. Never throw into the engine: return an
  error result the researcher logs.
- `client.js`: show research per agent — table badge (verdict/sentiment), detail pane section with last
  briefing (summary, catalysts/risks, sources with links, age, model), and a "shadow vs influence"
  indicator from `status.engine.research`.
- `test/plugin.test.js`: bridge mapping (fake llm), status/panel mapping helpers, no secrets.

## Economics / safety

- ~$0.001 per agent-hour (~$0.72/day for 30 agents if all research hourly) charged to the agents,
  raising their burn exactly like a real inference bill.
- Research is advisory: no new dangerous capability. The executor still passes every order through the
  14 brakes; the research analyst has no order tool, no wallet access, and no shared memory.
- If the LLM is unavailable, trading continues deterministically; briefings go stale and are ignored.
