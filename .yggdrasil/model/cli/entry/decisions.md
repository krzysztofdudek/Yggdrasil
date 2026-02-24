# Entry Decisions

**Reference:** docs/idea/tools.md (Operations, naming convention)

The CLI is invoked as a single command (`yg`) with subcommands. Commander is the standard Node.js convention for structured argument parsing. One entry point, one program instance — all operations flow through the same process.

**Why a thin entry:** Entry does not contain logic. It wires commands. The actual work (loadGraph, validate, buildContext, etc.) lives in commands and core. Entry's job is to parse argv and dispatch. This keeps the boundary clear: human types `yg build-context --node X`, entry routes to the handler, handler does the work.

**Platform-agnostic:** The CLI does not know which agent platform (Cursor, Claude, Copilot) consumes its output. It produces Markdown and exit codes. The platform delivers the mechanism; Yggdrasil delivers the content.
