# Utils Unit Tests — Responsibility

Unit tests for general utility modules in `src/utils/`. Verifies helper functions for git integration, hashing, path manipulation, tokenization, and token counting.

## Scope

- `git.test.ts` — git utility helpers (branch detection, repo root)
- `hash.test.ts` — file content hashing
- `paths.test.ts` — path normalization and resolution utilities
- `tokenizer.test.ts` — text tokenization for token budget calculations
- `tokens.test.ts` — token counting and budget enforcement

## Out of scope

- I/O parser tests — belongs to `cli/tests/unit/support/io`
- Template generation tests — belongs to `cli/tests/unit/support/templates`
