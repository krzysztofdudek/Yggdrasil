## [2026-05-13T05:34:38.083Z]
Initial creation: file-content-cache.ts.

Why: Plan Task 1.4. The file-when evaluator (Task 1.5) needs to test content regex against files matching path predicates. Reading the same file twice within a single validator run is wasteful, and naive reads against multi-MB files or binaries would dominate runtime. The cache memoizes by absolute path, classifies payloads as binary/too-large, and lets the evaluator emit a clear content-not-evaluable trace instead of stalling.

How to apply: SIZE_LIMIT_BYTES = 5MB, BINARY_PROBE_BYTES = 8KB (null-byte probe). FS read failures are reported via unreadable=true so the validator can emit file-unreadable rather than masking as content mismatch. Plan Task 1.4.
## [2026-05-13T05:38:36.240Z]
Extend FileContentResult with unreadableReason field.

Why: file-when-evaluator (Task 1.5) needs the underlying OS error message (e.g. ENOENT, EACCES) to attach to the EvaluationResult so the validator can render file-unreadable diagnostics with actionable detail. Task 1.4 returned a bare unreadable=true which lost that signal.

How to apply: stat/readFile catch blocks now capture err.message into unreadableReason. No behavior change for binary/tooLarge paths. Plan Task 1.5 (companion to evaluator).
## [2026-05-15T12:28:18.105Z]
R0.4: file moved from core/ to io/ — engine node mapping updated; type stays engine until Phase 2 reclassification
## [2026-05-15T17:44:23.069Z]
Phase 2: moved graph node from cli/core/file-content-cache to cli/io/file-content-cache. Type reclassified from engine to persistence-adapter (source file is in source/cli/src/io/).
## [2026-07-27T19:29:42.772Z]
Binary detection now runs before the size guard, reading only a bounded probe rather than a file's full bytes, so a binary file over the content-scan size limit is correctly reported binary instead of too-large. A content predicate treats a binary file as a deliberate, never-blocking non-match; reporting it too-large instead turned that legitimate non-match into a spurious blocking error.
