# Entry Internals

## Decisions

- **Thin composition root.** Entry wires commands and parses argv — no business logic. Rejected: putting graph loading or validation in entry — that couples all commands to a shared startup path and prevents commands like `init` (which creates the graph) from working.

- **Platform-agnostic output.** The CLI produces plain text with structured conventions (error codes, read: paths, YAML) and exit codes. It does not know which agent platform (Cursor, Claude, Copilot) consumes its output. The platform delivers the mechanism; Yggdrasil delivers the content.
