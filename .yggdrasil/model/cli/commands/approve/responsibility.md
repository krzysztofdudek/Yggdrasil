# Approve Command Responsibility

CLI command handler implementing `yg approve` and the backward-compatible `yg drift-sync` alias. Orchestrates graph loading, delegates to `cli/core/approve`, and formats the result for the user.

## Scope

- **`registerApproveCommand(program)`** — registers two commands on the Commander instance:
  - `yg approve --node <path>` — primary command. Accepts `--acknowledge <reason>` for conscious exceptions.
  - `yg drift-sync --node <path>` — deprecated alias. Accepts same options. Rejects `--all` and `--recursive` with a descriptive error.
- **Output formatting** — `formatResult` and `formatRefused` render all five outcome cases:
  - `approved` — green success line, hash transition (`prev -> curr`)
  - `acknowledged` — green with note about exception; special message for blackbox cascade
  - `initial` — green with "(initial)" marker
  - `no-change` — plain output with baseline confirmation
  - `refused` — red error to stderr with contextual guidance per failure case (blackbox blocked, anti-laundering, unilateral artifact change, unilateral source change, cascade-only)
- **Node path normalization** — strips leading `./` and trailing `/` from `--node` value before passing to core.
- **GC reporting** — prints orphaned drift state removals as dim lines.

## Failure modes handled

- `antiLaunderingBlocked` — explains that blackbox cannot cover already-tracked files, instructs decomposition
- `blackboxBlocked` + `acknowledgeAttempted` — explains `--acknowledge` is unavailable for blackbox source changes
- `blackboxBlocked` — lists changed source files, gives 3-step decomposition instructions
- Source changed, artifacts unchanged — lists changed source files + unchanged artifacts, instructs update-then-approve
- Artifacts changed, source unchanged — lists changed artifacts + source files, instructs implement-then-approve
- Cascade only (other tracked changed) — lists upstream changes with annotation labels, gives compliant/non-compliant paths

## Out of scope

- The three-axis decision logic and drift state I/O (that is `cli/core/approve`)
- Graph loading from disk (that is `cli/core/loader`)
- Hash computation (that is `cli/utils`)
