/**
 * Human-readable agent names derived from the agent's strategy.
 *
 * The random id (`atm-74c0d697`) stays the stable machine key; the name is what an operator
 * sees in the control panel: `Momentum AAPL`, `MeanRev NVDA`, `Breakout TSLA 2`, ...
 * Names are unique: the second agent with the same strategy family + symbol gets a numeric
 * suffix. They are deterministic for a given registry order, and the registry stores them so
 * they never change after birth.
 */

export const FAMILY_LABELS = Object.freeze({
  momentum: 'Momentum',
  meanrev: 'MeanRev',
  breakout: 'Breakout',
  gapfade: 'GapFade',
});

/** "Momentum AAPL" — the base name for a genome's strategy. */
export function strategyBaseName(genome) {
  const family = String(genome?.family ?? 'strategy').toLowerCase();
  const label = FAMILY_LABELS[family] ?? `${family.charAt(0).toUpperCase()}${family.slice(1)}`;
  const symbol = String(genome?.symbol ?? 'UNKNOWN').toUpperCase();
  return `${label} ${symbol}`;
}

/**
 * Pick the next unused name for a genome given the names already in the population.
 * @param {object} genome
 * @param {Iterable<string>} existingNames
 * @returns {string}
 */
export function nextAgentName(genome, existingNames) {
  const base = strategyBaseName(genome);
  const taken = new Set(
    [...existingNames]
      .filter((name) => typeof name === 'string' && name.length > 0)
      .map((name) => name.toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** Names currently used by a list of agent records. */
export function usedNames(agents) {
  return (agents ?? [])
    .map((agent) => agent?.name)
    .filter((name) => typeof name === 'string' && name.length > 0);
}
