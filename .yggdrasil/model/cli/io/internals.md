# IO Internals

## Decisions

Chose to separate I/O from domain logic so core modules stay focused on graph operations. All filesystem access, YAML parsing, and state persistence are centralized here.

Chose graceful degradation for operational files (readDriftState returns empty on missing file) but strict validation for structural files (config, node YAML throw on invalid input). Operational metadata is optional; graph structure is required for correct operation.

Chose nested `reviewer:` YAML structure in config but normalize to flat internal `LlmConfig` in the parser. The flat type is consumed by 5+ modules — changing it to mirror YAML nesting would cascade for zero behavioral gain. The parser absorbs the structural mismatch.

Chose per-node drift state files (`.drift-state/<node-path>.json`) over a single monolithic file. Legacy single-file format is auto-migrated transparently on read.

Chose `readArtifacts` returning `[]` on missing directory (treating it as "no artifacts") rather than throwing. This makes the function safe to call on nodes that haven't created artifact directories yet.
