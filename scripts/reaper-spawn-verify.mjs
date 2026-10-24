/**
 * Verify the engine spawns the EXTERNAL Reaper for paper mode, it sweeps the real paper
 * account, and that stopping the engine loop leaves it running by design (operator-only stop).
 * Run: node scripts/reaper-spawn-verify.mjs
 */
import { createEngine } from '../packages/automaton-trading/src/engine.js';

const engine = createEngine({
  cwd: 'D:/CounterStikers',
  overrides: { stateDir: 'D:/CounterStikers/automaton-data', envFile: 'D:/CounterStikers/.env', mode: 'paper' },
});

const started = await engine.start();
console.log('engine running:', started.engine?.running);
console.log('reaper:', JSON.stringify(started.engine?.reaper));
console.log('first tick:', started.engine?.ticks, 'lastTickAt', started.engine?.lastTickAt);

await new Promise((resolve) => setTimeout(resolve, 2000));
const whileRunning = await engine.status();
console.log('reaper after 2s:', JSON.stringify(whileRunning.engine?.reaper));

await engine.stop();
const afterStop = await engine.status();
console.log('after engine.stop() -> running:', afterStop.engine?.running, '| reaper:', JSON.stringify(afterStop.engine?.reaper));
console.log('NOTE: the external Reaper is deliberately still alive; only the operator stops it.');
