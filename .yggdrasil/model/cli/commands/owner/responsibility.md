# Owner Command Responsibility

**In scope:** `yg owner --file <path>`. Resolves a source file to its owning graph node — the first step in the graph-first workflow before reading or modifying any file.

Distinguishes three outcomes: direct mapping (file explicitly listed), ancestor directory mapping (file covered by parent directory), and no coverage. The ancestor case guides the agent to use `yg context --node` since the file lacks its own mapping entry.

**Out of scope:** Context building, validation, drift detection.
