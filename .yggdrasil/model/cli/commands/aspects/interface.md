# Aspects Command Interface

| Function | Signature | Command | Options |
| -------- | --------- | ------- | ------- |
| registerAspectsCommand | (program: Command) => void | aspects | None |

**Return:** void. Contract: errors to stderr, process.exit(1) on failure.

**Output format:** YAML array of aspect entries, sorted by id. Each entry contains: `id`, `name`, optional `description`, optional `implies` (when non-empty).

## Failure Modes

**Propagated from loadGraph:**

- Missing .yggdrasil/: `Error: No .yggdrasil/ directory found. Run 'yg init' first.`

**No command-specific errors.**

**Generic:** I/O errors — standard Node.js Error, caught and reported to stderr.
