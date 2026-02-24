# IO Errors

Parsers and stores throw `Error` on invalid input. No dedicated error codes — standard Error with descriptive message.

**config-parser:** Missing name, invalid node_types, invalid artifacts (reserved name `node`, invalid required.when), missing knowledge_categories, invalid quality (context_budget.error < warning), missing tags. Propagates ENOENT, EACCES from readFile.

**node-parser:** Missing name/type, invalid relations (non-array, invalid type, missing target), invalid mapping (paths must be relative, non-empty, no leading slash). Propagates ENOENT, EACCES from readFile.

**aspect-parser:** Missing name or tag. Propagates readFile and readArtifacts errors.

**flow-parser:** Missing name, invalid or empty nodes array. Propagates readFile and readArtifacts errors.

**knowledge-parser:** Missing name, invalid scope (must be global, or { tags } or { nodes } with non-empty arrays). Propagates readFile and readArtifacts errors.

**template-parser:** Invalid YAML (parseSchema). Propagates ENOENT, EACCES from readFile.

**artifact-reader:** Propagates ENOENT, EACCES from readdir/readFile.

**drift-state-store, journal-store:** ENOENT on read is handled gracefully (return {} or []). Write failures propagate (ENOENT, EACCES). archiveJournal returns null on missing/empty journal.
