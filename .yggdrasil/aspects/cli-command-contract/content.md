# CLI Command Contract

Every CLI command handler follows these conventions:

## Output routing

- Results to stdout via `process.stdout.write()`. Never `console.log`.
- Errors exclusively to stderr via `process.stderr.write()`.
- Chalk color semantics: green = ok/success, red = error/failure, yellow = warning, dim = suppressed/hidden.

## Error handling

- Every command action body is wrapped in try/catch.
- Catch block uses ONE of these forms:
  - `abortOnUnexpectedError(error, '<context>')` (canonical — emits a structured what/why/next via `buildIssueMessage`).
  - `process.stderr.write(`Error: ${buildIssueMessage({ what, why, next })}\n`)` then `process.exit(1)` for command-specific errors that need bespoke wording.
  - Raw `process.stderr.write(`Error: ${(error as Error).message}\n`) + process.exit(1)` is permitted ONLY when the surrounding code has already routed the message through `buildIssueMessage` upstream (rare).
- The missing-graph case is handled by `loadGraphOrAbort` (see **Graph loading** below) — commands do NOT inline a `'No .yggdrasil/ directory found'` string or ENOENT branch themselves.
- Constant-text command errors (option-mutex violations, "node not found", "unknown topic", etc.) wrap the message in `buildIssueMessage` inline — they do NOT route through `abortOnUnexpectedError` (which is for genuinely unexpected errors).

## Exit codes

- `process.exit(1)` on failure (thrown error).
- `process.exit(1)` on actionable state (unverified pairs, aspect violations, validation errors).
- Implicit exit 0 when no issues. Warnings alone do not trigger exit 1.

## Graph loading

- Commands requiring graph state start with `await loadGraphOrAbort(process.cwd())` (from `formatters/cli-preamble.js`).
- `loadGraphOrAbort` writes the canonical what/why/next missing-graph error to stderr and `process.exit(1)`s on ENOENT-shaped loader failures, then rethrows any other error so the surrounding try/catch handles it.
- The bootstrap command `init` is the only exception to starting with `loadGraphOrAbort`: it must be able to run when no `.yggdrasil/` exists (and its `--upgrade` path may migrate a graph that predates the current format), so it cannot load the graph first. Instead its `--upgrade` path delegates the missing-graph guard to the shared `abortUnlessYggdrasilExists` helper — a `stat`-based existence check on `.yggdrasil/` that, when the directory is absent, writes the canonical what/why/next missing-graph error via `buildIssueMessage` and `process.exit(1)`s. Because that helper (not the command body) owns the missing-graph string and the ENOENT-shaped branch, `init` calls no `loadGraph`, inlines no missing-graph string, and needs no suppression — it still satisfies the no-inlined-string rule above.

## Node path normalization

- Commands accepting `--node <path>` normalize with: `options.node.trim().replace(/\/$/, '')`.

## File path normalization

- Commands accepting `--file <path>` resolve it via `resolveFileArg(repoRoot, options.file)` where `repoRoot = projectRootFromGraph(graph.rootPath)`. Never resolve relative to `process.cwd()` directly.
