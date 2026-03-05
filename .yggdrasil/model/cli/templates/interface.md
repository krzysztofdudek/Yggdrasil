# Templates Interface

Public API consumed by cli/commands/init.

## default-config.ts

- `DEFAULT_CONFIG: string` — YAML string for default config.yaml (name, node_types with module/service/library/infrastructure, 3 artifacts: responsibility.md, interface.md, internals.md, quality thresholds)

## platform.ts

- `installRulesForPlatform(projectRoot: string, platform: Platform): Promise<string>`
  - Writes Yggdrasil rules to platform-specific location. Returns absolute path to rules file. Unknown platform uses generic.
- `PLATFORMS: Platform[]` — supported platforms
- `Platform` — type: cursor, claude-code, copilot, cline, roocode, codex, windsurf, aider, gemini, amp, generic

Platform paths: Cursor (.cursor/rules/yggdrasil.mdc), Claude Code (CLAUDE.md + import), Copilot (.github/copilot-instructions.md), Cline (.clinerules/yggdrasil.md), RooCode (.roo/rules/yggdrasil.md), Codex (AGENTS.md), Windsurf (.windsurf/rules/yggdrasil.md), Aider (.aider.conf.yml), Gemini (GEMINI.md), Amp (AGENTS.md), generic (.yggdrasil/agent-rules.md).

## rules.ts

- `AGENT_RULES_CONTENT: string` — canonical agent rules (operating manual). Hand-tuned; do not generate programmatically. Used internally by platform.ts. Includes enrichment priority guidance (interface.md first, then responsibility.md, then internals.md), aspect stability tiers (schema/protocol/implementation) with review urgency calibration, code anchors guidance, and `--method` flag in CLI reference.

## graph-schemas/

Directory (source/cli/graph-schemas/) — node.yaml, aspect.yaml, flow.yaml. Schemas for each graph layer. Copied to .yggdrasil/schemas/ during init. Not imported directly; init reads via readdir/readFile.

## Failure Modes

- **installRulesForPlatform:** May throw on mkdir/writeFile failures (ENOENT, EACCES). Unknown platform falls through to generic.
- **DEFAULT_CONFIG, AGENT_RULES_CONTENT:** Pure strings — no runtime errors.
- **graph-schemas copy:** init catches and reports warning; does not fail init.
