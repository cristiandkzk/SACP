# sacp-core

[English](README.md) · [Español](README.es.md)

Core de referencia del **[Safe Automation Control Plane](https://github.com/cristiandkzk/SACP)**.

Las piezas difíciles de hacer bien del patrón, como un paquete TypeScript chico:
un policy engine, un validador estricto del output de decisión, un rule-only
fallback, una state machine de decisiones, un circuit breaker y un rate limiter
de token-bucket — más los **ports** (interfaces) de las partes que vos traés
(storage, provider de LLM, cost model).

**Cero dependencias de runtime. Ports & adapters. Node ≥ 18.**

> Esto es un core de referencia, no un framework con todo incluido. Trae la
> lógica determinística y los contratos; tu base de datos y tu provider de modelo
> siguen siendo tuyos. Leé primero los [docs del patrón](https://github.com/cristiandkzk/SACP) —
> el código tiene mucho más sentido una vez que leíste el porqué.

## Instalación

```bash
npm install sacp-core
```

## Quickstart

```ts
import { DecisionEngine, PolicyEngine } from 'sacp-core';
import type { ModelProvider } from 'sacp-core';

// 1. Las reglas duras corren ANTES del modelo. El primer block gana.
const policy = new PolicyEngine();
policy.register('router_ai.campaign_send', (snap) => {
  const ctx = snap.context as { balance: number; cost: number };
  return ctx.balance >= ctx.cost
    ? { allowed: true }
    : { allowed: false, reasonCode: 'BALANCE_INSUFFICIENT' };
});

// 2. Tu adapter de LLM. El ÚNICO lugar donde se llama a un modelo.
const model: ModelProvider = {
  async call(snap) {
    // llamá a tu provider, devolvé el JSON crudo (sin validar)
    return {
      rawOutput: JSON.stringify({ decision: 'allow', riskLevel: 'low' }),
      tokensInput: 120, tokensOutput: 40, provider: 'groq', model: 'example',
    };
  },
};

// 3. Cablealo. Storage, cache y business validator son adapters opcionales.
const engine = new DecisionEngine({ policy, model });

const result = await engine.decide({
  tenantId: 't_123',
  action: { type: 'campaign_send', sourceModule: 'campaigns' },
  risk: { riskLevel: 'low' },
  context: { balance: 1000, cost: 200 },
});

console.log(result.output.decision); // 'allow' | 'block' | 'require_approval' | 'split'
console.log(result.fallbackUsed);    // true si el modelo fue salteado o falló
```

Si la policy bloquea, el modelo nunca se llama. Si el modelo falta, tira, o
devuelve JSON inválido, obtenés una decisión conservadora de `ruleOnlyFallback`
en vez de una excepción. La IA nunca tiene la última palabra.

## Qué hay en la caja

| Export | Qué es |
|---|---|
| `DecisionEngine` | El orquestador: policy → cache → model → schema → business validator, con fallback en cada falla. |
| `PolicyEngine` | Reglas duras por scope. El primer disallow bloquea. Fail-open/closed configurable en scope vacío. |
| `validateRouterDecision`, `isIso` | Validación estricta del output, cero deps. Normaliza las fechas pasadas/inválidas que inventan los modelos. |
| `ruleOnlyFallback` | La decisión conservadora por nivel de riesgo. |
| `canTransition`, `assertTransition` | La state machine de decisiones. |
| `CircuitBreaker` | Breaker por tasa de error en ventana (closed / open / half-open). |
| `TokenBucketRateLimiter` | Token bucket in-memory, por key. |

Ports que vos implementás (solo interfaces): `ModelProvider`, `DecisionCache`,
`BusinessValidator`.

## Desarrollo

```bash
npm install
npm test     # compila y corre el runner de Node — sin deps de framework de test
npm run build
```

## Licencia

MIT
