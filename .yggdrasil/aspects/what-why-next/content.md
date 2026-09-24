# What-Why-Next Messaging

Every diagnostic or error message that agents consume answers three questions — what happened, why it matters, what to do next — and is printed in the CLI's one output grammar. How this is expressed depends on the layer:

- **CLI command modules** (`cli/commands/`, `cli/cli/`): all agent-visible output is derived from structured data (`IssueMessage` `{ what, why, next }`, a `Diagnostic`, or a check finding's `messageData`) and rendered through the CLI output layer (`fail` / `failAndExit` for a command error, `notice` for a note, `warn` for a non-fatal problem, `block`, `field`, `heading`, `next`, `then`, `note`) or `buildIssueMessage`. Those render the one grammar:
  - a command error: `error[<code>]: <what>`, then an indented `why:  <why>`, then `next: <step>`;
  - a report finding: a heading `<severity>[<label>] <subject>`, then indented labelled fields `at:`, `why:`, `fix:` — always labelled, always lowercase, the why stated once per block;
  - a report's last lines: `next: <step>` and optionally `then: <step>`.
- **Engine modules** (`core/`, `ast/`, `io/`): return structured `messageData: IssueMessage` with `{ what, why, next }` fields populated. The CLI layer renders them. Engine modules do NOT call `buildIssueMessage` — they are not the formatting layer.

## Rules

- Every agent-visible diagnostic (validation errors, unverified-pair reports, reviewer failures, context build failures) must have `what`, `why`, and `next` populated.
- The `next` field — and every `next:` line — names a concrete runnable command (`yg …`) or an imperative that names a concrete location (`edit src/a.ts:1`, `Fix the YAML in .yggdrasil/model/app/yg-node.yaml`). A placeholder is allowed only for a value a person must supply (`<why this change was made>`); a value the CLI knows (the node, the file, the user's own flags) is filled in. A `next` that merely restates the finding's code (`Fix yaml-invalid in app`) or repeats its fix word for word is a violation.
- Output written in the old grammar is a violation: a capitalised `Why:` / `Fix:` / `Next:` / `Then:` label, an `Error:` / `Notice:` / `Warning:` prefix, an unlabelled why line under a finding, or a finding laid out by hand instead of through the output layer.
- Human sign-off is always phrased as "ask the user to approve …". "You" in output means the operator (an agent as often as a person); "your approval" is a violation, because an agent reads it as licence to approve.
- The ENOENT-from-loadGraph missing-graph message is produced by `loadGraphOrAbort` through the output layer (`error[graph-missing]: No .yggdrasil/ directory found. Run 'yg init' first.`); commands do not inline it.
- If a message guides agent remediation (telling the agent what to do next), it MUST use the structured format.
- Engine modules satisfy this aspect by populating `messageData: IssueMessage` on returned result objects — not by calling `buildIssueMessage`. The CLI command handler is where rendering happens.
- `throw new Error(msg)` in engine modules is exempt — throws are internal signals caught by the CLI command handler, which is responsible for formatting the output. The exception message does not need what/why/next structure.
- `AspectResponse.reason` and `AspectViolation.reason` fields are reviewer assessment outputs — they carry the reviewer's evaluation of why code satisfies or violates an aspect. These are not CLI diagnostic messages; they flow back into the verdict lock and are rendered as part of structured `CheckIssue.messageData` by the CLI layer. They are explicitly exempt from the what/why/next requirement.
- **Argument-parser validation errors** (an `InvalidArgumentError` thrown from a Commander option-value parser, an unknown option) are routed through the output layer by the help module, which reports them as `error[usage]: …` with a `next:` naming the command's `--help`. The short validation strings themselves are exempt from carrying a why.
- **Read-only report / attention / findings output**: a RESULT the user requested (a listing, a dashboard, per-case outcome lines, an attention feed) is report content, not a diagnostic, and need not be a what/why/next triple — but where it presents a finding it uses the block template (heading, `at:` / `why:` / `fix:`), and where it names a next step it writes `next:` in lowercase. The command's genuine error/failure paths (bad argument, missing graph, infra failure, blocking refusal) are NOT report output and must be structured.
