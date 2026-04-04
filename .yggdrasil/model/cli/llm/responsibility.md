# LLM Provider — Responsibility

Provides a unified interface for interacting with LLM providers to verify architectural claims against source code and review artifact freshness.

## What This Module Does

- Defines the `LlmProvider` interface with two core operations: `verifyClaim` (check if source code satisfies an aspect claim) and `reviewArtifact` (check if documentation is current against source code)
- Implements the adapter pattern via `createLlmProvider()` factory, selecting the concrete provider based on `LlmConfig.provider` field
- Provides three provider implementations:
  - **OllamaProvider** — fully implemented; communicates with local Ollama API over HTTP, uses JSON format mode, retries once on failure, strips markdown code fences from responses
  - **OpenAIProvider** — stub; throws "not yet implemented"
  - **AnthropicProvider** — stub; throws "not yet implemented"
- Handles provider availability checking (`isAvailable`) and context window size detection (`getContextWindowSize`)
- Resolves max tokens from config, auto-detection, or safe fallback (4096)

## What This Module Is NOT Responsible For

- Constructing the source code snippets or aspect content passed to the LLM — that is the caller's responsibility (artifact-reviewer, claim-verifier in core)
- Deciding when to invoke LLM verification — that decision belongs to the check pipeline
- Managing LLM configuration — config comes from `LlmConfig` in the model layer
- Prompt engineering beyond the fixed system prompts for claim/artifact review
