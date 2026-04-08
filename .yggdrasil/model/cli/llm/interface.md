# LLM Provider — Interface

**`createLlmProvider(config: LlmConfig): LlmProvider`** — factory function. Returns concrete provider based on `config.provider` ('ollama' or 'claude-code'). Throws on unknown provider.

**`LlmProvider` interface:**

- `needsChunking: boolean` — whether the provider needs source content inlined in prompts (true for API providers) or reads files itself (false for CLI providers). Callers use this to decide chunking strategy.
- `verifyAspect(params): Promise<AspectResponse>` — checks if source files satisfy an aspect. Params include `nodeContext` (pre-computed `yg context --node` output) so the reviewer has full graph understanding.
- `reviewArtifact(params): Promise<ArtifactResponse>` — checks if an artifact is current. Params include `nodeContext`, `nodeType`, and `qualityProfile` from architecture so the reviewer applies type-specific evaluation criteria.
- `isAvailable(): Promise<boolean>` — connectivity check.
- `getContextWindowSize(): Promise<number | undefined>` — for API providers to report model limits.

**Prompt structure:** Both providers use the same XML structure (`<role>`, `<rules>`, `<aspect>`, `<node>`, `<source-files>`, `<task>`). CLI providers receive file paths (self-closing `<file />` tags); API providers receive inline content. This standardization ensures consistent reviewer behavior regardless of backend.

**Provider contract:** All providers return structured JSON responses. On failure (timeout, parse error, unreachable), providers return safe fallback responses (`satisfied: false` / `current: false`) rather than throwing — callers never need try/catch around verification calls.

## Failure Modes

- Unknown provider name: throws from factory.
- Provider unavailable: `isAvailable()` returns false, verification calls return fallback.
