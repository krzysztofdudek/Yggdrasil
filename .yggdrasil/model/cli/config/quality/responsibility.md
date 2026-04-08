# Quality Config — Responsibility

Defines the quality floor every contributor must meet. `no-explicit-any` is a warning (not error) to allow exploratory code during development without blocking CI. Branch coverage threshold is intentionally lower than other metrics because thin Commander.js wrappers and LLM stubs are excluded from coverage — raising it would force meaningless test scaffolding. Changes here affect every contributor and CI run.
