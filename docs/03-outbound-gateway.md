# Outbound Gateway

[English](03-outbound-gateway.md) · [Español](03-outbound-gateway.es.md)

A practical way to call external APIs without duplicating plumbing in every
business module.

```
The business module declares an action.
The gateway validates, meters, limits, and runs the HTTP call.
The external provider is never called directly from a domain module.
```

Applies to any product that integrates external APIs with tokens, costs, rate
limits, or operational risk.

## The problem

Platforms often start calling providers like this:

```
instagram module    -> axios.post('https://graph.facebook.com/...')
marketplace module   -> axios.get('https://api.marketplace.com/...')
email module         -> fetch('https://api.email-provider.com/...')
```

Simple at first, dangerous later, because a call can: consume balance or
generate variable cost, duplicate an action on timeout, fail on an expired
token, hammer a dead provider, exceed rate limits, need audit/traceability,
carry secrets in headers, need retry with backoff, or affect reputation.

The fix is to separate **business**, **HTTP plumbing**, and **operational
control**.

## The principle

Never call an external API directly from a domain module.

```
Business service
  -> gateway.call()
  -> Provider Registry            (resolve the manifest)
  -> ProviderAccount / token       (valid token via getValidToken)
  -> idempotency
  -> circuit breaker
  -> rate limit
  -> retry / backoff
  -> Attempt log
  -> Cost ledger / audit
  -> External API
```

The caller declares intent. The gateway owns the infrastructure.

## Components

### 1. Provider Registry

A declarative manifest per provider. Adding a provider = adding a manifest; it
should not require changing the gateway. Each manifest declares: `provider`,
`apiName`, `capabilities`, `requiredScopes`, `webhookEvents`, `signatureScheme`,
`rateLimitPolicy`, `costModel`, `http`, `tokenRefresh`.

```js
module.exports = {
  provider: 'example_provider',
  apiName: 'api_v1',
  capabilities: [CAPABILITIES.READ_ORDERS, CAPABILITIES.REPLY_QUESTION],
  requiredScopes: ['offline_access', 'read', 'write'],
  webhookEvents: ['questions', 'orders'],
  rateLimitPolicy: { perMinute: 200 },
  costModel: { hasVariableCost: false },
  http: {
    baseUrl: 'https://api.example.com',
    authHeader: 'Authorization',
    authFormat: 'Bearer {accessToken}',
    timeoutMs: 20000,
    retryPolicy: { maxAttempts: 3, backoffMs: [500, 2000, 5000], retryOn: [408, 429, 500, 502, 503, 504] },
  },
  tokenRefresh: { refresh: require('../auth/exampleOAuth.refresh') },
};
```

The caller should not know the base URL, auth format, timeout, or retry policy.

### 2. ProviderAccount

One model for connected accounts, per tenant. Stores: account id, encrypted
tokens, requested scopes, effective permissions, operational status, `expiresAt`,
provider-specific metadata.

States: `not_connected`, `connecting`, `connected`, `missing_permissions`,
`token_expired`, `restricted`, `disabled`, `disconnected`, `error`.

> Tokens are never returned to UI, logs, or API responses.

### 3. getValidToken — with an anti-concurrency lease

Returns a usable access token. The subtle part is concurrency: without a lease,
two workers that both detect an expired token call the refresher at the same
time. For providers that **rotate** the refresh token (standard OAuth), the
second refresh receives a refresh token the first already consumed -> the
account ends up with no valid tokens.

```
1. Receive ProviderAccount (or look it up).
2. Token alive -> return it.
3. Expired / about to expire -> try to claim the refresh LEASE (atomic claim).
4a. Lease won  -> exchange refreshToken for a new accessToken, persist encrypted,
                  release the lease (always, even on failure). On failure, mark
                  the account token_expired.
4b. Lease lost -> another worker is refreshing. Poll until released (or TTL),
                  re-read fresh tokens from storage, return without refreshing.
5. Return { accessToken, account, refreshed }.
```

Atomic claim (MongoDB shown; Redis equivalent works):

```js
findOneAndUpdate(
  { _id, $or: [ { refreshLockedBy: null }, { refreshLockExpiresAt: { $lt: now } } ] },
  { $set: { refreshLockedBy: workerId, refreshLockedAt: now, refreshLockExpiresAt: now + 30s } },
  { new: true }
)
// truthy = you won the lease ; null = another worker holds it
```

A ~30s lease TTL covers a worker that dies mid-refresh: another can reclaim it
when the lease expires, with no manual intervention.

The refresher itself never worries about concurrency (`getValidToken` guarantees
a single call). If the provider rotates the refresh token, the refresher must
return the new one and fail loudly if it is missing. If it does not rotate
(long-lived tokens), it returns the new access token as the refresh token too,
so the next refresh has something to use.

### 4. gateway.call() — the universal entry point

```js
const result = await gateway.call({
  account,
  method: 'POST',
  path: '/{accountId}/messages',
  pathParams: { accountId: account.providerAccountId },
  body: { recipient: { id }, message: { text: 'Hi' } },
  idempotencyKey: `dm_${eventId}`,
  sourceModule: 'messaging',
  sourceType: 'dm_send',
  sourceId: eventId,
});
// -> { ok, status, data, error, attempts, latencyMs, refreshedToken, correlationId, attemptId, costLedgerId }
```

> The gateway does not throw on provider failure. It returns `{ ok: false, error }`
> and lets the caller decide.

### 5. Idempotency

When the caller passes `idempotencyKey`, the gateway checks for a prior
successful attempt with that key. If found: do not call the provider, return the
persisted result, `attempts = 0`. This prevents duplicates when the provider
received the request but did not answer, the worker restarted, a timeout
happened after executing, or the caller retried.

Key shape: `provider + idempotencyKey`, e.g. `dm_<eventId>`,
`question_reply_<questionId>`, `payment_capture_<invoiceId>`.

### 6. Attempt log

An auditable record of every outbound call: provider, normalized endpoint,
internal origin, attempt count, final status, HTTP status, sanitized response
snapshot, error code/message, estimated cost, latency, correlationId.

States: `pending`, `success`, `error`, `timeout`, `circuit_open`, `rate_limited`,
`token_unavailable`. Indexes: `unique(provider, idempotencyKey)` when the key
exists; `(tenant, provider, occurredAt)`; `(sourceModule, sourceType, sourceId)`;
TTL on `occurredAt`.

### 7. Circuit breaker — per (provider, endpoint)

```
closed     -> normal calls
open       -> gateway returns circuit_open without hitting the provider
half_open  -> one probe after cooldown; success -> closed, failure -> open
```

> Scope is **endpoint**, not provider. `/messages` can fail while `/media`
> works; cutting the whole provider loses capacity needlessly.

### 8. Rate limit — per (tenant, provider)

Consumes `manifest.rateLimitPolicy` (perSecond/perMinute/perHour/perDay/burst).
On excess: return `rate_limited`, log the attempt, do not call the provider.
Start with an in-memory token bucket; move to an atomic Redis token bucket when
you run multiple workers.

### 9. Retry / backoff — defined by the manifest

```
2xx                       -> success
4xx non-retryable         -> do not retry
408 / 429 / 5xx retryable -> backoff and retry
timeout                   -> retry up to maxAttempts
maxAttempts exhausted     -> attempt status error or timeout
```

Only retry the explicit `retryOn` list from the manifest. A `400` from a bad
payload is not fixed by retrying.

### 10. Cost ledger

Write a cost record when `costModel.hasVariableCost` is true and a per-call cost
applies (unless cost tracking is explicitly skipped). Fields: tenant, apiName,
provider, source, operation, units, unitType, currency, estimatedCost,
actualCost, costStatus, occurredAt.

## Adding a provider

> Full step-by-step walkthrough (manifest → OAuth → webhook → worker → decision)
> with a worked example: **[recipe-add-a-provider.md](recipe-add-a-provider.md)**.

```
1. Create the manifest.
2. Register it.
3. Create the OAuth refresher if needed.
4. Create the provider-specific OAuth controller.
5. Save the account (ProviderAccount.upsert()).
6. Call APIs via gateway.call().
7. Expose the inbound webhook if applicable.
```

Do **not** rebuild: HTTP client with retry, generic token refresh, idempotency,
circuit breaker, rate limit, cost ledger, attempt model.

## Uniform errors

`missing_required_fields`, `account_not_found`, `unknown_provider`,
`manifest_missing_http_config`, `token_unavailable`, `circuit_open`,
`rate_limited`, `timeout`, `network_error`, `http_400`, `http_401`, `http_403`,
`http_404`, `http_429`, `http_500`. The caller should not parse native Axios /
Fetch / SDK errors.

## Rollout modes

```
documentation - define contracts, manifests, structure; no runtime change
shadow        - log attempts in parallel / simulate calls; no production effect
advisory      - route some low-risk callers through the gateway
enforced      - forbid direct provider calls from business modules
```

In `enforced`, direct `axios`/`fetch` to external providers should surface as
tech debt or a lint/review failure.

## Testing

> Do not test that the external provider works. Test that the gateway behaves
> well under controlled responses.

Minimum cases: valid token (no refresher, call provider); expired token with
refresher (refresh, persist, call); expired token without refresher (return
`token_unavailable`); prior idempotency success (return snapshot, no call); open
breaker (no call, `circuit_open`); rate limit exceeded (no call, `rate_limited`);
`429` retryable (retry to success/maxAttempts); `500` retryable (retry with
backoff); `400` non-retryable (no retry, `http_400`); timeout (retry, then
`timeout`); large response (truncated snapshot); variable cost (creates ledger
record, links it to the attempt).

Lease tests (concurrency): 2 concurrent workers with an expired token -> exactly
one refresher call; one gets `refreshed: true`, the other reads from storage
`refreshed: false`. Expired (zombie) lease -> a new worker reclaims it. Refresh
success -> lease released. Refresh failure -> lease released anyway, account
marked `token_expired`.

Mock the HTTP client, not the real provider. Mock `getValidToken()` to control
alive / refresh / `token_unavailable`.

## Common bugs

```
Idempotency key too generic   ->  provider + action + sourceId + version
Endpoint persisted with IDs   ->  normalize: /{accountId}/messages, not /123/messages
Logging headers               ->  never persist Authorization, cookies, tokens, secrets
Retrying permanent 4xx        ->  only the explicit retryOn list
Global breaker per provider   ->  breaker per provider + normalized endpoint
```

## Relationship to a Decision Engine

The Decision Engine decides *whether* an action may run. The Outbound Gateway
*runs* an external call in a controlled way.

```
Decision Engine -> validated decision -> executor -> gateway.call() -> external API
```

Never `AI Router -> external API`. The AI should not have tokens, internal URLs,
or the ability to call providers.

## Final rule

```
Business modules do not call providers.
They declare intent.
The gateway controls the exit.
Every call is measured, limited, idempotent, and auditable.
```
