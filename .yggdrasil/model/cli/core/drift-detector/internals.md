# Drift Detector Internals

## Decisions

Chose bidirectional drift detection (source vs graph as separate categories) over a single "changed" status. Different directions require different resolution strategies: source-drift means "update graph to match code," graph-drift means "review if code needs updating."

Chose per-file hashing alongside the canonical hash. The canonical hash (SHA-256 of sorted path:hash pairs) determines whether drift exists; per-file hashes enable granular reporting of exactly which files changed. Without per-file tracking, the system could only report "something changed."

Chose child-wins model for parent/child overlap: `getChildMappingExclusions` excludes descendant-mapped paths from parent hashing to prevent a single file change from triggering drift on both parent and child.

Chose mtime-based hash caching — stored file data (hashes + mtimes) allows skipping re-hash for files whose mtime hasn't changed. Significant performance win on large mappings.
