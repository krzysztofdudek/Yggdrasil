# Drift Detector Interface

**Checking for drift:** Use `detectDrift` to scan all mapped nodes (or a subtree with `filterNodePath`). Returns a DriftReport where each node has a status: `ok` (nothing changed), `source-drift` (update artifacts), `graph-drift` (review source), `full-drift` (both changed — coordinated review needed), `missing` (files gone), `unmaterialized` (new node, never approved). The status tells the agent what to do next.

**Recording baseline after approval:** Use `syncDriftState` after a successful approve. Returns `sourceOnlyChange` flag — when true, source changed but graph artifacts didn't, which may indicate drift that was missed.

## Failure Modes

- `detectDrift`: never throws. Missing state produces `missing`/`unmaterialized` status.
- `syncDriftState`: throws if node doesn't exist, has no mapping, or is blackbox.
