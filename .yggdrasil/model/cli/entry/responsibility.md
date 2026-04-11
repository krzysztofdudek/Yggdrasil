# Entry — Responsibility

CLI entry point — wires the Commander program, registers all commands (init, check, approve, build-context, tree, owner, impact, aspects, flows, select), and parses argv. Reads version from package.json at startup to inject into Commander. Exists as the single composition root so that individual commands remain decoupled from each other and from the bootstrapping process.

The only file that knows about all commands; adding or removing a command requires changing only this node. Does not contain command logic — delegates immediately to command handlers.
