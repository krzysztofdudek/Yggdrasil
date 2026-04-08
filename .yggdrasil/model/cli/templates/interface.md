# Templates Interface

## `AGENT_RULES_CONTENT: string`

Canonical agent rules (operating manual). Hand-tuned; do not generate programmatically. Used internally by platform.ts.

## `DEFAULT_CONFIG: string`

YAML string for default yg-config.yaml — node types (module, service, library, infrastructure), quality thresholds. No artifacts section (hardcoded as STANDARD_ARTIFACTS in cli/model).

## `DEFAULT_ARCHITECTURE: string`

YAML string for default yg-architecture.yaml — node types with descriptions, optional aspects/relations per type.

## `installRulesForPlatform(projectRoot, platform): Promise<string>`

Writes rules to platform-specific location. Returns absolute path to rules file. Unknown platform falls through to generic.

## `PLATFORMS: Platform[]`

Supported platforms: cursor, claude-code, copilot, cline, roocode, codex, windsurf, aider, gemini, amp, generic.

## Failure Modes

- `installRulesForPlatform`: may throw on mkdir/writeFile failures (ENOENT, EACCES).
- `DEFAULT_CONFIG`, `AGENT_RULES_CONTENT`: pure strings, no runtime errors.
