# Drift Detector Interface

## `detectDrift(graph, filterNodePath?): Promise<DriftReport>`

Checks each mapped non-blackbox node for drift. When `filterNodePath` is set, checks only that node and its descendants.

Returns `DriftReport` with per-node entries (status, changedFiles with source/graph category), and aggregate counts: totalChecked, okCount, sourceDriftCount, graphDriftCount, fullDriftCount, missingCount, unmaterializedCount.

Status values: `ok` | `source-drift` | `graph-drift` | `full-drift` | `missing` | `unmaterialized`.

## `syncDriftState(graph, nodePath): Promise<SyncResult>`

Writes a new baseline for a node. Returns `{ previousHash?, currentHash, sourceOnlyChange }`. The `sourceOnlyChange` flag signals W018 when source files changed but no graph artifacts changed since last sync.

## Failure Modes

- `detectDrift`: never throws. Missing drift state or hash errors produce `missing`/`unmaterialized` status.
- `syncDriftState`: throws if node does not exist, has no mapping, or is blackbox.
