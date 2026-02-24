# Core Responsibility

Graph logic module — loading, context building, validation, drift detection, dependency resolution. Implements deterministic algorithms from docs/idea/engine.md and docs/idea/tools.md.

**Shared core contract (all children):**

- **Deterministic:** same inputs → same outputs. No randomness, no implicit system state. Tag: `deterministic`.
- **Graph-first:** structural validation enforces graph integrity before materialization; graph is intended truth (invariants/002).
- **Context reproducibility:** assembled context must suffice to reconstruct source behavior without reading raw code (invariants/001).
- **Read-only graph writes:** CLI does not create or edit model nodes, artifacts, aspects, flows, knowledge (decisions/001).

**Reference:** docs/idea/foundation.md (Division of labor), aspects/determinism.

**Flows:** loader, validator, context, drift-detector participate in build-context, validate, drift flows (see .yggdrasil/flows/).

**Sub-nodes:**

- **cli/core/loader**: `loadGraph`, `loadGraphFromRef` — scan model/, aspects/, flows/, knowledge/, templates/; git archive for ref-based loading. Consumes cli/io, cli/model, cli/utils.
- **cli/core/context**: `buildContext` — 10-step layer assembly (global, knowledge, hierarchy, own, relational, aspects, flows). Consumes cli/model, cli/utils.
- **cli/core/validator**: `validate` — structural checks (E001–E017, W001–W009); scope filtering; context budget; stale knowledge. Consumes cli/core/context, cli/model, cli/utils.
- **cli/core/drift-detector**: `detectDrift`, `syncDriftState` — hash comparison vs .drift-state; states ok|drift|missing|unmaterialized. Consumes cli/io, cli/model, cli/utils.
- **cli/core/dependency-resolver**: `resolveDeps`, `findChangedNodes`, `buildDependencyTree`, `formatDependencyTree`, `collectTransitiveDeps` — topological sort, git diff, tree output. Consumes cli/model only.

**Out of scope:**

- YAML parsing (cli/io)
- Output formatting (cli/formatters)
- Type definitions (cli/model)
