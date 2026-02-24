# Build Context Flow

End-to-end flow for `yg build-context`: assemble a context package for a node.

**Sequence:** commands/validation (orchestrates) → loader (load graph) → validator (structural errors block) → context (10-step assembly) → formatters (Markdown output).

**Participants:**

- `cli/commands/validation` — orchestrates loadGraph, validate, buildContext, formatContextMarkdown
- `cli/core/loader` — loads graph from `.yggdrasil/`
- `cli/core/validator` — structural checks; build-context blocks if any errors
- `cli/core/context` — 10-step layer assembly (global, knowledge, hierarchy, own, relational, aspects, flows)
- `cli/formatters` — formats context package as Markdown

**Output:** Markdown document to stdout; token count and budget status appended.
