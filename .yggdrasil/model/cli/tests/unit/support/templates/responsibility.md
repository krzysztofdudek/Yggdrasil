# Templates Unit Tests — Responsibility

Tests for template generation modules in `src/templates/`. Covers default config content, platform-specific rules file generation, and project name auto-detection. Asserts on string output — no filesystem writes.

Does not test I/O parsers or utility functions — those belong to sibling nodes.
