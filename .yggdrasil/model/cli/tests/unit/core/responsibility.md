# Core Unit Tests — Responsibility

Unit tests for every core library module in `src/core/`. Tests are pure function tests with mocked I/O — no real filesystem side effects.

## Scope

- `approve.test.ts` — drift approval logic and anti-laundering enforcement
- `check.test.ts` — full check gate logic
- `context-builder.test.ts` — context assembly and YAML map construction
- `context-files.test.ts` — artifact file path resolution
- `dependency-resolver.test.ts` — relation and dependency graph traversal
- `drift-detector.test.ts` — file hash comparison and drift detection
- `graph-loader.test.ts` — loading and parsing `.yggdrasil/` graph files
- `impact.test.ts` — blast radius computation
- `migrator.test.ts` — graph migration logic
- `node-selector.test.ts` — task-based node selection
- `validator.test.ts` — structural validation rule evaluation

## Out of scope

- CLI command wrapper tests — belongs to `cli/tests/unit/cli`
- Formatter, I/O, and utility tests — belongs to `cli/tests/unit/support`
