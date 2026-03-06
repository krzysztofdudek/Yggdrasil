## Constraints

# IO Constraints

- **Paths:** All parser functions accept absolute file paths. Callers (core, commands) resolve from project root or yggRoot.
- **YAML:** Uses `yaml` package. Throws on parse errors. No schema validation beyond required fields.
- **Artifact reader:** Skips binary extensions (.png, .jpg, .pdf, .zip, etc.). Excludes yg-node.yaml by default. Sorts output by filename for determinism.
- **Drift state:** Format is node-path → hash (string) or DriftNodeState { hash, files? }. Stored in .yggdrasil/.drift-state. Commit to repo.
- **Knowledge scope:** scope must be 'global' | { tags: string[] } | { nodes: string[] }. Tags and nodes must resolve.

## State

# IO State Files

## .drift-state

YAML file at `.yggdrasil/.drift-state`. Maps node paths to `DriftNodeState` objects:

```
<node-path>:
  hash: <sha256-hex>       # canonical hash of all tracked files (source + graph)
  files:                    # per-file hashes for granular change detection
    <relative-path>: <sha256-hex>
```

Written by `drift-sync` command via `writeDriftState`. Read by `detectDrift` via `readDriftState`. Legacy format (node-path mapped to a plain string hash) is silently skipped during reads. This file should be committed to the repository so drift baselines persist across sessions.

## Decisions

# IO Decisions

**Separation of I/O from domain:** Parsers and stores live in io/ so that cli/core (loader, drift-detector) and cli/commands can remain focused on domain logic. All filesystem access, YAML parsing, and operational state persistence are centralized here.

**Graceful degradation for operational files:** readDriftState returns empty structure on missing file — this is optional operational metadata. Parsers for config and graph structure throw on invalid input, since those are required for correct operation.
