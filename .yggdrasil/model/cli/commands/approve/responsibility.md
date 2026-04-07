# Approve Command Responsibility

CLI command handler implementing `yg approve` and the backward-compatible `yg drift-sync` alias. Orchestrates graph loading, delegates to `cli/core/approve`, and formats the result for the user.

## Scope

- **`registerApproveCommand(program)`** — registers two commands on the Commander instance:
  - `yg approve` — primary command with three target modes:
    - `--node <paths...>` — one or more node paths (variadic). Single node: direct approve. Multiple: batch. No-mapping parent: redirects to batch children.
    - `--aspect <id>` — batch approve all E021 cascade nodes from this aspect.
    - `--flow <name>` — batch approve all E021 cascade nodes from this flow.
    - Exactly one of `--node`, `--aspect`, `--flow` required (mutually exclusive).
    - Accepts `--reviewed <reason>` for conscious exceptions.
  - `yg drift-sync --node <path>` — deprecated alias. Single-node only, no batch. Rejects `--all` and `--recursive`.
- **Batch approve** — `--aspect <id>`, `--flow <name>`, or `--node <path>` (no mapping) triggers batch mode:
  - Runs `classifyDrift()` to find E021 cascade issues
  - Filters by cause prefix matching the specified entity via `filterCascadeNodes`
  - Runs `runBatch` worker-pool semaphore with `parallel` concurrency from config
  - Formats batch output: per-node result lines + summary counts
  - Exit code: 1 if any refused, 0 if all approved/reviewed
- **Output formatting** — `formatResult` and `formatRefused` render all five outcome cases:
  - `approved` — green success line, hash transition (`prev -> curr`); if reviewer ran, shows verification summary ("N aspects satisfied, N artifacts current")
  - `reviewed` — green with "Three-axis gate bypassed — reviewer not run (reason)" or "reviewer verified aspects" depending on `llmSkipped`
  - `initial` — green with "(initial)" marker
  - `no-change` — plain output with "baseline already current. No approval needed."
  - `refused` — red error to stderr with contextual guidance per failure case (blackbox blocked, anti-laundering, unilateral graph artifact change, unilateral source change, cascade-only)
- **Node path normalization** — strips leading `./` and trailing `/` from `--node` value before passing to core.
- **Reviewer loading** — `loadLlmProvider` reads `llm` config field (populated from `reviewer:` yaml section) and `yg-secrets.yaml`, creates provider, checks `isAvailable()`. Returns `llmNotConfigured: true` when no reviewer section exists, `llmNotConfigured: false` with `provider: undefined` when provider is unreachable.
- **Reviewer skip messaging** — `formatLlmResults` shows distinct messages based on `llmSkipped` reason:
  - `'not-configured'` — "Reviewer not configured — aspects not verified. Structural checks only. To enable: add reviewer section to yg-config.yaml."
  - `'unavailable'` — "Reviewer configured but not reachable — aspects not verified. Structural checks only."
  - `'blackbox'` — "Reviewer skipped for blackbox node."
- **GC reporting** — prints orphaned drift state removals as dim lines.

## Failure modes handled

- `antiLaunderingBlocked` — explains that blackbox cannot cover already-tracked files, instructs decomposition
- `blackboxBlocked` + `reviewedAttempted` — explains `--reviewed` is unavailable for blackbox source changes
- `blackboxBlocked` — lists changed source files, gives 3-step decomposition instructions
- Source changed, graph artifacts unchanged — lists changed source files + unchanged artifacts, instructs update-then-approve
- Graph artifacts changed, source unchanged — lists changed artifacts + source files, instructs implement-then-approve
- Cascade only (other tracked changed) — lists upstream changes with annotation labels, gives compliant/non-compliant paths
