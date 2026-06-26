/**
 * Ports (interfaces) the engine depends on. You provide the adapters:
 * your database, your LLM provider, your cost model. The core ships none of
 * them — that is what keeps it dependency-free.
 */

import type { RoutingSnapshot, RouterDecisionOutput } from './types.js';

export interface ModelCallResult {
  /** Raw, unvalidated model output (expected to be a JSON string). */
  rawOutput: string;
  tokensInput: number;
  tokensOutput: number;
  provider: string;
  model: string;
  latencyMs?: number;
}

/** The ONLY component that talks to an LLM. It does not validate or persist. */
export interface ModelProvider {
  call(snapshot: RoutingSnapshot): Promise<ModelCallResult>;
}

/** Reuse a prior decision for an identical input + context. */
export interface DecisionCache {
  lookup(key: string): Promise<RouterDecisionOutput | null>;
  store(key: string, decision: RouterDecisionOutput): Promise<void>;
}

/**
 * Re-checks hard rules against the model's (or fallback's) output AFTER the AI.
 * May downgrade `allow` into `block` or `require_approval`. This is the line the
 * whole pattern protects: the AI never has the final word.
 */
export interface BusinessValidator {
  validate(
    output: RouterDecisionOutput,
    snapshot: RoutingSnapshot,
  ): Promise<RouterDecisionOutput>;
}

export interface Clock {
  now(): number;
}
