# Context Types Responsibility

Types for context assembly output — the structured data that `yg context` produces for agent consumption.

**In scope:** ContextPackage, ContextLayer, ContextSection, ContextSectionKey, ContextMapOutput, Glossary, BudgetBreakdown, and all reference types (AncestorRef, DependencyRef, RequiredAspectRef, NodeAspectRef, FlowRef, GlossaryAspectEntry, GlossaryFlowEntry).

**Out of scope:** Graph model types (cli/model/graph), context assembly logic (cli/core/context). No runtime behavior — types only.
