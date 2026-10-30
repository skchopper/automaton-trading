/**
 * test/instruments.test.js — Lead-owned verification for multi-instrument playbooks, permissions,
 * affordability, option-policy normalization and the bot-agent instrument policy (v3.0).
 *
 * Run directly: cd packages/automaton-trading && node test/instruments.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAMILY_PLAYBOOKS,
  OPTION_STRUCTURES,
  agentInstrumentPermissions,
  contractsForBudget,
  isShortOptionStructure,
  isSpreadStructure,
  normalizeInstrumentPolicy,
  optionPremiumBudget,
  optionRightForStructure,
  playbookForFamily,
  playbookView,
  resolveInstrumentPermissions,
  spreadWidthPct,
  structuresForDirection,
  targetDTE,
} from '../src/instruments.js';
import { normalizePolicy } from '../src/bot-agent.js';

const fullConfig = {
  instruments: {
    enabled: true,
    allowMargin: true,
    maxMarginPctEquity: 1,
    allowShort: true,
    maxShortPctEquity: 1,
    maxShortNotionalUsd: 25,
    shortableOnly: true,
    allowOptions: true,
    allowCoveredCalls: true,
    allowSpreads: true,
    maxOptionPremiumPctEquity: 0.25,
    maxOptionPremiumUsd: 25,
    maxContracts: 3,
    minDTE: 2,
    maxDTE: 14,
    autoCloseDTE: 1,
    allowNakedShortOptions: false,
    optionDataFeed: 'indicative',
  },
};

describe('instrument permissions and playbooks', () => {
  it('exposes margin/short/long options/spreads/covered calls, never naked shorts', () => {
    const permissions = resolveInstrumentPermissions(fullConfig);
    assert.equal(permissions.enabled, true);
    assert.equal(permissions.margin, true);
    assert.equal(permissions.shortStock, true);
    assert.equal(permissions.longOptions, true);
    assert.equal(permissions.coveredCalls, true);
    assert.equal(permissions.spreads, true);
    assert.deepEqual(permissions.allowedStructures.sort(), [
      'bear_put_spread', 'bull_call_spread', 'call_credit_spread', 'covered_call',
      'long_call', 'long_put', 'put_credit_spread',
    ].sort());
    assert.equal(permissions.allowedStructures.includes('naked_short_call'), false);
  });

  it('honours disable flags and can restrict option selling while keeping long options', () => {
    const noSpreads = resolveInstrumentPermissions({
      instruments: { ...fullConfig.instruments, allowSpreads: false, allowCoveredCalls: false },
    });
    assert.equal(noSpreads.spreads, false);
    assert.equal(noSpreads.coveredCalls, false);
    assert.equal(noSpreads.longOptions, true);
    assert.deepEqual(noSpreads.allowedStructures, ['long_call', 'long_put']);
    const off = resolveInstrumentPermissions({ instruments: { ...fullConfig.instruments, enabled: false } });
    assert.equal(off.enabled, false);
    assert.equal(off.margin, false);
    assert.equal(off.shortStock, false);
    assert.deepEqual(off.allowedStructures, []);
  });

  it('gives every swing/day family explicit bullish/bearish instrument playbooks', () => {
    for (const family of ['momentum', 'meanrev', 'breakout', 'gapfade']) {
      const book = playbookForFamily(family);
      assert.ok(book.bullish.length > 0, `${family} needs a bullish playbook`);
      assert.ok(book.bearish.length > 0, `${family} needs a bearish playbook`);
      assert.ok(book.summary.length > 0);
      for (const structure of [...book.bullish, ...book.bearish]) {
        assert.ok(
          structure === 'long_stock' || structure === 'short_stock' || OPTION_STRUCTURES[structure],
          `${family} playbook references unknown structure ${structure}`,
        );
      }
    }
    assert.ok(FAMILY_PLAYBOOKS.gapfade.bearish.includes('covered_call'));
    assert.ok(FAMILY_PLAYBOOKS.breakout.bullish.includes('long_call'));
    assert.ok(FAMILY_PLAYBOOKS.momentum.bearish.includes('short_stock'));
    assert.ok(FAMILY_PLAYBOOKS.meanrev.bearish.includes('call_credit_spread'));
    assert.equal(isSpreadStructure('bull_call_spread'), true);
    assert.equal(isSpreadStructure('long_call'), false);
    assert.equal(isShortOptionStructure('covered_call'), true);
    assert.equal(isShortOptionStructure('long_put'), false);
    assert.equal(optionRightForStructure('put_credit_spread'), 'put');
    assert.equal(optionRightForStructure('call_credit_spread'), 'call');
    assert.ok(structuresForDirection('gapfade', 'bearish').includes('covered_call'));
    assert.ok(spreadWidthPct('day') < spreadWidthPct('swing') || spreadWidthPct('swing') > 0);
  });

  it('filters playbook views to the permitted structures', () => {
    const permissions = resolveInstrumentPermissions(fullConfig);
    const view = playbookView('gapfade', permissions);
    assert.equal(view.family, 'gapfade');
    assert.ok(view.bearish.includes('covered_call'));
    assert.ok(view.structures.includes('call_credit_spread'));
    const restricted = resolveInstrumentPermissions({
      instruments: { ...fullConfig.instruments, allowSpreads: false, allowCoveredCalls: false },
    });
    const restrictedView = playbookView('gapfade', restricted);
    assert.equal(restrictedView.bearish.includes('covered_call'), false);
    assert.equal(restrictedView.bearish.includes('short_stock'), true);
  });
});

describe('option affordability and policy normalization', () => {
  it('budgets option premium by equity percentage, per-order cap and mandate', () => {
    assert.equal(optionPremiumBudget({ config: fullConfig, equityUsd: 50 }), 12.5);
    assert.equal(optionPremiumBudget({ config: fullConfig, equityUsd: 50, mandateMaxUsd: 8 }), 8);
    assert.equal(optionPremiumBudget({ config: fullConfig, equityUsd: 50, openPremiumUsd: 5 }), 7.5);
    assert.equal(optionPremiumBudget({ config: fullConfig, equityUsd: 0 }), 0);
    assert.equal(contractsForBudget({ premiumUsd: 0.04, budgetUsd: 10, maxContracts: 3 }), 2);
    assert.equal(contractsForBudget({ premiumUsd: 2, budgetUsd: 10, maxContracts: 3 }), 0);
    assert.equal(contractsForBudget({ premiumUsd: 0.05, budgetUsd: 20, maxContracts: 99 }), 4);
    assert.equal(contractsForBudget({ premiumUsd: 0.05, budgetUsd: 20, maxContracts: 3 }), 3);
    assert.equal(targetDTE({ family: 'day', structure: 'long_call', minDTE: 2, maxDTE: 14 }), 4);
    assert.equal(targetDTE({ family: 'swing', structure: 'long_call', minDTE: 2, maxDTE: 14 }), 9);
  });

  it('clamps an agent instrument plan to allowed structures and caps', () => {
    const permissions = resolveInstrumentPermissions(fullConfig);
    const plan = normalizeInstrumentPolicy({
      prefer: 'naked_short_call',
      maxPremiumUsd: 999,
      maxContracts: 99,
      dteMin: 0,
      dteMax: 60,
    }, { config: fullConfig, permissions });
    assert.equal(plan.prefer, 'auto', 'unknown/naked structures fall back to auto');
    assert.equal(plan.maxPremiumUsd, 25);
    assert.equal(plan.maxContracts, 3);
    assert.equal(plan.dteMin, 2);
    assert.equal(plan.dteMax, 14);
    const valid = normalizeInstrumentPolicy({ prefer: 'call_credit_spread', maxContracts: 2 }, { config: fullConfig, permissions });
    assert.equal(valid.prefer, 'call_credit_spread');
    assert.equal(valid.maxContracts, 2);
    assert.equal(normalizeInstrumentPolicy(null, { config: fullConfig, permissions }).prefer, 'auto');
    const restricted = normalizeInstrumentPolicy({ prefer: 'bull_call_spread' }, {
      config: { instruments: { ...fullConfig.instruments, allowSpreads: false } },
      permissions: resolveInstrumentPermissions({ instruments: { ...fullConfig.instruments, allowSpreads: false } }),
    });
    assert.equal(restricted.prefer, 'auto', 'structure not offered by permissions cannot be chosen');
  });

  it('bot-agent policies gain a normalized instrument block', () => {
    const policy = normalizePolicy({
      stance: 'trade',
      sizeMultiplier: 0.8,
      confidence: 0.6,
      thesis: 'fx',
      plan: [],
      watch: [],
      instrument: { prefer: 'long_call', maxPremiumUsd: 999, maxContracts: 99, dteMin: 0, dteMax: 90 },
    }, { nowMs: Date.parse('2026-10-30T15:00:00Z'), reviewSec: 300, config: fullConfig });
    assert.equal(policy.instrument.prefer, 'long_call');
    assert.equal(policy.instrument.maxPremiumUsd, 25);
    assert.equal(policy.instrument.maxContracts, 3);
    assert.equal(policy.instrument.dteMin, 2);
    assert.equal(policy.instrument.dteMax, 14);
    const auto = normalizePolicy({ stance: 'trade', confidence: 0.5 }, { nowMs: Date.now(), reviewSec: 60, config: fullConfig });
    assert.equal(auto.instrument.prefer, 'auto');
  });
});
