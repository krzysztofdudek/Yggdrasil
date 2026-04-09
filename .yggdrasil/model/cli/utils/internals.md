# Utils Internals

## Decisions

- **Hierarchical gitignore over root-only.** Rejected: root-only gitignore — loses precision in monorepos where subdirectories have their own ignores.

- **SHA-256 over weaker hashes.** Rejected: MD5/CRC32 — not collision-resistant enough for file integrity in drift detection.

- **Fixed heuristic (~4 chars/token) over tiktoken.** Rejected: model-specific tokenizer — adds a dependency for marginal accuracy. Budget thresholds are warnings, not hard limits.

- **getLastCommitTimestamp returns null over throwing.** Rejected: throwing — callers need graceful degradation in non-git environments.

- **Mtime-based hash caching in hashTrackedFiles.** Reuses stored hashes when file mtime hasn't changed. Rejected: always re-hash — too slow for large mappings in the common case where most files haven't changed.

- **Append-only streaming for debug log.** Log accumulates across CLI invocations. Rejected: buffered writes — risk losing diagnostic data if process crashes before flush.
