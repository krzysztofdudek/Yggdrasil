## [2026-05-15T17:44:12.867Z]
Phase 2: split from cli/ast — types, report aggregator, public API index. Type: ast-adapter.
## [2026-05-26T08:53:55.218Z]
Violation gains column field (0-based from node.startPosition.column). Additive — pre-rewrite aspects unaffected. Useful for messages pointing at characters within a line.
## [2026-05-26T09:48:17.057Z]
Export new API (walk, report, inFile, findComments, closest) as named exports while keeping legacy ast namespace. Legacy inFile shim: /pattern/ → regex, glob meta-chars → glob, else contains. Both APIs coexist until Task 28 deletes legacy after all 14 aspects migrated.
## [2026-05-26T10:52:12.815Z]
Mapping extended to absorb walk.ts, file-path.ts, find-comments.ts after deletion of helpers-syntactic and helpers-naming nodes. Public API surface now lives under one node.
## [2026-05-30T10:05:16.581Z]
The comment-finding helper can now be called with a source-file object directly, deriving the programming language from the file's extension. Previously it required an explicit language argument and raised an unrecognized-language error when handed the file object that rule scripts actually receive, which made the documented call form unusable in practice. An unknown extension now produces a clear, explicit error instead of a confusing one.
## [2026-06-08T16:05:31.707Z]
The AST file-pattern helper that deterministic check authors use to scope a rule to certain files now matches through the shared single glob primitive rather than calling the glob library directly, so a check author glob and the system mapping globs share one semantics. A dot-prefixed path segment now matches a bare star, consistent with the rest of the system.
## [2026-06-08T19:56:29.501Z]
The public shape describing a source file handed to a deterministic check now records that its parse tree may be absent. A file whose extension has no registered grammar cannot be parsed, yet it must still be delivered to checks that only read file text. The parse-tree field on that shape is therefore optional rather than always present, and check authors who reach for the parse tree must first confirm it exists. This keeps the type honest about the non-parseable case instead of pretending every delivered file carries a tree.
## [2026-07-15T09:46:48.539Z]
The language-registry module — the pure extension-to-grammar lookup table with no imports of its own — was relocated from the core layer to the utility leaf so that lower layers (AST parsing, relation extraction, structural checks) no longer declare a dependency that points back up into core. This node's import path to that module was updated to the new leaf location. Pure structural relocation: no behavior changes, the lookup table and its helpers are byte-identical.
## [2026-08-19T11:31:09.469Z]
Added Tree and Node re-exports (as SyntaxNode) to ast/types.ts so src/roots/** can name web-tree-sitter's AST types without importing the web-tree-sitter package directly, matching the ast/index.ts barrel's existing re-export naming; the roots genericity fence bans that direct import.
## [2026-08-19T11:52:26.872Z]
The AST barrel now re-exports the parser library's tree and node types through the local type module instead of naming the third-party package a second time, so exactly one file states where those types come from and a future parser-library change touches one import site instead of two.
