# Utils Interface

Stateless utility functions consumed by cli/core and cli/commands.

**Path utilities:** `findYggRoot` traverses upward to locate `.yggdrasil/`. `normalizeMappingPaths` flattens mapping entries to a POSIX path list. `normalizeProjectRelativePath` converts any path to project-relative POSIX form.

**Hashing:** SHA-256 based. `hashTrackedFiles` produces the canonical drift hash for a node — expands directories with hierarchical `.gitignore` filtering (root + nested `.gitignore` files).

**Token estimation:** Fixed heuristic (~4 chars/token) for context budget calculations.

## Failure Modes

- `findYggRoot`: throws if `.yggdrasil/` not found or is not a directory.
- `normalizeProjectRelativePath`: throws if path is empty or outside project root.
- `hashForMapping`: throws if mapping has no paths.
- Hash functions: propagate filesystem errors (ENOENT, EACCES).
- `getLastCommitTimestamp`: returns null on git errors (never throws).
