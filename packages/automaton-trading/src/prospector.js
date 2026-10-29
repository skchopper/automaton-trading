/**
 * PROSPECTOR — demand discovery from market data, with DATED PROOF.
 *
 * Stopline (architecture §2): the Prospector never places an order, never sizes a
 * position, never touches the wallet. Its only product is a hypothesis whose claim is
 * backed by a measured statistic and the exact data request URL it was measured from.
 * "A link or nothing": a hypothesis without proof is never returned.
 *
 * Four long-only families are scanned (the trading mandate forbids shorting):
 *   momentum   — buy after a strong positive multi-bar momentum z-score
 *   meanrev    — buy when price is stretched below its rolling mean
 *   breakout   — buy when the close breaks the prior N-bar high
 *   gapfade    — buy an opening gap down, betting on the fade back up
 *
 * Determinism: bars come from the injected broker (sim is seeded), time from the
 * injected clock, ids from a content hash. No network in tests, no wall-clock reads.
 *
 * Contract: docs/CONTRACTS.md § "Data feed / market helpers". Owner: market teammate.
 *
 * @module prospector
 */

import { fail } from './contracts.js';
import { statePaths } from './config.js';
import {
  appendJsonl,
  mean,
  readJson,
  round2,
  round4,
  SYSTEM_CLOCK,
  writeJsonAtomic,
} from './util.js';

/** Estimated round-trip friction (bp) used only to rank hypotheses by edge/cost. */
export const ESTIMATED_COST_BPS = 12;

/** Minimum measured samples before a statistic is allowed to become a claim. */
export const MIN_SAMPLE_SIZE = 5;

/** Maximum number of hypotheses retained in the queue file. */
export const HYPOTHESIS_QUEUE_LIMIT = 200;

const FAMILY_CONFIG = Object.freeze({
  momentum: { window: 5, zEntry: 1.0, horizonBars: 3 },
  meanrev: { window: 10, zEntry: 1.0, horizonBars: 3 },
  breakout: { window: 20, zEntry: 0, horizonBars: 3 },
  gapfade: { window: 1, zEntry: 0, horizonBars: 2 },
});

/** Default parameter vectors hinted by family (Builder validates/clamps them). */
const FAMILY_SPECS = Object.freeze({
  momentum: { lookback: 60, entryZ: 1.0, exitZ: 0.5, stopPct: 0.02, targetPct: 0.04, maxHoldBars: 12, sizePct: 0.2, sessionFilter: 'any' },
  meanrev: { lookback: 40, entryZ: 1.2, exitZ: 0.3, stopPct: 0.025, targetPct: 0.03, maxHoldBars: 8, sizePct: 0.2, sessionFilter: 'any' },
  breakout: { lookback: 80, entryZ: 1.5, exitZ: 0.5, stopPct: 0.03, targetPct: 0.06, maxHoldBars: 16, sizePct: 0.2, sessionFilter: 'any' },
  gapfade: { lookback: 30, entryZ: 1.0, exitZ: 0.5, stopPct: 0.015, targetPct: 0.025, maxHoldBars: 6, sizePct: 0.15, sessionFilter: 'any' },
});

/** FNV-1a hash for deterministic ids. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function meanStd(values) {
  if (!Array.isArray(values) || values.length === 0) return { mean: 0, std: 0 };
  const avg = mean(values);
  let variance = 0;
  for (const value of values) variance += (value - avg) ** 2;
  return { mean: avg, std: Math.sqrt(variance / values.length) };
}

function normalizeBars(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const t = typeof raw.t === 'number'
      ? raw.t
      : typeof raw.t === 'string'
        ? Date.parse(raw.t)
        : NaN;
    const o = Number(raw.o);
    const h = Number(raw.h);
    const l = Number(raw.l);
    const c = Number(raw.c);
    const v = Number(raw.v ?? 0);
    if (!Number.isFinite(o) || !Number.isFinite(c) || c <= 0) continue;
    out.push({
      t: Number.isFinite(t) ? t : null,
      o,
      h: Number.isFinite(h) ? h : Math.max(o, c),
      l: Number.isFinite(l) ? l : Math.min(o, c),
      c,
      v: Number.isFinite(v) ? v : 0,
    });
  }
  out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  return out;
}

/** Forward return in bps from `entryPrice` at bar i to bar i+horizon. */
function forwardBps(bars, index, horizon, entryPrice) {
  const exitIndex = Math.min(bars.length - 1, index + horizon);
  if (exitIndex <= index || !(entryPrice > 0)) return null;
  return ((bars[exitIndex].c - entryPrice) / entryPrice) * 10_000;
}

/**
 * Compute one family's measured statistic over a symbol's bars.
 * @returns {{family:string, metric:string, meanBps:number, baselineBps:number, sampleSize:number,
 *            tStat:number, expectedEdgeBps:number, horizonBars:number, entryZ:number,
 *            rankScore:number}|null}
 */
function measureFamily(family, bars, params = {}) {
  const cfg = FAMILY_CONFIG[family];
  const horizon = cfg.horizonBars;
  const n = bars.length;
  if (n < 30) return null;

  /** @type {number[]} */
  const samples = [];
  /** @type {number[]} */
  const baseline = [];
  let entryThreshold = cfg.zEntry;
  let metric = '';

  if (family === 'momentum' || family === 'meanrev') {
    const window = cfg.window;
    /** @type {number[]} */
    const raw = [];
    for (let i = window; i < n - 1; i += 1) {
      if (family === 'momentum') {
        raw.push(bars[i].c / bars[i - window].c - 1);
      } else {
        let sum = 0;
        for (let k = i - window + 1; k <= i; k += 1) sum += bars[k].c;
        const sma = sum / window;
        let variance = 0;
        for (let k = i - window + 1; k <= i; k += 1) variance += (bars[k].c - sma) ** 2;
        const std = Math.sqrt(variance / window);
        raw.push(std > 0 ? (bars[i].c - sma) / std : 0);
      }
    }
    const { mean: avg, std } = meanStd(raw);
    for (let idx = 0; idx < raw.length; idx += 1) {
      const i = window + idx;
      const z = std > 0 ? (raw[idx] - avg) / std : 0;
      const fwd = forwardBps(bars, i, horizon, bars[i].c);
      if (fwd === null) continue;
      baseline.push(fwd);
      const signal = family === 'momentum' ? z >= entryThreshold : z <= -entryThreshold;
      if (signal) samples.push(fwd);
    }
    metric = family === 'momentum'
      ? `momentum z>=${entryThreshold.toFixed(2)} -> ${horizon}-bar forward return bps`
      : `mean-reversion z<=-${entryThreshold.toFixed(2)} -> ${horizon}-bar forward return bps`;
  } else if (family === 'breakout') {
    const window = cfg.window;
    for (let i = window; i < n - 1; i += 1) {
      let priorHigh = -Infinity;
      for (let k = i - window; k < i; k += 1) priorHigh = Math.max(priorHigh, bars[k].h);
      const fwd = forwardBps(bars, i, horizon, bars[i].c);
      if (fwd === null) continue;
      baseline.push(fwd);
      if (bars[i].c > priorHigh * 1.0002) samples.push(fwd);
    }
    metric = `close breaks prior ${window}-bar high -> ${horizon}-bar forward return bps`;
  } else if (family === 'gapfade') {
    const gapThreshold = 0.002; // 20 bps opening gap down
    for (let i = 1; i < n - 1; i += 1) {
      const priorClose = bars[i - 1].c;
      const gap = (bars[i].o - priorClose) / priorClose;
      const fwd = forwardBps(bars, i, horizon, bars[i].o);
      if (fwd === null) continue;
      baseline.push(fwd);
      if (gap <= -gapThreshold) samples.push(fwd);
    }
    metric = `open gap down >= 20bps -> ${horizon}-bar fade bps (entry at open)`;
  } else {
    return null;
  }

  if (samples.length < MIN_SAMPLE_SIZE || baseline.length === 0) return null;
  const sampleStats = meanStd(samples);
  const baselineMean = mean(baseline);
  const meanBps = round2(sampleStats.mean);
  const baselineBps = round2(baselineMean);
  const expectedEdgeBps = round2(meanBps - baselineBps);
  const tStat = sampleStats.std > 0
    ? round2((sampleStats.mean / sampleStats.std) * Math.sqrt(samples.length))
    : 0;
  return {
    family,
    metric,
    meanBps,
    baselineBps,
    sampleSize: samples.length,
    tStat,
    expectedEdgeBps,
    horizonBars: horizon,
    entryZ: family === 'momentum' || family === 'meanrev' ? entryThreshold + 0.5 : 1.0,
    rankScore: round4(expectedEdgeBps / ESTIMATED_COST_BPS),
    params,
  };
}

/** Rank a list of measured families, best first (deterministic tie-breaks). */
function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    if (b.expectedEdgeBps !== a.expectedEdgeBps) return b.expectedEdgeBps - a.expectedEdgeBps;
    return String(a.symbol).localeCompare(String(b.symbol));
  });
}

function buildClaim(family, symbol, stats, horizonBars) {
  if (family === 'breakout') {
    return `Buy ${symbol} when its close breaks the prior 20-bar high; measured continuation ${stats.meanBps.toFixed(1)}bps vs ${stats.baselineBps.toFixed(1)}bps baseline over ${horizonBars} bars.`;
  }
  if (family === 'momentum') {
    return `Buy ${symbol} when its 5-bar momentum z-score is at least ${(stats.entryZ ?? 1).toFixed(2)}; measured edge ${stats.meanBps.toFixed(1)}bps vs ${stats.baselineBps.toFixed(1)}bps baseline over ${horizonBars} bars.`;
  }
  if (family === 'meanrev') {
    return `Buy ${symbol} when it trades at least ${(stats.entryZ ?? 1).toFixed(2)} sigma below its 10-bar mean; measured bounce ${stats.meanBps.toFixed(1)}bps vs ${stats.baselineBps.toFixed(1)}bps baseline over ${horizonBars} bars.`;
  }
  return `Buy ${symbol} after an opening gap down of at least 20bps; measured fade ${stats.meanBps.toFixed(1)}bps vs ${stats.baselineBps.toFixed(1)}bps baseline over ${horizonBars} bars.`;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   broker: object,
 *   config: object,
 *   journal?: object,
 *   clock?: { now: () => number, iso: () => string },
 *   paths?: { hypothesesQueue?: string, hypothesesLog?: string },
 * }} deps
 * @returns {{ run: (opts?: { budgetUsd?: number }) => Promise<object>, describe: () => object }}
 */
export function createProspector({ broker, config, journal, clock, paths } = {}) {
  if (!broker || typeof broker.getBars !== 'function') {
    fail('CONFIG_INVALID', 'createProspector requires a broker with getBars()');
  }
  if (!config || typeof config !== 'object') {
    fail('CONFIG_INVALID', 'createProspector requires config');
  }
  const now = clock ?? SYSTEM_CLOCK;
  const resolvedPaths = paths ?? statePaths(config);
  const queueFile = resolvedPaths.hypothesesQueue;
  const logFile = resolvedPaths.hypothesesLog;
  const symbols = Array.isArray(config.symbols) ? config.symbols : [];
  const lookbackBars = config.data?.lookbackBars ?? 120;
  const maxHypotheses = config.data?.maxHypothesesPerCycle ?? 3;
  const dataPerCycleUsd = config.burn?.dataPerCycleUsd ?? 0.005;
  const mode = config.mode ?? 'paper';

  const dataUrlFor = (symbol) => {
    const params = {
      symbols: [symbol],
      timeframe: config.data?.timeframe ?? '1Hour',
      limit: lookbackBars,
      adjustment: 'raw',
      feed: 'iex',
    };
    if (typeof broker.getDataUrl === 'function') return broker.getDataUrl(params);
    // Honest fallback: the Alpaca endpoint the same params would hit.
    return `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(params.timeframe)}&limit=${lookbackBars}&adjustment=raw&feed=iex`;
  };

  async function persist(hypotheses) {
    if (hypotheses.length === 0 || !queueFile) return;
    try {
      const existing = await readJson(queueFile, []);
      const queue = Array.isArray(existing) ? existing : [];
      const merged = [...hypotheses, ...queue].slice(0, HYPOTHESIS_QUEUE_LIMIT);
      await writeJsonAtomic(queueFile, merged);
      if (logFile) {
        for (const hypothesis of hypotheses) await appendJsonl(logFile, hypothesis);
      }
    } catch (error) {
      // Persistence failure must not lose an otherwise valid hypothesis this cycle;
      // it is surfaced in `rejected` so the orchestrator trace shows it.
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        automatonPersistFailure: true,
      });
    }
  }

  async function run({ budgetUsd } = {}) {
    const atMs = now.now();
    const at = new Date(atMs).toISOString();
    const budget = Number(budgetUsd);
    const effectiveBudget = Number.isFinite(budget) ? budget : Infinity;
    const rejected = [];

    if (symbols.length === 0) fail('CONFIG_INVALID', 'prospector has no configured symbols');
    if (effectiveBudget < dataPerCycleUsd) {
      return {
        at,
        dataCalls: 0,
        spentUsd: 0,
        hypotheses: [],
        rejected: [{ reason: 'BUDGET_EXCEEDED', detail: `budget ${effectiveBudget} < data cost ${dataPerCycleUsd}` }],
      };
    }

    // One multi-symbol request per cycle: the population shares this data fetch.
    const barsBySymbol = await broker.getBars({
      symbols,
      timeframe: config.data?.timeframe ?? '1Hour',
      feed: config.data?.feed ?? 'iex',
      limit: lookbackBars,
    });
    const dataCalls = 1;
    const spentUsd = round4(Math.min(dataPerCycleUsd, effectiveBudget));

    /** @type {Array<object>} */
    const candidates = [];
    for (const symbol of symbols) {
      const bars = normalizeBars(barsBySymbol?.[symbol]);
      if (bars.length < 30) {
        rejected.push({ reason: 'DATA_MISSING', detail: `${symbol}: ${bars.length} usable bars` });
        continue;
      }
      /** @type {object[]} */
      const measured = [];
      for (const family of Object.keys(FAMILY_CONFIG)) {
        const result = measureFamily(family, bars);
        if (result && result.expectedEdgeBps > 0) measured.push({ ...result, symbol });
      }
      if (measured.length === 0) {
        rejected.push({ reason: 'NO_EDGE', detail: `${symbol}: no family measured a positive edge over baseline` });
        continue;
      }
      measured.sort((a, b) => (b.rankScore !== a.rankScore ? b.rankScore - a.rankScore : b.expectedEdgeBps - a.expectedEdgeBps));
      // Keep every family that measured a positive edge, not just the best one per symbol:
      // with a 30-agent population each agent must be able to trade its own strategy
      // (symbol + family), and the Builder can only compile what the Prospector proved.
      candidates.push(...measured);
    }

    const ranked = rankCandidates(candidates).slice(0, maxHypotheses);
    const hypotheses = ranked.map((candidate, index) => {
      const params = { ...FAMILY_SPECS[candidate.family], entryZ: Math.max(0.5, Math.min(3, candidate.entryZ)) };
      const stats = {
        meanBps: candidate.meanBps,
        baselineBps: candidate.baselineBps,
        sampleSize: candidate.sampleSize,
        tStat: candidate.tStat,
      };
      const observedAt = at;
      const idHash = fnv1a(
        `${candidate.symbol}|${candidate.family}|${observedAt}|${candidate.metric}|${index}`,
      )
        .toString(16)
        .padStart(8, '0');
      return {
        id: `hyp-${idHash}`,
        createdAt: observedAt,
        symbol: candidate.symbol,
        family: candidate.family,
        claim: buildClaim(candidate.family, candidate.symbol, stats, candidate.horizonBars),
        proof: {
          vendor: 'alpaca',
          simulated: mode === 'sim',
          url: dataUrlFor(candidate.symbol),
          observedAt,
          metric: candidate.metric,
          stats,
          sampleSize: candidate.sampleSize,
          barsUsed: lookbackBars,
        },
        expectedEdgeBps: candidate.expectedEdgeBps,
        horizonBars: candidate.horizonBars,
        rankScore: candidate.rankScore,
        specsHint: params,
      };
    });

    // A hypothesis without proof must never be returned (belt and braces).
    const proven = hypotheses.filter(
      (hypothesis) =>
        hypothesis.proof
        && typeof hypothesis.proof.url === 'string'
        && hypothesis.proof.url.length > 0
        && typeof hypothesis.proof.observedAt === 'string'
        && Number.isFinite(hypothesis.proof.stats?.meanBps)
        && hypothesis.proof.sampleSize > 0,
    );

    let persistenceOk = true;
    try {
      await persist(proven);
    } catch (error) {
      persistenceOk = false;
      rejected.push({ reason: 'PERSIST_FAILED', detail: String(error?.message ?? error) });
    }

    return {
      at,
      dataCalls,
      spentUsd,
      hypotheses: proven,
      rejected,
      persisted: persistenceOk,
      costEstimateBps: ESTIMATED_COST_BPS,
    };
  }

  return {
    run,
    describe() {
      return {
        role: 'prospector',
        symbols,
        lookbackBars,
        maxHypothesesPerCycle: maxHypotheses,
        estimatedCostBps: ESTIMATED_COST_BPS,
        queueFile,
      };
    },
  };
}

export default createProspector;
