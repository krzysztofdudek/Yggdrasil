# CLI Tests Responsibility

Automated test suite for the `@chrisdudek/yg` CLI package using Vitest.

## Test layers

### Unit tests (`tests/unit/`)

Pure function tests with no filesystem side effects. All I/O mocked or stubbed. Mirrors the `src/` directory structure.

### Integration tests (`tests/integration/`)

Pipeline tests exercising multiple layers together using real temp-copy fixture projects. Covers approve, check, context, drift, flow, and validation pipelines end-to-end.

### E2E tests (`tests/e2e/`)

Subprocess-based tests spawning the compiled `dist/bin.js` binary, asserting on stdout/stderr/exit code. Validates the CLI as a black box.

### Fixtures (`tests/fixtures/`)

Sample Yggdrasil projects used as test inputs — canonical healthy projects, invalid-state fixtures for error paths, and scenario-specific fixtures for drift and config tests.

## Out of scope

- Application source code — the tests consume `src/` but do not own it
- Test configuration (`vitest.config.ts`) — belongs to `cli/config`
