# Formatters Interface

Public API consumed by cli/commands/build-context.

## context-text.ts (YAML format)

- `formatContextYaml(data: ContextMapOutput): string`
  - Converts a `ContextMapOutput` to YAML (paths-only mode, default output format).
  - Input: `ContextMapOutput` from cli/model.
  - Output: YAML string. Top-level keys: `meta`, `project`, `node`, `hierarchy` (omitted if empty), `dependencies` (omitted if empty), `artifacts`.
  - Uses `yaml` library's `stringify` with `lineWidth: 0` (no wrapping).
  - Pure transformation — no I/O, no validation.

- `formatFullContent(files: Array<{ path: string; content: string }>): string`
  - Formats file contents for `--full` mode, appended after the YAML section.
  - Input: array of file path/content pairs.
  - Output: `---` separator followed by each file wrapped in XML-style tags (`<path>content</path>`). Returns empty string if no files.
  - Pure transformation — no I/O, no validation.

## markdown.ts (legacy)

- `formatContextMarkdown(pkg: ContextPackage): string`
  - Converts a context package to Markdown. Used by tests.
  - Output: Markdown with `##` sections, `###` layer labels.

## message-builder.ts

- `buildIssueMessage(msg: IssueMessage): string`
  - Constructs a structured diagnostic message for CLI output.
  - Input: `IssueMessage` interface with three fields: `what` (what happened), `why` (why it matters), `next` (how to resolve).
  - Output: Single string with fields joined by single newlines; internal newlines within fields are preserved.
  - Pure transformation — no I/O, no validation.

- `IssueMessage` interface
  - `what: string` — Facts describing what happened (one line or short block).
  - `why: string` — Context explaining why the event is a problem.
  - `next: string` — Concrete command or instruction to resolve.

## Failure Modes

No thrown errors — pure transformation. Callers must ensure valid input.

- Invalid or malformed input may produce incomplete or misleading output; no validation is performed.
- No I/O — no filesystem or network errors.
- No recovery behavior — caller responsibility.
