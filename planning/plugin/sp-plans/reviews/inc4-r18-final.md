# Increment 4 (R5) — Final plan review, round 18 (blockers-only bar)

**Target:** `planning/plugin/sp-plans/2026-08-22-increment-4-r5-verdict.md` (10 407 lines)
**Tree:** branch `claude/document-review-13yoty`, HEAD `9cda50e`
**Bar:** BLOCKING only for (a) a task consuming data/contracts no prior task or landed surface
produces; (b) a spec misreading green tests would not expose; (c) an acceptance criterion pinned to
an unreachable or wrong number; (d) a structural/graph violation baked into the design; (e) two
binding decisions in direct contradiction. Everything else is a non-blocking note.

---

## VERDICT: **LOCK — 0 blocking**

The plan is executable as written. Every focus area held under independent re-derivation from the
authorities and from the tree at HEAD, not from the plan's own prose.

### 1. Round 17's arithmetic simplification of Δ — re-derived, correct

D7 replaces `Δ = log2(p̂(expected)/p̂(observed))` with the cancelled form. Re-derived from §9.3
(`v6-spec.md:385`) rather than from D7: `p̂(v) = (n_v + ½)/(n_eff + K/2)` and
`p̂(⊥) = ½/(n_eff + K/2)`. **Both posteriors in the ratio are taken over the same fact, so the
denominator `n_eff + K/2` is literally the same expression in numerator and denominator and divides
out**, leaving `log2((n_e + ½)/(n_v + ½))` for an in-alphabet value and `log2((n_e + ½)/½) =
log2(2·n_e + 1)` for ⊥. That second form is Appendix E.1's own stated identity (`:905`, "clean-case
K-invariance — numerator and denominator share the same KT denominator"). The cancellation is
exact, not approximate, and holds at every `K` and every `n_eff`.

All six Δ rows of T3's acceptance table reproduce under **both** forms:

| Row | full form | cancelled form | value | τ | fires |
| --- | --- | --- | --- | --- | --- |
| bool `{true:3,false:0}`, obs `false` | `(3.5/4)/(0.5/4)` | `3.5/0.5` | `log2 7 = 2.8074` | 2.5 | yes ✓ |
| bool `{true:6,false:0}`, obs `false` | `(6.5/7)/(0.5/7)` | `6.5/0.5` | `log2 13 = 3.7004` | 2.5 | yes ✓ |
| absence `{false:20,true:1}`, obs `true` | `(20.5/22)/(1.5/22)` | `20.5/1.5` | `log2(41/3) = 3.7726` | 3.5 | yes ✓ |
| same fact, structural tier | idem | idem | 3.7726 | 4.5 | no ✓ |
| cat `\|V\|=4` (K=5), n=20, obs ⊥ | `(20.5/22.5)/(0.5/22.5)` | `20.5/0.5` | `log2 41 = 5.3576` | 2.5 | yes, WARN-capped ✓ |
| bool share 2/3 `{true:2,false:1}` | `(2.5/4)/(1.5/4)` | `2.5/1.5` | `log2(5/3) = 0.7370` | 2.5 | no ✓ |

Row 5 reproduces Appendix E.6's 5.36 (`:920`) exactly; row 1 reproduces E.1's `log2(2·n_eff+1)`
identity; row 6 sits under E.2's stated supremum of 1.0 bit at share 2/3 (`:907`). The two absence
tiers are read from the fact's own persisted `tau` (`isStructuralAbsenceSurface`,
`mine-stages.ts`), so rows 3 and 4 are two facts with identical counts and different `tau` — a
producible pair, not a contradiction.

**The graph consequence is real, not asserted.** With `K` numerically inert, `verdict.ts` needs
neither `n_eff` nor `K` nor `isBooleanSurface`; I walked all four `cli/roots/speech` files' declared
needs against the landed tree and **none of them requires a value import from any other node**:
`SessionEvent`/`TelemetryRecord`/`DemotionsFile`/`RootsConfig`/`LedgerEntry` come from
`./model.js` as whole-statement `import type` (dropped by `relations/extractors/typescript.ts:181`,
verified), `Finding`/`OpenIntervention`/`VerdictFact` are declared inside the node, and
`selectGoverningFact` is typed over a structural shape rather than over `MinedFact`. So
`relations: []` on `cli/roots/speech` is achievable, not aspirational.

### 2. The three-seam boundary vs the landed code and graph — holds

Verified at HEAD, item by item:

- `src/roots/index.ts` re-exports exactly **nine** names (`rootsConfigHash`, `runRootsIndex`,
  `computeUsedGrammarSetHash`, `isMinedModel`, `resolveWalkMode`, `isWindowingActive` + three
  types) and its own header states the store-re-export refusal ✓.
- `roots-engine.calls = [roots-engine, ast-adapter, persistence-adapter, utility]`,
  `uses: [types]` (`yg-architecture.yaml:759-760`) — **no `roots-store`**; `roots-store.calls =
  [persistence-adapter, utility]` (`:775-776`) — **no `roots-engine`**; `command.calls` carries both
  (`:61`) ✓. The store seam is architecturally forced, exactly as D27 part 5 says.
- `roots-import-boundary` is attached on the parent `cli/roots` node (`aspects: [roots-import-
  boundary]`, `relations: []`) with `when: any_of[node.type = roots-engine, node.type =
  roots-store]` ✓, so a `roots-engine`-typed `cli/roots/speech` child inherits it with no
  `aspects:` line ✓. `roots-engine`'s `when` is `source/cli/src/roots/*.ts` minus `stores.ts` minus
  `*.test.ts`, `enforce: strict` — all four speech files match, so they must be mapped by a
  `roots-engine`-typed node, which is what the new node is ✓.
- The allowlist is **13 entries** and `io/debug-log-writer` is **not** among them ✓; `stores.ts`'s
  whole `../` surface at HEAD is exactly `io/read-or-default`, `io/hash`, `io/atomic-write` ✓ — D27
  part 7's measurement is right, and T1's one pre-authorized entry is genuinely required. The four
  sites that must move together exist and carry what the plan says they carry: `ALLOWED_RESOLVED`
  (13 literals), the `THE ALLOWLIST` doc-comment above it ("13 specifiers"), the violation
  message's inline 13-name list, and the `yg-aspect.yaml` description (names + count). The `errs
  census` row (`README.md:227`) enumerates no specifier and carries no count ✓ — round 17's
  correction is right and the row genuinely does not move.
- **Acyclicity of the post-T8 edge set, checked row by row against `checkNoCycles`'s actual
  algorithm** (`core/checks/relations.ts:73-123` — declared `uses`/`calls`/`extends`/`implements`
  only, no parent/child collapsing, verified at source): `cli/roots/speech` has zero outbound edges
  and appears as a target only from `cli/commands/roots-check` and `cli/commands/roots`;
  `cli/roots/engine`'s `relations:` block is untouched (only its `mapping:` grows); no `io` node
  reaches a roots node; `cli/commands/roots → cli/commands/roots-check` has no return edge. The one
  shape that *looks* like a cycle — `cli/commands/roots-check` **uses** `cli/tests/unit/cli` while
  `cli/tests/unit/cli/roots` **calls** `cli/commands/roots-check` — is between different nodes and
  is the exact shape already landed and green for `cli/commands/roots` (`yg-node.yaml:40`) ↔
  `cli/tests/unit/cli/roots` (`:17`) ✓. **No cycle.**
- Relation counts re-measured, not trusted: `cli/commands/roots` declares exactly **10** targets
  today (10 → 13 ✓), `cli/tests/unit/roots` **13** (→ 15 ✓), `cli/tests/unit/cli/roots` **7**
  (→ 8 ✓). The fan-out leaderboard pins six paths at 32/25/24/23/23/23 with `cli/entry` in the
  23-tie ✓ — registering the new command from `cli/roots.ts` keeps it there.
- Frozen files: `roles.test.ts`, `fill-det.test.ts` and `advise-nominations.ts` are edited by no
  task; D4's route reaches `roles.ts` only as an import, and `buildRoleFeatureBag` /
  `roleJaccard` / `classifyAgainstMedoids` are all already exported ✓. **No frozen-file edit.**

### 3. Producer/consumer + branch-totality spot-sweep over the D13a complex — clean

Every field the plan's records declare has a producer that can construct it from that producer's
declared inputs, checked against the landed shapes: `TelemetryRecord.factKey` is reachable on both
paths (T6 from `Finding.fact.factKey`, T8 from `resolveFact`); `severity`/`deltaBits` ride the
`'warned'` event and `OpenIntervention` forward, so no closure recomputes a Δ that would be 0 on
the complied arm; the closure `sessionId` is `openedSessionId` on both paths, which is what makes
the store key collapse with the intervention row.

The three-row ceiling re-derived from the key alone: key = `(sessionId, stableId, surface,
observedAfter)` with `observedAfter ∈ {absent, 'complied', 'ignored'}` ⇒ **exactly three** rows per
`(sessionId, stableId, surface)`, and D26's four identity fields are functionally determined by
`stableId` (`stableIdOf(partitionId, relPath, kind, qualifiedName, arity)`, `extract.ts:627-628`,
verified) so none of them can mint a fourth ✓.

Branch totality on the two three-state values: `surfaceValue` and `currentValue.v` are both
`string | null`, and both producers write **nothing at all** for `null` (T7 transition 6, T8's
`null ⇒ gone`), differing only in the record's fate — which follows from live-vs-ended, not from
the branch ✓. `parentExp === null` is handled by both conjuncts of `localityContrast`
(`MinedFact.parentExp` is `string | null` and null for `_all`, `mine.ts:141-142`, verified) ✓.

**The reachable-pool arithmetic re-derived end to end for both e2e legs:**
- Demotion leg (S1): 8 sessions × (warn → intervention row; re-check → `'ignored'` closure, message
  suppressed by §11.3's dedup key since `direction` is unchanged) ⇒ 8 intervention rows (unresolved,
  excluded from the denominator) + 8 `ignored` rows (resolved) ⇒ n = 8, complied = 0,
  `WilsonLB95(0/8) = 0 < 0.3` ⇒ demote ✓. The 8 logs' mtimes are on the run's own UTC day, so T8's
  cross-session pass skips them and adds no ninth sample ✓.
- Control leg: re-plant before each session, 5 fix (transition 3, record removed) + 3 leave
  deviating (transition 2, record stays open) ⇒ 5 complied / 3 ignored, n = 8,
  `WilsonLB95(5/8) = 0.3057 > 0.3` ⇒ keep ✓, and the 3 open records are again skipped as
  same-day ✓.

### 4. Task-order dependency chain — every consumed shape produced earlier

Walked T1→T11. T3 (the first task with an adopter-visible flow) consumes only landed surfaces plus
T1's three record shapes, four stores, `appendLedgerMarks`, `snapshotContentHash` and three
design-lock nodes, and T2's `MinedFact.exemplars`, `partitionRouting`, `routePartition` (on the
facade) and `ROOTS_VERSION` 2. `openInterventions` and `demoted` arrive empty in T3 and are filled
by T7 and T8 with **data, not a new parameter** ✓. T6's `applyBudgetsAndDedup` needs
`Finding.skeyR`, declared at T3 ✓. T7's `markKey` facade re-export is the last facade growth ✓.
T8's six inputs plus two config numbers are all producible by `src/cli/roots.ts` from surfaces T1,
T2, T3 and T6 landed ✓. The e2e node `cli/tests/e2e/roots-verdict` is created mapping-less at T1 and
gets its first file at T2, before `unmapped-files` can fire ✓.

Three landed shapes I checked specifically because a gap there would have been class (a), and all
three are sufficient: `MinedRole` carries `label` **and** `medoidFeatures` (`mine.ts:163-171`), so
`resolveRolesForCheck`'s rung 2 can rebuild `RoleMedoid { set, ordered }` from the snapshot alone;
`RoleFeatureBag` exposes `ownFeatureCount` (`roles.ts:76-81`), so rung 0's `_untyped` gate is
buildable as an exact copy of the index's own (`roles.ts:822-826`); and `enumerate` returns
`{ bags, domains }` with `DomainMap = Map<surfaceId, Set<stableId>>`, which is exactly the pair
D6's surface-value read needs.

### 5. Acceptance-number spot-set — all re-derived

- **Six Δ rows** — table above ✓.
- **Eight Wilson figures** (z = 1.96 two-sided, `(p̂ + z²/2n − z·√(p̂q/n + z²/4n²))/(1 + z²/n)`):
  n = 8 → 0/8 **0** exactly (the `z·√(z²/4n²)` term is `z²/2n` and the numerator vanishes), 4/4
  **0.21521**, 5/3 **0.30574**, 6/2 **0.40927**; n = 10 → 2/8 **0.05668**, 5/5 **0.23659**, 7/3
  **0.39677**. All seven match the plan to four places, and the 5/3 boundary clears 0.3 by
  **0.00574** ✓. Appendix E.7's own floors re-derived as a cross-check: 12/12 → 0.7575, 15/15 →
  0.7961, 16/16 → 0.8064, and LB95 of a flawless record first reaches 0.9 at **n = 35** (0.90109;
  n = 34 gives 0.89848) ✓.
- **Five epoch constants** against the landed `weights.ts`: `2026-01-01` = 1 767 225 600,
  `2026-01-14` = 1 768 348 800, `2026-01-15` = 1 768 435 200, `2026-03-31` = 1 774 915 200,
  `2026-04-01` = 1 775 001 600 ✓. `stableDaysOf` = (1 775 001 600 − 1 767 225 600)/86 400 = **90**
  exactly, cleared on `<` (`weights.ts:108-110`, `:254`) ✓; one day earlier gives 89 ⇒ not released
  ✓; `threshold = floor(Date.parse('2026-01-01')/1000) + 14×86 400 = 1 768 435 200`, cleared on `>=`
  (`:258-259`) ✓; 1 768 348 800 ⇒ not released ✓. Both boundaries are exact-equality, which is what
  makes an off-by-one visible.
- **The 1201 baseline** — arithmetic re-derived rather than re-measured: `src/roots/model.ts` and
  `src/roots/index.ts` are both new files added by 13a43a5 and both mapped by `cli/roots/engine`
  (verified in its 16-file mapping), `roots-engine` binds exactly **one** LLM aspect
  (`deterministic`, `type: llm`, `per: file`; `source-hygiene` is an `aggregate`), and
  `roots-import-boundary/check.mjs` is a third `deterministic` subject under `graph-rules` ⇒
  1198 + 3 = **1201** ✓. R5's own **41** likewise checks out: 6 roots-engine × 1, 4
  persistence-adapter × 1 (`silent-missing-files` is the only `type: llm` among its five), 
  `roots-check.ts` × 2 (`cli-command-contract` and `diagnostic-logging` are both `type: llm`,
  `per: file`), and 29 `test-suite` files × 1 (`test-deterministic`; `self-contained-references` is
  deterministic) = 6 + 4 + 2 + 29 = **41** ✓, with the 28 test files recounted from the Files blocks
  (T1 5, T2 4, T3 5, T4 1, T5 2, T6 2, T7 3, T8 2, T9 2, T10 2) plus T3's `tests/support/` builder.
- **T9's completeness trio** re-derived from the landed row shape: `9/9 = 1.0 ≥ 0.75` names the
  test; `9/12 = 0.75 ≥ 0.75` (inclusive) names the source; `9/20 = 0.45 < 0.75` emits nothing on
  the test side while the source side still emits — and `conf = max(confAB, confBA) = 1.0` in all
  three, which is exactly why the persisted `conf` would have emitted all four ✓.
- **Prompt-margin predictions**: 72 000 − 55 569 − 1 182 − ~1 800 ≈ **13 449** for `mine.ts` and
  72 000 − 54 394 − 1 182 − ~1 800 ≈ **14 624** for `roles.ts`, both an order of magnitude above the
  2 000 STOP trigger ✓; `roots-check.ts`'s ceiling 72 000 − 3 124 − ~1 800 ≈ **67 K**, consistent
  with the plan's ≈66 KB ✓.

### 6. Scope discipline — nothing R6-R8 armed

No trend windows, no cohort trends, no nucleation detection (the `suppressedValue` skip lands
permanently inert because nothing sets the field), no calibration, no `τ_c` computation, no armed
DENY and no `permissionDecision` reachable from any real snapshot (`MinedFact.denyEligible` is the
literal type `false` at HEAD, verified — the projection's boolean widening is the whole indirection
and R6 flips one flag's source). No `where`, `spectrum`, `report`, `explain`, coverage/debt,
`status --exit-code` or campaign export. No `promote`, `seed`, `mute`, `reset`, `hooks install`. No
`rules.ts`/`digest.ts` edit, therefore no digest regeneration at the root or in any `examples/*/`.
The one Wilson use is §18.2's demotion, which the program plan assigns to R5 by name. The only
declared scope reduction is D11's dirty-file superset, recorded in NON-goals with its cost, its
owner and its permanence condition.

### Mechanical re-validation

- **MR ids: 82 live definitions, zero duplicates**, and every `MR-*` referenced anywhere in the
  document is defined **except** `MR-32c`/`MR-32d`, which appear only in their own retirement
  notice — matching R5-I11's "(82 ids at present)" exactly.
- **Cross-references: zero dangling** across qualified criterion refs and qualified/bare step refs,
  extracted per task and checked programmatically. The only apparent hits are the documented class
  `T8 Step 2a`/`2b` (Step 2's labelled `(a)`/`(b)` subsections). Counts confirmed unmoved: T1 9
  steps / 14 criteria; T3 10 steps / 16 numbered / 15 live criteria (9 retired in place); T6 9
  criteria; T7 8 criteria; the audit's 9 rows; D3's three added body fields; the six `--file`
  measuring sites.
- ~70 landed anchors spot-checked at HEAD, including every one this review's verdict turns on:
  `node-parser.ts:121/:218/:219/:228`, `typescript.ts:181/:207-222`, `mine.ts:130-132/:141-142/
  :155-160/:496/:542/:626/:1032/:1035`, `roles.ts:76-81/:149/:194/:335-339/:351-357/:913-914/
  :978-985/:1030`, `weights.ts:108-110/:250/:253/:256/:258-259/:267-269`,
  `partitions.ts:69/:101-102/:127-137/:237/:239-244/:257-275/:284/:291`,
  `extract.ts:100/:203-204/:607/:627-628/:675/:795-798`, `mine-stages.ts:221-222`,
  `git.ts:113-125`, `config-parser.ts` (every key D23 names),
  `init-scaffold.ts:143/:147`, `prompt-headroom.mjs:249-254/:452/:455-456/:564/:567/:570/:576`,
  `repo-check.sh:209`, `yg-config.yaml:9/:43`, and the six pinned fan-out counts.

**D5's module-root reconstruction re-derived case by case** against the landed line
`moduleRootDir = finalId === '_repo' ? '' : key === '_root' ? '' : key` (`partitions.ts:291`) with
`finalId = status === 'own-floor' ? key : '_repo'` (`:284`): merged ⇒ `''`; own-floor `_root` ⇒
`''`; root-level package (`key = ''`, `finalId = ''`) ⇒ `''` from both readings; every other
own-floor id ⇒ the matched `dir`. **`(id === '_repo' || id === '_root') ? '' : id` is exactly
equivalent** ✓, and `keyFor`'s three arms (`root === '' || relPath === root ||
relPath.startsWith(root + '/')`, `:239-244`) are reproduced verbatim by D5's lookup ✓.

---

## NON-BLOCKING NOTES

These ride into the execution-task briefs verbatim. None of them blocks the lock; each is something
a task implementer or reviewer should have in hand before writing the code.

1. **The `generic` channel's payload carries `newContent`, and T3 Step 8's per-source gate matrix
   has no row for it** — the matrix's third row ("Hook payload paths (`--hook`)") says the bytes
   come from the path and justifies that with `post`/`bash` only, while T5 Step 2 quotes §12.2's
   request shape `{files:[{path,newContent}], …}` verbatim; treat a payload entry carrying
   `newContent` as the matrix's `--content <p> --as <q>` row with `q` = its `path` (gate −1's
   file-kind test and gate 0 applied to `q`, containment resolved through `q`'s nearest existing
   ancestor, existence **not** required). *(T3 Step 8's gate matrix; T5 Steps 1 and 2.)*

2. **T3 Step 1's equivalence harness must be scoped to non-module units or it will fire T3's STOP
   spuriously** — both `finalizeUnits` (`extract.ts:690-712`) and `enumerate`
   (`enumerate.ts:245-249`) recompute `directFileCountByDir` from the units they are handed, so a
   single-file run legitimately resolves a different module directory and a different module-unit
   set than the whole-repo run, while every `method`/`type`/`file` unit is unaffected (`ScopeUnit`
   carries no module field, `extract.ts:199-207`). *(T3 Step 1; R5-I6.)*

3. **`MinedFact.counts` is `Record<string, string>` — canonical decimal strings — so D7's cancelled
   Δ needs an explicit parse**: `Δ = log2((Number(counts[expected] ?? '0') + 0.5) /
   (Number(counts[observed] ?? '0') + 0.5))`, where T3's acceptance table states its counts as
   numbers. *(D7; T3 Step 5; `mine.ts:128`.)*

4. **`selectGoverningFact`'s fact-side parameter must be typed over the wider `appliesKind`** —
   `MinedFact.appliesKind` is `ScopeKind | 'module'` (`mine.ts:125`) while `VerdictFact.appliesKind`
   is `'method' | 'type' | 'file'`, so the shared selector takes the wider union (a `VerdictFact` is
   assignable to it); the plan's "the four fields `MinedFact` and `VerdictFact` both carry" is true
   of the names, not of one of the types. *(T3 Step 3; D26.4; T8's Files input 5.)*

5. **The synthesized single-file `PartitionMap` must fill all six declared fields to typecheck** —
   D6 names only `partitionOfFile` and `moduleRootDirOfFile`, while the landed interface also
   declares `packageRoots`, `survivingPartitionIds`, `statusOfKey` and `silent`, none of which
   `finalizeUnits` reads and all of which are trivially fillable (`[]` / empty `Map` / `false`).
   *(D6; `partitions.ts:168-215`.)*

6. **The `'warned'` arm's "eleven payload fields" counts `ts`, which T1's own union block excludes
   from the term** — T6 Step 5 derives 8 − 1 + 4 = 11 with `ts` inside §18.1's eight, while T1
   scopes "payload field" to "every field beyond the two STRUCTURAL ones (`kind`, `ts`)"; the arm
   carries 11 fields beyond `kind` and 10 beyond `kind` and `ts`, and the growth-law argument is
   unaffected either way. *(T6 Step 5; T1's `SessionEvent` union block.)*

7. **T8's e2e demotion leg can pass for the wrong reason if the planted deviation moves the fact out
   of hook-eligibility** — the leg asserts "silence for that fact" after `index`, which is also the
   outcome if the re-mined fact drops below §9.4c's 2/3 survived-raw share or `mdl.minInstancesRaw`,
   so the fixture needs enough survived conformers that one planted deviant leaves it eligible (the
   same sizing discipline the non-demotion control already states for its one unreleased mark).
   *(T8's E2E coverage, the demotion leg.)*

8. **T3's Files block forward-references `../roots/session-state.js`, which T6 creates** — the
   three-seam sentence in `roots-check.ts`'s bullet lists all three speech modules, but at T3 only
   `../roots/verdict.js` and `../roots/speech.js` exist, and T3 declares only the edges it actually
   lands. *(T3's Files; the audit's `cli/commands/roots-check` row.)*

9. **Six anchors into `.yggdrasil/model/cli/roots/engine/yg-node.yaml` have drifted since a761dda**
   — the edge audit cites `:173-174` / `:179-180` / `:185-186` for `cli/io/stores` /
   `cli/ast/runtime` / `cli/language-registry`; measured at HEAD they are `:215-216` / `:219-220` /
   `:225-226`, while the facade clause (`:181`) and the `index.ts` mapping line (`:229`) are exact.
   *(The new-edge audit's `cli/roots/engine` row; T3's Files bullet for that node's description.)*

10. **`evaluateNoOpShortCircuit`'s anchor is `:545`, not `:538`** — measured at HEAD the function
    declaration is `src/cli/roots.ts:545` and `isNoOpShortCircuit` (whose eight-field comparison the
    plan quotes correctly, and which I verified compares exactly `headSha`, `clock`, `dirtyHash`,
    `configHash`, `seedsHash`, `decisionsHash`, `ledgerHash`, `bindingHash`) is `:498-510`.
    *(D3; D16.)*

11. **Three byte-size figures in Global constraints are 7-94 bytes stale after the boundary freeze**
    — measured at HEAD `mine.ts` is 55 569 (plan: 55 576), `roles.ts` 54 394 (54 401) and
    `src/cli/roots.ts` 40 736 (40 830); the predictions built on them (≈13 449 and ≈14 624, both far
    above the 2 000 STOP trigger) are unchanged, and `aspect-test.ts` 64 438,
    `deterministic/content.md` 1 182 and `cli-command-contract/content.md` 3 124 are exact.
    *(Global constraints' prompt-ceiling discipline; T2 Step 1.)*

12. **T1 Step 1(b)'s `relations: []` probe already has two landed precedents** —
    `.yggdrasil/model/cli/yg-node.yaml` and `.yggdrasil/model/cli/roots/yg-node.yaml` both carry an
    explicit `relations: []` and check clean at HEAD, so that half of the verification is a
    re-confirmation and only the mapping-less half is genuinely new (`parseMapping`'s
    `if (!rawMapping) return undefined;` at `io/node-parser.ts:219`, throw at `:228`, both verified).
    *(T1 Step 1(b); D27 part 9.)*

13. **`e2e-public-surface` is declared on `cli/tests/e2e`, which is both a mapped leaf and the
    parent** — the plan calls it "the PARENT node ... (`yg-node.yaml:5`)"; at HEAD that node's
    `aspects:` key is at `:5` with the aspect at `:6`, and the node also maps
    `cli-query.test.ts`, so inheritance to the new `roots-verdict` child (whose own `aspects:` list
    is empty, mirroring `roots-basic`'s) holds either way. *(T3 criterion 14b; the audit's e2e row.)*

14. **T1 Step 6's "whose type is `build-script` with `relations: []`" attributes the node's block to
    the type** — the `scripts` **node** carries `relations: []` (`yg-node.yaml:5`, with
    `scripts/*.mjs` mapped at `:8` exactly as cited) while the `build-script` **type** carries
    `relations: { default: deny }` (`yg-architecture.yaml:456-457`); same consequence, different
    object. *(T1 Step 6's "Graph cost: none".)*

---

## The single riskiest residual

Note 1 — the `generic` channel's supplied-bytes payload has no row in the gate matrix, so an
implementer following the matrix literally would evaluate the on-disk file instead of the payload's
`newContent`, and T5 criterion 1's recorded-fixture byte-exact assertion is written by that same
implementer and would not expose it. It is non-blocking only because `generic` has no live consumer
in R5 (no hook installer ships, the campaign oracle is R7's) and because T5 Step 2 quotes the
request shape verbatim two paragraphs away, which a DISTRUST reviewer reading both should catch.
