# roots — Full Prototype Report (emergent, total genericity, full history)

**Prototype:** `roots2.mjs` (790 lines, md5 `bc9eec11`, Node + the repo's tree-sitter WASM grammars). One script carries every v6 mechanism; its retired predecessors (`roots-probe.mjs`, `probe-emergent.mjs`, `roots-proto.mjs`) remain in the scratchpad as history. Commands closing the entire product loop:

| Command | What it does |
|---|---|
| `learn <repo> <model.json> [--fullhistory=<gitdir>]` | mines the field: 12 generic enumerators → roles → v5 MDL acceptance → gates → correlation dedup → vacuous filter → model (facts + medoids + sticky assignments + vocab + exemplars + trends + calibration + co-change + agentShare) |
| `check <repo> <model> <file> [--content --as --session --all]` | **the hook path**: verdict for one file's (post-edit) content vs the model → agent messages with Δ, evidence, exemplars; telemetry, compliance closure, health demotion, session dedup + budgets |
| `mutate-test <repo> <model>` | deep harness: plants real deviations into conforming exemplars, verifies detection; verifies silence on unmutated files; hermetic (no state pollution), operators anchored at the exemplar's line, call-injection placement validated by re-extraction |
| `export-aspect <repo> <model> <pi:fi> <outdir>` | **the Yggdrasil bridge**: converts a discovered fact into an enforced aspect — generated `yg-aspect.yaml` (prose + evidence) + standalone `check.mjs` with a **grandfathering ratchet** (pre-existing deviations pass, new ones fail CI) |
| `spectrum <repo> <model> <file> [--minbits --top]` | **solicited exploration**: the full convention lattice for one file — every cell of its contexts (roles → directories → package) with its continuous MDL score, deep-vocabulary re-enumeration (support floor 2, topK ×4), NORM/obs status vs the accepted model, per-file deviation flags; no acceptance cut — the threshold becomes a slider the asker holds. Measured: flask `tag.py` 2 885 cells / 633 rows at bits ≥ 0 vs 17 NORMs; immich `activity.table.ts` 4 493 / 900 vs 54 |
| `where <repo> <model> <query>` | **inverse query for cold-start**: "where do command handlers go?" → card with placement (member-directory histogram), the group's norms with evidence, exemplars to copy, historical co-change partners; lexical match over repo-native tokens, compact-map fallback (no RAG — the model is a small structured distillate, and the asking agent is itself the best semantic matcher). Measured: nest `guard` → `guard+CanActivate` (10 members, 100% extend `CanActivate`, path:line exemplars); flask `view` → view groups + `test_regression.py` co-change |
| `report · status · completeness · scan-pid` | field browsing, model health, co-change completeness hints, per-pid deviation scan |

Zero hardcoded semantics anywhere: language bindings are **derived from each grammar's `node-types.json`** (scope = node with `name`+`body`; imports/decorators/heritage by grammar-metadata regex + a lexical marker check), and the enumerators are name morphology, arity, node-type presence, statement sequences, return shape, callee/decorator vocabulary, path segments, normalized import specifiers, supertypes, depth-2 subtree shapes, local-variable morphology, and module-level facts. Messages are machine-verbalized per enumerator + real exemplars.

## Final mutation-harness sweep — 7 models, 2 languages, full histories included

| Model | detected | missed | falseFire | silence on conforming |
|---|---|---|---|---|
| nest (TS monorepo) | 23 | 0 | 0 | 38/38 |
| immich (TS+Py app) | 15 | 0 | 0 | 41/41 |
| typeorm (TS lib) | 11 | 0 | 0 | 16/16 |
| fastify (JS) | 2 | 0 | 0 | 4/4 |
| Yggdrasil (dogfood) | 3 | 0 | 0 | 7/7 |
| starlette-full (Py, **full history**) | 5 | 0 | 0 | 13/13 |
| flask-full (Py, **full history**) | 6 | 0 | 0 | 11/11 |
| **TOTAL** (final revision, locality lattice active) | **65** | **0** | **0** | **130/130** |

The earlier 93 % (40/43, 1 false fire) generation is superseded. Closing the gap surfaced **two genuine verdict-layer defects** (both now fixed and specified in v6) plus three harness-mechanics artifacts:

1. **Decorator binding over-match (real defect).** TypeScript's `type_annotation` node satisfies the generic `/decorator|annotation|attribute_list/` grammar-name rule, so a field's type (`queue: fastq.queueAsPromised<…>`) was mined as a decorator — spawning a spurious role convention *and* a spurious repo-wide absence fact. Fix: a candidate decoration must lexically start with `@` or `[` (holds for Python/TS decorators, Java/Kotlin annotations, C# attribute lists; never for type syntax). Effect: nest field 140→91 facts, every removed fact spurious.
2. **Missing specificity shadowing (real defect).** A repo-wide absence fact at 95 % share fired on every member of the role whose own fact expects presence at 100 % share. Fix: a role-level fact on a pid shadows the `_all` fact on the same pid for that role's members (the general convention yields to the specific one).
3. Harness mechanics (all three fixed): mutation operators now anchor at the exemplar's recorded line (a first-occurrence-in-file strip mutates someone else's decorator); call-injection placement is validated by re-extraction (ground truth for "inside the scope" is the extractor, not a brace heuristic); and the harness runs hermetically — its own re-checks were accumulating `ignored` telemetry closures and **demoted a 96 %-share fact mid-run** via health demotion, which also produced the once-per-session ignored-closure rule now in the spec.

## The full loop, verified end to end on roots2

- **Compliance loop (flask, final revision):** `extends JSONTag` stripped from a conforming class → one role-labeled WARN with Δ, evidence, exemplars and the locality-contrast line → agent "fixes" (original content restored) → re-check silent on that fact + telemetry `after:"complied"` + exactly one ledger mark (`src/flask/json/tag.py#type#TagTuple`).
- **Yggdrasil bridge (this repo):** discovered fact "files here do not import `~/source/cli/src/model/lock`" (share 0.927 — the lock-access boundary) → `export-aspect` → generated ratchet checker: **exit 0** on the clean tree (25 grandfathered), **exit 1 listing the exact planted file** when a violation is planted. Discovery → suggestion → conversion → deterministic keyless CI enforcement, all live.

## Pattern locality (subsystem-local defaults, owner-requested)

One repo is many subsystems, and a message must not universalize a local norm. The prototype now mines a **spatial context lattice** with the same MDL core, no new math:

- **Partition (package)** was already the top locality: files are checked only against their package's field, and the `_all` label now says so honestly — "package-wide (`server`)", never "repo-wide" unless the fact really comes from the repo-wide partition.
- **Directory contexts** below the partition: every ancestor directory holding ≥ 25 scopes of a kind (and fewer than the whole partition) is a candidate context; a fact is accepted there only if conditioning on the subtree pays its MDL cost **against the partition posterior** — same acceptance rule as roles, same index-cost control of multiple comparisons. Two pruning rules keep it honest: a dir fact restating the parent default that an accepted package-wide fact already covers is dropped (redundant refinement), and a deeper dir restating a kept shallower dir's default is dropped (nested refinement).
- **Specificity governance** at the verdict: for each property, the **most specific applicable context governs** — role or directory over package-wide, smallest evidence class wins; the shadowed general fact stays silent for that scope. An agent editing `server/src/schema/tables/` gets the local truth ("methods here are annotated with `@Table`, 64/67") even though package-wide the same property's default is *absence*; and the message appends the contrast line "*This is the local default of this directory — the wider package's norm differs here*", so the agent knows the claim's scope.

Measured on immich: the dir lattice self-discovered the subsystem map with zero configuration — `schema/` → `@Table` + `Column`/`sql-tools` imports (local default, package norm differs), `controllers/` → `@Controller` + `@Authenticated`, `dtos/` → `createZodDto` + zod import, `services/` → `@Injectable` + base-service import, SvelteKit's `+page` filename shape in `web/src/routes/`; on typeorm — `src/error/` → extends `TypeORMError` + `super()` call, `src/decorator/options/` → comment-first (documented options). Fact-count cost after pruning (final revision): immich 87 (36 dir), nest 66 (15), typeorm 103 (59 — per-database test suites genuinely differ), Yggdrasil 16 (10). On the Python repos the lattice surfaces **boundary facts**: starlette's `starlette/` (the library package) never uses `@pytest.fixture`/`@pytest.mark.anyio` and flask's `src/` never uses `@app.route` — the library/test and library/app boundaries, discovered spatially with no notion of "test" anywhere in the product. Harness after the change: still **0 missed / 0 false fires** on every model (65/65, 130/130 silence).

## Full history + multi-scale (the owner's vision, prototype-proven)

`learn --fullhistory` walks ALL commits (`--reverse --raw --no-abbrev -M`, no caps), parses every distinct historical blob exactly once (content-addressed cache, language by historical path extension), replays per-scope timelines through renames → scope-level lifecycle + value events (change signature includes decorators/supertypes/nameshape — a prototype-found defect class) → trends, cohort trends, nucleation, calibration inputs, co-change. Measured: flask 3 824 commits / 4 118 blobs / 119 s for the complete learn; starlette 1 617/2 422 ≈ 20–33 s; ~12 ms/blob steady. Scope-level lifecycle coverage 94–96 %. Pattern levels from statement shapes (docstring-first, type-hints-as-shape) through variables, methods, types, files, modules, roles, partitions — one MDL core.

## Language generality

The same script mined TS/TSX/JS/Python/Java/Go with **zero language-specific code**: Spring's annotation ontology (`@RequestParam` 0.91, `@ModelAttribute` 0.83, `@Pattern` 0.92) self-discovered on spring-petclinic; Go's `NewRouter` construction convention on chi; the Python detection caveat from the earlier operator generation is **retired** (starlette 5/5, flask 7/7, zero false fires).

## Incremental learning (commits land → model follows, measured)

The full-history walk now runs on a **persistent content-addressed blob cache** (each distinct blob parsed once *ever*, keyed by extractor version): flask-full cold = 4 118 blobs / 125 s history phase; warm = 4 118 cached / **0 parsed / 0 s**; a freshly landed commit costs **exactly its new blobs** (measured: 1 parsed, 0 s). Event replay and re-mining — the parts that always run — are seconds, so a post-commit/CI trigger can relearn automatically on every push. The model is **byte-identical across cache states** (run diagnostics live on stderr, not in the model), so automatic relearning is idempotent and model.json is diffable commit-to-commit — conventions being born and dying is literally visible in version control, which is what trends, cohorts and nucleation formalize.

## Adversarial verification rounds

The pair went through two independent verification passes beyond the harness. An adversarial spec↔prototype sync review found and fixed **31 spec defects** (overclaims, missing mechanisms, contradictions; the Sync Matrix grew to 73 rows) and reported **12 prototype defects**, of which every genuine correctness bug was then fixed and re-tested: the decorator attribution window (previous-sibling → body-start, replacing a one-sided row heuristic), scope ordinals ending same-name/overload key collisions across sticky roles, telemetry, ledger and lifecycle, a prototype-pollution hazard in the verdict math (`counts["constructor"]`), fail-open on the hook path, the clock pinned to the HEAD committer timestamp with wall-clock purged from the model (double-learn is now **byte-identical**, measured), support-ordered co-change capping, mining-only test-file exclusion, telemetry lines carrying expected/observed/Δ, weighted pre-bucketing in role clustering (identical feature bags can no longer be split by the sample cap), clone-aware ambiguity (two surviving clusters of the same latent role no longer silence their members), and a structural-absence τ tier (4.5) that killed measured "never contains an `if_statement`" spam while keeping vocabulary prohibitions.

## Where things stand

Spec v6 (`2026-08-17-yg-roots-v6-spec.md`) and `roots2.mjs` (md5 `bc9eec11`, 790 lines) are maintained as a synchronized pair: the spec's Appendix F Sync Matrix maps every mechanism to its prototype function with an honest MEASURED / SIMPLIFIED / SPEC-ONLY status and is stamped with the prototype revision it was verified against; Appendix H carries these measurements. The numbers above are from the final verified revision.

**Artifacts (session scratchpad):** `probe/roots2.mjs` · `models/*.json` (7 roots2-format models incl. two full-history) · `proto-aspects2/imp-source-cli-src-model-lock-false/` (generated ratchet aspect, runnable).
