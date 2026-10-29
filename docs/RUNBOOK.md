# RUNBOOK — operating MEAT

Everything below runs from `D:\CounterStikers\packages\automaton-trading` unless stated.

## 0. What you are operating

A population of virtual trading agents sharing one Alpaca account. Each agent has an
endowment, pays its own cost of existence (inference/data/hosting per cycle), and is
killed by an **external Reaper process** when its equity hits the death floor, its
drawdown limit, or its daily loss limit. Profitable agents reproduce with one mutation;
dead agents leave obituaries that children inherit. Paper is the default; live is gated.

## 1. Prerequisites

- Node ≥ 22 (this machine: `C:\Program Files\nodejs\node.exe` or the DSH bundled runtime).
- Alpaca **paper** account + API keys. Put them in `D:\CounterStikers\.env`:

  ```dotenv
  ALPACA_API_KEY_ID=PK...
  ALPACA_API_SECRET_KEY=...
  AUTOMATON_MODE=paper
  ```

  Keys never enter the plugin package, the profile config, or tool output; only the
  engine and the external Reaper read `.env`.

- Workspace state lives in `D:\CounterStikers\automaton-data\` (registry, ledger,
  obituaries.jsonl, traces.jsonl, specs/, KILL_SWITCH, reaper.pid, reaper.log).

## 2. Verify connectivity (no orders)

```powershell
node bin/automaton.mjs probe
node bin/automaton.mjs config
node bin/automaton.mjs brakes
```

`probe` must print account equity/cash/status and `market open: true|false`.
If it prints `BROKER_AUTH`, the keys are wrong or live keys are used against paper.

This build is tuned for the supplied **$2,000 paper account** and the requested population in
`automaton.config.json`: **30 agents × $20 endowment** ($600 allocated, 30% of equity), $1 death
floor, 20% drawdown death, $10 child endowment, 40 hypothesis candidates/cycle, spread ceiling
100 bps for IEX data. The invariant is
`population.initial × endowmentUsd <= 80% × account equity`; edit that file to scale up if the
paper account balance or population changes. The population is already seeded (30 gen-0 agents,
unique strategies, one compiled spec each). While the market is closed a cycle still reads real
data and prices the population, but every order is denied with `MARKET_CLOSED` (D3, broker clock)
and nothing is sent to Alpaca.

## 3. Phase 1 — metabolism, no earning (recommended first run)

The article's Phase 1: confirm costs are accounted and death fires exactly on time.
Cheapest and safest is the offline accelerated simulation:

```powershell
node bin/automaton.mjs simulate --cycles 240 --population 120 --seed 7
```

Then a single paper cycle with the real account (orders may be placed if the market is
open and the brakes allow — start with a small population):

```powershell
node bin/automaton.mjs tick
node bin/automaton.mjs status
```

Check in `status`: treasury state, runway hours, reconciliation `ok`, agents' equity and
per-cycle burn. `automaton-data/traces.jsonl` contains one trace per cycle.

## 4. Phase 2 — earning, no replication

Run the loop:

```powershell
node bin/automaton.mjs run
```

- The engine loops every `cycleIntervalSec` (default 300 s).
- It spawns the external Reaper automatically for paper/live, and refuses to start the
  population if the Reaper cannot run.
- In `mode=sim` there is no separate Reaper process: the engine executes death verdicts
  in-process (the synthetic broker is in-process), and `reaper-process.js` refuses a sim
  state directory. Paper/live always use the external process.
- Ctrl+C stops the loop **only**; the Reaper keeps running by design. Its pid is in
  `automaton-data/reaper.pid`, its log in `automaton-data/reaper.log`.
- Stop the Reaper only as the operator: `Stop-Process -Id (Get-Content automaton-data\reaper.pid | ConvertFrom-Json).pid`.
- After changing any plugin/engine source file, **restart the Harness app**: the Host
  process caches the plugin's module graph. CLI and test runs are fresh processes and are
  unaffected.

Watch `status` and `journal` for the first profitable cycle. If nothing earns over
several days, the niche/universe is wrong (article: "the problem is the niche, not the
architecture"), not the mortality rule.

## 5. Phase 3 — replication under a cap

Replication is automatic when the Treasurer gate passes (`mayReplicate: true`):
7-day surplus ≥ `replication.surplus7dUsd`, runway ≥ 72 h, population < cap, and the
parent can fund the child endowment while staying above twice the death floor.

Check `status` → `population`, `journal` → generation survival. If gen-2/gen-3 survival
does not improve on gen-1, the mutation vector is not teaching the population anything.

## 6. Harness control panel

The same engine is available inside the DeepSeek Harness Web UI:

- Agent tools: `automaton_status`, `automaton_start`, `automaton_stop`, `automaton_tick`,
  `automaton_agents`, `automaton_obituaries`, `automaton_brakes`, `automaton_simulate`,
  `automaton_config`, `automaton_emergency_stop`.
- **Control panel**: a **sidebar entry** (Automaton icon in the left sidebar) that opens the
  full dashboard in the central column; the same dashboard is also a page in
  **Settings → Plugins → MEAT — Mortality Engineered Auto-Trading**. The dashboard has header stats (equity, cash,
  population, runway, burn, allocated-vs-cap, last tick, kill switch, obituaries), the
  operator Reaper row, **Start / Stop / Emergency Stop** buttons, and the sortable/filterable
  table of all 30 agents with **strategy names** (`Momentum AAPL`, …), genome-vs-trading-spec,
  equity, P&L, runway, status/cause. **Click an agent** to open its drill-down: current
  holdings (symbol/qty/avg/last/market value/unrealized/opened), past activity (newest-first
  fills), strategy parameters, role costs and death info. Auto-refresh every 3 s with pause.
- **Operator controls (2026-10-29 feature set, docs/CONTROL-PANEL.md)**:
  - **Research cadence** — segmented control: every 1 h / 3 h / 6 h / 24 h, **before market open**,
    **after market close**, or both. Applies live through `POST /automaton/control`
    `{action:'set-research-settings', settings:{mode, intervalSec?, enabled?, influence?}}`; the
    choice is persisted to `automaton-data/settings.json` (operator overlay applied on every config
    load) so it survives restarts. Edit the same file to change it without the panel.
  - **Rewards** — enable toggle, period (daily/weekly/monthly), 1st/2nd/3rd percentages of the
    broker account's **cash** (defaults 5/3/2 %), optional max per period, live preview against the
    treasury pool and allocation-cap remaining. Persisted via `set-reward-settings`. Payouts are
    **virtual treasury → agent ledger transfers at period boundaries only** (no broker transfer
    exists); they are once-per-period, floored to cents, proportionally scaled if the pool/allocation
    cap/max would be exceeded, and recorded in `automaton-data/rewards.json` (history 50). Virtual
    `sum(agent equity) + pool` is unchanged, so reconciliation still holds.
  - **Leaderboards** — daily / weekly / monthly tabs ranked by period P&L %; top 3 get medals and
    can be clicked to open that agent. Period keys are UTC day, ISO week, UTC month.
  - **Agent detail** — the drill-down now explains the bot: strategy summary, entry rule, exit rules
    (stop/target/time/signal), risk rule, plan + next step, triggers table, current position plan
    (stop/target/bars held), next research time, ranking badges, P&L (realized/unrealized/day/week/
    month) and a full **Transactions** table with every fill (order id, side, qty, price, notional,
    realized P&L, time).
- Controls call `POST /automaton/control` (loopback only) with
  `{action:'start'|'stop'|'emergency-stop'|'reaper-stop'|'set-research-settings'|'set-reward-settings'}`;
  destructive actions need `confirm:'STOP'`. Data comes from `GET /automaton/state` (redacted JSON,
  no secrets). Settings actions are operator-only and are never exposed as agent tools; invalid
  settings are rejected with `400 INVALID_SETTINGS` (the Host also validates the same allow-list the
  engine does). `reaper-stop` is operator-only (Host-side) and is never exposed as an agent tool.
- A fresh Host boot can activate the plugin before the web-server service mounts; the Host
  half late-binds its routes (polls up to 60 s), so **restart the app once** after updating
  the plugin. After a restart: if the Reaper row shows a **stale generation** banner, press
  **Operator: stop Reaper**, then Start. If the Host cannot signal the old process, run the
  terminal command in §7.

The plugin row config is in `packages/automaton-trading/cordis.patch.yml`
(`stateDir`, `envFile`, `mode`, `autoStart`). `autoStart` is `false`; the engine starts
idle and never trades until the panel's Start button / `automaton_start` / CLI `run` is used.

## 6a. Research sidecar (per-agent, hourly)

Each living agent gets its own **isolated** hourly news briefing (`docs/RESEARCH.md`).

- **How it runs**: inside the engine loop — once per cycle the researcher runs only for agents
  whose hourly slot is due (`research.intervalSec`, staggered by `research.staggerSec`). In the
  Harness the LLM comes from the Host `llm` service (the same DeepSeek account, no extra key);
  a headless CLI run uses `DEEPSEEK_API_KEY` from `.env` (optional, `DEEPSEEK_MODEL` ~
  `deepseek-chat`). Without either, `engine.research.configured=false`: trading continues
  unchanged and the panel shows "research disabled: no LLM bridge / key".
- **What the model sees**: only that agent's genome/spec, its own cash/positions/P&L, news for
  its own symbols (Alpaca News API) and its own last ≤5 briefings. No other agent's data and no
  shared conversation — this is enforced by construction and asserted in `test/research.test.js`.
- **What it can do**: advise the Executor only. `AVOID`/`ALERT`/negative-sentiment/2+ risks veto
  a *new entry* (`research_veto`); positive sentiment scales the order size down (never up);
  `ALERT`/strong negative sentiment pushes an exit (`research_alert`). Every order still passes
  the 14 brakes. Set `research.influence:false` for shadow mode (briefings logged, no effect).
- **What it costs**: `research.costPerRunUsd` (default $0.001) is charged to **that agent's**
  ledger per successful briefing (category `research`, role `prospector`), so research shortens
  the agent's runway. Malformed/absent LLM answers are logged with no charge.
- **Where to look**: panel → agent drill-down "Research — isolated hourly analyst" (verdict,
  sentiment, confidence, summary, catalysts/risks, sources); raw data in
  `automaton-data/research/<agentId>.jsonl` and `automaton-data/research/state.json`;
  latest cycle summary in the tick trace (`trace.research`). `engine.status().engine.research`
  reports `enabled/configured/influence/lastRunAt/nextDueAt/provider/model/runs/errors`.
- **Disable / tune**: edit `research` in `automaton.config.json`
  (`enabled`, `influence`, `intervalSec`, `staggerSec`, `costPerRunUsd`, `maxAgeSec`,
  `maxNewsPerAgent`, `maxOutputTokens`) and restart the Host (engine modules load on boot).
  Advisory thresholds are also configurable: `vetoSentiment` (-0.6), `exitSentiment` (-0.5),
  `vetoMinRisks` (5, effectively off), `riskPenalty` (0.6 size multiplier when risks >= 2) and
  `errorCooldownSec` (900 s pause after provider errors; 1 h for fatal ones such as an empty API
  balance). Do not veto on risk count alone — a live tuning mistake did exactly that and blocked
  ~100% of entries for two sessions (see docs/VERIFICATION.md, 2026-10-28).
- **Provider balance**: the Harness `llm` service bills your DeepSeek account. If the balance is
  exhausted the analyst pauses (errors + stale briefings), and **trading continues without
  research influence** because stale briefings are ignored. Top up at platform.deepseek.com, then
  the next hourly slot resumes automatically (or restart after changing config).
- **Failure behaviour**: news outage → no news → neutral HOLD (no LLM call, no charge);
  LLM error → logged, no briefing/charge, trading unaffected; stale briefing (> `maxAgeSec`)
  → ignored by the Executor but still shown (marked stale) in the panel.


## 7. Safety and emergency procedures

| Situation | Action |
|---|---|
| Something looks wrong | `node bin/automaton.mjs emergency-stop` (or `automaton_emergency_stop` tool with `confirm:"STOP"`) — arms `KILL_SWITCH`, stops the loop; the Reaper keeps liquidating condemned agents. |
| Resume after stop | `node bin/automaton.mjs clear-kill`, then `run` again. The loop is not resurrected automatically. |
| Inspect what the wall blocks | `node bin/automaton.mjs brakes --symbol AAPL --notional 500` — prints the decision + rule that would fire. |
| Account/keys compromised | Stop the loop, stop the Reaper process, revoke the keys in the Alpaca dashboard. The plugin does not store keys. |
| Going live | Edit `automaton.config.json` or env: `mode=live`, `allowLive=true`, then `node bin/automaton.mjs arm-live --confirm "ARM LIVE"` (creates `LIVE_ARMED`). Then start. All 14 brakes still apply; there is no margin, shorting, options, or transfers. |
| Disarm live | Delete `automaton-data/LIVE_ARMED`, set `mode=paper` (or stop the loop first). |
| Stale/orphaned Reaper after an app upgrade | The control panel shows the Reaper row (pid, alive, heartbeat). A Reaper without a matching heartbeat is from an older generation and `Start` refuses to reuse it: press **Operator: stop Reaper** (two-step confirm) in the panel, then Start again. If the Host cannot signal it, run this once in your own terminal: `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*reaper-process.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }` |

The **agent** has no tool, IPC, or config write that can stop or reconfigure the Reaper: it is a
separate process with its own credentials path and schedule. The only stop surface is the
loopback-only operator control in the panel/Host (`POST /automaton/control`
`{"action":"reaper-stop","confirm":"STOP"}`) — it lives in the Harness Host, not in the engine,
and it is deliberately not exposed as an agent tool. A new Reaper reloads `registry.json` /
`ledger.json` before every sweep and writes a heartbeat, so an old non-reloading generation can
never silently overwrite newer state again.

## 8. Configuration

Effective config = defaults ← `automaton.config.json` (workspace root; the CLI reads it first)
← `automaton-data/automaton.config.json` (the plugin Host process runs with a different cwd, so
keep this mirror in sync) ← environment (`AUTOMATON_*`). `node bin/automaton.mjs config` shows the
redacted result and resolved paths. Key knobs:

| Field | Default | Meaning |
|---|---|---|
| `mode` | paper | sim / paper / live |
| `population.initial` / `.cap` | 3 / 10 | genesis size and population cap (this build: **30 / 60**) |
| `endowmentUsd` | 5000 | capital allocated per agent (virtual sub-ledger; this build: **$20**) |
| `deathFloorUsd` / `deathFloorPct` | 250 / 5% | equity at which death fires (this build: **$1 / 5%**) |
| `maxDrawdownPct` | 25% | risk-of-ruin death (this build: **20%**) |
| `burn.inferencePerCycleUsd` | 0.03 | per-agent inference cost per cycle (this build: **0.0002**) |
| `burn.dataPerCycleUsd` | 0.005 | per-agent market-data cost per cycle (this build: **0.00005**) |
| `cycleBudget` | 0.08/0.03/0.01 | STABLE/TIGHT/CRITICAL thinking budget |
| `replication.*` | 150 USD / 72 h / 2500 USD | breeding gate + child endowment (this build: **$3 / 72 h / $10**) |
| `data.maxHypothesesPerCycle` | 3 | proven hypotheses per cycle (this build: **40**, so 30 agents can each trade their own strategy) |
| `risk.*` | see `src/config.js` | max position %, order caps, daily orders, loss limits, session window, symbol whitelist |

## 9. Troubleshooting

- `CONFIG_INVALID: missing Alpaca credentials` → create/fix `.env`; check `--env-file`.
- `LIVE_NOT_ARMED` → mode=live requires `allowLive=true` and `LIVE_ARMED`.
- `refusing to start ... external Reaper unavailable` → check `automaton-data/reaper.log`,
  `AUTOMATON_NODE_BIN` (Node executable for the detached Reaper), and write access to the
  state dir. This is deliberate: no Reaper, no paper/live population.
- `reconciliation` mismatch in status → the virtual ledger and the broker disagree beyond
  tolerance; the Treasurer halts new orders. Inspect `ledger.json` vs Alpaca positions.
- Orders denied with `MARKET_CLOSED`/`OUTSIDE_WINDOW` → expected outside RTH; the executor
  only opens positions inside the configured window.
- All agents `CONDEMNED` but still `alive` → the Reaper process is not running; start it
  (`node src/reaper-process.js --state-dir ..\..\automaton-data`) or restart the engine.

## 10. Single-writer rule (ledger/registry)

The engine is the primary writer of `registry.json`/`ledger.json`. The external Reaper reloads both
before every sweep and now persists them **only when a sweep actually kills an agent** — an earlier
unconditional save overwrote newer engine writes (observed live: three small research charges
vanished). If you suspect drift after a crash or a manual experiment: **stop the loop**, then run the
idempotent repairs `node scripts/reconcile-fills.mjs` (broker fills → virtual ledger) and
`node scripts/reconcile-research-charges.mjs` (research charges), then Start again.

Never run the CLI `tick`/`run` while the engine loop is already running: two engine writers will race
the same state files. Use the panel/control route to start/stop the one writer.
