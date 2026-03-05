# Commands Responsibility

CLI commands layer — thin orchestration wrappers over core services. Each command is a subcommand of `yg` registered with Commander.

## Pattern

Every command follows the same structure:

1. Parse CLI options (Commander arguments and flags)
2. Call core functions with parsed parameters
3. Format output for stdout
4. Handle errors — catch exceptions from core/io, write to stderr, exit with code 1

Commands never implement domain logic directly. Graph loading, context assembly, validation, drift detection, and dependency resolution all live in `cli/core`. Commands orchestrate these services and present results.

## Shared command contract (all children)

- Use `process.cwd()` as project root. No config file for path — working directory is the project.
- **Errors to stderr, success to stdout.** Never mix. Scriptability and piping depend on this.
- **On failure:** `process.stderr.write('Error: <message>\n')`, then `process.exit(1)`. Never throw uncaught.
- **On success:** implicit `process.exit(0)` or normal end.
- Each command's `action` callback wraps logic in try/catch; propagates errors from core/io, reports once, exits.
- **No default exports** for command handlers — use named exports (e.g. `registerBuildCommand`).

**Reference:** aspect cli-command-contract.

## Child nodes and their commands

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

## Out of scope

- Graph loading, context building, validation logic (cli/core)
- YAML parsing, drift state, journal file format (cli/io)
