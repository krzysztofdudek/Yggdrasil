# IO Internals

## Decisions

Chose to separate I/O from domain logic so core modules stay focused on graph operations. All filesystem access, YAML parsing, and state persistence are centralized here.

Chose graceful degradation for operational files (readDriftState returns empty on missing file) but strict validation for structural files (config, node YAML throw on invalid input). Operational metadata is optional; graph structure is required for correct operation.

Chose nested `reviewer:` YAML structure in config but normalize to flat internal `LlmConfig` in the parser. The flat type is consumed by 5+ modules — changing it to mirror YAML nesting would cascade for zero behavioral gain. The parser absorbs the structural mismatch.

Chose per-node drift state files (`.drift-state/<node-path>.json`) over a single monolithic file. Legacy single-file format is auto-migrated transparently on read.

Chose `readArtifacts` returning `[]` on missing directory (treating it as "no artifacts") rather than throwing. This makes the function safe to call on nodes that haven't created artifact directories yet. Artifacts are sorted by filename for deterministic output — consumers relying on ordering get consistent results.

Chose dedicated `yg-secrets.yaml` for reviewer API keys and credentials, separate from main `yg-config.yaml`. This keeps sensitive config in a gitignore-able file, preventing accidental credential commits.

Chose write-only design for audit-log (`appendFile` only, never reads). This prevents the audit log from becoming a dependency for runtime behavior — it's purely observational.

Chose JSON.parse-first with YAML fallback when reading legacy monolithic drift state. This handles corrupt or hybrid legacy state files that may exist after interrupted migrations.

Chose active garbage collection for drift state: `garbageCollectDriftState` removes per-node .json files for deleted nodes and recursively prunes empty parent directories. Without this, orphaned state would accumulate indefinitely as nodes are renamed or deleted.

Chose `participants` as backward-compatible alias for `nodes` in flow-parser. Both field names are accepted silently — no migration warning, just silent compat.

Chose to silently ignore `anchors` and `stability` fields in aspect-parser rather than warning. These are reserved/removed fields that may appear in older configs. In contrast, architecture-parser actively rejects `integration_aspects` with a migration error directing users to `yg init --upgrade`. The difference: `integration_aspects` has a direct replacement (ports), so an actionable error helps migration. `anchors`/`stability` have no replacement — erroring would block users with no clear path forward.

Chose different migration strategies for old formats: drift state auto-migrates transparently on read (operational data, low risk), while node YAML and aspect YAML throw errors on old formats (object-style aspects, mapping groups) and redirect to `yg init --upgrade`. Structural graph files need explicit user action because silent migration could mask broken graph state.
