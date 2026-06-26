import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRouterDecision, isIso } from '../decision/schema.js';

const now = () => Date.parse('2026-06-26T12:00:00.000Z');

test('isIso rejects natural-language dates (Date.parse alone would accept some)', () => {
  assert.equal(isIso('tomorrow at 3'), false);
  assert.equal(isIso('2026-06-26T12:00:00.000Z'), true);
});

test('rejects an invalid decision enum', () => {
  const r = validateRouterDecision({ decision: 'maybe', riskLevel: 'low' }, { now });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('decision')));
});

test('normalizes a past expiresAt to now + ttl', () => {
  const r = validateRouterDecision(
    { decision: 'allow', riskLevel: 'low', expiresAt: '2020-01-01T00:00:00.000Z' },
    { now, decisionTtlMs: 60_000 },
  );
  assert.equal(r.valid, true);
  assert.equal(r.normalized?.expiresAt, new Date(now() + 60_000).toISOString());
});

test('keeps a valid future expiresAt', () => {
  const future = new Date(now() + 600_000).toISOString();
  const r = validateRouterDecision(
    { decision: 'allow', riskLevel: 'low', expiresAt: future },
    { now },
  );
  assert.equal(r.normalized?.expiresAt, future);
});

test('rejectUnknownKeys flags injected fields', () => {
  const r = validateRouterDecision(
    { decision: 'allow', riskLevel: 'low', sneaky: true },
    { now, rejectUnknownKeys: true },
  );
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('sneaky')));
});
