# Drift Commands Interface

Public API consumed by cli/entry. Named exports only.

| Function | Signature | Command | Options |
| -------- | --------- | ------- | ------- |
| registerDriftCommand | (program: Command) => void | drift | --scope (default: all), --drifted-only, --limit (optional integer). Scope: all or node-path. |
| registerDriftSyncCommand | (program: Command) => void | drift-sync | --node or --all (one required), --recursive (optional). |

**Return:** void. Both register subcommands on the Commander program.

**Contract:** Errors to stderr, process.exit(1) on failure. Implements patterns/command-error-handling.
