# I/O Unit Tests — Responsibility

Unit tests for file system I/O parsers in `src/io/`. Verifies YAML parsing, schema validation, and graph file reading behavior with mocked or minimal filesystem access.

## Scope

- `artifact-reader.test.ts` — artifact file reading and parsing
- `architecture-parser.test.ts` — architecture YAML parsing and validation
- `aspect-parser.test.ts` — aspect YAML parsing and validation
- `config-parser.test.ts` — `yg-config.yaml` parsing
- `drift-state-store.test.ts` — drift state JSON reading and writing
- `flow-parser.test.ts` — flow YAML parsing and validation
- `node-parser.test.ts` — node YAML parsing and validation (supports old and new aspects format, ports, typed anchor realizations)
- `schema-parser.test.ts` — schema file parsing
- `secrets-parser.test.ts` — secrets YAML loading and LlmConfig merging
- `audit-log.test.ts` — audit log append behavior

## Out of scope

- Template generation tests — belongs to `cli/tests/unit/support/templates`
- Utility function tests — belongs to `cli/tests/unit/support/utils`
- Formatter tests — stay in the parent `cli/tests/unit/support` node
