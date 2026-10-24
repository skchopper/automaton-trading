/**
 * brakes.js — the hard-denial wall in front of the broker client.
 *
 * A prompt is a request; a hook is a wall. Every order the EXECUTOR wants to place is
 * passed through `checkOrder()` first, and the Reaper's liquidations are the only path
 * that bypasses it (the Reaper is a separate process whose job is to close risk).
 * None of these rules live in data an agent can write.
 *
 * Signal shape: `{ decision: 'ALLOW'|'DENY', code, rule, reason }` where `code` is the
 * stable BRAKE_CODES value (contracts.js), `rule` is the human rule text, and `brakeId`
 * ("D3", ...) is included so the UI can link a denial to the catalogue.
 *
 * Owned by mortality-core. Contract: docs/CONTRACTS.md ("Mortality modules").
 */

import { AutomatonError, BRAKES, BRAKE_BY_ID, MODES } from './contracts.js';
import { DAY_MS, fileExists, minutesSinceMidnight, parseHhMm, round2, round4, SYSTEM_CLOCK } from './util.js';
import { liveArmed, statePaths } from './config.js';

const EPSILON = 1e-9;
const OCC_OPTION_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const FORBIDDEN_ORDER_SIDES = Object.freeze(['transfer', 'withdraw', 'withdrawal', 'deposit', 'ach', 'wire', 'journal']);

function resolveClock(clock) {
  return clock && typeof clock.now === 'function' ? clock : SYSTEM_CLOCK;
}

function toMs(now, clock) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (typeof now === 'string') {
    const parsed = Date.parse(now);
    if (Number.isFinite(parsed)) return parsed;
  }
  return clock.now();
}

/** Normalise a position input (broker array or ledger book map) into a symbol map. */
function normalisePositions(positions) {
  /** @type {Record<string, {qty: number, valueUsd: number}>} */
  const map = {};
  if (Array.isArray(positions)) {
    for (const raw of positions) {
      if (!raw || typeof raw !== 'object') continue;
      const symbol = String(raw.symbol ?? '').toUpperCase();
      if (symbol === '') continue;
      const qty = Number(raw.qty) || 0;
      const marketValue = Number(raw.marketValueUsd ?? raw.market_value ?? NaN);
      const avg = Number(raw.avgEntryPriceUsd ?? raw.avg_entry_price ?? 0);
      const valueUsd = Number.isFinite(marketValue) ? marketValue : qty * avg;
      map[symbol] = { qty: (map[symbol]?.qty ?? 0) + qty, valueUsd: (map[symbol]?.valueUsd ?? 0) + valueUsd };
    }
  } else if (positions && typeof positions === 'object') {
    for (const [key, raw] of Object.entries(positions)) {
      if (!raw || typeof raw !== 'object') continue;
      const symbol = String(raw.symbol ?? key).toUpperCase();
      const qty = Number(raw.qty) || 0;
      const marketValue = Number(raw.marketValueUsd ?? NaN);
      const avg = Number(raw.avgPriceUsd ?? raw.avgEntryPriceUsd ?? 0);
      const valueUsd = Number.isFinite(marketValue) ? marketValue : qty * avg;
      map[symbol] = { qty: (map[symbol]?.qty ?? 0) + qty, valueUsd: (map[symbol]?.valueUsd ?? 0) + valueUsd };
    }
  }
  return map;
}

function midPrice(quote) {
  if (!quote || typeof quote !== 'object') return null;
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) return (bid + ask) / 2;
  if (Number.isFinite(ask) && ask > 0) return ask;
  if (Number.isFinite(bid) && bid > 0) return bid;
  return null;
}

function spreadFromQuote(quote) {
  if (!quote || typeof quote !== 'object') return null;
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return round4(((ask - bid) / mid) * 10000);
}

/** First finite number from the argument list (ignoring null/undefined). */
function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Create the brakes wall.
 *
 * @param {{ config: object, paths?: object, clock?: object }} options
 */
export function createBrakes({ config, paths, clock } = {}) {
  if (!config || typeof config !== 'object') {
    throw new AutomatonError('CONFIG_INVALID', 'createBrakes requires a config object', {});
  }
  const risk = config.risk ?? {};
  const currentClock = resolveClock(clock);
  const resolved = { ...statePaths(config), ...(paths ?? {}) };
  const killSwitchPath = resolved.killSwitch;
  const liveArmedPath = resolved.liveArmed;

  /** Throw KILL_SWITCH when the operator's kill-switch file exists (D11). */
  function assertKillSwitchClear() {
    if (fileExists(killSwitchPath)) {
      throw new AutomatonError('KILL_SWITCH', `kill switch armed: remove ${killSwitchPath} to trade`, {
        path: killSwitchPath,
      });
    }
  }

  function isLiveArmed() {
    return liveArmed(config);
  }

  function killSwitchPresent() {
    return fileExists(killSwitchPath);
  }

  /**
   * The wall. Returns ALLOW or DENY; never throws for a policy outcome.
   *
   * @param {{
   *   mode?: string, now?: number|string, agentId?: string,
   *   dayStats?: { dayKey?: string, ordersCount?: number, startEquityUsd?: number,
   *                pnlUsd?: number, ordersThisCycle?: number, symbolsThisCycle?: string[] },
   *   quote?: { symbol?: string, bid?: number, ask?: number, ts?: number },
   *   order: { symbol?: string, side?: string, qty?: number, priceUsd?: number,
   *            notionalUsd?: number, type?: string, assetClass?: string, margin?: boolean,
   *            extendedHours?: boolean, slippageBps?: number, expectedSlippageBps?: number },
   *   equityUsd?: number, positions?: object|object[], mandate?: object, spec?: object,
   *   accountEquityUsd?: number, allocatedEquityUsd?: number, spreadBps?: number,
   *   marketOpen?: boolean, halted?: boolean, marketClock?: { isOpen?: boolean },
   * }} input
   * @returns {{ decision: 'ALLOW'|'DENY', code: string|null, rule: string|null,
   *            brakeId: string|null, reason: string }}
   */
  function checkOrder(input = {}) {
    const params = input && typeof input === 'object' ? input : {};
    const nowMs = toMs(params.now, currentClock);
    const order = params.order;
    const dayStats = params.dayStats && typeof params.dayStats === 'object' ? params.dayStats : {};
    const mandate = params.mandate && typeof params.mandate === 'object' ? params.mandate : null;
    const positions = normalisePositions(params.positions);

    const deny = (brakeId, reason, extra = {}) => {
      const brake = BRAKE_BY_ID[brakeId];
      return {
        decision: 'DENY',
        code: brake?.code ?? 'BRAKE_DENIED',
        rule: brake?.rule ?? null,
        brakeId: brake?.id ?? null,
        reason,
        ...extra,
      };
    };
    const denyWithCode = (brakeId, code, reason, extra = {}) => {
      const brake = BRAKE_BY_ID[brakeId];
      return {
        decision: 'DENY',
        code,
        rule: brake?.rule ?? null,
        brakeId: brake?.id ?? null,
        reason,
        ...extra,
      };
    };
    const allow = (reason = 'all brakes passed') => ({
      decision: 'ALLOW',
      code: null,
      rule: null,
      brakeId: null,
      reason,
    });

    // ---- D11: operator kill switch, checked before anything else ----------------
    if (killSwitchPresent()) {
      return deny('D11', `kill switch armed: ${killSwitchPath} exists; every order is denied`);
    }

    if (!order || typeof order !== 'object') {
      return denyWithCode('D1', 'BRAKE_DENIED', 'order is malformed: a buy/sell order object is required');
    }

    const symbol = String(order.symbol ?? '').toUpperCase();
    const side = String(order.side ?? '').toLowerCase();

    // ---- D1: only buy/sell orders exist; no transfers/withdrawals/ACH/crypto -----
    if (FORBIDDEN_ORDER_SIDES.includes(side)) {
      return deny('D1', `"${side}" is not a trade: transfers, withdrawals, ACH, wires and account changes are not implemented`);
    }
    if (!['buy', 'sell'].includes(side)) {
      return deny('D1', `order side must be "buy" or "sell" (got "${order.side ?? ''}")`);
    }
    if (String(order.assetClass ?? '').toLowerCase() === 'crypto' || symbol.includes('/')) {
      return deny('D1', 'crypto orders are not implemented');
    }

    // ---- D2: no margin, leverage, shorting, or options --------------------------
    if (malformedSymbol(symbol)) {
      return deny('D2', 'symbol does not look like an equity ticker');
    }
    const assetClass = String(order.assetClass ?? '').toLowerCase();
    if (assetClass === 'option' || assetClass === 'options' || OCC_OPTION_SYMBOL.test(symbol)) {
      if (risk.allowOptions !== true) return deny('D2', 'options are disabled (D2)');
    }
    if ((order.margin === true || order.leverage === true) && risk.allowMargin !== true) {
      return deny('D2', 'margin/leverage is disabled (D2)');
    }
    if (side === 'sell' && risk.allowShort !== true) {
      const heldQty = positions[symbol]?.qty ?? 0;
      const sellQty = Number(order.qty);
      if (Number.isFinite(sellQty) && sellQty - heldQty > EPSILON) {
        return deny('D2', `short selling is disabled: selling ${sellQty} ${symbol || '?'} but only ${heldQty} held`);
      }
    }

    // ---- D8: live mode must be explicitly armed; mode must match config ---------
    const effectiveMode = params.mode ?? config.mode;
    if (!MODES.includes(effectiveMode)) {
      return denyWithCode('D8', 'MODE_FORBIDDEN', `unknown mode "${effectiveMode}"`);
    }
    if (effectiveMode !== config.mode) {
      return denyWithCode(
        'D8',
        'MODE_FORBIDDEN',
        `order mode "${effectiveMode}" does not match configured mode "${config.mode}"`,
      );
    }
    if (effectiveMode === 'live' && !liveArmed(config)) {
      return deny('D8', 'live mode is not armed: needs mode=live, allowLive=true, and the LIVE_ARMED marker file');
    }

    // ---- D3: market window / session / extended hours ---------------------------
    if (order.extendedHours === true && risk.extendedHours !== true) {
      return deny('D3', 'extended-hours trading is disabled');
    }
    const marketOpen = params.marketOpen ?? params.marketClock?.isOpen ?? null;
    if (marketOpen === false) {
      return deny('D3', 'market is closed (broker clock)');
    }
    if (effectiveMode !== 'sim') {
      const window = Array.isArray(risk.sessionWindow) ? risk.sessionWindow : [];
      const openMinutes = parseHhMm(window[0]);
      const closeMinutes = parseHhMm(window[1]);
      const minutes = minutesSinceMidnight(nowMs, config.timeZone ?? 'America/New_York');
      if (openMinutes !== null && closeMinutes !== null) {
        if (minutes < openMinutes || minutes > closeMinutes) {
          return deny(
            'D3',
            `outside the configured session window ${window[0]}-${window[1]} (now ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ${config.timeZone ?? 'America/New_York'})`,
          );
        }
      }
    }

    // ---- D4: instrument whitelist, price/notional, spread, slippage ------------
    const whitelist = new Set((Array.isArray(config.symbols) ? config.symbols : []).map((item) => String(item).toUpperCase()));
    if (symbol === '' || !whitelist.has(symbol)) {
      return deny('D4', `symbol "${symbol || '(empty)'}" is not in the tradable whitelist`);
    }
    if (Array.isArray(mandate?.allowedSymbols) && mandate.allowedSymbols.length > 0) {
      const allowed = new Set(mandate.allowedSymbols.map((item) => String(item).toUpperCase()));
      if (!allowed.has(symbol)) return deny('D4', `symbol "${symbol}" is outside this mandate's allowed symbols`);
    }

    const quotePrice = midPrice(params.quote);
    const orderPrice = firstFinite(order.priceUsd, quotePrice);
    if (orderPrice === null || orderPrice <= 0) {
      return denyWithCode('D4', 'DATA_MISSING', `no price available for ${symbol}; refusing to size the order`);
    }
    if (orderPrice < Number(risk.minPriceUsd ?? 0)) {
      return deny('D4', `price ${orderPrice} is below the minimum tradable price ${risk.minPriceUsd}`);
    }

    const orderQty = Number(order.qty);
    const notionalUsd = firstFinite(order.notionalUsd, Number.isFinite(orderQty) ? orderQty * orderPrice : null);
    if (notionalUsd === null || notionalUsd <= 0) {
      return denyWithCode('D4', 'BRAKE_DENIED', `order notional is unavailable for ${symbol}`);
    }
    if (side === 'buy' && notionalUsd < Number(risk.minOrderNotionalUsd ?? 0)) {
      return deny('D4', `order notional ${notionalUsd.toFixed(2)} is below the minimum ${risk.minOrderNotionalUsd}`);
    }

    const spreadBps = firstFinite(params.spreadBps, spreadFromQuote(params.quote));
    if (spreadBps !== null && spreadBps > Number(risk.maxSpreadBps ?? Infinity)) {
      return deny('D4', `spread ${spreadBps}bps exceeds the maximum ${risk.maxSpreadBps}bps`);
    }
    const slippageBps = firstFinite(order.slippageBps, order.expectedSlippageBps, params.slippageBps);
    if (slippageBps !== null && slippageBps > Number(risk.maxSlippageBps ?? Infinity)) {
      return deny('D4', `slippage ${slippageBps}bps exceeds the maximum ${risk.maxSlippageBps}bps`);
    }

    // ---- D9: no trade without a Builder spec carrying dated proof --------------
    const spec = params.spec;
    if (!spec || typeof spec !== 'object') {
      return deny('D9', 'no strategy spec: a Builder spec with dated proof is required before any order');
    }
    // The Builder emits `proofRef` as the URL string; accept an object form too so the
    // wall does not depend on how a spec was serialized.
    const rawProofRef =
      spec.proofRef && typeof spec.proofRef === 'object'
        ? spec.proofRef.url ?? spec.proofRef.proofRef ?? spec.proofRef.href
        : spec.proofRef ?? spec.proof?.url ?? spec.proof?.proofRef;
    if (typeof rawProofRef !== 'string' || rawProofRef.trim() === '') {
      return deny('D9', 'spec carries no proof reference (a link or nothing)');
    }
    const observedAtRaw = spec.proof?.observedAt ?? spec.proof?.observed_at ?? spec.proofObservedAt;
    const observedAtMs = typeof observedAtRaw === 'string' ? Date.parse(observedAtRaw) : Number(observedAtRaw);
    if (Number.isFinite(observedAtMs)) {
      const maxProofAgeDays = Number(config.data?.maxProofAgeDays ?? 7);
      if (nowMs - observedAtMs > maxProofAgeDays * DAY_MS) {
        return denyWithCode(
          'D9',
          'PROOF_STALE',
          `proof observed at ${new Date(observedAtMs).toISOString()} is older than ${maxProofAgeDays} days`,
        );
      }
    }

    // ---- D7 at order time: no mandate (dead/halted) => no new exposure ----------
    if (!mandate) {
      return denyWithCode('D7', 'BRAKE_DENIED', 'no Treasurer mandate: the agent is dead/halted or has not been sized');
    }
    if (typeof mandate.agentId === 'string' && typeof params.agentId === 'string' && mandate.agentId !== params.agentId) {
      return denyWithCode('D7', 'BRAKE_DENIED', `mandate belongs to "${mandate.agentId}", not "${params.agentId}"`);
    }
    if (typeof mandate.expiresAt === 'string') {
      const expiresMs = Date.parse(mandate.expiresAt);
      if (Number.isFinite(expiresMs) && nowMs > expiresMs) {
        return denyWithCode('D7', 'BRAKE_DENIED', 'mandate expired: a new mandate is required this cycle');
      }
    }
    const halted = params.halted === true || mandate.allowExitOnly === true;
    if (halted && side === 'buy') {
      return denyWithCode('D7', 'BRAKE_DENIED', 'treasury is halted: exit-only, new exposure is denied');
    }

    // ---- D5: mandate size caps, position concentration, open positions ---------
    const equityUsd = Number(params.equityUsd);
    if (!Number.isFinite(equityUsd) || equityUsd <= 0) {
      return denyWithCode('D5', 'BRAKE_DENIED', 'agent equity is unavailable; cannot size the order');
    }
    const caps = [
      Number(risk.maxOrderNotionalUsd),
      Number(risk.maxOrderPctOfEquity) * equityUsd,
      Number(mandate.maxOrderNotionalUsd),
      Number(mandate.sizeBudgetUsd),
    ].filter((cap) => Number.isFinite(cap) && cap > 0);
    if (caps.length > 0) {
      const cap = Math.min(...caps);
      if (notionalUsd > cap + EPSILON) {
        return deny('D5', `order notional ${round2(notionalUsd)} exceeds the mandate/risk cap ${round2(cap)}`);
      }
    }
    const held = positions[symbol] ?? { qty: 0, valueUsd: 0 };
    if (side === 'buy') {
      const projected = (Number(held.valueUsd) || 0) + notionalUsd;
      const maxPositionValue = Number(risk.maxPositionPct ?? 0) * equityUsd;
      if (projected > maxPositionValue + EPSILON) {
        return deny(
          'D5',
          `position in ${symbol} would be ${round2(projected)} (${round4(projected / equityUsd)} of equity), above the ${risk.maxPositionPct} cap`,
        );
      }
      if (!(held.qty > 0)) {
        const openCount = Object.values(positions).filter((position) => (position.qty ?? 0) > 0).length;
        if (openCount >= Number(risk.maxOpenPositions ?? Infinity)) {
          return deny('D5', `already holding ${openCount} positions; maxOpenPositions is ${risk.maxOpenPositions}`);
        }
      }
    }

    // ---- D6: daily order cap and one order per symbol per cycle ----------------
    const ordersCount = Number(dayStats.ordersCount) || 0;
    if (ordersCount >= Number(risk.maxDailyOrders)) {
      return deny('D6', `daily order cap reached (${ordersCount}/${risk.maxDailyOrders})`);
    }
    const remaining = Number(mandate.maxDailyOrdersRemaining);
    if (Number.isFinite(remaining) && remaining <= 0) {
      return deny('D6', 'mandate has no daily orders remaining');
    }
    if (Array.isArray(dayStats.symbolsThisCycle)) {
      const symbolsThisCycle = new Set(dayStats.symbolsThisCycle.map((item) => String(item).toUpperCase()));
      if (symbolsThisCycle.has(symbol)) {
        return deny('D6', `already ordered ${symbol} this cycle (one order per symbol per cycle)`);
      }
    }
    const ordersThisCycle = Number(dayStats.ordersThisCycle);
    if (Number.isFinite(ordersThisCycle) && ordersThisCycle >= Number(risk.maxOrdersPerCycle)) {
      return deny('D6', `cycle order cap reached (${ordersThisCycle}/${risk.maxOrdersPerCycle})`);
    }

    // ---- D13: allocated capital can never exceed allocationCapPct of the account --
    // The Executor falls back to agent equity when a mandate carries no account-level
    // numbers; that degenerate triple is not evidence of over-allocation, so D13 is
    // enforced only when the inputs actually distinguish account vs allocated capital.
    if (side === 'buy') {
      const accountEquityUsd = Number(params.accountEquityUsd);
      const allocatedEquityUsd = Number(params.allocatedEquityUsd);
      const allocationsKnown = !(
        Number.isFinite(accountEquityUsd) &&
        accountEquityUsd === equityUsd &&
        allocatedEquityUsd === equityUsd
      );
      if (Number.isFinite(accountEquityUsd) && accountEquityUsd > 0 && Number.isFinite(allocatedEquityUsd) && allocationsKnown) {
        const allocationCap = Number(config.account?.allocationCapPct ?? 0) * accountEquityUsd;
        if (allocatedEquityUsd + notionalUsd > allocationCap + EPSILON) {
          return deny(
            'D13',
            `allocation cap reached: ${round2(allocatedEquityUsd)} allocated + ${round2(notionalUsd)} order > ${round2(allocationCap)} cap (${config.account?.allocationCapPct} of ${round2(accountEquityUsd)})`,
          );
        }
      }
    }

    return allow();
  }

  /** The documented brake catalogue, annotated with the enforcing code site. */
  function describe() {
    return BRAKES.map((brake) => ({
      id: brake.id,
      code: brake.code,
      rule: brake.rule,
      description: brake.rule,
      enforcement: brake.enforcement,
    }));
  }

  return {
    checkOrder,
    assertKillSwitchClear,
    isLiveArmed,
    killSwitchPresent,
    /** Alias used by the Lead's orchestrator/engine status views. */
    isKillSwitchActive: killSwitchPresent,
    describe,
    /** @returns {string} absolute path of the operator kill-switch file */
    get killSwitchPath() {
      return killSwitchPath;
    },
    /** @returns {string} absolute path of the LIVE_ARMED marker file */
    get liveArmedPath() {
      return liveArmedPath;
    },
  };
}

/** Guard against options/crypto-style symbols sneaking into the equity path. */
function malformedSymbol(symbol) {
  if (typeof symbol !== 'string' || symbol === '') return true;
  if (symbol.length > 12) return true;
  if (symbol.includes('/') || symbol.includes(':')) return true;
  return false;
}
