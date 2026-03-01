# Docs/Idea — Responsibility

This node represents the complete logical specification of Yggdrasil: the conceptual model, algorithms, data structures, and integration contracts that define what Yggdrasil is and how it must behave.

## Responsible for

- Defining the logical foundation: what the graph is, what it stores, and why (`foundation.md`)
- Specifying the graph structure: nodes, aspects, flows, and their relations (`graph.md`)
- Describing the context assembly algorithm in full, deterministic detail (`engine.md`)
- Specifying all CLI tool contracts: inputs, outputs, semantics (`tools.md`)
- Defining materialization behavior: how graph artifacts map to source files (`materialization.md`)
- Describing integration contracts: how agents and external tools interact with the graph (`integration.md`)

## Not responsible for

- Making the content approachable for first-time adopters — that is `docs/`'s concern
- Providing tutorials or getting-started guidance
- Omitting edge cases or simplifying for readability

## Quality bar

The primary quality bar is **logical completeness and correctness**. Every rule, algorithm, and contract must be fully specified so that an implementor can build a correct implementation from this specification alone, without consulting code.

Adoption-friendliness is explicitly **not** a goal here. If a section is difficult to read but logically precise, that is acceptable. If a section is easy to read but omits an edge case, that is a defect.

The `docs/idea/` specification is the source of truth. The CLI implementation (`source/cli/`) must conform to it. When they diverge, the specification wins unless a deliberate decision has been made to update it.
