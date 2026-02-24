# Graph Ops Commands Interface

Public API consumed by cli/entry. Named exports only.

| Function | Signature | Command | Options |
| -------- | --------- | ------- | ------- |
| registerStatusCommand | (program: Command) => void | status | None. |
| registerTreeCommand | (program: Command) => void | tree | --root, --depth (parsed as int). |
| registerOwnerCommand | (program: Command) => void | owner | --file (required). |
| registerDepsCommand | (program: Command) => void | deps | --node (required), --depth, --type (structural, event, all; default all). |
| registerImpactCommand | (program: Command) => void | impact | --node (required), --simulate. |

**Also exported:** findOwner(graph: Graph, projectRoot: string, rawPath: string): OwnerResult — resolves file to owning node; used by owner command.

**Return:** void for all register* functions. Contract: errors to stderr, process.exit(1) on failure.
