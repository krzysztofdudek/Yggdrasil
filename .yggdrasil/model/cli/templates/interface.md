# Templates Interface

Public API consumed by cli/commands/init.

## default-config.ts

- `DEFAULT_CONFIG: string` — YAML string for default config.yaml (name, stack, standards, tags, node_types, artifacts, knowledge_categories, quality)

## platform.ts

- `installRulesForPlatform(projectRoot: string, platform: Platform): Promise<string>`
  - Writes Yggdrasil rules to platform-specific location. Returns absolute path to rules file. Unknown platform uses generic.
- `PLATFORMS: Platform[]` — supported platforms
- `Platform` — type: cursor, claude-code, copilot, cline, roocode, codex, windsurf, aider, gemini, amp, generic

Platform paths: Cursor (.cursor/rules/yggdrasil.mdc), Claude Code (CLAUDE.md + import), Copilot (.github/copilot-instructions.md), Cline (.clinerules/yggdrasil.md), RooCode (.roo/rules/yggdrasil.md), Codex (AGENTS.md), Windsurf (.windsurf/rules/yggdrasil.md), Aider (.aider.conf.yml), Gemini (GEMINI.md), Amp (AGENTS.md), generic (.yggdrasil/agent-rules.md).

## rules.ts

- `AGENT_RULES_CONTENT: string` — canonical agent rules (operating manual). Hand-tuned; do not generate programmatically. Used internally by platform.ts.

## graph-templates/

Directory (source/cli/graph-templates/) — node.yaml, aspect.yaml, flow.yaml, knowledge.yaml. Schemas for each graph layer. Copied to .yggdrasil/templates/ during init. Not imported directly; init reads via readdir/readFile.
