# Increment 2 — Roots Mining Core (R1–R3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the roots convention-mining core — module foundations, storage, config,
binding derivation and enumeration for all 16 grammars, role induction and the full MDL
acceptance chain — dormant without config, additive to every existing surface, with golden
repositories for the six prototype-measured grammars as the proof harness.

**Architecture:** A new `source/cli/src/roots/` module implementing the strategic plan's
R1–R3 packages (`planning/plugin/2026-08-17-plugin-marketplace-plan.md:44-73`) by porting
the verified prototype (`planning/roots/prototype-roots2.mjs`) into typed, decomposed
modules per the integration design's port plan (§12) — semantics frozen by the prototype's
measured harness wherever the design says "ports as-is", productionized exactly where §12's
SIMPLIFIED/SPEC-ONLY rows say so. The v6 spec (`planning/roots/2026-08-17-yg-roots-v6-spec.md`)
is the formula authority; the design (`planning/roots/2026-08-17-yg-roots-integration-design.md`)
is the integration authority; the grounding reference
(`planning/roots/2026-08-18-increment-2-grounding.md`) indexes both with verified seams.

**Tech Stack:** TypeScript, web-tree-sitter via the CLI's existing parser pool
(`source/cli/src/ast/parser.ts` — the prototype's standalone loader does NOT port), vitest,
spawned `dist/bin.js` E2E on real on-disk fixtures, golden git repositories with scripted
deterministic histories.

**Spec:** R1–R3 as quoted verbatim in the grounding reference §A; the v6 spec sections each
task names; design §12 (port plan) and §13 (testing law). The spec and design travel with
this plan — every implementer reads the sections their task cites IN FULL before writing
code; this plan dictates structure, seams, signatures and test shapes, and defers formulas
to the spec sections it cites rather than re-transcribing them (a transcription would be a
second copy that can drift; the spec is the committed single source).

## Maintainer authorization (recorded)

The architecture-graph change this increment requires — new node types in
`.yggdrasil/yg-architecture.yaml` and the `model/cli/roots/**` subtree, the v6 spec's I10
design-lock step — was **explicitly approved by the maintainer in this working session**
("Zatwierdzam zmiany jak są konieczne"). Task 1 executes that approval with the exact
dictated shape below — two new node types plus the two relation-allowlist additions the
new code paths require (`parser-adapter` → `roots-engine`; `command` → the two new
types); nothing beyond that shape is authorized. The standing invariants stay:
no `review_by` changes, no suppressions, and any FURTHER architecture edit beyond Task 1's
dictated block goes back to the maintainer.

## Global Constraints

- **Additive increment.** No existing CLI output changes byte-for-byte: the Increment-1
  guard suites (`build-context-brief.test.ts`, `build-context-progressive.test.ts`,
  `context-file-brief.test.ts`, `context-file.test.ts`, `context-file-type-coverage.test.ts`,
  `build-context.test.ts`) pass unchanged in every task, plus `cli-ast-languages.test.ts`
  (the parser-pool surface roots now shares). Build first (`cd source/cli && npm run build`)
  before any dist-spawning suite — a `describe.skipIf(!distExists)` skip is NOT a pass.
- **Dormant without config.** A project whose `yg-config.yaml` has no `roots:` block gets
  ZERO behavioral change from this increment — no new files, no new output, no new cost.
  Task 2 pins this with a spawned test on an existing fixture and it is re-run in every
  later task.
- **One parser path.** Roots obtains parsers ONLY through `ast/parser.ts`'s pool and
  grammars ONLY through `utils/language-registry.ts` (P6). No `Parser.init`, no
  `Language.load`, no extension→grammar table anywhere under `src/roots/`. The genericity
  lint (Task 2) enforces the import fence; until it lands, reviews enforce it.
- **No graph mutation from roots (I10).** Nothing under `src/roots/` creates or modifies
  graph nodes, aspects, or architecture. R1–R3 has no export path at all (promote is R8).
- **Fail-closed survived-raw.** Without history, an instance is NOT survived (the prototype
  inverts this — `ageFn ? ... : true` at `prototype-roots2.mjs:190` must NOT be ported
  as-is). A historyless repo mines a field and speaks nothing. Pinned by Task 7's
  fail-closed control.
- **Determinism.** Every store write is canonical-JSON (sorted keys) + atomic; every
  iteration over mined maps is sorted; content hashes fold inputs. Object reads from mined
  values use null-prototype or own-property guards (`constructor` is a real method name).
  Pinned by Task 7's double-build byte-identity control.
- **Coverage.** `src/roots/**` is NOT in vitest's coverage exclude list — every branch
  counts toward the ≥90% gate. Write measured in-process tests as you build, not after.
- **Graph ritual per task** (same as prior increments): new test files join their owning
  node's `mapping:`; new import edges between mapped nodes get declared relations — WATCH
  `max_direct_relations` ceilings and the fan-out leaderboard pin in
  `tests/integration/portal-derive-rest.test.ts` (currently `cli/tests/unit/cli/general`
  at 32/32; Task 1 creates NEW nodes whose relations may enter the ranking — if any pinned
  count or ordering moves, update title+assertion+narrative in the same commit); log-gated
  nodes (`command` type) need `yg log add` with self-contained WHY prose on source drift;
  `node source/cli/dist/bin.js check --approve` from repo root ends `PASS (1 warning)` (the
  user-gated aspect-review-overdue warning — NOT yours).
- **Environment** (verified across two increments): every shell command doing npm/node
  network work starts with
  `cat /root/.ccr/ca-bundle.crt /etc/ssl/certs/ca-certificates.crt > /root/.ccr/node-ca-combined.crt && export NODE_EXTRA_CA_CERTS=/root/.ccr/node-ca-combined.crt`;
  7 chmod-simulation tests fail under root (container artifacts, never yours); NEVER `init`
  from a subdirectory; no `yg-secrets.yaml`, no `debug:` toggling, no `repo-check.sh`
  (controller gates), no commits (controller commits).
- **No CHANGELOG entry per task**; Task 8 closes the increment with ONE adopter-voiced
  entry under `## [Unreleased]` → `### Added`.
- Line anchors are from the tree at ff71299; re-locate by quoted code, note drift.

---

### Task 1: Architecture design-lock, storage, and config (R1 core)

**Files:**
- Modify: `.yggdrasil/yg-architecture.yaml` (two new node types + two allowlist edits —
  the maintainer-approved block in Step 1, nothing more)
- Create: `.yggdrasil/model/cli/roots/yg-node.yaml` (+ children `engine/`, `stores/`
  per Step 2)
- Create: `source/cli/src/roots/stores.ts`
- Create: `source/cli/src/roots/config.ts`
- Modify: `source/cli/src/io/config-parser.ts` (delegate the `roots:` block)
- Modify: `source/cli/src/cli/init-scaffold.ts` (gitignore + gitattributes lines)
- Test: `source/cli/tests/unit/roots/stores.test.ts`, `source/cli/tests/unit/roots/config.test.ts`
- Modify: graph mappings for the new test dir (Step 6)

**Interfaces:**
- Consumes: `config-parser.ts`'s per-block unknown-key rejection shape (`:231-249` signals,
  `:270-289` events — copy the `buildIssueMessage` "unknown key under X:" form);
  `init-scaffold.ts:29-33` (`GITATTRIBUTES_LINES`) and `:74-110` (`YGGDRASIL_GITIGNORE_LINES`);
  canonical-JSON/atomic-write precedents (`io/type-class-cache.ts:9-37` versioning,
  `io/atomic-write.ts`).
- Produces: `RootsConfig` (typed, spec §4.5 keys minus `version`/`daemon`), exported
  `parseRootsBlock(raw, sourcePath): RootsConfig | undefined` (absent ⇒ undefined ⇒
  dormant), `rootsConfigHash(config): string` (subtree-scoped); `stores.ts` exporting
  typed read/write for `model.json` (I2a header incl. `decisionsHash`), `seeds.jsonl`,
  `decisions.jsonl`, `ledger.jsonl`, and the gitignored `.cache/`/`.state/` roots —
  every write canonical + atomic + schema-versioned (`rootsVersion`). Tasks 3-8 import
  these names.

- [ ] **Step 1: The approved architecture block.** The file's real per-type schema
  (verified at ff71299): single-line quoted `description:`; `enforce: strict`; `when:` as
  a MAPPING (`path:` or `all_of:` with `not:`/`content:` predicates — never a bare glob
  list); an `aspects:` list opening with the
  `- id: source-no-raw-control-chars` / `status: enforced` entry; `log_required:`;
  `parents: [module]`; `relations:` with `calls:`/`uses:`/`default: deny`. Overlap is
  resolved by DISJOINTNESS BY CONSTRUCTION, not precedence — peers carve each other out
  with `not:` (see `engine` vs `reviewer-dispatch` at `:160-176`, `command` vs
  `command-support` via the `content:` regex at `:40-65`). Append to `node_types:` exactly
  these two types:

```yaml
  roots-engine:
    description: "Roots mining engine — deterministic convention-mining computation: binding derivation from grammar node-types, scope extraction and enumeration, role induction, and MDL acceptance. Pure functions over parsed source and store-loaded state; parsers come only from the shared pool, grammars only from the language registry; never reads or writes the architecture graph — findings are advisory by construction."
    enforce: strict
    when:
      all_of:
        - path: "source/cli/src/roots/*.ts"
        - not:
            path: "source/cli/src/roots/stores.ts"
        - not:
            path: "**/*.test.ts"
    aspects:
      - id: source-no-raw-control-chars
        status: enforced
      - deterministic
      - no-direct-fs
      - no-direct-console
      - no-nondeterminism-direct
      - source-hygiene
    log_required: true
    parents: [module]
    relations:
      calls: [roots-engine, ast-adapter, utility, formatter]
      uses: [types]
      default: deny

  roots-store:
    description: "Roots store — persistence for the mined convention model: the committed snapshot and union-merged event logs under .yggdrasil/roots/, plus the gitignored derived caches beside them. Canonical-JSON, atomic, schema-versioned writes — the lock stores' discipline applied to mined state."
    enforce: strict
    when:
      path: "source/cli/src/roots/stores.ts"
    aspects:
      - id: source-no-raw-control-chars
        status: enforced
      - source-hygiene
    log_required: true
    parents: [module]
    relations:
      calls: [roots-engine, persistence-adapter, utility]
      uses: [types]
      default: deny
```

  All six engine aspects and both store aspects already exist (they are carried by the
  `engine`/`ast-adapter`/`utility` types — verify each id resolves before committing).
  Plus exactly two ALLOWLIST EDITS to existing types, both inside the same approval:
  `parser-adapter`'s `calls:` gains `roots-engine` (config-parser delegates the `roots:`
  block to `roots/config.ts`, Step 3), and `command`'s `calls:` gains `roots-engine` and
  `roots-store` (the Task-8 command composes them). NOTHING else in the file changes. If
  the file's schema demands a field these blocks omit, or an aspect id fails to resolve,
  STOP and report rather than inventing values.

- [ ] **Step 2: The model subtree.** Create `model/cli/roots/yg-node.yaml` (umbrella,
  type matching the file's convention for structural parents — read `model/cli/yg-node.yaml`
  and siblings first) with children: `engine` (type `roots-engine`, mapping the R1-R3
  module files EXCEPT `stores.ts`) and `stores` (type `roots-store`, mapping `stores.ts`).
  The command node is NOT here: the Task-8 command file is `source/cli/src/cli/roots.ts`,
  which the existing `command` type classifies, and its node lands under the commands
  subtree (`model/cli/commands/` — read the siblings' convention) in Task 8. Note that
  forward plan in the umbrella's description. Relations:
  declare only what the code actually imports as it lands (this task: stores→io edges if
  stores.ts imports io modules; engine node lands in Task 3 when its first file exists —
  a node mapping nonexistent files would trip the graph loader; verify and structure the
  subtree so every mapped file exists at each task's end).
- [ ] **Step 3: Config.** Read spec §4.5 IN FULL (`v6-spec.md:141-206`). Implement
  `config.ts` with the §4.5 keys verbatim minus `version`/`daemon`; per-key defaults from
  the spec; unknown keys anywhere in the subtree → `buildIssueMessage` hard error in the
  parser's established shape; `rootsConfigHash` = sha256 of the canonical-JSON of the
  parsed subtree. Wire into `config-parser.ts` beside `signals:`/`events:`. Absent block ⇒
  `parseRootsBlock` returns undefined and NOTHING else in the CLI changes (no store reads,
  no directory creation).
- [ ] **Step 4: Stores.** Read design §4 IN FULL (`integration-design.md:122-165`).
  Implement `stores.ts`: layout exactly as §4 (committed `model.json` + `seeds.jsonl` +
  `decisions.jsonl` + `ledger.jsonl`; gitignored `.cache/`, `.state/`), I2a model header
  (read its field list from the spec section §4 cites), `rootsVersion` constant, reads
  tolerant of absent files (dormant/fresh repos), writes canonical+atomic. Extend
  `init-scaffold.ts`: three `.gitattributes` lines (design §4's `merge=union` entries) and
  the `.cache/`/`.state/` gitignore lines — through the existing managed-list machinery,
  never ad-hoc.
- [ ] **Step 5: Tests (TDD — write first, red, then implement).** `config.test.ts`:
  absent block → undefined; minimal block → defaults per spec; unknown key at top level
  AND nested → the exact error shape; configHash stable across key order, changed by any
  value change. `stores.test.ts`: fresh-repo reads (absent files) → typed empties;
  write/read round-trip byte-stable across two writes (canonical); atomicity (temp-file
  pattern per the io precedent); header carries rootsVersion + decisionsHash. Real tmp-dir
  fixtures, no mocks.
- [ ] **Step 6: Dormancy pin + graph ritual + report.** One spawned test (in
  `config.test.ts` or its own file): `yg check` on a copied existing fixture WITHOUT a
  `roots:` block → exit code and stdout byte-identical to the same fixture before this
  increment (capture both in the test). Graph: map the new test dir (a new
  `model/cli/tests/unit/roots/` node or the convention the existing tests tree uses —
  read it); declare relations; run the guard suites (build first) + typecheck + lint +
  `check --approve`. Report anchor drift, the `when:`-precedence finding, and any
  leaderboard-pin movement.

### Task 2: Test infrastructure — determinism, goldens harness, genericity lint

**Files:**
- Modify: `source/cli/tests/support/git-fixture.ts` (determinism block)
- Create: `source/cli/tests/support/roots-golden.ts` (golden builder + equivalence assert)
- Create: `source/cli/eslint-rules/roots-genericity.js` (+ wiring in `eslint.config.js`)
- Test: `source/cli/tests/unit/roots/genericity-lint.test.ts`
- Test: extend `source/cli/tests/support/` coverage per the tests tree's convention

**Interfaces:**
- Consumes: `git-fixture.ts`'s existing isolation (`GIT_DIR`/identity pinning `:71-76`).
- Produces: deterministic-history fixtures (`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` pinned
  per commit, `TZ=UTC`, `-c init.defaultBranch=main`) — spec §20.2's named prerequisite;
  `buildGoldenRepo(spec): dir` + `assertGoldenEquivalence(builderDir, committedDir)`
  (design §13.2's fixture-equivalence: CI rebuilds each golden from its builder and asserts
  equality with the committed bundle); a working genericity lint. Tasks 3-7 build on all
  three.

- [ ] **Step 1: Determinism block.** Extend `git-fixture.ts` (additive — existing callers
  unchanged): every commit helper accepts/derives a deterministic date (a fixed epoch +
  per-commit increment), sets both `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE`, `TZ=UTC` in
  the env block, and `init` pins the default branch. Test: two builds of the same scripted
  history produce IDENTICAL commit SHAs (the real determinism proof).
- [ ] **Step 2: Golden harness.** `roots-golden.ts`: a golden spec = ordered list of
  commits (author id, files map, message); `buildGoldenRepo` scripts it through the
  deterministic fixture; `assertGoldenEquivalence` compares builder output against a
  committed golden directory file-by-file (content hash) and commit-by-commit (SHA).
  Committed goldens live under `tests/fixtures/roots/golden/<grammar>/` with their builder
  spec beside them — the equivalence test is what keeps bundle and builder from drifting.
- [ ] **Step 3: Genericity lint — with proof it fires.** The repo's eslint config carries a
  documented failure precedent (`eslint.config.js:4-10`: a resolver-based architecture rule
  silently no-opped and was removed). The lint therefore must NOT depend on import
  RESOLUTION — write a local flat-config rule operating on import SPECIFIER TEXT only:
  under `src/roots/**`, an `ImportDeclaration`/`ImportExpression` whose specifier matches
  `/(tree-sitter|\.wasm)/` or names a path outside `src/roots/`, `src/ast/` (the adapter
  layer — parser pool and the Task-3 node-types loader), `src/utils/language-registry`,
  `src/io/`, `src/formatters/message-builder`, or `node:` builtins → error (the graph's
  relation allowlists constrain finer than this; the lint is the cheap first fence); string/identifier heuristics for per-language switches (a literal
  matching `/^\.(ts|tsx|js|py|java|go|rs|cs|c|cpp|php|rb|kt)$/` outside the registry
  import) → error. Wire it in `eslint.config.js` scoped to `src/roots/**`. THE PROOF:
  `genericity-lint.test.ts` runs ESLint programmatically on two inline fixture sources —
  one clean (passes), one with a banned import AND a banned extension literal (BOTH
  reported) — so a silent no-op regression fails red, the exact failure mode the config's
  note warns about.
- [ ] **Step 4: Guard suites + graph ritual + report** (as Task 1 Step 6; the lint join
  must leave `npm run lint` green on the whole existing tree).

### Task 3: Binding derivation + 16 grammar snapshots (R2a)

**Files:**
- Create: `source/cli/src/roots/binding.ts`
- Create: `source/cli/src/ast/node-types.ts` (the disk loader — ast-adapter-classified by
  the existing `when:`, so no architecture edit; roots-engine's `no-direct-fs` forbids the
  read living in `binding.ts` itself)
- Create: `source/cli/tests/fixtures/roots/bindings/<grammar>.json` × 16
- Test: `source/cli/tests/unit/roots/binding.test.ts`
- Modify: `.yggdrasil/model/cli/roots/` (the `engine` node lands here — its first file)

**Interfaces:**
- Consumes: `ast/parser.ts` pool; `language-registry.ts` (`LANGUAGES`,
  `getGrammarForExtension`); the shipped `dist/grammars/*.node-types.json` (16 pairs,
  verified present).
- Produces: `ast/node-types.ts` exporting `readNodeTypes(grammarId)` (resolves the JSON
  beside the wasm exactly the way `parser.ts` locates grammars — reuse its path logic);
  `binding.ts` exporting PURE `deriveBinding(nodeTypes): RootsBinding` — the
  scope/import/decorator node-kind sets with the lexical `@`/`[` marker rule and the
  decoration attribution window `(loRow, bodyRow]` — per spec §6.2 (`v6-spec.md:228-247`)
  read IN FULL; the prototype's `bindingFor()` (`prototype-roots2.mjs:34-45`) and
  `extractScopes`' window logic (`:85-91`) are the semantics reference. Tasks 4-7 consume
  `RootsBinding`.

- [ ] **Step 1: TDD snapshots.** For each of the 16 grammars: derive the binding, write it
  to `tests/fixtures/roots/bindings/<grammar>.json` (canonical JSON), and assert in
  `binding.test.ts` that a fresh derivation equals the committed snapshot — the three data
  grammars (json/yaml/toml) assert an EMPTY scope set (that emptiness is the mechanism
  design §5.4 rests on, not an error). First run generates; committed snapshots then pin.
- [ ] **Step 2: Build assertion.** A test that every grammar the registry ships resolves a
  readable `node-types.json` beside its wasm in `dist/grammars/` — failing loudly if a
  future grammar joins without one.
- [ ] **Step 3: The marker rule, unit-level.** Table-driven cases for the lexical `@`/`[`
  marker and the attribution window on at least the six measured grammars' decorator kinds.
  Two regression cases are mandatory: (a) the decorator over-match the prototype's
  verification found as a real defect — TypeScript's `type_annotation` satisfies the name
  regex, so without the lexical marker a field's type was mined as a decorator
  (`2026-08-17-yg-roots-prototype-report.md:32`); (b) the attribution window — a stacked
  decorator above a PRECEDING member must not attach to the following scope
  (`prototype-roots2.mjs:85-87`'s stated purpose). Cite each case's source in a test
  comment by content, not by path.
- [ ] **Step 4: Graph (the `engine` node with binding.ts mapped + parser/registry
  relations declared), guard suites, ritual, report.**

### Task 4: Extraction and enumeration (R2b)

**Files:**
- Create: `source/cli/src/roots/extract.ts`, `source/cli/src/roots/enumerate.ts`
- Test: `source/cli/tests/unit/roots/extract.test.ts`, `enumerate.test.ts`

**Interfaces:**
- Consumes: `RootsBinding` (Task 3), the parser pool.
- Produces: `extractUnits(file, source, binding): ScopeUnit[]` (scope ordinals, `skeyR`
  keys, `stable_id` = sha256(partitionId∥relPath∥kind∥qualifiedName∥arity) — the
  PRODUCTION scheme, spec §6.4 `v6-spec.md:245`, NOT the prototype's simple key);
  `enumerate(units, vocab): FeatureBag[]` — the twelve enumerators with per-partition
  vocabularies (deterministic selection) and relative-import normalization, per spec §7.1-7.2
  (`v6-spec.md:277-311`) read IN FULL; prototype `extractScopes` (`:70-120`) is the
  semantics reference with ordinals computed DURING extraction (not post-hoc). Tasks 5-7
  consume both shapes.

- [ ] **Step 1: TDD table-driven enumerator tests** — one table per enumerator (spec
  Appendix B rows are the source; read the appendix), real source snippets per measured
  grammar, exact expected feature bags.
- [ ] **Step 2: Implement extract.ts then enumerate.ts** to the tables; ordinals/skeyR
  everywhere a key leaves the module.
- [ ] **Step 3: §7.3 tautology filter** (productionized here per R3's ownership note —
  implement it in enumerate.ts where candidate features are born, since its absence
  mis-sizes the repo-wide `C` count; spec §7.3 `v6-spec.md:306-308`).
- [ ] **Step 4: Graph, guard suites, ritual, report.**

### Task 5: Role induction (R3a)

**Files:**
- Create: `source/cli/src/roots/roles.ts`
- Test: `source/cli/tests/unit/roots/roles.test.ts`

**Interfaces:**
- Consumes: `FeatureBag`/`ScopeUnit` (Task 4).
- Produces: `induceRoles(units, weights): RoleAssignment` — pre-bucketed weighted
  clustering (Lance-Williams, weighted DL, weighted medoids), clone-aware ambiguity
  (`cloneMedoidJaccard >= 0.6` runner-up skip), sticky-role resolution, and REAL
  `role_lift` (held-out DL with overlap-group exclusion and decorative demotion — spec
  §8.10 `v6-spec.md:359-362`; NO reference implementation exists, the prototype's proxy
  at `:252-255` is explicitly not it — implement fresh from the formula and derive unit
  fixtures from the spec's own worked values where its appendix provides them). Spec §8
  (`v6-spec.md:314-362`) read IN FULL; prototype `induceRoles`/`assignAll` (`:135-173`)
  is the clustering semantics reference. Task 6 consumes `RoleAssignment`.

- [ ] **Step 1: TDD** — clustering fixtures (hand-computable small bags: merge order,
  DL deltas, medoid selection), clone-ambiguity case, sticky case, and role_lift cases
  derived from the spec formula (state each expected value's derivation in a comment).
- [ ] **Step 2: Implement.** Weighted math exactly per spec; weight inputs arrive as a
  parameter (the R4 seam — a `WeightFn` interface with the R1-visible default of
  uniform weights; document the seam so R4 slots in without signature change).
- [ ] **Step 3: Graph, guard suites, ritual, report.**

### Task 6: Acceptance chain (R3b)

**Files:**
- Create: `source/cli/src/roots/mine.ts`
- Test: `source/cli/tests/unit/roots/mine.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `mine(input): MinedModel` — the FULL acceptance chain, decomposed from the
  prototype's single `mine()` (`:176-251`) into named stages: KT/MDL vs parent posterior,
  index cost, fire-ability, **survived-raw ≥ 2/3 FAIL-CLOSED without history** (the
  inversion fix — an absent history/age source marks instances NOT survived), vacuous
  filter, two-tier absence τ (3.5 vocabulary / 4.5 structural), placement group-only,
  fallback buckets, locality lattice (dirMin 25, redundant + nested-refinement pruning),
  correlation dedup, seeds cap 0.5×n_eff, §9.4g stability days, §9.4h factCap. Spec §9
  (`v6-spec.md:365-430+`) read IN FULL. The R3/R4 seam: `mine` takes the same `WeightFn`
  plus an optional `AgeFn` — absent AgeFn = the fail-closed branch, NOT a permissive
  default. Null-prototype/own-property reads on every mined-value map.

- [ ] **Step 1: TDD** — MDL math against spec Appendix E's derived fixtures (read the
  appendix; each expected number's derivation in a comment); the fail-closed case (no
  AgeFn → zero survived → the fact is silent) as its own named test; tau tiers; lattice
  pruning cases; dedup; caps.
- [ ] **Step 2: Implement as named stage functions** composed by `mine` — each stage
  unit-testable, the composition itself tested end-to-end on a small synthetic corpus.
- [ ] **Step 3: Graph, guard suites, ritual, report.**

### Task 7: Goldens for the six measured grammars + controls

**Files:**
- Create: `source/cli/tests/fixtures/roots/golden/{typescript,tsx,javascript,python,java,go}/`
  (committed bundles + builder specs)
- Test: `source/cli/tests/unit/roots/golden.test.ts` (or e2e/ per convention — decide by
  what the assertions spawn; report the choice)

**Interfaces:**
- Consumes: the Task-2 harness, the full Task 3-6 pipeline.
- Produces: per-golden MUST-mine / MUST-NOT-mine assertion sets (design §13.2), the
  fixture-equivalence check per golden, and three increment-wide controls:
  **null control** (shuffled-label null on every golden → 0 accepted role/locality
  conventions), **fail-closed control** (a golden with history stripped mines a field and
  accepts nothing history-gated), **determinism control** (double mine → byte-identical
  MinedModel; cache-state independence). Scope: the SIX prototype-measured grammars ONLY
  (plan:260) — the other seven code grammars' goldens are R9's, and this boundary is
  stated in the test file's header comment.

- [ ] **Step 1:** Author each golden's builder spec (small, honest repos: enough scopes
  per role for the acceptance math to clear its own thresholds — derive minimum counts
  from the thresholds, don't guess; the prototype report's mined examples are the shape
  reference).
- [ ] **Step 2:** MUST/MUST-NOT assertions per golden + the three controls.
- [ ] **Step 3:** Graph, guard suites, ritual, report. If any golden FAILS to mine what
  the spec says it must, STOP — that is a product bug in Tasks 3-6, not a fixture bug.

### Task 8: CLI surface, docs, changelog (R1 close)

**Files:**
- Create: `source/cli/src/cli/roots.ts` (exports `registerRootsCommand` — the `content:`
  regex in the `command` type's `when:` is what classifies it; `src/roots/cli.ts` would
  orphan outside every type's `when:`)
- Modify: `source/cli/src/bin.ts` (registration)
- Create: the command's model node under `model/cli/commands/` (read the siblings'
  file/naming convention there first)
- Test: `source/cli/tests/e2e/cli-roots-basic.test.ts` (spawned) + the sibling unit test
  the `command` type's `sibling-test-file` aspect demands (read the aspect; match where
  existing commands keep theirs)
- Modify: `docs/` (one new page or section — match the docs tree's structure), `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the MINIMAL command surface R1-R3 needs and no more — read spec §19 and
  implement exactly two commands: `yg roots learn` (parse → extract → enumerate → roles →
  mine → persist model.json; refuses with what/why/next when no `roots:` block) and
  `yg roots status` (reads the model, reports field/fact counts and dormancy honestly;
  NO `--exit-code` — that flag is a later package's single opt-in gate). Registration per
  `bin.ts` + `preamble.ts` patterns. The `command` type's aspects bind automatically
  (cli-command-contract, command-contract-shape, diagnostic-logging,
  command-error-via-buildissuemessage, sibling-test-file, source-hygiene) — read each
  before writing the handler, and satisfy them by construction, not retrofit. The node is
  log-gated (`command` type) — first `yg log add` entry authored here.

- [ ] **Step 1: TDD spawned E2E** — on a Task-7 golden: `learn` exits 0 and writes a
  model whose header carries rootsVersion+configHash; `status` reports what `learn` mined;
  both refuse gracefully (exit ≠ 0, what/why/next) without a `roots:` block; the dormancy
  pin from Task 1 re-run.
- [ ] **Step 2: Implement `cli/roots.ts` + registration + the sibling unit test.**
- [ ] **Step 3: Docs** — one adopter-facing page: what roots is (advisory convention
  mining), dormant-by-default, the two commands, the storage layout, what R1-R3 does NOT
  yet do (no speech, no hooks, no promotion — coming packages). Verify every behavior
  claim against the built binary. CHANGELOG: ONE `### Added` entry, adopter-voiced.
- [ ] **Step 4: Graph (command node + log entry), guard suites + the THREE progressive
  E2E suites (unchanged behavior proof), markdownlint, docs build, ritual, report.**

---

## Execution notes (controller)

- Order strict T1→T8; T3-T6 are the port core and may NOT overlap (each consumes the
  previous task's landed shapes).
- Same SDD loop as prior increments: fresh Sonnet implementer per task, Opus task review,
  fix loop, controller-run gate, one commit per task, push. The plan-perfection criterion
  (two consecutive CLEAN reviews) applies to THIS DOCUMENT before execution.
- **Digest gate note:** R1-R3 does NOT edit `templates/rules.ts`/`digest.ts` (the roots
  section of the agent manual is a later package), so no digest regeneration sweep.
- **User-gated, standing:** `read-or-default-via-helper`'s overdue `review_by`; the 12:28
  log entry; the chmod skipIf question. Untouched by this increment.
- Spec-fidelity risk is the increment's biggest: every task's reviewer must verify the
  implementer actually read the cited spec sections (formulas match the spec, not the
  prototype's simplifications, wherever §12 lists a productionized row).
