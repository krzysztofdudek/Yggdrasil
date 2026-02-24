# CLI Decisions

**Reference:** docs/idea/foundation.md, graph.md, engine.md, tools.md

Yggdrasil exists because AI agents degrade proportionally to project size — not from lack of intelligence, but from **what the model knows at the start**. Too little context: agent breaks contracts. Too much: signal drowns in noise. The fix is structural: a **persistent, structured knowledge base** that survives sessions, agents, and people.

The CLI is the **deterministic engine** that implements steps 2–5 of the agent workflow: building knowledge (graph), assembling context, materializing results, detecting drift. It gives repositories **memory of meaning** — what the system *is*, what depends on what, why decisions were made — orthogonal to git's memory of *what changed*.

**Division of labor:** Tools read and validate the graph; they do not write it. The agent writes the graph; tools give feedback. Analogous to programmer–compiler. Tools never guess — same graph state always produces same output. No heuristics, no repository search.

**Key insight:** Agents need 2000 *right* tokens, not 200 000 random ones. The graph enables bounded context packages assembled mechanically from explicit declarations. Deterministic discoverability: every piece of knowledge reaches the agent through a declared, tool-verifiable path.
