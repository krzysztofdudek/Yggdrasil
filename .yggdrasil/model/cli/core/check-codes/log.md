## [2026-05-31T16:32:41.639Z]
This unit is the single home for the issue-code category sets — the structural codes that always block the check, and the completeness codes surfaced as non-blocking metadata gaps. These sets were previously hard-coded twice: once in the check engine that tallies a summary count, and once in the command renderer that groups errors into sections. The two copies had silently diverged, so the structural-error count in the summary could disagree with what was actually shown grouped under the structural heading. Giving the categories one definition that both consumers import removes that whole class of drift between the count and the rendering.
## [2026-05-31T21:54:09.652Z]
Removed config-reviewer-legacy-format and config-reviewer-mixed-format from STRUCTURAL_CODES. These codes were emitted by runtime branches that have been deleted; retaining them in the set would silently allow callers to reference codes the parser no longer generates, risking confusion in error-grouping and summary tallies.
## [2026-06-03T07:05:08.466Z]
Registered the error codes for the aggregating-aspect kind and related aspect-contract validation so the new conditions render with stable, documented codes in the gate output instead of generic messages.
## [2026-06-03T08:20:15.797Z]
Registered a new structural issue code for drift-state baseline integrity. It is classified as structural because it must block the gate regardless of whether any source file drifted: the baseline itself is untrustworthy when its recorded hash cannot be reproduced from the node's files, identity, and verdicts. Grouping it with the other always-blocking graph-shape codes keeps the summary tally and the rendered error grouping in agreement and feeds the suggested-next computation.
## [2026-06-08T19:22:27.597Z]
Port-contract and relation-target violations are structural-integrity failures of the graph, on the same footing as the other structural codes, and must be classified as such so they group and block consistently with their peers. The codes covering a missing consumes declaration against a porting target, a consumes naming a port that does not exist, a port aspect that is undefined at the consumer, consuming a target that exposes no ports, and a relation whose target type the architecture forbids were not listed among the structural codes. They are now included so the categorisation matches the contract that these are blocking structural errors rather than some lesser class.
## [2026-06-12T13:14:12.945Z]
Added 'aspect-scope-invalid' and 'aspect-scope-on-aggregate' to STRUCTURAL_CODES so the single-source catalogue stays in lockstep with the rendered Structural group and summary count. These codes block yg check when scope: parsing fails and were previously missing from the catalogue, making the summary tally and rendered grouping inconsistent.
## [2026-06-13T08:59:33.165Z]
Registered a new blocking issue category for a file that a node mapping claims but the gitignore filter silently excludes from review. It is classified as a structural (blocking) issue, distinct from the plain not-covered-by-any-mapping error, because the file IS matched by a mapping — the problem is specifically the gitignore conflict that drops it from the review subject set, which would otherwise let an enforced rule pass over unreviewed source.
## [2026-06-13T10:52:15.582Z]
Two issue-classification gaps fixed. The secrets-non-credential error blocks the fill step but was not listed among the structural issue codes, so the single-next-step suggestion never pointed at it; it is now classified structural so it is grouped and surfaced correctly. Separately, a comment claimed the completeness-category codes are non-blocking, but one of them is emitted as a blocking error — the comment was corrected to say that category membership governs only grouping and tally, while the emitting check decides whether it blocks.
## [2026-06-14T06:55:19.446Z]
The relation-undeclared-dependency code was registered among the structural codes so it is counted in the summary, grouped with its peers, and reachable by the next-step suggestion.
## [2026-06-16T09:52:39.403Z]
Removed the secrets-non-credential-field code: yg-secrets is now a general deep-merge overlay over yg-config rather than an api_key-only file, so a non-credential field in it is valid and no longer a blocking error.
## [2026-06-19T05:55:05.448Z]
Retires the structural issue code that reported a missing schema file. Schema references are no longer a per-project graph artifact whose presence is checked; they are delivered by a built-in command and travel with the tool, so a project can never be missing them and the code has nothing left to report.
## [2026-06-19T19:18:52.568Z]
Register the two new companion-misuse error codes as blocking structural errors so they are categorised with the other aspect rule-source errors in the check summary.
## [2026-07-10T08:10:35.358Z]
Registered the error-direction validation code as a structural, always-blocking graph-shape error, next to the other rule-definition contract codes, so a misplaced or malformed label is caught by the read-only gate and by CI, not only during a fill.
## [2026-07-10T10:30:30.800Z]
Recorded the new dead-attach warning as a known non-blocking code and documented why it is intentionally kept out of the blocking code groups. Warnings must never fail a check run or abort the review-fill step; only the blocking categories do that. Documenting the code here, alongside the blocking sets, prevents a future reader from mistaking a purely advisory signal for a hard failure and wrongly adding it to a set that would gate the build.
## [2026-07-12T10:11:11.562Z]
Registers the two codes behind the standing review-by date: a blocking parse-time rejection fired only on a rule that carries a malformed date, and a non-blocking, status-independent warning for a rule whose review-by date has passed. The warning is intentionally kept out of every blocking set so it can never fail a build, and the date itself is excluded from every verification hash, so recording it invalidates no existing judgment.
## [2026-07-13T18:13:56.734Z]
Records the incident-ledger out-of-order warning in the registry of issue-code categories so it is documented as a non-gating warning and can never be mistaken for a blocking error. It belongs to none of the blocking sets on purpose: the incident ledger is committed human testimony and its only integrity signal must warn without ever failing a check.
## [2026-07-15T04:26:22.805Z]
aspect-when-invalid joins the structural code set so a malformed when: predicate blocks like the other aspect-contract errors and can never render as a non-blocking or absent signal.
## [2026-07-15T08:06:56.202Z]
Registers aspect-tier-on-aggregate in the structural code set so a tier declared on an aggregate aspect blocks like the sibling aspect-contract codes.
## [2026-07-15T08:27:07.379Z]
Registers relation-target-type-unknown in the structural code set so a relation allow-list that names an undefined target type is categorized and blocks like the sibling relation-integrity codes.
## [2026-07-20T04:43:29.950Z]
An out-of-repository file's bytes must never flow into a reviewer prompt. The primary defense rejects a mapping that escapes the project root at parse time, so such a node never loads. As defense in depth, the fill-and-approve stage now also treats an escaping mapping as a gating condition: if one ever reached a loaded graph by another route, the approve run aborts before any subject file is read rather than sending its contents to a reviewer.
## [2026-07-24T12:09:09.255Z]
A new category of non-blocking finding needed a single shared name so that the two places a repository's problems are tallied and grouped, the running summary counts and the detailed per-issue grouping, can never quietly diverge on how many of this kind of issue exist or how it gets labeled. Recording it once in the shared category list, rather than inline in each caller, is what keeps that guarantee automatic instead of something that has to be remembered every time a caller changes.
## [2026-07-27T14:26:40.134Z]
Removes the retired coverage-conflict code from the structural code set now that its detector is gone. Its replacement varies in severity by where the offending file lives in the repository, so it does not belong in a set reserved for codes that always block regardless of state.
## [2026-07-27T15:57:02.746Z]
ambiguous-node-type joins the structural code set: it always blocks yg check, like the other architecture-shape codes, and the summary tally and the check command's error grouping now agree on that without either needing its own copy of the rule.
## [2026-07-28T12:11:38.315Z]
Documents the new coverage-required-shadowed warning code: it flags a required coverage root that can never match a file because it is fully contained in an excluded root, a consequence of coverage exclusion becoming absolute rather than a longest-match comparison.
## [2026-07-28T12:25:31.449Z]
Reworded the coverage-required-shadowed warning-code doc comment so it reads as a self-contained description of the absolute-exclusion rule rather than referencing an external planning label.
## [2026-07-28T13:56:14.420Z]
Gained the zero-classifying-types standing notice constant, moved here from core/check.ts — it is a shared user-facing string read by two unrelated command files (yg check's coverage-section render and yg init's closing summary), which belongs beside the other shared issue-code constants rather than living inside the check orchestrator.
## [2026-07-28T15:37:23.450Z]
Registered the new live type-relation gate's blocking code in the structural set so the summary tally and the rendered error grouping count it consistently, the same single source every other blocking code already shares.
## [2026-07-31T08:26:04.808Z]
Registered the new file-mapping-nested-project structural error code alongside the existing gitignore one, so both render in the same grouped category.
## [2026-07-31T12:04:34.900Z]
The structural code that used to name only a nested-project cause for an unusable mapping entry now also covers the case where an adopter's own coverage.excluded config is what emptied it, so it is renamed to describe the general condition rather than the one cause it originally covered.
## [2026-08-06T13:56:20.201Z]
A cycle in rule implications leaves the effective rule set impossible to resolve, yet approval went ahead anyway: it dispatched every unrelated rule first, spending a reviewer call on each, and only then ended red. A cycle now stops approval outright, before anything is dispatched and before anything is recorded, so no work and no cost is spent while it is unknown which rules apply.
## [2026-08-12T10:05:57.290Z]
Added SCOPED_CODES, the outsideTwin naming function, and the derived OUTSIDE_CODES registry, declaring which check-engine issue codes may one day be downgraded from a blocking error to a non-blocking warning when a change cannot be honestly held accountable for them. Four of the members are deliberate carve-outs from the existing structural-code set, each documented with its own rationale for why it represents drift between committed code and the declared graph rather than a self-inconsistency in the graph's own authoring. Nothing yet reads this new set; it is a pure policy declaration plus its own guard tests.
## [2026-08-12T10:26:43.653Z]
Added a mechanics caveat to the SCOPED_CODES doc comment naming the six member codes that currently push their issue with no structured file or node identity (type-relation-forbidden, ambiguous-node-type, tracked-file-gitignored, type-strict-orphan, strict-overlap-conflict, and the aspect and flow branches of description-missing). The category rationale for each stays correct, but nothing can yet mechanically test whether a change touched them, so a future scope-classification step must not treat any of the six as attributable until they carry real identity.
## [2026-08-12T14:50:12.814Z]
The scoped-code registry documented six codes as emitting with no structured identity; now that every one of them carries a real subject field, the caveat is stale and needs to say so rather than keep warning about a gap that no longer exists.
## [2026-08-13T03:35:40.900Z]
Added a table mapping the handful of issue codes whose finding is never about anything a change touched — the committed agent-rules artifacts, the incident ledger, the coverage config, the architecture file — to the real path(s) each one actually reads, so a later step can recognize them as never attributable to a diff. The three rules-artifact names are imported from their single shared source rather than re-typed, so this file cannot drift from the installer or the digest reader the way the naming convention already guards against.
