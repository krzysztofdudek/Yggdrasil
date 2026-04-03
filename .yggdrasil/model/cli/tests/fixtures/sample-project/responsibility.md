# Sample Project Fixture — Responsibility

The canonical healthy Yggdrasil project fixture. Serves as the primary test input for the majority of unit, integration, and e2e tests. Represents a well-formed, fully valid graph state.

## Scope

A complete `.yggdrasil/` graph — nodes, aspects, flows, relations, drift state — representing a reference project with realistic structure and content. Tests that need a "valid project" start here.

Includes `yg-architecture.yaml` with node type definitions (module, service, repository) to support tests of effective aspect computation and architecture-based constraints.

## Out of scope

- Error-state and scenario-specific fixtures — belong to `cli/tests/fixtures/scenarios`
- Test logic that uses this fixture — belongs to the test layer nodes (`cli/tests/unit`, `cli/tests/integration`, `cli/tests/e2e`)
