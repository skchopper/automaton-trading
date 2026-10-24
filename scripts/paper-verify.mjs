/**
 * Paper-account verification against the real Alpaca paper endpoint.
 * - one read-only cycle (no orders are expected; entries are blocked while the market is closed)
 * - one direct pre-trade wall check through the real brakes with the real clock
 * - one independent confirmation from the broker that no orders/positions exist
 *
 * Run: node scripts/paper-verify.mjs
 */
import fs from 'node:fs';
import { loadConfig, statePaths } from '../packages/automaton-trading/src/config.js';
import { createBroker } from '../packages/automaton-trading/src/broker-alpaca.js';
import { createAutomaton } from '../packages/automaton-trading/src/orchestrator.js';
import { createBrakes } from '../packages/automaton-trading/src/brakes.js';
import { createClock } from '../packages/automaton-trading/src/util.js';

const root = 'D:/CounterStikers';
const { config, secrets } = loadConfig({ cwd: root, env: {} });
const paths = statePaths(config);
const broker = createBroker(config, { secrets });
const clock = createClock();

console.log('mode', config.mode, '| universe', config.symbols.length, '| endowment', config.endowmentUsd);

const account = await broker.getAccount();
console.log('account:', JSON.stringify({ equity: account.equityUsd, cash: account.cashUsd, buyingPower: account.buyingPowerUsd, status: account.status, currency: account.currency }));
const marketClock = await broker.getClock();
console.log('clock:', JSON.stringify({ isOpen: marketClock.isOpen, nextOpen: marketClock.nextOpen, nextClose: marketClock.nextClose }));

// 1. one read-only cycle against real data
const automaton = await createAutomaton({ config, paths, broker, clock });
await automaton.init();
const trace = await automaton.tick();
console.log('\ntick:', trace.tickId, `in ${trace.durationMs}ms`);
console.log('  market:', JSON.stringify(trace.market));
console.log('  prospector:', JSON.stringify(trace.prospector));
console.log('  builds:', JSON.stringify((trace.builds ?? []).map((b) => ({ symbol: b.symbol, family: b.family, compiled: b.compiled }))));
console.log('  executions:', JSON.stringify((trace.executions ?? []).map((e) => ({ orders: e.orders, denied: e.denied, detail: e.detail }))));
console.log('  orders placed:', (trace.executions ?? []).reduce((n, e) => n + (e.orders ?? 0), 0));
if ((trace.errors ?? []).length) console.log('  errors:', JSON.stringify(trace.errors));

// 2. direct wall check with the real market clock (must deny while closed)
const internals = automaton._internals;
const aliveAgent = internals.registry.alive()[0];
const treasury = internals.state.lastTreasury;
const view = (treasury?.agentViews ?? []).find((row) => row.agentId === aliveAgent.id);
const mandate = treasury?.mandates?.[aliveAgent.id];
const spec = aliveAgent.specId ? internals.state.specs.get(aliveAgent.specId) : null;
const brakes = createBrakes({ config, paths, clock });
const quote = await broker.getLatestQuote(spec?.symbol ?? 'AAPL').catch(() => null);
const wall = brakes.checkOrder({
  mode: config.mode,
  now: clock.now(),
  agentId: aliveAgent.id,
  dayStats: { dayKey: 'paper-verify', ordersCount: 0, startEquityUsd: view?.equityUsd ?? 0, pnlUsd: 0 },
  quote,
  order: { symbol: spec?.symbol ?? 'AAPL', side: 'buy', qty: 1, priceUsd: quote?.ask ?? view?.equityUsd, notionalUsd: 100 },
  equityUsd: view?.equityUsd ?? config.endowmentUsd,
  positions: view?.positions ?? [],
  mandate,
  spec,
  accountEquityUsd: treasury?.account?.equityUsd ?? account.equityUsd,
  allocatedEquityUsd: treasury?.allocatedUsd ?? 0,
  spreadBps: quote?.bid > 0 ? ((quote.ask - quote.bid) / quote.bid) * 10000 : 0,
  // the orchestrator forwards the broker's own session state into the brake chain
  marketOpen: marketClock.isOpen,
  marketClock,
});
console.log('\nbrake wall (real clock, real quote):', JSON.stringify(wall));
console.log('  expected: DENY while the market is closed');

// 3. independent broker confirmation: no orders, no positions
const orders = await broker.getOrders({ status: 'all', limit: 20 });
const positions = await broker.getPositions();
console.log('\nbroker orders:', orders.length, orders.map((o) => `${o.symbol}:${o.side}:${o.status}`).join(', ') || '(none)');
console.log('broker positions:', positions.length, positions.map((p) => `${p.symbol}:${p.qty}`).join(', ') || '(none)');

const status = await automaton.status();
console.log('\nstatus:', JSON.stringify({
  mode: status.mode,
  running: status.engine.running,
  population: status.population,
  treasury: { state: status.treasury?.state, runwayHours: status.treasury?.runwayHours, burnPerHourUsd: status.treasury?.burnPerHourUsd, reconciliation: status.treasury?.reconciliation },
  account: status.account,
}));

const summary = {
  at: new Date().toISOString(),
  account: { equity: account.equityUsd, cash: account.cashUsd, status: account.status },
  marketOpen: marketClock.isOpen,
  tick: { market: trace.market, prospector: trace.prospector, orders: (trace.executions ?? []).reduce((n, e) => n + (e.orders ?? 0), 0) },
  wall: { decision: wall?.decision, code: wall?.code, brakeId: wall?.brakeId, reason: wall?.reason },
  ordersOnBroker: orders.length,
  positionsOnBroker: positions.length,
  population: status.population,
};
fs.writeFileSync(new URL('../automaton-data/paper-verification.json', import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
console.log('\nwrote automaton-data/paper-verification.json');
