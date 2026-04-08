# Owner Command Interface

**Command:** `yg owner --file <path>` — required option.

**Also exported:** `findOwner(graph, projectRoot, rawPath): OwnerResult` — used by impact command to resolve `--file` flag to a node path.

**Output:** `<file> -> <nodePath>` on match. When no node owns the file, two variants:

- File exists but is not mapped: `<file> -> no graph coverage`
- File does not exist on disk: `<file> -> no graph coverage (file not found)`

When coverage comes from an ancestor directory mapping (not a direct file mapping), a second line follows:

```
  File has no direct mapping; context comes from ancestor directory <mappingPath>. Use: yg context --node <nodePath>
```

**Exit codes:** 0 on success (owner found or no-coverage output written); 1 on error (no .yggdrasil/, I/O failure).

## Failure Modes

- No .yggdrasil/ directory: `Error: No .yggdrasil/ directory found. Run 'yg init' first.` (stderr, exit 1)
- Path outside project root or empty path: propagated from path normalization (stderr, exit 1).
- Generic errors to stderr, exit 1.

Note: `no graph coverage` outputs (both variants) are written to stdout with exit 0 — they are informational results, not errors.
