## [2026-05-16T13:59:47.325Z]
Update test fixtures to match updated Graph model types: nodeParseErrors entries now use messageData: IssueMessage instead of message: string; architectureError raw string replaced with structured { code, messageData } object.
## [2026-05-26T08:07:19.411Z]
Update aspect-verifier.test.ts: add errorSource: 'codeViolation' to mock provider responses and toEqual assertions. Required field change means all mock AspectResponse objects and assertions must include errorSource.
## [2026-05-27T07:22:46.460Z]
Phase 6 type-bridge: validator.test.ts, validator-aspect-files.test.ts, and validator-reviewer.test.ts updated — createAspect/makeAspect helpers now always include reviewer field with default { type: 'llm' }; string shorthand 'ast'/'llm' accepted via bridge; inline aspect literals updated to include reviewer.
## [2026-05-27T07:55:57.284Z]
Updated inline aspect fixture to include v5 reviewer field (reviewer: { type: llm }). Required because parseAspect now rejects aspects without reviewer.
## [2026-05-27T09:36:01.009Z]
Added Phase 9 validator tests: aspectParseErrors emission, config-reviewer-missing check (with and without configError), aspect-tier-unknown check (valid tier, missing tier, ast-type suppression, configError suppression).
## [2026-05-27T10:13:06.600Z]
Phase 9: rewrote validator-reviewer.test.ts to add tests for Tasks 36, 36b, 37, 37b, 38 — covering aspectParseErrors emission, config-reviewer-missing check, aspect-tier-unknown check, and secrets-non-credential-field check. Also added tests for missing rule-source combinations (LLM+only check.mjs, AST+only content.md) in validator-aspect-files.test.ts to cover previously uncovered branches.
## [2026-05-27T13:55:05.624Z]
Removed the test block that exercised the deleted reviewer-enum validator function. Reviewer shape is rejected at the parser layer; the validator no longer has structural responsibility for it.
## [2026-05-28T08:00:20.574Z]
Added validator-references.test.ts — four unit tests for the new aspect-reference-broken validation rule. Tests cover: (1) a missing reference file emits the error with the path in the what field; (2) a reference pointing at a directory emits the error; (3) a reference pointing at an existing regular file produces no error; (4) a reference pointing at a symlink that resolves to a regular file produces no error (confirming statPath follow-symlinks semantics). The test file was added to this node's mapping rather than creating a new node because these tests exercise the same validator pipeline as the existing validator test files in this node.
## [2026-05-28T08:06:31.692Z]
Added test coverage for the three new validator error codes introduced in checkAspectReferences: aspect-reference-too-large (per-file size limit), aspect-references-total-too-large (total bytes per aspect limit), and aspect-references-empty-array (warning for explicitly empty references list). Tests verify that per-tier size caps from the reviewer config are honored, that the default 64 KiB / 256 KiB caps apply when the tier omits the references field, and that the empty-array case produces a warning rather than an error.
## [2026-05-28T10:05:58.187Z]
Extended size-limit tests to assert the updated messageData.what field includes the tier name (e.g. 'standard' in single quotes) and KiB/bytes-formatted numbers. Tests verify both aspect-reference-too-large and aspect-references-total-too-large messages use the new tier-name format.
## [2026-05-28T12:19:51.828Z]
Add validator-aspect-status.test.ts to the mapping so the new test belongs to a node and satisfies the test-suite type's strict coverage. The tests assert validator's aspect-status-downgrade detection across single-channel and cross-channel scenarios: explicit-below-default flags a downgrade, equal-to-default is silent, raise-above-default is silent, and a flow channel enforced + node channel advisory triggers a downgrade on the node's explicit attach. The empty other-sources case verifies the anchor falls back to the aspect's default when only the explicit site exists.
## [2026-05-29T05:46:48.570Z]
Extended structure aspect validation coverage with four new test cases: structure aspect with content.md, structure aspect without check.mjs, structure aspect with check.mjs only, and structure aspect with both files.
## [2026-05-30T18:08:13.779Z]
The vocabulary for how a rule is verified was reduced from three kinds to two. Previously a rule was checked by one of: a human-language reviewer, a single-file programmatic check, or a graph-aware programmatic check. The two programmatic kinds are now a single "deterministic" kind, leaving just deterministic-or-reviewer.

The motivation: the three-way split was drawn on the wrong axis. It described HOW a programmatic check reached its context (one file at a time, versus the whole graph), but the distinction that actually matters to a rule author and to cost is whether verification is local-and-free or requires the paid, non-deterministic reviewer. The single-file kind was already a strict subset of the graph-aware kind — every input the former could see, the latter also provides — so maintaining two of them forced rule authors to make a false choice up front and forced the engine to carry two parallel handling paths for one concept. Collapsing them removes that false choice and the duplicated handling, and routes every programmatic check through the one graph-aware path.

The language a programmatic check infers for a source file is determined solely from that file's extension, so a check no longer declares which languages it targets. A rule's verification kind being deterministic is also no longer carried as a separate synthetic identity signal — a deterministic rule's identity is fully covered by the files it already tracks — which keeps re-verification of such rules free.
## [2026-09-25T21:14:14.667Z]
Covers one dead rule being one finding in the check and one nomination in the advise feed, the orphan finding surviving for a bundle and a draft, and a decision stored under the retired dead-attach name still applying to the renamed nomination.
