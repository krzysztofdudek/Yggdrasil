# Context Core Unit Tests — Responsibility

Tests for the context assembly pipeline: graph loading, context file resolution, and context map construction. Includes snapshot tests to verify output stability across changes. Uses in-memory graph fixtures.

Does not test core operations (approve, check, drift, impact) — those belong to the operations sibling node.
