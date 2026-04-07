# Unit Tests — Responsibility

Pure function unit tests mirroring the `src/` directory structure. All I/O is mocked or stubbed — no filesystem side effects. Child nodes split by domain: core operations, context pipeline, CLI wrappers, and support modules (I/O parsers, formatters, templates, utils).

Does not cover multi-layer pipeline testing (integration), black-box binary invocation (e2e), or test fixtures.
