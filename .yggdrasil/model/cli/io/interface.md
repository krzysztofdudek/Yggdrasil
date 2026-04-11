# IO Interface

## Parsers

- **parseConfig** — config with quality defaults, debug flag, and reviewer section normalized to flat LlmConfig. General reviewer keys (`verify_aspects`, `verify_artifacts` — both default true, `consensus` — must be positive odd integer) sit at reviewer level. Supported providers: ollama (requires model; endpoint, temperature default to undefined/0; optional `max_tokens` defaults to 'auto' and must be 'auto' or positive number; optional `context_length_field` for model-specific context window) and claude-code (model defaults to 'haiku', always uses max_tokens:'auto', no endpoint). Multi-provider requires `active` key — throws if missing or mismatched. Validates `parallel` as a positive integer. Throws on missing name, invalid quality thresholds, unknown reviewer keys.
- **parseArchitecture** — node types with descriptions, optional aspects/parents/relations, quality_profile. Rejects removed v3 fields (`integration_aspects`) with migration guidance. Throws on empty file, missing node_types, invalid relation types.
- **parseNodeYaml** — node with name, type, optional mapping, relations, aspects (strings only — object format rejected with migration guidance), ports. Throws on invalid structure.
- **parseAspect** — aspect with content artifacts and optional `implies` chain (validated as array). Throws on missing name or empty id.
- **parseFlow** — flow with participants, aspects, and artifacts. Accepts both `nodes` and `participants` fields. Throws on missing name or empty participants.
- **parseSchema** — validates YAML parseable with descriptive errors, infers schemaType from filename stem (strips `yg-` prefix, e.g. `yg-node.yaml` → `node`).
- **readArtifacts** — sorted by filename for deterministic output. Skips non-files. Returns empty on missing directory. `excludeFiles` defaults to `['yg-node.yaml']`; optional `includeFiles` parameter filters to only named files.

## State Stores

- **readNodeDriftState** — single node's drift state. Returns undefined if missing.
- **writeNodeDriftState** — writes per-node JSON, creates directories as needed.
- **garbageCollectDriftState** — removes orphaned drift entries, cleans empty dirs.
- **readDriftState** — reads all nodes' drift state. Handles both current per-node directory format and legacy single-file format with automatic migration on read. Returns empty on missing/parse error.
- **writeDriftState** — writes per-node files via writeNodeDriftState for each entry. Use writeNodeDriftState directly for single-node writes.
- **appendAuditEntry** — append-only JSONL. Write-only by design — never reads existing content.
- **loadSecrets** — reviewer secrets from yg-secrets.yaml. Defaults to 'ollama' provider when provider name is omitted.
- **mergeLlmConfig** — secrets override base fields.

## Failure Modes

Parsers throw with descriptive messages on invalid input. Error format varies: node/aspect/flow/schema parsers use `<filename> at <path>: <field>`, config-parser uses `<filename>: <field>`, architecture-parser uses `yg-architecture.yaml: <field>`. Drift state read returns empty on missing file. Write failures propagate filesystem errors.
