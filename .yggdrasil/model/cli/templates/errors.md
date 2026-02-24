# Templates Errors

- **installRulesForPlatform:** May throw on mkdir/writeFile failures (ENOENT, EACCES). Unknown platform falls through to generic.
- **DEFAULT_CONFIG, AGENT_RULES_CONTENT:** Pure strings — no runtime errors.
- **graph-templates copy:** init catches and reports warning; does not fail init.
