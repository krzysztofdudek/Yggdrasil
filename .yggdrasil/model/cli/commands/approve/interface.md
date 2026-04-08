# Approve Command Interface

**Command:** `yg approve --node <path...> | --aspect <id> | --flow <name>` (mutually exclusive, one required).

**--node:** One or more node paths. Single node: direct approve. Multiple: batch. Parent node without mapping: auto-expands to children.

**--aspect / --flow:** Batch approves all E021 cascade nodes caused by changes in the specified aspect or flow.

**--reviewed "reason":** Bypasses three-axis gate only. Reviewer still verifies aspects (E055) and artifacts (E056).

**Output:** Per-node result with hash transition and reviewer summary. Batch mode shows per-node lines plus summary counts. Exit 0 if all approved/reviewed, exit 1 if any refused.

## Failure Modes

- No .yggdrasil/ directory: ENOENT, exit 1.
- No mode flag or multiple flags: exit 1.
- Node not found: exit 1.
- Three-axis refusal: detailed guidance per case (source-only, graph-only, cascade, blackbox).
- Reviewer refusal (E055/E056): aspect violations and stale artifacts listed.
