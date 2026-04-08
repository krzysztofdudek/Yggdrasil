# LLM Provider — Interface

**`createLlmProvider(config: LlmConfig): LlmProvider`** — factory. Returns `OllamaProvider` or `ClaudeCodeProvider` based on `config.provider`. Throws on unknown provider name.

**`LlmProvider` interface:**

- `needsChunking: boolean` — `true` for API providers (Ollama): source content must be inlined in prompts. `false` for CLI providers (claude-code): provider reads files itself via subprocess. Callers adapt chunking strategy from this flag.
- `verifyAspect(params): Promise<AspectResponse>` — checks whether source files satisfy an aspect. Returns `{ satisfied: boolean, reason: string }`.
- `reviewArtifact(params): Promise<ArtifactResponse>` — checks whether an artifact is current. Returns `{ current: boolean, reason: string }`.
- `isAvailable(): Promise<boolean>` — connectivity check before invoking verification.
- `getContextWindowSize(): Promise<number | undefined>` — meaningful for Ollama (reads from model info API); always returns `undefined` for claude-code.

**Provider differences that matter to callers:**

- Ollama inlines source content into HTTP request bodies; chunking guards against context overflow. `getContextWindowSize()` enables callers to compute safe chunk sizes.
- claude-code spawns a subprocess (`claude --print`) with file paths in the prompt; no chunking needed. Fallback responses on spawn error or timeout prevent caller try/catch.

**Failure contract:** All verification calls return safe fallbacks (`satisfied: false` / `current: false`) rather than throwing. Callers never need try/catch around verify calls.

## Failure Modes

- Unknown provider name: throws from factory.
- Provider unavailable or timed out: verification returns fallback response.
