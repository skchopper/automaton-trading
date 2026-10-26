/**
 * Dependency-free helpers shared by every module. Owned by the Lead.
 * Everything here is deterministic where it matters: modules take a `clock` and an
 * injected `rng` so tests and the accelerated simulation can control time and luck.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AutomatonError } from './contracts.js';

// ---------------------------------------------------------------------------
// Clock: injectable time so simulation and tests do not depend on wall clock.
// ---------------------------------------------------------------------------

/**
 * @param {{ now?: () => number, advance?: (ms: number) => void }} [options]
 * @returns {{ now: () => number, iso: () => string, advance: (ms: number) => void, set: (ms: number) => void }}
 */
export function createClock(options = {}) {
  let offset = 0;
  const base = options.now ?? (() => Date.now());
  return {
    now: () => base() + offset,
    iso: () => new Date(base() + offset).toISOString(),
    advance: (ms) => {
      offset += ms;
    },
    set: (ms) => {
      offset = ms - base();
    },
  };
}

export const SYSTEM_CLOCK = createClock();

// ---------------------------------------------------------------------------
// Identifiers and numbers
// ---------------------------------------------------------------------------

const ID_ALPHABET = '0123456789abcdef';

/**
 * Short, collision-resistant, prefix-tagged id: `atm-3f9a1c2b`.
 * @param {string} [prefix]
 * @param {() => number} [rng]
 */
export function newId(prefix = 'atm', rng = Math.random) {
  let out = '';
  for (let i = 0; i < 8; i += 1) out += ID_ALPHABET[Math.floor(rng() * 16)];
  return `${prefix}-${out}`;
}

export function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export const round2 = (v) => round(v, 2);
export const round4 = (v) => round(v, 4);
export const round8 = (v) => round(v, 8);

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function sum(values) {
  let total = 0;
  for (const value of values) total += Number(value) || 0;
  return total;
}

export function mean(values) {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/** Median of a numeric array (does not mutate). */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Seeded PRNG (mulberry32) — same seed, same population, same deaths. */
export function mulberry32(seed) {
  let state = Number(seed) >>> 0 || 0x9e3779b9;
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform float in [min, max). */
export function randomBetween(rng, min, max) {
  return min + (max - min) * rng();
}

/** Pick one element deterministically from a non-empty array. */
export function pick(rng, items) {
  if (!items || items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length) % items.length];
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function hoursBetween(fromMs, toMs) {
  return (toMs - fromMs) / HOUR_MS;
}

/** Trading day key in the configured session timezone (default: America/New_York). */
export function dayKey(ms, timeZone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Minutes since midnight in a timezone, for the session window brake. */
export function minutesSinceMidnight(ms, timeZone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '0';
  return Number(get('hour')) * 60 + Number(get('minute'));
}

/** "09:35" -> 575 */
export function parseHhMm(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Filesystem: atomic writes, JSON, JSONL
// ---------------------------------------------------------------------------

export function fileExists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Write JSON atomically (temp file + rename) so a crash never leaves half a file.
 * On Windows the rename can transiently fail with EPERM/EACCES/EBUSY while another process
 * (e.g. the external Reaper) is reading or renaming the same path — retry briefly instead of
 * surfacing a one-off file-lock error into the engine's error state.
 */
export async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) break;
      await sleep(10 + attempt * 20);
    }
  }
  try {
    await fsp.unlink(tmp);
  } catch {
    /* best effort cleanup */
  }
  throw lastError;
}

/** Same as writeJsonAtomic but synchronous; used by the sync registry/ledger saves. */
export function writeJsonAtomicSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) break;
      const until = Date.now() + 10 + attempt * 20;
      while (Date.now() < until) {
        /* short blocking backoff: sync save path */
      }
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* best effort cleanup */
  }
  throw lastError;
}

/** Read JSON, returning `fallback` when missing or corrupt (corruption is logged, not fatal). */
export async function readJson(file, fallback = null) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    if (text.trim() === '') return fallback;
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) return fallback;
    throw error;
  }
}

export function readJsonSync(file, fallback = null) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim() === '') return fallback;
    return JSON.parse(text);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) return fallback;
    throw error;
  }
}

export function appendJsonlSync(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function appendJsonl(file, record) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

/** Read a JSONL file, skipping malformed lines. Returns oldest-first. */
export async function readJsonl(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
    }
    return rows;
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Append a line to a plain-text log (used for traces/reaper logs). */
export async function appendLog(file, line) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, `${line}\n`, 'utf8');
}

export async function readText(file, fallback = '') {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/** Create the file if absent; used for the kill-switch and live-armed markers. */
export async function touchFile(file, contents = '') {
  await ensureDir(path.dirname(file));
  if (!fileExists(file)) await fsp.writeFile(file, contents, 'utf8');
}

export async function removeFile(file) {
  try {
    await fsp.unlink(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

// ---------------------------------------------------------------------------
// .env parsing (no dependency). Supports KEY=VALUE, quotes, comments, export.
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotenv(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export async function readDotenv(file) {
  return parseDotenv(await readText(file, ''));
}

// ---------------------------------------------------------------------------
// Secrets / redaction
// ---------------------------------------------------------------------------

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|passphrase|credential)/i;

/** Deep clone that replaces anything that looks like a secret with "***". */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key) && typeof item === 'string' && item.length > 0) {
        out[key] = '***';
      } else {
        out[key] = redactSecrets(item);
      }
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Logging: structured console output, safe for the Harness log.
// ---------------------------------------------------------------------------

export function createLogger(scope = 'automaton', sink = console) {
  const line = (level, message, data) => {
    const payload = data === undefined ? '' : ` ${safeJson(data)}`;
    const text = `[${scope}] ${level} ${message}${payload}`;
    if (level === 'error') sink.error(text);
    else if (level === 'warn') sink.warn(text);
    else sink.log(text);
  };
  return {
    info: (message, data) => line('info', message, data),
    warn: (message, data) => line('warn', message, data),
    error: (message, data) => line('error', message, data),
    debug: () => {},
  };
}

export function safeJson(value, space = 0) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      value,
      (key, item) => {
        if (typeof item === 'bigint') return Number(item);
        if (item && typeof item === 'object') {
          if (seen.has(item)) return '[circular]';
          seen.add(item);
        }
        return item;
      },
      space,
    );
  } catch {
    return '"[unserializable]"';
  }
}

/** Serialize an Error (including AutomatonError) for traces, tool output, and logs. */
export function errorInfo(error) {
  if (error instanceof AutomatonError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: error?.code ?? 'ERROR',
    message: error?.message ?? String(error),
    details: {},
  };
}
