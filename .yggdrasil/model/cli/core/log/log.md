## [2026-05-15T16:21:06.490Z]
New module: logAdd, logRead, logMergeResolve extracted from cli/log-add.ts, cli/log-read.ts, cli/log-merge-resolve.ts. Functions return structured IssueMessage-shaped results — no chalk, no process.exit, no formatters calls.
## [2026-05-15T16:28:14.146Z]
R0.10: extracted log-add, log-read, log-merge-resolve from cli/ to core/log/ as pure orchestration functions returning structured IssueMessage results. Uses adapter type (not engine) because these functions do I/O via log-store.ts and generate timestamps (Date.now) — will be reclassified in Phase 2 when persistence-adapter type exists.
## [2026-05-15T18:26:29.054Z]
Add yg-suppress-disable/enable(deterministic) around monotonicNow — log entry datetime is functional output returned to caller; Date.now() use is a conscious design decision accepted here
## [2026-05-15T19:28:50.332Z]
Move IssueMessage type from formatters/message-builder to model/validation — engine→formatter import violation fix for boundaries enforcement
## [2026-05-15T20:41:33.677Z]
Refactor logAdd to require nowMs parameter: move Date.now() call out of engine (log-add.ts) and into the CLI layer (log.ts). This satisfies the no-nondeterminism-direct AST aspect which forbids direct Date.now() calls in engine code.
## [2026-05-29T10:09:44.152Z]
Re-approving after drift state was wiped during concurrent development session. No source changes — this approval records the baseline verdicts for newly-active aspects.
## [2026-05-29T10:10:06.418Z]
Re-approving all aspects because the what-why-next aspect content was updated (clarified that structured messageData field access in CLI renderers satisfies the rule, not just direct buildIssueMessage calls). The aspect content change triggered a cascade drift requiring full re-approval to establish verdicts for all active aspects.
## [2026-05-30T10:05:16.434Z]
Merge reconciliation of a per-node history now verifies entries by their full content, not just their timestamp, and in both directions. Matching only on timestamp let a reconciliation silently keep an entry whose text had been altered, or add an entry present on neither merged branch, as long as the timestamps lined up. Reconciliation now rejects dropped, altered, and fabricated entries alike, and reports a clear, actionable message when the history file is absent instead of failing with an opaque error.
## [2026-05-30T10:28:16.596Z]
The merge-reconciliation path that handles an unreadable per-node history file now writes a diagnostic log line before returning its user-facing error, so a swallowed read failure is never silent. This follows the codebase convention that any caught error which is not re-thrown must still be recorded for later diagnosis, rather than disappearing into a fallback return.
## [2026-05-31T16:03:33.698Z]
Replaced the hand-inlined path-separator normalization with calls to a single shared helper. The same small idiom — convert backslash separators to forward slashes, and in most places also strip a trailing slash — had been copied across many modules, so the normalization rule lived in dozens of places at once and any change to it risked drifting them out of step. Consolidating it behind one well-named helper means the rule lives in exactly one spot and each call site reads by intent instead of by a repeated regex. Behavior is unchanged: the helper bodies are byte-for-byte equivalent to the expressions they replace, and the full test suite passes identically.
## [2026-06-01T06:21:23.722Z]
Updated the merge-resolve path to construct a typed drift baseline when none exists. A freshly created baseline now stamps the on-disk format version, carries an empty typed upstream-identity block, and an empty required per-aspect verdict map, instead of the former minimal shape that omitted those fields. This keeps a log-only baseline valid against the single-format runtime that rejects baselines missing the typed shape.
## [2026-06-14T07:55:56.527Z]
The log merge-resolve path now writes a diagnostic before returning when the lock it reads back is structurally invalid, matching the sibling read-failure branch, so a swallowed lock-invalid condition during a merge is no longer silent.
## [2026-06-20T11:18:09.127Z]
Log-baseline merge reconciliation now writes only the log member of the lock triad. WHY: the lock split the per-node source fingerprint and log-integrity baseline into their own committed file, so reconciling a baseline after a git merge must target that file alone. It must not rewrite the verdict files — doing so would require the verdict-kind partition information this path does not have, and would produce spurious churn in files whose verdicts did not change.
## [2026-06-23T06:53:40.793Z]
Host the shared log-gate freshness predicate here, in the read-only log module. The predicate — has this node's mapped source changed since its last recorded baseline without a fresh justification entry — is consulted by the fill gate, by positive closure, and by the read-only check. Placing it in this neutral read-only module lets the read path consult it without taking a dependency on the write/fill path, which would otherwise form a cycle because the fill path already depends on the read path.
## [2026-07-20T04:43:32.109Z]
Two fixes to keep log entries and their boundaries intact.

Adding an entry must reject a justification that contains an unclosed code fence. Because entry headers are recognized by a line pattern, an unterminated fence in one entry would swallow every following entry header into that entry's body for later readers, silently destroying the boundaries between entries. Such a justification is now refused up front with guidance to close or remove the fence.

Reconciling a log after a merge must detect real version-control conflict markers without firing on ordinary Markdown. The check previously also treated a line that is a run of equals signs as a conflict marker, but in Markdown such a line is a legitimate heading underline or horizontal rule, so a normal log could be misread as conflicted. Detection now keys only on the unambiguous opening and closing conflict markers, which a genuine conflict always emits, so no real conflict goes undetected and no ordinary log is falsely flagged.
