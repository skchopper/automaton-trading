/**
 * Stable constants, error types, and shared catalogues for AUTOMATON TRADING.
 * Owned by the Lead. Every module imports from here instead of re-declaring strings.
 */

export const MODES = Object.freeze(['sim', 'paper', 'live']);

export const TREASURY_STATES = Object.freeze(['STABLE', 'TIGHT', 'CRITICAL', 'DEAD']);

export const DEATH_CAUSES = Object.freeze([
  'insufficient_funds', // article rule: cannot pay for the next step
  'drawdown_limit', // trading risk-of-ruin rule
  'daily_loss_limit', // trading daily loss rule
  'account_not_active', // broker account is not ACTIVE
  'reconciliation_mismatch', // virtual ledger disagrees with broker beyond tolerance
  'risk_breach', // a brake breach that is fatal by policy
]);

export const AGENT_STATUS = Object.freeze(['alive', 'dead']);

export const ROLES = Object.freeze(['treasurer', 'prospector', 'builder', 'executor', 'replicator', 'reaper']);

export const HYPOTHESIS_FAMILIES = Object.freeze(['momentum', 'meanrev', 'breakout', 'gapfade']);

export const EXPIRY_MS = Object.freeze({
  mandate: 10 * 60 * 1000, // a cycle budget is only valid for one cycle window
  proof: 7 * 24 * 60 * 60 * 1000, // "a link or nothing" — proof older than 7 days is stale
});

/**
 * The hard denials. A prompt is a request; a hook is a wall.
 * `enforcement` names the code site that makes bypass impossible.
 */
export const BRAKES = Object.freeze([
  {
    id: 'D1',
    code: 'TRANSFER_FORBIDDEN',
    rule: 'No transfers, withdrawals, ACH, wires, crypto, or account configuration exist in the broker client.',
    enforcement: 'broker API surface (no method) + config validation',
  },
  {
    id: 'D2',
    code: 'INSTRUMENT_FORBIDDEN',
    rule: 'Instruments are gated: long stock always, short stock/options/margin only when config.instruments permits and the mandate grants them.',
    enforcement: 'brakes.checkOrder (instrument gate) + config defaults',
  },
  {
    id: 'D3',
    code: 'MARKET_CLOSED',
    rule: 'No orders outside the regular session or the configured window.',
    enforcement: 'brakes.checkOrder + broker clock',
  },
  {
    id: 'D4',
    code: 'INSTRUMENT_FORBIDDEN',
    rule: 'Symbol whitelist, minimum price, minimum notional, spread/slippage ceilings.',
    enforcement: 'brakes.checkOrder',
  },
  {
    id: 'D5',
    code: 'SIZE_FORBIDDEN',
    rule: 'Per-order notional, per-position percentage, and max open positions are capped by the Treasurer mandate.',
    enforcement: 'brakes.checkOrder',
  },
  {
    id: 'D6',
    code: 'RATE_FORBIDDEN',
    rule: 'Daily order cap per agent and max one order per symbol per cycle.',
    enforcement: 'brakes.checkOrder + dayStats',
  },
  {
    id: 'D7',
    code: 'LOSS_LIMIT',
    rule: 'Daily loss and drawdown limits are fatal (death), never a pause.',
    enforcement: 'treasurer.tick verdicts -> reaper',
  },
  {
    id: 'D8',
    code: 'LIVE_NOT_ARMED',
    rule: 'Live mode needs mode=live, allowLive, and a LIVE_ARMED file; keys are checked against the endpoint.',
    enforcement: 'config.resolveCredentials + brakes',
  },
  {
    id: 'D9',
    code: 'NO_PROOF',
    rule: 'No trade without a Builder spec carrying dated proof from the Prospector.',
    enforcement: 'builder.compile + brakes.checkOrder',
  },
  {
    id: 'D10',
    code: 'REPLICATION_FORBIDDEN',
    rule: 'Population cap, surplus gate, 72h runway floor, child endowment only from parent equity.',
    enforcement: 'treasurer gate + replicator.spawn',
  },
  {
    id: 'D11',
    code: 'KILL_SWITCH',
    rule: 'Operator kill switch file blocks every order and every cycle.',
    enforcement: 'brakes.assertKillSwitchClear (file only the operator writes)',
  },
  {
    id: 'D12',
    code: 'REAPER_ISOLATED',
    rule: 'The Reaper runs outside the engine process; no tool, IPC, config write, or handle can reach it.',
    enforcement: 'architecture (separate process, no control surface)',
  },
  {
    id: 'D13',
    code: 'ALLOCATION_FORBIDDEN',
    rule: 'Mandates may never allocate more than allocationCapPct of broker equity.',
    enforcement: 'treasurer.tick',
  },
  {
    id: 'D14',
    code: 'RESURRECTION_FORBIDDEN',
    rule: 'Dead is one-way; registry has markDead and no markAlive.',
    enforcement: 'registry.markDead',
  },
  {
    id: 'D15',
    code: 'SHORT_FORBIDDEN',
    rule: 'Short sales need shorting enabled, a shortable+marginable asset, whole shares, and a mandate short cap.',
    enforcement: 'brakes.checkOrder + broker asset metadata',
  },
  {
    id: 'D16',
    code: 'OPTION_FORBIDDEN',
    rule: 'Options need the permitted structure, integer contracts within caps, a valid DTE window and premium caps; covered calls need 100+ shares; spreads are defined-risk; naked short options never.',
    enforcement: 'brakes.checkOrder + option contract metadata',
  },
  {
    id: 'D17',
    code: 'MARGIN_LIMIT',
    rule: 'Margin debt must stay within the mandate and the configured equity percentage; buying power is never exceeded.',
    enforcement: 'brakes.checkOrder + ledger margin invariant',
  },
  {
    id: 'D18',
    code: 'EXPIRY_GUARD',
    rule: 'Opening option orders short of minDTE are denied; the executor closes before autoCloseDTE; sell-to-close is always allowed.',
    enforcement: 'brakes.checkOrder + executor lifecycle',
  },
]);

export const BRAKE_BY_ID = Object.freeze(Object.fromEntries(BRAKES.map((b) => [b.id, b])));
export const BRAKE_CODES = Object.freeze(Object.fromEntries(BRAKES.map((b) => [b.id, b.code])));

/** Stable, machine-readable error codes used across modules, tests, and the UI. */
export const ERROR_CODES = Object.freeze({
  CONFIG_INVALID: 'CONFIG_INVALID',
  MODE_FORBIDDEN: 'MODE_FORBIDDEN',
  LIVE_NOT_ARMED: 'LIVE_NOT_ARMED',
  KILL_SWITCH: 'KILL_SWITCH',
  BRAKE_DENIED: 'BRAKE_DENIED',
  NO_PROOF: 'NO_PROOF',
  PROOF_STALE: 'PROOF_STALE',
  SPEC_INVALID: 'SPEC_INVALID',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  REPLICATION_DENIED: 'REPLICATION_DENIED',
  POPULATION_CAP: 'POPULATION_CAP',
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  AGENT_DEAD: 'AGENT_DEAD',
  BROKER_ERROR: 'BROKER_ERROR',
  BROKER_AUTH: 'BROKER_AUTH',
  BROKER_RATE_LIMIT: 'BROKER_RATE_LIMIT',
  DATA_MISSING: 'DATA_MISSING',
  RECONCILIATION_MISMATCH: 'RECONCILIATION_MISMATCH',
  ACCOUNT_NOT_ACTIVE: 'ACCOUNT_NOT_ACTIVE',
  INSUFFICIENT_CASH: 'INSUFFICIENT_CASH',
  MARGIN_LIMIT: 'MARGIN_LIMIT',
  SHORT_FORBIDDEN: 'SHORT_FORBIDDEN',
  OPTION_FORBIDDEN: 'OPTION_FORBIDDEN',
  EXPIRY_GUARD: 'EXPIRY_GUARD',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
});

export class AutomatonError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message human message
   * @param {object} [details] structured context
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AutomatonError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** @returns {never} */
export function fail(code, message, details = {}) {
  throw new AutomatonError(code, message, details);
}

export function assert(condition, code, message, details = {}) {
  if (!condition) fail(code, message, details);
}

/** True when the error is an AutomatonError with one of the given codes. */
export function hasCode(error, ...codes) {
  return error instanceof AutomatonError && codes.includes(error.code);
}
