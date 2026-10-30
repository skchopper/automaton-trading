/**
 * STRATEGY EXPLANATION — human-readable "what this bot is, what it will do next".
 *
 * The population bots are deterministic strategy instances, so the operator panel can explain them
 * exhaustively: the genome/spec rules, the current plan (holding vs flat), the exact exit triggers,
 * and the next scheduled research briefing. This module is pure: it derives text and numbers from
 * the compiled spec + virtual book + last price; it never trades or reads broker account equity.
 *
 * Output shape (contract: docs/CONTROL-PANEL.md):
 * {
 *   summary, entryRule, exitRules[], riskRule, nextStep,
 *   triggers:{family, symbol, entryZ, exitZ, stopPct, targetPct, maxHoldBars, sizePct, sessionFilter},
 *   position: {symbol, qty, avgPriceUsd, lastPriceUsd, stopPriceUsd, targetPriceUsd, barsHeld, maxHoldBars} | null,
 *   research: {verdict, sentiment, confidence, at, stale} | null,
 *   nextResearchAt: ISO | null,
 * }
 */

import { timeframeToMs } from './util.js';

const FAMILY_LABELS = {
  momentum: 'Momentum',
  meanrev: 'Mean-reversion',
  breakout: 'Breakout',
  gapfade: 'Gap-fade',
};

function numberOrNull(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, dp = 4) {
  const n = numberOrNull(value);
  if (n === null) return null;
  const factor = 10 ** dp;
  return Math.round(n * factor) / factor;
}

function pct(value) {
  const n = numberOrNull(value);
  return n === null ? null : `${round(n * 100, 2)}%`;
}

/** Merge the compiled spec params with the inherited genome (spec is what actually trades). */
function resolveRules(agent, spec) {
  const genome = agent?.genome ?? {};
  const params = spec?.params ?? {};
  return {
    family: spec?.family ?? genome.family ?? 'meanrev',
    symbol: String(spec?.symbol ?? genome.symbol ?? '').toUpperCase() || null,
    entryZ: numberOrNull(params.entryZ) ?? numberOrNull(genome.entryZ) ?? 1,
    exitZ: numberOrNull(params.exitZ) ?? numberOrNull(genome.exitZ) ?? 0.5,
    stopPct: numberOrNull(params.stopPct) ?? numberOrNull(genome.stopPct) ?? 0.02,
    targetPct: numberOrNull(params.targetPct) ?? numberOrNull(genome.targetPct) ?? 0.04,
    maxHoldBars: numberOrNull(params.maxHoldBars) ?? numberOrNull(genome.maxHoldBars) ?? 12,
    sizePct: numberOrNull(params.sizePct) ?? numberOrNull(genome.sizePct) ?? 0.2,
    lookback: numberOrNull(params.lookback) ?? numberOrNull(genome.lookback) ?? 24,
    sessionFilter: params.sessionFilter ?? genome.sessionFilter ?? 'any',
  };
}

function describeEntry(family, symbol, rules) {
  const z = round(rules.entryZ, 2);
  if (family === 'momentum') {
    return `Buy ${symbol} when the 5-bar return z-score is >= ${z} (buying strength).`;
  }
  if (family === 'meanrev') {
    return `Buy ${symbol} when the 10-bar close z-score is <= -${z} (buying weakness).`;
  }
  if (family === 'breakout') {
    return `Buy ${symbol} when the hourly close breaks above the prior 20-bar high.`;
  }
  if (family === 'gapfade') {
    return `Buy ${symbol} when it opens with a gap down of at least -0.20% versus the previous close (fading the gap).`;
  }
  return `Wait for the ${family} entry signal on ${symbol}.`;
}

function describeExits(family, rules) {
  const z = round(rules.exitZ, 2);
  const exits = [];
  if (family === 'momentum') exits.push(`Signal exit when momentum z-score <= ${z}.`);
  else if (family === 'meanrev') exits.push(`Signal exit when z-score >= -${z} (reverted to the mean).`);
  else if (family === 'breakout') exits.push('Signal exit when the close falls back below the 10-bar SMA.');
  else if (family === 'gapfade') exits.push('Signal exit when the close recovers to the previous close.');
  exits.push(`Stop loss at ${pct(rules.stopPct)} below entry.`);
  exits.push(`Take profit at ${pct(rules.targetPct)} above entry.`);
  exits.push(`Time stop after ${rules.maxHoldBars} bars${barDurationLabel(rules.timeframe)}.`);
  exits.push('Research ALERT / very negative sentiment can force an exit before these levels.');
  return exits;
}

/** " (~5 min each)" suffix for bar-based rules. */
function barDurationLabel(timeframe) {
  const ms = timeframeToMs(timeframe ?? '1Hour');
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return ` (~${minutes} min each)`;
  const hours = Math.round((minutes / 60) * 100) / 100;
  return ` (~${hours} h each)`;
}

/**
 * @param {{
 *   agent: object, spec?: object|null, book?: object|null,
 *   prices?: Record<string, number>, nowMs: number,
 *   research?: object|null, nextResearchAt?: string|null,
 * }} input
 */
export function explainAgentPlan({ agent, spec = null, book = null, prices = {}, nowMs, research = null, nextResearchAt = null, timeframe = '1Hour' } = {}) {
  if (!agent || typeof agent !== 'object') return null;
  const rules = resolveRules(agent, spec);
  rules.timeframe = timeframe ?? '1Hour';
  const familyLabel = FAMILY_LABELS[rules.family] ?? rules.family;
  const positions = book?.positions && typeof book.positions === 'object' ? book.positions : {};
  const heldSymbol = Object.keys(positions).find((symbol) => Number(positions[symbol]?.qty) > 0) ?? null;
  const position = heldSymbol ? positions[heldSymbol] : null;
  const lastPrice = numberOrNull(prices[heldSymbol ?? rules.symbol]) ?? numberOrNull(position?.avgPriceUsd);

  const positionPlan = position
    ? {
        symbol: heldSymbol,
        qty: round(position.qty, 4),
        avgPriceUsd: round(position.avgPriceUsd, 4),
        lastPriceUsd: round(lastPrice, 4),
        stopPriceUsd: round(position.avgPriceUsd * (1 - rules.stopPct), 4),
        targetPriceUsd: round(position.avgPriceUsd * (1 + rules.targetPct), 4),
        barsHeld: (() => {
          const openedMs = typeof position.openedAt === 'string' ? Date.parse(position.openedAt) : numberOrNull(position.openedAt);
          const barMs = timeframeToMs(rules.timeframe);
          return Number.isFinite(openedMs) ? Math.max(0, Math.floor((nowMs - openedMs) / barMs)) : null;
        })(),
        maxHoldBars: rules.maxHoldBars,
      }
    : null;

  const researchPlan = research
    ? {
        verdict: research.verdict ?? null,
        sentiment: numberOrNull(research.sentiment),
        confidence: numberOrNull(research.confidence),
        at: research.at ?? null,
        stale: Boolean(research.stale),
      }
    : null;
  const researchNote = researchPlan && !researchPlan.stale
    ? ` Latest briefing: ${researchPlan.verdict} (sentiment ${researchPlan.sentiment}, confidence ${researchPlan.confidence}).`
    : '';

  const summary = [
    `${agent.name ?? agent.id} is a ${familyLabel.toLowerCase()} bot${rules.symbol ? ` trading ${rules.symbol}` : ''}.`,
    `Genome: ${agent?.genome?.family ?? rules.family}/${agent?.genome?.symbol ?? rules.symbol ?? 'n/a'}`,
    spec ? `; compiled spec: ${rules.family}/${rules.symbol} (lookback ${rules.lookback}, entryZ ${round(rules.entryZ, 2)}, exitZ ${round(rules.exitZ, 2)}, stop ${pct(rules.stopPct)}, target ${pct(rules.targetPct)}).` : '.',
    ` Position size ≈ ${pct(rules.sizePct)} of its mandate budget, inside the hard caps and the 18-brake wall.`,
    researchNote,
  ].join(' ');

  const nextStep = positionPlan
    ? `Holding ${positionPlan.qty} ${positionPlan.symbol} at ${positionPlan.avgPriceUsd}. It will exit on: price <= ${positionPlan.stopPriceUsd} (stop), price >= ${positionPlan.targetPriceUsd} (target), after ${positionPlan.maxHoldBars} held bars, a signal flip, or a research ALERT.`
    : `Flat and waiting for the entry condition: ${describeEntry(rules.family, rules.symbol, rules).replace(/^Buy /, 'buy ')} Next research briefing: ${nextResearchAt ?? 'pending schedule'}. If the signal fires, the order is sized from the mandate and must pass every brake before reaching the broker.`;

  return {
    summary,
    entryRule: describeEntry(rules.family, rules.symbol, rules),
    exitRules: describeExits(rules.family, rules),
    riskRule: `Size ≈ ${pct(rules.sizePct)} of mandate; stop loss ${pct(rules.stopPct)} below entry; max order/position/daily caps and the session window (${rules.sessionFilter}) apply; every order passes the 18 hard brakes (D1–D18, incl. instrument gates); deaths at the $1 floor or 20% drawdown.`,
    nextStep,
    triggers: {
      family: rules.family,
      symbol: rules.symbol,
      entryZ: round(rules.entryZ, 4),
      exitZ: round(rules.exitZ, 4),
      stopPct: round(rules.stopPct, 4),
      targetPct: round(rules.targetPct, 4),
      maxHoldBars: rules.maxHoldBars,
      sizePct: round(rules.sizePct, 4),
      sessionFilter: rules.sessionFilter,
      lookback: rules.lookback,
    },
    position: positionPlan,
    research: researchPlan,
    nextResearchAt: nextResearchAt ?? null,
  };
}

export { FAMILY_LABELS, resolveRules };
