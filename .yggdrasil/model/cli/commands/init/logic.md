# Init Command Logic

## Flow

1. projectRoot = process.cwd(); yggRoot = .yggdrasil
2. **Check .yggdrasil exists**: stat(yggRoot)
   - If exists and not directory → exit 1
   - If exists and options.upgrade → upgradeMode = true
   - If exists and !upgrade → exit 1 "Use --upgrade to refresh rules only"
   - If ENOENT → proceed with full init
3. **Platform validation**: platform in PLATFORMS; else exit 1
4. **If upgradeMode**: installRulesForPlatform(projectRoot, platform); output "Rules refreshed"; return
5. **Full init**:
   - mkdir model, aspects, flows, knowledge/{decisions,patterns,invariants}, templates
   - Copy graph-templates/*.yaml to templates/
   - Write config.yaml (DEFAULT_CONFIG)
   - Write .gitignore (.journal.yaml, journals-archive/)
   - installRulesForPlatform(projectRoot, platform)

## installRulesForPlatform

- Platform-specific: writes rules to .cursor/rules/, AGENTS.md, .github/copilot-instructions.md, etc.
- Content from rules.ts template
