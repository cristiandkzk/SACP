/**
 * End-to-end demo: hard rules + Claude risk evaluation + conservative fallback.
 * Requires ANTHROPIC_API_KEY in the environment.
 */

import { DecisionEngine, PolicyEngine } from 'sacp-core';
import { createAnthropicProvider } from './anthropicProvider.js';

async function main(): Promise<void> {
  // 1. Hard rules run before the model. First block wins.
  const policy = new PolicyEngine();
  policy.register('router_ai.campaign_send', (snap) => {
    const ctx = snap.context as { balance: number; cost: number };
    return ctx.balance >= ctx.cost
      ? { allowed: true }
      : { allowed: false, reasonCode: 'BALANCE_INSUFFICIENT' };
  });

  // 2. Wire the real Claude adapter as the model port.
  const engine = new DecisionEngine({
    policy,
    model: createAnthropicProvider(),
  });

  // 3. Decide. Rules pass -> Claude assesses risk -> validated decision.
  const result = await engine.decide({
    tenantId: 't_demo',
    action: { type: 'campaign_send', sourceModule: 'campaigns' },
    risk: { riskLevel: 'medium' },
    context: { balance: 5000, cost: 1200, recipients: 800, channel: 'whatsapp' },
  });

  console.log(JSON.stringify(result, null, 2));

  // Try the blocked path: the model is never called.
  const blocked = await engine.decide({
    tenantId: 't_demo',
    action: { type: 'campaign_send', sourceModule: 'campaigns' },
    risk: { riskLevel: 'medium' },
    context: { balance: 100, cost: 1200 },
  });
  console.log('\nblocked by rules (no model call):', blocked.output.decision);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
