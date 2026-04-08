# What-Why-Next Messaging

Every diagnostic or error message that agents consume must follow the what/why/next structure using `buildIssueMessage({ what, why, next })`.

## Rules

- Agent-visible error output (validation errors, drift reports, approval failures, context build failures) must use `buildIssueMessage`.
- The `next` field must contain a concrete runnable command or actionable instruction.
- Ad-hoc `Error: ${msg}` strings are acceptable ONLY for fatal/unexpected errors (ENOENT, I/O failures, missing arguments) where there is no remediation path beyond "fix the environment."
- If a message guides agent remediation (telling the agent what to do next), it MUST use the structured format.
- This aspect applies to `process.stderr.write` output only — not to `throw new Error()`. Throws are internal; the CLI command handler catches them and formats the output. The formatting layer is where what/why/next applies.
