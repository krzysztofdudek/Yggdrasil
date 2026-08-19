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

- **Additive increment.** No existing VERIFICATION-SURFACE output changes byte-for-byte
  (`yg check`/`yg context`/`yg build-context` — the guard suites prove it). The STATIC
  TEXT surfaces that change deliberately in Task 1 are exactly: the init-scaffold
  managed lists, the knowledge topic text (configuration, onboarding, cli-reference),
  the schema doc, and the docs pages `configuration.md` and `cli-reference.md` —
  and nowhere else before Task 8, which adds the adopter docs page and the changelog
  entry. The Increment-1
  guard suites (`tests/unit/cli/`: `build-context-brief.test.ts`,
  `build-context-progressive.test.ts`, `context-file-type-coverage.test.ts`,
  `build-context.test.ts`; `tests/unit/formatters/`: `context-file-brief.test.ts`,
  `context-file.test.ts`) pass unchanged in every task, plus `tests/e2e/cli-ast-languages.test.ts`
  (the parser-pool surface roots now shares — a dist-spawning suite, so build-first
  applies to it too). Build first (`cd source/cli && npm run build`)
  before any dist-spawning suite — a `describe.skipIf(!distExists)` skip is NOT a pass.
- **Dormant without config.** A project whose `yg-config.yaml` has no `roots:` block gets
  ZERO runtime change from this increment — `yg check`/`yg context` output, exit codes,
  files written, cost: all identical. The carved exceptions are the static surfaces the
  Additive-increment bullet names: `yg init --upgrade` manages the roots
  gitignore/gitattributes scaffold lines unconditionally, by design
  (`integration-design.md:164-165` states the propagation mechanism) — inert entries
  for paths that do not exist yet — and the knowledge/schema/docs text describes the
  new block for everyone. Task 1 pins runtime dormancy with a spawned test against a
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
  Pinned by Task 7's double-build byte-identity control. (Spec §20.2 also names a
  sorted-iteration LINT; this increment consciously substitutes the prose discipline
  above plus that byte-identity control — a mechanical sorted-iteration rule is not
  reliably writable without resolver machinery, the documented eslint failure mode.)
- **Coverage.** `src/roots/**` is NOT in vitest's coverage exclude list — every branch
  counts toward the ≥90% gate. Write measured in-process tests as you build, not after.
- **Graph ritual per task** (same as prior increments): new test files join their owning
  node's `mapping:`; new import edges between mapped nodes get declared relations — WATCH
  `max_direct_relations` ceilings and the fan-out leaderboard pin in
  `tests/integration/portal-derive-rest.test.ts` (currently `cli/tests/unit/cli/general`
  at 32/32 — and the pin is more than one row: the test pins five leaderboard paths and
  counts (32/25/24/23/23), a sixth value (`cli/commands/aspect-test` at exactly 20 with
  a `<23` bound), a descending-order invariant, the title, and a narrative comment, so
  any movement means updating the whole set coherently; Tasks 1 AND 8 create NEW nodes
  whose relations may enter the
  ranking — if any pinned count or ordering moves, update title+assertion+narrative in
  the same commit); log-gating
  is widespread, NOT command-only — `log_required: true` sits on `command`, `engine`,
  `parser-adapter`, `persistence-adapter`, `ast-adapter`, `migration` and more, plus both
  new roots types, so whenever a task's diff touches a log-gated node's mapped files or
  mappings, add `yg log add --node <id>` with self-contained WHY prose (the check output
  names the nodes demanding one); `node source/cli/dist/bin.js check --approve` from repo
  root ends `PASS (1 warning)` (the user-gated aspect-review-overdue warning — NOT yours).
  COMMENT DISCIPLINE, every task: the `self-contained-references` aspect binds to every
  new test node and to roots-engine via `source-hygiene` — its checker bans specific
  vague-reference shapes ("this task", "a later task", "the brief", step/task codes
  in test names); a spec-SECTION citation like "§16.2" is NOT banned and this plan's
  dictated comments use them — but the comment must still STATE the rule
  self-contained, with the citation as a pointer, never as the content. FILE-SIZE DISCIPLINE: roots-engine carries the per-file LLM
  `deterministic` review, and the reviewer prompt ceiling is `max_prompt_chars: 72000`
  (raised four times already for recurring large-file hot spots — the rules template
  and the check command; repo-check's headroom step reports the margin but never
  fails) — keep `mine.ts`/`enumerate.ts` comfortably under it by splitting stages into
  the module layout the tasks already dictate; and note `config-parser.ts` (already
  ~30k chars, per-file LLM-reviewed) grows by the whole §4.5 surface in Task 1 —
  headroom around config-parser itself is comfortable (~30k file + ~5k aspect
  prompt against the 72,000 ceiling), but the REPO-WIDE margin is tight: the
  measured largest assembled prompt is 71,343 chars — margin 657 — on
  `tests/unit/core/fill-det.test.ts`, which this increment does not touch; a breach
  anywhere is a BLOCKING check error, so run the gate's headroom step after every
  fat-file edit and split before you crowd it.
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
  `graph.ts:63`/`:73`; the `types` type is NOT log-gated, so no log entry for this one)
- Modify: `source/cli/src/io/config-parser.ts` (parse the `roots:` block INLINE beside
  `signals:`/`events:`)
- Modify: `source/cli/src/cli/init-scaffold.ts` (gitignore + gitattributes lines)
- Modify: `source/cli/tests/unit/cli/init-upgrade.test.ts` — it BYTE-PINS the managed
  lists (`:8-11` hard-codes the line constants; `:370` and `:440` assert the fully
  rendered `.gitattributes`/`.gitignore`); extend the pins to include the new lines,
  never weaken them
- Modify: `source/cli/src/templates/knowledge/configuration.ts` (its prose reproduces
  the gitignore list at `:315-333` and documents the config blocks),
  `source/cli/src/templates/knowledge/onboarding.ts` (`:329-332` lists the same
  entries), `docs/configuration.md` (`:355-365` gitignore table + the config-block
  sections), and `source/cli/src/templates/schemas/config.ts` (the schema doc gains the
  `roots:` block's keys — the `signals:`/`events:` entries at `:81`/`:85` are the
  precedent). None of these touches the digest gate: that gate regenerates from
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
  canonical-JSON/atomic-write precedents (`io/type-class-cache.ts:8-32` versioning (the const itself sits at `:32`),
  `io/atomic-write.ts`).
- Produces: `RootsConfig` (typed, spec §4.5 keys verbatim minus `version`/`daemon`,
  defaults applied at parse) as `YggConfig['roots']` (absent block ⇒ `undefined` ⇒
  dormant); `rootsConfigHash(config): string` (sha256 of the canonical-JSON of the
  parsed subtree — pure, engine-side); `stores.ts` exporting typed read/write for
  `model.json` (the I2a header field list is stated INLINE at
  `integration-design.md:140-142` — rootsVersion, headSha, lastIndexedSha, clock,
  bindingHash, configHash, seedsHash, decisionsHash (an integration-design ADDITION —
  spec `:137` and Appendix D's header omit it; the design is the integration
  authority, followed deliberately), ledgerHash, dirtyHash,
  candidateCountLog2, rolesStale; EVERY field has an assigned producer — this is the
  full ownership table, and Task 8's command assembles the header from it at persist
  time: `rootsVersion` = Task 1's constant; `configHash` = Task 1's `rootsConfigHash`;
  `seedsHash`/`decisionsHash`/`ledgerHash` = computed BY `stores.ts` itself (sha256 of
  each store file's canonical content, absent file = hash of empty — this is what Task
  1 Step 5's decisionsHash test exercises); `bindingHash` — Task 3's `binding.ts`
  produces the PER-GRAMMAR hash (design §6 assigns it there) and the HEADER value is
  the Task-6 pipeline's ALL-GRAMMAR fold of those (spec `:137` is the direct
  definition: "sha256 over the sorted derived binding sets of every grammar used";
  `:237` repeats it — the per-grammar hash is never written to the header
  directly);
  `candidateCountLog2` = Task 6's `mine` (spec §9.4a says it is recorded in the
  header) — both of these engine-produced values SURFACE to the command through the
  pipeline's `RootsIndexResult` return (Task 6 dictates it; the body alone cannot
  carry header fields); `headSha`, `clock` (HEAD committer timestamp, spec's clock
  rule — and the NON-GIT decision, stated: the new helpers fail SOFT to null,
  matching `utils/git.ts`'s existing fail-soft precedent, so a non-git repo still
  mines — R1-R3 needs no history — and its header carries null git fields as a
  recorded fact, not an error), and
  `dirtyHash` = the Task-8 COMMAND, via small ADDITIVE
  exported helpers Task 8 adds to `src/utils/git.ts` (utility layer — it has no
  HEAD-sha/timestamp getter today; hashing via the io helpers, which command legally
  calls), computed per the spec's ONLY definition of the field (`v6-spec.md:80`):
  dirty-file content hashes with **`.yggdrasil/roots/**` files EXCLUDED** — `index`
  itself writes those, so an unfiltered dirty list would make the header churn on
  every run; Task 8's double-index byte-identity assertion is what catches that;
  explicit null ONLY for `lastIndexedSha` in a git repo (R4 resume state; in the
  non-git case the git trio is also null, per the fail-soft clause above), and
  `rolesStale` is
  written as `false` — R1-R3 always fully re-induces, so `false` is knowable and
  honest where null would claim ignorance), `seeds.jsonl`,
  `decisions.jsonl`, `ledger.jsonl`, and
  the gitignored `.cache/`/`.state/` roots — every write canonical + atomic +
  schema-versioned (`rootsVersion`). THE MODEL-BODY SEAM, fixed here so no later task
  reopens this file: `stores.ts` owns `RootsModelHeader` (the I2a list above) and is
  GENERIC over the body — `writeModel(dir, header, body)` serializes any body
  canonically beside the header, `readModel(dir)` returns the header typed and the
  body as `unknown` for the caller to narrow. The body's concrete type (`MinedModel`)
  is declared in Task 6's `mine.ts` (engine-side, where it is produced), and Task 8
  composes the two — `stores.ts` is NOT touched after this task, so the log-gated
  `roots-store` node drifts only once. THE SEEDS SEAM, fixed here for the same reason:
  the record types of the jsonl stores that CROSS the engine boundary (`SeedEntry`,
  for seeds.jsonl) declare in `model/graph.ts` beside `RootsConfig` (types layer —
  both roots types have `uses: [types]`, so stores reads them typed and engine
  consumes them as values WITHOUT any engine→store edge); the prototype's pipeline
  reads seeds off disk itself (`learn` at `prototype-roots2.mjs:439`), which does NOT
  port — under the dictated allowlist engine cannot call the store, so seeds flow as
  an explicit PARAMETER: the Task-8 command loads them via `stores.ts` and passes
  them into the Task-6 pipeline. WHO IMPORTS WHAT: the command and tests import the
  store API; engine files NEVER import `stores.ts` — store-shaped values reach engine
  through parameters and shared types only.

- [ ] **Step 1: The approved architecture block.** The file's real per-type schema
  (verified at ff71299): single-line quoted `description:`; `enforce: strict`; `when:` as
  a MAPPING (`path:` or `all_of:` with `not:`/`content:` predicates — never a bare glob
  list); an `aspects:` list opening with the
  `- id: source-no-raw-control-chars` / `status: enforced` entry; `log_required:`;
  `parents: [module]`; `relations:` with `calls:`/`uses:`/`default: deny`. Overlap is
  resolved by DISJOINTNESS BY CONSTRUCTION, not precedence — peers carve each other out
  (see the `engine` type, `:86-115`, carving out the two `reviewer-dispatch` files with
  `not:` at `:98-99`, `reviewer-dispatch` itself at `:116-134`; and `command` vs
  `command-support`: the `content:` regex at `:48` vs its negation at `:74`). Append to
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
      - source-hygiene
    log_required: true
    parents: [module]
    relations:
      calls: [persistence-adapter, utility]
      uses: [types]
      default: deny
```

  ASPECT APPLICABILITY IS NOT ID RESOLUTION. Every aspect definition carries its own
  global `when:` predicate, and an attachment whose predicate fails is SILENTLY skipped
  (`src/model/when.ts:3-6` states the contract; no check code reports a
  never-applying attachment). That is why two seemingly-natural aspects are DELIBERATELY
  ABSENT above: `no-nondeterminism-direct` is type-scoped to
  engine/reviewer-dispatch/rule-script and its checker scans only `src/core/**` plus
  aspect `check.mjs` files, and
  `atomic-write-contract` is type-scoped to persistence-adapter with a checker gated to
  `src/io/*.ts` — on the new types both would advertise enforcement that never runs.
  Roots determinism is enforced by the LLM-reviewed `deterministic` aspect plus Task 7's
  determinism control; store discipline is pinned by Task 1 Step 5's tests. Before
  committing, read each DIRECTLY-LISTED remaining aspect's
  `.yggdrasil/aspects/<id>/yg-aspect.yaml` and verify its `when:` (if any) admits the
  new types — if one is type-scoped, STOP and report rather than shipping an inert
  attachment. (Direct attachments only: `deterministic` IMPLIES
  `no-nondeterminism-direct`, whose inertness here is already stated above and is
  accepted — an implied child failing its own `when:` is not a STOP.) Note
  `deriveBinding`'s disk read does
  NOT live in engine (Task 3 puts the loader in the ast layer), so `no-direct-fs` holds;
  engine may still CALL persistence-adapter helpers for repo scanning — the core
  `engine` type has that allowance, and `relations-adapter` is the even closer
  precedent: it carries `deterministic` while walking and parsing the whole repo. Plus exactly ONE ALLOWLIST EDIT to an existing type, inside the same
  approval: `command`'s `calls:` gains `roots-engine` and `roots-store` (the Task-8
  command composes them). NOTHING else in the file changes. Rationale worth keeping in
  the report: roots-engine deliberately has NO `formatter` edge — engine-layer code must
  not call `buildIssueMessage` (the `no-buildissuemessage-in-engine` rule on io/core/ast
  states the same PRINCIPLE — its checker is path-gated to those trees and inert on
  roots, so here the missing edge is the enforcement); engine returns structured data
  or throws typed errors,
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
  other. The `RootsConfig` TYPE declares in `model/graph.ts` (types layer, importable
  from both sides); the DEFAULTS const lives in `config-parser.ts` beside
  `DEFAULT_QUALITY`/`DEFAULT_COVERAGE` (`:23`/`:27` — that is where this repo keeps
  config defaults); `parseConfig` fills `config.roots` with the §4.5
  keys verbatim minus `version`/`daemon`, per-key defaults from the spec, unknown keys
  at ANY depth of the subtree → `ConfigParseError` in the established what/why/next
  shape. `src/roots/config.ts` holds only `rootsConfigHash` = sha256 of the
  canonical-JSON of the parsed subtree. Absent block ⇒ `config.roots === undefined` and
  NOTHING else in the CLI changes (no store reads, no directory creation).
- [ ] **Step 4: Stores.** Read design §4 IN FULL (`integration-design.md:122-165`).
  Implement `stores.ts`: layout exactly as §4 (committed `model.json` + `seeds.jsonl` +
  `decisions.jsonl` + `ledger.jsonl`; gitignored `.cache/`, `.state/`), the I2a model
  header (field list inline at `:140-142`), `rootsVersion` constant, reads tolerant of
  absent files (dormant/fresh repos), writes canonical+atomic. Extend `init-scaffold.ts`
  with EXACTLY the three `.gitattributes` lines design §4 states at `:146-150` — two
  `merge=union` entries plus the `linguist-generated` entry for `model.json` (they are
  not all `merge=union`; copy the design's lines, don't paraphrase) — and the
  `roots/.cache/`+`roots/.state/` gitignore lines (paths relative to `.yggdrasil/`, per
  the design's note) — through the existing managed-list machinery, never ad-hoc. Then
  true up EVERY surface that byte-pins or reproduces those lists — there are FOUR:
  `tests/unit/cli/init-upgrade.test.ts` (byte-pins), `templates/knowledge/configuration.ts`
  (`:315-333` prose list), `templates/knowledge/onboarding.ts` (`:329-332` lists the same
  entries), and `docs/configuration.md` — which needs MORE than its `:355-365`
  gitignore table: that page asserts the top-level key count in THREE places that all
  go false with an eleventh key ("Those ten are the whole of it" + the key list at
  `:38-39`, the warning box "the parser reads the ten keys above" at `:41-42`, and the
  `### Optional` bullet list at `:29-36`), plus the full annotated example at `:58` —
  update every one of them AND add the `roots:` block section, matching the
  `signals:`/`events:` sections' shape (`:483`/`:506`). NOTE the gitignore table at
  `:355-365` is ALREADY stale against `YGGDRASIL_GITIGNORE_LINES` (it omits `*.tmp`
  and drops the managed trailing `*` on two entries) — true up the whole table, and
  say so in the report so the fix does not read as new drift. The same completeness
  sweep applies to `templates/knowledge/configuration.ts`: its annotated example
  runs `:14-80` and the `signals:`/`events:`/`progressive:` precedent blocks a
  `roots:` block should copy sit at `:60-80` — plus the gitignore fenced list at
  `:322-331` inside the "Local state" section.
  NOTE: the knowledge gitignore list AND `onboarding.ts`'s copy are ALREADY stale in
  exactly the same two ways as the docs table (missing `*.tmp`, dropped trailing
  `*`) — true up all three copies to the source constant, not just the one being
  extended.
  Checked and DELIBERATELY left: that file's `:1` `summary` line lists example
  fields non-exhaustively (it already omits coverage/debug/signals/events), so an
  eleventh key does not falsify it.
  Checked-and-clear, so do NOT touch it: `tests/support/progressive-fixture.ts`'s
  `YGG_GITIGNORE` (`:264-272`) is a deliberately trimmed subset ("trimmed to the
  entries this fixture can actually produce") and no progressive test runs
  `init --upgrade`. Two `.gitattributes`-describing surfaces are ALREADY stale (they
  mention only the lock's `linguist-generated` line) and get staler with the roots
  lines — true them up in the same pass: `docs/cli-reference.md:1237-1238` and
  `templates/knowledge/cli-reference.ts:1001-1002`. Finally,
  keep this repo's own dogfood artifacts in sync: run the built binary's `init --upgrade`
  from repo root AND from each `examples/*/` that carries its own `.yggdrasil/` (all
  seven do), so the committed `.gitattributes`/`.yggdrasil/.gitignore` copies match the
  new managed lists. (This does not violate the "NEVER `init` from a subdirectory"
  rule — each example IS its own project root, the same allowance the digest gate's
  per-example sweep already uses.)
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
  freshly built binary on the same fixture and asserts byte-identity with the golden —
  `tests/e2e/cli-aspects-health.test.ts:134-138` (`DEFAULT_ASPECTS_GOLDEN`) is the
  existing precedent proving this pattern works and the output is byte-stable.
  Lives at `tests/unit/roots/dormancy.test.ts` — decided: the unit tree, mapped by
  this step's own `model/cli/tests/unit/roots/` node (spawning from a unit test is
  fine — the committed precedent is `tests/unit/bounty2/gitignore.test.ts:50`, which
  spawns `dist/bin.js` from the unit tree today; an `e2e/` home would need its own
  per-family e2e node for no benefit). Graph: map the new test FILES by name — the
  unit-tree convention is per-file `mapping:` entries, not directory globs (see
  `model/cli/tests/unit/cli/advise/yg-node.yaml`; only the fixtures node maps a
  directory) — on the new test node (a
  new `model/cli/tests/unit/roots/` node — `model/cli/tests/unit/` holds per-area
  children, follow that convention); declare relations; log entries for every log-gated
  node the diff touched (`cli/io/parsers/config` and the new roots nodes;
  `cli/model/graph` is type `types`, NOT log-gated — the check names the true set); run
  the guard suites (build first) + typecheck + lint
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
  imports nothing from `src/**` or the config, so it creates no graph edge; joins
  the Task-1 `model/cli/tests/unit/roots/` node's `mapping:` like every test here)
- Test: `source/cli/tests/unit/roots/git-fixture-determinism.test.ts` (Step 1 states
  its content; it joins the Task-1 `model/cli/tests/unit/roots/` node's `mapping:` —
  per-file, like every unit-test node)

**Interfaces:**
- Consumes: `git-fixture.ts`'s ACTUAL exports — `gitFixtureEnv`, `runGitFixture`, and
  the `RunGitFixtureOptions` type (130 lines; there are no commit/init helpers to
  extend) — and its identity pinning (`FIXTURE_IDENTITY`, `:71-76`).
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
  block. Test: `tests/unit/roots/git-fixture-determinism.test.ts` — the home is the
  Task-1 `model/cli/tests/unit/roots/` node (this IS roots test infrastructure, and
  there is no `tests/unit/support/` directory; the model node named
  `tests/unit/support` is a LOGICAL grouping with no `mapping:` of its own — do not
  try to map a file there): two builds of the same scripted history produce IDENTICAL
  commit SHAs (the real determinism proof).
- [ ] **Step 2: Golden harness — bundles, not directories.** A working golden repo
  cannot be committed as a plain directory (its `.git` would become a gitlink); the
  authorities are explicit that goldens ship as builder specs + `git bundle`s
  (spec §20.2 `v6-spec.md:713`, design §13.2 `integration-design.md:487-490`).
  `roots-golden.ts`: a golden spec = ordered commit list (author id, files map,
  message); `buildGoldenRepo` scripts it through the deterministic fixture;
  `assertGoldenBundleEquivalence` rebuilds from the spec, clones the committed bundle,
  and asserts head-SHA equality plus file-content equality. Committed artifacts live
  under `tests/fixtures/roots/golden/<name>/` as `<name>.bundle` (binary — add a
  `*.bundle binary` line to the repo `.gitattributes` in the same commit: `binary`
  = `-diff -merge -text`, and `-text` is the half that matters under the repo's
  `* text=auto eol=lf` first line; the existing binary precedent is `repos/** -text`) + the builder spec beside it — the equivalence test is what keeps bundle and builder from drifting.
- [ ] **Step 3: Genericity lint — with proof it fires.** The repo's eslint config carries a
  documented failure precedent (`eslint.config.js:4-10`: a resolver-based architecture rule
  silently no-opped and was removed). The rule therefore must NOT depend on module
  RESOLUTION machinery — but real imports here are RELATIVE with `.js` extensions
  (`'../utils/language-registry.js'`, see `ast/parser.ts:7`), so matching raw specifier
  text against `src/...` prefixes would flag every legal import. The rule does pure
  string normalization instead: `path.posix.join(dirname(importing file), specifier)`
  for relative specifiers (no resolver, no filesystem), then checks the normalized
  repo-relative path against the allowlist: `src/roots/`, `src/ast/` (parser pool +
  the Task-3 node-types loader + `ast/types` re-exports), `src/utils/` (COARSE, on
  purpose: the graph's `utility` edge is the fine fence, and roots code NEEDS more
  than the registry — `source-hygiene`'s implied `no-direct-minimatch` child MANDATES
  `utils/mapping-path.js`'s `globMatch` for §6.8's exclusion globs, and the POSIX
  path helpers live there too), `src/io/` (same coarse/fine split — engine may call persistence-adapter
  helpers but not the `*-parser.ts` files typed parser-adapter), `src/model/` (the
  `RootsConfig` type), plus `node:` builtins — NO `src/formatters/` entry: the graph
  gives roots-engine no formatter edge, and the lint must not be permissive where the
  graph is restrictive. (That is a DELIBERATE departure from the design §6 preamble's
  import allowance at `integration-design.md:223-225`, which listed
  `formatters/message-builder.ts` among roots' permitted imports — an allowance that
  predates the inline-config-parsing decision that removed roots' only
  message-building need. The `:252` mandate that CLI-facing errors go through
  `buildIssueMessage` still holds — it is honored by the Task-8 COMMAND, which formats
  what the engine returns as structured data.) Everything else errors, as does any
  specifier matching
  `/tree-sitter|\.wasm/` — including `'web-tree-sitter'`: roots gets AST TYPES
  (`Tree`, nodes) via re-exports from `src/ast/types.ts`, never from the package
  (Task 3 adds the re-export if absent). Also error on per-language switch heuristics:
  a string literal matching `/^\.(ts|tsx|js|py|java|go|rs|cs|c|cpp|php|rb|kt)$/`
  outside the registry import. (This is deliberately NARROWER than design §6's "any
  identifier or string literal naming a programming language" — that heuristic
  false-positives on ordinary words; the narrowing is a conscious decision, stated in
  the rule's header comment. Design §6's second dogfood — "a deterministic aspect on
  this repo's own `src/roots/**` node" — means a deterministic-CHECKER aspect (a
  `check.mjs` under `.yggdrasil/aspects/`) encoding the genericity fence in the graph
  itself; it is NOT satisfied by the type carrying the unrelated LLM `deterministic`
  aspect. Authoring a NEW aspect is outside Task 1's authorized architecture block, so
  this row is CONSCIOUSLY DEFERRED pending maintainer approval — it is listed in the
  execution notes' user-gated items, not silently dropped.) The rule lives INLINE in
  `eslint.config.js`
  scoped to `src/roots/**` — a separate `eslint-rules/` directory would be unmapped
  by every architecture `when:` (a blocking coverage error needing an UNAUTHORIZED
  third architecture edit), unlinted by `"lint": "eslint src/ tests/"`, and imported
  by nothing precedented. THE PROOF: `genericity-lint.test.ts` SPAWNS the eslint CLI
  from cwd `source/cli` (the only cwd where `eslint.config.js` is found) with
  `--stdin --stdin-filename src/roots/virtual.ts --format json` — the filename is
  CONFIG-RELATIVE: eslint resolves it against cwd, so a `source/cli/`-prefixed value
  would double the prefix and silently miss the `files: ['src/roots/**']` scope while
  globally-scoped rules still fire, faking a working run. A virtual filename makes the
  flat-config scoping apply without writing into `src/`, and spawning means the test
  imports nothing — no graph edge. The test asserts THREE things: the clean source
  passes, the dirty source (banned import AND banned extension literal) reports BOTH,
  and the dirty run's output actually contains the genericity rule's own id — the
  last assertion is what catches the scope-miss failure mode dead. So a silent no-op
  regression fails red, the exact failure mode the config's note warns about.
- [ ] **Step 4: Guard suites + graph ritual + report** (as Task 1 Step 6; the lint join
  must leave `npm run lint` green on the whole existing tree).

### Task 3: Binding derivation + 16 grammar snapshots (R2a)

**Files:**
- Create: `source/cli/src/roots/binding.ts`
- Create: `source/cli/src/ast/node-types.ts` (the disk loader — ast-adapter-classified by
  the existing `when:`, so no architecture edit; roots-engine's `no-direct-fs` forbids the
  read living in `binding.ts` itself)
- Create is self-contained — `node-types.ts` does NOT reuse `parser.ts`'s wasm
  resolution, because it cannot: `node-types.json` exists ONLY under `dist/grammars/`
  (the build copies it there via `tsup.config.ts`'s per-grammar candidate table; the
  node_modules dev-fallback locations `resolveWasm` probes have wasm but NO
  node-types.json at the probed paths). Dictated resolution: two candidates, first hit
  wins — `<moduleDir>/grammars/` (correct when running from `dist/`: the published
  bundle is FLAT, so `dist/grammars` is `__dirname/grammars` — `parser.ts:13-19`'s own
  first candidate and its comment say exactly this) and `<packageRoot>/dist/grammars/`
  (correct when running from `src/` under vitest; packageRoot found by package.json
  walk-up — `dist/` has no package.json, so the walk-up is safe in both modes); if
  neither directory exists, THROW loudly
  naming the build command — never skip, never return empty (the built-binary guard's
  philosophy; the gate builds before tests, so in CI the directory is always there).
  Read via `node:fs` directly, exactly as `parser.ts` itself does (`:4`) —
  ast-adapter's allowlist has NO persistence-adapter edge, so the io-helpers instinct
  would create an unsanctioned relation. No change to `parser.ts` needed. Coverage
  note: `src/ast/**` IS coverage-measured and the throw branch never fires in CI (the
  gate builds before tests) — make the candidate list injectable (an optional
  parameter defaulting to the two real candidates) so the error branch gets a direct
  unit test instead of dead uncovered lines.
- Modify: `source/cli/src/ast/types.ts` — add `export type` re-exports for the
  web-tree-sitter types roots needs (`Tree`, node types); verified: it imports
  `type { Tree }` today WITHOUT re-exporting it, so this step is genuinely needed;
  roots never imports the package directly (Task 2's lint bans it)
- Modify: BOTH ast model nodes — `.yggdrasil/model/cli/ast/runtime/yg-node.yaml`
  (`node-types.ts` joins its `mapping:` beside `parser.ts`/`parse-cache.ts`/`runner.ts`)
  AND `.yggdrasil/model/cli/ast/report/yg-node.yaml` (`types.ts` maps THERE, not to
  runtime) — ast-adapter is log-gated, so BOTH drifts need their own `yg log add`
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
  keys on the asset name" — concretely: strip the `tree-sitter-` prefix and `.wasm`
  suffix, so `tree-sitter-c_sharp.wasm` → asset `c_sharp` → fixture `c_sharp.json`,
  and the loader reads `tree-sitter-<asset>.node-types.json`); the asset name derives
  from the registry entry's wasm filename. `RootsBinding` carries the FULL §6.2
  derivation, not just the three node-kind sets: also the HERITAGE node-type matcher
  (the prototype's `heritageRe` at `:39`) and the scope-KIND rule (`type` when the
  body subtree contains a further scope, else `method` — prototype `:81-82`). And
  because `deriveBinding` is pure over node-types and cannot itself apply
  extraction-time rules, `binding.ts` ALSO exports the two helpers Task 4 calls:
  the lexical decoration-marker predicate (text begins `@`/`[` after whitespace) and
  the attribution-window test over `(loRow, bodyRow]` — named exports with unit
  tests here, so Task 4 consumes them instead of re-deriving. The 16 committed
  snapshot fixtures are named `<asset>.json` (committed
  filenames cannot be cheaply renamed later — get this right now); `binding.ts`
  exporting PURE `deriveBinding(nodeTypes): RootsBinding` — the scope/import/decorator
  node-kind sets with the lexical `@`/`[` marker rule and the decoration attribution
  window `(loRow, bodyRow]` — per spec §6.2 (`v6-spec.md:228-240`) read IN FULL — plus
  `bindingHash(binding): string` (sha256 of the canonical-JSON binding — the
  PER-GRAMMAR hash; the Task-6 pipeline folds all used grammars' hashes into the
  single header value, and that fold — not this per-grammar hash — is what the
  Task-8 command writes; say so in binding.ts's own comment); the
  prototype's `bindingFor()` (`prototype-roots2.mjs:36-45`) and `extractScopes`' window
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
  name regex; the lexical @/[ marker filters it" — with any spec-section citation as
  a pointer beside the stated rule, never as a substitute for it (the
  `self-contained-references` checker bans vague planning-artifact references like
  "this task"; a section number is fine, an unexplained one is not).
- [ ] **Step 4: Graph (binding.ts joins the engine node's mapping; ast/registry
  relations declared; the TWO ast-adapter log entries — `cli/ast/runtime` and
  `cli/ast/report`), guard suites, ritual, report.**

### Task 4: Extraction and enumeration (R2b)

**Files:**
- Create: `source/cli/src/roots/extract.ts`, `source/cli/src/roots/partitions.ts`,
  `source/cli/src/roots/enumerate.ts`
- Test: `source/cli/tests/unit/roots/extract.test.ts`, `partitions.test.ts`,
  `enumerate.test.ts`
- Modify: `.yggdrasil/model/cli/roots/engine/yg-node.yaml` (mapping + relations)

**Interfaces:**
- Consumes: `RootsBinding`, the decoration-marker predicate, and the
  attribution-window helper (all Task 3 exports — consume them, do not re-derive);
  parses via `withParsedFile`.
- Produces — THE PARSE SEAM AND THE PHASE ORDER, fixed here. Per-file extraction is
  PURE and SYNCHRONOUS over an already-parsed tree, and the async walk (list files,
  read, parse) belongs to the Task-6 pipeline (tests parse their snippets via
  `withParsedFile` directly). But partitioning depends on SCOPE counts (spec §6.8's
  300-SCOPE floor, `v6-spec.md:268` — a partition under 300 scopes merges into
  `_repo`) and `stable_id`/module resolution depend on the FINAL partitionId — so
  extraction is TWO-PHASE. One DELIBERATE deviation from the prototype's order,
  decided here: the prototype builds module scopes BEFORE partitioning (`:420-426`,
  feeding the same array its merge counts at `:431-435`) because ITS module rule
  ignores partition roots — but the SPEC's module rule (§6.3, "nearest of partition
  root or first directory with ≥ 3 code files") is partition-DEPENDENT, so under the
  spec modules are structurally posterior to partitioning, and the 300-scope floor is
  evaluated over the pre-module denominator: NAMED-BODY + FILE scopes. That is
  stricter than the prototype's count (fewer scopes clear the floor) — the safe
  direction for goldens sized against it; state the denominator in `partitions.ts`'s
  header comment. The phase mechanics otherwise match the prototype (file walk for
  roots at `:427-429`, merge over SCOPES at `:431-435`):
  (1) `extractUnits(relPath, source, tree, binding): RawScope[]` — per-file, pure:
  named-body scopes AND the one FILE scope per file (the prototype pushes it inside
  `extractScopes` at `:113`), under spec §6.7's extraction contract
  (`v6-spec.md:264-265`: never descend into a nested scope's body — prototype `:98` —
  and the FIXED 4000-node visit cap — prototype `:95`) AND §6.1's error tolerance
  (`:222`): ERROR nodes never abort — subtrees containing them are skipped
  (error-free subtrees only), and a root-level error degrades to the file scope
  alone; this is extractUnits' OWN contract, tested here, so Task 6's pipeline only
  composes it. `RawScope` carries every
  field the downstream signatures force: `qualifiedName` and `arity` (stable_id
  inputs, §6.4), anonymous scopes as `<anon>` + ordinal and overloads as `#k` by
  source order (stated at `:245`, marked binding at `:247`), ordinals computed DURING extraction (not
  post-hoc), kinds, decorations, and §8.1's role-feature ingredients (own-name
  tokens' source, supertypes via the heritage matcher, file imports) — NO
  partitionId, NO stable_id yet.
  (2) `derivePartitions(files, rawScopes, config): PartitionMap` in `partitions.ts`
  (config carries the include/exclude and partition keys; the
  `makeRootsFileFilters` factory is likewise built FROM config — both parameters
  stated here, not left to Task 6's blanket clause) — spec
  §6.8 IN FULL (`v6-spec.md:267-271`): package-root detection from the file walk, the
  300-scope floor over the raw scopes, `_repo` merge, the built-in exclusion list.
  `files` is the EXCLUSION-FILTERED listing, NOT the parsed subset and NOT the
  raw walk: spec §6.6 step 1 (`v6-spec.md:255`) enumerates "filtered", so the marker
  scan runs AFTER the §6.8+config exclusion merge (else `dist/package.json`,
  `vendor/*/go.mod`, `build/pom.xml` become partition roots in repos that commit
  those trees) but BEFORE any grammar filter — §6.8's package markers (`go.mod`,
  `pom.xml`, `*.csproj`, `*.sln`, `setup.cfg`) have no registered grammar and would
  vanish from a post-grammar-filter list, silently losing Java/Go/C# roots. The
  composition, exactly (the two predicate flavors are `partitions.ts`'s, see its
  factory below): listing → merged EXCLUSIONS → marker scan; listing → `include` ∧
  merged exclusions ∧ registered-grammar → parse.
  Config `include`/`exclude` (§4.5 `v6-spec.md:146`) are applied HERE too: spec
  §21.3 (`:721`) merges the §6.8 built-in exclusion list with config `exclude`, and
  `partitions.ts` owns that merge (globs via `mapping-path`'s `globMatch`, per the
  lint story), EXPORTING a FACTORY — `makeRootsFileFilters(config)` returning BOTH predicates:
  `{ forMarkers, forParsing }` (they need config; the factory form makes the call
  sites unambiguous). The two flavors, deliberately: the MARKER SCAN filters by the merged EXCLUSIONS
  ONLY (the prototype's walk applies `EXCL` alone at `:428` — a narrowed `include`
  like `["src/**"]` must not hide a root `go.mod` and vanish the partition root),
  while the PARSE set additionally requires an `include` match (default `**/*`). Those predicates are
  what keep excluded scopes OUT of mining end-to-end: `forMarkers` (merged
  exclusions only) filters the package-root marker scan (spec §6.6's enumeration is
  "filtered", `:255`), and `forParsing` (`include` ∧ merged exclusions), composed
  with the grammar filter, gates the parse set (Task 6).
  (3) `finalizeUnits(rawScopes, partitions): ScopeUnit[]` — assigns final
  partitionIds, resolves MODULE scopes (spec §6.3 `:241-243` — "nearest of partition
  root or first directory with ≥ 3 code files" is partition-dependent, which is why
  the prototype builds module scopes cross-file in `learn` at `:420-426`; for scopes
  whose partition merged into `_repo` the "partition root" arm is the REPO root —
  state that convention in a comment, since a merged partition has no directory of
  its own; and "code files" in the ≥3 rule COUNTS registered data-grammar files —
  design §5.4 gives data grammars module-level surfaces (E12 module facts), which
  requires data files to be able to form modules — another stated decision), and mints
  the keys: `skeyR` (the prototype's `rel#kind#name[#ord]` key at `:121`) and
  `stable_id` = sha256hex(partitionId∥relPath∥kind∥qualifiedName∥arity)[:16] — the
  PRODUCTION scheme, spec §6.4 `v6-spec.md:245`, NOT the prototype's simple key.
  `enumerate.ts` exports `buildVocabularies(units, partitions, config)` (the §7.2
  per-partition vocabulary builder — deterministic selection; config carries the
  `enumerate.*` floors and caps) and
  `enumerate(units, vocab, config): { bags: FeatureBag[], domains: DomainMap }` —
  the twelve enumerators with relative-import normalization, per spec §7.1-7.2
  (`v6-spec.md:277-304`) read IN FULL, AND spec §5's sparse-boolean rule
  (`v6-spec.md:213`, read IN FULL): boolean surfaces are stored TRUE-ONLY with a
  per-surface APPLICABILITY DOMAIN declared by the enumerator (Appendix B's
  `domain` column — e.g. `auto.call:<c>` applies to methods with ≥1 body statement,
  `auto.imp:<s>` to files with ≥1 import), so `extractUnits` records the
  observables those domains need (body-statement count, import presence, …),
  `enumerate` derives per-surface domain membership into `DomainMap`, and the
  counting layer computes `n_false(q,r) = |domain(q) ∩ members(r)| − n_true(q,r)` —
  a scope OUTSIDE the domain contributes NOTHING (undecidable ≠ false;
  `|cell| − n_true` is the forbidden shortcut), with the spec's own property test
  (sparse ≡ dense on small fixtures) written here.
  Prototype `extractScopes` (`:70-120`) is the per-scope semantics reference.
  Tasks 5-7 consume all these shapes; Task 6's pipeline composes them in exactly this
  phase order.

- [ ] **Step 1: TDD table-driven enumerator tests** — one table per enumerator (spec
  Appendix B rows are the source; read the appendix), real source snippets per measured
  grammar, exact expected feature bags; partition cases (package roots, the 300-scope
  floor, `_repo` merge) hand-built and hand-derived; anonymous-scope (`<anon>` +
  ordinal) and same-name-overload (`#k`) key cases — §6.4 makes both markers
  binding, because a collapsed key silently merges two scopes' identities.
- [ ] **Step 2: Implement the three phases (extract.ts's `extractUnits` +
  `finalizeUnits`, partitions.ts between them), then enumerate.ts** to the tables;
  ordinals/skeyR/stable_id everywhere a key leaves the module.
- [ ] **Step 3: §7.3 tautology filter — the SPLIT.** Read spec §7.3
  (`v6-spec.md:306-308`): the skip is per (ROLE, surface) candidate — a candidate
  whose overlap group is among the role's §8.8 defining feature groups, `_all`
  exempt — so it CANNOT run in `enumerate.ts` (roles do not exist yet in the
  pipeline order). What lives HERE is the static surface→overlap-group MAP
  (name-tokens↔E1, supertype↔E9, decorator↔E6-deco, import-segments↔E8/E7, per
  `:307`), exported FROM `enumerate.ts` (named: it is a property of the enumerator
  catalog) for Task 6; the SKIP itself is a named mine stage, and §9.4a's
  `C` is counted AFTER it (`:397`: candidates surviving appliesKind ∧
  overlap-tautology ∧ minInstancesRaw) — its absence mis-sizes the repo-wide `C`.
- [ ] **Step 4: Graph, guard suites, ritual, report.**

### Task 5: Role induction (R3a)

**Files:**
- Create: `source/cli/src/roots/roles.ts`
- Test: `source/cli/tests/unit/roots/roles.test.ts`
- Modify: `.yggdrasil/model/cli/roots/engine/yg-node.yaml` (mapping + relations — same
  as every other engine-file task)

**Interfaces:**
- Consumes: `ScopeUnit` (Task 4 — §8.1's role bag is built from ScopeUnit's
  role-feature ingredients; `FeatureBag` reaches roles only indirectly through Task
  6's counts) and the parsed `RootsConfig`.
- Produces: `induceRoles(units, weights, config): RoleAssignment` — clustering runs PER
  PARTITION (§8.3 `v6-spec.md:331` — group by the `partitionId` each `ScopeUnit`
  carries; never cluster the repo flat), pre-bucketed weighted
  clustering (Lance-Williams, weighted DL, weighted medoids), clone-aware ambiguity
  (`cloneMedoidJaccard >= 0.6` runner-up skip), the persisted `assignments` map (the
  sticky-resolution ENABLER — see the scope correction below), and REAL
  `role_lift` (held-out DL with overlap-group exclusion and decorative demotion — spec
  §8.10 `v6-spec.md:359-362`; NO reference implementation exists, the prototype's proxy
  at `:252-255` is explicitly not it). OWNERSHIP SPLIT, because §8.10's formula is
  "computed from the same counts as §9.4 in one pass" (`:361`) and the §9.4 counting
  layer is Task 6's: THIS task implements — and `roles.ts` EXPORTS — `role_lift` as a PURE function
  over supplied counts (the formula, the overlap-group exclusion, the ≤0 ⇒ decorative
  rule — with unit fixtures over hand-supplied counts), and documents on
  `RoleAssignment` what decorative demotion means for consumers (a decorative role
  contributes no conventions and no shadows; members fall back to `_all`).
  `RoleAssignment`'s SHAPE is dictated here, matching Appendix D's `roles[]` +
  `assignments`: per-role `roleKey`, `label`, `size`, `medoidFeatures`,
  `definingFeatureGroups` (§8.8 `v6-spec.md:353` — role-induction OUTPUT, and
  load-bearing for both the §7.3 tautology skip and §8.10's held-out exclusion),
  `ambiguityRate`, plus the `assignments` map (`"-1"` for ambiguous); `roleLift`
  values are attached by Task 6's counting pass. Task 6
  INVOKES it from the real §9.4 counts in its one counting pass and honors the
  demotion when building role cells — never a second implementation of the posterior
  math. Implement fresh from the formula and derive unit
  fixtures from the spec's own worked values where its appendix provides them). Spec §8
  (`v6-spec.md:314-365`) read IN FULL — INCLUDING §8.9(b) file-scope derived roles
  (`:357`), which design §12 lists as "specified but never built": it is THIS task's,
  implemented fresh from the spec text like role_lift. STICKY-ROLE scope, corrected
  against the spec: stickiness is the VERDICT path resolving a scope's role from a
  PRIOR snapshot's `assignments` map (§8.6 `:345`) — that path is R5's, and build-time
  induction is "one pass, final by definition" (§8.4 `:337`), so `induceRoles` takes
  no prior state and there is no sticky RESOLUTION to build or test here. What R1-R3
  lands is the ENABLING half: the Appendix-D `assignments` map, keyed
  `relPath#kind#name` + `#k` ordinal (`v6-spec.md:875-876`), persisted in the model
  body — recorded as a conscious deferral beside the others in the execution notes.
  Prototype `induceRoles`/`assignAll` (`:135-173`) is the clustering semantics
  reference. Task 6 consumes `RoleAssignment`.

- [ ] **Step 1: TDD** — clustering fixtures (hand-computable small bags: merge order,
  DL deltas, medoid selection), clone-ambiguity case, an assignments-map persistence
  case (keys carry the `#k` ordinal, and the `"-1"` ambiguity marker Appendix D
  binds at `v6-spec.md:875-876` is pinned too), and role_lift cases
  derived from the spec formula (state each expected value's derivation in a comment).
- [ ] **Step 2: Implement.** Weighted math exactly per spec; weight inputs arrive as a
  parameter (the R4 seam — a `WeightFn` interface whose R1-visible default is the
  CONSTANT `weights.noLifecycleWeight` — 0.3, config-supplied, per spec §9.1
  (`v6-spec.md:375-378`, value at `:167`). TWO WEIGHT SYSTEMS — do not conflate
  them: §8.3's CLUSTERING weights are BUCKET CARDINALITY (`w = |bucket|`,
  `v6-spec.md:331`; prototype `:142` — `minClusterSize` is a total member weight in
  those units), so the hand-computed clustering fixtures are derived with bucket
  weights, NEVER scaled by 0.3. And the mining-layer weights are THEMSELVES two
  quantities — `:342`'s weight-index table is binding: role-CELL counts use
  `w(s,q)·(ambiguous ? 0.5 : 1)` and `_all` counts use `w(s,q)` (the per-(scope,
  surface) §9.1 weight WITH the hook-shaped cap — Task 6's concern), while
  §8.9(b)'s file-role plurality uses `w_base` per `:342`'s weight-index table (the
  §8.9b PROSE at `:357` states an unweighted plurality — the table is the more
  specific rule and we follow it, a DECIDED reading; at R1 the two coincide anyway)
  — the per-SCOPE §9.1 base, `:375-377`, BEFORE any cap — so THIS task's `weights`
  parameter is typed as the per-scope BASE weight, w_base, and nothing else. At R1 both quantities evaluate to
  `noLifecycleWeight` = 0.3, which is exactly why the types must be right NOW:
  when R4 lands ledger caps, w_base ≠ w(s,q), and a plurality computed with the
  capped weight would silently drift. Document the seam so R4 slots in without
  signature change.
- [ ] **Step 3: Graph, guard suites, ritual, report.**

### Task 6: Acceptance chain (R3b)

**Files:**
- Create: `source/cli/src/roots/mine.ts`, `source/cli/src/roots/pipeline.ts`
- Test: `source/cli/tests/unit/roots/mine.test.ts`, `pipeline.test.ts`
- Modify: `.yggdrasil/model/cli/roots/engine/yg-node.yaml` (mapping + relations)

**Interfaces:**
- Consumes: everything above.
- Produces: `MinedModel` — the model-BODY type, declared HERE in `mine.ts` per Task 1's
  seam decision (stores.ts stays generic and untouched). ITS SHAPE IS NOT INVENTED:
  spec Appendix D (`v6-spec.md:861-896`) is the NORMATIVE `model.json` body — read it
  IN FULL and follow it key-for-key (string keys only; header excluded from the
  content hash; `:896`'s no-wall-clock constraint binds). The key accounting below covers every Appendix-D key and per-record field the
  authorities make decidable, and the OPERATIVE RULE for anything found in the
  appendix and not named here: populate if its inputs exist this increment, else
  structurally absent, each absence stated in a comment:
  POPULATED — per-partition `vocab`, `alphabets` (load-bearing for §9.3's
  categorical K), `roles[]` with roleKey/label/size/medoidFeatures/
  definingFeatureGroups/roleLift/ambiguityRate, the §8.6 `assignments` map, `facts[]`'s
  §9.4-computable fields including `hookEligible` and the survived populations
  `nConformRaw`/`nTotalRaw` (`:881`, `:886`) — with `counts` encoded as CANONICAL
  DECIMAL STRINGS exactly as Appendix D shows (`"true":"24.2"` — a
  determinism-relevant encoding the byte-identity control depends on) —
  `moduleOfFile`, `seeds`, and `partitions[].id`/the header per the escape clause.
  WRITTEN AS THEIR HONEST DEGENERATE VALUES — `denyEligible: false` on every fact
  (nothing can be deny-eligible before R6 calibration exists), `hookShapedConform: 0`
  (the ledger exists from Task 1 but nothing writes marks before R5 — zero is as
  knowable as the coverage zeros below), `suppressedValue: null` and `seeds[].tension:
  null` (Appendix D shows both as explicit nulls — keep the keys, null the values), and
  `coverageRole`/`coverageAll`/`debtBits`/`debtPerInstance` as ZEROS: their only
  definition is §16.2 (`v6-spec.md:655`), computed over HOOK-ELIGIBLE facts with
  §9.10 governance and §9.7's Δ — later-package machinery — and under this
  increment's fail-closed rule every fact is `hookEligible: false`, so zero is the
  true value, written with a comment citing §16.2, NEVER computed over accepted
  facts (that would be the exact acceptance/eligibility conflation this increment
  exists to fix).
  STRUCTURALLY ABSENT — `historyStats`, `cochange`, `agentShare` (history-fed,
  R4/R5); `couplingByFile`/`couplingByModule` (Appendix G.3 `:1018` defines coupling
  as a CO-CHANGE percentile — history-fed, R4 — NOT static import coupling: do not
  fabricate it from imports); within `facts[]`: `calib` (§14, R6), `trend`/`cohorts`
  (§9.5, R6), `exemplars` (§9.11), and `stabilityDays` per the §9.4g rule above. And `mine(input): { body: MinedModel; candidateCountLog2: number }` — the header
  value CANNOT ride the body (Appendix D puts it in the header), so mine returns it
  beside the body and the pipeline lifts it into `RootsIndexResult`; `input` is the
  fully-assembled stage record { units, bags, domains, vocab, partitions, roles,
  seeds, config, weightFn, ageFn? } (domains feed §5's `n_false` counting — never
  `|cell| − n_true`) — the FULL chain,
  decomposed from the prototype's single `mine()` (`:176-251`) into named stages
  (named, NOT an execution order: seeds join cell counts BEFORE scoring and before
  `C` — prototype `:196-202` — and directory cells are built during counting even
  though their pruning is post-acceptance),
  with §9.4a ACCEPTANCE and §9.4c HOOK ELIGIBILITY as SEPARATE stages: acceptance
  (`:395`) is bits_saved ≥ acceptMarginBits ∧ n_raw ≥ minInstancesRaw ∧ n_eff ≥
  minInstancesEff — survived-raw is NOT part of it; eligibility (`:405-409`,
  directionality + **survived-raw ≥ 2/3, FAIL-CLOSED without history**: an absent
  history/age source marks instances NOT survived) sets the fact's `hookEligible`
  FLAG and NEVER removes the fact — the prototype's `continue`-drop at `:224-225`
  does NOT port (Appendix D records survived populations ON accepted facts, which is
  only possible if eligibility is a flag, not a filter). Then: KT/MDL vs parent
  posterior, index cost, vacuous
  filter, two-tier absence τ (3.5 vocabulary / 4.5 structural — verbatim keys
  `thresholds.absenceGapBits`/`absenceGapBitsStructural`), placement group-only,
  fallback buckets (eligibility gates 1-3 — fallback, placement group-only,
  fire-ability — are FLAG-setters exactly like gate 4: the prototype
  `continue`-drops on all of them and none of that ports; spec `:652`'s
  distributional facts exist only because ineligible facts stay accepted),
  the §7.3 TAUTOLOGY SKIP (per (role, surface) candidate against the role's §8.8
  defining feature groups, using Task 4's exported overlap-group map; `_all`
  exempt; `C` counted after it), DECORATIVE-ROLE DEMOTION (invoke Task 5's pure `role_lift` from
  this pass's own counts — §8.10 `:361` "one pass"; a role with role_lift ≤ 0
  contributes no role cells and no shadows, its members fall back to `_all`, and the
  computed value is recorded on `roles[]`), locality lattice (dirMin 25 — verbatim key `mdl.dirContextMinScopes` — redundant +
  nested-refinement pruning),
  correlation dedup, seeds cap `seedCapFraction` (0.5) × `n_eff_real`
  (`v6-spec.md:382`; `n_eff_real` is the EFFECTIVE — weighted — sum over REAL,
  pre-seed instances: not the raw instance count, and not the post-seed effective sum;
  the prototype computes it at `:201-202` by summing `counts`, which accumulate
  weights, before seeds are added with zero raw weight), §9.4g stability days, §9.4h
  factCap 400 — and §9.4g's R3 SHAPE stated plainly: stability days compute from
  trend windows, trends are a later package, so in this increment the field is
  STRUCTURALLY ABSENT (the spec's own "absent trends ⇒ omitted from messages" rule
  extended to the snapshot; §9.4g's
  "Stored in the snapshot" sentence refers to the value when it exists — with no
  trends there is no value to store, a decided reading, not an oversight) —
  implement the stage so absence is the modeled outcome, with a unit case asserting
  it, never a fabricated value. Spec §9 read
  IN FULL through §9.4 (`v6-spec.md:366-430`); §9.5-§9.11 (trends, severity, DENY
  eligibility, the verdict function, exemplar ranking) belong to LATER packages — out
  of R1-R3, consciously. The R3/R4 seam:
  `mine` takes the same `WeightFn` plus an optional `AgeFn` — absent AgeFn = the
  fail-closed branch, NOT a permissive default. Null-prototype/own-property reads on
  every mined-value map. CONFIG THREADING, decided here: the constants this plan
  names (τ 3.5/4.5, dirMin 25, seedCapFraction 0.5, factCap 400, the §7.2 support
  floors, minInstancesRaw/Eff, acceptMarginBits, eligibilityMinRawShare 2/3, and the
  keys Task 5 consumes — `roles.*`: clusterSampleCap, minClusterSize,
  minOwnFeatures, cloneMedoidJaccard 0.6 (`:198-199`); `thresholds.*`:
  roleAmbiguityGap 0.15, roleMinMembership 0.35 (`:178` — NOTE the namespace: these
  two live under `thresholds`, NOT `roles`, and the parsed shape is verbatim-§4.5) —
  which is why `induceRoles` takes `config`) are §4.5
  DEFAULTS, not fixed
  constants — §4.5's own `:205` list names what IS deliberately non-config (the 300
  floor, KT α=½, dedup lead selection, …) and none of these is on it. Every stage
  that consumes a §4.5 key takes it as a parameter threaded from the parsed
  `RootsConfig` by the pipeline (add a config/options parameter to any dictated
  signature that needs one), and ONE behavioral test pins the wiring: changing
  `mdl.acceptMarginBits` in config changes the accepted set. ALSO: `pipeline.ts`
  exporting TWO stages: `parseAndExtractAll(repoRoot, config):
  Promise<{ files: string[], rawScopes: RawScope[] }>` — the walk + filter + parse +
  extract PREFIX under the §6.1 rules above, returning both the exclusion-filtered
  listing (what `derivePartitions` consumes) and the raw scopes; it exists as its
  own export so Task 7's null control composes the real filters instead of
  re-implementing them — and the full async composition
  `runRootsIndex(repoRoot, config, seeds: SeedEntry[]): Promise<RootsIndexResult>`
  (which itself starts from `parseAndExtractAll`)
  where `RootsIndexResult` = `{ body: MinedModel, bindingSetHash: string,
  candidateCountLog2: number }` — the two header fields produced inside the engine
  MUST surface to the Task-8 command, and `bindingSetHash` (named distinctly so the
  per-grammar `bindingHash` can never be confused with it; it is what the header's
  `bindingHash` field stores) is the ALL-GRAMMAR fold
  (sha256 over the sorted derived binding sets of every grammar used — spec `:137`
  is the definition, `:237` repeats it; the data golden alone uses ≥2 grammars, so
  a single-binding hash is wrong on day one). Seeds
  arrive as a PARAMETER per Task 1's seeds seam (engine never reads the store; the
  prototype's in-`learn` seed read at `:439` does not port; an empty array is the
  no-seeds case, and Task 7's goldens pass whatever their fixtures carry). The
  pipeline itself constructs the R1 defaults — the `WeightFn` is spec §9.1 evaluated
  with NO lifecycle rows, i.e. the CONSTANT `weights.noLifecycleWeight` (default
  0.3, config-supplied; `v6-spec.md:375-378` and `:167` — NOT 1.0, and the word
  "uniform" must not be read as unity: n_eff and every data term scale by this
  weight) — and NO AgeFn;
  R4 will widen this via a trailing options parameter (the same
  no-signature-break seam Task 5 documents for `induceRoles`); `mine.ts` also exports
  an `isMinedModel` narrowing guard, because `readModel` returns the body as
  `unknown` and Task 8's `status` is the first consumer that must narrow it (command
  → roots-engine is a sanctioned edge). The pipeline lists
  files AND reads their contents
  via existing io helpers (persistence-adapter — the scanner for listing, the io
  file-read helper for content; engine carries `no-direct-fs`, so `node:fs` is not an
  option here, and engine may call persistence-adapter same as the core `engine` type),
  parse via `withParsedFile` UNDER SPEC §6.1's ROBUSTNESS RULES (`v6-spec.md:222`,
  read IN FULL — the one §6 subsection everything else here already cites around):
  oversize files (> `history.blobMaxBytes` bytes or > 40k lines — the config key is
  parsed in Task 1) are EXCLUDED before parsing; a file whose parse yields errors
  contributes error-free subtrees only, and a root-level error degrades to FILE
  granularity (the file scope alone); the pipeline NEVER aborts on a file (I1). The
  prototype does both on the two lines directly above the block this plan quotes —
  the size guard at `prototype-roots2.mjs:418` and the per-file try/catch at `:419`
  — and Task 4's `extractUnits` already tolerates error nodes by its own contract;
  the pipeline just composes it. A unit case pins it: one malformed file in a corpus → `runRootsIndex` succeeds
  and that file yields its file scope only. Then Task 4's three phases in order —
  extractUnits per file → derivePartitions → finalizeUnits — then vocabularies →
  enumerate → roles → mine, all pure stages. ONE factory, TWO compositions: the walk's listing passes the merged EXCLUSIONS
  first (that filtered set feeds `derivePartitions` — package markers like `go.mod`
  have no grammar, so no grammar filter touches the marker scan, and `include` does
  not apply to it either), and PARSING additionally requires the `include` match AND
  a registered grammar (registry lookup BEFORE parsing; `getParser` throws
  on unknown extensions — the registry, not the exception, is the filter) — so a
  §6.8-excluded file (`*.test.*`, `**/fixtures/**`, …) never produces scopes and
  never enters vocabularies, roles, or cells (spec `:271` scopes the exclusion to
  convention mining; the excluded files' co-change counting is R4's concern, not
  ours). Task 7's "a golden whose files are named like tests mines nothing" rests
  exactly here. Bindings are derived ONCE per grammar per process and
  cached (spec §6.2 `v6-spec.md:237` makes the cache normative; the prototype's
  `bindings` map at `:35` is the shape). (then, ON `parseAndExtractAll`'s output, `derivePartitions` → `finalizeUnits` —
  the prefix already ran `extractUnits`; never call it twice). This is what Task 7's
  goldens drive in-process and
  what the Task-8 command calls; it does NOT persist (the command composes
  `runRootsIndex` + `stores.ts`).

- [ ] **Step 1: TDD** — MDL math against spec Appendix E's WORKED SCENARIOS **E.2-E.4
  ONLY** (fire-ability, role acceptance, the false-convention control): E.1 and
  E.5-E.7 exercise machinery this increment does not build — E.1 states Δ values, the
  §9.7 verdict-function quantity whose finite-n condition is the fire-ability gate we
  DO build; E.5 is the attractor/survived-raw impossibility argument; E.6 is §9.7
  novelty capping; E.7 is §14 calibration/DENY Wilson floors. Note: the appendix names a
  generator script `tests/fixtures/derive-e.ts` that does NOT exist in the tree — the
  scenarios' stated numbers are the source, each expected number's derivation restated
  in a comment. Also: the fail-closed case (no AgeFn → zero
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
  assertions read `MinedModel` shapes in-process through `runRootsIndex` (the body is
  `result.body` of Task 6's `RootsIndexResult`), and the
  `e2e-public-surface` aspect on `cli/tests/e2e` forbids ANY `src/**` import (even
  `import type`), so `e2e/` is structurally unavailable for these assertions (the
  spawned-CLI proof is Task 8's)

**Interfaces:**
- Consumes: the Task-2 harness, `runRootsIndex` (Task 6).
- Produces: per-golden MUST-mine / MUST-NOT-mine assertion sets (design §13.2), the
  builder⇒bundle equivalence check per golden, the SEVENTH golden `data/` — read
  design §5.4 at `integration-design.md:210-216`: it mixes `.json`/`.yaml`/`.toml`
  files WITH a code grammar (a pure data repo would have nothing to MUST-mine), and
  asserts BOTH halves — MUST-mine on the file/module surfaces AND MUST-NOT-mine on
  every scope-level enumerator over the data files — and three increment-wide
  controls — each with a REAL injection point,
  stated here because `runRootsIndex` deliberately exposes none:
  **null control** (spec Appendix H.6's shuffled-label null; design §13.2's "0
  accepted role/locality conventions") — composes the EXPORTED stages directly
  instead of the pipeline wrapper, starting from `pipeline.ts`'s exported
  `parseAndExtractAll` (Task 6 exports the walk+filter+parse+extract prefix as its
  own stage precisely so this control cannot re-implement the filters divergently):
  parseAndExtractAll→partitions→finalize→vocabularies→
  enumerate→**induceRoles** on a golden, PERMUTE each surface's values across scopes
  WITHIN THAT SURFACE'S DOMAIN ONLY (the `domains` map rides along unpermuted — a
  value permuted onto an out-of-domain scope would drive `n_false` negative and fake
  the zero result) with a DETERMINISTIC seed (spec H.6 pins seeded permutation; the
  test-suite determinism discipline demands it too)
  after enumeration, then assert mine accepts 0 role/locality conventions;
  **fail-closed control** — two halves, both executable NOW: (a) pipeline-level,
  every golden's MinedModel shows ZERO history-gated hook ELIGIBILITY (spec §9.4c
  puts survived-raw in hook eligibility, NOT in acceptance — "mines a field and
  speaks nothing" — so `MinedModel` MUST record per-fact eligibility for this to be
  assertable; Task 6 owns that field); (b) unit-level at the mine stage,
  which DOES take the optional AgeFn: a hand-built case where injecting a synthetic
  AgeFn flips the same fact's `hookEligible` from false to true — the fact is
  ACCEPTED either way (an AgeFn feeds only §9.4c's survived-raw gate; it cannot move
  bits_saved or the instance counts, so acceptance never changes) — proving the
  branch points the right way (a "history-stripped golden" would prove nothing here — without any
  AgeFn, stripped and unstripped goldens are indistinguishable by construction);
  **determinism control** (double `runRootsIndex` → byte-identical MinedModel; note
  the blob cache is R4 — nothing writes `.cache/` this increment, so cache
  independence is NOT claimable yet and is not asserted). Scope: the SIX
  prototype-measured code grammars
  plus the data golden ONLY (`plugin-marketplace-plan.md:260`) — the other seven code
  grammars' goldens belong to **R10** ("roots test suites (design §13)",
  `plugin-marketplace-plan.md:134-138`; the mutation harness rows sit at `:139-141`;
  NOT R9, which is protocol/product integrations),
  and this boundary is stated in the test file's header comment.

- [ ] **Step 1: Size the goldens against the REAL floors — the dominant one is not an
  acceptance threshold.** Spec §6.8 (`v6-spec.md:268`): a partition under 300 scopes
  merges into `_repo`, and **if the merged bucket itself is under 300 scopes there is
  no partition at all and the repo is SILENT (J4)** — the prototype drops the bucket
  outright (`prototype-roots2.mjs:435`). So EVERY golden — the data golden's code half included — MUST clear ≥300 scopes with real margin (not land exactly on the boundary)
  in its merged bucket (counted in the Task-4 denominator: named-body + file scopes),
  or it mines nothing and every MUST-mine assertion fails vacuously. On top of that
  sit §7.2's per-surface vocabulary support floors (`v6-spec.md:300-304`; the
  default values also appear in §4.5 at `:158`) and §9.4's
  min-instance floors — derive each assertion's minimum counts from THOSE, AND at
  the R1 weight: with no lifecycle rows every instance weighs 0.3 (Task 6's
  default), so `n_eff = 0.3 × n_raw` — `minInstancesEff: 3` needs ≥10 raw
  instances, the data term scales by 0.3 against an UNSCALED index cost, and
  Appendix E's worked instance counts multiply by ≈3.3 (E.3's accept-at-n_eff-21
  means ~70 raw conforming instances here). Derive at w=0.3, not at 1. Reaching
  300+ scopes is a scripted-builder job, not hand-typing: the builder spec generates
  files programmatically (loops emitting many small, honest source files — e.g. 60
  files × 5-6 scopes). AND the generated files must dodge §6.8's built-in exclusion
  globs (`v6-spec.md:271` — quote it EXACTLY when porting, e.g. `**/fixtures/**`, `**/migrations/**`, `*.test.*`, `*.spec.*`, `**/*.d.ts**`, …) — a golden whose files are named like tests mines
  nothing; the exclusion applies to paths INSIDE the golden repo, not to where the
  bundle lives in this repo's tree. The prototype report's mined examples are the
  shape reference.
- [ ] **Step 2:** MUST/MUST-NOT assertions per golden + the three controls.
- [ ] **Step 3:** Graph, guard suites, ritual, report. If any golden FAILS to mine what
  the spec says it must, FIRST re-check the golden against Step 1's floors (an
  under-floor golden is a fixture bug and mines nothing by design); only when the
  floors are demonstrably cleared is a miss a product bug in Tasks 3-6 — then STOP
  and report.

### Task 8: CLI surface, docs, changelog (R1 close)

**Files:**
- Create: `source/cli/src/cli/roots.ts` (exports `registerRootsCommand` — the `content:`
  regex in the `command` type's `when:` is what classifies it; a `src/roots/cli.ts`
  would instead match `roots-engine`'s `when:` and be judged as pure engine code —
  no console, no formatter, no Commander — which a command cannot satisfy)
- Modify: `source/cli/src/bin.ts` (registration)
- Modify: `source/cli/src/utils/git.ts` (additive exported helpers for HEAD sha, HEAD
  committer timestamp, and the dirty-file list — the header fields Task 1's ownership
  table assigns to this command; the `utility` type is not log-gated). `src/utils/**`
  is coverage-MEASURED and the spawned E2E contributes no coverage, so these helpers
  get their own in-process unit tests (`tests/unit/utils/` per that area's
  convention — owned by the DEDICATED child
  `model/cli/tests/unit/support/utils/git-helpers/yg-node.yaml`, which already maps
  every git test AND carries the `{ target: cli/tests/support, type: uses }`
  relation a fixture-using test needs; add the new test file to ITS `mapping:` —
  real tmp git repos via the Task-2 fixture)
- Modify: `.yggdrasil/model/cli/tests/unit/cli/yg-node.yaml` description — it
  enumerates its children by name and is ALREADY stale (lists four, seven exist);
  true it up while adding the eighth (`roots`)
- Create: THREE model nodes — the command's node under `model/cli/commands/` (read the
  siblings' file/naming convention there first); the e2e test's node under
  `model/cli/tests/e2e/` (the tree keeps per-file/family e2e nodes there — a new
  spawned suite without one is an unmapped file); AND a new
  `model/cli/tests/unit/cli/roots/` node mapping the sibling unit test. Do NOT map the
  sibling test into `cli/tests/unit/cli/general` — that umbrella's
  `max_direct_relations` ceiling is DELIBERATELY exact at 32 and the leaderboard test
  pins it, so a 33rd relation turns a pinned integration test red; a child node costs
  nothing, and `sibling-test-file`'s checker walks descendants, so it satisfies the
  aspect.
- Test: `source/cli/tests/e2e/cli-roots-basic.test.ts` (spawned) + the sibling unit test
  the `command` type's `sibling-test-file` aspect demands — its checker derives the
  expected filename from the command file's stem, so `src/cli/roots.ts` requires
  EXACTLY `roots.test.ts` — on disk at `tests/unit/cli/roots.test.ts` (files stay
  flat in that directory; the per-command CHILD NODE maps them, as `advise.test.ts`
  lives flat but is mapped by `…/advise/`) — AND requires
  the command node to DECLARE `{type: uses, target: cli/tests/unit/cli}` (see
  `model/cli/commands/advise/yg-node.yaml` for the convention), else it reports
  `missing-relation`
- Modify: `docs/` — one new adopter-facing page, which needs FOUR mechanical joins,
  not just the file: the page joins `.yggdrasil/model/docs/guides/yg-node.yaml`'s
  `mapping:` (else unmapped-files), the VitePress sidebar
  (`docs/.vitepress/config.*`), that docs node's description (it enumerates its
  pages by name), and the node's directly-attached `docs-internal-links` aspect
  (every internal link on the new page must resolve — write links to real pages, not
  planned ones)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the MINIMAL command surface R1-R3 needs and no more — exactly two
  commands, named by the DESIGN's vocabulary, not the prototype's: **`yg roots index`**
  (design §3, `integration-design.md:74-75`: "Naming uses Yggdrasil's vocabulary: index
  (like a build)" — the design's vocabulary decision; the prototype's `learn` verb
  appears nowhere in the design's surface; spec §19's
  command list has `index [--full]`, and in R1-R3 every run is full — do NOT ship an
  accepted-but-ignored flag: implement plain `index`, and note `--full` becomes
  meaningful with R4's incrementality) — on a repo WITHOUT a `roots:` block it SCAFFOLDS the block with defaults,
  printed first, then proceeds (`integration-design.md:399-400` is explicit:
  "`yg roots index` on a repo without the block scaffolds it with defaults, printed
  first" — the earlier draft's refusal contradicted the integration authority;
  refusal remains only for real I/O/config errors, design `:79`) — loads seeds via
  `stores.ts` (empty on a fresh repo), runs `runRootsIndex(repoRoot, config, seeds)`,
  assembles the header
  from the ownership table (the result's `bindingSetHash` — written into the
  header's `bindingHash` field — and `candidateCountLog2`, plus the
  command-computed git trio and the store hashes), and persists header+`result.body`
  via `stores.ts` (the command is the ONLY composer of store and engine, per Task 1's
  seams); real I/O/config errors still refuse with what/why/next (the blockless case
  SCAFFOLDS instead, per the decision above) — and
  **`yg roots status`** (reads the model, reports field/fact counts and dormancy
  honestly; NO `--exit-code` and NO `--diagnose` — `status` itself is a RECORDED
  partial pull-forward from R7, whose scope of record (`plugin-marketplace-plan.md:107-108`) owns the full
  `status [--exit-code] [--diagnose]` gate surface: R1-R3 ships only the read-only
  view, because a mined model nobody can inspect is unverifiable by the E2E and
  useless to adopters; R7 later adds the gating flags to this same command — see the
  execution notes' pull-forward record).
  Registration per `bin.ts` + `preamble.ts` patterns. The `command` type's aspects bind
  automatically (source-no-raw-control-chars, cli-command-contract,
  command-contract-shape, diagnostic-logging, command-error-via-buildissuemessage,
  sibling-test-file, source-hygiene) — read each before writing the handler, and
  satisfy them by construction, not retrofit. The node is log-gated — its `yg log add`
  entry is authored here (alongside any other log-gated node this task's diff touches).

- [ ] **Step 1: TDD spawned E2E** — PROJECT SETUP first, because a golden is a plain
  source repo, not a Yggdrasil project: the test clones the bundle and writes a
  MINIMAL `.yggdrasil/yg-config.yaml` into the clone (the schema `version:` key; the
  `roots:` block present or absent per case — nothing else; `runRootsIndex` needs
  config, not the graph, and `cli/roots.ts` accordingly loads CONFIG ONLY, never
  `loadGraphOrAbort` — mining touches no graph, I10; concretely it composes
  `findYggRoot` (`io/paths.ts:20`) + `parseConfig` (`config-parser.ts:112`) itself,
  since the only existing `parseConfig` call site lives inside the graph loader —
  both edges are sanctioned for `command`). Cases: with a `roots:` block,
  `yg roots index` exits 0 and writes a model whose header carries
  rootsVersion+configHash; running `index` a SECOND time yields a byte-identical
  `model.json` — header included (the header-level determinism proof, and the
  assertion that catches a `dirtyHash` folding in roots' own outputs); WITHOUT the
  block, `index` SCAFFOLDS it with defaults — printed first — into the existing
  `yg-config.yaml` (the merge-a-block writer follows the
  `init-reviewer-setup.ts:263-301` `writeReviewerConfig` precedent; name the new
  writer in cli/roots.ts) and then proceeds to mine, exiting 0; `yg roots status`
  reports what `index` mined, and `status` ALWAYS exits 0, reporting dormancy as
  INFORMATION — spec `v6-spec.md:706` ("All read surfaces exit 0 by default") and
  design `:84` (R7's `--exit-code` is the ONLY gate-capable surface, opt-in); a read
  command exiting non-zero on a dormant repo is exactly the CI-gating surface this
  increment must not ship. Real I/O/config errors are the only non-zero `index`
  exits (design `:79`). The dormancy pin from Task 1 re-run.
- [ ] **Step 2: Implement `cli/roots.ts` + registration + the sibling unit test.**
- [ ] **Step 3: Docs** — one adopter-facing page: what roots is (advisory convention
  mining), dormant-by-default, the two commands, the storage layout, what R1-R3 does NOT
  yet do (no speech, no hooks, no promotion — coming packages). The per-command
  CLI-REFERENCE entries (docs/cli-reference.md + its knowledge twin) stay R9's
  (`plugin-marketplace-plan.md:131`) — this page is the adopter guide, not the
  reference; state that boundary in the report so the omission reads as scoped, not
  missed. Verify every behavior
  claim against the built binary. Wire the three mechanical joins (mapping, sidebar,
  node description). CHANGELOG: ONE `### Added` entry, adopter-voiced.
- [ ] **Step 4: Graph (command node + log entries), guard suites + the THREE progressive
  E2E suites — `tests/e2e/cli-progressive-approve.test.ts`, `cli-progressive-byte-guard.test.ts`,
  `cli-progressive-gate.test.ts` (unchanged behavior proof) — markdownlint, docs build,
  ritual, report.**

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
  log entry; the chmod skipIf question. Untouched by this increment. NEW from this plan:
  design §6's second genericity dogfood — a deterministic-checker ASPECT on the roots
  node (`.yggdrasil/aspects/` addition, outside Task 1's authorized block) — is deferred
  pending maintainer approval; propose it at increment close.
- Spec-fidelity risk is the increment's biggest: every task's reviewer must verify the
  implementer actually read the cited spec sections (formulas match the spec, not the
  prototype's simplifications, wherever §12 lists a productionized row).
- **Two conscious narrowings of R1's own text** (`plugin-marketplace-plan.md:45-53`),
  recorded so no reviewer reads them as omissions: (a) R1 sketches a 16-file
  `src/roots/` skeleton; this plan creates only the files R1-R3 actually populates —
  an empty mapped stub is dead weight in the graph, and later packages add their own
  files when they have content for them — while `partitions.ts` and `pipeline.ts`
  are deliberate ADDITIONS beyond that sketch (the phase split and the composition
  seam earned their own modules). (b) "`rootsVersion` migrations ride the
  existing `migrations/` infra" is vacuous at version 1: the constant lands in Task 1,
  and the FIRST migration is authored by whichever future package first bumps it.
  And one conscious PULL-FORWARD in the other direction: R9's list includes the
  `roots:` schema-doc addition and user-docs pages, but AGENTS.md's doc-consistency
  rule ("changes are not complete until every document describing that behavior is
  consistent") makes deferring them dishonest once the block and commands exist — so
  Task 1 documents the config block and Task 8 ships the adopter page now, and R9
  RETAINS the rest of its docs surface: the `roots-model` schema doc (the model
  header/body schema — Task 1 creates and Task 8 writes that artifact but its
  schema-doc entry is consciously R9's, recorded here), the roots knowledge topics,
  and the per-command CLI-reference entries. And a SECOND recorded pull-forward:
  `yg roots status` (read-only form only) comes forward from R7's
  `status [--exit-code] [--diagnose]` — the gating flags stay R7's; what R1-R3 ships
  is the inspection half a verifiable increment cannot do without. And a THIRD: the
  `data/` golden comes forward from R10's fixture list ("13 code-grammar fixture
  repos + 1 data-grammar golden") because design §5.4/§13.2 make it part of phase-1
  done — the seven unmeasured code-grammar goldens and the mutation harness stay
  R10's. And one more recorded DEFERRAL: sticky-role RESOLUTION is the R5 verdict
  path's (build-time induction is one-pass-final per spec §8.4); R1-R3 ships only
  its enabler, the persisted `assignments` map (Task 5). Also deferred, recorded:
  the §4.4 BUILD LOCK (design §12's infrastructure bullet) — R1-R3's single writer
  is `yg roots index` and every store write is atomic, so lock-less is safe until
  R4's daemon/incremental writers arrive; the lock lands with them.
