# Model Responsibility

TypeScript type definitions for all domain types. Single source of truth for the CLI's type vocabulary.

Split into four child modules by domain:

- **graph** — core graph model (Graph, GraphNode, Config, Architecture, Aspects, Flows)
- **context** — context assembly output (ContextPackage, ContextMapOutput)
- **drift** — drift detection, approval, audit (DriftEntry, ApproveResult, DriftState)
- **validation** — validation results (ValidationIssue, ValidationResult)

**Shared constraint:** No runtime behavior — types and one constant (STANDARD_ARTIFACTS) only.
