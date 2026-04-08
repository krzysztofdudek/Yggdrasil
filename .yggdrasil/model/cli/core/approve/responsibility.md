# Approve Responsibility

Deterministic three-axis change detection for node approval. Five scenarios:

1. Both artifacts AND source changed → accepts (normal post-modify)
2. Only source changed, artifacts unchanged → refuses (update artifacts first)
3. Only artifacts changed, source unchanged → refuses (implement the changes)
4. Only upstream context changed, own artifacts and source unchanged → refuses (review compliance)
5. Nothing changed → no-change (baseline already current, no approval needed)

`--reviewed "reason"` bypasses scenarios 2-4 with an audit trail. Blackbox nodes are sealed — source changes unconditionally refuse, `--reviewed` cannot override. Anti-laundering prevents hiding tracked files under a new blackbox.

Records baseline to drift state, appends audit trail, garbage-collects orphaned drift entries. Does not know about LLM verification — semantic review is orchestrated by the CLI layer.
