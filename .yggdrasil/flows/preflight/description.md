# Preflight Diagnostics Flow

## Business context

Every agent session begins with a health check. The preflight command provides a single unified diagnostic that covers all dimensions: drift state, graph status, and validation. This replaces running multiple separate commands and gives agents a single pass/fail signal.

## Trigger

Agent starts a session and runs `yg preflight` (mandated by agent-rules as the first action).

## Goal

Single unified diagnostic report: drift status + graph metrics + validation results. Exit 1 if any dimension requires attention.

## Participants

- `cli/commands/preflight` — orchestrates all checks and formats unified report
- `cli/core/loader` — loads graph from `.yggdrasil/`
- `cli/core/validator` — runs structural and completeness checks
- `cli/core/drift-detector` — detects source/graph drift

## Paths

### Happy path

Graph loads; no drift; validation clean. Output: all sections show "clean". Exit 0.

### Issues found

One or more dimensions have issues: drift detected, validation errors. Output: unified report with details per section. Exit 1.

### Warnings only

Validation has warnings but no errors; no drift. Output: warnings listed. Exit 0 (warnings alone don't trigger failure).

## Invariants across all paths

- Read-only: preflight never modifies graph or drift state.
- Comprehensive: always runs all checks regardless of individual results.
- Actionable: exit code tells agent whether to proceed (0) or address issues first (1).
