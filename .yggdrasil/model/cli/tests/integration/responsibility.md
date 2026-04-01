# Integration Tests — Responsibility

Pipeline tests that exercise multiple CLI layers together using a real (temp-copy) fixture project. Each test file covers a full vertical slice through the system.

## Scope

- `approve-pipeline.test.ts` — three-axis approve logic, blackbox enforcement, anti-laundering
- `build-pipeline.test.ts` — context assembly end-to-end
- `check-pipeline.test.ts` — full check gate: drift, validation, coverage, completeness
- `context-pipeline.test.ts` — context package generation
- `drift-pipeline.test.ts` — drift detection across file changes
- `flow-support.test.ts` — flow participant resolution and aspect propagation
- `validation-pipeline.test.ts` — structural error detection

## Out of scope

- Isolated unit tests with no filesystem — belongs to `cli/tests/unit`
- Black-box binary invocation via subprocess — belongs to `cli/tests/e2e`
- Test input data and sample projects — belongs to `cli/tests/fixtures`
