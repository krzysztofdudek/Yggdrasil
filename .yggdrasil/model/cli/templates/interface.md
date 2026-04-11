# Templates Interface

Adapter that transforms canonical rules content into platform-specific rules files. Three installation strategies:

- **Import-by-reference**: claude-code (appends `@.yggdrasil/agent-rules.md` to CLAUDE.md), aider (appends to `.aider.conf.yml` read list), gemini (appends to GEMINI.md), amp (appends to AGENTS.md). Rules content lives in one place; platform file points to it.
- **Inline embed**: cursor (MDC with frontmatter), copilot/codex (yggdrasil-fenced blocks supporting idempotent update). Rules content is embedded directly in platform-specific format.
- **Direct write**: cline, roocode, windsurf, generic. Rules content written directly to platform-specific file path.

**Edge case:** codex and amp both target `AGENTS.md` but use incompatible strategies (codex: inline-embed via fenced block, amp: import-by-reference). Running both platforms on the same repo would produce an AGENTS.md with both an inline embed and an import line pointing to the same content.

## Exports

- `installRulesForPlatform` — writes rules to platform-specific location, returns absolute path to the rules file. Reference-based strategies (claude-code, aider, gemini, amp) are idempotent: they check for the import line first and skip the write if already present, returning the rules path rather than the platform file path. Unknown platform falls through to generic.
- `resolveProjectName` — infers project name for `yg init` from package.json, handling scoped packages and generic bare names ("root", "app", "main", "monorepo", "workspace"), falls back to directory basename.
- `AGENT_RULES_CONTENT` — canonical agent rules string. Public export from rules.ts.
- `DEFAULT_CONFIG` — YAML string for default yg-config.yaml.
- `DEFAULT_ARCHITECTURE` — YAML string for default yg-architecture.yaml.
- `PLATFORMS` — supported platforms: cursor, claude-code, copilot, cline, roocode, codex, windsurf, aider, gemini, amp, generic.

## Failure Modes

- Platform installation may throw on mkdir/writeFile failures (ENOENT, EACCES).
- Config and rules exports are pure strings — no runtime errors.
