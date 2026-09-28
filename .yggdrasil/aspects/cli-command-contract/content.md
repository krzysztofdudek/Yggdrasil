# CLI Command Contract

Every CLI command handler follows these conventions. How a command prints, and the form of its errors, belong to other rules that already hold every command file: `output-through-layer` (every byte through the output layer — `writeOut` / `writeErr`, `fail` / `failAndExit` / `notice` / `warn`; no stream write, `console.*` or chalk), `command-error-via-buildissuemessage` (an error, notice or warning in the one lowercase what / why: / next: grammar), `no-raw-process-exit` and `command-exit-codes` (how and with which code a command ends). This rule does not restate them; it covers what none of them checks.

## Error handling

- Every command action body is wrapped in try/catch.
- The catch block ends in `abortOnUnexpectedError(error, '<context>')` from `cli/preamble.ts` (the canonical what / why / next for an error nobody anticipated), or in `failAndExit(...)` with a diagnostic of the command's own when the error is one the command expects and can word better.
- Constant-text command errors (option-mutex violations, "node not found", "unknown topic", etc.) are raised where they happen with `failAndExit` and a what / why / next of their own — they do NOT route through `abortOnUnexpectedError`, which is for genuinely unexpected errors.
- The missing-graph case is handled by `loadGraphOrAbort` (see **Graph loading** below) — commands do NOT inline a `'No .yggdrasil/ directory found'` string or an ENOENT branch themselves.

## Exit codes

- Exit 1 on failure (a thrown error) and on an actionable state (unverified pairs, rule violations, validation errors).
- Exit 0 when there is nothing to act on. Warnings alone do not make it 1.

## Graph loading

- Commands requiring graph state start with `await loadGraphOrAbort(process.cwd())` (from `cli/preamble.ts`).
- `loadGraphOrAbort` writes the loader's what / why / next and exits 1 on every failure the loader classifies as a `GraphLoadError` (a missing graph — the canonical missing-graph error — an unreadable schema version, a broken flow file), then rethrows any other error so the surrounding try/catch handles it.
- Two BOOTSTRAP commands are exempt from starting with `loadGraphOrAbort`, and only these two — `init` and `adopt`. Both must be able to run when no `.yggdrasil/` exists: `init` creates one, `adopt` accepts one. Neither can therefore load the repository's graph first, and neither inlines a missing-graph string or an ENOENT branch of its own.
  - `init`'s `--upgrade` path delegates the missing-graph guard to the shared `abortUnlessYggdrasilExists` helper (`cli/preamble.ts`) — a `stat`-based existence check on `.yggdrasil/` that, when the directory is absent, writes the canonical what / why / next missing-graph error and exits 1. Because that helper (not the command body) owns the missing-graph string and the ENOENT-shaped branch, `init` needs no suppression — it still satisfies the no-inlined-string rule above. The `loadGraph` calls `init` makes after the upgrade has run are best-effort predictions, not a guard: a graph that does not load yields no prediction and is logged with `debugWrite`, never an error.
  - `adopt` is handed the graph it is to accept, so an absent `.yggdrasil/` is the ORDINARY case rather than an error: it reads the proposed graph from the directory it was given (with the same `loadGraph` every check uses, so a proposal that will not load is refused for the same reason a check would refuse it) and opens the repository's own only after moving the accepted graph into place. Every refusal it can reach before that — an unrecognizable proposal directory, a graph already present, a proposal that does not load or does not hold together — is its own, specific and constant-text, and each is raised inline exactly as the rule above requires.

## Node path normalization

- Commands accepting `--node <path>` normalize with: `options.node.trim().replace(/\/$/, '')`.

## File path normalization

- Commands accepting `--file <path>` resolve it via `resolveFileArg(repoRoot, options.file)` where `repoRoot = projectRootFromGraph(graph.rootPath)`. Never resolve relative to `process.cwd()` directly.
