# Formatters Interface

Public API consumed by cli/commands/validation (build-context).

## markdown.ts

- `formatContextMarkdown(pkg: ContextPackage): string`
  - Converts a context package to Markdown.
  - Input: `ContextPackage` from cli/model (nodePath, nodeName, layers, sections, mapping, tokenCount).
  - Output: Markdown string.
  - Header: `# Context Package: ${pkg.nodeName}`, `# Path: ${pkg.nodePath}`, `# Generated: ${new Date().toISOString()}`, `---`.
  - For each section in pkg.sections: if section.layers.length > 0, emit `## ${section.key}`, then for each layer `### ${layer.label}`, layer.content, double newline.
  - Footer: `Context size: ${pkg.tokenCount.toLocaleString()} tokens`, `Layers: ${pkg.layers.map(l => l.type).join(', ')}`.
  - Skips sections where layers.length === 0.
  - Pure transformation — no I/O, no validation.
