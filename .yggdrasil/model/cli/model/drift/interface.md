# Drift Types Interface

Type library — exports TypeScript interfaces and type aliases only.

## LLM Verification

- **AspectVerificationResult** — Cached result: satisfied (boolean), reason.
- **ArtifactReviewResult** — Cached result: current (boolean), reason.

## Drift Detection

- **DriftCategory** — `'source' | 'graph'`
- **TrackedFileLayer** — `'own' | 'hierarchy' | 'aspects' | 'relational' | 'flows' | 'source'` — indicates which context layer tracks the file.
- **DriftFileChange** — Per-file change: filePath, category.
- **DriftStatus** — `'ok' | 'source-drift' | 'graph-drift' | 'full-drift' | 'missing' | 'unmaterialized'`
- **DriftEntry** — Per-node result: nodePath, status, changedFiles, details.
- **DriftReport** — Full scan result: entries, counts by status.

## Drift State (persistence)

- **DriftNodeState** — Stored per node: hash, files (path→SHA-256), mtimes, reviewedReason, aspectResults cache, artifactReview cache.
- **DriftState** — Record mapping node paths to DriftNodeState.

## Approval

- **ApproveResult** — Result of approveNode(): action, hashes, refuse details, axis states, changed/unchanged files, blackbox/anti-laundering flags, LLM results, skip reason, E055/E056 violations.
- **AnnotatedChange** — Upstream change: filePath, annotation.

## Audit

- **AuditEntry** — Append-only log entry: ts, node, action, prev, hash, reason, files.

## Failure Modes

Type library — no runtime errors.
