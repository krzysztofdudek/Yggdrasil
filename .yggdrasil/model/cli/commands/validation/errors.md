# Validation Commands Errors

**Propagated from loadGraph:**

- Missing .yggdrasil/: `Error: No .yggdrasil/ directory found. Run 'yg init' first.`
- model/ does not exist: `Directory .yggdrasil/model/ does not exist. Run 'yg init' first.`

**validate:** No command-specific errors; propagates from loadGraph, validate.

**build-context:**

- Validation errors: `Error: build-context requires a structurally valid graph (N errors found).` — blocks build when structural errors exist.
- Node not found: propagated from buildContext.
- Budget exceeded: `Error: context package exceeds error budget (${tokenCount} >= ${errorThreshold}).` — exits 1 when tokenCount >= config.quality.context_budget.error.

**Generic:** I/O errors — standard Node.js Error, caught and reported to stderr.
