# sacp-core

[English](README.md) · [Español](README.es.md)

Reference core for the **[Safe Automation Control Plane](https://github.com/cristiandkzk/SACP)**.

The hard-to-get-right, dependency-free pieces of the pattern, as a small
TypeScript package: a policy engine, a strict decision-output validator, a
rule-only fallback, a decision state machine, a circuit breaker, and a
token-bucket rate limiter — plus the **ports** (interfaces) for the parts you
bring yourself (storage, LLM provider, cost model).

**Zero runtime dependencies. Ports & adapters. Node ≥ 18.**

> This is a reference core, not a batteries-included framework. It ships the
> deterministic logic and the contracts; your database and your model provider
> stay yours. Read the [pattern docs](https://github.com/cristiandkzk/SACP) first
> — the code makes a lot more sense once you've read why.

## Install

```bash
npm install sacp-core
```

## Quickstart

```ts
import { DecisionEngine, PolicyEngine } from 'sacp-core';
import type { ModelProvider } from 'sacp-core';

// 1. Hard rules run BEFORE the model. First block wins.
const policy = new PolicyEngine();
policy.register('router_ai.campaign_send', (snap) => {
  const ctx = snap.context as { balance: number; cost: number };
  return ctx.balance >= ctx.cost
    ? { allowed: true }
    : { allowed: false, reasonCode: 'BALANCE_INSUFFICIENT' };
});

// 2. Your LLM adapter. The ONLY place a model is called.
const model: ModelProvider = {
  async call(snap) {
    // call your provider, return the raw (unvalidated) JSON string
    return {
      rawOutput: JSON.stringify({ decision: 'allow', riskLevel: 'low' }),
      tokensInput: 120, tokensOutput: 40, provider: 'groq', model: 'example',
    };
  },
};

// 3. Wire it. Storage, cache and business validator are optional adapters.
const engine = new DecisionEngine({ policy, model });

const result = await engine.decide({
  tenantId: 't_123',
  action: { type: 'campaign_send', sourceModule: 'campaigns' },
  risk: { riskLevel: 'low' },
  context: { balance: 1000, cost: 200 },
});

console.log(result.output.decision); // 'allow' | 'block' | 'require_approval' | 'split'
console.log(result.fallbackUsed);    // true if the model was bypassed/failed
```

If the policy blocks, the model is never called. If the model is missing, throws,
or returns invalid JSON, you get a conservative `ruleOnlyFallback` decision
instead of an exception. The AI never has the final word.

## What's in the box

| Export | What it is |
|---|---|
| `DecisionEngine` | The orchestrator: policy → cache → model → schema → business validator, with fallback at every failure. |
| `PolicyEngine` | Scoped hard rules. First disallow blocks. Configurable fail-open/closed on empty scope. |
| `validateRouterDecision`, `isIso` | Strict, zero-dep output validation. Normalizes the past/invalid dates models invent. |
| `ruleOnlyFallback` | The conservative decision by risk level. |
| `canTransition`, `assertTransition` | The decision state machine. |
| `CircuitBreaker` | Windowed error-rate breaker (closed / open / half-open). |
| `TokenBucketRateLimiter` | In-memory token bucket, keyed. |

Ports you implement (interfaces only): `ModelProvider`, `DecisionCache`,
`BusinessValidator`.

## Develop

```bash
npm install
npm test     # compiles and runs the Node test runner — no test framework deps
npm run build
```

## License

MIT
