# Drift Detector Internals

## Decisions

Chose bidirectional drift detection (source vs graph as separate categories) over a single "changed" status. Different directions require different resolution strategies: source-drift means "update graph to match code," graph-drift means "review if code needs updating."

Chose per-file hashing alongside the canonical hash. The canonical hash (SHA-256 of sorted path:hash pairs) determines whether drift exists; per-file hashes enable granular reporting of exactly which files changed. Rejected: single canonical hash only — loses the ability to identify which specific files changed, making diagnostics require manual investigation.

Chose child-wins model for parent/child overlap: `getChildMappingExclusions` excludes descendant-mapped paths from parent hashing to prevent a single file change from triggering drift on both parent and child. Rejected: parent-wins — child file changes would trigger drift on the parent as well, making parent approval noisy and forcing parent re-approval on every child-owned file change.
