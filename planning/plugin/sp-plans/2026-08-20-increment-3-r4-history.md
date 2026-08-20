# Increment 3 — R4: Full History & Weights — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land R4 in full — the complete git-history layer and the real §9.1 instance weights
under the mining core that Increment 2 landed. After this increment the mined field is
*survived*: every instance carries a weight derived from how long its code has stood, who wrote
it, and whether it churned; a fact's displayed evidence is its survived population; the blob
cache makes a re-index parse nothing; and an index resumes from the last indexed commit instead
of re-walking history. Nothing speaks, nothing gates, nothing is promoted — those are R5–R8.

**Architecture:** Four new engine modules under `source/cli/src/roots/` (history walk join,
replay, co-change, weights), one new utility module for the raw git plumbing
(`source/cli/src/utils/git-history.ts`), and three new persistence modules under
`source/cli/src/io/` (the sharded blob cache, the rebuildable replay-state store, the build
lock). The pipeline (`src/roots/pipeline.ts:161`) gains a history stage between extraction and
mining; `mine()` gains the per-surface weight and hook-shaped seams its §9.1 contract always
implied. The v6 spec (`planning/roots/2026-08-17-yg-roots-v6-spec.md`) is the formula authority;
the integration design (`planning/roots/2026-08-17-yg-roots-integration-design.md`) is the
integration authority; the program plan's R4 paragraph
(`planning/plugin/2026-08-17-plugin-marketplace-plan.md:74-82`) is binding verbatim and nothing
in it may be descoped without the owner's written decision (`:281`).

**Tech Stack:** TypeScript, `web-tree-sitter` via the CLI's existing parser pool
(`src/ast/parser.ts` — no second loader), `node:child_process` for git (streamed, never
buffered whole), vitest, spawned `dist/bin.js` E2E, golden git repositories with scripted
deterministic histories (`tests/support/git-fixture.ts` + `tests/support/roots-golden.ts`).

**Spec:** R4 as quoted verbatim below; spec §13 (`v6-spec.md:596-625`), §9.1 (`:368-379`),
§9.4c (`:405-409`), §6.4–§6.6 (`:244-262`), §18.3 (`:685`), §18.4 (`:687`), §20.2 (`:713`),
§21.1 (`:719`), §4.4 (`:120-139`), Appendix D (`:861-897`), Appendix G (`:1012-1022`); design
§12's productionized rows (`integration-design.md:439-467`) and §13's testing law (`:479-517`).
**Every implementer reads, in full, the spec and design sections their task cites before writing
code.** This plan dictates structure, seams, signatures, decisions and test shapes; it defers
formulas to the sections it cites rather than re-transcribing them — a transcription is a second
copy that can drift.

### R4, verbatim (`plugin-marketplace-plan.md:74-82`)

> **R4 — Full history & weights (design §12; spec §13, §9.1)**
> Full walk (`--reverse --raw --no-abbrev --no-merges -M`), **sharded** persistent blob cache
> `.cache/blobs/<2-hex>/` keyed `blobSha∥extractorVersion∥bindingHash`, **resume from
> `lastIndexedSha`** (full walk only on `--full` or unreachable SHA), per-scope lifecycle with
> rename replay, value events (change signature incl. decorations/supertypes/nameshape), clock =
> HEAD committer timestamp, co-change (mega-commit cap 30, 5000 pairs by descending support),
> weights survival × provenance × churn with floor — ledger cap applied **inside `w(s,q)`**
> before mining (productionized from the prototype's fact-level approximation). History defaults
> uncapped (`history.full: true`, `maxCommits: 0`).

---

## Maintainer authorization (status: none required, with one escalation path)

**No `.yggdrasil/yg-architecture.yaml` edit is expected in this increment.** Every file R4 adds
classifies under an existing node type by an existing `when:` predicate, and every import it
needs is already on an existing type's relation allow-list. Verified at HEAD:

| New file | Classified by | Allowed because |
| --- | --- | --- |
| `src/roots/history.ts`, `history-replay.ts`, `history-cochange.ts`, `weights.ts` | `roots-engine` — `when: path: "source/cli/src/roots/*.ts"` (`yg-architecture.yaml:744`) | roots-engine `calls: [roots-engine, ast-adapter, persistence-adapter, utility]`, `uses: [types]` |
| `src/utils/git-history.ts` | `utility` — `when: path: "source/cli/src/utils/*.ts"` (`:359`) | roots-engine → utility is an allowed `calls` edge; `utils/git.ts` already spawns git under the same type's `no-direct-fs` aspect (that aspect bans `node:fs`, not `node:child_process`) |
| `src/io/roots-blob-cache.ts` | `persistence-adapter` — `when: any_of: path: "source/cli/src/io/*-cache.ts"` (`:181-196`, the `*-cache.ts` entry at `:184`) | roots-engine → persistence-adapter is an allowed `calls` edge |
| `src/io/roots-history-store.ts`, `src/io/roots-build-lock-store.ts` | `persistence-adapter` — `path: "source/cli/src/io/*-store.ts"` (`:183`) | same |

**The file names are load-bearing, not stylistic.** `persistence-adapter`'s `when:` is an
explicit glob/name list — a file named `roots-build-lock.ts` or `roots-history.ts` under
`src/io/` matches *no* type predicate, becomes a blocking `unmapped-files` /
`type-strict-orphan` finding, and would force an architecture edit this increment is not
authorized to make. Keep the `-cache.ts` / `-store.ts` suffixes.

**Escalation path (Task 1, Step 1).** If the Task-1 verification finds any of the above false —
a predicate that does not admit a new file, a relation the allow-list denies, an aspect whose own
`when:` makes it inert or newly binding — the implementer **STOPS and reports** with the exact
minimal `yg-architecture.yaml` block that would fix it. Architecture edits are user-gated: the
controller presents the block to the maintainer for explicit approval before any execution
continues. No task in this plan may edit `yg-architecture.yaml` on its own initiative.

The standing invariants hold throughout: no `review_by` changes, no `yg-suppress` markers, no
fabricated incidents, no hand-edited lock files, no graph mutation from roots (I10).

---

## Increment-wide invariants (R4-I1 … R4-I16)

Every task's reviewer checks these. Each names the test family that pins it (task in
parentheses).

- **R4-I1 — Determinism (I2a).** Identical inputs ⇒ byte-identical `model.json`, header
  included, across processes and machines. The clock is HEAD's committer timestamp, read once —
  never `max(last_modified)` over the replay, never wall-clock (`v6-spec.md:618`, `:713`). No
  wall-clock or run-timing field appears anywhere in the model body (`:896`). *(T8, T9)*
- **R4-I2 — Incremental ≡ full.** A resumed index produces a byte-identical `model.json` to a
  fresh `index --full` on the same tree (`v6-spec.md:262`, `:728`). The persisted replay state
  is itself byte-identical between the two paths. *(T9)*
- **R4-I3 — Cache-state independence.** Deleting `.yggdrasil/roots/.cache/` and re-indexing
  yields a byte-identical model (cold ≡ warm). Every field of `historyStats` is therefore a
  property of the history, never of what this run happened to do. *(T4, T8, T9)*
- **R4-I4 — Fail-closed without history.** No git, a shallow clone, or a scope with no
  resolvable lifecycle row ⇒ flat weights (`weights.noLifecycleWeight`) and **unsurvived**
  instances, so no fact is hook-eligible and the field is honestly silent (§9.4c's degenerate
  case `v6-spec.md:409`; §21.1 `:719`). Never the prototype's fail-open inversion
  (`prototype-roots2.mjs:190`; design `:441-444`). *(T7, T8)*
- **R4-I5 — Ledger cap last, inside `w(s,q)`.** `w(s,q) = ledgerMarked(s,q) ? min(base(s),
  hookShapedWeight) : base(s)`, applied **after** every degraded-mode branch and **before**
  mining, per (scope, **surface**) — not per fact, not after counting (`v6-spec.md:378`;
  design `:445`; Appendix F `:957`). Unreleased marks are additionally excluded from the
  survived-raw population (`:685`). *(T7, T8)*
- **R4-I6 — Historical language from the historical path.** A historical blob's grammar comes
  from the extension recorded in the walk for that blob's path at that commit. Content sniffing
  is forbidden (`v6-spec.md:606`, `:226`). *(T4)*
- **R4-I7 — One key space.** Historical scope keys carry the same occurrence ordinals as live
  ones, so the live↔historical join is collision-free (`v6-spec.md:247`). The join key is
  `skeyR` (`relPath#kind#qualifiedName`, ordinal inside `qualifiedName` —
  `src/roots/extract.ts:185`), never `stable_id` (partition-dependent, and partitions move over
  history). *(T5)*
- **R4-I8 — Each distinct blob parsed at most once, ever.** Per `(blobSha, extractorVersion,
  bindingHash)` (`v6-spec.md:604-605`). A warm run parses zero blobs. *(T4)*
- **R4-I9 — Advisory only.** No verdict, no speech, no telemetry, no DENY, no gate. `yg roots
  index` exits 0 except on real I/O/config errors; `yg roots status` always exits 0
  (`integration-design.md:79`, `:84`; `v6-spec.md:706`). No `yg check`/`yg context` output
  changes. *(every task; the Increment-2 dormancy pin re-runs in each)*
- **R4-I10 — Degrade, never abort.** A blob that fails to parse is recorded empty and the walk
  continues; a corrupt cache/state entry is a miss and is rebuilt; git unavailable is a degraded
  mode, not a failure (`v6-spec.md:719`). Every such degradation writes one `debugWrite` line —
  never a silent swallow (the `diagnostic-logging` convention). *(T2, T4, T8)*
- **R4-I11 — Derived state stays derived.** Everything R4 writes beyond `model.json` lives under
  `.yggdrasil/roots/.cache/`, is gitignored, and is safe to delete at any moment (AGENTS.md's
  local-state rule; design `:134-135`). R4 writes no committed store other than `model.json`.
  *(T1, T4, T9)*
- **R4-I12 — Single writer.** Every writer (`index` today; `calibrate`/`promote` later) takes the
  exclusive `.cache/.build.lock`; readers (`status`, and every later read surface) never take it
  and read through `model.json`'s atomic rename (`v6-spec.md:139`;
  `integration-design.md:160-163`). *(T9)*
- **R4-I13 — Config verbatim.** R4 invents no config key. `history.*`, `weights.*`, `cochange.*`
  and `ledger.*` are already parsed with spec defaults (`src/model/graph.ts:135-203`;
  `v6-spec.md:148-188`). Defaults stay uncapped: `history.full: true`, `maxCommits: 0`. *(T2, T6,
  T7)*
- **R4-I14 — One parser path, one registry.** Historical blobs parse through `withParsedFile`
  and grammars resolve through `utils/language-registry.ts` only. No `Parser.init`, no
  `Language.load`, no extension→grammar table under `src/roots/**` or `src/utils/git-history.ts`.
  The genericity ESLint rule (`source/cli/eslint.config.js`) stays green. *(every task)*
- **R4-I15 — Every load-bearing rule has a killer test.** For each rule this plan names as
  load-bearing there is a test that FAILS when the rule alone is deleted, and the implementer
  demonstrates that by actually deleting it, running the test, and restoring (the live mutation
  round-trips MR-1…MR-30, named per task below). A rule with no killer test is not done. *(every task)*
- **R4-I16 — Deterministically ordered accumulation.** Every weighted accumulation iterates a
  deterministically ordered collection; no weighted sum is taken over a `Set`, a `Map` or an
  object built in incidental order. Under R1–R3 every weight was the identical constant 0.3, so
  summation order was immaterial; with per-scope weights (0.05 … 1.0, plus `0.216667`-class
  values) `Σ w` is order-sensitive in the last ULP, and `bitsPerInstance`, `bitsSaved` and
  `share` are serialized as raw numbers — only `counts` passes through `formatCanonicalDecimal`
  (`src/roots/mine-stages.ts:102`). Byte-identity (R4-I1) therefore depends on iteration order
  for the first time in this increment. *(T8)*

---

## Global constraints

- **Additive to every existing surface.** No `yg check` / `yg context` / `yg build-context`
  output changes byte-for-byte; the Increment-1 guard suites
  (`tests/unit/cli/build-context-brief.test.ts`, `build-context-progressive.test.ts`,
  `context-file-type-coverage.test.ts`, `build-context.test.ts`;
  `tests/unit/formatters/context-file-brief.test.ts`, `context-file.test.ts`) and the dormancy
  pin (`tests/unit/roots/dormancy.test.ts`) pass unchanged in every task. Build first
  (`cd source/cli && npm run build`) before any dist-spawning suite — a
  `describe.skipIf(!distExists)` skip is NOT a pass.
- **Dormant without config.** A project with no `roots:` block gets zero runtime change. R4 adds
  no new unconditional surface; the only always-managed artifacts remain the `init --upgrade`
  gitignore/gitattributes lines, which already cover `roots/.cache/` and `roots/.state/`
  (`src/cli/init-scaffold.ts:143`, `:147`) — **no new gitignore entry is needed** (everything R4
  writes is under `roots/.cache/`). Verify that, do not assume it.
- **Coverage.** `src/roots/**`, `src/io/**`, `src/utils/**` are all coverage-measured against the
  ≥ 90 % gate. Spawned E2E contributes no coverage — every new module needs in-process unit
  tests. Error/degraded branches are the ones that go uncovered: make them reachable in tests by
  parameter injection (an optional injected candidate list / clock / spawn wrapper), the pattern
  `src/ast/node-types.ts` already uses for its throw branch.
- **Prompt-ceiling discipline.** The per-file LLM `deterministic` review runs on every
  roots-engine file, and the reviewer prompt ceiling is `max_prompt_chars: 72000` with a measured
  repo-wide margin in the hundreds of characters. Current sizes:
  `src/roots/roles.ts` 54.4k, `mine.ts` 49.6k, `extract.ts` 42.0k;
  `tests/unit/roots/roles.test.ts` 67.0k, `mine-invariants.test.ts` 53.9k. Measured live at the
  branch HEAD, the tightest margins under the 72000 ceiling are
  `tests/unit/core/fill-det.test.ts` 657 characters and `tests/unit/roots/roles.test.ts` 660 —
  and neither `mine.ts` nor `extract.ts` is anywhere near it. So the constraint is not "grow
  nothing", it is: **`roles.ts`, `roles.test.ts`, `mine-invariants.test.ts` and
  `tests/unit/core/fill-det.test.ts` must not grow at all; `mine.ts` and `extract.ts` take only
  the edits named in T4 and T8 and are re-measured with `node scripts/prompt-headroom.mjs` from
  repo root afterwards.** All other new behavior goes in new files and all other new tests go in
  new sibling files; split before crowding the ceiling. (Graph-node `description:` growth is not
  a prompt risk — `src/llm/prompt.ts:179-181` deliberately excludes it from the assembled
  prompt.)
- **Aspect reviewers refuse, up front.** Before writing code, read the aspects binding your
  file's type. They will reject: inlined canonical strings a helper owns (missing-graph text,
  error text), a swallowed error with no `debugWrite`, a path that leaves a public function
  without `toPosixPath`, direct `node:fs` in `roots-engine`/`utility`, `console.*` in engine
  code, a command that formats errors without `buildIssueMessage`, and a command file that
  breaks the CLI command contract. Three more bind `persistence-adapter`
  (`yg-architecture.yaml:197-203`) and therefore bind all three new `src/io/` modules:
  `read-or-default-via-helper` (every ENOENT-swallowing read goes through `readFileOrDefault`,
  never a bare try/catch), `atomic-write-contract` (no `writeFile`/`writeFileSync`/`appendFile`/
  `createWriteStream` imported from `node:fs` in any `src/io/*.ts` — see the build lock's
  `openSync(path, 'wx')` spelling in T1), and `silent-missing-files` (an LLM aspect, judged per
  file). Satisfy them all by construction, not by retrofit.
- **Graph ritual, every task.** New source and test files join their owning node's `mapping:`
  (the unit tree maps per file, not by directory); new import edges between mapped nodes get
  declared relations; watch `max_direct_relations` ceilings and the fan-out leaderboard pin in
  `tests/integration/portal-derive-rest.test.ts` (it pins five paths with counts, a sixth bounded
  value, descending order, the title and a narrative comment — any movement means updating the
  whole set coherently). `log_required: true` sits on `roots-engine`, `roots-store`,
  `persistence-adapter`, `command`, `ast-adapter` and more, so every task whose diff touches a
  log-gated node's mapped files or mappings adds `yg log add --node <id>` with self-contained WHY
  prose. `node source/cli/dist/bin.js check --approve` from repo root must end
  `PASS (1 warning)` (the standing user-gated aspect-review-overdue warning — not yours).
- **Comment discipline.** `self-contained-references` binds every new test node and roots-engine
  via `source-hygiene`: no "this task", "a later task", "the plan", step/task codes in test
  names. A spec-section citation (`§13.3`) is fine as a *pointer beside* a rule stated in full,
  never as the rule itself.
- **No new repo-check steps.** The 17-step list in AGENTS.md is untouched; everything enters
  through the existing typecheck/lint/build/test/coverage/graph steps
  (`integration-design.md:513-517`). Performance budgets (spec §20.1 `:712`) are measured by
  hand at T10 and reported, never gated — a timing assertion in the commit gate is flaky by
  construction.
- **Environment** (verified across two increments): every shell command doing npm/node network
  work starts with
  `cat /root/.ccr/ca-bundle.crt /etc/ssl/certs/ca-certificates.crt > /root/.ccr/node-ca-combined.crt && export NODE_EXTRA_CA_CERTS=/root/.ccr/node-ca-combined.crt`;
  7 chmod-simulation tests fail under root (container artifacts, never yours); gates run
  backgrounded (a foreground command dies at 10 minutes); NEVER `init` from a subdirectory; no
  `repo-check.sh` and no commits from the implementer (the controller gates and commits).
- **Anchors.** Line anchors are from the tree at the branch HEAD when this plan was written.
  Re-locate by the quoted code if an anchor has drifted, and report the drift.

---

## Decisions taken in this plan (D1–D14)

Each resolves something the authorities leave under-determined, or reconciles two of them. A
task may not re-litigate one; a task that finds a decision *wrong* stops and reports.

- **D1 — Where the replay state lives, and everything a resume must carry.** The design's
  storage sketch calls `.cache/` "blob cache only … plus `.build.lock`"
  (`integration-design.md:134-135`), but the spec's §4.4 store layout puts `lifecycle.json`,
  `aliases.json` and `cochange.json` in the same gitignored cache beside `blobs/`
  (`v6-spec.md:126-131`), and §6.6's resume clause only works if that state persists (`:257`).
  Store internals are mechanism, where the spec wins (`integration-design.md:6-8`). R4 therefore
  writes `.yggdrasil/roots/.cache/history/` — all gitignored, all rebuildable, all canonical so
  the state itself is byte-comparable (R4-I2). It holds the replay's **products** and, just as
  load-bearing, every quantity the replay **carries**; a resume that reconstructs only the
  products is not a resume, it is a different computation:
  - `lifecycle.jsonl`, `events.jsonl`, `aliases.jsonl` — the products (T5).
  - `prevstate.jsonl` — the carried replay state: per path, per `scopeKey`, the previous blob's
    value tuple and that tuple's signature. §13.3 replays against `prevState[path]`
    (`v6-spec.md:610`) and a *change* event exists only where the new signature differs from the
    previous blob's, so a resumed walk that starts with no previous tuple emits a spurious
    introduction (or silently misses the change) on the first commit after the resume point.
  - `cochange-raw.jsonl` — every pair's **raw** support together with the per-file commit counts
    `confidence(a→b) = support(a,b)/commits(a)` needs over the whole history (`v6-spec.md:622`),
    **uncut and unfiltered**. The `minSupport`/`minConfidence` filter and the `maxPairs` cut are
    applied at `finishCochange`, never at persist time: a pair sitting at support 7 must still be
    able to reach 8 on a later run, and a pair below the 5000-pair cut today may belong in the
    set tomorrow. The cut set is a **derived output, never state**.
  - `cochange.jsonl` — the cut set as last emitted, kept only so `status` can describe the last
    index cheaply; it is never read back into a replay.
  - `meta.json` — the schema version, `lastIndexedSha`, `inputsHash`, the **per-file
    walk-appearance counters** that `lifecycleMaxAppearances` 200 (`v6-spec.md:615`) is tested
    against (a resumed walk that restarts the count demotes a different set of files to
    file-level than a full walk does, in both directions), the **running `historyStats`
    accumulators** and the **distinct-blob roster** they need (D4).
  R4-I2's byte-identity claim is a claim about all seven files, not only about `model.json`. The
  design's parenthetical is under-enumerating, not contradicting; T10's doc pass says so where
  adopters read it.
- **D2 — Resume means resuming the *walk*, not just the parse.** `plugin-marketplace-plan.md:76`
  is binding: "resume from `lastIndexedSha` (full walk only on `--full` or unreachable SHA)". So
  a resumed index walks `lastIndexedSha..HEAD` only and applies those commits to the loaded
  replay state. The safety net is mechanical, not aspirational: **any** mismatch of the state's
  `inputsHash` (schema version ∥ extractor version ∥ the binding hashes of every registered
  grammar ∥ the canonical `history:`+`include`/`exclude` config subtree), a missing or
  unparseable state, an unreachable `lastIndexedSha`, or `--full` forces a full walk. These
  additional triggers **widen, never narrow**, the full-walk set, so they are not a §6.8 descope
  of the binding "full walk only on `--full` or unreachable SHA"
  (`plugin-marketplace-plan.md:76-77`; `v6-spec.md:257`): that clause constrains what may cause a
  **resume**, and no trigger here suppresses a resume the clause requires — each one trades a
  cheap run for a correct one. R4-I2 is what proves the two paths agree.
- **D3 — Windowing disables resume.** With `history.full: false` or `maxCommits > 0`, the walked
  set is a function of *when you run it*, so a resumed walk would silently mix two windows. Under
  either setting R4 always performs a full (windowed) walk and `status` reports that windowing is
  active (`v6-spec.md:599`, `:697`). Defaults are uncapped, so this path is opt-in-only.
- **D4 — `historyStats` carries only cache- and resume-independent numbers.** Appendix D shows
  `{commits, events, blobs, parsed, mb}` (`v6-spec.md:866`) while §20.2 and Appendix F's I2a row
  require byte-identity across cache states (`:713`, `:1002`, `:972`). Both hold only if none of
  the five is "what this run did". R4 defines them as properties of the *history*: `commits` =
  non-merge commits walked; `events` = value events produced by the replay; `blobs` = distinct
  blob SHAs the walk names; `parsed` = distinct blobs that produced a scope record (i.e. not
  skipped for size or for having no registered grammar); `mb` = MiB (floored) of the recorded
  byte lengths of the blobs the walk **fetched**.
  All five are **accumulated into `meta.json` and re-emitted from state** (D1), so a resumed run
  reports the history's totals rather than its window's: `commits` and `events` are running sums;
  `blobs` is the size of a persisted `blobs-seen` roster of distinct SHAs, since a per-run count
  would double-count a blob first named in an earlier run; `parsed` and `mb` are running sums
  over newly-fetched blobs only. Without that, a resumed index and a `--full` index report
  different `historyStats` for the same history and R4-I2 fails on the header alone.
  The `blobs`/`mb` split is deliberate, and it is what makes `mb` reachable at all: `blobs`
  counts every distinct SHA the walk **names**, while `parsed`, `mb` and the skip roster cover
  only blobs the walk **fetched**. A blob whose historical path carries no registered grammar is
  recognised from that path *before* any fetch (R4-I6): it is counted in `blobs`, its `bytes` is
  recorded as **0** (a recorded zero, never an unknown), it contributes 0 to `mb`, and it is
  never fetched — so §20.1's blob-rate budget is never spent pulling binaries and lockfiles down
  for a byte count. A test pins exactly this reading: on a golden carrying a `.png` and a
  lockfile, both blobs appear in `blobs`, neither appears in `parsed`, and `mb` is unmoved by
  them.
  Run diagnostics — blobs parsed *this* run, walk seconds — go to stderr and nowhere else.
- **D5 — Value events store the raw value tuple, not a per-surface value.** §13.3 says an event
  records `(commit_ts, value, author_hash, author_kind)` where the value tuple carries nameshape,
  first-statement type, return shape, sorted decorators, sorted supertypes (`v6-spec.md:614`),
  and §6.5 binds the change signature over those plus node types and callee texts (`:252`). R4
  persists the tuple itself (the same raw ingredients the blob cache holds), so R6's trends and
  calibration derive any surface's value at join time and a vocabulary change never invalidates
  the event log — the same reasoning §13.2 gives for the blob cache (`:605`).
- **D6 — The history join key is `skeyR`.** Path-scoped, ordinal-carrying, partition-free
  (R4-I7). `stable_id` folds `partitionId`, which is a property of the *current* tree and moves
  when a package root appears or the 300-scope floor flips a partition into `_repo` — a
  historical key space keyed on it would silently fail to join. Ledger marks, which the spec
  keys on `stable_id` (`:685`), are resolved by mapping the current unit's `stable_id` at lookup
  time (the mark is written against the current tree by R5), with aliases followed for renames.
- **D7 — `w(s,q)` is per (scope, surface); the counting callbacks change shape.** §9.1's function
  is `w(s,q)`, and the ledger cap keys on (stable_id, surface) (`v6-spec.md:378`, `:685`). The
  landed counting layer passes `weightOf(stableId)` / `survivedOf(stableId)`
  (`src/roots/mine-stages.ts:189-216`), which cannot express the cap. T8 widens **those two
  callbacks — the ones `countRealInstancesIntoCell` takes — and only those** to
  `(stableId, surface)`; §8.10's `role_lift` keeps a per-scope `w_base` callback of its own,
  which is why T8's Files list names the call sites individually rather than saying "widen
  `weightOf`". `roles.ts`'s `WeightFn` (`src/roots/roles.ts:497`) stays per-scope and
  keeps meaning `w_base` — §8.3's clustering weights are bucket cardinality and §8.9b's file-role
  plurality uses `w_base`; conflating them with the capped `w(s,q)` is exactly the drift
  Increment 2 documented when it fixed those types.
- **D8 — Goldens gain time depth by one trailing non-code commit, not by rewriting their
  sources.** With real weights, a repo whose every file was written in HEAD's own commit has
  `stable_days = 0` ⇒ `w_surv = 0` ⇒ every instance at the `baseFloor` of 0.05 and nothing
  survived — the seven landed goldens would mine essentially nothing and every MUST-mine
  assertion would fail vacuously. T3 therefore re-scripts each golden as: its existing seed
  commit at day 0, plus one trailing commit at **day 400** touching a single non-code file
  (`NOTES.md`, no registered grammar ⇒ no scopes, no partition marker). HEAD's committer
  timestamp then sits 400 days after the code, so `w_surv = min(1, 400/120) = 1`, `age_days =
  400 ≥ freshPenaltyDays`, `w_churn = 1` (never re-touched), `w_prov = 1` (author
  `roots-golden` matches no `history.agentIdentities` regex) ⇒ `w = 1.0` uniformly. Source bytes
  are untouched, so T3 lands with **zero expectation churn**; the expectation movement caused by
  `w` going 0.3 → 1.0 is T8's, in one reviewable place.
- **D9 — Coverage/debt keys become structurally absent, not zero.** `MinedPartition` currently
  types `coverageRole`/`coverageAll`/`debtBits`/`debtPerInstance` as the literal `0`
  (`src/roots/mine.ts:171-175`) because §16.2 computes them over **hook-eligible** facts and
  Increment 2 had none. Once eligibility can be true, a written `0` asserts a falsehood — and
  §16.2's definition still needs §9.10's specificity governance (`v6-spec.md:655`), which is
  R5's. T8 removes the four keys with a comment stating the reason; `report` (R7) computes and
  reintroduces them. This is the same honest encoding Increment 2 used for `historyStats` and
  `cochange`: absent while uncomputable, never a placeholder that reads as data.
- **D10 — `ROOTS_VERSION` stays 1; no migration is authored.** The store's version gate exists to
  refuse a body written by another schema (`src/roots/stores.ts:174-179`), and R4 does change the
  body shape (D9 plus the additions in T8). But roots has never shipped in a release — the R1–R3
  entry is still under `## [Unreleased]` in `CHANGELOG.md` — so no adopter holds a v1
  `model.json`, and this repository carries no `roots:` block or committed model of its own. A
  migration would migrate nothing. T8 states this in `stores.ts`'s own comment; the first real
  bump belongs to the first package that changes the body *after* a release.
- **D11 — Blob cache records hold raw ingredients minus grammar constants.** A cached record is
  the file's `RawScope[]` (`src/roots/extract.ts:92`) with the two grammar-derived constants
  (`grammarNodeTypeVocabulary`, `grammarHasDecoratorTypes`) stripped and re-attached from the
  binding at read time — they are a pure function of `bindingHash`, which is already in the cache
  key, and inlining a whole grammar's node-type vocabulary into every blob record would multiply
  the cache size by an order of magnitude for zero information. Each record also carries the
  blob's `bytes` (D4's `mb`) and a `skipped` marker for oversize/no-grammar blobs, so a skip is
  recorded once and never re-attempted.
- **D12 — Progress goes to stderr; the model never sees it.** §13.1 requires a progress line with
  an ETA when the projected walk exceeds 60 s (`v6-spec.md:602`). The engine has
  `no-direct-console`, so `runRootsIndex` takes an optional `onProgress` callback and the command
  renders to **stderr** (stdout stays the command's own result surface). No timing number reaches
  the model body (R4-I1).
- **D13 — A no-op index writes nothing.** §6.6's clause 6 is categorical: "a build whose full
  input tuple (HEAD, dirty hashes, config, seeds, ledger, bindings) is unchanged performs **zero
  writes** to `.roots-cache/` — a correctness statement (I2a), not an optimization"
  (`v6-spec.md:260`). R1–R3 rewrite `model.json` unconditionally, so R4 brings the behavior to
  the spec rather than recording a departure — silence would read to a later reviewer as an
  unnoticed regression. `index` computes the header's input tuple **first**; when it matches the
  on-disk header byte-for-byte **and no cache write is pending**, the run reports "already
  current" in plain user terms, exits 0, and writes nothing at all — model, replay state and blob
  cache alike. The second condition carries real weight: a missing, unparseable or
  inputs-mismatched replay state, and a deleted blob cache, each mean a rebuild is pending, so
  the run proceeds normally. That is what keeps R4-I3's cold-versus-warm case a real test rather
  than one the short-circuit answers trivially, and `--full` bypasses the short-circuit outright
  as the explicit determinism reference. Byte-identity across a repeated run is then trivially
  preserved, and the property a test can assert is the stronger one: `model.json`'s bytes **and**
  its mtime are unchanged.
- **D14 — Blob-cache shard layout: a directory per 2-hex prefix, one file per key.** Three
  authorities disagree in form. The binding R4 paragraph says `.cache/blobs/<2-hex>/` — a
  *directory* (`plugin-marketplace-plan.md:75-76`) — and design `:464` says "sharded
  `.cache/blobs/`"; spec §13.2 says records are "stored content-addressed under
  `.roots-cache/blobs/<2-hex>.json`" (`v6-spec.md:605`), one aggregate JSON *file* per shard,
  matching §4.4's `blobs/<2-hex>.json` (`:128`). The binding paragraph and the design win:
  §13.2's form is the prototype-era aggregate that Appendix F `:972` already records as
  SIMPLIFIED, and one file per key is what makes a partial write a single-record loss and a
  corrupt shard a single-record miss (R4-I10) rather than the loss of a whole 256th of the cache.
  The difference is not cosmetic — 256 files against one per distinct blob (order 10⁴–10⁵ on a
  real repository) — so an implementer who reads §13.2 in full, as T4's authorities require,
  implements **this decision** and not that sentence. The literal path is fixed here too, since
  no task otherwise pins it: `rootsBlobCacheDir(yggRoot) = <rootsCacheDir(yggRoot)>/blobs`, and a
  record for key `k` lands at `<rootsBlobCacheDir>/<k.slice(0, 2)>/<k>.json`.

---

## Task 1 — Seams, graph design-lock, and the three persistence surfaces

**Scope.** Verify the architecture admits R4 unchanged; land the three `src/io/` modules R4
writes through (sharded blob cache, replay-state store, build lock), the ledger reader on
`stores.ts`, and the types that cross the engine/store boundary. Nothing calls them yet.

**Authorities.** Design §4 storage (`integration-design.md:122-165`), §4's writer concurrency
(`:160-163`); spec §4.4 (`v6-spec.md:120-139`, cache layout `:126-131`, lock `:139`), §5 stores
(`:209-216`), §18.3 ledger (`:685`); program plan R4 blob-cache clause (`:75-76`);
Increment-2's recorded build-lock deferral (`2026-08-18-increment-2-roots-core.md:1296-1298`).
Precedents in code: `src/io/type-class-cache.ts`, `src/io/file-content-cache.ts`,
`src/io/atomic-write.ts`, `src/roots/stores.ts:143-243`.

**Files.**
- Create `source/cli/src/io/roots-blob-cache.ts` — sharded, content-addressed, **generic over the
  record** (`unknown` in, `unknown` out) exactly as `stores.ts` is generic over the model body
  (`stores.ts:143-182`): `persistence-adapter` may not import an engine type, and the engine
  narrows what it reads.
- Create `source/cli/src/io/roots-history-store.ts` — the D1 replay-state store: read/write
  `meta.json` + the **six** canonical JSONL files D1 enumerates (`lifecycle`, `events`,
  `aliases`, `prevstate`, `cochange-raw`, `cochange`) under a caller-supplied directory, generic
  over the record shapes, tolerant of absence, tolerant of a malformed line (skip + `debugWrite`,
  the `advise-decisions-store.ts` convention `stores.ts:203-227` already follows).
- Create `source/cli/src/io/roots-build-lock-store.ts` —
  `acquireBuildLock(lockPath, { waitMs = 2000, pollMs = 100, now })` /
  `releaseBuildLock(handle)`. The name is load-bearing on both halves: `*-store.ts` is what
  `persistence-adapter`'s predicate matches (`yg-architecture.yaml:183`), and the
  `roots-build-lock-` prefix keeps it distinct from the existing `src/io/lock-store.ts`, which is
  the graph verdict-lock triad store — an unrelated concept with an otherwise near-identical
  name. Behavior: exclusive create with this process's pid inside; **stale after 15 minutes**
  (fixed, `v6-spec.md:139`); a held *fresh* lock is **retried until `waitMs` elapses and only
  then refused**, because §4.4's writer-concurrency clause is binding and reads "CLI builds
  **wait briefly, then fail** with a what/why/next message naming the holder" (`v6-spec.md:139`;
  design `:160-163`) — not "fail". The refusal carries the holder's pid in the structured data
  the caller formats. The clock and the sleep are injected, so no test ever waits. Implementation
  note: `atomic-write-contract` (`.yggdrasil/aspects/atomic-write-contract/check.mjs`) bans
  `writeFile`/`writeFileSync`/`appendFile`/`createWriteStream` imported from `node:fs` in **every**
  `src/io/*.ts`, so the exclusive create is spelled `openSync(path, 'wx')` + `writeSync` +
  `closeSync` — the aspect-safe form of `O_EXCL`, not `writeFileSync(path, pid, {flag: 'wx'})`.
- Modify `source/cli/src/roots/stores.ts` — add `readLedger(yggRoot): Promise<LedgerEntry[]>`
  (same tolerant JSONL shape as `readSeeds`, `:211-227`) and the three cache path helpers, all
  built on the existing `rootsCacheDir` (`:43-45`) and all with their literal layout fixed here
  so no task has to guess: `rootsBlobCacheDir = <rootsCacheDir>/blobs` (D14),
  `rootsHistoryStateDir = <rootsCacheDir>/history` (D1), `rootsBuildLockPath =
  <rootsCacheDir>/.build.lock`.
- Modify `source/cli/src/model/graph.ts` — add `LedgerEntry` (`{stableId, surface, date}`,
  §18.3's record) beside `SeedEntry` (`:238-260`), with the same "crosses the boundary" comment.
- Create `source/cli/tests/unit/roots/blob-cache.test.ts`, `history-store.test.ts`,
  `build-lock-store.test.ts`, `stores-ledger.test.ts` — new sibling files (never grow
  `stores.test.ts`).
- Create `.yggdrasil/model/cli/io/roots-cache/yg-node.yaml` — one `persistence-adapter` node
  named for roots' derived state, mapping the three new io files (single-file nodes are the
  local convention, but three files of one subsystem in one node keeps the fan-out leaderboard
  still).

**Interfaces produced.**
- `writeBlobRecord(cacheDir, key, record: unknown): Promise<void>` and
  `readBlobRecord(cacheDir, key): Promise<unknown | undefined>` — path
  `<cacheDir>/<key.slice(0,2)>/<key>.json` per D14 (a directory per 2-hex prefix, one file per
  key), canonical JSON, atomic write. A parse failure is a MISS (`undefined`) plus one
  `debugWrite`, never a throw (R4-I10).
- `readHistoryState(dir)`, `writeHistoryState(dir, state)` — the six JSONL files plus
  `meta.json` (D1); every array written in a fixed sorted order so two states of the same history
  are byte-identical.
- `acquireBuildLock` (bounded wait, then refuse) / `releaseBuildLock` as above.
- `readLedger`, the three path helpers, `LedgerEntry`.

**Steps.**
- [ ] **Step 1: Architecture verification (the design-lock).** For each new file path, confirm by
  reading `.yggdrasil/yg-architecture.yaml` which `when:` predicate classifies it, that every
  import it will make is on that type's `calls`/`uses` list, and that every aspect the type
  attaches actually applies (an aspect whose own `when:` excludes the file is silently skipped —
  `src/model/when.ts:3-6`). Record the result in the task report. Any mismatch ⇒ **STOP**, report
  the minimal architecture block that fixes it, do not edit the file.
- [ ] **Step 2: TDD the three io modules.** Real tmp dirs, no mocks. Blob cache: round-trip;
  sharding layout by the key's first two hex characters; a corrupt shard file reads as a miss;
  two writes of the same record are byte-identical. History store: absent state ⇒ `undefined`;
  round-trip byte-identity of all seven files; a malformed line is skipped, not fatal. Lock:
  exclusive acquisition; a second acquire on a held fresh lock retries for the bounded window and
  *then* fails; a holder that releases inside that window is acquired rather than refused (the
  wait branch's own killer case); release removes the file; a lock file older than 15 minutes is
  broken and re-acquired (inject the clock and the sleep — a test never waits, for 2 seconds or
  for 15 minutes).
- [ ] **Step 3: `readLedger` + path helpers + `LedgerEntry`.** Mirror `readSeeds`'s tolerance
  exactly; a mis-shaped line is skipped so one hand-edit never erases everyone's marks.
- [ ] **Step 4: Graph + ritual.** New io node, test files into the roots unit test node's
  `mapping:`, declared relations, `yg log add` for every log-gated node the diff touched
  (`cli/io/*` node, `cli/roots/stores`), guard suites, typecheck, lint, `check --approve`.

**Acceptance criteria (hand-checkable).**
1. `writeBlobRecord(dir, 'ab12…', r)` creates exactly `<dir>/ab/ab12….json` — D14's layout, one
   directory per 2-hex prefix and one file per key, never an aggregate `<dir>/ab.json` — and its
   bytes equal `canonical(r)`.
2. A 15-minute-old lock file is broken and acquired. A 1-minute-old one is refused with the
   holder's pid, but only after the bounded wait window has elapsed; a holder that releases
   inside the window yields the lock to the waiter instead.
3. `readHistoryState` on an empty directory returns the empty state, creates nothing, throws
   nothing.
4. `yg check --approve` is green with no architecture edit.

**Test obligations / mutation round-trips.**
- **MR-1 (blob cache shard):** flatten the layout to `<dir>/<key>.json` ⇒ the sharding test
  fails.
- **MR-2 (lock exclusivity):** replace the `openSync(path, 'wx')` exclusive create with a plain
  write ⇒ the "second acquire fails while held" test fails.

**NON-goals.** No writer calls these modules yet. No telemetry/session/incident state (`.state/`
stays unwritten — R5). No `yg roots reset` (R8).

---

## Task 2 — The git walk primitives (`src/utils/git-history.ts`)

**Scope.** The raw plumbing, and only that: a streamed full/resumed `git log` walk that yields
typed commit records, a chunked `git cat-file --batch` blob reader, shallow-clone detection, and
commit reachability. No roots concepts (no lifecycle, no scopes) live here.

**Authorities.** Spec §13.1 walk and cost model (`v6-spec.md:598-602`), §13.2 blob batching
(`:604-607`), §6.6 resume (`:257`), §21.1 shallow/git-unavailable (`:719`), Appendix G.1 fix
classifier (`:1014`), G.2 agent-author classifier (`:1016`); design §12's fidelity-fix row
(`integration-design.md:457-458`); Appendix F's honest prototype gaps (`v6-spec.md:971`);
`src/utils/git.ts:81-142` (the existing fail-soft git helpers and their contract).

**Files.**
- Create `source/cli/src/utils/git-history.ts`.
- Create `source/cli/tests/unit/utils/git-history.test.ts` — mapped by the dedicated git-helpers
  test node that already owns `tests/unit/utils/` git tests and carries the
  `{target: cli/tests/support, type: uses}` relation.

**Interfaces produced.**
```ts
export interface HistoryFileRecord {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  path: string;            // POSIX, repo-relative; for R/C this is the OLD path
  newPath?: string;        // present for R/C
  preSha: string | null;   // null for A (the all-zero sha normalizes to null)
  postSha: string | null;  // null for D
}
export interface HistoryCommitRecord {
  sha: string;
  committerTs: number;          // epoch seconds
  authorHash: string;           // sha256(name ∥ email) — full hex, spec §13.1
  authorKind: 'human' | 'agent';
  isFix: boolean;
  files: HistoryFileRecord[];
}
export interface WalkOptions {
  sinceSha?: string;            // resume: walk sinceSha..HEAD (exclusive of sinceSha)
  maxCommits?: number;          // 0 / undefined = uncapped
  sinceMonths?: number;         // only when history.full === false
  agentIdentities: string[];    // config, compiled case-insensitively
}
export function walkHistory(repoRoot: string, opts: WalkOptions,
  onCommit: (c: HistoryCommitRecord) => void): Promise<{ commits: number }>;
// HEAD is read OUTSIDE the walk and never from it. The walk is `--no-merges`, so when HEAD is a
// merge commit — the common case on any repository that merges PRs — the walk's last record is
// neither HEAD's sha nor HEAD's timestamp, while §13.4 is categorical that the clock is HEAD's
// committer timestamp, full stop (`v6-spec.md:618`). Setting `lastIndexedSha` to the last
// non-merge commit would also break resume: the next run would walk `lastNonMerge..HEAD` and
// re-apply commits it already replayed. Implemented as `git rev-parse HEAD` plus
// `git log -1 --no-walk --format=%ct` (no `--no-merges`), both fail-soft to null.
export function readHead(repoRoot: string): { sha: string | null; committerTs: number | null };
export function readBlobs(repoRoot: string, shas: readonly string[],
  onBlob: (sha: string, content: Buffer) => void | Promise<void>): Promise<void>;
export function isShallowRepository(repoRoot: string): boolean;
export function isCommitReachable(repoRoot: string, sha: string): boolean;
```

**Steps.**
- [ ] **Step 1: Pin the framing empirically before writing the parser.** Build a fixture history
  with `tests/support/git-fixture.ts`'s deterministic helpers and capture the real output of
  `git log --reverse --raw --no-abbrev --no-merges -M -z --format=<candidate>` — including a path
  containing a space and a rename. **Do not** trust this plan (or the prototype) for the exact
  NUL/tab framing: `-z` changes both the raw-record separators and the format terminator, and the
  parser must be written against what the installed git actually emits. Encode the framing you
  observed as a test with a literal captured sample, so a future git version that changes it
  fails loudly instead of silently mis-parsing. `--follow` is forbidden anywhere in roots
  (`v6-spec.md:600`).
- [ ] **Step 2: Stream, never buffer.** `spawn` + incremental line/record parsing with a bounded
  accumulator; a 100k-commit `--raw` log is hundreds of MB and `execFileSync`'s `maxBuffer` is
  not an option (this is the one place `utils/git.ts`'s `execFileSync` shape does not port).
  Reject the child's stderr into a bounded tail used only for the error message. Non-zero exit ⇒
  a typed error the caller degrades on (R4-I10), never a partial silent result.
- [ ] **Step 3: Classifiers.** `authorHash` = sha256 of `name ∥ email` (the prototype's 32-bit
  FNV does not port — design `:457-458`, corroborated by Appendix F `:971`). `authorKind` = agent
  iff the author **or** any `Co-Authored-By:` trailer matches any `agentIdentities` regex,
  case-insensitively (G.2 `:1016`).
  `isFix` = G.1's regex exactly (`:1014`): `/^(fix|hotfix|bugfix)\b|(^|\s)revert(s|ed)?\b/i`, the
  conventional-commit `fix:` type, or a body containing `This reverts commit` — the prototype's
  looser regex does not port.
- [ ] **Step 4: Blobs.** One long-lived `git cat-file --batch` child per call, fed in chunks of
  400 SHAs (`v6-spec.md:605`), parsing the `<sha> <type> <size>\n<content>\n` framing by byte
  count (never by scanning for a newline — blob content contains newlines). A missing object
  yields `<sha> missing` and is reported to the callback as absent, not as a crash.
- [ ] **Step 5: Resume, HEAD and degraded modes.** `sinceSha` ⇒ `git log <sinceSha>..HEAD`;
  `readHead` = `git rev-parse HEAD` + `git log -1 --no-walk --format=%ct`, deliberately without
  `--no-merges` and deliberately outside the walk, so a merge HEAD is visible;
  `isCommitReachable` = `git rev-parse --verify <sha>^{commit}` succeeding;
  `isShallowRepository` = `git rev-parse --is-shallow-repository` returning `true`. Every helper
  fails soft to `null`/`false`/an empty walk with one `debugWrite`, matching `utils/git.ts`'s
  documented contract (`:61-71`).
- [ ] **Step 6: Windowing.** `maxCommits > 0` ⇒ `--max-count=<n>`, and state in the header
  comment what that means with `--reverse` (git applies the cap to the *newest* N commits, then
  reverses — that is the intended "cap" semantic); `sinceMonths` ⇒ `--since=<n> months ago`
  (only reachable when `history.full === false`).
- [ ] **Step 7: Graph ritual + report.**

**Acceptance criteria (hand-checkable, against a deterministic fixture).**
1. A history of 5 commits, one of them a merge, walks 4 records in **parent order** — which, for
   a fixture whose commit dates are monotonic, is also ascending committer-timestamp order.
   `--reverse` sorts by ancestry, never by timestamp, so "ascending timestamp" is a property of
   the fixture, not a guarantee of the flag. The first record is the root commit.
2. `git mv a.ts b.ts` in a commit yields exactly one record with `status: 'R'`, `path: 'a.ts'`,
   `newPath: 'b.ts'`, and both blob SHAs non-null.
3. A commit authored by `claude <claude@example.test>` classifies `authorKind: 'agent'`; the same
   commit authored by a human but carrying `Co-Authored-By: Claude <…>` also classifies `agent`;
   a plain human commit classifies `human`.
4. `fix: handle empty input`, `Revert "x"`, and a body containing `This reverts commit abc` each
   classify `isFix: true`; `refactor: prefix handling` does not.
5. `readBlobs` over 900 distinct SHAs invokes the callback 900 times with byte-exact contents,
   using at most 3 batch children.
6. A repo cloned with `--depth 1` reports `isShallowRepository() === true`.
7. In a repository whose HEAD **is** a merge commit, the walk yields no record for HEAD (it is
   `--no-merges`), while `readHead()` returns that merge's sha and its committer timestamp. The
   two readers are independent by construction, which is the whole reason `readHead` exists.

**Test obligations / mutation round-trips.**
- **MR-3 (no-merges):** drop `--no-merges` ⇒ acceptance 1 fails.
- **MR-4 (rename detection):** drop `-M` ⇒ acceptance 2 fails (the rename reads as D+A).
- **MR-5 (trailer branch):** delete the `Co-Authored-By` scan ⇒ acceptance 3's middle case fails.
- **MR-6 (byte-counted blob framing):** parse `cat-file --batch` by newline instead of the
  declared size ⇒ a blob whose content contains a blank line fails byte-exactness.

**NON-goals.** No scope extraction, no caching, no roots types, no lifecycle. No `git log
--follow` under any circumstance.

---

## Task 3 — Golden harness: time depth, renames, deletes, and the history golden

**Scope.** Give the golden fixtures the two things R4's tests need and Increment 2's did not:
*time depth* (D8) and *history shape* (renames, deletes, mega-commits, agent authors, fix
commits). Land it with **zero movement in any golden's mined model**, so the expectation churn
that real weights cause is isolated in T8.

**Authorities.** Spec §20.2's determinism block (`v6-spec.md:713`), §22.3 golden repos (`:729`),
§22.7b fixture equivalence (`:734`); design §13.2 (`integration-design.md:487-490`); spec §13.3
rename replay (`:610`), §13.5 mega-commit cap (`:622`); `tests/support/git-fixture.ts:144-261`
(the deterministic block), `tests/support/roots-golden.ts:32-113` (the spec shape and builder).

**Files.**
- Modify `source/cli/tests/support/git-fixture.ts` — **additively**: a
  `deterministicCommitDateAt(dayOffset, seq)` export layered on the existing epoch/interval
  constants; existing exports keep byte-identical behavior for every current caller.
- Modify `source/cli/tests/support/roots-golden.ts` — `GoldenCommit` gains `dayOffset?: number`
  (days from the fixed epoch; absent = the existing fixed-epoch + 60 s-per-index spacing
  (`tests/support/git-fixture.ts:151`, `:159`), never wall-clock time, so every landed spec keeps
  its current SHAs until it opts in), `deletes?: string[]`, and
  `renames?: {from: string; to: string}[]` (executed as `git mv` before the commit's `files` are
  written, so a rename and a content change in one commit is expressible). It also gains a
  **`dayOffset` monotonicity guard**: `buildGoldenRepo` commits in array order
  (`roots-golden.ts:103-111`) with each commit's date pinned, and a `--reverse` walk yields
  *parent* order rather than timestamp order, so a spec whose offsets are not **non-decreasing**
  scripts a history the replay can never receive in arrival order. The builder throws before
  creating the repository, naming the golden, the offending index and the two offsets.
- Modify all seven committed golden specs (`tests/fixtures/roots/golden/*/spec.ts`) — add the D8
  trailing `NOTES.md` commit at `dayOffset: 400`, source files untouched.
- Regenerate all seven `*.bundle` files.
- Create `source/cli/tests/fixtures/roots/golden/history/{spec.ts, history.bundle}` — the R4
  workhorse golden.
- Modify the golden-node mapping and `tests/support`'s node description (it names its helpers).
- Create `source/cli/tests/unit/roots/roots-golden-history.test.ts` — bundle equivalence for the
  new golden plus the harness extensions' own tests.

**The `history/` golden's scripted shape** (≥ 300 scopes in its merged bucket, per §6.8's floor —
size it the way `typescript/spec.ts` documents its own 400-scope arithmetic). The list below is
the commit array in the order `buildGoldenRepo` commits it, and its `dayOffset` sequence is
**strictly ascending**, enforced by the monotonicity guard above: the walk delivers commits in
parent order, so a spec whose dates dipped mid-stream would hand the replay a *decreasing*
timestamp and every field that assumes monotonic arrival — `first_seen`, `last_modified`,
`churned_early`, `last_human_commit_ts` — would be computed against an order the fixture never
had.

1. **day 0** — the bulk seed: ~90 files × ~4 scopes, uniform conventions, author `alice`. It
   touches ~90 files, so `megaCommitFileCap` 30 excludes it from co-change entirely
   (`v6-spec.md:622`) — which is exactly why the `commits(a)` denominators in the two pair
   populations below count the pair commits and nothing else.
2. **day 20** — a *change* event **and** a new cohort, in one commit: add a decorator to 10
   existing day-0 scopes without touching their bodies (the exact event class a body-only
   signature misses — `v6-spec.md:252`), **and** add 10 **new** decorated files carrying one
   scope each, so 10 scopes have `first_seen` = day 20. The new files matter: step 3 needs a
   population whose `first_seen` is not day 0, and the day-0 seed is otherwise the only
   file-creating commit in the script.
3. **day 30** — the *early-churn* case: rewrite all 10 files born at day 20, author `alice`.
   30 − 20 = 10 ≤ `churnEarlyDays` 14 (`v6-spec.md:612`; `config-parser.ts:50`), so those scopes
   are `churned_early`. The two populations are then explicit and hand-checkable: **the 10 scopes
   born day 20 and churned at day 30 ⇒ `w_churn` 0.25**, and **every day-0 scope, whose first
   modification — where one happens at all — is at day 20 or later, and 20 > 14 ⇒ `churned_early`
   false ⇒ `w_churn` 1**.
4. **day 60** — an *agent* commit: author `claude <claude@golden.test>` adds 12 scopes.
5. **day 65** — a human-authored commit carrying a `Co-Authored-By: Cursor <…>` trailer, which
   classifies `authorKind: 'agent'` on the trailer alone (G.2, `v6-spec.md:1016`).
6. **day 90** — a **rename** commit: `git mv` a directory's worth of files (the lifecycle
   continuity case) with no content change.
7. **day 120** — a **delete** commit removing 3 files.
8. **day 150** — a **mega-commit**: 40 files touched in one commit (above
   `megaCommitFileCap` = 30 ⇒ contributes nothing to co-change).
9. **days 160, 170, 180, 190, 210, 220, 230, 240, 250** — **nine** ordinary commits, each
   touching exactly the same **pair** of files (`src/svc/order.ts` + `test/order.spec.ts`) and
   nothing else. Support(order.ts, order.spec.ts) = **9 ≥ `minSupport` 8**
   (`v6-spec.md:187`; `config-parser.ts:112`), and no other *counted* commit touches either file
   — the day-0 seed is excluded by the mega-commit cap — so `commits(order.ts)` = 9 and
   confidence = 9/9 = **1.0 ≥ `minConfidence` 0.75**. This pair, and only this pair, persists.
10. **day 200** — a `fix: …` commit touching **one** day-0 file (`fix_touches` on that file's
    scopes). A one-file commit has fewer than 2 changed files, so it contributes no pair and
    moves no `commits(a)` denominator; it is sequenced between the day-190 and day-210 pair
    commits purely to keep the offsets ascending.
11. **days 300, 320, 340, 360, 380** — **five** ordinary commits each touching a second pair
    (`src/svc/ship.ts` + `test/ship.spec.ts`) and nothing else. Support 5 < `minSupport` 8, so
    this pair deliberately never clears the floor: it is the negative control proving the filter
    actually runs, and without it a broken filter would look identical to a working one.
12. **day 400** — the trailing `NOTES.md` commit (D8's clock anchor).

That is **24 commits** (1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 9 + 1 + 5 + 1) at 24 strictly ascending
day offsets: 0, 20, 30, 60, 65, 90, 120, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250,
300, 320, 340, 360, 380, 400.

**Steps.**
- [ ] **Step 1: Extend the fixture helpers additively**, with a test proving the existing helpers'
  output is unchanged (two builds of an unmodified landed spec still produce identical SHAs —
  `git-fixture-determinism.test.ts` is the existing pattern). Land the `dayOffset` monotonicity
  guard in the same step, with a test that a deliberately out-of-order spec throws before any
  repository is created — a guard nothing exercises is a comment.
- [ ] **Step 2: Add the trailing commit to the seven specs, rebuild the seven bundles**, and run
  every landed golden suite **without editing a single expectation**. If any expectation moves,
  STOP: the trailing commit was supposed to add no scopes and no partition marker, and something
  else changed.
- [ ] **Step 3: Write the `history/` golden** exactly as scripted above — 24 commits, strictly
  ascending offsets — build its bundle, assert equivalence, and assert its size clears §6.8's
  300-scope floor with margin (named-body + file scopes, the denominator `partitions.ts`
  documents). Assert the two co-change populations by hand from the built repository before any
  mining code reads them: nine commits touch the `order` pair, five touch the `ship` pair.
- [ ] **Step 4: Graph ritual + report** (new fixture files join the fixtures node's directory
  mapping; the new test file joins the roots unit test node per file).

**Acceptance criteria.**
1. `assertGoldenBundleEquivalence` passes for all **eight** goldens.
2. Every landed golden test passes with no expectation edit in this task's diff.
3. Building the `history/` golden twice yields identical HEAD SHAs.
4. `git log` in the built `history/` golden shows the **24** scripted commits in parent order,
   with the scripted dates, and those dates are strictly ascending from day 0 to day 400.
5. A spec whose `dayOffset` sequence decreases anywhere throws from `buildGoldenRepo`, naming the
   golden and the offending index, before any repository is created.
6. In the built `history/` golden, `src/svc/order.ts` and `test/order.spec.ts` are touched
   together in exactly nine commits of 2 files each, and `src/svc/ship.ts` /
   `test/ship.spec.ts` in exactly five — the supports T6 and T8 are written against.

**Test obligations / mutation round-trips.**
- **MR-7 (bundle drift):** change one byte of a golden spec without rebuilding its bundle ⇒
  equivalence fails naming that golden.

**NON-goals.** No expectation re-derivation (T8). No mining assertions on the `history/` golden
yet (T5–T9 add them as the mechanisms land).

---

## Task 4 — Historical blob extraction and the sharded blob cache

**Scope.** Turn a blob SHA plus its historical path into scope records, exactly once ever, and
persist them content-addressed.

**Authorities.** Spec §13.2 (`v6-spec.md:604-607`), §6.1 oversize/parse tolerance (`:222`), §6.2
binding cache (`:237`), §6.4 ordinals across key spaces (`:247`), §20.1 blob-rate budget (`:712`);
program plan's key clause (`:75-76`); Appendix F's cache row (`:972`); code:
`src/roots/pipeline.ts:29-57` (the asset-name rule `assetNameOfWasmFile` at `:29-39` and the
per-grammar binding cache at `:41-57`),
`:107-140` (the live extraction path this mirrors), `src/roots/extract.ts:399` (`extractUnits`).

**Files.**
- Create `source/cli/src/roots/history.ts` — the history layer's types and the blob-record join
  (`extractBlobRecord`, `blobCacheKey`, the read-through cache wrapper). Keep it under ~25k
  characters; the replay lives in T5's own file.
- Modify `source/cli/src/roots/extract.ts` — add **one** export: `EXTRACTOR_VERSION` (a string
  constant) with a header note stating the bump discipline: any change to what `extractUnits`
  records, or to how it records it, bumps it, and a bump invalidates every cached blob record by
  key rather than by deletion. (This is the only edit to `extract.ts` in the increment.)
- Modify `source/cli/src/roots/enumerate.ts` — export the existing private `nameShape`
  (`enumerate.ts:58`); T5's change signature needs it and a second copy would be a second
  definition of E1's folding.
- Create `source/cli/tests/unit/roots/history-blobs.test.ts`.

**Interfaces produced.**
```ts
// sha256 of the three joined. `bindingHash` is the **per-grammar** hash of the grammar selected
// from the historical path's extension — `pipeline.ts:48-57`'s cached `hash` — and NEVER the
// all-grammar header fold (`pipeline.ts:212-222`, `RootsIndexResult.bindingSetHash`, spec
// `:137`). §13.2 (`v6-spec.md:605`) is ambiguous between the two and the choice is not
// cosmetic: with the fold there is one key per blob, so the same blob seen at `.ts` and at `.py`
// collides (acceptance 4 becomes unsatisfiable) and every cached record is invalidated whenever
// any unrelated grammar moves. A blob whose historical path has no registered grammar has no
// binding at all: it is keyed with the literal sentinel `no-grammar` in the `bindingHash`
// position, so its skip record is stable across grammar changes and is never re-attempted
// (D11; acceptance 5).
export function blobCacheKey(blobSha: string, extractorVersion: string, bindingHash: string): string;
export interface BlobScopeRecord {
  bytes: number;            // D4's `mb` input
  skipped: false;
  scopes: StoredRawScope[]; // RawScope minus the two grammar constants (D11)
}
export interface SkippedBlobRecord { bytes: number; skipped: true; reason: 'oversize' | 'no-grammar' | 'unparseable' }
// The blob arrives as bytes and is decoded as UTF-8 for parsing, because `withParsedFile` takes
// a `string` (`src/ast/parser.ts:134-137`); but `bytes` and the `blobMaxBytes` comparison are
// the **raw byte length before decoding**, matching the live path's
// `Buffer.byteLength(content, 'utf8')` check at `pipeline.ts:126`. A decode that produces
// replacement characters is still parsed — content is never sniffed (R4-I6).
export function extractBlobRecord(relPath: string, content: Buffer, config: RootsConfig): Promise<BlobScopeRecord | SkippedBlobRecord>;
export function makeBlobRecordReader(cacheDir: string, config: RootsConfig, onParsed?: () => void): (sha: string, relPath: string, content: Buffer | undefined) => Promise<BlobRecord>;
```

**Steps.**
- [ ] **Step 1: Grammar selection by historical path only.** Resolve the grammar with
  `getGrammarForExtension(path.extname(historicalPath))`; no registered grammar ⇒ a `no-grammar`
  skip record. **Never** inspect content to guess (R4-I6). Reuse `pipeline.ts`'s asset-name rule
  and per-grammar binding cache — extract the shared helper rather than copying it, and note in
  the report if extracting it touches `pipeline.ts` (a roots-engine → roots-engine edge, already
  allowed).
- [ ] **Step 2: Extraction.** Parse via `withParsedFile(historicalPath, content, …)` — the pool
  keys the grammar off that path, which is what makes R4-I6 structural rather than a check — and
  call the *same* `extractUnits` the live path calls, so ordinals and `qualifiedName` are
  identical in both key spaces (R4-I7). Oversize (`> history.blobMaxBytes`) ⇒ a recorded skip
  *before* parsing (`v6-spec.md:607`). A throw from the parser ⇒ an `unparseable` skip plus one
  `debugWrite`, and the caller continues (R4-I10).
- [ ] **Step 3: Read-through cache.** Key per D11/§13.2; read the shard, on a hit rebuild the
  full `RawScope[]` by re-attaching the grammar constants from the binding; on a miss extract,
  write, and count one parse via `onParsed`. A malformed shard is a miss.
- [ ] **Step 4: Tests** (real tmp cache dirs, real fixture blobs from the `history/` golden read
  through `readBlobs`).
- [ ] **Step 5: Graph ritual + report.**

**Acceptance criteria (hand-checkable).**
1. Same blob, two calls, one parse: the second call's `onParsed` never fires and the returned
   records are deep-equal.
2. Changing `EXTRACTOR_VERSION` changes the key, so the same blob parses again and the old shard
   is left inert (not deleted).
3. Changing a grammar's `bindingHash` does the same, independently.
4. A `.ts` blob whose historical path later became `.py` extracts under **typescript** for the
   commit where its path ended in `.ts` — the record is keyed by content, but the *grammar* comes
   from the path passed in, and both records coexist in the cache.
5. A 2 MB blob, **over** the default `blobMaxBytes` of 1 500 000 bytes (`v6-spec.md:153`;
   `config-parser.ts:51`), records `{skipped: true, reason: 'oversize'}` and is never parsed, on
   this run or any later one.
6. Records land at `<cacheDir>/<key[0:2]>/<key>.json` — one directory per 2-hex prefix, one file
   per key, per D14; never §13.2's aggregate `<2-hex>.json` shard file.

**Test obligations / mutation round-trips.**
- **MR-8 (path-derived grammar):** replace the path-extension lookup with a content sniff ⇒
  acceptance 4 fails.
- **MR-9 (cache key completeness):** drop `extractorVersion` (or `bindingHash`) from the key ⇒
  acceptance 2 (or 3) fails.
- **MR-10 (skip recording):** treat an oversize blob as a cache miss instead of a recorded skip ⇒
  acceptance 5's "never parsed on any later run" half fails.

**NON-goals.** No lifecycle, no events, no walking (T5, T9 own those). No pipeline wiring.

---

## Task 5 — Replay: per-scope lifecycle, value events, aliases

**Scope.** Replay the walk in commit order, maintaining per-path scope state through renames, and
emit the two artifacts everything downstream reads: lifecycle rows and value events.

**Authorities.** Spec §13.3 in full (`v6-spec.md:609-615`), §6.5 change signature (`:249-252`),
§6.4 ordinals (`:244-247`), §9.1's lifecycle-row fields (`:368-379`), §18.2/§18.3 for what
`author_kind` and `last_human_commit_ts` are later used for (`:683`, `:685`); design §12's
lifecycle rows (`integration-design.md:439-467`); Appendix F rows `:974`, `:975`.

**Files.**
- Create `source/cli/src/roots/history-replay.ts`.
- Create `source/cli/tests/unit/roots/history-replay.test.ts`.

**Interfaces produced.**
```ts
export interface LifecycleRow {
  key: string;                 // skeyR — `relPath#kind#qualifiedName` (D6)
  level: 'scope' | 'file';
  firstSeenTs: number;
  lastModifiedTs: number;
  modifications: number;
  churnedEarly: boolean;       // first modification <= history.churnEarlyDays after firstSeen
  fixTouches: number;
  authorKind: 'human' | 'agent';   // kind of the most recent non-merge touch (G.2)
  lastHumanCommitTs: number | null;
}
export interface ValueEvent { key: string; ts: number; kind: 'introduction' | 'change'; value: ValueTuple; authorHash: string; authorKind: 'human' | 'agent' }
export interface ReplayResult { lifecycle: LifecycleRow[]; events: ValueEvent[]; aliases: Array<[string, string]>; events_n: number }
export function replayCommit(state: ReplayState, commit: HistoryCommitRecord, records: BlobRecordLookup): void;
export function finishReplay(state: ReplayState): ReplayResult;
```

**Steps.**
- [ ] **Step 1: State machine.** `prevState[path] → Map<scopeKey, record>` where
  `scopeKey = kind#qualifiedName` (ordinal inside `qualifiedName`). An `R` record moves
  `prevState[old] → prevState[new]` and appends `old → new` to aliases **before** the new
  content is applied (`v6-spec.md:610`) — chains compressed so `a→b`, `b→c` stores `a→c` and
  `b→c`. A `D` record drops the path's state. `A`/`M` apply the post-image blob's records. This
  map is not scratch: it is D1's `prevstate.jsonl`, written at the end of a run and reloaded
  before a resumed walk, because a walk that starts with no previous tuple cannot tell a change
  from an introduction.
- [ ] **Step 2: Lifecycle rows** per (path, scopeKey), every field per §13.3's list. Maintain
  **file-level rows in parallel, always** — they are the documented fallback for the 4–6 % of
  scopes the replay cannot resolve (`:612`), and a fallback computed only on demand is a fallback
  that was never tested.
- [ ] **Step 3: Value events.** An **introduction** event at a scope's first appearance (author =
  that commit's author — without it, values adopted in new code are invisible, `:614`), and a
  **change** event whenever the value tuple's signature differs from the previous blob's. The
  tuple (D5) carries `nameShape(name)`, first-statement type, return shape, sorted decorator
  list, sorted supertype list, sorted node types present, sorted callee texts; the signature is a
  sha256 over its canonical JSON. A decorator added with no body change **must** emit an event —
  that is the prototype-found defect this rule exists for.
- [ ] **Step 4: Cost guards.** A file over `history.lifecycleFileMaxKb` or appearing in more than
  `history.lifecycleMaxAppearances` commits stays **file-level only** (`:615`) — no per-scope
  rows, no per-scope events; record the demotion once with `debugWrite`.
- [ ] **Step 5: Deterministic output.** `finishReplay` returns every array sorted (rows by `key`;
  events by `(ts, key, kind)`; aliases by old path) — the replay's own order must not leak into
  the state file or the model (R4-I1/I2).
- [ ] **Step 6: Tests + graph ritual + report.**

**Acceptance criteria (hand-checkable, on scripted micro-histories and the `history/` golden).**
1. A scope introduced at day 0, modified at day 200, HEAD at day 400: `firstSeenTs` = day 0,
   `lastModifiedTs` = day 200, `modifications` = 1, `churnedEarly` = false.
2. Same scope modified at day 10 instead: `churnedEarly` = true (10 ≤ 14); at day 15: false.
3. `git mv a.ts b.ts` at day 90: the scope's row has `key` = `b.ts#…`, `firstSeenTs` still day 0,
   and `aliases` contains `a.ts → b.ts`. Without rename replay the row would read `firstSeenTs =
   day 90` — assert the day-0 value, not merely that a row exists.
4. Adding `@Injectable` to a class with no other change emits exactly one **change** event, whose
   tuple differs from the previous one only in the decorator list.
5. A file with two same-named overloads produces two lifecycle rows whose keys differ by the
   `#k` ordinal, and neither row's `modifications` counts the other's edits.
6. A file exceeding `lifecycleMaxAppearances` yields a file-level row and zero scope rows for
   that path.
7. `finishReplay` on the same walk, twice, returns byte-identical JSON.

**Test obligations / mutation round-trips.**
- **MR-11 (rename replay):** delete the `R`-record move ⇒ acceptance 3 fails.
- **MR-12 (change-signature completeness):** drop decorators (or supertypes, or nameshape) from
  the tuple ⇒ acceptance 4 fails.
- **MR-13 (ordinals in historical keys):** strip the ordinal from the historical `scopeKey` ⇒
  acceptance 5 fails (the two overloads collapse into one row).
- **MR-14 (introduction events):** emit change events only ⇒ a test asserting a
  never-modified scope still has exactly one event fails.

**NON-goals.** Trends, cohorts, nucleation, calibration (R6) — this task produces their inputs
and reads none of them. No weights (T7).

---

## Task 6 — Co-change, coupling, agentShare, historyStats

**Scope.** The repo-global, non-lifecycle products of the same walk.

**Authorities.** Spec §13.5 (`v6-spec.md:621-625`), Appendix G.3 coupling (`:1018`), §18.4
agentShare (`:687`), Appendix D's `cochange`/`agentShare`/`historyStats`/`couplingBy*` fields
(`:866-892`), §6.8's exclusion scoping — test files and non-code files are **fully counted** in
co-change and history (`:271`); Appendix F's co-change row (`:981`); D4 above.

**Files.**
- Create `source/cli/src/roots/history-cochange.ts`.
- Create `source/cli/tests/unit/roots/history-cochange.test.ts`.

**Interfaces produced.** `accumulateCochange(state, commit)`, `finishCochange(state, config):
{pairs: CochangePair[]; couplingByFile: Record<string, number>; couplingByModule: Record<string,
number>}`, `computeAgentShare(lifecycle, clock, config): number | null`, and the `historyStats`
assembly per D4.

**Steps.**
- [ ] **Step 1: Pair accumulation.** Only non-merge commits with **≥ 2 and ≤
  `history.megaCommitFileCap` (30)** changed files (`:622`); every unordered file pair increments
  support; per-file commit counts accumulate over the same commit set. `R` records remap old→new
  **before** counting. Repo-global — never per partition — and inclusive of non-code and
  test-pattern files (the `routing.py ↔ test_routing.py` signal is exactly this).
- [ ] **Step 2: The cut is a derived output, not state.** At `finishCochange`:
  `confidence(a→b) = support(a,b)/commits(a)`; keep pairs with `support ≥ cochange.minSupport`
  **and** max-direction confidence `≥ cochange.minConfidence`; sort by **descending support**
  (ties by `a` then `b`, so the order is total) and cut at `cochange.maxPairs`. Sorting before
  the cut is the rule, not an optimization: a first-N-by-insertion cut can drop the strongest
  pair. Every one of those operations happens at `finishCochange` and **never at persist time**.
  What `cochange-raw.jsonl` holds (D1) is the raw support of every pair the walk has ever seen
  plus the per-file commit counts, uncut and unfiltered. Persisting the filtered set instead
  would make the floor permanent — a pair at support 7 could never reach 8 on a later run, and a
  pair once outside the 5000 could never re-enter — so a resumed index and a full one would
  disagree by construction (R4-I2).
- [ ] **Step 3: Coupling percentiles (G.3).** Per file: the file's rank in the distribution of
  *distinct co-change partners with confidence ≥ minConfidence*. The spec gives the rank, not the
  convention, so this plan fixes it: `percentile = round(100 × |{files with a strictly smaller
  partner count}| / |files with any coupling entry|)`, ties sharing a percentile; per module = the
  **median** of its files' percentiles (`moduleOfFile` already exists —
  `src/roots/mine.ts:978`). State the formalization in the file header.
- [ ] **Step 4: agentShare (§18.4).** `Σ base(agent-authored, stable_days < weights.agentPromoteDays)
  / Σ base` over scopes first seen in the trailing **120 days** (fixed) of the clock; `null` when
  there is no history. A denominator of 0 — no scope first seen inside that window at all — is an
  **empty population, not a zero share**, and is encoded `null`, the same way §18.4 encodes the
  no-history case (`v6-spec.md:687`). 0/0 is undefined, and `JSON.stringify(NaN)` silently emits
  `null` anyway, so an unguarded division ships the defect as a plausible-looking value rather
  than crashing. Only a **non-empty** population with no agent-authored member yields `0`. This
  is not a corner case here: after D8 every golden's code is first seen at day 0 with the clock
  at day 400, so the trailing-120-day population is empty by construction on all eight. It is a
  composition diagnostic in R4 — the alarm and `status --exit-code` are R6/R7.
- [ ] **Step 5: historyStats per D4**, integers only, no timing field.
- [ ] **Step 6: Tests + graph ritual + report.**

**Acceptance criteria (hand-checkable).**
1. Two files changed together in 8 commits out of `a`'s 10 total: support 8, confidence(a→b) 0.8
   ⇒ persisted. In 8 of `a`'s 12: confidence 0.667 ⇒ dropped (below 0.75) unless the reverse
   direction clears it.
2. A commit touching 40 files contributes **zero** pairs; a commit touching 30 contributes
   `30×29/2 = 435`.
3. With `maxPairs: 2` and three qualifying pairs of support 40/30/20 on a scripted
   micro-history, the persisted set is the 40 and 30 pairs. On the `history/` golden the same
   rule keeps `src/svc/order.ts ↔ test/order.spec.ts` at support 9, confidence 9/9 = 1.0, and
   never admits `src/svc/ship.ts ↔ test/ship.spec.ts` at support 5 — that pair is dropped by
   `minSupport` 8 long before any cut is reached.
4. A rename at day 90 followed by 8 co-changes of the new path, with 3 co-changes of the old path
   before it, yields one pair with support 11 keyed on the **new** path.
5. `historyStats` for a fixed golden is identical whether the blob cache is cold or warm (R4-I3).
6. `agentShare` is `null` on every D8 golden — nothing is first seen in the clock's trailing 120
   days, so the population is empty — and `null` on a repo with no history. It is `0` only on a
   scripted history with a **non-empty** trailing-120-day population none of whose scopes is
   agent-authored. A separate assertion proves no `NaN` ever reaches the serializer on any input,
   since a serialized `NaN` would arrive as an indistinguishable `null`.

**Test obligations / mutation round-trips.**
- **MR-15 (mega-commit cap):** remove the ≤ 30 filter ⇒ acceptance 2 fails.
- **MR-16 (support-ordered cut):** cut by insertion order ⇒ acceptance 3 fails.
- **MR-17 (rename remap):** drop the old→new remap ⇒ acceptance 4 fails.

**NON-goals.** The Stop-channel completeness sweep (`v6-spec.md:625`) is R5's — R4 produces the
pairs it will read. Campaigns and the report surface are R7's.

---

## Task 7 — Weights: §9.1, exactly

**Scope.** A pure module implementing `w(s,q)`, `base(s)` and the age/survival predicates from
lifecycle rows, ledger marks, the dirty set and the clock. No wiring — T8 wires it.

**Authorities.** Spec §9.1 in full (`v6-spec.md:368-379`), §9.4c.4's survived population
(`:409`), §18.3's ledger semantics and release rule (`:685`), §4.5's `weights`/`ledger` defaults
(`:162-169`, `:188`), §21.1's degraded mode (`:719`); design §12's weights rows
(`integration-design.md:441-448`); Appendix F `:956`, `:957`.

**Files.**
- Create `source/cli/src/roots/weights.ts`.
- Create `source/cli/tests/unit/roots/weights.test.ts`.

**Interfaces produced.**
```ts
export interface LifecycleIndex { rowFor(skeyR: string, relPath: string): LifecycleRow | undefined }  // scope-level -> file-level -> undefined
export interface WeightInputs {
  lifecycle: LifecycleIndex;
  ledger: readonly LedgerEntry[];      // committed marks; released marks already filtered out
  dirtyPaths: ReadonlySet<string>;     // repo-relative POSIX
  clockTs: number;                     // HEAD committer timestamp, epoch seconds — the same
                                       // instant the header's ISO-8601 `clock` string encodes
  config: RootsConfig;
}
export function makeWeightFns(inputs: WeightInputs): {
  baseWeight: (unit: ScopeUnit) => number;                    // w_base — roles/§8.9b consumer (D7)
  surfaceWeight: (unit: ScopeUnit, surface: string) => number; // w(s,q) — cap applied LAST
  ageDays: (unit: ScopeUnit) => number;                        // AgeFn
  isHookShaped: (unit: ScopeUnit, surface: string) => boolean; // unreleased mark present
};
export function releasedMarks(marks: readonly LedgerEntry[], lifecycle: LifecycleIndex, clockTs: number, config: RootsConfig): Set<string>;
```

**Steps.**
- [ ] **Step 1: Transcribe §9.1's five lines as five named helpers** (`wSurv`, `wProv`, `wChurn`,
  `base`, `w`) so each is separately testable, and keep the branch ORDER the spec fixes: no
  lifecycle row ⇒ `noLifecycleWeight`; else scope dirty in the working tree ⇒ `dirtyWeight`; else
  `max(baseFloor, w_surv·w_prov·w_churn)`; and **then**, last, the ledger cap. A degraded-mode
  branch must never bypass the cap — that ordering is the whole point of the row. State one
  consequence in the module header, because it is invisible from the formula and a later reader
  will otherwise report it as a bug: a `module`-kind unit's `relPath` is a **directory**
  (`finalizeUnits`, `src/roots/extract.ts:735-736`), so neither of `rowFor`'s lookups —
  scope-level keyed on `skeyR`, then file-level keyed on `relPath` — can ever hit. Every module
  scope therefore weighs `noLifecycleWeight` 0.3 forever and is never survived. That is
  spec-consistent (`v6-spec.md:375`) but it is a real product consequence: no module-level fact
  can be hook-eligible in R4.
- [ ] **Step 2: Ledger release (§18.3).** A mark releases when `stable_days ≥
  ledger.releaseStableDays` **and** there exists a human-authored non-merge commit touching the
  file with `ts ≥ markDate + ledger.releaseMinDaysAfterMark` — the gap requirement exists because
  the commit landing hook-shaped code is routinely human-authored and must not self-ratify.
  Released marks stop capping and stop excluding; the line stays in the file for audit. Marks the
  walk cannot see stay capped (conservative).
- [ ] **Step 3: The survived predicate.** `survived(s, q) = age_days(s) ≥ weights.freshPenaltyDays
  ∧ ¬isHookShaped(s, q)` — and, with **no lifecycle source at all**, false for everything
  (R4-I4). Seeds are excluded from the survived population upstream (they already contribute no
  raw count).
- [ ] **Step 4: Tests — hand-derived, every number shown in a comment.**
- [ ] **Step 5: Graph ritual + report.**

**Acceptance criteria — the arithmetic, hand-derivable at the §4.5 defaults**
(`survivalFullDays` 120, `freshPenaltyDays` 14, `agentBase` 0.15, `agentPromoteDays` 180,
`baseFloor` 0.05, `hookShapedWeight` 0.15, `noLifecycleWeight` 0.3, `dirtyWeight` 0.3
— `v6-spec.md:162-169` — plus the two `ledger` defaults the release rule reads,
`releaseStableDays` **90** and `releaseMinDaysAfterMark` **14** (`v6-spec.md:188`;
`config-parser.ts:113`); note that 120 is `survivalFullDays` and has nothing to do with
release):

| Case | Derivation | `base` |
| --- | --- | --- |
| human, first_seen −400 d, last_modified −400 d, no early churn | `w_surv = min(1, 400/120) = 1`, ×1 (age ≥ 14); `w_prov = 1`; `w_churn = 1` | **1.0** |
| human, first_seen −5 d, last_modified −5 d | `w_surv = 5/120 = 0.041667 × 0.5` (age < 14) `= 0.020833`; floor | **0.05** |
| human, stable 60 d, churned early | `w_surv = 0.5`; `w_churn = 0.25` ⇒ 0.125 | **0.125** |
| agent, stable 60 d | `w_prov = 0.15 + 0.85 × min(1, 60/180) = 0.433333`; `w_surv = 0.5` ⇒ 0.216667 | **0.216667** |
| agent, stable 200 d | `w_prov = 0.15 + 0.85 × 1 = 1`; `w_surv = 1` | **1.0** |
| no lifecycle row | first branch | **0.3** |
| dirty in the working tree (row present) | second branch | **0.3** |

…and on top of `base`: an **unreleased ledger mark** on `(s, q)` makes `w(s,q) = min(base, 0.15)`
— so the first row's 1.0 becomes 0.15 and the second row's 0.05 stays 0.05 (`min`, not
assignment). Additional criteria:
1. Release is predicated on the **scope's `stable_days`**, never on the mark's own age (§18.3,
   `v6-spec.md:685` — Step 2 states the rule; this criterion pins it). Mark at day 0, the only
   human touch at day 20, clock at day 100 ⇒ `stable_days` = 80 < `releaseStableDays` 90 ⇒
   **not** released, still caps. Clock at day 130 ⇒ `stable_days` = 110 ≥ 90, and that touch is
   20 ≥ `releaseMinDaysAfterMark` 14 after the mark ⇒ released, no cap. Clock at day 130 with the
   only touch 5 days after the mark ⇒ `stable_days` = 125 ≥ 90 but 5 < 14 ⇒ **not** released.
2. With `lifecycle` empty, `ageDays` returns 0 for every scope, so the survived predicate —
   `ageDays ≥ weights.freshPenaltyDays` 14 ∧ ¬`isHookShaped`, which T8 folds into `mine.ts`'s
   `survivedOf` — is false for every (scope, surface): the fail-closed shape (R4-I4). `weights.ts`
   exports no `survived` of its own; the predicate has exactly one home, and this criterion
   asserts it through `ageDays` and `isHookShaped`, the two functions this task does export.
3. Scope-level row wins over the file-level row for the same path; a scope with no scope-level row
   resolves to its file-level row; with neither, `noLifecycleWeight`.

**Test obligations / mutation round-trips.**
- **MR-18 (cap last):** move the ledger cap before the `max(baseFloor, …)` ⇒ the marked-scope row
  whose base is 0.05 wrongly rises to 0.05→(min after floor is 0.05 either way) — so use the
  1.0 row: applying the cap *before* the floor yields `max(0.05, min(1, 0.15)) = 0.15` and
  applying it after yields `min(max(0.05, 1), 0.15) = 0.15` — identical. The killer test is the
  **degraded branch**: with no lifecycle row and a mark present, cap-last gives `min(0.3, 0.15) =
  0.15` while cap-inside-the-product gives 0.3. Pin that case.
- **MR-19 (fresh penalty):** delete the `age_days < freshPenaltyDays ? 0.5 : 1` factor ⇒ row 2's
  derivation test fails.
- **MR-20 (churn):** delete `w_churn` ⇒ row 3 fails.
- **MR-21 (release gap):** delete the `releaseMinDaysAfterMark` conjunct ⇒ criterion 1's third
  case fails.

**NON-goals.** `hookShapedConform` counting and any model field (T8). Telemetry and mark
*writing* (R5) — R4 only reads a ledger that is empty until then, which is exactly why its tests
supply hand-written `ledger.jsonl` fixtures.

---

## Task 8 — Wiring: the history join, eligibility flips, model body, degraded modes

**Scope.** The behavioral landing. `runRootsIndex` performs the walk, joins history to the mined
field, and the model gains its history-fed fields. Golden expectations move here, in one place.

**Authorities.** Spec §9.4c (`v6-spec.md:405-409`), §16.2 (`:655`), §21.1 (`:719`), Appendix D
(`:861-897`), §13.4 clock and reshaping (`:617-619`); design §12 (`integration-design.md:439-467`),
§13.5's fail-closed control (`:497-499`); D4, D7, D9 above; code: `src/roots/pipeline.ts:161-225`,
`src/roots/mine.ts:75-204`, `:854-987`, `src/roots/mine-stages.ts:189-216`,
`src/cli/roots.ts:332-395`.

**Files.**
- Modify `source/cli/src/roots/history.ts` — the orchestration entry point
  `buildHistoryJoin(repoRoot, config, deps): Promise<HistoryJoin | undefined>` composing T2's
  walk, T4's cache, T5's replay and T6's co-change, returning lifecycle/events/aliases/cochange/
  coupling/agentShare/historyStats plus the clock; `undefined` ⇒ the degraded mode.
- Modify `source/cli/src/roots/pipeline.ts` — `runRootsIndex(repoRoot, config, seeds, options?)`
  where `options` carries `{ historyDeps?: { cacheDir, stateDir, ledger, dirtyPaths },
  onProgress? }`. Absent options ⇒ exactly today's behavior (constant weights, no AgeFn), so
  every landed unit test that calls the three-argument form keeps passing.
- Modify `source/cli/src/roots/mine.ts` — a small, **enumerated** edit set (prompt ceiling;
  re-measure afterwards): `MineInput` gains `surfaceWeightFn?` and `hookShapedFn?`; `survivedOf`
  becomes per-(stableId, surface) and folds `hookShapedFn`; the `weightOf` definition
  (`mine.ts:860`) gains a **surface-aware sibling** rather than changing meaning, and
  `roleWeightOf` (`:326`) becomes surface-aware through it; `MinedFact.hookShapedConform` becomes
  a real count; `MinedPartition` drops the four coverage/debt keys (D9). The **top-level**
  `MinedModel` additions are `historyStats`, `cochange` and `agentShare` — Appendix D's top-level
  trio (`v6-spec.md:866-868`) — plus `aliases`, which Appendix D does *not* list and which is
  authorized instead by `integration-design.md:130` ("model.json … co-change, **aliases**") and
  `:456` ("persisted `aliases`" as a productionized gap): the cache copy (D1) is replay state,
  the model copy is the consumer-facing projection, sorted and canonical. `couplingByFile` and
  `couplingByModule` are **not** top-level — Appendix D puts them inside each `partitions[]`
  entry beside `seeds` (`v6-spec.md:892`), which is where `moduleOfFile` already lives
  (`mine.ts:178`, produced at `:978`) and what `MinedModel`'s own header comment records. Put any
  helper that computes any of them in `history.ts`, not in `mine.ts`.
- Modify `source/cli/src/roots/mine-stages.ts` — `countRealInstancesIntoCell`
  (`mine-stages.ts:189-216`) and the three cell constructions that feed it (`mine.ts:290`,
  `:329` via `roleWeightOf` at `:326`, `:356`) take a **surface-aware** weight callback derived
  from `surfaceWeightFn`; `computeRoleLiftForPartition` (`mine.ts:462`, `:497`, `:905`) keeps the
  **per-scope `w_base`** callback unchanged — §8.10's `n_eff(r)` is base weight, never `w(s,q)`,
  as that function's own in-file comment states ("at FULL base weight, no ambiguous discount"). A
  wholesale widening of `weightOf` at all ten of its call sites would route the ledger-capped
  per-surface weight into `role_lift`'s divisor: precisely the conflation D7 forbids and
  Increment 2 documented, and silent unless MR-30 is written.
- Modify `source/cli/src/cli/roots.ts` — load the ledger and the dirty set, pass `historyDeps`,
  keep `computeDirtyHash`'s `.yggdrasil/roots/**` exclusion (`:170-181`) exactly as it is.
- Modify the landed expectation pins: `tests/unit/roots/golden*.test.ts`,
  `tests/unit/cli/roots.test.ts:223-226` and `tests/unit/roots/mine.test.ts:471-477` — both
  ranges run one line further than a quick read suggests (`debtPerInstance` is the last key in
  each, at `:226` and `:477`), and a leftover key becomes a TypeScript excess-property error the
  moment D9 removes it from the type.
- Replace `tests/unit/roots/golden-controls.test.ts`'s part-(a) control (`:191-213`) with the
  four controls of Step 6 below (two degraded-mode, one positive, one merge-HEAD); part (b) of
  that file is untouched.
- Create `source/cli/tests/unit/roots/history-join.test.ts` and
  `tests/unit/roots/golden-history.test.ts`.

**Steps.**
- [ ] **Step 1: The join.** `buildHistoryJoin` runs the walk, feeds every commit to the replay and
  the co-change accumulator, reads blobs through T4's cache in batches, and returns the finished
  products. **The clock and `headSha` come from T2's `readHead`, never from the walk.** The walk
  is `--no-merges`, so when HEAD is a merge commit — the common case on any repository that
  merges PRs, this one included at dogfood time — the walk's last record is neither HEAD's sha
  nor HEAD's timestamp, while §13.4 is categorical that the clock is HEAD's committer timestamp,
  full stop (`v6-spec.md:618`). The two readers must still agree to the second, and a test
  asserts that across representations rather than trusting either: the header's `clock` is a
  strict ISO-8601 string from `git log -1 --format=%cI` (`utils/git.ts:100-110`; `stores.ts:82`
  types it `string | null`) while the weights take epoch seconds, so the assertion is
  `Date.parse(header.clock) / 1000 === readHead().committerTs`.
- [ ] **Step 2: Degraded modes (R4-I4).** No git repository, a **shallow** clone, or a walk that
  throws ⇒ `buildHistoryJoin` returns `undefined` and the pipeline keeps R1's constant weights and
  no AgeFn. The history-fed model fields are then **absent** (not zeroed) except `agentShare:
  null` (§18.4's `n/a`), and no fact is hook-eligible. One `debugWrite` per cause; the command
  reports the degradation to the user in plain terms at T10.
- [ ] **Step 3: Wire the weights.** `induceRoles` receives `baseWeight` (w_base — D7); `mine`
  receives `weightFn: baseWeight`, `surfaceWeightFn: surfaceWeight`, `ageFn: ageDays`,
  `hookShapedFn: isHookShaped`. Role-cell counts keep their `× (ambiguous ? 0.5 : 1)` factor over
  `surfaceWeight` (`mine.ts:326`), unchanged in shape.
- [ ] **Step 4: The model body.** At the **top level** add `historyStats` (D4), `cochange`
  (Appendix D's `{a,b,sup,conf}` rows, sorted), `agentShare`, and `aliases`
  (`integration-design.md:130`; the sorted canonical projection of D1's cache copy). **Inside
  each `partitions[]` entry**, beside the existing `moduleOfFile`, add `couplingByFile` and
  `couplingByModule` (`v6-spec.md:892`) — co-change itself stays repo-global (`:622`) and only
  the percentiles are projected per partition. Set `hookShapedConform` per fact from the members
  set and `isHookShaped`; remove the four coverage/debt keys with the D9 comment. Every added
  map/array is emitted in sorted order and numbers are formatted with the existing
  canonical-decimal helper (`mine-stages.ts:102`) wherever a weighted quantity is stored as a
  string. Iteration order becomes load-bearing here for the first time (R4-I16): with per-scope
  weights every `Σ w` is order-sensitive in the last ULP, and `bitsPerInstance`, `bitsSaved` and
  `share` are serialized as raw numbers, so every weighted accumulation must run over a
  deterministically ordered collection — never over a `Set`, a `Map` or an object assembled in
  incidental order.
- [ ] **Step 5: Re-derive the golden expectations.** With `w = 1.0` uniformly (D8), each golden's
  `n_eff` equals its `n_raw`. Work each moved expectation out **by hand from the spec's formulas
  first**, then compare with what the code produces; a fact that newly accepts must be explainable
  (`data_term` scaled by 1/0.3 against an unchanged index cost), and a fact that newly *fails* a
  MUST-mine assertion is a bug, not an expectation to loosen. **Every structural MUST-NOT-mine
  assertion must still hold unchanged**: tautologies, vacuous facts, placement on `_all`/dir
  cells, scope-level facts in the data golden, mining inside `*.test.*` files. If one flips,
  STOP and report — that is a defect, not a fixture update. One population must **not** move at
  all: `module`-kind units carry no lifecycle row, because their `relPath` is a directory (stated
  in T7 Step 1), so their `n_eff` is computed at `noLifecycleWeight` 0.3 before and after this
  change. Module-level expectations must therefore be **unchanged**; a module fact whose numbers
  move is a bug, not a re-derivation.
- [ ] **Step 6: Controls, replacing the old part (a).**
  **(i) No-git control:** build a golden, delete its `.git`, index ⇒ facts exist, every one
  `hookEligible: false`, `historyStats` absent, `agentShare: null`.
  **(ii) Shallow control:** clone a golden with `--depth 1` ⇒ same degraded shape (and *not* a
  half-history model computed from one commit).
  **(iii) Positive control:** the `history/` golden with its real history ⇒ at least one fact
  with `hookEligible: true` whose `nConformRaw`/`nTotalRaw` are the survived counts, not the raw
  counts.
  **(iv) Merge-HEAD control:** a scripted fixture repository (the same helper T2's merge case
  uses) whose HEAD **is** a merge commit indexes with the *merge's* committer timestamp as the
  clock and records the merge's sha as `lastIndexedSha` — neither of which a `--no-merges` walk
  can see, which is why both come from `readHead`.
  Part (b) of the landed control (the synthetic-AgeFn flip at the `mine` level) stays as it is,
  and acceptance 4 below explains why it, and not the no-git control, is where the
  "acceptance never reads survival" claim lives.
- [ ] **Step 7: Graph ritual + report**, including a `node scripts/prompt-headroom.mjs` reading
  after the `mine.ts` edits.

**Acceptance criteria.**
1. Every golden mines a non-empty field and the `history/` golden has ≥ 1 hook-eligible fact.
2. On the `history/` golden, a fact's `nTotalRaw` is strictly less than the number of accepted
   instances wherever any instance is younger than 14 days at the clock — the survived population
   is visibly not the raw one.
3. A hand-planted `ledger.jsonl` mark on a conforming scope's (stable_id, surface) drops that
   fact's `nConformRaw` by one and raises `hookShapedConform` to one, and the fact's weighted
   count drops by `base − 0.15`.
4. Holding the weights fixed and toggling **only** the AgeFn, the accepted set is unchanged
   while every fact's `hookEligible` flips — acceptance never reads survival (§9.4a vs §9.4c).
   That is the landed `golden-controls.test.ts` part (b), which stays. The **no-git** control
   asserts something deliberately weaker: facts still exist, and **every** one is
   `hookEligible: false`. It makes no claim about *which* facts are accepted, because deleting
   `.git` removes the weights as well as survival — every instance drops from `w = 1.0` (D8) to
   `noLifecycleWeight` 0.3 (`v6-spec.md:375`), and acceptance is
   `bits_saved = data_term − param_cost − index_cost ≥ acceptMarginBits ∧ n_raw ≥ 5 ∧ n_eff ≥ 3`
   (`:395`), where `data_term` scales roughly linearly in `n_eff`, `param_cost` only
   logarithmically, `index_cost` (`log2 C₂`) not at all, and `n_eff ≥ 3` needs `n_raw ≥ 10` at
   w = 0.3 against `n_raw ≥ 3` at w = 1.0. Facts legitimately drop; asserting they do not would
   pin a falsehood, and Step 5 says the same thing from the other side.
5. `model.json` carries no `coverageRole`/`coverageAll`/`debtBits`/`debtPerInstance` key.
6. Two consecutive `runRootsIndex` calls on the same golden return deep-equal bodies (R4-I1).

**Test obligations / mutation round-trips.**
- **MR-22 (per-surface weight):** revert `surfaceWeightFn` to a per-scope weight ⇒ acceptance 3's
  weighted-count half fails.
- **MR-23 (hook-shaped exclusion):** stop excluding unreleased marks from the survived population
  ⇒ acceptance 3's `nConformRaw` half fails.
- **MR-24 (fail-closed):** make `survivedOf` default true when no AgeFn is present (the
  prototype's inversion) ⇒ the no-git control fails.
- **MR-25 (clock):** take the clock from `Date.now()` or from `max(lastModified)` ⇒ acceptance 6
  and the header-equality test fail.
- **MR-30 (`role_lift`'s divisor stays `w_base`):** route `computeRoleLiftForPartition`'s
  `nEff += weightOf(u.stableId)` (`mine.ts:497`) through the surface-aware weight instead of the
  per-scope `w_base` ⇒ a test pinning `role_lift` on a partition holding exactly one unreleased
  ledger mark fails: the capped 0.15 shrinks the divisor and inflates the lift, which is the
  §8.10 corruption a wholesale `weightOf` widening would introduce silently.

**NON-goals.** No verdict, message, session, telemetry or demotion surface. No trends, cohorts,
nucleation, calibration, τ_c, DENY. No `report`, no `where`, no `spectrum`. No coverage/debt
computation. No promotion.

---

## Task 9 — Incremental index: resume, the build lock, `--full`, and the determinism suite

**Scope.** Make the second index cheap and prove it is identical. This is where R4-I2, R4-I3 and
R4-I12 are actually earned.

**Authorities.** Spec §6.6 (`v6-spec.md:254-262`), §13.1's resumption requirement (`:602`), §4.4's
lock (`:139`), §20.2 (`:713`), §22.2's property list (`:728`); program plan's resume clause
(`:76-77`); design §3's `index [--full]` row (`integration-design.md:79`), §4's writer
concurrency (`:160-163`); Increment 2's recorded lock deferral
(`2026-08-18-increment-2-roots-core.md:1296-1298`); D2, D3 above.

**Files.**
- Modify `source/cli/src/roots/history.ts` — state load/save, `inputsHash`, the full-walk
  decision function `decideWalkMode(...)` (pure and separately unit-tested: `--full`, no state,
  schema mismatch, inputs mismatch, unreachable sha, windowing ⇒ `full`; else `resume`).
- Modify `source/cli/src/cli/roots.ts` — `--full` flag; acquire/release the build lock around the
  whole index; write `lastIndexedSha` into the header; progress rendering (D12).
- Modify `source/cli/src/roots/stores.ts` — nothing new expected; confirm.
- Modify `tests/e2e/cli-roots-basic.test.ts:64` and `:104-116` (the landed double-`index` case,
  which becomes the incremental byte-identity case) and `tests/unit/cli/roots.test.ts:177-203`
  (`lastIndexedSha` pins).
- Create `source/cli/tests/unit/roots/history-resume.test.ts` and
  `tests/e2e/cli-roots-incremental.test.ts`.

**Steps.**
- [ ] **Step 1: `inputsHash`, the walk decision, and the no-op short-circuit.** The walk decision
  is exactly D2's, with a unit test per trigger. A resumed walk that produces a state whose
  `lastIndexedSha` is not HEAD is a bug, not a fallback — assert it. Before any of that, D13's
  short-circuit: `index` computes the header's full input tuple first, and an unchanged tuple
  ends the run with "already current" and **zero writes**.
- [ ] **Step 2: Lock the writer.** `index` acquires `.cache/.build.lock` before the first write
  and releases it in a `finally`. A held fresh lock is **waited on for the bounded window T1's
  `acquireBuildLock` implements, and only then refused**, with a what/why/next message naming the
  holding pid (`buildIssueMessage` — the command formats, the store returns data): §4.4's binding
  clause is "wait briefly, then fail" (`v6-spec.md:139`; design `:160-163`), and a run that
  refuses instantly implements half of it. A holder that releases inside the window is waited out
  and the second run proceeds normally. `status` never takes the lock.
- [ ] **Step 3: `--full`.** Documented as the determinism reference (`integration-design.md:79`):
  it forces the walk and, per §6.6, is what an adopter runs after a merge conflict on
  `model.json`. It also bypasses D13's no-op short-circuit — an explicit `--full` always
  recomputes and rewrites, which is what makes it usable as the reference.
- [ ] **Step 4: Progress (D12).** When the count of *uncached* blobs projects past 60 s at the
  spec's ≈ 12 ms/blob (`v6-spec.md:602`, `:712`), print one line to stderr with the blob count and
  the ETA, then an update every 500 blobs. Nothing reaches the model.
- [ ] **Step 5: The determinism suite** — the increment's centerpiece:
  (a) **double `--full`** on one tree ⇒ byte-identical `model.json`, header included. The landed
  cross-process case (`tests/e2e/cli-roots-basic.test.ts:104-116`) runs plain `index` twice,
  which after this task *resumes*; it survives as the **incremental** byte-identity case, and a
  new `--full`-twice case is added beside it;
  (b) **incremental ≡ full**: index the `history/` golden at commit N, append two **prescribed**
  commits with the deterministic fixture, index again (resume), then index a *fresh clone* of the
  same tree with `--full` ⇒ byte-identical `model.json` **and** byte-identical replay state. The
  two commits are prescribed because two commits that merely add a new file exercise none of the
  quantities a resume carries. **Commit N+1** adds a decorator to an existing scope with **no
  body change** — a change event whose detection is impossible without the reloaded
  `prevstate.jsonl`, and which a resumed walk lacking it reports as an introduction instead.
  **Commit N+2** re-touches an already-supported co-change pair — proving the raw supports and
  the per-file commit counts survived the run boundary, so `support` and `confidence` match the
  full walk — **and** renames a tracked file in the same commit, proving the alias chain and the
  per-file appearance counters carried too. Delete any one of `prevstate.jsonl`,
  `cochange-raw.jsonl`'s supports, its per-file commit counts, or `meta.json`'s appearance
  counters, and this case fails;
  (c) **cache-state independence**: delete `.cache/` entirely, re-index ⇒ byte-identical
  `model.json` (and zero blobs parsed on a warm run, asserted through the parse counter). The
  deleted cache is a pending rebuild, so D13's short-circuit does not fire here — the run really
  does re-walk and re-parse, and the model still comes out byte-identical;
  (d) **unreachable SHA**: hand-edit the state's `lastIndexedSha` to a well-formed but absent sha
  ⇒ the run falls back to a full walk and the model is byte-identical to (a)'s;
  (e) **inputs mismatch**: bump `EXTRACTOR_VERSION` in a copy of the state's `inputsHash` inputs ⇒
  full walk, same model;
  (f) **hostile state**: truncate `events.jsonl` mid-line ⇒ full walk, same model, one debug line,
  no crash;
  (g) **merge HEAD**: a fixture repository whose HEAD is a merge commit indexes, records the
  merge's sha as `lastIndexedSha`, and a second `index` resumes from that sha — walking
  `<merge>..HEAD`, i.e. nothing — rather than re-walking. The `--no-merges` walk never names that
  sha, so only `readHead` can supply it, and a resume anchored on the last non-merge commit would
  silently re-apply commits already replayed.
- [ ] **Step 6: Graph ritual + report.**

**Acceptance criteria.**
1. All seven determinism cases green, each asserting *byte* identity of the file, not a
   deep-equal of a parsed object.
2. A second `yg roots index` on an unchanged tree parses zero blobs, walks zero commits and —
   per D13 and §6.6's clause 6 (`v6-spec.md:260`) — **writes nothing at all**: `model.json`'s
   bytes *and* its mtime are unchanged, and no state or cache file is rewritten. The run says
   "already current" in plain terms and exits 0.
3. `yg roots index --full` on the same tree produces the same bytes as the incremental run.
4. Two concurrent `index` runs: the second waits up to the bounded window and only then exits
   non-zero with a message naming the holder's pid, and the first's model is intact. A holder
   that releases inside the window yields the lock and the second run proceeds — that half is the
   killer case for the wait branch.
5. The header's `lastIndexedSha` equals `readHead().sha` after any successful index in a git
   repo — including when HEAD is a merge commit, which the walk itself never reports — and stays
   `null` in a non-git repo.

**Test obligations / mutation round-trips.**
- **MR-26 (reachability check):** delete the unreachable-SHA branch ⇒ case (d) fails (the resumed
  walk errors or silently walks nothing).
- **MR-27 (inputsHash):** drop `EXTRACTOR_VERSION` from `inputsHash` ⇒ case (e) fails.
- **MR-28 (build lock, both halves):** stop acquiring the lock ⇒ acceptance 4's refusal half
  fails; make `acquireBuildLock` refuse immediately instead of retrying until `waitMs` elapses ⇒
  acceptance 4's second half fails, because a lock released inside the window is wrongly
  refused.
- **MR-29 (windowing/resume interlock, D3):** allow resume while `maxCommits > 0` ⇒ a test that
  indexes with a cap, appends commits, re-indexes, and compares against a fresh capped `--full`
  run fails.

**NON-goals.** No daemon, no socket, no background reindex (excluded by design §9). No git-hook
installer (`--git` is R8's). No `reset` command (R8).

---

## Task 10 — Status, docs, changelog, dogfood measurement

**Scope.** Make what R4 changed visible and true everywhere it is described, and measure the real
cost on this repository.

**Authorities.** Design §3's `status` row (`integration-design.md:84`) and §14 documentation
(`:519-530`); spec §19's `status` line (`v6-spec.md:697`), §13.1's windowing-visibility rule
(`:599`); AGENTS.md's doc-consistency rule and changelog policy; current doc text:
`docs/roots.md:42-46`, `:68-70`, `docs/configuration.md:372-373`, `:553-616`,
`src/templates/knowledge/configuration.ts:347-348`,
`src/templates/knowledge/onboarding.ts:333`.

**Files.**
- Modify `source/cli/src/cli/roots.ts` — `status` gains an honest history block.
- Modify `docs/roots.md`, `docs/configuration.md`,
  `source/cli/src/templates/knowledge/configuration.ts`,
  `source/cli/src/templates/knowledge/onboarding.ts`.
- Modify `CHANGELOG.md`.
- Modify `source/cli/tests/e2e/cli-roots-basic.test.ts` (status assertions) and
  `tests/unit/cli/roots.test.ts` (the `renderRootsStatus` cases).

**Steps.**
- [ ] **Step 1: `status`'s history block** — still always exit 0, still no `--exit-code` and no
  `--diagnose` (R7's). It reports, in plain user terms (no internal vocabulary — design §11):
  how much history the last index read (commits, distinct files parsed from history), how far
  behind HEAD the index is (`git rev-list --count <lastIndexedSha>..HEAD`, failing soft to
  silence), whether the repository has no history or is a shallow clone and what that costs
  ("nothing is counted as established yet, so nothing is reported as a convention"), and whether
  history windowing is active (`v6-spec.md:599` requires this to be visible).
- [ ] **Step 2: `docs/roots.md`.** Four true-ups, each currently false or about to be:
  `:42-46`'s "nothing is inherited across runs" (now: incremental by default, `--full` forces the
  walk, a re-index parses only new code); `:68-69`'s ledger row (now: marks, when they exist,
  reduce a pattern's evidence rather than merely being hashed); `:70`'s `.cache/`/`.state/` row
  (now: `.cache/` holds the rebuildable history and blob caches and is safe to delete; `.state/`
  is still unwritten); and a new section on what history changes for the reader — that a pattern's
  evidence is now what has *stood*, that fresh code is discounted, and that a repository with no
  git history or a shallow CI clone reports no established conventions at all, on purpose. The
  "What's not here yet" list (`:79-88`) stays: R4 adds no speech, no gate, no promotion.
- [ ] **Step 3: `docs/configuration.md` + the knowledge templates.** **Two** copies make the
  "nothing writes it yet" claim about `roots/.cache/` — `docs/configuration.md:372-373` and
  `src/templates/knowledge/configuration.ts:347-348` — and both are now false for `.cache/` while
  staying true for `.state/`. Fix both, against the source constant rather than the one you
  noticed first. `src/templates/knowledge/onboarding.ts:333` is a bare gitignore list that makes
  no such claim: check it, and leave it alone if it only lists the path. In the `roots:` section
  (`:553-616`), the `history` row's "How much git history is walked, and its safety caps" gains
  the operative fact: the default walks everything, once, and caching makes later runs cheap; a window or a cap is an
  emergency setting that changes what is mined and is reported by `yg roots status`.
- [ ] **Step 4: CHANGELOG** — the single entry drafted at T8 is amended in place here, never
  joined by a second one. One entry under `## [Unreleased]`, release-notes voice, describing
  the adopter-visible change: mined conventions are now weighted by how long code has stood and
  who wrote it; a re-index is incremental; `--full` exists and is the reference; `status` reports
  history and honestly says when a repository (or a shallow CI clone) has no established history.
  Not a work log: one entry for the increment, no per-task lines, no method notes.
- [ ] **Step 5: Dogfood measurement (report only).** Run the built binary against a *copy* of this
  repository with a temporary `roots:` block — cold and warm — and record: walk seconds, distinct
  blobs, ms/blob against §20.1's ≤ 15 ms budget, warm-run parse count, model size, and whether
  the mined field looks sane. **Do not commit a `roots:` block, a `model.json`, or any cache into
  this repository** — enabling the dogfood is the maintainer's call (Open Question 2). Report the
  numbers.
- [ ] **Step 6: Docs build + markdownlint + graph ritual + report.** No digest regeneration:
  R4 edits neither `templates/rules.ts` nor `templates/digest.ts`, so the digest gate has nothing
  to re-run (state that in the report so the omission reads as scoped).

**Acceptance criteria.**
1. Every claim in `docs/roots.md` and `docs/configuration.md` is verified against the built
   binary's actual behavior, not against this plan.
2. `yg roots status` on a no-history repo, a shallow clone, a windowed config and a normal repo
   each print a distinct, honest paragraph and exit 0.
3. `npm run docs:build` and markdownlint pass; the docs node's `docs-internal-links` aspect is
   satisfied (link only to pages that exist).
4. No `.yggdrasil/roots/` directory and no `roots:` block are added to this repository.

**NON-goals.** The per-command CLI-reference entries and the roots knowledge topics stay R9's
(`plugin-marketplace-plan.md:131`); the `roots-model` schema doc stays R9's too (Increment 2
recorded that boundary). Say so in the report.

---

## Increment-wide NON-goals (R5/R6 material that must not leak in)

Naming them so a reviewer can reject them on sight:

- **R5 — verdict, speech, telemetry.** No `yg roots check`, no channel table, no Δ gates, no
  severity, no verbalizer, no budgets, no dedup, no session state, no `telemetry.jsonl`, no
  `demotions.json`, no compliance closure, no ledger *writing*, no incidents store. R4 reads a
  ledger that is empty until R5 writes it — that is the whole of the relationship.
- **R6 — trends, calibration, DENY.** No trend windows, no cohort trends, no nucleation, no
  attractor, no `calibrate`, no τ_c, no Wilson bounds, no `permissionDecision`. R4 *produces*
  value events and stops; nothing in this increment reads one.
- **R7 — inquiry and reporting.** No `where`, `spectrum`, `report`, `explain`; no coverage/debt
  computation (D9); no `status --exit-code`/`--diagnose`.
- **R8 — promotion and steering.** No `promote`, no advise nomination class, no `seed add`, no
  `mute`, no `reset`, no `hooks install`, no `--git` trigger.
- **R9/R10.** No `rules.ts`/`digest.ts` roots section, no `yg check` informational line, no
  knowledge topics, no schema-doc entry, no mutation harness, no seven remaining code-grammar
  goldens, no big-corpus sweep, no new repo-check step.
- **Excluded by design, permanently.** No daemon or socket (`integration-design.md:364-383`), no
  `check --exit-code`, no `scaffold`, no recognizer pack, no `EXT2GRAMMAR` of roots' own.

---

## CHANGELOG policy

One entry, under `## [Unreleased]`, in release-notes voice, covering the increment's
adopter-visible surface: history-weighted mining, incremental re-index with `--full` as the
reference, honest reporting when a repository has no usable history. Tasks 1–9 are internal
stages of that one change and get no entries of their own — per-task entries would be a work log,
which AGENTS.md's changelog rules forbid. Timing, since T8 and T9 land adopter-visible behavior
in their own gated commits several commits ahead of T10: the entry is **drafted at T8**, the
first task whose commit changes what an adopter sees, and **amended in place at T10** when
`status` and the docs land. That satisfies AGENTS.md's "every code or behavior change gets an
entry … as part of normal work" at the commit that makes the change, while keeping the
one-entry-per-change rule. No second entry is ever added. The existing R1–R3 entry is left as it
stands (it says "reading and reporting only", which R4 does not falsify); if any sentence in it
becomes untrue, correct that sentence in the same commit rather than adding a contradicting
entry.

---

## Execution protocol

- **Order is strict T1 → T10.** T4–T8 are the port core and may not overlap: each consumes the
  previous task's landed shapes. T3 must land before T5, since T5's acceptance criteria are
  written against the `history/` golden.
- **The SDD loop, per task:** a fresh Sonnet implementer implements the task from this plan plus
  the repository alone; an Opus reviewer reviews it against the task's acceptance criteria,
  invariants and cited authorities; the implementer fixes; the controller runs the gate
  (`scripts/repo-check.sh`, backgrounded), commits once, and pushes. Implementers do not commit
  and do not run the full gate.
- **The reviewer's standing questions**, every task: did the implementer actually read the cited
  spec sections (do the formulas match the spec, or the prototype's simplification)? Does every
  load-bearing rule have a test that fails when the rule is deleted, and did the implementer run
  that deletion live and report the failure (R4-I15)? Did anything R5/R6-shaped leak in? Did the
  graph ritual happen (mappings, relations, log entries) and does `check --approve` end
  `PASS (1 warning)`? And for T8 specifically: is every weighted accumulation taken over a
  deterministically ordered collection, with no `Σ w` over a `Set`, a `Map` or an object built in
  incidental order (R4-I16)?
- **Plan perfection criterion:** two consecutive clean reviews of this document before execution
  starts, the same bar the previous increments used.
- **STOP conditions** (report, do not improvise): an architecture edit appears necessary; a golden
  fails a *structural* MUST-NOT-mine assertion after the weight change; a determinism case cannot
  be made to pass without weakening the assertion; a spec section contradicts a decision D1–D14
  in a way this plan did not anticipate.

---

## Open questions for the maintainer

Only genuinely owner-gated items are listed. Each states a default so execution is never blocked
waiting for an answer.

1. **Architecture edits — confirmation, not a request.** The verification in Task 1 Step 1 is
   expected to show that R4 needs **no** `yg-architecture.yaml` change. If it does not, execution
   stops and the controller presents the minimal dictated block for approval before continuing.
   *Default: proceed on the expectation that no edit is needed.*

2. **Dogfood: enable roots on this repository now, or later?** R4 makes the mined field
   meaningful here for the first time (this repo has real history), and design §15's phase-1
   definition of done includes "dogfood on this repo mines a field"
   (`integration-design.md:546-547`). But enabling it commits a `roots:` block and a generated
   `model.json` that moves on every index of a moving repository — design's own risk 4
   (`:570-573`) — and there is still nothing that *speaks*, so the committed artifact would buy
   observation only. *Recommendation and default: measure at Task 10 and report the numbers, but
   commit nothing; revisit at R5, when the model starts paying for itself through the check path.*

3. **A design-document true-up, for the record.** Decision D1 resolves `.cache/`'s contents in
   favour of the spec's own §4.4 layout (`v6-spec.md:126-131` — `lifecycle.json`, `aliases.json`,
   `cochange.json` beside `blobs/`) over the integration design's narrower parenthetical
   ("`.cache/` — gitignored — blob cache only (content-addressed, sharded 2-hex), plus
   `.build.lock`", `integration-design.md:134-135`). The two are reconcilable — the design is
   under-enumerating, and store internals are the spec's authority by the design's own preamble
   (`:6-8`) — so nothing is blocked. *Question: do you want the design document's line amended to
   match what ships, or is the decision recorded here sufficient? Default: recorded here; T10's
   docs pass makes the adopter-facing description accurate either way.*

---

## Self-review

Reviewed end to end once before finishing. What that pass changed:

- **Caught the golden-collapse trap.** The first draft wired real weights (T8) against the landed
  goldens unchanged. Working the arithmetic out by hand showed that a golden whose every file is
  written in HEAD's own commit has `stable_days = 0` ⇒ `w_surv = 0` ⇒ every instance pinned at
  `baseFloor` 0.05 and nothing survived — every MUST-mine assertion would have failed vacuously
  and read as a product bug. That produced decision D8 and moved the fixture work forward into its
  own task (T3) so the expectation churn is isolated in exactly one place (T8).
- **Fixed a mutation round-trip that would not have killed anything.** MR-18 was originally "move
  the ledger cap before the floor"; worked through, both orders give 0.15 on the ordinary row, so
  the test would have passed either way. Replaced it with the *degraded-branch* case
  (`noLifecycleWeight` 0.3 with a mark present: 0.15 cap-last vs 0.3 otherwise), which is the case
  the spec's own "degraded modes cannot bypass it" clause exists for.
- **Resolved, rather than deferred, the `historyStats` contradiction.** Appendix D's `parsed`/`mb`
  read naturally as "what this run did", which would break byte-identity across cache states — the
  very property the same document claims as measured. D4 defines all five fields as properties of
  the history and sends run diagnostics to stderr.
- **Turned the file-naming detail into a first-class constraint.** `src/io/roots-blob-cache.ts`
  classifies only because `persistence-adapter`'s `when:` lists `*-cache.ts`; a name like
  `roots-build-lock.ts` would have produced a blocking unmapped-file finding and an unauthorized
  architecture edit mid-increment. It is now stated in the authorization section, not buried.
- **Removed a false claim about `.state/`.** An earlier draft's doc true-up said both derived
  directories become live; only `.cache/` does. `.state/` stays unwritten until R5.
- **Added the coverage/debt honesty decision (D9)**, which the first draft silently left as
  literal zeros — a value that stops being true the moment any fact is hook-eligible.
- Verified every code anchor cited here against the tree (`pipeline.ts:161`, `mine.ts:75/171/854`,
  `mine-stages.ts:189`, `stores.ts:143/211/239`, `cli/roots.ts:170/208/332`, `utils/git.ts:81-142`,
  `extract.ts:185/399`, `enumerate.ts:58`, `roles.ts:497`) and every pin R4 moves
  (`cli-roots-basic.test.ts:64`, `:104-116`, `unit/cli/roots.test.ts:177-226`,
  `mine.test.ts:471-477`, `golden-controls.test.ts:191-213`).
