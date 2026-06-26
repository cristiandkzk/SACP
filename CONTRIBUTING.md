# Contributing to Safe Automation Control Plane (SACP)

This is a pattern, not a framework, so the most valuable contributions are
**experience reports**, not feature requests.

Especially welcome:

- A bug you hit implementing the pattern, plus the fix and the rule it taught
  you (the format in [docs/lessons-learned.md](docs/lessons-learned.md)).
- A reference implementation in a language or stack not covered yet. Link it;
  it does not have to live in this repo.
- A new `action.type`, channel adapter, or provider manifest shape that the core
  did not anticipate.
- Corrections where the spec disagrees with what production actually requires.

Please keep the docs **stack-agnostic**. Concrete examples are good; hard
dependencies on a specific database, framework, or vendor are not — push those
into a clearly-labeled "example" section.

Open an issue to discuss anything large before writing it.
