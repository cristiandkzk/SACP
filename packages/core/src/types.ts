/**
 * Core contracts for the Safe Automation Control Plane.
 * These are the universal shapes the engine passes around — intentionally
 * minimal and storage/vendor-agnostic.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Decision = 'allow' | 'block' | 'require_approval' | 'split';
export type Confidence = 'low' | 'medium' | 'high';

export type DecisionState =
  | 'requested'
  | 'rule_checked'
  | 'cache_hit'
  | 'ai_requested'
  | 'ai_decided'
  | 'schema_validated'
  | 'business_validated'
  | 'approval_pending'
  | 'approved'
  | 'routable'
  | 'blocked'
  | 'expired'
  | 'failed'
  | 'cancelled';

/** Identifies the kind of action; drives policy scope and model selection. */
export interface ActionDescriptor {
  type: string;
  sourceModule?: string;
  sourceType?: string;
  sourceId?: string;
}

/**
 * The universal input to the engine. `input` and `context` are domain-specific
 * payloads used for hashing and policy evaluation — keep raw user text and
 * secrets OUT of what you send to the model.
 */
export interface RoutingSnapshot {
  tenantId: string;
  action: ActionDescriptor;
  risk?: { riskLevel: RiskLevel };
  input?: unknown;
  context?: unknown;
}

/** The validated output of a decision (model- or fallback-produced). */
export interface RouterDecisionOutput {
  decision: Decision;
  riskLevel: RiskLevel;
  confidence?: Confidence;
  requiresApproval?: boolean;
  expiresAt?: string;
  summary?: string;
  reasonCodes?: string[];
  rulesApplied?: string[];
  estimatedAiCostUSD?: number;
  estimatedExternalCost?: number;
}
