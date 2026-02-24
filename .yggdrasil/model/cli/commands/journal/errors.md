# Journal Commands Errors

**Propagated from findYggRoot:**

- Missing .yggdrasil/: `Error: No .yggdrasil/ directory found. Run 'yg init' first.`
- .yggdrasil exists but is not a directory: `Error: .yggdrasil exists but is not a directory (${yggPath}). Run 'yg init' in a clean location.`

**Propagated from appendJournalEntry, readJournal, archiveJournal:**

- I/O errors: permission denied, missing files — standard Node.js Error.

**Generic:** All errors caught and reported to stderr, process.exit(1).
