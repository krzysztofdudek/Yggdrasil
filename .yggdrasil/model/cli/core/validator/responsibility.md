# Validator Responsibility

Structural and semantic validation of the graph. Reports issues without modifying anything — read-only by design.

Only errors represent structurally invalid states that block commits. Warnings indicate quality concerns but never block build-context or approve.
