# Increment 4 (R5) plan — adversarial review, round 17

**Target:** `planning/plugin/sp-plans/2026-08-22-increment-4-r5-verdict.md` (9 809 lines)
**Tree:** branch `claude/document-review-13yoty`, HEAD `648ee6c` (freeze `13a43a5`, plan fold-in `648ee6c`)

## VERDICT: 1 BLOCKING + 2 MAJOR + 3 MINOR

The blocking defect is **round 3's B1 re-created by round 16b's own fix**. D27 part 6 — added
one commit ago — requires `src/roots/index.ts` (a `cli/roots/engine` file) to **value**-re-export
seven symbols from four `cli/roots/speech` files. That is a `cli/roots/engine → cli/roots/speech`
edge, and it closes a `structural-cycle` with the `cli/roots/speech → cli/roots/engine` edge the
plan's own edge audit declares. The plan's edge audit says, in the same document, that
`cli/roots/engine` adds "**none new at all**" and that "nothing in `roots/engine` imports from
`roots/speech`". Both are false under part 6, and the increment goes red at T3.

Everything else about the landed surface held up under deep check. D27's ten parts are otherwise
accurate against `13a43a5`; the six drills, the 13-entry allowlist, the normalization and dynamic-import
handling, the cascade attachment, `index.ts`'s nine exports, `stores.ts`'s three-specifier `../`
surface, the design-lock parser mechanism, and the ESLint-vs-aspect disagreement are all exactly as
described. Every worked number I re-derived reproduces: six Δ rows, eight Wilson figures, T9's
completeness trio, both fixture sizings, criterion 8's margins, MR-12's cancellation, the five epoch
constants, the 1201 baseline (measured live: **1201 pairs, one tier, margins 657 / 660 / 849**), and
R5's own 41 new pairs. 82 MR ids, each defined exactly once, no collisions, no dangling
criterion/step references in any of the three classes.

---

## BLOCKING

### B1 — D27 part 6's facade growth creates the `cli/roots/engine ↔ cli/roots/speech` cycle the authorization section exists to prevent

**Plan sites.** D27 part 6 (`:2423-2444`, esp. `:2429-2436`); T3's Files (`:3484-3490`); T6's Files
(`:4778-4781`); T8's Files (`:5438-5440`); the edge audit's `cli/roots/speech` row (`:171`) and
`cli/roots/engine` row (`:172`); the authorization section's cycle derivation (`:143-160`).

**What the plan requires.** D27 part 6 (`:2428`): "**the task that lands an engine symbol a command
file imports also adds it to `index.ts` in that task's own graph ritual.** The whole list, so no task
has to derive it:" — and the list names, by task:

- **T3** — `evaluate`, `channelFilter`, `selectGoverningFact` (`verdict.ts`); `render` (`speech.ts`)
- **T6** — `applyBudgetsAndDedup`, `foldSession` (`session-state.ts`)
- **T8** — the aggregation entry point (`health.ts`)

All seven are **values**, not types. T3's Files repeats it verbatim (`:3484-3488`), T6's
(`:4778-4780`) and T8's (`:5438-5440`) likewise.

**Where those files live.** `src/roots/index.ts` is mapped by **`cli/roots/engine`** — landed, line
229 of `.yggdrasil/model/cli/roots/engine/yg-node.yaml`, verified at HEAD. `verdict.ts`, `speech.ts`,
`session-state.ts` and `health.ts` are mapped by **`cli/roots/speech`** — T1's node list (`:181-185`):
"mapping (from T3) **four** of the five new engine files: `verdict.ts`, `speech.ts`,
`session-state.ts`, `health.ts`."

**A value `export … from` creates a relation edge — first-hand, landed evidence from this exact
file.** `src/relations/extractors/typescript.ts:207-222` handles `export_statement`: it breaks out
only for a whole-statement `export type { … } from` and for an all-inline-type clause, then
`emit(specifierFromSource(node), node)`. And `src/roots/index.ts`'s own landed header comment says
so about itself:

> "an `export … from './stores.js'` here would create exactly the forbidden edge
> (`relation-undeclared-dependency` catches this for real: it fired on an earlier draft of this file
> that did re-export the store's surface)."

D27 part 5 repeats it (`:2413-2415`). So `export { evaluate } from './verdict.js'` in `index.ts`
creates `cli/roots/engine → cli/roots/speech` by exactly the mechanism that already fired once on
this file.

**The reverse edge is already planned.** Edge audit `:171`: `cli/roots/speech → cli/roots/engine`
(`isBooleanSurface` from `mine-stages.ts`), required by D7 (`:1266-1268`: "decided by the
**exported** `isBooleanSurface` … never by inspecting the alphabet's contents"). D27 part 6 (`:2438`)
confirms it is a real value import: "`isBooleanSurface` … is the edge audit's single
`cli/roots/speech → cli/roots/engine` import."

**Both outcomes are blocking, verified at source:**

- Leave the new edge undeclared ⇒ `relation-undeclared-dependency`, which is an always-error
  (`src/core/check-codes.ts:96`, and again in the carve-outs at `:251`), at T3's own gate.
- Declare it ⇒ `checkNoCycles` (`src/core/checks/relations.ts:72-123`) walks
  `uses`/`calls`/`extends`/`implements`, finds `engine → speech → engine`, and emits
  `structural-cycle` at `severity: 'error'`; it is in `STRUCTURAL_CODES`
  (`check-codes.ts:36`), the set whose doc says these "always block `yg check` regardless of
  verification state". `roots-engine.calls` includes `roots-engine`
  (`yg-architecture.yaml:759`), so the edge is *type*-legal — which is precisely why the failure
  lands as a cycle rather than as `relation-target-forbidden`.

This is the authorization section's own argument (`:143-160`), which rejects mapping `exemplars.ts`
to `roots/speech` for exactly this reason and concludes: "`roots/speech` has **one** outbound edge
(`→ cli/roots/engine`) and no back edge." Part 6 supplies the back edge, three tasks over.

**The plan contradicts itself in the same document.** Edge audit `:172`: "`cli/roots/engine`
(+ `exemplars.ts`, `extract-file.ts`) | **none new at all** … **So this node's `relations:` block is
not edited by this increment; only its `mapping:` grows.**" And `:171`'s back-edge column: "none —
nothing in `roots/engine` imports from `roots/speech`."

**T1 Step 1's safety net cannot catch it.** Step 1 (`:2777-2783`) runs `checkNoCycles` over the
design-locked nodes, and the plan says why that is not enough (`:216-221`): "it cannot verify edges
that only arrive at T2-T8, which is precisely why the table exists." The table is the thing that is
wrong.

**A second, independent inconsistency rides the same root cause** (raised separately as MAJOR-1
because it survives some fixes and not others): under part 6 the command files never import a
`cli/roots/speech` file at all, so the edges the audit lands for them are wrong in the other
direction.

**Concrete fixes** (any one closes it; the plan must pick one and reconcile the audit, the counts and
D27 parts 5/6 together):

- **(A) Break the one back edge — preferred, smallest blast radius.** Drop `verdict.ts`'s runtime
  import of `isBooleanSurface`; make boolean-ness a **fifth non-copy field** on `VerdictFact`
  (`isBoolean: boolean`), filled by the command layer's projection (D9 already fills four non-copies,
  `:1328-1337`) from `isBooleanSurface`, which then joins `index.ts`'s re-export list (D27 part 6's
  "three names deliberately NOT on that list", `:2437-2441`, drops to two). `cli/roots/speech` then
  has **zero** outbound runtime edges, `cli/roots/engine → cli/roots/speech` is acyclic, and D27
  part 5's one-seam rule survives intact. Costs: one projection field, one facade name, two
  edge-audit rows, and a re-pointing of D7's "never by inspecting the alphabet" sentence to say the
  test still runs — one layer out.
- **(B) Take the speech symbols out of the facade.** Both command files import `../roots/verdict.js`,
  `../roots/speech.js`, `../roots/session-state.js`, `../roots/health.js` by deep path — which is
  what the edge audit already declares for them. D27 part 5 then states a **third** seam
  (`cli/roots/speech` is its own public surface, for the same reason `stores.ts` is), and part 6's
  per-task list keeps only the `cli/roots/engine` symbols (`routePartition`, `surfacesForFile`,
  `resolveRolesForCheck`, `markKey`).
- **(C) Narrow the speech node.** Map `verdict.ts` and `speech.ts` into `cli/roots/engine` and leave
  only `session-state.ts`/`health.ts` in `cli/roots/speech` (neither imports anything from engine at
  runtime — `applyBudgetsAndDedup` takes `RootsConfig` as a parameter, `health.ts` takes supplied
  lookups). Back edge gone, facade rule intact. Costs the reviewability argument the speech node was
  created for (`:112-121`).

Whichever is taken, T1 Step 1's `checkNoCycles` run must be given the *post-T8* declared edge set to
reason over, not only the design-lock set, or the same class of defect recurs at the next node split.

---

## MAJOR

### M1 — the edge audit's command-layer `→ cli/roots/speech` edges contradict D27 part 6, and `cli/commands/roots`' "10 → 13" is 10 → 12

**Plan sites.** Edge audit `cli/commands/roots-check` row (`:175`) and `cli/commands/roots` row
(`:176`); D27 parts 5-6 (`:2409-2444`); T8's Files (`:5466-5468`).

The audit declares `cli/commands/roots-check → cli/roots/speech` and `cli/commands/roots →
cli/roots/speech`, and counts the latter node **10 → 13** relations (`:176`: "`→
cli/commands/roots-check` (the registrar call), `→ cli/roots/speech` (T8's aggregation call),
**`→ cli/io/roots-state`** … — **10 → 13 relations**"). Verified at HEAD: `cli/commands/roots`
declares exactly 10 targets today.

But D27 part 6 routes every engine symbol through `../roots/index.js`, and T8's Files says it in
those words (`:5466-5468`): "**Both of those symbols, and `surfacesForFile` for input 6, reach
`src/cli/roots.ts` through `../roots/index.js`** — the one engine seam (D27 part 5)." `index.ts` is
a `cli/roots/engine` file. So under part 6 neither command file names a `cli/roots/speech` specifier
at all, the `→ cli/roots/speech` edges are never created, and `cli/commands/roots` goes **10 → 12**.

This is not merely a stale number. The audit is billed as "the increment's single graph authority"
(`:213-215`), each task's graph ritual declares edges against it, and a moving count with no row is
what round 4's M6 was. Under fix (A) or (C) for B1 the two rows must be deleted and the count
corrected; under fix (B) they are right and the count stands — so the plan currently asserts both
halves of a fork it has not taken.

*(`cli/tests/unit/roots` 13 → 15 is unaffected and correct — tests are exempt from the facade rule
(D27 part 3, `:2361-2364`) and import `src/roots/verdict.ts` etc. by deep path. Verified: that node
declares 13 targets today, with `uses cli/roots/engine` at `:287` and `uses cli/roots/stores` at
`:288`, exactly as the plan cites.)*

### M2 — three landed descriptions enumerate a surface R5 grows, and no task owns the update

**Plan sites.** T1 Step 2's four-place edit (`:2804-2812`); D27 part 8 (`:2465-2475`); T1 Step 7
(`:2957-2965`).

T1 Step 2 requires editing "the aspect's `yg-aspect.yaml` description (which claims the allowlist
*is* the core's real surface, so it must stay literally true)" when the allowlist grows by
`io/debug-log-writer`. It fixes **one half** of that description's sentence and leaves the other half
to go false later, in three places — and the plan itself has twice given exactly this class its own
owner (T2's "sixteenth site" for `mine.ts:155-160`, `:3254-3261`; T3's obligation on
`cli/tests/support`'s enumerating description, `:3472-3483`).

1. **`.yggdrasil/aspects/roots-import-boundary/yg-aspect.yaml`'s description** hard-codes THE CORE as
   a literal seventeen-name list and asserts it is "**exactly the roots-engine and roots-store
   nodes' own mapped files**". R5 grows that set to 23 — `exemplars.ts` at T2, `extract-file.ts`
   plus the `cli/roots/speech` quartet at T3 (D27 part 2 says so in its own words, `:2343-2345`:
   "every new `src/roots/` file R5 adds is fenced the moment it is mapped"). From T2 onward the
   sentence names a set that is neither seventeen files nor those nodes' mapped files. This is the
   rule's own statement of what it binds, and `yg context` prints it verbatim to every agent working
   in that tree.
2. **`check.mjs`'s header comment** carries the same enumeration ("so in production `ctx.files` here
   is exactly those two nodes' own mapped files — THE CORE (binding, extract, … index)"). T1 Step 2
   already edits this file; nothing tells it to fix this paragraph.
3. **`cli/roots/engine`'s node description**, `:181-182` of its `yg-node.yaml`: "index.ts is the
   public facade: cli/roots.ts (**the only CLI-layer composer of engine + store**) now imports the
   names it actually consumes from here". D27 part 5 (`:2415-2417`) states plainly that R5 adds a
   second: "`src/cli/roots.ts` **and** `src/cli/roots-check.ts` are the **sanctioned composers of
   both**." The clause goes false at T3.

**Fix.** Give the three sites owners the way T2 and T3 already give theirs: T2's graph ritual updates
the aspect description and `check.mjs`'s header to state THE CORE as *the two nodes' mapped files*
rather than as a frozen name list (which also stops the list going stale at every future roots file);
T3's graph ritual softens `cli/roots/engine`'s "the only CLI-layer composer" to name both. Say it in
the Files blocks, not only in a step's prose, since the graph ritual bullet (`:612-627`) covers
mappings, relations, ceilings and log entries and is silent about descriptions — which is exactly why
round 13 had to write T3's obligation into its Files list.

---

## MINOR

### m1 — `io/node-parser.ts:218` is the function declaration; the guard D27 part 9 rests on is `:219`

**Plan sites.** D27 part 9 (`:2477-2482`), T1's Files (`:2553-2556`).

Measured at HEAD (this file is untouched by the freeze, so `a761dda` == HEAD and the anchor policy
does not cover it):

```
218  function parseMapping(rawMapping: unknown, filePath: string): string[] | undefined {
219    if (!rawMapping) return undefined;
...
228      throw new Error(`yg-node.yaml at ${filePath}: mapping array must not be empty`);
```

`:228` is exact. `:218` names the declaration, not the mechanism the decision turns on; and "The
mechanism that does work is **one line up**" (`:2480`) describes a nine-line gap. Round 16b lists
"the parser line that decides part 9" among what it verified against HEAD. Fix: `:219`, and drop
"one line up" (or make it "the function's first guard").

### m2 — "`stores.ts`'s stated no-`node:fs` shape" is not stated in `stores.ts`

**Plan sites.** D27 part 7 (`:2459-2461`), T1 Step 2 (`:2795-2796`).

D27 part 7 rejects one of its two alternatives with: "`appendFileSync` from `node:fs` … breaks
`stores.ts`'s **stated** no-`node:fs` shape". The landed file's header (`stores.ts:1-16`) states the
*engine/store* seam ("`roots-engine` files never import this module …") and says nothing about
`node:fs`. `roots-store` carries no `no-direct-fs` aspect either (`yg-architecture.yaml:767-770`:
`source-no-raw-control-chars` + `source-hygiene`), and `atomic-write-contract`'s glob
(`check.mjs:19`) does not bind the file — which the plan correctly says elsewhere. What is true is the
*observed* shape: `stores.ts`'s only builtin import is `node:path` (`:18`). The rejection is still
sound on the chokepoint-doctrine ground the same sentence gives; it just rests on an attribution the
file does not carry. Fix: "its observed no-`node:fs` shape (only `node:path` today)".

### m3 — T1 Step 2's fourth mandated edit site has nothing to edit

**Plan site.** T1 Step 2 (`:2804-2812`): "`ALLOWED_RESOLVED` … the inline list in that check's own
violation message, the aspect's `yg-aspect.yaml` description …, and the `errs census` row in
`.yggdrasil/aspects/README.md` — **all four together, or the description starts lying**."

Measured at HEAD: the `roots-import-boundary` row in `.yggdrasil/aspects/README.md` is a single line
(`:227`) about `errs: over` and the two scope limits (computed dynamic arguments; re-export
laundering). It **does not enumerate the allowlist** and contains no count. Adding
`io/debug-log-writer` makes nothing in it false, so an implementer told "all four together, or the
description starts lying" will hunt for text that does not exist — and the stated justification is
false of that one site. The other three are real and each genuinely goes stale. Fix: state it as
three edits, with the README row named as "re-read and confirm it still holds" rather than as a
mandated fourth edit.

---

## What was checked and held

Recorded so the verdict is auditable rather than asserted.

**D27 against the landed freeze (`13a43a5`), part by part.**
Part 1 — the aspect's `when: any_of[node.type = roots-engine, node.type = roots-store]`, `errs: over`,
`reviewer.type: deterministic`, `review_by: 2026-11-23`, and the 13-entry `ALLOWED_RESOLVED` all
verbatim; THE CORE is 17 files (16 mapped by `cli/roots/engine`, `stores.ts` by `cli/roots/stores`),
matching the directory listing exactly. `normalizeRelativeSpecifier` runs **before** classification;
the dynamic branch checks `import(...)`/`require(...)` with a statically-resolvable string or
no-substitution template and skips interpolated ones; type-only imports are not exempt; both scope
limits are recorded in the aspect description **and** in the README census. Part 2 — the attachment
is on `cli/roots` (`aspects: [roots-import-boundary]`, type `module`), and a live probe confirms the
cascade: `yg context --node cli/roots/engine` reports 16 aspects including
`roots-import-boundary` with "**Source: inherited from parent 'cli/roots'**"; neither leaf declares
an `aspects:` key. Part 3 — the `violates-type-only-import` drill is literally
`import type { RootsConfig } from '../model/graph.js'`; all six drills exist and are exactly the
cases D27 names. Part 4 — `src/roots/model.ts` declares `RootsConfig` (`:9`), `SeedEntry` (`:126`),
`LedgerEntry` (`:151`); `src/model/graph.ts:131` re-exports all three as a whole-statement
`export type … from '../roots/model.js'`; `cli/roots/stores`' former `uses: cli/model/graph` is
retired and its description says so; `cli/roots/engine` declares six relations, none of them
`cli/model/graph`. Part 5 — measured: `cli/roots.ts` imports **15** names from `../roots/stores.js`
and **9** from `../roots/index.js`, exactly as claimed. Part 6 — `index.ts` re-exports exactly the
nine names D27 enumerates. Part 9 — `parseMapping` returns `undefined` on an absent key and throws
unconditionally on an empty array (m1 aside); `sibling-test-file`'s `check.mjs:3-4` returns early on
`ctx.node.files[0]`; and the "no LLM pair" claim generalizes beyond the probe's `roots-engine` node —
every LLM aspect on `command` (`cli-command-contract`, `diagnostic-logging`) and on `test-suite`
(`test-deterministic`) is `per: file`, so all three mapping-less design locks are pair-free.
Part 10 — both maintainer items are accurately stated.

**The speech-quartet re-homing.** Every site is consistent: `./model.js` inside the fence
(authorization row `:81`, D1 `:785-799`, D6 `:1078`, D27 parts 3/4, T1's Files `:2539-2549` and its
interface-block comment `:2610-2616`), `../model/graph.js` for the four `src/io/` stores. The four
new stores are `persistence-adapter` with `uses: [types]` (`yg-architecture.yaml:208`), so the
specifier resolves to `cli/model/graph` and creates no io → roots edge — verified against the
extractor's specifier-text handling. The engine-side cross-node type imports (`verdict.ts` etc. →
`./model.js`) are whole-statement `import type` and create no edge either. No site missed.

**The `io/debug-log-writer` escalation.** Real, and the measurement is right: `stores.ts`'s whole
`../` surface at HEAD is `io/read-or-default` (`:20`), `io/hash` (`:21`), `io/atomic-write` (`:22`) —
no `debug-log-writer` — and `io/debug-log-writer` is not on the allowlist, so T1 as written is
refused at its own gate. `appendToDebugLog` is `appendFileSync(filePath, text, 'utf-8')` and nothing
else (`debug-log-writer.ts:7-9`); `atomic-write-contract` names it as its sanctioned exemption
(`check.mjs:15`) and does not bind `stores.ts` (`check.mjs:19`). The two rejected alternatives' costs
are accurate (m2 aside).

**The ESLint-vs-aspect note.** `GENERICITY_ALLOWED_IMPORT_PREFIXES` is at `eslint.config.js:107` and
does include `'src/model/'` — so `import type { SessionEvent } from '../model/graph.js'` passes lint,
`tsc` and plain `yg check`, and is refused only at `--approve --only-deterministic`. Exactly as D27
part 3 states. MR-42 is therefore observable, by the graph, in MR-4's shape.

**Worked numbers, all re-derived from the spec rather than from the plan.** Six Δ rows (2.807 /
3.700 / 3.7726 / 3.7726 at τ 4.5 / 5.358 / 0.737) with E.1's `log2(2·n_eff+1)` identity, E.6's 5.36
and E.2's 1.0-bit supremum. Eight Wilson figures at z = 1.96: n = 10 → 0.0567 / 0.2366 / 0.3968;
n = 8 → 0 exactly / 0.2152 / 0.3057 / 0.4093 (5/3 clears 0.3 by 0.0057). T9's trio: 9/9, 9/12 at the
inclusive boundary, 9/20 = 0.45 rejected. Criterion 8's margins (7 000 / 12 000, `worstMargin`
7 000; 62 000). MR-12's cancellation (the shared KT denominator cancels to `(n_e+½)/(n_v+½)`, so an
in-alphabet zero-count value prices identically to ⊥ — §9.3's own "numerically like ⊥ but NOT
novel"). All five epoch constants (1 767 225 600 / 1 768 435 200 / 1 775 001 600 / 1 768 348 800 /
1 774 915 200), and both boundary comparisons against the landed `releasedMarks`
(`stableDaysOf` exactly 90 clearing `releaseStableDays` 90 on `<`; `lastHumanCommitTs` exactly
`floor(Date.parse(date)/1000) + 14 × 86400` clearing `releaseMinDaysAfterMark` on `>=`), with both
one-day negatives failing as stated. The 1201 baseline **measured live**: `node
scripts/prompt-headroom.mjs` reports 1201 pairs across one tier, margins 657 / 660 / 849 on
`fill-det.test.ts` / `roles.test.ts` / `advise-nominations.ts` — byte-for-byte the plan's three.
R5's 41 = 6 + 4 + 2 + 29, each term verified against the aspect graph (`roots-engine` and
`persistence-adapter` and `test-suite` each bind exactly one `per: file` LLM aspect; `command` binds
two — `command-exit-codes` is deterministic); the 29 test files recount exactly from the Files blocks
(T1 5, T2 4, T3 5 + 1 support, T4 1, T5 2, T6 2, T7 3, T8 2, T9 2, T10 2). "The graph's 71st aspect"
is exact: 71 `yg-aspect.yaml` files, 49 top-level plus 22 under `portal/` and `reference/`.

**Landed-surface spot checks, all exact.** `yg-architecture.yaml`: roots-engine `when` `:742-748`,
aspects `:749-755`, `calls` `:759` / `uses` `:760`; roots-store relations `:774-777`; command aspects
`:49-57` and `calls` `:61`; command-support `when` `:68-74` and `calls` `:82`; test-suite `:418-431`
with no relation block. `config-parser.ts`: every one of D23's anchors, including the `:136` vs
`:135` distinction the plan calls out. `weights.ts` `:108-110` / `:250` / `:253` / `:256` /
`:267-269`. `roles.ts` `:149` / `:194` / `:335-339` / `:351-357` (five parameters) / `:363-369` /
`:803` / `:815-825` / `:871` / `:887` / `:904` / `:913-914` / `:978-985` / `:1030` / `:1054-1057`.
`repo-scanner.ts` `:21` / `:33` / `:99` / `:218` / `:229` / `:260-269` / `:305` / `:322-335` / `:339`.
`pipeline.ts` `:92` / `:96-100` / `:103` / `:104` / `:108-109` / `:111` / `:115-118`. `partitions.ts`
`:101-102` / `:127-137`. `check-codes.ts` `:36` / `:96`. `prompt-headroom.mjs` `:249-254` / `:452` /
`:455-456` / `:558-564` / `:565` / `:567` / `:570` / `:576`. `repo-check.sh:209`. `prompt.ts:179-181`.
`yg-config.yaml:9` and `:43`. The fan-out leaderboard `:69-80` with `cli/entry` at `:77-78`, and
`cli/entry` at 23 relations today. All fifteen T2 assertion sites, by value: seven `rootsVersion: 1`
(202/342/375/404/432/639/674), `cli-roots-basic.test.ts:73`, six exact-shape co-change `toEqual`s
(178/181/203/244/367/572), and `mine.test.ts:470` with its `:457` title. The three frozen
`roles.test.ts` `toEqual({ roleIndex: 0, ambiguous: false })` at `:162` / `:214` / `:230`. Live
aspect counts: `cli/commands/roots` **18**, `cli/io/stores` **16** — both exactly as claimed.
`repo-check.sh` has exactly 17 `run_step`s.

**One apparent gap, checked and dismissed.** D6's gate list (`:1204-1212`) reproduces "the loop's own
gates, **all six**" but the landed `parseAndExtractAll` also applies `filters.forMarkers` to the
walked set *before* the loop (`pipeline.ts:94`), which D6 never mentions. It is harmless:
`forMarkers = ¬mergedExclusions` and `forParsing = includes ∧ ¬(mergedExclusions ∪
TEST_PATTERN_EXCLUSIONS)` (`partitions.ts:135-136`), so `forParsing ⇒ forMarkers` and gate 0 subsumes
it. No finding.

**Anchor drift, checked and covered.** Several `cli/roots.ts` anchors (`:128-129`, `:403-409`,
`:491-510`, `:538-585`, `:551-556`, `:711-725`, `:99-113`) and the three
`cli/roots/engine/yg-node.yaml` relation anchors (`:173-174`, `:179-180`, `:185-186`) no longer
resolve at HEAD — the freeze shifted `cli/roots.ts` by +7 lines and grew the engine node yaml by 41.
Every one of them was **exact at `a761dda`**, which the Global constraints declare as the anchor tree
with an explicit re-locate-and-report instruction (`:649-650`). Recorded trade-off, not a finding.

**Cross-reference and MR validation, mechanical.** 82 live MR definitions, no duplicates, and every
`MR-*` referenced in the task body defined except `MR-32c`/`MR-32d` in their retirement notice —
exactly the plan's own claim. Qualified criterion references, qualified step references and bare
in-task `Step N` / `criterion N`, with wrapped-line joining: **zero dangling in all three classes**;
the only apparent hits are the documented `T8 Step 2a`/`2b` subsections.

---

## Closest calls that did *not* become findings

- **`errs: over` and the `aspect-review-overdue` horizon.** OQ4 raises the three-month `review_by`
  honestly and defaults to leaving it; no task touches it. Correctly handled.
- **The `--as` target's file-kind clause** (absent, or a regular file, nothing else) reads as an
  exception to T3 Step 8's totality rule until the "Second" consequence and the totality clause's own
  carve-out for `p` are read together. All three sites now cross-reference. Held.
- **The `null ⇒ gone` rule living inside `health.ts`** under `currentValue`'s three-state contract.
  Re-derived against R5-I4: the rule is pure logic over a parameter, so purity holds and leg (iv) is a
  genuinely distinct injected input. Held.
- **`debugWrite` inside a `deterministic` + `no-direct-fs` engine module** (D6 gates 1 and 5, R5-I15).
  Landed precedent is unambiguous — `history.ts`, `history-replay.ts` and `history-resume.ts` all call
  it, and `utils/debug-log` is on the fence's allowlist. Held.
