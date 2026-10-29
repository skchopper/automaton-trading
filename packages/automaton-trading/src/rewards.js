/**
 * REWARDS — configurable period payouts to the leaderboard winners.
 *
 * Virtual money only: a reward is a `ledger.transfer('__treasury__', agentId, ...)`,
 * i.e. cash moves from the treasury pool to the agent's virtual account. The broker
 * client still has no transfer/withdraw surface (brake D1), and because the pool is
 * part of `sum(agent equity) + pool`, the treasurer's reconciliation is unaffected.
 *
 * Scheduler semantics (docs/CONTROL-PANEL.md § "Rewards module"):
 *   - the current period key (daily = UTC date, weekly = ISO week, monthly = UTC month)
 *     is anchored on first load, so the initial partial period is never paid;
 *   - when the current key differs from `lastPeriodKey`, one period has completed and
 *     `duePeriod()` returns it (at most once per key — `apply()` advances the anchor);
 *   - amounts = `rankPercents[i] * broker account CASH` (basis `account-cash`), then
 *     proportionally scaled down so the payout never exceeds the available pool, the
 *     remaining allocation cap, or `maxPerPeriodUsd`;
 *   - all-zero payouts record `skipped` history, never a transfer.
 *
 * Pure w.r.t. wall clock/randomness: time comes from the injected clock or explicit
 * `nowMs`. State persists atomically to `stateDir/rewards.json` (history keeps 50).
 *
 * Contract: docs/CONTROL-PANEL.md § "Rewards module". Owner: market teammate.
 *
 * @module rewards
 */

import path from 'node:path';
import { fail } from './contracts.js';
import { statePaths } from './config.js';
import { TREASURY_ID } from './ledger.js';
import { readJson, round2, SYSTEM_CLOCK, writeJsonAtomic } from './util.js';
import { nextPeriodStartMs, periodKeyEndMs, periodKeyFor, periodStartMs } from './rankings.js';

/** Periods the rewards scheduler can pay on. */
export const REWARD_PERIODS = Object.freeze(['daily', 'weekly', 'monthly']);

/** Configured history length (last 50 payouts). */
export const REWARD_HISTORY_LIMIT = 50;

export const REWARDS_VERSION = 1;

/** Fallbacks used when the passed config has no (or a malformed) `rewards` section. */
export const REWARD_DEFAULTS = Object.freeze({
  enabled: true,
  period: 'daily',
  rankPercents: Object.freeze([0.05, 0.03, 0.02]),
  basis: 'account-cash',
  maxPerPeriodUsd: null,
});

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Normalize an explicit timestamp / ISO string / Date; fall back to the clock. */
function normalizeAt(value, clock) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return clock.now();
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

/** Deep clone of plain JSON-safe state. */
function cloneState(state) {
  try {
    return structuredClone(state);
  } catch {
    return JSON.parse(JSON.stringify(state));
  }
}

/**
 * Resolve the reward settings from `config.rewards` with local fallbacks, so the module
 * is usable even before the Lead's config schema lands.
 * @param {object} [config]
 */
export function resolveRewardSettings(config) {
  const raw = config && isPlainObject(config.rewards) ? config.rewards : {};
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : REWARD_DEFAULTS.enabled;
  const period = REWARD_PERIODS.includes(raw.period) ? raw.period : REWARD_DEFAULTS.period;
  const basis = raw.basis === 'account-cash' ? raw.basis : REWARD_DEFAULTS.basis;
  let rankPercents = [...REWARD_DEFAULTS.rankPercents];
  if (Array.isArray(raw.rankPercents) && raw.rankPercents.length === 3) {
    const parsed = raw.rankPercents.map((percent) => Number(percent));
    if (parsed.every((percent) => Number.isFinite(percent) && percent >= 0 && percent <= 0.5)) {
      rankPercents = parsed;
    }
  }
  const rawMax = raw.maxPerPeriodUsd;
  const maxPerPeriodUsd = rawMax === null || rawMax === undefined || rawMax === ''
    ? null
    : Number.isFinite(Number(rawMax)) && Number(rawMax) >= 0
      ? Number(rawMax)
      : null;
  return { enabled, period, rankPercents, basis, maxPerPeriodUsd };
}

/** @returns {{version:number, lastPeriodKey:string|null, lastRunAt:string|null,
 *            lastWinners:Array<object>, history:Array<object>, nextRunAt:string|null,
 *            updatedAt:string|null}} */
function emptyState() {
  return {
    version: REWARDS_VERSION,
    lastPeriodKey: null,
    lastRunAt: null,
    lastWinners: [],
    history: [],
    nextRunAt: null,
    updatedAt: null,
  };
}

/** Tolerantly rebuild persisted state (a corrupt file means "no payouts yet"). */
function normalizeState(raw) {
  const state = emptyState();
  if (!isPlainObject(raw)) return state;
  state.lastPeriodKey = typeof raw.lastPeriodKey === 'string' && raw.lastPeriodKey !== '' ? raw.lastPeriodKey : null;
  state.lastRunAt = typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null;
  state.nextRunAt = typeof raw.nextRunAt === 'string' ? raw.nextRunAt : null;
  state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  state.lastWinners = Array.isArray(raw.lastWinners) ? raw.lastWinners.filter(isPlainObject) : [];
  const history = Array.isArray(raw.history) ? raw.history.filter(isPlainObject) : [];
  state.history = history.slice(-REWARD_HISTORY_LIMIT);
  return state;
}

/** Money helper: floor to cents so a scaled payout can never exceed its cap. */
function floorCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * 100 + 1e-9) / 100;
}

/** Pick only winners that actually have a measured P&L (missing baseline => skipped). */
function eligibleRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row || typeof row !== 'object') return false;
    if (typeof row.agentId !== 'string' || row.agentId.trim() === '') return false;
    return row.pnlPct !== null && row.pnlPct !== undefined && Number.isFinite(Number(row.pnlPct));
  });
}

/** Normalize one winners/history row to the documented shape. */
function winnerRow({ rank, agentId, name, percent, amountUsd }) {
  return {
    rank: Number(rank) || 0,
    agentId: String(agentId),
    name: typeof name === 'string' && name !== '' ? name : String(agentId),
    percent: Number(percent) || 0,
    amountUsd: round2(Number(amountUsd) || 0),
  };
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * Create the rewards scheduler/state.
 *
 * @param {{
 *   paths?: { rewardsFile?: string },
 *   config?: object,
 *   clock?: { now: () => number, iso: () => string },
 * }} deps `paths` is the object from `statePaths(config)`; `config` is a fallback.
 * @returns {{
 *   load: () => Promise<object>,
 *   save: () => Promise<string>,
 *   duePeriod: (nowMs?: number|string|Date) => ({period:string, periodKey:string,
 *              completed:true, currentPeriodKey:string}|null),
 *   apply: (input: object) => Promise<object>,
 *   status: () => object,
 *   getState: () => object,
 *   reconfigure: (config?: object) => object,
 *   describe: () => object,
 *   path: string,
 * }}
 */
export function createRewards({ paths, config, clock } = {}) {
  const currentClock = clock ?? SYSTEM_CLOCK;
  const resolvedPaths = paths ?? (config ? statePaths(config) : null);
  const file = resolvedPaths?.rewardsFile
    ?? (config?.paths?.stateDir ? path.join(String(config.paths.stateDir), 'rewards.json') : null);
  if (!file) {
    fail('CONFIG_INVALID', 'createRewards requires paths.rewardsFile (from statePaths(config))');
  }
  const rewardsPath = String(file);

  let settings = resolveRewardSettings(config);
  /** @type {ReturnType<typeof emptyState>} */
  let state = emptyState();

  function anchor(nowMs) {
    state.lastPeriodKey = periodKeyFor(settings.period, nowMs);
    state.nextRunAt = isoAt(nextPeriodStartMs(settings.period, nowMs));
    return state.lastPeriodKey;
  }

  async function load() {
    const raw = await readJson(rewardsPath, null);
    state = normalizeState(raw);
    const nowMs = currentClock.now();
    if (state.lastPeriodKey === null) anchor(nowMs);
    else if (state.nextRunAt === null) state.nextRunAt = isoAt(nextPeriodStartMs(settings.period, nowMs));
    return getState();
  }

  async function save() {
    await writeJsonAtomic(rewardsPath, state);
    return rewardsPath;
  }

  function getState() {
    return cloneState(state);
  }

  /**
   * The just-completed period, or null when no period boundary has been crossed.
   * Anchors `lastPeriodKey` on first use so the initial partial period is never paid.
   *
   * @param {number|string|Date} [nowMs]
   * @returns {{period:string, periodKey:string, completed:true, currentPeriodKey:string}|null}
   */
  function duePeriod(nowMsInput) {
    const nowMs = normalizeAt(nowMsInput, currentClock);
    const currentKey = periodKeyFor(settings.period, nowMs);
    if (state.lastPeriodKey === null) {
      anchor(nowMs);
      return null;
    }
    if (!settings.enabled) return null;
    if (state.lastPeriodKey === currentKey) return null;
    return {
      period: settings.period,
      periodKey: state.lastPeriodKey,
      completed: true,
      currentPeriodKey: currentKey,
    };
  }

  /**
   * Pay the completed period's top winners. Never pays the same periodKey twice.
   *
   * `rankings` may be either:
   *   - a computed snapshot from `rankings.compute({ atMs: <boundary - 1> })`, or
   *   - the rankings module itself (has `compute()`), in which case the completed-period
   *     snapshot is resolved internally from the instant just before the boundary.
   *
   * @param {{
   *   due: {period?:string, periodKey:string, currentPeriodKey?:string},
   *   rankings: object,
   *   accountCashUsd?: number,
   *   poolUsd?: number,
   *   allocationCapRemainingUsd?: number,
   *   ledger: { transfer: Function },
   *   nowMs?: number|string|Date,
   * }} input
   * @returns {Promise<{applied:boolean, period:string, periodKey:string|null, at?:string,
   *           winners:Array<{rank:number, agentId:string, name:string, percent:number,
   *           amountUsd:number}>, skipped:boolean, reason?:string,
   *           errors?:Array<object>, nextRunAt?:string}>}
   */
  async function apply({ due, rankings, accountCashUsd, poolUsd, allocationCapRemainingUsd, ledger, nowMs: nowInput } = {}) {
    const nowMs = normalizeAt(nowInput, currentClock);
    const at = isoAt(nowMs);
    const fallbackPeriod = settings.period;
    if (!settings.enabled) {
      return { applied: false, period: fallbackPeriod, periodKey: due?.periodKey ?? null, winners: [], skipped: true, reason: 'disabled' };
    }
    if (!due || typeof due !== 'object' || typeof due.periodKey !== 'string' || due.periodKey === '') {
      fail('CONFIG_INVALID', 'rewards.apply requires the due period returned by duePeriod()', { due });
    }
    if (!ledger || typeof ledger.transfer !== 'function') {
      fail('CONFIG_INVALID', 'rewards.apply requires a ledger with transfer()');
    }
    const rankingPeriod = REWARD_PERIODS.includes(due.period) ? due.period : fallbackPeriod;
    const targetKey = typeof due.currentPeriodKey === 'string' && due.currentPeriodKey !== ''
      ? due.currentPeriodKey
      : periodKeyFor(settings.period, nowMs);

    // Idempotency: a due period is payable exactly once. apply() advances the anchor,
    // so a second call (or a retry after success) reports already_applied.
    if (state.lastPeriodKey !== null && state.lastPeriodKey !== due.periodKey) {
      return {
        applied: false,
        period: rankingPeriod,
        periodKey: due.periodKey,
        winners: [],
        skipped: true,
        reason: 'already_applied',
      };
    }

    // --- resolve the completed period's leaderboard ---------------------------
    // Rank the instant just before the completed period ended: that is where its
    // baselines and archived close are still in scope. Only fall back to "now" when the
    // key cannot be parsed (synthetic keys in tests/operator tooling).
    let snapshot = null;
    if (rankings && typeof rankings === 'object' && isPlainObject(rankings.periods)) {
      snapshot = rankings;
    } else {
      const completedEndMs = periodKeyEndMs(rankingPeriod, due.periodKey);
      const rankAtMs = (Number.isFinite(completedEndMs)
        ? completedEndMs
        : periodStartMs(rankingPeriod, nowMs)) - 1;
      if (rankings && typeof rankings.compute === 'function') {
        snapshot = rankings.compute({ atMs: Math.max(0, rankAtMs), stored: true });
      } else if (typeof rankings === 'function') {
        snapshot = rankings({ atMs: Math.max(0, rankAtMs), stored: true });
      }
    }
    const rows = eligibleRows(snapshot?.periods?.[rankingPeriod]);

    // --- caps: account cash basis, then pool / allocation cap / max per period --
    const cashUsd = Number(accountCashUsd);
    const basisCashUsd = Number.isFinite(cashUsd) && cashUsd > 0 ? round2(cashUsd) : 0;
    const poolAvailableUsd = Number.isFinite(Number(poolUsd)) ? Math.max(0, Number(poolUsd)) : 0;
    const allocationAvailableUsd = Number.isFinite(Number(allocationCapRemainingUsd))
      ? Math.max(0, Number(allocationCapRemainingUsd))
      : Infinity;
    const maxPerPeriodUsd = settings.maxPerPeriodUsd === null ? Infinity : Math.max(0, settings.maxPerPeriodUsd);
    const availableUsd = Math.max(0, Math.min(poolAvailableUsd, allocationAvailableUsd, maxPerPeriodUsd));

    const candidates = rows.slice(0, settings.rankPercents.length).map((row, index) => {
      const percent = settings.rankPercents[index] ?? 0;
      return {
        rank: index + 1,
        agentId: String(row.agentId),
        name: typeof row.name === 'string' && row.name !== '' ? row.name : String(row.agentId),
        percent,
        requestedUsd: round2(basisCashUsd * percent),
      };
    });
    const totalRequestedUsd = round2(candidates.reduce((sum, candidate) => sum + candidate.requestedUsd, 0));
    // Insufficient pool/cap => scale every winner proportionally (never exceed the cap).
    const scale = totalRequestedUsd > availableUsd && totalRequestedUsd > 0
      ? availableUsd / totalRequestedUsd
      : 1;
    const planned = candidates.map((candidate) => winnerRow({
      ...candidate,
      amountUsd: floorCents(candidate.requestedUsd * scale),
    }));

    // --- pay ------------------------------------------------------------------
    const paid = [];
    const errors = [];
    for (const winner of planned) {
      if (!(winner.amountUsd > 0)) {
        paid.push(winner);
        continue;
      }
      try {
        await ledger.transfer(TREASURY_ID, winner.agentId, winner.amountUsd, {
          reason: 'reward',
          category: 'reward',
          at: nowMs,
        });
        paid.push(winner);
      } catch (error) {
        errors.push({
          agentId: winner.agentId,
          code: error?.code ?? 'ERROR',
          message: String(error?.message ?? error).slice(0, 160),
        });
        paid.push({ ...winner, amountUsd: 0 });
      }
    }
    const skipped = paid.every((winner) => !(winner.amountUsd > 0));

    // --- record history + advance the period anchor ---------------------------
    /** @type {object} */
    const historyEntry = {
      period: rankingPeriod,
      periodKey: due.periodKey,
      at,
      winners: paid.map((winner) => winnerRow(winner)),
    };
    if (skipped) historyEntry.skipped = true;
    if (errors.length > 0) historyEntry.errors = errors;
    state.history.push(historyEntry);
    if (state.history.length > REWARD_HISTORY_LIMIT) state.history = state.history.slice(-REWARD_HISTORY_LIMIT);
    state.lastPeriodKey = targetKey;
    state.lastRunAt = at;
    state.lastWinners = historyEntry.winners.map((winner) => ({ ...winner, periodKey: due.periodKey, at }));
    state.nextRunAt = isoAt(nextPeriodStartMs(settings.period, nowMs));
    state.updatedAt = at;
    await save();

    /** @type {object} */
    const result = {
      applied: true,
      period: rankingPeriod,
      periodKey: due.periodKey,
      at,
      winners: paid,
      skipped,
      nextRunAt: state.nextRunAt,
    };
    if (errors.length > 0) result.errors = errors;
    return result;
  }

  /**
   * Current scheduler settings + last payout, for the engine status payload.
   * @returns {{enabled:boolean, period:string, rankPercents:number[], basis:string,
   *            lastRunAt:string|null, nextRunAt:string|null, lastWinners:Array<object>,
   *            historyCount:number, lastPeriodKey:string|null}}
   */
  function status() {
    const nowMs = currentClock.now();
    const currentKey = periodKeyFor(settings.period, nowMs);
    const nextRunAt = state.lastPeriodKey === currentKey || state.nextRunAt === null
      ? isoAt(nextPeriodStartMs(settings.period, nowMs))
      : state.nextRunAt;
    return {
      enabled: settings.enabled,
      period: settings.period,
      rankPercents: [...settings.rankPercents],
      basis: settings.basis,
      lastRunAt: state.lastRunAt,
      nextRunAt,
      lastWinners: cloneState(state.lastWinners),
      historyCount: state.history.length,
      lastPeriodKey: state.lastPeriodKey,
    };
  }

  /** Re-resolve settings from a new config (control-panel live update) and re-anchor. */
  function reconfigure(nextConfig) {
    settings = resolveRewardSettings(nextConfig ?? config);
    anchor(currentClock.now());
    state.updatedAt = isoAt(currentClock.now());
    return status();
  }

  return {
    load,
    save,
    duePeriod,
    apply,
    status,
    getState,
    reconfigure,
    describe() {
      return {
        role: 'rewards',
        ...status(),
        history: state.history.slice(-5),
        path: rewardsPath,
      };
    },
    get path() {
      return rewardsPath;
    },
  };
}

export default createRewards;
