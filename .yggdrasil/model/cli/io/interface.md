# IO Interface

Library used by cli/core (loader, drift-detector) and cli/commands (journal). All paths are absolute; callers resolve from project root or yggRoot.

## config-parser.ts

- `parseConfig(filePath: string): Promise<YggConfig>`
  - Reads and parses config.yaml. Throws on missing name, invalid node_types, invalid artifacts (reserved name `node`, invalid required.when), missing knowledge_categories, invalid quality (context_budget.error < warning), missing tags. Returns parsed config with quality defaults.

## node-parser.ts

- `parseNodeYaml(filePath: string): Promise<NodeMeta>`
  - Throws on missing name/type, invalid relations (non-array, invalid type, missing target), invalid mapping (paths must be relative, non-empty). Relation types: uses, calls, extends, implements, emits, listens.

## aspect-parser.ts

- `parseAspect(aspectDir: string, aspectYamlPath: string): Promise<AspectDef>`
  - Throws on missing name or tag. Reads artifacts from aspectDir excluding aspect.yaml.

## flow-parser.ts

- `parseFlow(flowDir: string, flowYamlPath: string): Promise<FlowDef>`
  - Throws on missing name, invalid or empty nodes array. Reads artifacts from flowDir excluding flow.yaml.

## knowledge-parser.ts

- `parseKnowledge(knowledgeDir: string, knowledgeYamlPath: string, category: string, relativePath: string): Promise<KnowledgeItem>`
  - Throws on missing name, invalid scope (must be `global` or `{ tags: string[] }` or `{ nodes: string[] }` with non-empty arrays). Reads artifacts from knowledgeDir excluding knowledge.yaml.
- Exports type: `KnowledgeScope = 'global' | { tags: string[] } | { nodes: string[] }`

## template-parser.ts

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
