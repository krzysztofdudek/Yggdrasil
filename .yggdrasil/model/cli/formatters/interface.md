# Formatters Interface

## `formatContextYaml(data: ContextMapOutput): string`

Converts structured context map to YAML. Top-level keys: `meta`, `project`, `node`, `hierarchy`, `dependencies`, `artifacts`. Empty optional sections omitted. Uses `lineWidth: 0` (no wrapping).

## `formatNodeContext(data: NodeContextData): string`

Node context as structured text for `yg context --node`. Sections: header, source files, aspects, flows, dependencies, dependents (with blast radius vocabulary: HIGH 11+, Moderate 6-10), parent, artifacts, token budget.

## `formatFileContext(data: FileContextData): string`

File context as structured text for `yg context --file`. Unmapped files show candidate nodes with actionable guidance.

## `formatFullContent(files: Array<{ path, content }>): string`

File contents for `--full` mode. Each file wrapped in XML-style `<path>` tags, separated from YAML by `---`. Empty string if no files.

## `buildIssueMessage(msg: IssueMessage): string`

Structured diagnostic message from `{ what, why, next }`. Fields joined by newlines.

## Failure Modes

No thrown errors — pure transformation. Invalid input may produce incomplete output.
