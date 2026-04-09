/**
 * Shared artifact quality criteria — used by both agent rules (what to write)
 * and reviewer prompts (what to verify). Single source of truth.
 */

export const ARTIFACT_GUIDANCE = `Artifact types and what belongs in each:

- responsibility.md — IDENTITY: what this node IS, what it is NOT, its role relative to siblings and parent. Business rules and domain constraints that the code enforces but doesn't explain.
- interface.md — CONTRACT: what the source file CANNOT tell you about using this module. Group exports by consumer use case, explain WHEN to use which export and what the return MEANS in context. Do NOT document signatures (types, parameters) — those are in the code. Name functions to orient the reader, then explain purpose and failures. The interface should make agents FASTER at understanding the module, not replace reading the source.
- internals.md — WHY + CONSTRAINTS: design decisions with rejected alternatives, non-obvious constraints. Sections: ## Decisions ("Chose X over Y because Z"), ## Constraints.

Quality test — an artifact is GOOD when:
1. It captures knowledge an agent CANNOT learn by reading the source code.
2. It does NOT repeat what yg-node.yaml already declares (mappings, relations, aspects).
3. It does NOT restate what is directly visible by reading files or running commands.

An artifact is BAD when it contains:
- File-by-file inventory of the mapped directory (visible from ls or yg-node.yaml mapping)
- Internal function signatures or helpers not exported to consumers
- Step-by-step pseudocode paraphrasing the algorithm (the code IS the algorithm)
- Config file settings restated in prose (the config file IS the documentation)
- "Out of scope" listing sibling nodes by name (the graph knows boundaries through relations)
- Parent content repeated in a child (hierarchy inheritance delivers parent context)`;
