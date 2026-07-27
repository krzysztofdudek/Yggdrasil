## [2026-05-15T08:33:44.600Z]
Add type-classifier.ts: classifies a repo file against all architecture node types with when predicates. Returns full matches + top 3 closest by satisfied-fraction. Powers yg type-suggest command.
## [2026-05-15T12:34:39.162Z]
R0.4: file-content-cache import updated from ./file-content-cache to ../io/file-content-cache (no logic change)
## [2026-07-27T13:29:46.617Z]
Classifying a file whose content predicate could not actually be evaluated (oversized file) used to fall through as a plain non-match, indistinguishable from a file that was genuinely inspected and failed the rule. The classifier now returns a distinct unreadable list so callers can tell 'rule was checked and failed' apart from 'rule was never checked'.
