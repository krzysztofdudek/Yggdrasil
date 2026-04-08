# Migrations Responsibility

Schema version upgrade boundary — detects the current schema version of a `.yggdrasil/` directory and applies sequential migrations to bring it to the current format. Guards callers from having to know migration history or version ordering.

All migration functions are idempotent — re-running on an already-migrated project produces no changes. Each migration returns `{ actions, warnings }` for the caller to surface to the user. Only raw file I/O; no in-memory graph operations.
