# Docs/Concept — Responsibility

The specification that the CLI implements. Changes here must be reflected in code — a spec change without a corresponding implementation change is a lie agents will follow. Split into six documents because each has different volatility and audience: tools.md changes with every feature, engine.md changes with every algorithm, graph.md is relatively stable. Separation prevents a small feature addition from creating a merge conflict with an unrelated algorithm change.
