# Approve Command Responsibility

**In scope:** `yg approve`. Records that a node's source and graph artifacts are consistent — the semantic verification gate in the post-modify workflow.

Orchestrates three concerns: the three-axis change detection gate, LLM-powered reviewer verification (E055/E056), and batch approval for cascade drift. Batch mode (`--aspect`, `--flow`, or parent node without mapping) finds all E021 cascade nodes caused by the specified entity and approves them in parallel.

The `--reviewed "reason"` flag bypasses only the three-axis gate — the LLM reviewer still runs. This is intentional: `--reviewed` means "I verified manually that the unchanged side doesn't need updating" but does NOT mean "skip aspect verification."

Also registered as `yg drift-sync` (deprecated alias, single-node only).
