# Loader Responsibility

Single entry point for materializing the graph from disk — every command that needs graph state goes through `loadGraph`. Exists because the graph is the foundation all operations depend on, and its loading must be consistent, error-tolerant, and centralized.

The core design principle: one bad node must not prevent diagnosing the rest. This drives the choice to collect errors rather than throw — if loading failed on the first broken YAML, the agent couldn't run `yg check` to find out what's wrong.
