# Context Types Interface

Type library — exports TypeScript interfaces and type aliases only.

## Context Package

- **ContextPackage** — Assembled context: nodePath, nodeName, layers, sections, mapping, tokenCount.
- **ContextLayer** — Single layer: type, label, content, source, attrs.
- **ContextSection** — Grouped layers by key.
- **ContextSectionKey** — `'Global' | 'Hierarchy' | 'OwnArtifacts' | 'Aspects' | 'Relational'`

## Context Map (structured output)

- **ContextMapOutput** — Full structured output: meta (tokenCount, budgetStatus, breakdown), project, node, hierarchy, dependencies, glossary.
- **BudgetBreakdown** — Per-category token counts: own, hierarchy, aspects, flows, dependencies, total.
- **Glossary** — Index of aspects and flows with names/descriptions/files.
- **GlossaryAspectEntry** / **GlossaryFlowEntry** — Glossary entries.
- **RequiredAspectRef** — Required aspect: id, source.
- **NodeAspectRef** — Node aspect: id, exceptions.
- **FlowRef** — Flow reference: id.
- **AncestorRef** — Ancestor node: path, name, type, description, aspects, files.
- **DependencyRef** — Dependency: path, name, type, description, relation, consumes, failure, event-name, aspects, hierarchy, files.

## Failure Modes

Type library — no runtime errors.
