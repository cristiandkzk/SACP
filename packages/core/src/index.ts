/**
 * sacp-core — reference core for the Safe Automation Control Plane.
 * Pure logic + ports. No storage, no vendor, no runtime dependencies.
 */

export * from './types.js';
export * from './ports.js';

export { PolicyEngine } from './policy/engine.js';
export type {
  Policy,
  PolicyVerdict,
  PolicyEvaluation,
  PolicyEngineOptions,
} from './policy/engine.js';

export { validateRouterDecision, isIso } from './decision/schema.js';
export type { ValidationResult, ValidateOptions } from './decision/schema.js';

export { ruleOnlyFallback } from './decision/fallback.js';
export type { FallbackInput } from './decision/fallback.js';

export {
  canTransition,
  assertTransition,
  decisionTransitions,
} from './decision/stateMachine.js';

export { CircuitBreaker } from './resilience/circuitBreaker.js';
export type { BreakerState, CircuitBreakerOptions } from './resilience/circuitBreaker.js';

export { TokenBucketRateLimiter } from './resilience/rateLimiter.js';
export type { TokenBucketOptions } from './resilience/rateLimiter.js';

export { DecisionEngine } from './orchestrator.js';
export type { DecisionEngineDeps, DecisionResult } from './orchestrator.js';
