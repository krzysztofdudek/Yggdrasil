# Integration Tests — Responsibility

Integration tests that verify CLI commands work end-to-end against real graph fixtures. Exists because unit tests cannot catch regressions that emerge from the interaction of multiple layers — filesystem access, graph loading, validation, and output formatting combined in a single command invocation.

Each test exercises a full vertical slice through the system using a temp-copy fixture project. Does not test isolated functions in memory (unit tests) or black-box binary invocation (e2e tests).
