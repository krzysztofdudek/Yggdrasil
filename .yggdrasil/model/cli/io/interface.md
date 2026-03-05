# IO Interface

Library used by cli/core (loader, drift-detector) and cli/commands (journal). All paths are absolute; callers resolve from project root or yggRoot.

## config-parser.ts

- `parseConfig(filePath: string): Promise<YggConfig>`
  - Reads and parses config.yaml. Throws on missing name, invalid node_types (must be non-empty object keyed by type name, each entry must have non-empty description string), invalid artifacts (reserved name `node`, invalid required.when), invalid quality (context_budget.error < warning). Returns parsed config with quality defaults.

## node-parser.ts

- `parseNodeYaml(filePath: string): Promise<NodeMeta>`
  - Throws on missing name/type, invalid relations (non-array, invalid type, missing target), invalid mapping (paths must be relative, non-empty), invalid aspects (non-array, entries must be objects with non-empty `aspect` string, optional `exceptions` and `anchors` arrays of strings, duplicate aspect ids rejected). Relation types: uses, calls, extends, implements, emits, listens.
  - Internally calls `parseAspects(raw, filePath)` which validates the unified aspect format: each entry must be an object with a non-empty `aspect` string; optional `exceptions` (string[]) and `anchors` (string[]) are validated as arrays of strings; duplicate aspect ids produce an error. Returns `NodeAspectEntry[]` or undefined.

## aspect-parser.ts

- `parseAspect(aspectDir: string, aspectYamlPath: string, id: string): Promise<AspectDef>`
  - Throws on missing name or empty id. Parses optional `stability` (must be one of: schema, protocol, implementation). Reads artifacts from aspectDir excluding aspect.yaml.

## flow-parser.ts

- `parseFlow(flowDir: string, flowYamlPath: string): Promise<FlowDef>`
  - Throws on missing name, invalid or empty nodes array. Reads artifacts from flowDir excluding flow.yaml. Sets `path` from `flowDir` basename (directory name under flows/).

## schema-parser.ts

- `parseSchema(filePath: string): Promise<SchemaDef>`
  - Validates file is parseable YAML. Infers `schemaType` from filename stem (e.g. `node.yaml` → `'node'`). Used by `loadSchemas` in cli/core/loader.

## artifact-reader.ts

- `readArtifacts(dirPath: string, excludeFiles?: string[], includeFiles?: string[]): Promise<Artifact[]>`
  - excludeFiles default: `['node.yaml']`. If includeFiles provided, only those files included. Returns sorted by filename. Skips non-files.

## drift-state-store.ts

- `readDriftState(yggRoot: string): Promise<DriftState>` — returns `{}` on missing file or parse error
- `writeDriftState(yggRoot: string, state: DriftState): Promise<void>`
- `getCanonicalHash(entry: string | DriftNodeState): string` — returns string hash or entry.hash
- `getFileHashes(entry: string | DriftNodeState): Record<string, string> | undefined` — returns entry.files or undefined

## journal-store.ts

- `readJournal(yggRoot: string): Promise<JournalEntry[]>` — returns `[]` on missing file or parse error
- `appendJournalEntry(yggRoot: string, note: string, target?: string): Promise<JournalEntry>` — appends with ISO timestamp
- `archiveJournal(yggRoot: string): Promise<{ archiveName: string; entryCount: number } | null>` — moves .journal.yaml to journals-archive/.journal.YYYYMMDD-HHMMSS.yaml; returns null if empty or missing

## Failure Modes

Parsers and stores throw `Error` on invalid input. No dedicated error codes — standard Error with descriptive message.

**config-parser:** Missing name, invalid node_types (not a non-empty object, entries missing description), invalid artifacts (reserved name `node`, invalid required.when), invalid quality (context_budget.error < warning). Propagates ENOENT, EACCES from readFile.

**node-parser:** Missing name/type, invalid relations (non-array, invalid type, missing target), invalid mapping (paths must be relative, non-empty, no leading slash), invalid aspects (non-array, entries not objects, missing/empty aspect string, invalid exceptions/anchors not arrays of strings, duplicate aspect ids). Propagates ENOENT, EACCES from readFile.

**aspect-parser:** Missing name or empty id. Invalid `stability` (not one of: schema, protocol, implementation). Propagates readFile and readArtifacts errors.

**flow-parser:** Missing name, invalid or empty nodes array. Propagates readFile and readArtifacts errors.

**schema-parser:** Invalid YAML (parseSchema). Propagates ENOENT, EACCES from readFile.

**artifact-reader:** Propagates ENOENT, EACCES from readdir/readFile.

**drift-state-store, journal-store:** ENOENT on read is handled gracefully (return {} or []). Write failures propagate (ENOENT, EACCES). archiveJournal returns null on missing/empty journal.
