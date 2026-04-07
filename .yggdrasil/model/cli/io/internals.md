## Constraints

# IO Constraints

- **Paths:** All parser functions accept absolute file paths. Callers (core, commands) resolve from project root or yggRoot.
- **YAML:** Uses `yaml` package. Throws on parse errors. No schema validation beyond required fields.
- **Artifact reader:** Skips binary extensions (.png, .jpg, .pdf, .zip, etc.). Excludes yg-node.yaml by default. Sorts output by filename for determinism.
- **Drift state:** Per-node storage under `.yggdrasil/.drift-state/` directory. Each node's state is stored in `.drift-state/<node-path>.json` as a JSON file containing `{ hash, files, mtimes? }`. Legacy single-file format (`.drift-state` as a file) is auto-migrated on read. Commit to repo.
- **Knowledge scope:** scope must be 'global' | { tags: string[] } | { nodes: string[] }. Tags and nodes must resolve.

## State

# IO State Files

## .drift-state/

Per-node directory at `.yggdrasil/.drift-state/`. Each node's state is stored as `<node-path>.json`:

```
.drift-state/
  cli/
    commands/
      aspects.json    # { "hash": "<sha256>", "files": {...}, "mtimes": {...} }
    core/
      loader.json
```

Each JSON file contains a `DriftNodeState`: canonical hash, per-file hashes, and optional mtimes. Written by `drift-sync` command via `writeNodeDriftState`. Read by `detectDrift` via `readNodeDriftState` or `readDriftState`.

**Legacy migration:** If `.drift-state` exists as a single file (old format, JSON or YAML), `readDriftState` transparently migrates it: parses the old file, writes per-node files, deletes the old file, and returns the state. Legacy string-hash entries are silently skipped during migration. This directory should be committed to the repository so drift baselines persist across sessions.

## Decisions

# IO Decisions

**Separation of I/O from domain:** Parsers and stores live in io/ so that cli/core (loader, drift-detector) and cli/commands can remain focused on domain logic. All filesystem access, YAML parsing, and operational state persistence are centralized here.

**Graceful degradation for operational files:** readDriftState returns empty structure on missing file — this is optional operational metadata. Parsers for config and graph structure throw on invalid input, since those are required for correct operation.

**Artifacts removed from config:** The config parser no longer parses or validates an `artifacts` section. The three standard artifacts (responsibility.md, interface.md, internals.md) are now hardcoded as STANDARD_ARTIFACTS in cli/model/types.ts. This eliminated the need for config-level artifact injection, E020 validation, and the `artifacts` field on YggConfig.

**Aspects format migration:** parseAspects in node-parser.ts supports both old (object with `aspect` key) and new (flat string) formats. Old format objects can include `exceptions` field; new flat string format contains only the aspect ID. This allows gradual migration from old to new format.

**Ports:** The `ports` field on NodeMeta defines aspect IDs that consumers of this node must propagate in their dependency tracking.

**Nested reviewer config with parser normalization:** Chose to parse the nested `reviewer:` YAML structure (provider sub-keys under `reviewer:`) and normalize it into the flat internal `LlmConfig` type, over changing the `LlmConfig` type to mirror the YAML nesting. Reason: the flat `LlmConfig` is consumed by 5+ modules (provider factory, claim verifier, artifact reviewer, approve command, check). Changing the internal type would cascade through all consumers for zero behavioral gain. The parser absorbs the structural mismatch so the rest of the codebase stays untouched.

**`deterministic` aspect removed:** The io layer writes files by design (drift-state, audit-log). The `deterministic` aspect is appropriate for pure computation functions; it is not appropriate for the persistence layer.

**`readArtifacts` returns `[]` on missing directory:** `readArtifacts` now catches readdir errors and returns an empty array, treating a missing directory as "no artifacts" rather than an error. This satisfies the `silent-missing-files` contract and makes the function safe to call on nodes that have not yet created artifact directories.
