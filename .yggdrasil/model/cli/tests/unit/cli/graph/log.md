## [2026-05-27T07:22:38.664Z]
Phase 6 type-bridge: aspects.test.ts makeAspect helper updated to accept string shorthand for reviewer and convert to AspectReviewerSpec object form; string literals 'ast' / 'llm' in test calls remain valid via the helper bridge.
## [2026-05-28T14:02:06.781Z]
Add tests covering visible aspect status in graph-oriented CLI commands. yg aspects test asserts [<status>] tags appear next to each aspect id. yg find tests assert a status: <enum> line appears for aspect-kind results (default enforced and explicitly declared draft). yg impact tests assert effective status tags appear on directly affected nodes (--aspect) and on the Aspects: summary line (--node).
## [2026-05-28T19:39:36.893Z]
Tests for the new yg impact rendering-flip annotation: one case seeds a refused aspectVerdict in drift state and asserts the annotation appears; one case seeds an approved verdict and asserts no annotation.
## [2026-05-28T19:44:24.810Z]
Updated impact.test.ts assertion: file->nodePath message now flows through stdout (was stderr). Assertion checks stdout for full 'src/orders/order.service.ts -> orders/order-service' text instead of partial path on stderr. Matches the cli/commands/impact stdout-routing fix in the same review cycle.
## [2026-05-28T19:52:53.944Z]
Strip dangling design/plan section references from JSDoc and test descriptions. The design doc lives in .plans/ which is gitignored and will be deleted; references like 'spec §7', 'design §12.1', 'Task 14' become stale pointers to non-existent files. Replaced with self-contained prose. No behavior change.
## [2026-05-30T18:08:11.973Z]
The vocabulary for how a rule is verified was reduced from three kinds to two. Previously a rule was checked by one of: a human-language reviewer, a single-file programmatic check, or a graph-aware programmatic check. The two programmatic kinds are now a single "deterministic" kind, leaving just deterministic-or-reviewer.

The motivation: the three-way split was drawn on the wrong axis. It described HOW a programmatic check reached its context (one file at a time, versus the whole graph), but the distinction that actually matters to a rule author and to cost is whether verification is local-and-free or requires the paid, non-deterministic reviewer. The single-file kind was already a strict subset of the graph-aware kind — every input the former could see, the latter also provides — so maintaining two of them forced rule authors to make a false choice up front and forced the engine to carry two parallel handling paths for one concept. Collapsing them removes that false choice and the duplicated handling, and routes every programmatic check through the one graph-aware path.

The language a programmatic check infers for a source file is determined solely from that file's extension, so a check no longer declares which languages it targets. A rule's verification kind being deterministic is also no longer carried as a separate synthetic identity signal — a deterministic rule's identity is fully covered by the files it already tracks — which keeps re-verification of such rules free.
## [2026-09-23T20:10:27.186Z]
The description listed a verdict command and described verdict tests proving the external-judge channel, but that command and its tests were removed with the channel. It now names the commands whose tests this node actually maps, including the rule log beside aspects and the owner lookup the which tests exercise.
## [2026-09-25T21:14:18.483Z]
Assertions follow the one shared aspect-not-found refusal for an unknown rule id, which replaced this command's own wording.
