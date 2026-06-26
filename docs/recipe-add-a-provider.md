# Recipe: add an external provider

[English](recipe-add-a-provider.md) · [Español](recipe-add-a-provider.es.md)

The [Outbound Gateway](03-outbound-gateway.md) is the *pattern*; this is the
*recipe*. It's the step-by-step for wiring a new third-party API (an email
service, a marketplace, a payment processor, a messaging platform) end to end —
inbound webhooks, outbound calls, and the decision that gates them.

Code is illustrative JavaScript; the shapes are framework- and storage-agnostic.

## The mental model

Every external API you add flows through three lanes:

```
INBOUND   (webhooks the provider sends you)
   provider → /webhooks/{slug} → webhookGateway → InboundEvent (pending)
                                                       │
                                                       ▼
                                                 async worker processes

OUTBOUND  (requests you send the provider)
   your code → gateway.call({ ... }) → external API
                  ├─ getValidToken (auto refresh)
                  ├─ idempotency / rate limit / breaker
                  ├─ retry + backoff
                  └─ persist AttemptLog → CostLedger

DECISION  (actions with cost, risk, or impact)
   your code → DecisionEngine.decide() → validated decision
                  ├─ Policy Engine (hard rules)
                  ├─ Decision Cache
                  ├─ model (only if it adds value)
                  ├─ Schema + Business Validator
                  └─ ApprovalRequest if required
```

**Your job per new API:** declare the contract (a manifest), implement the
provider-specific OAuth, write the business logic. **Everything else — token
refresh, idempotency, retries, breaker, rate limit, cost, audit — comes for
free** from the gateway.

Global rules:

```
Never: AI -> external provider directly
Never: business module -> axios/fetch -> external provider directly
Never: sensitive action -> executor without a valid decision

Always:
  webhookGateway for inbound
  DecisionEngine for deciding
  ApprovalRequest when a human is required
  gateway.call() for outbound
  an outbox/worker for async + retry
  AttemptLog + CostLedger for traceability
```

## The recipe — 6 steps per new API

### Step 1 — Manifest

Declare *what the API is* and *how you talk to it*. The single place where the
base URL, scopes, webhook signature, rate limit, and cost live.

```js
module.exports = {
  // identity
  provider:    'sendgrid',
  apiName:     'api_v1',
  description: 'Transactional email.',

  // semantic capabilities
  capabilities: [CAPABILITIES.SEND_EMAIL],

  // OAuth scopes (omit if the API uses a static key)
  requiredScopes: ['mail.send'],

  // inbound webhooks
  webhookEvents:         ['delivered', 'opened', 'bounced'],
  signatureScheme:       'hmac',                    // 'hmac' | 'jwt' | 'none'
  signatureSecretEnvVar: 'SENDGRID_WEBHOOK_SECRET',

  // declarative rate limit
  rateLimitPolicy: { perSecond: 10, perDay: 100000 },

  // cost (drives the automatic CostLedger)
  costModel: { hasVariableCost: true, perCallCostUSD: 0.001, perUnit: 'email_sent' },

  // outbound HTTP (consumed by the gateway)
  http: {
    baseUrl:    'https://api.sendgrid.com',
    authHeader: 'Authorization',
    authFormat: 'Bearer {accessToken}',
    timeoutMs:  20000,
    retryPolicy: { maxAttempts: 3, backoffMs: [500, 2000, 5000], retryOn: [408, 429, 500, 502, 503, 504] },
  },

  // token refresh (omit for static API keys)
  tokenRefresh: { refresh: require('./sendgridOAuth.refresh') },
};
```

Register it so the gateway picks it up. Adding a provider should be **adding a
manifest** — not changing the gateway.

### Step 2 — OAuth refresher (only if the API uses OAuth)

A ~20-line async function that exchanges `refreshToken` for a new `accessToken`.
`getValidToken()` calls it **automatically** when the token is about to expire —
you write it once. Skip it entirely for static-API-key providers.

```js
module.exports = async function refresh({ refreshToken }) {
  const { data } = await httpPost('https://api.example.com/oauth/token', {
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     process.env.EXAMPLE_CLIENT_ID,
    client_secret: process.env.EXAMPLE_CLIENT_SECRET,
  });
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,   // many providers rotate the refresh token too
    expiresInSec: data.expires_in,
  };
};
```

> The refresher does **not** worry about concurrency — `getValidToken`'s atomic
> lease guarantees a single refresh under parallel load (see the Outbound Gateway
> doc). If the provider rotates the refresh token, return the new one and fail
> loudly if it's missing.

### Step 3 — OAuth controller (start the connection flow)

Three endpoints: `connect` (returns the authorize URL), `callback` (receives the
code, creates the account), `disconnect` (revokes).

```
GET  /integrations/{provider}/connect      — build the authorize URL
GET  /integrations/{provider}/callback     — exchange code for tokens
POST /integrations/{provider}/disconnect   — revoke and remove the account
```

```js
async function callback(req, res) {
  const { code, state } = req.query;
  const { data } = await httpPost('https://api.example.com/oauth/token', {
    grant_type:   'authorization_code',
    code,
    client_id:    process.env.EXAMPLE_CLIENT_ID,
    client_secret: process.env.EXAMPLE_CLIENT_SECRET,
    redirect_uri: process.env.PUBLIC_BASE_URL + '/integrations/example/callback',
  });

  await ProviderAccount.upsert({
    tenantId:          state,
    provider:          'example',
    providerAccountId: data.account_id,
    scopes:            (data.scope || '').split(' '),
    accessToken:       data.access_token,   // encrypted on write
    refreshToken:      data.refresh_token,
    expiresAt:         new Date(Date.now() + data.expires_in * 1000),
  });

  res.redirect('/settings?connected=1');
}
```

> Never store tokens in plaintext — `ProviderAccount.upsert()` encrypts on write,
> and tokens are never returned to UI/logs.

### Step 4 — Webhook endpoint

The controller does one thing: hand the raw request to `webhookGateway.ingest()`
and return `200` fast. Never do heavy work here.

```js
async function receive(req, res) {
  res.sendStatus(200); // respond immediately

  await webhookGateway.ingest({
    provider:        'example',
    rawBody:         req.rawBody,   // for signature verification
    headers:         req.headers,
    payload:         req.body,
    externalEventId: req.body?.eventId,
    onIngested:      (event) => worker.enqueue(event.id),
  });
}
```

`ingest()` verifies the signature per `manifest.signatureScheme`, dedupes by
`(provider, externalEventId)`, persists an `InboundEvent`, and fires `onIngested`
only for new events. Some providers need a GET challenge (verify token) — answer
it before ingesting.

### Step 5 — Domain service + async worker

The worker polls `InboundEvent`s in `pending` and processes them. The pattern:

```
1. Read the InboundEvent.
2. Re-fetch the resource via gateway.call() — don't trust the webhook payload
   as the complete source.
3. Normalize to your domain model.
4. Build a RoutingSnapshot.
5. Call DecisionEngine.decide(snapshot).
6. Per the result: create an ApprovalRequest, notify, or execute.
```

Claim each event atomically so two workers don't double-process, and dead-letter
after N attempts:

```js
const claimed = await InboundEvent.claim(event.id); // pending -> processing, atomic
if (!claimed) continue;
try {
  await service.handle(claimed);
  await InboundEvent.markProcessed(claimed.id);
} catch (err) {
  await InboundEvent.fail(claimed.id, err, { maxAttempts: 5 }); // -> pending or dead_lettered
}
```

Every outbound call from the service goes through the gateway, and every
sensitive action through the engine:

```js
const decision = await engine.decide({
  tenantId,
  action: { type: 'inbound_reply', sourceModule: 'example' },
  risk:   { riskLevel: 'medium' },
  context: { /* trimmed — no secrets, no raw user text */ },
});

if (decision.output.decision === 'block') return;
if (decision.output.requiresApproval) return createApproval(decision);

// only with a valid decision:
await gateway.call({ account, method: 'POST', path: '/v1/messages', body, idempotencyKey });
```

### Step 6 — Done

You added a provider without touching the gateway, the engine, or the worker
framework — only a manifest, an OAuth refresher, a controller, a webhook handler,
and your domain logic.

## What's free vs what you write

| Comes free (from the gateway/engine) | You write (per provider) |
|---|---|
| Token refresh + anti-concurrency lease | The OAuth refresher (~20 lines) |
| Idempotency, retry, breaker, rate limit | The manifest (URL, scopes, limits, cost) |
| Cost ledger + attempt log + audit | The OAuth connect/callback/disconnect |
| Signature verify + dedupe (inbound) | The webhook handler (one `ingest` call) |
| Policy → AI → validators → approval | Your hard rules + domain normalization |
| Conservative fallback on any failure | — |

## Definition of Done

```
[ ] Manifest registered; the gateway resolves it
[ ] OAuth refresher returns the rotated refresh token (or omitted for API keys)
[ ] connect/callback/disconnect work; tokens stored encrypted
[ ] Webhook returns 200 fast; signature verified; events deduped
[ ] Worker claims atomically and dead-letters after N attempts
[ ] Re-fetch the resource — never trust the webhook payload as complete
[ ] Every outbound call goes through gateway.call()
[ ] Every sensitive action goes through DecisionEngine.decide()
[ ] No tokens in logs, responses, or plaintext storage
```

## Anti-patterns

```
axios/fetch straight to the provider from a domain module
heavy work inside the webhook controller (do it in the worker)
trusting the webhook payload instead of re-fetching
executing before a valid decision exists
a new HTTP client / retry / refresh per provider (the gateway already has them)
idempotency key = sourceId (collides — use provider + action + sourceId + version)
```
