# Decision Engine

[English](01-decision-engine.md) · [Español](01-decision-engine.es.md)

Una forma práctica de decidir acciones con IA sin dejar que la IA tenga la última
palabra.

```
La IA propone.
La plataforma valida.
El executor solo corre decisiones validadas.
```

Aplica a cualquier producto que use IA para decidir acciones con costo, riesgo o
impacto operativo: plataformas SaaS, CRMs, herramientas de mensajería,
marketplaces, sistemas de marketing, asistentes internos.

## El problema

Muchas plataformas conectan la IA directo a la ejecución:

```
el usuario pide algo  ->  el modelo decide  ->  el sistema ejecuta
```

Ese flujo es peligroso cuando la acción puede: generar costo variable, enviar por
canales pagos, publicar contenido, afectar la reputación, violar límites de plan,
duplicar envíos, ignorar opt-out/consentimiento, o requerir aprobación humana.

El fix es **separar decisión, validación y ejecución**.

## El principio

> No uses IA si una regla, un cache o una tool determinística pueden resolverlo
> bien.

Orden recomendado:

```
Rule / Policy Engine
  -> Decision Cache
  -> AI Router (solo si aporta valor)
  -> Schema Validator
  -> Business Validator
  -> Approval Workflow
  -> Executor
  -> Audit / Billing / Outbox
```

Nunca:

```
AI Router -> Executor (directo)
```

## Un motor, cualquier origen

El motor no es solo para una feature. Es un patrón de decisión para cualquier
acción con costo, riesgo o impacto — sin importar quién la dispara.

```
Un usuario en la UI del panel  -> crea una campaña, publica un producto
Un bot / automatización         -> responde un mensaje entrante
Un asistente IA interno         -> el usuario pide en lenguaje natural; el
                                  asistente propone; el motor decide; un humano
                                  aprueba si el riesgo lo exige
Un worker / job programado      -> sync de stock, reconciliación
Un webhook de provider entrante -> una pregunta de marketplace, un evento de orden
```

Todos producen lo mismo: un **RoutingSnapshot** con un `action.type` declarado. El
motor ni sabe ni le importa quién lo armó.

### El patrón del asistente interno

Un asistente conversacional es uno de los orígenes más comunes. La forma correcta:

```
El asistente recibe un pedido en lenguaje natural
  -> lee los datos que necesita (tools read_*)
  -> propone una acción (tool propose_*)
  -> propose_* arma un RoutingSnapshot con el action.type correcto
  -> llama al decision service
  -> el decision service corre el flujo completo:
       Policy Engine -> AI Router -> Schema Validator
       -> Business Validator -> Approval si corresponde
  -> la tool devuelve { status: 'pending_approval' | 'allowed' | 'blocked' }
  -> el asistente comunica el resultado
```

Lo que el asistente **no** debe hacer: ejecutar directo, llamar APIs externas
directo, saltear el Policy Engine, asumir que su propio juicio de riesgo alcanza,
ni aprobar sus propias propuestas.

## Core agnóstico al canal y a la acción

El input universal es un `RoutingSnapshot` con un sub-objeto `action`:

```
action.type:
  campaign_send     - envío masivo
  inbound_reply     - respuesta a un mensaje/evento entrante
                      (DMs, preguntas de marketplace, respuestas de soporte, propuestas del asistente)
  content_publish   - publicar un producto o post en un canal externo
  auto_reply        - respuesta automática del bot
  comment_moderate  - moderar/responder un comentario público
```

`action.sourceModule` y `action.sourceType` son metadata de trazabilidad
solamente (ej. `marketplace` / `marketplace_answer_question`). Identifican el
origen en logs y auditoría; **no** cambian el flujo del motor.

`action.type` determina: el scope de policy a evaluar, la feature del selector de
modelo, los títulos del approval request, y qué pasos del flujo aplican (ej.
reserva de saldo solo para `campaign_send`).

### Extender sin tocar el core

Agregar un **canal** nuevo:

```
{Channel}Snapshot adapter   - traduce el estado del canal al snapshot universal
{channel}CostEstimator      - estima el costo específico del canal
{channel}Balance            - reserva saldo si el canal lo requiere
policies específicas        - solo si necesita reglas propias
```

Agregar un **tipo de acción** nuevo:

```
policy scope 'router_ai.{type}'  - reglas duras para ese tipo
feature del selector             - qué modelos pueden responder
factory de snapshot              - RoutingSnapshot.for{Type}(...)
```

Nunca cambies: el decision service, el decision model, el output schema, el
rule-only fallback, el Policy Engine, el Decision Cache, el Provider Selector.

## Componentes

### 1. Policy Engine (reglas duras)

Corre reglas determinísticas **antes** de cualquier llamada al modelo.

```
el plan no permite la acción  -> block
saldo insuficiente            -> block
usuario sin permiso           -> block
canal desconectado            -> block
destinatario sin consentimiento -> block
opt-out activo                -> block
canal no oficial no habilitado -> block
feature flag apagada          -> block
approval requerida, no otorgada -> block
```

La IA no debe poder ignorarlas. Agrupá las policies por scope (ej.
`router_ai.routing`) con un orden de evaluación explícito:

```
optOut -> channel -> channelConnected -> channelBalance
       -> planLimits -> riskGates -> experimentalChannel
```

### 2. AI Router

Optimiza **dentro** de lo permitido. Puede decidir: tandas, delays, orden
recomendado, riesgo, explicación, si pedir aprobación, si pausar, si una
alternativa más barata es mejor.

**No** puede decidir: ignorar límites de plan, usar un canal deshabilitado, enviar
sin saldo, enviar a opt-outs, ejecutar sin una aprobación requerida, ni usar un
canal experimental como fallback automático.

### 3. Schema Validator

Valida el output del modelo contra un JSON Schema estricto.

```
si el schema falla:
  no ejecutar
  reintentar como máximo una vez
  si vuelve a fallar, usar el fallback conservador
  emitir un evento schema_failed
```

### 4. Business Validator

Re-valida **después** de la IA: plan, límites, saldo, reserva de costo, permisos,
feature flags, estado del canal/provider, consentimiento, opt-out, horarios
permitidos, reputación de links, aprobaciones, circuit breakers, idempotencia,
expiración de la decisión.

> Aunque la IA devuelva `allow`, el Business Validator puede convertirlo en
> `block` o `require_approval`. Esta es la línea que todo el patrón protege.

### 5. Executor

Solo corre decisiones validadas. Recibe algo como:

```
decisionId, channel, provider, destination, payload,
scheduledFor, idempotencyKey, correlationId, costReservationId
```

**No** recalcula la decisión. Si la decisión venció o cambió un input crítico,
bloquea y pide una decisión fresca.

## El decision model

Persistí lo suficiente para auditar y ser idempotente. Campos recomendados:

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
rule_checked -> ai_requested        (si la IA aporta valor)
rule_checked -> business_validated  (si las reglas ya deciden)
ai_requested -> ai_decided -> schema_validated -> business_validated
business_validated -> approval_pending  (si requiere aprobación)
business_validated -> routable           (si es ejecutable)
business_validated -> blocked            (si falla una regla dura)
approval_pending -> approved -> routable
```

## El orquestador

```
1. Recibe un snapshot resumido.
2. Calcula inputHash / contextHash.
3. Corre reglas duras. Si deciden, devuelve una decisión rule-only.
4. Busca el decision cache. En hit, valida y devuelve.
5. Elige provider/modelo por costo, riesgo y plan.
6. Llama a la IA solo si aporta valor.
7. Valida JSON estricto. Reintenta una vez si falla.
8. Corre el Business Validator.
9. Persiste la decisión.
10. Registra tokens y costo.
11. Guarda el cache si es seguro.
12. Crea un approval request si se requiere.
13. Devuelve la decisión final.
```

El orquestador **no** debe: ejecutar envíos, reservar saldo directo, ignorar
policies, aceptar output de IA sin el schema validator, ni mandar texto crudo del
usuario al modelo (prevención de prompt injection).

## Rule-Only Fallback

El camino conservador cuando la IA falla o no aporta valor:

```
reglas duras bloquean        -> decision = block
riesgo bajo + reglas pasan   -> decision = allow (tandas mínimas, delays conservadores)
riesgo medio                 -> decision = require_approval
riesgo alto / crítico        -> decision = block
```

Reason codes: `RULE_ONLY_FALLBACK_USED`, `AI_PROVIDER_UNAVAILABLE`,
`PROVIDER_CIRCUIT_OPEN`, `SCHEMA_INVALID`, `LOW_RISK_RULES_PASSED`,
`MEDIUM_RISK_APPROVAL_REQUIRED`, `HIGH_RISK_BLOCKED`.

## Output schema

Output mínimo esperado del modelo:

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

Enums: `decision` = allow | block | require_approval | split; `riskLevel` = low |
medium | high | critical; `confidence` = low | medium | high.

## Modos de rollout

```
simulation  - computa costo/riesgo, no ejecuta (UI, QA)
advisory    - muestra recomendación, el humano aprueba, el executor espera
shadow      - compara la decisión real (reglas) vs la de la IA, sin efecto en producción
enforced    - una decisión validada de la IA puede afectar el routing; solo canales estables/oficiales
```

> Los canales experimentales o no oficiales nunca deben arrancar en `enforced`.
> Mantenelos en advisory/shadow, o bloqueá salvo habilitación explícita.

## Control de costos

El motor reduce el **costo de IA** porque: no llama a la IA cuando una regla
alcanza, usa un decision cache, elige el modelo por costo/riesgo, hace una llamada
por tanda (no una por destinatario), recorta el snapshot (sin texto crudo, sin
secretos), y mide tokens por tenant/feature/provider/modelo.

Reduce el **costo de APIs externas** porque: estima el costo antes de ejecutar,
bloquea ante saldo insuficiente, reserva saldo antes de ejecutar, separa acciones
gratuitas vs pagas, y detecta duplicados vía idempotencia.

## Qué debe existir antes de construir el motor

Estructuras de datos: un registro de **Decision** (con su state machine), un
**Event Outbox** (publicación atómica de eventos), un **Approval Request**, el
contrato **RoutingSnapshot**, y el **JSON Schema del output**.

Servicios de infraestructura: **Policy Engine** (reglas por scope), **Decision
Cache** (`hash(input) + hash(context)`), **Provider Selector** (con circuit
breaker), **AI Circuit Breaker**, **Usage Ledger**, **Cost Estimator** y **Balance
Service** por canal.

Servicios de negocio: **Approval Service**, **Rate Card / Pricing Store** (con
vigencia temporal), **Exchange Rate Service** (cacheado, con una tasa de
fallback).

**No** necesitás primero: el executor, un dashboard de decisiones, el shadow mode
completo, ni múltiples adapters de canal. Construí el canal oficial primero.

## Orden de construcción recomendado

```
1. Decision model + output schema       (sin persistencia no hay nada que auditar)
2. Rule-only fallback service           (el motor debe correr sin IA desde el día uno)
3. Policy Engine + reglas mínimas del canal (las reglas duras antes que la IA)
4. Orquestador (decision service)         (integra lo anterior)
5. Channel snapshot adapter (canal oficial)
6. Domain adapter (arma el snapshot, conecta el dominio con el motor)
7. Endpoint de simulación                 (primer punto de entrada end-to-end)
8. Decision Cache + Provider Selector     (optimización de costo, segundo corte)
```

## Testing

> No testees la IA. Testeá que el motor la usa bien y que sobrevive cuando falla.
> Si un test necesita que el modelo responda correctamente para pasar, es un test
> del modelo, no del motor.

Casos obligatorios antes de habilitar cualquier cosa más allá de `simulation`:

```
Plan no permitido         -> block, reason PLAN_NOT_ALLOWED
Canal desconectado        -> block, reason CHANNEL_DISCONNECTED
Saldo insuficiente        -> block, reason BALANCE_INSUFFICIENT
Opt-out total             -> block, reason OPT_OUT
Opt-out parcial           -> no es block global; blockedDestinations lista los opt-outs
Health score crítico      -> block o require_approval según la policy
IA no disponible (timeout) -> rule-only fallback, fallbackUsed=true, sin excepción
Schema inválido y después válido -> decisión válida, attempts=2, tokens de ambas llamadas contados
Schema inválido dos veces -> rule-only fallback, schema_failed emitido
IA allow -> validator block (el canal se desconecta a mitad) -> block
Cache hit                 -> el segundo request idéntico no llama a la IA
Cache invalidado          -> un cambio de contexto (health score) fuerza una nueva llamada a la IA
Experimental + enforced   -> block, sin importar lo que diga la IA
Reserva de saldo falla    -> block final, reason BALANCE_INSUFFICIENT
Decisión vencida          -> el executor se niega, no ejecuta
```

## Regla final

```
Las reglas deciden qué está permitido.
La IA optimiza lo que está permitido.
Los validadores deciden qué puede ejecutarse.
Los executors solo corren decisiones validadas.

Quien origina la decisión no importa:
un usuario, un bot, un asistente IA o un worker
todos pasan por el mismo motor.
```
