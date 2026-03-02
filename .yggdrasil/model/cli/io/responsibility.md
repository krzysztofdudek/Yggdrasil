# IO Responsibility

I/O layer — parsing graph YAML files and persisting operational state. Separates filesystem/parse concerns from domain logic.

**In scope:**

- **config-parser:** Parse config.yaml. Enforces: name (non-empty), node_types (non-empty array), artifacts (non-empty object, no reserved `node`), quality (context_budget.error >= warning). Uses yaml parser.
- **node-parser:** Parse node.yaml — name, type, aspects, blackbox, relations (valid RelationType, target required), mapping (paths array, relative to repo root, no leading slash)
- **aspect-parser, flow-parser:** Parse YAML for aspects, flows. Each reads artifacts from directory via readArtifacts.
- **schema-parser:** `parseSchema(filePath)` — validates YAML parseable, infers `schemaType` from filename stem. Used by loadSchemas; no artifacts.
- **artifact-reader:** Read artifact files from directory. Exclude/include filters. Sorted by filename for determinism.
- **drift-state-store:** Read/write .drift-state. Supports legacy string hash or DriftNodeState with hash and optional files.
- **journal-store:** Read/write .journal.yaml, append entries, archive to journals-archive/ with timestamped filename.

**Out of scope:**

- Validation logic (cli/core/validator)
- Type definitions (cli/model)
- Graph assembly (cli/core/loader)
