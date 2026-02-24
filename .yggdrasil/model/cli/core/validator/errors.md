# Validator Errors

- **validate**: No throws for normal validation — all issues returned as ValidationResult.issues (errors + warnings).
- **invalid-scope**: When scope is non-empty and node not found, returns single error in ValidationResult: `{ severity: 'error', rule: 'invalid-scope', message: "Node not found: ${scope}" }`, nodesScanned: 0.
- **buildContext failure**: If buildContext throws during W005/W006 check, error is caught and skipped (other rules will surface structural issues).
