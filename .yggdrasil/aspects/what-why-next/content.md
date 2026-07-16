# What-Why-Next Messaging

Every diagnostic or error message that agents consume must follow the what/why/next structure. How this is expressed depends on the layer:

- **CLI command modules** (`cli/commands/`, `cli/cli/`): all agent-visible output must derive from structured `IssueMessage` data (`{ what, why, next }`). The standard path is to call `buildIssueMessage({ what, why, next })` when writing to `process.stderr.write` or constructing visible output strings. A CLI renderer that accesses `issue.messageData.what`, `issue.messageData.why`, and `issue.messageData.next` individually to render them with labels (e.g. `Why: ...` / `Fix: ...`) also satisfies this rule — what matters is that the output is derived from structured messageData, not hardcoded strings.
- **Engine modules** (`core/`, `ast/`, `io/`): return structured `messageData: IssueMessage` with `{ what, why, next }` fields populated. The CLI command layer calls `buildIssueMessage()` on them for presentation. Engine modules do NOT call `buildIssueMessage` — they are not the formatting layer.

## Rules

- Every agent-visible diagnostic (validation errors, unverified-pair reports, reviewer failures, context build failures) must have `what`, `why`, and `next` populated.
- The `next` field must contain a concrete runnable command or actionable instruction.
- Ad-hoc `Error: ${msg}` strings are acceptable ONLY for fatal/unexpected errors (I/O failures, missing arguments) where there is no remediation path beyond "fix the environment."
- The standardized ENOENT-from-loadGraph message `Error: No .yggdrasil/ directory found. Run 'yg init' first.` is exempt — this exact string is required by the `cli-command-contract` aspect and takes precedence.
- If a message guides agent remediation (telling the agent what to do next), it MUST use the structured format.
- Engine modules satisfy this aspect by populating `messageData: IssueMessage` on returned result objects — not by calling `buildIssueMessage`. The CLI command handler is where rendering happens.
- `throw new Error(msg)` in engine modules is exempt — throws are internal signals caught by the CLI command handler, which is responsible for formatting the output. The exception message does not need what/why/next structure.
- `AspectResponse.reason` and `AspectViolation.reason` fields are reviewer assessment outputs — they carry the LLM's evaluation of why code satisfies or violates an aspect. These are not CLI diagnostic messages; they flow from the LLM back into the verdict lock and are rendered as part of structured `CheckIssue.messageData` by the CLI layer. They are explicitly exempt from the what/why/next requirement.
- **Commander argument-parser validation errors are exempt.** An `InvalidArgumentError` thrown from a Commander option-value parser (e.g. `--port must be an integer`) is the framework's arg-parsing layer, not the command's diagnostic surface; these short validation strings are the CLI's convention and are exempt. Diagnostics from the command's action body are not.
- **Read-only report / attention / findings output is exempt.** Output whose purpose is to present findings, an outcome, a dashboard, or a listing as the command's result — attention items, per-case replay/simulation outcome lines, a metrics dashboard, a rendered view — is report content, not a diagnostic, even when a line carries a suggestion. The command's genuine error/failure paths (bad argument, missing graph, infra failure, blocking refusal) are NOT report output and must still be structured. The test: a RESULT the user requested (exempt) vs. something the user attempted that FAILED and must be fixed (structured).
