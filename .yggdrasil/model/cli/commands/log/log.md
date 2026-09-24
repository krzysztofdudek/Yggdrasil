## [2026-05-15T12:24:34.046Z]
R0.3: cascade from cli/io metadata update
## [2026-05-15T12:30:04.814Z]
R0.4b: log-add.ts import updated from utils/atomic-write to io/atomic-write (no logic change)
## [2026-05-15T12:41:10.519Z]
R0.5: graph-loader.ts now routes all fs calls through io/graph-fs.ts (readSortedDir, readTextFile)
## [2026-05-15T13:21:54.563Z]
R0.6: update log-parser import — log-add.ts, log-read.ts, log-merge-resolve.ts now import parseLog from core/parsing/log-parser (moved from io/ to core/parsing/). No logic change.
## [2026-05-15T16:20:59.852Z]
Thin wrapper now delegates log-add/read/merge-resolve logic to core/log/. Presentation (chalk, buildIssueMessage, process.exit) and --reason-file reading remain at CLI layer.
## [2026-05-15T16:28:22.013Z]
R0.10: rewrote cli/log.ts as pure presentation layer — removed direct fs/parsing logic, imports logAdd/logRead/logMergeResolve from core/log/, handles --reason-file and graph loading, normalizes node path with trim+posix before passing to core.
## [2026-05-15T17:52:31.371Z]
Fix diagnostic-logging violations: add debugWrite() to catch blocks that exit without re-throwing.
## [2026-05-15T20:44:47.418Z]
Pass nowMs: Date.now() to logAdd — inject the current timestamp at the CLI boundary instead of inside the engine.
## [2026-05-16T17:37:14.060Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
## [2026-05-16T18:22:21.058Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
## [2026-05-31T16:03:31.754Z]
Replaced the hand-inlined path-separator normalization with calls to a single shared helper. The same small idiom — convert backslash separators to forward slashes, and in most places also strip a trailing slash — had been copied across many modules, so the normalization rule lived in dozens of places at once and any change to it risked drifting them out of step. Consolidating it behind one well-named helper means the rule lives in exactly one spot and each call site reads by intent instead of by a repeated regex. Behavior is unchanged: the helper bodies are byte-for-byte equivalent to the expressions they replace, and the full test suite passes identically.
## [2026-05-31T17:27:17.718Z]
Moved the shared command-layer support helpers — the graph-load-or-abort wrapper and the unexpected-error funnel — out of the formatters layer and into the command layer. These helpers must reach both the engine (to load the graph) and the formatters (to build the uniform what/why/next message), and only the command layer may legally depend on both; keeping them in the formatters layer was an upward dependency on the engine that the layering rules forbid. The helpers register no command of their own, so they live under a dedicated command-support classification rather than as a command handler. Command handlers now import them from their new command-layer location.
## [2026-07-10T13:22:18.614Z]
Reading a node's log can now optionally weave in that node's own recent verification outcomes — the approved/refused results recorded locally whenever verification runs — as a single newest-first timeline alongside the human-written entries. The motivation: those outcomes were already being recorded but surfaced nowhere, so a person reviewing a node's history could not see, next to the written rationale, what the automated checks most recently decided about it. Only the node's own outcomes are woven in (those recorded against the node itself or against one of the files it owns), and only genuine verification-run outcomes — other internal diagnostic sources are deliberately excluded from this view. That outcome data is local, machine-only telemetry meant to stay out of version control; the header states how far back the telemetry reaches, and if the telemetry file has been committed by mistake the header says so and stops calling it "local", because a committed file is shared team history, not a private local trace. Plain log reading is left byte-for-byte unchanged.
## [2026-07-13T20:22:38.750Z]
The log-read view that interleaves verification outcomes now, when the committed shared record contributed events, prints an honest label noting that machines on older versions record only locally and so do not contribute to the shared record. This keeps a reader from mistaking the shared record for the whole picture when part of the team is on an older version.
## [2026-07-13T20:30:13.439Z]
Node-path argument normalization was brought in line with the command contract, which prescribes trimming and stripping a trailing slash only. The subcommands here had additionally forced separators to forward slashes, a step the contract does not sanction and that the sibling replay command does not perform. Removing that extra step keeps every command that accepts a node argument on one identical normalization, so the same typed argument resolves the same way everywhere.
## [2026-07-31T22:10:13.412Z]
A verdict event keyed by file: was attributed to a node by testing whether the path fell textually inside the node mapping strings, which let a directory-mapping ancestor claim a descendant node file verdicts and kept reporting verdicts for a file coverage.excluded had already removed. Attribution now goes through the same hierarchy-first, exclusion-aware ownership resolver yg owner --file uses, so a node timeline only ever shows its own files outcomes.
## [2026-09-22T13:38:26.826Z]
The merge-resolve command gained flags to name the two sides of a merge that left no merge commit, and an optional base for sides that share no merge base. Naming only one side, or a base without the sides, is refused up front, because the merged log is verified against both sides and one of them alone names no merge.
## [2026-09-23T19:41:18.471Z]
merge-resolve now works where people actually meet a conflicted log: during a merge that stopped on it. With a merge in progress it reads the two sides from HEAD and MERGE_HEAD and writes their union itself, so the check's advice to run it is followable and nobody is pushed into hand-stitching conflict markers, which breaks the integrity hashes.
## [2026-09-23T23:00:39.903Z]
yg log read --json prints the yg-log/1 document of a node's entries (with --with-verdicts, the fill events attributed to it). Every refusal the log commands print now goes through the shared CLI output layer, so it carries the same Error: prefix as every other command error instead of none, and reaches a JSON reader as a yg-error/1 document.
## [2026-09-24T02:30:18.327Z]
The message after merge-resolve writes a union now names the command that finishes the operation it was run in — git commit for a merge, git rebase --continue or git cherry-pick --continue for a replay — because merge-resolve now also resolves rebase and cherry-pick stops, and telling someone mid-rebase to commit the merge sends them the wrong way.
## [2026-09-24T08:19:04.222Z]
The --base option of log merge-resolve no longer names the log both sides started from, because the shared history is now read off the two sides themselves; it names the commit whose entries neither side may have lost, which is how the merge base is still used. Its help text and the refusal for a lone --base say so, so nobody reaches for --base to get past a merge that now resolves on its own.
## [2026-09-24T09:01:48.512Z]
The CLI now speaks one output grammar: every finding is a block headed error[label] or warning[label] with lowercase labelled at:, why: and fix: fields, every command error is error[code]: what with a labelled why and a next: step, and a report ends with one next: step and optionally a then: step. Scripts that parsed the old capitalised Why:, Fix: and Next: lines are sent to the JSON documents, which carry the same facts. A missing node now answers with the node-not-found code and a find command for it, a missing reason names the exact command to run, and the count of shared events agrees with its noun.
## [2026-09-24T09:01:49.093Z]
A --reason-file that is not a regular file now names the command to run with a text file instead of generic advice.
## [2026-09-24T13:51:01.411Z]
Every byte this command prints now goes through the output layer: stdout and stderr through writeOut and writeErr, colour through paint, instead of process.stdout.write, process.stderr.write and a chalk import of its own. The repository now refuses a direct stream write, a console call or a chalk import outside that layer, so that where output goes, what guards it and when it is decorated are decided in one place and cannot drift command by command again, as they had across hundreds of write sites before the layer existed.
## [2026-09-24T14:51:40.780Z]
Output that names a next step now goes through the output layer next and then lines instead of being laid out by hand, and a source comment that spoke about the reviewer is reworded to describe the split plainly, so the one output grammar and the untrusted-content prompt hold for these files too.
