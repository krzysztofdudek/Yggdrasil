# Init Command Interface

Public API consumed by cli/entry. Named exports only.

| Function | Signature | Command | Options |
| -------- | --------- | ------- | ------- |
| registerInitCommand | (program: Command) => void | init | --platform (default: generic), --upgrade. |

**Platforms (PLATFORMS):** cursor, claude-code, copilot, cline, roocode, codex, windsurf, aider, gemini, amp, generic.

**Return:** void. Registers subcommand on the Commander program.

**Contract:** Errors to stderr, process.exit(1) on failure. Implements patterns/command-error-handling.
