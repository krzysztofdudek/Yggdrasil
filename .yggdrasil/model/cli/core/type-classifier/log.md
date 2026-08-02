## [2026-05-15T08:33:44.600Z]
Add type-classifier.ts: classifies a repo file against all architecture node types with when predicates. Returns full matches + top 3 closest by satisfied-fraction. Powers yg type-suggest command.
## [2026-05-15T12:34:39.162Z]
R0.4: file-content-cache import updated from ./file-content-cache to ../io/file-content-cache (no logic change)
## [2026-07-27T13:29:46.617Z]
Classifying a file whose content predicate could not actually be evaluated (oversized file) used to fall through as a plain non-match, indistinguishable from a file that was genuinely inspected and failed the rule. The classifier now returns a distinct unreadable list so callers can tell 'rule was checked and failed' apart from 'rule was never checked'.
## [2026-07-27T19:29:35.432Z]
classifyFile now records why a type's predicate could not be evaluated on a file — a genuine read failure versus a file over the content-scan size limit — instead of only a reason string, so downstream consumers can give different, honest guidance for the two cases instead of one generic message that mislabeled a size limit as an OS error.
## [2026-08-02T10:20:03.736Z]
classifyFile now accepts an optional injected classification cache: it hashes the file's content, consults the cache before running the per-type predicate loop, and writes the result back on a miss. Also gains a value dependency on the file-hashing helper, since computing the cache key requires the file's real bytes.
## [2026-08-02T11:51:51.127Z]
The classification cache key now folds in the file's own repository-relative path and hashes raw, un-normalized bytes instead of the line-ending-normalized hash used for verdict hashing elsewhere, so classifyFile's cache lookup and write both take the path alongside the content hash. Two files with identical bytes at different paths, or one file whose line-ending style changes at a fixed path, previously could share or fail to invalidate a cache entry; neither can now.
