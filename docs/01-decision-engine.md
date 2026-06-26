# Decision Engine

A practical way to decide on actions with AI without letting the AI have the
final say.

```
The AI proposes.
The platform validates.
The executor only runs validated decisions.
```

This applies to any product that uses AI to decide actions with cost, risk, or
operational impact: SaaS platforms, CRMs, messaging tools, marketplaces,
marketing systems, internal assistants.

## The problem

Many platforms wire AI straight to execution:

```
user asks something  ->  model decides  ->  system executes
```

That flow is dangerous when the action can: generate variable cost, send over
paid channels, publish content, affect reputation, breach plan limits,
duplicate sends, ignore opt-out/consent, or require human approval.

The fix is to **separate decision, validation, and execution**.

## The principle

> Do not use AI if a rule, a cache, or a deterministic tool can resolve it well.

Recommended order:

```
Rule / Policy Engine
  -> Decision Cache
  -> AI Router (only if it adds value)
  -> Schema Validator
  -> Business Validator
  -> Approval Workflow
  -> Executor
  -> Audit / Billing / Outbox
```

Never:

```
AI Router -> Executor (directly)
```

## One engine, any origin

The engine is not just for one feature. It is a decision pattern for any action
with cost, risk, or impact — regardless of who triggers it.

```
A user in the panel UI       -> creates a campaign, publishes a product
A bot / automation           -> replies to an inbound message
An internal AI assistant     -> the user asks in natural language; the
                                assistant proposes; the engine decides; a
                                human approves if risk requires it
A worker / scheduled job     -> stock sync, reconciliation
An inbound provider webhook  -> a marketplace question, an order event
```

All of them produce the same thing: a **RoutingSnapshot** with a declared
`action.type`. The engine neither knows nor cares who built it.

### The internal-assistant pattern

A conversational assistant is one of the most common origins. The correct shape:

```
Assistant receives a natural-language request
  -> reads the data it needs (read_* tools)
  -> proposes an action (propose_* tool)
  -> propose_* builds a RoutingSnapshot with the right action.type
  -> calls the decision service
  -> decision service runs the full flow:
       Policy Engine -> AI Router -> Schema Validator
       -> Business Validator -> Approval if required
  -> tool returns { status: 'pending_approval' | 'allowed' | 'blocked' }
  -> assistant relays the result
```

What the assistant must **not** do: execute directly, call external APIs
directly, bypass the Policy Engine, assume its own risk judgment is enough, or
approve its own proposals.

## Channel- and action-agnostic core

The universal input is a `RoutingSnapshot` with an `action` sub-object:

```
action.type:
  campaign_send     - bulk send
  inbound_reply     - reply to an inbound message/event
                      (DMs, marketplace questions, support replies, assistant proposals)
  content_publish   - publish a product or post to an external channel
  auto_reply        - automated bot reply
  comment_moderate  - moderate/reply to a public comment
```

`action.sourceModule` and `action.sourceType` are traceability metadata only
(e.g. `marketplace` / `marketplace_answer_question`). They identify the origin
in logs and audit records; they do **not** change the engine's flow.

`action.type` determines: the policy scope to evaluate, the model-selector
feature, the approval-request titles, and which flow steps apply (e.g. balance
reservation only for `campaign_send`).

### Extending without touching the core

Add a new **channel**:

```
{Channel}Snapshot adapter   - translate channel state into the universal snapshot
{channel}CostEstimator      - estimate channel-specific cost
{channel}Balance            - reserve balance if the channel requires it
channel-specific policies   - only if it needs its own rules
```

Add a new **action type**:

```
policy scope 'router_ai.{type}'  - hard rules for that type
selector feature                 - which models may answer
snapshot factory                 - RoutingSnapshot.for{Type}(...)
```

Never change: the decision service, the decision model, the output schema, the
rule-only fallback, the Policy Engine, the Decision Cache, the Provider Selector.

## Components

### 1. Policy Engine (hard rules)

Runs deterministic rules **before** any model call.

```
plan does not allow the action -> block
insufficient balance           -> block
user lacks permission          -> block
channel disconnected           -> block
recipient without consent      -> block
opt-out active                 -> block
unofficial channel not enabled -> block
feature flag off               -> block
approval required, not granted -> block
```

The AI must not be able to ignore these. Group policies by scope (e.g.
`router_ai.routing`) with an explicit evaluation order:

```
optOut -> channel -> channelConnected -> channelBalance
       -> planLimits -> riskGates -> experimentalChannel
```

### 2. AI Router

Optimizes **within** what is allowed. May decide: batching, delays, recommended
order, risk, explanation, whether to ask for approval, whether to pause, whether
a cheaper alternative is better.

It may **not** decide: ignoring plan limits, using a disabled channel, sending
without balance, sending to opt-outs, executing without a required approval, or
using an experimental channel as an automatic fallback.

### 3. Schema Validator

Validates model output against a strict JSON Schema.

```
if the schema fails:
  do not execute
  retry at most once
  if it fails again, use the conservative fallback
  emit a schema_failed event
```

### 4. Business Validator

Re-validates **after** the AI: plan, limits, balance, cost reservation,
permissions, feature flags, channel/provider state, consent, opt-out, allowed
hours, link reputation, approvals, circuit breakers, idempotency, decision
expiry.

> Even if the AI returns `allow`, the Business Validator can turn it into
> `block` or `require_approval`. This is the line the whole pattern protects.

### 5. Executor

Runs only validated decisions. Receives something like:

```
decisionId, channel, provider, destination, payload,
scheduledFor, idempotencyKey, correlationId, costReservationId
```

It does **not** recompute the decision. If the decision expired or a critical
input changed, it blocks and requests a fresh decision.

## The decision model

Persist enough to audit and to be idempotent. Recommended fields:

```
tenantId, sourceModule, sourceType, sourceId, decisionId, mode, state, decision,
channel, riskLevel, inputHash, contextHash, schemaVersion, policyVersion,
promptVersion, provider, model, tokensInput, tokensOutput, estimatedAiCostUSD,
estimatedExternalCost, requiresApproval, approvalRequestId, expiresAt, summary,
confidence, reasonCodes, rulesApplied, batches, perDestinationDecisions,
blockedDestinations, requiredActions, balanceReservation, cacheHit, fallbackUsed,
rawOutput, validatedOutput, businessValidationResult, correlationId, causationId,
idempotencyKey, createdAt, updatedAt
```

State machine:

```
requested -> rule_checked
rule_checked -> ai_requested        (if AI adds value)
rule_checked -> business_validated  (if rules already decide)
ai_requested -> ai_decided -> schema_validated -> business_validated
business_validated -> approval_pending  (if approval required)
business_validated -> routable           (if executable)
business_validated -> blocked            (if a hard rule fails)
approval_pending -> approved -> routable
```

## The orchestrator

```
1. Receive a summarized snapshot.
2. Compute inputHash / contextHash.
3. Run hard rules. If they decide, return a rule-only decision.
4. Look up the decision cache. On hit, validate and return.
5. Pick provider/model by cost, risk, and plan.
6. Call the AI only if it adds value.
7. Validate strict JSON. Retry once on failure.
8. Run the Business Validator.
9. Persist the decision.
10. Record tokens and cost.
11. Store cache if safe.
12. Create an approval request if required.
13. Return the final decision.
```

The orchestrator must **not**: execute sends, reserve balance directly, ignore
policies, accept AI output without the schema validator, or send raw user text
to the model (prompt-injection prevention).

## Rule-Only Fallback

The conservative path when the AI fails or adds no value:

```
hard rules block            -> decision = block
low risk + rules pass       -> decision = allow (minimal batches, conservative delays)
medium risk                 -> decision = require_approval
high / critical risk        -> decision = block
```

Reason codes: `RULE_ONLY_FALLBACK_USED`, `AI_PROVIDER_UNAVAILABLE`,
`PROVIDER_CIRCUIT_OPEN`, `SCHEMA_INVALID`, `LOW_RISK_RULES_PASSED`,
`MEDIUM_RISK_APPROVAL_REQUIRED`, `HIGH_RISK_BLOCKED`.

## Output schema

Minimum expected model output:

```json
{
  "decision": "allow",
  "schemaVersion": "router_ai_output_v1",
  "riskLevel": "medium",
  "estimatedExternalCost": 0,
  "estimatedAiCostUSD": 0.002,
  "requiresApproval": false,
  "expiresAt": "2026-01-01T12:00:00.000Z",
  "summary": "Allowed with conservative batches.",
  "confidence": "medium",
  "reasonCodes": ["RULES_PASSED"],
  "batches": [],
  "rulesApplied": ["policy_passed"]
}
```

Enums: `decision` = allow | block | require_approval | split; `riskLevel` = low
| medium | high | critical; `confidence` = low | medium | high.

## Rollout modes

```
simulation  - compute cost/risk, do not execute (UI, QA)
advisory    - show recommendation, human approves, executor waits
shadow      - compare real (rules) decision vs AI decision, no production effect
enforced    - validated AI decision may affect routing; stable/official channels only
```

> Experimental or unofficial channels must never start in `enforced`. Keep them
> in advisory/shadow, or block unless explicitly enabled.

## Cost control

The engine reduces **AI cost** because it: doesn't call AI when a rule
suffices, uses a decision cache, picks the model by cost/risk, makes one call
per batch (not per destination), trims the snapshot (no raw text, no secrets),
and meters tokens per tenant/feature/provider/model.

It reduces **external-API cost** because it: estimates cost before executing,
blocks on insufficient balance, reserves balance before executing, separates
free vs paid actions, and detects duplicates via idempotency.

## What must exist before you build the engine

Data structures: a **Decision** record (with its state machine), an **Event
Outbox** (atomic event publishing), an **Approval Request**, the
**RoutingSnapshot** contract, and the **output JSON Schema**.

Infrastructure services: **Policy Engine** (scoped rules), **Decision Cache**
(`hash(input) + hash(context)`), **Provider Selector** (with circuit breaker),
**AI Circuit Breaker**, **Usage Ledger**, per-channel **Cost Estimator** and
**Balance Service**.

Business services: **Approval Service**, **Rate Card / Pricing Store** (with
temporal validity), **Exchange Rate Service** (cached, with a fallback rate).

You do **not** need first: the executor, a decisions dashboard, full shadow
mode, or multiple channel adapters. Build the official channel first.

## Recommended build order

```
1. Decision model + output schema       (no persistence, nothing to audit)
2. Rule-only fallback service           (the engine must run without AI on day one)
3. Policy Engine + minimal channel rules (hard rules before AI)
4. Orchestrator (decision service)        (integrates the above)
5. Channel snapshot adapter (official channel)
6. Domain adapter (builds the snapshot, connects domain to engine)
7. Simulation endpoint                    (first end-to-end entry point)
8. Decision Cache + Provider Selector     (cost optimization, second cut)
```

## Testing

> Do not test the AI. Test that the engine uses it well and survives when it
> fails. If a test needs the model to answer correctly to pass, it is a test of
> the model, not of the engine.

Mandatory cases before enabling anything beyond `simulation`:

```
Plan not allowed          -> block, reason PLAN_NOT_ALLOWED
Channel disconnected      -> block, reason CHANNEL_DISCONNECTED
Insufficient balance      -> block, reason BALANCE_INSUFFICIENT
Total opt-out             -> block, reason OPT_OUT
Partial opt-out           -> not a global block; blockedDestinations lists opt-outs
Critical health score     -> block or require_approval per policy
AI unavailable (timeout)  -> rule-only fallback, fallbackUsed=true, no exception
Schema invalid then valid -> valid decision, attempts=2, tokens of both calls counted
Schema invalid twice      -> rule-only fallback, schema_failed emitted
AI allow -> validator block (channel disconnects mid-flight) -> block
Cache hit                 -> second identical request does not call AI
Cache invalidated         -> context change (health score) forces a new AI call
Experimental + enforced   -> block, regardless of what the AI says
Balance reservation fails -> final block, reason BALANCE_INSUFFICIENT
Decision expired          -> executor refuses, does not run
```

## Final rule

```
Rules decide what is allowed.
The AI optimizes what is allowed.
Validators decide what may execute.
Executors only run validated decisions.

Whoever originates the decision does not matter:
a user, a bot, an AI assistant, or a worker
all go through the same engine.
```
