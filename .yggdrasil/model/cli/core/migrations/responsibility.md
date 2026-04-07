# Migrations Responsibility

Implements schema version migrations for Yggdrasil graph files. Provides version detection and sequential migration execution for upgrading `.yggdrasil/` directories from older CLI versions to the current format.

## Scope

- `detectVersion` — reads `yg-config.yaml` (or legacy `config.yaml`) to determine the current schema version of a project. Returns `'1.4.3'` as the sentinel for any pre-2.0.0 project (whether `config.yaml` exists or `yg-config.yaml` has no version field).
- `runMigrations` — filters applicable migrations (target version strictly greater than current), sorts by semver ascending, and runs them sequentially.
- `updateConfigVersion` — rewrites the `version` field in `yg-config.yaml` after migrations complete.
- Migration implementations for each schema transition:
  - **2.0.0** — renames YAML files to `yg-*` prefix, converts `node_types` from array to object, migrates `stack`/`standards` to root node `internals.md`, transforms `aspects` arrays in `yg-node.yaml` from string to object format, removes `tags`, renames schema files, deletes old drift state.
  - **3.0.0** — removes the `artifacts` section from `yg-config.yaml` (artifact types became hardcoded in the CLI).
  - **4.0.0** — converts bare-string anchor arrays in `yg-node.yaml` aspect entries to typed objects (historical — anchors have since been removed from the aspect model).

## Constraints

All migration functions are idempotent — re-running on an already-migrated project produces no changes and emits no spurious actions. Each migration returns `{ actions: string[], warnings: string[] }` for the caller to surface to the user.

## Out of scope

- Triggering migrations (that is `cli/commands/init`)
- Writing the post-migration version to config (caller responsibility via `updateConfigVersion`)
- Any graph-loading or in-memory graph operations (only raw file I/O)
