# Diagnostic Logging

Every catch block that handles an error without re-throwing must call `debugWrite()` with diagnostic context. Silent error swallowing creates invisible failures that make debugging impossible.

## Rules

- When a catch block returns a fallback value, continues a loop, or returns a default instead of re-throwing, it must call `debugWrite()`.
- The message must include: module identifier, operation name, error message, and raw response if applicable.
- Pattern: `debugWrite(\`[module] operation: ${error.message}\`)`
- This applies to: LLM provider responses, HTTP failures, file read fallbacks, JSON parse failures, subprocess errors.
- `debugWrite()` is a no-op when debug logging is not enabled — there is no performance cost.

## Depends on

The `debugWrite` function from `utils/debug-log.ts` (Plan 5). If not yet implemented, this aspect documents the requirement — code compliance will be verified once the module exists.
