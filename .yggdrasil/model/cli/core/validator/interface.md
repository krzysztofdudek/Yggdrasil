# Validator Interface

## `validate(graph, scope?): Promise<ValidationResult>`

Validates the graph and returns all issues found.

- `graph: Graph` — loaded graph
- `scope: string` — `'all'` (default) or a node path to filter issues to that node

Returns `ValidationResult` with `issues: ValidationIssue[]` and `nodesScanned: number`.

When scope is a node path that doesn't exist, returns a single `invalid-scope` error with `nodesScanned: 0`.

## Failure Modes

- No throws for normal validation — all issues returned in `ValidationResult.issues`.
- `buildContext` failure during budget check: caught and skipped (other rules surface structural issues).
