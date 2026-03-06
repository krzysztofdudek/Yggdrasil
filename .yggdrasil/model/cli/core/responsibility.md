# Core Responsibility

Pure domain logic layer — graph operations independent of CLI presentation. Implements the deterministic algorithms specified in docs/concept/engine.md and docs/concept/tools.md.

## Boundary

Core has no dependency on Commander, process.exit, stdout, or stderr. It receives typed inputs and returns typed outputs. On error, core functions throw — callers (commands) are responsible for catching exceptions and presenting them to the user.

## Components

| Sub-node | Exports | Role |
| -------- | ------- | ---- |
| cli/core/loader | `loadGraph`, `loadGraphFromRef` | Scan model/, aspects/, flows/, schemas/ to build the in-memory graph. Git archive for ref-based loading. Consumes cli/io, cli/model, cli/utils. |
| cli/core/context | `buildContext` | 5-step layer assembly: global, hierarchy, own, aspects, relational. Produces the deterministic context package for a node. Consumes cli/model, cli/utils. |
| cli/core/validator | `validate` | Structural checks (E001-E019, W001-W014). Scope filtering, context budget enforcement, anchor validation. Consumes cli/core/context, cli/model, cli/utils. |
| cli/core/drift-detector | `detectDrift`, `syncDriftState` | Hash comparison vs .drift-state. Reports per-file status: ok, drift, missing, unmaterialized. Consumes cli/io, cli/model, cli/utils. |
| cli/core/dependency-resolver | `resolveDeps`, `findChangedNodes`, `buildDependencyTree`, `formatDependencyTree`, `collectTransitiveDeps` | Topological sort of structural relations, git diff integration, tree output. Consumes cli/model only. |

## Shared core contract (all children)

- **Deterministic:** same inputs produce same outputs. No randomness, no implicit system state.
- **Graph-first:** structural validation enforces graph integrity before materialization; graph is intended truth.
- **Context reproducibility:** assembled context must suffice to reconstruct source behavior without reading raw code.
- **Read-only graph writes:** core does not create or edit model nodes, artifacts, aspects, or flows.

**Reference:** docs/concept/foundation.md (Division of labor), aspects/deterministic.

## Out of scope

- YAML parsing and file I/O (cli/io)
- Output formatting (cli/formatters)
- Type definitions (cli/model)
- CLI argument handling and error presentation (cli/commands)
