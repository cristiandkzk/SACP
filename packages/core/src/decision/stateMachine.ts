/**
 * Decision state machine. Persisting state with enforced transitions is what
 * makes a decision auditable and idempotent.
 */

import type { DecisionState } from '../types.js';

const TRANSITIONS: Record<DecisionState, readonly DecisionState[]> = {
  requested: ['rule_checked'],
  rule_checked: ['ai_requested', 'cache_hit', 'business_validated', 'blocked'],
  cache_hit: ['business_validated'],
  ai_requested: ['ai_decided', 'failed'],
  ai_decided: ['schema_validated', 'failed'],
  schema_validated: ['business_validated'],
  business_validated: ['approval_pending', 'routable', 'blocked'],
  approval_pending: ['approved', 'cancelled', 'expired'],
  approved: ['routable', 'expired'],
  routable: ['expired', 'cancelled'],
  blocked: [],
  expired: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: DecisionState, to: DecisionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: DecisionState, to: DecisionState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal decision transition: ${from} -> ${to}`);
  }
}

export const decisionTransitions = TRANSITIONS;
