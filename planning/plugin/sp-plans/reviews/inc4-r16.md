# Increment 4 (R5) plan — adversarial review, round 16

**Target:** `planning/plugin/sp-plans/2026-08-22-increment-4-r5-verdict.md` (8253 lines)
**Tree:** branch `claude/document-review-13yoty`, HEAD `099653c` (`git log a761dda..HEAD -- source/` empty — every landed anchor below was checked at HEAD and is therefore also a761dda)
**Prior rounds read for context only:** `inc4-r12.md` … `inc4-r15.md`

## VERDICT — 0 BLOCKING + 2 MAJOR + 6 MINOR

Not clean. The two majors are the same defect class round 15 iterated its producer/consumer walk to
"fixpoint" over — **a branch a stage cannot take, and a killer that cannot fail** — and both sit on
the one question the walk did not ask of both producers: *what happens at closure when the surface
value is `null`?* T8 answers it and cannot implement the answer at the layer the plan puts it;
T7 never asks it at all. The fixpoint claim is therefore **false**: a complete pass over the
closure's own three-way branch, against both of its producers, was not made.

Everything else re-derived independently held. Verified from source this round, not taken on
report: all six Δ rows, all eight Wilson figures, T9's completeness trio, D26(a)'s two fixture
sizings and 4b(ii)/(v)'s scope arithmetic, criterion 8's three margins, MR-12's KT cancellation,
all five epoch constants including both boundary flips, the 6+4+2+29 = 41 pair count re-counted
from the Files blocks (28 `*.test.ts` + 1 support builder; 8 e2e files), the live
`prompt-headroom.mjs` run (**1198 pairs, 657 / 660 / 849 — reproduced byte for byte**), the 76
unique MR definitions with only MR-32c/MR-32d referenced-and-retired, a mechanical re-validation of
every qualified `T<n> criterion <m>` / `T<n> Step <k>` reference (**two hits, both the documented
`T8 Step 2a`/`2b` subsections**), T2 Step 1's **fifteen** landed assertion sites re-counted at
source (7 + 1 + 6 + 1, and no sixteenth `rootsVersion` literal exists in the tree), D4's three
exact-shape `roles.test.ts` assertions at `:162`/`:214`/`:230` versus the five field reads at
`:167`/`:171`/`:189`/`:197`/`:241` (exactly as stated — I mis-read this once and re-checked), the
whole D8 decorative-deletion arithmetic, every graph relation count (10 / 13 / 7) and the fan-out
leaderboard pin (32/25/24/23/23/23, `cli/entry` at 23), every type's aspect list and relation
allow-list, the complete LLM-aspect roster (so `roots-engine` = 1 pair, `persistence-adapter` = 1,
`command` = 2, `test-suite` = 1), every `config-parser.ts` line anchor in D23 including
`minOwnFeatures` at `:136` versus `minClusterSize` at `:135`, and ~60 spec line citations read in
full (§9.10 `:479`, §18.2 `:683`, §9.4i `:428`, §9.4c.4 `:409`, §11.4 `:554`, §12.5 `:586`,
§21.1 `:719`, Appendix D `:867`/`:890`/`:892`, E.1/E.2/E.6/E.7).

---

## MAJOR

### MAJOR-1 — T7's compliance closure has two branches where the spec and T8 both have three; the missing one banks an `ignored` sample for an undecidable value

**Where.** T7 Step 2, plan `:4343-4346`: *"**Step 2: The two branches** … Open intervention on
`(stable_id, surface)` and `v == expected` ⇒ … complied … **Open and still deviating** ⇒
`observedAfter: ignored`."* D13a(b)'s lifecycle table (`:1488-1494`) carries the same two
in-session transitions and no third.

**Why the third branch is reachable, not theoretical.** T3 Step 4 (`:3290-3295`) fixes the skip
ladder deliberately so that *"compliance closure would run first … then `!hookEligible`; then
locally demoted; then `v == null`, `v == expected`, `v == suppressedValue`"*, and states in the
same breath that **"Order is behavior, not style"**. So closure runs **before** the `v == null`
skip, by design, and `VerdictInput.surfaceValue` is declared `=> string | null` with `null` meaning
out-of-domain (`:3059-3062`). An in-session re-check of a scope whose surface has left its domain
(a categorical enumerator that no longer fires — e.g. a method that no longer makes any call for
`auto.call:*`) reaches T7's closure with `v === null`.

**What the plan's own text then prescribes.** `null !== expected`, so the only remaining branch is
"still deviating ⇒ `observedAfter: ignored`". That banks a resolved `ignored` sample and sets
`ignoredRecordedInSession` for a value the product itself calls undecidable. Three authorities
refuse it, and the plan cites all three elsewhere:

- **§9.10 `:479`** (verified in full this round) is written as two conditionals — *"If one exists
  and `v == f.expected` … If one exists and **`v` still deviates**"* — and a `null` satisfies
  neither.
- **§6.4's sparse-boolean clause `:213`**, quoted verbatim: *"A scope outside the domain
  contributes nothing (**undecidable ≠ false**)."* The plan invokes exactly this line for T3
  criterion 11 / MR-14 on the *speech* side.
- **T8's own rule for the identical question**, plan `:4767-4769`: *"**A `null` value — the scope
  exists but is out of the surface's domain — is `gone`, not `complied`**: undecidable is never a
  deviation (`v6-spec.md:213`) and is equally never a compliance, so it may not bank a sample or a
  ledger mark."* T7 gets no such sentence.

**Consequence.** A resolved `ignored` row enters §18.2's denominator for a fact nobody was shown to
have ignored — the demotion-biasing direction §18.2 explicitly rules out (*"a lost demotion
resurrects a FACT, never falsely silences one"*, `:683`) — and it does so on the *in-session* path,
which D13a(d)'s S1 makes the only path T8's demotion e2e drives. No criterion in the increment
observes it: T7 criteria 1, 2, 3, 3b and 4 all drive scopes whose value is a real string, and
MR-34e's arms are all pointed at T8.

**Fix.** State the third outcome at T7 Step 2 and at D13a(b), and give it an observer:
1. T7 Step 2 becomes three outcomes — `v === expected` ⇒ complied (transition 3); `v` present and
   different ⇒ ignored (transition 2); **`v === null` ⇒ neither branch fires: no telemetry row, no
   `'closed'` event, no ledger mark, and the intervention stays open** for T8's pass to resolve at
   session end. (Leaving it open rather than dropping it is the in-session-correct answer: the
   surface may re-enter the domain before the session ends, and an in-session drop would need a
   session-log event the union has no arm for.)
2. Add the transition row to D13a(b) so its "every transition names the event that causes it" claim
   stays true, and one line to D13a(a)'s derivability note.
3. Add a T7 criterion (an open intervention whose scope's surface value is `null` at re-check ⇒
   `telemetry.jsonl` and `ledger.jsonl` byte-identical, the session log gains no `'closed'` event,
   the intervention is still open in the fold) and an MR that flips it to `ignored`. Without the MR
   this is a rule with no killer, which R5-I11 refuses.

---

### MAJOR-2 — `currentValue`'s declared contract makes T8 criterion 4 leg (iv) indistinguishable from leg (iii), and leaves MR-34e's mirror arm with no observer

**Where.** The lookup is declared twice, identically, as a **two-arm** union:
- D26.4, plan `:2043-2044`: `currentValue(intervention) → { state: 'gone' } | { state: 'value'; v: string }`
- T8's Files block, input 6, plan `:4596-4598`: same signature, `v: string`.

**The rule that cannot live where the plan puts it.** T8 Step 2's branch table (`:4764-4769`) reads
as `health.ts`'s own logic — *"Then, per §18.2: the value **equals `expected`** … ⇒ a `complied`
sample **and** the §18.3 mark; the value is present and **differs** ⇒ an `ignored` sample; **gone**
⇒ … dropped. **A `null` value … is `gone`, not `complied`**"* — but under the declared contract
`health.ts` can never receive a `null`. The `null → gone` mapping is forced into the *command
layer's* builder in `src/cli/roots.ts` (Step 2's numbered step 3, `:4761-4762`, is where
`surfaceValue` — which does return `string | null` — is actually called). So the plan states a
branch for a stage that structurally cannot take it.

**Two consequences, both of the class the plan refuses elsewhere.**

1. **T8 criterion 4 leg (iv) is vacuous.** Criterion 4 (`:4944-4956`) is explicitly a unit-level
   assertion — *"With five open interventions in one ended log and **both lookups supplied by
   value** — `currentValue` and `resolveFact`"*. Under the two-arm contract, leg (iii) (*"a scope
   whose `skeyR` is absent from the re-enumeration"*) and leg (iv) (*"a scope that is **present but
   whose surface value is `null`**"*, `:4951`) are **the same injected input** — `{state:'gone'}` —
   producing the same output. The criterion's own justification for the split ("gone has three
   producers inside this criterion") is false at the layer it drives: only leg (v)'s producer
   (`resolveFact → null`) is a genuinely distinct input to `health.ts`.
2. **MR-34e's mirror arm cannot kill.** `:5237-5239`: *"treat a `null` (out-of-domain) value as
   `complied` rather than as gone ⇒ **criterion 4's leg (iv) fails**, with a committed ledger mark
   written for a scope nobody complied with."* Applied inside `health.ts` the mutation is
   inexpressible (there is no `null` to treat); applied in the command layer's builder — its only
   possible home — it is bypassed by criterion 4's injected lookup. Either way the mutant survives.
   R5-I11's own words: *"an MR whose mutation cannot change any observable is not a killer, and
   keeping it is worse than having none."*

**Fix (preferred — it also restores symmetry with the check path).** Widen the contract to
`currentValue(intervention) → { state: 'gone' } | { state: 'value'; v: string | null }` at both
declaration sites (D26.4 and T8's Files block input 6), and keep the `null ⇒ gone` rule **inside
`health.ts`**, exactly where T8 Step 2's prose already puts it. That is precisely the shape the
check path already has — `VerdictInput.surfaceValue` returns `string | null` and the engine owns
the "null is not a deviation" rule (T3 criterion 11, MR-14) — so the two paths stop diverging on
where "undecidable" is decided. With the widening: leg (iv) becomes a distinct injected input
(`{state:'value', v:null}`), leg (iii) keeps `{state:'gone'}`, and MR-34e's mirror arm becomes a
one-line `health.ts` mutation that fails leg (iv) for real. The command layer's step 3 then simply
forwards `surfaceValue(surface)` unchanged, which is one fewer rule in the layer that may not hold
rules.

*(The alternative — keep the contract and re-home leg (iv) and MR-34e's mirror arm onto a
command-layer or e2e observer — works but costs a new fixture and splits one rule across two
layers; the widening costs one character.)*

---

## MINOR

### MINOR-1 — the fold has no rule for a second `'warned'` on an already-open intervention, and T6 criterion 2 produces exactly that sequence

T6 Step 1's `openInterventions` rules (`:4149-4152`) are *"`'warned'` opens, `'closed'`+`'complied'`
removes, `'closed'`+`'ignored'` with `scope: 'session'` leaves the record open …"* — no clause for
a `'warned'` whose `(stableId, surface)` is already open. T6 criterion 2 (`:4262-4264`) *requires*
that sequence: *"the same `stable_id` and `surface` with a **different** observed value emits
again (direction is part of the key)"*, and T6 Step 3 appends a `'warned'` event for every emitted
finding. Two `'warned'` events for one pair therefore land in one session log by design.

The natural implementation (`map.set(key, …)`) overwrites, which resets `ignoredRecordedInSession`
to `false` and re-dates the "as emitted" `severity`/`deltaBits` pair D13a(a) requires closure rows
to copy — breaking §9.10's once-per-session log bound (`:479`) in a way T7 criterion 2 cannot see,
because that criterion re-checks the *same* value and so never mints a second `'warned'`.

The plan does contain the answer, but 2,500 lines away and in an unrelated paragraph: T8's e2e
re-plant mechanic, `:5105` — *"An intervention opens only when a session's **first** check sees a
deviating scope."* A T6 implementer building "from this plan plus the repository alone" will not
find it there.

**Fix.** One clause at T6 Step 1 and one at T1's `'warned'` arm: a `'warned'` whose
`(stableId, surface)` is already open is a **no-op for `openInterventions`** — the intervention keeps
its first emission's `expected`/`severity`/`deltaBits` and its `ignoredRecordedInSession` — while
still contributing its own `dedupKeys` entry and `warnCount`. (Worth naming `warnCount`'s identity
set in the same clause: T6 Step 1 calls it "`warnCount`'s underlying identity set" without saying
what the identity is, and (stableId, surface) versus the dedup key differ by exactly this case.)

### MINOR-2 — D8 cites `mine.ts:496` for a `set` call that is at `:542`

D8, `:1229-1230`: *"`computeRoleLiftForPartition` writes one entry per role unconditionally
(`mine.ts:496`, the `liftByRoleKey.set(...)` at the end of its per-role loop)"*. At HEAD, `:496` is
`function computeRoleLiftForPartition(` — the declaration; the `liftByRoleKey.set(role.roleKey, …)`
is at **`:542`**. The claim itself is correct (I verified the call is unconditional inside
`for (const role of rolesForPartition)`, and that `roleLiftByKey` at `:970`/`:985` is populated from
its return, making `MinedRole.roleLift` at `:1032` total), so only the anchor is wrong — but D8's
decorative-deletion is an evidence-driven decision and the plan's own Anchors rule asks for drift to
be reported. **Fix:** `:496` → `:542`, or cite the function as `:496-546`.

### MINOR-3 — "`induceRoles` writes an entry for every eligible scope" contradicts D26.2 and the code

Stated twice — D8 `:1234` and T3 criterion 8c `:3534` — as *"`induceRoles` writes an entry (a
`roleKey` or `'-1'`) for every eligible scope it saw (`roles.ts:983`)"*. D26.2 `:1937-1939` says the
opposite and is the one that matches the tree: *"an ineligible **or role-less** scope carries **no**
`assignments` entry at all"*. The write loop is
`for (const item of eligible) { const idx = rank1RoleIndex.get(item.unit.stableId); if (idx === undefined) continue; … }`
(`roles.ts:978-985`), and `rank1RoleIndex` is populated only when `classifyAgainstMedoids` returns
`roleIndex >= 0` (`roles.ts:913-914`). An **eligible** scope that matches no medoid gets no entry.

Neither conclusion moves — D8's decorative argument only needs scopes that *do* carry a decorative
`roleKey`, and criterion 8c's "new since the index" fixture is still the right one — but the plan
now asserts P and ¬P about the same landed function in two decisions. **Fix:** at `:1234` and
`:3534`, "for every eligible scope it **classified into a role**"; D26.2 already carries the exact
statement to reuse.

### MINOR-4 — `resolveFact` resolves roles from `assignments` alone while the check path runs a three-rung ladder; the consequence is never derived

D26.2 (`:1982-1987`) and T8's Files block input 5 (`:4578-4586`) fix Q1's resolution as
`routePartition → assignments[skeyR] → D8's selector`. The check path's role answer is
`resolveRolesForCheck` — **rung 0 eligibility + rung 1 sticky + rung 2 `classifyAgainstMedoids`**
(T3 Step 2). The two agree for every scope the index assigned, and for ineligible or role-less
scopes (both `null` on both paths). They diverge for exactly one class: a scope **new since the
index**, which rung 2 may place in a role and which `assignments` does not know — so the check path
can warn under a role fact's `factKey` while T8 pools that row under `_all`.

The divergence is *named* in passing (T3 Step 3, `:3282-3284`: *"`roleOf`'s answer on the check
path, `assignments[skeyR]`'s on T8's"*) but never analysed, and the plan's interaction pass claims
the opposite shape (*"one governance rule, one call, so the two applications of 'D8's governance'
cannot diverge"*, `:8172-8173`) — true of the *fact selector*, not of the *role input* fed to it.
§18.2's "via current membership" (`:683`, read in full) arguably makes the assignments-only reading
the **correct** one, and the expected-flip filter catches the sub-case where the two facts disagree
on `expected`; but where they agree, a role-fact sample pools into the `_all` fact — a pollution in
the falsely-silence direction §18.2 rules out.

**Fix.** One paragraph at D26.2, in the register T3 Step 2 already uses for the medoid push-order
tie (*"That exposure is accepted and named rather than engineered around"*): name the class (rows
recorded against a rung-2 role for a scope the snapshot does not know), name the outcome (pools
under `_all`, partially guarded by the flip filter), and state that this is §18.2's own "current
membership" rather than a fidelity loss. Then T3 Step 3's parenthetical stops being the only place
a reader can learn the two inputs differ.

### MINOR-5 — D14's "they enter `D`" is unobservable: completeness is once-per-session and computes `D` from the fold alone

D14, `:1600-1605`, justifies the flood-skipped sweep appending no `'checked'` by saying the deferred
paths *"enter `D` when they are actually taken up — in the deferred `stop` summary, which evaluates
files and therefore appends its own `'checked'`"*. But T9 Step 4 (`:5314-5316`) defines
`D = foldSession`'s `writtenFiles` — the fold as read at the start of the run — and T9 criterion 5
(`:5394`) pins *"A second `stop` run in the same session emits nothing"*. The deferred summary's own
`'checked'` is appended by the same `stop` run, after that fold, and no later run consumes it. So on
a flood-skipped session the deferred paths reach `writtenFiles` in the log and **no completeness
computation ever sees them**.

**Fix.** One sentence at T9 Step 4 (and matching D14): the `stop` run's `D` is the fold's
`writtenFiles` **unioned with this run's own `'checked'` payload** — the same merge D1 already has
the command layer perform on `Intents`. That makes D14's claim true, costs nothing on the Edit-only
path (a `stop` run that evaluates nothing contributes an empty set), and needs no new criterion
beyond extending criterion 4's flood→stop leg to assert the deferred paths' partners.
*(If the intended behaviour is the opposite — deferred paths deliberately get no completeness — then
D14's "they enter `D`" should say "they enter `writtenFiles`" and record the loss.)*

### MINOR-6 — T5 criterion 4b's leg 2 is not the R5-I15 fault it is claimed to be

T5 Step 3, `:3948-3949`: *"4b's five legs are exactly R5-I15's five faults."* R5-I15's second fault
is *"an **unreadable** `demotions.json`"*, owned by *"T1 Step 3's I/O half (criterion 5b)"* — and
R5-I2 goes out of its way to keep the two apart (`:235-237`: *"the *content*-shaped cases are
criterion 5, and the two are different faults with one outcome"*). T5 criterion 4b's leg 2
(`:4023`) is *"a **non-JSON** `demotions.json`"* — the content fault, absorbed by `readDemotions`'
own parse handling, which needs none of the wrapper T1 Step 3 had to add because
`readFileOrDefault` rethrows every non-ENOENT error (`read-or-default.ts:5-6`, verified).

Coverage is not actually lost — T1 criterion 5b is the wrapper's killer and says so — but the
"exactly" is false, and the leg with teeth at the *run* level is the one that is missing.
**Fix:** make leg 2 *"a `demotions.json` that is a **directory** (EISDIR — no `chmod`, not skipped
under root)"*, matching T1 criterion 5b's own fixture choice, or drop the word "exactly" and say
which of the five 4b substitutes a sibling fault for.

---

## What was checked and found sound

Recorded so a later round need not repeat it.

- **The producer/consumer walk, re-run independently over the full D13a table, the `SessionEvent`
  union, `OpenIntervention`, `Finding`, `VerdictFact`, `VerdictInput`, `Intents` and
  `foldSession`'s nine fields.** Every field of every record has a producer that holds its inputs
  and a consumer that reads it, with the two exceptions above. Spot-confirmed: all three
  `TelemetryRecord` producers can construct all 14 fields; `OpenIntervention`'s 11 fields are all
  foldable from the `'warned'` arm plus the fold's `sessionId` parameter; `Finding`'s 15 are all
  consumed; `VerdictFact` carries exactly MinedFact's 18 projectable fields plus D9's four
  non-copies (`partitionId`, `roleLabel`, `denyEligible`, `exemplars` — `exemplars` being both a
  copy target and a non-copy); `lastSweepTs` has a real consumer (the debounce) and a real producer.
- **Round-15's contract changes.** `resolveFact`'s identity-tuple typing genuinely serves both T8
  stages and genuinely does not typecheck over a `TelemetryRecord` for the closure caller; the
  grouped `sessionEvents` return is genuinely required by `appendSessionEvents(stateDir, sessionId,
  events)` and by the `'closed'` arm carrying no session id; MR-32g is unexpressible against the
  grouped shape and observable against the flat one at criterion 4d's two-ended-log fixture; the
  `decorativeRoles` deletion's arithmetic is exactly right at `mine.ts:626` / `:970-987` / `:1032`
  and `isDecorativeRole` is `roleLiftValue <= 0` (`roles.ts:598`).
- **`scopeKind`'s union at every site** — `EvaluatedScope.kind`, `Finding.scopeKind`,
  `VerdictFact.appliesKind`, the `'warned'` arm and `OpenIntervention` all spell
  `'method' | 'type' | 'file'`; `ScopeKind` at `extract.ts:100` is exactly that, so
  `VerdictFact.appliesKind`'s narrowing from `ScopeKind | 'module'` is the stated module drop and
  nothing else. `TelemetryRecord`'s shorthand listing types no field but `observedAfter`, which is
  consistent with the rest of that block.
- **~90 landed anchors** re-located at HEAD, including every one round 15 claimed to have verified:
  `stores.ts` `:25-37`/`:38`/`:43`/`:61-63`/`:160-162`/`:206-211`/`:274`; `roots.ts`
  `:99`/`:128`/`:491-510`/`:538`/`:549-556`/`:711-725`; `weights.ts`
  `:108-110`/`:235-244`/`:250`/`:253`/`:256`/`:267-269`; `partitions.ts`
  `:69`/`:102`/`:127-136`/`:221`/`:232-237`/`:239-244`/`:257-275`/`:284`/`:291`; `extract.ts`
  `:72`/`:100`/`:203-204`/`:417`/`:627-628`/`:748`/`:795-798`; `pipeline.ts`
  `:41`/`:44`/`:92`/`:96-100`/`:103`/`:104`/`:108`/`:109`/`:111`/`:115-118`/`:117`;
  `repo-scanner.ts` `:21`/`:33`/`:55`/`:99`/`:218`/`:229`/`:260-268`/`:305`/`:322`/`:339`/`:533`;
  `history-cochange.ts` `:94`/`:109-112`/`:394-398`; `history-resume.ts` `:62`/`:394`; `history.ts`
  `:89`/`:1091-1094`; `debug-log-writer.ts` `:7-9`; `read-or-default.ts` `:5-6`/`:10`;
  `atomic-write.ts` `:26-28`; `prompt-headroom.mjs` `:249-254`/`:452`/`:558-564`/`:565`/`:567`/`:570`
  (round 15's off-by-one fix is correct); `yg-config.yaml` `:9`/`:43`; `cli/io/stores`'s mapping
  `:18`/`:24`/`:25`/`:28`/`:29`; `cli/roots/engine`'s relations `:173-174`/`:179-180`/`:185-186`;
  `cli/tests/unit/roots` `:287-288`; `cli/tests/unit/support/io` `:40`.
- **The seven-case boundary table's premise** — six of the seven cases are already asserted at the
  whole-walk level (`repo-scanner-nested.test.ts:98`/`:121`/`:137` and `:190`/`:198`/`:207`/`:216`/
  `:225`) and the `.git` **symlink** case is covered by no landed test. Exactly as stated.
- **`cli/tests/support`'s description** does read as an enumeration ("A fourth file … All four
  files"), mapping four files today — so T3's obligation to extend it is real.

## Closest calls that are not findings

- **`warnCount` is derivable from `dedupKeys`** (a WARN is emitted only when its dedup key is new,
  so the two sets coincide). A ninth fold field that is the eighth's cardinality sits close to the
  rule that deleted `openedTs` and the `'warned'` arm's `factKey` — but it has a named consumer
  (§11.3's session budget) and costs nothing to carry. Folded into MINOR-1's fix as a naming
  clarification rather than raised on its own.
- **T10's "`cli-roots-basic.test.ts` asserts `toContain('No \`roots:\` block found')` in three
  places (`:209`, `:212`, `:237`)"** — `:212` is an `indexOf` ordering assertion and `:237` is a
  `not.toContain`. The substance ("appending information is compatible, rewording is not") holds for
  all three and criterion 6 asserts the right thing, so this is a description, not a defect.
- **`git status --porcelain` in a shallow clone** (D11's withdrawn caveat) and **`getDirtyFiles`'
  `null`-vs-`[]` contract** both re-checked against `utils/git.ts`; the plan's reading is right.
