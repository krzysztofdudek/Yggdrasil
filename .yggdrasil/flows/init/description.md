# Init Flow

End-to-end flow for `yg init`: create `.yggdrasil/` structure and platform integration.

**Sequence:** commands/init (orchestrates) → templates (DEFAULT_CONFIG, installRulesForPlatform, graph-templates).

**Participants:**

- `cli/commands/init` — orchestrates directory creation, config write, template copy, rules install
- `cli/templates` — DEFAULT_CONFIG, installRulesForPlatform, PLATFORMS, graph-templates

**Output:** List of created files; or (upgrade mode) path of refreshed rules file.
