# CONTRACTS — build interfaces (source of truth for parallel work)

Package root: `D:\CounterStikers\packages\automaton-trading\`
Stack: **ESM JavaScript (`.js`), Node ≥ 22, zero runtime dependencies** (global `fetch`).
Style: JSDoc type comments, `export function`/`export async function`, explicit error codes.
Tests: `node --test` (`test/*.test.js`), no test framework installs. Run: `node --test`.

## File layout / ownership

```
packages/automaton-trading/
  package.json            plugin manifest (Lead scaffolds, plugin teammate owns)
  cordis.patch.yml        bundle patch (plugin teammate)
  index.js                Host plugin: tools + status route + engine wiring (plugin teammate)
  client.js               Client UI module (plugin teammate)
  locale/en.json zh.json icon.svg (plugin teammate)
  src/contracts.js        constants, error class        (Lead)
  src/util.js             helpers                      (Lead)
  src/config.js           defaults/load/validate/secrets (Lead)
  src/orchestrator.js     cycle loop composition        (Lead)
  src/engine.js           facade for plugin + CLI       (Lead)
  src/journal.js          obituaries + lessons digest   (mortality teammate)
  src/ledger.js           per-agent virtual ledger      (mortality teammate)
  src/registry.js         population registry           (mortality teammate)
  src/brakes.js           pre-trade hard denials        (mortality teammate)
  src/treasurer.js        metabolism/runway/mandates    (mortality teammate)
  src/replicator.js       spawn + mutation              (mortality teammate)
  src/reaper.js           kill logic                    (mortality teammate)
  src/reaper-process.js   external process entry        (mortality teammate)
  src/broker-alpaca.js    Alpaca REST client            (market teammate)
  src/broker-sim.js       simulated broker + market     (market teammate)
  src/prospector.js       hypotheses w/ dated proof     (market teammate)
  src/builder.js          hypothesis -> StrategySpec    (market teammate)
  src/executor.js         order placement + exits       (market teammate)
  src/simulate.js         accelerated population sim    (market teammate)
  bin/automaton.mjs       CLI                           (Lead)
  test/*.test.js          node:test suites              (each owner + verifier)
```

**Never edit a file owned by another teammate.** Both sides call through the interfaces below.
If an interface is insufficient, report it to the Lead instead of changing the contract unilaterally.

## Error convention

`src/contracts.js`:

```js
export class AutomatonError extends Error {    // code is a stable machine string
  constructor(code, message, details = {}) { ... }
}
export function fail(code, message, details) { throw new AutomatonError(code, message, details) }
export function assert(condition, code, message, details) { ... }
```

Codes (stable, used in tests and UI): `CONFIG_INVALID`, `MODE_FORBIDDEN`,
`LIVE_NOT_ARMED`, `KILL_SWITCH`, `BRAKE_DENIED`, `NO_PROOF`, `PROOF_STALE`,
`SPEC_INVALID`, `BUDGET_EXCEEDED`, `REPLICATION_DENIED`, `POPULATION_CAP`,
`UNKNOWN_AGENT`, `AGENT_DEAD`, `BROKER_ERROR`, `BROKER_AUTH`, `BROKER_RATE_LIMIT`,
`DATA_MISSING`, `RECONCILIATION_MISMATCH`, `ACCOUNT_NOT_ACTIVE`, `NOT_IMPLEMENTED`.

## Shared constants (`contracts.js`)

```js
export const MODES = ['sim', 'paper', 'live'];
export const TREASURY_STATES = ['STABLE', 'TIGHT', 'CRITICAL', 'DEAD'];
export const DEATH_CAUSES = ['insufficient_funds', 'drawdown_limit', 'daily_loss_limit',
  'account_not_active', 'reconciliation_mismatch', 'risk_breach'];
export const AGENT_STATUS = ['alive', 'dead'];
export const ROLES = ['treasurer', 'prospector', 'builder', 'executor', 'replicator', 'reaper'];
export const BRAKE_CODES = { /* D1_...: description */ };
```

## Config (`src/config.js`)

```js
export const DEFAULT_CONFIG = { /* see below */ };
export function loadConfig({ configFile, envFile, overrides, env } = {})
  // -> { config, secrets, sources }
  // merges DEFAULT_CONFIG <- configFile JSON <- overrides (plugin row) <- env overrides
  // throws CONFIG_INVALID on bad values; never stores secrets in config
export function validateConfig(config) // -> config or throws
export function publicConfig(config)   // -> deep-cloned config with secrets paths only, no key material
export function resolveCredentials(config, secrets, env)
  // -> { keyId, secretKey, baseUrl, dataBaseUrl, mode, source }
  // paper -> paper-api.alpaca.markets, live -> api.alpaca.markets (+ LIVE_ARMED requirement)
export function statePaths(config) // -> { stateDir, registry, ledger, journal, hypotheses,
  //      specsDir, traces, stateFile, killSwitch, liveArmed, configFile, envFile }
export function liveArmed(config) // -> boolean
```

Defaults (paper / $100k account):

```js
{
  mode: 'paper', allowLive: false,
  account: { allocationCapPct: 0.8, reconciliationTolerancePct: 0.02 },
  symbols: ['AAPL','MSFT','NVDA','AMD','META','AMZN','GOOGL','TSLA','SPY','QQQ'],
  cycleIntervalSec: 300, reaperIntervalSec: 30,
  population: { initial: 3, cap: 10 },
  endowmentUsd: 5000, deathFloorUsd: 250, deathFloorPct: 0.05, maxDrawdownPct: 0.25,
  burn: { inferencePerCycleUsd: 0.03, dataPerCycleUsd: 0.005, hostingPerHourUsd: 0.001,
          committedMonthlyUsd: 0 },
  cycleBudget: { STABLE: 0.08, TIGHT: 0.03, CRITICAL: 0.01 },
  replication: { surplus7dUsd: 150, minRunwayHours: 72, childEndowmentUsd: 2500 },
  risk: { maxPositionPct: 0.25, maxOpenPositions: 3, maxDailyOrders: 6,
          maxDailyLossPct: 0.05, maxOrderNotionalUsd: 0.5, // x endowment? -> see note
          minOrderNotionalUsd: 1, maxSpreadBps: 25, minPriceUsd: 5,
          maxSlippageBps: 30, allowShort: false, allowMargin: false, allowOptions: false,
          extendedHours: false, sessionWindow: ['09:35','15:50'],
          maxOrdersPerCycle: 1, maxBuildSpendPct: 0.4 },
  data: { timeframe: '1Hour', lookbackBars: 120, maxHypothesesPerCycle: 3, maxProofAgeDays: 7 },
  paths: { stateDir: '<workspace>/automaton-data', envFile: '<workspace>/.env' },
  engine: { autoStart: false, traceLimit: 2000 }
}
```

Note on notional: `maxOrderNotionalUsd` is expressed as *fraction of agent equity*,
field name `maxOrderPctOfEquity` (0.25 default) plus absolute `maxOrderNotionalUsd`
(2500 default). Both caps apply. Implement both in config.

Environment overrides: `AUTOMATON_MODE`, `AUTOMATON_STATE_DIR`, `AUTOMATON_ENV_FILE`,
`AUTOMATON_AUTO_START`, `AUTOMATON_CYCLE_SEC`, `AUTOMATON_POPULATION_CAP`,
`AUTOMATON_ENDOWMENT_USD`, `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`,
`ALPACA_PAPER_API_KEY_ID`/`ALPACA_PAPER_API_SECRET_KEY`,
`ALPACA_LIVE_API_KEY_ID`/`ALPACA_LIVE_API_SECRET_KEY`.

## Broker interface (both `broker-alpaca.js` and `broker-sim.js`)

```js
export function createBroker(config, { secrets = {}, fetchImpl = globalThis.fetch, seed, accountEquityUsd } = {})
// -> broker. Alpaca: call resolveCredentials(config, secrets) from src/config.js.
// sim: seed (default 7), accountEquityUsd (default 100000) — deterministic synthetic market.
// kind: 'alpaca' | 'sim'; mode: 'paper'|'live'|'sim'
broker.getClock() -> { isOpen, timestamp, nextOpen, nextClose }
broker.getAccount() -> { equityUsd, cashUsd, buyingPowerUsd, status, currency, mode, raw? }
broker.getPositions() -> [{ symbol, qty, avgEntryPriceUsd, marketValueUsd, unrealizedPlUsd }]
broker.getOrders({ status = 'all', limit = 100, after } = {}) -> [{ id, clientOrderId, symbol, side,
    qty, filledQty, avgFillPriceUsd, status, submittedAt }]
broker.submitOrder({ symbol, side, qty, type = 'market', limitPrice, clientOrderId,
    timeInForce = 'day' }) -> order (same shape as getOrders item)
broker.cancelOrder(id) -> { id, status }
broker.getBars({ symbols, timeframe, limit }) -> { [symbol]: [{ t, o, h, l, c, v }] }
broker.getLatestQuote(symbol) -> { symbol, bid, ask, ts }
broker.getDayBars(symbol, { limit }) -> same as getBars subset (optional helper)
// FORBIDDEN to implement: transfers, withdrawals, ACH, crypto, account configuration,
// margin enablement. Their absence is the D1 wall.
```

`broker-alpaca.js` requirements: `fetch`-based, `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY`
headers, base URLs from `resolveCredentials`, JSON errors mapped to `AutomatonError`
(`BROKER_AUTH` on 401/403, `BROKER_RATE_LIMIT` on 429 with retry-after awareness,
`BROKER_ERROR` otherwise), request timeout via `AbortSignal.timeout(15000)`, one
built-in retry for 429/5xx, ISO/epoch handling, fractional qty support,
`getBars` supports multiple symbols (Alpaca multi-symbol query) and returns bars with
ISO timestamps parsed to epoch ms and numbers parsed to float.

`broker-sim.js`: deterministic synthetic market (seeded `mulberry32`), plausible OHLCV
hourly bars with regimes, configurable commission/slippage, instant fills at next open,
cash & positions accounting, `getClock` always open (sim), `setMarket(seed)` helper for
tests. Must expose `broker.setQuoteOverrides()` for deterministic tests.

## Data feed / market helpers (market teammate)

`prospector.js`:

```js
export function createProspector({ broker, config, journal, clock })
  .run({ budgetUsd }) -> {
      at, dataCalls, spentUsd,
      hypotheses: [{
        id, createdAt, symbol, family: 'momentum'|'meanrev'|'breakout'|'gapfade',
        claim,                       // one sentence: what is being bought/sold and why
        proof: { vendor: 'alpaca', url, observedAt, metric, stats: { meanBps, sampleSize,
                 baselineBps, tStat? }, sampleSize, barsUsed },
        expectedEdgeBps, horizonBars, rankScore, specsHint: { ... }
      }],
      rejected: [{ reason, detail }]
    }
```

Rules: ≤ `maxHypothesesPerCycle`; proof must be dated within `maxProofAgeDays` and
contain a data URL + measured stat; never returns orders or sizing; sorted by
`rankScore` desc (`expectedEdgeBps / estimated cost`). Hypothesis queue persists at
`paths.hypotheses` (`state/hypotheses.json`) and append-only `state/hypotheses.jsonl`.

`builder.js`:

```js
export function createBuilder({ config, brakes })
  .compile({ hypothesis, agentId, cycleBudgetUsd })
    -> { spec, spentUsd } | throws AutomatonError(NO_PROOF|PROOF_STALE|BUDGET_EXCEEDED|SPEC_INVALID)

spec = { specId, hypothesisId, agentId, symbol, family, createdAt, proofRef,
         params: { lookback, entryZ, exitZ, stopPct, targetPct, maxHoldBars, sizePct, sessionFilter },
         budgetUsedUsd }
```

Rules: refuses hypotheses without valid proof; enforces parameter bounds; never changes
symbol/family selected by the Prospector; spends ≤ `maxBuildSpendPct` of cycle budget.

`executor.js`:

```js
export function createExecutor({ broker, brakes, ledger, config, clock })
  .run({ agent, spec, mandate, quotes, dayStats, now })
    -> { agentId, actions: [{ type:'entry'|'exit'|'hold'|'skip', symbol, side?, qty?,
            reason, orderId?, fillPriceUsd? }], orders, denied: [{ code, reason }], spentUsd }
```

Rules: every order calls `brakes.checkOrder()` first and rejects with its code; only uses
`broker.submitOrder/cancelOrder/getOrders` and `ledger.book(agentId)` (positions +
openOrders) — never `broker.getAccount`; exits: stop/target/maxHold; sizing from
`sizePct * mandate.sizeBudgetUsd` capped by brakes; qty rounded to 4 decimals,
min notional enforced; `clientOrderId = atm:<agentId>:<specId>:<seq>`.

## Mortality modules (mortality teammate)

`journal.js`

```js
export function createJournal({ paths, config })
  .append(obituary) -> void                 // validates required fields, appends JSONL
  .list({ limit = 50, offset = 0 } = {}) -> [obituary]   // newest first
  .count() -> number
  .causes() -> { cause: count }
  .stats() -> { total, alive, medianLifespanHours, meanLifespanHours, firstProfitRate,
                revenuePositiveRate, medianGeneration, mostCommonCause, mostCommonLine }
  .lessonsFor(genome, { limit = 20 } = {}) -> [string]   // human-readable lessons from similar deaths
```

`obituary` shape (all required unless noted):

```js
{ agentId, parentId, generation, bornAt, diedAt, lifespanHours,
  endowmentUsd, finalEquityUsd, revenueUsd, spendUsd, netPlUsd,
  genome, mutation, productsShipped: 0, tradesCount, firstProfitAt: null|iso,
  strategySpecId, cause, lastRunwayHours, lessons: [] }
```

`ledger.js`

```js
export function createLedger({ paths, config, clock })
  .ensureAgent(agentId, { endowmentUsd, at }) -> ledgerRecord
  .get(agentId) -> ledgerRecord
  .book(agentId) -> { agentId, positions: {sym:{qty,avgPriceUsd,openedAt}}, openOrders: [] }
  .charge(agentId, amountUsd, { category, role, ref, at }) -> { balanceUsd, record }
  .applyFill(agentId, { symbol, side, qty, priceUsd, at, orderId }) -> { realizedPlUsd, position }
  .transfer(fromId, toId, amountUsd, { reason, at }) -> void   // used by Treasurer/Replicator only
  .grant(agentId, amountUsd, { reason, at }) -> void           // initial funding from treasury pool
  .equity(agentId, prices) -> { equityUsd, cashUsd, positionsValueUsd, unrealizedPlUsd }
  .snapshot(agentId) -> { cashUsd, positions, realizedPlUsd, unrealizedPlUsd, costsUsd,
       grossSpendUsd, grossRevenueUsd, trades, net7dUsd, firstProfitAt }
  .roleCosts(agentId) -> { role: usd }
  .pool() -> { poolUsd, allocatedUsd, totalUsd }
  .save(), .load()
```

Ledger invariants: `ensureAgent` creates the record with `cashUsd = 0` (it records the declared
endowment, it does NOT add cash); cash enters only through `grant` (genesis funding) or
`transfer` (child funding from parent, reaper residual sweep to `'__treasury__'`); cash + positionsValue = equity per agent;
sum(agent equity) + poolUsd may differ from broker equity only by mark-price noise
(reconciled by Treasurer); no negative cash allowed (`INSUFFICIENT_CASH` → rejected order);
fills update cash and realized P&L; `net7dUsd = realized + unrealized − costs` over trailing 7 days.
The synthetic `'__treasury__'` account is created lazily for sweeps/pool accounting.

`registry.js`

```js
export function createRegistry({ paths, config })
  .load(), .save()
  .all() -> [agent], .alive(), .dead(), .get(id), .population() -> number, .cap -> number
  .register(agent) -> agent            // throws POPULATION_CAP
  .update(id, patch) -> agent
  .markDead(id, { cause, at, finalEquityUsd }) -> agent   // one-way; throws AGENT_DEAD if already dead
  .generationStats() -> { [gen]: { born, alive, dead, survivalRate, medianLifespanHours } }
  .nextId() -> 'atm-<8 hex>'
```

Agent record:

```js
{ id, parentId: null|string, generation, bornAt, status: 'alive'|'dead',
  endowmentUsd, genome, mutation: null|{ field, from, to }, specId: null|string,
  lastCycleAt: null|iso, diedAt: null|iso, cause: null|string, notes: [string] }
```

`brakes.js`

```js
export function createBrakes({ config, paths, clock })
  .checkOrder({ mode, now, agentId, dayStats, quote, order: { symbol, side, qty, priceUsd,
      notionalUsd }, equityUsd, positions, mandate, spec, accountEquityUsd,
      allocatedEquityUsd, spreadBps }) -> { decision: 'ALLOW'|'DENY', code, rule, reason }
  .assertKillSwitchClear() -> void        // throws KILL_SWITCH
  .isLiveArmed() -> boolean
  .describe() -> [{ id, rule, description, enforcement }]
```

`dayStats` per agent: `{ dayKey, ordersCount, startEquityUsd, pnlUsd }`.
Mandate shape (issued by Treasurer): `{ agentId, issuedAt, expiresAt, state, sizeBudgetUsd,
maxOrderNotionalUsd, maxDailyOrdersRemaining, allowedSymbols, allowExitOnly }`.

`treasurer.js`

```js
export function createTreasurer({ broker, ledger, registry, journal, config, paths, clock })
  .tick({ prices, dayStats } = {}) -> {
      at, mode, account: { equityUsd, cashUsd, buyingPowerUsd, status },
      state, burnPerHourUsd, runwayHours, cycleBudgetUsd,
      surplus7dUsd, mayReplicate, populationCapRemaining,
      allocatedUsd, poolUsd, reconciliation: { ok, deltaUsd, toleranceUsd },
      mandates: { [agentId]: mandate },
      agentViews: [{ agentId, generation, equityUsd, cashUsd, positionsValueUsd,
                     runwayHours, state, drawdownPct, dayPnlPct, net7dUsd,
                     ordersToday, roleCosts, positions }],
      verdicts: [{ agentId, cause, finalEquityUsd, at }],
      halted: boolean, haltReasons: []
    }
  .grantInitial(agentId, amountUsd) -> void
  .fundChild(parentId, childId, amountUsd) -> void
  .async reconcile() -> { ok, deltaUsd }
```

Rules: only role reading `broker.getAccount()`; never orders; death verdicts written to
`state/deaths.json` for the Reaper to pick up (but the Reaper re-derives, never trusts);
`halted` blocks all new orders (existing exits still permitted: `mandate.allowExitOnly`).

`replicator.js`

```js
export const MUTABLE = { /* field: (value, rng) => newValue */ };
export function createReplicator({ treasurer, registry, ledger, journal, config, clock })
  .async spawn(parentId, treasuryGate) -> { child, mutation, lessonCount }
```

`treasuryGate` = the object returned by `treasurer.tick()` (uses `mayReplicate`,
`surplus7dUsd`, `runwayHours`). Throws `REPLICATION_DENIED`/`POPULATION_CAP`.

`reaper.js`

```js
export function createReaper({ broker, registry, ledger, journal, config, paths, clock })
  .async sweep({ prices } = {}) -> {
      at, killed: [{ agentId, cause, finalEquityUsd, liquidated: [...], orders: [...] }],
      checked, skipped: [{ agentId, reason }] }
```

Kill sequence: independently derive death (equity from broker + ledger marks, not
`deaths.json`), cancel open orders for the agent, submit market sell for each position
(market-hours guard: if market closed, mark dead and queue liquidation — liquidation
allowed outside RTH only with `timeInForce` day order at next open; never leave a dead
agent trading), transfer residual virtual cash to `__treasury__`, `registry.markDead`,
`journal.append(obituary)`. `grace = 0`. Must be idempotent.

`reaper-process.js`: standalone entry, `node src/reaper-process.js --state-dir <dir>
[--once]`, loads config from `<state-dir>/config.json` + env, creates broker, loops
`sweep()` every `reaperIntervalSec`, appends `state/reaper.log` JSONL progress, exits
code 0 on `--once`. It is launched by the plugin as a detached child process; the
engine has no handle to signal or stop it.

## Orchestrator (Lead)

```js
export async function createAutomaton({ config, paths, broker, clock }) -> {
  async tick() -> trace { tickId, at, durationMs, treasury, prospector, builds, executions,
                          replication, deaths, halted },   // also persists trace + state.json
  async init() { ensure dirs, load registry/ledger/journal, seed initial population if empty }
  async start() / async stop() / isRunning()
  async status() -> { engine: { running, mode, lastTickAt, ticks, errors }, treasury, account,
                      population: { total, alive, dead, byGeneration }, agents: [agentViews],
                      obituaries: { total, causes } }
  async obituaries({ limit }) -> journal.list()
  async simulate({ cycles, population, seed }) -> simulate.run()
  brakesView()
  configView()
}
```

## Plugin (plugin teammate)

`index.js` — Host plugin bundle:

```js
export const name = 'automaton-trading';
export const inject = ['tools'];
export function apply(ctx, config) { /* tools + status route + engine lifecycle via ctx.effect */ }
```

Tool names + one-line contracts (all return JSON):

- `automaton_status` — status snapshot (mode, account, treasury, population, last tick).
- `automaton_start` — start engine loop (refuses live unless armed).
- `automaton_stop` — stop engine loop (does not stop Reaper process).
- `automaton_tick` — run exactly one cycle now.
- `automaton_agents` — population list with genome/equity/runway/state.
- `automaton_obituaries` — journal view (`limit`, `cause` filter).
- `automaton_brakes` — brake rules + a dry-run pre-trade check (`symbol`, `side`, `notionalUsd`, `agentId`).
- `automaton_simulate` — accelerated mortality simulation (`cycles`, `population`, `seed`) → survival stats.
- `automaton_config` — effective redacted config.
- `automaton_emergency_stop` — halt engine + arm kill switch (requires `confirm: "STOP"`).

Status route: `GET /automaton/state` → same JSON as `automaton_status` (no secrets).
Client UI: read `references/ui-plugin.md`, register a panel in a slot with room
(`settings.plugins.tab` page preferred, `conversation.composer.dock` compact strip optional).
Poll `/automaton/state`; show mode badge, account equity, population (alive/dead),
runway bars per agent, treasury state, recent obituaries, kill-switch state.
