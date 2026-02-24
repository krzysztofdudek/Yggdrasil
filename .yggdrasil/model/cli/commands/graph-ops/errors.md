# Graph Ops Commands Errors

**Propagated from loadGraph:**

- Missing .yggdrasil/: `Error: No .yggdrasil/ directory found. Run 'yg init' first.`
- model/ does not exist: `Directory .yggdrasil/model/ does not exist. Run 'yg init' first.`

**status:** No command-specific errors; propagates from loadGraph, detectDrift, validate.

**tree:**

- Path not found: `Error: path '${path}' not found` — when --root is specified but the path does not exist in the graph.

**owner:**

- Path outside project: propagated from normalizeProjectRelativePath: `Path is outside project root: ${rawPath}`.
- Empty path: propagated from normalizeProjectRelativePath: `Path cannot be empty`.

**deps:**

- Node not found: propagated from formatDependencyTree (via buildDependencyTree): `Node not found: ${nodePath}`.

**impact:**

- Node not found: `Node not found: ${nodePath}` — when --node does not exist in the graph.

**Generic:** I/O errors — standard Node.js Error, caught and reported to stderr.
