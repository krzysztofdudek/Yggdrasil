# Utils Interface

**Path resolution (async):** Use `findYggRoot` (async) to locate `.yggdrasil/` from any subdirectory. Use `normalizeProjectRelativePath` when converting user-provided paths to project-relative form — it rejects paths outside the project root. Use `normalizeMappingPaths` to flatten mapping entries from yg-node.yaml into a usable path list.

**Drift hashing:** Use `hashTrackedFiles` for drift detection — it expands directories with gitignore filtering and uses mtime caching to skip unchanged files. Use `hashForMapping` for a single hash of a flat mapping list (throws if empty). Use `perFileHashes` when you need per-file breakdown for diagnostics.

**Search:** Use `tokenize` for keyword extraction in `yg select` scoring. Use `estimateTokens` for context budget warnings (~4 chars/token heuristic).

**Observability:** Use `initDebugLog` once after loadGraph to enable diagnostic capture. Use `debugWrite` in catch blocks that swallow errors. `getLastCommitTimestamp` returns null when git is unavailable — callers degrade gracefully.

## Failure Modes

- `findYggRoot`: throws if `.yggdrasil/` not found.
- `normalizeProjectRelativePath`: throws if path empty or outside root.
- `hashForMapping`: throws if no paths.
- `getLastCommitTimestamp`: returns null (never throws).
