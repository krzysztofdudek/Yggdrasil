# Validation Types Interface

Type library — exports TypeScript interfaces and type aliases only.

- **IssueSeverity** — `'error' | 'warning'`
- **ValidationIssue** — Single issue: severity, optional code, rule name, message, optional nodePath.
- **ValidationResult** — Collection of issues with nodesScanned count.

## Failure Modes

Type library — no runtime errors.
