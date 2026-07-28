## [2026-06-13T03:12:08.131Z]
Rule authors need to exercise a single rule against a node or files and read the reviewer's reasoning without recording anything, so this diagnostic runs either reviewer kind, previews the assembled prompt for the non-deterministic kind, and is guaranteed never to touch the committed verdict store.
## [2026-06-13T03:16:12.838Z]
Each error this diagnostic swallows — an unavailable provider, an unreadable subject file, a reviewer that throws mid-run — leaves a diagnostic trace rather than failing silently, so an author debugging a flaky rule run can see exactly which step degraded.
## [2026-06-13T03:19:19.986Z]
A reference file that cannot be read aborts the diagnostic with an actionable message and leaves a diagnostic trace of the underlying read error, and the reference path it reports is normalized to forward slashes so the output is stable across platforms.
## [2026-06-13T05:33:57.815Z]
A report handed to a pipe now drains fully before the process exits, so a long error list sent to a capturing consumer (an agent, a grep, or CI) is never truncated by the process terminating before the kernel buffer flushes. The full refusal reason for a rejected pair is now shown in the gate output rather than being abbreviated, so the reader sees the complete reason a verdict was refused.
## [2026-06-16T09:52:40.157Z]
Removed the per-provider secrets merge here: yg-secrets is now a general deep-merge overlay over yg-config applied once at config parse time, so the resolved tier already reflects any local override and no separate merge is needed at review time.
## [2026-06-19T19:18:52.103Z]
Surface the per-unit companion files in the aspect diagnostic so an author can preview, before paying for a review, exactly which paired file the reviewer will see for each unit. The dry run executes the resolver live but never calls the reviewer or writes the lock, and the ad-hoc file mode refuses a companion aspect because resolving a companion needs the graph relations that an ad-hoc file run does not provide.
## [2026-06-21T16:25:13.357Z]
The rule-preview command now resolves and shows the waived line ranges the real reviewer would receive, so previewing a model-judged rule reflects the same waivers as a billed run instead of diverging from it.
## [2026-06-29T20:48:23.438Z]
Classify deterministic runner errors in the aspect-test command. A check that throws, returns the wrong shape, is async, or reports a violation against a file it was not given is a structured, actionable aspect-author failure carrying its own what/why/next. The node-scoped path previously routed these through the generic unclassified-error handler, which both told the agent to file a CLI bug and leaked an internal error-code prefix; the ad-hoc file path already rendered them cleanly, so the two surfaces disagreed. The command now renders the structured message and exits non-zero for both surfaces, including under the run-twice determinism mode where either run may surface such an error.
## [2026-07-02T16:01:43.936Z]
The aspect-test diagnostic gained a uniform verdict stamp, an honest footer, draft-aspect parity, and placeholder-free violation rendering. Four motivations, one change-set.

First, refusal output used to start with a bare file path while a clean run printed only "No violations." — there was no stable, quotable verdict line, and an LLM refusal exited 0, contradicting the documented "exit 1 on violations or refusals" contract. Every run now carries exactly one line of the form "yg aspect-test: satisfied|refused|incomplete|dry-run": leading on deterministic runs (results are complete before printing), trailing after the streamed per-unit lines on LLM runs. LLM refusals now exit 1, and units that could not be verified at all (companion failure, reviewer error, unresolvable suppress marker) produce a red "incomplete" stamp with exit 1 — fail closed rather than silently green. The vocabulary is deliberately satisfied/refused (the reviewer/lock vocabulary), never PASS/FAIL, so a diagnostic can never read as a build verdict.

Second, the closing footer claimed the check command "still reports the stored verdict". That claim is false precisely in the tool's canonical use — testing an edit before accepting it — where the check command reports the pair as unverified (inputs no longer hash to the stored verdict), and also false for a never-yet-verified pair during aspect authoring. The footer now states that the check command judges the lock against your files, not this run — true in every state (clean tree, edited, reverted, never verified).

Third, the LLM path silently dropped draft aspects ("No pairs ... may be draft") while the deterministic path ran them fine. Draft dormancy exists to keep pairs out of the lock and the fill; this diagnostic never touches the lock, so the gate served no safety purpose and broke the documented authoring ladder (start at draft, iterate with the diagnostic). Draft pairs are now included uniformly for both reviewer kinds; the dry-run mode remains a zero-cost prompt preview, and a live run on a draft makes a real reviewer call — the same cost as any live diagnostic, disclosed in the docs. Dormancy in check/fill is unchanged.

Fourth, a violation with a file but no line number rendered a literal "L?" placeholder that read like corrupted output; the line segment is now simply omitted and the message prints bare under its file header. Line-less violations keep sorting first within a file group.
## [2026-07-03T07:20:07.668Z]
A live single-aspect diagnostic against an LLM rule was reporting a reviewer that could not be reached — an HTTP error or an unreadable response from the provider — as though the code had been refused. That is misleading: the reviewer never actually judged the code, so labelling it a refusal sends a reader editing source to fix a violation that does not exist, when the real fault is the provider connection or configuration. A provider-sourced failure is now treated as a unit that could not be verified: the diagnostic prints the infrastructure cause, stamps the run incomplete, exits nonzero, and records nothing — the same fail-closed stance the main verification path already takes for the identical failure. Only a genuine code judgment is reported as a refusal, so the diagnostic's verdict vocabulary now means what the documentation says it means.
## [2026-07-03T08:26:16.798Z]
Running a deterministic check against a node's files ad-hoc is a legitimate way to test a rule before attaching it, but doing so silently is misleading: it prints a verdict real verification will never produce, because no pair exists for an aspect that is not effective on the node through any channel. The diagnostic now prints a note, before the ad-hoc run, when the aspect is not effective on the node, so the reader knows the printed verdict corresponds to no tracked pair. This restores symmetry with the reviewer path, which already reports that no pair exists in the same situation. The note never changes the exit code or the verdict output, and effectiveness that cannot be determined from the graph is treated as no note rather than blocking the useful ad-hoc run.
## [2026-07-05T14:33:33.918Z]
The live diagnostic now prints the vote breakdown alongside a verdict whenever the resolved reviewer tier casts more than one independent vote for the aspect under test. Previously the diagnostic showed only the final aggregated verdict, so a person running a one-off check against a multi-vote reviewer configuration had no way to tell a unanimous result from one that barely cleared the majority threshold. Since this diagnostic is explicitly meant to build confidence before a verdict becomes a permanent lock entry, showing how close the vote was gives the runner a concrete reason to double-check a borderline case rather than trust an aggregate number that hides disagreement among the votes.
## [2026-07-05T17:32:08.674Z]
Added a repeated-run stability mode to the aspect diagnostic. When authoring or sharpening an LLM-reviewed rule, the reviewer's judgment on identical inputs can drift from run to run if the rule text is ambiguous, and that flakiness stays invisible until it later surfaces as an intermittent build failure. Re-running the same unit several times and reporting how many runs returned a satisfied verdict exposes that instability while the rule is still being written.

Each run is deliberately reduced to a single vote rather than the configured multi-vote consensus, so the figure reflects the judge's own run-to-run consistency instead of a majority-aggregated verdict that would hide a genuine split. The wording around the result is kept scrupulously clear that consistency is not correctness — a rule can be consistently wrong, and a high agreement ratio only means the reviewer agreed with itself.

Runs in which the reviewer could not be reached are excluded from the ratio and surfaced separately, so a transient outage never reads as instability. Any single run that refuses still marks the unit refused, and a unit whose every run failed to reach the reviewer is treated as incomplete rather than passed, keeping the fail-closed stance the rest of the tool follows. The mode is confined to LLM rules and to the live reviewing path, because a local deterministic check is already exactly reproducible and the prompt-preview path makes no reviewer call at all.
## [2026-07-11T04:44:04.013Z]
The reviewer-diagnostic command gained two capabilities that share one
motivation: making reviewer behavior observable and comparable across runs
without ever altering saved verification results.

First, every live reviewer run this command performs — both the repeated
self-consistency runs and an ordinary single run — now appends one entry to the
local, gitignored telemetry record, noting which reviewer judged the unit, how it
voted, and whether the run produced a verdict or hit an infrastructure failure.
Until now the repeated-run mode reported self-consistency on screen but left no
durable trace, so later analysis of how stably a rule judges, or how a judge
behaves after a model change, had no data to draw on. Emission is deliberately
best-effort: a failed write is swallowed so a diagnostic can never fail because
telemetry could not be recorded, and the telemetry is never an input to any
verdict, so the saved verification results stay untouched.

Second, a run can now be pointed at an explicitly named reviewer configuration
instead of the one the rule would normally resolve, so a candidate reviewer can
be dry-fitted against the current code before an actual model swap is committed.
The named configuration is looked up directly in the merged reviewer settings
(the committed configuration plus the local secrets overlay), deliberately
bypassing the normal rule-to-reviewer resolution — overriding that choice is the
entire point. An unknown name is rejected with guidance listing the
configurations that exist, and the override performs no graph edits and no
saved-result writes.

Both capabilities are strictly diagnostic and apply only to a judgment-based rule
run against a graph node; neither applies to locally-checked rules or to ad-hoc
file lists, which have no reviewer to vary.
## [2026-07-13T12:50:06.053Z]
The aspect diagnostic decides whether the rule under test is genuinely in force on the target before it runs the check ad-hoc. That decision now follows the full attachment cascade rather than asking whether a verdict slot happens to exist at that exact target. An organizational grouping that carries no source of its own can still put a rule in force across everything beneath it, with the actual verdicts landing on the descendants that hold the files. Deciding attachment by presence-of-a-slot-here wrongly treated such a grouping as unattached and emitted a misleading advisory that the rule was being run only ad-hoc. Basing the decision on effective-force keeps the advisory truthful in both directions and preserves the intent that a not-yet-active (draft-status) rule attached to its own target still reads as attached, since activation status never gates this diagnostic.
## [2026-07-28T19:46:11.087Z]
The companion-resolution helper this command uses now handles a subject with no owning component explicitly instead of assuming one exists, matching the same fix already made to the shared fill-time resolver.
