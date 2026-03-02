# Commands Responsibility

CLI commands module — groups 14 command handlers registered in Commander. Each handler is a subcommand of `yg`.

**Shared command contract (all children):**

- Use `process.cwd()` as project root. No config file for path — working directory is the project.
- **Errors to stderr, success to stdout.** Never mix. Scriptability and piping depend on this.
- **On failure:** `process.stderr.write('Error: <message>\n')`, then `process.exit(1)`. Never throw uncaught.
- **On success:** implicit `process.exit(0)` or normal end.
- Each command's `action` callback wraps logic in try/catch; propagates errors from core/io, reports once, exits.
- **No default exports** for command handlers — use named exports (e.g. `registerBuildCommand`).

**Reference:** config.yaml standards.

**Flows:** cli/commands/build-context → build-context; cli/commands/validation → validate; cli/commands/drift → drift; cli/commands/init → init.

**Child nodes and their commands:**

| Node | Commands |
| ---- | -------- |
| cli/commands/init | init |
| cli/commands/validation | validate |
| cli/commands/drift | drift, drift-sync |
| cli/commands/journal | journal-add, journal-read, journal-archive |
| cli/commands/aspects | aspects |
| cli/commands/build-context | build-context |
| cli/commands/deps | deps |
| cli/commands/impact | impact |
| cli/commands/owner | owner |
| cli/commands/preflight | preflight |
| cli/commands/status | status |
| cli/commands/tree | tree |

**Out of scope:**

- Graph loading, context building, validation logic (cli/core)
- YAML parsing, drift state, journal file format (cli/io)
