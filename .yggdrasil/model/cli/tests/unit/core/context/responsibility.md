# Context Core Unit Tests — Responsibility

Unit tests for context assembly pipeline modules: graph loading, context file resolution, and context map construction.

## Scope

- `context-builder.test.ts` — context assembly and YAML map construction, including snapshot tests
- `context-files.test.ts` — artifact file path resolution and listing
- `graph-loader.test.ts` — loading and parsing `.yggdrasil/` graph files (nodes, aspects, flows)
- `__snapshots__/context-builder.test.ts.snap` — snapshot baseline for context-builder output

## Out of scope

- Operations tests (approve, check, drift, impact, etc.) — belongs to `cli/tests/unit/core/operations`
