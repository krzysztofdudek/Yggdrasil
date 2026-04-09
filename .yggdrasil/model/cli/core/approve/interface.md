# Approve Interface

## `approveNode(graph, nodePath, options?): Promise<ApproveResult>`

Three-axis change detection and baseline recording. Call this after verifying artifacts are current — it records the current state so future drift detection has a baseline to compare against.

`options.reviewed` — provide a reason string to bypass the three-axis gate when only one side changed and the other genuinely does not need updating. The reviewer still runs even with `--reviewed`.

## Acting on `ApproveResult`

The result is discriminated by `action`. Consumers branch on this field:

- `'approved'` / `'reviewed'` / `'initial'` — the node was accepted and the baseline was recorded. Consumers can proceed. The `gcPaths` field lists old baseline files that can be garbage-collected.
- `'no-change'` — baseline already matches current state. Nothing to do.
- `'refused'` — the gate rejected the approval. Consumers must report why and guide the agent to fix the imbalance before retrying. The `refuseReason` string contains the human-readable explanation. The `axes` object (ownArtifacts / source / otherTracked each as `'changed'` or `'unchanged'`) shows exactly which sides are out of balance. `blackboxBlocked` and `antiLaunderingBlocked` flags indicate structural violations that require node restructuring, not just artifact updates.

## Exported Helpers

`resolveAspects` and `loadSourceFiles` are used by the reviewer subprocess to evaluate aspect satisfaction. They are not part of the approve command's own contract — consumers of `approveNode` do not call them directly.

## Failure Modes

- Throws on: empty reviewed reason, non-existent node, node without mapping.
- Returns `'refused'` (not throw): blackbox modification, anti-laundering, unilateral changes.
