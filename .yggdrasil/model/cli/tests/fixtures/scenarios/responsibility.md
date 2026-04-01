# Scenario Fixtures — Responsibility

Error-state and scenario-specific fixtures used for targeted test coverage of edge cases, invalid states, and configuration variations.

## Scope

- `sample-project-broken-relation/` — fixture with an invalid relation reference; used for relation-error-path tests
- `sample-project-orphan-dir/` — fixture with an orphan directory; used for orphan-detection error tests
- `drift-multi-file/` — fixture for multi-file drift detection scenarios
- `tmp-config-dup-cat/` — fixture for duplicate category configuration edge case
- `tmp-config-kc-skip/` — fixture for knowledge-category skip configuration
- `tmp-config-no-kc/` — fixture for missing knowledge-category configuration
- `tmp-flow-knowledge/` — fixture for flow knowledge configuration scenarios

## Out of scope

- The canonical healthy project fixture — belongs to `cli/tests/fixtures/sample-project`
- Test logic — belongs to the test layer nodes
