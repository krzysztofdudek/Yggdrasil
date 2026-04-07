# IO Responsibility

I/O layer — parsing graph YAML files and persisting operational state. Separates filesystem/parse concerns from domain logic.

**In scope:**

- **config-parser:** Parse yg-config.yaml. Enforces: name (non-empty), node_types (non-empty object keyed by type name, each entry requires description), artifacts (non-empty object, no reserved `node`), quality (context_budget.error >= warning), parallel (positive integer >= 1). Parses `reviewer:` section (active provider, consensus, provider-specific keys) into flat `LlmConfig`. Uses yaml parser.
- **secrets-parser:** Load `yg-secrets.yaml` and merge reviewer secrets into an `LlmConfig`. Supports `reviewer.<provider>.*` format. Returns undefined if no secrets file exists.
- **architecture-parser:** Parse yg-architecture.yaml. Enforces: node_types (non-empty object), each entry requires description. Optional fields: aspects, ports, parents, relations (valid RelationType values only). Uses yaml parser.
- **node-parser:** Parse yg-node.yaml — name, type, aspects, blackbox, relations (valid RelationType, target required), mapping (paths array, relative to repo root, no leading slash)
- **aspect-parser, flow-parser:** Parse YAML for aspects, flows. Each reads artifacts from directory via readArtifacts.
- **schema-parser:** `parseSchema(filePath)` — validates YAML parseable, infers `schemaType` from filename stem. Used by loadSchemas; no artifacts.
- **artifact-reader:** Read artifact files from directory. Exclude/include filters. Sorted by filename for determinism.
- **drift-state-store:** Read/write .drift-state. Supports legacy string hash or DriftNodeState with hash and optional files.
- **audit-log:** Append-only JSONL audit log for approve operations. Write-only; never read by CLI.
