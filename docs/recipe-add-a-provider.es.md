# Receta: agregar un provider externo

[English](recipe-add-a-provider.md) · [Español](recipe-add-a-provider.es.md)

El [Outbound Gateway](03-outbound-gateway.es.md) es el *patrón*; esto es la
*receta*. Es el paso a paso para cablear una API externa nueva (un servicio de
email, un marketplace, una pasarela de pago, una plataforma de mensajería) de
punta a punta — webhooks entrantes, llamadas salientes, y la decisión que las
gatea.

El código es JavaScript ilustrativo; las formas son agnósticas al framework y al
storage.

## El modelo mental

Toda API externa que sumás pasa por tres carriles:

```
ENTRADA   (webhooks que el provider te manda)
   provider → /webhooks/{slug} → webhookGateway → InboundEvent (pending)
                                                       │
                                                       ▼
                                                 worker async procesa

SALIDA    (requests que vos le mandás al provider)
   tu código → gateway.call({ ... }) → API externa
                  ├─ getValidToken (refresh auto)
                  ├─ idempotency / rate limit / breaker
                  ├─ retry + backoff
                  └─ persiste AttemptLog → CostLedger

DECISIÓN  (acciones con costo, riesgo o impacto)
   tu código → DecisionEngine.decide() → decisión validada
                  ├─ Policy Engine (reglas duras)
                  ├─ Decision Cache
                  ├─ modelo (solo si aporta valor)
                  ├─ Schema + Business Validator
                  └─ ApprovalRequest si se requiere
```

**Tu trabajo por cada API nueva:** declarar el contrato (un manifest),
implementar el OAuth específico, escribir la lógica de negocio. **Todo lo demás —
refresh de tokens, idempotencia, retries, breaker, rate limit, costo, auditoría —
sale gratis** del gateway.

Reglas globales:

```
Nunca: IA -> provider externo directo
Nunca: módulo de negocio -> axios/fetch -> provider externo directo
Nunca: acción sensible -> executor sin una decisión vigente

Siempre:
  webhookGateway para la entrada
  DecisionEngine para decidir
  ApprovalRequest cuando se requiere un humano
  gateway.call() para la salida
  un outbox/worker para async + retry
  AttemptLog + CostLedger para trazabilidad
```

## La receta — 6 pasos por cada API nueva

### Paso 1 — Manifest

Declará *qué es la API* y *cómo le hablás*. El único lugar donde viven la base
URL, los scopes, la firma del webhook, el rate limit y el costo.

```js
module.exports = {
  // identidad
  provider:    'sendgrid',
  apiName:     'api_v1',
  description: 'Email transaccional.',

  // capabilities semánticas
  capabilities: [CAPABILITIES.SEND_EMAIL],

  // OAuth scopes (omitir si la API usa una key estática)
  requiredScopes: ['mail.send'],

  // webhooks entrantes
  webhookEvents:         ['delivered', 'opened', 'bounced'],
  signatureScheme:       'hmac',                    // 'hmac' | 'jwt' | 'none'
  signatureSecretEnvVar: 'SENDGRID_WEBHOOK_SECRET',

  // rate limit declarativo
  rateLimitPolicy: { perSecond: 10, perDay: 100000 },

  // costo (alimenta el CostLedger automático)
  costModel: { hasVariableCost: true, perCallCostUSD: 0.001, perUnit: 'email_sent' },

  // HTTP saliente (consumido por el gateway)
  http: {
    baseUrl:    'https://api.sendgrid.com',
    authHeader: 'Authorization',
    authFormat: 'Bearer {accessToken}',
    timeoutMs:  20000,
    retryPolicy: { maxAttempts: 3, backoffMs: [500, 2000, 5000], retryOn: [408, 429, 500, 502, 503, 504] },
  },

  // refresh de tokens (omitir para API keys estáticas)
  tokenRefresh: { refresh: require('./sendgridOAuth.refresh') },
};
```

Registralo para que el gateway lo tome. Agregar un provider debería ser **agregar
un manifest** — no cambiar el gateway.

### Paso 2 — Refresher OAuth (solo si la API usa OAuth)

Una función async de ~20 líneas que intercambia `refreshToken` por un
`accessToken` nuevo. `getValidToken()` la llama **automáticamente** cuando el
token está por vencer — la escribís una sola vez. Salteala por completo para
providers con API key estática.

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
    refreshToken: data.refresh_token,   // muchos providers rotan el refresh token también
    expiresInSec: data.expires_in,
  };
};
```

> El refresher **no** se preocupa por la concurrencia — el lease atómico de
> `getValidToken` garantiza un único refresh bajo carga paralela (ver el doc del
> Outbound Gateway). Si el provider rota el refresh token, devolvé el nuevo y
> fallá ruidoso si falta.

### Paso 3 — OAuth controller (inicio de la conexión)

Tres endpoints: `connect` (devuelve la URL de autorización), `callback` (recibe el
code, crea la cuenta), `disconnect` (revoca).

```
GET  /integrations/{provider}/connect      — arma la URL de autorización
GET  /integrations/{provider}/callback     — intercambia el code por tokens
POST /integrations/{provider}/disconnect   — revoca y elimina la cuenta
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
    accessToken:       data.access_token,   // cifrado al escribir
    refreshToken:      data.refresh_token,
    expiresAt:         new Date(Date.now() + data.expires_in * 1000),
  });

  res.redirect('/settings?connected=1');
}
```

> Nunca guardes tokens en texto plano — `ProviderAccount.upsert()` cifra al
> escribir, y los tokens nunca se devuelven a UI/logs.

### Paso 4 — Webhook endpoint

El controller hace una sola cosa: pasarle el request crudo a
`webhookGateway.ingest()` y responder `200` rápido. Nunca hagas trabajo pesado
acá.

```js
async function receive(req, res) {
  res.sendStatus(200); // responder inmediato

  await webhookGateway.ingest({
    provider:        'example',
    rawBody:         req.rawBody,   // para verificar la firma
    headers:         req.headers,
    payload:         req.body,
    externalEventId: req.body?.eventId,
    onIngested:      (event) => worker.enqueue(event.id),
  });
}
```

`ingest()` verifica la firma según `manifest.signatureScheme`, deduplica por
`(provider, externalEventId)`, persiste un `InboundEvent`, y dispara `onIngested`
solo para eventos nuevos. Algunos providers necesitan un challenge GET (verify
token) — respondelo antes de ingerir.

### Paso 5 — Service de dominio + worker async

El worker pollea los `InboundEvent` en `pending` y los procesa. El patrón:

```
1. Lee el InboundEvent.
2. Re-fetch del resource vía gateway.call() — no confíes en el payload del
   webhook como fuente completa.
3. Normaliza a tu modelo de dominio.
4. Arma un RoutingSnapshot.
5. Llama a DecisionEngine.decide(snapshot).
6. Según el resultado: crea un ApprovalRequest, notifica, o ejecuta.
```

Reclamá cada evento atómicamente para que dos workers no lo procesen doble, y
mandalo a dead-letter después de N intentos:

```js
const claimed = await InboundEvent.claim(event.id); // pending -> processing, atómico
if (!claimed) continue;
try {
  await service.handle(claimed);
  await InboundEvent.markProcessed(claimed.id);
} catch (err) {
  await InboundEvent.fail(claimed.id, err, { maxAttempts: 5 }); // -> pending o dead_lettered
}
```

Toda llamada saliente del service pasa por el gateway, y toda acción sensible por
el motor:

```js
const decision = await engine.decide({
  tenantId,
  action: { type: 'inbound_reply', sourceModule: 'example' },
  risk:   { riskLevel: 'medium' },
  context: { /* recortado — sin secretos, sin texto crudo del usuario */ },
});

if (decision.output.decision === 'block') return;
if (decision.output.requiresApproval) return createApproval(decision);

// solo con una decisión vigente:
await gateway.call({ account, method: 'POST', path: '/v1/messages', body, idempotencyKey });
```

### Paso 6 — Listo

Agregaste un provider sin tocar el gateway, el motor ni el framework del worker —
solo un manifest, un refresher OAuth, un controller, un handler de webhook y tu
lógica de dominio.

## Qué sale gratis vs qué escribís

| Sale gratis (del gateway/motor) | Escribís vos (por provider) |
|---|---|
| Refresh de tokens + lease anti-concurrencia | El refresher OAuth (~20 líneas) |
| Idempotencia, retry, breaker, rate limit | El manifest (URL, scopes, límites, costo) |
| Cost ledger + attempt log + auditoría | El connect/callback/disconnect de OAuth |
| Verificación de firma + dedupe (entrada) | El handler de webhook (una llamada a `ingest`) |
| Policy → IA → validadores → approval | Tus reglas duras + normalización de dominio |
| Fallback conservador ante cualquier falla | — |

## Definition of Done

```
[ ] Manifest registrado; el gateway lo resuelve
[ ] El refresher OAuth devuelve el refresh token rotado (u omitido para API keys)
[ ] connect/callback/disconnect andan; tokens guardados cifrados
[ ] El webhook responde 200 rápido; firma verificada; eventos deduplicados
[ ] El worker reclama atómicamente y manda a dead-letter después de N intentos
[ ] Re-fetch del resource — nunca confíes en el payload del webhook como completo
[ ] Toda llamada saliente pasa por gateway.call()
[ ] Toda acción sensible pasa por DecisionEngine.decide()
[ ] Sin tokens en logs, respuestas, ni storage en texto plano
```

## Anti-patrones

```
axios/fetch directo al provider desde un módulo de dominio
trabajo pesado dentro del controller del webhook (hacelo en el worker)
confiar en el payload del webhook en vez de re-fetchear
ejecutar antes de que exista una decisión vigente
un HTTP client / retry / refresh nuevo por provider (el gateway ya los tiene)
idempotency key = sourceId (colisiona — usá provider + action + sourceId + version)
```
