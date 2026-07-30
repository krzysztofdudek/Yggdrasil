## [2026-07-27T15:57:09.526Z]
New pure module computing the type-level classification lattice over already-uncovered files: which ones are satisfied by a single matching type, which are ambiguous between two or more, which are already owned by the strict backward scan, which match no type at all, and which could not be classified because their matching type's rule could not be evaluated. It exists so the coverage section and the strict-orphan enrichment can share one classification of a file instead of each re-deriving it.
## [2026-07-27T19:29:38.997Z]
computeTypeCoverage now records one unreadable entry per file, naming every classifying type that could not be evaluated against it, instead of one entry per file-type pair — every type unreadable on a given file shares the same underlying cached file read, so the readability verdict is identical across them and per-type duplication carried no extra information.
## [2026-07-28T12:11:30.745Z]
The classification lattice's own excluded-root check is replaced by the shared absolute-exclusion predicate the coverage tiering already uses, so a file's excluded status can never disagree between the lattice and the tier split that consumes its results.
## [2026-07-28T13:56:15.350Z]
Deleted the dead alsoMatches field from TypeCoverageResult.strictClaimed — nothing in production ever read it (the equivalent enrichment the field was meant to feed lives independently in checks/mapping.ts's own type-strict-orphan message, which computes its own co-match list), so carrying it here was pure unread output.
## [2026-07-30T13:40:11.663Z]
Adds a single-file classification entry point so a command answering about one file, not the whole repository, can classify it against the architecture without paying for a full-repo classification pass.
