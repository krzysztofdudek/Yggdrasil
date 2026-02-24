# Validator Interface

- `validate(graph: Graph, scope?: string): Promise<ValidationResult>`
  - Parameters: `graph` (Graph), `scope` (string, default 'all') — 'all' or node path.
  - Returns: `ValidationResult` with `issues` (ValidationIssue[]), `nodesScanned` (number).
  - When scope is a node path: filters issues to that node; returns single error in issues if node not found (invalid-scope, nodesScanned: 0).
  - No throw for normal validation — all issues returned in result. Uses buildContext internally for W005/W006 (context budget).
