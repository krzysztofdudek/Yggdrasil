# Init Flow

## Business context

Create `.yggdrasil/` structure for a new project or refresh platform rules for an existing one. First step for adopting Yggdrasil.

## Trigger

User runs `yg init [--platform <name>]` or `yg init --upgrade`.

## Goal

**Init:** Create `.yggdrasil/` with config, schemas, model structure. Install platform rules file. **Upgrade:** Refresh rules file only; leave existing structure intact.

## Participants

- `cli/commands/init` — orchestrates directory creation, config write, schema copy, rules install
- `cli/templates` — DEFAULT_CONFIG, installRulesForPlatform, PLATFORMS, graph-schemas

## Paths

### Happy path (new init)

`.yggdrasil/` does not exist. Init creates directories, writes config from DEFAULT_CONFIG, copies node/aspect/flow schemas, installs rules for platform. Output: list of created files.

### Happy path (upgrade)

`.yggdrasil/` exists; user passes `--upgrade`. Init refreshes rules file only (no config overwrite, no schema overwrite). Output: path of refreshed rules file.

### Platform not found

User passes `--platform <name>` but platform is unknown. Init fails; no files created.

## Invariants across all paths

- New init: idempotent only when `.yggdrasil/` is empty; overwrites config if re-run.
- Upgrade: never overwrites config or schemas; rules file only.
