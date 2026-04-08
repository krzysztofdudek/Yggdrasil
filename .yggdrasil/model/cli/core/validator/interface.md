# Validator Interface

## `validate(graph, scope?): Promise<ValidationResult>`

Validates the graph and returns all issues found.

- `graph: Graph` — loaded graph
- `scope: string` — `'all'` (default) or a node path to filter issues to that node

Returns `ValidationResult` with `issues: ValidationIssue[]` and `nodesScanned: number`.

When scope is a node path that doesn't exist, returns a single `invalid-scope` error with `nodesScanned: 0`.

## `expandMappingToFiles(projectRoot, mappingPaths): Promise<string[]>`

Expands a list of mapping entries (files or directories) to a flat list of contained file paths. Applies hierarchical `.gitignore` filtering. Used by drift detection and hash computation outside of validation.

- Throws if a mapping entry path type is unsupported.
- Propagates filesystem errors (ENOENT, EACCES).

## Failure Modes

- `validate`: no throws — all issues returned in `ValidationResult.issues`. `buildContext` failure during budget check is caught and skipped.
- `expandMappingToFiles`: throws on unsupported path type or filesystem error.
