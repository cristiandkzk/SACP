# Lessons learned

These are bugs found by **running** the pattern against a real database and a
real model provider — not by reading the spec. The same problems show up in any
implementation of this architecture, so they are worth writing down.

## Decision Engine

### 1. `Date.parse()` accepts non-ISO strings

**Symptom:** a schema test passed with `expiresAt: "tomorrow at 3"`.

**Cause:** V8's `Date.parse()` accepts strings that are not ISO 8601 and returns
a valid timestamp instead of `NaN`. The validator trusted `Date.parse()` alone.

**Fix:** regex first, then `Date.parse()`.

```js
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const isIso = v => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
```

**Rule:** never validate ISO format with `Date.parse()` alone.

### 2. The Policy Engine silently allowed everything

**Symptom:** 14 of 22 integration tests failed — policies returned `allowed: true`
for every input.

**Cause:** the test required the engine but never called `registerAll()`. With a
lazy registry and zero policies registered, the engine defaults to `allowed: true`.

**Fix:** register policies explicitly in test setup.

```js
beforeAll(() => { require('../../policy/policies').registerAll(); });
```

**Rule:** if the engine uses a lazy registry, the test must activate it. A bare
`require` is not enough — and a "fail open" default is a loaded gun.

### 3. Model IDs from marketing that do not exist

**Symptom:** `400 json_validate_failed` when calling the provider.

**Cause:** the selector registry listed model IDs copied from a marketing page
that were not real, available models in the provider's API.

**Fix:** replace them with IDs verified against the provider's live model list.

**Rule:** verify model IDs against the real API before adding them to the
registry. Marketing names lie.

### 4. The AI generates `expiresAt` in the past

**Symptom:** `decision: allow` but final state `blocked`, with
`businessValidationResult.failures = [DECISION_EXPIRED]`.

**Cause:** the model produced a date from its training cutoff, not from the
moment of the call. The Business Validator correctly blocked an already-expired
decision.

**Fix, two parts** — normalize server-side after the schema, and tell the model
the current time in the system prompt:

```js
if (out.expiresAt && new Date(out.expiresAt) < new Date()) {
  out = { ...out, expiresAt: new Date(Date.now() + DECISION_TTL_MS) };
}
// system prompt: `The current date and time is: ${new Date().toISOString()}`
```

**Rule:** the AI does not know real time. Any time-dependent field must be
normalized server-side. Do not trust the model to compute it.

### 5. ObjectId leaking into the event contract

**Symptom:** `tenantId: expected string, got object` from the event contract
validator.

**Cause:** the tenant id was a `mongoose.Types.ObjectId`; the event contract
expected a string. Implicit serialization did not convert it.

**Fix:** `tenantId: String(snapshot.tenantId)`.

**Rule:** at the boundary between an ORM and an event system (outbox, queues,
webhooks), convert ids to strings explicitly. Do not rely on implicit
serialization.

## Outbound Gateway

### 6. Idempotency key too generic

Using `idempotencyKey = sourceId` collides across different actions on the same
entity. Use `provider + action + sourceId + version`.

### 7. Persisting endpoints with concrete IDs

`/123456/messages` makes metrics impossible to group. Persist the normalized
template: `/{accountId}/messages`.

### 8. Logging headers

Headers usually carry tokens. Never persist `Authorization`, cookies,
`accessToken`, `refreshToken`, or secrets in the attempt snapshot.

### 9. Retrying permanent 4xx

A `400` from a bad payload is not fixed by retrying. Only retry the explicit
`retryOn` list from the manifest.

### 10. Opening the breaker for the whole provider

If one failing endpoint trips the whole provider, you lose capacity needlessly.
Scope the breaker to `provider + normalized endpoint`.

### 11. The refresh-token race (the expensive one)

Two workers detect an expired token and both call the refresher. For providers
that rotate the refresh token, the second call consumes a token the first
already invalidated — and the account is left with no valid tokens until a human
reconnects it. The fix is an **atomic lease** with a TTL (see the Outbound
Gateway doc): one worker refreshes, the others poll and re-read. The TTL covers a
worker that dies mid-refresh.

## The meta-lesson

Most of these are not AI bugs. They are the bugs of *putting a non-deterministic
component inside a deterministic, audited system*: time it doesn't know,
identifiers it mangles, formats it invents, concurrency it ignores. The control
plane exists precisely so these failures degrade into a conservative fallback
instead of an unauthorized action.
