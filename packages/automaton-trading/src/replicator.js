/**
 * replicator.js — birth.
 *
 * A child is the parent's genome plus EXACTLY ONE mutation plus the journal's
 * `lessonsFor(genome)` digest. One mutation, because changing several axes at once
 * makes the population learn nothing.
 *
 * The Replicator never computes surplus and never decides whether it may spawn: the
 * Treasurer's gate decides. The child's endowment comes from the parent's cash only
 * (D10) — this module cannot create money.
 *
 * Owned by mortality-core. Contract: docs/CONTRACTS.md ("Mortality modules").
 */

import { AutomatonError, HYPOTHESIS_FAMILIES, fail } from './contracts.js';
import { DEFAULT_CONFIG } from './config.js';
import { effectiveDeathFloor } from './treasurer.js';
import { round2, SYSTEM_CLOCK } from './util.js';
import { nextAgentName, usedNames } from './naming.js';
import { tierForFamily } from './strategy-types.js';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Pick a different element deterministically from an option list. */
function pickOther(rng, options, current) {
  const pool = options.filter((option) => option !== current);
  if (pool.length === 0) return current;
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

/** Jitter a numeric parameter inside [min, max], guaranteeing a different value. */
function jitter(rng, min, max, current, decimals = 2) {
  const rounded = (value) => Number(value.toFixed(decimals));
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const next = rounded(min + (max - min) * rng());
    if (next !== current) return next;
  }
  const fallback = current !== rounded(min) ? rounded(min) : rounded(max);
  return fallback;
}

const LOOKBACKS = Object.freeze([20, 30, 50, 60, 90, 120, 150, 200]);
const STOP_PCTS = Object.freeze([0.01, 0.015, 0.02, 0.03, 0.04, 0.05]);
const TARGET_PCTS = Object.freeze([0.01, 0.02, 0.03, 0.04, 0.06, 0.08]);
const HOLD_BARS = Object.freeze([3, 5, 8, 12, 20, 30]);
const SIZE_PCTS = Object.freeze([0.05, 0.1, 0.15, 0.2, 0.25]);
const SESSION_FILTERS = Object.freeze(['all', 'firstHour', 'lastHour', 'midday']);

/**
 * The mutable catalogue: exactly one of these fields changes per birth.
 * Signature: `(currentValue, rng, context) => newValue`; `context` carries the config
 * symbol whitelist so the catalogue stays dep-free.
 */
export const MUTABLE = Object.freeze({
  symbol: (value, rng, context) =>
    pickOther(
      rng,
      (context?.symbols ?? DEFAULT_CONFIG.symbols).map((symbol) => String(symbol).toUpperCase()),
      String(value ?? '').toUpperCase(),
    ),
  family: (value, rng) => pickOther(rng, HYPOTHESIS_FAMILIES, value),
  lookback: (value, rng) => pickOther(rng, LOOKBACKS, value),
  entryZ: (value, rng) => jitter(rng, 0.5, 3, value, 2),
  exitZ: (value, rng) => jitter(rng, -1, 1.5, value, 2),
  stopPct: (value, rng) => pickOther(rng, STOP_PCTS, value),
  targetPct: (value, rng) => pickOther(rng, TARGET_PCTS, value),
  maxHoldBars: (value, rng) => pickOther(rng, HOLD_BARS, value),
  sizePct: (value, rng) => pickOther(rng, SIZE_PCTS, value),
  sessionFilter: (value, rng) => pickOther(rng, SESSION_FILTERS, value),
});

/** Catalogue field names, in a stable order (useful for tests and the UI). */
export const MUTABLE_FIELDS = Object.freeze(Object.keys(MUTABLE));

/**
 * @param {{ treasurer: object, registry: object, ledger: object, journal: object,
 *   config: object, clock?: object, rng?: () => number }} options
 */
export function createReplicator({ treasurer, registry, ledger, journal, config, clock, rng } = {}) {
  if (!treasurer || !registry || !ledger || !journal || !config) {
    throw new AutomatonError(
      'CONFIG_INVALID',
      'createReplicator requires { treasurer, registry, ledger, journal, config }',
      {},
    );
  }
  const currentClock = clock && typeof clock.now === 'function' ? clock : SYSTEM_CLOCK;
  const currentRng = typeof rng === 'function' ? rng : Math.random;
  const replication = config.replication ?? {};

  function populationCapReached() {
    return registry.population() >= registry.cap;
  }

  /**
   * Spawn one child from a living parent, gated by the Treasurer.
   *
   * @param {string} parentId
   * @param {object} treasuryGate the object returned by `treasurer.tick()`
   * @returns {Promise<{ child: object, mutation: { field: string, from: unknown, to: unknown }, lessonCount: number }>}
   */
  async function spawn(parentId, treasuryGate) {
    const parent = registry.get(parentId);
    if (!parent) fail('UNKNOWN_AGENT', `cannot replicate unknown agent "${parentId}"`, { parentId });
    if (parent.status !== 'alive') {
      fail('AGENT_DEAD', `cannot replicate dead agent "${parentId}" (dead is one-way)`, { parentId });
    }
    if (!treasuryGate || typeof treasuryGate !== 'object') {
      fail('REPLICATION_DENIED', 'replication requires the Treasurer gate (treasurer.tick() result)', { parentId });
    }

    // 1) population cap (D10)
    if (populationCapReached()) {
      fail('POPULATION_CAP', `population cap reached (${registry.cap}); no child may be born`, {
        cap: registry.cap,
        population: registry.population(),
      });
    }

    // 2) the Treasurer's numeric gates
    const surplus7dUsd = Number(treasuryGate.surplus7dUsd ?? 0);
    const minSurplus = Number(replication.surplus7dUsd ?? 0);
    if (!(surplus7dUsd >= minSurplus)) {
      fail(
        'REPLICATION_DENIED',
        `surplus gate closed: 7-day net ${surplus7dUsd.toFixed(2)} < required ${minSurplus.toFixed(2)}`,
        { parentId, surplus7dUsd, requiredUsd: minSurplus },
      );
    }
    const runwayHours = Number(treasuryGate.runwayHours ?? 0);
    const minRunwayHours = Number(replication.minRunwayHours ?? 0);
    if (!(runwayHours >= minRunwayHours)) {
      fail(
        'REPLICATION_DENIED',
        `runway gate closed: ${runwayHours.toFixed(2)}h < required ${minRunwayHours}h`,
        { parentId, runwayHours, requiredHours: minRunwayHours },
      );
    }
    if (treasuryGate.mayReplicate !== true) {
      fail('REPLICATION_DENIED', 'Treasurer has not opened the replication gate (mayReplicate !== true)', {
        parentId,
        surplus7dUsd,
        runwayHours,
      });
    }

    // 3) the parent pays: child endowment from parent equity only, never at the cost of its life
    const childEndowmentUsd = round2(Number(replication.childEndowmentUsd ?? 0));
    if (!(childEndowmentUsd > 0)) {
      fail('REPLICATION_DENIED', 'childEndowmentUsd must be positive', { parentId, childEndowmentUsd });
    }
    const parentView = Array.isArray(treasuryGate.agentViews)
      ? treasuryGate.agentViews.find((view) => view?.agentId === parentId)
      : null;
    let parentEquityUsd;
    try {
      parentEquityUsd = parentView && Number.isFinite(Number(parentView.equityUsd))
        ? Number(parentView.equityUsd)
        : ledger.equity(parentId, {}).equityUsd;
    } catch (error) {
      if (error instanceof AutomatonError) throw error;
      fail('REPLICATION_DENIED', `cannot value the parent for replication: ${error?.message ?? error}`, { parentId });
    }
    const floorUsd = effectiveDeathFloor(config, parent.endowmentUsd ?? config.endowmentUsd);
    // The parent must survive BOTH death rules after paying the child endowment: the
    // zero-balance floor and the drawdown limit (equity <= endowment * (1 - maxDrawdown)).
    // Checking only the floor lets a "successful" birth push the parent straight into a
    // drawdown death — which is exactly what D10 ("no replication at the cost of your own
    // life") forbids.
    const parentEndowmentUsd = Number(parent.endowmentUsd ?? config.endowmentUsd) || 0;
    const drawdownFloorUsd = round2(parentEndowmentUsd * (1 - Number(config.maxDrawdownPct ?? 0)));
    const postBirthEquityUsd = round2(parentEquityUsd - childEndowmentUsd);
    const minPostBirthEquityUsd = round2(Math.max(floorUsd * 2, drawdownFloorUsd));
    if (postBirthEquityUsd <= minPostBirthEquityUsd) {
      fail(
        'REPLICATION_DENIED',
        `replication at the cost of the parent's life: parent equity ${parentEquityUsd.toFixed(2)} ` +
          `- child ${childEndowmentUsd.toFixed(2)} = ${postBirthEquityUsd.toFixed(2)}, which must stay above ` +
          `max(2 x death floor, drawdown floor) = ${minPostBirthEquityUsd.toFixed(2)}`,
        { parentId, parentEquityUsd, childEndowmentUsd, postBirthEquityUsd, floorUsd, drawdownFloorUsd },
      );
    }
    const parentSnapshot = ledger.snapshot(parentId);
    if (parentSnapshot.cashUsd < childEndowmentUsd) {
      fail(
        'REPLICATION_DENIED',
        `parent equity is not liquid: cash ${parentSnapshot.cashUsd.toFixed(2)} < child endowment ${childEndowmentUsd.toFixed(2)}`,
        { parentId, cashUsd: parentSnapshot.cashUsd, childEndowmentUsd },
      );
    }

    // 4) exactly one mutation from the MUTABLE catalogue
    const parentGenome = isPlainObject(parent.genome) ? parent.genome : {};
    const field = MUTABLE_FIELDS[Math.floor(currentRng() * MUTABLE_FIELDS.length) % MUTABLE_FIELDS.length];
    const from = parentGenome[field];
    let to = from;
    for (let attempt = 0; attempt < 25 && to === from; attempt += 1) {
      to = MUTABLE[field](from, currentRng, { symbols: config.symbols, config, genome: parentGenome });
    }
    if (to === from) {
      fail('REPLICATION_DENIED', `mutation of "${field}" produced no change; refusing a clone`, {
        parentId,
        field,
        value: from,
      });
    }
    const childGenome = { ...parentGenome, [field]: to };
    const mutation = { field, from: from === undefined ? null : from, to };

    // 5) the child inherits the journal's digest, not the parent's code
    const lessons = journal.lessonsFor(childGenome, { limit: 20 });
    const lessonCount = lessons.length;

    // 6) register, fund from the parent, persist
    const bornAt = currentClock.iso();
    const child = registry.register({
      id: registry.nextId(),
      name: nextAgentName(childGenome, usedNames(registry.all())),
      parentId,
      // Generation 0 is the genesis generation: `Number(x) || 1` would skip a generation.
      generation: (Number.isFinite(Number(parent.generation)) ? Number(parent.generation) : 0) + 1,
      bornAt,
      status: 'alive',
      endowmentUsd: childEndowmentUsd,
      genome: childGenome,
      mutation,
      specId: null,
      // The child's execution tier follows its strategy family (the one mutation may change the
      // family, so the cadence class is derived from the mutated genome rather than copied).
      tier: tierForFamily(childGenome.family),
      lastCycleAt: null,
      notes: lessons.slice(0, 8),
    });
    ledger.ensureAgent(child.id, { endowmentUsd: childEndowmentUsd, at: bornAt });
    try {
      treasurer.fundChild(parentId, child.id, childEndowmentUsd);
    } catch (error) {
      // A child that could not be funded is not a birth: make it dead rather than undoable.
      try {
        registry.markDead(child.id, { cause: 'risk_breach', at: bornAt, finalEquityUsd: 0 });
      } catch {
        /* best effort rollback */
      }
      throw error;
    }
    registry.save();
    ledger.save();
    return { child, mutation, lessonCount };
  }

  return { spawn };
}
