# Aspects Command Interface

**Command:** `yg aspects` — no options.

**Output format:** Human-readable text to stdout, sorted by aspect id. Each aspect: id, description, usage count with source breakdown (architecture/direct/implied/flow), implies chain. Orphaned aspects flagged in yellow.

## Failure Modes

- Missing .yggdrasil/: propagated from loadGraph.
- Generic I/O errors to stderr, exit 1.
