# Increment 2 — Roots Mining Core (R1–R3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the roots convention-mining core — module foundations, storage, config,
binding derivation and enumeration for all 16 grammars, role induction and the full MDL
acceptance chain — dormant without config, additive to every existing surface, with golden
repositories for the six prototype-measured grammars plus a data-grammar golden as the
proof harness.

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
dictated shape below — two new node types plus one relation-allowlist addition
(`command` → the two new types); nothing beyond that shape is authorized. The standing invariants stay:
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
  ZERO runtime change from this increment — `yg check`/`yg context` output, exit codes,
  files written, cost: all identical. ONE carved exception, by design
  (`integration-design.md:145-149`): `yg init --upgrade` manages the roots
  gitignore/gitattributes scaffold lines unconditionally — inert entries for paths that
  do not exist yet. Task 1 pins runtime dormancy with a spawned test against a
  pre-captured golden (its Step 6 states the capture mechanics) and it is re-run in
  every later task.
- **One parser path.** Roots obtains parses ONLY through `ast/parser.ts` and grammars
  ONLY through `utils/language-registry.ts` (P6). No `Parser.init`, no `Language.load`,
  no extension→grammar table anywhere under `src/roots/`. The inherited
  `wasm-tree-lifecycle` aspect (attached at `model/cli/yg-node.yaml:5`, cascading to
  every descendant node — roots and its tests included) additionally forbids importing
  `parseFile` directly: use `withParsedFile` (or `getParser` where a held parser is
  genuinely needed) — read the aspect before writing parse code. The genericity lint
  (Task 2) enforces the import fence; until it lands, reviews enforce it.
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
  count or ordering moves, update title+assertion+narrative in the same commit); log-gating
  is widespread, NOT command-only — `log_required: true` sits on `command`, `engine`,
  `parser-adapter`, `persistence-adapter`, `ast-adapter`, `migration` and more, plus both
  new roots types, so whenever a task's diff touches a log-gated node's mapped files or
  mappings, add `yg log add --node <id>` with self-contained WHY prose (the check output
  names the nodes demanding one); `node source/cli/dist/bin.js check --approve` from repo
  root ends `PASS (1 warning)` (the user-gated aspect-review-overdue warning — NOT yours).
  The LLM-reviewed aspects on the new types (e.g. `deterministic`) are filled by that same
  `check --approve` through the keyless `claude-code` provider — expect the fill to take
  real minutes on roots-heavy tasks; that is the ritual working, not a hang.
- **Environment** (verified across two increments): every shell command doing npm/node
  network work starts with
  `cat /root/.ccr/ca-bundle.crt /etc/ssl/certs/ca-certificates.crt > /root/.ccr/node-ca-combined.crt && export NODE_EXTRA_CA_CERTS=/root/.ccr/node-ca-combined.crt`;
  7 chmod-simulation tests fail under root (container artifacts, never yours); NEVER `init`
  from a subdirectory; no `yg-secrets.yaml`, no `debug:` toggling, no `repo-check.sh`
  (controller gates), no commits (controller commits).
- **No CHANGELOG entry per task**; Task 8 closes the increment with ONE adopter-voiced
  entry under `## [Unreleased]` → `### Added`. (Reconciliation with AGENTS.md's
  "every change gets an entry as part of normal work": the increment is one adopter-visible
  change shipping as a unit on this branch — Tasks 1-7 are its internal, dormant stages,
  and per-task entries would be a work log, which the changelog rules forbid. The entry
  lands with the change's completion, before anything is releasable.)
- Line anchors are from the tree at ff71299 (later commits on this branch touch only
  planning files, so the anchors hold at HEAD); re-locate by quoted code, note drift.

---

### Task 1: Architecture design-lock, config seam, storage (R1 core)

**Files:**
- Modify: `.yggdrasil/yg-architecture.yaml` (two new node types + one allowlist edit —
  the maintainer-approved block in Step 1, nothing more)
- Create: `.yggdrasil/model/cli/roots/yg-node.yaml` + children `engine/`, `stores/` —
  BOTH land now: this task creates engine-classified source (`config.ts`), and an
  unmapped `src/roots/*.ts` file is a blocking `unmapped-files` code under
  `coverage.required: ["/"]`, so the engine node cannot wait for Task 3
- Create: `source/cli/src/roots/config.ts` (engine-side: `rootsConfigHash` only — see
  Step 3 for why parsing does NOT live here)
- Create: `source/cli/src/roots/stores.ts`
- Modify: `source/cli/src/model/graph.ts` (the `RootsConfig` type + an optional
  `roots?: RootsConfig` field on `YggConfig` — the exact seam `signals`/`events` ride,
  `graph.ts:63`/`:73`; this node is log-gated)
- Modify: `source/cli/src/io/config-parser.ts` (parse the `roots:` block INLINE beside
  `signals:`/`events:`)
- Modify: `source/cli/src/cli/init-scaffold.ts` (gitignore + gitattributes lines)
- Modify: `source/cli/tests/unit/cli/init-upgrade.test.ts` — it BYTE-PINS the managed
  lists (`:8-11` hard-codes the line constants; `:370` and `:440` assert the fully
  rendered `.gitattributes`/`.gitignore`); extend the pins to include the new lines,
  never weaken them
- Modify: `source/cli/src/templates/knowledge/configuration.ts` (its prose reproduces
  the gitignore list at `:315-333` and documents the config blocks) and
  `source/cli/src/templates/schemas/config.ts` (the schema doc gains the `roots:`
  block's keys — the `signals:`/`events:` entries at `:81`/`:85` are the precedent).
  Neither edit touches the digest gate: that gate regenerates from
  `templates/digest.ts`/`rules.ts` only, which this increment never edits.
- Test: `source/cli/tests/unit/roots/config.test.ts` (drives parsing through the public
  `parseConfig`), `source/cli/tests/unit/roots/stores.test.ts`
- Modify: graph mappings for the new test dir (Step 6)

**Interfaces:**
- Consumes: `config-parser.ts`'s per-block unknown-key rejection shape (`:231-249`
  signals, `:270-289` events) — the established error contract is `ConfigParseError`
  (`config-parser.ts:17`) carrying what/why/next fields, NOT `buildIssueMessage`; both
  precedent blocks carry the comment "No schema-version bump: an absent key changes
  nothing about how any existing config parses", which is exactly this block's
  situation too — no graph schema version bump; `init-scaffold.ts:29-33`
  (`GITATTRIBUTES_LINES`) and `:89-124` (`YGGDRASIL_GITIGNORE_LINES`);
  canonical-JSON/atomic-write precedents (`io/type-class-cache.ts:9-37` versioning,
  `io/atomic-write.ts`).
- Produces: `RootsConfig` (typed, spec §4.5 keys verbatim minus `version`/`daemon`,
  defaults applied at parse) as `YggConfig['roots']` (absent block ⇒ `undefined` ⇒
  dormant); `rootsConfigHash(config): string` (sha256 of the canonical-JSON of the
  parsed subtree — pure, engine-side); `stores.ts` exporting typed read/write for
  `model.json` (the I2a header field list is stated INLINE at
  `integration-design.md:139-142` — rootsVersion, headSha, lastIndexedSha, clock,
  bindingHash, configHash, seedsHash, decisionsHash, ledgerHash, dirtyHash,
  candidateCountLog2, rolesStale; R1-R3 fills what it computes and stores explicit
  nulls for the rest, honestly), `seeds.jsonl`, `decisions.jsonl`, `ledger.jsonl`, and
  the gitignored `.cache/`/`.state/` roots — every write canonical + atomic +
  schema-versioned (`rootsVersion`). Tasks 3-8 import these names.

- [ ] **Step 1: The approved architecture block.** The file's real per-type schema
  (verified at ff71299): single-line quoted `description:`; `enforce: strict`; `when:` as
  a MAPPING (`path:` or `all_of:` with `not:`/`content:` predicates — never a bare glob
  list); an `aspects:` list opening with the
  `- id: source-no-raw-control-chars` / `status: enforced` entry; `log_required:`;
  `parents: [module]`; `relations:` with `calls:`/`uses:`/`default: deny`. Overlap is
  resolved by DISJOINTNESS BY CONSTRUCTION, not precedence — peers carve each other out
  (see the `engine` type, `:86-115`, carving out the two `reviewer-dispatch` files with
  `not:` at `:98-99`, `reviewer-dispatch` itself at `:116-135`; and `command` vs
  `command-support`: the `content:` regex at `:46` vs its negation at `:76`). Append to
  `node_types:` exactly these two types:

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
      calls: [roots-engine, ast-adapter, persistence-adapter, utility]
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
      - atomic-write-contract
      - source-hygiene
    log_required: true
    parents: [module]
    relations:
      calls: [roots-engine, persistence-adapter, utility]
      uses: [types]
      default: deny
```

  Every aspect id above already exists (the six engine aspects are carried by the
  existing `engine` type; `atomic-write-contract` by `persistence-adapter` — verify each
  id resolves before committing). Note `deriveBinding`'s disk read does NOT live in
  engine (Task 3 puts the loader in the ast layer), so `no-direct-fs` holds; engine may
  still CALL persistence-adapter helpers for repo scanning, the same allowance the core
  `engine` type has. Plus exactly ONE ALLOWLIST EDIT to an existing type, inside the same
  approval: `command`'s `calls:` gains `roots-engine` and `roots-store` (the Task-8
  command composes them). NOTHING else in the file changes. Rationale worth keeping in
  the report: roots-engine deliberately has NO `formatter` edge — engine-layer code must
  not call `buildIssueMessage` (the `no-buildissuemessage-in-engine` rule on io/core/ast
  applies to this layer equally); engine returns structured data or throws typed errors,
  and the command formats. If the file's schema demands a field these blocks omit, or an
  aspect id fails to resolve, STOP and report rather than inventing values.

- [ ] **Step 2: The model subtree.** Create `model/cli/roots/yg-node.yaml` (umbrella,
  type matching the file's convention for structural parents — read `model/cli/yg-node.yaml`
  and siblings first) with children: `engine` (type `roots-engine`, mapping the R1-R3
  module files EXCEPT `stores.ts`) and `stores` (type `roots-store`, mapping `stores.ts`).
  The command node is NOT here: the Task-8 command file is `source/cli/src/cli/roots.ts`,
  which the existing `command` type classifies, and its node lands under the commands
  subtree (`model/cli/commands/` — read the siblings' convention) in Task 8. Note that
  forward plan in the umbrella's description. The `engine` node lands NOW with
  `config.ts` as its first mapped file (Tasks 3-6 extend its `mapping:` as each module
  file lands — a node mapping nonexistent files trips the graph loader, so every mapped
  file must exist at each task's end). Relations: declare only what the code actually
  imports as it lands (this task: stores→io edges for the io helpers `stores.ts` uses).
- [ ] **Step 3: Config seam.** Read spec §4.5 IN FULL (`v6-spec.md:141-206`). Parsing
  lives INLINE in `config-parser.ts` beside `signals:`/`events:` — NOT delegated to
  roots — because the established error contract is `ConfigParseError` (a parser-adapter
  export at `config-parser.ts:17`) and engine-layer code must call neither it nor
  `buildIssueMessage`; delegation would force an illegal edge in one direction or the
  other. The `RootsConfig` type (and defaults) declares in `model/graph.ts` (types
  layer, importable from both sides); `parseConfig` fills `config.roots` with the §4.5
  keys verbatim minus `version`/`daemon`, per-key defaults from the spec, unknown keys
  at ANY depth of the subtree → `ConfigParseError` in the established what/why/next
  shape. `src/roots/config.ts` holds only `rootsConfigHash` = sha256 of the
  canonical-JSON of the parsed subtree. Absent block ⇒ `config.roots === undefined` and
  NOTHING else in the CLI changes (no store reads, no directory creation).
- [ ] **Step 4: Stores.** Read design §4 IN FULL (`integration-design.md:122-165`).
  Implement `stores.ts`: layout exactly as §4 (committed `model.json` + `seeds.jsonl` +
  `decisions.jsonl` + `ledger.jsonl`; gitignored `.cache/`, `.state/`), the I2a model
  header (field list inline at `:139-142`), `rootsVersion` constant, reads tolerant of
  absent files (dormant/fresh repos), writes canonical+atomic. Extend `init-scaffold.ts`
  with EXACTLY the three `.gitattributes` lines design §4 states at `:145-149` — two
  `merge=union` entries plus the `linguist-generated` entry for `model.json` (they are
  not all `merge=union`; copy the design's lines, don't paraphrase) — and the
  `roots/.cache/`+`roots/.state/` gitignore lines (paths relative to `.yggdrasil/`, per
  the design's note) — through the existing managed-list machinery, never ad-hoc. Then
  true up every surface that byte-pins or reproduces those lists:
  `tests/unit/cli/init-upgrade.test.ts` and `templates/knowledge/configuration.ts`.
- [ ] **Step 5: Tests (TDD — write first, red, then implement).** `config.test.ts`
  drives everything through the PUBLIC `parseConfig` (real yg-config.yaml files in tmp
  dirs, matching how the signals/events behavior is tested): absent block →
  `config.roots` undefined; minimal block → defaults per spec; unknown key at top level
  AND nested → `ConfigParseError` with the established shape; `rootsConfigHash` stable
  across key order, changed by any value change. `stores.test.ts`: fresh-repo reads
  (absent files) → typed empties; write/read round-trip byte-stable across two writes
  (canonical); atomicity (temp-file pattern per the io precedent); header carries
  rootsVersion + decisionsHash. Real tmp-dir fixtures, no mocks.
- [ ] **Step 6: Dormancy pin + graph ritual + report.** The pin's mechanics: BEFORE
  changing anything, build the current binary and run `yg check` on a copy of an
  existing no-`roots:` fixture, capturing exit code + stdout; HARDCODE that capture into
  the test as the golden (a test cannot re-derive pre-increment output at run time —
  the golden is captured once, now, from the pre-change tree). The test then spawns the
  freshly built binary on the same fixture and asserts byte-identity with the golden.
  Lives in its own spawned test file (`tests/unit/roots/dormancy.test.ts` or per the
  tests tree's spawn convention — report the choice). Graph: map the new test dir (a
  new `model/cli/tests/unit/roots/` node — `model/cli/tests/unit/` holds per-area
  children, follow that convention); declare relations; log entries for every log-gated
  node the diff touched (`cli/io/parsers/config`, `cli/model/graph`, the new roots
  nodes — the check names them); run the guard suites (build first) + typecheck + lint
  + `check --approve`. Report anchor drift and any leaderboard-pin movement.

### Task 2: Test infrastructure — determinism, goldens harness, genericity lint

**Files:**
- Modify: `source/cli/tests/support/git-fixture.ts` (additive deterministic-history
  exports) and its model node `.yggdrasil/model/cli/tests/support/yg-node.yaml` (the
  node is named "Tests — Shared Git Fixtures" and its description ends "Both helpers
  import only Node builtins; nothing from `src/**`." — adding `roots-golden.ts` means
  the name/description must be trued up, keeping the no-`src/**` claim accurate)
- Create: `source/cli/tests/support/roots-golden.ts` (golden builder + bundle
  equivalence assert)
- Modify: `source/cli/eslint.config.js` (the genericity rule lives INLINE here — see
  Step 3 for why a separate `eslint-rules/` directory is a trap)
- Test: `source/cli/tests/unit/roots/genericity-lint.test.ts` (spawns the eslint CLI —
  imports nothing from `src/**` or the config, so it creates no graph edge)
- Test: extend `source/cli/tests/support/` coverage per the tests tree's convention

**Interfaces:**
- Consumes: `git-fixture.ts`'s ACTUAL exports — exactly `gitFixtureEnv` and
  `runGitFixture` (130 lines; there are no commit/init helpers to extend) — and its
  identity pinning (`FIXTURE_IDENTITY`, `:71-76`).
- Produces: NEW deterministic-history exports (`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`
  pinned per commit from a fixed epoch + per-commit increment, `TZ=UTC`,
  `-c init.defaultBranch=main`) — spec §20.2's named prerequisite;
  `buildGoldenRepo(spec): dir` + `assertGoldenBundleEquivalence(spec, bundlePath)`
  (design §13.2 / spec §20.2: goldens are committed as builder specs AND `git bundle`
  files, with a test asserting builder ⇒ bundle equivalence); a working genericity
  lint. Tasks 3-7 build on all three.

- [ ] **Step 1: Determinism exports.** Extend `git-fixture.ts` ADDITIVELY: new exported
  helpers (e.g. a deterministic env builder taking a commit index, layered on
  `gitFixtureEnv`) — the existing two exports' behavior stays byte-identical for every
  current caller; `TZ=UTC` goes only in the NEW deterministic env, never the shared
  block. Test: two builds of the same scripted history produce IDENTICAL commit SHAs
  (the real determinism proof).
- [ ] **Step 2: Golden harness — bundles, not directories.** A working golden repo
  cannot be committed as a plain directory (its `.git` would become a gitlink); the
  authorities are explicit that goldens ship as builder specs + `git bundle`s
  (spec §20.2 `v6-spec.md:715`, design §13.2 `integration-design.md:493`).
  `roots-golden.ts`: a golden spec = ordered commit list (author id, files map,
  message); `buildGoldenRepo` scripts it through the deterministic fixture;
  `assertGoldenBundleEquivalence` rebuilds from the spec, clones the committed bundle,
  and asserts head-SHA equality plus file-content equality. Committed artifacts live
  under `tests/fixtures/roots/golden/<name>/` as `<name>.bundle` + the builder spec
  beside it — the equivalence test is what keeps bundle and builder from drifting.
- [ ] **Step 3: Genericity lint — with proof it fires.** The repo's eslint config carries a
  documented failure precedent (`eslint.config.js:4-10`: a resolver-based architecture rule
  silently no-opped and was removed). The rule therefore must NOT depend on module
  RESOLUTION machinery — but real imports here are RELATIVE with `.js` extensions
  (`'../utils/language-registry.js'`, see `ast/parser.ts:7`), so matching raw specifier
  text against `src/...` prefixes would flag every legal import. The rule does pure
  string normalization instead: `path.posix.join(dirname(importing file), specifier)`
  for relative specifiers (no resolver, no filesystem), then checks the normalized
  repo-relative path against the allowlist: `src/roots/`, `src/ast/` (parser pool +
  the Task-3 node-types loader + `ast/types` re-exports), `src/utils/language-registry`,
  `src/io/`, `src/model/` (the `RootsConfig` type), `src/formatters/message-builder`,
  plus `node:` builtins. Everything else errors, as does any specifier matching
  `/tree-sitter|\.wasm/` — including `'web-tree-sitter'`: roots gets AST TYPES
  (`Tree`, nodes) via re-exports from `src/ast/types.ts`, never from the package
  (Task 3 adds the re-export if absent). Also error on per-language switch heuristics:
  a string literal matching `/^\.(ts|tsx|js|py|java|go|rs|cs|c|cpp|php|rb|kt)$/`
  outside the registry import. (This is deliberately NARROWER than design §6's "any
  identifier or string literal naming a programming language" — that heuristic
  false-positives on ordinary words; the narrowing is a conscious decision, stated in
  the rule's header comment. Design §6's second dogfood — a deterministic aspect on
  the roots node — is satisfied by the `roots-engine` TYPE carrying `deterministic`,
  which binds every node of that type.) The rule lives INLINE in `eslint.config.js`
  scoped to `src/roots/**` — a separate `eslint-rules/` directory would be unmapped
  by every architecture `when:` (a blocking coverage error needing an UNAUTHORIZED
  third architecture edit), unlinted by `"lint": "eslint src/ tests/"`, and imported
  by nothing precedented. THE PROOF: `genericity-lint.test.ts` SPAWNS the eslint CLI
  with `--stdin --stdin-filename source/cli/src/roots/virtual.ts --format json` (a
  virtual filename makes the flat-config scoping apply without writing into `src/`,
  and spawning means the test imports nothing — no graph edge): one clean source
  passes, one source with a banned import AND a banned extension literal reports
  BOTH — so a silent no-op regression fails red, the exact failure mode the config's
  note warns about.
- [ ] **Step 4: Guard suites + graph ritual + report** (as Task 1 Step 6; the lint join
  must leave `npm run lint` green on the whole existing tree).

### Task 3: Binding derivation + 16 grammar snapshots (R2a)

**Files:**
- Create: `source/cli/src/roots/binding.ts`
- Create: `source/cli/src/ast/node-types.ts` (the disk loader — ast-adapter-classified by
  the existing `when:`, so no architecture edit; roots-engine's `no-direct-fs` forbids the
  read living in `binding.ts` itself)
- Modify: `source/cli/src/ast/parser.ts` — its wasm-path resolution (`GRAMMAR_DIRS`
  `:16-19`, `resolveWasm` `:69`) is MODULE-PRIVATE today; export the minimal locator the
  loader needs (additive export, no behavior change)
- Modify: `source/cli/src/ast/types.ts` — add `export type` re-exports for the
  web-tree-sitter types roots needs (`Tree`, node types), if not already exported; roots
  never imports the package directly (Task 2's lint bans it)
- Modify: `.yggdrasil/model/cli/ast/runtime/yg-node.yaml` (`node-types.ts` joins its
  `mapping:` beside `parser.ts`/`parse-cache.ts`/`runner.ts`) — ast-adapter is
  log-gated, so this drift needs its `yg log add`
- Create: `source/cli/tests/fixtures/roots/bindings/<asset>.json` × 16
- Test: `source/cli/tests/unit/roots/binding.test.ts`
- Modify: `.yggdrasil/model/cli/roots/engine/yg-node.yaml` (`binding.ts` joins the
  existing engine node's `mapping:`; declare the ast/registry relations)

**Interfaces:**
- Consumes: `ast/parser.ts`; `language-registry.ts` (`LANGUAGES`,
  `getGrammarForExtension`); the shipped `dist/grammars/*.node-types.json` (16 pairs,
  verified present).
- Produces: `ast/node-types.ts` exporting `readNodeTypes(assetName)` — NAMESPACE
  DECISION, fixed here: binding derivation keys on the grammar ASSET name, not the
  registry id (design `integration-design.md:174-177`: registry ids `csharp`/`php` ship
  as `tree-sitter-c_sharp.wasm`/`tree-sitter-php_only.wasm`, and "binding derivation
  keys on the asset name"); the asset name derives from the registry entry's wasm
  filename, and the 16 committed snapshot fixtures are named `<asset>.json` (committed
  filenames cannot be cheaply renamed later — get this right now); `binding.ts`
  exporting PURE `deriveBinding(nodeTypes): RootsBinding` — the scope/import/decorator
  node-kind sets with the lexical `@`/`[` marker rule and the decoration attribution
  window `(loRow, bodyRow]` — per spec §6.2 (`v6-spec.md:228-247`) read IN FULL; the
  prototype's `bindingFor()` (`prototype-roots2.mjs:34-45`) and `extractScopes`' window
  logic (`:85-91`) are the semantics reference. Tasks 4-7 consume `RootsBinding`.

- [ ] **Step 1: TDD snapshots.** For each of the 16 grammars: derive the binding, write it
  to `tests/fixtures/roots/bindings/<asset>.json` (canonical JSON), and assert in
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
  (`prototype-roots2.mjs:85-87`'s stated purpose). Each case's comment states the RULE
  itself, self-contained — e.g. "TypeScript's type_annotation matches the decorator
  name regex; the lexical @/[ marker filters it" — never a bare reference to a planning
  doc or spec section number (the `self-contained-references` aspect bans exactly that
  shape).
- [ ] **Step 4: Graph (binding.ts joins the engine node's mapping; ast/registry
  relations declared; the ast-adapter log entry), guard suites, ritual, report.**

### Task 4: Extraction and enumeration (R2b)

**Files:**
- Create: `source/cli/src/roots/extract.ts`, `source/cli/src/roots/partitions.ts`,
  `source/cli/src/roots/enumerate.ts`
- Test: `source/cli/tests/unit/roots/extract.test.ts`, `partitions.test.ts`,
  `enumerate.test.ts`
- Modify: `.yggdrasil/model/cli/roots/engine/yg-node.yaml` (mapping + relations)

**Interfaces:**
- Consumes: `RootsBinding` (Task 3), parses via `withParsedFile`.
- Produces — THE PARSE SEAM, fixed here: extraction is PURE and SYNCHRONOUS over an
  already-parsed tree — `extractUnits(relPath, source, tree, binding): ScopeUnit[]` —
  and the async walk (list files, read, parse) belongs to the Task-6 pipeline (tests
  parse their snippets via `withParsedFile` directly). Extraction covers spec §6.3 IN
  FULL (`v6-spec.md:241-243`): one FILE scope per file and MODULE scopes, not just
  named-body scopes — the prototype does these inside `learn`
  (`prototype-roots2.mjs:409-423`), NOT inside `extractScopes`, so port from both
  sites. `partitions.ts` exports `derivePartitions(files): PartitionMap` per spec §6.8
  IN FULL (`v6-spec.md:267-274`: package-root detection, the 300-scope floor, `_repo`
  merge, the built-in exclusion list). Scope keys: ordinals computed DURING extraction
  (not post-hoc), `skeyR` keys, and `stable_id` =
  sha256hex(partitionId∥relPath∥kind∥qualifiedName∥arity)[:16] — the PRODUCTION scheme,
  spec §6.4 `v6-spec.md:245`, NOT the prototype's simple key. `enumerate.ts` exports
  `buildVocabularies(units, partitions)` (the §7.2 per-partition vocabulary builder —
  deterministic selection) and `enumerate(units, vocab): FeatureBag[]` — the twelve
  enumerators with relative-import normalization, per spec §7.1-7.2
  (`v6-spec.md:277-311`) read IN FULL; prototype `extractScopes` (`:70-120`) is the
  per-scope semantics reference. Tasks 5-7 consume all these shapes.

- [ ] **Step 1: TDD table-driven enumerator tests** — one table per enumerator (spec
  Appendix B rows are the source; read the appendix), real source snippets per measured
  grammar, exact expected feature bags; partition cases (package roots, the 300-scope
  floor, `_repo` merge) hand-built and hand-derived.
- [ ] **Step 2: Implement extract.ts + partitions.ts, then enumerate.ts** to the
  tables; ordinals/skeyR/stable_id everywhere a key leaves the module.
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
  (`v6-spec.md:314-362`) read IN FULL — INCLUDING §8.9(b) file-scope derived roles
  (`:357`), which design §12 lists as "specified but never built": it is THIS task's,
  implemented fresh from the spec text like role_lift. Prototype
  `induceRoles`/`assignAll` (`:135-173`) is the clustering semantics reference. Task 6
  consumes `RoleAssignment`.

- [ ] **Step 1: TDD** — clustering fixtures (hand-computable small bags: merge order,
  DL deltas, medoid selection), clone-ambiguity case, sticky case, and role_lift cases
  derived from the spec formula (state each expected value's derivation in a comment).
- [ ] **Step 2: Implement.** Weighted math exactly per spec; weight inputs arrive as a
  parameter (the R4 seam — a `WeightFn` interface with the R1-visible default of
  uniform weights; document the seam so R4 slots in without signature change).
- [ ] **Step 3: Graph, guard suites, ritual, report.**

### Task 6: Acceptance chain (R3b)

**Files:**
- Create: `source/cli/src/roots/mine.ts`, `source/cli/src/roots/pipeline.ts`
- Test: `source/cli/tests/unit/roots/mine.test.ts`, `pipeline.test.ts`
- Modify: `.yggdrasil/model/cli/roots/engine/yg-node.yaml` (mapping + relations)

**Interfaces:**
- Consumes: everything above.
- Produces: `mine(input): MinedModel` — the FULL acceptance chain, decomposed from the
  prototype's single `mine()` (`:175-251`) into named stages: KT/MDL vs parent posterior,
  index cost, fire-ability, **survived-raw ≥ 2/3 FAIL-CLOSED without history** (the
  inversion fix — an absent history/age source marks instances NOT survived), vacuous
  filter, two-tier absence τ (3.5 vocabulary / 4.5 structural), placement group-only,
  fallback buckets, locality lattice (dirMin 25, redundant + nested-refinement pruning),
  correlation dedup, seeds cap `seedCapFraction` (0.5) × n_eff_REAL (`:382` — the real
  count, not the effective sum), §9.4g stability days, §9.4h factCap 400. Spec §9 read
  IN FULL through §9.4 (`v6-spec.md:366-430`); §9.5-§9.11 (trends, drift, telemetry
  weighting) belong to LATER packages — out of R1-R3, consciously. The R3/R4 seam:
  `mine` takes the same `WeightFn` plus an optional `AgeFn` — absent AgeFn = the
  fail-closed branch, NOT a permissive default. Null-prototype/own-property reads on
  every mined-value map. ALSO: `pipeline.ts` exporting the async composition
  `runRootsIndex(repoRoot, config): MinedModel` — list files via the io scanner
  (persistence-adapter helpers; engine may call them, same as the core `engine` type),
  parse via `withParsedFile`, then extract → partitions → vocabularies → enumerate →
  roles → mine, all pure stages. This is what Task 7's goldens drive in-process and
  what the Task-8 command calls; it does NOT persist (the command composes
  `runRootsIndex` + `stores.ts`).

- [ ] **Step 1: TDD** — MDL math against spec Appendix E's WORKED SCENARIOS E.1-E.7
  (note: the appendix names a generator script `tests/fixtures/derive-e.ts` that does
  NOT exist in the tree — the scenarios' stated numbers are the source, each expected
  number's derivation restated in a comment); the fail-closed case (no AgeFn → zero
  survived → the fact is silent) as its own named test; tau tiers; lattice pruning
  cases; dedup; caps.
- [ ] **Step 2: Implement as named stage functions** composed by `mine` — each stage
  unit-testable, the composition itself tested end-to-end on a small synthetic corpus;
  then `pipeline.ts` over a real tmp-dir mini-repo.
- [ ] **Step 3: Graph, guard suites, ritual, report.**

### Task 7: Goldens for the six measured grammars + data + controls

**Files:**
- Create: `source/cli/tests/fixtures/roots/golden/{typescript,tsx,javascript,python,java,go,data}/`
  (each: a `git bundle` + its builder spec, per the Task-2 harness)
- Test: `source/cli/tests/unit/roots/golden.test.ts` — UNIT, decided here: the
  assertions read `MinedModel` shapes in-process through `runRootsIndex`, and the
  `e2e-public-surface` aspect on `cli/tests/e2e` forbids ANY `src/**` import (even
  `import type`), so `e2e/` is structurally unavailable for these assertions (the
  spawned-CLI proof is Task 8's)

**Interfaces:**
- Consumes: the Task-2 harness, `runRootsIndex` (Task 6).
- Produces: per-golden MUST-mine / MUST-NOT-mine assertion sets (design §13.2), the
  builder⇒bundle equivalence check per golden, the SEVENTH golden `data/` (mixed
  json/yaml/toml — design §5.4/§13.2's mandated data golden: empty scope sets flow
  through the whole pipeline without error and without inventing structural
  conventions), and three increment-wide controls:
  **null control** (shuffled-label null on every golden → 0 accepted role/locality
  conventions), **fail-closed control** (a golden with history stripped mines a field and
  accepts nothing history-gated), **determinism control** (double mine → byte-identical
  MinedModel; cache-state independence). Scope: the SIX prototype-measured code grammars
  plus the data golden ONLY (`plugin-marketplace-plan.md:260`) — the other seven code
  grammars' goldens are R9's, and this boundary is stated in the test file's header
  comment.

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
- Modify: `docs/` — one new adopter-facing page, which needs THREE mechanical joins,
  not just the file: the page joins `.yggdrasil/model/docs/guides/yg-node.yaml`'s
  `mapping:` (else unmapped-files), the VitePress sidebar
  (`docs/.vitepress/config.*`), and that docs node's description (it enumerates its
  pages by name)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the MINIMAL command surface R1-R3 needs and no more — exactly two
  commands, named by the DESIGN's vocabulary, not the prototype's: **`yg roots index`**
  (design §3, `integration-design.md:78`: "Naming uses Yggdrasil's vocabulary: index
  (like a build)" — the prototype's `learn` verb was explicitly rejected; spec §19's
  command list has `index [--full]`, and in R1-R3 every run is full, so the flag is
  accepted-and-ignored-free territory: implement plain `index`, note `--full` becomes
  meaningful with R4's incrementality) — runs `runRootsIndex` and persists via
  `stores.ts`; refuses with what/why/next when no `roots:` block — and
  **`yg roots status`** (reads the model, reports field/fact counts and dormancy
  honestly; NO `--exit-code` — that flag is a later package's single opt-in gate).
  Registration per `bin.ts` + `preamble.ts` patterns. The `command` type's aspects bind
  automatically (source-no-raw-control-chars, cli-command-contract,
  command-contract-shape, diagnostic-logging, command-error-via-buildissuemessage,
  sibling-test-file, source-hygiene) — read each before writing the handler, and
  satisfy them by construction, not retrofit. The node is log-gated — its `yg log add`
  entry is authored here (alongside any other log-gated node this task's diff touches).

- [ ] **Step 1: TDD spawned E2E** — on a Task-7 golden (cloned from its bundle):
  `yg roots index` exits 0 and writes a model whose header carries
  rootsVersion+configHash; `yg roots status` reports what `index` mined; both refuse
  gracefully (exit ≠ 0, what/why/next) without a `roots:` block; the dormancy pin from
  Task 1 re-run.
- [ ] **Step 2: Implement `cli/roots.ts` + registration + the sibling unit test.**
- [ ] **Step 3: Docs** — one adopter-facing page: what roots is (advisory convention
  mining), dormant-by-default, the two commands, the storage layout, what R1-R3 does NOT
  yet do (no speech, no hooks, no promotion — coming packages). Verify every behavior
  claim against the built binary. Wire the three mechanical joins (mapping, sidebar,
  node description). CHANGELOG: ONE `### Added` entry, adopter-voiced.
- [ ] **Step 4: Graph (command node + log entries), guard suites + the THREE progressive
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
