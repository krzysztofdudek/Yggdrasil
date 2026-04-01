# Test Fixtures — Responsibility

Sample Yggdrasil projects used as test inputs across unit, integration, and e2e test layers.

## Scope

- `sample-project/` — canonical healthy project used across most tests
- `sample-project-broken-relation/` — invalid state fixture for relation-error-path tests
- `sample-project-orphan-dir/` — invalid state fixture for orphan-directory error tests
- `drift-multi-file/` — scenario-specific fixture for multi-file drift tests
- `tmp-*` — temporary fixtures created at test runtime for scenario-specific config tests

## Out of scope

- Test logic itself — belongs to `cli/tests/unit`, `cli/tests/integration`, or `cli/tests/e2e`
- Production source code or build outputs
