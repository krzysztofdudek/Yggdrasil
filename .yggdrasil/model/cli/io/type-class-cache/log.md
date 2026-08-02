## [2026-08-02T10:19:59.753Z]
Adds a content-hash-keyed local cache for the type-level classification lattice, so an unchanged file skips re-evaluating every classifying type's predicate on the next run. Mirrors the existing AST fact cache's fail-closed shard contract and lives in io/ because core/ files may not touch the filesystem directly.
