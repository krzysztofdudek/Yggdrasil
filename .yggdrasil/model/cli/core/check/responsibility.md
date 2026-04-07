## Responsibility

The `cli/core/check` module runs the full unified graph health check. It orchestrates validation (E001-E041), drift detection (E020-E021), and coverage scanning (E022). It returns a `CheckResult` with all issues, counts, and a suggested next command.
