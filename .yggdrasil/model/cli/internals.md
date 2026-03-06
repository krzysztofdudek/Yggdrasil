## Decisions

# CLI Decisions

**Reference:** docs/concept/foundation.md, graph.md, engine.md, tools.md

## Why Yggdrasil exists

AI agents degrade proportionally to project size — not from lack of intelligence, but from **what the model knows at the start**. Too little context: agent breaks contracts. Too much: signal drowns in noise. The fix is structural: a **persistent, structured knowledge base** that survives sessions, agents, and people. The CLI is the deterministic engine that gives repositories memory of meaning — what the system is, what depends on what, why decisions were made.

## Why layered architecture (commands -> core -> io)

The CLI separates concerns into three layers: commands (user-facing orchestration), core (domain logic), and io (filesystem access). This separation enables independent testing of each layer — core logic can be tested without Commander or filesystem, commands can be tested with mocked core, and io can be tested against real or mocked file systems. It also enforces clear responsibility: commands never implement domain logic, core never touches the filesystem directly, and io never makes domain decisions.

## Why single entry point

`bin.ts` registers all commands with Commander in one place. This makes the CLI's surface area discoverable — every available command is registered in a single file. Commander handles argument parsing, help generation, and subcommand routing.

## Why TypeScript + ESM

Strict TypeScript provides compile-time safety for the complex type relationships in the graph model (nodes, aspects, flows, relations, config). ESM (import/export) is the modern module standard for Node.js, enabling tree-shaking and explicit dependency declarations.

## Division of labor

Tools read and validate the graph; they do not write it. The agent writes the graph; tools give feedback. Analogous to programmer-compiler. Tools never guess — same graph state always produces same output. No heuristics, no repository search.

## Key insight

Agents need 5000 *right* tokens, not 50,000 random ones. The graph enables bounded context packages assembled mechanically from explicit declarations. Deterministic discoverability: every piece of knowledge reaches the agent through a declared, tool-verifiable path.
