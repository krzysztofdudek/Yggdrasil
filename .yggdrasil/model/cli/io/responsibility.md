# IO Responsibility

YAML parsing and operational state persistence — the boundary between filesystem and in-memory graph model. Centralizes all filesystem access so that core modules (loader, drift-detector) and commands remain focused on domain logic.

Parsers enforce structural validity for config, architecture, nodes, aspects, flows, and schemas. Operational stores handle drift state (per-node JSON files in `.drift-state/`) and append-only audit logging.

Config parser normalizes nested `reviewer:` YAML structure into flat internal `LlmConfig`. Drift state store auto-migrates legacy single-file format to per-node files transparently on read.
