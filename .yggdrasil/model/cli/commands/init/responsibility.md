# Init Command Responsibility

**In scope:** `yg init` — bootstrap Yggdrasil graph in current project.

**Full init (when .yggdrasil/ does not exist):**

- Create directories: .yggdrasil/model, aspects, flows, knowledge (decisions, patterns, invariants), templates. mkdir recursive.
- getGraphTemplatesDir(): from import.meta.url, package root = parent of cli dir, join packageRoot, 'graph-templates'.
- Copy graph-templates: readdir, filter files, copy each to .yggdrasil/templates. On failure: write warning to stderr, continue (do not exit).
- Write config.yaml (DEFAULT_CONFIG), .gitignore (GITIGNORE_CONTENT: .journal.yaml, journals-archive/).
- installRulesForPlatform(projectRoot, platform).
- Output created paths and next steps.

**Upgrade mode (--upgrade when .yggdrasil/ exists):**

- stat(.yggdrasil). If not directory: exit 1 "Error: .yggdrasil exists but is not a directory."
- If exists and no --upgrade: exit 1 "Error: .yggdrasil/ already exists. Use --upgrade to refresh rules only."
- If --upgrade: installRulesForPlatform only. Output "✓ Rules refreshed." and rules path. Return.

**Platform validation:** (options.platform ?? 'generic') as Platform. If not in PLATFORMS: exit 1 "Error: Unknown platform '${platform}'. Use: ${PLATFORMS.join(', ')}".

**Uses:** path.join(projectRoot, '.yggdrasil') directly; does not use findYggRoot.

**Consumes:** DEFAULT_CONFIG, installRulesForPlatform, PLATFORMS, Platform (cli/templates).

**Out of scope:** Graph loading, validation, drift.
