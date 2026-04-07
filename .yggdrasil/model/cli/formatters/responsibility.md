# Formatters Responsibility

CLI output formatting — converts structured data to human-readable text.

**In scope:**

- `formatContextYaml(data: ContextMapOutput): string` — converts structured context map to YAML for `yg build-context` output (primary)
- `formatFullContent(files): string` — formats file contents for `--full` mode, appended after YAML section
- `formatContextMarkdown(pkg: ContextPackage): string` — legacy Markdown format (used by tests)
- `buildIssueMessage(msg: IssueMessage): string` — structured diagnostic messages for CLI error/warning output
- Pure transformation — no I/O, no validation, deterministic (tag: deterministic)

**Out of scope:**

- Validation of input (callers must ensure valid input)
