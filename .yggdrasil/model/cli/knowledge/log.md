## [2026-05-26T10:59:44.519Z]
Rewrite writing-ast-aspects for raw tree-sitter API. Runtime contract, multi-language flow placeholder, primitives reference, default-switch dispatch pattern, old→new migration table. column field on Violation noted. closest() retained in minimal API.
## [2026-05-26T11:02:24.161Z]
Add bracket-form suppress examples for Python (#) and SQL (--). Existing doc covered single-line non-C-family but bracket form was C-only. Phase 3 will add full per-language delimiter table to suppress.ts.
## [2026-05-28T15:30:39.207Z]
Add aspect-status.ts to knowledge docs mapping — new topic on three-level status semantics, declaration sites, drift mechanics
## [2026-05-29T08:33:39.060Z]
Added writing-structure-aspects knowledge topic. Structure aspects check graph and file-system shape rules — cross-node consistency, file existence, hierarchy — that cannot be expressed as per-file AST or LLM checks. The topic covers: the ctx surface (node, files, fs, graph, parseAst/parseYaml/parseJson/parseToml), the synchronous parseAst contract (pre-warmed by dispatcher, no await), the allowed-reads boundary and the three runtime violation kinds reserved for it, common helpers re-exported from @chrisdudek/yg/structure, the draft/advisory/enforced adoption workflow, the authoring loop (yg structure-test), and three cookbook examples (sibling-test-file, knowledge-topic-consistency, child-type-composition). Registered in knowledge index.ts and added to the Where-to-find-more table in rules.ts.
## [2026-09-25T21:14:10.518Z]
The shipped CLI reference now documents the one aspect-not-found refusal every rule-id command shares, the one-finding rule for a dead rule, and the two renamed advise classes with their old names kept as aliases.
