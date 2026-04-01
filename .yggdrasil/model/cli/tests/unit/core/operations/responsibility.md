# Operations Core Unit Tests — Responsibility

Unit tests for core CLI operation modules: approval, validation, drift detection, impact analysis, dependency resolution, migration, and node selection.

## Scope

- `approve.test.ts` — drift approval logic and anti-laundering enforcement
- `check.test.ts` — full check gate logic and health scoring
- `dependency-resolver.test.ts` — relation and dependency graph traversal
- `drift-detector.test.ts` — file hash comparison and drift detection
- `impact.test.ts` — blast radius computation for nodes and aspects
- `migrator.test.ts` — graph migration transformation logic
- `node-selector.test.ts` — task-based node selection
- `validator.test.ts` — structural validation rule evaluation

## Out of scope

- Context assembly tests — belongs to `cli/tests/unit/core/context`
