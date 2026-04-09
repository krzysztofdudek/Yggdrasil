# Validator Interface

## Validating the full graph

Call `validate(graph)` with no scope to validate the entire graph. Returns a `ValidationResult` containing all issues found across all nodes, plus `nodesScanned` for progress reporting. All errors and warnings are in `issues` — no throws. Use this when you need a complete picture of graph health (e.g. `yg check`).

## Validating a specific node scope

Call `validate(graph, nodePath)` to filter issues to a single node and its artifacts. Issues unrelated to that node are excluded from the result. When the node path does not exist, returns a single `invalid-scope` error with `nodesScanned: 0`. Use this when a command operates on one node and only wants that node's issues.

## Expanding mappings for coverage checks

Call `expandMappingToFiles(projectRoot, mappingPaths)` to resolve a list of mapping entries (files or directories) to a flat list of contained file paths. Use this when computing which source files a node covers — drift detection and hash computation both rely on the expanded list.

Hidden entries (names starting with `.`) and `node_modules` directories are always excluded. `.gitignore` filtering is NOT applied — only these two hardcoded rules govern exclusions. Filesystem errors (ENOENT, EACCES, etc.) are silently swallowed; inaccessible paths are skipped without surfacing an error.

## Failure Modes

- `validate`: never throws — all issues are returned in `ValidationResult.issues`.
- `expandMappingToFiles`: never throws — filesystem errors are silently ignored.
