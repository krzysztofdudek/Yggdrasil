# Utils Interface

Stateless utility functions consumed by cli/core and cli/commands.

**Path utilities:** `findYggRoot` traverses upward to locate `.yggdrasil/`. `getPackageRoot` returns the CLI package directory. `normalizeMappingPaths` flattens mapping entries to a POSIX path list. `normalizeProjectRelativePath` converts any path to project-relative POSIX form. `toGraphPath` converts an absolute path to a graph-relative path (relative to `.yggdrasil/`). `normalizeNodePath` strips leading/trailing slashes from a node path string. `projectRootFromGraph` returns the project root given a `.yggdrasil/` path.

**Hashing:** SHA-256 based. `hashFile` hashes a single file. `hashPath` hashes a file or directory. `hashString` hashes a string. `perFileHashes` returns per-file hash map for a list of paths. `hashForMapping` hashes a flat mapping path list. `hashTrackedFiles` produces the canonical drift hash for a node — expands directories with hierarchical `.gitignore` filtering (root + nested `.gitignore` files), returns per-file data for incremental diffing.

**Token estimation:** `estimateTokens` uses a fixed heuristic (~4 chars/token). `tokenize` splits text into tokens for context budget calculations.

**Git:** `getLastCommitTimestamp` returns the last commit timestamp for a file.

**Debug logging:** `initDebugLog` redirects stdout/stderr to a log file when debug mode is enabled. `debugWrite` writes a message directly to the debug log (bypasses stdout redirection).

## Failure Modes

- `findYggRoot`: throws if `.yggdrasil/` not found or is not a directory.
- `normalizeProjectRelativePath`: throws if path is empty or outside project root.
- `hashForMapping`: throws if mapping has no paths.
- `hashPath`: throws on unsupported path type.
- Hash functions: propagate filesystem errors (ENOENT, EACCES).
- `getLastCommitTimestamp`: returns null on git errors (never throws).
