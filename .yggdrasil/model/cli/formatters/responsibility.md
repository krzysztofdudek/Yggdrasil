# Formatters Responsibility

CLI output formatting — converts structured data to human-readable text.

**In scope:**

- `formatContextMarkdown(pkg: ContextPackage): string` — converts assembled context package to Markdown for `yg build-context` output
- Output structure: header (# Context Package, # Path, # Generated ISO timestamp), horizontal rule, sections (## key, ### layer.label, layer.content), footer (Context size, Layers)
- Skips sections where `section.layers.length === 0`
- Footer: token count with `toLocaleString()`, layer types joined by comma
- Pure transformation — no I/O, no validation, deterministic (tag: deterministic)

**Out of scope:**

- Building context package (cli/core/context)
- Console coloring (cli/commands)
- Validation of input (callers must ensure valid ContextPackage)
