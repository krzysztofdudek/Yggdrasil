# Approve Responsibility

Deterministic three-axis change detection for node approval. Compares own artifacts, source files, and upstream context — both artifacts AND source must change together, or a `--reviewed` reason must explain why only one side changed.

Blackbox nodes are sealed: any source file change unconditionally refuses approval — `--reviewed` cannot override this. Anti-laundering prevents hiding already-tracked files under a new blackbox on first approve.

Records baseline to drift state, appends audit trail, and garbage-collects orphaned drift entries. Does not know about LLM verification — semantic review (E055/E056) is orchestrated by the calling CLI layer.
