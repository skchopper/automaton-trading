/**
 * scripts/reconcile-research-charges.mjs — re-book research briefings the ledger lost to the
 * old Reaper's unconditional save race (fixed in src/reaper-process.js).
 *
 * Every persisted briefing should have exactly one matching ledger event:
 *   category 'research', ref `research:<briefing.at>`, role 'prospector', amount costUsd.
 * This script is idempotent: it charges only briefings whose ref is missing.
 *
 * Run only while the engine loop is STOPPED (single writer):
 *   node scripts/reconcile-research-charges.mjs
 * Then start the loop again.
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, statePaths } from '../packages/automaton-trading/src/config.js';
import { createLedger } from '../packages/automaton-trading/src/ledger.js';
import { createRegistry } from '../packages/automaton-trading/src/registry.js';
import { readJsonl, createClock } from '../packages/automaton-trading/src/util.js';

const root = 'D:/CounterStikers';
const { config } = loadConfig({ cwd: root, env: {} });
const paths = statePaths(config);
const clock = createClock();
const registry = createRegistry({ paths, config, clock });
const ledger = createLedger({ paths, config, clock });
registry.load();
ledger.load();

const researchDir = paths.researchDir;
if (!fs.existsSync(researchDir)) {
  console.log('no research directory yet — nothing to reconcile');
  process.exit(0);
}

let booked = 0;
let skipped = 0;
for (const file of fs.readdirSync(researchDir).filter((name) => name.endsWith('.jsonl'))) {
  const agentId = file.slice(0, -'.jsonl'.length);
  if (!registry.get(agentId)) {
    console.log(`skip ${file}: unknown agent`);
    continue;
  }
  for (const briefing of await readJsonl(path.join(researchDir, file))) {
    const ref = `research:${briefing.at}`;
    const amount = Number(briefing.costUsd) || 0;
    if (amount <= 0) continue;
    const record = ledger.get(agentId);
    const already = (record?.events ?? []).some((event) => event.category === 'research' && event.ref === ref);
    if (already) {
      skipped += 1;
      continue;
    }
    try {
      ledger.charge(agentId, amount, { category: 'research', role: 'prospector', ref, at: Date.parse(briefing.at) });
      booked += 1;
      console.log(`booked ${amount} -> ${agentId} (${briefing.at})`);
    } catch (error) {
      console.log(`could not book ${agentId} ${briefing.at}: ${error?.message ?? error}`);
    }
  }
}
if (booked > 0) ledger.save();
console.log(`reconciled: ${booked} charge(s) booked, ${skipped} already present`);
