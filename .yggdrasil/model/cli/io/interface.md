# IO Interface

## Parsers

- `parseConfig(filePath): Promise<YggConfig>` — config with quality defaults and reviewer section normalized to flat `LlmConfig`. Throws on missing name, invalid node_types, invalid quality thresholds, unknown reviewer keys.
- `parseArchitecture(filePath): Promise<ArchitectureDef>` — node types with descriptions, optional aspects/ports/parents/relations. Throws on empty file, missing node_types, invalid relation types.
- `parseNodeYaml(filePath): Promise<NodeMeta>` — node with name, type, optional mapping (flat paths), relations, aspects (string or object with exceptions), ports. Throws on invalid structure.
- `parseAspect(aspectDir, yamlPath, id): Promise<AspectDef>` — aspect with content artifacts. Throws on missing name or empty id.
- `parseFlow(flowDir, yamlPath): Promise<FlowDef>` — flow with participants and artifacts. Accepts both `nodes` and `participants` fields. Throws on missing name or empty participants.
- `parseSchema(filePath): Promise<SchemaDef>` — validates YAML parseable, infers schemaType from filename stem.
- `readArtifacts(dirPath, excludeFiles?, includeFiles?): Promise<Artifact[]>` — sorted by filename. Skips non-files. Returns `[]` on missing directory.

## State Stores

- `readNodeDriftState(yggRoot, nodePath): Promise<DriftNodeState | undefined>` — single node's drift state. Returns undefined if missing.
- `writeNodeDriftState(yggRoot, nodePath, state): Promise<void>` — writes per-node JSON with `mkdir -p`.
- `garbageCollectDriftState(yggRoot, validNodePaths): Promise<string[]>` — removes orphaned drift entries, cleans empty dirs.
- `readDriftState(yggRoot): Promise<DriftState>` — full legacy state (all nodes). Returns `{}` on missing/parse error.
- `writeDriftState(yggRoot, state): Promise<void>` — writes full legacy state. Use `writeNodeDriftState` for per-node writes.
- `appendAuditEntry(yggRoot, entry): Promise<void>` — append-only JSONL. Never reads existing content.
- `loadSecrets(rootPath, providerName?): Promise<Partial<LlmConfig> | undefined>` — reviewer secrets from `yg-secrets.yaml`.
- `mergeLlmConfig(base, secrets): LlmConfig` — secrets override base fields.

## Failure Modes

Parsers throw `Error` with descriptive message on invalid input. Drift state read returns empty on missing file. Write failures propagate filesystem errors.
