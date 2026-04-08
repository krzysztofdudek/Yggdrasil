# LLM Provider — Responsibility

LLM backend boundary — shields the approve pipeline from knowing whether verification runs against a local API (Ollama) or a CLI subprocess (Claude Code). Callers invoke `verifyAspect` and `reviewArtifact` against a uniform interface regardless of provider.

The critical behavioral split: CLI-based providers (claude-code) read source files themselves via subprocesses — inlining file content into prompts would be redundant and wasteful. API-based providers (ollama) have no filesystem access, so all content must be chunked into the request. This split cannot be inferred from call sites — it is a constraint imposed by the provider runtime environment.
