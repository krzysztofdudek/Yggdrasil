# Approve Command Interface

**Command:** `yg approve --node <path...> | --aspect <id> | --flow <name>` (mutually exclusive, one required).

**--node:** One or more node paths. Single node: direct approve. Multiple nodes (`--node <paths...>`): triggers batch approve — same path as `--aspect`/`--flow` batch. Parent node without mapping: auto-expands to children (cascade batch via artifact prefix).

**--aspect / --flow:** Batch approves all E021 cascade nodes caused by changes in the specified aspect or flow.

**--reviewed "reason":** Bypasses three-axis gate only. Reviewer still verifies aspects (E055) and artifacts (E056).

**Output:** Per-node result with hash transition and reviewer summary. Batch mode shows per-node lines plus summary counts. Exit 0 if all approved/reviewed, exit 1 if any refused.

**Initial baseline (first-time approve):** When a node has no prior drift state, approve records the current hashes as the baseline without requiring artifact or source changes. This is the expected path when setting up coverage on existing code.

**No-change path:** When source and artifacts are both unchanged since last approve, approve exits 0 without invoking the reviewer.

## Failure Modes

- No .yggdrasil/ directory: ENOENT, exit 1.
- No mode flag or multiple flags: exit 1.
- Node not found: exit 1.
- Three-axis refusal: detailed guidance per case (source-only, graph-only, cascade, blackbox).
- Reviewer refusal (E055/E056): aspect violations and stale artifacts listed.
- Anti-laundering failure: approve refuses when a blackbox node's first-time approve finds its files already tracked in drift state of other nodes. This prevents retroactively creating a blackbox over previously tracked files.
- Cloud provider notice: when a non-ollama reviewer is configured, a cloud API privacy notice is shown before the first reviewer call in the session.
