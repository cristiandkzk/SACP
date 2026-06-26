# Example — Claude (Anthropic) adapter

[English](README.md) · [Español](README.es.md)

A real `ModelProvider` for [`sacp-core`](../../packages/core), backed by **Claude
Opus 4.8**. It shows the pieces a production adapter needs:

- **Structured outputs** (`output_config.format`) so the model returns the exact
  JSON the core validator expects — no brittle string parsing.
- **System-authored prompt** with the current time injected (the model can't know
  it); the snapshot is sent as **delimited, untrusted data**, not instructions.
- **Refusal handling** — a safety decline (`stop_reason: "refusal"`) is turned
  into a failed call, so the engine falls back to a conservative rule-only
  decision instead of trusting an empty response.

See [`src/anthropicProvider.ts`](src/anthropicProvider.ts) for the adapter and
[`src/demo.ts`](src/demo.ts) for an end-to-end run.

## Run it

```bash
# 1. Build the core package this example depends on
cd ../../packages/core && npm install && npm run build && cd -

# 2. Install and build the example
npm install
npm run build

# 3. Run (needs your Anthropic API key)
export ANTHROPIC_API_KEY=sk-ant-...
npm run demo
```

The demo runs two decisions: one where hard rules pass and Claude assesses risk,
and one where a balance rule blocks the action **before the model is ever
called**. The model never has the final word — a `BusinessValidator` (not wired
in this minimal demo) could still override its `allow`.

> This example pins `sacp-core` via `file:../../packages/core`, so build the core
> first. Once `sacp-core` is published to npm, replace that with a normal version
> range.
