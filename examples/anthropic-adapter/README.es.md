# Ejemplo — adapter de Claude (Anthropic)

[English](README.md) · [Español](README.es.md)

Un `ModelProvider` real para [`sacp-core`](../../packages/core), con **Claude
Opus 4.8** por detrás. Muestra las piezas que un adapter de producción necesita:

- **Salida estructurada** (`output_config.format`) para que el modelo devuelva el
  JSON exacto que el validador del core espera — sin parseo frágil de strings.
- **Prompt autoría del sistema** con la fecha/hora actual inyectada (el modelo no
  puede saberla); el snapshot se manda como **dato delimitado y no confiable**, no
  como instrucciones.
- **Manejo de refusal** — un rechazo de seguridad (`stop_reason: "refusal"`) se
  convierte en una llamada fallida, así el motor cae a una decisión conservadora
  por reglas en vez de confiar en una respuesta vacía.

Ver [`src/anthropicProvider.ts`](src/anthropicProvider.ts) para el adapter y
[`src/demo.ts`](src/demo.ts) para una corrida de punta a punta.

## Cómo correrlo

```bash
# 1. Compilá el paquete core del que depende este ejemplo
cd ../../packages/core && npm install && npm run build && cd -

# 2. Instalá y compilá el ejemplo
npm install
npm run build

# 3. Corré (necesita tu API key de Anthropic)
export ANTHROPIC_API_KEY=sk-ant-...
npm run demo
```

El demo corre dos decisiones: una donde las reglas duras pasan y Claude evalúa el
riesgo, y otra donde una regla de saldo bloquea la acción **antes de que el modelo
se llame siquiera**. El modelo nunca tiene la última palabra — un
`BusinessValidator` (no cableado en este demo mínimo) podría igual anular su
`allow`.

> Este ejemplo fija `sacp-core` vía `file:../../packages/core`, así que compilá el
> core primero. Cuando `sacp-core` esté publicado en npm, reemplazalo por un rango
> de versión normal.
