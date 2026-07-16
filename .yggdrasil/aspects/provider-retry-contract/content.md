# Provider Retry Contract

LLM provider implementations must be resilient to transient errors and must not expose raw exceptions to callers.

## Rules

- All HTTP requests go through `apiFetch()` from `llm/api-utils.ts`, which handles 429 rate-limit retry with 2-second backoff. Providers must not implement their own retry loops.
- `verifyAspect(prompt)` must catch all errors internally and return a fallback `AspectResponse` object (e.g., `{ satisfied: false, reason: '...', providerError: true }`) rather than letting exceptions propagate to the caller.
- Providers must not retry on authentication failures (4xx errors other than 429) — these are configuration errors, not transient failures.
- `isAvailable()` must return a boolean and never throw — it is used as a lightweight health check.

## Subprocess-based providers

CLI-based providers (claude-code, codex, gemini-cli) spawn child processes via `cli-base.ts`. These providers satisfy this aspect by extending `CliAgentProvider` without overriding its error handling — the base class implements `verifyAspect()` and `isAvailable()`. A CLI provider file that simply extends `CliAgentProvider` and registers itself is compliant; the base-class error handling is verified at the `cli/llm/subprocess-base` node level.

## Rationale

The reviewer calls `verifyAspect()` for every node × aspect pair. A single throwing provider would abort an entire batch. The fallback pattern ensures partial success is preserved even when one provider call fails.
