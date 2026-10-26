/**
 * EXECUTOR — the only role that presses the button.
 *
 * Stopline (architecture §2): the Executor never reads account equity or cash (that is
 * the Treasurer's alone) and never decides its own budget: it receives a mandate from
 * the Treasurer, a StrategySpec from the Builder, and quotes. Every order it intends to
 * place passes `brakes.checkOrder()` FIRST; a denial is recorded, never retried blind.
 *
 * It reads only: its own ledger position book (`ledger.book(agentId)`), the broker's
 * public market data, `submitOrder`/`cancelOrder`/`getOrders`. It never calls
 * `broker.getAccount()`.
 *
 * Exits are risk-reducing and run before entries: stop-loss, take-profit, max-hold
 * bars, family exit signal. Entries are long-only, sized from
 * `sizePct * mandate.sizeBudgetUsd` and capped by absolute notional caps, rounded to
 * 4 decimal fractional shares, stamped `atm:<agentId>:<specId>:<seq>`.
 *
 * Contract: docs/CONTRACTS.md § "Data feeder / market helpers" (executor.js).
 * Owner: market teammate.
 *
 * @module executor
 */

import { fail } from './contracts.js';
import { HOUR_MS, mean, round2, round4, SYSTEM_CLOCK } from './util.js';

const MAX_BARS_FETCH = 240;

// ---------------------------------------------------------------------------
// small normalization helpers
// ---------------------------------------------------------------------------

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Accept epoch ms, Date, or ISO string; fall back to the injected clock. */
export function normalizeNow(value, clock = SYSTEM_CLOCK) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return clock.now();
}

/** Parse a ledger timestamp (epoch ms or ISO) to epoch ms. */
function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Normalize one quote to { symbol, bid, ask, last, ts }. */
export function normalizeQuote(raw, symbol) {
  if (!raw || typeof raw !== 'object') return null;
  const bid = numberOrNull(raw.bid ?? raw.bidPriceUsd);
  const ask = numberOrNull(raw.ask ?? raw.askPriceUsd);
  const last = numberOrNull(raw.last ?? raw.lastPriceUsd ?? raw.priceUsd);
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : last ?? bid ?? ask;
  if (!(mid > 0)) return null;
  return {
    symbol: String(raw.symbol ?? symbol ?? '').toUpperCase(),
    bid: bid ?? mid,
    ask: ask ?? mid,
    last: last ?? mid,
    ts: raw.ts ?? null,
  };
}

/** Normalize a bars array (ascending) dropping invalid rows. */
export function normalizeBars(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const c = numberOrNull(raw.c);
    const o = numberOrNull(raw.o);
    if (!(c > 0) || !(o > 0)) continue;
    const t = timestampOf(raw.t);
    out.push({
      t,
      o,
      h: numberOrNull(raw.h) ?? Math.max(o, c),
      l: numberOrNull(raw.l) ?? Math.min(o, c),
      c,
      v: numberOrNull(raw.v) ?? 0,
    });
  }
  out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  return out;
}

function meanStd(values) {
  if (!Array.isArray(values) || values.length === 0) return { mean: 0, std: 0 };
  const avg = mean(values);
  let variance = 0;
  for (const value of values) variance += (value - avg) ** 2;
  return { mean: avg, std: Math.sqrt(variance / values.length) };
}

/** Spread in bps from a normalized quote (0 when bid/ask are not both present). */
export function spreadBpsOf(quote) {
  if (!quote || !(quote.bid > 0) || !(quote.ask > 0)) return 0;
  const mid = (quote.bid + quote.ask) / 2;
  if (!(mid > 0)) return 0;
  return round2(((quote.ask - quote.bid) / mid) * 10_000);
}

/**
 * Evaluate a spec's family signal on the bar history.
 * Long-only (the mandate forbids shorting): `enter` means buy, `exit` means close.
 * @param {string} family
 * @param {Array<{t:number|null,o:number,h:number,l:number,c:number,v:number}>} bars ascending
 * @param {object} params spec params
 * @returns {{enter:boolean, exit:boolean, z:number|null, lastClose:number|null, reason:string}}
 */
export function computeSignal(family, bars, params = {}) {
  const n = bars.length;
  if (n < 30) {
    return { enter: false, exit: false, z: null, lastClose: n > 0 ? bars[n - 1].c : null, reason: 'insufficient_bars' };
  }
  const last = bars[n - 1];
  const entryZ = Number.isFinite(params.entryZ) ? params.entryZ : 1;
  const exitZ = Number.isFinite(params.exitZ) ? params.exitZ : 0.5;
  if (family === 'momentum') {
    const window = 5;
    const momentum = [];
    for (let i = window; i < n; i += 1) momentum.push(bars[i].c / bars[i - window].c - 1);
    const latest = momentum[momentum.length - 1];
    const history = momentum.slice(0, -1);
    const { mean: avg, std } = meanStd(history);
    const z = std > 0 ? (latest - avg) / std : 0;
    return {
      enter: z >= entryZ,
      exit: z <= exitZ,
      z: round4(z),
      lastClose: last.c,
      reason: `momentum z=${round2(z)}`,
    };
  }
  if (family === 'meanrev') {
    const window = 10;
    const slice = bars.slice(-window).map((bar) => bar.c);
    const { mean: avg, std } = meanStd(slice);
    const z = std > 0 ? (last.c - avg) / std : 0;
    return {
      enter: z <= -entryZ,
      exit: z >= -exitZ,
      z: round4(z),
      lastClose: last.c,
      reason: `meanrev z=${round2(z)}`,
    };
  }
  if (family === 'breakout') {
    const window = Math.min(20, n - 1);
    let priorHigh = -Infinity;
    for (let i = n - 1 - window; i < n - 1; i += 1) priorHigh = Math.max(priorHigh, bars[i].h);
    const sma10 = mean(bars.slice(-10).map((bar) => bar.c));
    return {
      enter: last.c > priorHigh,
      exit: last.c < sma10,
      z: priorHigh > 0 ? round4(((last.c - priorHigh) / priorHigh) * 10_000) : null,
      lastClose: last.c,
      reason: last.c > priorHigh ? 'breakout' : 'inside_range',
    };
  }
  if (family === 'gapfade') {
    const prev = bars[n - 2];
    const gap = (last.o - prev.c) / prev.c;
    return {
      enter: gap <= -0.002,
      exit: last.c >= prev.c,
      z: round4(gap * 10_000),
      lastClose: last.c,
      reason: `gap ${round2(gap * 10_000)}bps`,
    };
  }
  return { enter: false, exit: false, z: null, lastClose: last.c, reason: 'unknown_family' };
}

function positionsToMap(raw) {
  const map = new Map();
  if (!raw) return map;
  if (Array.isArray(raw)) {
    for (const position of raw) {
      if (position && position.symbol && Number(position.qty) > 0) {
        map.set(String(position.symbol).toUpperCase(), {
          qty: Number(position.qty),
          avgPriceUsd: numberOrNull(position.avgPriceUsd ?? position.avgEntryPriceUsd) ?? 0,
          openedAt: position.openedAt ?? null,
        });
      }
    }
    return map;
  }
  if (typeof raw === 'object') {
    for (const [symbol, position] of Object.entries(raw)) {
      if (!position || !(Number(position.qty) > 0)) continue;
      map.set(String(symbol).toUpperCase(), {
        qty: Number(position.qty),
        avgPriceUsd: numberOrNull(position.avgPriceUsd ?? position.avgEntryPriceUsd) ?? 0,
        openedAt: position.openedAt ?? null,
      });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   broker: object,
 *   brakes: { checkOrder: (input: object) => object },
 *   ledger: object,
 *   config: object,
 *   clock?: { now: () => number },
 * }} deps
 * @returns {{ run: (args: object) => Promise<object>, describe: () => object }}
 */
export function createExecutor({ broker, brakes, ledger, config, clock } = {}) {
  if (!broker || typeof broker.submitOrder !== 'function') {
    fail('CONFIG_INVALID', 'createExecutor requires a broker with submitOrder()');
  }
  if (!brakes || typeof brakes.checkOrder !== 'function') {
    fail('CONFIG_INVALID', 'createExecutor requires brakes.checkOrder()');
  }
  if (!ledger || typeof ledger.book !== 'function') {
    fail('CONFIG_INVALID', 'createExecutor requires ledger.book()');
  }
  if (!config || typeof config !== 'object') {
    fail('CONFIG_INVALID', 'createExecutor requires config');
  }
  const now = clock ?? SYSTEM_CLOCK;
  const risk = config.risk ?? {};
  const maxOrdersPerCycle = Math.max(1, risk.maxOrdersPerCycle ?? 1);
  const minOrderNotionalUsd = Number.isFinite(risk.minOrderNotionalUsd) ? risk.minOrderNotionalUsd : 1;
  const hardMaxNotionalUsd = Number.isFinite(risk.maxOrderNotionalUsd) ? risk.maxOrderNotionalUsd : Infinity;
  const maxOrderPctOfEquity = Number.isFinite(risk.maxOrderPctOfEquity) ? risk.maxOrderPctOfEquity : 0.25;
  const timeframe = config.data?.timeframe ?? '1Hour';

  /** Monotonic per-agent order sequence, so client_order_id never repeats. */
  const orderSeq = new Map();

  function nextSeq(agentId) {
    const seq = (orderSeq.get(agentId) ?? 0) + 1;
    orderSeq.set(agentId, seq);
    return seq;
  }

  return {
    /**
     * Run one execution cycle for one agent.
     * @param {{
     *   agent: object, spec: object, mandate: object,
     *   quotes?: Record<string, {bid?:number, ask?:number, last?:number, ts?:number}>,
     *   bars?: Record<string, Array<object>>|Array<object>,
     *   dayStats?: object, now?: number|string|Date,
     * }} args
     * @returns {Promise<{agentId:string, actions:Array<object>, orders:Array<object>,
     *           denied:Array<{code:string, reason:string}>, spentUsd:number}>}
     */
    async run({ agent, spec, mandate, quotes, bars: providedBars, dayStats, now: nowInput, marketOpen, marketClock } = {}) {
      const atMs = normalizeNow(nowInput, now);
      const at = new Date(atMs).toISOString();
      const agentId = String(agent?.id ?? agent?.agentId ?? spec?.agentId ?? '');
      /** @type {{agentId:string, actions:Array<object>, orders:Array<object>, denied:Array<object>, spentUsd:number}} */
      const result = { agentId, actions: [], orders: [], denied: [], spentUsd: 0 };

      const deny = (code, reason, extra = {}) => {
        result.denied.push({ code, reason, ...extra });
      };
      const skip = (symbol, reason, extra = {}) => {
        result.actions.push({ type: 'skip', symbol, reason, ...extra });
      };

      // --- broker-fill reconciliation (paper/live market orders are async) ---------
      // Alpaca returns a market order as `accepted` before it fills. Booking that response
      // would mean a 0-qty fill (and the real fill would never reach the virtual ledger), so:
      //   - we track how much of each order id is already booked,
      //   - we reconcile recent broker orders for THIS agent at the start of every cycle,
      //   - and after submitting we briefly poll for the fill before booking.
      /** @type {Map<string, number>} orderId -> booked qty */
      const bookedQtyByOrder = new Map();
      if (typeof ledger.history === 'function') {
        try {
          for (const fill of ledger.history(agentId, { limit: 250 })) {
            if (fill?.orderId) bookedQtyByOrder.set(fill.orderId, (bookedQtyByOrder.get(fill.orderId) ?? 0) + Number(fill.qty || 0));
          }
        } catch {
          /* history is optional for reconciliation */
        }
      }

      /** Book the not-yet-booked part of a broker order fill. */
      async function bookFilledOrder(order) {
        const orderId = order?.id ?? null;
        const filledQty = numberOrNull(order?.filledQty) ?? 0;
        const price = numberOrNull(order?.avgFillPriceUsd) ?? numberOrNull(order?.filledAvgPriceUsd) ?? 0;
        const symbol = String(order?.symbol ?? '').toUpperCase();
        if (!(filledQty > 0) || !(price > 0) || symbol === '') return { bookedQty: 0, reason: 'not_filled' };
        const already = orderId ? (bookedQtyByOrder.get(orderId) ?? 0) : 0;
        const delta = round4(filledQty - already);
        if (!(delta > 0)) return { bookedQty: 0, reason: 'already_booked' };
        await ledger.applyFill(agentId, {
          symbol,
          side: order.side,
          qty: delta,
          priceUsd: price,
          at,
          orderId,
        });
        if (orderId) bookedQtyByOrder.set(orderId, already + delta);
        return { bookedQty: delta, price, side: order.side, symbol };
      }

      /** Book any filled orders the broker has for this agent that the ledger has not seen. */
      async function reconcileBrokerFills() {
        if (typeof broker.getOrders !== 'function' || typeof ledger.applyFill !== 'function') return;
        try {
          const recent = await broker.getOrders({ status: 'all', limit: 100, direction: 'desc' });
          for (const order of Array.isArray(recent) ? recent : []) {
            if (!String(order?.clientOrderId ?? '').startsWith(`atm:${agentId}:`)) continue;
            if (!['filled', 'partially_filled'].includes(String(order?.status))) continue;
            const booked = await bookFilledOrder(order);
            if (booked.bookedQty > 0) {
              result.actions.push({
                type: 'reconcile_fill',
                symbol: booked.symbol,
                side: booked.side,
                qty: booked.bookedQty,
                priceUsd: round2(booked.price),
                orderId: order.id ?? null,
              });
            }
          }
        } catch (error) {
          result.actions.push({ type: 'reconcile_skipped', reason: String(error?.message ?? error).slice(0, 140) });
        }
      }

      /** Poll briefly for a just-submitted order to fill; returns the freshest order record. */
      async function waitForFill(order) {
        if (!order || (numberOrNull(order.filledQty) ?? 0) > 0 || typeof broker.getOrders !== 'function') return order;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          try {
            const recent = await broker.getOrders({ status: 'all', limit: 100, direction: 'desc' });
            const match = (Array.isArray(recent) ? recent : []).find(
              (candidate) => candidate?.id === order.id || (order.clientOrderId && candidate?.clientOrderId === order.clientOrderId),
            );
            if (match) {
              order = { ...order, ...match };
              if ((numberOrNull(order.filledQty) ?? 0) > 0) return order;
            }
          } catch {
            /* retry until the short poll window ends */
          }
        }
        return order;
      }

      // --- identity and life-state ------------------------------------------------
      if (!agent || !agentId) {
        deny('UNKNOWN_AGENT', 'executor.run requires an agent record');
        return result;
      }
      if (agent.status === 'dead') {
        deny('AGENT_DEAD', `agent ${agentId} is dead and may not trade`);
        return result;
      }
      if (!spec || typeof spec !== 'object') {
        deny('SPEC_INVALID', 'executor.run requires a compiled StrategySpec');
        return result;
      }
      // D9: the spec must carry its proof link. The Builder stores it as the
      // `proofRef` URL string (what the brake wall checks) with dated evidence in `proof`.
      const proofUrl = typeof spec.proofRef === 'string'
        ? spec.proofRef
        : spec.proofRef?.url ?? (typeof spec.proof?.url === 'string' ? spec.proof.url : null);
      if (typeof proofUrl !== 'string' || proofUrl.trim().length === 0) {
        deny('NO_PROOF', 'spec carries no dated proof reference (D9)');
        return result;
      }
      if (!mandate || typeof mandate !== 'object') {
        deny('BRAKE_DENIED', 'no Treasurer mandate for this agent');
        return result;
      }
      const sizeBudgetUsd = numberOrNull(mandate.sizeBudgetUsd);
      if (sizeBudgetUsd === null || sizeBudgetUsd <= 0) {
        deny('BRAKE_DENIED', 'mandate carries no positive sizeBudgetUsd');
        return result;
      }

      // --- mandate gates (entries only; exits remain permitted) -------------------
      let entriesBlocked = false;
      let entriesBlockedReason = '';
      const mandateExpiresMs = timestampOf(mandate.expiresAt);
      if (mandateExpiresMs !== null && atMs > mandateExpiresMs) {
        entriesBlocked = true;
        entriesBlockedReason = 'mandate expired';
        deny('MANDATE_EXPIRED', `Treasurer mandate expired at ${new Date(mandateExpiresMs).toISOString()}`);
      }
      if (mandate.allowExitOnly === true) {
        entriesBlocked = true;
        entriesBlockedReason = 'treasury halted: exit-only';
        deny('BRAKE_DENIED', 'treasury halt: mandate is exit-only');
      }
      const allowedSymbols = Array.isArray(mandate.allowedSymbols)
        ? mandate.allowedSymbols.map((s) => String(s).toUpperCase())
        : null;

      // --- own position book (never broker.getAccount) ----------------------------
      // Reconcile pending fills BEFORE reading the book so today's fills become positions.
      await reconcileBrokerFills();
      const book = ledger.book(agentId);
      const positions = positionsToMap(book?.positions);
      const openOrders = Array.isArray(book?.openOrders) ? book.openOrders : [];

      // --- quotes + prices --------------------------------------------------------
      const quoteMap = quotes && typeof quotes === 'object' ? quotes : {};
      const priceMap = {};
      for (const [symbol, rawQuote] of Object.entries(quoteMap)) {
        const quote = normalizeQuote(rawQuote, symbol);
        if (quote) priceMap[quote.symbol] = quote.last;
      }

      async function getQuote(symbol) {
        const fromArgs = normalizeQuote(quoteMap[symbol], symbol);
        if (fromArgs) {
          priceMap[symbol] = fromArgs.last;
          return fromArgs;
        }
        if (typeof broker.getLatestQuote === 'function') {
          try {
            const fetched = normalizeQuote(await broker.getLatestQuote(symbol), symbol);
            if (fetched) {
              priceMap[symbol] = fetched.last;
              return fetched;
            }
          } catch (error) {
            deny(error?.code ?? 'DATA_MISSING', `quote unavailable for ${symbol}: ${error?.message ?? error}`);
          }
        }
        return null;
      }

      const barCache = new Map();
      async function getBars(symbol) {
        const ticker = String(symbol).toUpperCase();
        if (barCache.has(ticker)) return barCache.get(ticker);
        let rows = null;
        if (Array.isArray(providedBars)) rows = providedBars;
        else if (providedBars && typeof providedBars === 'object') rows = providedBars[ticker];
        if (!rows && typeof broker.getBars === 'function') {
          try {
            const fetched = await broker.getBars({
              symbols: [ticker],
              timeframe,
              limit: MAX_BARS_FETCH,
            });
            rows = Array.isArray(fetched) ? fetched : fetched?.[ticker];
          } catch {
            rows = null;
          }
        }
        const normalized = normalizeBars(rows);
        barCache.set(ticker, normalized);
        return normalized;
      }

      // --- equity proxy used only for the absolute sizing cap ---------------------
      let equityUsd = null;
      if (Number.isFinite(mandate.equityUsd)) equityUsd = mandate.equityUsd;
      else if (Number.isFinite(agent.equityUsd)) equityUsd = agent.equityUsd;
      else if (typeof ledger.equity === 'function') {
        try {
          const view = ledger.equity(agentId, priceMap);
          if (Number.isFinite(view?.equityUsd)) equityUsd = view.equityUsd;
        } catch {
          /* fall through to a conservative proxy below */
        }
      }
      // Conservative last resort so the absolute cap can still be computed.
      if (!Number.isFinite(equityUsd)) equityUsd = sizeBudgetUsd;

      let snapshot = null;
      if (typeof ledger.snapshot === 'function') {
        try {
          snapshot = ledger.snapshot(agentId);
        } catch {
          snapshot = null;
        }
      }

      const ordersPlaced = () => result.orders.length;
      const cycleBudgetLeft = () => maxOrdersPerCycle - ordersPlaced();

      /**
       * Check the brakes, submit, and book the fill for one intended order.
       * @returns {Promise<object|null>} submitted order or null when denied/skipped
       */
      async function submitChecked({ symbol, side, qty, priceUsd, reason, kind, quote, positionsSnapshot }) {
        const ticker = String(symbol).toUpperCase();
        const orderQty = round4(qty);
        if (!(orderQty > 0)) {
          skip(ticker, 'qty_rounds_to_zero');
          return null;
        }
        const notionalUsd = round2(orderQty * priceUsd);
        const spreadBps = spreadBpsOf(quote);

        /** @type {object} */
        const brakeInput = {
          mode: config.mode,
          now: atMs,
          agentId,
          dayStats: dayStats ?? { dayKey: null, ordersCount: 0, startEquityUsd: equityUsd, pnlUsd: 0 },
          quote,
          order: { symbol: ticker, side, qty: orderQty, priceUsd, notionalUsd },
          equityUsd,
          positions: positionsSnapshot,
          mandate,
          spec,
          // D13 is enforced by the Treasurer (the only role allowed to read account
          // equity). The Executor must never obtain account equity, so it forwards a
          // mandate-provided figure when present and otherwise leaves the check to the
          // Treasurer; brakes skips D13 when these are not finite numbers.
          accountEquityUsd: Number.isFinite(mandate.accountEquityUsd) ? mandate.accountEquityUsd : null,
          allocatedEquityUsd: Number.isFinite(mandate.allocatedEquityUsd) ? mandate.allocatedEquityUsd : null,
          spreadBps,
          // D3 needs the broker's authoritative session state, not just a clock window: a
          // weekday window check would happily trade on a Saturday. The orchestrator reads
          // `/v2/clock` once per cycle and forwards it here.
          marketOpen,
          marketClock,
        };

        let decision;
        try {
          decision = await brakes.checkOrder(brakeInput);
        } catch (error) {
          deny(error?.code ?? 'BRAKE_DENIED', `brakes threw: ${error?.message ?? error}`, { symbol: ticker, side });
          skip(ticker, `brake_denied:${error?.code ?? 'BRAKE_DENIED'}`, { reason: error?.message ?? String(error) });
          return null;
        }
        if (!decision || decision.decision !== 'ALLOW') {
          deny(decision?.code ?? 'BRAKE_DENIED', decision?.reason ?? 'brakes denied the order', {
            symbol: ticker,
            side,
            rule: decision?.rule ?? null,
          });
          skip(ticker, `brake_denied:${decision?.code ?? 'BRAKE_DENIED'}`, { rule: decision?.rule ?? null });
          return null;
        }

        // Our own virtual book must be able to pay for a buy (no broker account read).
        if (side === 'buy' && snapshot && Number.isFinite(snapshot.cashUsd) && snapshot.cashUsd < notionalUsd) {
          deny('INSUFFICIENT_CASH', `virtual cash ${snapshot.cashUsd} < notional ${notionalUsd}`);
          skip(ticker, 'insufficient_cash');
          return null;
        }

        const seq = nextSeq(agentId);
        const clientOrderId = `atm:${agentId}:${spec.specId}:${seq}`;
        let order;
        try {
          order = await broker.submitOrder({
            symbol: ticker,
            side,
            qty: orderQty,
            type: 'market',
            clientOrderId,
            timeInForce: 'day',
          });
        } catch (error) {
          deny(error?.code ?? 'BROKER_ERROR', `broker rejected order: ${error?.message ?? error}`, {
            symbol: ticker,
            side,
            clientOrderId,
          });
          skip(ticker, `broker_error:${error?.code ?? 'BROKER_ERROR'}`);
          return null;
        }

        const resolvedOrder = await waitForFill(order);
        result.orders.push(resolvedOrder);
        let booked = { bookedQty: 0 };
        try {
          booked = await bookFilledOrder(resolvedOrder);
        } catch (error) {
          deny(error?.code ?? 'LEDGER_REJECTED', `fill could not be booked: ${error?.message ?? error}`, {
            symbol: ticker,
            orderId: resolvedOrder?.id ?? null,
          });
        }
        const bookedQty = booked.bookedQty ?? 0;
        result.actions.push({
          type: kind,
          symbol: ticker,
          side,
          qty: bookedQty,
          // A market order that is still `accepted` is not a denial: the next cycle's
          // reconciliation books the fill once the broker reports it as filled.
          reason: bookedQty > 0 ? reason : `${reason} (awaiting fill)`,
          orderId: resolvedOrder?.id ?? null,
          fillPriceUsd: bookedQty > 0 ? round2(booked.price) : null,
          pending: bookedQty === 0,
        });
        // Position book changed; keep the local map current for the rest of the cycle.
        if (bookedQty > 0) {
          if (side === 'buy') {
            const existing = positions.get(ticker);
            positions.set(ticker, {
              qty: round4((existing?.qty ?? 0) + bookedQty),
              avgPriceUsd: existing?.avgPriceUsd ?? booked.price,
              openedAt: existing?.openedAt ?? at,
            });
          } else {
            positions.delete(ticker);
          }
        }
        return resolvedOrder;
      }

      // =========================================================================
      // 1) EXITS FIRST (risk-reducing orders have priority over new entries)
      // =========================================================================
      for (const [symbol, position] of [...positions.entries()]) {
        if (cycleBudgetLeft() <= 0) {
          skip(symbol, 'max_orders_per_cycle');
          continue;
        }
        const quote = await getQuote(symbol);
        if (!quote) {
          deny('DATA_MISSING', `no quote for held position ${symbol}`);
          continue;
        }
        const bars = await getBars(symbol);
        const signal = computeSignal(spec.family, bars, spec.params);
        const openedAtMs = timestampOf(position.openedAt);
        const barsHeld = openedAtMs === null ? 0 : Math.floor((atMs - openedAtMs) / HOUR_MS);
        const stopPrice = position.avgPriceUsd * (1 - (spec.params?.stopPct ?? 0.02));
        const targetPrice = position.avgPriceUsd * (1 + (spec.params?.targetPct ?? 0.04));
        const maxHoldBars = spec.params?.maxHoldBars ?? 12;

        let exitReason = null;
        if (position.avgPriceUsd > 0 && quote.last <= stopPrice) exitReason = 'stop';
        else if (position.avgPriceUsd > 0 && quote.last >= targetPrice) exitReason = 'target';
        else if (barsHeld >= maxHoldBars) exitReason = 'max_hold';
        else if (signal.exit) exitReason = 'signal';
        if (!exitReason) {
          result.actions.push({
            type: 'hold',
            symbol,
            reason: signal.reason ?? 'within_bounds',
            barsHeld,
            z: signal.z,
          });
          continue;
        }
        await submitChecked({
          symbol,
          side: 'sell',
          qty: position.qty,
          priceUsd: round4(quote.bid ?? quote.last),
          reason: exitReason,
          kind: 'exit',
          quote,
          positionsSnapshot: Object.fromEntries(positions),
        });
      }

      // =========================================================================
      // 2) ENTRIES (long-only, one order per symbol per cycle)
      // =========================================================================
      const symbol = String(spec.symbol ?? '').toUpperCase();
      if (positions.has(symbol)) {
        // Already handled by the exit pass; nothing to do without a new signal.
        if (!result.actions.some((action) => action.symbol === symbol)) {
          result.actions.push({ type: 'hold', symbol, reason: 'in_position' });
        }
      } else if (openOrders.some((order) => String(order?.symbol ?? '').toUpperCase() === symbol)) {
        result.actions.push({ type: 'hold', symbol, reason: 'open_order_pending' });
      } else if (cycleBudgetLeft() <= 0) {
        skip(symbol, 'max_orders_per_cycle');
      } else if (entriesBlocked) {
        skip(symbol, `entries_blocked:${entriesBlockedReason}`);
      } else if (allowedSymbols && !allowedSymbols.includes(symbol)) {
        deny('INSTRUMENT_FORBIDDEN', `symbol ${symbol} is outside the mandate allowlist`, { symbol });
        skip(symbol, 'symbol_not_in_mandate');
      } else {
        const quote = await getQuote(symbol);
        if (!quote) {
          deny('DATA_MISSING', `no quote for ${symbol}`);
        } else {
          const bars = await getBars(symbol);
          const signal = computeSignal(spec.family, bars, spec.params);
          if (!signal.enter) {
            result.actions.push({
              type: 'hold',
              symbol,
              reason: signal.reason ?? 'no_signal',
              z: signal.z,
            });
          } else {
            const price = round4(quote.ask ?? quote.last);
            const caps = [(spec.params?.sizePct ?? 0.2) * sizeBudgetUsd];
            if (Number.isFinite(mandate.maxOrderNotionalUsd)) caps.push(mandate.maxOrderNotionalUsd);
            if (Number.isFinite(hardMaxNotionalUsd)) caps.push(hardMaxNotionalUsd);
            if (Number.isFinite(equityUsd)) caps.push(maxOrderPctOfEquity * equityUsd);
            if (snapshot && Number.isFinite(snapshot.cashUsd) && snapshot.cashUsd > 0) caps.push(snapshot.cashUsd);
            const notionalCap = Math.min(...caps.filter((cap) => Number.isFinite(cap) && cap > 0));
            let qty = round4(notionalCap / price);
            let notionalUsd = round2(qty * price);
            if (notionalUsd < minOrderNotionalUsd || qty <= 0) {
              // Try the minimum notional size before giving up, then honour the cap.
              const minQty = round4(minOrderNotionalUsd / price);
              if (minQty > 0 && round2(minQty * price) <= Math.min(...caps.filter((c) => Number.isFinite(c) && c > 0)) + 0.01) {
                qty = minQty;
                notionalUsd = round2(qty * price);
              } else {
                skip(symbol, 'below_min_notional', { attemptedNotionalUsd: notionalUsd, minOrderNotionalUsd });
                return result;
              }
            }
            await submitChecked({
              symbol,
              side: 'buy',
              qty,
              priceUsd: price,
              reason: signal.reason ?? 'signal',
              kind: 'entry',
              quote,
              positionsSnapshot: Object.fromEntries(positions),
            });
          }
        }
      }

      return result;
    },

    describe() {
      return {
        role: 'executor',
        maxOrdersPerCycle,
        minOrderNotionalUsd,
        maxOrderNotionalUsd: hardMaxNotionalUsd,
        maxOrderPctOfEquity,
        timeframe,
        readsAccountEquity: false,
      };
    },
  };
}

export default createExecutor;
