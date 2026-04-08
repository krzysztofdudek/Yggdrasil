# Owner Command Interface

**Command:** `yg owner --file <path>` — required option.

**Also exported:** `findOwner(graph, projectRoot, rawPath): OwnerResult` — used by impact command to resolve `--file` flag to a node path.

**Output:** `<file> -> <nodePath>` on match, `<file> -> no graph coverage` otherwise. When coverage comes from an ancestor directory (not a direct mapping), a second line explains this.

## Failure Modes

- No .yggdrasil/ directory: `Error: No .yggdrasil/ directory found. Run 'yg init' first.`
- Path outside project root or empty path: propagated from path normalization.
- Generic errors to stderr, exit 1.
