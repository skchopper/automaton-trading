# VERIFICATION — INDEPENDENT review of AUTOMATON TRADING

Verifier: independent verifier teammate (`verifier`), not an author of any module under test.
Date: 2026-10-25 (Asia/Hong_Kong). Host: Windows, Node **v22.18.0**, DSH file sandbox
`workspace-write`, **no network**, no Alpaca credentials installed.
Package: `packages/automaton-trading` (`@local/automaton-trading`).

Scope of the verifier: read `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`,
`docs/RUNBOOK.md`, every module in `src/`, `index.js`/`client.js` and the three builder test
suites, then write **only** `test/integration.test.js`, `test/security.test.js` and this file.
No module under test was edited by the verifier; defects were reported with file:line and a
minimal repro and are listed with their fix status in §4.

This document is the verification record: what was checked, how to reproduce it, the exact
results, the defects that were found (and their fix status), and what remains **unverified**.
It is written to be re-runnable; every claim below maps to a test in
`test/integration.test.js` or `test/security.test.js` (verifier-owned) or to one of the three
builder suites (`test/mortality.test.js`, `test/market.test.js`, `test/plugin.test.js`).

---

## 1. Reproduce

The sandbox blocks `node --test test/` (the runner's child-process isolation hits spawn EPERM), so
every suite is run **directly in a fresh Node process** from the package root:

```powershell
cd D:\CounterStikers\packages\automaton-trading

node test/mortality.test.js      # mortality core (builder-owned)
node test/market.test.js         # market side (builder-owned)
node test/plugin.test.js         # Host plugin + client registration (builder-owned)
node test/integration.test.js    # verifier: end-to-end sim + paper-mode death ownership + engine facade
node test/security.test.js       # verifier: adversarial live gating / D1-D14 / secrets / reaper / cap
```

The Lead's fix-verification script was also run independently and passes 15/15:

```powershell
cd D:\CounterStikers
node scripts/verify-fixes.mjs
```

> **Important on "authority":** the already-installed Harness plugin process caches the old JS
> modules until the DSH app is restarted, so a live GUI/tool call can still execute pre-fix code.
> The suites above run in fresh Node processes against the workspace sources and are therefore
> the authoritative test of the fixed code. Nothing in the Harness profile was modified by the
> verifier.

---

## 2. Result table (exact counts, fresh runs)

| # | Suite | Tests | Pass | Fail | TODO | Wall clock | Verdict |
|---|-------|------:|-----:|-----:|-----:|-----------|---------|
| 1 | `test/mortality.test.js` | 55 | 55 | 0 | 0 | 0.31 s | **PASS** |
| 2 | `test/market.test.js` | 21 | 21 | 0 | 0 | 0.20 s | **PASS** |
| 3 | `test/plugin.test.js` | 12 | 12 | 0 | 0 | 0.17 s | **PASS** |
| 4 | `test/integration.test.js` (verifier) | 21 | 20 | 0 | 1 | 0.51 s | **PASS (1 known gap documented)** |
| 5 | `test/security.test.js` (verifier) | 41 | 41 | 0 | 0 | 0.35 s | **PASS** |
| | **Total** | **150** | **149** | **0** | **1** | ~1.6 s | |

`TODO` is `node:test`'s expected-failure marker: the single TODO is a real residual gap
(§6 R1), not a flaky/ignored test. All five processes exit with code 0.

### 2.1 Verifier integration suite — per-test results

| Test (file `test/integration.test.js`) | Result |
|---|---|
| end-to-end (mode=sim): seeds genesis population from config (3 alive, gen 0, deterministic genomes, funded) | PASS |
| end-to-end (mode=sim): charges metabolism every cycle, attributes by role, burn matches formula | PASS |
| end-to-end (mode=sim): Treasurer mandates, runway, reconciliation, cycle budget, no halt | PASS |
| end-to-end (mode=sim): records executions and places orders through the brake wall with attributable ids | PASS |
| end-to-end (mode=sim): verdict + in-process sim execution + schema-valid generation-0 obituary | PASS |
| end-to-end (mode=sim): persists trace + state.json every cycle and durable registry/ledger/journal | PASS |
| end-to-end (mode=sim): ledger invariants (no negative cash, cash+positions=equity, broker agreement) | PASS |
| end-to-end (mode=sim): status surface honest; brake dry-run traverses the chain (D9 proof included) | PASS |
| end-to-end (mode=sim): replication gate, exactly one mutation, gen+1, inherited lessons, no money creation | PASS |
| end-to-end (mode=sim): kill switch blocks the cycle/orders; Reaper still closes risk; gate-vs-drawdown finding | PASS |
| end-to-end (mode=sim): no engine-side Reaper control surface; no in-engine death outside sim | PASS |
| death ownership (mode=paper): engine never executes the verdict and does not trust `deaths.json` | PASS |
| death ownership (mode=paper): independent Reaper (fresh state instances) executes and persists the death | PASS |
| death ownership (mode=paper): engine re-syncs from disk; killed agent never traded again, no duplicate obituary | PASS |
| daily_loss_limit: fires from real P&L (not hardcoded zero) | PASS |
| daily_loss_limit: KNOWN GAP — a daily_loss_limit death is frozen; Reaper only re-derives equity causes | **TODO (R1)** |
| engine facade: status/configView/brakesView/obituaries never construct the engine or start trading | PASS |
| engine facade: no way to stop/disable/re-arm the external Reaper | PASS |
| engine facade: probe reads account/clock without starting the population or leaking secrets | PASS |
| engine facade: tick() runs one cycle, leaves loop stopped, status ticks immediately correct | PASS |
| engine facade: emergencyStop arms kill switch, next cycle refused, clear removes it | PASS |

### 2.2 Verifier security suite — per-test results

| Test (file `test/security.test.js`) | Result |
|---|---|
| live gating: refuses live without mode=live + allowLive + LIVE_ARMED | PASS |
| live gating: live endpoint only when fully armed; paper never consumes live keys/endpoint | PASS |
| live gating: brokers send traffic to their own mode endpoint; keys only in headers | PASS |
| live gating: unarmed live broker performs no network request at all | PASS |
| live gating: engine.start refuses to launch live until armed | PASS |
| live gating: plugin `automaton_start` refuses live without LIVE_ARMED | PASS |
| broker D1: neither broker exposes transfer/withdraw/ACH/wire/crypto/account-config methods | PASS |
| broker D1: the Alpaca client has exactly one write endpoint family (order create/cancel) | PASS |
| broker D1: client source implements no transfer/withdrawal/ACH/crypto endpoint | PASS |
| secrets: env-file credentials absent from engine status/configView/probe/brakes/obituaries | PASS |
| secrets: `publicConfig` redacts secret-looking keys and nested secret containers | PASS |
| secrets: plugin tools + HTTP route scrub credential-shaped data and error messages | PASS |
| kill switch: brakes deny with KILL_SWITCH, before any other rule; assertKillSwitchClear throws | PASS |
| kill switch: calling the Executor directly places nothing | PASS |
| kill switch: whole automaton cycle halted before spending | PASS |
| Reaper D12: no engine facade/tool can stop/disable the Reaper | PASS |
| Reaper D12: CLI accepts only `--state-dir`/`--once`/`--help` | PASS |
| Reaper D12: reaper-process refuses a sim-mode state dir (no wrong-venue kills) | PASS |
| Reaper D12: kill durable across fresh load (no resurrection), idempotent, only `sweep()` exists | PASS |
| Reaper D12: no config flag disables the Reaper | PASS |
| D14: registry API/module exports contain no revival path | PASS |
| D14: markDead irreversible; no status patch; dead agent cannot be updated; survives reload | PASS |
| D10: registry refuses registration at the cap (living only); death frees a slot | PASS |
| D10: replicator refuses a birth at the cap even with an open Treasurer gate | PASS |
| D10: running engine never exceeds the configured cap | PASS |
| D10: config validation rejects initial > cap | PASS |
| D1 TRANSFER_FORBIDDEN | PASS |
| D2 MARGIN_FORBIDDEN | PASS |
| D3 MARKET_CLOSED | PASS |
| D4 INSTRUMENT_FORBIDDEN | PASS |
| D5 SIZE_FORBIDDEN | PASS |
| D6 RATE_FORBIDDEN | PASS |
| D7 LOSS_LIMIT (fatal, not a pause; enforced as Treasurer death verdicts) | PASS |
| D8 LIVE_NOT_ARMED / MODE_FORBIDDEN | PASS |
| D9 NO_PROOF / PROOF_STALE | PASS |
| D10 REPLICATION_FORBIDDEN / POPULATION_CAP | PASS |
| D11 KILL_SWITCH | PASS |
| D12 REAPER_ISOLATED | PASS |
| D13 ALLOCATION_FORBIDDEN | PASS |
| D14 RESURRECTION_FORBIDDEN | PASS |
| catalogue is exactly the 14 documented brakes with unique ids/codes | PASS |

---

## 3. What was actually verified (by claim)

### 3.1 Metabolism, runway, death
- Genesis population is seeded from `population.initial`, generation 0, deterministic genomes
  (`symbols[0..2]` × `momentum/meanrev/breakout`), each funded with `endowmentUsd` through
  `grant` (declared ≠ funded; cash really exists). Test: *seeds the genesis population*.
- Every cycle charges hosting/data/inference, **attributed by role** (`prospector`, `builder`,
  `executor`, `treasurer`) and the per-cycle debit now equals the burn formula
  `inference + data + hosting*(cycleInterval/3600)` to 1e-6 (`0.03508333/cycle` with the test
  config). Tests: *charges metabolism…*, *burn matches formula*.
- Equity decomposes exactly: `equity − endowment = realized + unrealized − costs` (± $0.05
  rounding). Runway is reported as hours from `(equity − floor)/burn`, never raw balance.
- Treasurer issues one mandate per living agent (expiry, size budget, allowed symbols,
  daily-order remainder), computes portfolio burn/runway/cycle budget ($0.08 STABLE),
  reconciliation against broker equity (ok, delta = ledger-only cycle costs), and stays
  un-halted and non-replicating while unhealthy. Test: *Treasurer prices the population*.
- Death is a **verdict request**: the engine writes `deaths.json`, marks the agent condemned and
  stops charging/trading it. The Reaper independently re-derives death, liquidates, sweeps the
  residual, marks dead, writes one obituary. In `mode=sim` (demo only) the engine executes the
  verdict in-process and reports `deathsExecuted`; in `mode=paper` the engine must not execute
  and does not (verified with a separate Reaper built on freshly-loaded state modules, i.e. the
  way the external process sees the world). Tests: *verdict + in-process sim execution*,
  *death ownership (mode=paper)* ×3.
- Obituary satisfies `validateObituary` and the documented 20 fields, including
  `firstProfitAt: null`, correct endowment/final equity/`netPlUsd`, generation 0 (fixed), and
  `lessonsFor(genome)` returns at least one lesson. Journal statistics aggregate causes/rates.

### 3.2 The six roles and the stoplines
- Execution attributes every fill via `client_order_id = atm:<agentId>:<specId>:<seq>`; the
  broker order count equals the sum of per-cycle trace orders; every referenced spec file exists.
- Executor never reads account equity: exercised through the real modules in the integration
  happy path and by the brake wall tests; `broker.getAccount` is only called by Treasurer/Reaper.
- Prospector supplies dated proof (URL + observedAt + measured stats); Builder compiles without
  choosing symbol/family and stores `proofRef`; D9 order-time check requires the proof.
- Replicator: birth only when the Treasurer gate is open, exactly **one** genome field mutates,
  the child gets `generation = parent+1` (genesis 0 → child 1 after the fix), genome inherited
  plus one mutation, and `lessonsFor(childGenome)` from the journal (the child's `notes` contain
  the prior death lesson). Endowment is transferred from the parent's cash only; the virtual
  total does not increase (no money creation). Tests: *replication…*.

### 3.3 Durability and the external Reaper (the critical defect area)
- After the fixes, a Reaper kill is persisted (`registry.json` status `dead`, `ledger.json` cash
  swept to 0, obituary JSONL appended) and **survives a fresh load** — no resurrection. The
  external process entry also saves after each sweep. Test: *kill durable across fresh load*.
- The engine re-syncs `registry.load()`/`ledger.load()` at the start of every cycle, prunes the
  condemned set for agents now dead on disk, and therefore cannot keep charging, trading or
  funding a Reaper-executed agent. Verified in the paper-mode world: the third tick after the
  external kill shows the dead agent absent from executions and the obituary count still 1 (no
  duplicate).
- `reaper-process.js --once` refuses a `mode=sim` state dir (logged `event:"refused"`, exit 0)
  so a synthetic-broker process cannot kill for the wrong reason. Test spawns the real Node
  process (`stdio: 'ignore'`, as the sandbox blocks piped stdio).

### 3.4 Brakes (D1–D14)
Each rule was attacked at its real enforcement site with a minimal constructed context (see the
14 PASS rows in §2.2). D1/D12/D14 are *architectural* brakes and were verified structurally:
- D1: no money-movement/account-config method on either broker (runtime property scan **and**
  source scan); the only write endpoints in the Alpaca client are `POST /v2/orders` and
  `DELETE /v2/orders/:id`; endpoint allowlist asserted on a stubbed fetch surface.
- D12: the Reaper has no engine method, no tool, no config flag; it is a standalone entry that
  refuses sim; its module exposes only `sweep()`; the engine facade exposes a read-only
  `reaper` status getter and nothing callable.
- D14: no `markAlive`/`revive` anywhere in the API or module exports; `markDead` twice throws
  `AGENT_DEAD`; dead agents cannot be patched/updated; the death survives reload.
- D7: the two loss limits are **death verdicts** (`drawdown_limit`, `daily_loss_limit`), not
  pauses — verified on the Treasurer directly and through the engine.

### 3.5 Live gating and secrets
- Live requires all of `mode=live`, `allowLive=true` and the `LIVE_ARMED` marker; any missing
  leg throws `LIVE_NOT_ARMED` and the unarmed broker performs **zero** HTTP requests.
- Paper resolves `paper-api.alpaca.markets` and ignores live-named keys; live resolves
  `api.alpaca.markets`. Credentials travel only in `APCA-*` headers, never URLs.
- Env-file secrets never appear in engine `status`/`probe`/`configView`/`brakesView`/
  `obituaries`, plugin tool JSON, or `/automaton/state`; the plugin also scrubs
  credential-shaped strings out of error messages (`AKIA…`, `secret=…`).
- The engine facade never auto-starts trading: read-only calls leave `engine.automaton === null`,
  no `state.json` is written, and `tick()` does not start the timer loop.

### 3.6 Population cap, kill switch
- Cap is enforced in the registry (living agents only), in the replicator (even with an open
  Treasurer gate), and end-to-end in a running engine whose population never grows past `cap`.
- Kill switch: checked before anything spends/trades; denies with `KILL_SWITCH` before every
  other rule; a whole cycle returns `halted/haltReasons: ["KILL_SWITCH"]` with no charges and no
  broker orders; the Executor cannot bypass it when called directly; the Reaper keeps liquidating
  by design (operator emergency stop leaves the Reaper running).

---

## 4. Defects found by this verification and their fix status

All seven were reported to the Lead with file:line and minimal repro. They are now fixed in the
workspace and re-verified by the tests named below (`docs/VERIFICATION.md` keeps them because
finding + fixing them is the value of the independent pass).

| # | Sev | Defect (pre-fix) | Fix location (current) | Re-verified by |
|---|-----|------------------|------------------------|----------------|
| F1 | **CRITICAL** | Reaper never persisted its kills: `killAgent`/`settleDeadAgent` marked dead and swept in memory only, and `reaper-process.js` never saved after a sweep. Because the Reaper is a separate process, the engine (which had loaded state once at init) never learned of the death, kept charging/trading the agent, and a process restart **resurrected** the dead agent while the journal already held its obituary. | `src/reaper.js:206-210,250-251`; `src/reaper-process.js:198-205`; engine propagation: `src/orchestrator.js:396-407` (per-cycle re-sync + condemned pruning) | integration *death ownership (mode=paper)* ×3; security *kill durable across fresh load*; `scripts/verify-fixes.mjs` checks 1-4 |
| F2 | HIGH | `automaton_brakes` dry-run could never ALLOW: `preTradeCheck` passed a `{specId}` stub as the spec, so D9 always denied `NO_PROOF`. The advertised "operator dry-run through the real brakes chain" was decorative. | `src/orchestrator.js:799-810` (full compiled spec from `state.specs`) | integration *status surface honest + dry-run traverses the chain*; `verify-fixes.mjs` check 10 |
| F3 | MEDIUM | `daily_loss_limit` death was unreachable: `dayStatsFor()` hardcoded `pnlUsd: 0`, so the Treasurer could never see a day loss in the real engine loop. | `src/orchestrator.js:173-187,437-451` (real P&L each cycle) | integration *daily_loss_limit fires from real P&L*; `verify-fixes.mjs` check 11 |
| F4 | MEDIUM | Generation numbers corrupted by truthiness: `Number(agent.generation) \|\| 1` relabelled genesis gen-0 as gen-1 in obituaries, and `(parent.generation \|\| 1) + 1` made children of genesis parents gen-2 (gen-1 skipped) — corrupting the gen-1 vs gen-3 survival dataset. | `src/reaper.js:154-155`; `src/replicator.js:206-207` (`Number.isFinite` guards) | integration *obituary generation-0* + *child gen+1*; security *kill durable…* (generation 0); `verify-fixes.mjs` checks 5/13 |
| F5 | LOW | Status lied: `state.ticks` was incremented after writing `state.json` (status lagged one tick); `population.total` was the alive count (`total ≠ alive+dead`); dead agents were reported as `"condemned"` forever because `state.condemned` was never cleared after execution. | `src/orchestrator.js:408,406,650-658,706-713` | integration *persists trace/state.json*, *status surface honest*; `verify-fixes.mjs` checks 6-9 |
| F6 | LOW | Per-cycle cost attribution rounded each role charge to 2dp before deducting: a run charged ~$0.04/cycle instead of the configured $0.035 (data $0.005→$0.01, inference slices rounded up) and hosting rounded to zero, so actual burn diverged from the runway formula by ~14%. | `src/ledger.js:122-130,202,214-216` (8dp money); tested against `expectedBurnPerCycle()` | integration *burn matches formula*; `verify-fixes.mjs` check 9 |
| F7 | GAP | `mode=sim` had no death execution path at all (engine comment claimed an in-process simulation existed; the orchestrator never killed, so sim condemned agents lingered forever and no obituary was ever written by an engine loop), and the external Reaper could be pointed at a sim state dir where its synthetic-broker account differs from the engine's. | `src/orchestrator.js:476-497` (sim-only in-process Reaper + `deathsExecuted`); `src/engine.js:185-196`; `src/reaper-process.js:124-135` (refuses sim) | integration *verdict + in-process sim execution*; security *reaper-process refuses sim-mode dir*; `verify-fixes.mjs` checks 2/15 |

Minimal repros used (all were run before the fixes, then re-run after):

1. **F1 resurrection** — seed an under-funded agent (`endowment 5000`, grant `100`), `save()`;
   construct a *second* registry/ledger pair and `.load()` it (the external Reaper's view);
   `createReaper(...).sweep()` kills it and writes the obituary; read `state/registry.json`:
   pre-fix `"status":"alive"`; a new `createRegistry().load()` -> `"alive"` while the journal
   said dead. Post-fix: disk `"dead"`, reload `"dead"`, ledger cash `0`.
2. **F2** — after one tick: `automaton.preTradeCheck({agentId: <alive>, symbol:
   <genome.symbol>, side: 'buy', notionalUsd: 100})` -> pre-fix `{decision:'DENY',
   code:'NO_PROOF', brakeId:'D9'}`; post-fix `{decision:'ALLOW'}`.
3. **F3** — after one tick, `state/day-stats.json` entries had no `pnlUsd`; post-fix the
   Treasurer receives `pnlUsd = equity − startEquityUsd` and a −$300 cycle produces a
   `daily_loss_limit` verdict.
4. **F4** — kill a genesis agent: pre-fix `journal.list()[0].generation === 1` while
   `registry.get(id).generation === 0`; child of a gen-0 parent was gen-2. Post-fix: 0 and 1.
5. **F5** — 9 successful ticks then `status()`: pre-fix `engine.ticks === 8`,
   `population.total === alive` with `dead > 0`, executed agent row `"condemned"`. Post-fix
   9 / `total = 3 = 2 alive + 1 dead` / `"dead"`.
6. **F6** — `ledger.charge(agent, 0.0075)` deducted $0.01 pre-fix; a 3-cycle run charged $0.12
   vs the $0.10525 formula. Post-fix the run charges exactly the formula.
7. **F7** — `node src/reaper-process.js --state-dir <sim-state> --once` pre-fix started sweeping
   a simulated account from a separate process; post-fix exits 0 and logs
   `event:"refused"` without touching state.

---

## 5. Residual findings (OPEN — not fixed, reported to the Lead)

| # | Sev | Finding | Evidence / repro |
|---|-----|---------|------------------|
| R1 | MEDIUM | **A `daily_loss_limit` death is not executable by the Reaper.** The rule now fires (F3 fixed), but `reaper.sweep()` re-derives death only from equity (insufficient funds / drawdown) and never reads day P&L, so a daily-loss condemned agent is *frozen alive forever*: the engine stops charging/trading it (`condemned`), but it never receives an obituary and keeps its population slot. Same structural limitation applies to the system-level causes (`account_not_active`, `reconciliation_mismatch`, `risk_breach`) if they are ever emitted as death verdicts — the Reaper deliberately ignores the verdict file. | `src/reaper.js:309-319` (death derivation: `insufficient_funds`, `drawdown_limit`, `systemDead` only) + integration TODO test *“daily_loss_limit death is frozen”*, whose expected `dead`/obituary assertions fail while the observed state stays `alive` / `journal.count() === 0` after the cycle. |
| R2 | MEDIUM | **The replication gate does not account for the drawdown death rule.** `replicator.spawn` requires `parentEquity − childEndowment >= 2 × deathFloor` (`src/replicator.js:163`), but the drawdown rule kills at `endowment × (1 − maxDrawdownPct)` (`src/treasurer.js:269-272`). With the default economics a parent can pass the gate, fund the child, and immediately fall below its drawdown threshold — i.e. a successful birth at the cost of the parent's life, contradicting D10's wording. | Integration test *kill switch … gate-vs-drawdown finding*: after the forced birth the independent Reaper kills **two** agents — the intended `insufficient_funds` child and the **parent with cause `drawdown_limit`** (final equity $3,100.12 < $3,750 threshold). Deterministic with `seed 6`, parent equity ≈ $5,600 → child endowment $2,500. |
| R3 | LOW | `state/day-stats.json` does not persist `pnlUsd` (only `ordersCount`/`startEquityUsd`); the daily-loss rule works because the engine computes live P&L every cycle, but an external observer of the file cannot see the P&L that killed an agent. | `src/orchestrator.js:437-451` (computed into the `dayStats` argument) vs `saveDayStats()`/`state.dayStats` (`:169-171`) which keeps only the persisted shape; observed in `state/day-stats.json` after ticks. |
| R4 | MEDIUM | **Two writers, no lock.** The engine and the external Reaper both write `registry.json`/`ledger.json` (atomic file rename, but no locking or version check). The per-cycle re-sync (F1) narrows the stale window, but an engine in-memory save can still overwrite a Reaper save that happened mid-cycle (lost update), and vice versa. | `src/orchestrator.js:396-407,434,585`; `src/reaper.js:209-210,250-251`; `src/reaper-process.js:201-202`. Not reproduced under real concurrency (see NOT verified). Recovery path: next Reaper sweep re-settles the agent (`settleDeadAgent`), so it is self-healing but can double-sweep / temporarily show a zombie. |
| R5 | LOW | The kill switch is an **execution-path wall**, not a broker freeze: any code that holds the broker object can still call `broker.submitOrder()` directly (the Reaper does exactly this deliberately to close risk). Only the Executor path and the cycle loop consult the marker. This matches the architecture ("agents never hold the broker"), but it is not a process-wide interlock. | Brakes/executor tests; `src/brakes.js:112-118,185-187`; reaper never checks the kill switch (integration *kill switch … Reaper still closes risk*). |
| R6 | LOW | Reconciliation tolerance (2% of account equity, default $2,000) masks ledger-only drift. Deliberate in the docs (per-agent equity is bookkeeping), but it means a $599 ledger-only “profit” used to force the replication gate in testing passes reconciliation. Do not read `deltaUsd ≈ 0` as proof the virtual ledger equals the broker. | integration *replication…*: after a ledger-only +$600 round trip, `reconciliation.deltaUsd = −599.44`, `ok: true`. |

---

## 6. NOT verified

Explicitly out of scope or impossible in this environment; do **not** read the green table above as
evidence for these:

1. **Live trading / real money.** No Alpaca keys are installed, no network is available, and live
   mode was never armed. What *is* verified: live refuses without the full arming chain and makes
   no request while unarmed; endpoint selection with stubbed fetch; the operator must create
   `LIVE_ARMED`. Actual armed live order submission, broker permissions, buying-power behavior,
   and real fills are **not** verified.
2. **Paper-mode connectivity against Alpaca.** All HTTP is a stub double (`fetchImpl`); TLS, auth,
   rate limits, `/v2/clock` reality and partial fills are not exercised against the vendor.
3. **The external Reaper running as a detached, long-lived OS process against a real broker.**
   Verified: the entry is a standalone Node process, its CLI parses only documented flags, it
   refuses `mode=sim`, and its kill/sweep logic (with the same modules) executes and persists the
   death durably. **Not** verified: `engine.start()` spawning it for paper/live and retrying
   (needs credentials), continuous `reaperIntervalSec` sweeping, SIGINT/SIGTERM shutdown, and
   multi-process write interleaving with the engine (R4).
4. **Browser rendering of the dashboard panel.** The verifier did not run a browser/screenshot.
   The Lead separately verified `GET /automaton/state` returns 200 and the client registers both
   slots (`settings.plugins.tab`, `conversation.composer.dock`); client rendering, layout, polling
   cadence, locale switching and the installed profile’s cached-module behavior were not verified
   here.
5. **Real market-closed behavior.** All runs use a fixed synthetic clock at Mon 10:00 ET; the D3
   session tests use constructed timestamps. The real market was closed during verification; no
   test depends on it, and no live-session behavior was observed.
6. **Adversarial agents in a real environment.** The six roles are deterministic code, not LLM
   agents under adversarial prompt injection; "agents can't" claims are checked structurally
   (API surface, brakes) but no real autonomous agent tried to evade the walls. The threat model
   is code-path discipline, not a compromised model.
7. **Long-run population behavior.** Tests run 1–12 cycles (minutes of simulated time, ~$0.3 of
   costs); no multi-day selection, gen-3 drift, journal growth/performance, long-horizon
   overfitting, or population collapse statistics were verified. `automaton_simulate` /
   `src/simulate.js` was exercised only by the builders' short test (`cycles: 6`), not by a long
   mortality run in this verification.
8. **Multi-agent concurrency / process crashes.** No kill -9 mid-write, no two engine instances,
   no crashed-Reaper recovery beyond the unit path (`settleDeadAgent`) already covered by the
   builders' suite.
9. **Harness integration end-to-end.** The ten `automaton_*` tools are live in the installed
   profile, but this verification runs the plugin contract in-process with fake Cordis
   contexts/engines (as the builders' `plugin.test.js` does); actual tool dispatch through the
   running Harness, the panel fetch loop, and module caching after a code change (see banner at
   the top) were not exercised by the verifier.

---

## 7. Verdict (does the delivered system match the article's architecture?)

Yes in substance, with the caveats above. The role/stopline separation is real code, not theatre:
the Treasurer is the only account-equity reader, the Executor trades only inside a mandate and
never sees balance, the Prospector cannot size/order, the Builder cannot move symbol/family and
must carry dated proof, the Replicator cannot decide its own birth, and the Reaper is a separate
process entry that the engine cannot stop. The brakes are real denials at the point where the
broker is called, not prompt text. The obituary dataset exists and is validated/deduped, children
inherit the journal digest plus exactly one mutation (generation numbering now correct), and
`firstProfitAt: null` is preserved. The two implementation gaps that keep it from being *fully*
the article's system are (R1) a death cause that is declared fatal but cannot be executed by the
Reaper, and (R2) a replication gate that checks the death floor but not the drawdown death rule,
so a birth can kill the parent; the external-process durability flaw that would have turned the
whole death mechanism into theatre (F1) was found, reported, fixed, and re-verified here. The
system is genuinely mortality-engineered — but it is a paper/sim trading system: no live/real-money
behavior is verified, and the "agents are AI" framing is not part of what was tested.

---

## 8. Lead addendum — post-verification fixes (2026-10-25)

The Lead fixed the residual findings R1–R3 after this verification was written, and re-ran
everything. This section is owned by the Lead, not the verifier; the verifier's findings above
remain the record of what was found.

| Finding | Status | What changed |
|---|---|---|
| **R1** `daily_loss_limit` not executable by the Reaper | **FIXED** | `src/orchestrator.js` persists `pnlUsd` into `state/day-stats.json`; `src/reaper.js` reads that record and re-derives `daily_loss_limit` (`-pnl/startEquity >= maxDailyLossPct`), and re-derives `account_not_active` from the broker account status. A daily-loss death is now executed and leaves an obituary. |
| **R2** replication gate ignored the drawdown rule | **FIXED** | `src/replicator.js` now requires `parentEquity - childEndowment > max(2 x deathFloor, endowment x (1 - maxDrawdownPct))`, so a birth that would push the parent under the drawdown threshold is refused (`REPLICATION_DENIED`). |
| **R3** day P&L not persisted | **FIXED** | `pnlUsd` and `dayKey` are stored in `state/day-stats.json` for every living agent each cycle. |
| **R4** dual writers, no lock | **OPEN (accepted)** | Narrowed by the per-cycle re-sync and the Reaper's immediate persist; self-healing via `settleDeadAgent` on the next sweep. A real file lock is future work; it needs a cross-process lock primitive the Host does not provide. |
| **R5** kill switch is an execution wall, not a broker freeze | **OPEN (by design)** | The broker object is never held by agents; the Reaper deliberately bypasses the marker to close risk. Documented in `docs/ARCHITECTURE.md` §5. |
| **R6** reconciliation tolerance can mask ledger drift | **OPEN (documented)** | Deliberate: per-agent equity is bookkeeping on a shared Alpaca account. Do not read `ok: true` as proof of ledger/broker equality. |

Final re-run after the fixes (fresh Node processes, direct execution):
`mortality 55/55`, `market 21/21`, `plugin 12/12`, `integration 21/21`, `security 41/41` —
**150 tests, 150 pass, 0 fail**, and `scripts/verify-fixes.mjs` **18/18 checks pass**
(reaper persistence across reload, no resurrection, gen 0/1, exact burn accounting, in-process
sim death, external-Reaper refusal for sim, daily-loss execution + obituary, replication
drawdown refusal).

Note on the accelerated simulation preset: after the corrected R2 gate, a birth is only
possible for a parent that has actually grown. On the random-walk sim market most agents only
drain, so a 200-cycle demo run typically shows mortality and survival (25 dead / 75 alive,
seed 7) but **no** reproduction; reproduction is covered deterministically by the test suites
(funded-parent scenarios) and will happen in paper/live only when an agent's equity genuinely
supports it. This is the honest behaviour of a no-edge market, not a missing feature.

### Paper-account verification (2026-10-24, after Alpaca paper keys were supplied)

What was run against the **real paper endpoint** (`https://paper-api.alpaca.markets`), from the
fixed code in fresh Node processes:

| Check | Command | Result |
|---|---|---|
| Credentials + account | `bin/automaton.mjs probe` | equity **$2,000**, cash **$2,000**, buying power $8,000, status **ACTIVE**, `market open: false` |
| One read-only cycle | `bin/automaton.mjs tick` (and `scripts/paper-verify.mjs`) | 10 symbols, **1,172 real hourly bars**, 10 quotes, 3 dated-proof hypotheses, 2 compiled specs, **0 orders**, 0 errors |
| D3 wall with the broker clock | `scripts/paper-verify.mjs` | `DENY MARKET_CLOSED — market is closed (broker clock)` |
| Independent broker state | Alpaca `/v2/orders`, `/v2/positions` | **0 orders, 0 positions** |
| Detached external Reaper | `scripts/reaper-spawn-verify.mjs` | engine spawned pid alive; reaper swept the real account (`checked=2 killed=0`); `engine.stop()` left it running by design; stopped manually as operator |
| Reconciliation | status | `ok`, delta $0.20 (tolerance $40) |

The account cannot carry the repo defaults (2 × $500 endowments fit the 80% cap of $2,000; the
default 3 × $5,000 does not), so `automaton.config.json` now carries account-scaled economics:
2 agents, $500 endowment, $25 death floor, $250 child endowment, 100 bps spread ceiling for IEX
data.

**Defects found only by testing against the vendor (all fixed):**

| Finding | Status | Fix |
|---|---|---|
| `GET /v2/stocks/bars` returns **no bars** when the window is omitted, returns the **oldest** bars when unsorted, and paginates multi-symbol requests **one symbol per page** (so a multi-symbol call silently returned one symbol) | **FIXED** | `src/broker-alpaca.js#getBars` issues one bounded-window request per symbol (`start`/`end`, `sort=desc`), sorts ascending defensively; market test updated to assert per-symbol requests + window |
| D3 only enforced the weekday time window; a Saturday signal would have been submitted to a closed market | **FIXED** | orchestrator reads `broker.getClock()` each cycle and forwards `marketOpen`/`marketClock` through the executor into `brakes.checkOrder()`; verified `DENY MARKET_CLOSED` against the real clock |
| Weekend IEX quotes are gross (spread ≈ 1,000 bps for AAPL), so a 25 bps ceiling would block every paper entry even during the week | **TUNED** | paper config `risk.maxSpreadBps = 100`; D4 still denies genuinely illiquid quotes (verified denying the weekend quote before the D3 context was forwarded) |

**Still not verified:** actual paper fills (the market was closed for the entire build; the next
open is Monday 09:30 ET), live-mode order flow, and browser rendering of the panel. These remain
the honest boundaries of this delivery.

### 30-agent population + control panel (2026-10-24, second request)

The user asked for **30 agents with $20 each and their own strategy**, plus a tracker UI.

| Check | Result |
|---|---|
| Population seeded | **30 gen-0 agents**, $20.00 each, $600 allocated of $2,000 (30%), cap 60, reconciliation `ok` |
| Distinct strategies | 30 unique deterministic genomes (10 symbols × momentum/meanrev/breakout, randomized lookback/entryZ/exitZ/stop/target/hold/size/session); 22 distinct proven symbol×family pairs (the rest trade their family on the nearest proven symbol — the Builder refuses unproven combinations); **30 distinct compiled specs**, all persisted (`registry.json` specIds) |
| Metabolism scaled for $20 | $0.00025/cycle burn, $1 death floor, 20% drawdown death, $10 child endowment; runway 6,312 h at genesis; 30 agents × 1 cycle = 0.006% account drag |
| Real paper cycle with 30 agents | 1,172 real bars, 22 hypotheses, 30 builds, 30 executions, **0 orders** (market closed), 0 broker orders/positions, D3 `MARKET_CLOSED` on the wall check |
| Test suites after the change | mortality 55, market 21, plugin 20, integration 21, security 41 → **158/158 pass**; `scripts/verify-fixes.mjs` 18/18 |
| Control panel client half | Live: `shell.overlay` has an active `automaton-trading` occupant (inspected through the Client Slots provider); settings tab and composer strip register through the same shared component |
| Control route | Implemented + unit-tested (`POST /automaton/control`: loopback 403, start/stop/emergency mapping, confirm required, 400/405/409); **needs one app restart** — a fresh Host boot activated the plugin before `webServer` mounted, so the Host half now late-binds its routes |
| 30-agent table mapping | Unit-tested in `test/plugin.test.js` via exported pure helpers: rows, sort, filter, summary, generations, obituaries, $20 endowment P&L fallback; unknown fields render '—' |

**Known limitation found during this change (fixed):** the Host plugin originally captured
`ctx.get('webServer')` once at activation. If the plugin activates before the web server service is
mounted (fresh app boot), both routes are silently skipped while the tools still register — the
panel then polls 404s. `index.js` now polls for the service for up to 60 s inside a disposable
effect, so routes register as soon as the server exists. A restart is required to load the new
Host module generation.

**Still not verified:** visual rendering of the panel (structurally verified only), the Start
button driving a live loop for a full market session, and actual paper fills.

### Sidebar UI, strategy names, holdings drill-down, Reaper hardening (2026-10-25, third request)

The user asked for: sidebar instead of a floating panel, memorable strategy-derived agent names,
and click-through holdings/activity per agent.

| Check | Result |
|---|---|
| Agent names | 30 unique strategy names persisted in `registry.json` (`Momentum AAPL`, `Momentum MSFT`, … `MeanRev …`, `Breakout …`); name is displayed primary, `atm-xxxxxxxx` id secondary; obituaries carry the name |
| Holdings + activity data | status rows now include `positions` (qty, avg/last price, market value, unrealized P&L, opened-at), `recentTrades` (newest-first fills: side, qty, price, notional, realized P&L, time), `tradesCount`, `realizedPlUsd`, `unrealizedPlUsd`, `firstProfitAt`, and the compiled `spec` (genome-vs-trading distinction) |
| Sidebar registration (live) | Client slot inspector: `sidebar.panellist` occupant `automaton-trading` (order 30, active) **and** keyed `main` occupant `automaton-trading` (active) — clicking the sidebar entry selects the dashboard in the central column; the old `shell.overlay` occupant is gone |
| Plugin tests | 28/28 (names, genome-vs-spec, holdings/activity mapping + empty states, slots `sidebar.panellist` + `main` + settings tab, control route incl. `reaper-stop` confirm/missing-pid/EPERM/kill-escalation, 10 tools) |
| Full suite | mortality 55, market 21, plugin 28, integration 21, security 41 → **166/166 pass**; `scripts/verify-fixes.mjs` 18/18 |
| Reaper hardening | new Reaper reloads registry/ledger before every sweep and writes `reaper.heartbeat.json` v2; `engine.start()` refuses to reuse a Reaper without a matching heartbeat; `engine.status().engine.reaper` now reports pid/alive/heartbeat/sweeps read from disk; the engine still has **no** Reaper control method (D12 tests still pass) |

**Incident found during this change (hardened, one residual manual step):** a Reaper left over
from the previous app generation (pid 24452, pre-heartbeat code) kept saving its process-start
snapshot of `registry.json`/`ledger.json` every 30 s, reverting agent names and costs. A sandboxed
shell cannot signal a process owned by the Host (EPERM), so the operator must clear it once:
after the app restart, the panel shows the stale-generation Reaper row and an operator-only
**Stop Reaper** action (`POST /automaton/control {"action":"reaper-stop","confirm":"STOP"}`,
Host-side kill), or run
`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*reaper-process.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
in a normal terminal. New Reapers cannot recur the bug (reload-before-sweep + heartbeat).

**Still not verified:** visual rendering of the sidebar/dashboard (slot registration is verified
live; pixels are not), the Start button driving a full market session, and actual paper fills.

### First live paper session — async-fill bug found and fixed (2026-10-26)

First real paper session: the loop ran 519 ticks with the market closed (0 orders, D3
`MARKET_CLOSED` denials by design — the session window starts 09:35 ET), the external Reaper
v2 stayed healthy (pid/heartbeat/sweeps), 30 agents and names persisted, reconciliation `ok`.
At **09:39 ET** the first live order was placed and filled: `MeanRev AAPL` bought
`0.0068 AAPL @ $343.922` ($2.33 notional, `client_order_id atm:atm-72e7db49:spec-64e8f7c4:1`).

**Defect found by that fill:** Alpaca returns a market order as `accepted` before it fills, with
`filledQty = 0`; the executor used `numberOrNull(filledQty) ?? orderQty`, and since `0` is not
nullish it attempted to book a 0-qty fill — the ledger rejected it (`fill qty must be > 0`), the
real fill never reached the virtual ledger, and the panel showed no holding. Found by comparing
the broker position against `ledger.json` after the order.

**Fix (executor):** (a) fill delta is computed against already-booked qty per `orderId` (handles
partials), (b) after submitting, the executor briefly polls the broker for the fill and books the
actual `filledQty`/`avgFillPrice`, (c) every cycle reconciles recent filled broker orders for that
agent whose `client_order_id` starts with `atm:<agentId>:` and books anything the ledger has not
seen yet. The missed fill was backfilled with `scripts/reconcile-fills.mjs`
(`MeanRev AAPL`: cash 17.53 + AAPL 0.0068 @ 343.922, trades 1).

Also hardened in the same change: atomic JSON writes retry transient Windows `EPERM/EACCES/EBUSY`
rename races (engine + Reaper both save `registry.json`/`ledger.json`), and a successful cycle
clears a stale `lastError` instead of leaving it sticky forever (one transient file-lock error had
been shown persistently). Full suite after the fixes: **166/166 pass**, `scripts/verify-fixes.mjs`
18/18. The running Host must be restarted to load these engine fixes; the loop was stopped before
the fix so no further unbooked fills could accumulate.

### Per-agent research sidecar (2026-10-26, user-requested upgrade)

The user asked whether the population members are separate Harness agents (they are not — 30
deterministic strategy instances in one engine) and asked for **per-agent isolation plus hourly
research of company/internet news about each agent's holdings**. Chosen design: **A2 now** (one
isolated stateless LLM analyst per agent with a private briefing journal; designed so a bot can
later be promoted to its own Harness agent), **live influence from day one**, light budget
($0.001/briefing charged to the agent's ledger). Contract: `docs/RESEARCH.md`.

| Check | Result |
|---|---|
| Research unit suite | `test/research.test.js` **9/9**: prompt isolation (no other agent id/name/book/journal), schema clamp/validation, malformed-reply containment (no briefing, no charge, error logged), per-agent ledger charge (category `research`, role `prospector`), hourly scheduling (due → skipped → due), stale expiry (`maxAgeSec`) with dashboard still showing stale briefings, empty-news neutral HOLD with no LLM call, HTTP fallback generator absent without key / mapped with key |
| Composition smoke | `scripts/research-smoke.mjs` **10/10** on the real `createAutomaton` + sim broker: research runs for due agents, `engine.research` configured, every agent row carries its own briefing, per-agent journals on disk, each briefing charged to its own ledger, second cycle does not re-run, next hour due again |
| Executor influence | market suite **27/27** (21 + 6 new): fresh AVOID/ALERT/sentiment/risk veto → `skip research_veto` (never a denial), size scaling can only shrink and respects caps, `research_alert` exit, stale/disabled/malformed/missing = byte-for-byte baseline |
| Broker news | Alpaca `GET /v1beta1/news` verified live against the paper keys (HTTP 200 with headlines/summaries/urls); mapping/filters/outage in market tests; sim broker has a deterministic synthetic feed. Alpaca returns `[]` on `BROKER_ERROR` so a news outage can never break a trading cycle; auth/rate-limit/config errors still surface |
| Plugin bridge + dashboard | plugin suite **36/36**: `createResearchBridge` provider resolution (agentDefaultModel → first provider/model, row/nested overrides), stream concatenation/usage, clean scrubbed errors, engine factory receives the bridge, GET state passes `engine.research` and per-agent `research`, client mapping helpers (badge HOLD/AVOID/ALERT/stale/none, detail catalysts/risks/sources sanitization, shadow/influence/disabled banners). Real-engine sim smoke with a fake Host llm: `configured:true`, provider/model resolved from the bridge |
| Full suite | mortality 55 + market 27 + plugin 36 + integration 21 + security 41 + research 9 = **189/189 pass**; `scripts/verify-fixes.mjs` 18/18 |
| Scheduling safety | `research.maxRunsPerCycle` (default 3) caps LLM work per trading cycle so an hourly batch can never stall order placement for minutes; `staggerSec` (120 for 30 agents) spreads the hourly load |
| Cost | `$0.001` per successful briefing charged to that agent's ledger; malformed/failed replies are free. Treasury burn formula intentionally unchanged (research is an actual ledger charge, not modelled burn) |

**Not yet verified:** the live Harness-LLM bridge against real model calls (needs the app restart
that loads the new Host `index.js`) and therefore real briefings appearing in the panel; the paper
loop is running the previous Host code until restart.

### Live research bridge — first real dispatch defect, found and fixed (2026-10-26)

After the restart that loaded the research sidecar, the engine reported
`engine.research.configured:true, provider:deepseek-account, model:deepseek-flash, errors:1` with
`lastError: "llm: deepseek-account/deepseek-flash: prepared LLM call config changed before adapter
dispatch"` and zero briefings. Cause (read from the installed `@deepseek-ai/dsh-llm` bundle): the
Host `prepareCall(config)` returns a frozen, fully resolved call config (adapter defaults such as
`reasoningEffort` are materialised at preparation time), and `prepared.stream(options)` rejects any
options that do not compare equal field-by-field to that config (`INVALID_PREPARED_CALL`). The
bridge re-sent only `{provider, model, maxTokens, temperature}`, so every dispatch was rejected
**before any provider request** (no tokens spent); trading was unaffected.

Fix: the bridge spreads `prepared.config` into the stream options and adds only the `system` /
`messages` prompt fields the equality check ignores. Regression test: the fake Host `llm` in
`test/plugin.test.js` materialises an adapter default (`reasoningEffort: high`) and asserts the exact
frozen config is echoed back (plugin 36/36). Research output budget raised 700 → 1200 tokens so a
reasoning model cannot consume the whole budget and return empty content. Research 9/9, full suite
189 green. One more Host restart loads the corrected bridge; the real provider dispatch is then
re-verified live.

**Decision recorded:** Alpaca news outages return an empty feed at the broker adapter (advisory
data must never break a cycle); real LLM failures are logged by the researcher and never charged.
