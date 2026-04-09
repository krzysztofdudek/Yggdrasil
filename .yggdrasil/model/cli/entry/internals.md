# Entry Internals

## Decisions

- **Thin composition root over shared startup path.** Entry wires commands and parses argv — no business logic. Rejected: centralizing graph loading or validation in entry — that couples all commands to a shared startup path and prevents commands like `init` (which creates the graph) from running before one exists.
