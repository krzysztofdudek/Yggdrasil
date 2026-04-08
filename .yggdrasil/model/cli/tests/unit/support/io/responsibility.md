# I/O Unit Tests — Responsibility

Unit tests for the I/O layer — verifies YAML parsing, config loading, drift state persistence, and audit log writing. Exists because parsers are the boundary between raw files and typed domain objects; malformed input, missing files, and schema violations must be caught here before they propagate into core logic.

Each parser has a corresponding test verifying its contracts. All filesystem access is mocked or uses minimal in-memory fixtures.
