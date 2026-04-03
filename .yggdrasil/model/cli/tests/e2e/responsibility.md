# E2E Tests — Responsibility

Subprocess-based tests that spawn the compiled `dist/bin.js` binary and assert on stdout, stderr, and exit code. Validates the CLI as a black box from the user's perspective.

## Scope

- Spawn `dist/bin.js` as a child process for each test scenario
- Assert on observable outputs: stdout content, stderr content, exit codes
- Cover user-facing command behavior that cannot be verified through unit or integration tests
- Test `yg init` creates all expected files including yg-architecture.yaml with sensible defaults (module, service, library, infrastructure, data node types)
- Test `yg init --upgrade` creates missing yg-architecture.yaml file when upgrading old projects

## Out of scope

- Internal module behavior — belongs to `cli/tests/unit`
- Multi-layer pipeline behavior (without binary boundary) — belongs to `cli/tests/integration`
- Test input data and sample projects — belongs to `cli/tests/fixtures`
