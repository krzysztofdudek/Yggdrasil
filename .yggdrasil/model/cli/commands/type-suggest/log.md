## [2026-05-15T08:40:14.535Z]
Add yg type-suggest --file command: suggests node_type based on architecture when predicates. Shows matching types, closest 3 by satisfied-fraction, or edge-case messages for .yggdrasil/ and non-existent files.
## [2026-05-15T10:11:11.572Z]
Restructure: loadGraph first, resolve --file via resolveFileArg(repoRoot), fix posix-paths trailing slash strip
## [2026-05-15T12:12:58.996Z]
R0.3: updated import from utils/repo-scan to io/repo-scanner (no logic change)
## [2026-05-15T12:28:18.002Z]
R0.4: file-content-cache import updated from core to io (no logic change)
## [2026-05-15T12:36:42.834Z]
R0.4b: cascade from cli/io metadata update (atomic-write.ts added to mapping)
## [2026-05-15T12:41:10.616Z]
R0.5: graph-loader.ts now routes all fs calls through io/graph-fs.ts (readSortedDir, readTextFile)
## [2026-05-16T05:58:01.036Z]
Phase 4.7 (no-direct-fs): update paths import from utils/ to io/ following move of paths module to persistence-adapter layer
## [2026-05-16T06:34:16.259Z]
Phase 5.2 (posix-paths-output): add backslash replacement to repoRelPath normalization
## [2026-05-16T17:37:14.424Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
## [2026-05-16T18:22:21.440Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
## [2026-05-31T16:03:32.123Z]
Replaced the hand-inlined path-separator normalization with calls to a single shared helper. The same small idiom — convert backslash separators to forward slashes, and in most places also strip a trailing slash — had been copied across many modules, so the normalization rule lived in dozens of places at once and any change to it risked drifting them out of step. Consolidating it behind one well-named helper means the rule lives in exactly one spot and each call site reads by intent instead of by a repeated regex. Behavior is unchanged: the helper bodies are byte-for-byte equivalent to the expressions they replace, and the full test suite passes identically.
## [2026-05-31T17:27:18.272Z]
Moved the shared command-layer support helpers — the graph-load-or-abort wrapper and the unexpected-error funnel — out of the formatters layer and into the command layer. These helpers must reach both the engine (to load the graph) and the formatters (to build the uniform what/why/next message), and only the command layer may legally depend on both; keeping them in the formatters layer was an upward dependency on the engine that the layering rules forbid. The helpers register no command of their own, so they live under a dedicated command-support classification rather than as a command handler. Command handlers now import them from their new command-layer location.
## [2026-07-27T13:29:46.968Z]
type-suggest previously showed no signal when a type's classification rule could not be evaluated on the target file (e.g. an oversized file under a content-based rule), leaving the omission indistinguishable from a rule that was checked and simply didn't apply. The command now lists such types separately so the difference is visible to whoever is diagnosing why a file isn't classifying as expected.
## [2026-07-31T18:00:25.107Z]
A path this graph excludes from coverage — a coverage.excluded root, or a separate project's own boundary — is no longer classified against the architecture's types at all; it now reports the same 'excluded from graph coverage by design' fact every other single-file command already reports for the identical path, instead of naming a real or apparent type overlap that has no consequence for a path nothing enforces.
## [2026-07-31T19:30:10.168Z]
An excluded path's message now names which of the two exclusion sources applies (a separate project's own boundary, or a matching coverage.excluded root) instead of a disjunction, and the gitignore stack is read from the repository root rather than the invocation directory so a run from a subdirectory sees the same rules a run from the repository root would.
