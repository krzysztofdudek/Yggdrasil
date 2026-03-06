# Determinism

Every component tagged `deterministic` must produce identical output for identical input. Same graph state → same context package, same validation result, same drift report. No heuristics, no repository search beyond declared mappings. No network calls. Git operations (e.g. findChangedNodes) are deterministic relative to repo state. Token estimation uses fixed heuristic (~4 chars/token). Hash algorithms use SHA-256. No Math.random or Date.now in core logic.
