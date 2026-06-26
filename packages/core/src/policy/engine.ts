/**
 * Policy Engine — hard rules that run BEFORE the model. Policies are grouped by
 * scope (e.g. `router_ai.campaign_send`). The first policy that disallows blocks
 * the request; the AI never sees it.
 */

import type { RoutingSnapshot } from '../types.js';

export interface PolicyVerdict {
  allowed: boolean;
  reasonCode?: string;
  detail?: string;
}

export type Policy = (
  snapshot: RoutingSnapshot,
) => PolicyVerdict | Promise<PolicyVerdict>;

export interface PolicyEvaluation {
  allowed: boolean;
  reasonCodes: string[];
  blockedBy?: string;
}

export interface PolicyEngineOptions {
  /**
   * What to do when a scope has NO registered policies.
   * Defaults to `true` (allow) to match the spec — but a "fail open" default is
   * how an unregistered policy set silently allowed everything in production
   * (see lessons-learned). Set `false` to fail closed, or use `onEmptyScope` to
   * be warned.
   */
  allowWhenEmpty?: boolean;
  onEmptyScope?: (scope: string) => void;
}

export class PolicyEngine {
  private readonly scopes = new Map<string, Policy[]>();
  private readonly allowWhenEmpty: boolean;
  private readonly onEmptyScope?: (scope: string) => void;

  constructor(opts: PolicyEngineOptions = {}) {
    this.allowWhenEmpty = opts.allowWhenEmpty ?? true;
    this.onEmptyScope = opts.onEmptyScope;
  }

  register(scope: string, policy: Policy): this {
    const list = this.scopes.get(scope) ?? [];
    list.push(policy);
    this.scopes.set(scope, list);
    return this;
  }

  async evaluate(
    scope: string,
    snapshot: RoutingSnapshot,
  ): Promise<PolicyEvaluation> {
    const policies = this.scopes.get(scope);
    if (!policies || policies.length === 0) {
      this.onEmptyScope?.(scope);
      return {
        allowed: this.allowWhenEmpty,
        reasonCodes: this.allowWhenEmpty ? [] : ['NO_POLICIES_REGISTERED'],
      };
    }

    const reasonCodes: string[] = [];
    for (const policy of policies) {
      const verdict = await policy(snapshot);
      if (verdict.reasonCode) reasonCodes.push(verdict.reasonCode);
      if (!verdict.allowed) {
        return { allowed: false, reasonCodes, blockedBy: verdict.reasonCode };
      }
    }
    return { allowed: true, reasonCodes };
  }
}
