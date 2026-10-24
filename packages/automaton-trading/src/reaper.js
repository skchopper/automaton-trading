/**
 * reaper.js — death execution, independent of the engine and of any verdict file.
 *
 * The Reaper re-derives death from broker state plus the virtual ledger's marks:
 * it never reads `deaths.json` and no engine code path can call, disable or reschedule
 * it (the standalone entry is `reaper-process.js`). Kill sequence, grace_seconds = 0:
 *
 *   1. cancel the agent's open orders
 *   2. market-sell every position it holds (day order; queued at next open if closed)
 *   3. mark the virtual book at the broker's marks and sweep residual cash to '__treasury__'
 *   4. registry.markDead (one-way)
 *   5. journal.append(obituary)
 *
 * Every step is idempotent: a second sweep sees the agent dead and does nothing, and a
 * sweep that crashes mid-sequence is completed by the next one.
 *
 * Owned by mortality-core. Contract: docs/CONTRACTS.md ("Mortality modules").
 */

import { AutomatonError } from './contracts.js';
import { errorInfo, readJsonSync, round2, round4, SYSTEM_CLOCK } from './util.js';
import { statePaths } from './config.js';
import { burnPerHour, computeRunwayHours, effectiveDeathFloor } from './treasurer.js';
import { TREASURY_ID } from './ledger.js';

const HOUR_MS = 60 * 60 * 1000;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function marksFromPositions(brokerPositions, prices = {}) {
  const marks = isPlainObject(prices) ? { ...prices } : {};
  for (const position of brokerPositions ?? []) {
    const symbol = String(position?.symbol ?? '').toUpperCase();
    if (symbol === '') continue;
    const qty = Number(position?.qty);
    const marketValue = Number(position?.marketValueUsd);
    if (Number.isFinite(qty) && qty !== 0 && Number.isFinite(marketValue) && marketValue > 0) {
      marks[symbol] = round4(Math.abs(marketValue / qty));
    }
  }
  return marks;
}

/**
 * @param {{ broker: object, registry: object, ledger: object, journal: object,
 *   config: object, paths?: object, clock?: object }} options
 */
export function createReaper({ broker, registry, ledger, journal, config, paths, clock } = {}) {
  if (!broker || !registry || !ledger || !journal || !config) {
    throw new AutomatonError(
      'CONFIG_INVALID',
      'createReaper requires { broker, registry, ledger, journal, config }',
      {},
    );
  }
  const currentClock = clock && typeof clock.now === 'function' ? clock : SYSTEM_CLOCK;
  const resolved = { ...statePaths(config), ...(paths ?? {}) };

  /**
   * Day P&L is persisted by the engine's Treasurer (state/day-stats.json). The Reaper reads
   * the *record*, not the engine's live memory, so `daily_loss_limit` becomes a cause the
   * external process can actually re-derive and execute — otherwise the Treasurer could
   * declare a fatal cause that no Reaper ever carries out (a frozen condemned agent).
   */
  function readDayStats() {
    const raw = readJsonSync(resolved.dayStats, null);
    return raw && typeof raw === 'object' && raw.agents && typeof raw.agents === 'object' ? raw : null;
  }

  async function fetchBrokerState() {
    const errors = [];
    let account = null;
    let positions = [];
    try {
      account = await broker.getAccount();
    } catch (error) {
      errors.push({ scope: 'account', error: errorInfo(error) });
    }
    if (account) {
      try {
        positions = (await broker.getPositions?.()) ?? [];
      } catch (error) {
        errors.push({ scope: 'positions', error: errorInfo(error) });
      }
    }
    return { account, positions, errors };
  }

  /** Cancel every open order that carries this agent's attribution prefix. */
  async function cancelOpenOrders(agentId) {
    /** @type {object[]} */
    const canceled = [];
    let open = [];
    try {
      open = (await broker.getOrders?.({ status: 'open', limit: 500 })) ?? [];
    } catch (error) {
      return [{ error: errorInfo(error), scope: 'getOrders' }];
    }
    const prefix = `atm:${agentId}:`;
    for (const order of open) {
      const clientOrderId = String(order?.clientOrderId ?? order?.client_order_id ?? '');
      if (!clientOrderId.startsWith(prefix)) continue;
      try {
        const result = await broker.cancelOrder(order.id);
        canceled.push({ id: order.id, clientOrderId, status: result?.status ?? 'canceled' });
      } catch (error) {
        canceled.push({ id: order.id, clientOrderId, status: 'cancel_failed', error: errorInfo(error) });
      }
    }
    return canceled;
  }

  async function liquidate(agentId, marks, marketOpen, at) {
    const liquidated = [];
    const book = ledger.book(agentId);
    let sequence = 0;
    for (const [symbol, position] of Object.entries(book.positions)) {
      const qty = round4(Number(position?.qty));
      if (!(qty > 0)) continue;
      sequence += 1;
      const mark = Number(marks[symbol]) > 0 ? Number(marks[symbol]) : Number(position?.avgPriceUsd) || 0;
      try {
        const order = await broker.submitOrder({
          symbol,
          side: 'sell',
          qty,
          type: 'market',
          timeInForce: 'day',
          clientOrderId: `atm:${agentId}:reaper:${sequence}`,
        });
        const fillPrice = Number(order?.avgFillPriceUsd) > 0 ? Number(order.avgFillPriceUsd) : mark;
        ledger.applyFill(agentId, {
          symbol,
          side: 'sell',
          qty,
          priceUsd: fillPrice,
          at,
          orderId: order?.id ?? null,
        });
        liquidated.push({
          symbol,
          qty,
          orderId: order?.id ?? null,
          priceUsd: round4(fillPrice),
          status: order?.status ?? 'submitted',
          queued: marketOpen === false,
        });
      } catch (error) {
        liquidated.push({ symbol, qty, status: 'failed', error: errorInfo(error) });
      }
    }
    return liquidated;
  }

  function buildObituary(agent, cause, finalEquityUsd, at, atMs) {
    const snapshot = ledger.snapshot(agent.id);
    const endowmentUsd = round2(Number(agent.endowmentUsd ?? config.endowmentUsd) || 0);
    const bornAtMs = Date.parse(agent.bornAt);
    const bornAt = Number.isFinite(bornAtMs) ? new Date(bornAtMs).toISOString() : at;
    const lifespanHours = Number.isFinite(bornAtMs) ? round2(Math.max(0, (atMs - bornAtMs) / HOUR_MS)) : 0;
    const finalEquity = round2(Number(finalEquityUsd) || 0);
    return {
      agentId: agent.id,
      name: agent.name ?? null,
      parentId: agent.parentId ?? null,
      // Generation 0 is a valid generation: never let truthiness turn genesis into 1.
      generation: Number.isFinite(Number(agent.generation)) ? Number(agent.generation) : 0,
      bornAt,
      diedAt: at,
      lifespanHours,
      endowmentUsd,
      finalEquityUsd: finalEquity,
      revenueUsd: round2(snapshot.grossRevenueUsd),
      spendUsd: round2(snapshot.grossSpendUsd + snapshot.costsUsd),
      netPlUsd: round2(finalEquity - endowmentUsd),
      genome: isPlainObject(agent.genome) ? agent.genome : {},
      mutation: agent.mutation ?? null,
      productsShipped: 0,
      tradesCount: snapshot.trades,
      firstProfitAt: snapshot.firstProfitAt ?? null,
      strategySpecId: agent.specId ?? null,
      cause,
      lastRunwayHours: computeRunwayHours(
        finalEquity,
        effectiveDeathFloor(config, endowmentUsd),
        burnPerHour(config, 1),
      ),
      lessons: [],
    };
  }

  /** Execute one death. Idempotent by construction. */
  async function killAgent(agent, cause, marks, marketOpen, at, atMs) {
    const agentId = agent.id;
    const orders = await cancelOpenOrders(agentId);
    const liquidated = await liquidate(agentId, marks, marketOpen, at);
    const finalEquity = ledger.equity(agentId, marks);
    // Sweep whatever cash remains after liquidation; the virtual estate returns to the pool.
    // Use the ledger's exact (8dp) cash, not the 2dp display snapshot, or a sub-cent
    // rounding difference can make the estate "insufficient" and block a legitimate kill.
    let sweptUsd = 0;
    const exactCashUsd = Number(ledger.get?.(agentId)?.cashUsd ?? 0);
    if (exactCashUsd > 0) {
      ledger.transfer(agentId, TREASURY_ID, exactCashUsd, { reason: 'death_sweep', at });
      sweptUsd = round2(exactCashUsd);
    }
    let deadAgent;
    try {
      deadAgent = registry.markDead(agentId, { cause, at, finalEquityUsd: finalEquity.equityUsd });
    } catch (error) {
      if (error?.code === 'AGENT_DEAD') {
        deadAgent = registry.get(agentId);
      } else {
        throw error;
      }
    }
    if (deadAgent && !journal.has(agentId)) {
      journal.append(buildObituary(deadAgent, cause, finalEquity.equityUsd, at, atMs));
    }
    // Persist immediately: the Reaper is the only process that may write a death, and the
    // engine process reads these two files to learn that an agent is gone. Without this
    // save the kill exists only in this process's memory and a restart resurrects the agent.
    await registry.save();
    await ledger.save();
    return {
      agentId,
      cause,
      finalEquityUsd: finalEquity.equityUsd,
      liquidated,
      orders,
      sweptUsd,
    };
  }

  /**
   * Finish anything a crashed sweep left behind for an already-dead agent: retry the
   * liquidation, sweep residual cash, and append the missing obituary.
   */
  async function settleDeadAgent(agent, marks, marketOpen, at, atMs) {
    const agentId = agent.id;
    if (!ledger.has(agentId)) ledger.ensureAgent(agentId, { endowmentUsd: agent.endowmentUsd ?? 0, at });
    const book = ledger.book(agentId);
    const hasPositions = Object.values(book.positions).some((position) => Number(position?.qty) > 0);
    const needsObituary = !journal.has(agentId);
    const snapshot = ledger.snapshot(agentId);
    if (!hasPositions && !needsObituary && snapshot.cashUsd <= 0) {
      return { settled: false, sweptUsd: 0 };
    }
    const orders = await cancelOpenOrders(agentId);
    const liquidated = await liquidate(agentId, marks, marketOpen, at);
    const equity = ledger.equity(agentId, marks);
    const after = ledger.get?.(agentId) ?? ledger.snapshot(agentId);
    let sweptUsd = 0;
    if (Number(after.cashUsd) > 0) {
      ledger.transfer(agentId, TREASURY_ID, Number(after.cashUsd), { reason: 'death_sweep-recovery', at });
      sweptUsd = round2(Number(after.cashUsd));
    }
    if (needsObituary) {
      const storedFinalEquity = Number(agent.finalEquityUsd);
      const finalEquityUsd =
        Number.isFinite(storedFinalEquity) && storedFinalEquity > 0 ? storedFinalEquity : equity.equityUsd;
      journal.append(buildObituary(agent, agent.cause ?? 'insufficient_funds', finalEquityUsd, at, atMs));
    }
    await registry.save();
    await ledger.save();
    return { settled: true, sweptUsd, liquidated, orders };
  }

  /**
   * One death sweep. Re-derives death independently from broker equity + ledger marks.
   *
   * @param {{ prices?: Record<string, number> }} [options]
   * @returns {Promise<{ at: string, killed: object[], checked: number,
   *   skipped: object[], errors?: object[] }>}
   */
  async function sweep({ prices = {} } = {}) {
    const atMs = currentClock.now();
    const at = new Date(atMs).toISOString();
    /** @type {object[]} */
    const killed = [];
    /** @type {object[]} */
    const skipped = [];
    const { account, positions: brokerPositions, errors } = await fetchBrokerState();
    if (!account) {
      skipped.push({
        agentId: null,
        reason: `broker_unavailable: ${errors[0]?.error?.message ?? 'account unavailable'}`,
      });
      return { at, killed, checked: 0, skipped, errors };
    }

    const marks = marksFromPositions(brokerPositions, prices);
    let marketOpen = true;
    try {
      const clockInfo = await broker.getClock?.();
      if (clockInfo && clockInfo.isOpen === false) marketOpen = false;
    } catch (error) {
      errors.push({ scope: 'clock', error: errorInfo(error) });
    }

    const aliveAgents = registry.alive();
    const checked = aliveAgents.length;
    const totalFloorsUsd = round2(
      advanceSum(
        aliveAgents.map((agent) =>
          effectiveDeathFloor(config, agent.endowmentUsd ?? config.endowmentUsd),
        ),
      ),
    );
    const accountEquityUsd = Number(account.equityUsd);
    const accountActive = String(account.status ?? '').toUpperCase() === 'ACTIVE';
    const dayStats = readDayStats();
    const maxDailyLossPct = Number(config.risk?.maxDailyLossPct ?? 0);
    // The last line of defence: if the broker account itself can no longer cover the
    // population's collective death floors, the population is dead (article rule at
    // account scope), not merely one agent.
    const systemDead =
      Number.isFinite(accountEquityUsd) && totalFloorsUsd > 0 && accountEquityUsd <= totalFloorsUsd;

    for (const agent of aliveAgents) {
      const agentId = agent.id;
      try {
        if (!ledger.has(agentId)) {
          ledger.ensureAgent(agentId, {
            endowmentUsd: Number(agent.endowmentUsd ?? config.endowmentUsd),
            at,
          });
        }
        const equity = ledger.equity(agentId, marks);
        const endowmentUsd = Number(agent.endowmentUsd ?? config.endowmentUsd) || 0;
        const floorUsd = effectiveDeathFloor(config, endowmentUsd);
        const drawdownThreshold = round2(endowmentUsd * (1 - Number(config.maxDrawdownPct ?? 0)));
        let cause = null;
        if (equity.equityUsd <= floorUsd) cause = 'insufficient_funds';
        else if (equity.equityUsd <= drawdownThreshold) cause = 'drawdown_limit';
        else if (systemDead) cause = 'insufficient_funds';
        if (!cause && dayStats && maxDailyLossPct > 0) {
          const dayEntry = dayStats.agents?.[agentId];
          const startEquityUsd = Number(dayEntry?.startEquityUsd);
          const pnlUsd = Number(dayEntry?.pnlUsd);
          if (Number.isFinite(startEquityUsd) && startEquityUsd > 0 && Number.isFinite(pnlUsd)) {
            if (-pnlUsd / startEquityUsd >= maxDailyLossPct) cause = 'daily_loss_limit';
          }
        }
        if (!cause && !accountActive) cause = 'account_not_active';
        if (!cause) continue;
        killed.push(await killAgent(agent, cause, marks, marketOpen, at, atMs));
      } catch (error) {
        skipped.push({ agentId, reason: `kill_failed: ${error?.message ?? error}` });
      }
    }

    // Recovery path for agents a previous (crashed) sweep left half-settled.
    for (const agent of registry.dead()) {
      try {
        const result = await settleDeadAgent(agent, marks, marketOpen, at, atMs);
        skipped.push({ agentId: agent.id, reason: 'already_dead', settled: result.settled === true });
      } catch (error) {
        skipped.push({ agentId: agent.id, reason: `settle_failed: ${error?.message ?? error}` });
      }
    }

    const result = { at, killed, checked, skipped };
    if (errors.length > 0) result.errors = errors;
    return result;
  }

  return { sweep };
}

function advanceSum(values) {
  let total = 0;
  for (const value of values) total += Number(value) || 0;
  return total;
}
