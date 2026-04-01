# Approve Core Interface

## Exports

### `approveNode(graph, nodePath, options?): Promise<ApproveResult>`

Records a new drift baseline for a node after reviewing its current state.

**Parameters:**

- `graph: Graph` — loaded in-memory graph (from `cli/core/loader`)
- `nodePath: string` — node path relative to `model/` (e.g., `cli/commands/approve`)
- `options.acknowledge?: string` — non-empty reason string for a conscious exception (approves without bilateral changes)

**Returns:** `ApproveResult` with:

- `action: 'approved' | 'acknowledged' | 'initial' | 'no-change' | 'refused'`
- `previousHash?: string` — baseline hash before this approval (undefined on first approve)
- `currentHash: string` — hash after this approval (empty string if refused with no state read)
- `axes?: { ownArtifacts, source, otherTracked }` — each `'changed' | 'unchanged'`
- `changedOwnArtifacts?: string[]` — artifact file paths that changed
- `changedSource?: string[]` — source file paths that changed
- `changedOther?: AnnotatedChange[]` — upstream file paths with annotation label
- `unchangedArtifactNames?: string[]` — artifact filenames that did not change (for error display)
- `unchangedSourceFiles?: string[]` — source file paths that did not change (for error display)
- `refuseReason?: string` — human-readable reason for refusal
- `blackboxBlocked: boolean` — true when refused due to blackbox source change
- `antiLaunderingBlocked: boolean` — true when refused due to anti-laundering check on first approve
- `acknowledgeAttempted: boolean` — true when `--acknowledge` was provided
- `isBlackbox: boolean` — whether the node is a blackbox
- `gcPaths: string[]` — orphaned drift state entries removed during this run

## Failure modes

- **Throws** `'--acknowledge requires a non-empty reason string.'` when `acknowledge` is empty string
- **Throws** `'Node '<path>' does not exist.'` when the node is not in the graph
- **Throws** `'Node '<path>' has no mapping.'` when the node has no `mapping.paths`
- Returns `action: 'refused'` with `antiLaunderingBlocked: true` when first-approving a blackbox whose files appear in other nodes' drift state
- Returns `action: 'refused'` with `blackboxBlocked: true` when source files changed on a blackbox node (not recoverable with `--acknowledge`)

## `ApproveOptions`

```typescript
interface ApproveOptions {
  acknowledge?: string; // conscious exception reason — must be non-empty if provided
}
```
