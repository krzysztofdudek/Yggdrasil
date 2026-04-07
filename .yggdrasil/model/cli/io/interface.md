# IO Interface

Library used by cli/core (loader, drift-detector). All paths are absolute; callers resolve from project root or yggRoot.

## config-parser.ts

- `parseConfig(filePath: string): Promise<YggConfig>`
  - Reads and parses yg-config.yaml. Throws on missing name, invalid quality (context_budget.error < warning). Returns parsed config with quality defaults. Parses `reviewer:` section (nested provider structure) into flat `LlmConfig`. Throws on unknown keys under `reviewer:`, multiple providers without `active:` selector, `active:` pointing to unconfigured provider, invalid provider-specific fields (model, max_tokens, consensus). No `llm:` flat format support — removed.

## architecture-parser.ts

- `parseArchitecture(filePath: string): Promise<ArchitectureDef>`
  - Reads and parses yg-architecture.yaml. Throws on missing node_types (must be non-empty object), missing or invalid description (non-empty string) on any node type entry, invalid relation types (not one of: uses, calls, extends, implements, emits, listens), relation values that are not arrays of strings. Optional fields on each node type: aspects, ports, parents (string arrays), relations (object with relation type keys). Returns ArchitectureDef with all parsed node types.

## node-parser.ts

- `parseNodeYaml(filePath: string): Promise<NodeMeta>`
  - Parses yg-node.yaml with required fields: name (non-empty string), type (non-empty string, must match config.node_types). Optional: description, blackbox (boolean), mapping, relations, aspects, ports.
  - **Mapping format (v4):** Flat list of file/directory paths relative to repo root (no leading slash, non-empty). Backward compatible with old object format `mapping: {paths: [...]}` (converted internally to flat list).
  - **Relations:** Array of relation objects with `target: string` (required, relative path), `type: RelationType` (required: uses|calls|extends|implements|emits|listens), optional `consumes: string[]`, `failure: string`, `event_name: string`. No longer supports `anchors` field on relations.
  - **Aspects:** Array of aspect entries. Each entry is either a flat string (aspect ID) or an object with `aspect: string` (required, id of aspect) and optional `exceptions: string[]` (deviations from aspect pattern).
  - **ports:** Optional array of aspect IDs (strings) that consumers must realize.
  - Throws on invalid name, type, relations, mapping (non-array or object, invalid structure), aspects (non-array, duplicate ids, invalid entries), ports (non-array), blackbox (non-boolean).

## aspect-parser.ts

- `parseAspect(aspectDir: string, aspectYamlPath: string, id: string): Promise<AspectDef>`
  - Throws on missing name or empty id. Reads content artifacts from aspectDir excluding yg-aspect.yaml.

## flow-parser.ts

- `parseFlow(flowDir: string, flowYamlPath: string): Promise<FlowDef>`
  - Accepts both `nodes` and `participants` fields (`nodes` takes precedence when both present). Throws on missing name, invalid or empty nodes/participants array. Reads artifacts from flowDir excluding yg-flow.yaml. Sets `path` from `flowDir` basename (directory name under flows/).

## schema-parser.ts

- `parseSchema(filePath: string): Promise<SchemaDef>`
  - Validates file is parseable YAML. Infers `schemaType` from filename stem (e.g. `yg-node.yaml` → `'node'`). Used by `loadSchemas` in cli/core/loader.

## artifact-reader.ts

- `readArtifacts(dirPath: string, excludeFiles?: string[], includeFiles?: string[]): Promise<Artifact[]>`
  - excludeFiles default: `['yg-node.yaml']`. If includeFiles provided, only those files included. Returns sorted by filename. Skips non-files.

## drift-state-store.ts

- `readNodeDriftState(yggRoot: string, nodePath: string): Promise<DriftNodeState | undefined>` — reads single node's drift state from `.drift-state/<nodePath>.json`. Returns undefined if file doesn't exist.
- `writeNodeDriftState(yggRoot: string, nodePath: string, nodeState: DriftNodeState): Promise<void>` — writes single node's drift state to `.drift-state/<nodePath>.json`. Creates directories with `mkdir -p`. Pretty-prints JSON (2-space indent + trailing newline).
- `garbageCollectDriftState(yggRoot: string, validNodePaths: Set<string>): Promise<string[]>` — scans `.drift-state/` for all `.json` files, removes those whose node path is NOT in validNodePaths. Cleans up empty parent directories after removal. Returns sorted list of removed node paths.
- `readDriftState(yggRoot: string): Promise<DriftState>` — reads full drift state. If `.drift-state` is a directory, scans for per-node `.json` files. If `.drift-state` is a legacy single file, migrates it to per-node files transparently. Returns `{}` on missing or parse error.
- `writeDriftState(yggRoot: string, state: DriftState): Promise<void>` — writes full drift state as per-node files (delegates to `writeNodeDriftState` in a loop).

## audit-log.ts

- `appendAuditEntry(yggRoot: string, entry: AuditEntry): Promise<void>`
  - Appends a single JSONL line to `.yggdrasil/.audit-log.jsonl`. Creates the file if it doesn't exist. Never reads or parses existing content — pure append. Callers provide the fully-formed entry; this function only serializes and writes.

## secrets-parser.ts

- `loadSecrets(rootPath: string, providerName?: string): Promise<Partial<LlmConfig> | undefined>`
  - Reads `yg-secrets.yaml` from the given directory. Returns secrets for the given provider under `reviewer.<providerName>`. Returns `undefined` if no secrets file exists, no `reviewer:` section, or the provider key is absent. No `llm:` legacy format support.
- `mergeLlmConfig(base: LlmConfig, secrets: Partial<LlmConfig>): LlmConfig`
  - Merges secrets overrides into base config. Secrets fields take precedence.

## Failure Modes

Parsers and stores throw `Error` on invalid input. No dedicated error codes — standard Error with descriptive message.

**config-parser:** Missing name, invalid node_types (not a non-empty object, entries missing description), invalid quality (context_budget.error < warning). Propagates ENOENT, EACCES from readFile.

**architecture-parser:** Empty file, missing node_types (not a non-empty object), entries missing description, invalid relation types (not one of the valid types), relation values not arrays of strings. Propagates ENOENT, EACCES from readFile.

**node-parser:** Missing name/type, invalid relations (non-array, invalid type, missing target), invalid mapping (paths must be relative, non-empty, no leading slash), invalid aspects (non-array, invalid entries, missing/empty aspect string, invalid exceptions, duplicate aspect ids). Propagates ENOENT, EACCES from readFile.

**aspect-parser:** Missing name or empty id. Propagates readFile and readArtifacts errors.

**flow-parser:** Missing name, invalid or empty nodes/participants array. Propagates readFile and readArtifacts errors.

**schema-parser:** Invalid YAML (parseSchema). Propagates ENOENT, EACCES from readFile.

**artifact-reader:** Propagates ENOENT, EACCES from readdir/readFile.

**drift-state-store:** ENOENT on read is handled gracefully (return {}). Write failures propagate (ENOENT, EACCES).
