# Validation Types Responsibility

Types for validation results — the output of `yg check` structural and semantic validation.

**In scope:** ValidationResult, ValidationIssue, IssueSeverity.

**Out of scope:** Validation logic (cli/core/validator), check orchestration (cli/core/check). No runtime behavior — types only.
