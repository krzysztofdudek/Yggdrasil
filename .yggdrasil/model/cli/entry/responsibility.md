# Entry Responsibility

CLI entry point — `bin.ts`. Bootstraps Commander and delegates to command handlers.

**In scope:**

- Creating Commander instance with name `yg`, description "Yggdrasil — architectural knowledge infrastructure for AI agents", version 0.1.0
- Registering 15 subcommands via `register*Command(program)`: init, build-context, validate, drift, drift-sync, flows, preflight, status, tree, owner, deps, impact, journal-add, journal-read, journal-archive
- Invoking `program.parse()` for argv handling (Commander handles exit on failure)

**Out of scope:**

- Individual command logic (cli/commands)
- Graph loading, context building, validation, drift (cli/core)
