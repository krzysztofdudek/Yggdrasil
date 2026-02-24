# Journal Commands Interface

Public API consumed by cli/entry. Named exports only.

| Function | Signature | Command | Options |
| -------- | --------- | ------- | ------- |
| registerJournalAddCommand | (program: Command) => void | journal-add | --note (required), --target (optional node path). |
| registerJournalReadCommand | (program: Command) => void | journal-read | None. |
| registerJournalArchiveCommand | (program: Command) => void | journal-archive | None. |

**Return:** void. All register subcommands on the Commander program.

**Contract:** Errors to stderr, process.exit(1) on failure. Implements patterns/command-error-handling.
