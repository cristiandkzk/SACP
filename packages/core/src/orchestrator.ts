/**
 * DecisionEngine — the orchestrator. Wires the flow together using injected
 * ports:  policy -> cache -> model -> schema -> business validator, with a
 * conservative fallback at every failure point. It owns no storage and no
 * vendor; you bring those as adapters.
 */

import type { RoutingSnapshot, RouterDecisionOutput } from './types.js';
import { PolicyEngine } from './policy/engine.js';
import { validateRouterDecision } from './decision/schema.js';
import { ruleOnlyFallback } from './decision/fallback.js';
import type { ModelProvider, DecisionCache, BusinessValidator, ModelCallResult } from './ports.js';

export interface DecisionEngineDeps {
  policy: PolicyEngine;
  model?: ModelProvider;
  cache?: DecisionCache;
  businessValidator?: BusinessValidator;
  hashSnapshot?: (s: RoutingSnapshot) => string;
  scopeForAction?: (actionType: string) => string;
  decisionTtlMs?: number;
  now?: () => number;
}

export interface DecisionResult {
  output: RouterDecisionOutput;
  cacheHit: boolean;
  fallbackUsed: boolean;
  reasonCodes: string[];
}

const defaultScope = (t: string): string => `router_ai.${t}`;
const defaultHash = (s: RoutingSnapshot): string =>
  JSON.stringify({ t: s.tenantId, a: s.action, i: s.input, c: s.context });

export class DecisionEngine {
  constructor(private readonly deps: DecisionEngineDeps) {}

  async decide(snapshot: RoutingSnapshot): Promise<DecisionResult> {
    const now = this.deps.now ?? (() => Date.now());
    const riskLevel = snapshot.risk?.riskLevel ?? 'medium';
    const scope = (this.deps.scopeForAction ?? defaultScope)(snapshot.action.type);

    // 1. Hard rules first — block before any model call.
    const policy = await this.deps.policy.evaluate(scope, snapshot);
    if (!policy.allowed) {
      const output = ruleOnlyFallback({ rulesBlocked: true, riskLevel, reason: policy.blockedBy }, now);
      return { output, cacheHit: false, fallbackUsed: true, reasonCodes: policy.reasonCodes };
    }

    const hash = (this.deps.hashSnapshot ?? defaultHash)(snapshot);

    // 2. Decision cache.
    if (this.deps.cache) {
      const cached = await this.deps.cache.lookup(hash);
      if (cached) {
        const output = await this.businessValidate(cached, snapshot);
        return { output, cacheHit: true, fallbackUsed: false, reasonCodes: ['CACHE_HIT'] };
      }
    }

    // 3. No model wired -> conservative decision (rules already passed).
    if (!this.deps.model) {
      const fb = ruleOnlyFallback({ rulesBlocked: false, riskLevel, reason: 'NO_MODEL_CONFIGURED' }, now);
      const output = await this.businessValidate(fb, snapshot);
      return { output, cacheHit: false, fallbackUsed: true, reasonCodes: fb.reasonCodes ?? [] };
    }

    // 4. Call the model.
    let raw: ModelCallResult;
    try {
      raw = await this.deps.model.call(snapshot);
    } catch {
      const fb = ruleOnlyFallback({ rulesBlocked: false, riskLevel, reason: 'AI_PROVIDER_UNAVAILABLE' }, now);
      const output = await this.businessValidate(fb, snapshot);
      return { output, cacheHit: false, fallbackUsed: true, reasonCodes: fb.reasonCodes ?? [] };
    }

    // 5. Validate the model's output strictly.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw.rawOutput);
    } catch {
      parsed = null;
    }
    const result = validateRouterDecision(parsed, { decisionTtlMs: this.deps.decisionTtlMs, now });
    if (!result.valid || !result.normalized) {
      const fb = ruleOnlyFallback({ rulesBlocked: false, riskLevel, reason: 'SCHEMA_INVALID' }, now);
      const output = await this.businessValidate(fb, snapshot);
      return { output, cacheHit: false, fallbackUsed: true, reasonCodes: fb.reasonCodes ?? [] };
    }

    // 6. Business validation may downgrade allow -> block / require_approval.
    const output = await this.businessValidate(result.normalized, snapshot);

    // 7. Store cache (only safe, validated decisions).
    if (this.deps.cache) await this.deps.cache.store(hash, output);

    return { output, cacheHit: false, fallbackUsed: false, reasonCodes: output.reasonCodes ?? [] };
  }

  private async businessValidate(
    output: RouterDecisionOutput,
    snapshot: RoutingSnapshot,
  ): Promise<RouterDecisionOutput> {
    if (!this.deps.businessValidator) return output;
    return this.deps.businessValidator.validate(output, snapshot);
  }
}
