#!/usr/bin/env node
/**
 * AUTOMATON TRADING — operator CLI.
 *
 *   node bin/automaton.mjs <command> [options]
 *
 * Commands:
 *   status            one-screen population/treasury snapshot (from the last persisted tick)
 *   tick              run exactly one cycle now
 *   run               run the cycle loop until Ctrl+C
 *   probe             verify Alpaca credentials and account connectivity without trading
 *   simulate          accelerated mortality simulation (no network, no real money)
 *   journal           recent obituaries + death statistics
 *   brakes            the hard-denial catalogue + a dry-run order check
 *   config            effective config (redacted) and resolved paths
 *   emergency-stop    arm the kill switch and stop the loop (requires --confirm STOP)
 *   clear-kill        remove the kill switch (operator only)
 *   arm-live          create LIVE_ARMED (requires mode=live + --confirm "ARM LIVE")
 *
 * Options:
 *   --state-dir <dir> --env-file <file> --mode <sim|paper|live> --config <file>
 *   --cycles <n> --population <n> --seed <n> --limit <n>
 *   --symbol <SYM> --side buy|sell --notional <usd> --agent <id>
 *   --confirm <phrase> --json
 */

import { parseArgs } from 'node:util';
import { createEngine } from '../src/engine.js';

const OPTIONS = {
  'state-dir': { type: 'string' },
  'env-file': { type: 'string' },
  mode: { type: 'string' },
  config: { type: 'string' },
  cycles: { type: 'string' },
  population: { type: 'string' },
  seed: { type: 'string' },
  limit: { type: 'string' },
  symbol: { type: 'string' },
  side: { type: 'string' },
  notional: { type: 'string' },
  agent: { type: 'string' },
  confirm: { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const HELP = `AUTOMATON TRADING — mortality-engineered trading population on Alpaca

Usage: node bin/automaton.mjs <command> [options]

Commands:
  status            population/treasury snapshot from the last persisted tick
  tick              run exactly one cycle now
  run               run the cycle loop until Ctrl+C (starts the external Reaper in paper/live)
  probe             verify Alpaca credentials + account connectivity, no orders
  simulate          accelerated mortality simulation (offline)
  journal           recent obituaries and death statistics
  brakes            hard-denial catalogue and optional dry-run order check
  config            effective redacted config + resolved paths
  emergency-stop    arm kill switch + stop loop (needs --confirm STOP)
  clear-kill        remove the kill switch
  arm-live          create LIVE_ARMED (needs mode=live and --confirm "ARM LIVE")

Options:
  --state-dir <dir>  --env-file <file>  --mode <sim|paper|live>  --config <file>
  --cycles <n> --population <n> --seed <n> --limit <n>
  --symbol <SYM> --side <buy|sell> --notional <usd> --agent <id>
  --confirm <phrase> --json

Examples:
  node bin/automaton.mjs probe
  node bin/automaton.mjs tick
  node bin/automaton.mjs simulate --cycles 240 --population 120 --seed 11
  node bin/automaton.mjs java  # (invalid, prints help)
`;

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function pct(value, digits = 2) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(digits)}%`;
}

function usd(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `$${value.toFixed(2)}`;
}

function hh(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 48) return `${(value / 24).toFixed(1)}d`;
  return `${value.toFixed(1)}h`;
}

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }
  const command = positionals[0];
  const overrides = {};
  if (values['state-dir']) overrides.stateDir = values['state-dir'];
  if (values['env-file']) overrides.envFile = values['env-file'];
  if (values.mode) overrides.mode = values.mode;
  const engine = createEngine({
    overrides,
    configFile: values.config,
    envFile: values['env-file'] ?? overrides.envFile,
    cwd: process.cwd(),
  });

  switch (command) {
    case 'status': {
      const status = await engine.status();
      if (values.json) return print(status);
      return printHumanStatus(status);
    }
    case 'tick': {
      const { trace } = await engine.tick();
      if (values.json) return print(trace);
      printHumanTrace(trace);
      return undefined;
    }
    case 'run': {
      await engine.start();
      const status = await engine.status();
      printHumanStatus(status);
      console.log('\ncycle loop running (Ctrl+C to stop; the external Reaper keeps running)');
      await new Promise((resolve) => {
        const shutdown = async () => {
          console.log('\nstopping engine loop (Reaper left running)...');
          await engine.stop();
          resolve();
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
      });
      return undefined;
    }
    case 'probe': {
      const probe = await engine.probe();
      if (values.json) return print(probe);
      console.log(`mode:            ${probe.mode}`);
      console.log(`credentials:     ${probe.hasCredentials ? 'present' : 'MISSING'}`);
      console.log(`live armed:      ${probe.liveArmed ? 'YES' : 'no'}`);
      if (probe.account) {
        console.log(`account equity:  ${usd(Number(probe.account.equityUsd))}`);
        console.log(`cash:            ${usd(Number(probe.account.cashUsd))}`);
        console.log(`buying power:    ${usd(Number(probe.account.buyingPowerUsd))}`);
        console.log(`status:          ${probe.account.status}`);
      }
      if (probe.clock) console.log(`market open:     ${probe.clock.isOpen}`);
      if (probe.error) console.log(`error:           ${probe.error.code} ${probe.error.message}`);
      return undefined;
    }
    case 'simulate': {
      const result = await engine.simulate({
        cycles: Number(values.cycles ?? 200),
        population: Number(values.population ?? 100),
        seed: Number(values.seed ?? 7),
      });
      if (values.json) return print(result);
      return printSimulation(result);
    }
    case 'journal': {
      const journal = await engine.obituaries({ limit: Number(values.limit ?? 10) });
      if (values.json) return print(journal);
      console.log(`obituaries: ${journal.stats?.total ?? 0}`);
      console.log(`stats: ${JSON.stringify(journal.stats ?? {})}`);
      for (const item of journal.items ?? []) {
        console.log(
          `- ${item.agentId} gen ${item.generation} ${item.cause} lifespan ${hh(item.lifespanHours)} ` +
            `net ${usd(item.netPlUsd)} firstProfit ${item.firstProfitAt ? 'yes' : 'null'}`,
        );
      }
      return undefined;
    }
    case 'brakes': {
      const view = await engine.brakesView();
      if (values.json && !values.symbol) return print(view);
      console.log('Hard denials:');
      for (const rule of view.rules ?? []) console.log(`  ${rule.id} ${rule.code} — ${rule.rule}`);
      console.log(`\nmode: ${view.mode}  killSwitch: ${view.killSwitch ? 'ARMED' : 'clear'}  liveArmed: ${view.liveArmed}`);
      if (values.symbol) {
        const check = await engine.preTradeCheck({
          agentId: values.agent ?? 'operator-probe',
          symbol: values.symbol,
          side: values.side ?? 'buy',
          notionalUsd: Number(values.notional ?? 100),
        });
        console.log('\ndry-run check:', JSON.stringify(check, null, 2));
      }
      return undefined;
    }
    case 'config': {
      const view = engine.configView();
      return print(view);
    }
    case 'emergency-stop': {
      if (values.confirm !== 'STOP') fail('emergency-stop requires --confirm STOP');
      const result = await engine.emergencyStop();
      return print(result);
    }
    case 'clear-kill': {
      const result = await engine.clearEmergencyStop();
      return print(result);
    }
    case 'arm-live': {
      const result = await engine.armsLive({ confirm: values.confirm });
      return print(result);
    }
    default:
      return fail(`unknown command "${command}"\n\n${HELP}`);
  }
}

function printHumanStatus(status) {
  const engine = status.engine ?? {};
  const treasury = status.treasury ?? {};
  const population = status.population ?? {};
  console.log('AUTOMATON TRADING');
  console.log(`  mode:            ${status.mode}${engine.running ? ' (loop running)' : ''}`);
  console.log(`  kill switch:     ${engine.killSwitch ? 'ARMED' : 'clear'}   live armed: ${engine.liveArmed ? 'YES' : 'no'}`);
  if (engine.reaper) {
    console.log(`  reaper:          ${engine.reaper.alive ? `pid ${engine.reaper.pid} alive` : `not running${engine.reaper.error ? ` (${engine.reaper.error})` : ''}`}`);
  }
  if (status.account) {
    console.log(`  account equity:  ${usd(status.account.equityUsd)}   cash: ${usd(status.account.cashUsd)}`);
  }
  if (treasury.state) {
    console.log(
      `  treasury:        ${treasury.state}   runway ${hh(treasury.runwayHours)}   burn ${usd(treasury.burnPerHourUsd)}/h   budget ${usd(treasury.cycleBudgetUsd)}/cycle`,
    );
    console.log(`  surplus 7d:      ${usd(treasury.surplus7dUsd)}   may replicate: ${treasury.mayReplicate ? 'YES' : 'no'}`);
    if (treasury.reconciliation) console.log(`  reconciliation:  ${treasury.reconciliation.ok ? 'ok' : 'MISMATCH'} (delta ${usd(treasury.reconciliation.deltaUsd)})`);
  }
  if (status.halted) console.log(`  HALTED:          ${(status.haltReasons ?? []).join(', ')}`);
  console.log(`  population:      ${population.alive ?? 0} alive / ${population.dead ?? 0} dead / cap ${population.cap ?? '?'}`);
  console.log(`  obituaries:      ${status.obituaries?.total ?? 0}   last tick: ${engine.lastTickAt ?? 'never'}`);
  const agents = status.agents ?? [];
  if (agents.length > 0) {
    console.log('\n  agents:');
    for (const agent of agents) {
      const badge = agent.status === 'dead' ? 'DEAD' : agent.status === 'condemned' ? 'CONDEMNED' : 'alive';
      console.log(
        `   - ${agent.id} gen ${agent.generation} ${badge.padEnd(9)} equity ${usd(agent.equityUsd)} ` +
          `runway ${hh(agent.runwayHours)} ${agent.treasuryState ?? ''} ${agent.cause ? `cause ${agent.cause}` : ''}`,
      );
    }
  }
  if (engine.lastError) console.log(`\n  last error: ${engine.lastError.code}: ${engine.lastError.message}`);
}

function printHumanTrace(trace) {
  console.log(`tick ${trace.tickId} in ${trace.durationMs}ms  mode ${trace.mode}${trace.halted ? '  HALTED' : ''}`);
  if (trace.account) console.log(`  account equity: ${usd(trace.account.equityUsd)}`);
  if (trace.treasury) console.log(`  treasury: ${trace.treasury.state} runway ${hh(trace.treasury.runwayHours)} budget ${usd(trace.treasury.cycleBudgetUsd)}`);
  console.log(`  market: ${trace.market?.symbols ?? 0} symbols, ${trace.market?.bars ?? 0} bars, ${trace.market?.quotes ?? 0} quotes`);
  console.log(`  prospector: ${trace.prospector ? `${trace.prospector.hypotheses} hypotheses, $${trace.prospector.spentUsd}` : 'skipped'}`);
  console.log(`  builds: ${(trace.builds ?? []).length}   executions: ${(trace.executions ?? []).length}   orders: ${(trace.executions ?? []).reduce((n, e) => n + (e.orders ?? 0), 0)}`);
  if ((trace.executions ?? []).length > 0) {
    for (const execution of trace.executions) {
      console.log(`   - ${execution.agentId}: ${execution.actions} actions, ${execution.orders} orders, ${execution.denied} denied`);
    }
  }
  if (trace.replication) console.log(`  replication: ${JSON.stringify(trace.replication)}`);
  if ((trace.deaths ?? []).length > 0) console.log(`  death verdicts: ${trace.deaths.map((d) => `${d.agentId}:${d.cause}`).join(', ')}`);
  for (const error of trace.errors ?? []) console.log(`  ${error.role} ${error.code}: ${error.message}`);
  if (trace.halted) console.log(`  halted: ${(trace.haltReasons ?? []).join(', ')}`);
}

function printSimulation(result) {
  const summary = result?.summary ?? result?.stats ?? result?.results ?? result;
  console.log('MORTALITY SIMULATION');
  if (!summary || typeof summary !== 'object') return print(result);
  const keys = ['cycles', 'population', 'survived', 'died', 'total', 'survivalRate', 'medianLifespanHours', 'meanLifespanHours', 'firstProfitRate', 'durationMs'];
  for (const key of keys) {
    if (summary[key] !== undefined) console.log(`  ${key.padEnd(20)} ${summary[key]}`);
  }
  if (summary.causes) console.log(`  causes               ${JSON.stringify(summary.causes)}`);
  if (summary.generations) console.log(`  generations          ${JSON.stringify(summary.generations)}`);
  if (!keys.some((key) => summary[key] !== undefined)) print(result);
  return undefined;
}

main().catch((error) => {
  if (error?.code === 'CONFIG_INVALID' || error?.code === 'LIVE_NOT_ARMED' || error?.code === 'MODE_FORBIDDEN') {
    fail(`${error.code}: ${error.message}`);
  }
  fail(error?.stack ?? String(error));
});
