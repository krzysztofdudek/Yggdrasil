# Validation Commands Interface

Public API consumed by cli/entry. Named exports only.

| Function | Signature | Command | Options |
| -------- | --------- | ------- | ------- |
| registerValidateCommand | (program: Command) => void | validate | --scope (default: all). Uses tolerateInvalidConfig. |
| registerBuildCommand | (program: Command) => void | build-context | --node (required). |

**Return:** void. Both register subcommands on the Commander program.

**Contract:** Errors to stderr, process.exit(1) on failure. Implements patterns/command-error-handling.
