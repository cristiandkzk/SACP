/**
 * Schema validation for the model's decision output. Hand-rolled (zero deps) and
 * strict. Encodes two hard-won lessons:
 *  - `Date.parse()` accepts non-ISO strings — regex first.
 *  - The model invents past/missing `expiresAt` — normalize server-side.
 */

import type {
  RouterDecisionOutput,
  Decision,
  RiskLevel,
  Confidence,
} from '../types.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function isIso(v: unknown): v is string {
  return typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
}

const DECISIONS: readonly Decision[] = ['allow', 'block', 'require_approval', 'split'];
const RISKS: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];
const CONFIDENCES: readonly Confidence[] = ['low', 'medium', 'high'];

const KNOWN_KEYS = new Set<string>([
  'decision', 'riskLevel', 'confidence', 'requiresApproval', 'expiresAt',
  'summary', 'reasonCodes', 'rulesApplied', 'estimatedAiCostUSD',
  'estimatedExternalCost', 'schemaVersion', 'batches', 'perDestinationDecisions',
  'blockedDestinations', 'requiredActions', 'balanceReservation',
]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  normalized?: RouterDecisionOutput;
}

export interface ValidateOptions {
  /** TTL applied when `expiresAt` is missing or already in the past. */
  decisionTtlMs?: number;
  now?: () => number;
  /** Reject any field the validator does not know (additionalProperties:false). */
  rejectUnknownKeys?: boolean;
}

export function validateRouterDecision(
  raw: unknown,
  opts: ValidateOptions = {},
): ValidationResult {
  const errors: string[] = [];
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.decisionTtlMs ?? 5 * 60_000;

  if (typeof raw !== 'object' || raw === null) {
    return { valid: false, errors: ['output is not an object'] };
  }
  const o = raw as Record<string, unknown>;

  if (!DECISIONS.includes(o['decision'] as Decision)) {
    errors.push(`invalid decision: ${String(o['decision'])}`);
  }
  if (!RISKS.includes(o['riskLevel'] as RiskLevel)) {
    errors.push(`invalid riskLevel: ${String(o['riskLevel'])}`);
  }
  if (o['confidence'] !== undefined && !CONFIDENCES.includes(o['confidence'] as Confidence)) {
    errors.push(`invalid confidence: ${String(o['confidence'])}`);
  }
  if (o['expiresAt'] !== undefined && !isIso(o['expiresAt'])) {
    errors.push(`expiresAt is not ISO-8601: ${String(o['expiresAt'])}`);
  }
  if (opts.rejectUnknownKeys) {
    for (const k of Object.keys(o)) {
      if (!KNOWN_KEYS.has(k)) errors.push(`unknown key: ${k}`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  // Normalize the date the model cannot be trusted to compute.
  const current = o['expiresAt'] as string | undefined;
  const expiresAt =
    current && Date.parse(current) >= now()
      ? current
      : new Date(now() + ttl).toISOString();

  const normalized = { ...(o as unknown as RouterDecisionOutput), expiresAt };
  return { valid: true, errors: [], normalized };
}
