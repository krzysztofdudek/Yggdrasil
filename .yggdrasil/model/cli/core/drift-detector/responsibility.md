# Drift Detector Responsibility

Answers "has this node changed since last approve?" by comparing current file state against stored baselines. Scopes exclusively to proper nodes — blackbox nodes are silently skipped in detection and rejected with an error in sync. `detectDrift` is read-only — it never modifies state, which makes it safe to run at any time without side effects. `syncDriftState` writes the baseline after approval. Separation is deliberate: detection reports the situation, sync records the decision.

Categorizes drift into six statuses: `ok` (no changes), `source-drift` (source files changed, graph artifacts unchanged), `graph-drift` (graph artifacts changed, source files unchanged), `full-drift` (both sides changed), `missing` (all mapped source paths are gone), and `unmaterialized` (no drift state recorded and files do not exist). Each status implies a different resolution — source-drift means the graph needs updating; graph-drift means source should be reviewed; full-drift means both sides changed and require coordinated review; missing means a previously approved node lost all its source files; unmaterialized means a new node with no drift state or files yet.

Implements a child-wins model for parent/child node overlap: when a file is mapped to both a parent and a descendant node, it is attributed to the child only. This prevents a single file change from appearing as drift in both nodes simultaneously.

Not responsible for writing drift state after approval — that is `syncDriftState`. Detection and sync are separate exports intentionally.
