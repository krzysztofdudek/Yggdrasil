# Entry Responsibility

CLI entry point — `bin.ts`. Bootstraps Commander and delegates to command handlers.

**In scope:**

- Creating Commander instance with name `yg`, description "Yggdrasil — architectural knowledge infrastructure for AI agents", version from package.json
- Registering subcommands via `register*Command(program)`: init, context (alias: build-context), approve (alias: drift-sync), tree, owner, impact, aspects, flows, select, check
- Invoking `program.parse()` for argv handling (Commander handles exit on failure)

**Out of scope:**

- Individual command logic (cli/commands)
- Graph loading, context building, validation, drift (cli/core)
