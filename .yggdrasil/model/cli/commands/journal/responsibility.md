# Journal Commands Responsibility

**In scope:** `yg journal-add`, `yg journal-read`, `yg journal-archive`. Session journal for iterative mode — buffer notes before consolidating to graph.

**journal-add:**

- findYggRoot(process.cwd()). appendJournalEntry(yggRoot, options.note, options.target). readJournal(yggRoot).
- Output: "Note added to journal (N entries total)".

**journal-read:**

- findYggRoot(process.cwd()). readJournal(yggRoot).
- If empty: "Session journal: empty (clean state)". Return.
- Else: "Session journal (N entries):" then each entry: [date] target, note. Date format: e.at.slice(0,19).replace('T',' ').

**journal-archive:**

- findYggRoot(process.cwd()). archiveJournal(yggRoot).
- If !result: "No active journal - nothing to archive." Return.
- Else: "Archived journal (N entries) -> journals-archive/${archiveName}".

**Error handling:** try/catch; on error write to stderr, process.exit(1).

**Consumes:** readJournal, appendJournalEntry, archiveJournal (cli/io); findYggRoot (cli/utils).

**Out of scope:** Validation, drift, graph navigation.
