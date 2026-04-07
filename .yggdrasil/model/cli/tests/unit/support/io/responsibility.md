# I/O Unit Tests — Responsibility

Tests for the I/O parser layer in `src/io/`. Each parser has a 1:1 test file verifying YAML parsing contracts, schema validation, and graceful handling of missing or malformed files. All filesystem access is mocked or uses minimal in-memory fixtures.

Does not test template generation, utility functions, or formatters — those belong to sibling nodes.
