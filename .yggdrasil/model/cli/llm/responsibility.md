# LLM Provider — Responsibility

Isolates the CLI from LLM backends so that providers can be swapped without changing callers. The approve command calls `verifyAspect` and `reviewArtifact` without knowing whether the LLM is a local Ollama instance or a Claude Code subprocess.

The key design split: CLI-based providers (claude-code) read source files themselves and don't need content inlined in prompts. API-based providers (ollama) need all content chunked into the prompt. The `needsChunking` flag on the provider interface lets callers (aspect-verifier, artifact-reviewer) adapt without knowing which backend is active.
