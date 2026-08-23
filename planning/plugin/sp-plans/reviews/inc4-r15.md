# Increment 4 (R5) plan — adversarial review, round 15

**Target:** `planning/plugin/sp-plans/2026-08-22-increment-4-r5-verdict.md` (7440 lines)
**Tree:** branch `claude/document-review-13yoty`, HEAD `c40a78f`. Verified that
`git log a761dda..HEAD -- source/ .yggdrasil/ scripts/` is **empty**, so every line anchor in the
plan (declared as "from the tree at a761dda") is valid at HEAD without adjustment.

## VERDICT: 0 BLOCKING + 2 MAJOR + 5 MINOR

Round 14's centrepiece, **D26**, survives an independent re-derivation of its two load-bearing
claims (§18.2's clause placement and the pooling-filter enumeration) — see "What was re-derived and
held" below. Both majors are in the same seam D26 opened: they are the **third and fourth**
producer-derivability gaps the D13a-style walk surfaces, and both sit on the T8 side that D26 now
owns. Neither is a defect *in* D26's decision; both are records D26's own pass must write and cannot,
from the inputs the plan enumerates for it.

---

## MAJOR

### MAJOR-1 — T8's cross-session closure row must carry a `factKey`, and nothing the pass is handed can produce one

**Where.** `TelemetryRecord`'s declaration (`:2065-2068`); D13a(a)'s field table, `factKey` row
(`:1333`); `OpenIntervention`'s declaration (`:2819-2830`); `health.ts`'s enumerated input list
(`:4257-4279`, items 5 and 6 at `:4266` and `:4272`); T8 Step 2's three-way branch (`:4376-4399`).

**Evidence.**

1. `TelemetryRecord` declares `factKey: string` **non-optional** (`:2065-2068`). Every row T8's pass
   appends is a `TelemetryRecord`.
2. D13a(a) fixes what that field must hold on a closure row: *"the `factKey` the closure observation
   itself resolved: identical for T7's in-session closures …, **the current one for T8's pass, which
   resolved it forward**"* (`:1333`).
3. `OpenIntervention` — the only record T8 Step 2 reads per intervention — carries twelve fields
   (`:2819-2830`) and **`factKey` is not one of them**. (The `'warned'` session event *does* carry
   `factKey`, `:2024-2027`; the fold's projection drops it.)
4. The one forward-resolution lookup `health.ts` is handed is item 5, declared
   `resolve(row) -> { factKey, expected } | null` and scoped in its own words **"D26's forward
   resolution for Step 1"** (`:4266-4271`), typed over a telemetry **row**. Item 6 —
   `currentValue(intervention) -> { state: 'gone' } | { state: 'value'; v: string }` (`:4272-4274`) —
   is Step 2's lookup and returns no `factKey`.
5. T8 Step 2's own text (`:4376-4399`) enumerates what each sample repeats — `severity`/`deltaBits`
   off `OpenIntervention`, `observed` from the re-enumerated value — and never mentions `factKey`.

So a T8 implementer building the closure `TelemetryRecord` hits a `tsc --noEmit` failure with no
sanctioned source for the missing field, and both escapes are wrong as the plan stands: passing an
`OpenIntervention` to `resolve` does not typecheck (an `OpenIntervention` is not a `TelemetryRecord`
— no `ts`, `sessionId`, `observed`, `factKey`), and copying the recorded `factKey` off the
intervention row in `telemetry.jsonl` contradicts `:1333`'s "the current one" *and* silently depends
on that intervention row existing — which T1 Step 3b (`:2198-2224`) explicitly permits to be lost to
a swallowed append failure.

This is exactly the class round 13's M1 and round 14's second gap belong to (a stage assigned a
record it cannot construct), one writer further down the same table.

**Fix (concrete, one contract change plus two sentences).**

- Re-type input 5 over the identity tuple **both** callers hold rather than over a telemetry row:
  `resolveFact(id: { relPath; skeyR; scopeKind; partitionId; surface }) -> { factKey; expected } | null`,
  and say at `:4266` that it serves **Step 1 and Step 2** — Step 1 calls it with the row's four D26
  fields plus the row's `surface`, Step 2 with the intervention's. Nothing else about D26's Q1
  derivation moves: those are precisely the five values the lookup already consumes (`:1857-1862`).
- State in T8 Step 2 which `factKey` a closure row carries and **what happens when the lookup returns
  `null`** (the scope's value may be readable while no fact governs it any more). Recommended and
  consistent with D26's stated direction: `null` ⇒ **gone** — no sample, no mark, no event — since a
  lost sample resurrects a fact and never falsely silences one (`v6-spec.md:683`). Give it a leg in
  T8 criterion 4 (which already has four) and name it in MR-34e, whose two arms are already about
  reading the closure's answer from the wrong place.
- Alternatively, if the plan prefers the recorded key, carry `factKey` on `OpenIntervention` (a copy
  by a producer that already holds it — D26's own shape) and rewrite `:1333`'s second cell to say so.
  **Either is fine; the plan must pick one**, because D13a is the document T6/T7/T8 are told to trust
  literally.

### MAJOR-2 — `Intents.sessionEvents` cannot say **which** ended session log each terminal `'closed'` event belongs to

**Where.** `Intents`' declaration (`:2898-2900`); `SessionEvent`'s `'closed'` arm (`:2044-2050`);
`appendSessionEvents(stateDir, sessionId, events)` (`:2085`); T6 Step 1's "no `SessionEvent` arm
carries one" (`:3853-3857`); T8's return (`:4281`); T8 Step 2b rule 1 (`:4424-4426`); T8 Step 5
(`:4491-4499`); criteria 4b (`:4552-4564`) and 4d (`:4618-4630`).

**Evidence.**

1. `Intents.sessionEvents` is a flat `SessionEvent[]` (`:2898-2900`), and T8 returns exactly that
   shape: *"`health.ts` returns `{demotions, sessionEvents, telemetry, ledgerMarks}` and the command
   layer applies them"* (`:4281`), reinforced by Step 5's *"`health.ts` returns **all three** of the
   cross-session pass's write sets as intents"* (`:4491-4494`).
2. The `'closed'` arm is `{ ts, kind, stableId, surface, outcome, scope }` (`:2044-2050`) — **no
   session id**, and T6 Step 1 states the reason as a design fact: *"no `SessionEvent` arm carries
   one — the session is a property of the log file"* (`:3853-3857`).
3. The store's writer is per-log: `appendSessionEvents(stateDir, sessionId, events)` (`:2085`).
4. T8's pass is over **N** logs, not one: Step 2a has the command layer enumerate with
   `listSessionLogs` and *"For each ended log the aggregation folds …"* (`:4371-4374`), and D16.2 runs
   the aggregation on **every** `index` over every ended, unpruned log (`sessions.pruneDays` = 7). Rule
   1 then appends a terminal event *"into **that** ended session's own log"* (`:4424-4426`).

So the command layer receives a flat array and has no field to route it by. Matching by content is
provably ambiguous on the plan's own headline scenario: D13a(d)'s S2 (`:1451-1454`) is *eight*
sessions each holding an open intervention on the **same** `(stableId, surface)` — under one `nowMs`
the eight returned events are byte-identical in all six fields, so no post-hoc attribution exists.
The failure is silent and lands on the committed side of the loop: terminal markers written into the
wrong logs re-open the interventions the pass thought it closed, and MR-32b's whole correctness
argument (a later-day `complied` row plus a §18.3 ledger mark for an intervention nobody was warned
about, `:4448-4453`) is exactly what the marker is supposed to prevent. Criterion 4d
(`:4618-4630`) — "the earlier log has exactly one `scope: 'cross-session'` event … the current-day log
is byte-identical" — is unwritable against a flat array once more than one log is ended, and an
implementation that appends the whole array to whichever log it happens to hold passes 4d's
one-ended-log fixture while being wrong in production from day two.

Note the asymmetry that makes this specific to `sessionEvents`: telemetry rows carry `sessionId`
(`:2065`) and the ledger is a single file, so both of T8's other two write sets route themselves.

**Fix (concrete).**

- Give T8's session-event set an owner field. Either widen the pass's return —
  `sessionEvents: ReadonlyArray<{ sessionId: string; event: SessionEvent }>` (or
  `Map<string, SessionEvent[]>`) — and say at D1 (`:2898-2900`) that this is the one place the index
  pass's intents differ in shape from the check path's, where a run has exactly one session; **or**
  add `sessionId` to the `'closed'` arm for the `scope: 'cross-session'` case only, and say so at
  `:2044-2050`.
- Whichever is chosen, restate it at T8 Step 2b rule 1 (`:4424`) and Step 5 (`:4491`), and make
  criterion 4d's fixture carry **two** ended logs plus the live one, so the attribution is observable
  at all; point MR-32e's first arm at it (it already mutates the ended-session domain).

---

## MINOR

### MINOR-1 — `decorativeRoles` is unreachable through any snapshot the index can emit, and the plan does not say so

D8 lists a decorative role among the three applicability exclusions (`:1171-1174`); `VerdictInput`
carries `decorativeRoles: ReadonlySet<string>` built by the command layer from
`MinedRole.roleLift <= 0` (`:2862-2863`); T3 criterion 9 asserts it (`:3295-3298`); the edge-audit
table justifies `isDecorativeRole`'s call site (`:147`). **The index emits no fact for a decorative
role at all**, so none of it can bind:

- `scorePartitionFacts` skips role cells outright: `if (cell.cellClass === 'role' &&
  decorativeRoleKeys.has(cell.roleKey as string)) continue; // decorative-role demotion`
  (`source/cli/src/roots/mine.ts:626`), and that function is the sole producer of
  `MinedPartition.facts` (`mine.ts:1002` → prune → dedup → cull → `:1055`).
- The persisted flag cannot disagree with the set the index used: `roleLiftByKey` is **total** over
  `rolesForPartition` (`computeRoleLiftForPartition` writes one entry per role, `mine.ts:496`),
  and `MinedRole.roleLift = roleLiftByKey.get(r.roleKey) ?? 0` (`:1032`) reads that same map, so
  `roleLift <= 0` ⟺ `roleKey ∈ decorativeRoleKeys` ⟺ zero facts.
- A scope whose sticky `assignments` entry names a decorative role still reaches D8 with that
  `roleKey`; D8 finds no role facts for it and falls back to `_all` **with or without** the filter.

So the filter cannot change any verdict on a real snapshot. That is not automatically wrong — the
plan holds the DENY row in exactly this state on purpose (D9, `:1216-1223`) — but R5-I11 requires the
choice to be explicit: *"When a rule turns out to have no possible killer, the honest outcomes are to
delete the rule or to record it explicitly as unkillable defense-in-depth; both were taken this
round, and neither is left implicit"* (`:332-335`). Here it is left implicit, criterion 9 reads as a
behavioural assertion over a real snapshot, and it is the one T3 criterion with no MR pointed at it.

**Fix.** Add one clause to D8 at `:1173` and one to criterion 9 at `:3295`, in D9's register: the
index already refuses to score a decorative role's cells (`mine.ts:626`), so no snapshot carries such
a fact; the engine-side exclusion is defence-in-depth against a hand-built or future projection, and
criterion 9 is therefore a **synthetic-input** criterion exactly as criterion 10 is (`:3299-3302`).
Say the same in one clause at `:2862`. (Deleting the field instead is also defensible and costs a
`VerdictInput` slot, a command-layer derivation and the edge-table clause at `:147`; the plan should
choose, not leave it.)

### MINOR-2 — T9 Step 4's "partner still exists on disk" has no named layer, and one of T9's three edited files refuses it

T9 Step 4's inclusion predicate ends `∧ partner ∉ D ∧ partner still exists on disk` (`:4850`), and
criterion 5 asserts it (`:4886`). T9's Files edits `session-state.ts`, `roots-check.ts` and
`speech.ts` (`:4807-4809`). Two of those three carry `no-direct-fs` and `deterministic` (R5-I4,
`:257-264`), and `session-state.ts` is where §13.5's `D` (`writtenFiles`) actually lives — so it is
the file an implementer reaches for first, and the refusal arrives only at
`check --approve --only-deterministic`, at the end of the task. This is round 13's M2 shape
(a decision naming a filesystem test with no legal home) in a smaller key; every other filesystem
touch in this increment has an explicitly named layer (T3 Step 8, T3 Step 7b, D26's Q2).

**Fix.** One sentence in T9 Step 4: the partner-existence test is performed by the **command layer**
(`src/cli/roots-check.ts`) as part of building the partner list handed to `speech.ts`'s Appendix-A T5
renderer, with the same totality rule Step 8 states (a failing `lstat` is a drop, never an
exception). Same sentence covers Step 2's `list, hash, diff` (`:4819`), whose reads are in the same
layer for the same reason.

### MINOR-3 — `OpenIntervention`'s doc comment describes its fields by a position they no longer occupy

The block comment at `:2806-2818` says *"Every field is load-bearing, in three groups. **The first
six** carry §9.10's once-per-session ignore bound … **The next two** carry §18.1's EMITTED
`severity`/`deltaBits` pair … **The last four** are D26's recorded identity."* The declaration it
annotates (`:2819-2830`) orders the fields
`stableId, surface, expected | severity, deltaBits | openedSessionId, openedTs | relPath, skeyR,
scopeKind, partitionId | ignoredRecordedInSession`.

So the §9.10 six are at positions 1, 2, 3, 6, 7 and **12**; the "next two" are at 4-5; and the "last
four" are at 8-11, with `ignoredRecordedInSession` last. Round 14's Sweep B refreshed this comment's
counts (8 → 12 fields, two groups → three) but not its positional language. This block is written to
be copied verbatim into `verdict.ts`, and the plan tracks exactly this failure mode elsewhere
(`mine.ts:155-160`'s "STRUCTURALLY ABSENT" comment, T2 Step 1's sixteenth site, `:2540-2547`).

**Fix.** Replace the positional words with the group names: "**the §9.10 ignore-bound group**
(`stableId`, `surface`, `expected`, `openedSessionId`, `openedTs`, `ignoredRecordedInSession`) … the
**emitted pair** (`severity`, `deltaBits`) … **D26's recorded identity** (`relPath`, `skeyR`,
`scopeKind`, `partitionId`)" — or reorder the declaration to match the prose.

### MINOR-4 — criterion 8b's "~34 new pairs" undercounts against the plan's own file list

`:2391-2393` derives the pair growth as *"6 new `roots-engine` files × 1 LLM pair, 4 new
`persistence-adapter` stores × 1, `roots-check.ts` × 2, and ~22 new `tests/**` files × 1 — roughly
**34** new pairs"*. The first three terms check out at source: a `roots-engine` file binds exactly one
LLM aspect (`deterministic`, `type: llm`, `per: file`; `no-direct-fs`/`no-direct-console`/
`source-no-raw-control-chars` are deterministic and `source-hygiene` is an aggregate), a
`persistence-adapter` file binds one (`silent-missing-files`), and `command` binds two
(`cli-command-contract`, `diagnostic-logging`) — all confirmed in `.yggdrasil/aspects/*/yg-aspect.yaml`.
The fourth is wrong: the plan's own Files blocks create **28** new `*.test.ts` files plus the
`tests/support` fixture builder = **29** new `test-suite` files, each binding one LLM aspect
(`test-deterministic`), so the growth is ≈ **41**, not ≈ 34. (`tests/fixtures/roots-hook-payloads/`
correctly contributes nothing — `test-suite`'s `when` excludes `source/cli/tests/fixtures/**`,
`yg-architecture.yaml:422-425`, and `cli/tests/fixtures` maps the directory, so `unmapped-files`
cannot fire on it either.)

The argument the figure serves — that this repo's `entries.length` moves, so criterion 8b must run
against a scratch fixture — is *strengthened*, not weakened. But the plan states worked numbers as
checkable, and this one is not.

**Fix.** Change "~22 new `tests/**` files" to "~29" and "roughly **34**" to "roughly **41**" at
`:2391-2393`.

### MINOR-5 — one off-by-one anchor in T1 Step 6

`:2269` reads *"The per-tier block ends at `:565` and the summary line is printed at `:567`"*.
Measured at HEAD: the per-tier `for` loop closes at **`:564`**; `:565` is
`const worstMarginOverall = tierMargins.worstMarginOverall;`, a non-printing assignment; `:567` is the
summary `log(...)` and `:570` is `process.exit(0)` — both correct. The same paragraph's earlier
citation *"prints … the largest assembled prompt plus the next two (`:558-565`)"* (`:454`, `:2240`)
carries the same one-line overreach. The rule the sentence supports ("the query block goes after
`:567` and before `:570`") is unaffected, but the plan corrected two neighbouring anchors in this same
function in rounds 11 and 12 and the record should stay exact.

**Fix.** `:565` → `:564` at `:2269`, and `:558-565` → `:558-564` at `:454` and `:2240`.

---

## What was re-derived independently and held

**D26's clause-placement claim — checked against the sentence structure, not paraphrased.** §18.2's
relevant text is one bolded sentence with a three-arm semicolon list:

> **Cross-session closure:** the aggregation pass also closes interventions left open by ended
> sessions — if the current index shows the (stable_id, surface) at `expected`, it records a
> **complied** sample and appends the §18.3 ledger mark (same dedupe); **if** the pair still exists and
> deviates, it records an **ignored** sample; **if the scope is gone, the intervention is dropped.**

The third `if` is the third arm of that list, governed by "closes interventions left open by ended
sessions", and *"the intervention is dropped"* names the object only that clause has. It cannot
attach to the pooling sentence two sentences earlier, which has no interventions in scope, only
events. **D26's claim (`:1867-1873`) is correct.**

**The pooling-filter enumeration.** §18.2's pooling sentence names exactly two filters — *"pooled per
`factKey` … via current membership, filtered to events whose recorded (surface, expected) matches the
current FACT"* — plus the resolved/unresolved denominator rule. D26's *"That is the whole of §18.2's
pooling filter, plus the expected-flip filter"* (`:1863-1866`) is exact. T8 Step 1's extra
changed-partition drop is defensible as "current membership at its coarsest" and is conservative in
§18.2's own stated direction; it is declared, not smuggled.

**Every worked number in the brief, recomputed from scratch.**

- **Six Δ rows** (`:3240-3245`): `log2 7 = 2.807`, `log2 13 = 3.700`, `log2(41/3) = 3.7726` (twice, at
  τ 3.5 and τ 4.5), `log2 41 = 5.358`, `log2(2.5/1.5) = 0.737` — all correct, including the K values
  (2 for boolean, |alphabet|+1 = 5 for the categorical) and both τ outcomes. Row 1 does reproduce
  E.1's `log2(2·n_eff + 1)` identity (n_eff = 3 ⇒ 7); row 6 does sit under E.2's 1.0-bit supremum.
- **Eight Wilson figures** (`:1465-1468`, `:4510-4516`) at z = 1.96: n = 10 → 0.056681 / 0.236589 /
  0.396774 (plan 0.0567 / 0.2366 / 0.3968); n = 8 → **0** exactly (the `z·√(z²/4n²)` term is
  `z²/2n`, so the numerator vanishes) / 0.215212 / 0.305738 / 0.409269 (plan 0.2152 / 0.3057 /
  0.4093). All eight round to the plan's figures, and 5/3 does clear 0.3 by 0.0057.
- **T9's completeness trio** (`:4874-4884`): 9/9 = 1.0 ≥ 0.75; 9/12 = 0.75 ≥ 0.75 (inclusive);
  9/20 = 0.45 < 0.75. The fixture row is internally coherent — `conf = max(confAB, confBA) = 1.0` in
  both variants, so both survive `finishCochange`'s committed cut, which is precisely what makes the
  directional re-gate a live test (D20).
- **D26's fixture sizings** (`:1826-1837`): 600 × 110 B ≈ 66 KB and 10 000 × 110 B ≈ 1.1 MB; the value
  half at 600 × 60 ≈ 36 000 ≈ 0.9 MB and 10 000 × 60 ≈ 600 000 ≈ 15 MB — internally consistent at
  25 B/entry, and conservative in the direction that *weakens* the rejection, so the refusal of
  route (a) stands on arithmetic that cannot be accused of inflation. `mdl.factCap` is 400
  (`config-parser.ts:80`) and the 10 % deviant figure checks out.
- **T2 criterion 4b's sizings**: (ii) two nested own-floor buckets ⇒ ~600 generated scopes, because
  `keyFor` assigns to the closest ancestor (`partitions.ts:239-244`); (v) two sub-floor keys summing
  ≥ 300 (200 + 150) is exactly what `repoBucketSurvives = mergedCount >= PARTITION_SCOPE_FLOOR` over
  `mergedKeys` alone requires (`partitions.ts:257-275`). Both correct.
- **Criterion 8's margins** (`:2371-2378`): 72 000 − 65 000 = 7 000 and − 60 000 = 12 000, ascending
  7 000 then 12 000, `worstMargin` 7 000; b.ts 62 000. Correct, and the multi-pair fixture really is
  what makes MR-1c killable.
- **MR-12's cancellation** (`:3442-3446`): `p̂(e)/p̂(v)` cancels the shared KT denominator, and an
  in-alphabet zero-count value has `n_v = 0` exactly as ⊥ does with the same K (the mutation does not
  move the persisted alphabet), so Δ is identical and only the flag moves. Correct.
- **The five epoch constants** (T7 criterion 7 leg A, `:4147-4158`): 2026-01-01 = 1 767 225 600
  (20 454 days × 86 400, 56 years + 14 leap days); 2026-04-01 = 1 775 001 600 (+90 days ⇒
  `stableDaysOf` exactly 90); 2026-01-15 = 1 768 435 200 (= mark + 14 × 86 400); 2026-01-14 =
  1 768 348 800; 2026-03-31 = 1 774 915 200 (⇒ 89 days). All five confirmed, and both comparison
  senses are right against the landed code: `if (stableDaysOf(row, clockTs) <
  config.ledger.releaseStableDays) continue;` (`weights.ts:255`, clears on `<`) and
  `row.lastHumanCommitTs >= threshold` (`:259`, clears on `>=`), with
  `ledger: { releaseStableDays: 90, releaseMinDaysAfterMark: 14 }` (`config-parser.ts:113`).

**The gate claim, reproduced live.** `node scripts/prompt-headroom.mjs` at HEAD prints, byte for
byte, the plan's pinned figures: `'standard'` tier ceiling **72 000**; `fill-det.test.ts` margin
**657**; `roles.test.ts` **660**; `advise-nominations.ts` **849**; *"measured **1198** LLM pair(s)
across 1 tier(s)"*. The Global-constraints prediction reproduces too: `roles.ts` is 54 401 B and
`mine.ts` 55 576 B, `deterministic/content.md` is 1 182 B, so `file + aspect + ~1.8 K` gives
72 000 − 57 383 = **14 617** and 72 000 − 58 558 = **13 442** against the stated ≈14 600 / ≈13 400.
`roots.ts` is 40 830 B, `aspect-test.ts` 64 438 B and `cli-command-contract/content.md` 3 124 B, so
`roots-check.ts`'s ≈66 KB ceiling is right (and `cli-command-contract` really is `command`'s largest
LLM aspect — `diagnostic-logging` is 957 B).

**D26's data flow, walked end to end.** Every other read traces to a persisted or passed source.
`stableId = hash(partitionId ∥ relPath ∥ kind ∥ qualifiedName ∥ arity)` (`extract.ts:627-628`) and
`skeyR = relPath#kind#qualifiedName` (`:203-204`), so the four recorded identity fields are exactly
`stableId`'s ingredients minus `arity` — D13a(c)'s "cannot produce a fourth row" holds. `arity` is
persisted nowhere and `assignments` is `skeyR`-keyed (`mine.ts:1037-1041`), so the non-invertibility
argument holds. The short-circuit really does return before mining (`roots.ts:710-725`), so the
in-memory fallback really is closed. The re-enumeration's cost/determinism story holds: `join` is
built at `pipeline.ts:318` **before** `mine()` at `:343`, so T2's "thread coupling into the exemplar
stage" is executable (the per-partition projection at `:357-361` only *filters* the repo-global
percentiles, so a candidate's centrality is the same value either way, and the `join`-absent case is
D4's centrality-1 arm). `MinedRole.medoidFeatures = medoids[idx].ordered` (`roles.ts:960`) is the
full bag, not a truncation, so T3 Step 2's medoid rebuild is exact and D4's `m1` is reconstructible.
D26's "graph cost: none" is verified against the landed block rather than assumed:
`cli/commands/roots` declares `calls` on `cli/roots/engine`, `cli/io/stores` and `cli/utils` and has
**10** relations today, so 10 → 13 does not move.

**Mechanical cross-reference sweep.** 73 MR definitions, **no duplicates**; the only `MR-*` ids
referenced in the plan body without a definition are `MR-32c` and `MR-32d`, in their own retirement
notice — R5-I11's "(73 ids at present)" is exact. All three reference classes re-validated with
previous-line joining: **zero dangling qualified criterion refs, zero dangling qualified step refs,
zero dangling bare in-task refs.** The eight apparent hits are the two documented classes
(`T8 Step 2a`/`2b`, which are Step 2's labelled subsections, and wrapped `T7 Step 2, criterion 2` /
`T10 Step 6 (criterion 6)`). Counts re-derived and confirmed: T1 9 steps / 14 criteria; T3 10 steps /
criteria running to 16; the edge audit's **9** rows; the **six** `--file` measuring sites (T2 Step 1,
T2 Step 6, T5 Step 6, T6 Step 6, T7 Step 5, T9 Step 6 — every one present in its task's step list);
`TelemetryRecord` 14 fields; `OpenIntervention` 12; `Finding` 15; `applyBudgetsAndDedup` 4 arguments;
`health.ts` 6 inputs + 2 config numbers.

**Landed-surface anchors spot-checked (≈70, all exact).** `yg-architecture.yaml` `:43-48`, `:49-57`,
`:61`, `:68-74`, `:82`, `:183`, `:197-203`, `:206-209`, `:341`, `:418-431`, `:442-454`, `:742-748`,
`:749-755`, `:759-760`, `:774-777`; `partitions.ts` `:69`, `:101-102`, `:127-137`, `:232-250`,
`:237`, `:239-244`, `:243`, `:257-275`, `:284`, `:291`; `repo-scanner.ts` `:21`, `:33`, `:99`,
`:218`, `:229`, `:260-269`, `:305`, `:322-335`, `:339`, `:524-538`; `pipeline.ts` `:41`, `:44`,
`:92`, `:96-100`, `:103`, `:104`, `:108-109`, `:111`, `:115-118`; `mine.ts` `:119-153`, `:121`,
`:122`, `:125`, `:130-132`, `:141-142`, `:155-160`, `:165`, `:180-208`, `:225-231`, `:1035`,
`:1037-1041`; `roles.ts` `:149`, `:194`, `:335-339`, `:351-357`, `:598`, `:815-825`, `:904`,
`:913`, `:983`, `:1030`, `:1054-1057`; `weights.ts` `:108-110`, `:250`, `:253`, `:256`, `:267-269`;
`config-parser.ts` `:41-140` and every key D23 names (including `:136` `minOwnFeatures` vs `:135`
`minClusterSize`, which round 9 got right); `read-or-default.ts` `:5-6`/`:10`;
`debug-log-writer.ts` `:7-9`; `atomic-write.ts` `:26-28`; `utils/git.ts` `:113-125`;
`portal-derive-rest.test.ts` `:69-80` (32/25/24/23/23/23) and `:77-78`; `yg-config.yaml` `:9`/`:43`;
`cli/io/stores/yg-node.yaml` `:18`/`:24`/`:25`/`:28`; `cli/tests/unit/support/io/yg-node.yaml` `:40`;
`cli/tests/e2e/yg-node.yaml` `:5`; `cli/tests/unit/roots/yg-node.yaml` `:287-288` (and its 13
relations). Round 12's restored `prompt-headroom.mjs` anchors `:452`/`:455`/`:456`/`:567`/`:570` are
all correct.

**Round-14 repairs re-checked and holding.** T3 Step 8's degraded dirty-set arms now match D11 and
the landed `getDirtyFiles` contract; the one-clock-one-timezone paragraph is referenced (not
restated) at every consumer; the per-partition `closureIntents` concatenation is stated at D1 and at
T7 Step 3; D4's memoized `lstat` bound is stated at both D4 and T3 Step 7b with the memo scoped per
run; `appendTelemetry`'s growth law is at the declaration with T11 Step 5 reporting the figure;
`health.ts`'s input list is complete for everything except MAJOR-1's `factKey`; `scopeKind`/`relPath`
spelling is uniform across all three records.

---

## Closest calls that were **not** written up

- **T8's `resolve` and D8's decorative exclusion.** The pass's forward resolution (`:4315-4322`)
  omits the decorative filter that D8's applicability clause carries. Not raised as a divergence
  because MINOR-1 shows the filter is inert on both paths, so the two applications of "D8's
  governance" agree by construction; the honest fix is MINOR-1's, not a second rule for T8.
- **`mine()` gains an input, not just three edits.** T2's Files says `mine.ts` takes "three edits
  only" (`:2463-2465`) while threading coupling into the exemplar stage also adds a `MineInput`
  field. One or two lines against a ~30-line cap and a 13 442-char margin; below the noise floor.
- **`'checked'` / `'sweep'` / `'stop'` event timestamps** are not explicitly tied to the run's single
  `nowIso`. Only `lastSweepTs` is read back (for the debounce), and "one clock reading per run"
  (`:2911-2926`) covers it by implication. Left alone.
- **`extract-file.ts`'s "3 → 4 exports"** ignores the moved `MAX_PARSE_LINES` constant. Cosmetic.
