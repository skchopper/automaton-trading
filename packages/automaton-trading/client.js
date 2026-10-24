/**
 * Client (browser) half of the AUTOMATON TRADING bundle.
 *
 * ONE shared dashboard, registered in three slot surfaces:
 *  - `sidebar.panellist`  sidebar entry (glyph; label "Automaton") that selects the panel.
 *  - `main`               keyed central panel with key `automaton-trading`: the full
 *                         control dashboard opened from the sidebar (not a floating window).
 *  - `settings.plugins.tab` the same dashboard as a secondary full page.
 *
 * Dashboard: header stats, Start / Stop / Emergency controls, 3 s auto-refresh + pause,
 * kill-switch indicator, generation rollup, obituary feed, and a clickable 30-100-agent
 * table. Clicking an agent opens an inline detail pane (holdings + past activity +
 * genome/spec strategy parameters + role costs + death info). Agent names are the
 * strategy-derived labels from the engine ("Momentum AAPL"), with the short id secondary;
 * the inherited genome and the currently-traded compiled spec are shown separately
 * because the Builder can trade a different hypothesis than the inherited genome.
 *
 * Host routes (relative URLs only): `GET /automaton/state` (3 s poll) and
 * loopback-only `POST /automaton/control` for operator actions.
 *
 * Pure data mapping (`buildAgentRows`, `buildHoldingsRows`, `buildActivityRows`, …) is
 * exported under `helpers` so it can be unit-tested without a browser. Styling uses
 * Harness theme tokens (`--dsw-alias-*`) with fallbacks only; timers/listeners are
 * cleaned up on unmount.
 */

window.__ModuleLoader__.load({
  id: '@local/automaton-trading',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'automaton-trading';
    const STATE_URL = '/automaton/state';
    const CONTROL_URL = '/automaton/control';
    const POLL_MS = 3000;
    const PANEL_ID = 'automaton-trading';
    const SIDEBAR_SLOT = 'sidebar.panellist';
    const MAIN_SLOT = 'main';
    const SETTINGS_SLOT = 'settings.plugins.tab';
    const MAX_OBITUARIES = 8;
    const MODE_LABEL = { sim: 'SIM', paper: 'PAPER', live: 'LIVE' };
    const STATUS_FILTERS = ['all', 'alive', 'dead', 'condemned'];
    const SORTABLE_KEYS = new Set(['name', 'generation', 'equityUsd', 'pnlUsd', 'runwayHours', 'dayPnlPct', 'status']);
    const FAMILY_LABELS = { momentum: 'Momentum', meanrev: 'MeanRev', breakout: 'Breakout', gapfade: 'GapFade' };

    // -----------------------------------------------------------------------
    // locale (inline dictionaries; EN is the fallback)
    // -----------------------------------------------------------------------

    const EN = {
      tab: 'Automaton Trading',
      sidebarLabel: 'Automaton',
      title: 'Automaton Trading',
      subtitle: 'Mortality-engineered strategies: the unprofitable die, the profitable reproduce, every death leaves a record.',
      loading: 'Loading automaton state…',
      connecting: 'connecting…',
      offline: 'Automaton offline',
      running: 'running',
      stopped: 'stopped',
      killOn: 'KILL SWITCH ARMED',
      killOff: 'kill switch clear',
      killSwitch: 'Kill switch',
      armed: 'ARMED',
      clear: 'clear',
      reaper: 'Reaper',
      reaperAlive: 'alive',
      reaperNotRunning: 'not running',
      reaperStale: 'no heartbeat (stale generation)',
      reaperHealthy: 'heartbeat',
      reaperVersion: 'heartbeat v',
      reaperSweeps: 'sweeps',
      reaperStop: 'Operator: stop Reaper',
      reaperConfirm: 'CONFIRM STOP REAPER',
      reaperHint: 'Agents cannot stop the Reaper — this is an operator control.',
      reaperStaleWarning: 'stale generation — operator stop required; the engine refuses to start until it is stopped.',
      reaperHealthyNote: 'fresh generation (heartbeat v2) — operator stop not required',
      reaperStopped: 'Reaper stopped',
      reaperStopFailed: 'Reaper stop failed',
      mode: 'Mode',
      loop: 'Loop',
      account: 'Account equity',
      cash: 'Cash',
      treasury: 'Treasury / runway',
      population: 'Population',
      alive: 'alive',
      dead: 'dead',
      condemned: 'condemned',
      total: 'total',
      cap: 'cap',
      burn: 'Burn rate',
      allocated: 'Allocated / cap',
      lastTick: 'Last tick',
      obituaries: 'Obituaries',
      generations: 'Generations',
      agents: 'Agents',
      agent: 'Agent',
      gen: 'Gen',
      strategy: 'Strategy',
      genome: 'Genome',
      trading: 'Trading (spec)',
      params: 'Params',
      equity: 'Equity',
      pnl: 'P&L',
      dayPnl: 'Day %',
      net7d: 'Net 7d',
      runway: 'Runway',
      treasuryState: 'Treasury',
      statusLabel: 'Status',
      cause: 'Cause',
      positions: 'Pos.',
      parent: 'Parent',
      mutation: 'Mutation',
      search: 'Search name, id, symbol, family…',
      filterAll: 'All',
      filterAlive: 'Alive',
      filterDead: 'Dead',
      filterCondemned: 'Condemned',
      rows: 'rows',
      clickHint: 'Click an agent for holdings & activity',
      noAgents: 'No agents yet. Start the engine below or run a tick.',
      noObits: 'No deaths recorded yet.',
      noGenerations: 'No generation data yet.',
      start: 'Start',
      stop: 'Stop',
      emergency: 'Emergency Stop',
      confirmStop: 'CONFIRM STOP',
      cancel: 'Cancel',
      pause: 'Pause',
      resume: 'Resume',
      refreshing: 'refreshing…',
      autoRefresh: 'auto-refresh 3 s',
      pausedLabel: 'paused',
      halted: 'HALTED — new orders are blocked',
      brakes: '14 hard brakes enforced in code',
      externalReaper: 'External Reaper runs as a separate process; it cannot be stopped from the engine.',
      lastError: 'Last error',
      neverProfited: 'never profitable',
      firstProfit: 'First profit',
      lifespan: 'lifespan',
      updated: 'updated',
      controlOk: '{action} accepted',
      controlFailed: 'Control action failed',
      close: 'Close',
      detailTitle: 'Agent detail',
      selectAgent: 'Select an agent to inspect its holdings and past activity.',
      holdings: 'Current holdings',
      noPositions: 'No open positions.',
      activity: 'Past activity',
      noTrades: 'No trades yet · market closed.',
      side: 'Side',
      buy: 'BUY',
      sell: 'SELL',
      symbol: 'Symbol',
      qty: 'Qty',
      avgPrice: 'Avg price',
      lastPrice: 'Last price',
      marketValue: 'Market value',
      unrealized: 'Unrealized',
      openedAt: 'Opened',
      time: 'Time',
      price: 'Price',
      notional: 'Notional',
      realized: 'Realized',
      cost: 'Cost',
      costs: 'Role costs',
      strategyParams: 'Strategy parameters',
      genomeParams: 'Genome (inherited)',
      specParams: 'Trading (compiled spec)',
      specCreated: 'Compiled',
      noSpec: 'No compiled spec yet — trading the inherited genome.',
      specDiffers: 'compiled spec differs from inherited genome',
      genomeOnly: 'genome only',
      born: 'Born',
      died: 'Died',
      drawdown: 'Drawdown',
      endowment: 'Endowment',
      positionsValue: 'Positions value',
      tradingState: 'Alive / dead',
      dayPnlTitle: 'Day P&L',
      net7dTitle: 'Net 7 d',
      role: 'Role',
      amount: 'Amount',
      tradesCount: 'Trades',
      positionsCount: 'Positions',
      mutationFrom: 'from',
      mutationTo: 'to',
      noParent: 'genesis',
      none: '—',
    };

    const ZH = {
      tab: '自动交易生命体',
      sidebarLabel: '自动交易',
      title: '自动交易生命体',
      subtitle: '死亡机制驱动的策略种群：不赚钱的死去，赚钱的复制，每一次死亡都留下记录。',
      loading: '正在读取自动交易状态…',
      connecting: '连接中…',
      offline: '自动交易离线',
      running: '运行中',
      stopped: '已停止',
      killOn: '熔断开关已触发',
      killOff: '熔断开关未触发',
      killSwitch: '熔断开关',
      armed: '已触发',
      clear: '未触发',
      reaper: 'Reaper',
      reaperAlive: '存活',
      reaperNotRunning: '未运行',
      reaperStale: '无心跳（过期世代）',
      reaperHealthy: '心跳',
      reaperVersion: '心跳版本 v',
      reaperSweeps: '次清扫',
      reaperStop: '操作员：停止 Reaper',
      reaperConfirm: '确认停止 Reaper',
      reaperHint: '智能体无法停止 Reaper —— 这是操作员控制。',
      reaperStaleWarning: '世代过期 — 需要操作员停止；在停止前引擎将拒绝启动。',
      reaperHealthyNote: '世代正常（心跳 v2）— 无需操作员停止',
      reaperStopped: 'Reaper 已停止',
      reaperStopFailed: '停止 Reaper 失败',
      mode: '模式',
      loop: '循环',
      account: '账户权益',
      cash: '现金',
      treasury: '金库 / 续航',
      population: '种群',
      alive: '存活',
      dead: '死亡',
      condemned: '待处决',
      total: '总数',
      cap: '上限',
      burn: '燃烧速率',
      allocated: '已分配 / 上限',
      lastTick: '最近周期',
      obituaries: '死亡记录',
      generations: '世代',
      agents: '个体',
      agent: '个体',
      gen: '世代',
      strategy: '策略',
      genome: '基因组',
      trading: '交易（规格）',
      params: '参数',
      equity: '权益',
      pnl: '盈亏',
      dayPnl: '当日 %',
      net7d: '7日净额',
      runway: '续航',
      treasuryState: '金库',
      statusLabel: '状态',
      cause: '死因',
      positions: '持仓',
      parent: '父代',
      mutation: '变异',
      search: '搜索名称、id、代码、策略族…',
      filterAll: '全部',
      filterAlive: '存活',
      filterDead: '死亡',
      filterCondemned: '待处决',
      rows: '行',
      clickHint: '点击个体查看持仓与历史活动',
      noAgents: '暂无个体。启动下方引擎或运行一个周期。',
      noObits: '暂无死亡记录。',
      noGenerations: '暂无世代数据。',
      start: '启动',
      stop: '停止',
      emergency: '紧急停止',
      confirmStop: '确认停止',
      cancel: '取消',
      pause: '暂停',
      resume: '继续',
      refreshing: '刷新中…',
      autoRefresh: '每 3 秒自动刷新',
      pausedLabel: '已暂停',
      halted: '已暂停 — 新订单被阻止',
      brakes: '14 条硬熔断由代码强制执行',
      externalReaper: '外部 Reaper 是独立进程，无法从引擎中停止。',
      lastError: '最近错误',
      neverProfited: '从未盈利',
      firstProfit: '首次盈利',
      lifespan: '存活时长',
      updated: '更新于',
      controlOk: '{action} 已受理',
      controlFailed: '控制操作失败',
      close: '关闭',
      detailTitle: '个体详情',
      selectAgent: '选择一个个体，查看其持仓与历史活动。',
      holdings: '当前持仓',
      noPositions: '暂无持仓。',
      activity: '历史活动',
      noTrades: '暂无成交记录 · 市场休市。',
      side: '方向',
      buy: '买入',
      sell: '卖出',
      symbol: '代码',
      qty: '数量',
      avgPrice: '均价',
      lastPrice: '现价',
      marketValue: '市值',
      unrealized: '未实现',
      openedAt: '开仓',
      time: '时间',
      price: '价格',
      notional: '名义金额',
      realized: '已实现',
      cost: '成本',
      costs: '角色成本',
      strategyParams: '策略参数',
      genomeParams: '基因组（继承）',
      specParams: '交易（编译规格）',
      specCreated: '编译于',
      noSpec: '暂无编译规格 — 按继承基因组交易。',
      specDiffers: '编译规格与继承基因组不同',
      genomeOnly: '仅基因组',
      born: '出生',
      died: '死亡',
      drawdown: '回撤',
      endowment: '初始资金',
      positionsValue: '持仓市值',
      tradingState: '存活 / 死亡',
      dayPnlTitle: '当日盈亏',
      net7dTitle: '7日净额',
      role: '角色',
      amount: '金额',
      tradesCount: '成交',
      positionsCount: '持仓',
      mutationFrom: '从',
      mutationTo: '到',
      noParent: '创世',
      none: '—',
    };

    /** Bind the Client locale service; fall back to the bundled English dictionary. */
    function createTranslator(ctx) {
      try {
        const locale = ctx && ctx.locale;
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(
            () => locale.register(NS, { en: EN, zh: ZH }),
            'automaton-trading: locale dictionaries',
          );
          const bound = locale.bind(NS);
          if (typeof bound === 'function') {
            return (key) => {
              const value = bound(key);
              return typeof value === 'string' && value.length > 0 ? value : (EN[key] ?? key);
            };
          }
        }
      } catch {
        /* locale is optional for rendering; never blank the panel because of it */
      }
      return (key) => EN[key] ?? key;
    }

    // -----------------------------------------------------------------------
    // formatting helpers (pure)
    // -----------------------------------------------------------------------

    function toNumber(value) {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    function round2(value) {
      return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
    }

    function fmtUsd(value) {
      const number = toNumber(value);
      if (number === null) return '—';
      return `$${number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    function fmtSignedUsd(value) {
      const number = toNumber(value);
      if (number === null) return '—';
      const sign = number > 0 ? '+' : number < 0 ? '−' : '';
      return `${sign}$${Math.abs(number).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    /** Accept a fraction (0.023) or points (2.3) and render percent points. */
    function pctPoints(value) {
      const number = toNumber(value);
      if (number === null) return null;
      return Math.abs(number) <= 1 ? number * 100 : number;
    }

    function fmtPct(value) {
      const points = pctPoints(value);
      if (points === null) return '—';
      const sign = points > 0 ? '+' : points < 0 ? '−' : '';
      return `${sign}${Math.abs(points).toFixed(1)}%`;
    }

    function fmtPercentPoints(points) {
      const number = toNumber(points);
      if (number === null) return '—';
      const sign = number > 0 ? '+' : number < 0 ? '−' : '';
      return `${sign}${Math.abs(number).toFixed(1)}%`;
    }

    function fmtPctPlain(value) {
      const points = pctPoints(value);
      if (points === null) return '—';
      return `${Math.abs(points).toFixed(0)}%`;
    }

    function fmtNum(value) {
      const number = toNumber(value);
      if (number === null) return '—';
      return Math.trunc(number).toLocaleString('en-US');
    }

    function fmtQty(value) {
      const number = toNumber(value);
      if (number === null) return '—';
      const fixed = Math.abs(number) >= 1 ? number.toFixed(2) : number.toFixed(4);
      return fixed.replace(/\.?0+$/, '');
    }

    function fmtHours(value) {
      const number = toNumber(value);
      if (number === null) return '—';
      if (number >= 100) return `${Math.round(number)} h`;
      return `${number.toFixed(1)} h`;
    }

    function fmtAgo(iso) {
      if (!iso) return '—';
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return '—';
      const deltaSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (deltaSec < 60) return `${deltaSec}s`;
      if (deltaSec < 3600) return `${Math.round(deltaSec / 60)}m`;
      if (deltaSec < 86400) return `${Math.round(deltaSec / 3600)}h`;
      return new Date(ms).toLocaleDateString();
    }

    function fmtDateTime(iso) {
      if (!iso) return '—';
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return '—';
      return new Date(ms).toLocaleString();
    }

    function shortId(value) {
      const text = String(value ?? '');
      return text.startsWith('atm-') ? text.slice(4) : text;
    }

    function errorText(error) {
      if (!error) return '';
      if (typeof error === 'string') return error;
      return String(error.message ?? error.code ?? JSON.stringify(error));
    }

    function modeOf(data) {
      const mode = String(data?.mode ?? data?.config?.mode ?? 'unknown').toLowerCase();
      return MODE_LABEL[mode] ? mode : 'unknown';
    }

    function lifespanHours(bornAt, diedAt) {
      if (!bornAt || !diedAt) return null;
      const born = Date.parse(bornAt);
      const died = Date.parse(diedAt);
      if (!Number.isFinite(born) || !Number.isFinite(died) || died < born) return null;
      return round2((died - born) / (60 * 60 * 1000));
    }

    // -----------------------------------------------------------------------
    // strategy labels (pure; names are strategy-derived, engine-provided)
    // -----------------------------------------------------------------------

    function familyLabel(family) {
      const key = String(family ?? '').trim().toLowerCase();
      if (key.length === 0) return '';
      return FAMILY_LABELS[key] ?? `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    }

    /** "Momentum AAPL" from a genome/spec; '' when neither field is present. */
    function strategyLabel(strategy) {
      if (!strategy || typeof strategy !== 'object') return '';
      const family = familyLabel(strategy.family);
      const symbol = typeof strategy.symbol === 'string' && strategy.symbol.length > 0 ? strategy.symbol : '';
      return [family, symbol].filter(Boolean).join(' ').trim();
    }

    /** Primary agent label: engine name, else strategy label, else short id. */
    function agentDisplayName(agent) {
      if (agent && typeof agent.name === 'string' && agent.name.trim().length > 0) return agent.name.trim();
      const strategy = strategyLabel(agent?.genome);
      if (strategy.length > 0) return strategy;
      return shortId(agent?.id);
    }

    /** Strategy parameter summary for one genome/spec params object. */
    function strategyParamsText(params) {
      if (!params || typeof params !== 'object') return '—';
      const parts = [];
      if (params.lookback !== undefined) parts.push(`lb${params.lookback}`);
      if (params.entryZ !== undefined || params.exitZ !== undefined) parts.push(`z${params.entryZ ?? '?'}/${params.exitZ ?? '?'}`);
      if (params.stopPct !== undefined || params.targetPct !== undefined) {
        parts.push(`s${fmtPctPlain(params.stopPct)}/t${fmtPctPlain(params.targetPct)}`);
      }
      if (params.maxHoldBars !== undefined) parts.push(`h${params.maxHoldBars}`);
      if (params.sizePct !== undefined) parts.push(fmtPctPlain(params.sizePct));
      if (params.sessionFilter !== undefined) parts.push(String(params.sessionFilter));
      return parts.length > 0 ? parts.join(' · ') : '—';
    }

    /** Structured parameter chips for the detail pane. */
    function strategyParamItems(params) {
      if (!params || typeof params !== 'object') return [];
      const items = [];
      const push = (key, label, format) => {
        if (params[key] === undefined || params[key] === null) return;
        const value = format ? format(params[key]) : String(params[key]);
        items.push({ key, label, value });
      };
      push('lookback', 'lookback');
      push('entryZ', 'entryZ');
      push('exitZ', 'exitZ');
      push('stopPct', 'stop', fmtPctPlain);
      push('targetPct', 'target', fmtPctPlain);
      push('maxHoldBars', 'maxHold');
      push('sizePct', 'size', fmtPctPlain);
      push('sessionFilter', 'session');
      return items;
    }

    // -----------------------------------------------------------------------
    // pure data mapping (exported for tests under `helpers`)
    // -----------------------------------------------------------------------

    const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

    /**
     * Human description of the engine's Reaper telemetry, read fresh from disk by
     * `engine.status()`: `{pid, alive, startedAt, heartbeatAt, heartbeatVersion, sweeps,
     * note, error?, hint?}`. Older engine builds reported only `{pid, alive, error, note}`.
     * A Reaper that is alive without a version-2 heartbeat belongs to a stale generation
     * and must be stopped by the operator before the engine will start.
     * @param {object|null} reaper engine.status().engine.reaper
     * @returns {{kind:'stopped'|'stale'|'healthy', pid:number|null, alive:boolean,
     *   heartbeatAt:string|null, heartbeatVersion:number|null, startedAt:string|null,
     *   sweeps:number|null, stale:boolean, error:string|null, hint:string|null, note:string|null}}
     */
    function describeReaper(reaper) {
      const info = plainObject(reaper);
      const rawPid = toNumber(info.pid);
      const pid = rawPid !== null && rawPid > 0 ? rawPid : null;
      const alive = info.alive === true;
      const heartbeatAt = typeof info.heartbeatAt === 'string' && info.heartbeatAt.length > 0 ? info.heartbeatAt : null;
      const heartbeatVersion = toNumber(info.heartbeatVersion);
      // A fresh Reaper writes heartbeat version 2 every sweep; an alive process without
      // that heartbeat belongs to a stale/legacy generation and must be operator-stopped.
      const freshHeartbeat = heartbeatAt !== null && heartbeatVersion !== null && heartbeatVersion >= 2;
      const stale = Boolean(alive && !freshHeartbeat);
      let kind = 'healthy';
      if (!alive || pid === null) kind = 'stopped';
      else if (stale) kind = 'stale';
      return {
        kind,
        pid,
        alive,
        heartbeatAt,
        heartbeatVersion,
        startedAt: typeof info.startedAt === 'string' ? info.startedAt : null,
        sweeps: toNumber(info.sweeps),
        stale,
        error: info.error ? String(info.error) : null,
        hint: info.hint ? String(info.hint) : null,
        note: info.note ? String(info.note) : null,
      };
    }

    /** Current holdings rows from an agent's `positions`. */
    function buildHoldingsRows(positions) {
      const list = Array.isArray(positions) ? positions : [];
      return list.filter((position) => position && typeof position === 'object').map((position, index) => {
        const qty = toNumber(position.qty);
        const avgPrice = toNumber(position.avgPriceUsd);
        const lastPrice = toNumber(position.lastPriceUsd);
        const marketValue = toNumber(position.marketValueUsd)
          ?? (qty !== null && lastPrice !== null ? round2(qty * lastPrice) : null);
        const unrealized = toNumber(position.unrealizedPlUsd)
          ?? (qty !== null && avgPrice !== null && lastPrice !== null ? round2((lastPrice - avgPrice) * qty) : null);
        return {
          key: `${position.symbol ?? 'position'}-${index}`,
          symbol: position.symbol ?? '—',
          qty,
          qtyText: fmtQty(qty),
          avgPriceUsd: avgPrice,
          lastPriceUsd: lastPrice,
          marketValueUsd: marketValue,
          unrealizedPlUsd: unrealized,
          openedAt: position.openedAt ?? null,
        };
      });
    }

    /** Past-activity rows from an agent's `recentTrades` (newest first, as provided). */
    function buildActivityRows(trades) {
      const list = Array.isArray(trades) ? trades : [];
      return list.filter((trade) => trade && typeof trade === 'object').map((trade, index) => {
        const sideRaw = String(trade.side ?? '').toLowerCase();
        const qty = toNumber(trade.qty);
        const price = toNumber(trade.priceUsd);
        return {
          key: `${trade.orderId ?? trade.id ?? 'trade'}-${index}`,
          symbol: trade.symbol ?? '—',
          side: sideRaw === 'sell' ? 'sell' : sideRaw === 'buy' ? 'buy' : '—',
          qty,
          qtyText: fmtQty(qty),
          priceUsd: price,
          notionalUsd: toNumber(trade.notionalUsd) ?? (qty !== null && price !== null ? round2(qty * price) : null),
          realizedPlUsd: toNumber(trade.realizedPlUsd),
          at: trade.at ?? null,
          orderId: trade.orderId ?? null,
        };
      });
    }

    /** Role-cost pairs (stable ascending by role name for a predictable rendering). */
    function roleCostRows(roleCosts) {
      const costs = plainObject(roleCosts);
      return Object.keys(costs)
        .sort()
        .map((role) => ({ role, amountUsd: toNumber(costs[role]) ?? 0 }));
    }

    /**
     * Turn one status payload into table/detail rows. Pure: no DOM, no fetch, no mutation
     * of `status`, safe with missing fields and with 0-100 agents.
     * @param {object} status the GET /automaton/state payload
     * @returns {Array<object>} one flat row per agent
     */
    function buildAgentRows(status) {
      const agents = Array.isArray(status?.agents) ? status.agents : [];
      /** Population-level endowment fallback: agent rows may omit their own endowment. */
      const populationEndowment = toNumber(status?.limits?.endowmentUsd) ?? toNumber(status?.config?.endowmentUsd);
      const nameById = new Map();
      for (const agent of agents) {
        if (agent && agent.id !== undefined) nameById.set(String(agent.id), agentDisplayName(agent));
      }
      return agents.map((agent, index) => {
        const safeAgent = plainObject(agent);
        const id = String(safeAgent.id ?? '');
        const genome = plainObject(safeAgent.genome);
        const spec = plainObject(safeAgent.spec);
        const rawStatus = String(safeAgent.status ?? (safeAgent.cause ? 'dead' : 'alive')).toLowerCase();
        const agentStatus = rawStatus === 'dead' || rawStatus === 'condemned' ? rawStatus : 'alive';
        const endowment = toNumber(safeAgent.endowmentUsd) ?? populationEndowment;
        const equity = toNumber(safeAgent.equityUsd);
        const pnlUsd = equity !== null && endowment !== null
          ? round2(equity - endowment)
          : toNumber(safeAgent.netPlUsd);
        const pnlPct = pnlUsd !== null && endowment !== null && endowment > 0 ? (pnlUsd / endowment) * 100 : null;
        const positions = buildHoldingsRows(safeAgent.positions);
        const activity = buildActivityRows(safeAgent.recentTrades);
        const roleCosts = roleCostRows(safeAgent.roleCosts);
        const roleCostsTotal = round2(roleCosts.reduce((total, entry) => total + entry.amountUsd, 0));
        const parentId = safeAgent.parentId ? String(safeAgent.parentId) : null;
        const mutation = plainObject(safeAgent.mutation);
        const hasMutation = Object.keys(mutation).length > 0;
        const genomeText = strategyLabel(genome);
        const specText = strategyLabel(spec);
        const bornAt = safeAgent.bornAt ?? null;
        const diedAt = safeAgent.diedAt ?? null;
        return {
          index: index + 1,
          id,
          shortId: shortId(id),
          name: agentDisplayName(safeAgent),
          generation: toNumber(safeAgent.generation),
          parentId,
          parentName: parentId ? (nameById.get(parentId) ?? shortId(parentId)) : null,
          status: agentStatus,
          cause: safeAgent.cause ?? null,
          note: safeAgent.note ?? null,
          bornAt,
          diedAt,
          lifespanHours: lifespanHours(bornAt, diedAt),
          firstProfitAt: safeAgent.firstProfitAt ?? null,
          genome,
          genomeText: genomeText.length > 0 ? genomeText : '—',
          genomeParamsText: strategyParamsText(genome),
          spec: Object.keys(spec).length > 0 ? spec : null,
          specId: safeAgent.specId ?? spec.specId ?? null,
          specText: specText.length > 0 ? specText : null,
          specParamsText: Object.keys(plainObject(spec.params)).length > 0 ? strategyParamsText(spec.params) : '—',
          specCreatedAt: spec.createdAt ?? null,
          tradingDiffers: Boolean(specText.length > 0 && genomeText.length > 0 && specText !== genomeText),
          mutation: hasMutation ? mutation : null,
          mutationText: hasMutation
            ? `${mutation.field ?? '?'}: ${String(mutation.from ?? '?')} → ${String(mutation.to ?? '?')}`
            : null,
          equityUsd: equity,
          cashUsd: toNumber(safeAgent.cashUsd),
          positionsValueUsd: toNumber(safeAgent.positionsValueUsd),
          endowmentUsd: endowment,
          pnlUsd,
          pnlPct,
          realizedPlUsd: toNumber(safeAgent.realizedPlUsd),
          unrealizedPlUsd: toNumber(safeAgent.unrealizedPlUsd),
          dayPnlPct: toNumber(safeAgent.dayPnlPct),
          net7dUsd: toNumber(safeAgent.net7dUsd),
          drawdownPct: toNumber(safeAgent.drawdownPct),
          runwayHours: toNumber(safeAgent.runwayHours),
          treasuryState: safeAgent.treasuryState ?? null,
          positions,
          positionCount: positions.length,
          activity,
          tradesCount: toNumber(safeAgent.tradesCount) ?? activity.length,
          roleCosts,
          roleCostsTotal,
        };
      });
    }

    /** Look up a built row by agent id (detail selection survives polling). */
    function findAgentRow(rows, id) {
      if (!id) return null;
      return rows.find((row) => row.id === id) ?? null;
    }

    /** Header/statistics projection of one status payload. */
    function summarize(status) {
      const account = status?.account ?? null;
      const treasury = status?.treasury ?? null;
      const population = status?.population ?? null;
      const engine = status?.engine ?? {};
      const limits = status?.limits ?? {};
      const agents = Array.isArray(status?.agents) ? status.agents : [];
      const count = (wanted) => agents.filter((agent) => {
        const raw = String(agent?.status ?? (agent?.cause ? 'dead' : 'alive')).toLowerCase();
        return raw === wanted;
      }).length;
      return {
        mode: modeOf(status),
        running: Boolean(engine.running),
        killSwitch: Boolean(engine.killSwitch ?? status?.brakes?.killSwitch),
        halted: Boolean(status?.halted),
        haltReasons: Array.isArray(status?.haltReasons) ? status.haltReasons : [],
        equityUsd: toNumber(account?.equityUsd),
        cashUsd: toNumber(account?.cashUsd),
        buyingPowerUsd: toNumber(account?.buyingPowerUsd),
        accountStatus: account?.status ?? null,
        population: {
          total: toNumber(population?.total) ?? agents.length,
          alive: toNumber(population?.alive) ?? count('alive'),
          dead: toNumber(population?.dead) ?? count('dead'),
          condemned: toNumber(population?.condemned) ?? count('condemned'),
          cap: toNumber(population?.cap) ?? toNumber(limits.populationCap),
        },
        treasury: {
          state: treasury?.state ?? null,
          runwayHours: toNumber(treasury?.runwayHours),
          burnPerHourUsd: toNumber(treasury?.burnPerHourUsd),
          allocatedUsd: toNumber(treasury?.allocatedUsd),
          poolUsd: toNumber(treasury?.poolUsd),
          surplus7dUsd: toNumber(treasury?.surplus7dUsd),
          mayReplicate: treasury?.mayReplicate === true,
          reconciliation: treasury?.reconciliation ?? null,
        },
        allocationCapUsd: toNumber(limits.allocationCapUsd),
        allocationCapPct: toNumber(limits.allocationCapPct),
        endowmentUsd: toNumber(limits.endowmentUsd),
        deathFloorUsd: toNumber(limits.deathFloorUsd),
        cycleIntervalSec: toNumber(limits.cycleIntervalSec) ?? toNumber(status?.config?.cycleIntervalSec),
        lastTickAt: engine.lastTickAt ?? null,
        lastError: engine.lastError ?? null,
        ticks: toNumber(engine.ticks),
        reaper: engine.reaper ?? null,
        brakesCount: toNumber(status?.brakes?.count) ?? 14,
        obituaryStats: status?.obituaries?.stats ?? null,
        at: status?.at ?? null,
        control: status?.control ?? null,
      };
    }

    /** Generation rollup sorted by generation number (from byGeneration or the rows). */
    function generationRows(status) {
      const byGeneration = status?.population?.byGeneration;
      if (byGeneration && typeof byGeneration === 'object' && !Array.isArray(byGeneration)) {
        return Object.entries(byGeneration)
          .map(([key, value]) => {
            const stats = value && typeof value === 'object' ? value : {};
            return {
              generation: toNumber(key) ?? 0,
              born: toNumber(stats.born) ?? 0,
              alive: toNumber(stats.alive) ?? 0,
              dead: toNumber(stats.dead) ?? 0,
              survivalRate: toNumber(stats.survivalRate),
              medianLifespanHours: toNumber(stats.medianLifespanHours),
            };
          })
          .sort((a, b) => a.generation - b.generation);
      }
      const groups = new Map();
      for (const agent of Array.isArray(status?.agents) ? status.agents : []) {
        const generation = toNumber(agent?.generation) ?? 0;
        if (!groups.has(generation)) groups.set(generation, { generation, born: 0, alive: 0, dead: 0 });
        const group = groups.get(generation);
        group.born += 1;
        const raw = String(agent?.status ?? 'alive').toLowerCase();
        if (raw === 'dead' || raw === 'condemned') group.dead += 1;
        else group.alive += 1;
      }
      return [...groups.values()].sort((a, b) => a.generation - b.generation);
    }

    /** Obituary feed rows (newest-first as the journal returns them), name-first. */
    function obituaryRows(status) {
      const recent = Array.isArray(status?.obituaries?.recent) ? status.obituaries.recent : [];
      return recent.slice(0, MAX_OBITUARIES).map((item, index) => ({
        key: `${item?.agentId ?? item?.id ?? 'obit'}-${index}`,
        agentId: item?.agentId ?? item?.id ?? null,
        name: (typeof item?.name === 'string' && item.name.trim().length > 0)
          ? item.name.trim()
          : strategyLabel(item?.genome) || shortId(item?.agentId ?? item?.id),
        shortId: shortId(item?.agentId ?? item?.id),
        generation: toNumber(item?.generation),
        cause: item?.cause ?? null,
        lifespanHours: toNumber(item?.lifespanHours) ?? lifespanHours(item?.bornAt, item?.diedAt),
        netPlUsd: toNumber(item?.netPlUsd),
        firstProfitAt: item?.firstProfitAt ?? null,
        diedAt: item?.diedAt ?? null,
      }));
    }

    /** Stable client-side sort on one whitelisted key. Nulls sort last. */
    function sortAgentRows(rows, sortKey = 'equityUsd', direction = 'desc') {
      const key = SORTABLE_KEYS.has(sortKey) ? sortKey : 'equityUsd';
      const sign = direction === 'asc' ? 1 : -1;
      const valueOf = (row) => {
        if (key === 'name') return String(row.name ?? '');
        if (key === 'status') return String(row.status ?? '');
        if (key === 'generation') return row.generation;
        return row[key];
      };
      return [...rows].sort((a, b) => {
        const left = valueOf(a);
        const right = valueOf(b);
        const leftEmpty = left === null || left === undefined || left === '';
        const rightEmpty = right === null || right === undefined || right === '';
        if (leftEmpty && rightEmpty) return a.index - b.index;
        if (leftEmpty) return 1;
        if (rightEmpty) return -1;
        if (typeof left === 'string' || typeof right === 'string') {
          return String(left).localeCompare(String(right)) * sign;
        }
        return (Number(left) - Number(right)) * sign;
      });
    }

    /** Status filter + text search over the built rows (names and ids both searchable). */
    function filterAgentRows(rows, filter = 'all', query = '') {
      const wanted = STATUS_FILTERS.includes(filter) ? filter : 'all';
      const text = String(query ?? '').trim().toLowerCase();
      return rows.filter((row) => {
        if (wanted !== 'all' && row.status !== wanted) return false;
        if (text.length === 0) return true;
        const haystack = [
          row.name,
          row.id,
          row.shortId,
          row.parentId,
          row.parentName,
          row.genomeText,
          row.specText,
          row.genome?.symbol,
          row.genome?.family,
          row.spec?.symbol,
          row.spec?.family,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(text);
      });
    }

    // -----------------------------------------------------------------------
    // shared data store: one 3 s poller for every mounted dashboard surface
    // -----------------------------------------------------------------------

    function createStateStore() {
      /** @type {{loading:boolean,data:object|null,error:object|null,fetchedAt:number,paused:boolean,refreshing:boolean}} */
      let snapshot = { loading: true, data: null, error: null, fetchedAt: 0, paused: false, refreshing: false };
      const listeners = new Set();
      let timer = null;
      let inFlight = false;
      let disposed = false;

      function publish(patch) {
        snapshot = { ...snapshot, ...patch };
        for (const listener of [...listeners]) {
          try {
            listener(snapshot);
          } catch {
            /* a crashing subscriber must not stop polling for the others */
          }
        }
      }

      function schedule() {
        clearTimeout(timer);
        timer = null;
        if (disposed || snapshot.paused || listeners.size === 0) return;
        timer = setTimeout(() => {
          timer = null;
          void load();
        }, POLL_MS);
      }

      async function load() {
        if (inFlight || disposed) return; // ignore while a request is in flight
        inFlight = true;
        publish({ refreshing: true });
        try {
          const response = await fetch(STATE_URL, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (!response.ok || !body || body.ok === false) {
            publish({
              loading: false,
              refreshing: false,
              error: body?.error ?? { code: `HTTP_${response.status}`, message: response.statusText || 'state route failed' },
            });
          } else {
            publish({ loading: false, refreshing: false, error: null, data: body, fetchedAt: Date.now() });
          }
        } catch (error) {
          publish({ loading: false, refreshing: false, error: { code: 'FETCH_FAILED', message: errorText(error) } });
        } finally {
          inFlight = false;
          schedule();
        }
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          if (listeners.size === 1) schedule();
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) {
              clearTimeout(timer);
              timer = null;
            }
          };
        },
        refreshNow() {
          if (!inFlight && !disposed) void load();
        },
        setPaused(paused) {
          publish({ paused: Boolean(paused) });
          if (!snapshot.paused) schedule();
          else {
            clearTimeout(timer);
            timer = null;
            publish({ refreshing: false });
          }
        },
        togglePaused() {
          this.setPaused(!snapshot.paused);
        },
      };
    }

    const store = createStateStore();

    /** Subscribe one component to the shared poll snapshot. */
    function useDashboardState() {
      const [snapshot, setSnapshot] = React.useState(store.getSnapshot());
      React.useEffect(() => store.subscribe(setSnapshot), []);
      return snapshot;
    }

    function useControlActions() {
      const [state, setState] = React.useState({ pending: null, action: null, error: null, message: null, hint: null, result: null });
      const run = React.useCallback(async (payload) => {
        if (!payload || typeof payload.action !== 'string') return;
        setState({ pending: payload.action, action: payload.action, error: null, message: null, hint: null, result: null });
        try {
          const response = await fetch(CONTROL_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(payload),
          });
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (!response.ok || !body || body.ok === false) {
            setState({
              pending: null,
              action: payload.action,
              error: body?.error ?? { code: `HTTP_${response.status}`, message: response.statusText || 'control request failed' },
              hint: typeof body?.hint === 'string' ? body.hint : null,
              message: null,
              result: null,
            });
          } else {
            setState({ pending: null, action: payload.action, error: null, hint: null, message: payload.action, result: body.result ?? null });
            store.refreshNow();
          }
        } catch (error) {
          setState({ pending: null, action: payload.action, error: { code: 'CONTROL_FAILED', message: errorText(error) }, hint: null, message: null, result: null });
        }
      }, []);
      return { controlState: state, runControl: run };
    }

    // -----------------------------------------------------------------------
    // styles (theme tokens with fallbacks; class names shared by all slots)
    // -----------------------------------------------------------------------

    const APP_CSS = `
.atm-root{display:flex;flex-direction:column;gap:12px;min-width:0;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:20px}
.atm-main{height:100%;box-sizing:border-box;overflow:auto;padding:16px 20px 28px}
.atm-settings{max-width:1180px}
.atm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.atm-head-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.atm-title{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary,inherit)}
.atm-sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit);max-width:660px}
.atm-head-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.atm-badge{display:inline-flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:999px;padding:1px 8px;font-size:11px;line-height:18px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-badge[data-mode="paper"]{color:var(--dsw-alias-state-business-primary,inherit)}
.atm-badge[data-mode="live"]{color:var(--dsw-alias-state-error-primary,inherit);border-color:currentColor}
.atm-badge[data-running="true"]{color:var(--dsw-alias-label-primary,inherit)}
.atm-kill{display:inline-flex;align-items:center;gap:4px;border:.5px solid currentColor;border-radius:999px;padding:1px 8px;font-size:11px;line-height:18px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;color:var(--dsw-alias-state-error-primary,inherit)}
.atm-kill[data-on="false"]{color:var(--dsw-alias-label-tertiary,inherit);border-color:var(--dsw-alias-border-l2,currentColor)}
.atm-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
.atm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px}
.atm-card{display:flex;flex-direction:column;gap:1px;min-width:0;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;padding:6px 9px;background:var(--dsw-alias-bg-l2,transparent)}
.atm-card-k{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atm-card-v{font-size:14px;font-weight:600;line-height:21px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atm-card-sub{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atm-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.atm-spacer{flex:1 1 auto}
.atm-btn{font:inherit;font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l2,currentColor);background:var(--dsw-alias-bg-l2,transparent);color:var(--dsw-alias-label-primary,inherit);border-radius:7px;padding:2px 10px;cursor:pointer;white-space:nowrap}
.atm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,transparent)}
.atm-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,currentColor));outline-offset:1px}
.atm-btn:disabled{opacity:.45;cursor:default}
.atm-btn[data-variant="primary"]{color:var(--dsw-alias-state-business-primary,inherit);border-color:currentColor}
.atm-btn[data-variant="danger"]{color:var(--dsw-alias-state-error-primary,inherit);border-color:currentColor}
.atm-btn[data-variant="active"]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-label-primary,currentColor)}
.atm-chip{font:inherit;font-size:11.5px;line-height:18px;border:.5px solid var(--dsw-alias-border-l2,currentColor);background:transparent;color:var(--dsw-alias-label-tertiary,inherit);border-radius:999px;padding:1px 9px;cursor:pointer}
.atm-chip[data-active="true"]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-label-primary,currentColor);background:var(--dsw-alias-bg-l2,transparent)}
.atm-input{font:inherit;font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,inherit);padding:2px 8px;min-width:180px}
.atm-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,currentColor));outline-offset:1px}
.atm-section{display:flex;flex-direction:column;gap:6px;min-width:0}
.atm-section-title{margin:0;font-size:12.5px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary,inherit);display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.atm-table-wrap{overflow:auto;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;max-height:420px}
.atm-table{width:100%;border-collapse:separate;border-spacing:0;font-size:11.5px;line-height:16px;white-space:nowrap}
.atm-table th{position:sticky;top:0;z-index:1;text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,inherit);background:var(--dsw-alias-bg-l2,var(--dsw-alias-bg-base,Canvas));border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding:3px 6px;white-space:nowrap}
.atm-table th.atm-sortable{cursor:pointer;user-select:none}
.atm-table th.atm-sortable:hover{color:var(--dsw-alias-label-primary,inherit)}
.atm-table th[data-sorted="true"]{color:var(--dsw-alias-label-primary,inherit)}
.atm-table td{border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding:3px 6px;max-width:230px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
.atm-table tbody tr:last-child td{border-bottom:0}
.atm-table tbody tr[data-clickable="true"]{cursor:pointer}
.atm-table tbody tr[data-clickable="true"]:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}
.atm-table tbody tr:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,currentColor));outline-offset:-1px}
.atm-table tbody tr[data-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-l2,transparent));box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary,currentColor)}
.atm-table tr[data-status="dead"]{opacity:.62}
.atm-table tr[data-status="condemned"] td:first-child{box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary,currentColor)}
.atm-name{display:flex;flex-direction:column;gap:0;min-width:0;line-height:15px}
.atm-name-main{font-weight:600;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atm-name-sub{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atm-mono{font-variant-numeric:tabular-nums}
.atm-pos{color:var(--dsw-alias-state-business-primary,inherit)}
.atm-neg{color:var(--dsw-alias-state-error-primary,inherit)}
.atm-muted{color:var(--dsw-alias-label-tertiary,inherit);margin:0;font-size:12px}
.atm-err{color:var(--dsw-alias-state-error-primary,inherit);margin:0;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.atm-note{color:var(--dsw-alias-label-tertiary,inherit);margin:0;font-size:11px;line-height:16px}
.atm-halt{border:.5px solid var(--dsw-alias-state-error-primary,currentColor);color:var(--dsw-alias-state-error-primary,inherit);border-radius:6px;padding:4px 10px;font-size:12px;margin:0}
.atm-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.atm-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.atm-list li{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:11.5px;line-height:17px;border-left:2px solid var(--dsw-alias-border-l2,currentColor);padding-left:8px}
.atm-list li[data-cause="death"]{border-left-color:var(--dsw-alias-state-error-primary,currentColor)}
.atm-runway-cell{display:inline-flex;align-items:center;gap:6px}
.atm-runway{display:inline-block;width:56px;height:5px;border-radius:3px;background:var(--dsw-alias-fill-l2,var(--dsw-alias-border-l2,transparent));overflow:hidden;vertical-align:middle}
.atm-runway > i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary,currentColor)}
.atm-runway[data-level="warn"] > i{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary,currentColor))}
.atm-runway[data-level="crit"] > i{background:var(--dsw-alias-state-error-primary,currentColor)}
.atm-status{display:inline-flex;align-items:center;gap:4px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,currentColor);padding:0 7px;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atm-status[data-status="alive"]{color:var(--dsw-alias-state-business-primary,inherit)}
.atm-status[data-status="dead"]{color:var(--dsw-alias-state-error-primary,inherit)}
.atm-status[data-status="condemned"]{color:var(--dsw-alias-state-error-primary,inherit);border-color:currentColor}
.atm-workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start}
.atm-workspace[data-detail="true"]{grid-template-columns:minmax(0,1fr) minmax(320px,380px)}
@media (max-width:1080px){.atm-workspace[data-detail="true"]{grid-template-columns:minmax(0,1fr)}}
.atm-main-col{display:flex;flex-direction:column;gap:12px;min-width:0}
.atm-detail{display:flex;flex-direction:column;gap:10px;min-width:0;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-l2,transparent);position:sticky;top:8px;max-height:calc(100vh - 220px);overflow:auto}
.atm-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap}
.atm-detail-name{margin:0;font-size:15px;font-weight:600;line-height:21px;color:var(--dsw-alias-label-primary,inherit);overflow-wrap:anywhere}
.atm-detail-id{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,inherit)}
.atm-detail-title{margin:6px 0 0;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary,inherit);display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.atm-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:4px 8px}
.atm-kv-item{display:flex;flex-direction:column;gap:0;min-width:0;line-height:15px}
.atm-kv-k{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atm-kv-v{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-primary,inherit);overflow-wrap:anywhere}
.atm-detail-table{width:100%;border-collapse:separate;border-spacing:0;font-size:11px;line-height:15px;white-space:nowrap;font-variant-numeric:tabular-nums}
.atm-detail-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,inherit);border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding:2px 4px}
.atm-detail-table td{border-bottom:.5px solid var(--dsw-alias-border-l2,currentColor);padding:2px 4px}
.atm-detail-table tr:last-child td{border-bottom:0}
.atm-activity{display:flex;flex-direction:column;gap:3px;margin:0;padding:0;list-style:none}
.atm-activity li{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:11px;line-height:16px;border-left:2px solid var(--dsw-alias-border-l2,currentColor);padding-left:6px}
.atm-activity li[data-side="buy"]{border-left-color:var(--dsw-alias-state-business-primary,currentColor)}
.atm-activity li[data-side="sell"]{border-left-color:var(--dsw-alias-state-error-primary,currentColor)}
.atm-side{font-weight:600;text-transform:uppercase;font-size:10px}
.atm-side[data-side="buy"]{color:var(--dsw-alias-state-business-primary,inherit)}
.atm-side[data-side="sell"]{color:var(--dsw-alias-state-error-primary,inherit)}
.atm-chips{display:flex;flex-wrap:wrap;gap:4px}
.atm-param{display:inline-flex;align-items:baseline;gap:4px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:5px;padding:0 5px;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-param b{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.atm-empty{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,inherit)}
.atm-warn{color:var(--dsw-alias-state-error-primary,inherit);font-size:11px;line-height:16px;margin:0}
.atm-pill{display:inline-flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:999px;padding:0 7px;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.atm-pill[data-emphasis="true"]{color:var(--dsw-alias-state-business-primary,inherit);border-color:currentColor}
.atm-reaper{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;padding:5px 10px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,inherit);background:transparent}
.atm-reaper[data-kind="stale"]{border-color:var(--dsw-alias-state-error-primary,currentColor);color:var(--dsw-alias-label-primary,inherit)}
.atm-reaper[data-kind="healthy"]{border-color:var(--dsw-alias-state-business-primary,currentColor)}
.atm-reaper-label{font-weight:600;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap}
.atm-reaper-detail{white-space:nowrap}
.atm-reaper-stale{color:var(--dsw-alias-state-error-primary,inherit);font-weight:600}
.atm-close{font:inherit;font-size:13px;line-height:18px;border:.5px solid var(--dsw-alias-border-l2,currentColor);background:transparent;color:var(--dsw-alias-label-tertiary,inherit);border-radius:6px;padding:0 7px;cursor:pointer}
.atm-close:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,transparent)}
.atm-icon{display:block}
`;

    // -----------------------------------------------------------------------
    // small presentational components
    // -----------------------------------------------------------------------

    function ModeBadge({ t, mode }) {
      const label = MODE_LABEL[mode] ?? String(mode ?? '—').toUpperCase();
      return h('span', { className: 'atm-badge', 'data-mode': mode, title: `${t('mode')}: ${mode}` }, label);
    }

    function KillBadge({ t, on }) {
      return h('span', {
        className: 'atm-kill',
        'data-on': on ? 'true' : 'false',
        title: on ? t('killOn') : t('killOff'),
      }, h('span', { className: 'atm-dot', 'aria-hidden': true }), on ? t('killOn') : t('killOff'));
    }

    function StatCard({ label, value, sub }) {
      return h('div', { className: 'atm-card' }, [
        h('span', { className: 'atm-card-k', key: 'k' }, label),
        h('span', { className: 'atm-card-v', key: 'v', title: String(value) }, value),
        sub ? h('span', { className: 'atm-card-sub', key: 's', title: String(sub) }, sub) : null,
      ]);
    }

    function HeaderStats({ t, summary }) {
      const population = summary.population;
      const treasury = summary.treasury;
      const allocatedText = treasury.allocatedUsd === null && summary.allocationCapUsd === null
        ? '—'
        : `${fmtUsd(treasury.allocatedUsd)}${summary.allocationCapUsd === null ? '' : ` / ${fmtUsd(summary.allocationCapUsd)}`}`;
      return h('div', { className: 'atm-grid' }, [
        h(StatCard, { key: 'mode', label: t('mode'), value: MODE_LABEL[summary.mode] ?? String(summary.mode).toUpperCase(), sub: summary.accountStatus ?? null }),
        h(StatCard, { key: 'loop', label: t('loop'), value: summary.running ? t('running') : t('stopped'), sub: summary.cycleIntervalSec ? `${summary.cycleIntervalSec}s` : null }),
        h(StatCard, { key: 'equity', label: t('account'), value: fmtUsd(summary.equityUsd), sub: `${t('cash')} ${fmtUsd(summary.cashUsd)}` }),
        h(StatCard, {
          key: 'pop',
          label: t('population'),
          value: `${fmtNum(population.alive)} / ${fmtNum(population.total)}`,
          sub: `${t('dead')} ${fmtNum(population.dead)} · ${t('condemned')} ${fmtNum(population.condemned)} · ${t('cap')} ${fmtNum(population.cap)}`,
        }),
        h(StatCard, {
          key: 'treasury',
          label: t('treasury'),
          value: `${treasury.state ?? '—'} · ${fmtHours(treasury.runwayHours)}`,
          sub: `${t('burn')} ${fmtUsd(treasury.burnPerHourUsd)}/h`,
        }),
        h(StatCard, {
          key: 'allocated',
          label: t('allocated'),
          value: allocatedText,
          sub: summary.allocationCapPct === null ? null : `${Math.round((summary.allocationCapPct ?? 0) * 100)}%`,
        }),
        h(StatCard, { key: 'tick', label: t('lastTick'), value: fmtAgo(summary.lastTickAt), sub: summary.ticks === null ? null : `${summary.ticks} ticks` }),
        h(StatCard, {
          key: 'kill',
          label: t('killSwitch'),
          value: summary.killSwitch ? t('armed') : t('clear'),
          sub: summary.halted ? t('halted') : null,
        }),
        h(StatCard, {
          key: 'obits',
          label: t('obituaries'),
          value: fmtNum(summary.obituaryStats?.total ?? 0),
          sub: summary.obituaryStats?.mostCommonCause ?? null,
        }),
      ]);
    }

    function PauseToggle({ t }) {
      const snapshot = useDashboardState();
      return h('button', {
        type: 'button',
        className: 'atm-btn',
        'data-variant': snapshot.paused ? 'active' : undefined,
        title: t('autoRefresh'),
        onClick: () => store.togglePaused(),
      }, snapshot.paused ? t('resume') : t('pause'));
    }

    function ControlBar({ t, summary, controlState, runControl }) {
      const [armed, setArmed] = React.useState(false);
      const pending = controlState.pending;
      const disabled = pending !== null;
      return h('div', { className: 'atm-section' }, [
        h('div', { className: 'atm-toolbar', key: 'buttons' }, [
          h('button', {
            key: 'start',
            type: 'button',
            className: 'atm-btn',
            'data-variant': 'primary',
            disabled: disabled || summary.running || summary.killSwitch,
            title: summary.killSwitch ? t('killOn') : t('start'),
            onClick: () => runControl({ action: 'start' }),
          }, `${t('start')}${pending === 'start' ? '…' : ''}`),
          h('button', {
            key: 'stop',
            type: 'button',
            className: 'atm-btn',
            disabled: disabled || !summary.running,
            onClick: () => runControl({ action: 'stop' }),
          }, `${t('stop')}${pending === 'stop' ? '…' : ''}`),
          armed
            ? h('button', {
              key: 'confirm',
              type: 'button',
              className: 'atm-btn',
              'data-variant': 'danger',
              disabled,
              onClick: () => {
                setArmed(false);
                runControl({ action: 'emergency-stop', confirm: 'STOP' });
              },
            }, `${t('confirmStop')}${pending === 'emergency-stop' ? '…' : ''}`)
            : h('button', {
              key: 'emergency',
              type: 'button',
              className: 'atm-btn',
              'data-variant': 'danger',
              disabled: disabled || summary.killSwitch,
              onClick: () => setArmed(true),
            }, t('emergency')),
          armed
            ? h('button', {
              key: 'cancel',
              type: 'button',
              className: 'atm-btn',
              onClick: () => setArmed(false),
            }, t('cancel'))
            : null,
          h('span', { className: 'atm-spacer', key: 'spacer' }),
          h(PauseToggle, { key: 'pause', t }),
          h('span', { className: 'atm-muted', key: 'auto', title: t('autoRefresh') }, summary.paused ? t('pausedLabel') : t('autoRefresh')),
        ]),
        controlState.error
          ? h('p', { className: 'atm-err', key: 'err' }, `${t('controlFailed')}: ${errorText(controlState.error)}`)
          : null,
        controlState.message
          ? h('p', { className: 'atm-muted', key: 'msg' }, t('controlOk').replace('{action}', controlState.message))
          : null,
      ]);
    }

    /**
     * Operator-only Reaper row: shows the external death process read fresh from disk by
     * the engine (`engine.reaper`) and lets the operator stop a stale-generation orphan.
     * Agents/tools cannot stop the Reaper — this is a deliberate operator surface.
     */
    function ReaperRow({ t, summary, controlState, runControl }) {
      const [armed, setArmed] = React.useState(false);
      const reaper = describeReaper(summary.reaper);
      const pending = controlState.pending === 'reaper-stop';
      const disabled = controlState.pending !== null;
      const stale = reaper.kind === 'stale';
      const stopped = reaper.kind === 'stopped';
      // Safety: only a STALE-generation Reaper may be stopped from the panel. A fresh
      // (heartbeat v2) Reaper is the mortality enforcer for the running population.
      const canStopReaper = stale;
      const isReaperAction = controlState.action === 'reaper-stop';
      const lastResult = isReaperAction && controlState.message === 'reaper-stop' ? controlState.result : null;
      const reaperError = isReaperAction ? controlState.error : null;

      const detailParts = [];
      if (stopped) {
        detailParts.push(t('reaperNotRunning'));
      } else {
        detailParts.push(`pid ${reaper.pid} · ${t('reaperAlive')}`);
        if (reaper.heartbeatAt) {
          detailParts.push(`${t('reaperHealthy')} ${fmtAgo(reaper.heartbeatAt)}${reaper.heartbeatVersion !== null ? ` (v${reaper.heartbeatVersion})` : ''}`);
        } else {
          detailParts.push(t('reaperStale'));
        }
        if (reaper.sweeps !== null) detailParts.push(`${reaper.sweeps} ${t('reaperSweeps')}`);
      }
      if (reaper.error) detailParts.push(reaper.error);

      return h('div', { className: 'atm-reaper', 'data-kind': reaper.kind }, [
        h('span', { className: 'atm-reaper-label', key: 'label' }, `${t('reaper')} —`),
        h('span', { className: 'atm-reaper-detail', key: 'detail', title: reaper.hint ?? reaper.note ?? '' }, detailParts.join(' · ')),
        stale ? h('span', { className: 'atm-reaper-stale', key: 'stale' }, `⚠ ${t('reaperStale')}`) : null,
        h('span', { className: 'atm-spacer', key: 'spacer' }),
        stopped
          ? null
          : canStopReaper
            ? (armed
              ? h('span', { className: 'atm-toolbar', key: 'armed' }, [
                h('button', {
                  key: 'confirm',
                  type: 'button',
                  className: 'atm-btn',
                  'data-variant': 'danger',
                  disabled,
                  onClick: () => {
                    setArmed(false);
                    runControl({ action: 'reaper-stop', confirm: 'STOP' });
                  },
                }, `${t('reaperConfirm')}${pending ? '…' : ''}`),
                h('button', {
                  key: 'cancel',
                  type: 'button',
                  className: 'atm-btn',
                  disabled,
                  onClick: () => setArmed(false),
                }, t('cancel')),
              ])
              : h('button', {
                key: 'stop-reaper',
                type: 'button',
                className: 'atm-btn',
                'data-variant': 'danger',
                disabled,
                title: t('reaperHint'),
                onClick: () => setArmed(true),
              }, t('reaperStop')))
            : h('span', { className: 'atm-note', key: 'healthy' }, t('reaperHealthyNote')),
        h('span', { className: 'atm-note', key: 'note' }, t('reaperHint')),
        stale ? h('p', { className: 'atm-warn', key: 'stale-warning' }, t('reaperStaleWarning')) : null,
        lastResult
          ? h('p', { className: lastResult.stopped ? 'atm-muted' : 'atm-warn', key: 'result' },
            lastResult.stopped
              ? `${t('reaperStopped')} (pid ${lastResult.pid ?? '—'})`
              : `${t('reaperStopFailed')}: ${lastResult.reason ?? t('none')}`)
          : null,
        controlState.error
          ? h('p', { className: 'atm-err', key: 'error' }, `${t('reaperStopFailed')}: ${errorText(reaperError ?? controlState.error)}${controlState.hint ? ` — ${controlState.hint}` : ''}`)
          : null,
      ]);
    }

    function RunwayCell({ row }) {
      return h('span', { className: 'atm-runway-cell' }, [
        h('span', { className: 'atm-runway', 'data-level': runwayLevel(row.runwayHours), key: 'bar' },
          h('i', { style: { width: `${runwayPercent(row.runwayHours)}%` } })),
        h('span', { className: 'atm-mono', key: 'text' }, fmtHours(row.runwayHours)),
      ]);
    }

    function StatusCell({ t, row }) {
      const label = row.status === 'condemned' ? t('condemned') : row.status === 'dead' ? t('dead') : t('alive');
      return h('span', { className: 'atm-status', 'data-status': row.status, title: row.cause ?? row.status },
        h('span', { className: 'atm-dot', 'aria-hidden': true }),
        label,
        row.cause ? h('span', { key: 'cause' }, ` · ${row.cause}`) : null);
    }

    /** Runway bar fill percent: 72 h = healthy full bar; unknown/dead = 0. */
    const RUNWAY_FULL_HOURS = 72;
    function runwayPercent(hours) {
      const number = toNumber(hours);
      if (number === null) return 0;
      return Math.max(0, Math.min(100, (number / RUNWAY_FULL_HOURS) * 100));
    }

    /** 'ok' | 'warn' | 'crit' — a colour level derived from runway only. */
    function runwayLevel(hours) {
      const number = toNumber(hours);
      if (number === null) return 'crit';
      if (number < 6) return 'crit';
      if (number < 24) return 'warn';
      return 'ok';
    }

    // -----------------------------------------------------------------------
    // agent table
    // -----------------------------------------------------------------------

    const TABLE_COLUMNS = [
      { key: 'index', label: '#', sortable: false, width: '30px' },
      { key: 'name', labelKey: 'agent', sortable: true },
      { key: 'generation', labelKey: 'gen', sortable: true },
      { key: 'genome', labelKey: 'genome', sortable: false },
      { key: 'trading', labelKey: 'trading', sortable: false },
      { key: 'equityUsd', labelKey: 'equity', sortable: true },
      { key: 'pnlUsd', labelKey: 'pnl', sortable: true },
      { key: 'dayPnlPct', labelKey: 'dayPnl', sortable: true },
      { key: 'runwayHours', labelKey: 'runway', sortable: true },
      { key: 'status', labelKey: 'statusLabel', sortable: true },
      { key: 'positions', labelKey: 'positions', sortable: false },
    ];

    function AgentTable({ t, rows, selectedId, onSelect }) {
      const [sortKey, setSortKey] = React.useState('pnlUsd');
      const [direction, setDirection] = React.useState('desc');
      const [filter, setFilter] = React.useState('all');
      const [query, setQuery] = React.useState('');

      const visible = React.useMemo(
        () => sortAgentRows(filterAgentRows(rows, filter, query), sortKey, direction),
        [rows, filter, query, sortKey, direction],
      );

      const onSort = (key) => {
        if (!SORTABLE_KEYS.has(key)) return;
        if (sortKey === key) setDirection(direction === 'asc' ? 'desc' : 'asc');
        else {
          setSortKey(key);
          setDirection(key === 'name' || key === 'generation' || key === 'status' ? 'asc' : 'desc');
        }
      };

      const showCondemned = rows.some((row) => row.status === 'condemned');
      const filters = STATUS_FILTERS.filter((value) => value !== 'condemned' || showCondemned);

      return h('div', { className: 'atm-section' }, [
        h('div', { className: 'atm-toolbar', key: 'toolbar' }, [
          h('h3', { className: 'atm-section-title', key: 'title' }, `${t('agents')} · ${fmtNum(visible.length)} ${t('rows')}`),
          h('span', { className: 'atm-muted', key: 'hint' }, t('clickHint')),
          h('span', { className: 'atm-spacer', key: 'spacer' }),
          filters.map((value) => h('button', {
            key: value,
            type: 'button',
            className: 'atm-chip',
            'data-active': filter === value ? 'true' : 'false',
            onClick: () => setFilter(value),
          }, value === 'all' ? t('filterAll') : value === 'alive' ? t('filterAlive') : value === 'dead' ? t('filterDead') : t('filterCondemned'))),
          h('input', {
            key: 'search',
            className: 'atm-input',
            type: 'search',
            placeholder: t('search'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
            'aria-label': t('search'),
          }),
        ]),
        rows.length === 0
          ? h('p', { className: 'atm-muted', key: 'empty' }, t('noAgents'))
          : h('div', { className: 'atm-table-wrap', key: 'wrap' },
            h('table', { className: 'atm-table' }, [
              h('thead', { key: 'head' }, h('tr', null, TABLE_COLUMNS.map((column) => h('th', {
                key: column.key,
                className: column.sortable ? 'atm-sortable' : undefined,
                'data-sorted': column.sortable && sortKey === column.key ? 'true' : undefined,
                style: column.width ? { width: column.width } : undefined,
                title: column.sortable ? 'sort' : undefined,
                onClick: column.sortable ? () => onSort(column.key) : undefined,
              }, `${column.labelKey ? t(column.labelKey) : column.label}${column.sortable && sortKey === column.key ? (direction === 'asc' ? ' ↑' : ' ↓') : ''}`)))),
              h('tbody', { key: 'body' }, visible.map((row) => h('tr', {
                key: row.id,
                'data-status': row.status,
                'data-clickable': 'true',
                'data-selected': row.id === selectedId ? 'true' : undefined,
                tabIndex: 0,
                'aria-selected': row.id === selectedId,
                onClick: () => onSelect(row.id),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                    event.preventDefault();
                    onSelect(row.id);
                  }
                },
              }, [
                h('td', { key: 'i', className: 'atm-muted atm-mono' }, row.index),
                h('td', { key: 'name' }, h('span', { className: 'atm-name' }, [
                  h('span', { className: 'atm-name-main', key: 'n', title: row.name }, row.name),
                  h('span', { className: 'atm-name-sub atm-mono', key: 'id', title: row.id }, row.shortId),
                ])),
                h('td', { key: 'gen', className: 'atm-mono' }, fmtNum(row.generation)),
                h('td', { key: 'genome', title: row.genomeParamsText }, row.genomeText),
                h('td', { key: 'trading', title: row.specParamsText }, [
                  h('span', { key: 'spec' }, row.specText ?? t('none')),
                  row.tradingDiffers ? h('span', { key: 'diff', className: 'atm-warn', title: t('specDiffers') }, ' ≠') : null,
                ]),
                h('td', { key: 'equity', className: 'atm-mono' }, fmtUsd(row.equityUsd)),
                h('td', {
                  key: 'pnl',
                  className: `atm-mono ${row.pnlUsd === null ? '' : row.pnlUsd > 0 ? 'atm-pos' : row.pnlUsd < 0 ? 'atm-neg' : ''}`,
                }, `${fmtSignedUsd(row.pnlUsd)}${row.pnlPct === null ? '' : ` (${fmtPercentPoints(row.pnlPct)})`}`),
                h('td', {
                  key: 'day',
                  className: `atm-mono ${(row.dayPnlPct ?? 0) > 0 ? 'atm-pos' : (row.dayPnlPct ?? 0) < 0 ? 'atm-neg' : ''}`,
                }, fmtPct(row.dayPnlPct)),
                h('td', { key: 'runway' }, h(RunwayCell, { row })),
                h('td', { key: 'status' }, h(StatusCell, { t, row })),
                h('td', {
                  key: 'positions',
                  className: 'atm-mono',
                  title: `${t('positionsCount')} ${row.positionCount} · ${t('tradesCount')} ${row.tradesCount}`,
                }, `${row.positionCount} / ${row.tradesCount}`),
              ]))),
            ])),
      ]);
    }

    // -----------------------------------------------------------------------
    // agent detail (holdings + activity + strategy + costs + death)
    // -----------------------------------------------------------------------

    function DetailKv({ items }) {
      return h('div', { className: 'atm-kv' }, items
        .filter((item) => item && item.value !== undefined && item.value !== null)
        .map((item) => h('div', { className: 'atm-kv-item', key: item.key }, [
          h('span', { className: 'atm-kv-k', key: 'k' }, item.label),
          h('span', { className: 'atm-kv-v', key: 'v', title: typeof item.value === 'string' ? item.value : undefined }, item.value),
        ])));
    }

    function HoldingsTable({ t, row }) {
      if (row.positionCount === 0) return h('p', { className: 'atm-empty' }, t('noPositions'));
      return h('table', { className: 'atm-detail-table' }, [
        h('thead', { key: 'head' }, h('tr', null, [
          h('th', { key: 'symbol' }, t('symbol')),
          h('th', { key: 'qty' }, t('qty')),
          h('th', { key: 'avg' }, t('avgPrice')),
          h('th', { key: 'last' }, t('lastPrice')),
          h('th', { key: 'mv' }, t('marketValue')),
          h('th', { key: 'unrl' }, t('unrealized')),
          h('th', { key: 'opened' }, t('openedAt')),
        ])),
        h('tbody', { key: 'body' }, row.positions.map((position) => h('tr', { key: position.key }, [
          h('td', { key: 'symbol', className: 'atm-mono' }, position.symbol),
          h('td', { key: 'qty', className: 'atm-mono' }, position.qtyText),
          h('td', { key: 'avg', className: 'atm-mono' }, fmtUsd(position.avgPriceUsd)),
          h('td', { key: 'last', className: 'atm-mono' }, fmtUsd(position.lastPriceUsd)),
          h('td', { key: 'mv', className: 'atm-mono' }, fmtUsd(position.marketValueUsd)),
          h('td', {
            key: 'unrl',
            className: `atm-mono ${(position.unrealizedPlUsd ?? 0) > 0 ? 'atm-pos' : (position.unrealizedPlUsd ?? 0) < 0 ? 'atm-neg' : ''}`,
          }, fmtSignedUsd(position.unrealizedPlUsd)),
          h('td', { key: 'opened', className: 'atm-muted', title: fmtDateTime(position.openedAt) }, fmtAgo(position.openedAt)),
        ]))),
      ]);
    }

    function ActivityFeed({ t, row }) {
      if (row.activity.length === 0) return h('p', { className: 'atm-empty' }, t('noTrades'));
      return h('ul', { className: 'atm-activity' }, row.activity.map((trade) => h('li', {
        key: trade.key,
        'data-side': trade.side,
        title: fmtDateTime(trade.at),
      }, [
        h('span', { key: 'time', className: 'atm-muted' }, fmtAgo(trade.at)),
        h('span', { key: 'side', className: 'atm-side', 'data-side': trade.side }, trade.side === 'sell' ? t('sell') : trade.side === 'buy' ? t('buy') : '—'),
        h('span', { key: 'symbol', className: 'atm-mono' }, trade.symbol),
        h('span', { key: 'qty', className: 'atm-mono' }, trade.qtyText),
        h('span', { key: 'price', className: 'atm-mono' }, `@ ${fmtUsd(trade.priceUsd)}`),
        h('span', { key: 'notional', className: 'atm-muted atm-mono' }, fmtUsd(trade.notionalUsd)),
        trade.realizedPlUsd === null
          ? null
          : h('span', {
            key: 'realized',
            className: `atm-mono ${trade.realizedPlUsd > 0 ? 'atm-pos' : trade.realizedPlUsd < 0 ? 'atm-neg' : ''}`,
          }, `${t('realized')} ${fmtSignedUsd(trade.realizedPlUsd)}`),
      ])));
    }

    function ParamChips({ t, params, emptyLabel }) {
      const items = strategyParamItems(params);
      if (items.length === 0) return h('p', { className: 'atm-empty' }, emptyLabel ?? t('none'));
      return h('div', { className: 'atm-chips' }, items.map((item) => h('span', { className: 'atm-param', key: item.key }, [
        h('b', { key: 'l' }, item.label),
        h('span', { key: 'v' }, item.value),
      ])));
    }

    function AgentDetail({ t, row, onClose }) {
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [onClose]);

      const deathInfo = [];
      if (row.status === 'dead' || row.status === 'condemned') {
        if (row.cause) deathInfo.push({ key: 'cause', label: t('cause'), value: row.cause });
        if (row.diedAt) deathInfo.push({ key: 'died', label: t('died'), value: fmtDateTime(row.diedAt) });
        if (row.lifespanHours !== null) deathInfo.push({ key: 'life', label: t('lifespan'), value: fmtHours(row.lifespanHours) });
      }
      if (row.note) deathInfo.push({ key: 'note', label: 'note', value: row.note });

      const metaItems = [
        { key: 'gen', label: t('gen'), value: fmtNum(row.generation) },
        { key: 'born', label: t('born'), value: fmtAgo(row.bornAt), title: fmtDateTime(row.bornAt) },
        { key: 'parent', label: t('parent'), value: row.parentName ?? t('noParent') },
        { key: 'mutation', label: t('mutation'), value: row.mutationText ?? t('none') },
        { key: 'endowment', label: t('endowment'), value: fmtUsd(row.endowmentUsd) },
        { key: 'cash', label: t('cash'), value: fmtUsd(row.cashUsd) },
        { key: 'posval', label: t('positionsValue'), value: fmtUsd(row.positionsValueUsd) },
        { key: 'equity', label: t('equity'), value: fmtUsd(row.equityUsd) },
        { key: 'day', label: t('dayPnlTitle'), value: fmtPct(row.dayPnlPct) },
        { key: 'net7d', label: t('net7dTitle'), value: fmtSignedUsd(row.net7dUsd) },
        { key: 'realized', label: t('realized'), value: fmtSignedUsd(row.realizedPlUsd) },
        { key: 'unrealized', label: t('unrealized'), value: fmtSignedUsd(row.unrealizedPlUsd) },
        { key: 'runway', label: t('runway'), value: fmtHours(row.runwayHours) },
        { key: 'drawdown', label: t('drawdown'), value: fmtPct(row.drawdownPct) },
        { key: 'firstProfit', label: t('firstProfit'), value: row.firstProfitAt ? fmtAgo(row.firstProfitAt) : t('neverProfited') },
      ];

      return h('aside', { className: 'atm-detail', 'aria-label': `${t('detailTitle')}: ${row.name}` }, [
        h('div', { className: 'atm-detail-head', key: 'head' }, [
          h('div', { key: 'titles' }, [
            h('h3', { className: 'atm-detail-name', key: 'name' }, row.name),
            h('span', { className: 'atm-detail-id atm-mono', key: 'id', title: row.id }, row.id),
            h('div', { className: 'atm-toolbar', key: 'badges', style: { marginTop: 2 } }, [
              h(StatusCell, { key: 'status', t, row }),
              h('span', { className: 'atm-muted', key: 'gen' }, `gen ${fmtNum(row.generation)}`),
            ]),
          ]),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'atm-close',
            'aria-label': t('close'),
            title: `${t('close')} (Esc)`,
            onClick: onClose,
          }, '×'),
        ]),
        h(DetailKv, { key: 'meta', items: metaItems }),
        deathInfo.length > 0 ? h('div', { key: 'death' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, t('tradingState')),
          h(DetailKv, { key: 'kv', items: deathInfo }),
        ]) : null,
        h('div', { key: 'holdings' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, `${t('holdings')} · ${fmtNum(row.positionCount)}`),
          h(HoldingsTable, { key: 'table', t, row }),
        ]),
        h('div', { key: 'activity' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, `${t('activity')} · ${fmtNum(row.tradesCount)}`),
          h(ActivityFeed, { key: 'feed', t, row }),
        ]),
        h('div', { key: 'strategy' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, t('strategyParams')),
          h('p', { className: 'atm-note', key: 'genome-label' }, `${t('genomeParams')} · ${row.genomeText}`),
          h(ParamChips, { key: 'genome-params', t, params: row.genome }),
          h('p', { className: 'atm-note', key: 'spec-label' }, [
            `${t('specParams')} · ${row.specText ?? t('none')}`,
            row.specCreatedAt ? ` · ${t('specCreated')} ${fmtAgo(row.specCreatedAt)}` : '',
          ].join('')),
          row.spec
            ? h(ParamChips, { key: 'spec-params', t, params: row.spec.params })
            : h('p', { className: 'atm-empty', key: 'no-spec' }, t('noSpec')),
          row.tradingDiffers
            ? h('p', { className: 'atm-warn', key: 'diff' }, `⚠ ${t('specDiffers')}`)
            : null,
        ]),
        h('div', { key: 'costs' }, [
          h('h4', { className: 'atm-detail-title', key: 'title' }, `${t('costs')} · ${fmtUsd(row.roleCostsTotal)}`),
          row.roleCosts.length === 0
            ? h('p', { className: 'atm-empty', key: 'empty' }, t('none'))
            : h('table', { className: 'atm-detail-table', key: 'table' }, [
              h('thead', { key: 'head' }, h('tr', null, [
                h('th', { key: 'role' }, t('role')),
                h('th', { key: 'amount' }, t('amount')),
              ])),
              h('tbody', { key: 'body' }, row.roleCosts.map((cost) => h('tr', { key: cost.role }, [
                h('td', { key: 'role', className: 'atm-mono' }, cost.role),
                h('td', { key: 'amount', className: 'atm-mono' }, fmtUsd(cost.amountUsd)),
              ]))),
            ]),
        ]),
      ]);
    }

    // -----------------------------------------------------------------------
    // feed sections
    // -----------------------------------------------------------------------

    function Generations({ t, summaryData }) {
      const rows = React.useMemo(() => generationRows(summaryData), [summaryData]);
      const population = summaryData?.population ?? null;
      return h('div', { className: 'atm-section' }, [
        h('h3', { className: 'atm-section-title', key: 'title' }, t('generations')),
        population
          ? h('p', { className: 'atm-note', key: 'pop' },
            `${t('alive')} ${fmtNum(population.alive)} · ${t('dead')} ${fmtNum(population.dead)} · ${t('condemned')} ${fmtNum(population.condemned)} · ${t('total')} ${fmtNum(population.total)} · ${t('cap')} ${fmtNum(population.cap)}`)
          : null,
        rows.length === 0
          ? h('p', { className: 'atm-muted', key: 'empty' }, t('noGenerations'))
          : h('ul', { className: 'atm-list', key: 'list' }, rows.map((row) => h('li', { key: row.generation }, [
            h('span', { className: 'atm-mono', key: 'gen' }, `gen ${row.generation}`),
            h('span', { key: 'alive', className: 'atm-pos' }, `${row.alive} ${t('alive')}`),
            h('span', { key: 'dead', className: 'atm-neg' }, `${row.dead} ${t('dead')}`),
            row.survivalRate === null
              ? null
              : h('span', { key: 'rate', className: 'atm-muted' }, `${Math.round(row.survivalRate * 100)}%`),
          ]))),
      ]);
    }

    function Obituaries({ t, summaryData }) {
      const rows = React.useMemo(() => obituaryRows(summaryData), [summaryData]);
      return h('div', { className: 'atm-section' }, [
        h('h3', { className: 'atm-section-title', key: 'title' }, t('obituaries')),
        rows.length === 0
          ? h('p', { className: 'atm-muted', key: 'empty' }, t('noObits'))
          : h('ul', { className: 'atm-list', key: 'list' }, rows.map((row) => h('li', {
            key: row.key,
            'data-cause': 'death',
            title: row.diedAt ? fmtDateTime(row.diedAt) : '',
          }, [
            h('span', { key: 'name', className: 'atm-name-main', title: row.name }, row.name),
            h('span', { key: 'id', className: 'atm-muted atm-mono' }, row.shortId),
            row.generation === null ? null : h('span', { key: 'gen', className: 'atm-muted' }, `gen ${row.generation}`),
            h('span', { key: 'cause', className: 'atm-neg' }, row.cause ?? '—'),
            h('span', { key: 'life', className: 'atm-muted' }, `${t('lifespan')} ${fmtHours(row.lifespanHours)}`),
            h('span', {
              key: 'pl',
              className: `atm-mono ${row.netPlUsd === null ? '' : row.netPlUsd < 0 ? 'atm-neg' : 'atm-pos'}`,
            }, fmtSignedUsd(row.netPlUsd)),
            h('span', { key: 'fp', className: 'atm-muted' }, row.firstProfitAt ? `first profit ${fmtAgo(row.firstProfitAt)}` : t('neverProfited')),
          ]))),
      ]);
    }

    // -----------------------------------------------------------------------
    // dashboard (shared by the main panel and the settings tab)
    // -----------------------------------------------------------------------

    function DashboardBody({ t, snapshot, summary, rows, selectedRow, onSelect, onCloseDetail }) {
      const { controlState, runControl } = useControlActions();
      return h('div', { className: 'atm-root' }, [
        summary.halted ? h('p', { className: 'atm-halt', key: 'halted' }, t('halted')) : null,
        snapshot.error ? h('p', { className: 'atm-err', key: 'fetch-error' }, `${t('lastError')}: ${errorText(snapshot.error)}`) : null,
        h(HeaderStats, { key: 'stats', t, summary }),
        h(ReaperRow, { key: 'reaper', t, summary, controlState, runControl }),
        h(ControlBar, { key: 'controls', t, summary: { ...summary, paused: snapshot.paused }, controlState, runControl }),
        h('div', { className: 'atm-workspace', key: 'workspace', 'data-detail': selectedRow ? 'true' : 'false' }, [
          h('div', { className: 'atm-main-col', key: 'left' }, [
            h(AgentTable, {
              key: 'table',
              t,
              rows,
              selectedId: selectedRow ? selectedRow.id : null,
              onSelect,
            }),
            h('div', { className: 'atm-two', key: 'bottom' }, [
              h(Generations, { key: 'gens', t, summaryData: snapshot.data }),
              h(Obituaries, { key: 'obits', t, summaryData: snapshot.data }),
            ]),
          ]),
          selectedRow
            ? h(AgentDetail, { key: 'detail', t, row: selectedRow, onClose: onCloseDetail })
            : null,
        ]),
        summary.lastError ? h('p', { className: 'atm-err', key: 'last-error' }, `${t('lastError')}: ${errorText(summary.lastError)}`) : null,
        h('p', { className: 'atm-note', key: 'note' },
          `${t('brakes')} · ${t('externalReaper')} · ${t('updated')} ${fmtAgo(snapshot.data.at)}`),
      ]);
    }

    /**
     * Shared dashboard page: used for the sidebar-opened `main` panel and the
     * `settings.plugins.tab` page. Selection is component-local (per surface) and
     * survives polling because rows are re-looked-up by agent id.
     */
    function AutomatonDashboard({ t, variant }) {
      const snapshot = useDashboardState();
      const summaryData = snapshot.data;
      const summary = React.useMemo(() => (summaryData ? summarize(summaryData) : null), [summaryData]);
      const rows = React.useMemo(() => (summaryData ? buildAgentRows(summaryData) : []), [summaryData]);
      const [selectedId, setSelectedId] = React.useState(null);
      const selectedRow = React.useMemo(() => findAgentRow(rows, selectedId), [rows, selectedId]);
      React.useEffect(() => {
        if (selectedId !== null && summaryData && rows.length > 0 && !rows.some((row) => row.id === selectedId)) {
          setSelectedId(null);
        }
      }, [rows, selectedId, summaryData]);

      const isSettings = variant === 'settings';
      return h('div', { className: isSettings ? 'atm-root atm-settings' : 'atm-root atm-main' }, [
        h('style', { key: 'css' }, APP_CSS),
        h('div', { className: 'atm-head', key: 'head' }, [
          h('div', { className: 'atm-head-main', key: 'titles' }, [
            h('h2', { className: 'atm-title', key: 'title' }, t('title')),
            h('p', { className: 'atm-sub', key: 'sub' }, t('subtitle')),
          ]),
          h('div', { className: 'atm-head-actions', key: 'actions' }, [
            summary ? h(ModeBadge, { key: 'mode', t, mode: summary.mode }) : null,
            summary ? h('span', { className: 'atm-badge', key: 'loop', 'data-running': summary.running ? 'true' : 'false' }, summary.running ? t('running') : t('stopped')) : null,
            summary ? h(KillBadge, { key: 'kill', t, on: summary.killSwitch }) : null,
            h(PauseToggle, { key: 'pause', t }),
            h('span', { className: 'atm-muted', key: 'auto', title: t('autoRefresh') }, t('autoRefresh')),
          ]),
        ]),
        !summaryData
          ? h('p', { className: 'atm-muted', key: 'loading' }, snapshot.error ? `${t('offline')}: ${errorText(snapshot.error)}` : t('loading'))
          : h(DashboardBody, {
            key: 'body',
            t,
            snapshot,
            summary,
            rows,
            selectedRow,
            onSelect: (id) => setSelectedId((previous) => (previous === id ? null : id)),
            onCloseDetail: () => setSelectedId(null),
          }),
      ]);
    }

    // -----------------------------------------------------------------------
    // sidebar entry glyph (rendered inside the sidebar panel row)
    // -----------------------------------------------------------------------

    function SidebarPanelIcon({ size = 16, active }) {
      const px = Number.isFinite(Number(size)) ? Number(size) : 16;
      return h('svg', {
        className: 'atm-icon',
        width: px,
        height: px,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        focusable: 'false',
      }, [
        h('path', {
          key: 'pulse',
          d: 'M2.6 15h3.8l1.6-4.6 2.3 8.3 2-5.5 1.4 1.8h2',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { key: 'skull', cx: 19, cy: 8.2, r: 3, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('circle', { key: 'eyeL', cx: 18, cy: 7.9, r: 0.7, fill: 'currentColor' }),
        h('circle', { key: 'eyeR', cx: 20, cy: 7.9, r: 0.7, fill: 'currentColor' }),
        active ? h('circle', { key: 'live', cx: 19, cy: 19.6, r: 1.3, fill: 'var(--dsw-alias-state-business-primary,currentColor)' }) : null,
      ]);
    }

    // -----------------------------------------------------------------------
    // module
    // -----------------------------------------------------------------------

    /** React context carrying the locale translator into slot components. */
    const LocaleContext = React.createContext((key) => EN[key] ?? key);

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return;
        const t = createTranslator(ctx);
        const providerFor = (Component, extra) => (props) => h(
          LocaleContext.Provider,
          { value: t },
          h(Component, { ...props, ...(extra ?? {}), t }),
        );

        /**
         * Inject a contribution into `slotName` without letting one unavailable slot
         * (e.g. a deployment without the Settings page composed in) break the others.
         */
        const contribute = (slotName, options, Component, extra) => {
          try {
            ctx.slots.inject(slotName, () => {
              try {
                return ctx.slots.register({ name: slotName, ...options }, providerFor(Component, extra));
              } catch (error) {
                try {
                  console.warn(`[automaton-trading] could not register into ${slotName}:`, error?.message ?? error);
                } catch {
                  /* console is optional */
                }
                return () => {};
              }
            });
          } catch (error) {
            try {
              console.warn(`[automaton-trading] slot ${slotName} is unavailable:`, error?.message ?? error);
            } catch {
              /* console is optional */
            }
          }
        };

        // Sidebar entry: the glyph + label in the sidebar's global panel list.
        contribute(SIDEBAR_SLOT, {
          id: PANEL_ID,
          order: 30,
          label: () => t('sidebarLabel'),
          locale: NS,
        }, SidebarPanelIcon);

        // Central panel opened by selecting the sidebar entry (keyed `main` slot).
        contribute(MAIN_SLOT, {
          key: PANEL_ID,
          locale: NS,
        }, AutomatonDashboard, { variant: 'main' });

        // Secondary full-page entry inside Settings -> Built-in plugins.
        contribute(SETTINGS_SLOT, {
          id: PANEL_ID,
          order: 20,
          label: () => t('tab'),
          locale: NS,
        }, AutomatonDashboard, { variant: 'settings' });
      },
      /** Pure data helpers, exposed for the host test suite (no React rendering needed). */
      helpers: {
        buildAgentRows,
        buildHoldingsRows,
        buildActivityRows,
        describeReaper,
        summarize,
        generationRows,
        obituaryRows,
        sortAgentRows,
        filterAgentRows,
        findAgentRow,
        strategyParamItems,
        strategyParamsText,
        agentDisplayName,
        strategyLabel,
        familyLabel,
        roleCostRows,
        fmtUsd,
        fmtSignedUsd,
        fmtHours,
        fmtPct,
        fmtPercentPoints,
        fmtAgo,
        fmtDateTime,
        lifespanHours,
        runwayPercent,
        runwayLevel,
        shortId,
        modeOf,
        STATE_URL,
        CONTROL_URL,
        POLL_MS,
        PANEL_ID,
        SIDEBAR_SLOT,
        MAIN_SLOT,
        SETTINGS_SLOT,
        SORTABLE_KEYS,
      },
    };
  },
});
