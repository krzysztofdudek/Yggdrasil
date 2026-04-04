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

## Why claims replaced regex anchors (v4)

Chose LLM-verified natural language claims over regex patterns because agents were writing meaningless regexes to pass validation (e.g., `"export function"` as proof of determinism). Regex was a proxy for semantic verification — direct semantic verification via LLM is more honest. Claims in natural language are per-file verifiable, composable, and cannot be gamed. Rejected alternative: keeping regex with stricter patterns — rejected because the fundamental problem was proving semantic properties with syntactic patterns.

## Why LLM verification at approve, not check (v4)

Chose to run LLM checks at approve time only, not at check time. Check runs 20+ times per session and must be fast (<1s), deterministic, and offline-capable. Approve runs once per node after changes and can tolerate LLM latency. This separation means: check = structural gate (fast, deterministic), approve = semantic gate (LLM-powered, thorough). Rejected alternative: LLM at check time — rejected because it would make the fast feedback loop unusable.

## Why flat mapping replaced mapping groups (v4)

Chose flat path lists over grouped mappings with per-group aspect proofs. Mapping groups were an intermediate design — once verification became LLM-based (semantic, per-node), there was no need to group files by proof profiles. All files in a node prove the same aspects the same way: via their code, verified by LLM reading it. Flat mapping is simpler for agents to maintain. Rejected alternative: keeping mapping groups — rejected because the grouping complexity served only the regex proof system, which was itself replaced.

## Why typed ports replaced integration_aspects (v4)

Chose per-node typed ports over global integration_aspects. APIs are typed — different endpoints have different contracts. Global integration_aspects forced all consumers to prove everything, regardless of what they actually consumed. Ports match reality: consumer A consumes port X with aspects [a, b], consumer B consumes port Y with aspects [c]. The `consumes` field already existed on relations; promoting it to enforcement was natural. Rejected alternative: keeping global integration_aspects — rejected because it didn't model real API contracts.

## Why health score was removed (v4)

Agent feedback showed health scores were meaningless without explanation — "90/100" tells an agent nothing about what to fix. The score was removed in favor of explicit error/warning counts and actionable next-command guidance. Rejected alternative: health score with breakdown — rejected because error counts are more actionable and the score formula was arbitrary.

## Why progressive disclosure in context output (v4)

Chose two-level structured text (node overview, file details) over single YAML dump. Agents don't parse context programmatically — they read it. YAML was verbose and required agents to understand the map structure. Structured text with clear headers and `read:` pointers is more scannable. Two levels provide progressive disclosure: `context --node` for orientation, `context --file` for per-file details when modifying code. Rejected alternative: keeping YAML output — rejected because agents consistently struggled with the YAML map structure.

## Why per-file-verifiable claims (v4)

Claims must be verifiable within a single file, not across files. Cross-file claims ("function A calls function B") break with file chunking on large nodes. Per-file claims ("no Date.now()", "error handling uses AppError") are robust, compose well, and can be verified independently. Cross-file invariants belong in flow descriptions and node artifacts, not aspect claims.
