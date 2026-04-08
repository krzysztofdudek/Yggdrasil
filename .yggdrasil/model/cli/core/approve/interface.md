# Approve Interface

**`approveNode(graph, nodePath, options?): Promise<ApproveResult>`** — records a new drift baseline after verifying a node's state through two gates:

1. **Three-axis gate:** Compares own artifacts, source files, and upstream context. Both artifacts AND source must change together — unilateral changes are refused with guidance. `--reviewed` bypasses this gate only.
2. **Reviewer gate (when LLM configured):** Verifies aspects (E055) against source code and optionally reviews artifact freshness (E056). This gate cannot be bypassed.

**`ApproveResult.action`** values: `'approved'` (both gates pass), `'reviewed'` (three-axis bypassed, reviewer passed), `'initial'` (first approve for node), `'no-change'` (baseline already current), `'refused'` (gate failed — check `axes`, `e055Violations`, `e056Violations`, `blackboxBlocked` for reason).

**`options.verifyAspects`** (default true) and **`options.verifyArtifacts`** (default false) control which reviewer checks run.

## Failure Modes

- Throws on: empty reviewed reason, non-existent node, node without mapping.
- Returns refused (not throw): blackbox source changes, anti-laundering violations, gate failures.
