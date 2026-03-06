## Decisions

# Commands Decisions

**Reference:** docs/idea/foundation.md (Division of labor), engine.md (Tool operations), tools.md (Operations)

## Why commands are thin wrappers

Commands are the user-facing layer of the deterministic engine. Each command maps to one tool operation. The agent (or human) invokes `yg build-context`, `yg validate`, `yg drift` — commands orchestrate the call into core, format output, and exit. Domain logic stays in `cli/core` so that it can be tested independently of Commander, process.exit, and stdout/stderr. Commands are responsible only for CLI concerns: argument parsing, output formatting, and error presentation.

## Why one file per command

Each command lives in its own source file (e.g., `build-context.ts`, `validate.ts`, `drift.ts`). This provides isolation — changes to one command do not affect others. It enables independent testing of each command's argument parsing and error handling. It also gives clear ownership: each command file maps to exactly one graph node.

## Why per-command node granularity

After the graph-ops split, each command has its own node in the graph rather than being grouped. This reflects the actual isolation in the codebase — commands share the contract defined in this parent node but have independent implementations, test coverage, and evolution paths.

## Why process.cwd() as project root

Yggdrasil operates on the repository where the user runs the command. No config file to specify path — the working directory *is* the project. Simple, predictable. Same as git.

## Why exit 1 on errors

Commands are scriptable. CI pipelines, agent workflows, and humans need a clear success/failure signal. stderr for messages, exit code for status. No exceptions bubbling to top-level — each command catches, reports, exits.

## Why commands don't write the graph

Per the division of labor, tools read and validate. Commands call loadGraph, validate, detectDrift — they never create nodes or artifacts. The only writes are operational metadata (drift-sync) via io, and init's one-time bootstrap.
