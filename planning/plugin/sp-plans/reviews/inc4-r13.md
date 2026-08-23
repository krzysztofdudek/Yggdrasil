# Increment 4 (R5) plan — adversarial review, round 13

**Target:** `planning/plugin/sp-plans/2026-08-22-increment-4-r5-verdict.md` (6245 lines), read in full.
**Tree:** branch `claude/document-review-13yoty`, HEAD `dd3deef`. Verified that `a761dda..HEAD`
touches **only** `planning/plugin/sp-plans/` (`git diff --stat` = 2 files, 6679 insertions, both
review artefacts), so every `a761dda` anchor in the plan is still an anchor into the current tree.

## VERDICT: 0 BLOCKING + 2 MAJOR + 5 MINOR

Round 13 is **not clean**. The consecutive-clean counter stays at **zero**.

Round-12's three repairs all hold under re-derivation (audited in detail below). Both new majors are
in a seam no round has audited end to end: **what the three pipeline stages can actually construct
from the parameters D1 gives them.** One stage is assigned a record it structurally cannot build;
one decision's fifth bullet describes a behaviour that cannot live where the pipeline puts it and
that no task, criterion or MR owns.

---

## MAJOR-1 — `applyBudgetsAndDedup(findings, fold, config)` is assigned the §18.1 intervention
telemetry row and the `'warned'` session events, and its stated parameters carry neither a session
id nor a clock — so the function D1 names cannot construct either record, and cannot typecheck

**Plan lines:** **613-616** (D1's pipeline block, the signature), **3394-3400** (T6 Step 3, which
calls it "the signature D1's pipeline names"), **1255** (D13a(b) transition 1's Writer cell),
**1732-1756** (T1's `SessionEvent` union), **1757-1759** (T1's `TelemetryRecord`), **2506-2508**
(`Intents`), **3339-3341** (`foldSession`'s result), **249-253** (R5-I4), 3544-3549 (T7 Step 3's
three-way merge).

**The assignment.** D13a(b)'s transition 1 (`:1255`) names the writer of the §18.1 intervention row:
"**T6**'s `applyBudgetsAndDedup`, in `emissionIntents`, for exactly the findings the budget
emitted". T6 Step 3 restates it (`:3398-3399`): "`emissionIntents` carries the `warned` session
events and the §18.1 telemetry lines for exactly the findings that were emitted". T7 Step 3
(`:3544-3549`) concatenates `emissionIntents` with `evaluate`'s `closureIntents` and the command
layer's `'checked'` event **into one `Intents` record**, so the three sets must be the same types:
`Intents { sessionEvents: SessionEvent[]; telemetry: TelemetryRecord[]; ledgerMarks: LedgerEntry[] }`
(`:2506-2508`).

**What those records require.** From T1's own interface block, which the plan says "none of them may
be left to an implementer's choice" (`:1731`):

```
{ ts, kind: 'warned',  stableId, surface, expected, observed, factKey, severity }   // :1733-1734
TelemetryRecord { sessionId, ts, stableId, surface, factKey, expected, observed,
                  severity, deltaBits, observedAfter? }                              // :1757-1759
```

Both require a **`ts`**; `TelemetryRecord` additionally requires a **`sessionId`**. Neither field is
optional in the declared shapes.

**What the signature supplies.** `applyBudgetsAndDedup(findings, fold, config)`:

- `findings: Finding[]` (`:2498-2504`) carries `stableId`, `fact` (hence `factKey`, `surface`,
  `expected`), `observed`, `deltaBits`, `severity` — every *content* field, and **no clock and no
  session id**;
- `fold` is `foldSession`'s result, declared exhaustively at `:3339-3341` as
  `{ warnCount, dedupKeys, openInterventions, writtenFiles, fileState, seedTruncated, floodSkipped,
  lastSweepTs, completenessEmitted }` — **no `sessionId`** (the id is a *parameter* of `foldSession`,
  not a field of its result, `:3342-3346`) and no timestamp;
- `config` is `RootsConfig` (`src/model/graph.ts:131`) — thresholds only.

**And it may not fetch them.** R5-I4 (`:249-253`) names `session-state.ts` among the six modules that
"contain … no `Date.now()`", and states the rule positively: "**Every clock reading, session
identity, file read and file append is a parameter supplied by the command layer**." The invariant
says the two missing values are parameters; the signature has no parameter for either. That is a
direct contradiction inside D1 itself, not between two documents.

**Why it is not a wording nit.** This is a compile failure, not a judgement call. `Intents.telemetry`
is `TelemetryRecord[]` with `sessionId: string` and `ts: string` required, so
`applyBudgetsAndDedup`'s body cannot produce one from `(findings, fold, config)` — the T6
implementer's first `tsc --noEmit` on `tsconfig.check.json` stops there. The escapes are both
forbidden by the plan: widening the signature re-litigates D1's pipeline block (a decision, so the
protocol's STOP fires, `:600`), and returning half-built records contradicts `Intents`' declared type
and T7 Step 3's concatenation. Note the contrast that makes the gap visible: `evaluate` has exactly
these two fields on `VerdictInput` — `sessionId` (`:2486`) and `nowIso` (`:2487`) — *because* it too
returns telemetry and ledger marks. The stage that was given a second set of intents was not given
the two fields that make them constructible.

Round 7's M1 was the same defect on `VerdictInput` (a stage asked to produce something its inputs
could not reach); this is its mirror one stage later, and the round-7 fix's own sentence — "every
later task adds *data*, never a new parameter" — is scoped to `VerdictInput` and does not protect
this signature.

**Fix.** Widen the stage's contract in D1's pipeline block and in T6 Step 3, in one edit, and say why
so it is not re-narrowed:

```
applyBudgetsAndDedup(findings, fold, config, { sessionId, nowIso })
                        -> { emitted, emissionIntents }   // session-state.ts (T6) — §11.3's ONE authority
```

with one sentence at both sites: "`sessionId` and `nowIso` are the same two values `VerdictInput`
carries (`:2486-2487`), supplied by `src/cli/roots-check.ts` for the same reason — R5-I4 forbids
`session-state.ts` reading a clock or deriving an identity, and §18.1's row and the `'warned'` event
both require a `ts` while the row additionally requires the `sessionId`." Then re-check T6 criterion
4c and MR-1b, which assert through the applied `Intents` and are unaffected by the widening.

---

## MAJOR-2 — D4's render-time exemplar re-validation has no owning task, no step, no criterion and
no killer, and the stage the decision assigns it to may not perform it (`no-direct-fs`)

**Plan lines:** **789-794** (D4's fifth bullet), 616 (D1's `render(emitted)` signature), 2123 (T2's
Authorities, citing design `:454`), 2429 (`VerdictFact.exemplars`), 1090-1098 (D9's enumeration of
the projection's non-copy fields), 2629-2635 (T3 Step 6, the `See:` line), 3030-3050 (T4 Step 3, the
notes), 2923-2929 (T3's e2e).

**The decision.** D4 (`:789-794`): "**Render-time re-validation** (spec: 'reaped scopes never
render') is a **file-existence check** at check time, not a re-parse… A message whose exemplars all
fail the existence check still renders, without the `See:` line". The mechanism is decided (existence
check, not re-parse), the fallback is decided (render without `See:`), and the authority is real —
§9.11 (`v6-spec.md:483-484`) and design §12's own productionized row (`integration-design.md:454`,
"§9.11 exemplar ranking … **with render-time re-validation**"), which T2 lists among its Authorities.

**Nothing owns it.** Searched the whole document: `re-validation` / `existence check` / `reaped`
appear at `:789-794` (D4 itself), `:2123` (the Authorities citation), and then only in unrelated
senses (`:2654` and `:2981` are gate −1's *own* existence filter on the files being checked; the
rest are the review history's "mechanical re-validation"). Concretely:

- **T2** builds `exemplars.ts` at index time; D4 places the re-validation "at check time", so T2
  correctly does not own it, and no T2 criterion mentions it.
- **T3 Step 6** (`:2629-2635`) renders "Appendix A's T1, first three lines plus the `See:` line" and
  says nothing about validating the three paths.
- **T4 Step 3** (`:3030-3050`) enumerates every note the template can carry — `{hook_shaped_note}`,
  `{seed_note}`, `{novelty_note}`, `{stability_note}`, the locality sentence — and does not carry the
  `See:`-line suppression.
- **No criterion.** T3's criteria are 7-15, T4's are 1-6; none asserts the deleted-exemplar case.
  T3's e2e asserts only the positive direction: "a `See:` line pointing at a real file and line"
  (`:2926`).
- **No MR.** MR-15..MR-18 cover row completeness, nameshape, the locality contrast and the naming
  leak. Nothing kills a missing existence filter.

**And the named home refuses it.** D1's pipeline puts rendering in `speech.ts`
(`render(emitted) -> string[] | VerdictJson`, `:616`), and R5-I4 (`:249-253`) lists `speech.ts` among
the six modules that "contain no `node:fs`" — `roots-engine` carries `no-direct-fs`
(`yg-architecture.yaml:749-755`). So "render-time" cannot mean "in the renderer". The only legal home
is the command layer's `VerdictFact` projection — but D9 (`:1090-1098`) enumerates that projection's
three fields that "are not copies of a `MinedFact` field" (`partitionId`, `roleLabel`,
`denyEligible`) precisely so none is discovered later, and `exemplars` is not among them;
`VerdictFact.exemplars` (`:2429`) reads as a straight copy.

**Why this is a MAJOR and not a nit.** It is exactly round 8's M4 shape — "a decision whose text
lives only in this block … is a decision the T1→T11 protocol will not build" (`:1641-1645`) — applied
to a decision that has *not* been given a home. Under the plan's own execution protocol a fresh T3/T4
implementer builds from "this plan plus the repository alone" and will ship `See:` lines pointing at
files that no longer exist: exemplars are other files' scopes recorded by the last `index`, and the
hook path's whole premise (D5, `:895-898`) is that the tree has moved since. The product's most
literal promise — "here are three real examples to copy" — silently becomes three dead paths, with
nothing in the increment able to notice.

**Fix.** Give it the only home the architecture allows, and give it an observer:

1. In D4's bullet, replace "at check time" with the owner: "performed by `src/cli/roots-check.ts`
   when it builds the `VerdictFact` projection — `speech.ts` carries `no-direct-fs` and may not stat
   anything (R5-I4), so the filter is a projection step: each `MinedFact.exemplars` entry survives
   only if `<repoRoot>/<rel>` exists."
2. Name it in D9's projection paragraph as the projection's **fourth** non-copy field, beside
   `partitionId` / `roleLabel` / `denyEligible`, and amend `VerdictFact.exemplars`' comment
   (`:2429`) from a copy to "the surviving subset".
3. Add it to T3 Step 8's set-resolution neighbourhood or to T3 Step 7's projection step, whichever
   the implementer reads first — one line either way.
4. Add a criterion (T4 is its natural home, beside criterion 4's note switching): "a fact whose three
   exemplar files have all been deleted still renders its first three lines and emits **no** `See:`
   line; with one surviving, `See:` names that one." And an MR — "skip the existence filter ⇒ the
   criterion fails with a `See:` naming a deleted file" — so R5-I11 is satisfied for a rule the plan
   states as binding.

---

## MINOR-1 — MR-19b's writer arm states a failure mode that D14's own write order rules out

**Plan lines:** 3297-3303 (MR-19b), 1881-1884 (T1 Step 3b's third reason), 3252-3274 (T5 criterion 4b).

MR-19b (`:3297-3300`) says: "make any one of R5-I15's five absorbed faults throw instead of
degrading — … or **delete the swallow from a `.state/` writer** … ⇒ criterion 4b fails on that
fault's leg: **the deviating file's finding disappears** and an incident appears where R5-I15
promises none."

For the four *read*-side faults that is right (they all precede evaluation, so the run genuinely
produces nothing). For the **writer** arm it is not, and T1 Step 3b says so itself sixteen hundred
lines earlier (`:1881-1884`): "D14 writes the **output first**, before any append, so by the time an
append can fail the message is already on stdout: a catch reporting 'zero findings' would be
describing a run that in fact spoke." Under the mutation the message is printed, *then* the telemetry
append throws, *then* the boundary catch records an incident — so criterion 4b fails on its
**zero-incidents** assertion, never on the finding. An implementer performing R5-I11's live
round-trip and looking for the stated observable would find the finding still on stdout and could
read the mutation as surviving.

**Fix.** Split MR-19b's stated failure by arm: "for the four read-side faults the run goes silent and
an incident appears; for the writer arm the message is already on stdout (D14's order, T1 Step 3b),
so what fails is criterion 4b's **zero-incidents** assertion — which is the whole reason 4b's fifth
leg keeps `.state/` itself writable."

## MINOR-2 — T3's Files says the seven-case boundary table is asserted by no landed test; six of the
seven are already asserted by value at HEAD

**Plan lines:** 2388-2393.

The bullet says `repo-scanner-nested.test.ts` "gains the **seven-case** table **no landed test
asserts by value**", then lists them. Measured at HEAD, that file already asserts six of the seven
against the real `findNestedProjectRoots`:

- `describe('findNestedProjectRoots — an empty .yggdrasil/ draws no boundary')`
  (`repo-scanner-nested.test.ts:97-165`) — empty `.yggdrasil/` **and** a `.yggdrasil/` holding only an
  empty subdirectory (not a boundary), plus the control: a `.yggdrasil/` with a real file (boundary);
- `describe('findNestedProjectRoots — the .git marker requires real content …')` (`:173-233`) — empty
  `.git/`, a `.git` file with garbage, an empty `.git` file (none a boundary), plus both controls: a
  `.git/` with a real `HEAD`, and a `.git` file carrying `gitdir: …` (both boundaries).

Only the **`.git` symlink** case is genuinely new (`grep -n symlink` over that file returns nothing).
The added table is still worth landing — the landed cases go through the whole-tree walker, while
the table would pin the newly-exported `isNestedProjectBoundary` directly — but the stated
justification is false, and it is the kind of claim an implementer acts on: read literally, finding
six of them already present invites skipping the table altogether.

**Fix.** At `:2389-2393`: "gains the seven-case table against the **newly exported predicate**
— six of the seven are already asserted at the whole-walk level (`repo-scanner-nested.test.ts:97-165`
and `:173-233`), and re-asserting them against `isNestedProjectBoundary` is what pins the extracted
function itself; the `.git` **symlink** case is the one no landed test covers at all."

## MINOR-3 — the "full new-edge audit" table omits the two existing unit-test nodes that gain new
edges, while carrying a row for the new e2e test node

**Plan lines:** 139-153 (the table), 179-189 (the unit-test ownership paragraph).

The table is billed as covering "every node this increment creates or edits" and its last row is a
*test* node (`cli/tests/e2e/roots-verdict`), so test nodes are in scope. Two edited test nodes are
missing, and both gain edges to nodes this increment creates:

- **`cli/tests/unit/roots`** (13 declared relations today) gains `→ cli/io/roots-state` (T1's four
  store tests import `src/io/roots-*-store.ts`) and `→ cli/roots/speech` (T3's `verdict.test.ts` /
  `speech.test.ts`, T6's `session-state.test.ts`, T7's `verdict-closure.test.ts`, T8's
  `health.test.ts`, T9's `sweep-state.test.ts`) ⇒ **13 → 15**;
- **`cli/tests/unit/cli/roots`** (7 today) gains `→ cli/commands/roots-check` (T3's
  `roots-check.test.ts`, required by `sibling-test-file`) ⇒ **7 → 8+**.

Nothing breaks — `test-suite` declares no type-level relation allow-list
(`yg-architecture.yaml:418-431`), so legality is trivial; both counts stay far under
`max_direct_relations: 20`; and neither approaches the 23 leaderboard tie. But the same omission was
round 4's M6 (rated MAJOR then, when a count moved), and the paragraph at `:179-189` that assigns
every new unit-test file its node discusses **mapping** only and never mentions the edges those files
create.

**Fix.** Two rows in the table, with the counts stated the way the `cli/commands/roots` row states
10 → 13, and a clause at `:186` noting that the unit-test nodes' `relations:` blocks grow with the
mappings.

## MINOR-4 — `cli/tests/support`'s node description enumerates its files ("A fourth file …", "All
four files"), and T3 adds a fifth

**Plan lines:** 2398-2403, 2893-2899; graph ritual at 558-568.

T3's new programmatic fixture builder joins `cli/tests/support`'s mapping. That node's landed
`description:` is written as an enumeration —
"A **fourth** file builds the shared branch-and-merge fixture … **All four files** import only Node
builtins; nothing from `src/**`" (`.yggdrasil/model/cli/tests/support/yg-node.yaml`) — so the moment
the fifth file is mapped the description is false, in the same way T2's `mine.ts:155-160`
"STRUCTURALLY ABSENT" comment goes false (which the plan tracks explicitly as a sixteenth site,
`:2193-2200`). The graph ritual (`:558-568`) covers mappings, relations, ceilings and log entries —
never node descriptions.

**Fix.** One clause in T3's Files bullet: "and extend that node's `description:` to name the fifth
file and keep its 'all N files import only Node builtins' sentence true — the description is the
node's own documentation and AGENTS.md's reflect-changes-in-documentation rule covers `.yggdrasil/`
metadata." (Prompt cost is nil: node descriptions are excluded from the assembled reviewer prompt,
`src/llm/prompt.ts:177-181`, which the plan already cites at `:120-121`.)

## MINOR-5 — T2's Files omits the four test files Step 1 mandates editing, and attaches "the eight
landed test sites" to the `stores.ts` bullet

**Plan lines:** 2137-2138 (the `stores.ts` bullet), 2168-2192 (Step 1's fifteen sites).

T2's Files reads "Edit `source/cli/src/roots/stores.ts` — `ROOTS_VERSION` 1 → 2 (D3), **plus the
eight landed test sites Step 1 names**." Those eight sites are not in `stores.ts`; they are in
`tests/unit/cli/roots.test.ts` (seven) and `tests/e2e/cli-roots-basic.test.ts` (one). And the seven
*body-shape* sites Step 1 also mandates — `tests/unit/roots/history-cochange.test.ts` (six) and
`tests/unit/roots/mine.test.ts:457`/`:470` — appear in Files not at all. So T2's Files names two of
the four test files it edits, and mis-attributes them.

This matters mildly beyond tidiness: one of the four (`cli-roots-basic.test.ts`) is an **e2e** file in
a different node from every other file T2 touches, and every other task in this plan lists such a
file explicitly (T3 lists `repo-scanner-nested.test.ts`; T10 lists `cli-roots-basic.test.ts`).

**Fix.** Move the parenthetical off the `stores.ts` bullet and add one Files line: "Edit
`source/cli/tests/unit/cli/roots.test.ts`, `source/cli/tests/e2e/cli-roots-basic.test.ts`,
`source/cli/tests/unit/roots/history-cochange.test.ts` and `source/cli/tests/unit/roots/mine.test.ts`
— the fifteen landed assertion sites Step 1 enumerates; all four are already mapped, so no node
moves."

---

## Round-12's three repairs, audited in detail (all three hold)

**(a) Criterion 14b's split — holds, and every graph claim behind it is true at source.**
`e2e-public-surface` is declared on `cli/tests/e2e` itself
(`.yggdrasil/model/cli/tests/e2e/yg-node.yaml:5`), `roots-basic`'s own `aspects:` is `[]`, so the new
`roots-verdict` node inherits it — the plan's claim, verified structurally rather than by re-running
`yg context`. `SRC_ROOT = 'source/cli/src/'` and the five import forms are as described
(`check.mjs:17`, `:2-8`), and the aspect's own description sanctions the escape the split uses
verbatim: "Shared e2e helpers under `support/` are fine: they read committed artifacts via `node:fs`
and import nothing from `src/**`" (`yg-aspect.yaml:2`). **Edge-free in both directions, checked
against both landed `relations:` blocks:** `cli/tests/e2e/roots-basic` declares
`uses cli/tests/support` + `uses cli/tests/fixtures`, and `cli/tests/unit/support/io` declares
`uses cli/tests/support` and `uses cli/io/stores` — the latter being the node that maps
`repo-scanner.ts` (`.yggdrasil/model/cli/io/stores/yg-node.yaml:29`), so the unit leg's import of
`findNestedProjectRoots` (`repo-scanner.ts:229`) needs no new edge either. The mapping anchor
`yg-node.yaml:40` is exact. The memoization note is right: `findNestedProjectRoots` caches per
resolved root (`repo-scanner.ts:230-236`) and the landed file already imports
`resetNestedProjectRootsCache` (`:218`) and calls it in every describe.
**MR-14f is observable at both ends** under one mutation: bare-existence boundary ⇒
`findNestedProjectRoots` gains `packages/pseudo-a` and `packages/pseudo-b`, failing the unit
assertion, **and** prunes both subtrees from `walkRepoFiles` (`:97`), so neither is mined and both
e2e legs go silent. Five e2e legs (three silent + two messages) ✓.

**(b) The `exemplars.ts` / `roleJaccard` route — reaches zero of the three sites, and `m1`'s
semantics survive exactly.** `roles.test.ts:162`, `:214`, `:230` are the only three
`expect(result).toEqual({ roleIndex: 0, ambiguous: false })` sites; `:167`, `:171`, `:189`, `:197`,
`:241` read `.roleIndex` and are unaffected. The chosen route edits no byte of `roles.ts` and no byte
of its test, so all three stand — the 660-char freeze holds literally, and the live measurement below
reproduces 660 exactly. **The m1 arithmetic re-derived against `roles.ts` as landed:** inside
`classifyAgainstMedoids` (`:351-373`), `m1` is precisely `max over medoids of roleJaccard(bag,
medoid.set)` — the same quantity, symbol for symbol, that D4 now computes in `exemplars.ts` from the
exported `roleJaccard` (`:194`) over the medoid bags and the scope bag from the exported
`buildRoleFeatureBag` (`:149`). §8.5's definition (`v6-spec.md:340`) matches both. `mine()` receives
`units` and `roles` (`mine.ts:911-912`), so the bags and the per-scope units are in hand at the call
site. Intra-node (`exemplars.ts` and `roles.ts` are both mapped by `cli/roots/engine`), so round 3's
`structural-cycle` argument is untouched, and `src/roots/` → `src/roots/` is on the ESLint fence's
allowlist.

**(c) T1 Step 3b's writer contract — consistent, and both fixtures really produce their faults.**
`appendToDebugLog` is `appendFileSync(filePath, text, 'utf-8')` and nothing else
(`debug-log-writer.ts:7-9`); `readFileOrDefault`'s header says "Any other error (EACCES, EISDIR,
EIO, …) is rethrown" (`read-or-default.ts:5-6`); `atomicWriteFile` mkdirs inside itself
(`atomic-write.ts:26-28`). Step 3b's D16.4 reconciliation is right: D16.4's prohibition is on the
*aggregation* path creating anything eagerly, Step 2b is about creating a parent before a decided
write, and Step 3b is about a decided write that then fails — three disjoint rules, now stated as
such. **The EISDIR fixtures work under root**: `open(2)` on a directory returns `EISDIR` for every
user, for both `readFile` (criterion 5b) and `appendFileSync` (criterion 6c), and Step 2b's
`mkdir(dirname, {recursive:true})` succeeds harmlessly first in every one of the three 6c cases.
Criteria 5b and 6c are their own killers as claimed. **T5 criterion 4b's five legs are disjoint**
(corrupt session line / non-JSON `demotions.json` / unregistered grammar / injected `parseFile`
throw / directory at `.state/telemetry.jsonl`) and its **zero-incidents assertion is real**: the
fifth leg leaves `.state/` writable, so `incidents.jsonl` could be written and the assertion is not
satisfied by an unwritable target — the distinction from criterion 6c's read-only-`.state/` arm is
stated at both ends. The only defect in this complex is MINOR-1 above, in MR-19b's prose.

**(d) The six measuring sites — the enumeration matches the tasks exactly.** Global constraints
(`:446-450`) names T2 Step 1, T2 Step 6, T5 Step 6, T6 Step 6, T7 Step 5, T9 Step 6; all six carry
`node scripts/prompt-headroom.mjs --file …` in their own text (`:2159-2161`, `:2233-2236`,
`:3209-3213`, `:3420-3422`, `:3552-3554`, `:4168-4171`), and each of the four `roots-check.ts` ones
is that task's **final** step (T5 ends at 6, T6 at 6, T7 at 5, T9 at 6) as `:500-503` claims. The
retired seventh (D4's fallback gate) is named as retired and appears nowhere as a live obligation.

**(e) 71 MR definitions, no duplicates, and the three-class property holds.** Mechanically: 71
distinct `- **MR-…:**` definitions, each exactly once, matching R5-I11's "(71 ids at present)"
(`:317`). 74 distinct ids are *referenced*; the three extras are `MR-32b2` (changelogs only) and
`MR-32c`/`MR-32d` (R5-I11's retirement sentence `:322`, T8 Step 2b `:3782`, and their own retirement
notice `:4060-4068`) — exactly as the plan states. Cross-reference sweep over all three classes, with
previous-line joining so a wrapped reference is not a false positive: **zero dangling** qualified
criterion refs, **zero dangling** qualified step refs, **zero dangling** bare in-task `Step N`
(the two apparent hits resolve to wrapped `T6 Step 1b` at `:4148-4149` and `T3 criterion 13` at
`:3284-3285`). Spot-checked by hand ≥10 per class: T1 c4b/c5b/c6b/c6c/c8/c8b, T2 c3b/c3c/c4b, T3
c8b/c8c/c14/c14b/c15, T5 c3b/c3c/c4b/c5b, T6 c4b/c4c, T7 c3b/c7, T8 c4b/c4c/c4d/c6/c7, T9
c5b/c5c/c5d, T10 c1b/c6 — all resolve.

## Worked numbers — every one re-derived from the spec, none moved

- **Six Δ rows (`:2777-2782`)**: `log2 7 = 2.8074`; `log2 13 = 3.7004`; `log2(41/3) = 3.77259`
  (quoted 3.7726 — fires at τ 3.5, not at 4.5); `log2 41 = 5.3576` at K = 5, n_eff 20 (spec E.6 says
  5.36, `v6-spec.md:920`); `log2(2.5/1.5) = 0.7370` at share 2/3, under E.2's exact-1.0-bit supremum
  (`:907`). E.1's `log2(2·n_eff+1)` identity holds for rows 1 and 2 (`:905`).
- **Eight Wilson figures (z = 1.96)**: n = 10 → 2/8 **0.056681**, 5/5 **0.236589**, 7/3 **0.396772**;
  n = 8 → 0/8 **0** exactly (`z·√(z²/4n²)` cancels `z²/2n`), 4/4 **0.215212**, 5/3 **0.305738**
  (clears 0.3 by 0.0057 — the four-place quote is justified), 6/2 **0.409271**. All eight match.
  §14's "z = 1.96 two-sided — fixed" confirmed at `v6-spec.md:637`.
- **T9's completeness trio (`:4183-4193`)**: 9/9 = 1.0 ≥ 0.75; 9/12 = 0.75 (inclusive boundary);
  9/20 = 0.45 < 0.75; `sup 9 ≥ minSupport 8` (`config-parser.ts:112`). Also checked that the row's
  own `conf: 1.0` is consistent with `conf = max(confAB, confBA)` in all three variants
  (`history-cochange.ts:396-398`), which is what makes MR-37b's mutation observable. §13.5's `E`
  excludes `D` and deleted partners (`v6-spec.md:625`) — matched by T9 Step 4.
- **Both fixture sizings**: 4b(ii)'s ~600 generated scopes (two buckets each clearing
  `PARTITION_SCOPE_FLOOR = 300`, `partitions.ts:69`, under `keyFor`'s closest-ancestor rule
  `:239-244`) ✓; 4b(v)'s "two sub-floor keys summing ≥ 300" ✓ against `repoBucketSurvives =
  mergedCount >= 300` over **only** the sub-floor keys (`partitions.ts:265-274`; an own-floor key
  never joins the merge, `:266-267`). Re-derived 4b(i) end to end as well: with a root marker,
  `fallback` is `null` (no key ever routes to `_root`, and the empty merge bucket is dropped), which
  is exactly what makes MR-8b's mutation produce total silence.
- **Criterion 8's margins (`:2038-2045`)**: 72 000 − 65 000 = 7 000; − 60 000 = 12 000; − 10 000 =
  62 000; `worstMargin` = 7 000 ✓.
- **MR-12's cancellation (`:2958-2963`)**: `p̂(e)/p̂(v)` cancels the shared KT denominator to
  `(n_e+½)/(n_v+½)`, so an in-alphabet zero-count value prices identically to ⊥ — §9.3's own
  "numerically like ⊥ but NOT novel" (`v6-spec.md:385`). MR-12 is correctly a novelty-*flag* killer.
- **Five epoch constants vs `weights.ts`**: 2026-01-01 = 1 767 225 600; 2026-01-15 = 1 768 435 200
  (= +14 × 86 400); 2026-01-14 = 1 768 348 800; 2026-04-01 = 1 775 001 600 ⇒ `stableDaysOf` exactly
  90; 2026-03-31 = 1 774 915 200 ⇒ 89. Checked against `stableDaysOf` (`weights.ts:108-110`), the
  `<` and `>=` senses in `releasedMarks` (`:255`, `:259`), `rowFor(mark.stableId, mark.stableId)`
  (`:253`), `Date.parse(mark.date)` (`:256`), `markKey` (`:267-269`) and `ledger.releaseStableDays:
  90` / `releaseMinDaysAfterMark: 14` (`config-parser.ts:113`).
- **Echo-shaped sizing vs `mdl.minInstancesRaw = 5`** (`config-parser.ts:78`) ✓ — the control leg's
  added constraint is correctly derived.
- **The prompt-margin measurement, re-run live at HEAD** (`node scripts/prompt-headroom.mjs`):
  `'standard' tier ceiling: 72000`, **1198 LLM pair(s) across 1 tier**, margins **657**
  (`tests/unit/core/fill-det.test.ts`), **660** (`tests/unit/roots/roles.test.ts`), **849**
  (`src/core/advise-nominations.ts`) — the plan's three figures reproduced exactly, byte for byte.
  The one-LLM-pair prediction basis is confirmed at source too: `deterministic` is
  `reviewer.type: llm`, `per: file`, `content.md` **1 182 B**; `source-hygiene` is an aggregate with
  no own reviewer; `command`'s LLM aspects are exactly two (`cli-command-contract`, 3 124 B, and
  `diagnostic-logging`); `persistence-adapter`'s is exactly one (`silent-missing-files`);
  `test-suite`'s is exactly one (`test-deterministic`). All four inherited `cli`-node aspects and
  `no-buildissuemessage-in-engine` are deterministic, so none adds a pair.
- **The live aspect counts the plan quotes**: `yg context --node cli/commands/roots` → **18**;
  `--node cli/io/stores` → **16**. Both exact.

## Landed-surface anchors re-verified (~95 checked; all correct unless listed above)

`mine.ts:121/125/130-132/141-142/155-160(:156,:157)/163/225-231/234/911-912/1035`;
`mine-stages.ts:52`; `partitions.ts:69/101-102/126-137/136/218-220/237/239-244/265-274/272/284/291`;
`roles.ts:149/194/335-339/351-357/363-369`; `extract.ts:72/203-204/417/627-628/748/795-798`;
`pipeline.ts:41/44/91/92/96-100/101-118/103/104/108-109/111/113/115-118`; `history.ts:89/1091-1094`;
`history-cochange.ts:94/109-112/393-400`; `history-resume.ts:62/394`;
`stores.ts:25-37/38/43/61-63/160-162/206-211/274`;
`cli/roots.ts:99-113/128-129/400-409/457/491-510/538/551-556`;
`weights.ts:108-110/232-244/250/253/255-259/267-269`;
`repo-scanner.ts:21/33/55/99/218/229/260-269/261-266/305/322-335/339/524-538`;
`config-parser.ts:41-140` (every D23 key: `:42-43`, `:51`, `:57-62`, `:78`, `:91-92`, `:112`, `:113`,
`:114-123`, `:124`, `:125`, `:128-130`, `:131-138`, `:135`, `:136`, `:137`, `:139`);
`debug-log-writer.ts:7-9`; `read-or-default.ts:5-6/10`; `atomic-write.ts:26/27-28`;
`incidents-store.ts:168-177`; `model/graph.ts:131/248/273`; `llm/prompt.ts:177-181`;
`relations/extractors/typescript.ts:180-181`; `core/checks/relations.ts:73`; `core/validator.ts:192`;
`core/check-codes.ts:28-36/96`; `model/lock.ts:80` (`fileUnit` = `file:<path>`, which is what makes
T1 Step 6's `unitKey` match work); `core/fill-llm.ts:206`;
`yg-architecture.yaml:43-48/49-57/61/68-74/82/183/197-203/206-209/341/418-431/442-454/742-748/749-755/759-760/774-777`;
`yg-config.yaml:3/9/43`; `init-scaffold.ts:143/147`;
`.yggdrasil/model/cli/io/stores/yg-node.yaml:18/24/25/28/29`;
`.yggdrasil/model/cli/roots/engine/yg-node.yaml:173-174/179-180/185-186/187-201`;
`.yggdrasil/model/cli/tests/unit/roots/yg-node.yaml:287-288`;
`.yggdrasil/model/cli/tests/unit/support/io/yg-node.yaml:40`;
`.yggdrasil/model/cli/tests/e2e/yg-node.yaml:5`; `.yggdrasil/model/scripts/yg-node.yaml:8`;
`portal-derive-rest.test.ts:69-80` (32/25/24/23/23/23) and `:77-78` (`cli/entry` at 23);
`cli-roots-basic.test.ts:46-52/73/159/160/209/212/237/239`; `roles.test.ts:162/214/230`;
`repo-scanner-nested.test.ts:8-9/40`; `prompt-headroom.mjs:249-254/452/455/456/558-564/567/570/576`;
`prompt-headroom.test.ts:17/470-500`; `repo-check.sh:209/210`;
`sibling-test-file/check.mjs:3/6-31/35-41`; `command-contract-shape/check.mjs:46-62`;
`atomic-write-contract/check.mjs:4/15/19/21-22`; `read-or-default-via-helper/check.mjs:36-48`;
`e2e-public-surface/check.mjs:17` + `yg-aspect.yaml:2`; `cli-command-contract/content.md` (the
option-mutex + `process.exit(1)` clauses R5-I1's carve-out rests on). Spec and design citations
spot-checked at 68 and 42 line anchors respectively; every one resolves to the text the plan quotes,
including the two that earlier rounds moved (`v6-spec.md:428` is §9.4i's closing "Measured, not
projected." paragraph carrying both the label rule and the locality sentence; `:479` carries
`closeIntervention`'s "at most once per session per intervention (**the open record** …)").
`cli/commands/roots` has exactly **10** declared relations today, so 10 → 13 and "clear of the 23
tie" both hold.

## Closest calls that were checked and did NOT become findings

- **`status`'s a761dda byte baseline vs T2's body change.** `renderRootsStatusInner`
  (`cli/roots.ts:368-448`) prints partition/fact/role/seed **counts** and the history lines, none of
  which moves when `exemplars`, `partitionRouting` or `commitsA`/`commitsB` arrive, and
  `isMinedModel` is structural, not exhaustive (`mine.ts:234-247`) — so T10 criterion 1 survives T2
  intact. It also never prints `rootsVersion`, so the D3 bump does not move it either.
- **Adding three interfaces to `src/model/graph.ts`.** The `types` node carries only
  `source-no-raw-control-chars` and `source-hygiene` — **no LLM aspect at all**
  (`yg-architecture.yaml:345-348`) — so there is no prompt-ceiling exposure and no `log_required`,
  exactly as T1's Files claims.
- **`cli/tests/unit/cli/roots → cli/commands/roots-check` as a possible cycle** with
  `cli/commands/roots-check → cli/tests/unit/cli` (`sibling-test-file`). Not a cycle: the landed
  `cli/commands/roots` ↔ `cli/tests/unit/cli/roots` pair has exactly this shape today and passes,
  because the declared edge targets the parent node, not the child.
- **The demotion e2e leg's silence assertion** could in principle be produced by the fact losing
  eligibility at the second `index` rather than by demotion. Re-derived and dismissed: the leg writes
  no ledger mark (stated, `:4016-4017`), and one deviant among the conformers keeps the survived raw
  share at 0.8 against `eligibilityMinRawShare` 2/3 (`config-parser.ts:88`) for any sane fixture, so
  the round-11 sizing constraint that genuinely bites the *control* leg does not bite this one.
- **Criterion 8b's scratch fixture vs the script's completeness guards.** `assertMeasurementComplete`
  compares parsed entries against the run's **own header** LLM-verified count
  (`prompt-headroom.mjs:298-309`), and `classifyZeroMeasurement` only fires at zero entries — so a
  scripted stand-in emitting a header plus a handful of prompt-too-large lines satisfies both. The
  criterion is executable as written.
- **`~22 new tests/** files` in criterion 8b's rationale (`:2060`)** actually counts to 29 across the
  tasks (17 `tests/unit/roots`, 3 `tests/unit/cli`, 8 `tests/e2e`, 1 `tests/support`), so "roughly 34
  new pairs" is nearer 41. Both figures are explicitly hedged and the direction is conservative — a
  larger movement strengthens, not weakens, the criterion's conclusion that this repo's output cannot
  be the baseline — so it is recorded here rather than raised.
- **The `pid` token in T4 Step 6's forbidden list** is a bare substring and would trip on a real path
  or scope name containing it (`rapid`, `cupid`). The corpus is fixture-controlled and no landed
  golden carries such a name, so this stays a note rather than a finding.
- **`T5 Step 5`'s staleness modulator has no MR.** Its display half is killed by T10 criterion 3 and
  MR-40; its check-path half is inert in R5 (nothing reaches DENY), so there is no observable for a
  killer to move — the honest position R5-I11 already sanctions.
