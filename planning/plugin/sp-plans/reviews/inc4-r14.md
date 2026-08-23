# Increment 4 (R5) plan — adversarial review, round 14

**Target:** `planning/plugin/sp-plans/2026-08-22-increment-4-r5-verdict.md` (6 673 lines)
**Tree:** branch `claude/document-review-13yoty`, HEAD `e759fa9`
**Verdict:** **1 BLOCKING + 1 MAJOR + 4 MINOR**

The clean-round counter stays at zero.

---

## What was re-derived and held

Before the findings, the parts of the plan this round independently re-derived from the
authorities rather than from the plan, all of which held:

- **All six Δ rows** of T3's arithmetic table, recomputed from `p̂(v) = (n_v + ½)/(n_eff + K/2)`:
  `log2 7 = 2.807355`, `log2 13 = 3.700440`, `log2(41/3) = 3.7725895` (twice, under τ 3.5 and 4.5),
  `log2 41 = 5.357552`, and `0.7369656` at share 2/3. Rows 3/4 still round to **3.7726**, not
  3.7724.
- **All eight Wilson figures** at z = 1.96: n = 10 → 0.0567 / 0.2366 / 0.3968; n = 8 → **0** exactly
  (0/8), 0.2152 (4/4), **0.3057** (5/3), 0.4093 (6/2); and n = 7 at p̂ = 0 → 0, below `minSamples`.
- **T9's completeness trio** from `{a:"src/order.ts", b:"test/order.test.ts", sup:9, conf:1.0,
  commitsA:9, commitsB:12}`: 9/9 = 1.0 ≥ 0.75; 9/12 = 0.75 (inclusive boundary); 9/20 = 0.45 < 0.75
  with the `a`-side still emitting. The `f === row.a ⇒ commitsA` mapping matches §13.5's
  `confidence(a→b) = support/commits(a)`.
- **Both fixture sizings.** 4b(ii)'s ~600 generated scopes: `keyFor` assigns to the closest ancestor
  root (`partitions.ts:239-244`), so `a/` and `a/b/` need 300 each. 4b(v): `repoBucketSurvives` is
  `mergedCount ≥ 300` over **only** the sub-floor keys (`partitions.ts:257-275`), so the stated
  `x/` 200 + `_root` 150 = 350 is correct and a single bucket would fail.
- **Criterion 8's margins.** 72 000 − 65 000 = 7 000 (worst), 72 000 − 60 000 = 12 000, ordered
  margin-ascending; `b.ts` 62 000; unmatched path `null`.
- **MR-12's cancellation.** `p̂(e)/p̂(v)` cancels the shared KT denominator to `(n_e+½)/(n_v+½)`;
  an in-alphabet zero-count value and ⊥ both give numerator ½, so Δ genuinely does not move and
  MR-12 is correctly a novelty-*flag* killer.
- **The five epoch constants**, all confirmed against UTC dates and against the landed arithmetic:
  1 767 225 600 = 2026-01-01Z, 1 768 435 200 = 2026-01-15Z = `+14 × 86400`, 1 775 001 600 =
  2026-04-01Z ⇒ `stableDaysOf` exactly 90 (`weights.ts:108-110`), 1 768 348 800 = 2026-01-14Z,
  1 774 915 200 = 2026-03-31Z ⇒ 89.
- **Echo-shaped sizing.** T8's control leg needs ≥ 6 survived conformers to stay at/above
  `mdl.minInstancesRaw` = 5 (`config-parser.ts:78`) after the one unreleased mark makes one
  conformer echo-shaped; the plan states the constraint (not the number), which is sufficient.
- **Round-13's mechanics.** (b) `{sessionId, nowIso}` reads identically at D1 (`:622`, `:627`),
  D13a(a)'s derivability note (`:1297`), T6 Step 3 (`:3580`), and transition 1's Writer cell; no
  clock or identity derivation is placed in `session-state.ts`. (c) The exemplar re-validation is
  legal where it was put — `command`'s type-level aspects (`yg-architecture.yaml:49-57`) are
  `source-no-raw-control-chars`, `cli-command-contract`, `diagnostic-logging`,
  `command-contract-shape`, `source-hygiene`, `command-error-via-buildissuemessage`,
  `sibling-test-file`: neither `no-direct-fs` nor `deterministic`, and the `cli` node's four
  inherited aspects (`model/cli/yg-node.yaml:4-8`) ban nothing relevant. T3 Step 7b's two negatives,
  criterion 16 and MR-14g are all present and consistent; D9's **four** non-copy fields read as four
  at `:1130`, `:2771` and in `VerdictFact.exemplars`' comment. (e) `OpenIntervention`'s 8 fields are
  identical at every site that names them (`:1303`, `:1801`, `:2552-2561`, `:3709`, `:3969`,
  `:3984`).
- **(d) Mechanical cross-references.** 72 `MR-*` definitions in the task body, **no duplicates**,
  and every `MR-*` referenced in the body is defined except `MR-32c`/`MR-32d`, which appear only in
  their retirement notice — matching R5-I11's "(72 ids at present)" exactly. Qualified
  `T<n> criterion <m>` and `T<n> Step <m>` references: **zero dangling**. Bare in-task references:
  zero dangling (the four apparent hits are line-wrap artefacts of `T3 criterion 13`, `T6 Step 1b`
  and `T10 Step 6 (criterion 6)`).
- **~60 landed anchors re-read at HEAD**, all correct: `yg-architecture.yaml:43-48`/`:49-57`/`:61`/
  `:82`/`:183`/`:197-203`/`:206-209`/`:341`/`:418-431`/`:442-454`/`:742-748`/`:749-755`/`:759-760`/
  `:774-777`; `partitions.ts:69`/`:101-102`/`:127-136`/`:136`/`:237`/`:239-244`/`:257-275`/`:284`/
  `:291`; `extract.ts:203-204`/`:417`/`:627-628`/`:748`/`:795-798`; `pipeline.ts:41`/`:44`/`:92`/
  `:96-100`/`:103-118`; `roles.ts:149`/`:194`/`:335-339`/`:351-357`/`:363-369`/`:598`/`:704-712`/
  `:803`/`:815-825`/`:871`/`:887`/`:904`/`:913`/`:983`/`:1030`/`:1054-1057`; `mine.ts:121`/
  `:130-132`/`:141-142`/`:155-160`/`:1035`; `weights.ts:108-110`/`:250`/`:253`/`:256`/`:267-269`;
  `repo-scanner.ts:21`/`:33`/`:99`/`:218`/`:229`/`:260-269`/`:305`/`:322-335`/`:339`;
  `config-parser.ts:42-43`/`:51`/`:57-62`/`:78`/`:91-92`/`:112`/`:124-125`/`:128-130`/`:131-138`;
  `prompt-headroom.mjs:249-254`/`:452`/`:455-456`/`:558-565`/`:567`/`:570`/`:576`;
  `repo-check.sh:209`; `portal-derive-rest.test.ts:69-80`/`:77-78`; `cli-roots-basic.test.ts:46-52`/
  `:73`/`:159`/`:209`/`:212`/`:237`; `roles.test.ts:162`/`:214`/`:230`; `mine.test.ts:457`/`:470`;
  `model/scripts/yg-node.yaml:8`; `model/cli/roots/engine/yg-node.yaml:173-174`/`:179-180`/
  `:185-186`; `model/cli/io/stores/yg-node.yaml:18`/`:24`/`:25`/`:28`; `model/cli/tests/e2e/
  yg-node.yaml:5`. Node relation counts confirmed live: `cli/commands/roots` **10**,
  `cli/tests/unit/roots` **13**, `cli/tests/unit/cli/roots` **7** — the three "→ 13 / → 15 / → 8"
  rows all start from the right number. `cli/tests/support`'s landed description does say
  "**All four files** import only Node builtins", so T3's fifth-file obligation is real.
- Spec anchors `v6-spec.md:81`/`:245`/`:271`/`:340`/`:345`/`:353`/`:360-362`/`:385`/`:409`/`:428`/
  `:439-440`/`:447`/`:455-456`/`:479`/`:481`/`:484`/`:505`/`:513`/`:517`/`:527`/`:547`/`:551`/
  `:554`/`:563`/`:576-577`/`:583`/`:586`/`:592`/`:621-625`/`:637`/`:679-687`/`:697-698`/`:712-713`/
  `:719-720`/`:770-806`/`:861-892`/`:905`/`:907`/`:920`/`:922`/`:1020` and design anchors `:80`/
  `:84`/`:122-165`/`:133`/`:137-138`/`:161-164`/`:310`/`:329-334`/`:358-363`/`:365`/`:374-381`/
  `:401`/`:406`/`:410-426` all read as cited.

*(Not re-measured this round: the three live prompt margins 657/660/849 and the 1 198-pair count —
the measurement needs a built `dist/bin.js` and writes a gitignored reviewer-config overlay, which
is not appropriate from a report-only review. Rounds 11–13 reproduced them.)*

---

## BLOCKING

### B1 — T8's aggregation reads two things the committed snapshot does not carry and the command layer does not pass: `stableId → scope`, and a scope's current surface value. Every demotion criterion in the increment rests on them.

**Where.** Plan `:3902-3908` (T8's Files/input block), `:3918-3930` (Step 1's forward resolution),
`:3963-3971` (Step 2's three-way closure), `:1507-1509` (D16.2), and the criteria that depend on
them: T8 criteria 3b, 4, 4b, 4c, 4d, 5, 6, 7, both e2e legs, MR-32, MR-32b, MR-32e, MR-34b.

**What the plan requires.**

- Step 1 (`:3924-3926`): "the pass resolves each event forward: `stableId` → **the current scope in
  the snapshot** → its current role … → the **current** `factKey`, and pools on that. An event whose
  `stableId` no longer resolves … is **dropped**."
- Step 2 (`:3966-3968`): "**current index shows the pair at `expected`** ⇒ a `complied` sample **and**
  the §18.3 mark …; the pair exists and **still deviates** ⇒ an `ignored` sample; the scope is gone
  ⇒ the intervention is dropped."

**What is actually available.** T8's Files block is explicit and exhaustive about health.ts's
inputs (`:3902-3905`): "**`health.ts` reads nothing itself (R5-I4).** `src/cli/roots.ts` enumerates
the session logs with `listSessionLogs`, reads the ended ones with `readSessionEvents`, reads
`telemetry.jsonl`, and **passes the folds plus `nowMs` in**" — plus Step 4's
`snapshotContentHash(model.body)` **string**. D16.2 (`:1507-1508`) adds only "reading whatever
`model.json` is on disk".

And `model.json` cannot answer either question — verified at HEAD, not assumed:

1. **No `stableId` appears anywhere in the persisted body.** `MinedPartition` (`mine.ts:180-208`)
   is `{ id, vocab, alphabets, roles, assignments, facts, moduleOfFile, seeds, couplingByFile?,
   couplingByModule? }`; `MinedModel` (`:225-231`) adds `historyStats?`, `cochange?`, `agentShare`,
   `aliases?`. T2 adds exactly three more (`MinedFact.exemplars`, body-level `partitionRouting`,
   `commitsA`/`commitsB`). `MinedFact` (`:119-153`) carries `factKey`/`roleKey`/`surface`/
   `counts`/`deviantsN` — no instance identities. Appendix D (`v6-spec.md:861-892`) shows the same
   shape and no scope index.
2. **`assignments` cannot substitute.** It is keyed by `skeyR` = `relPath#kind#qualifiedName`
   (`extract.ts:203-204`, and `partitionAssignments` is built from `u.skeyR`, `mine.ts:1037-1041`),
   while `stableId = hash(partitionId ∥ relPath ∥ kind ∥ qualifiedName ∥ **arity**)`
   (`extract.ts:627-628`). **`arity` is persisted nowhere**, so stableIds cannot be recomputed from
   the snapshot and the map cannot be inverted. Separately, an ineligible or role-less scope carries
   **no** `assignments` entry at all (`roles.ts:815-825`), so even a `skeyR`-keyed lookup could not
   distinguish "gone" from "`_all`-governed", which is Step 2's third branch.
3. **No per-scope surface value is persisted at all**, so "shows the pair at `expected`" / "still
   deviates" has no source. (The spec assumes it too — §18.2 `:683` — but Appendix D does not carry
   it, and closing that gap is exactly the job T2 already does for `exemplars`, `partitionRouting`
   and `commitsA`/`commitsB`.)
4. **The in-memory fallback is closed by D16 itself.** On the path D16 exists for — the no-op
   short-circuit, which T8 criterion 7 requires demotion to survive — the landed `index` action
   returns before any mining: `evaluateNoOpShortCircuit` runs cold at `cli/roots.ts:711-725` and
   `if (isNoOp) { …; return; }`, so `runRootsIndex`'s walk/parse/`mine()` never execute
   (`pipeline.ts:290-343`). No units, no bags, no domains, no surface values.

**Why it is blocking, not an implementation detail.** This is round-1 B4's exact shape
("completeness consumed data the snapshot does not carry", fixed by T2 persisting two integers),
applied to the demotion complex. As written, a T8 implementer has three exits and all three are
bad: STOP (best case, one full task lost); pool on the **recorded** `factKey`, which is precisely
the defect M3 (round 1) and MR-34b exist to prevent and which passes every fixture while never
firing in production; or invent a repo-wide re-enumeration inside every `index`, which nothing
authorizes and which contradicts D16.3's cost framing and R5-I16. Criterion 3b ("the pool survives
a re-induction … the resolution through `stableId` is what finds them", `:4089-4092`) is
unsatisfiable as stated, and criteria 4/4b/4c/4d and both e2e legs all read the current value of a
scope.

**Concrete fix — one of two, and the choice changes T2 as well as T8.**

- **(a) Persist the projection at T2 (preferred; it is the pattern D3/D5/D20 already use).** Add a
  fourth additive body field, e.g. per partition
  `scopeIndex: Record<stableId, { rel: string; skeyR: string; kind: 'method'|'type'|'file' }>` plus
  the observed values the closure branch reads —
  `surfaceValues: Record<stableId, Record<surface, string>>`, restricted to the surfaces that
  actually carry facts, which bounds it by the cell set the model already reasons over. Then Step 1's
  resolution is `scopeIndex[stableId] → routePartition → assignments[skeyR] → current factKey`, and
  Step 2's branch is `surfaceValues[stableId][surface] === expected`. Consequences to land in the
  same edit: D3's "three things the model body does not yet carry" becomes four (and the
  `ROOTS_VERSION` regeneration argument covers it unchanged); R5-I5's determinism sentence names
  the fourth field and its total order; T2's Scope, Files, Step list, criteria and e2e all grow;
  T8's Files block names the body as an input; and the size cost is stated the way D20 states its
  two integers.
- **(b) Re-enumerate exactly the affected files at `index`.** Add `rel` (and `skeyR`) to
  `TelemetryRecord`, to the `'warned'` event and to `OpenIntervention`, and have `src/cli/roots.ts`
  read + `extractScopesForCheck` + `enumerate` **only** the files named by open interventions and
  unresolved telemetry rows before calling `health.ts`. This keeps the body unchanged but must be
  written as a decision with its cost (O(files with open interventions) parses on every `index`,
  including short-circuited ones), its module ownership (the bytes are read in the command layer;
  `extract-file.ts` stays `no-direct-fs`), and its interaction with D16.4's "creates nothing" rule
  and R4's whole-tree no-op snapshot (reads write nothing — say so).

Either way, T8's Files block must stop enumerating health.ts's inputs as "the folds plus `nowMs`",
and D13a(a)'s derivability note must record the walk for the pass's own row (it currently records
`observed` as "from the current index" without asking whether the current index can be read).

---

## MAJOR

### M1 — T3 Step 8's closing sentence contradicts D11 on both halves of the degraded dirty-set rule, and reinstates a caveat round 2 deleted.

**Where.** T3 Step 8, `:2911-2912`: "Git unavailable **or a shallow clone** ⇒ **empty set** ⇒
silence plus one `debugWrite` line."

**Against D11**, `:1205-1212`:

- `getDirtyFiles` "returns **`null`**, never `[]`, when it cannot tell … `null` ⇒ silence plus one
  `debugWrite` line; **`[]` ⇒ silence and no log line**, because a clean tree is the normal,
  correct, uninteresting case." Verified at source: the landed contract says "Returns `null` (never
  an empty array standing in for 'could not tell')" (`utils/git.ts:113-124`, function at `:125`).
  Step 8 describes the degraded outcome as an **empty set** that logs, which is the one combination
  D11 rules out.
- "A **shallow clone is not a degraded case here at all**: `git status` reports dirty files normally
  in one, so the shallow-clone caveat that belongs to the history walk does not belong to this
  path." Step 8 names a shallow clone as producing an empty set — the false caveat round 2's minor
  sweep explicitly removed from D11 ("`getDirtyFiles`' `null`-vs-`[]` distinction is restored and
  the false shallow-clone caveat removed", `:5047-5048`) and which never reached the step that
  implements it.

**Why it matters.** This is a live decision-vs-task contradiction, which this plan's own protocol
turns into a STOP (`:608`, `:4750`) — the same failure round 10 fixed by deleting R5-I3's trailing
sentence. It is also observable: an implementer following Step 8 emits a `debugWrite` line on every
clean-tree run (the common case, and the one D11 calls "uninteresting"), and writes a
shallow-clone branch that can never fire. T3 criterion 13's last clause ("With git unavailable the
same invocation is silent and exits 0") does not pin either half, so nothing catches it.

**Fix.** Replace `:2911-2912` with D11's own two cases and drop the shallow-clone claim:
"`getDirtyFiles` returning `null` (not a git repository, or git missing) ⇒ silence plus one
`debugWrite` line; `[]` (a clean tree) ⇒ silence and **no** log line (D11). A shallow clone is not a
degraded case on this path." Optionally extend T3 criterion 13 with the `[]`-no-log arm so the
distinction has an observer.

---

## MINOR

### m1 — `nowIso`'s timezone is never pinned, while the ledger `date` and T8's ended-session predicate both require the **UTC** day.

`VerdictInput.nowIso` is declared as `nowIso: string; // roots-check.ts's injected clock — telemetry
ts / ledger date` (`:2598`), and T7 criterion 7 leg B derives the mark's `date` "from the same
`nowIso` the input carried" (`:3822-3823`). D15 requires "the UTC calendar day … as exactly
`YYYY-MM-DD`" (`:1446-1452`) because `markKey` joins the date verbatim (`weights.ts:267-269`) and
`releasedMarks` does `Date.parse(mark.date)` assuming UTC midnight (`:256`); T8's ended-session
predicate is UTC-day off `nowMs`. A local-time ISO string silently produces a different `date` for
the same UTC day either side of local midnight, breaking §18.3's per-day dedupe and skewing the
release arithmetic — and it would make the check path's day and the pass's day disagree.
**Fix:** state at the field (and once in T6 Step 4 beside the identity ladder) that `nowIso` is a
UTC ISO-8601 instant (`new Date().toISOString()`, `Z`-suffixed) and that the ledger `date` is its
first ten characters.

### m2 — D1's per-partition `evaluate` fan-out is stated for `findings` only; `closureIntents` reads as singular everywhere, and `Intents`' asserted "sorted" has no key.

D1 fixes that "`evaluate` is called once per partition … in ascending `partitionId` order" and that
the **findings** are concatenated in that order (`:655-662`), but the same call returns
`closureIntents` (`:2621`), and T7 Step 3 says "**three** sets concatenate into one `Intents`
record: **`evaluate`'s `closureIntents`**, `applyBudgetsAndDedup`'s `emissionIntents`, and the
command layer's own `'checked'` event" (`:3738-3741`) — singular, so a monorepo run with N routed
partitions has N closure sets and no stated merge or order. D1 also calls `Intents` "a plain,
**sorted** record" (`:640`) without naming a sort key anywhere. Nothing is observably wrong today
(within-kind append order is only visible in the session log), but the plan is otherwise absolute
about single ordering authorities. **Fix:** one clause in D1 and one in T7 Step 3 — the command
layer concatenates the N `closureIntents` in the same ascending `partitionId` order it used for
findings, and either name `Intents`' sort key or drop the word "sorted".

### m3 — the exemplar existence filter's per-run cost is asserted as bounded without the arithmetic D4's own rejection of the alternative rests on.

D4 rejects a re-parse on a cost argument against the 700 ms cold budget (`:812-814`) and then says
the filter's "cost is bounded and statable — at most three `lstat`s per projected fact, once per
run" (`:829-830`, repeated at `:2784-2785`). But T3 Step 7b builds `VerdictFact[]` from the **whole**
routed `MinedPartition` (`:2769-2773`), and `mdl.factCap` is **400** (`config-parser.ts:80`) — so the
real per-run bound is ≤ 3 × 400 = **1 200 `lstat`s per routed partition**, multiplied by the number
of partitions a bare `yg roots check` spans. Meanwhile only the ≤ 3 emitted findings' governing facts
ever have their exemplars rendered, so almost all of that work is discarded. **Fix:** state the real
bound beside D4's own budget arithmetic, and require a per-run memoized `lstat` cache keyed on `rel`
(exemplar files repeat heavily across a partition's facts, which collapses the bound to distinct
files) — or narrow the filter's domain to the governing facts of scopes that actually produced a
finding, keeping the "renderer needs no new rule" property by running it on the same layer just
before render.

### m4 — `appendTelemetry`'s growth law is unstated, though T6 Step 5 states the analogous session-log law for the same reason and telemetry's window is 26× larger.

`appendTelemetry` "dedupes on `(sessionId, stableId, surface, observedAfter)`" (`:1854-1855`, T1
criterion 4b), which means reading and parsing the whole `telemetry.jsonl` on **every** append —
and D14 puts those appends on the hook path, inside the 700 ms cold budget. T6 Step 5 goes out of
its way to state exactly this law for the session log ("`foldSession` reads the whole log on every
hook invocation inside the 700 ms cold budget … mtime-based pruning at 7 days is the only bound",
`:3601-3610`), while telemetry's only bound is `health.telemetryRetentionDays` = **180** compaction
that runs at `index` — a window 26× longer, on a file with no per-session partitioning. T11's
dogfood step measures the session-log size (`:3610`) and not this one. **Fix:** state the law where
`appendTelemetry` is defined (whole-file read per append; compaction at `index` is the only bound;
why that is acceptable, or what caps it), and add the observed `telemetry.jsonl` size and append
cost to T11 Step 5's reported figures beside the session-log figure.

---

## Closing note

B1 is the third producer-derivability gap the D13a-style walk has surfaced in two rounds, and it is
the first that cannot be closed at a signature — it needs data that does not exist on disk. Rounds
12 and 13's repairs all held under re-derivation, the 72-MR set is internally consistent, and every
cross-reference class is clean; the defects this round are one missing snapshot projection, one
decision-vs-task drift that outlived the round-2 fix that created the decision, and four
under-stated contracts.
