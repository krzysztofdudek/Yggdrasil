# Init Command Interface

**Command:** `yg init [--platform <name>] [--upgrade]`

**--platform:** Target agent platform for rules file placement. Defaults to `generic`. Supported: cursor, claude-code, copilot, cline, roocode, codex, windsurf, aider, gemini, amp, generic.

**--upgrade:** When `.yggdrasil/` exists, refreshes rules and schemas without touching graph content. Runs version migrations if project version < CLI version. Without `--upgrade`, init refuses to overwrite an existing project.

## Output Format

**Full init output:**

```
✓ Yggdrasil initialized.

Created:
  .yggdrasil/yg-config.yaml
  .yggdrasil/yg-architecture.yaml
  .yggdrasil/.gitignore
  .yggdrasil/yg-secrets.example.yaml
  .yggdrasil/model/
  .yggdrasil/aspects/
  .yggdrasil/flows/
  .yggdrasil/schemas/ (yg-config, yg-node, yg-aspect, yg-flow)
  <platform-rules-path> (rules)

Next steps:
  1. Edit .yggdrasil/yg-config.yaml — set name and configure node types
  2. Create nodes under .yggdrasil/model/
  3. Run: yg check
```

**Upgrade output:**

When migrations run (project version < CLI version):
```
Migrating from <old-version> to <new-version>...

  ✓ <migration-action>
  ⚠ <migration-warning>   ← only when warnings exist

✓ Rules refreshed.
  <platform-rules-path>
```

When already up to date (no migrations needed):
```
✓ Rules refreshed.
  <platform-rules-path>
```

## Failure Modes

- .yggdrasil/ exists without --upgrade: exit 1.
- .yggdrasil exists but is not a directory: exit 1.
- Unknown platform: exit 1.
- Schema copy failure: full init prints warning to stderr and continues; upgrade mode silently ignores the error and continues.
- Project version newer than CLI (upgrade only): warning to stderr, exit 1.
- Generic I/O errors: exit 1.
