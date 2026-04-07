# Approve Core Interface

## Exports

### `approveNode(graph, nodePath, options?): Promise<ApproveResult>`

Records a new drift baseline for a node after reviewing its current state.

**Parameters:**

- `graph: Graph` — loaded in-memory graph (from `cli/core/loader`)
- `nodePath: string` — node path relative to `model/` (e.g., `cli/commands/approve`)
- `options.acknowledge?: string` — non-empty reason string for a conscious exception (approves without both source and artifacts changing)

**Returns:** `ApproveResult` with:

- `action: 'approved' | 'acknowledged' | 'initial' | 'no-change' | 'refused'`
- `previousHash?: string` — baseline hash before this approval (undefined on first approve)
- `currentHash: string` — hash after this approval (empty string if refused with no state read)
- `axes?: { ownArtifacts, source, otherTracked }` — each `'changed' | 'unchanged'`
- `changedOwnArtifacts?: string[]` — artifact file paths that changed
- `changedSource?: string[]` — source file paths that changed
- `changedOther?: AnnotatedChange[]` — upstream file paths with annotation label
- `unchangedArtifactNames?: string[]` — artifact filenames that did not change (returned when source changed but artifacts did not)
- `unchangedSourceFiles?: string[]` — source file paths that did not change (returned when artifacts changed but source did not)
- `refuseReason?: string` — human-readable reason for refusal
- `blackboxBlocked: boolean` — true when refused due to blackbox source change
- `antiLaunderingBlocked: boolean` — true when refused due to anti-laundering check on first approve
- `acknowledgeAttempted: boolean` — true when `--acknowledge` was provided
- `isBlackbox: boolean` — whether the node is a blackbox
- `gcPaths: string[]` — orphaned drift state entries removed during this run
- `conflictingFiles?: string[]` — files that triggered anti-laundering refusal

## Failure modes

- **Throws** `'--acknowledge requires a non-empty reason string.'` when `acknowledge` is empty string
- **Throws** `'Node '<path>' does not exist.'` when the node is not in the graph
- **Throws** `'Node '<path>' has no mapping.'` when the node has no `mapping.paths`
- Returns `action: 'refused'` with `antiLaunderingBlocked: true` and `conflictingFiles` when first-approving a blackbox whose files appear in other nodes' drift state
- Returns `action: 'refused'` with `blackboxBlocked: true` when source files changed on a blackbox node (not recoverable with `--acknowledge`)

## LLM verification

When `llmProvider` is supplied and not skipped, runs:

1. **Claim verification (E055)** — checks each aspect claim against source files
2. **Artifact review (E056)** — checks if responsibility/interface/internals are current

LLM is skipped (with reason) when: no provider configured (`'not-configured'`), provider unreachable (`'unavailable'`), `--acknowledge` used (`'acknowledge'`), or blackbox node (`'blackbox'`).

**Returns** (LLM fields on `ApproveResult`):

- `llmSkipped?: 'not-configured' | 'unavailable' | 'acknowledge' | 'blackbox'` — why LLM verification was skipped
- `claimResults?: Record<aspectId, Record<claimId, ClaimVerificationResult>>` — per-claim results
- `artifactReviewResults?: Record<artifactName, ArtifactReviewResult>` — per-artifact freshness
- `e055Violations?: Array<{ aspect, claim, reason }>` — claims not satisfied
- `e056Violations?: Array<{ name, reason }>` — stale artifacts

## `ApproveOptions`

```typescript
interface ApproveOptions {
  acknowledge?: string;    // conscious exception reason — must be non-empty if provided
  llmProvider?: LlmProvider; // for semantic verification (E055/E056)
  llmNotConfigured?: boolean; // true = no llm section in config (vs provider unreachable)
  maxTokens?: number;      // resolved from config or queried from provider
  consensus?: number;      // vote count for claim verification (default: 1)
  verifyArtifacts?: boolean; // run artifact review E056 (default: false)
}
```
