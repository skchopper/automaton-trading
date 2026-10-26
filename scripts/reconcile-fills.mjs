/**
 * One-off: book broker fills the virtual ledger missed (e.g. orders that were `accepted`
 * when submitted but filled asynchronously). Safe to run while the engine loop is stopped.
 *
 * Run: node scripts/reconcile-fills.mjs
 */
import { loadConfig, statePaths } from '../packages/automaton-trading/src/config.js';
import { createBroker } from '../packages/automaton-trading/src/broker-alpaca.js';
import { createLedger } from '../packages/automaton-trading/src/ledger.js';
import { createRegistry } from '../packages/automaton-trading/src/registry.js';
import { createClock } from '../packages/automaton-trading/src/util.js';

const root = 'D:/CounterStikers';
const { config, secrets } = loadConfig({ cwd: root, env: {} });
const paths = statePaths(config);
const clock = createClock();
const broker = createBroker(config, { secrets });
const ledger = createLedger({ paths, config, clock });
const registry = createRegistry({ paths, config, clock });
await ledger.load();
await registry.load();

const orders = await broker.getOrders({ status: 'all', limit: 200 });
const filled = orders.filter((order) => ['filled', 'partially_filled'].includes(String(order.status)));
console.log(`broker orders: ${orders.length} (filled: ${filled.length})`);

let bookedCount = 0;
let bookedQty = 0;
for (const order of filled) {
  const clientOrderId = String(order.clientOrderId ?? '');
  const match = /^atm:(atm-[0-9a-f]{8}):/.exec(clientOrderId);
  if (!match) continue;
  const agentId = match[1];
  if (!registry.get(agentId)) {
    console.log(`skip ${order.id}: unknown agent ${agentId}`);
    continue;
  }
  const history = ledger.history(agentId, { limit: 250 });
  const already = history
    .filter((fill) => fill.orderId === order.id)
    .reduce((sum, fill) => sum + Number(fill.qty || 0), 0);
  const delta = Math.round((Number(order.filledQty) - already) * 1e4) / 1e4;
  if (!(delta > 0) || !(Number(order.avgFillPriceUsd) > 0)) continue;
  await ledger.applyFill(agentId, {
    symbol: order.symbol,
    side: order.side,
    qty: delta,
    priceUsd: Number(order.avgFillPriceUsd),
    at: clock.now(),
    orderId: order.id,
  });
  bookedCount += 1;
  bookedQty += delta;
  const agent = registry.get(agentId);
  console.log(`booked ${order.symbol} ${order.side} ${delta} @ ${order.avgFillPriceUsd} -> ${agent?.name ?? agentId}`);
}
await ledger.save();
console.log(`booked ${bookedCount} fill(s), qty ${bookedQty}`);

console.log('\nledger after reconciliation:');
for (const agent of registry.all()) {
  const snapshot = ledger.snapshot(agent.id);
  if (Object.keys(snapshot.positions ?? {}).length === 0 && (snapshot.trades ?? 0) === 0) continue;
  const marks = Object.fromEntries(
    Object.entries(snapshot.positions ?? {}).map(([symbol, position]) => [symbol, position.avgPriceUsd]),
  );
  const equity = ledger.equity(agent.id, marks);
  console.log(
    `  ${agent.name} (${agent.id}) cash ${snapshot.cashUsd.toFixed(2)} positions ${JSON.stringify(snapshot.positions)} equity ${equity.equityUsd.toFixed(4)} trades ${snapshot.trades}`,
  );
}
