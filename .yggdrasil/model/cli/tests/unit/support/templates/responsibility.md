# Templates Unit Tests — Responsibility

Guards that platform installation doesn't corrupt user files — multiple `yg init` runs must not duplicate rules imports in CLAUDE.md, GEMINI.md, or AGENTS.md. Deduplication is a key invariant because agents run init frequently. Guards that DEFAULT_CONFIG produces valid YAML — if the template breaks, every new project starts broken. Guards project name resolution from package.json with fallbacks for missing or generic names — so `yg init` always produces a meaningful project identifier.
