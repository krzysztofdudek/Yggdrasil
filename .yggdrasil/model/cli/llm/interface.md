# LLM Provider — Interface

**Provider factory:** `createLlmProvider(config)` — returns an `OllamaProvider` or `ClaudeCodeProvider` based on `config.provider`. Throws on unknown provider name.

**Connectivity check:** `isAvailable()` — callers invoke before verification to avoid spending time on a provider that cannot respond.

**Context window:** `getContextWindowSize()` — meaningful for API providers (Ollama reads from model info API); always returns `undefined` for CLI providers (claude-code). Callers use this to compute safe chunk sizes when `needsChunking` is true.

## Aspect verification

`verifyAspects(params)` — checks whether source files satisfy an aspect. Returns `{ satisfied: boolean, reason: string }`. Uses consensus voting across multiple calls; majority wins. API providers (Ollama) receive source content inlined in the request body; chunk size is computed from `getContextWindowSize()`. CLI providers (claude-code) receive file paths; the subprocess reads files directly — no chunking needed.

## Artifact review

`reviewArtifacts(params)` — checks whether an artifact is current. Returns `{ current: boolean, reason: string }`. API providers receive file content in chunks; the first stale result short-circuits remaining chunks. CLI providers issue a single call with file paths; no chunking.

## Provider capability flag

`needsChunking: boolean` — `true` for API providers, `false` for CLI providers. Callers adapt their strategy from this flag before invoking verification or review.

## Failure contract

All verification and review calls return safe fallbacks (`satisfied: false` / `current: false`) rather than throwing. Callers never need try/catch around verify or review calls.

## Failure Modes

- Unknown provider name: throws from factory.
- Provider unavailable or timed out: verification and review return fallback responses.
