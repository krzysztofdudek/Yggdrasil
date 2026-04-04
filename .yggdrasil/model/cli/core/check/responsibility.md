## Responsibility

The `cli/core/check` module runs the full unified graph health check. It orchestrates validation (E001-E041), drift detection (E020-E021), and coverage scanning (E022). It returns a `CheckResult` with all issues, counts, and a suggested next command.

This node is NOT responsible for:

- Output formatting (that is in `cli/commands/check`)
- Loading the graph from disk (that is in `cli/core/loader`)
- Detecting individual drift states at the file level (that is in `cli/core/drift-detector`)
- Structural validation rules (that is in `cli/core/validator`)
