# Operations Core Unit Tests — Responsibility

Unit tests for core CLI operation modules: approval, validation, drift detection, impact analysis, dependency resolution, migration, and node selection.

## Scope

- `approve.test.ts` — drift approval logic and anti-laundering enforcement
- `check.test.ts` — full check gate logic and health scoring
- `dependency-resolver.test.ts` — relation and dependency graph traversal
- `drift-detector.test.ts` — file hash comparison and drift detection
- `effective-aspects.test.ts` — effective aspect resolution and computation
- `impact.test.ts` — blast radius computation for nodes and aspects
- `migrator.test.ts` — graph migration transformation logic
- `node-selector.test.ts` — task-based node selection
- `validator.test.ts` — structural validation rule evaluation
- `artifact-reviewer.test.ts` — artifact review orchestration and LLM response handling
- `claim-verifier.test.ts` — claim extraction, batching, and per-file verification logic
- `approve-llm.test.ts` — approve gate with reviewer configured (E055/E056 enforcement, --reviewed flag)

## Out of scope

- Context assembly tests — belongs to `cli/tests/unit/core/context`
