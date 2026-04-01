# CLI Tests Responsibility

Automated test suite for the `@chrisdudek/yg` CLI package. Covers unit, integration, and end-to-end scenarios using Vitest as the test runner.

## Test layers

### Unit tests (`tests/unit/`)

Pure function tests with no filesystem side effects. Mirror the `src/` directory structure:

- `core/` — unit tests for every core library: `approve.test.ts`, `check.test.ts`, `context-builder.test.ts`, `context-files.test.ts`, `dependency-resolver.test.ts`, `drift-detector.test.ts`, `graph-loader.test.ts`, `impact.test.ts`, `migrator.test.ts`, `node-selector.test.ts`, `validator.test.ts`
- `cli/` — unit tests for thin command wrappers: `build-command.test.ts`, `impact.test.ts`, `owner.test.ts`, `which.test.ts`
- `formatters/`, `io/`, `migrations/`, `templates/`, `utils/` — unit tests for their respective modules

### Integration tests (`tests/integration/`)

Pipeline tests that exercise multiple layers together using a real (temp-copy) fixture project:

- `approve-pipeline.test.ts` — three-axis approve logic, blackbox enforcement, anti-laundering
- `build-pipeline.test.ts` — context assembly end-to-end
- `check-pipeline.test.ts` — full check gate: drift, validation, coverage, completeness
- `context-pipeline.test.ts` — context package generation
- `drift-pipeline.test.ts` — drift detection across file changes
- `flow-support.test.ts` — flow participant resolution and aspect propagation
- `validation-pipeline.test.ts` — structural error detection

### E2E tests (`tests/e2e/`)

Subprocess-based tests that spawn the compiled `dist/bin.js` binary and assert on stdout/stderr/exit code. Validates the CLI as a black box from the user's perspective.

### Fixtures (`tests/fixtures/`)

Sample Yggdrasil projects used as test inputs:

- `sample-project/` — canonical healthy project used across most tests
- `sample-project-broken-relation/`, `sample-project-orphan-dir/` — invalid state fixtures for error-path tests
- `drift-multi-file/`, `tmp-*` — scenario-specific fixtures for drift and config tests

## Out of scope

- Application source code — the tests consume `src/` but do not own it
- Test configuration (`vitest.config.ts`) — that belongs to `cli/config`
- Coverage thresholds enforcement — defined in `vitest.config.ts`
