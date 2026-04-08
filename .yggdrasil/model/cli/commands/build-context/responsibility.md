# Build Context Command Responsibility

The primary command in the graph-first workflow — agents run this before reading or modifying any mapped source file. Exists because agents need a single entry point that takes "I want to work on X" and returns all the constraints, dependencies, and rules that apply.

Blocks output when validation errors affect the node's context scope (own node, ancestors, relation targets). This protects the invariant that agents never receive a context package built from a structurally broken graph — partial or incorrect context leads to code that violates invisible constraints.

Also registered as `yg build-context` (legacy alias).
