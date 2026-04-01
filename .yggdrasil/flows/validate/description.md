# Validate Flow

## Business context

CLI validation of graph structural integrity and completeness. Agents and CI use this to ensure the semantic memory graph is valid before build-context or merge.

## Trigger

User runs `yg check`.

## Goal

Report structural errors (E001–E017) and completeness warnings (W001–W011) to stdout; exit 1 if any errors.

## Participants

- `cli/commands/check` — orchestrates loadGraph, validate, detectDrift; outputs errors/warnings
- `cli/core/loader` — loads graph from `.yggdrasil/` (tolerates invalid config for partial validation)
- `cli/core/validator` — structural checks, context budget

## Paths

### Happy path

Graph loads; validator runs all checks. Output: list of issues (errors first, then warnings); summary "X errors, Y warnings". Exit 0 if no errors (warnings allowed).

### Config parse error

`yg-config.yaml` fails to parse. Loader sets `configError`; validator reports E012. Validation continues for other checks where possible. Exit 1.

## Invariants across all paths

- Read-only: validation never modifies the graph.
- Same check order: config-dependent first, then structure checks.
