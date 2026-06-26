import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from '../policy/engine.js';
import { CircuitBreaker } from '../resilience/circuitBreaker.js';
import { TokenBucketRateLimiter } from '../resilience/rateLimiter.js';
import { DecisionEngine } from '../orchestrator.js';
import type { RoutingSnapshot } from '../types.js';
import type { ModelProvider } from '../ports.js';

const snap = (type = 'campaign_send'): RoutingSnapshot => ({
  tenantId: 't1',
  action: { type },
  risk: { riskLevel: 'low' },
});

test('policy: a blocking rule short-circuits with its reason code', async () => {
  const policy = new PolicyEngine();
  policy.register('router_ai.campaign_send', () => ({ allowed: false, reasonCode: 'OPT_OUT' }));
  const r = await policy.evaluate('router_ai.campaign_send', snap());
  assert.equal(r.allowed, false);
  assert.equal(r.blockedBy, 'OPT_OUT');
});

test('policy: empty scope can fail closed', async () => {
  const policy = new PolicyEngine({ allowWhenEmpty: false });
  const r = await policy.evaluate('router_ai.unknown', snap());
  assert.equal(r.allowed, false);
  assert.ok(r.reasonCodes.includes('NO_POLICIES_REGISTERED'));
});

test('engine: blocked by policy -> block, no model called', async () => {
  const policy = new PolicyEngine();
  policy.register('router_ai.campaign_send', () => ({ allowed: false, reasonCode: 'PLAN_NOT_ALLOWED' }));
  let called = false;
  const model: ModelProvider = {
    async call() {
      called = true;
      return { rawOutput: '{}', tokensInput: 0, tokensOutput: 0, provider: 'x', model: 'y' };
    },
  };
  const engine = new DecisionEngine({ policy, model });
  const r = await engine.decide(snap());
  assert.equal(r.output.decision, 'block');
  assert.equal(called, false);
});

test('engine: invalid model output falls back conservatively', async () => {
  const policy = new PolicyEngine();
  const model: ModelProvider = {
    async call() {
      return { rawOutput: 'not json', tokensInput: 1, tokensOutput: 1, provider: 'x', model: 'y' };
    },
  };
  const engine = new DecisionEngine({ policy, model });
  const r = await engine.decide(snap());
  assert.equal(r.fallbackUsed, true);
  assert.ok(r.output.reasonCodes?.includes('SCHEMA_INVALID'));
});

test('engine: business validator can downgrade allow -> block', async () => {
  const policy = new PolicyEngine();
  const model: ModelProvider = {
    async call() {
      return {
        rawOutput: JSON.stringify({ decision: 'allow', riskLevel: 'low' }),
        tokensInput: 1,
        tokensOutput: 1,
        provider: 'x',
        model: 'y',
      };
    },
  };
  const engine = new DecisionEngine({
    policy,
    model,
    businessValidator: {
      async validate(output) {
        return { ...output, decision: 'block', reasonCodes: ['CHANNEL_DISCONNECTED'] };
      },
    },
  });
  const r = await engine.decide(snap());
  assert.equal(r.output.decision, 'block');
});

test('circuit breaker opens past the threshold and blocks requests', () => {
  let t = 0;
  const cb = new CircuitBreaker({ minRequests: 4, threshold: 0.5, now: () => t });
  for (let i = 0; i < 4; i++) cb.record(false);
  assert.equal(cb.canRequest(), false);
  t += 30_000; // halfOpenAfterMs
  assert.equal(cb.currentState(), 'half_open');
});

test('rate limiter enforces capacity then refills', () => {
  let t = 0;
  const rl = new TokenBucketRateLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
  assert.equal(rl.tryRemove('k'), true);
  assert.equal(rl.tryRemove('k'), true);
  assert.equal(rl.tryRemove('k'), false);
  t += 1000; // +1 token
  assert.equal(rl.tryRemove('k'), true);
});
