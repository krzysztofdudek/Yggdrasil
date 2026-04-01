# Graph Analysis Flow

## Business context

Agent needs to understand the broader impact of changes, inspect cross-cutting requirements, or assemble implementation context. These are analytical queries that answer "what would be affected?", "what are the cross-cutting rules?", and "what does an agent need to know?"

## Trigger

User runs `yg impact`, `yg aspects`, or `yg build-context`.

## Goal

Deliver deterministic analytical views: blast radius, aspect inventory, assembled context packages.

## Participants

- `cli/commands/impact` — blast radius analysis across three modes (node, aspect, flow)
- `cli/commands/aspects` — list aspects with metadata in YAML format
- `cli/commands/build-context` — assemble and output context package for a node
- `cli/core/loader` — loads graph
- `cli/core/context` — 5-layer context assembly, ancestor collection, effective aspect computation
- `cli/core/dependency-resolver` — forward dependency tree for impact analysis
- `cli/formatters` — context package text formatting

## Paths

### Happy path (impact)

Graph loads; reverse dependencies, transitive chains, descendants, co-aspect nodes computed. Output: structured impact report.

### Happy path (build-context)

Graph loads; validation passes; context assembled from 5 layers; formatted as plain text. Token budget checked.

### Validation blocks build-context

Graph has structural errors. Build-context refuses to run — user must fix errors first.

## Invariants across all paths

- Read-only: analysis never modifies the graph.
- Deterministic: same graph state → same output (flow aspect enforces this).
