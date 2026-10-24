/**
 * Lead smoke test: compose the real modules against the simulated broker and run cycles.
 * Not part of the plugin; used during integration to surface contract mismatches fast.
 * Run: node scripts/smoke.mjs [cycles]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, statePaths } from '../packages/automaton-trading/src/config.js';
import { createBroker } from '../packages/automaton-trading/src/broker-sim.js';
import { createAutomaton } from '../packages/automaton-trading/src/orchestrator.js';
import { createClock } from '../packages/automaton-trading/src/util.js';
import { createEngine } from '../packages/automaton-trading/src/engine.js';

const cycles = Number(process.argv[2] ?? 5);
const stateDir = path.resolve('D:/CounterStikers/.tmp-smoke');

function wipe() {
  fs.rmSync(stateDir, { recursive: true, force: true });
}
wipe();

const clock = createClock();
const { config } = loadConfig({
  cwd: 'D:/CounterStikers',
  env: {},
  overrides: {
    mode: 'sim',
    paths: { stateDir, envFile: 'D:/CounterStikers/.env' },
    population: { initial: 3, cap: 5 },
    endowmentUsd: 5000,
    cycleIntervalSec: 300,
  },
});
const paths = statePaths(config);
const broker = createBroker(config, { seed: 11, accountEquityUsd: 100000 });
const automaton = await createAutomaton({ config, paths, broker, clock });

console.log('init…');
await automaton.init();
let status = await automaton.status();
console.log('population', status.population, 'account', status.account);

for (let i = 1; i <= cycles; i += 1) {
  try {
    const trace = await automaton.tick();
    console.log(
      `tick ${i}: state=${trace.treasury?.state} runway=${trace.treasury?.runwayHours} budget=${trace.treasury?.cycleBudgetUsd} ` +
        `hyps=${trace.prospector?.hypotheses ?? 0} builds=${trace.builds?.length ?? 0} execs=${trace.executions?.length ?? 0} ` +
        `orders=${(trace.executions ?? []).reduce((n, e) => n + (e.orders ?? 0), 0)} deaths=${(trace.deaths ?? []).length} errors=${(trace.errors ?? []).length}`,
    );
    for (const error of trace.errors ?? []) console.log('   error:', JSON.stringify(error));
  } catch (error) {
    console.error(`tick ${i} THREW`, error?.code ?? '', error?.message ?? error);
    console.error(error?.stack?.split('\n').slice(0, 6).join('\n'));
    break;
  }
}

status = await automaton.status();
console.log('\nfinal status:');
console.log('  population', JSON.stringify(status.population));
console.log('  treasury', JSON.stringify(status.treasury));
console.log('  agents:');
for (const agent of status.agents ?? []) {
  console.log('   ', agent.id, agent.status, 'equity', agent.equityUsd, 'runway', agent.runwayHours, 'state', agent.treasuryState, 'spec', agent.specId);
}
console.log('  obituaries', JSON.stringify(status.obituaries));
console.log('  lastError', JSON.stringify(status.engine?.lastError));

// engine facade smoke (sim mode, no credentials needed)
const engine = createEngine({
  overrides: { mode: 'sim', stateDir, envFile: 'D:/CounterStikers/.env' },
  cwd: 'D:/CounterStikers',
});
const probe = await engine.probe();
console.log('\nengine.probe:', JSON.stringify({ mode: probe.mode, equity: probe.account?.equityUsd, hasCredentials: probe.hasCredentials, error: probe.error?.code }));
const cfgView = engine.configView();
console.log('engine.configView keys:', Object.keys(cfgView.config).join(','));

// simulate smoke
const sim = await engine.simulate({ cycles: 60, population: 24, seed: 5 });
const summary = sim?.summary ?? sim?.stats ?? sim?.results ?? sim;
console.log('\nsimulate summary keys:', Object.keys(summary ?? {}).join(','));
console.log('simulate sample:', JSON.stringify(summary).slice(0, 600));
