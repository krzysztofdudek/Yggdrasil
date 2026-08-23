# Increment 4 (R5) plan — adversarial review, round 12

**Target:** `planning/plugin/sp-plans/2026-08-22-increment-4-r5-verdict.md` (5770 lines), read in full.
**Tree:** branch `claude/document-review-13yoty`, HEAD `a370f5a`. Verified that `a761dda..HEAD`
touches **only the plan file** (`git diff --stat` = 1 file, 5770 insertions), so every `a761dda`
anchor in the plan is still an anchor into the current tree.

## VERDICT: 0 BLOCKING + 3 MAJOR + 5 MINOR

Round 12 is **not clean**. The consecutive-clean counter stays at **zero**.

All three majors are executability defects of the class the last four rounds have been finding:
a rule whose only stated home is forbidden by an aspect the plan itself cites; a *preferred*
implementation that breaks landed assertions the plan's own exhaustive breakage list omits and a
freeze rule the plan states absolutely; and an invariant clause with no owning task, no criterion,
and a landed helper that refuses it.

---

## MAJOR-1 — T3 criterion 14b requires one test to both drive `yg roots check` and import
`findNestedProjectRoots` from `src/**`; its natural home is refused by `e2e-public-surface`, and the
plan never says where it lives

**Plan lines:** 2678-2698 (criterion 14b), esp. **2693-2698**; supporting: 324 (R5-I12), 148 (the
edge table's e2e row), 2211-2221 and 2231 (T3's Files).

**What the criterion demands.** Criterion 14b (`:2683-2698`) builds a programmatic fixture and then
requires, in one test:

- `yg roots check` on a gitignored file, a symlink and a nested checkout → "prints nothing, exits 0,
  records no incident" (`:2685-2686`);
- the same run over `packages/pseudo-a/` and `packages/pseudo-b/` → each "**must produce their
  message**" (`:2688-2692`);
- and (`:2693-2695`) "**The same test** calls the landed `findNestedProjectRoots(repoRoot)` once and
  asserts its result contains `packages/external` and contains **neither** `packages/pseudo-a` **nor**
  `packages/pseudo-b`", with the stated reason "so gate −1's per-path narrowing and the function it
  narrows are pinned together in both directions, which a single positive fixture cannot do."

**Why the natural home is refused.** `findNestedProjectRoots` is exported from
`source/cli/src/io/repo-scanner.ts:229`. The `e2e-public-surface` aspect forbids **any** e2e file
from naming a specifier that resolves under `source/cli/src/` — static import, `import type`,
re-export, dynamic `import()` or `require()` (`.yggdrasil/aspects/e2e-public-surface/check.mjs`,
`SRC_ROOT = 'source/cli/src/'`). It is **enforced**, and it reaches every child of `cli/tests/e2e`
by node inheritance, not only the node that declares it — confirmed live against the landed sibling:

```
$ node source/cli/dist/bin.js context --node cli/tests/e2e/roots-basic
  e2e-public-surface [enforced] — …
    Source: inherited from parent 'cli/tests/e2e'
```

(`.yggdrasil/model/cli/tests/e2e/roots-basic/yg-node.yaml` itself declares `aspects: []`.) So the
new `cli/tests/e2e/roots-verdict` node inherits it too — which is exactly what the plan asserts at
`:148` and `:324`. The three "run `yg roots check`" halves of 14b read as an e2e (criteria 14 and 15
either side of it are phrased identically, and T3's only spawning file is
`tests/e2e/cli-roots-check.test.ts`, `:2231`). An implementer who lands 14b there gets a **blocking
deterministic aspect refusal** at that task's own `check --approve --only-deterministic` gate.

**Why this is not merely a wording nit.** The plan is exhaustive about test homes everywhere the
choice matters — criterion 8 (`:2612-2614`), 8b (`:2620-2623`) and 8c (`:2628`) each name the file —
and 14b names none. The two legal homes both require a departure the plan does not sanction:

- `tests/unit/cli/roots-check.test.ts` (node `cli/tests/unit/cli/roots`, no `e2e-public-surface`)
  would have to drive the command in-process — legal precedent exists
  (`tests/unit/cli/roots.test.ts:14-22` imports `registerRootsCommand` and runs it) — but the plan
  never says so, and that node would need a new declared `uses` edge to `cli/io/stores` (which maps
  `repo-scanner.ts`, `.yggdrasil/model/cli/io/stores/yg-node.yaml:29`), an edge the "full new-edge
  audit" (`:134-149`) does not carry.
- Splitting the criterion across the e2e and `tests/unit/io/repo-scanner-nested.test.ts` (node
  `cli/tests/unit/support/io`, which already maps that file at `yg-node.yaml:40` and already imports
  `findNestedProjectRoots`) contradicts 14b's own "**The same test**".

The support-helper escape is closed too: `e2e-public-surface`'s own description says shared helpers
under `support/` "import nothing from `src/**`".

**Fix.** State 14b's home, and split it the way the aspect allows without losing the two-directional
pin:

1. Move the programmatic fixture builder into `tests/support/` (no `src/**` import — it only writes
   files), so both tiers build the *same* fixture.
2. Keep the five `yg roots check` legs in `tests/e2e/cli-roots-check.test.ts`.
3. Put the `findNestedProjectRoots(repoRoot)` assertion in
   `tests/unit/io/repo-scanner-nested.test.ts` — the file T3 already edits (`:2211-2221`) and the one
   node that legally imports it — over the same builder, and replace "The same test" with "the same
   **fixture**, asserted at both tiers", since the shared fixture is what the stated reason actually
   needs.
4. Note in that leg that `findNestedProjectRoots` is memoized and the landed test file already
   imports `resetNestedProjectRootsCache` (`repo-scanner.ts:218`) — call it first, or the assertion
   can read another test's cached answer.

MR-14f (`:2767-2772`) must be re-pointed accordingly: it claims one mutation fails "criterion 14b's
two negative cases **and** the `findNestedProjectRoots` assertion", which after the split is two
files — still one mutation, but the plan should say both.

---

## MAJOR-2 — D4's *preferred* `m1` implementation breaks three landed `toEqual` assertions in
`roles.test.ts`, a file the plan freezes at "not a single character", and names none of them among
the fifteen it enumerates for exactly this reason

**Plan lines:** **686-693** (D4's `m1` bullet), 416-418 (the freeze), 1983 (T2's Files restating it),
2005-2029 (the enumerated breakage list), 1996-2004 (T2 Step 1's measurement gate).

**The instruction.** D4 (`:686-689`): "**Preferred implementation: extend `RoleClassification`
(`src/roots/roles.ts:335-339`) with `m1: number`**, so the membership has one home; that is a
~30-line edit inside the prompt-ceiling cap…". The fallback (compute `m1` in `exemplars.ts` from
`roleJaccard`) fires **only** if the post-edit measurement puts `roles.ts` within 2000 chars of the
ceiling — and the plan predicts ≈14 600 (`:448-449`, reproduced by rounds 10 and 11) and makes a
near-2000 reading a **STOP** (`:2001-2004`). So the preferred path is the path.

**What it breaks.** `RoleClassification` is the return type of `classifyAgainstMedoids`
(`roles.ts:336-339`, `:351-357`). Adding a populated `m1` changes that return object, and vitest's
`toEqual` fails on an extra defined key. Three landed assertions assert the exact shape:

```
source/cli/tests/unit/roots/roles.test.ts:162:    expect(result).toEqual({ roleIndex: 0, ambiguous: false });
source/cli/tests/unit/roots/roles.test.ts:214:    expect(result).toEqual({ roleIndex: 0, ambiguous: false });
source/cli/tests/unit/roots/roles.test.ts:230:    expect(result).toEqual({ roleIndex: 0, ambiguous: false });
```

(The other `roleIndex` sites in that file — `:167`, `:171`, `:189`, `:197`, `:241` — read the field
and survive.) There is no escape via optionality: `m1?: number` left unset defeats D4's own "the
membership has one home", and set on the success path still breaks all three, which are success
paths.

**The two failures this is.**

1. **It contradicts the freeze.** Global constraints (`:416-418`): the three tightest prompts —
   including `tests/unit/roots/roles.test.ts` at **660** chars of margin — "**must not grow by a
   single character.**" T2's Files repeats it as the reason for a new sibling file (`:1982-1983`:
   "`roles.test.ts` is frozen at 660 chars of margin"). Repairing three `toEqual` literals grows that
   file by ~30-40 characters. The margin survives; the *rule as written* does not, and the plan gives
   no dispensation — so the implementer faces a decision-vs-task contradiction, which this plan's own
   protocol turns into a STOP (`:4320`).
2. **It is absent from the enumeration whose whole purpose is to prevent this.** T2 Step 1 names
   "eight landed assertions … so none is discovered as a mystery failure" (`:2005-2013`), then "seven
   more, named here for the same reason" (`:2014-2021`), then a sixteenth comment site
   (`:2022-2029`). All fifteen verified correct at HEAD (`roots.test.ts:202/342/375/404/432/639/674`,
   `cli-roots-basic.test.ts:73`, `history-cochange.test.ts:178/181/203/244/367/572`,
   `mine.test.ts:457/470`, `mine.ts:155-160` with `exemplars` on `:156` and `(§9.11)` on `:157`).
   The three `roles.test.ts` sites are a *sixteenth/seventeenth/eighteenth* landed assertion this
   increment breaks, in the file the plan singles out as untouchable.

**Fix.** In D4's `m1` bullet, after the "preferred implementation" sentence, add: "This changes
`classifyAgainstMedoids`' return object, so the three exact-shape assertions in
`tests/unit/roots/roles.test.ts` (`:162`, `:214`, `:230`) gain the new key — the only edit this
increment makes to that file, and an explicit, bounded exception to the freeze (three literals,
≈40 chars against 660 of margin; re-measure after)." Mirror it in T2 Step 1's enumeration (making it
"eighteen landed assertions") and in T2's Files line, so `roles.test.ts` reads as "frozen except for
these three keys" rather than as untouchable. If the maintainer prefers the freeze absolute, invert
D4's preference: make `exemplars.ts` + `roleJaccard` the primary implementation and the
`RoleClassification` extension the fallback — the plan already carries that implementation and pins
the two against each other by value (`:691-693`).

---

## MAJOR-3 — R5-I15's fifth absorbed fault (an `EACCES` on a `.state/` append) has no owning task,
no criterion and no killer, and both landed helpers throw — so R5-I2 prescribes the opposite outcome
for the same input, which R5-I15 claims by construction cannot happen

**Plan lines:** **353-357** (R5-I15's list), **217-224** (R5-I2's absorbed enumeration), 355-357 and
372-373 (the disjointness claim), 3031-3044 (T5 criterion 4b), 1731-1764 (T1 Steps 2/2b/3), 1867-1869
(T1 criterion 5).

**The contradiction.** R5-I15 (`:353-355`) lists **five** absorbed faults: "A corrupt session file,
an unreadable `demotions.json`, a missing grammar, a file that will not parse, **an `EACCES` on a
`.state/` append** — each is one `debugWrite` line and a continued run, **with findings still emitted
and no incident recorded**." It then claims (`:355-357`) that R5-I2 "governs what escapes it, and the
two lists are disjoint by construction so the same input never has two prescribed outcomes."

R5-I2's own absorbed enumeration (`:220-224`) has **four** entries and assigns each an owner: "a
corrupt session line is skipped (T1 Step 3's per-record tolerance), an unreadable `demotions.json`
reads as `undefined` (T1 criterion 5), a missing grammar is a `[]` skip and a parse failure degrades
to `minimalFileScope` (D6's gates 1 and 5)." **The append `EACCES` is not there.** Nor is it in T5
criterion 4b, which enumerates exactly four absorbed faults (`:3031-3040`: a corrupted session log
line, a non-JSON `demotions.json`, an unregistered grammar, a forced `parseFile` throw). Nor in any
T1 step or criterion: Step 2 fixes the chokepoint (`:1731-1740`), Step 2b fixes `mkdir`
(`:1741-1759`), Step 3 fixes **read** tolerance ("a malformed line is skipped", `:1760-1764`), and
criterion 5's four cases (`:1867-1869`) are all malformed **content**.

**The landed code refuses the promise.** The mandated append chokepoint is a bare synchronous write
with no guard:

```ts
// source/cli/src/io/debug-log-writer.ts:7-9
export function appendToDebugLog(filePath: string, text: string): void {
  appendFileSync(filePath, text, 'utf-8');
}
```

An `EACCES`/`EROFS`/`ENOSPC` there throws out of `appendSessionEvents` / `appendTelemetry` /
`appendIncident`, out of the intents applier, and into R5-I2's single catch — which by R5-I2's own
rule produces "zero findings plus exactly one incident record". That is the *opposite* of what
R5-I15 promises for the same input, in the one pair of invariants the plan says are disjoint.

**The read side has the same hole.** "An unreadable `demotions.json`" is owned by T1 criterion 5,
whose four cases are content-shaped — but the mandated reader rethrows every non-ENOENT error by
documented contract:

```ts
// source/cli/src/io/read-or-default.ts:5-6, 16-22
 * Read a UTF-8 text file. If the file is missing (ENOENT) return the supplied default.
 * Any other error (EACCES, EISDIR, EIO, …) is rethrown — callers must handle real failures.
```

So an `EACCES` on `demotions.json` — literally the case R5-I15 names — escapes to the boundary too,
unless `readDemotions` catches it, which no step or criterion says it does.

**Fix.** Two sentences and two criteria, all in T1:

1. T1 Step 3: extend the tolerance contract from *records* to *I/O*: "Every reader in this task
   returns its empty/`undefined` answer on **any** read failure, not only ENOENT and not only a parse
   error — `readFileOrDefault` rethrows `EACCES`/`EISDIR`/`EIO` by contract
   (`read-or-default.ts:5-6`), so each reader wraps it and emits one `debugWrite`."
2. New T1 step/clause: "Every **writer** in this task swallows its own failure to one `debugWrite`
   and returns normally — `appendToDebugLog` is a bare `appendFileSync`
   (`debug-log-writer.ts:7-9`) and throws. A failed append loses derived state, which R5-I15 permits;
   it may never lose the run's findings or mint an incident."
3. Add T1 criterion 5b (a read on a mode-`000` `demotions.json`/`telemetry.jsonl` returns
   `undefined`/`[]` with no throw) and 6c (an append into a read-only `.state/` returns normally and
   records no incident), both skipped where the suite already skips its chmod cases under root
   (the plan's own environment note, `:530`).
4. Extend T5 criterion 4b's absorbed set from four faults to **five**, adding a failed `.state/`
   append in a run that also contains a genuinely deviating file — the run still emits the finding,
   exits 0, records **zero** incidents — and point MR-19b at it as well, so the fifth clause of
   R5-I15 finally has a killer (R5-I11).
5. Re-list the fifth fault in R5-I2's enumeration (`:220-224`) with its new owner, so the two lists
   really are disjoint.

---

## MINOR-1 — three off-by-one anchors in T1 Step 6, two of them introduced by round 11's own
"correction"

**Plan lines:** 1798-1803.

The plan writes: "the script exits 0 on its normal reporting path (`prompt-headroom.mjs:570`) and
reserves the **non-zero** exit of `fail()` (`:451`) for a run it could not perform at all (a missing
built binary `:454`, a missing config `:455`, …)". Measured at HEAD:

```
451:function log(m) { … }
452:function fail(m) { … process.exit(1); }
454:async function main() {
455:  if (!existsSync(BIN_PATH)) fail(`built binary missing …`);
456:  if (!existsSync(CONFIG_PATH)) fail(`no committed config …`);
570:  process.exit(0);
```

`fail()` is **:452**, the missing-binary check **:455**, the missing-config check **:456**. `:570`
and `:567` (the summary line) and `:558-565` (the per-tier block) and `:576` (`process.argv[1]`) are
all correct. Round 11's changelog (`:5676-5677`) records "`fail()` is `prompt-headroom.mjs:451`
(not `:452`)" — i.e. a correct anchor was replaced with a wrong one, and the neighbouring two moved
with it. The anchor is load-bearing because the same sentence tells the implementer **not** to "fix"
`fail()` to exit 0. **Fix:** `:451`→`:452`, `:454`→`:455`, `:455`→`:456`, at `:1799-1801`.

## MINOR-2 — T1 Step 6's query-block placement contradicts criterion 8b's prefix identity

**Plan lines:** 1789 vs 1895-1897.

Step 6 says "With one or more `--file`, **after the existing per-tier block** the script prints…"
(`:1789`), and the plan defines the per-tier block as `:558-565` (`:1780`, `:427`) — which ends
*before* the summary line at `:567`. Criterion 8b asserts "the no-argument run's per-tier block
**and summary line** are byte-identical to the `--file` run's **first N lines**, and the `--file`
run appends its query block and nothing else" (`:1895-1897`) — which requires the query block to
follow the summary line. An implementer following Step 6 literally inserts at `:566` and fails 8b.
**Fix:** at `:1789` write "after the existing per-tier block **and its summary line** (i.e. as the
last thing printed before `process.exit(0)`)".

## MINOR-3 — the aspect inventories are type-level only and are stated as complete; four enforced
node-inherited aspects are uncounted, one of them on-point for this increment's only new parsing
module

**Plan lines:** 104-107, 483-495.

The plan says "`command` carries **seven** aspects (`yg-architecture.yaml:49-57`) … Read all seven
before writing the file" (`:104-107`) and "**five** bind every new `src/io/` file
(`yg-architecture.yaml:197-203`)" (`:484-486`). Both counts are the *type-level* lists and are
correct as such, but they are not the effective set. Measured live:

```
$ node source/cli/dist/bin.js context --node cli/commands/roots
  wasm-tree-lifecycle [enforced]            Source: inherited from parent 'cli'
  events-reader-boundary [enforced]         Source: inherited from parent 'cli'
  instrument-import-fence [enforced]        Source: inherited from parent 'cli'
  rules-artifact-names-single-source [enforced]  Source: inherited from parent 'cli'
  … plus the seven type-level ones and their implied children (command-exit-codes,
    posix-paths-source, no-direct-minimatch, …)
```

Three of the four are inert for R5, but **`wasm-tree-lifecycle`** is not: it forbids importing
`parseFile` from `ast/parser` directly and requires `withParsedFile`. D6's gate 5 happens to specify
`withParsedFile` (`:925-927`), so the plan complies — but by copying the landed loop, not because the
rule is in its inventory, and `extract-file.ts` is precisely the file an implementer might reach for
`parseFile` in (T5 criterion 4b even discusses `parseFile` throwing, `:3035-3037`). **Fix:** at
`:104-107` and `:483-495`, say "seven from the type, plus four enforced aspects inherited from the
`cli` node — of which only `wasm-tree-lifecycle` has teeth here: the single-file parse path must go
through `withParsedFile`, never `parseFile`."

## MINOR-4 — D5's module-root reconstruction is written over "which arm matched", which
`routePartition`'s return cannot report, while D5 forbids a second copy of the arm walk

**Plan lines:** 778-795 (the one-matcher rule), **806-808** (the reconstruction rule), 2044-2047
(T2 Step 3 / criterion 4's second half).

D5 exports exactly one matcher, `routePartition(routing, relPath): string | null` (`:780-782`), and
says the arm test "is exported **once** … never re-written in a test or a caller". But `:806-808`
states the module-root rule as "`''` when the resolved id is `'_repo'` **or the `fallback` arm
matched**, otherwise **the matched entry's `dir`**" — two facts the `string | null` return does not
carry. An implementer needing `moduleRootDirOfFile` for D6's synthesized `PartitionMap` would re-walk
`roots`, which is the second implementation D5 refuses.

It is derivable from the id alone, and the plan should say so: an own-floor entry's `partitionId`
**is** its `dir` (`partitions.ts:284`, `finalId = key`), and every other outcome collapses to `''`
(`partitions.ts:291`) — so `moduleRootDir = (id === '_repo' || id === '_root') ? '' : id`. **Fix:**
replace `:806-808` with that expression (keeping `partitions.ts:291` as the citation), or widen
`routePartition` to return `{ partitionId, moduleRootDir }` and say so in the signature at `:781`.

## MINOR-5 — one dangling qualified step reference (review history)

**Plan line:** 5452 — "the prompt-margin mechanism → … **T5/T6/T7 Step 6** and T9's step". T7 has
Steps 1-5; its `roots-check.ts` headroom obligation is **Step 5** (`:3318-3320`). T5's and T6's are
Step 6. **Fix:** "T5/T6 Step 6, T7 Step 5 and T9 Step 6."

---

## Mechanical properties I was asked to verify myself

**Three-class cross-reference property — HOLDS in the task body.** Extracted every task's criterion
and step ids programmatically and checked all three reference classes across the document:

- **Qualified criterion refs** (`T<n> criterion/criteria <m>`): **zero dangling**. Spot-checked by
  hand: T1 c3/c4b/c4c/c5, T2 c4b/c6, T3 c13/c14/c14b/c15, T5 c3b/c3c/c4b, T6 c4b/c4c, T7 c2/c3b/c7,
  T8 c4b/c4c/c4d/c6/c7, T9 c5c/c5d, T10 c1/c1b/c6 — all resolve. (T3's criteria 1-6 are its
  Δ-table rows, exactly as R5-I6's repaired pointer at `:263-267` says.)
- **Qualified step refs** (`T<n> Step <m>`): zero dangling in the task body. `T8 Step 2a`/`2b` are
  Step 2's labelled `(a)`/`(b)` subsections (`:3506`, `:3542`) — real. One dangling reference in the
  **review history** only: MINOR-5 above.
- **Bare in-task `Step N`**: zero dangling (only `Step 2a`/`2b` inside T8, both real).

**71-MR uniqueness/definition property — HOLDS.** Mechanically: **71 distinct definitions, no
duplicates**, matching R5-I11's "(71 ids at present)" (`:309`). Every `MR-*` referenced in the task
body is defined except `MR-32c`/`MR-32d`, which appear only in R5-I11's retirement sentence
(`:314`), T8 Step 2b (`:3548`) and their own retirement notice (`:3826-3834`) — exactly as the plan
states. `MR-32b2` appears only inside the round-7/8 changelogs (`:5087`, `:5153`, `:5180`, `:5206`),
never in the task body, which is consistent with round 8's "absorbed into MR-32b's honest scope".

## Worked numbers — all re-derived from the spec, none moved

- **Six Δ rows (`:2593-2605`)**: `log2 7 = 2.807`; `log2 13 = 3.700`; `log2(41/3) = 3.77259`
  (quoted 3.7726, fires at τ 3.5, not at 4.5); `log2 41 = 5.358` at K = 5, n_eff 20 (spec E.6 says
  5.36, `v6-spec.md:920`); `log2(2.5/1.5) = 0.737` at share 2/3, under E.2's exact-1.0-bit supremum
  (`:907`, quoted verbatim). E.1's `log2(2·n_eff+1)` identity holds for rows 1 and 2 (`:905`).
- **Eight Wilson figures (z = 1.96)**: n = 10 → 2/8 **0.05668**, 5/5 **0.23659**, 7/3 **0.39677**;
  n = 8 → 0/8 **0** exactly (the `z·√(z²/4n²)` term equals `z²/2n`), 4/4 **0.21521**, 5/3
  **0.30574** (clears 0.3 by 0.0057 — the four-place quote is justified), 6/2 **0.40927**. All match.
  §14's "z = 1.96 two-sided — fixed" confirmed at `v6-spec.md:637`.
- **T9's completeness trio (`:3949-3959`)**: 9/9 = 1.0 ≥ 0.75; 9/12 = 0.75 (inclusive boundary);
  9/20 = 0.45 < 0.75; `sup 9 ≥ minSupport 8`. §13.5's `E` excludes `D` and deleted partners
  (`v6-spec.md:625`) — matched by T9 Step 4's `partner ∉ D ∧ partner still exists on disk`.
- **Both fixture sizings**: 4b(ii)'s ~600 generated scopes (two buckets must each clear
  `PARTITION_SCOPE_FLOOR = 300`, `partitions.ts:69`, given `keyFor`'s closest-ancestor rule
  `:239-244`) ✓; 4b(v)'s "two distinct sub-floor keys summing ≥ 300" ✓ against
  `repoBucketSurvives = mergedCount >= 300` over **only** the sub-floor keys (`partitions.ts:257-275`;
  an own-floor key never joins the merge, `:260-261`).
- **Criterion 8's margins (`:1882-1889`)**: 72 000 − 65 000 = 7 000; − 60 000 = 12 000;
  − 10 000 = 62 000; `worstMargin` = 7 000 ✓.
- **MR-12's cancellation (`:2743-2748`)**: `p̂(e)/p̂(v)` cancels the shared KT denominator to
  `(n_e+½)/(n_v+½)`, so an in-alphabet zero-count value prices identically to ⊥ — §9.3's own
  "numerically like ⊥ but NOT novel" (`v6-spec.md:385`). MR-12 is correctly a novelty-*flag* killer.
- **Five epoch constants vs `weights.ts`**: 2026-01-01 = 1 767 225 600; 2026-01-15 = 1 768 435 200
  (= +14 × 86 400); 2026-01-14 = 1 768 348 800; 2026-04-01 = 1 775 001 600 (⇒ `stableDaysOf` exactly
  90); 2026-03-31 = 1 774 915 200 (⇒ 89). Checked against `stableDaysOf` (`weights.ts:108-110`),
  `releasedMarks` (`:250`), its `rowFor(mark.stableId, mark.stableId)` (`:253`),
  `Date.parse(mark.date)` (`:256`) and `markKey` (`:267-269`); `ledger.releaseStableDays: 90` /
  `releaseMinDaysAfterMark: 14` (`config-parser.ts:113`). The `<` and `>=` senses in T7 criterion 7
  match the landed guards.
- **The echo-shaped sizing vs `mdl.minInstancesRaw = 5`** (`config-parser.ts:78`): T8's control leg
  needs its fact to hold ≥ 6 survived conformers so it stays hook-eligible after one goes
  echo-shaped ✓ — the constraint the plan added in round 11 is correctly derived.

## Landed-surface anchors re-verified (a sample of ~70, all correct unless listed above)

`mine.ts:121/125/130-132/141-142/155-160(:156,:157)/165/1035`; `mine-stages.ts:52`;
`partitions.ts:69/101-102/127-137/221/232-250/237/239-244/243/257-275/284/291`;
`roles.ts:149/194/335-339/351-357/363-369/598/803/815-818/819-825/871/887/904/913/983/1030/1054-1057`;
`extract.ts:72/203-204/417/627-628/748/795-798`;
`pipeline.ts:41/44/92/96-100/101-118/103/104/108-109/111/115-118`; `history.ts:89` (imports
`MAX_PARSE_LINES`, confirming the second consumer); `history-cochange.ts:94/109-112/394-398`;
`history-resume.ts:62/394`; `stores.ts:25-37/43/61-63/160-162/206-211/274`;
`cli/roots.ts:99-113/128-129/403-409/491-510(the eight header inputs)/538/551-556`;
`weights.ts` (above); `repo-scanner.ts:21/33/99/229/260-269/305/322-335/339/524-538`;
`config-parser.ts:42-43/51/57-62/78/91-92/112/113/114-123/124/125/128-130/131-138/136/137/139`;
`debug-log-writer.ts:7-9`; `atomic-write.ts:26/27-28`; `read-or-default.ts:10`;
`yg-architecture.yaml:43-48/49-57/61/68-74/82/183/197-203/206-209/341/442-454/742-748/749-755/759-760/774-777`;
`yg-config.yaml:9/:43`; `.yggdrasil/model/cli/io/stores/yg-node.yaml:18/24/25/28/29`;
`.yggdrasil/model/cli/roots/engine/yg-node.yaml:173-174/179-180/185-186`;
`.yggdrasil/model/cli/tests/unit/roots/yg-node.yaml:287-288`;
`.yggdrasil/model/cli/tests/unit/support/io/yg-node.yaml:40`;
`.yggdrasil/model/scripts/yg-node.yaml:8`; `portal-derive-rest.test.ts:69-80` (32/25/24/23/23/23);
`cli-roots-basic.test.ts:46-52/73/159/209/212/237`; `check-codes.ts:28-36/:96`;
`relations.ts:73`; `validator.ts:192`; `typescript.ts:180-181`; `prompt.ts:179-181`;
`repo-check.sh:209`; `prompt-headroom.mjs:249-254/558-565/567/570/576`;
`sibling-test-file/check.mjs:3/6-31/35-41`; `command-contract-shape/check.mjs:46-62`;
`atomic-write-contract/check.mjs:4/15/19`; `read-or-default-via-helper/check.mjs:36-48`.
`cli/commands/roots` has exactly **10** declared relations today, so the plan's 10 → 13 and its
"clear of the 23 tie" both hold.

Round-4's rejection of minor 13(c) re-checked and still correct: `mine.ts:130` is the doc comment,
`:131` `nConformRaw`, `:132` `nTotalRaw`.

## Closest calls that were checked and did NOT become findings

- **`HistoryState.cochange` is typed `unknown[]`** (`io/roots-history-store.ts:94`), so
  `history-store.test.ts:54`'s `{a,b,sup,conf}` fixture does **not** break when `CochangePair` gains
  `commitsA`/`commitsB` — the plan's fifteen-site enumeration is complete for that change.
- **The index's `forMarkers` pre-filter** (`pipeline.ts:94`) is not a missed gate: `forParsing`
  implies `forMarkers` (`parseExclusions ⊇ mergedExclusions`), so D6's six-gate projection is exact.
- **`couplingByFile` really is a 0-100 percentile** (`history-cochange.ts:294-296`,
  `computeFilePercentiles`), so D4's `/100` and its "absent ⇒ 0" reading are right.
- **`readFileOrDefault`'s ENOENT-only contract** made `read-or-default-via-helper` look like a trap
  for the new stores; the aspect's regex is `\breadFile\s*\(` and excludes `readFileSync`
  (`check.mjs:36-38`), so T1's parenthetical at `:1632-1636` is correct as written.
- **`e2e-public-surface` is not declared on `roots-basic`** — but it is inherited from
  `cli/tests/e2e`, so the plan's claim for the new e2e node stands (this is what MAJOR-1 turns on,
  in the opposite direction).
- **`appendToDebugLog` in an `src/io/*.ts` store** does not trip `atomic-write-contract`: the check
  collects names imported from `node:fs` (`check.mjs:21-22`), and `debug-log-writer.ts` is itself
  exempt (`:15`).
- **T8's three e2e legs** were re-derived end to end: S1 needs no back-dating (all eight logs are
  current-day, so the cross-session pass correctly skips them and the eight `ignored` rows come from
  T7's transition 2); the control's re-plant produces 5 + 3 = 8 resolved rows under eight distinct
  session keys; 4b(ii)'s two legs discriminate on presence/absence in an empty ledger with no clock
  override. All hold.
