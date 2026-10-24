/**
 * journal.js — the obituary dataset.
 *
 * Every death appends exactly one JSONL line. The living do not inherit code: they
 * inherit `lessonsFor(genome)`, a digest derived from deaths of similar genomes.
 *
 * Owned by mortality-core. Contract: docs/CONTRACTS.md ("Mortality modules").
 * Persistence is synchronous on purpose: `append()` is called from the Reaper's kill
 * sequence and from tests, where a floating promise would be a lost record.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AutomatonError, DEATH_CAUSES } from './contracts.js';
import { mean, median, readJsonSync, round2, round4 } from './util.js';
import { statePaths } from './config.js';

/**
 * Stable local code for a malformed obituary. The shared ERROR_CODES catalogue in
 * `contracts.js` has no obituary-specific code (reported to the Lead); this constant
 * keeps the failure machine-readable without editing the Lead-owned file.
 */
export const OBITUARY_INVALID = 'OBITUARY_INVALID';

/** Every required obituary field, in the order documented in CONTRACTS.md. */
export const OBITUARY_FIELDS = Object.freeze([
  'agentId',
  'parentId',
  'generation',
  'bornAt',
  'diedAt',
  'lifespanHours',
  'endowmentUsd',
  'finalEquityUsd',
  'revenueUsd',
  'spendUsd',
  'netPlUsd',
  'genome',
  'mutation',
  'productsShipped',
  'tradesCount',
  'firstProfitAt',
  'strategySpecId',
  'cause',
  'lastRunwayHours',
  'lessons',
]);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isIsoDate = (value) => typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Date.parse(value));

function invalid(field, message, value) {
  return new AutomatonError(OBITUARY_INVALID, `invalid obituary field "${field}": ${message}`, {
    field,
    value,
  });
}

/**
 * Validate an obituary against the documented schema. Throws AutomatonError
 * `OBITUARY_INVALID` on the first problem. Returns the same object on success.
 *
 * @param {object} obituary
 * @returns {object}
 */
export function validateObituary(obituary) {
  if (!isPlainObject(obituary)) throw invalid('obituary', 'must be an object', obituary);

  for (const field of OBITUARY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(obituary, field)) {
      throw invalid(field, 'is required', undefined);
    }
  }

  const {
    agentId,
    parentId,
    generation,
    bornAt,
    diedAt,
    lifespanHours,
    endowmentUsd,
    finalEquityUsd,
    revenueUsd,
    spendUsd,
    netPlUsd,
    genome,
    mutation,
    productsShipped,
    tradesCount,
    firstProfitAt,
    strategySpecId,
    cause,
    lastRunwayHours,
    lessons,
  } = obituary;

  if (typeof agentId !== 'string' || agentId.trim() === '') throw invalid('agentId', 'must be a non-empty string', agentId);
  if (parentId !== null && typeof parentId !== 'string') throw invalid('parentId', 'must be null or a string', parentId);
  if (!Number.isInteger(generation) || generation < 0) throw invalid('generation', 'must be a non-negative integer', generation);
  if (!isIsoDate(bornAt)) throw invalid('bornAt', 'must be an ISO timestamp string', bornAt);
  if (!isIsoDate(diedAt)) throw invalid('diedAt', 'must be an ISO timestamp string', diedAt);
  if (Date.parse(diedAt) < Date.parse(bornAt)) throw invalid('diedAt', 'must not precede bornAt', diedAt);
  if (!isFiniteNumber(lifespanHours) || lifespanHours < 0) throw invalid('lifespanHours', 'must be a non-negative number', lifespanHours);
  for (const field of ['endowmentUsd', 'finalEquityUsd', 'revenueUsd', 'spendUsd', 'netPlUsd', 'lastRunwayHours']) {
    if (!isFiniteNumber(obituary[field])) throw invalid(field, 'must be a finite number', obituary[field]);
  }
  if (!isPlainObject(genome)) throw invalid('genome', 'must be an object', genome);
  if (mutation !== null) {
    if (!isPlainObject(mutation)) throw invalid('mutation', 'must be null or an object {field, from, to}', mutation);
    if (typeof mutation.field !== 'string' || mutation.field.trim() === '') {
      throw invalid('mutation', 'object must carry a non-empty "field" string', mutation);
    }
    if (!Object.prototype.hasOwnProperty.call(mutation, 'from') || !Object.prototype.hasOwnProperty.call(mutation, 'to')) {
      throw invalid('mutation', 'object must carry "from" and "to"', mutation);
    }
  }
  if (!isFiniteNumber(productsShipped) || productsShipped < 0) throw invalid('productsShipped', 'must be a non-negative number', productsShipped);
  if (!isFiniteNumber(tradesCount) || tradesCount < 0) throw invalid('tradesCount', 'must be a non-negative number', tradesCount);
  if (firstProfitAt !== null && !isIsoDate(firstProfitAt)) throw invalid('firstProfitAt', 'must be null or an ISO timestamp', firstProfitAt);
  if (strategySpecId !== null && typeof strategySpecId !== 'string') throw invalid('strategySpecId', 'must be null or a string', strategySpecId);
  if (!DEATH_CAUSES.includes(cause)) throw invalid('cause', `must be one of ${DEATH_CAUSES.join('|')}`, cause);
  if (lastRunwayHours < 0) throw invalid('lastRunwayHours', 'must not be negative', lastRunwayHours);
  if (!Array.isArray(lessons) || lessons.some((line) => typeof line !== 'string')) {
    throw invalid('lessons', 'must be an array of strings', lessons);
  }
  return obituary;
}

/** Read a JSONL file synchronously, skipping malformed lines. Oldest first. */
function readJournalSync(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a torn line is skipped, not fatal: obituaries are append-only */
    }
  }
  return rows;
}

function countAliveFromRegistry(registryPath) {
  const raw = readJsonSync(registryPath, null);
  if (!raw) return 0;
  const agents = Array.isArray(raw) ? raw : Object.values(raw.agents ?? {});
  return agents.filter((agent) => agent && agent.status === 'alive').length;
}

/** Human-readable money for lesson lines (always 2dp). */
function usd(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '$0.00';
}

function genomeOf(obituary) {
  return isPlainObject(obituary.genome) ? obituary.genome : {};
}

const NUMERIC_GENOME_FIELDS = Object.freeze([
  'lookback',
  'entryZ',
  'exitZ',
  'stopPct',
  'targetPct',
  'maxHoldBars',
  'sizePct',
]);

/**
 * Similarity of a candidate genome to a dead one. Symbol and family dominate;
 * adjacent numeric parameters add a little. Deterministic and cheap.
 */
function similarityScore(genome, obituary) {
  const a = isPlainObject(genome) ? genome : {};
  const b = genomeOf(obituary);
  let score = 0;
  if (a.symbol && b.symbol === a.symbol) score += 3;
  if (a.family && b.family === a.family) score += 2;
  for (const field of NUMERIC_GENOME_FIELDS) {
    if (isFiniteNumber(a[field]) && isFiniteNumber(b[field])) {
      const tolerance = Math.max(1, Math.abs(a[field]) * 0.25);
      if (Math.abs(a[field] - b[field]) <= tolerance) score += 1;
    }
  }
  if (a.sessionFilter && b.sessionFilter === a.sessionFilter) score += 1;
  return score;
}

/** One-line lesson distilled from a death. */
function lessonLine(obituary) {
  const genome = genomeOf(obituary);
  const symbol = typeof genome.symbol === 'string' ? genome.symbol : 'unknown';
  const family = typeof genome.family === 'string' ? genome.family : 'unknown-family';
  const generation = Number.isFinite(obituary.generation) ? obituary.generation : 0;
  const lifespan = round2(Number(obituary.lifespanHours) || 0);
  const firstProfit = obituary.firstProfitAt ? `first profit at ${obituary.firstProfitAt}` : 'never reached first profit';
  return (
    `${symbol} ${family} gen-${generation} died of ${obituary.cause} after ${lifespan}h: ` +
    `net ${usd(obituary.netPlUsd)}, final equity ${usd(obituary.finalEquityUsd)}; ${firstProfit}.`
  );
}

/**
 * Create the obituary journal.
 *
 * @param {{ paths?: object, config?: object }} [options]
 * @returns {{
 *   append: (obituary: object) => void,
 *   list: (options?: { limit?: number, offset?: number }) => object[],
 *   count: () => number,
 *   causes: () => Record<string, number>,
 *   has: (agentId: string) => boolean,
 *   stats: () => object,
 *   lessonsFor: (genome: object, options?: { limit?: number }) => string[],
 * }}
 */
export function createJournal({ paths, config } = {}) {
  if (!paths?.journal && !config) {
    throw new AutomatonError('CONFIG_INVALID', 'createJournal requires { paths } or { config }', {});
  }
  const resolved = { ...(config ? statePaths(config) : {}), ...(paths ?? {}) };
  if (!resolved.journal) {
    throw new AutomatonError('CONFIG_INVALID', 'journal path is required', {});
  }
  const journalPath = path.resolve(resolved.journal);
  const registryPath = resolved.registry ? path.resolve(resolved.registry) : null;

  const readAll = () => readJournalSync(journalPath);

  /**
   * Validate and append exactly one JSONL line.
   * @param {object} obituary
   */
  function append(obituary) {
    validateObituary(obituary);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.appendFileSync(journalPath, `${JSON.stringify(obituary)}\n`, 'utf8');
  }

  /**
   * Newest-first page of obituaries.
   * @param {{ limit?: number, offset?: number }} [options]
   */
  function list({ limit = 50, offset = 0 } = {}) {
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const rows = readAll();
    const newestFirst = rows.slice().reverse();
    return newestFirst.slice(safeOffset, safeOffset + safeLimit);
  }

  function count() {
    return readAll().length;
  }

  /** @returns {Record<string, number>} cause -> count */
  function causes() {
    const out = {};
    for (const row of readAll()) {
      const cause = typeof row.cause === 'string' ? row.cause : 'unknown';
      out[cause] = (out[cause] ?? 0) + 1;
    }
    return out;
  }

  /** True when the journal already contains this agent's obituary (reaper idempotency). */
  function has(agentId) {
    if (typeof agentId !== 'string' || agentId === '') return false;
    return readAll().some((row) => row && row.agentId === agentId);
  }

  function stats() {
    const rows = readAll();
    const total = rows.length;
    const lifespans = rows.map((row) => Number(row.lifespanHours)).filter(Number.isFinite);
    const generations = rows.map((row) => Number(row.generation)).filter(Number.isFinite);
    const causeCounts = causes();
    const causeEntries = Object.entries(causeCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const lineCounts = new Map();
    for (const row of rows) {
      for (const line of Array.isArray(row.lessons) ? row.lessons : []) {
        if (typeof line !== 'string' || line.trim() === '') continue;
        lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
      }
    }
    let mostCommonLine = null;
    let best = 0;
    for (const [line, countValue] of lineCounts) {
      if (countValue > best) {
        best = countValue;
        mostCommonLine = line;
      }
    }
    const rate = (predicate) => (total === 0 ? 0 : round4(rows.filter(predicate).length / total));
    return {
      total,
      alive: registryPath ? countAliveFromRegistry(registryPath) : 0,
      medianLifespanHours: total === 0 ? 0 : round2(median(lifespans)),
      meanLifespanHours: total === 0 ? 0 : round2(mean(lifespans)),
      firstProfitRate: rate((row) => row.firstProfitAt !== null && row.firstProfitAt !== undefined),
      revenuePositiveRate: rate((row) => Number(row.revenueUsd) > 0),
      medianGeneration: generations.length === 0 ? 0 : round2(median(generations)),
      mostCommonCause: causeEntries.length > 0 ? causeEntries[0][0] : null,
      mostCommonLine,
    };
  }

  /**
   * Human-readable lessons derived from the deaths of similar genomes, best match first.
   * Falls back to the most recent deaths when nothing is similar.
   *
   * @param {object} genome
   * @param {{ limit?: number }} [options]
   * @returns {string[]}
   */
  function lessonsFor(genome, { limit = 20 } = {}) {
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 20;
    if (max === 0) return [];
    const scored = readAll().map((obituary, index) => ({
      obituary,
      index,
      score: similarityScore(genome, obituary),
      diedAtMs: Date.parse(obituary?.diedAt) || 0,
    }));
    scored.sort((a, b) => b.score - a.score || b.diedAtMs - a.diedAtMs || b.index - a.index);
    const lines = [];
    const seen = new Set();
    const push = (line) => {
      if (lines.length >= max) return;
      const text = String(line).trim();
      if (text === '' || seen.has(text)) return;
      seen.add(text);
      lines.push(text);
    };
    for (const { obituary } of scored) {
      if (lines.length >= max) break;
      push(lessonLine(obituary));
      for (const extra of Array.isArray(obituary?.lessons) ? obituary.lessons : []) push(extra);
    }
    return lines;
  }

  return { append, list, count, causes, has, stats, lessonsFor };
}
