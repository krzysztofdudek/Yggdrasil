# CLI Command Unit Tests — Responsibility

Tests for the thin command wrappers in `src/cli/`. Verifies argument parsing and delegation to core modules without invoking full pipeline execution. Each test stubs or mocks the underlying core function.

Does not test core logic, full pipelines, or black-box binary invocation — those belong to core, integration, and e2e nodes respectively.
