# Drift Flow

## Business context

Detect and sync divergence between the graph and mapped source files. Drift means code changed but graph artifacts were not updated. Used by agents during session start via `yg check` and explicitly via `yg drift-sync`.

## Trigger

User runs `yg check` (for drift detection) or `yg drift-sync --node <path>` (to update baseline).

## Goal

**Check:** Report drift state per node (ok, drift, missing, unmaterialized) as part of unified output. **Drift-sync:** Update `.yggdrasil/.drift-state` with current file hashes for the specified node.

## Participants

- `cli/commands/check` — orchestrates loadGraph, detectDrift; reports drift as part of unified check output
- `cli/core/loader` — loads graph (mappings for hash resolution)
- `cli/core/drift-detector` — computes hashes, compares to baseline; consumes cli/io for readDriftState, writeDriftState

## Paths

### Happy path (check — drift detection)

Graph loads; drift-detector hashes mapped files, compares to `.drift-state`. Output: per-node drift state included in unified check report. No writes.

### Happy path (drift-sync)

Graph loads; user specified `--node <path>`. Drift-detector computes current hash, writes to `.drift-state`. Output: confirmation.

### Node not found

User passes `--node <path>` for drift-sync but node does not exist. Operation error; no sync.

### Unmaterialized node

Node has no mapping; drift-sync is a no-op (nothing to hash). State remains unmaterialized.

## Invariants across all paths

- Check: read-only; never modifies graph or .drift-state.
- Drift-sync: writes only `.yggdrasil/.drift-state`; never modifies graph artifacts or source files.
