# Approve Interface

**`approveNode(graph, nodePath, options?): Promise<ApproveResult>`** — three-axis change detection + baseline recording. No LLM calls.

`options.reviewed?: string` — bypasses three-axis gate with a reason.

**`ApproveResult.action`** values: `'approved'`, `'reviewed'`, `'initial'`, `'no-change'`, `'refused'`.

**Exported helpers for CLI layer:**

- `resolveAspects(node, graph)` — computes effective aspects with content paths for LLM verification.
- `loadSourceFiles(filePaths, projectRoot)` — reads source files from disk, skipping unreadable ones.

## Failure Modes

- Throws on: empty reviewed reason, non-existent node, node without mapping.
- Returns `'refused'` (not throw): blackbox source changes, anti-laundering violations, unilateral changes.
