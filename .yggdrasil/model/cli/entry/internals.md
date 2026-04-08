# Entry Internals

## Decisions

- **Thin composition root over shared startup path.** Entry wires commands and parses argv — no business logic. Rejected: centralizing graph loading or validation in entry — that couples all commands to a shared startup path and prevents commands like `init` (which creates the graph) from running before one exists.

- **Plain text with structured conventions over machine-readable output.** The CLI emits structured plain text (error codes, `read:` paths, YAML blocks, exit codes) rather than JSON. Rejected: JSON output — agents consume CLI output as part of natural text and structured plain text is readable in both interactive and piped contexts without a JSON parser step.
