# Outbound Gateway

[English](03-outbound-gateway.md) · [Español](03-outbound-gateway.es.md)

Una forma práctica de llamar APIs externas sin duplicar plomería en cada módulo
de negocio.

```
El módulo de negocio declara una acción.
El gateway valida, mide, limita y ejecuta la llamada HTTP.
El proveedor externo nunca se llama directo desde un dominio.
```

Aplica a cualquier producto que integre APIs externas con tokens, costos, rate
limits o riesgo operativo.

## El problema

Las plataformas suelen empezar llamando providers así:

```
módulo de instagram    -> axios.post('https://graph.facebook.com/...')
módulo de marketplace   -> axios.get('https://api.marketplace.com/...')
módulo de email         -> fetch('https://api.email-provider.com/...')
```

Simple al principio, peligroso después, porque una llamada puede: consumir saldo
o generar costo variable, duplicar una acción por timeout, fallar por token
vencido, martillar a un provider caído, exceder rate limits, necesitar
auditoría/trazabilidad, llevar secretos en headers, necesitar retry con backoff o
afectar la reputación.

El fix es separar **negocio**, **plomería HTTP** y **control operativo**.

## El principio

Nunca llamar una API externa directo desde un módulo de dominio.

```
Servicio de negocio
  -> gateway.call()
  -> Provider Registry            (resuelve el manifest)
  -> ProviderAccount / token       (token válido vía getValidToken)
  -> idempotencia
  -> circuit breaker
  -> rate limit
  -> retry / backoff
  -> Attempt log
  -> Cost ledger / auditoría
  -> API externa
```

El caller declara intención. El gateway es dueño de la infraestructura.

## Componentes

### 1. Provider Registry

Un manifest declarativo por provider. Agregar un provider = agregar un manifest;
no debería requerir cambiar el gateway. Cada manifest declara: `provider`,
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

El caller no debería conocer la base URL, el formato de auth, el timeout ni la
política de retry.

### 2. ProviderAccount

Un modelo para las cuentas conectadas, por tenant. Guarda: account id, tokens
cifrados, scopes solicitados, permisos efectivos, estado operativo, `expiresAt`,
metadata específica del provider.

Estados: `not_connected`, `connecting`, `connected`, `missing_permissions`,
`token_expired`, `restricted`, `disabled`, `disconnected`, `error`.

> Los tokens nunca se devuelven a la UI, logs ni respuestas de la API.

### 3. getValidToken — con un lease anti-concurrencia

Devuelve un access token usable. La parte sutil es la concurrencia: sin lease, dos
workers que ambos detectan un token vencido llaman al refresher al mismo tiempo.
Para providers que **rotan** el refresh token (OAuth estándar), el segundo refresh
recibe un refresh token que el primero ya consumió -> la cuenta queda sin tokens
válidos.

```
1. Recibe ProviderAccount (o lo busca).
2. Token vivo -> lo devuelve.
3. Vencido / por vencer -> intenta tomar el LEASE de refresh (claim atómico).
4a. Gana el lease  -> intercambia refreshToken por un accessToken nuevo, persiste
                      cifrado, libera el lease (siempre, incluso si falla). Si
                      falla, marca la cuenta token_expired.
4b. Pierde el lease -> otro worker está refrescando. Pollea hasta que libere (o
                      el TTL), re-lee tokens frescos del storage, devuelve sin
                      refrescar.
5. Devuelve { accessToken, account, refreshed }.
```

Claim atómico (se muestra MongoDB; el equivalente en Redis sirve):

```js
findOneAndUpdate(
  { _id, $or: [ { refreshLockedBy: null }, { refreshLockExpiresAt: { $lt: now } } ] },
  { $set: { refreshLockedBy: workerId, refreshLockedAt: now, refreshLockExpiresAt: now + 30s } },
  { new: true }
)
// truthy = ganaste el lease ; null = otro worker lo tiene
```

Un TTL del lease de ~30s cubre al worker que muere a mitad del refresh: otro puede
reclamarlo cuando el lease vence, sin intervención manual.

El refresher en sí nunca se preocupa por la concurrencia (`getValidToken`
garantiza una sola llamada). Si el provider rota el refresh token, el refresher
debe devolver el nuevo y fallar ruidoso si falta. Si no rota (tokens long-lived),
devuelve el nuevo access token también como refresh token, para que el próximo
refresh tenga algo que usar.

### 4. gateway.call() — el entrypoint universal

```js
const result = await gateway.call({
  account,
  method: 'POST',
  path: '/{accountId}/messages',
  pathParams: { accountId: account.providerAccountId },
  body: { recipient: { id }, message: { text: 'Hola' } },
  idempotencyKey: `dm_${eventId}`,
  sourceModule: 'messaging',
  sourceType: 'dm_send',
  sourceId: eventId,
});
// -> { ok, status, data, error, attempts, latencyMs, refreshedToken, correlationId, attemptId, costLedgerId }
```

> El gateway no tira ante una falla del provider. Devuelve `{ ok: false, error }`
> y deja que el caller decida.

### 5. Idempotencia

Cuando el caller pasa `idempotencyKey`, el gateway chequea si ya hay un attempt
exitoso previo con esa key. Si existe: no llama al provider, devuelve el resultado
persistido, `attempts = 0`. Esto evita duplicados cuando el provider recibió el
request pero no respondió, el worker reinició, hubo timeout después de ejecutar, o
el caller reintentó.

Forma de la key: `provider + idempotencyKey`, ej. `dm_<eventId>`,
`question_reply_<questionId>`, `payment_capture_<invoiceId>`.

### 6. Attempt log

Un registro auditable de cada llamada saliente: provider, endpoint normalizado,
origen interno, cantidad de intentos, status final, status HTTP, snapshot
sanitizado de respuesta, código/mensaje de error, costo estimado, latencia,
correlationId.

Estados: `pending`, `success`, `error`, `timeout`, `circuit_open`, `rate_limited`,
`token_unavailable`. Índices: `unique(provider, idempotencyKey)` cuando existe la
key; `(tenant, provider, occurredAt)`; `(sourceModule, sourceType, sourceId)`; TTL
en `occurredAt`.

### 7. Circuit breaker — por (provider, endpoint)

```
closed     -> llamadas normales
open       -> el gateway devuelve circuit_open sin pegarle al provider
half_open  -> un probe tras el cooldown; éxito -> closed, falla -> open
```

> El scope es **endpoint**, no provider. `/messages` puede fallar mientras
> `/media` funciona; cortar todo el provider pierde capacidad al pedo.

### 8. Rate limit — por (tenant, provider)

Consume `manifest.rateLimitPolicy` (perSecond/perMinute/perHour/perDay/burst).
Al excederse: devolver `rate_limited`, loguear el attempt, no llamar al provider.
Empezá con un token bucket in-memory; movete a un token bucket atómico en Redis
cuando corras múltiples workers.

### 9. Retry / backoff — definido por el manifest

```
2xx                       -> success
4xx no retryable          -> no reintentar
408 / 429 / 5xx retryable -> backoff y reintentar
timeout                   -> reintentar hasta maxAttempts
maxAttempts agotado       -> attempt status error o timeout
```

Reintentá solo la lista explícita de `retryOn` del manifest. Un `400` por payload
inválido no se arregla reintentando.

### 10. Cost ledger

Escribí un registro de costo cuando `costModel.hasVariableCost` es true y aplica
un costo por llamada (salvo que el tracking de costo esté explícitamente
salteado). Campos: tenant, apiName, provider, source, operation, units, unitType,
currency, estimatedCost, actualCost, costStatus, occurredAt.

## Agregar un provider

> Walkthrough completo paso a paso (manifest → OAuth → webhook → worker →
> decisión) con un ejemplo trabajado: **[recipe-add-a-provider.es.md](recipe-add-a-provider.es.md)**.

```
1. Crear el manifest.
2. Registrarlo.
3. Crear el refresher OAuth si hace falta.
4. Crear el controller OAuth provider-specific.
5. Guardar la cuenta (ProviderAccount.upsert()).
6. Llamar APIs vía gateway.call().
7. Exponer el webhook entrante si aplica.
```

**No** reconstruyas: HTTP client con retry, token refresh genérico, idempotencia,
circuit breaker, rate limit, cost ledger, attempt model.

## Errores uniformes

`missing_required_fields`, `account_not_found`, `unknown_provider`,
`manifest_missing_http_config`, `token_unavailable`, `circuit_open`,
`rate_limited`, `timeout`, `network_error`, `http_400`, `http_401`, `http_403`,
`http_404`, `http_429`, `http_500`. El caller no debería parsear los errores
nativos de Axios / Fetch / SDK.

## Modos de rollout

```
documentation - definir contratos, manifests, estructura; sin cambio de runtime
shadow        - loguear attempts en paralelo / simular llamadas; sin efecto en producción
advisory      - rutear algunos callers de bajo riesgo por el gateway
enforced      - prohibir llamadas directas a providers desde módulos de negocio
```

En `enforced`, un `axios`/`fetch` directo a providers externos debería aparecer
como deuda técnica o una falla de lint/review.

## Tests

> No testees que el provider externo funciona. Testeá que el gateway se comporta
> bien bajo respuestas controladas.

Casos mínimos: token válido (sin refresher, llama al provider); token vencido con
refresher (refresca, persiste, llama); token vencido sin refresher (devuelve
`token_unavailable`); éxito de idempotencia previo (devuelve snapshot, sin
llamada); breaker abierto (sin llamada, `circuit_open`); rate limit excedido (sin
llamada, `rate_limited`); `429` retryable (reintenta hasta éxito/maxAttempts);
`500` retryable (reintenta con backoff); `400` no retryable (sin retry,
`http_400`); timeout (reintenta, después `timeout`); respuesta grande (snapshot
truncado); costo variable (crea registro en el ledger, lo linkea al attempt).

Tests del lease (concurrencia): 2 workers concurrentes con un token vencido -> una
sola llamada al refresher; uno obtiene `refreshed: true`, el otro lee del storage
`refreshed: false`. Lease vencido (zombie) -> un worker nuevo lo reclama. Refresh
exitoso -> lease liberado. Refresh falla -> lease liberado igual, cuenta marcada
`token_expired`.

Mockeá el HTTP client, no el provider real. Mockeá `getValidToken()` para
controlar vivo / refresh / `token_unavailable`.

## Bugs comunes

```
Idempotency key demasiado genérica   ->  provider + action + sourceId + version
Endpoint persistido con IDs           ->  normalizá: /{accountId}/messages, no /123/messages
Loguear headers                       ->  nunca persistas Authorization, cookies, tokens, secretos
Reintentar 4xx permanentes            ->  solo la lista explícita de retryOn
Breaker global por provider           ->  breaker por provider + endpoint normalizado
```

## Relación con un Decision Engine

El Decision Engine decide *si* una acción puede ejecutarse. El Outbound Gateway
*ejecuta* una llamada externa de forma controlada.

```
Decision Engine -> decisión validada -> executor -> gateway.call() -> API externa
```

Nunca `AI Router -> API externa`. La IA no debería tener tokens, URLs internas ni
la capacidad de llamar providers.

## Regla final

```
Los módulos de negocio no llaman providers.
Declaran intención.
El gateway controla la salida.
Cada llamada queda medida, limitada, idempotente y auditable.
```
