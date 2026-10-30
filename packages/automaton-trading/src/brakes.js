/**
 * brakes.js — the hard-denial wall in front of the broker client (v3.0).
 *
 * A prompt is a request; a hook is a wall. Every order the EXECUTOR wants to place is
 * passed through `checkOrder()` first, and the Reaper's liquidations are the only path
 * that bypasses it (the Reaper is a separate process whose job is to close risk).
 *
 * v3.0 replaced the old blanket D2 denial ("no margin/short/options") with an
 * instrument-permission gate and four new hard rules:
 *   D15 short sale      — shorting enabled, asset shortable+marginable, whole shares,
 *                         mandate short notional cap.
 *   D16 options         — explicit permission + allowed defined-risk structure, OCC symbol,
 *                         integer contracts ≤ caps, premium ≤ caps, DTE window, covered
 *                         calls need ≥100 long shares, spreads exactly two legs same
 *                         underlying/expiry/opposite sides with defined max loss;
 *                         NAKED SHORT OPTIONS ARE ALWAYS DENIED.
 *   D17 margin          — debt after the order ≤ maxMarginUsd / maxMarginPctEquity × equity.
 *   D18 expiry guard    — opening orders below minDTE denied; sell-to-close always allowed.
 *
 * Wall order: D11 kill switch → mode/live → D3 market → D2/D15/D16/D18/D17 instrument gates
 * → D4 whitelist/price/spread → D9 proof/spec → D5 sizing → D6 rate → D13 allocation.
 *
 * Signal shape: `{ decision: 'ALLOW'|'DENY', code, rule, reason }`; `code` is a
 * contracts.js BRAKE_CODES value (D1-D18) or one of the v3 stable codes below; `brakeId`
 * links the denial to the catalogue.
 *
 * Owned by mortality-core. Contract: docs/INSTRUMENTS.md + docs/CONTRACTS.md.
 */

import { AutomatonError, BRAKES, BRAKE_BY_ID, MODES } from './contracts.js';
import {
  isOccOptionSymbol,
  normaliseAssetClass,
  optionDaysToExpiry,
  OPTION_MULTIPLIER,
  parseOccSymbol,
} from './ledger.js';
import { DAY_MS, fileExists, minutesSinceMidnight, parseHhMm, round2, round4, SYSTEM_CLOCK } from './util.js';
import { liveArmed, statePaths } from './config.js';

const EPSILON = 1e-9;
const OCC_OPTION_SYMBOL = /^[A-Z][A-Z0-9]{0,5}\d{6}[CP]\d{8}$/;
const EQUITY_SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const FORBIDDEN_ORDER_SIDES = Object.freeze(['transfer', 'withdraw', 'withdrawal', 'deposit', 'ach', 'wire', 'journal']);
const KNOWN_ASSET_CLASSES = Object.freeze([
  '',
  'equity',
  'stock',
  'us_equity',
  'us_stock',
  'option',
  'options',
  'us_option',
  'option_contract',
  'us_option_contract',
]);

/** Stable v3 brake codes (also present in contracts.js after the v3 catalogue update). */
export const SHORT_FORBIDDEN = BRAKE_BY_ID.D15?.code ?? 'SHORT_FORBIDDEN';
export const OPTION_FORBIDDEN = BRAKE_BY_ID.D16?.code ?? 'OPTION_FORBIDDEN';
export const MARGIN_LIMIT = BRAKE_BY_ID.D17?.code ?? 'MARGIN_LIMIT';
export const EXPIRY_GUARD = BRAKE_BY_ID.D18?.code ?? 'EXPIRY_GUARD';

/** Documented option structures (v1). */
export const OPTION_STRUCTURES = Object.freeze([
  'long_call',
  'long_put',
  'covered_call',
  'call_credit_spread',
  'put_credit_spread',
  'bull_call_spread',
  'bear_put_spread',
]);

/** The v3 brakes D15-D18 (defined in contracts.js; kept exported for convenience). */
export const EXTENDED_BRAKES = Object.freeze(BRAKES.filter((brake) => ['D15', 'D16', 'D17', 'D18'].includes(brake.id)));

/** The full D1-D18 catalogue (contracts.js is the source of truth). */
export const BRAKE_CATALOGUE = Object.freeze([...BRAKES]);

const BRAKE_V3_BY_ID = Object.freeze(Object.fromEntries(BRAKE_CATALOGUE.map((brake) => [brake.id, brake])));

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

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

function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function positiveOrInfinity(value, fallback = Infinity) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function capFrom(...values) {
  let cap = Infinity;
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) cap = Math.min(cap, n);
  }
  return cap;
}

/**
 * Normalised `config.instruments` view with safe defaults. Missing config = v2 rules
 * (margin/short/options off), so legacy configurations keep the original wall.
 */
export function instrumentConfig(config) {
  const raw = config?.instruments ?? {};
  const enabled = raw.enabled !== false;
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    enabled,
    allowMargin: enabled && raw.allowMargin === true,
    maxMarginPctEquity: num(raw.maxMarginPctEquity, 1),
    maxMarginUsd: positiveOrInfinity(raw.maxMarginUsd ?? 0, Infinity),
    allowShort: enabled && raw.allowShort === true,
    maxShortPctEquity: num(raw.maxShortPctEquity, 1),
    maxShortNotionalUsd: positiveOrInfinity(raw.maxShortNotionalUsd ?? 0, Infinity),
    shortableOnly: raw.shortableOnly !== false,
    allowOptions: enabled && raw.allowOptions === true,
    allowCoveredCalls: raw.allowCoveredCalls !== false,
    allowSpreads: raw.allowSpreads !== false,
    maxOptionPremiumPctEquity: num(raw.maxOptionPremiumPctEquity, 0.25),
    maxOptionPremiumUsd: positiveOrInfinity(raw.maxOptionPremiumUsd ?? 0, Infinity),
    maxContracts: Number.isFinite(Number(raw.maxContracts)) && Number(raw.maxContracts) > 0
      ? Math.floor(Number(raw.maxContracts))
      : 0,
    minDTE: num(raw.minDTE, 2),
    maxDTE: num(raw.maxDTE, 14),
    autoCloseDTE: num(raw.autoCloseDTE, 1),
    allowNakedShortOptions: false, // never, whatever the config says
    optionDataFeed: raw.optionDataFeed ?? 'indicative',
  };
}

/** Mandate instrument permissions; a legacy mandate (no instruments) = long stock only. */
function mandateInstruments(mandate) {
  const raw = mandate?.instruments;
  if (!raw || typeof raw !== 'object') {
    return {
      legacy: true,
      longStock: true,
      shortStock: false,
      longOptions: false,
      shortOptions: false,
      coveredCalls: false,
      spreads: false,
      margin: false,
      allowedStructures: [],
      maxShortNotionalUsd: Infinity,
      maxOptionPremiumUsd: Infinity,
      maxContracts: Infinity,
      maxMarginUsd: Infinity,
    };
  }
  return {
    legacy: false,
    longStock: raw.longStock !== false,
    shortStock: raw.shortStock === true,
    longOptions: raw.longOptions === true,
    shortOptions: raw.shortOptions === true,
    coveredCalls: raw.coveredCalls === true,
    spreads: raw.spreads === true,
    margin: raw.margin === true,
    allowedStructures: Array.isArray(raw.allowedStructures)
      ? raw.allowedStructures.map((structure) => String(structure).toLowerCase())
      : [],
    maxShortNotionalUsd: positiveOrInfinity(raw.maxShortNotionalUsd, Infinity),
    maxOptionPremiumUsd: positiveOrInfinity(raw.maxOptionPremiumUsd, Infinity),
    maxContracts: Number.isFinite(Number(raw.maxContracts)) ? Math.max(0, Math.floor(Number(raw.maxContracts))) : Infinity,
    maxMarginUsd: positiveOrInfinity(raw.maxMarginUsd, Infinity),
  };
}

/** Normalise a position input (broker array or ledger book map) into a symbol map. */
function normalisePositions(positions) {
  /** @type {Record<string, object>} */
  const map = {};
  const ingest = (raw, symbolKey) => {
    if (!raw || typeof raw !== 'object') return;
    const symbol = String(raw.symbol ?? symbolKey ?? '').toUpperCase();
    if (symbol === '') return;
    const rawQty = Number(raw.qtySigned ?? raw.qty ?? 0) || 0;
    const assetClass = normaliseAssetClass(raw.assetClass, symbol);
    const multiplier = Number.isFinite(Number(raw.multiplier))
      ? Number(raw.multiplier)
      : assetClass === 'us_option'
        ? OPTION_MULTIPLIER
        : 1;
    const marketValue = Number(raw.marketValueUsd ?? raw.market_value ?? NaN);
    const avg = Number(raw.avgPriceUsd ?? raw.avgEntryPriceUsd ?? raw.avg_entry_price ?? 0) || 0;
    const valueUsd = Number.isFinite(marketValue) ? marketValue : rawQty * avg * multiplier;
    const previous = map[symbol];
    if (previous) {
      previous.qty += rawQty;
      previous.qtySigned += rawQty;
      previous.valueUsd += valueUsd;
      previous.marketValueUsd = (Number(previous.marketValueUsd) || 0) + (Number.isFinite(marketValue) ? marketValue : 0);
    } else {
      map[symbol] = {
        symbol,
        qty: rawQty,
        qtySigned: rawQty,
        assetClass,
        multiplier,
        avgPriceUsd: avg,
        marketValueUsd: Number.isFinite(marketValue) ? marketValue : valueUsd,
        valueUsd,
        option: raw.option ?? parseOccSymbol(symbol),
        groupId: raw.groupId ?? raw.option?.groupId ?? null,
      };
    }
  };
  if (Array.isArray(positions)) {
    for (const raw of positions) ingest(raw, null);
  } else if (positions && typeof positions === 'object') {
    for (const [key, raw] of Object.entries(positions)) ingest(raw, key);
  }
  return map;
}

function positionQty(positions, symbol) {
  return Number(positions[String(symbol ?? '').toUpperCase()]?.qtySigned ?? positions[String(symbol ?? '').toUpperCase()]?.qty) || 0;
}

function longShares(positions, underlying) {
  const position = positions[String(underlying ?? '').toUpperCase()];
  if (!position || position.assetClass !== 'us_equity') return 0;
  return Math.max(0, Number(position.qtySigned ?? position.qty ?? 0) || 0);
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

function normaliseStructure(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return raw === '' ? null : raw;
}

/** Infer the vertical-spread structure name from two parsed legs. */
function inferSpreadStructure(legs) {
  if (!Array.isArray(legs) || legs.length !== 2) return null;
  const [a, b] = legs;
  if (!a || !b || a.type !== b.type) return null;
  const buy = a.side === 'buy' ? a : b;
  const sell = a.side === 'sell' ? a : b;
  if (!buy || !sell || buy.side !== 'buy' || sell.side !== 'sell') return null;
  if (a.type === 'call') {
    return buy.strikeUsd < sell.strikeUsd ? 'bull_call_spread' : 'call_credit_spread';
  }
  return buy.strikeUsd > sell.strikeUsd ? 'bear_put_spread' : 'put_credit_spread';
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
   * v3 order input additions:
   *   order.assetClass, order.asset {shortable, marginable, tradable},
   *   order.option {underlying, expiration, type, strikeUsd, multiplier, dte, structure, groupId},
   *   order.structure, order.groupId, order.legs [{symbol, side, ratioQty, positionIntent}],
   *   order.positionIntent, order.marginRequiredUsd, order.netPremiumUsd, order.notionalUsd;
   *   mandate.instruments {longStock, shortStock, longOptions, shortOptions, coveredCalls,
   *   spreads, margin, allowedStructures, maxShortNotionalUsd, maxOptionPremiumUsd,
   *   maxContracts, maxMarginUsd}.
   *
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
    const inst = instrumentConfig(config);
    const mandateInstr = mandateInstruments(mandate);

    const deny = (brakeId, reason, extra = {}) => {
      const brake = BRAKE_V3_BY_ID[brakeId];
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
      const brake = BRAKE_V3_BY_ID[brakeId];
      return {
        decision: 'DENY',
        code,
        rule: brake?.rule ?? null,
        brakeId: brake?.id ?? null,
        reason,
        ...extra,
      };
    };
    const allow = (reason = 'all brakes passed', extra = {}) => ({
      decision: 'ALLOW',
      code: null,
      rule: null,
      brakeId: null,
      reason,
      ...extra,
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
    const rawAssetClass = String(order.assetClass ?? '').trim().toLowerCase();
    const legsInput = Array.isArray(order.legs) ? order.legs : [];
    const isSpread = legsInput.length > 0;
    const assetClass = normaliseAssetClass(rawAssetClass, symbol);
    const isOption = assetClass === 'us_option';
    const isOptionOrder = isOption || isSpread;
    const singleOption = isOption ? (order.option ?? parseOccSymbol(symbol)) : null;

    // ---- D1: only buy/sell orders exist; no transfers/withdrawals/ACH/crypto -----
    if (FORBIDDEN_ORDER_SIDES.includes(side)) {
      return deny('D1', `"${side}" is not a trade: transfers, withdrawals, ACH, wires and account changes are not implemented`);
    }
    if (!['buy', 'sell'].includes(side)) {
      return deny('D1', `order side must be "buy" or "sell" (got "${order.side ?? ''}")`);
    }
    if (rawAssetClass === 'crypto' || symbol.includes('/')) {
      return deny('D1', 'crypto orders are not implemented');
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

    // ---- D2: instrument-permission gate (asset class + permissions) -------------
    if (!KNOWN_ASSET_CLASSES.includes(rawAssetClass)) {
      return deny('D2', `unsupported assetClass "${order.assetClass}": only us_equity and us_option are tradable`);
    }
    if (!isOption && !isSpread && !EQUITY_SYMBOL.test(symbol)) {
      return deny('D2', `symbol "${symbol || '(empty)'}" does not look like an equity ticker`);
    }
    if (!mandateInstr.legacy && mandateInstr.longStock !== true && !isOptionOrder) {
      if (side === 'buy' && positionQty(positions, symbol) >= 0) {
        return deny('D2', 'long stock is not permitted by this mandate (instrument permission gate)');
      }
    }
    if (mandateInstr.legacy && !isOptionOrder && side === 'sell') {
      const held = Math.max(0, positionQty(positions, symbol));
      const sellQty = Number(order.qty);
      if (Number.isFinite(sellQty) && sellQty - held > EPSILON) {
        return deny('D15', `short selling is not permitted by a legacy mandate: selling ${sellQty} ${symbol} but only ${held} held`);
      }
    }

    // ---- price / notional resolution (D4 INPUT_MISSING precondition) ------------
    const quotePrice = midPrice(params.quote);
    const orderPrice = firstFinite(order.priceUsd, quotePrice);
    if (orderPrice === null || orderPrice <= 0) {
      return denyWithCode('D4', 'DATA_MISSING', `no price available for ${symbol || 'order'}; refusing to size the order`);
    }
    const orderQty = Number(order.qty);
    const contractsQty = Number.isFinite(orderQty) ? orderQty : null;

    // Underlying for whitelist / covered-call / mandate checks.
    let parsedLegs = [];
    if (isSpread) {
      if (legsInput.length !== 2) {
        return deny('D16', `defined-risk spreads require exactly 2 legs (got ${legsInput.length})`);
      }
      for (const rawLeg of legsInput) {
        const legSymbol = String(rawLeg?.symbol ?? '').toUpperCase();
        const parsed = parseOccSymbol(legSymbol);
        const legSide = String(rawLeg?.side ?? '').toLowerCase();
        if (!parsed) return deny('D16', `spread leg "${legSymbol || '(empty)'}" is not a valid OCC option symbol`);
        if (!['buy', 'sell'].includes(legSide)) return deny('D16', `spread leg "${legSymbol}" side must be buy or sell`);
        parsedLegs.push({
          ...parsed,
          side: legSide,
          ratioQty: Math.max(1, Number(rawLeg?.ratioQty ?? rawLeg?.ratio ?? 1) || 1),
          priceUsd: firstFinite(rawLeg?.priceUsd, rawLeg?.limitPrice, rawLeg?.price),
          positionIntent: rawLeg?.positionIntent ?? null,
        });
      }
    }
    const underlying = String(
      (isSpread ? parsedLegs[0]?.underlying : null)
        ?? singleOption?.underlying
        ?? parseOccSymbol(symbol)?.underlying
        ?? symbol,
    ).toUpperCase();
    const isClosing =
      String(order.positionIntent ?? order.intent ?? '').toLowerCase().endsWith('_close')
      || params.closing === true
      || order.closing === true
      || (isSpread && parsedLegs.some((leg) => String(leg.positionIntent ?? '').toLowerCase().endsWith('_close')));

    // Sizing notional: stock = qty × price; option = premium notional (debit or credit).
    let notionalUsd = null;
    let premiumNotionalUsd = null;
    if (isOptionOrder) {
      if (isSpread) {
        const derived = parsedLegs.reduce(
          (total, leg) => total + Math.abs(Number(leg.priceUsd) || 0) * leg.ratioQty * OPTION_MULTIPLIER,
          0,
        );
        premiumNotionalUsd = firstFinite(
          order.netPremiumUsd,
          order.premiumNotionalUsd,
          order.notionalUsd,
          derived > 0 ? derived : null,
        );
      } else {
        const contracts = contractsQty;
        premiumNotionalUsd = firstFinite(
          order.notionalUsd,
          order.netPremiumUsd,
          order.premiumNotionalUsd,
          Number.isFinite(contracts) ? contracts * orderPrice * OPTION_MULTIPLIER : null,
        );
      }
      if (premiumNotionalUsd === null || premiumNotionalUsd <= 0) {
        return denyWithCode('D4', 'DATA_MISSING', `option premium notional is unavailable for ${symbol || 'order'}`);
      }
      notionalUsd = premiumNotionalUsd;
    } else {
      notionalUsd = firstFinite(order.notionalUsd, Number.isFinite(orderQty) ? orderQty * orderPrice : null);
      if (notionalUsd === null || notionalUsd <= 0) {
        return denyWithCode('D4', 'BRAKE_DENIED', `order notional is unavailable for ${symbol}`);
      }
    }

    // ---- D15: short stock sales ------------------------------------------------
    let shortNotionalUsd = 0;
    if (!isOptionOrder && side === 'sell') {
      const held = Math.max(0, positionQty(positions, symbol));
      const shortAdd = (Number(order.qty) || 0) - held;
      if (shortAdd > EPSILON) {
        const shortNotional = round2(shortAdd * orderPrice);
        shortNotionalUsd = shortNotional;
        if (!inst.allowShort) return deny('D15', 'short selling is disabled by config.instruments.allowShort');
        if (mandateInstr.shortStock !== true) return deny('D15', 'this mandate does not permit short stock');
        if (inst.shortableOnly) {
          const asset = order.asset;
          if (!asset || typeof asset !== 'object') {
            return deny('D15', `asset metadata for ${symbol} is missing; a short sale needs a shortable+marginable asset`);
          }
          if (asset.shortable !== true || asset.marginable !== true) {
            return deny('D15', `${symbol} is not shortable+marginable (shortable=${asset.shortable}, marginable=${asset.marginable})`);
          }
        }
        if (Math.abs(shortAdd - Math.round(shortAdd)) > 1e-6) {
          return deny('D15', `short sales require whole shares (shorting ${shortAdd} shares)`);
        }
        const shortCap = capFrom(
          inst.maxShortNotionalUsd,
          inst.maxShortPctEquity * Number(params.equityUsd || 0),
          mandateInstr.maxShortNotionalUsd,
        );
        if (shortNotional > shortCap + EPSILON) {
          return deny('D15', `short notional ${round2(shortNotional)} exceeds the mandate/config cap ${round2(shortCap)}`);
        }
      }
    }

    // ---- D16: options (permissions, structure, contracts, premium, spreads) -----
    let optionStructure = null;
    let optionDte = null;
    let optionContracts = null;
    let definedMaxLossUsd = null;
    if (isOptionOrder) {
      if (!inst.allowOptions) return deny('D16', 'options are disabled by config.instruments.allowOptions');
      const equityUsd = Number(params.equityUsd);
      const premiumCap = capFrom(
        inst.maxOptionPremiumUsd,
        inst.maxOptionPremiumPctEquity * (Number.isFinite(equityUsd) ? equityUsd : 0),
        mandateInstr.maxOptionPremiumUsd,
      );
      const contractsCap = Math.min(inst.maxContracts, mandateInstr.maxContracts);
      const dteSource = singleOption?.dte
        ?? (singleOption?.expiration ? optionDaysToExpiry(singleOption.expiration, nowMs) : null);

      if (isSpread) {
        const [legA, legB] = parsedLegs;
        if (!inst.allowSpreads) return deny('D16', 'defined-risk spreads are disabled by config.instruments.allowSpreads');
        if (!mandateInstr.spreads) return deny('D16', 'this mandate does not permit option spreads');
        if (legA.underlying !== legB.underlying) return deny('D16', 'spread legs must share the same underlying');
        if (legA.expiration !== legB.expiration) return deny('D16', 'spread legs must share the same expiration (mixed-expiry spreads are not defined risk)');
        if (legA.type !== legB.type) return deny('D16', 'vertical spread legs must be the same option type');
        if (legA.side === legB.side) return deny('D16', 'a defined-risk spread needs one long and one short leg');
        if (legA.strikeUsd === legB.strikeUsd) return deny('D16', 'spread legs must have different strikes (a defined max loss needs width)');
        if (legA.ratioQty !== legB.ratioQty) return deny('D16', 'spread leg ratios must be equal (1:1)');
        optionStructure = normaliseStructure(order.structure) ?? inferSpreadStructure(parsedLegs);
        if (!optionStructure || !OPTION_STRUCTURES.includes(optionStructure)) {
          return deny('D16', `unknown or undefined spread structure "${order.structure ?? ''}"`);
        }
        if (mandateInstr.allowedStructures.length > 0 && !mandateInstr.allowedStructures.includes(optionStructure)) {
          return deny('D16', `structure "${optionStructure}" is not in this mandate's allowed structures`);
        }
        const spreadContracts = contractsQty ?? Math.max(legA.ratioQty, legB.ratioQty);
        if (!Number.isInteger(spreadContracts) || spreadContracts <= 0) {
          return deny('D16', 'spread contracts must be a positive integer');
        }
        optionContracts = spreadContracts;
        if (optionContracts > contractsCap + EPSILON) {
          return deny('D16', `contracts ${optionContracts} exceed the per-order cap ${contractsCap}`);
        }
        const widthUsd = Math.abs(legA.strikeUsd - legB.strikeUsd);
        definedMaxLossUsd = round2(widthUsd * OPTION_MULTIPLIER * optionContracts);
        if (!Number.isFinite(definedMaxLossUsd) || definedMaxLossUsd <= 0) {
          return deny('D16', 'spread max loss is not defined');
        }
        optionDte = optionDaysToExpiry(legA.expiration, nowMs);
      } else {
        if (!singleOption) return deny('D16', `option order ${symbol || '(empty)'} has no contract metadata and no valid OCC symbol`);
        if (!isOccOptionSymbol(symbol)) return deny('D16', `symbol "${symbol}" is not a valid OCC option symbol`);
        if (!OPTION_STRUCTURES.includes(String(singleOption.type) === 'call' ? 'long_call' : 'long_put')
          && !['call', 'put'].includes(String(singleOption.type))) {
          return deny('D16', 'option type must be call or put');
        }
        optionStructure = normaliseStructure(order.structure ?? singleOption.structure);
        if (!optionStructure) {
          optionStructure = String(singleOption.type) === 'put'
            ? (side === 'buy' ? 'long_put' : 'naked_put')
            : (side === 'buy' ? 'long_call' : 'covered_call');
        }
        if (!Number.isInteger(contractsQty) || contractsQty <= 0) {
          return deny('D16', 'option contracts must be a positive integer');
        }
        optionContracts = contractsQty;
        if (optionContracts > contractsCap + EPSILON) {
          return deny('D16', `contracts ${optionContracts} exceed the per-order cap ${contractsCap}`);
        }
        optionDte = dteSource;
        if (!isClosing) {
          if (side === 'buy') {
            if (!mandateInstr.longOptions) return deny('D16', 'this mandate does not permit long options');
            if (!['long_call', 'long_put'].includes(optionStructure)) {
              return deny('D16', `structure "${optionStructure}" is not a valid long option (use a spread for defined risk)`);
            }
            if (mandateInstr.allowedStructures.length > 0 && !mandateInstr.allowedStructures.includes(optionStructure)) {
              return deny('D16', `structure "${optionStructure}" is not in this mandate's allowed structures`);
            }
            definedMaxLossUsd = round2(premiumNotionalUsd);
          } else {
            // sell to open: only a covered call is legal; everything else is naked.
            if (optionStructure !== 'covered_call') {
              return deny('D16', 'naked short options are always denied (only covered calls and defined-risk spreads may be sold to open)');
            }
            if (!inst.allowCoveredCalls) return deny('D16', 'covered calls are disabled by config.instruments.allowCoveredCalls');
            if (!mandateInstr.coveredCalls) return deny('D16', 'this mandate does not permit covered calls');
            if (singleOption?.type !== 'call') return deny('D16', 'a covered call must be a call option');
            if (mandateInstr.allowedStructures.length > 0 && !mandateInstr.allowedStructures.includes(optionStructure)) {
              return deny('D16', `structure "${optionStructure}" is not in this mandate's allowed structures`);
            }
            const coveredShares = longShares(positions, singleOption.underlying ?? underlying);
            if (coveredShares + EPSILON < optionContracts * OPTION_MULTIPLIER) {
              return deny(
                'D16',
                `covered call requires ${optionContracts * OPTION_MULTIPLIER} long shares of ${singleOption.underlying ?? underlying}; only ${coveredShares} held`,
              );
            }
            // defined max loss for a covered call is the upside it forgoes; bounded by premium
            definedMaxLossUsd = round2(premiumNotionalUsd);
          }
        }
        // premium caps apply to opening debit AND opening credit
        if (!isClosing && premiumNotionalUsd > premiumCap + EPSILON) {
          return deny('D16', `option premium notional ${round2(premiumNotionalUsd)} exceeds the mandate/config cap ${round2(premiumCap)}`);
        }
        if (!isClosing && optionDte !== null && optionDte > inst.maxDTE) {
          return deny('D16', `DTE ${optionDte} is above the maximum ${inst.maxDTE}`);
        }
      }
      // spreads: premium caps + max DTE
      if (isSpread) {
        if (!isClosing && premiumNotionalUsd > premiumCap + EPSILON) {
          return deny('D16', `spread premium notional ${round2(premiumNotionalUsd)} exceeds the mandate/config cap ${round2(premiumCap)}`);
        }
        if (!isClosing && optionDte !== null && optionDte > inst.maxDTE) {
          return deny('D16', `DTE ${optionDte} is above the maximum ${inst.maxDTE}`);
        }
      }
    }

    // ---- D18: expiry/assignment guard (opening options below minDTE) -----------
    if (isOptionOrder && !isClosing) {
      if (optionDte === null || !Number.isFinite(optionDte)) {
        return deny('D16', 'option DTE is unknown; a dated option contract is required');
      }
      if (optionDte < inst.minDTE) {
        return deny(
          'D18',
          `opening option orders need DTE >= ${inst.minDTE} (this contract has ${optionDte} DTE); sell-to-close is always allowed`,
          { dte: optionDte },
        );
      }
    }

    // ---- D17: margin -----------------------------------------------------------
    const marginRequiredUsd = Math.max(0, Number(order.marginRequiredUsd) || 0);
    const currentMarginDebtUsd = Math.max(0, Number(params.marginDebtUsd) || 0);
    let projectedMarginDebtUsd = round2(currentMarginDebtUsd);
    if (marginRequiredUsd > EPSILON && !isClosing) {
      projectedMarginDebtUsd = round2(currentMarginDebtUsd + marginRequiredUsd);
      const equityUsdForMargin = Number(params.equityUsd);
      if (!inst.allowMargin) {
        return deny('D17', `margin is disabled by config.instruments.allowMargin (order needs ${round2(marginRequiredUsd)} of debt)`);
      }
      if (mandateInstr.margin !== true) {
        return deny('D17', 'this mandate does not permit margin');
      }
      const marginCap = capFrom(
        inst.maxMarginUsd,
        inst.maxMarginPctEquity * (Number.isFinite(equityUsdForMargin) ? equityUsdForMargin : 0),
        mandateInstr.maxMarginUsd,
      );
      if (projectedMarginDebtUsd > marginCap + EPSILON) {
        return deny(
          'D17',
          `margin debt ${projectedMarginDebtUsd.toFixed(2)} would exceed the cap ${round2(marginCap).toFixed(2)}`,
        );
      }
      const buyingPower = Number(params.buyingPowerUsd);
      if (Number.isFinite(buyingPower) && marginRequiredUsd > buyingPower + EPSILON) {
        return deny('D17', `margin requirement ${round2(marginRequiredUsd)} exceeds buying power ${round2(buyingPower)}`);
      }
    }

    // ---- D4: whitelist, price/notional, spread, slippage -----------------------
    const whitelist = new Set((Array.isArray(config.symbols) ? config.symbols : []).map((item) => String(item).toUpperCase()));
    const whitelistSymbol = isOptionOrder ? underlying : symbol;
    if (whitelistSymbol === '' || !whitelist.has(whitelistSymbol)) {
      return deny('D4', `symbol "${whitelistSymbol || '(empty)'}" is not in the tradable whitelist`);
    }
    if (Array.isArray(mandate?.allowedSymbols) && mandate.allowedSymbols.length > 0) {
      const allowed = new Set(mandate.allowedSymbols.map((item) => String(item).toUpperCase()));
      if (!allowed.has(whitelistSymbol)) return deny('D4', `symbol "${whitelistSymbol}" is outside this mandate's allowed symbols`);
    }
    if (!isOptionOrder && orderPrice < Number(risk.minPriceUsd ?? 0)) {
      return deny('D4', `price ${orderPrice} is below the minimum tradable price ${risk.minPriceUsd}`);
    }
    if (side === 'buy' && notionalUsd < Number(risk.minOrderNotionalUsd ?? 0)) {
      return deny('D4', `order notional ${notionalUsd.toFixed(2)} is below the minimum ${risk.minOrderNotionalUsd}`);
    }
    // Options quotes are legitimately wide (cents), so the equity spread/slippage
    // ceilings are not applied to option or spread orders; premium caps bound the risk.
    if (!isOptionOrder) {
      const spreadBps = firstFinite(params.spreadBps, spreadFromQuote(params.quote));
      if (spreadBps !== null && spreadBps > Number(risk.maxSpreadBps ?? Infinity)) {
        return deny('D4', `spread ${spreadBps}bps exceeds the maximum ${risk.maxSpreadBps}bps`);
      }
      const slippageBps = firstFinite(order.slippageBps, order.expectedSlippageBps, params.slippageBps);
      if (slippageBps !== null && slippageBps > Number(risk.maxSlippageBps ?? Infinity)) {
        return deny('D4', `slippage ${slippageBps}bps exceeds the maximum ${risk.maxSlippageBps}bps`);
      }
    }

    // ---- D9: no trade without a Builder spec carrying dated proof --------------
    const spec = params.spec;
    if (!spec || typeof spec !== 'object') {
      return deny('D9', 'no strategy spec: a Builder spec with dated proof is required before any order');
    }
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
    if (halted && side === 'buy' && !isClosing) {
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
    const held = positions[isOptionOrder ? underlying : symbol] ?? { qty: 0, valueUsd: 0 };
    const opensExposure = side === 'buy' || (isSpread && !isClosing) || (!isOptionOrder && side === 'sell');
    if (opensExposure && !isClosing) {
      const existingValue = Number(held.valueUsd) || 0;
      const projected = side === 'sell' && !isOptionOrder ? notionalUsd : existingValue + notionalUsd;
      const maxPositionValue = Number(risk.maxPositionPct ?? 0) * equityUsd;
      if (projected > maxPositionValue + EPSILON) {
        return deny(
          'D5',
          `position notional in ${whitelistSymbol} would be ${round2(projected)} (above the ${risk.maxPositionPct} of equity cap)`,
        );
      }
      const isNewSymbolPosition = !isOptionOrder && !(held.qty > 0) && side === 'buy';
      const isNewOptionPosition = isOptionOrder && !Object.keys(positions).some((key) => key === symbol);
      if (isNewSymbolPosition || isNewOptionPosition) {
        const openCount = Object.values(positions).filter((position) => (Number(position.qty) || 0) !== 0).length;
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
    const cycleSymbols = new Set(
      (Array.isArray(dayStats.symbolsThisCycle) ? dayStats.symbolsThisCycle : []).map((item) => String(item).toUpperCase()),
    );
    if (cycleSymbols.has(symbol) || cycleSymbols.has(whitelistSymbol)) {
      return deny('D6', `already ordered ${whitelistSymbol} this cycle (one order per symbol per cycle)`);
    }
    const ordersThisCycle = Number(dayStats.ordersThisCycle);
    if (Number.isFinite(ordersThisCycle) && ordersThisCycle >= Number(risk.maxOrdersPerCycle)) {
      return deny('D6', `cycle order cap reached (${ordersThisCycle}/${risk.maxOrdersPerCycle})`);
    }

    // ---- D13: allocated capital can never exceed allocationCapPct of the account --
    // The Executor falls back to agent equity when a mandate carries no account-level
    // numbers; that degenerate triple is not evidence of over-allocation, so D13 is
    // enforced only when the inputs actually distinguish account vs allocated capital.
    if (side === 'buy' && !isClosing) {
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

    return allow('all brakes passed', {
      assetClass,
      underlying: isOptionOrder ? underlying : symbol,
      notionalUsd: round2(notionalUsd),
      premiumNotionalUsd: isOptionOrder ? round2(premiumNotionalUsd) : null,
      structure: optionStructure,
      contracts: optionContracts,
      dte: optionDte,
      maxLossUsd: definedMaxLossUsd,
      shortNotionalUsd: shortNotionalUsd > 0 ? round2(shortNotionalUsd) : 0,
      marginDebtUsd: projectedMarginDebtUsd,
    });
  }

  /** The full D1-D18 catalogue, annotated with the enforcing code site. */
  function describe() {
    return BRAKE_CATALOGUE.map((brake) => ({
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
