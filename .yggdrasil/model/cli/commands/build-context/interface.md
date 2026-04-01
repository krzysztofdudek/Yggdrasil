# Build Context Command Interface

| Function | Signature | Command | Options |
| -------- | --------- | ------- | ------- |
| registerBuildCommand | (program: Command) => void | build-context | --node or --file (one required), --full (optional) |

**Return:** void. Contract: errors to stderr, process.exit(1) on failure.

**--file flag:** Resolves the owning node via `findOwner`, prints `<file> -> <node>` to stderr, then proceeds as if `--node <owner>` was given. If file has no graph coverage, prints `<file> -> no graph coverage` to stderr and exits 1.

**--full flag:** When set, appends full artifact file contents after the YAML context map. Files are collected from all registry sections (nodes, aspects, flows), deduplicated, and rendered via `formatFullContent`.

## Failure Modes

**Propagated from loadGraph:**

- Missing .yggdrasil/: `Error: No .yggdrasil/ directory found. Run 'yg init' first.`

**Command-specific:**

- Neither --node nor --file: `Error: either '--node <path>' or '--file <path>' is required` (exit 1).
- Both --node and --file: `Error: '--node' and '--file' are mutually exclusive` (exit 1).
- File not mapped (--file): `<file> -> no graph coverage` (exit 1). If other files in the same directory are mapped, lists candidate nodes with file counts and a `Use: yg build-context --node <node-path>` hint.
- Node not found: exits when node path does not exist in graph.
- Validation errors: blocks build-context if graph has structural errors (E001-E017) affecting this node's context (own node, ancestors, relation targets and their ancestors). Unrelated errors in other nodes are ignored.

**Generic:** I/O errors — standard Node.js Error, caught and reported to stderr.
