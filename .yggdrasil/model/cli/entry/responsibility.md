# Entry Responsibility

CLI entry point — `bin.ts`. Bootstraps Commander and delegates to command handlers.

**In scope:**

- Creating Commander instance with name `yg`, description "Yggdrasil — architectural knowledge infrastructure for AI agents", version from package.json
- Registering subcommands via `register*Command(program)`: init, build-context, drift-sync, tree, owner, deps, impact, aspects, flows, select, check
- Invoking `program.parse()` for argv handling (Commander handles exit on failure)

**Out of scope:**

- Individual command logic (cli/commands)
- Graph loading, context building, validation, drift (cli/core)
- Removed commands: validate, drift, status, preflight (replaced by `yg check`)
