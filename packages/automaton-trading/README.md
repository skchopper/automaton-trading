# @local/automaton-trading

DeepSeek Harness plugin bundle for **AUTOMATON TRADING** — a mortality-engineered
multi-agent trading system on Alpaca. The plugin owns the Harness shell only: the
engine, roles, brakes, and journal live in `src/` (Lead-owned) and are reached through
one facade (`src/engine.js`).

The theory is simple: a trading strategy is not a task, it is a **life with a runway**.
The unprofitable die, the profitable reproduce, and every death leaves a structured
obituary the living read.

## What this package adds

| Surface | Detail |
|---|---|
| 10 agent tools | `automaton_status`, `automaton_start`, `automaton_stop`, `automaton_tick`, `automaton_agents`, `automaton_obituaries`, `automaton_brakes`, `automaton_simulate`, `automaton_config`, `automaton_emergency_stop` |
| Sidebar entry | `sidebar.panellist`: one "Automaton" entry in the sidebar's global panel list (strategy/skull glyph, localized label) |
| Control panel | `main` keyed panel `automaton-trading`: the full dashboard opened from the sidebar in the central column — header stats, operator controls, the 30-agent table, per-agent drill-down, generation rollup and obituary feed |
| Settings page | Settings → Built-in plugins → **Automaton Trading** (`settings.plugins.tab`): the same dashboard as a full page |
| State route | `GET /automaton/state` — the redacted JSON every dashboard surface polls every 3 s (auto-refresh with pause) |
| Control route | `POST /automaton/control` — loopback-only operator controls used by the panel's buttons (including the operator-only Reaper stop) |
| Research sidecar | Host-side Harness-LLM bridge for the engine's per-agent isolated hourly analyst; briefings surface in the agent table and detail pane |

Everything is dependency-free ESM with no build step; the browser module is loaded as
plain JavaScript (`./client`). `dsh.client.inject` orders the client half after the real
installed client plugins that own the slots: `@deepseek-ai/dsh-client-ui-layout` (the
`main` keyed panel) and `@deepseek-ai/dsh-client-ui-sidebar` (`sidebar.panellist`), plus
`@deepseek-ai/dsh-client-locale`.

## The control panel (30 agents at $20)

The engine runs a **30-agent population with a $20 endowment per agent**. Every agent has
a **strategy-derived name** (e.g. `Momentum AAPL`, `MeanRev NVDA`, `Breakout TSLA`); the
short random id is shown underneath as the secondary, machine-facing label. Search,
sorting and the obituary feed use the name first.

The dashboard shows, per agent: name, generation, **Genome** (`family symbol` inherited
from the parent, e.g. `Momentum AAPL`) and **Trading (spec)** (the compiled hypothesis the
Builder actually trades — it can differ from the genome, shown with a `≠` marker), equity,
USD/percent P&L, day P&L, net-7d, a runway bar, treasury state, alive/dead/condemned
status plus cause, and a positions/trades count.

**Click any agent row** to open the inline detail pane (right-hand side on wide screens,
stacked below on narrow ones; `Esc` or the × closes it):

- header: name, status, generation, born/died, cause, note, parent/mutation, equity,
  cash, positions value, endowment, day/net-7d P&L, realized/unrealized P&L, runway,
  drawdown, first-profit time, compiled-spec timestamp;
- **Current holdings** table: symbol, qty, avg price, last price, market value,
  unrealized P&L, opened-at (empty state "No open positions.");
- **Past activity**: the last fills newest-first — side, symbol, qty, price, notional,
  realized P&L, time (empty state "No trades yet · market closed.");
- **Strategy parameters** for both the inherited **genome** and the compiled **spec**
  (lookback / entryZ / exitZ / stop / target / max-hold / size / session), with a warning
  when the compiled spec differs, and a note when an agent has no compiled spec yet;
- **Role costs** per role (treasurer / prospector / builder / executor / replicator /
  reaper).

Plus:

- **Sort** by clicking the Agent, Gen, Equity, P&L, Day %, Runway or Status headers.
- **Filter** by All / Alive / Dead (plus Condemned when any exist) and free-text search
  across name, id, symbol, family and parent name.
- **Generations** summarises born/alive/dead per generation; **Obituaries** lists the
  last 8 deaths (name, cause, lifespan, net P&L, first-profit time).
- **Auto-refresh**: 3 s, with an explicit Pause/Resume toggle shared by every surface.
  A request is never issued while the previous one is in flight; timers/listeners are
  cleaned up on unmount.
- **Controls**: `Start` (disabled while running or while the kill switch is armed),
  `Stop` (disabled while stopped), `Emergency Stop` (two-step: first click arms a red
  `CONFIRM STOP`, second click sends `{action:"emergency-stop", confirm:"STOP"}`).
  In-flight and error states are shown inline; the kill-switch indicator turns red once
  the marker file exists (`REAPER_UNAVAILABLE` from `Start` is shown when a stale Reaper
  refuses to be reused).

### Operator Reaper row (important after an app restart)

The dashboard header shows the external Reaper read fresh from disk by the engine:
`Reaper — pid 24452 · alive · heartbeat 3s ago (v2) · 51 sweeps`, or
`Reaper — pid 24452 · alive · no heartbeat (stale generation)` when it belongs to a
previous app generation. Only a **stale-generation** Reaper gets the two-step
**Operator: stop Reaper** button (first click arms `CONFIRM STOP REAPER`, second sends
`{action:"reaper-stop", confirm:"STOP"}`); it terminates the orphan by pid from the Host
process and removes `reaper.pid`. A fresh generation (`heartbeat v2`) is the mortality
enforcer for the running population, so the panel shows "operator stop not required"
instead of a stop button.

> Agents cannot stop the Reaper — this is a deliberate operator-only control.
> The Reaper has no engine control surface (brake D12); the Host plugin only signals the
> external OS process, exactly like `kill` from a terminal. It is never exposed as an
> agent tool.

**Startup priority after an app restart:**

1. **Stop Reaper** — if the row shows a stale generation (`alive` without heartbeat v2),
   click it, then `CONFIRM STOP REAPER`. The engine refuses to start while a stale
   generation is alive (`REAPER_UNAVAILABLE` with an operator hint).
2. **Start** — once the Reaper row shows `not running` (a fresh Reaper is spawned by
   `engine.start()` for paper/live), press `Start`.

### Research sidecar — isolated hourly analyst

Every living agent gets an **isolated** hourly LLM briefing about *its own* strategy and
book (its own symbols, positions and past briefings — never another agent's data, another
role's memory or a shared conversation). The reply is strict JSON: `sentiment` (-1..1),
`confidence` (0..1), `verdict` (`HOLD` | `AVOID` | `ALERT`), catalysts (≤4), risks (≤4),
a ≤400-char summary and dated sources. In **influence** mode the briefing can veto
entries, shrink size or force an exit; in **shadow** mode it is logged but never applied.
The agent pays ~`$0.001` per run from its own ledger (~$0.72/day for 30 hourly agents), so
research raises its burn exactly like any other inference cost.

- **Cadence**: per-agent `research.intervalSec` (default 3600 s = hourly) with
  `staggerSec` spreading the population inside the hour; briefings older than
  `research.maxAgeSec` are ignored by the executor.
- **Isolation**: one private LLM call per agent — no shared conversation, no order tool,
  no wallet access; the analyst only advises that agent's executor.
- **Harness bridge (no extra key needed)**: the plugin implements the `ResearchProvider`
  seam on the Host `llm` service. Provider/model resolve from
  `agentDefaultModel.currentSelection()` (fallback: first registered provider + its first
  model) and may be overridden by plugin-row `researchProvider` / `researchModel` (or
  nested `config.research.provider/model`). Calls stream through
  `llm.prepareCall(...)` + `prepared.stream(...)` at temperature 0.2 with bounded output
  tokens; provider failures are returned as clean errors for the researcher's log and
  never crash the plugin or engine.
- **No LLM bridge / key**: the plugin passes no generator, `engine.research.configured`
  becomes `false`, the dashboard shows "research disabled: no LLM bridge / key", briefings
  go stale and are ignored, and trading continues unchanged. The headless CLI (outside the
  Harness) instead uses `DEEPSEEK_API_KEY` against
  `https://api.deepseek.com/chat/completions`.
- **Dashboard display**: a compact table badge (`HOLD +0.2` / `AVOID -0.6` / `ALERT`,
  `—` when no briefing, dimmed when stale) and a **Research — isolated hourly analyst**
  section in the agent detail pane (briefing age, verdict, sentiment, confidence, summary,
  catalysts, risks, clickable sources, provider/model, run/error counters) plus a
  shadow-vs-influence line. `engine.research` (enabled/configured/influence/interval/
  lastRun/nextDue/provider/model/runs/errors) and each agent's `research` are carried by
  `GET /automaton/state`; no research control action or agent tool is added.

### `POST /automaton/control`

Loopback-only operator surface: requests whose socket address is not loopback
(`127.0.0.0/8`, `::1`, IPv4-mapped variants) get `403 FORBIDDEN`, so a remote browser
session cannot drive the population.

```http
POST /automaton/control
Content-Type: application/json

{"action": "start"}
{"action": "stop"}
{"action": "emergency-stop", "confirm": "STOP"}
{"action": "reaper-stop", "confirm": "STOP"}
```

| Response | Meaning |
|---|---|
| `200 {"ok":true,"action":"…","result":{…}}` | action accepted (`start`/`stop` result is the redacted engine view; `reaper-stop` result is `{stopped,pid,alive,reason?,signals?,heartbeat?}`) |
| `400` `BAD_ACTION` / `BAD_JSON` / `CONFIRM_REQUIRED` | malformed body, unknown action, or `emergency-stop`/`reaper-stop` without `confirm: "STOP"` |
| `403` `FORBIDDEN` | request did not arrive over a loopback connection |
| `405` `METHOD_NOT_ALLOWED` | not a `POST` |
| `409` `LIVE_NOT_ARMED` | `start` in live mode before the operator armed `LIVE_ARMED` |
| `409` `REAPER_UNAVAILABLE` | `start` refused because an alive Reaper has no version-2 heartbeat (stop it first) |
| `409` `EPERM` / `REAPER_STOP_FAILED` | the Host could not signal the Reaper process; the response carries `hint: "stop it from the operating system terminal"` |
| `5xx` | engine failure, as `{"ok":false,"isError":true,"error":{"code","message"}}` |

`reaper-stop` is implemented **entirely in this Host plugin**: it reads
`<stateDir>/reaper.pid` (plus `<stateDir>/reaper.heartbeat.json` for freshness), sends
`SIGTERM`, waits ~400 ms, escalates to `SIGKILL` if the process is still alive, and
removes the pid file. If there is no pid file or the process is not running it returns
`200 {"ok":true,"result":{"stopped":false,"reason":…}}` and cleans up a stale pid file.

## Install

The bundle is installed into the current Harness profile from its directory:

```
plugin_manager install_bundle { "target": "D:\\CounterStikers\\packages\\automaton-trading" }
```

The plugin installs with `autoStart: false`; the population starts only when you press
**Start** (or an agent calls `automaton_start`). After install (refresh/restart the app
so the new client module + routes load), verify:

1. The sidebar shows an **Automaton** entry; clicking it opens the dashboard in the
   central column (no floating window any more).
2. Settings → Built-in plugins → Automaton Trading shows the same dashboard as a page.
3. Clicking an agent opens its holdings / past activity / genome-vs-spec detail pane.
4. The Reaper row is visible; if it shows a stale generation, **Stop Reaper** then **Start**.
5. `GET http://127.0.0.1:<port>/automaton/state` returns JSON with `"ok": true`, and a
   local `POST /automaton/control` with `{"action":"stop"}` returns `{"ok":true}`.
6. The tool list contains the ten `automaton_*` tools (the Reaper stop is intentionally
   **not** among them).
7. Research: the table shows research badges once the first hourly run lands (or a
   `—`), clicking an agent shows the briefing section, and a "research disabled" note
   appears instead when the Host has no LLM bridge. `GET /automaton/state` carries
   `engine.research` and `agents[].research`.

## Configuration

`cordis.patch.yml` inserts row `automaton-trading` with this config (edit it in your
profile patch to change paths; the row patch is the user's layer and survives upgrades):

```yaml
- insert:
    - id: automaton-trading
      name: '@local/automaton-trading'
      config:
        stateDir: 'D:\CounterStikers\automaton-data'
        envFile: 'D:\CounterStikers\.env'
        mode: paper          # sim | paper | live — paper is the default
        autoStart: false     # never auto-starts live; sim/paper only
        allowLive: false     # live additionally needs mode=live + LIVE_ARMED marker
```

Layering inside the engine is `defaults <- config file <- plugin row <- environment`
(`AUTOMATON_*`, `ALPACA_*`). Credentials are never stored in the config: they are read
from `envFile`/environment into a short-lived credentials object at broker construction.

Test seam: `config.engineFactory` may be supplied (function `(rowConfig, research) => engine`,
sync or async) to replace the real `createEngine`; the second argument is the Host-built
research bridge (or `null` when no LLM bridge exists). It exists for `node --test` and is
not a production configuration surface.

Research overrides (optional, plugin-row config): `researchProvider` / `researchModel`
take precedence over `agentDefaultModel.currentSelection()` and the first-registered
provider/model fallback; the same values may be supplied as nested
`config.research.provider` / `config.research.model`. The engine-side `research` config
(`enabled`, `influence`, `intervalSec`, `staggerSec`, `costPerRunUsd`, `maxAgeSec`, …)
stays in the engine's layered config.

## Tools

| Tool | Contract |
|---|---|
| `automaton_status` | Redacted snapshot: mode, account, treasury/runway, population, agents, recent obituaries, kill switch, last tick/error. Same JSON as the route. |
| `automaton_start` | Start the in-process cycle loop. Refuses **live** unless the operator armed `LIVE_ARMED`; never starts the external Reaper. |
| `automaton_stop` | Stop the cycle loop only. The external Reaper process is unaffected by design. |
| `automaton_tick` | Run exactly one cycle now; returns trace + refreshed status. |
| `automaton_agents` | Population rows with generation, equity, runway, state, cause; optional genomes. |
| `automaton_obituaries` | Newest-first death journal, `limit` (1–200) and `cause` filter. |
| `automaton_brakes` | The 14 brake rules (D1–D14), kill-switch/live-armed state, and an **operator dry-run** pre-trade check when `symbol` is given. Advisory only — places no order. |
| `automaton_simulate` | Accelerated deterministic mortality simulation (`cycles`, `population`, `seed`), no broker/network. |
| `automaton_config` | Effective redacted config + layer sources; no credential material. |
| `automaton_emergency_stop` | Requires `confirm: "STOP"`. Arms the `KILL_SWITCH` marker (checked before every order/cycle), stops the loop, leaves the Reaper running. |

All tools return one structured JSON envelope: `{"ok": true, ...}` on success or
`{"ok": false, "isError": true, "error": {"code": "...", "message": "..."}}` on failure.
Errors are mapped to stable codes (`LIVE_NOT_ARMED`, `CONFIRM_REQUIRED`,
`ENGINE_UNAVAILABLE`, ...), free-form messages are scrubbed, and responses are redacted.

## Safety notes

- **Paper is the default.** `mode: paper` uses `paper-api.alpaca.markets`; `sim` uses the
  deterministic in-process broker and needs no credentials.
- **Live is gated four ways:** `mode=live`, `allowLive=true`, the operator-written
  `LIVE_ARMED` marker file, and credentials matching the endpoint. `automaton_start`
  refuses live until all hold; `autoStart` is ignored for live entirely.
- **The Reaper is external.** It runs as a separate OS process, re-derives death from
  broker state, liquidates, and writes the obituary. There is **no engine control
  surface** over it (brake D12): no engine method, no IPC, no config write and no agent
  tool can stop it, and `automaton_stop`/`automaton_emergency_stop` stop trading loops
  only. The single exception is the **operator-only** `reaper-stop` action of this Host
  plugin, which signals the external pid from the Host process exactly like `kill` in a
  terminal — a deliberate operator escape hatch for orphaned stale-generation Reapers,
  never exposed to agents. An alive Reaper without a version-2 heartbeat makes
  `engine.start()` refuse with `REAPER_UNAVAILABLE` until the operator stops it.
- **14 brakes in code, not prompts.** No transfers/withdrawals, no margin/shorting/options,
  session window, symbol/size/order caps, daily-loss and drawdown death rules, proof-or-nothing
  builds, population cap, kill switch, external Reaper isolation, allocation cap, and
  one-way death (no resurrection). See `docs/ARCHITECTURE.md`.
- **Controls are local-only.** `POST /automaton/control` is loopback-only and is the only
  write surface the UI has. `start`/`stop`/`emergency-stop` map exactly to
  `engine.start` / `engine.stop` / `engine.emergencyStop`; `emergency-stop` and the
  operator-only `reaper-stop` require `confirm: "STOP"`. No dashboard surface can clear
  the kill switch, place an order, or change the engine configuration.
- **Kill switch:** `automaton_emergency_stop` (tool or control panel) writes
  `<stateDir>/KILL_SWITCH`; every order and cycle is denied while the file exists, and
  the panel's red indicator follows the marker file itself (not a possibly-stale engine
  snapshot). Clearing it is a deliberate operator action on the filesystem — no tool and
  no UI button can clear it.
- **Research is advisory.** The per-agent analyst has no order tool, no wallet access and
  no shared memory; its briefing can only veto/resize/exit through the agent's own
  executor, and every order still passes the 14 brakes. If the LLM is unavailable
  (`configured:false`) trading continues deterministically and stale briefings are ignored.
  Research cost is charged to the agent's own ledger like any other inference cost.
- **Secrets:** never returned by tools, the state route, or the dashboard. `configView`
  exposes only the env-file path and credential source signature. LLM failures are logged
  as scrubbed, structured errors — never credentials or full provider payloads.

## Development

```
node --check index.js && node --check client.js
node test/plugin.test.js
# or, when child-process spawning is allowed:
node --test --experimental-test-isolation=none test/plugin.test.js
```

The test suite uses a fake Cordis context and `config.engineFactory`; it never touches the
network, a broker, or the Harness profile. (Under the Windows DSH sandbox the default
`node --test <file>` runner cannot spawn its per-file worker — `spawn EPERM` — so run the
file in-process with `node test/plugin.test.js` or disable test isolation as shown.)

Layout: `index.js` (Host tools + state/control routes + engine lifecycle + the
operator-only Reaper stop helper), `client.js` (shared dashboard: sidebar entry + keyed
`main` panel + settings page; agent names/genome-vs-spec/holdings/activity mapping and
Reaper telemetry are pure functions exported as `helpers` for tests),
`locale/{en,zh}.json` (plugin metadata), `icon.svg`, `test/plugin.test.js`, `src/**`
(engine implemented by the core project).

