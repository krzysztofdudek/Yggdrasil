# Approve Responsibility

Three-axis change detection and LLM reviewer verification for node approval. Determines whether a node's graph artifacts and source code have been updated together, then optionally runs semantic verification (aspect compliance, artifact freshness) via an LLM reviewer.

Blackbox nodes are sealed: any source file change unconditionally refuses approval — `--reviewed` cannot override this. The only path forward is decomposing into a proper node. Anti-laundering prevents hiding already-tracked files under a new blackbox on first approve.

The `--reviewed` flag bypasses the three-axis structural gate only. The LLM reviewer still runs and can independently refuse if aspects are unmet (E055) or artifacts are stale (E056). This two-gate design prevents agents from rubber-stamping semantic failures.
