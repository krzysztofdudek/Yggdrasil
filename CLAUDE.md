@.yggdrasil/agent-rules.md
@AGENTS.md

## Release Status

No 4.0.0 release yet. All breaking changes go into 4.0.0 — no need for backwards compatibility shims or deprecation paths.

- **CHANGELOG:** All entries go under `## [4.0.0]`, not `[Unreleased]`. 4.0.0 mutates until release — there is no intermediate state to document. If a feature was added in 4.0.0 and then removed before release, delete the original entry entirely. The changelog should describe the final 4.0.0 state vs 3.x, not the development history within 4.0.0.
- **Code:** Same principle. If something was introduced in 4.0.0 development and later removed, just remove it — no deprecation shims, no migration paths, no backwards compatibility with earlier 4.0.0 iterations.

## Memory

Do NOT use the auto memory system. All persistent knowledge goes into CLAUDE.md or AGENTS.md — nowhere else.
