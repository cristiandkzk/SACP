/**
 * Rule-Only Fallback — the conservative decision used when the AI is blocked by
 * rules, unavailable, or returns invalid output. The engine must be able to run
 * without the model from day one.
 */

import type { RiskLevel, RouterDecisionOutput } from '../types.js';

export interface FallbackInput {
  rulesBlocked: boolean;
  riskLevel: RiskLevel;
  reason?: string;
}

const TTL_MS = 5 * 60_000;

export function ruleOnlyFallback(
  input: FallbackInput,
  now: () => number = () => Date.now(),
): RouterDecisionOutput {
  const reasonCodes = ['RULE_ONLY_FALLBACK_USED'];
  if (input.reason) reasonCodes.push(input.reason);
  const expiresAt = new Date(now() + TTL_MS).toISOString();

  if (input.rulesBlocked) {
    return {
      decision: 'block',
      riskLevel: input.riskLevel,
      confidence: 'high',
      reasonCodes: [...reasonCodes, 'RULES_BLOCKED'],
      expiresAt,
    };
  }

  switch (input.riskLevel) {
    case 'low':
      return {
        decision: 'allow',
        riskLevel: 'low',
        confidence: 'medium',
        reasonCodes: [...reasonCodes, 'LOW_RISK_RULES_PASSED'],
        expiresAt,
      };
    case 'medium':
      return {
        decision: 'require_approval',
        riskLevel: 'medium',
        confidence: 'medium',
        requiresApproval: true,
        reasonCodes: [...reasonCodes, 'MEDIUM_RISK_APPROVAL_REQUIRED'],
        expiresAt,
      };
    default:
      return {
        decision: 'block',
        riskLevel: input.riskLevel,
        confidence: 'high',
        reasonCodes: [...reasonCodes, 'HIGH_RISK_BLOCKED'],
        expiresAt,
      };
  }
}
