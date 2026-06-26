import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleOnlyFallback } from '../decision/fallback.js';

const fixedNow = () => Date.parse('2026-01-01T00:00:00.000Z');

test('blocked rules always block', () => {
  const r = ruleOnlyFallback({ rulesBlocked: true, riskLevel: 'low' }, fixedNow);
  assert.equal(r.decision, 'block');
  assert.ok(r.reasonCodes?.includes('RULES_BLOCKED'));
});

test('low risk + rules pass -> allow', () => {
  const r = ruleOnlyFallback({ rulesBlocked: false, riskLevel: 'low' }, fixedNow);
  assert.equal(r.decision, 'allow');
});

test('medium risk -> require approval', () => {
  const r = ruleOnlyFallback({ rulesBlocked: false, riskLevel: 'medium' }, fixedNow);
  assert.equal(r.decision, 'require_approval');
  assert.equal(r.requiresApproval, true);
});

test('high/critical risk -> block', () => {
  for (const riskLevel of ['high', 'critical'] as const) {
    const r = ruleOnlyFallback({ rulesBlocked: false, riskLevel }, fixedNow);
    assert.equal(r.decision, 'block');
  }
});

test('always carries the fallback marker and a fresh expiry', () => {
  const r = ruleOnlyFallback({ rulesBlocked: false, riskLevel: 'low' }, fixedNow);
  assert.ok(r.reasonCodes?.includes('RULE_ONLY_FALLBACK_USED'));
  assert.ok(r.expiresAt && Date.parse(r.expiresAt) > fixedNow());
});
