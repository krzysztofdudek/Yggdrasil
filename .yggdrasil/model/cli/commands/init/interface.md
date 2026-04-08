# Init Command Interface

**Command:** `yg init [--platform <name>] [--upgrade]`

**--platform:** Target agent platform for rules file placement. Defaults to `generic`. Supported: cursor, claude-code, copilot, cline, roocode, codex, windsurf, aider, gemini, amp, generic.

**--upgrade:** When `.yggdrasil/` exists, refreshes rules and schemas without touching graph content. Runs version migrations if project version < CLI version. Without `--upgrade`, init refuses to overwrite an existing project.

## Failure Modes

- .yggdrasil/ exists without --upgrade: exit 1.
- .yggdrasil exists but is not a directory: exit 1.
- Unknown platform: exit 1.
- Schema copy failure: warning to stderr, continues.
- Generic I/O errors: exit 1.
