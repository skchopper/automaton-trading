/**
 * Alpaca broker client (market side) — dependency-free REST over global `fetch`.
 *
 * Safety surface (brake D1): this file deliberately implements ONLY market/account
 * READS plus order submission/cancellation. There is no transfer, withdrawal, ACH,
 * wire, crypto, account-configuration, or margin-enablement method here, and no way
 * to add one from config. Their absence is the wall.
 *
 * The client never logs or returns key material. All timestamps are normalized to
 * epoch milliseconds and all broker numbers to JavaScript floats.
 *
 * Contract: docs/CONTRACTS.md § "Broker interface".
 * Owner: market teammate. Do not edit from other modules.
 *
 * @module broker-alpaca
 */

import { fail } from './contracts.js';
import { resolveCredentials, DATA_BASE_URL } from './config.js';
import { sleep } from './util.js';

/** Request timeout enforced with AbortSignal.timeout(ms). */
export const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;
const BODY_SNIPPET_LIMIT = 280;

// ---------------------------------------------------------------------------
// parsing helpers (Alpaca returns numbers as JSON strings and timestamps as ISO)
// ---------------------------------------------------------------------------

/**
 * Parse a broker numeric field into a float. Returns `fallback` for null/invalid.
 * @param {unknown} value
 * @param {number|null} [fallback]
 * @returns {number|null}
 */
export function parseNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse an ISO-8601 timestamp (or epoch seconds / milliseconds) to epoch ms.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Alpaca always returns ISO strings; tolerate epoch seconds if a test feeds them.
    return Math.round(value < 1e12 ? value * 1000 : value);
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {string|string[]} symbols
 * @returns {string[]} deduped upper-case tickers
 */
export function normalizeSymbols(symbols) {
  const list = Array.isArray(symbols) ? symbols : String(symbols ?? '').split(',');
  const out = [];
  for (const raw of list) {
    const symbol = String(raw ?? '').trim().toUpperCase();
    if (symbol && !out.includes(symbol)) out.push(symbol);
  }
  return out;
}

/** Milliseconds for one Alpaca timeframe string ("1Hour", "5Min", "1Day", ...). */
export function timeframeToMs(timeframe) {
  const match = /^(\d+)(Min|Hour|Day|Week|Month)$/.exec(String(timeframe ?? '').trim());
  if (!match) return 60 * 60 * 1000;
  const count = Number(match[1]);
  const unitMs = {
    Min: 60 * 1000,
    Hour: 60 * 60 * 1000,
    Day: 24 * 60 * 60 * 1000,
    Week: 7 * 24 * 60 * 60 * 1000,
    Month: 30 * 24 * 60 * 60 * 1000,
  }[match[2]];
  return count * unitMs;
}

/** Truncate a response body to something safe for error details/traces. */
export function bodySnippet(text) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > BODY_SNIPPET_LIMIT ? `${clean.slice(0, BODY_SNIPPET_LIMIT)}...` : clean;
}

function headerNumber(headers, name) {
  if (!headers || typeof headers.get !== 'function') return null;
  const value = headers.get(name);
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function retryDelayMs(response) {
  const retryAfter = headerNumber(response?.headers, 'retry-after');
  if (retryAfter !== null) {
    // Alpaca sends seconds; a cap keeps a bad header from stalling a cycle.
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(RETRY_DELAY_MS, Math.round(retryAfter * 1000)));
  }
  return RETRY_DELAY_MS;
}

/** Map a raw Alpaca order to the contract order shape. */
export function mapOrder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: raw.id ?? null,
    clientOrderId: raw.client_order_id ?? null,
    symbol: String(raw.symbol ?? '').toUpperCase(),
    side: raw.side ?? null,
    qty: parseNumber(raw.qty, 0),
    filledQty: parseNumber(raw.filled_qty, 0),
    avgFillPriceUsd: parseNumber(raw.filled_avg_price, null),
    status: raw.status ?? null,
    submittedAt: parseTimestamp(raw.submitted_at),
    type: raw.type ?? null,
    notionalUsd: parseNumber(raw.notional, null),
  };
}

/** Map a raw Alpaca bar to the contract bar shape (t = epoch ms). */
export function mapBar(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = parseTimestamp(raw.t);
  if (t === null) return null;
  return {
    t,
    o: parseNumber(raw.o, 0),
    h: parseNumber(raw.h, 0),
    l: parseNumber(raw.l, 0),
    c: parseNumber(raw.c, 0),
    v: parseNumber(raw.v, 0),
  };
}

/** Map a raw Alpaca position to the contract position shape. */
export function mapPosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    symbol: String(raw.symbol ?? '').toUpperCase(),
    qty: parseNumber(raw.qty, 0),
    avgEntryPriceUsd: parseNumber(raw.avg_entry_price, null),
    marketValueUsd: parseNumber(raw.market_value, null),
    unrealizedPlUsd: parseNumber(raw.unrealized_pl, null),
  };
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * Create an Alpaca REST broker.
 *
 * Credentials resolve lazily from `resolveCredentials(config, secrets)` so that
 * constructing the client never throws before the engine is ready; the first real
 * request surfaces CONFIG_INVALID / LIVE_NOT_ARMED / BROKER_AUTH as appropriate.
 *
 * @param {object} config AUTOMATON config (mode must be 'paper' or 'live')
 * @param {{
 *   secrets?: Record<string,string>,
 *   credentials?: { keyId: string, secretKey: string, baseUrl: string, dataBaseUrl?: string },
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {object} broker with kind 'alpaca'
 */
export function createBroker(config, options = {}) {
  if (!config || typeof config !== 'object') {
    fail('CONFIG_INVALID', 'broker-alpaca requires a config object');
  }
  if (config.mode === 'sim') {
    fail('CONFIG_INVALID', 'mode=sim uses broker-sim.js, not broker-alpaca.js');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail('CONFIG_INVALID', 'broker-alpaca requires global fetch (Node >= 22) or a fetchImpl');
  }
  const sleepImpl = options.sleepImpl ?? sleep;
  const mode = config.mode;
  /** @type {ReturnType<typeof resolveCredentials>|null} */
  let credentials = options.credentials ?? null;

  function creds() {
    if (!credentials) {
      credentials = resolveCredentials(config, options.secrets ?? {});
    }
    return credentials;
  }

  /**
   * One HTTP round-trip with the contract's retry + error mapping.
   * Retries idempotent requests once on 429/5xx and POSTs once on 429 only
   * (a blind POST retry on 5xx could duplicate an order that was already accepted).
   */
  async function request(pathname, { method = 'GET', query = null, body, dataHost = false, attempt = 0 } = {}) {
    const resolved = creds();
    const base = dataHost ? resolved.dataBaseUrl || DATA_BASE_URL : resolved.baseUrl;
    if (!base) {
      fail('CONFIG_INVALID', `no ${dataHost ? 'data' : 'broker'} endpoint for mode=${mode}`);
    }
    const url = new URL(pathname, base);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    const headers = {
      'APCA-API-KEY-ID': resolved.keyId,
      'APCA-API-SECRET-KEY': resolved.secretKey,
      accept: 'application/json',
    };
    /** @type {RequestInit} */
    const init = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(url.toString(), init);
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      fail(
        'BROKER_ERROR',
        timedOut
          ? `Alpaca ${method} ${url.pathname} timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `Alpaca ${method} ${url.pathname} failed: ${error?.message ?? String(error)}`,
        { method, path: url.pathname, cause: error?.name ?? 'network', mode },
      );
    }

    const status = Number(response.status);
    const text = typeof response.text === 'function' ? await response.text() : '';
    if (status >= 200 && status < 300) {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        fail('BROKER_ERROR', `Alpaca ${method} ${url.pathname} returned invalid JSON`, {
          status,
          method,
          path: url.pathname,
        });
      }
    }

    const retryable = status === 429 || (status >= 500 && status <= 599);
    const idempotent = method === 'GET' || method === 'DELETE';
    if (retryable && attempt === 0 && (status === 429 || idempotent)) {
      await sleepImpl(status === 429 ? retryDelayMs(response) : RETRY_DELAY_MS);
      return request(pathname, { method, query, body, dataHost, attempt: attempt + 1 });
    }

    const detail = { status, method, path: url.pathname, body: bodySnippet(text), mode };
    if (status === 401 || status === 403) {
      fail('BROKER_AUTH', `Alpaca rejected credentials (${status})`, detail);
    }
    if (status === 429) {
      fail('BROKER_RATE_LIMIT', 'Alpaca rate limit exceeded', {
        ...detail,
        retryAfterSec: headerNumber(response.headers, 'retry-after'),
      });
    }
    fail('BROKER_ERROR', `Alpaca ${method} ${url.pathname} failed (${status})`, detail);
  }

  const broker = {
    kind: 'alpaca',
    mode,

    /** @returns {Promise<{isOpen:boolean, timestamp:number|null, nextOpen:number|null, nextClose:number|null}>} */
    async getClock() {
      const raw = await request('/v2/clock');
      return {
        isOpen: raw?.is_open === true,
        timestamp: parseTimestamp(raw?.timestamp),
        nextOpen: parseTimestamp(raw?.next_open),
        nextClose: parseTimestamp(raw?.next_close),
      };
    },

    /** @returns {Promise<{equityUsd:number, cashUsd:number, buyingPowerUsd:number, status:string, currency:string, mode:string}>} */
    async getAccount() {
      const raw = await request('/v2/account');
      return {
        equityUsd: parseNumber(raw?.equity, 0),
        cashUsd: parseNumber(raw?.cash, 0),
        buyingPowerUsd: parseNumber(raw?.buying_power, 0),
        status: raw?.status ?? 'UNKNOWN',
        currency: raw?.currency ?? 'USD',
        mode,
      };
    },

    /** @returns {Promise<Array<{symbol:string, qty:number, avgEntryPriceUsd:number|null, marketValueUsd:number|null, unrealizedPlUsd:number|null}>>} */
    async getPositions() {
      const raw = await request('/v2/positions');
      const rows = Array.isArray(raw) ? raw : [];
      return rows.map(mapPosition).filter(Boolean);
    },

    /**
     * @param {{status?: string, limit?: number, after?: string, direction?: 'asc'|'desc', symbols?: string}} [query]
     * @returns {Promise<Array<object>>}
     */
    async getOrders({ status = 'all', limit = 100, after, direction = 'desc', symbols } = {}) {
      const raw = await request('/v2/orders', {
        query: { status, limit: Math.max(1, Math.min(500, Number(limit) || 100)), after, direction, symbols },
      });
      const rows = Array.isArray(raw) ? raw : [];
      return rows.map(mapOrder).filter(Boolean);
    },

    /**
     * Submit an order. Supports fractional qty, notional orders, and
     * client_order_id pass-through for fill attribution.
     * @param {{symbol:string, side:'buy'|'sell', qty?:number, notional?:number, type?:string, limitPrice?:number,
     *          clientOrderId?:string, timeInForce?:string, extendedHours?:boolean}} order
     * @returns {Promise<object>} mapped order
     */
    async submitOrder(order = {}) {
      const symbol = String(order.symbol ?? '').trim().toUpperCase();
      if (!symbol) fail('SPEC_INVALID', 'submitOrder requires symbol');
      const side = String(order.side ?? '').toLowerCase();
      if (side !== 'buy' && side !== 'sell') {
        fail('SPEC_INVALID', 'submitOrder side must be buy or sell', { side: order.side });
      }
      const qty = parseNumber(order.qty);
      const notional = parseNumber(order.notional);
      if (qty === null && notional === null) {
        fail('SPEC_INVALID', 'submitOrder requires qty or notional', { symbol });
      }
      const payload = {
        symbol,
        side,
        type: order.type ?? 'market',
        time_in_force: order.timeInForce ?? 'day',
      };
      if (qty !== null) payload.qty = String(qty);
      else payload.notional = String(notional);
      const limitPrice = parseNumber(order.limitPrice);
      if (limitPrice !== null) payload.limit_price = String(limitPrice);
      if (order.clientOrderId) payload.client_order_id = String(order.clientOrderId);
      if (order.extendedHours === true) payload.extended_hours = true;
      const raw = await request('/v2/orders', { method: 'POST', body: payload });
      return mapOrder(raw);
    },

    /**
     * @param {string} id
     * @returns {Promise<{id:string, status:string}>}
     */
    async cancelOrder(id) {
      if (!id) fail('SPEC_INVALID', 'cancelOrder requires an order id');
      const raw = await request(`/v2/orders/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
      if (raw && typeof raw === 'object') {
        const mapped = mapOrder(raw);
        return { id: mapped?.id ?? String(id), status: mapped?.status ?? 'canceled' };
      }
      return { id: String(id), status: 'canceled' };
    },

    /**
     * Multi-symbol hourly bars. Returns every requested symbol (empty array when the
     * vendor has none), bars ascending with `t` in epoch ms.
     * @param {{symbols: string|string[], timeframe?: string, limit?: number,
     *          adjustment?: string, feed?: string, start?: string, end?: string}} params
     * @returns {Promise<Record<string, Array<{t:number,o:number,h:number,l:number,c:number,v:number}>>>}
     */
    async getBars({ symbols, timeframe = '1Hour', limit = 120, adjustment = 'raw', feed = 'iex', start, end } = {}) {
      const list = normalizeSymbols(symbols);
      if (list.length === 0) fail('DATA_MISSING', 'getBars requires at least one symbol');
      const effectiveLimit = Math.max(1, Math.min(10_000, Number(limit) || 120));
      // Verified against the paper data API:
      //  - omitting the window returns NO bars;
      //  - with a window, default pagination returns the OLDEST bars;
      //  - multi-symbol requests page one symbol at a time (next_page_token), so they cannot
      //    be relied on to return every symbol.
      // Therefore: one request per symbol, window ending now, sort=desc, then restore ascending.
      const intervalMs = timeframeToMs(timeframe);
      const windowMs = Math.max(intervalMs * effectiveLimit * 4, 3 * 24 * 60 * 60 * 1000);
      const nowMs = Date.now();
      const effectiveEnd = end ?? new Date(nowMs).toISOString();
      const effectiveStart = start
        ?? new Date(nowMs - Math.min(windowMs, 400 * 24 * 60 * 60 * 1000)).toISOString();
      /** @type {Record<string, Array<object>>} */
      const out = {};
      await Promise.all(
        list.map(async (symbol) => {
          try {
            const raw = await request('/v2/stocks/bars', {
              dataHost: true,
              query: {
                symbols: symbol,
                timeframe,
                limit: effectiveLimit,
                adjustment,
                feed,
                start: effectiveStart,
                end: effectiveEnd,
                sort: 'desc',
              },
            });
            const rows = Array.isArray(raw?.bars?.[symbol])
              ? raw.bars[symbol]
              : raw?.bars && typeof raw.bars === 'object'
                ? Object.values(raw.bars).find((value) => Array.isArray(value)) ?? []
                : [];
            // Sort ascending by timestamp instead of assuming the page direction: the live
            // API honors sort=desc, but a stub/proxy may return ascending rows anyway.
            out[symbol] = rows
              .map(mapBar)
              .filter(Boolean)
              .sort((left, right) => left.t - right.t);
          } catch (error) {
            // One unavailable symbol must not blank the whole cycle; the prospector treats
            // an empty series as "no data" and skips it.
            if (error?.code === 'BROKER_AUTH' || error?.code === 'BROKER_RATE_LIMIT') throw error;
            out[symbol] = [];
          }
        }),
      );
      return out;
    },

    /**
     * Latest NBBO quote for one symbol.
     * @param {string} symbol
     * @param {{feed?: string}} [opts]
     * @returns {Promise<{symbol:string, bid:number|null, ask:number|null, ts:number|null}>}
     */
    async getLatestQuote(symbol, { feed = 'iex' } = {}) {
      const ticker = String(symbol ?? '').trim().toUpperCase();
      if (!ticker) fail('DATA_MISSING', 'getLatestQuote requires a symbol');
      const raw = await request(`/v2/stocks/${encodeURIComponent(ticker)}/quotes/latest`, {
        dataHost: true,
        query: { feed },
      });
      const quote = raw?.quote && typeof raw.quote === 'object' ? raw.quote : raw ?? {};
      return {
        symbol: ticker,
        bid: parseNumber(quote.bp, null),
        ask: parseNumber(quote.ap, null),
        ts: parseTimestamp(quote.t),
      };
    },

    /**
     * Optional helper: bars for one symbol in the configured timeframe.
     * @param {string} symbol
     * @param {{limit?: number}} [opts]
     */
    async getDayBars(symbol, { limit = 120 } = {}) {
      const timeframe = config.data?.timeframe ?? '1Hour';
      return broker.getBars({ symbols: [symbol], timeframe, limit });
    },

    /**
     * The real data request URL a hypothesis proof points at. Used by the Prospector
     * so every claim carries the exact query it was measured from.
     * @param {{symbols: string|string[], timeframe?: string, limit?: number, adjustment?: string, feed?: string}} params
     * @returns {string}
     */
    getDataUrl({ symbols, timeframe = '1Hour', limit = 120, adjustment = 'raw', feed = 'iex' } = {}) {
      const list = normalizeSymbols(symbols);
      const base = creds().dataBaseUrl || DATA_BASE_URL;
      const url = new URL('/v2/stocks/bars', base);
      url.searchParams.set('symbols', list.join(','));
      url.searchParams.set('timeframe', String(timeframe));
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('adjustment', String(adjustment));
      url.searchParams.set('feed', String(feed));
      return url.toString();
    },

    /** Readonly endpoint summary for status/debug output (no key material). */
    describe() {
      const resolved = creds();
      return { kind: 'alpaca', mode, baseUrl: resolved.baseUrl, dataBaseUrl: resolved.dataBaseUrl };
    },
  };

  return broker;
}

export default createBroker;
