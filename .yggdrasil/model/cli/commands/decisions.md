# Commands Decisions

**Reference:** docs/idea/foundation.md (Division of labor), engine.md (Tool operations), tools.md (Operations)

Commands are the **user-facing layer** of the deterministic engine. Each command maps to one tool operation. The agent (or human) invokes `yg build-context`, `yg validate`, `yg drift` — commands orchestrate the call into core, format output, and exit.

**Why process.cwd() as project root:** Yggdrasil operates on the repository where the user runs the command. No config file to specify path — the working directory *is* the project. Simple, predictable. Same as git.

**Why exit 1 on errors:** Commands are scriptable. CI pipelines, agent workflows, and humans need a clear success/failure signal. stderr for messages, exit code for status. No exceptions bubbling to top-level — each command catches, reports, exits.

**Why commands don't write the graph:** Per the division of labor, tools read and validate. Commands call loadGraph, validate, detectDrift — they never create nodes or artifacts. The only writes are operational metadata (drift-sync, journal) via io, and init's one-time bootstrap.
