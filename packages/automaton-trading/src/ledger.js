/**
 * ledger.js — the per-agent virtual USD ledger.
 *
 * Alpaca has no sub-accounts, so per-agent capital is bookkeeping: this module is the
 * book. Every agent has a cash balance and a position book; fills move cash and realize
 * P&L; costs are attributed by role so "a role must pay for its own inference" is
 * measurable rather than rhetorical.
 *
 * Funding semantics (aligned with the Lead's orchestrator):
 *   - `ensureAgent(id, {endowmentUsd})` declares an endowment for reference and creates
 *     the record with cashUsd = 0. It never adds cash.
 *   - `grant(id, usd)` is a money-creation path (genesis funding).
 *   - `transfer(from, to, usd)` moves existing cash (replication funding, death sweep).
 *   - `'__treasury__'` is a synthetic reserved record holding unallocated capital; the
 *     Reaper sweeps a dead agent's residual cash into it.
 *
 * Invariants enforced here: cashUsd >= 0, cash + positionsValue = equity, USD at 2dp,
 * quantities at 4dp. `anchorToBrokerEquity()` is called once by the Treasurer so that
 * sum(agent equity) + treasury equity is anchored to broker account equity.
 *
 * Owned by mortality-core. Contract: docs/CONTRACTS.md ("Mortality modules").
 */

import fs from 'node:fs';
import path from 'node:path';
import { AutomatonError, fail } from './contracts.js';
import { readJsonSync, round2, round4, round8, SYSTEM_CLOCK } from './util.js';
import { statePaths } from './config.js';

/** Reserved synthetic account that holds unallocated treasury cash. */
export const TREASURY_ID = '__treasury__';

const NET7D_MS = 7 * 24 * 60 * 60 * 1000;
const EPSILON = 1e-9;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function writeJsonAtomicSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function normalizeAt(at, clock) {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  if (typeof at === 'string') {
    const ms = Date.parse(at);
    if (Number.isFinite(ms)) return ms;
  }
  return clock.now();
}

function priceLookup(prices, symbol) {
  if (!prices) return undefined;
  if (typeof prices.get === 'function') return prices.get(symbol);
  return prices[symbol];
}

/**
 * @param {{ paths?: object, config?: object, clock?: object }} [options]
 */
export function createLedger({ paths, config, clock } = {}) {
  if (!paths?.ledger && !config) {
    throw new AutomatonError('CONFIG_INVALID', 'createLedger requires { paths } or { config }', {});
  }
  const resolved = { ...(config ? statePaths(config) : {}), ...(paths ?? {}) };
  if (!resolved.ledger) {
    throw new AutomatonError('CONFIG_INVALID', 'ledger path is required', {});
  }
  const ledgerPath = path.resolve(resolved.ledger);
  const currentClock = clock ?? SYSTEM_CLOCK;

  /** @type {{ version: number, anchored: boolean, anchoredAt: string|null, agents: Record<string, object> }} */
  let state = emptyState();

  function emptyState() {
    return { version: 1, anchored: false, anchoredAt: null, agents: {} };
  }

  function newRecord(agentId, { endowmentUsd = 0, at } = {}) {
    const atIso = new Date(normalizeAt(at, currentClock)).toISOString();
    return {
      agentId,
      cashUsd: 0,
      positions: {},
      realizedPlUsd: 0,
      costsUsd: 0,
      costsByRole: {},
      grossSpendUsd: 0,
      grossRevenueUsd: 0,
      trades: 0,
      firstProfitAt: null,
      declaredEndowmentUsd: round2(Math.max(0, Number(endowmentUsd) || 0)),
      startedAt: atIso,
      fills: [],
      events: [{ atMs: Date.parse(atIso), kind: 'endowment-declared', amountUsd: round2(Number(endowmentUsd) || 0) }],
      markPrices: {},
      lastUnrealizedUsd: 0,
      updatedAt: atIso,
    };
  }

  function normaliseRecord(raw) {
    const atIso = typeof raw?.startedAt === 'string' ? raw.startedAt : currentClock.iso();
    const record = {
      ...newRecord(raw?.agentId, { endowmentUsd: raw?.declaredEndowmentUsd ?? 0, at: atIso }),
      ...raw,
    };
    record.positions = isPlainObject(record.positions) ? record.positions : {};
    for (const [symbol, position] of Object.entries(record.positions)) {
      record.positions[symbol] = {
        qty: round4(Number(position?.qty) || 0),
        avgPriceUsd: round4(Number(position?.avgPriceUsd) || 0),
        openedAt: typeof position?.openedAt === 'string' ? position.openedAt : atIso,
      };
    }
    // Sub-cent precision matters here: the metabolism charges fractions of a cent per
    // role per cycle, and rounding the accumulator at 2dp on every reload silently
    // changes the configured burn rate (measured: +14% on short runs).
    record.cashUsd = round8(Number(record.cashUsd) || 0);
    record.realizedPlUsd = round8(Number(record.realizedPlUsd) || 0);
    record.costsUsd = round8(Number(record.costsUsd) || 0);
    record.costsByRole = isPlainObject(record.costsByRole) ? record.costsByRole : {};
    for (const [role, value] of Object.entries(record.costsByRole)) {
      record.costsByRole[role] = round8(Number(value) || 0);
    }
    record.grossSpendUsd = round8(Number(record.grossSpendUsd) || 0);
    record.grossRevenueUsd = round8(Number(record.grossRevenueUsd) || 0);
    record.trades = Number(record.trades) || 0;
    record.fills = Array.isArray(record.fills) ? record.fills : [];
    record.events = Array.isArray(record.events) ? record.events : [];
    record.markPrices = isPlainObject(record.markPrices) ? record.markPrices : {};
    record.declaredEndowmentUsd = round2(Number(record.declaredEndowmentUsd) || 0);
    return record;
  }

  function pruneEvents(record) {
    const cutoff = currentClock.now() - NET7D_MS;
    record.events = record.events.filter((event) => Number(event?.atMs) >= cutoff);
    if (record.fills.length > 5000) record.fills = record.fills.slice(-5000);
  }

  function requireRecord(agentId) {
    if (typeof agentId !== 'string' || agentId === '') {
      fail('CONFIG_INVALID', 'agentId must be a non-empty string', { agentId });
    }
    const record = state.agents[agentId];
    if (!record) fail('UNKNOWN_AGENT', `unknown ledger agent "${agentId}"`, { agentId });
    return record;
  }

  function ensureRecord(agentId, options = {}) {
    const existing = state.agents[agentId];
    if (existing) return existing;
    const record = newRecord(agentId, options);
    state.agents[agentId] = record;
    return record;
  }

  /** Create the ledger record for an agent with cashUsd = 0. Returns a copy. */
  function ensureAgent(agentId, { endowmentUsd = 0, at } = {}) {
    if (typeof agentId !== 'string' || agentId === '') {
      fail('CONFIG_INVALID', 'ensureAgent(agentId) requires a non-empty string id', { agentId });
    }
    const record = ensureRecord(agentId, { endowmentUsd, at });
    if (Number.isFinite(endowmentUsd) && Number(endowmentUsd) > 0 && record.declaredEndowmentUsd === 0) {
      record.declaredEndowmentUsd = round2(Number(endowmentUsd));
      record.events.push({
        atMs: normalizeAt(at, currentClock),
        kind: 'endowment-declared',
        amountUsd: record.declaredEndowmentUsd,
      });
    }
    return clone(record);
  }

  function get(agentId) {
    return clone(requireRecord(agentId));
  }

  function has(agentId) {
    return typeof agentId === 'string' && Boolean(state.agents[agentId]);
  }

  function ids() {
    return Object.keys(state.agents);
  }

  /** Position book handed to the EXECUTOR (never account equity/cash). */
  function book(agentId) {
    const record = requireRecord(agentId);
    return { agentId, positions: clone(record.positions), openOrders: [] };
  }

  /** Attribute a cost (inference, data, hosting) to an agent and a role. */
  function charge(agentId, amountUsd, { category = 'inference', role = 'executor', ref = null, at } = {}) {
    const record = requireRecord(agentId);
    // Costs are sub-cent (a fraction of a cent per role per cycle): round at 8dp while
    // accumulating, or the metabolism silently charges more than the configured burn.
    const amount = round8(Number(amountUsd));
    if (!Number.isFinite(amount) || amount < 0) {
      fail('CONFIG_INVALID', 'charge amount must be a non-negative finite number', { agentId, amountUsd });
    }
    if (amount > record.cashUsd + EPSILON) {
      fail('INSUFFICIENT_CASH', `agent "${agentId}" cannot pay ${amount.toFixed(2)}: cash is ${record.cashUsd.toFixed(2)}`, {
        agentId,
        amountUsd: amount,
        cashUsd: record.cashUsd,
      });
    }
    const atMs = normalizeAt(at, currentClock);
    record.cashUsd = round8(record.cashUsd - amount);
    record.costsUsd = round8(record.costsUsd + amount);
    record.costsByRole[role] = round8((Number(record.costsByRole[role]) || 0) + amount);
    record.events.push({ atMs, kind: 'cost', amountUsd: amount, category, role, ref });
    record.updatedAt = new Date(atMs).toISOString();
    pruneEvents(record);
    return { balanceUsd: record.cashUsd, record: clone(record) };
  }

  /**
   * Apply a broker fill to the virtual book: buys debit cash, sells realize P&L.
   * Selling more than the book holds is refused (D2: no shorting).
   *
   * @returns {{ realizedPlUsd: number, position: object|null }}
   */
  function applyFill(agentId, { symbol, side, qty, priceUsd, at, orderId = null } = {}) {
    const record = requireRecord(agentId);
    const symbolKey = String(symbol ?? '').toUpperCase();
    if (symbolKey === '') fail('CONFIG_INVALID', 'applyFill requires a symbol', { agentId });
    const direction = String(side ?? '').toLowerCase();
    if (!['buy', 'sell'].includes(direction)) {
      fail('CONFIG_INVALID', 'applyFill side must be "buy" or "sell"', { agentId, side });
    }
    const quantity = round4(Number(qty));
    const price = round4(Number(priceUsd));
    if (!Number.isFinite(quantity) || quantity <= 0) fail('CONFIG_INVALID', 'fill qty must be > 0', { agentId, qty });
    if (!Number.isFinite(price) || price <= 0) fail('CONFIG_INVALID', 'fill priceUsd must be > 0', { agentId, priceUsd });
    const atMs = normalizeAt(at, currentClock);
    const atIso = new Date(atMs).toISOString();
    const notional = round2(quantity * price);

    const existing = record.positions[symbolKey];
    let realizedPlUsd = 0;
    let position = null;

    if (direction === 'buy') {
      if (notional > record.cashUsd + EPSILON) {
        fail('INSUFFICIENT_CASH', `agent "${agentId}" cannot buy ${symbolKey}: cash is ${record.cashUsd.toFixed(2)}, cost is ${notional.toFixed(2)}`, {
          agentId,
          symbol: symbolKey,
          notionalUsd: notional,
          cashUsd: record.cashUsd,
        });
      }
      record.cashUsd = round2(record.cashUsd - notional);
      record.grossSpendUsd = round2(record.grossSpendUsd + notional);
      const heldQty = round4(Number(existing?.qty) || 0);
      const heldCost = round4(Number(existing?.avgPriceUsd) || 0) * heldQty;
      const totalQty = round4(heldQty + quantity);
      const avgPriceUsd = round4((heldCost + quantity * price) / totalQty);
      record.positions[symbolKey] = {
        qty: totalQty,
        avgPriceUsd,
        openedAt: existing?.openedAt ?? atIso,
      };
      position = clone(record.positions[symbolKey]);
      record.trades += 1;
      record.events.push({ atMs, kind: 'fill', side: 'buy', amountUsd: -notional, symbol: symbolKey, qty: quantity });
    } else {
      const heldQty = round4(Number(existing?.qty) || 0);
      if (heldQty <= EPSILON) {
        fail('BRAKE_DENIED', `agent "${agentId}" cannot sell ${symbolKey}: no position (D2 no shorting)`, {
          agentId,
          symbol: symbolKey,
          positionQty: 0,
          brake: 'MARGIN_FORBIDDEN',
        });
      }
      if (quantity - heldQty > EPSILON) {
        fail('BRAKE_DENIED', `agent "${agentId}" cannot sell ${quantity} ${symbolKey}: only ${heldQty} held (D2 no shorting)`, {
          agentId,
          symbol: symbolKey,
          positionQty: heldQty,
          brake: 'MARGIN_FORBIDDEN',
        });
      }
      const avgPriceUsd = round4(Number(existing?.avgPriceUsd) || 0);
      realizedPlUsd = round2((price - avgPriceUsd) * quantity);
      record.cashUsd = round2(record.cashUsd + notional);
      record.realizedPlUsd = round2(record.realizedPlUsd + realizedPlUsd);
      record.grossRevenueUsd = round2(record.grossRevenueUsd + notional);
      const remainingQty = round4(heldQty - quantity);
      if (remainingQty <= EPSILON) delete record.positions[symbolKey];
      else record.positions[symbolKey] = { ...existing, qty: remainingQty, avgPriceUsd };
      position = record.positions[symbolKey] ? clone(record.positions[symbolKey]) : null;
      record.trades += 1;
      record.events.push({
        atMs,
        kind: 'fill',
        side: 'sell',
        amountUsd: notional,
        symbol: symbolKey,
        qty: quantity,
        realizedPlUsd,
      });
      if (record.firstProfitAt === null && round2(record.realizedPlUsd - record.costsUsd) > 0) {
        record.firstProfitAt = atIso;
      }
    }

    record.fills.push({
      symbol: symbolKey,
      side: direction,
      qty: quantity,
      priceUsd: price,
      notionalUsd: notional,
      realizedPlUsd,
      atMs,
      at: atIso,
      orderId,
    });
    record.updatedAt = atIso;
    pruneEvents(record);
    return { realizedPlUsd, position };
  }

  /**
   * Move existing cash between accounts. Both sides auto-create records so init order
   * does not matter; the source must have the cash (never go negative).
   */
  function transfer(fromId, toId, amountUsd, { reason = 'transfer', at } = {}) {
    if (typeof fromId !== 'string' || fromId === '' || typeof toId !== 'string' || toId === '') {
      fail('CONFIG_INVALID', 'transfer requires non-empty fromId and toId', { fromId, toId });
    }
    if (fromId === toId) fail('CONFIG_INVALID', 'transfer source and target must differ', { fromId, toId });
    // 8dp: cash accumulates sub-cent charges, and a death sweep must move the exact
    // residual (rounding it to 2dp can make the estate half a cent short and block the kill).
    const amount = round8(Number(amountUsd));
    if (!Number.isFinite(amount) || amount <= 0) {
      fail('CONFIG_INVALID', 'transfer amount must be a positive finite number', { amountUsd });
    }
    const atMs = normalizeAt(at, currentClock);
    const from = ensureRecord(fromId, { endowmentUsd: 0, at: atMs });
    if (amount > from.cashUsd + EPSILON) {
      fail('INSUFFICIENT_CASH', `account "${fromId}" cannot transfer ${amount.toFixed(8)}: cash is ${from.cashUsd.toFixed(8)}`, {
        fromId,
        toId,
        amountUsd: amount,
        cashUsd: from.cashUsd,
      });
    }
    const to = ensureRecord(toId, { endowmentUsd: 0, at: atMs });
    from.cashUsd = round8(from.cashUsd - amount);
    to.cashUsd = round8(to.cashUsd + amount);
    from.events.push({ atMs, kind: 'transfer-out', amountUsd: amount, toId, reason });
    to.events.push({ atMs, kind: 'transfer-in', amountUsd: amount, fromId, reason });
    from.updatedAt = new Date(atMs).toISOString();
    to.updatedAt = from.updatedAt;
    pruneEvents(from);
    pruneEvents(to);
  }

  /** Genesis funding: creates virtual cash for an agent (the orchestrator seeds once). */
  function grant(agentId, amountUsd, { reason = 'grant', at } = {}) {
    if (typeof agentId !== 'string' || agentId === '') {
      fail('CONFIG_INVALID', 'grant requires a non-empty agentId', { agentId });
    }
    const amount = round2(Number(amountUsd));
    if (!Number.isFinite(amount) || amount <= 0) {
      fail('CONFIG_INVALID', 'grant amount must be a positive finite number', { amountUsd });
    }
    const atMs = normalizeAt(at, currentClock);
    const record = ensureRecord(agentId, { endowmentUsd: 0, at: atMs });
    record.cashUsd = round2(record.cashUsd + amount);
    record.events.push({ atMs, kind: 'grant', amountUsd: amount, reason });
    record.updatedAt = new Date(atMs).toISOString();
    pruneEvents(record);
  }

  /** Mark an agent at current prices and return the equity decomposition. */
  function equity(agentId, prices = {}) {
    const record = requireRecord(agentId);
    let positionsValueUsd = 0;
    let costBasisUsd = 0;
    const marks = {};
    for (const [symbol, position] of Object.entries(record.positions)) {
      const heldQty = Number(position.qty) || 0;
      if (heldQty === 0) continue;
      const candidate = priceLookup(prices, symbol);
      const mark = Number.isFinite(Number(candidate)) && Number(candidate) > 0
        ? Number(candidate)
        : Number(record.markPrices?.[symbol]) > 0
          ? Number(record.markPrices[symbol])
          : Number(position.avgPriceUsd) || 0;
      marks[symbol] = mark;
      positionsValueUsd += heldQty * mark;
      costBasisUsd += heldQty * (Number(position.avgPriceUsd) || 0);
    }
    const roundedPositionsValue = round2(positionsValueUsd);
    const unrealizedPlUsd = round2(positionsValueUsd - costBasisUsd);
    const equityUsd = round2(record.cashUsd + roundedPositionsValue);
    record.markPrices = { ...record.markPrices, ...marks };
    record.lastUnrealizedUsd = unrealizedPlUsd;
    record.updatedAt = currentClock.iso();
    const netPlUsd = round2(record.realizedPlUsd - record.costsUsd + unrealizedPlUsd);
    if (record.firstProfitAt === null && netPlUsd > 0) record.firstProfitAt = currentClock.iso();
    return {
      equityUsd,
      cashUsd: record.cashUsd,
      positionsValueUsd: roundedPositionsValue,
      unrealizedPlUsd,
    };
  }

  /** Trailing 7-day net: realized P&L (window) + current unrealized − costs (window). */
  function net7d(agentId) {
    const record = requireRecord(agentId);
    const cutoff = currentClock.now() - NET7D_MS;
    let realized = 0;
    let costs = 0;
    for (const event of record.events) {
      if (!(Number(event.atMs) >= cutoff)) continue;
      if (event.kind === 'fill' && event.side === 'sell') realized += Number(event.realizedPlUsd) || 0;
      if (event.kind === 'cost') costs += Number(event.amountUsd) || 0;
    }
    return round2(realized - costs + (Number(record.lastUnrealizedUsd) || 0));
  }

  /** Snapshot used for obituaries and status views (no broker reads). */
  function snapshot(agentId) {
    const record = requireRecord(agentId);
    return {
      cashUsd: record.cashUsd,
      positions: clone(record.positions),
      realizedPlUsd: record.realizedPlUsd,
      unrealizedPlUsd: round2(Number(record.lastUnrealizedUsd) || 0),
      costsUsd: record.costsUsd,
      grossSpendUsd: record.grossSpendUsd,
      grossRevenueUsd: record.grossRevenueUsd,
      trades: record.trades,
      net7dUsd: net7d(agentId),
      firstProfitAt: record.firstProfitAt,
      endowmentUsd: record.declaredEndowmentUsd,
      startedAt: record.startedAt,
    };
  }

  function roleCosts(agentId) {
    const record = requireRecord(agentId);
    return clone(record.costsByRole);
  }

  /**
   * Recent fills for the operator/UI: newest first, bounded, with everything needed to show
   * "past activity" (side, qty, price, notional, realized P&L, timestamp, order id).
   * @param {string} agentId
   * @param {{ limit?: number }} [options]
   */
  function history(agentId, { limit = 20 } = {}) {
    const record = requireRecord(agentId);
    const size = Math.max(1, Math.min(200, Number(limit) || 20));
    return clone(record.fills.slice(-size)).reverse();
  }

  /** Equity of a record at its stored marks (the synthetic treasury has no positions). */
  function equityAtStoredMarks(record) {
    let positionsValueUsd = 0;
    for (const [symbol, position] of Object.entries(record.positions)) {
      const mark = Number(record.markPrices?.[symbol]) > 0
        ? Number(record.markPrices[symbol])
        : Number(position.avgPriceUsd) || 0;
      positionsValueUsd += (Number(position.qty) || 0) * mark;
    }
    return round2(record.cashUsd + positionsValueUsd);
  }

  /**
   * Treasury pool: unallocated cash held by `'__treasury__'` plus allocated agent equity.
   * @param {{ aliveIds?: string[] }} [options] restrict allocated equity to living agents
   */
  function pool({ aliveIds = null } = {}) {
    const treasury = state.agents[TREASURY_ID];
    const poolUsd = treasury ? equityAtStoredMarks(treasury) : 0;
    const filter = Array.isArray(aliveIds) ? new Set(aliveIds) : null;
    let allocatedUsd = 0;
    for (const [agentId, record] of Object.entries(state.agents)) {
      if (agentId === TREASURY_ID) continue;
      if (filter && !filter.has(agentId)) continue;
      allocatedUsd += equityAtStoredMarks(record);
    }
    return { poolUsd: round2(poolUsd), allocatedUsd: round2(allocatedUsd), totalUsd: round2(poolUsd + allocatedUsd) };
  }

  function isAnchored() {
    return state.anchored === true;
  }

  /**
   * One-time reconciliation anchor: credit `'__treasury__'` with the broker capital that
   * is not yet allocated, so sum(agent equity) + treasury equity = broker account equity
   * at the anchor point. Later drift is what `treasurer.tick()` reports as mismatch.
   */
  function anchorToBrokerEquity(accountEquityUsd) {
    const accountEquity = round2(Number(accountEquityUsd));
    if (!Number.isFinite(accountEquity)) {
      fail('CONFIG_INVALID', 'anchorToBrokerEquity requires a finite account equity', { accountEquityUsd });
    }
    if (state.anchored) return { anchored: false, seededUsd: 0, poolUsd: pool().poolUsd };
    const allocated = pool().allocatedUsd;
    const seed = round2(accountEquity - allocated);
    if (seed > 0) {
      grant(TREASURY_ID, seed, { reason: 'genesis-pool-anchor' });
    }
    state.anchored = true;
    state.anchoredAt = currentClock.iso();
    return { anchored: true, seededUsd: Math.max(0, seed), poolUsd: pool().poolUsd };
  }

  function save() {
    writeJsonAtomicSync(ledgerPath, state);
  }

  function load() {
    const raw = readJsonSync(ledgerPath, null);
    state = emptyState();
    if (!raw) return;
    state.anchored = raw.anchored === true;
    state.anchoredAt = typeof raw.anchoredAt === 'string' ? raw.anchoredAt : null;
    const agents = isPlainObject(raw.agents) ? raw.agents : {};
    for (const [agentId, record] of Object.entries(agents)) {
      if (!isPlainObject(record)) continue;
      state.agents[agentId] = normaliseRecord({ ...record, agentId });
    }
  }

  return {
    ensureAgent,
    get,
    has,
    ids,
    book,
    charge,
    applyFill,
    transfer,
    grant,
    equity,
    net7d,
    snapshot,
    roleCosts,
    history,
    pool,
    isAnchored,
    anchorToBrokerEquity,
    save,
    load,
    /** Absolute path of the persisted ledger file (diagnostics only). */
    get path() {
      return ledgerPath;
    },
  };
}
