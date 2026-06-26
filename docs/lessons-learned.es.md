# Lecciones aprendidas

[English](lessons-learned.md) · [Español](lessons-learned.es.md)

Estos son bugs encontrados **corriendo** el patrón contra una base de datos real
y un provider de modelo real — no leyendo el spec. Los mismos problemas aparecen
en cualquier implementación de esta arquitectura, así que vale la pena anotarlos.

## Decision Engine

### 1. `Date.parse()` acepta strings no-ISO

**Síntoma:** un test de schema pasaba con `expiresAt: "mañana a las 3"`.

**Causa:** el `Date.parse()` de V8 acepta strings que no son ISO 8601 y devuelve
un timestamp válido en vez de `NaN`. El validador confiaba solo en `Date.parse()`.

**Fix:** regex primero, después `Date.parse()`.

```js
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const isIso = v => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
```

**Regla:** nunca validar formato ISO con `Date.parse()` solo.

### 2. El Policy Engine permitía todo en silencio

**Síntoma:** 14 de 22 tests de integración fallaban — las policies devolvían
`allowed: true` para todo input.

**Causa:** el test requería el engine pero nunca llamaba `registerAll()`. Con un
registro lazy y cero policies registradas, el engine por defecto da
`allowed: true`.

**Fix:** registrar las policies explícitamente en el setup del test.

```js
beforeAll(() => { require('../../policy/policies').registerAll(); });
```

**Regla:** si el engine usa un registro lazy, el test tiene que activarlo. Un
`require` pelado no alcanza — y un default "fail open" es un arma cargada.

### 3. Model IDs de marketing que no existen

**Síntoma:** `400 json_validate_failed` al llamar al provider.

**Causa:** el registry del selector listaba model IDs copiados de una página de
marketing que no eran modelos reales disponibles en la API del provider.

**Fix:** reemplazarlos por IDs verificados contra la lista de modelos en vivo del
provider.

**Regla:** verificá los model IDs contra la API real antes de agregarlos al
registry. Los nombres de marketing mienten.

### 4. La IA genera `expiresAt` en el pasado

**Síntoma:** `decision: allow` pero estado final `blocked`, con
`businessValidationResult.failures = [DECISION_EXPIRED]`.

**Causa:** el modelo produjo una fecha de su training cutoff, no del momento de la
llamada. El Business Validator bloqueó correctamente una decisión ya vencida.

**Fix, dos partes** — normalizar server-side después del schema, e informarle al
modelo la hora actual en el system prompt:

```js
if (out.expiresAt && new Date(out.expiresAt) < new Date()) {
  out = { ...out, expiresAt: new Date(Date.now() + DECISION_TTL_MS) };
}
// system prompt: `The current date and time is: ${new Date().toISOString()}`
```

**Regla:** la IA no conoce el tiempo real. Cualquier campo de fecha que dependa
del momento de la llamada debe normalizarse server-side. No confíes en que el
modelo lo calcule.

### 5. ObjectId filtrándose al contrato de eventos

**Síntoma:** `tenantId: expected string, got object` del validador de contrato de
eventos.

**Causa:** el tenant id era un `mongoose.Types.ObjectId`; el contrato esperaba un
string. La serialización implícita no lo convertía.

**Fix:** `tenantId: String(snapshot.tenantId)`.

**Regla:** en la frontera entre un ORM y un sistema de eventos (outbox, colas,
webhooks), convertí los ids a string explícitamente. No confíes en la
serialización implícita.

## Outbound Gateway

### 6. Idempotency key demasiado genérica

Usar `idempotencyKey = sourceId` colisiona entre acciones distintas sobre la misma
entidad. Usá `provider + action + sourceId + version`.

### 7. Persistir endpoints con IDs concretos

`/123456/messages` hace imposible agrupar métricas. Persistí el template
normalizado: `/{accountId}/messages`.

### 8. Loguear headers

Los headers suelen llevar tokens. Nunca persistas `Authorization`, cookies,
`accessToken`, `refreshToken` ni secretos en el snapshot del attempt.

### 9. Reintentar 4xx permanentes

Un `400` por payload inválido no se arregla reintentando. Reintentá solo la lista
explícita de `retryOn` del manifest.

### 10. Abrir el breaker para todo el provider

Si un endpoint que falla corta todo el provider, perdés capacidad al pedo.
Scopeá el breaker a `provider + endpoint normalizado`.

### 11. La carrera del refresh-token (la cara)

Dos workers detectan un token vencido y ambos llaman al refresher. Para providers
que rotan el refresh token, la segunda llamada consume un token que la primera ya
invalidó — y la cuenta queda sin tokens válidos hasta que un humano la
reconecta. El fix es un **lease atómico** con TTL (ver el doc del Outbound
Gateway): un worker refresca, los otros pollean y re-leen. El TTL cubre al worker
que muere a mitad del refresh.

## La meta-lección

La mayoría de estos no son bugs de IA. Son los bugs de *meter un componente
no-determinista adentro de un sistema determinístico y auditado*: tiempo que no
conoce, identificadores que mangle, formatos que inventa, concurrencia que
ignora. El control plane existe justamente para que esas fallas degraden a un
fallback conservador en vez de a una acción no autorizada.
