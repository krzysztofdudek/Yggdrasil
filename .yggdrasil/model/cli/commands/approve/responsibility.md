# Approve Command Responsibility

CLI command handler implementing `yg approve` and the backward-compatible `yg drift-sync` alias. Orchestrates graph loading, delegates to `cli/core/approve`, and formats the result for the user.

## Scope

- **`registerApproveCommand(program)`** — registers two commands on the Commander instance:
  - `yg approve --node <path>` — primary command. Accepts `--reviewed <reason>` for conscious exceptions.
  - `yg drift-sync --node <path>` — deprecated alias. Accepts same options. Rejects `--all` and `--recursive` with a descriptive error.
- **Output formatting** — `formatResult` and `formatRefused` render all five outcome cases:
  - `approved` — green success line, hash transition (`prev -> curr`); if reviewer ran, shows verification summary ("N claims satisfied, N artifacts current")
  - `reviewed` — green with "Three-axis gate bypassed — reviewer not run (reason)" or "reviewer verified claims" depending on `llmSkipped`
  - `initial` — green with "(initial)" marker
  - `no-change` — plain output with "baseline already current. No approval needed."
  - `refused` — red error to stderr with contextual guidance per failure case (blackbox blocked, anti-laundering, unilateral graph artifact change, unilateral source change, cascade-only)
- **Node path normalization** — strips leading `./` and trailing `/` from `--node` value before passing to core.
- **Reviewer loading** — `loadLlmProvider` reads `llm` config field (populated from `reviewer:` yaml section) and `yg-secrets.yaml`, creates provider, checks `isAvailable()`. Returns `llmNotConfigured: true` when no reviewer section exists, `llmNotConfigured: false` with `provider: undefined` when provider is unreachable.
- **Reviewer skip messaging** — `formatLlmResults` shows distinct messages based on `llmSkipped` reason:
  - `'not-configured'` — "Reviewer not configured — claims not verified. Structural checks only. To enable: add reviewer section to yg-config.yaml."
  - `'unavailable'` — "Reviewer configured but not reachable — claims not verified. Structural checks only."
  - `'blackbox'` — "Reviewer skipped for blackbox node."
- **GC reporting** — prints orphaned drift state removals as dim lines.

## Failure modes handled

- `antiLaunderingBlocked` — explains that blackbox cannot cover already-tracked files, instructs decomposition
- `blackboxBlocked` + `reviewedAttempted` — explains `--reviewed` is unavailable for blackbox source changes
- `blackboxBlocked` — lists changed source files, gives 3-step decomposition instructions
- Source changed, graph artifacts unchanged — lists changed source files + unchanged artifacts, instructs update-then-approve
- Graph artifacts changed, source unchanged — lists changed artifacts + source files, instructs implement-then-approve
- Cascade only (other tracked changed) — lists upstream changes with annotation labels, gives compliant/non-compliant paths

## Out of scope

- The three-axis decision logic and drift state I/O (that is `cli/core/approve`)
- Graph loading from disk (that is `cli/core/loader`)
- Hash computation (that is `cli/utils`)
