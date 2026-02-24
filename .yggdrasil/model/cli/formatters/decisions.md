# Formatters Decisions

**Pure transformation:** Formatters perform no I/O and no validation. They receive structured data and produce text. This keeps the layer deterministic and testable — callers own input validity.

**Context output format:** The Markdown structure (header, sections, footer) is designed for agent consumption. Sections map to context layers; empty sections are skipped to avoid noise. Token count in footer supports context budget awareness.
