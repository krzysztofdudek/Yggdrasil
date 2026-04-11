# Loader Responsibility

Single entry point for materializing the graph from disk — every command that needs graph state goes through `loadGraph`. Exists because the graph is the foundation all operations depend on, and its loading must be consistent, error-tolerant, and centralized.

The core design principle: one bad node must not prevent diagnosing the rest. This drives the choice to collect errors rather than throw — if loading failed on the first broken YAML, the agent couldn't run `yg check` to find out what's wrong. Hard vs soft failure asymmetry: `model/` missing throws with an actionable message ("Run yg init first") because the graph is required, while `aspects/`, `flows/`, and `schemas/` missing silently return empty because they are optional parts of graph structure. The `tolerateInvalidConfig` option enables a partial-load mode using a fallback config — exists so `yg check` can run even when config is broken.
