# Build Context Flow

## Business context

Assemble a context package for a node — the exact specification an agent reads before working on that node. Used by `yg build-context` and by agents during preflight.

## Trigger

User runs `yg build-context --node <path>`.

## Goal

Output plain text with XML-like tags to stdout: assembled context (global, hierarchy, own, aspects, relational) plus token count and budget status.

## Participants

- `cli/commands/validation` — orchestrates loadGraph, validate, buildContext, formatContextText
- `cli/core/loader` — loads graph from `.yggdrasil/`
- `cli/core/validator` — structural checks; build-context blocks if any errors
- `cli/core/context` — 5-step layer assembly (global, hierarchy, own, aspects, relational); relational merges structural dependencies and flows into one section; aspects include flow.aspects for participating flows
- `cli/formatters` — formats context package as plain text with XML-like tags

## Paths

### Happy path

Graph loads; validation passes (no errors). Context builder assembles layers; formatter outputs plain text with XML-like tags. Token count and budget status appended.

### Validation errors block

Graph has structural errors (E001–E017). Build-context does not run; user must fix errors first. Output: validation failure message.

### Node not found

User passes `--node <path>` but node does not exist. Operation error; no context assembled.

## Invariants across all paths

- Read-only: build-context never modifies the graph.
- Deterministic: same node + same graph → same output.
