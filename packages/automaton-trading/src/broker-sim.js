/**
 * Deterministic synthetic broker + market (market side) — the accelerated, network-free
 * twin of `broker-alpaca.js`. Same interface, same return shapes, zero I/O.
 *
 * The market is generated with `mulberry32(seed)` so the same seed and the same call
 * sequence always produce the same bars, quotes, fills and account: the population
 * simulation is reproducible. Each symbol walks through repeating regimes
 * (trend up / choppy / mean-reverting / trend down) so momentum, mean-reversion,
 * breakout and gap-fade signals all have something real to find.
 *
 * Order fills are immediate for market orders at the current quote plus configured
 * slippage/commission; resting limit orders fill when a later bar trades through the
 * limit. Cash and positions are accounted exactly, with no shorting and no negative cash.
 *
 * Includes a deterministic synthetic news feed (`getNews`) so the isolated research
 * sidecar can be exercised offline: same seed + same simulated hour => same headlines.
 *
 * Contract: docs/CONTRACTS.md § "Broker interface". Owner: market teammate.
 *
 * @module broker-sim
 */

import { fail } from './contracts.js';
import { HOUR_MS, mulberry32, round2, round4 } from './util.js';

/** Fixed simulated session start so bars/timestamps are deterministic. */
export const SIM_MARKET_EPOCH_MS = Date.UTC(2024, 0, 8, 14, 30, 0);

const DEFAULT_SEED = 42;
const DEFAULT_ACCOUNT_EQUITY_USD = 100_000;
const DEFAULT_HISTORY_BARS = 400;
const REGIME_BARS = 48;
const MIN_PRICE_USD = 1;

/** Deterministic synthetic-news templates consumed by the research sidecar. */
const NEWS_TEMPLATES = Object.freeze([
  { headline: '{symbol} beats quarterly expectations', summary: 'Quarterly results for {symbol} came in above consensus, with management raising guidance.' },
  { headline: 'Analysts lift {symbol} price target', summary: 'A sell-side note raised its target on {symbol}, citing improving end-market demand.' },
  { headline: '{symbol} warns on margin pressure', summary: '{symbol} flagged input-cost pressure that could weigh on margins next quarter.' },
  { headline: '{symbol} downgraded after soft guidance', summary: 'An analyst downgraded {symbol} following cautious forward guidance.' },
  { headline: '{symbol} announces routine product update', summary: '{symbol} shipped a routine product refresh; no financial detail was disclosed.' },
  { headline: '{symbol} schedules investor day', summary: '{symbol} will host an investor day to discuss its medium-term capital plan.' },
  { headline: 'Regulators open review into {symbol} disclosures', summary: 'A regulatory review into {symbol} disclosures adds near-term uncertainty.' },
  { headline: '{symbol} expands share repurchase program', summary: '{symbol} enlarged its share repurchase authorization, a modest capital-return signal.' },
]);

/** Parse a news start/end filter (epoch ms or ISO string) to epoch ms. */
function newsFilterMs(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// deterministic helpers
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit string hash (stable across runs/platforms). */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Per-symbol seeded PRNG so symbols are independent but deterministic. */
function symbolRng(seed, symbol) {
  return mulberry32((fnv1a(symbol) ^ Math.imul(seed >>> 0, 0x9e3779b9)) >>> 0);
}

/** Standard normal from a uniform rng (Box-Muller, deterministic). */
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function num(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Generate one hourly OHLCV bar for a symbol state.
 * Regimes: 0 = trend up, 1 = choppy, 2 = mean-reverting, 3 = trend down.
 * @param {object} state symbol state
 * @returns {{t:number,o:number,h:number,l:number,c:number,v:number}}
 */
function nextBar(state) {
  const rng = state.rng;
  const index = state.bars.length;
  const regime = Math.floor(index / REGIME_BARS) % 4;
  const sigma = 0.0022 + rng() * 0.0038; // 0.22% - 0.6% hourly vol
  const prevClose = state.lastClose;
  let drift = 0;
  if (regime === 0) drift = 0.0007 + rng() * 0.0008; // persistent uptrend
  else if (regime === 3) drift = -(0.0007 + rng() * 0.0008); // persistent downtrend
  else if (regime === 2) drift = ((state.mean - prevClose) / prevClose) * 0.12; // reversion pull
  // regime 1 (choppy) has ~zero drift and slightly higher vol
  const vol = regime === 1 ? sigma * 1.35 : sigma;

  // Gaps exist so the gap-fade family has something to measure.
  const gapChance = rng();
  let gap = 0;
  if (gapChance < 0.12) gap = gaussian(rng) * 0.0018;
  if (gapChance < 0.02) gap = Math.sign(gaussian(rng) || 1) * (0.004 + rng() * 0.004);

  let open = prevClose * (1 + gap);
  let close = open * (1 + drift + vol * gaussian(rng));
  open = Math.max(MIN_PRICE_USD, open);
  close = Math.max(MIN_PRICE_USD, close);
  const wickUp = Math.abs(gaussian(rng)) * vol * 0.55;
  const wickDown = Math.abs(gaussian(rng)) * vol * 0.55;
  const high = Math.max(open, close) * (1 + wickUp);
  const low = Math.max(MIN_PRICE_USD, Math.min(open, close) * (1 - wickDown));
  const volume = Math.round(250_000 + rng() * 3_000_000);

  const bar = {
    t: SIM_MARKET_EPOCH_MS + index * HOUR_MS,
    o: round4(open),
    h: round4(high),
    l: round4(low),
    c: round4(close),
    v: volume,
  };
  state.lastClose = bar.c;
  state.mean = state.mean + (bar.c - state.mean) * 0.08;
  state.bars.push(bar);
  return bar;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * Create a simulated broker + market with the same interface as broker-alpaca.
 *
 * @param {object} config AUTOMATON config (mode is reported as 'sim')
 * @param {{
 *   seed?: number,
 *   accountEquityUsd?: number,
 *   clock?: { now: () => number },
 *   spreadBps?: number,
 *   slippageBps?: number,
 *   commissionUsd?: number,
 *   fetchImpl?: typeof fetch,
 *   secrets?: Record<string,string>,
 *   historyBars?: number,
 * }} [options]
 * @param {{ seed?: number, accountEquityUsd?: number }} [simOptions] Lead-passed third arg
 * @returns {object} broker with kind 'sim' plus market helpers
 */
export function createBroker(config, options = {}, simOptions = {}) {
  if (!config || typeof config !== 'object') {
    fail('CONFIG_INVALID', 'broker-sim requires a config object');
  }
  const symbols = Array.isArray(config.symbols) ? [...config.symbols] : [];
  if (symbols.length === 0) fail('CONFIG_INVALID', 'broker-sim needs at least one configured symbol');

  const clock = options.clock ?? null;
  const spreadBps = num(options.spreadBps ?? config.sim?.spreadBps, 4);
  const slippageBps = num(options.slippageBps ?? config.sim?.slippageBps, 5);
  const commissionUsd = num(options.commissionUsd ?? config.sim?.commissionUsd, 0);
  const baseSeed = num(simOptions.seed ?? options.seed ?? config.sim?.seed, DEFAULT_SEED);
  const baseEquity = num(
    simOptions.accountEquityUsd ?? options.accountEquityUsd ?? config.sim?.accountEquityUsd,
    DEFAULT_ACCOUNT_EQUITY_USD,
  );
  const historyBars = Math.max(
    DEFAULT_HISTORY_BARS,
    num(options.historyBars, 0),
    num(config.data?.lookbackBars, 120) + 60,
  );

  /** @type {ReturnType<typeof createBroker>} */
  const broker = {
    kind: 'sim',
    mode: 'sim',
    seed: baseSeed,
    symbols,
  };

  // -------------------------------------------------------------------------
  // state
  // -------------------------------------------------------------------------
  let market = null; // { nowMs, symbolStates: Map }
  let account = null; // { cashUsd, positions: Map, orders: [], seq }
  let quoteOverrides = new Map();

  /** @returns {void} */
  function initMarket(seed) {
    const symbolStates = new Map();
    for (const symbol of symbols) {
      const rng = symbolRng(seed, symbol);
      const basePrice = 25 + (fnv1a(`${symbol}:${seed}`) % 400); // $25 - $425
      /** @type {object} */
      const state = {
        symbol,
        rng,
        bars: [],
        lastClose: basePrice,
        mean: basePrice,
      };
      for (let i = 0; i < historyBars; i += 1) nextBar(state);
      symbolStates.set(symbol, state);
    }
    market = { nowMs: SIM_MARKET_EPOCH_MS + historyBars * HOUR_MS, symbolStates, seed };
  }

  /** @returns {void} */
  function initAccount() {
    account = { cashUsd: baseEquity, positions: new Map(), orders: [], seq: 0 };
  }

  initMarket(baseSeed);
  initAccount();

  /** Current reference price (last close), independent of overrides. */
  function lastClose(symbol) {
    const state = market.symbolStates.get(symbol);
    if (!state || state.bars.length === 0) return null;
    return state.bars[state.bars.length - 1].c;
  }

  /** Current quote including deterministic test overrides. */
  function currentQuote(symbol) {
    const ticker = String(symbol ?? '').trim().toUpperCase();
    const override = quoteOverrides.get(ticker);
    if (override) {
      const last = num(override.last, num(override.bid, num(override.ask, lastClose(ticker))));
      return {
        symbol: ticker,
        bid: num(override.bid, last),
        ask: num(override.ask, last),
        last,
        ts: num(override.ts, broker.marketNow()),
      };
    }
    const close = lastClose(ticker);
    if (close === null) {
      fail('DATA_MISSING', `sim broker has no market for symbol ${ticker}`, { symbol: ticker });
    }
    const half = spreadBps / 20_000; // spreadBps -> half-spread as fraction
    return {
      symbol: ticker,
      bid: round4(close * (1 - half)),
      ask: round4(close * (1 + half)),
      last: close,
      ts: broker.marketNow(),
    };
  }

  /** Market clock in simulated milliseconds (or the injected clock's time). */
  function marketNow() {
    if (clock && typeof clock.now === 'function') return Math.round(clock.now());
    return market.nowMs;
  }

  function execPrice(side, quote) {
    const slip = slippageBps / 10_000;
    return round4(side === 'buy' ? quote.ask * (1 + slip) : quote.bid * (1 - slip));
  }

  function normalizeOrder(raw) {
    return {
      id: raw.id,
      clientOrderId: raw.clientOrderId ?? null,
      symbol: raw.symbol,
      side: raw.side,
      qty: raw.qty,
      filledQty: raw.filledQty,
      avgFillPriceUsd: raw.avgFillPriceUsd ?? null,
      status: raw.status,
      submittedAt: raw.submittedAt,
      type: raw.type ?? 'market',
      notionalUsd: round2(raw.notionalUsd ?? 0),
    };
  }

  /** Apply a fill to cash/positions and mutate the order record. */
  function fill(order, price) {
    const qty = order.qty;
    const notional = round2(qty * price);
    if (order.side === 'buy') {
      const cost = round2(notional + commissionUsd);
      if (cost > round2(account.cashUsd) + 1e-9) {
        fail('INSUFFICIENT_CASH', 'sim broker has insufficient cash for fill', {
          cashUsd: round2(account.cashUsd),
          costUsd: cost,
        });
      }
      account.cashUsd = round2(account.cashUsd - cost);
      const existing = account.positions.get(order.symbol);
      if (existing && existing.qty > 0) {
        const totalQty = round4(existing.qty + qty);
        existing.avgPriceUsd = round4(
          (existing.qty * existing.avgPriceUsd + qty * price) / Math.max(totalQty, 1e-9),
        );
        existing.qty = totalQty;
        existing.openedAt = existing.openedAt ?? marketNow();
      } else {
        account.positions.set(order.symbol, {
          qty,
          avgPriceUsd: price,
          openedAt: marketNow(),
        });
      }
    } else {
      const existing = account.positions.get(order.symbol);
      if (!existing || existing.qty + 1e-9 < qty) {
        fail('BRAKE_DENIED', 'sim broker forbids shorting: sell qty exceeds position', {
          symbol: order.symbol,
          sellQty: qty,
          heldQty: existing?.qty ?? 0,
        });
      }
      account.cashUsd = round2(account.cashUsd + notional - commissionUsd);
      const remaining = round4(existing.qty - qty);
      if (remaining <= 0) account.positions.delete(order.symbol);
      else existing.qty = remaining;
    }
    order.status = 'filled';
    order.filledQty = qty;
    order.avgFillPriceUsd = price;
    order.notionalUsd = notional;
    order.filledAt = marketNow();
    return order;
  }

  /**
   * @param {{symbol:string, side:'buy'|'sell', qty?:number, notional?:number, type?:string,
   *          limitPrice?:number, clientOrderId?:string, timeInForce?:string}} input
   * @returns {object}
   */
  function submitOrder(input = {}) {
    const symbol = String(input.symbol ?? '').trim().toUpperCase();
    if (!market.symbolStates.has(symbol)) {
      fail('BRAKE_DENIED', `sim broker symbol not whitelisted: ${symbol}`, { symbol });
    }
    const side = String(input.side ?? '').trim().toLowerCase();
    if (side !== 'buy' && side !== 'sell') {
      fail('SPEC_INVALID', 'sim submitOrder side must be buy or sell', { side: input.side });
    }
    const type = input.type ?? 'market';
    const quote = currentQuote(symbol);
    const price = execPrice(side, quote);

    let qty = num(input.qty, null);
    const notional = num(input.notional, null);
    if (qty === null && notional === null) {
      fail('SPEC_INVALID', 'sim submitOrder requires qty or notional', { symbol });
    }
    if (qty === null) qty = round4(notional / price);
    qty = round4(qty);
    if (!(qty > 0)) fail('SPEC_INVALID', 'sim submitOrder qty must be positive', { symbol, qty });

    account.seq += 1;
    const order = normalizeOrder({
      id: `sim-ord-${String(account.seq).padStart(6, '0')}`,
      clientOrderId: input.clientOrderId ? String(input.clientOrderId) : null,
      symbol,
      side,
      qty,
      filledQty: 0,
      avgFillPriceUsd: null,
      status: 'new',
      submittedAt: marketNow(),
      type,
      notionalUsd: 0,
    });

    if (type === 'market') {
      fill(order, price);
      account.orders.push(order);
      return { ...order };
    }

    if (type !== 'limit') {
      fail('SPEC_INVALID', `sim broker only supports market and limit orders, got ${type}`, { type });
    }
    const limitPrice = num(input.limitPrice, null);
    if (limitPrice === null) fail('SPEC_INVALID', 'sim limit order requires limitPrice', { symbol });
    order.limitPriceUsd = limitPrice;
    const executable = side === 'buy'
      ? quote.ask <= limitPrice + 1e-9
      : quote.bid >= limitPrice - 1e-9;
    if (executable) fill(order, round4(Math.min(limitPrice, price)));
    account.orders.push({ ...order });
    return { ...order };
  }

  /** Try to fill resting limit orders against the latest bar. */
  function matchRestingOrders() {
    for (const order of account.orders) {
      if (order.status !== 'new' || order.type !== 'limit' || order.limitPriceUsd === undefined) continue;
      const state = market.symbolStates.get(order.symbol);
      if (!state || state.bars.length === 0) continue;
      const bar = state.bars[state.bars.length - 1];
      const crossed = order.side === 'buy' ? bar.l <= order.limitPriceUsd : bar.h >= order.limitPriceUsd;
      if (!crossed) continue;
      try {
        fill(order, order.limitPriceUsd);
      } catch {
        order.status = 'rejected';
      }
    }
  }

  function openStatuses() {
    return new Set(['new', 'accepted', 'pending_new', 'partially_filled']);
  }

  // -------------------------------------------------------------------------
  // contract surface (mirrors broker-alpaca.js exactly)
  // -------------------------------------------------------------------------

  Object.assign(broker, {
    /** @returns {{isOpen:boolean, timestamp:number, nextOpen:number, nextClose:number}} */
    getClock() {
      const now = marketNow();
      return {
        isOpen: true, // sim market is always open; the window brake is separate
        timestamp: now,
        nextOpen: now,
        nextClose: now + 6.5 * HOUR_MS,
      };
    },

    /** @returns {{equityUsd:number, cashUsd:number, buyingPowerUsd:number, status:string, currency:string, mode:string}} */
    getAccount() {
      let positionsValue = 0;
      for (const [symbol, position] of account.positions) {
        const close = lastClose(symbol);
        if (close !== null) positionsValue += position.qty * close;
      }
      const equity = round2(account.cashUsd + positionsValue);
      return {
        equityUsd: equity,
        cashUsd: round2(account.cashUsd),
        buyingPowerUsd: round2(account.cashUsd),
        status: 'ACTIVE',
        currency: 'USD',
        mode: 'sim',
      };
    },

    /** @returns {Array<{symbol:string, qty:number, avgEntryPriceUsd:number, marketValueUsd:number, unrealizedPlUsd:number}>} */
    getPositions() {
      const rows = [];
      for (const [symbol, position] of account.positions) {
        const close = lastClose(symbol);
        const marketValue = close === null ? 0 : round2(position.qty * close);
        rows.push({
          symbol,
          qty: position.qty,
          avgEntryPriceUsd: position.avgPriceUsd,
          marketValueUsd: marketValue,
          unrealizedPlUsd: close === null ? 0 : round2((close - position.avgPriceUsd) * position.qty),
        });
      }
      return rows;
    },

    /**
     * @param {{status?: string, limit?: number, after?: number|string}} [query]
     * @returns {Array<object>} newest first
     */
    getOrders({ status = 'all', limit = 100, after } = {}) {
      const open = openStatuses();
      let rows = account.orders.filter((order) => {
        if (status === 'open') return open.has(order.status);
        if (status === 'closed') return !open.has(order.status);
        return true;
      });
      if (after !== undefined && after !== null) {
        const afterMs = typeof after === 'number' ? after : Date.parse(String(after));
        if (Number.isFinite(afterMs)) rows = rows.filter((order) => order.submittedAt > afterMs);
      }
      return rows
        .slice(-Math.max(1, Math.min(500, Number(limit) || 100)))
        .reverse()
        .map((order) => ({ ...order }));
    },

    submitOrder,

    /** @param {string} id @returns {{id:string, status:string}} */
    cancelOrder(id) {
      const order = account.orders.find((row) => row.id === String(id ?? ''));
      if (!order) fail('BROKER_ERROR', `sim broker has no order ${id}`, { id });
      if (openStatuses().has(order.status)) order.status = 'canceled';
      return { id: order.id, status: order.status };
    },

    /**
     * @param {{symbols?: string|string[], timeframe?: string, limit?: number}} params
     * @returns {Record<string, Array<{t:number,o:number,h:number,l:number,c:number,v:number}>>}
     */
    getBars({ symbols: wanted, timeframe = '1Hour', limit = 120 } = {}) {
      const list = (Array.isArray(wanted) ? wanted : String(wanted ?? '').split(','))
        .map((s) => String(s ?? '').trim().toUpperCase())
        .filter(Boolean);
      const tickers = list.length > 0 ? [...new Set(list)] : symbols;
      const max = Math.max(1, Math.min(10_000, Number(limit) || 120));
      const out = {};
      for (const symbol of tickers) {
        const state = market.symbolStates.get(symbol);
        // Expose exactly the contract bar shape { t, o, h, l, c, v } (no extras).
        out[symbol] = state
          ? state.bars.slice(-max).map((bar) => ({ t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }))
          : [];
      }
      return out;
    },

    /**
     * @param {string} symbol
     * @returns {{symbol:string, bid:number, ask:number, last:number, ts:number}}
     */
    getLatestQuote(symbol) {
      return currentQuote(symbol);
    },

    /**
     * Deterministic synthetic news for the research sidecar (offline twin of
     * broker-alpaca.getNews). Headlines are seeded by market seed + symbol + the
     * simulated hour, so the same seed and simulated time produce identical items.
     *
     * @param {{symbols?: string|string[], limit?: number, start?: string|number,
     *          end?: string|number}} params
     * @returns {Promise<Array<{id:string, headline:string, summary:string, source:string,
     *           url:string|null, symbols:string[], createdAt:number}>>}
     */
    async getNews({ symbols: wanted, limit = 6, start, end } = {}) {
      const requested = (Array.isArray(wanted) ? wanted : typeof wanted === 'string' ? wanted.split(',') : [])
        .map((item) => String(item ?? '').trim().toUpperCase())
        .filter(Boolean);
      // Explicit empty list => no news; omitted list => the broker's configured universe.
      const tickers = [...new Set(wanted === undefined ? symbols : requested)]
        .filter((ticker) => market.symbolStates.has(ticker));
      if (tickers.length === 0) return [];
      const effectiveLimit = Math.max(1, Math.min(20, Number(limit) || 6));
      const startMs = newsFilterMs(start);
      const endMs = newsFilterMs(end);
      const now = marketNow();
      const bucket = Math.floor(now / HOUR_MS);
      const items = [];
      for (const ticker of tickers) {
        // Fresh PRNG per symbol+bucket: deterministic, and independent of call order.
        const rng = mulberry32(fnv1a(`${market.seed}:${ticker}:${bucket}`));
        for (let index = 0; index < effectiveLimit; index += 1) {
          const template = NEWS_TEMPLATES[Math.floor(rng() * NEWS_TEMPLATES.length) % NEWS_TEMPLATES.length];
          const minutesAgo = 3 + index * 17 + Math.floor(rng() * 9);
          const createdAt = now - minutesAgo * 60 * 1000;
          if (startMs !== null && createdAt < startMs) continue;
          if (endMs !== null && createdAt > endMs) continue;
          items.push({
            id: `sim-news-${ticker}-${bucket}-${index}`,
            headline: template.headline.replace('{symbol}', ticker),
            summary: template.summary.replace('{symbol}', ticker),
            source: 'Simulated Wire',
            url: null,
            symbols: [ticker],
            createdAt,
          });
        }
      }
      items.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
      return items.slice(0, effectiveLimit);
    },

    /** Optional helper mirroring broker-alpaca. */
    getDayBars(symbol, { limit = 120 } = {}) {
      const timeframe = config.data?.timeframe ?? '1Hour';
      return broker.getBars({ symbols: [symbol], timeframe, limit });
    },

    /**
     * The sim data URL recorded as hypothesis proof (clearly non-networked).
     * @param {{symbols: string|string[], timeframe?: string, limit?: number}} params
     * @returns {string}
     */
    getDataUrl({ symbols: wanted, timeframe = '1Hour', limit = 120 } = {}) {
      const list = (Array.isArray(wanted) ? wanted : String(wanted ?? '').split(','))
        .map((s) => String(s ?? '').trim().toUpperCase())
        .filter(Boolean);
      const url = new URL('/v2/stocks/bars', 'sim://data.alpaca.markets');
      url.searchParams.set('symbols', list.join(','));
      url.searchParams.set('timeframe', String(timeframe));
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('adjustment', 'raw');
      url.searchParams.set('feed', 'iex');
      url.searchParams.set('sim', '1');
      url.searchParams.set('seed', String(market.seed));
      return url.toString();
    },

    // ---------------------------------------------------------------------
    // market helpers (sim-only; used by tests + simulate.js)
    // ---------------------------------------------------------------------

    /** Advance the synthetic market by `bars` hourly bars; fills resting limits. */
    advanceBar(bars = 1) {
      const steps = Math.max(1, Math.floor(Number(bars) || 1));
      for (let step = 0; step < steps; step += 1) {
        for (const state of market.symbolStates.values()) nextBar(state);
        market.nowMs += HOUR_MS;
        matchRestingOrders();
      }
      return broker;
    },

    /** Alias used by simulate.js: advance exactly one bar. */
    advanceBars(bars = 1) {
      return broker.advanceBar(bars);
    },

    /** Simulated market clock in epoch ms. */
    marketNow,

    /** Current bar index (0-based) for the generated series. */
    barIndex() {
      const state = market.symbolStates.get(symbols[0]);
      return state ? state.bars.length - 1 : -1;
    },

    /**
     * Deterministic quote overrides for tests/executor scenarios.
     * `setQuoteOverrides({ AAPL: { bid, ask, last } })`; entries set to null clear.
     * @param {Record<string, {bid?:number, ask?:number, last?:number, ts?:number}|null>} overrides
     */
    setQuoteOverrides(overrides = {}) {
      for (const [symbol, value] of Object.entries(overrides ?? {})) {
        const ticker = String(symbol).toUpperCase();
        if (value === null || value === undefined) quoteOverrides.delete(ticker);
        else quoteOverrides.set(ticker, { ...value });
      }
      return broker;
    },

    /** Remove all quote overrides. */
    clearQuoteOverrides() {
      quoteOverrides = new Map();
      return broker;
    },

    /** The state the sim broker is currently quoting (for debugging/tests). */
    snapshot() {
      return {
        seed: market.seed,
        barIndex: broker.barIndex(),
        now: marketNow(),
        account: broker.getAccount(),
        positions: broker.getPositions(),
        orders: account.orders.map((order) => ({ ...order })),
        quoteOverrides: Object.fromEntries(quoteOverrides),
      };
    },

    /**
     * Re-seed just the market (account/orders untouched). Test helper.
     * @param {number|{seed?: number}} seed
     */
    setMarket(seed) {
      const nextSeed = num(typeof seed === 'object' ? seed?.seed : seed, baseSeed);
      initMarket(nextSeed);
      return broker;
    },

    /** Full reset: original seed, fresh account, no orders, no overrides. */
    reset() {
      market = null;
      account = null;
      quoteOverrides = new Map();
      initMarket(baseSeed);
      initAccount();
      return broker;
    },
  });

  return broker;
}

export default createBroker;
