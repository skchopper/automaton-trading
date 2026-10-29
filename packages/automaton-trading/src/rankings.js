/**
 * RANKINGS — deterministic, persisted daily / weekly / monthly leaderboards.
 *
 * Pure bookkeeping for the operator control panel: it observes per-agent equity and
 * computes period P&L against the equity observed at the start of the period. It never
 * trades, never moves money, and never reads the broker.
 *
 * Baseline semantics (docs/CONTROL-PANEL.md § "Rankings module"):
 *   - the FIRST observation of an agent in a period sets that period's baseline;
 *   - when a new period starts, the PREVIOUS period's last observed equity is carried
 *     forward as the new baseline, so a period's return is measured from start-of-period
 *     equity even though observations are sampled every tick;
 *   - without a baseline for the current period the entry is ranked last with
 *     `pnlPct: null` / `pnlUsd: null` (never a fabricated number).
 *
 * Determinism: time comes from the injected clock (or explicit `atMs`); there is no
 * `Date.now()`, no `Math.random()`, and no locale-dependent comparison. Persistence is
 * an atomic JSON write to `stateDir/rankings.json`.
 *
 * Contract: docs/CONTROL-PANEL.md § "Rankings module". Owner: market teammate.
 *
 * @module rankings
 */

import path from 'node:path';
import { fail } from './contracts.js';
import { statePaths } from './config.js';
import { readJson, round, round2, SYSTEM_CLOCK, writeJsonAtomic } from './util.js';

/** Periods the control panel exposes. */
export const PERIODS = Object.freeze(['daily', 'weekly', 'monthly']);

export const RANKINGS_VERSION = 1;

/** Keep percent fractions exact enough for stable tie-breaking. */
const PCT_DECIMALS = 6;

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

// ---------------------------------------------------------------------------
// period key helpers (exported for rewards.js and for tests)
// ---------------------------------------------------------------------------

function utcParts(atMs) {
  const date = new Date(atMs);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
}

/** UTC day key `YYYY-MM-DD` (e.g. `2026-10-29`). */
export function utcDateKey(atMs) {
  const { year, month, day } = utcParts(atMs);
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** ISO-8601 week key `YYYY-Www`, weeks starting Monday (e.g. `2026-W44`). */
export function isoWeekKey(atMs) {
  const date = new Date(atMs);
  // ISO week = the week containing the Thursday; move to that Thursday first.
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDay = thursday.getUTCDay() || 7; // Mon=1 .. Sun=7
  thursday.setUTCDate(thursday.getUTCDate() + 4 - isoDay);
  const weekYear = thursday.getUTCFullYear();
  const yearStart = Date.UTC(weekYear, 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

/** UTC month key `YYYY-MM` (e.g. `2026-10`). */
export function utcMonthKey(atMs) {
  const { year, month } = utcParts(atMs);
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * The current key of every period at one instant.
 * @param {number} atMs epoch ms
 * @returns {{daily:string, weekly:string, monthly:string}}
 */
export function periodKeys(atMs) {
  return {
    daily: utcDateKey(atMs),
    weekly: isoWeekKey(atMs),
    monthly: utcMonthKey(atMs),
  };
}

/**
 * The key of one named period at one instant.
 * @param {'daily'|'weekly'|'monthly'} period
 * @param {number} atMs epoch ms
 * @returns {string}
 */
export function periodKeyFor(period, atMs) {
  if (period === 'daily') return utcDateKey(atMs);
  if (period === 'weekly') return isoWeekKey(atMs);
  if (period === 'monthly') return utcMonthKey(atMs);
  fail('CONFIG_INVALID', `unknown rankings period "${period}"`, { period });
  return '';
}

/**
 * First boundary strictly after `atMs` for the given period (UTC).
 * Used by the rewards scheduler for `nextRunAt`.
 * @param {'daily'|'weekly'|'monthly'} period
 * @param {number} atMs epoch ms
 * @returns {number} epoch ms of the next boundary
 */
export function nextPeriodStartMs(period, atMs) {
  const { year, month, day } = utcParts(atMs);
  if (period === 'daily') return Date.UTC(year, month, day + 1);
  if (period === 'monthly') return Date.UTC(year, month + 1, 1);
  if (period === 'weekly') {
    const isoDay = new Date(Date.UTC(year, month, day)).getUTCDay() || 7; // Mon=1 .. Sun=7
    const addDays = (8 - isoDay) % 7 || 7; // next Monday, never today
    return Date.UTC(year, month, day + addDays);
  }
  fail('CONFIG_INVALID', `unknown rankings period "${period}"`, { period });
  return atMs;
}

/**
 * Start (UTC epoch ms) of the period containing `atMs`.
 * @param {'daily'|'weekly'|'monthly'} period
 * @param {number} atMs epoch ms
 * @returns {number}
 */
export function periodStartMs(period, atMs) {
  const { year, month, day } = utcParts(atMs);
  if (period === 'daily') return Date.UTC(year, month, day);
  if (period === 'monthly') return Date.UTC(year, month, 1);
  if (period === 'weekly') {
    const isoDay = new Date(Date.UTC(year, month, day)).getUTCDay() || 7; // Mon=1 .. Sun=7
    return Date.UTC(year, month, day - (isoDay - 1));
  }
  fail('CONFIG_INVALID', `unknown rankings period "${period}"`, { period });
  return atMs;
}

/**
 * Exclusive end (the next period's start) of a period key, or null when the key is
 * malformed. Used by rewards to rank a *completed* period after its boundary passed.
 * @param {'daily'|'weekly'|'monthly'} period
 * @param {string} key
 * @returns {number|null}
 */
export function periodKeyEndMs(period, key) {
  const text = String(key ?? '');
  if (period === 'daily') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return null;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
  }
  if (period === 'monthly') {
    const match = /^(\d{4})-(\d{2})$/.exec(text);
    if (!match) return null;
    const monthIndex = Number(match[2]) - 1;
    if (monthIndex < 0 || monthIndex > 11) return null;
    return Date.UTC(Number(match[1]), monthIndex + 1, 1);
  }
  if (period === 'weekly') {
    const match = /^(\d{4})-W(\d{2})$/.exec(text);
    if (!match) return null;
    const year = Number(match[1]);
    const week = Number(match[2]);
    if (week < 1 || week > 53) return null;
    const jan4 = Date.UTC(year, 0, 4);
    const jan4IsoDay = new Date(jan4).getUTCDay() || 7;
    const week1Monday = jan4 - (jan4IsoDay - 1) * 86_400_000;
    return week1Monday + week * 7 * 86_400_000;
  }
  return null;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/** @returns {{version:number, updatedAt:string|null, agents:Record<string, object>}} */
function emptyState() {
  return { version: RANKINGS_VERSION, updatedAt: null, agents: {} };
}

/** Tolerantly rebuild persisted state; a corrupt file simply means "no history yet". */
function normalizeState(raw) {
  const state = emptyState();
  if (!isPlainObject(raw)) return state;
  state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  const agents = isPlainObject(raw.agents) ? raw.agents : {};
  for (const [rawId, rawAgent] of Object.entries(agents)) {
    const agentId = String(rawId ?? '').trim();
    if (!agentId || !isPlainObject(rawAgent)) continue;
    /**
     * baseline/last describe the CURRENT period; previousBaseline/previousLast archive
     * the last completed period so a payout can rank it after the boundary rolled over.
     * @type {{name:string, baseline:Record<string, object>, last:Record<string, object>,
     *         previousBaseline:Record<string, object>, previousLast:Record<string, object>}}
     */
    const agent = {
      name: typeof rawAgent.name === 'string' ? rawAgent.name : agentId,
      baseline: {},
      last: {},
      previousBaseline: {},
      previousLast: {},
    };
    for (const period of PERIODS) {
      const baseline = rawAgent.baseline?.[period];
      if (isPlainObject(baseline) && typeof baseline.key === 'string' && Number.isFinite(Number(baseline.equityUsd))) {
        agent.baseline[period] = { key: baseline.key, equityUsd: round2(Number(baseline.equityUsd)) };
      }
      const last = rawAgent.last?.[period];
      if (isPlainObject(last) && typeof last.key === 'string' && Number.isFinite(Number(last.equityUsd))) {
        agent.last[period] = {
          key: last.key,
          equityUsd: round2(Number(last.equityUsd)),
          trades: Math.max(0, Math.trunc(Number(last.trades) || 0)),
          atMs: Number.isFinite(Number(last.atMs)) ? Math.round(Number(last.atMs)) : null,
        };
      }
      const previousBaseline = rawAgent.previousBaseline?.[period];
      if (
        isPlainObject(previousBaseline)
        && typeof previousBaseline.key === 'string'
        && Number.isFinite(Number(previousBaseline.equityUsd))
      ) {
        agent.previousBaseline[period] = {
          key: previousBaseline.key,
          equityUsd: round2(Number(previousBaseline.equityUsd)),
        };
      }
      const previousLast = rawAgent.previousLast?.[period];
      if (isPlainObject(previousLast) && typeof previousLast.key === 'string' && Number.isFinite(Number(previousLast.equityUsd))) {
        agent.previousLast[period] = {
          key: previousLast.key,
          equityUsd: round2(Number(previousLast.equityUsd)),
          trades: Math.max(0, Math.trunc(Number(previousLast.trades) || 0)),
          atMs: Number.isFinite(Number(previousLast.atMs)) ? Math.round(Number(previousLast.atMs)) : null,
        };
      }
    }
    state.agents[agentId] = agent;
  }
  return state;
}

/** Deep clone of plain JSON-safe state. */
function cloneState(state) {
  try {
    return structuredClone(state);
  } catch {
    return JSON.parse(JSON.stringify(state));
  }
}

/** Deterministic string comparison (no locale/ICU dependence). */
function compareText(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Leaderboard ordering: measured entries first by pnlPct desc, then pnlUsd desc, then
 * name asc. Entries without a baseline (pnlPct null) always sort last (name asc).
 */
export function compareRankedEntries(a, b) {
  const aMissing = a.pnlPct === null || a.pnlPct === undefined;
  const bMissing = b.pnlPct === null || b.pnlPct === undefined;
  if (aMissing !== bMissing) return aMissing ? 1 : -1;
  if (!aMissing && b.pnlPct !== a.pnlPct) return b.pnlPct - a.pnlPct;
  const aPnl = Number.isFinite(a.pnlUsd) ? a.pnlUsd : -Infinity;
  const bPnl = Number.isFinite(b.pnlUsd) ? b.pnlUsd : -Infinity;
  if (aPnl !== bPnl) return bPnl - aPnl;
  return compareText(a.name, b.name) || compareText(a.agentId, b.agentId);
}

/** @returns {{name:string|null, equityUsd:number, trades:number}|null} */
function normalizeObservation(raw) {
  if (!isPlainObject(raw)) return null;
  const equityUsd = Number(raw.equityUsd);
  if (!Number.isFinite(equityUsd)) return null;
  const trades = Number(raw.trades);
  return {
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : null,
    equityUsd: round2(equityUsd),
    trades: Number.isFinite(trades) ? Math.max(0, Math.trunc(trades)) : 0,
  };
}

/**
 * Create the persisted rankings book.
 *
 * @param {{
 *   paths?: { rankings?: string },
 *   config?: object,
 *   clock?: { now: () => number, iso: () => string },
 * }} deps `paths` is the object from `statePaths(config)`; `config` is only a fallback.
 * @returns {{
 *   load: () => Promise<object>,
 *   save: () => Promise<string>,
 *   record: (input: {atMs?: number|string|Date, equityByAgent?: Record<string, object>}) => Promise<object>,
 *   compute: (input: {atMs?: number|string|Date, equityByAgent?: Record<string, object>}) => object,
 *   getState: () => object,
 *   describe: () => object,
 *   path: string,
 * }}
 */
export function createRankings({ paths, config, clock } = {}) {
  const currentClock = clock ?? SYSTEM_CLOCK;
  const resolvedPaths = paths ?? (config ? statePaths(config) : null);
  const file = resolvedPaths?.rankings
    ?? (config?.paths?.stateDir ? path.join(String(config.paths.stateDir), 'rankings.json') : null);
  if (!file) {
    fail('CONFIG_INVALID', 'createRankings requires paths.rankings (from statePaths(config))');
  }
  const rankingsPath = String(file);

  /** @type {ReturnType<typeof emptyState>} */
  let state = emptyState();

  async function load() {
    const raw = await readJson(rankingsPath, null);
    state = normalizeState(raw);
    return cloneState(state);
  }

  async function save() {
    await writeJsonAtomic(rankingsPath, state);
    return rankingsPath;
  }

  function getState() {
    return cloneState(state);
  }

  /**
   * Store this tick's observations: set the period baseline on the first observation of
   * a period (carrying the previous period's last equity forward) and refresh the last
   * observed equity for the current period. Persists immediately.
   *
   * Synchronous mutation + async persist: the in-memory state is ready for an immediate
   * `compute()` even if the caller does not await the returned promise.
   *
   * @param {{atMs?: number|string|Date, equityByAgent?: Record<string, object>}} [input]
   * @returns {Promise<object>} the updated persisted state
   */
  async function record({ atMs, equityByAgent } = {}) {
    const nowMs = normalizeAt(atMs, currentClock);
    const at = new Date(nowMs).toISOString();
    const keys = periodKeys(nowMs);
    const observations = isPlainObject(equityByAgent) ? equityByAgent : {};
    let changed = false;
    for (const [rawId, rawObs] of Object.entries(observations)) {
      const agentId = String(rawId ?? '').trim();
      if (!agentId) continue;
      const observation = normalizeObservation(rawObs);
      if (!observation) continue;
      const existing = state.agents[agentId];
      /**
       * @type {{name:string, baseline:Record<string, object>, last:Record<string, object>,
       *         previousBaseline:Record<string, object>, previousLast:Record<string, object>}}
       */
      const agent = existing ?? {
        name: agentId,
        baseline: {},
        last: {},
        previousBaseline: {},
        previousLast: {},
      };
      agent.baseline = agent.baseline ?? {};
      agent.last = agent.last ?? {};
      agent.previousBaseline = agent.previousBaseline ?? {};
      agent.previousLast = agent.previousLast ?? {};
      if (observation.name) agent.name = observation.name;
      for (const period of PERIODS) {
        const key = keys[period];
        const baseline = agent.baseline[period];
        if (!baseline || baseline.key !== key) {
          // A new period (or the first ever observation): archive the completed period
          // for late ranking, then carry the previous period's last observed equity
          // forward so this period is measured from its start.
          const priorLast = agent.last[period];
          if (baseline) {
            agent.previousBaseline[period] = { key: baseline.key, equityUsd: round2(baseline.equityUsd) };
          }
          if (priorLast) {
            agent.previousLast[period] = {
              key: priorLast.key,
              equityUsd: round2(priorLast.equityUsd),
              trades: priorLast.trades,
              atMs: priorLast.atMs,
            };
          }
          const carried = priorLast?.equityUsd;
          agent.baseline[period] = {
            key,
            equityUsd: round2(Number.isFinite(carried) ? carried : observation.equityUsd),
          };
        }
        agent.last[period] = {
          key,
          equityUsd: observation.equityUsd,
          trades: observation.trades,
          atMs: nowMs,
        };
      }
      state.agents[agentId] = agent;
      changed = true;
    }
    if (changed) state.updatedAt = at;
    await save();
    return getState();
  }

  /**
   * Rank agents in every period.
   *
   * - With `equityByAgent` (normal use: the orchestrator passes the living population),
   *   only those agents are listed; a missing current-period baseline means null P&L
   *   and last place.
   * - `stored: true` (used by the rewards scheduler) ranks from the stored observations
   *   instead, including the archived close of the just-completed period, so a payout
   *   can rank the period that just ended even after the boundary rolled a baseline over.
   *
   * @param {{atMs?: number|string|Date, equityByAgent?: Record<string, object>,
   *          stored?: boolean}} [input]
   * @returns {{asOf:string, periodKeys:{daily:string,weekly:string,monthly:string},
   *            periods:{daily:Array<object>, weekly:Array<object>, monthly:Array<object>}}}
   */
  function compute({ atMs, equityByAgent, stored = false } = {}) {
    const nowMs = normalizeAt(atMs, currentClock);
    const keys = periodKeys(nowMs);
    const hasObservations = isPlainObject(equityByAgent);
    const observations = hasObservations ? equityByAgent : {};
    const agentIds = hasObservations ? Object.keys(observations) : stored ? Object.keys(state.agents) : [];
    /** @type {Record<string, Array<object>>} */
    const periods = { daily: [], weekly: [], monthly: [] };
    for (const period of PERIODS) {
      const currentKey = keys[period];
      const rows = [];
      for (const rawId of agentIds) {
        const agentId = String(rawId ?? '').trim();
        if (!agentId) continue;
        const observation = hasObservations ? normalizeObservation(observations[rawId]) : null;
        if (hasObservations && !observation) continue;
        const agentState = state.agents[agentId];
        const baseline = agentState?.baseline?.[period];
        const last = agentState?.last?.[period];
        const archivedBaseline = agentState?.previousBaseline?.[period];
        const archivedLast = agentState?.previousLast?.[period];
        const archivedView = Boolean(
          archivedBaseline
          && archivedLast
          && archivedBaseline.key === currentKey
          && archivedLast.key === currentKey,
        );
        const currentView = Boolean(
          baseline
          && baseline.key === currentKey
          && Number.isFinite(Number(baseline.equityUsd)),
        );
        if (!hasObservations && !archivedView && !currentView) continue; // never observed in this period
        let equityUsd;
        let trades;
        let baselineEquityUsd = null;
        if (archivedView) {
          // The period just completed: its archived close is authoritative, so the
          // ranking cannot drift with observations made after the boundary.
          equityUsd = archivedLast.equityUsd;
          trades = archivedLast.trades;
          baselineEquityUsd = round2(archivedBaseline.equityUsd);
        } else if (currentView) {
          equityUsd = observation?.equityUsd ?? last?.equityUsd;
          trades = observation?.trades ?? last?.trades ?? 0;
          baselineEquityUsd = round2(baseline.equityUsd);
        } else {
          equityUsd = observation?.equityUsd ?? last?.equityUsd;
          trades = observation?.trades ?? last?.trades ?? 0;
        }
        if (!Number.isFinite(equityUsd)) continue;
        const pnlUsd = baselineEquityUsd === null ? null : round2(equityUsd - baselineEquityUsd);
        const pnlPct = baselineEquityUsd !== null && baselineEquityUsd > 0
          ? round((equityUsd - baselineEquityUsd) / baselineEquityUsd, PCT_DECIMALS)
          : null;
        rows.push({
          agentId,
          name: observation?.name ?? agentState?.name ?? agentId,
          equityUsd: round2(equityUsd),
          baselineEquityUsd,
          pnlUsd,
          pnlPct,
          trades,
        });
      }
      rows.sort(compareRankedEntries);
      periods[period] = rows.map((row, index) => ({ rank: index + 1, ...row }));
    }
    return { asOf: new Date(nowMs).toISOString(), periodKeys: keys, periods };
  }

  return {
    load,
    save,
    record,
    compute,
    getState,
    describe() {
      return {
        role: 'rankings',
        periods: [...PERIODS],
        asOf: state.updatedAt,
        agents: Object.keys(state.agents).length,
        path: rankingsPath,
      };
    },
    get path() {
      return rankingsPath;
    },
  };
}

export default createRankings;
