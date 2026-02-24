# Validate Flow

End-to-end flow for `yg validate`: check graph structural integrity and completeness signals.

**Sequence:** commands/validation (orchestrates) → loader (load graph, tolerateInvalidConfig) → validator (E001–E017, W001–W009).

**Participants:**

- `cli/commands/validation` — orchestrates loadGraph, validate; outputs errors/warnings
- `cli/core/loader` — loads graph from `.yggdrasil/`
- `cli/core/validator` — structural checks, scope filtering, context budget, stale knowledge

**Output:** Errors and warnings to stdout; exit 1 if any errors.
