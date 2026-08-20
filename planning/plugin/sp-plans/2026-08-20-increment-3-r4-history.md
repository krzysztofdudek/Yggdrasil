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
| `src/utils/git-history.ts` | `utility` — `when: path: "source/cli/src/utils/*.ts"` (`:359`) | roots-engine → utility is an allowed `calls` edge; `utils/git.ts` already spawns git under the same type's `no-direct-fs` aspect (that aspect bans `node:fs`, not `node:child_process`). **Outbound is the tighter half of this row:** `utility`'s own relations are `calls: [utility]`, `uses: [types]`, `default: deny` (`yg-architecture.yaml:369-372`; `parents:` is the line above, at
`:368`), so this file may import other `src/utils/*.ts` helpers and types and **nothing else under `src/`** — not `io/hash.ts`, not `io/read-or-default.ts`. It needs neither: `debugWrite` is itself a utility (`src/utils/debug-log.ts:73`), and `createHash` comes straight from `node:crypto`, exactly as `io/lock-store.ts`, `ast/parser.ts` and `relations/facts-cache.ts` already use it. Reaching for `hashString` instead would trip a blocking relation finding |
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
  is itself byte-identical between the two paths. This holds **by construction, not by luck about
  the order git hands commits over**: every replay-visible quantity is defined as a function of
  the *set* of walked commit records, with ties broken deterministically (D16). A resume walks
  `lastIndexedSha..HEAD`, which is the set difference between the full walk's commit set and the
  set the previous run already applied — so the union of what the two runs applied is exactly the
  full walk's set, whatever relative order either run received it in. The older, wrong formulation
  — "the resume range is a suffix of the full walk's order" — is empirically false and is what
  D16 replaces. *(T5, T9)*
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
  from the extension recorded in the walk for that blob's path at that commit — and for a rename
  that is *its own* path: the pre-image blob's grammar comes from the old path, the post-image
  blob's from the new one. Content sniffing is forbidden (`v6-spec.md:606`, `:226`). *(T4, T8)*
- **R4-I7 — One key space.** Historical scope keys carry the same occurrence ordinals as live
  ones, so the live↔historical join is collision-free (`v6-spec.md:247`). The join key is
  `skeyR` (`relPath#kind#qualifiedName`, ordinal inside `qualifiedName` —
  `src/roots/extract.ts:185`), never `stable_id` (partition-dependent, and partitions move over
  history). *(T5)*
- **R4-I8 — Each distinct blob parsed at most once, ever.** Per `(blobSha, extractorVersion,
  bindingHash)` (`v6-spec.md:604-605`). A warm run parses zero blobs. *(T4)*
- **R4-I9 — Advisory only.** No verdict, no speech, no telemetry, no DENY, no gate. `yg roots
  index` exits 0 except on real I/O/config errors — and a build lock another index still holds when
  the bounded wait window elapses is one of them, the single new non-zero exit R4 adds (T1, T9):
  refusing to write over a concurrent run is a genuine problem, not an advisory verdict; `yg roots
  status` always exits 0
  (`integration-design.md:79`, `:84`; `v6-spec.md:706`). No `yg check`/`yg context` output
  changes. *(every task; the Increment-2 dormancy pin re-runs in each)*
- **R4-I10 — Degrade, never abort.** A blob that fails to parse is recorded empty and the walk
  continues; a corrupt cache/state entry is a miss and is rebuilt; git unavailable is a degraded
  mode, not a failure (`v6-spec.md:719`). Every such degradation writes one `debugWrite` line —
  never a silent swallow (the `diagnostic-logging` convention). The rule is symmetric across reads
  and **writes**, which no task otherwise states: a write that fails on a cache or state file
  (EACCES, ENOSPC, a read-only volume) is one `debugWrite` and the run continues — `model.json`
  still lands, and the next run simply finds a rebuild pending — while a failed `model.json` write
  is a real error the command reports and exits non-zero on. Derived state may be lost; the product
  may never be lost silently. *(T1, T2, T4, T8)*
- **R4-I11 — Derived state stays derived.** Everything R4 writes beyond `model.json` lives under
  `.yggdrasil/roots/.cache/`, is gitignored, and is safe to delete at any moment (AGENTS.md's
  local-state rule; design `:134-135`). R4 writes no committed store other than `model.json`.
  *(T1, T4, T9)*
- **R4-I12 — Single writer.** Every writer (`index` today; `calibrate`/`promote` later) takes the
  exclusive `.cache/.build.lock`; readers (`status`, and every later read surface) never take it
  and read through `model.json`'s atomic rename (`v6-spec.md:139`;
  `integration-design.md:160-163`). **A reader may also read the replay state directory, and the
  rule for that is stated here because "never take the lock" alone does not cover it:** the read is
  **best-effort**. A state that is absent, unreadable, mid-rewrite or epoch-inconsistent is reported
  as **"unknown"** in whatever the reader was going to say, never as an error and never as a
  fabricated number — so T10's `status` block, which reports how far behind HEAD the index is from
  `meta.json`'s `lastIndexedSha`, simply omits that line when the state does not read cleanly.
  `status` still exits 0 (R4-I9). *(T9, T10)*
- **R4-I13 — Config verbatim.** R4 invents no config key. `history.*`, `weights.*`, `cochange.*`
  and `ledger.*` are **declared** as types in `src/model/graph.ts:131-203` and **parsed with the
  spec's defaults** in `src/io/config-parser.ts:44-113` — the parser is where a default is
  checkable, and it is the file T3, T6 and T7 already cite for every number they derive
  (`v6-spec.md:148-188`). Defaults stay uncapped: `history.full: true`, `maxCommits: 0`. *(T2, T6,
  T7)*
- **R4-I14 — One parser path, one registry.** Historical blobs parse through `withParsedFile`
  and grammars resolve through `utils/language-registry.ts` only. No `Parser.init`, no
  `Language.load`, no extension→grammar table under `src/roots/**` or `src/utils/git-history.ts`.
  The genericity ESLint rule (`source/cli/eslint.config.js`) stays green. *(every task)*
- **R4-I15 — Every load-bearing rule has a killer test.** For each rule this plan names as
  load-bearing there is a test that FAILS when the rule alone is deleted, and the implementer
  demonstrates that by actually deleting it, running the test, and restoring (the live mutation
  round-trips MR-1…MR-35, named per task below). A rule with no killer test is not done. *(every task)*
- **R4-I16 — Deterministically ordered accumulation.** Every weighted accumulation iterates in a
  **deterministic order**. A `Set` or a `Map` qualifies when its own insertion order is
  deterministic — JS iterates both in insertion order — and fails only when it was assembled from
  an incidentally ordered source. The rule is about the order, never about the container type, and
  T8 discharges it by **naming every accumulation site together with the ordered source its order
  derives from**. The three sites that exist today all already qualify:
  `countRealInstancesIntoCell`'s `memberIds` (`src/roots/mine-stages.ts:189-216`), whose `Set` is
  built from an ordered member array at each of the **three** cell constructions that call it — the
  `unitsByKind` array at `mine.ts:290`, the `roleMembers` array at `:329` (built at `:323` as
  `[...confidentMembers, ...ambiguousMembers]`, both filtered from the ordered `members`), and the
  `dirMembersByKindDir` array at `:356`
  (the directory cell, which T8's Files list also names, so the two lists match);
  `computeRoleLiftForPartition`'s loop over the `partitionUnits` array (`mine.ts:492-498`); and
  `addCount`'s per-value `Map`s, keyed in first-observation order under those same loops. None of
  them needs materialising or re-sorting — that would be an unbudgeted O(n log n) per cell against
  §20.1 — and an invariant read as "no `Set`, ever" would demand exactly that against code whose
  determinism is already fine. Under R1–R3 every weight was the identical constant 0.3, so
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
  **`appendFileSync`**/`createWriteStream` imported from `node:fs` in any `src/io/*.ts` — see the
  build lock's `openSync(path, 'wx')` spelling in T1; `appendFileSync` is on the banned list too
  and is the obvious reach for a JSONL writer, so read the aspect's own `RAW_WRITE_FNS` before
  reaching for any append), and `silent-missing-files` (an LLM aspect, judged per file). Satisfy them all by construction, not by retrofit.
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

## Decisions taken in this plan (D1–D17)

Each resolves something the authorities leave under-determined, or reconciles two of them. A
task may not re-litigate one; a task that finds a decision *wrong* stops and reports.

- **D1 — Where the replay state lives, and everything a resume must carry.** The design's
  storage sketch calls `.cache/` "blob cache only … plus `.build.lock`"
  (`integration-design.md:134-135`), but the spec's §4.4 store layout puts `lifecycle.json`,
  `aliases.json` and `cochange.json` in the same gitignored cache beside `blobs/`
  (`v6-spec.md:126-131`), and §6.6's resume clause only works if that state persists (`:257`).
  Store internals are mechanism, where the spec wins (`integration-design.md:6-8`). R4 therefore
  writes `.yggdrasil/roots/.cache/history/` — all gitignored, all rebuildable, all canonical so
  the state itself is byte-comparable (R4-I2). It holds every quantity the replay **accumulates**;
  a resume that reconstructs only the finished products is not a resume, it is a different
  computation:
  - `lifecycle.jsonl`, `events.jsonl`, `aliases.jsonl` — the replay's **accumulators**: raw rows,
    raw events and raw rename **edges**, each keyed on the path the walk recorded, none of them
    resolved, merged or compressed. The finished products a consumer sees — alias-resolved
    lifecycle rows, the sorted event list, the compressed alias map — are derived at `finishReplay`
    from these three and are never persisted, exactly as the co-change cut is derived from
    `cochange-raw.jsonl` below. Persisting the *resolved* form instead would leave a later run's
    rename unable to re-fold rows an earlier run had already merged.
  - There is deliberately **no** carried previous-value state — no `prevstate.jsonl`. §13.3's
    "replay against `prevState[path]`" (`v6-spec.md:610`) reads as a running map, but a running map
    is wrong on any merged history whatever order the walk uses, and it is what made a resumed walk
    disagree with a full one. Each file record carries its own pre-image blob sha, so "the previous
    blob" is available **per record** with nothing carried at all (D16). That is why this state is
    six files and not seven.
  - `cochange-raw.jsonl` — every pair's **raw** support together with the per-file commit counts
    `confidence(a→b) = support(a,b)/commits(a)` needs over the whole history (`v6-spec.md:622`),
    **uncut and unfiltered**. The `minSupport`/`minConfidence` filter and the `maxPairs` cut are
    applied at `finishCochange`, never at persist time: a pair sitting at support 7 must still be
    able to reach 8 on a later run, and a pair below the 5000-pair cut today may belong in the
    set tomorrow. The cut set is a **derived output, never state**.
  - `cochange.jsonl` — the cut set as last emitted, epoch-carried like the other four JSONL files
    (it is the one of the five that is not an accumulator) and never read back into a replay. **Its reason is not "so `status` can describe the last index
    cheaply"** — T8 puts the same `{a,b,sup,conf}` rows at the **top level of `model.json`**, which
    `status` already reads, so that justification is falsified by this plan's own wiring. The
    honest reason it is written: it is the last-emitted **cut** kept beside the **raw** supports, so
    the state directory is self-describing — a reader can see what this state produced without
    holding the model — and so a torn state is detectable across all six files rather than five
    (D15). It is state in the epoch sense and an output in the data sense, and D1's
    raw-versus-derived rule is unaffected: nothing ever reads it back.
  - `meta.json` — the state schema version, the write run's `stateEpoch` (D15), `lastIndexedSha`,
    `inputsHash`, the **per-file walk-appearance counters** that `lifecycleMaxAppearances` 200
    (`v6-spec.md:615`) is tested
    against (a resumed walk that restarts the count demotes a different set of files to
    file-level than a full walk does, in both directions), the **running `historyStats`
    accumulators** and the **two rosters** they need — distinct blob SHAs for `blobs`, and distinct
    non-skipped **cache keys** with their `bytes` for `parsed`/`mb` (D4). Both rosters are fields of
    `meta.json`, not files of their own: the state is still six files.
    **`meta.json` therefore grows without bound with the history, and that is deliberate — no
    pruning rule exists, by design.** It carries one entry per distinct blob sha, one per distinct
    non-skipped cache key (64 hex characters plus a `bytes` integer) and one per distinct walked
    path, i.e. O(10⁴–10⁵) entries on a real repository, sorted and rewritten **whole** on every
    index. Pruning any of the three would make `blobs`, `parsed`, `mb` or the appearance counters a
    function of what a run happened to keep — precisely what R4-I2 and R4-I3 forbid on
    model-visible fields — so the size is the price of the invariant and is paid knowingly. T10
    Step 5 reports `meta.json`'s on-disk size and its write time beside the model size, so the
    price is measured on a real repository rather than assumed tolerable.
  R4-I2's byte-identity claim is a claim about all six files, not only about `model.json`, and
  D15 fixes how the six are committed as a **set** — six individually atomic writes are not a
  transaction. The design's parenthetical is under-enumerating, not contradicting; T10's doc pass
  says so where adopters read it.
- **D2 — Resume means resuming the *walk*, not just the parse.** `plugin-marketplace-plan.md:76`
  is binding: "resume from `lastIndexedSha` (full walk only on `--full` or unreachable SHA)". So
  a resumed index walks `lastIndexedSha..HEAD` only and applies those commits to the loaded
  replay state. The safety net is mechanical, not aspirational: **any** mismatch of the state's
  `inputsHash` (schema version ∥ extractor version ∥ the binding hashes of every registered
  grammar ∥ the canonical `history:`+`include`/`exclude` config subtree — `include`/`exclude`
  belong there because D17 makes them change the walk's product, not merely the live tree's), a
  missing or
  unparseable state, an unreachable `lastIndexedSha`, or `--full` forces a full walk. These
  additional triggers **widen, never narrow**, the full-walk set, so they are not a §6.8 descope
  of the binding "full walk only on `--full` or unreachable SHA"
  (`plugin-marketplace-plan.md:76-77`; `v6-spec.md:257`): that clause constrains what may cause a
  **resume**, and no trigger here suppresses a resume the clause requires — each one trades a
  cheap run for a correct one. R4-I2 is what proves the two paths agree.
  **One trigger is deliberately *not* on that list: "the resume range contains a commit older than
  `lastIndexedSha`".** That was the cheap way to paper over the ordering defect D16 records — force
  a full walk whenever a merged branch reorders the range — and it would have made the commonest
  git workflow re-walk the whole history on every merge, turning "resume" into a synonym for
  "sometimes". D16 removes the need for it instead: the replay does not care what order the range
  arrives in, so a merged older branch resumes like anything else. Do not add the trigger back.
  A `full` verdict **discards every loaded state file**: the walk starts from empty
  lifecycle/event/alias/co-change accumulators, zeroed appearance counters, an empty blob roster and
  zeroed `historyStats`
  accumulators, and the state directory is overwritten wholesale at the end of the run, never
  merged into what was there. That rule is not decoration. The three determinism cases that *begin*
  with a usable-looking state on disk — an unreachable `lastIndexedSha`, an inputs mismatch, a torn
  state (T9 (d), (e), (f)) — are precisely the paths a merging implementation would double-count
  on: doubled `modifications`, doubled `support`, doubled `historyStats` running sums, and a model
  that still looks plausible.
- **D3 — Windowing disables resume.** With `history.full: false` or `maxCommits > 0`, the walked
  set is a function of *when you run it*, so a resumed walk would silently mix two windows. Under
  either setting R4 always performs a full (windowed) walk and `status` reports that windowing is
  active (`v6-spec.md:599`, `:697`). Defaults are uncapped, so this path is opt-in-only.
- **D4 — `historyStats` carries only cache- and resume-independent numbers.** Appendix D shows
  `{commits, events, blobs, parsed, mb}` (`v6-spec.md:866`) while §20.2 and Appendix F's I2a row
  require byte-identity across cache states (`:713`, `:1002`, `:972`). Both hold only if none of
  the five is "what this run did". R4 defines them as properties of the *history*: `commits` =
  non-merge commits walked; `events` = the **raw** value events the fold emitted, counted **before**
  the appearance-cap demotion `finishReplay` applies (T5 Step 4a); `blobs` = distinct
  blob SHAs the walk **resolves** — **pre-image and post-image alike**, since D16 makes each record's
  own pre-image blob part of what the replay reads. **"Resolves" is the precise word, and it is not
  "keys": the two sets differ, and an earlier draft said they were the same.** What the walk
  resolves is the post-image and pre-image of every `A`/`M`/`R`/`C` record that survives D17's
  gate 1 — **whether or not that record's path is one R4 extracts**. A path carrying no registered
  grammar, or one `forParsing` excludes, is rostered straight off the walk record and is **never
  keyed, probed or fetched** (D11, D17, T8 Step 1), so the keyed set is a strict subset of `blobs`;
  building the roster from the keyed set instead would drop every non-code blob from a
  model-visible field. Not resolved at all, and so not rostered: the pre-image of a `D` record,
  which nothing reads.
  `parsed` = distinct **cache keys** whose blob record is not skipped; `mb` = MiB (floored) of the
  summed `bytes` of exactly those records.
  **Why `parsed` and `mb` are counted over the key and not over the sha, which is the one place the
  obvious formulation is order-sensitive.** Git blob SHAs are content-addressed and path-independent,
  so one sha routinely reaches two paths with different grammar verdicts — **every empty file in a
  repository shares the sha `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`** (verified), so an empty
  `src/foo.ts` (extracted ⇒ `skipped: false`) and an empty `NOTES.md` (no grammar ⇒ never keyed)
  are one sha with two verdicts; a `.ts`↔`.py` rename and any stub, licence header or generated
  file that exists at both a registered and an unregistered extension do the same. "The blob's
  first appearance in the roster decides" would then make `parsed` a function of **which path the
  walk handed over first**, which differs between a full walk and a resume — the exact residue D16
  exists to eliminate, on a model-visible field. Keying on the cache key removes the choice instead
  of tie-breaking it: a key is `(sha, extractorVersion, bindingHash)`, exactly one blob record
  answers to it, and `skipped`/`bytes` are therefore *functions of the key* with nothing to
  arbitrate. A consequence to expect rather than report as a bug: `parsed` may exceed `blobs` when
  one sha is extracted under two grammars (T4 acceptance 4's `.ts`/`.py` case at the record level,
  and T8 acceptance 8(c)'s `src/stub/same.ts`/`same.py` pair at the `historyStats` level), and
  `parsed`
  counts a key whose record carries **no named-body scope — only the mandatory `file` scope §6.3
  requires** (`extractUnits` appends exactly one per parsed file, unconditionally and after the
  walk: `src/roots/extract.ts:530-556`, and its own header note at `:396-397`) — the criterion is
  `skipped: false`, never "produced at least one **named-body** scope", so an empty but parseable
  file is `parsed`. A `BlobScopeRecord` with `scopes: []` is unreachable, and no test may assert
  one.
  All five are **accumulated into `meta.json` and re-emitted from state** (D1), so a resumed run
  reports the history's totals rather than its window's: `commits` and `events` are running sums;
  `blobs` is the size of a persisted `blobs-seen` roster of distinct **SHAs**, since a per-run count
  would double-count a blob first named in an earlier run; `parsed` and `mb` are the size and the
  `bytes` sum of a **second** persisted roster, of distinct non-skipped **cache keys**, accumulated
  on a key's first appearance in it and reading `bytes` and `skipped` **off the blob record — a
  cache hit and a fresh extraction alike** (D11 puts both fields in the record for exactly this
  purpose). A record R4 never keys has no key and so enters neither `parsed` nor `mb`; it enters
  `blobs` alone, off the walk record. Two rosters, not one, is the whole content of this
  paragraph — `meta.json` carries both.
  `events` is a running sum for the same reason the other four are, and that fixes which of two
  integers it is: the fold counts each event as it emits it, while `finishReplay`'s appearance-cap
  demotion drops a subset that is a function of the **whole** history — including paths whose count
  crosses `lifecycleMaxAppearances` in *this* run, whose earlier contribution no run can
  retro-subtract from a sum an earlier run already wrote. So `historyStats.events` is the
  **pre-demotion** count, which is a set function of the commit set and is the only one a running
  sum can carry. The finished event list is shorter on any repository with a file touched in more
  than 200 commits, and that is expected, not a discrepancy.
  The word "fetched" appears in none of the five definitions, and that is
  load-bearing rather than stylistic: a forced full walk against a **warm** cache fetches nothing at
  all — T9 case (e) is exactly that shape, since editing the stored `inputsHash` leaves the real
  `EXTRACTOR_VERSION` and therefore every blob-cache key untouched — so a `parsed`/`mb` defined
  over newly-fetched blobs would accumulate to zero and the model would not be byte-identical to
  the cold run's. Without all five defined this way, a resumed index and a `--full` index report
  different `historyStats` for the same history and R4-I2 fails on `historyStats` alone —
  a **body** field (Appendix D `:866`; `MinedModel`'s own header comment), not a header one; the
  header carries none of the five.
  The `blobs`/`mb` split is deliberate, and it is what makes `mb` reachable at all: `blobs`
  counts every distinct SHA the walk **resolves**, while `parsed` and `mb` count only the keys R4
  actually extracted under — and a path R4 does not extract (D17's middle tier: no registered
  grammar, or excluded from the parse set) never produces a key at all. Such a blob is
  recognised from its path *before* any fetch (R4-I6): it is counted in `blobs`, its in-memory skip record carries `bytes` **0** (a recorded zero,
  never an unknown — the sha roster itself holds only shas), it contributes 0 to `mb`, and it is
  never fetched — so §20.1's blob-rate budget is never spent pulling images, binaries and prose
  down for a byte count. **"No registered grammar" is a narrower set than intuition suggests, and
  the test must be written against the registry rather than against the word "data file":**
  `.json`, `.yaml`, `.yml` and `.toml` **are** registered (`src/utils/language-registry.ts`), so
  `package-lock.json` and `pnpm-lock.yaml` parse like any other source file and are counted in
  `parsed` and `mb`. The files that genuinely carry no grammar are of the shape `yarn.lock`,
  `NOTES.md` and `.png`. A test pins exactly this reading: on a golden carrying a `.png`, a
  `NOTES.md` and a `yarn.lock`, all three blobs appear in `blobs`, none appears in `parsed`, and
  `mb` is unmoved by them.
  Run diagnostics — blobs parsed *this* run, walk seconds — go to stderr and nowhere else.
- **D5 — Value events store the raw value tuple, not a per-surface value.** §13.3 says an event
  records `(commit_ts, value, author_hash, author_kind)` where the value tuple carries nameshape,
  first-statement type, return shape, sorted decorators, sorted supertypes (`v6-spec.md:614`),
  and §6.5 binds the change signature over those plus node types and callee texts (`:252`). Each
  persisted event additionally carries the **commit sha** it came from — not a spec field, but the
  tie-break that makes `(ts, key, kind, sha)` a total order and therefore makes the event file
  byte-identical whatever order the walk delivered its commits in (D16). R4
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
  reintroduces them. Name the deviation rather than leaving it implicit: Appendix D's own partition
  example lists all four (`v6-spec.md:894`; `:893` is the `seeds` row — `"coverageRole":0.63,"coverageAll":0.91,
  "debtBits":812.5,"debtPerInstance":1.9`), so this is a documented departure from **Appendix D**,
  the same kind D14 records against §13.2, and it is undone by R7 rather than by a schema bump.
  This is the same honest encoding Increment 2 used for `historyStats` and `cochange`: absent
  while uncomputable, never a placeholder that reads as data.
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
  blob's `bytes` (D4's `mb`) and a `skipped` marker, so an expensive skip is recorded once and
  never re-attempted. **Only the two expensive skips are recorded**: `oversize`, which is knowable
  only after the blob's bytes are in hand, and `unparseable`, which is knowable only after a parse
  attempt. The third skip reason — a path whose extension has no registered grammar — is a pure
  function of the path and costs nothing to recompute, so it is answered in memory before any key
  is computed and **never written to the cache at all** (T4's interfaces). Recording it would add
  one JSON file per distinct blob of every non-code file in the whole history — every revision of
  every `NOTES.md`, `.png` and `yarn.lock` — to a cache §20.1 budgets for code blobs, in exchange
  for re-deriving nothing.
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
  unnoticed regression. `index` compares the run's **input** fields against the on-disk header's
  and short-circuits only when all four of these hold. **Reading that header can throw**, and the
  rule for it is fixed here because no condition below covers it: `readModel`
  (`src/roots/stores.ts:156-182`) throws on unparseable JSON, on a body that is not
  `{header, body}`-shaped, and on a `rootsVersion` mismatch. Any throw is caught, written once with
  `debugWrite`, and treated as **"no comparable header"** — condition 1 fails, the run proceeds
  normally, and `model.json` is rewritten. That is safe by construction: the run is about to
  overwrite the unreadable model anyway, and turning an unreadable model into a hard failure would
  make a corrupt cache file the one thing an adopter could not fix by re-indexing.
  1. **The input fields are equal, field by field** — `headSha`, `clock`, `dirtyHash`,
     `configHash`, `seedsHash`, `decisionsHash`, `ledgerHash`, `bindingHash`. The header's
     remaining fields — `candidateCountLog2`, `rolesStale`, `rootsVersion` and `lastIndexedSha` —
     are **outputs** and are excluded from the comparison. "Matches the on-disk header
     byte-for-byte" would be unimplementable: `candidateCountLog2` and `rolesStale`
     (`stores.ts:78-91`) are knowable only after mining, and `bindingHash` is `runRootsIndex`'s own
     `bindingSetHash` (`pipeline.ts:205-222`, assembled at `cli/roots.ts:370-380`), so T9 lifts
     that one fold out into a standalone function the command can call before mining. That lift is
     **not** a copy of the landed lines: as landed the fold *reads* a module-level binding cache
     that `parseAndExtractAll` filled earlier in the same call, so called cold — which is exactly
     how the short-circuit calls it — it would find an empty cache and hash `"{}"`, condition 1
     would never hold and this whole decision would be dead code. T9 dictates the derivation
     semantics that make it callable cold, and names the one behavioural difference that follows.
  2. **`decideWalkMode` returns `resume`** (T9). This is the mechanical statement of "no rebuild is
     pending", and it is deliberately *not* an enumeration of state defects: a missing,
     unparseable, epoch-inconsistent (D15) or inputs-mismatched state, an unreachable
     `lastIndexedSha`, active windowing (D3) and `--full` all already fail it. An enumeration would
     let the short-circuit swallow T9's determinism cases (d), (e) and (f) — each of those leaves a
     **present, parseable, inputs-matching** state on disk and is caught by the walk decision alone.
  3. **The resume range is empty** — `lastIndexedSha..HEAD` names no commit — **and** `meta.json`'s
     `lastIndexedSha` equals `readHead().sha`.
  4. **The blob cache directory exists.**
  Then the run reports "already current" in plain user terms, exits 0, and writes nothing at all —
  model, replay state and blob cache alike. `--full` bypasses the short-circuit outright as the
  explicit determinism reference, and R4-I3's cold-versus-warm case stays a real test because a
  deleted cache directory fails condition 4. Byte-identity across a repeated run is then trivially
  preserved, and the property a test can assert is the stronger one: `model.json`'s bytes **and**
  its mtime are unchanged.
  Two consequences to implement deliberately. The comparison runs **before** `acquireBuildLock`: a
  no-op run that created and then deleted `.cache/.build.lock` would be a write to the cache
  directory, and §6.6 clause 6 allows **zero** (`v6-spec.md:260`). And the compared set carries no
  **builder-version** component, so a future change to the mining code with HEAD, config, seeds,
  ledger and bindings all unchanged would report "already current" over a stale body — and D10
  freezes `ROOTS_VERSION` at 1, so `readModel`'s version gate cannot catch it either. R4 itself is
  safe only incidentally: an R1–R3 model has no replay state beside it, so the first R4 run always
  fails condition 2. The limitation is recorded here and belongs to whichever release first changes
  the body after shipping.
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
- **D15 — The replay state commits as a set, or not at all.** D1's state is six files, and
  `atomic-write-contract` (`.yggdrasil/aspects/atomic-write-contract/check.mjs`) gives each of them
  **per-file** atomicity — which is exactly what makes a torn *set* silent: a process killed
  between the third file and the fourth leaves six individually well-formed files describing two
  different walks. The likeliest shape is also the worst. `meta.json` is the only carrier of
  `lastIndexedSha`, so if the five accumulators land and `meta.json` does not, the next run resumes from
  the **old** sha with the new lifecycle rows, co-change supports and appearance counters already
  applied: `modifications`, `support` and every `historyStats` running sum double-count, and
  nothing detects it. Per-file atomicity is necessary and not sufficient, and the design's own
  productionized row asks for more — "canonical-JSON stores with schema **versions** and **atomic
  writes**" (`integration-design.md:466`).
  R4 commits the set with a **`stateEpoch`**: one token per written state, carried as the **first
  record of each of the five JSONL files** and as a **field of `meta.json`**, beside the state
  schema version. The write order is fixed — the five accumulators first, `meta.json` last — and
  `readHistoryState` accepts the state only when all six epochs agree. Any disagreement is "no
  usable state", which `decideWalkMode` turns into a full walk (D2, and T1's all-or-nothing read
  contract), never a partial resume. **Partial presence is the same verdict**, and it is reachable
  rather than hypothetical — R4-I10 makes a failed write to a state file one `debugWrite` and a
  continuing run, which leaves the directory holding some of its files and not others. So: the
  state directory being absent entirely ⇒ `undefined`; the directory existing with **any one of the
  six files missing** ⇒ `undefined` too, on exactly the epoch-disagreement footing, never a load of
  the five that happen to be there. A torn or partial write therefore costs exactly one full walk
  and can never produce a wrong model.
  **`readHistoryState` compares the six stored epochs; it never re-derives one.** The distinction
  looks academic and is not: both of the epoch's inputs are themselves plain `meta.json` fields, so
  a reader that recomputed `sha256(stateSchemaVersion ∥ inputsHash ∥ lastIndexedSha)` from them and
  compared it against what is stored would be a natural implementation — and it would reject T9's
  case (d) at **read** time, before `decideWalkMode` ever runs its reachability probe. MR-31 would
  then kill nothing (the reachability branch it deletes is never reached), and case (e)'s narrative
  — a state that is "present, parseable, inputs-matching" — would stop being true of case (d)'s
  hand-edited `lastIndexedSha`. The reader's whole job is to answer "do these six files describe
  one state?", which is a comparison across the six, not a re-derivation from two of them. A
  hand-edited field is `decideWalkMode`'s to catch, on its own footing.
  The epoch is **derived, never random or counted** — `sha256(stateSchemaVersion ∥ inputsHash ∥
  lastIndexedSha)` is the shape — because R4-I2 requires the persisted state to be byte-identical
  between a resumed run and a `--full` one, and a per-run counter or a random token would move
  `meta.json`'s bytes on every write and fail that invariant outright. A derived epoch still catches
  the failure it exists for: a torn set pairs products carrying the **new** state's epoch with a
  `meta.json` still carrying the previous state's, and those two states differ in
  `lastIndexedSha`. The one case it cannot detect — rewriting a state byte-identical to the one
  already there — is the case where a torn write changes nothing.
  The **state schema version** sits beside `stateEpoch` in `meta.json` and is folded into
  `inputsHash` (D2). It moves whenever the shape of any of the six files moves — a new lifecycle
  field, a changed alias-edge record, a renamed counter — and moving it is the whole migration,
  because the state is rebuildable. It is a **third** version notion, independent of both
  `package.json`'s release version and `ROOTS_VERSION` (D10); AGENTS.md's warning about conflating
  the first two applies to this one identically.
- **D16 — The replay is a function of the commit *set*, never of arrival order.** This decision
  replaces an earlier draft's two ordering claims, both of which are empirically false against
  `git version 2.43.0` and were verified false on throwaway fixture repositories before this
  decision was written:
  1. *"`--reverse --date-order` delivers ascending committer timestamps."* It does not.
     `--date-order`'s primary constraint is topological — "show no parents before all of its
     children are shown, but otherwise show commits in the commit timestamp order" — so on a
     **linear** chain whose committer dates dip (day 60, day 0, day 121) `--reverse --date-order`,
     `--reverse --topo-order` and a plain `--reverse` all deliver the same parent-chain order, and
     the timestamps descend and then ascend.
  2. *"A resume range is a suffix of the full walk's order."* It is not; it is a **set
     difference**. On the commonest git workflow there is — merging a feature branch that was
     started before the last index — the full walk applies the branch commit *before* the
     main-line commit that was `lastIndexedSha`, while the resumed walk applies it *after* that
     commit is already in state. Any commit older than `lastIndexedSha` that becomes reachable
     later lands out of the full walk's relative position.
  A third fact makes ordering unsalvageable rather than merely unpinned: **no linearization of a
  branched DAG can make a running previous-value map correct.** On point 2's fixture the full walk
  hands over the side-branch blob and then the main-line blob, so a running map computes the
  main-line commit's change against the *side branch's* blob — a transition the repository never
  contained. Reversing the order breaks the other commit instead. Pinning a walk order could
  therefore never have made the old design right; only removing the carried state can.
  **The construction.** Every value comparison is per **file record**, and every accumulated
  quantity is a set function with a deterministic tie-break:
  - `git log --raw` hands each file record its own **pre-image** blob sha — by definition the blob
    in *that commit's own parent*, which is what "the previous blob" was always meant to name. So a
    **change** event is `signature(postSha) ≠ signature(preSha)` for a scope key present in both, an
    **introduction** is a scope key present in `postSha` and absent from `preSha` (all of them when
    `preSha` is null, i.e. status `A`), and neither reads any state carried between commits.
    Verified empirically on point 2's fixture: the resume range's records carry
    **byte-identical** `preSha`/`postSha` pairs to the same commits' records in the full walk — the
    side-branch commit included, even though the two walks place it on opposite sides of
    `lastIndexedSha` — so the two runs produce the same events for the same commits. T2 acceptance 2
    is where that gets pinned as a test.
  - Lifecycle fields are `min`/`max`/counters (T5 Step 2 already required this and it stays);
    `churnedEarly` is derived at finish from the **two smallest** touch timestamps, both persisted,
    rather than from "the first modification observed"; `authorKind` is the kind of the touch with
    the greatest `(committerTs, sha)`, the sha being the tie-break that makes equal timestamps
    decidable, and `lastHumanCommitTs` is a plain `max` over human touches.
  - The appearance-cap demotion (T5 Step 4a), the alias chain closure and the co-change cut are all
    computed at **finish** from accumulated raw counters, edges and supports — never incrementally
    as the walk proceeds.
  - `historyStats`' five numbers are set cardinalities and running sums over **two** persisted
    rosters — distinct blob SHAs, and distinct non-skipped cache keys (D4). The second roster is
    what makes them order-free rather than merely looking it: one blob sha reaches two paths with
    opposite extraction verdicts often enough to matter (every empty file in a repository is one
    sha), so a single sha-keyed roster would decide `parsed` by arrival order. Counting keys
    removes the choice instead of tie-breaking it.
  - `finishReplay` emits events in the order `(ts, key, kind, sha)`; the sha is what makes that
    tuple total **on the raw events `events.jsonl` persists**, so a fixture with two commits at the
    same second cannot reorder the file. After the alias rewrite the tuple is no longer total —
    two live paths whose closures land on the same final path can collide — which is harmless in
    R4 (nothing serializes the finished list, and the returned order stays deterministic on a
    pre-rewrite-key tie-break) and recorded as R6 debt in T5's `ValueEvent` comment.
  **Consequences to implement deliberately.** `prevstate.jsonl` is **deleted** from D1's state: R4
  persists **six** files, not seven, and no run carries a previous-value map across a commit
  boundary or across a run boundary. The pre-image blob must instead be *resolvable*, which the
  probe-then-fetch protocol (T8 Step 1) handles by keying and probing **both** shas of every record
  R4 extracts (D17 gate 2 answers the rest from the path alone, with nothing fetched):
  on a full walk from the root every `preSha` is either null or the post-image of an earlier walked
  commit, so the distinct-blob set is unchanged except for a blob that exists only inside a merge's
  own tree (a conflict resolution), which is fetched like any other; on a resume the range's opening
  pre-images were extracted by the previous run and hit the blob cache, so a resume fetches nothing
  extra.
  **What this decision does *not* claim.** The walk still pins `--date-order` beside `--reverse`
  and still forbids `--topo-order`, for one reason only, and it is not the replay's: a **stated**
  ordering flag makes the `--max-count` window (D3, T2 Step 6) a stated contract instead of an
  inherited default a future git is free to change.
  **And the window is not "the newest N by committer date" — that is empirically false, and
  writing it down as if it were true is the same class of defect this decision exists to record.**
  `--max-count=N` truncates the **traversal** at N commits, and `--reverse` is applied afterwards;
  with `--date-order` the traversal is date-ordered *subject to the child-before-parent
  constraint*, so the capped set is the newest N **in traversal order**, which coincides with the
  newest N by committer date only on a history whose dates never dip below a parent's. Verified
  false on `git version 2.43.0`, twice over:
  - On claim 1's own linear chain (day 60 → day 0 → day 121),
    `git log --reverse --date-order --max-count=2` returns day 0 and day 121 — **excluding day 60**,
    which is newer than day 0. The traversal is child-before-parent, the cap takes its first two,
    and `--reverse` flips those two.
  - On a branched DAG (base day 0 → `M1` day 100 on the main line; a side branch `S1` day 50 →
    `S2` day 20; then the merge), `git log --date-order --no-merges --max-count=2` returns `M1` and
    **`S2`**, not `M1` and `S1` — the two newest by date. That is reachable on any repository that
    merges a branch whose commits are older than the mainline tip, i.e. the commonest git workflow
    there is.
  So naming the flag makes the capped set *stated*; it does not make it "the newest N by date", and
  nothing anywhere may be written against that reading. D3 is unchanged and unaffected: under
  windowing the walked set is run-time-dependent whatever the cap's exact semantic, which is why
  windowing disables resume outright.
- **D17 — §6.8's exclusions bind the *historical* path too, in two tiers.** §6.8's built-in
  exclusion list is binding (`v6-spec.md:271`, quoted verbatim into
  `src/roots/partitions.ts:78-99` as `BUILT_IN_EXCLUSIONS`, merged with config `exclude` by
  `makeRootsFileFilters`), and the spec scopes only the **test-pattern** carve-out
  (`*.test.*`/`*.spec.*` — `partitions.ts:102`) to convention mining, leaving the rest of the list
  binding everywhere. No authority says what that means for a path seen in *history* rather than in
  the live tree, and three tasks would otherwise each guess: T4 resolves a historical path by
  extension alone, T6 calls co-change "inclusive of non-code and test-pattern files", and T8's
  probe-then-fetch protocol says only "recognise the historical path's extension". Left unstated,
  every historical revision of `dist/`, `vendor/`, `node_modules/`, `*.d.ts` and `.yggdrasil/**`
  would be keyed, fetched, parsed and cached — against §20.1's per-blob budget and T10's dogfood
  measurement — `historyStats.blobs/parsed/mb` would inflate by a large multiple on model-visible
  fields, and co-change would couple build output to everything it was ever emitted beside. D2 has
  already assumed an answer, too: it folds `include`/`exclude` into `inputsHash`, which is only
  meaningful if they change the walk's product. So it is fixed here, once, and T4, T6 and T8 cite
  it rather than restating it. `makeRootsFileFilters(config)` is the single source of both
  predicates; neither is re-implemented against a historical path.
  1. **Gate 1 — `forMarkers` (merged built-in + config exclusions).** A historical path failing it
     is **invisible to R4 entirely**: no blob-roster entry (neither roster — so it moves neither
     `blobs` nor `parsed` nor `mb`), no co-change participation, no lifecycle row of either level,
     never keyed, never probed, never fetched, never cached. It does not even count toward T6's
     `≥ 2 and ≤ megaCommitFileCap` changed-file band — that band is measured over the records
     **surviving this gate**, so a commit touching forty `dist/` files and two source files is an
     ordinary two-file commit, not a mega-commit. The commit itself is still walked and still
     counted in `historyStats.commits`.
     **A record's gate-1 path is its *post-image* path — `newPath ?? path` for *every* status,
     which for `D` and `T` (neither of which carries a `newPath`) is just `path`.** Writing the rule
     that way rather than enumerating `A`/`M`/`R`/`C` and `D` separately is deliberate: an
     enumeration leaves `T` — which git does emit, and which the status union carries — in neither
     list, and `newPath ?? path` already gives it the right answer. The rule has to be stated at all
     because `forMarkers` takes a single `relPath`
     (`src/roots/partitions.ts:135`) while an `R`/`C` record carries **two** paths whose verdicts
     genuinely differ — `git mv src/a.ts vendor/a.ts` gives `forMarkers('src/a.ts')` true and
     `forMarkers('vendor/a.ts')` false, and `git mv dist/a.js src/a.js` gives exactly the reverse
     (both verified on `git version 2.43.0`; `**/dist/**` and `**/vendor/**` are
     `BUILT_IN_EXCLUSIONS` entries at `partitions.ts:82` and `:87`). Gate 1 is applied **once**, in
     T8 Step 1, and four consumers read the result, so an unstated choice would move four
     model-visible things at once: the changed-file band, the pair and `commits(a)` increments, the
     `blobs` roster, and whether the **alias edge** is recorded — which decides whether a renamed
     file's whole lifecycle history follows it or is stranded at the old key. Concretely:
     a rename whose post-image is excluded is dropped **whole** — no alias edge, and the old path's
     rows simply stop receiving touches, which is the honest outcome for code that left the mined
     world. A rename **out of** an excluded prefix survives gate 1; gate 2 then answers its
     pre-image from the old path (excluded ⇒ the in-memory skip record, no scopes), so every
     post-image scope is an **introduction** at that commit.
  2. **Gate 2 — `forParsing` ∧ a registered grammar.** A path that passes gate 1 and fails gate 2
     is rostered in `blobs` off the walk record — its in-memory skip record carrying `bytes` **0**
     (the sha roster holds only shas) — counted for co-change, and
     carries **no lifecycle row of either level** — and is never keyed, probed or fetched, so it
     enters neither the key roster nor `parsed`/`mb` (D4). This is the existing `no-grammar` rule
     (D4, D11, T5 Step 2) generalized: `forParsing`-exclusion joins "no registered grammar" as a
     second way into the same in-memory skip record, whose `reason` therefore takes one further
     value, `'excluded'`, alongside `'no-grammar'` — both in-memory only, neither ever persisted
     (D11's rule is unchanged: only `oversize` and `unparseable` are written).
  3. **Only a path passing both gates** is keyed, probed, fetched, extracted, cached, and carries
     lifecycle rows.
  The `*.test.*`/`*.spec.*` carve-out lands where §6.8 puts it with nothing extra said: it lives
  inside `forParsing` and not inside `forMarkers`, so a test file passes gate 1 and fails gate 2 —
  **fully counted for co-change and history, never mined**, which is exactly `:271`'s clause. That
  it also carries no lifecycle row is not a loss: its scopes are excluded from the live parse set
  by the same predicate, so a historical row for one would join nothing.

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
  `meta.json` + the **five** canonical JSONL files D1 enumerates (`lifecycle`, `events`,
  `aliases`, `cochange-raw`, `cochange`) under a caller-supplied directory, generic
  over the record shapes, tolerant of **absence** and **all-or-nothing on damage**. The two
  tolerances this task lands are deliberately opposite and must not be conflated. The **blob
  cache** is per-record tolerant: one corrupt record is one miss, re-extracted for free (R4-I10;
  MR-1's sibling test). The **history store** is not. Any malformed line in any of the six files,
  an unparseable `meta.json`, a `stateEpoch` disagreement **across the six stored copies** — the
  reader compares them and never re-derives one from `meta.json`'s own fields, which is a rule with
  teeth rather than a nicety (D15 says why, and T9's case (d) depends on it) — or **any one of the
  six missing while the directory itself exists** (D15) makes
  `readHistoryState` report **no usable state for the whole directory**, with one `debugWrite`
  naming the file and the offending line — which `decideWalkMode` turns into a **full walk** (D2).
  `readSeeds`/`readDecisions`'s per-line skip (`stores.ts:211-227`) is the wrong precedent to copy
  here: those are hand-editable **committed** stores where one bad line must not erase everyone
  else's records, while the replay state is machine-written, gitignored and internally coupled. A
  silently skipped line there is a lost value event, a lost lifecycle row or a lost co-change
  support, and R4-I2's byte-identity then fails invisibly instead of loudly. Writing is the same
  contract in the other direction: the five accumulators first, `meta.json` last, every file
  carrying the state's derived `stateEpoch` (D15).
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
  `writeFile`/`writeFileSync`/`appendFile`/`appendFileSync`/`createWriteStream` imported from
  `node:fs` in **every**
  `src/io/*.ts`, so the exclusive create is spelled `openSync(path, 'wx')` + `writeSync` +
  `closeSync` — the aspect-safe form of `O_EXCL`, not `writeFileSync(path, pid, {flag: 'wx'})`.
  The same ban is why the history store's JSONL files are written whole rather than appended:
  `appendFileSync` is on `RAW_WRITE_FNS` beside the rest.
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
  key), canonical JSON, atomic write — and canonical means a **self-contained sorted-keys
  serializer copied into each new module**: the repo's existing canonical serializers are every
  one of them unexported (`roots/stores.ts`'s `sortKeysDeep`/`canonicalModelJson` at
  `:118`/`:132`, `io/type-class-cache.ts`'s `canonicalJson` at `:61`, `roots/binding.ts`'s at
  `:221`, `roots/config.ts`'s at `:29`, and the `engine`-type copy at
  `core/advise-nominations.ts:337` — `stores.ts:103-117`'s precedent comment names the
  config.ts copy and that engine-type one as its "two copies kept in sync"), and `roots-store` is
  not on `persistence-adapter`'s `calls` list (`yg-architecture.yaml:206-209`), so none is legally
  reachable — the same deliberate-duplication precedent `stores.ts:109-112` documents for itself.
  A parse failure is a MISS (`undefined`) plus one
  `debugWrite`, never a throw (R4-I10).
- `readHistoryState(dir): Promise<HistoryState | undefined>` and `writeHistoryState(dir, state)` —
  the five JSONL files plus `meta.json` (D1); every array written in a fixed sorted order so two
  states of the same history are byte-identical. **Name those orders here, because R4-I2 claims
  byte-identity of all six files and nothing else in the plan fixes them** — T5 Step 5 specifies
  sort orders for `finishReplay`'s *derived* output, which D1 says is never persisted, so the
  **raw** orders are these and only these: `lifecycle.jsonl` by `key`, then `level`
  (`'file'` before `'scope'`) — **not** because `key` alone would be ambiguous, which it is not: a
  scope-level key is `relPath#kind#qualifiedName` and a file-level key is the bare `relPath` with no
  `#` component at all, so the two key spaces are **disjoint** and `key` alone is already total.
  `level` is in the sort key so the two levels group readably and the order stays **stated** rather
  than incidental; `events.jsonl` by `(ts, key, kind, sha)`, which **is**
  total on the raw events because their `key` still carries the pre-rewrite path;
  `aliases.jsonl` by `(ts, sha, from)`; `cochange-raw.jsonl` carries two record shapes and writes
  them in two blocks — every pair row first, sorted by `(a, b)`, then every per-file commit-count
  row, sorted by path; `cochange.jsonl` in the emitted cut's own order
  (descending support, ties by `a` then `b` — T6 Step 2), since it is a snapshot of an output and
  never read back. Inside `meta.json`, the blob-sha roster sorts by sha and the cache-key roster by
  key (D4). Every one of those keys is **total**, so two writes of the same state are byte-identical
  — which is what lets the `stateEpoch` be **derived from the state's own content** rather than a
  counter or a random token (D15). Each JSONL file's **first
  record** carries that epoch and the state schema version, and `meta.json` carries both as fields;
  `writeHistoryState` writes the five accumulators first and `meta.json` **last**;
  `readHistoryState` returns `undefined` — never a partial state — on absence of the directory, on
  any one of the six files missing while the directory exists, on any malformed line, or on any
  epoch disagreement across the six (D15).
- `acquireBuildLock` (bounded wait, then refuse) / `releaseBuildLock` as above.
- `readLedger`, the three path helpers, `LedgerEntry`.

**Steps.**
- [ ] **Step 1: Architecture verification (the design-lock).** For each new file path, confirm by
  reading `.yggdrasil/yg-architecture.yaml` which `when:` predicate classifies it, that every
  import it will make is on that type's `calls`/`uses` list, and that every aspect the type
  attaches actually applies (an aspect whose own `when:` excludes the file is silently skipped —
  `src/model/when.ts:3-6`). Record the result in the task report. Any mismatch ⇒ **STOP**, report
  the minimal architecture block that fixes it, do not edit the file.
  **One item looks like part of that checklist and is deliberately *not*: the `roots-engine` type's
  own `description:`.** It currently reads "**Pure functions** over parsed source and store-loaded
  state" (`yg-architecture.yaml:740` — an architecture *type* description; graph **nodes** carry
  their own, in `.yggdrasil/model/**/yg-node.yaml`), while R4's `history.ts` will orchestrate a
  streamed `git log`, a long-lived `cat-file --batch` child and cache reads and writes. **Neither
  kind of description reaches any reviewer.** The assembled prompt's `<node …/>` element carries
  `path` and nothing else, deliberately and with the reason written into the code
  (`src/llm/prompt.ts:176-192`: the description "is not a verdict input: `computeLlmInputHash` never
  folds it, so editing a description re-verifies nothing"); the only `description` attributes in an
  assembled prompt are the aspect's and each reference's. So a stale wording here **cannot** make an
  honest R4 file read as a violation, and it is **not** a reason to STOP. This is the same fact
  Global constraints already state one way ("Graph-node `description:` growth is not a prompt
  risk"), restated here so this step does not raise an Open-Question-1 escalation over a change that
  can move no verdict. If the maintainer wants the wording widened for human readers — it is what
  `yg context` and `yg find` show them — that is an optional, separately-gated request that does not
  block execution. The predicate/relation/aspect checklist above is unchanged and is what this step
  actually verifies.
- [ ] **Step 2: TDD the three io modules.** Real tmp dirs, no mocks. Blob cache: round-trip;
  sharding layout by the key's first two hex characters; a corrupt shard file reads as a miss;
  two writes of the same record are byte-identical. History store: an **absent** state directory ⇒
  `undefined` — "no state", which `decideWalkMode` must be able to tell apart from a state that
  loaded cleanly and happens to describe an empty history; round-trip byte-identity of all six
  files; a malformed line **anywhere in any of the six** ⇒ `undefined` plus one `debugWrite`,
  never a partial load; a directory holding **five of the six** files (delete one, leave the rest
  intact and epoch-consistent — R4-I10's failed-write shape) ⇒ `undefined` too; a state whose
  `meta.json` carries a different `stateEpoch` than its accumulators — the torn-write shape,
  assembled by hand in the test by writing one state's accumulators
  beside an earlier state's `meta.json` — ⇒ `undefined`; and two writes of the same state produce
  the same derived epoch, so all six files are byte-identical across them (D15).
  Lock: exclusive acquisition; a second acquire on a held fresh lock retries for the bounded
  window and *then* fails; a holder that releases inside that window is acquired rather than refused (the
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
   inside the window yields the lock to the waiter instead. This criterion is the **only** home of
   the release-inside-the-window half of §4.4's "wait briefly, then fail": here the clock and the
   sleep are injected and nothing actually waits, whereas asserting it against two concurrent real
   `index` runs would need a full index to finish inside `waitMs` 2000 — a timing assertion in the
   commit gate, which this plan's global constraints forbid. T9's E2E keeps the refusal half only.
3. `readHistoryState` on an absent or empty directory returns `undefined` — "no state", never an
   empty-history state — creates nothing and throws nothing. A directory holding a clean state that
   happens to describe an empty history returns that state, and the two outcomes are
   distinguishable at the call site: `decideWalkMode` routes the first to `full` and the second to
   `resume`. A directory holding only five of the six files — the shape R4-I10's continue-on-failed-write
   leaves behind — also loads as `undefined`, never as a resume from whatever survived.
   `writeHistoryState` emits the five accumulators before `meta.json`, all six carrying the
   same derived `stateEpoch`; a hand-assembled state whose `meta.json` carries the epoch of a
   *different* state than its accumulators loads as no state at all, never as a resume point. Two
   writes of the same state produce the same epoch and therefore byte-identical files (D15).
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
- Modify `source/cli/src/utils/git.ts` — **only if** `readHead` wants epoch seconds directly rather
  than parsing the ISO-8601 string `getHeadCommitterTimestamp` already returns: add a `%ct` sibling
  beside it (`:100-110`) with the same fail-soft-to-`null` contract, changing no existing helper's
  behavior. Either way `readHead` delegates and never issues its own `rev-parse`/`log -1`; say in
  the report which of the two shapes you took.
- Create `source/cli/tests/unit/utils/git-history.test.ts` — mapped by the dedicated git-helpers
  test node that already owns `tests/unit/utils/` git tests and carries the
  `{target: cli/tests/support, type: uses}` relation.

**Interfaces produced.**
```ts
export interface HistoryFileRecord {
  // `--raw`'s status letter with any similarity SCORE STRIPPED: `-M` emits `R100`, `R087`, `C075`
  // and so on, never a bare `R`/`C` (verified against a whole-directory `git mv`, which yields six
  // `R100` records). Parse the leading letter, discard the digits — a parser that compares the
  // whole token against `'R'` silently classifies every rename as unknown.
  //
  // `'T'` (typechange — a regular file becoming a symlink or a submodule, or the reverse) is in the
  // union because git emits it, and its handling is stated HERE, once, because it is the only place
  // every consumer reads: **a `T` record is a TOUCH and nothing more.** It counts as a changed file
  // for the co-change band and for the pair increments (T6), and it contributes its touch to the
  // **file-level** lifecycle row's `lastModifiedTs`/`modifications`/`fixTouches`/`authorKind`
  // counters exactly as an `M` does (T5 Step 2) — **the file-level row only, and never a scope
  // row**: a `T` resolves no blob, so no scope set and no scope key exists for it. Touching scope
  // rows this path is already known to carry from *other* commits would be reading state carried
  // across a commit boundary, which D16 forbids outright, and it would break R4-I2 silently, since
  // whether a given scope row was already known depends on arrival order. It is
  // **never blob-resolved and never event-producing**: no key
  // is derived, neither of its shas is probed, fetched, extracted or rostered, and it emits no
  // introduction and no change. That is why D4's `blobs` roster and T8's probe-then-fetch protocol
  // enumerate `A`/`M`/`R`/`C` only, and why T5 Step 1's fold does the same; neither list is an
  // omission. A path clearing both of D17's gates whose only record in the whole history is a `T`
  // therefore carries its FILE-level row and no scope-level row — nothing ever resolved a scope set
  // for it — which is the same shape a `D`-only path has and is harmless.
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  path: string;            // POSIX, repo-relative; for R/C this is the OLD path
  newPath?: string;        // present for R/C
  // The blob in THIS COMMIT'S OWN PARENT — which is what makes the replay order-free (D16): a
  // change is `signature(postSha) != signature(preSha)`, computed from the record alone, with no
  // value map carried between commits. Null for A (the all-zero sha normalizes to null).
  preSha: string | null;
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
// `onCommit` is a streaming callback and is deliberately NOT where a consumer folds: T8 buffers
// commits into a window — probing each commit's keys as it appends it, and FETCHING once per
// window (T8 Step 1) — which is what keeps the
// walk to one `cat-file --batch` child rather than one per commit. This function therefore makes
// no promise beyond "called once per walked commit, before the returned promise resolves" — no
// ordering promise in particular (D16) — and must not grow one.
export function walkHistory(repoRoot: string, opts: WalkOptions,
  onCommit: (c: HistoryCommitRecord) => void): Promise<{ commits: number }>;
// HEAD is read OUTSIDE the walk and never from it. The walk is `--no-merges`, so when HEAD is a
// merge commit — the common case on any repository that merges PRs — the walk's last record is
// neither HEAD's sha nor HEAD's timestamp, while §13.4 is categorical that the clock is HEAD's
// committer timestamp, full stop (`v6-spec.md:618`). Setting `lastIndexedSha` to the last
// non-merge commit would also break resume: the next run would walk `lastNonMerge..HEAD` and
// re-apply commits it already replayed. Implemented **through the landed helpers, not beside
// them**: `getHeadSha` (`src/utils/git.ts:81-92`) and `getHeadCommitterTimestamp` (`:100-110`,
// `git log -1 --format=%cI`, which already carries the "never `max(last_modified)`, never
// wall-clock" contract in its own doc comment and already omits `--no-merges`). If epoch seconds
// are wanted rather than a re-parse of the ISO-8601 string, add a `%ct` sibling in `git.ts`; a
// second `rev-parse`/`log -1` pair inside `git-history.ts` would be a second definition of HEAD,
// free to drift from the one the model header already uses. Both fail soft to null.
//
// It returns the committer timestamp in BOTH representations, and that is a requirement rather
// than a convenience: T8's `HistoryJoin` carries `clockTs` (epoch seconds, for `WeightInputs`) and
// `clockIso` (the strict ISO-8601 string the model header's `clock` takes), and `git-history.ts`
// is not on T8's Files list, so a `clockIso` with no supplier here would have no legal source
// there. Nor may it be derived from `committerTs`: the header's format is `%cI`
// (`utils/git.ts:100-111`) — `'2026-08-19T00:00:00+00:00'`, the form the landed pin at
// `tests/unit/cli/roots.test.ts:178` carries — which `new Date(ts * 1000).toISOString()` does not
// reproduce. So `committerIso` comes straight off `getHeadCommitterTimestamp` and `committerTs`
// off the `%ct` sibling (or off a parse of that same ISO string — say which in the report).
export function readHead(repoRoot: string):
  { sha: string | null; committerTs: number | null; committerIso: string | null };
// §13.2 is categorical that blobs are read through **a single** `git cat-file --batch` child
// (`v6-spec.md:605`), and §20.1's ≤ 15 ms/blob budget assumes it. A walk fetches in many rounds
// (T8 Step 1's windowed probe-then-fetch), so a one-shot `readBlobs(repoRoot, shas, …)` would
// spawn one child per round — on a 100 000-commit repository, one process spawn and one
// object-store initialisation per round, on top of the walk. The primitive is therefore a
// **reusable handle**, opened once for the whole walk and closed in a `finally`:
export interface BlobReader {
  read(shas: readonly string[], onBlob: (sha: string, content: Buffer) => void | Promise<void>): Promise<void>;
  close(): void;
}
export function openBlobReader(repoRoot: string): BlobReader;
// `readBlobs` stays as the one-shot convenience wrapper (open → read → close in a `finally`) for
// callers with a single batch — every test in this task, and nothing on the walk's hot path.
export function readBlobs(repoRoot: string, shas: readonly string[],
  onBlob: (sha: string, content: Buffer) => void | Promise<void>): Promise<void>;
export function isShallowRepository(repoRoot: string): boolean;
export function isCommitReachable(repoRoot: string, sha: string): boolean;
```

**Steps.**
- [ ] **Step 1: Pin the framing empirically before writing the parser.** Build a fixture history
  with `tests/support/git-fixture.ts`'s deterministic helpers and capture the real output of
  `git log --reverse --date-order --raw --no-abbrev --no-merges -M -z --format=<candidate>` —
  including a path containing a space and a rename. **Do not** trust this plan (or the prototype)
  for the exact NUL/tab framing: `-z` changes both the raw-record separators and the format terminator, and the
  parser must be written against what the installed git actually emits. Encode the framing you
  observed as a test with a literal captured sample, so a future git version that changes it
  fails loudly instead of silently mis-parsing.
  **`-M`'s status token carries a similarity score.** A `git mv` of a whole directory emits `R100`
  per file, not `R` — verified. Parse the leading letter and discard the digits, and pin that with a
  fixture whose rename produces a scored token; comparing the whole token against `'R'` silently
  demotes every rename to an unrecognised status, which reads downstream as a delete plus an add
  and destroys the lifecycle continuity T5 acceptance 3 asserts.
  **Pin the ordering in the same step — and pin what it actually is, not what it is convenient to
  assume.** Two claims an earlier draft made here are empirically false and D16 records why:
  `--reverse --date-order` does **not** deliver ascending committer timestamps (on a linear chain
  dated day 60 → day 0 → day 121 it delivers exactly that dipping sequence, identically to
  `--topo-order` and to a plain `--reverse`, because the topological constraint outranks the date),
  and a resume range is **not** a suffix of the full walk's order (it is a set difference). What
  `--date-order` does give, and what this step pins by capturing it, is: **no commit is delivered
  before its own parent, and among commits with no ancestry relation the committer date decides.**
  The walk still names `--date-order` explicitly beside `--reverse`, turning today's default into a
  stated contract a future git cannot silently change, and **`--topo-order` stays forbidden anywhere
  in roots exactly as `--follow` is** (`v6-spec.md:600`) — but the reason is now narrow and true:
  it makes the `--max-count` window (Step 6) a **stated** contract rather than one inherited from
  git's default. It does **not** make that window "the newest N by committer date" — D16 records
  why, with the two counter-examples — so do not restate it that way here or anywhere downstream.
  The replay itself needs **no** ordering property whatsoever
  (D16), so nothing downstream may be written against an assumed arrival order. Naming a flag that
  spells out git's existing default is not a change to R4's binding flag set
  (`plugin-marketplace-plan.md:75`) and so is not a §6.8 descope; it is a guard on it, in the same
  spirit as D2's widened full-walk triggers.
  Capture a branch-and-merge fixture **locally, in this test file**, and capture the **resume**
  shape beside it,
  because that pair is the empirical evidence D16 rests on: `base` → a side branch → a later
  main-line commit → the merge → one more main-line commit. **"Locally" is deliberate and is the
  half a later task depends on:** this capture is a git-plumbing pin against literal captured
  output, which is exactly what belongs in `git-history.test.ts` and nowhere else, and this task
  lands before T3 — the task that owns `tests/support/**` — so it has no shared helper to reach
  for. T3 Step 1 lifts the *same commit shape* into `tests/support/branch-merge-fixture.ts`, built
  through the deterministic primitives, and T5, T8 and T9 use that helper. Nothing back-ports into
  this file: the two are independent constructions of one shape, and T3 asserts they agree.
  Assert that (i) the full walk delivers
  the side-branch and main-line commits interleaved by date rather than grouped by branch, and — the
  load-bearing half — (ii) walking `<the main-line commit>..HEAD` yields records whose `preSha` and
  `postSha` are **byte-identical** to the same commits' records in the full walk, even though their
  position relative to the already-indexed commit is different. That is the property the whole
  incremental-equals-full claim is built on, and it is a property of `--raw`'s per-record pre-image,
  not of the walk order.
  **Capture a typechange commit in the same step, because `T` is in the status union and no other
  fixture anywhere in this increment produces one.** A regular file becoming a symlink is the
  cheapest shape: `rm a.ts && ln -s target.txt a.ts && git add -A && git commit`, which on
  `git version 2.43.0` emits exactly one record —
  `:100644 120000 <preSha> <postSha> T\ta.ts` — one path, no `newPath`, both shas non-null
  (verified). Capture it beside the rename and the spaced path, so the parser's `T` branch is
  written against real output rather than against this plan; acceptance 9 reads it. Without this
  capture the whole `T` rule stated on `HistoryFileRecord.status` ships untested, which R4-I15
  forbids.
  **Capture one more local fixture in the same step, because acceptance 8 needs a shape the
  five-commit capture does not contain: a repository whose HEAD *is* the merge.** The five-commit
  shape deliberately ends with a trailing main-line commit, so its HEAD is not a merge, and T3's
  `buildBranchMergeFixture({trailingMainCommit: false})` — the shared helper that expresses this
  variant — does not exist yet at this task. So build it here, locally, the same way: stop after
  the merge instead of adding the trailing commit. Acceptance 8 reads it.
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
- [ ] **Step 4: Blobs.** One long-lived `git cat-file --batch` child **per open handle** — not per
  `read()` call and emphatically not per commit — fed in chunks of
  400 SHAs (`v6-spec.md:605`), parsing the `<sha> <type> <size>\n<content>\n` framing by byte
  count (never by scanning for a newline — blob content contains newlines). A missing object
  yields `<sha> missing` and is reported to the callback as absent, not as a crash.
  `openBlobReader` spawns the child, `read()` writes a request batch into the live child and
  resolves when that batch's responses are consumed, and `close()` ends its stdin and waits for
  exit; `readBlobs` is `open` → one `read` → `close` in a `finally`. That is what lets T8's walk
  fetch in many windows while §13.2's "**a single** `git cat-file --batch` child" stays literally
  true for the whole index.
- [ ] **Step 5: Resume, HEAD and degraded modes.** `sinceSha` ⇒ `git log <sinceSha>..HEAD`;
  `readHead` delegates to `utils/git.ts`'s `getHeadSha` and `getHeadCommitterTimestamp` (adding a
  `%ct` sibling there if epoch seconds are wanted rather than a parse of the ISO string), which are
  deliberately without `--no-merges` and deliberately outside the walk, so a merge HEAD is visible;
  `isCommitReachable` = `git rev-parse --verify <sha>^{commit}` succeeding;
  `isShallowRepository` = `git rev-parse --is-shallow-repository` returning `true`. Every helper
  fails soft to `null`/`false`/an empty walk with one `debugWrite`, matching `utils/git.ts`'s
  documented contract (`:61-71`).
- [ ] **Step 6: Windowing.** `maxCommits > 0` ⇒ `--max-count=<n>`, and state in the header comment
  what that means with `--reverse --date-order` — **stating what git does, not what is convenient
  to assume, because this comment becomes a contract the `deterministic`/`source-hygiene` reviewers
  read as truth**: `--max-count=N` truncates the **traversal** at N commits and `--reverse` is
  applied afterwards; with `--date-order` the traversal is date-ordered subject to the
  child-before-parent constraint, so the capped set is the newest N **in traversal order**, which
  coincides with the newest N by committer date only on a history whose dates never dip below a
  parent's. Naming the flag makes the capped set a stated contract rather than an inherited
  default; it does **not** make it "the newest N by date" (D16 carries both counter-examples,
  verified on git 2.43.0 — a dipping linear chain, and a merged side branch older than the mainline
  tip). Pin it with a fixture rather than only a comment: on the dipping day 60 → day 0 → day 121
  chain, `--reverse --date-order --max-count=2` yields day 0 then day 121, **excluding** the newer
  day 60. `sinceMonths` ⇒ `--since=<n> months ago` (only reachable when `history.full === false`).
- [ ] **Step 7: Graph ritual + report.**

**Acceptance criteria (hand-checkable, against a deterministic fixture).**
1. A history of 5 commits, one of them a merge, walks **4** records, in an order that **never
   places a commit before its own parent**, with the committer date deciding between commits that
   have no ancestry relation. Assert *that* — plus the specific literal sequence the fixture at hand
   produces, captured from the real git. Do **not** assert ascending committer timestamps: that is
   false in general, `--date-order`'s topological constraint outranks the date, and a linear chain
   dated day 60 → day 0 → day 121 walks in exactly that dipping order (D16). Nothing downstream
   depends on this criterion — the replay is a function of the commit set (D16) — so this is a pin
   on git's behavior, not a premise anything is built on.
2. **The resume range carries identical records.** On this file's own local branch-and-merge
   fixture (Step 1 — T3's shared helper does not exist yet at this task), index-point
   `sinceSha` = the main-line commit that precedes the merge: `walkHistory(..., {sinceSha})` yields
   a strict subset of the full walk's commits, and for every commit in that subset the
   `status`/`path`/`newPath`/`preSha`/`postSha` of every file record is **byte-identical** to the
   same commit's record in the full walk — even for the side-branch commit, which the full walk
   delivers *before* `sinceSha` and the resumed walk delivers *after* it. This is the empirical
   foundation of R4-I2 and it replaces the false "the range is a suffix" claim.
3. `git mv a.ts b.ts` in a commit yields exactly one record with `status: 'R'`, `path: 'a.ts'`,
   `newPath: 'b.ts'`, and both blob SHAs non-null — from a raw token of `R100`, whose score digits
   the parser strips (Step 1). A whole-directory `git mv` of six files yields six such records.
4. A commit authored by `claude <claude@example.test>` classifies `authorKind: 'agent'`; the same
   commit authored by a human but carrying `Co-Authored-By: Claude <…>` also classifies `agent`;
   a plain human commit classifies `human`.
5. `fix: handle empty input`, `Revert "x"`, and a body containing `This reverts commit abc` each
   classify `isFix: true`; `refactor: prefix handling` does not.
6. `readBlobs` over 900 distinct SHAs invokes the callback 900 times with byte-exact contents,
   spawning **exactly one** `git cat-file --batch` child and writing **three** request batches into
   it (400 + 400 + 100 — Step 4's chunk size). "At most 3 children" would pin nothing: one child
   satisfies it trivially, and one child is what Step 4 dictates. **The handle half, which is the
   one T8's walk actually runs on:** an `openBlobReader` handle driven through **three separate
   `read()` calls** of 10 SHAs each, then closed, also spawns **exactly one** child in total and
   returns byte-exact contents for all 30 — the property that keeps §13.2's "a single `cat-file
   --batch` child" (`v6-spec.md:605`) true across a whole windowed walk instead of once per window.
   Assert the child count by counting spawns, not by asserting the results are correct: a
   per-`read()` child returns identical bytes and would pass anything weaker.
7. A repo cloned with `--depth 1` reports `isShallowRepository() === true`.
8. In a repository whose HEAD **is** a merge commit — **Step 1's second local capture**, the
   variant that stops at the merge rather than adding a trailing main-line commit — the walk yields
   no record for HEAD (it is
   `--no-merges`), while `readHead()` returns that merge's sha and its committer timestamp. The
   two readers are independent by construction, which is the whole reason `readHead` exists.
9. **A typechange commit** — Step 1's local `rm f && ln -s t f` capture — yields exactly **one**
   record with `status: 'T'`, that one `path`, **no `newPath`**, and both shas non-null. This is
   the plumbing half of the `T` rule stated on `HistoryFileRecord.status`; T5 acceptance 12 is its
   replay half.

**Test obligations / mutation round-trips.**
- **MR-3 (no-merges):** drop `--no-merges` ⇒ acceptance 1 fails.
- **MR-4 (rename detection):** drop `-M` ⇒ acceptance 3 fails (the rename reads as D+A). Strip the
  score-digit handling instead (compare the whole `R100` token against `'R'`) ⇒ acceptance 3 fails
  the same way.
- **MR-5 (trailer branch):** delete the `Co-Authored-By` scan ⇒ acceptance 4's middle case fails.
- **MR-6 (byte-counted blob framing):** parse `cat-file --batch` by newline instead of the
  declared size ⇒ a blob whose content contains a blank line fails byte-exactness.

**NON-goals.** No scope extraction, no caching, no roots types, no lifecycle. No `git log
--follow` and no `git log --topo-order` under any circumstance.

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
- Create `source/cli/tests/support/branch-merge-fixture.ts` — **the shared branch-and-merge
  fixture five acceptance criteria across three later tasks build on, which otherwise has no owner
  and no home.** T2's merge capture is local to its own test file (T2 Step 1 says so, and T2 lands
  before this task), and a fixture built inside `tests/unit/utils/git-history.test.ts` is reachable
  from neither `tests/unit/roots/history-replay.test.ts` (T5) nor `golden-controls.test.ts` (T8)
  nor `tests/e2e/cli-roots-incremental.test.ts` (T9) — and an e2e suite may use only
  `tests/support/**` plus the public CLI surface. `buildGoldenRepo` cannot express it either: it
  builds a **linear** chain and its own monotonicity guard would reject the date dip. So this task,
  which already owns `tests/support/`, owns the helper too. It exports:
  - `buildBranchMergeFixture(opts?): {dir: string; shas: {base, side, main1, merge, main2?: string}}`
    — the `base` → side-branch commit → main-line commit → merge → one more main-line commit shape,
    with the side branch dated **before** the main-line commit it is merged past (the dip is the
    entire point), every date coming from `deterministicCommitDateAt` through the commit-index grid
    below, every command through `runDeterministicGitFixture`. `opts.trailingMainCommit` (default
    **`true`**) controls the last commit: `true` gives the five-commit shape T5's order-independence
    and split-walk cases need, where the merge sits *inside* the history; `false` stops after the
    merge, so **HEAD is the merge commit** — which is what T8's control (iv) and T9's case (g)
    assert against, and neither can build it from `buildGoldenRepo` (a linear chain). Both variants
    return `main2` only when it exists. The caller owns cleanup, the same
    division of labor `buildGoldenRepo` and `git-fixture.ts` already use.
    **What the commits *write* is part of the contract, not the caller's to improvise, because T5
    acceptance 8 asserts against it and a topology-only fixture would make that criterion
    unwritable.** The minimum this helper guarantees: `base` creates at least one extracted file
    (registered grammar, passing both of D17's gates) carrying at least one **named-body** scope;
    the **side-branch** commit creates a *second* such file, so at least one scope is **born on the
    side branch** — the population T5 acceptance 8 names — and the later main-line commit (`main1`)
    edits `base`'s file, so the two branches touch **different** files and the merge is
    conflict-free; the **merge** itself writes nothing of its own; and `main2`, when present, edits
    the side branch's file, so that scope's `lastModifiedTs` is strictly later than its
    `firstSeenTs` and both fields are hand-derivable from the day offsets. Every edit is a small
    in-place body change on a file of at least ~20 lines, never a rewrite, so no commit here can
    trip `-M`'s similarity threshold or produce an unintended rename. T8's control (iv) and T9's
    case (g) read only the topology and the clock, so the content contract costs them nothing.
  - `appendMergeOfOlderSideBranch(dir, {branchFrom, sideDayOffset, mergeDayOffset, …}): {sideSha,
    mergeSha}` — the same shape **appended** to an already-built repository, which is what T9 case
    (b)'s commit N+3 needs on top of the `history/` golden.
  Both go through the deterministic primitives only, so the fixture's SHAs are stable across
  machines, and this task asserts the standalone shape agrees with the branch topology and date dip
  T2's local capture pinned — two independent constructions of one shape, neither back-porting into
  the other.
- Modify `source/cli/tests/support/roots-golden.ts` — `GoldenCommit` gains `dayOffset?: number`
  (days from the fixed epoch; absent = the existing fixed-epoch + 60 s-per-index spacing
  (`tests/support/git-fixture.ts:151`, `:159`), never wall-clock time, so every landed spec keeps
  its current SHAs until it opts in), `deletes?: string[]`, and
  `renames?: {from: string; to: string}[]` (executed as `git mv` before the commit's `files` are
  written, so a rename and a content change in one commit is expressible). It also gains a
  **`dayOffset` monotonicity guard**: `buildGoldenRepo` commits in array order
  (`roots-golden.ts:103-111`) with each commit's date pinned, and the guard throws before creating
  the repository if the offsets dip anywhere, naming the golden, the offending index and the two
  offsets. **On a mixed spec — commits without a `dayOffset` followed by commits carrying one, the
  shape every landed golden takes after its trailing commit — the guard compares the RESOLVED day
  sequence: an absent offset is its index-derived day (the fixed epoch's 60 s-per-index spacing),
  so the landed goldens pass unchanged and only a genuine dip throws.**
  **State the guard's reason honestly, because the obvious one is wrong.** It is *not* that a
  dipping sequence would make the walk diverge from the build order: `buildGoldenRepo` produces a
  **linear** chain (one commit per array entry, each on the previous), and on a linear chain the
  parent-before-child constraint fully determines the walk regardless of dates — a fixture dated
  day 60 → day 0 → day 121 still walks in build order (T2 Step 1's captured evidence). Nor would a
  divergence matter if it happened, since the replay is a function of the commit set (D16). The
  guard exists because a dipping offset makes every **derived quantity** unreadable by hand:
  `stable_days` measured from a clock anchor that is no longer the last commit, `churnEarlyDays`
  windows measured between commits whose order on the page no longer matches their order in time,
  and a golden that silently scripts a history whose arithmetic nobody can check. A fixture whose
  numbers cannot be derived by hand cannot be a golden.
- Modify all seven committed golden specs (`tests/fixtures/roots/golden/*/spec.ts`) — add the D8
  trailing `NOTES.md` commit at `dayOffset: 400`, source files untouched.
- Regenerate all seven `*.bundle` files.
- Create `source/cli/tests/fixtures/roots/golden/history/{spec.ts, history.bundle}` — the R4
  workhorse golden.
- Modify the golden-node mapping, and `tests/support`'s node **mapping** (the new
  `branch-merge-fixture.ts` joins it) and its **description** (it names its helpers).
- Create `source/cli/tests/unit/roots/roots-golden-history.test.ts` — bundle equivalence for the
  new golden plus the harness extensions' own tests.

**The `history/` golden's scripted shape** (≥ 300 scopes in its merged bucket, per §6.8's floor —
size it the way `typescript/spec.ts` documents its own 400-scope arithmetic). The list below groups
the commits by the role each plays, **not** strictly by position in the commit array: item 9's nine
pair commits and item 10's day-200 fix commit interleave, and the array `buildGoldenRepo` receives
is all of them ordered by `dayOffset`. That sequence is **strictly ascending**, enforced by the
monotonicity guard above, so every quantity this script states — `first_seen`, `last_modified`,
`churned_early`, `stable_days`, `last_human_commit_ts` — is derivable by hand from the day offsets
on this page. No mechanism depends on that ascent (D16); the *reader* does.

**Every scope count below counts the mandatory `file` scope, and that is stated once here rather
than repeated per item.** `extractUnits` appends **exactly one** `file`-kind scope to every parsed
file, unconditionally, after the named-body walk (`src/roots/extract.ts:530-556`; §6.3, "exactly one
per file" — its own header note at `:396-397` says the append happens "regardless of how many (if
any) named-body scopes the walk found"). So a file R4 extracts contributes `named-body scopes + 1`,
an empty-but-parseable file contributes exactly 1, and a path R4 does **not** extract — no
registered grammar, or excluded by either of D17's gates — contributes none at all. Read every
count on this page that way; a per-item count that omitted the file scope would not be
hand-derivable, which is the property this page claims.

1. **day 0** — the bulk seed, and its file set is stated as a **partition** so the scope arithmetic
   is a sum rather than an estimate with two overlapping riders: **≈ 88 ordinary files** × ~4
   **named-body** scopes (so ≈ 5 scopes each once the mandatory `file` scope is counted) ⇒ ≈ 440
   scopes, **plus the two placeholders** described next (two files, **one** scope between them),
   **plus the two stubs** described after that (two files, **two** scopes) — ≈ **92 files and ≈ 443
   scopes** in this one commit. Uniform conventions, author `alice`. One test-pattern seed file
   (`test/order.spec.ts`, item 9's pair partner — `test/ship.spec.ts` is deliberately NOT here:
   item 11 creates the whole ship pair at day 300, which is what makes those scopes' `first_seen`
   day 300) fails D17 gate 2 via `**/*.spec.*`, contributes **zero** scopes and no lifecycle row,
   and is **outside the ≈ 88** — so this commit LISTS ≈ 93 files while the scope-bearing partition
   stays ≈ 92 files / ≈ 443 scopes. Reading the placeholders and
   the stubs as *inside* the ≈ 88 rather than beside it would double-count roughly eight scopes,
   which is why the breakdown is written as a partition here. 93 listed files (the gate-1-surviving record count, which is what the cap measures) is far above
   `megaCommitFileCap` 30, so the commit is excluded from co-change entirely
   (`v6-spec.md:622`) — which is exactly why the `commits(a)` denominators in the two pair
   populations below count the pair commits and nothing else.
   **Two of those 92 files are deliberately empty, and they are the same blob:**
   `src/svc/placeholder.ts` (registered grammar ⇒ extracted, `skipped: false`, and — like every
   parsed file — carrying the one mandatory `file` scope and **no named-body scope**) and
   `docs/PLACEHOLDER.md` (no registered grammar ⇒ never keyed, never extracted, no scope of any
   kind). Every empty file in every git
   repository is the blob `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`, so this pair is one sha
   reaching two paths with **opposite** extraction verdicts — D4's arrival-order case, which
   nothing else in this plan's fixtures exercises and which T8 acceptance 8(b) asserts by value.
   So the pair adds **two files and one scope** — the `.ts` file's file scope; the `.md` file's
   nothing — and Step 3's floor check counts
   scopes and still clears §6.8's 300 with margin. Both are inside
   the day-0 seed, which the mega-commit cap already excludes, so **no co-change number on this
   page moves either**; and neither is an `order`/`ship` pair file, a day-20 cohort file, one of
   item 6's six renamed files or one of item 7's three deletes.
   Git lists a commit's `--raw` records in path order, so `docs/PLACEHOLDER.md` arrives **before**
   `src/svc/placeholder.ts` — which is what makes the fixture a killer rather than a decoration: a
   `historyStats` implementation that decides a sha's `parsed` contribution on its **first**
   appearance sees the no-grammar verdict first and undercounts.
   **A second same-blob pair sits beside it, and it is the one that separates the two mutants D4's
   two-roster rule is aimed at:** `src/stub/same.ts` and `src/stub/same.py`, both carrying the
   identical one-line body `x = 1`. That line is a bare assignment statement in **both** grammars,
   so neither file yields a named-body scope and each contributes exactly its one mandatory `file`
   scope — **two files, two scopes**, one blob sha. Unlike the placeholder pair, **both** paths
   clear both of D17's gates, so both are keyed — and their keys differ, because `blobCacheKey`
   folds the **per-grammar** `bindingHash` of the path's own grammar (T4's interfaces). One sha,
   two keys, both `skipped: false`. That is D4's "`parsed` may exceed `blobs`" case made visible on
   a golden: the sha enters `blobs` once while the key roster gains two entries. The placeholder
   pair kills the *arrival-order* mutant (a sha-keyed roster fed by keyed and unkeyed records where
   first appearance decides); this pair kills the *two-grammar* mutant (a sha-keyed roster
   restricted to keyed records, which the placeholder pair leaves alive because it never sees the
   `.md` verdict at all). Neither stub is an `order`/`ship` pair file, a day-20 cohort file, one of
   item 6's six renamed files or one of item 7's three deletes, and nothing ever re-touches either,
   so their two scopes sit in the day-0 `w = 1.0` population and no number elsewhere on this page
   moves.
2. **day 20** — a *change* event **and** a new cohort, in one commit: add a decorator to 10
   existing day-0 scopes without touching their bodies (the exact event class a body-only
   signature misses — `v6-spec.md:252`), **and** add 10 **new** decorated files carrying one
   named-body scope each, so — counting each new file's mandatory `file` scope — **20** scopes
   (10 named-body + 10 file) have `first_seen` = day 20. The new files matter: item 3 needs a
   population whose `first_seen` is not day 0 and whose first modification is early enough to
   churn, which neither of the script's other file-creating commits (day 300's `ship` pair, day
   395's fresh cohort) supplies.
   **The ten decorated day-0 scopes are named in the spec and are subject to the same exclusions
   items 6 and 7 carry:** none of them lives in `src/svc/order.ts` or `test/order.spec.ts`, in the
   six files item 6 renames, or in the three item 7 deletes. Without that exclusion this commit
   would touch an `order` pair file, `commits(order.ts)` would be **10** rather than 9, and
   confidence would fall to 0.9 — falsifying item 9's and T8's stated `9/9 = 1.0`. This commit
   changes **20 files** (10 modified + 10 added) — the file count and the scope count both land on
   20 here by coincidence, not by construction, so read each against its own noun — inside the
   counted 2…30 band, so it contributes
   `20×19/2 = 190` pairs at support 1 — every one of them far below `minSupport` 8, and none of
   them recurring anywhere else in the script except among the ten new files, which item 3 touches
   again for support 2. State that in the spec's own comment so no co-change number on this page
   is left implicit.
3. **day 30** — the *early-churn* case: rewrite all 10 files born at day 20 (an in-place body
   change — same scope names, same kinds, no renames — so every scope key survives), author `alice`.
   30 − 20 = 10 ≤ `churnEarlyDays` 14 (`v6-spec.md:612`; `config-parser.ts:50`), so those scopes
   are `churned_early`. The two populations are then explicit and hand-checkable: **the 20 scopes
   born day 20 and churned at day 30 — the 10 named-body scopes and the 10 `file` scopes of the
   same 10 files, which share their files' touches exactly ⇒ `w_churn` 0.25 for all 20**, and
   **every day-0 scope, whose first
   modification — where one happens at all — is at day 20 or later, and 20 > 14 ⇒ `churned_early`
   false ⇒ `w_churn` 1**.
4. **day 60** — an *agent* commit: author `claude <claude@golden.test>` adding **three new files**
   carrying 12 named-body scopes between them, so **15** scopes counting each file's mandatory
   `file` scope. Three changed files sits inside the counted 2…30 band, so the
   commit contributes its three pairs at support 1 — far below `minSupport` 8, and no pair among
   the three recurs anywhere else in the script. The three are named in the spec and, like items 6
   and 7, **none of them is an `order` or `ship` pair file, a day-20 cohort file, one of item 6's
   six renamed files or one of item 7's three deletes**, so no `w_churn`, `first_seen`,
   `commits(a)` or confidence stated elsewhere on this page moves. Nothing ever re-touches these
   three (item 5 deliberately picks day-0 files instead), so their fifteen scopes have no first
   modification, `churned_early` false, `stable_days` 400 − 60 = 340 ⇒ `w_surv` 1, and
   `w_prov` 1 at 340 ≥ `agentPromoteDays` 180 — weight **1.0**, in the same bucket as the day-0
   seed rather than a population of their own.
5. **day 65** — a human-authored commit carrying a `Co-Authored-By: Cursor <…>` trailer, which
   classifies `authorKind: 'agent'` on the trailer alone (G.2, `v6-spec.md:1016`). It **modifies
   three day-0 seed files** (named in the spec) and nothing else: three changed files, inside the
   counted band, contributing three pairs at support 1 that recur nowhere else. The three are
   **none of item 4's new files** — a modification 5 days after their birth would make those
   fifteen scopes `churned_early` and add a second 0.25 population T8 Step 5 does not enumerate —
   and none
   of them is an `order`/`ship` pair file, a day-20 cohort file, one of the ten day-0 files item 2
   decorates, one of item 6's six renamed files, one of item 7's three deletes, or either of item
   1's two empty placeholders. Their first modification is therefore day 65, and 65 > 14, so
   `churned_early` stays false exactly as item 3 states for every day-0 scope; their `authorKind`
   becomes `agent` at `stable_days` 400 − 65 = 335 ≥ `agentPromoteDays` 180 ⇒ `w_prov` 1, so their
   weight stays **1.0** and no population moves. Stating item 5's file set is not a detail: left
   unspecified, its pair contribution, its churn effect and its effect on every `commits(a)`
   denominator are not hand-derivable, which is the property this page claims for every commit on
   it.
6. **day 90** — a **rename** commit: `git mv src/legacy/ src/archive/`, moving **six** day-0 seed
   files with no content change (the lifecycle continuity case). The six are named in the spec and
   are none of the day-20 cohort files, neither `order` pair file, neither `ship` pair file and not
   `NOTES.md`, so no `w_churn`, `first_seen` or co-change number stated elsewhere in this script
   moves. Six changed files sits inside the counted 2…30 band, so the commit contributes its 15
   pairs at support 1 — far below `minSupport` 8, and no pair among those six recurs anywhere else
   in the script.
7. **day 120** — a **delete** commit removing **three** day-0 seed files under `src/scratch/`,
   named in the spec. Like the rename, none of the three is a day-20 cohort file or an
   `order`/`ship` pair file; three changed files contribute three pairs at support 1 and nothing
   else.
8. **day 150** — a **mega-commit**: 40 files touched in one commit (above
   `megaCommitFileCap` = 30 ⇒ contributes nothing to co-change). **The forty are day-0 seed files
   named in the spec, and they carry the same exclusion sentence every other commit on this page
   carries**, because this is the one commit large enough to collide with all of them at once:
   none of the forty is an `order`/`ship` pair file, a day-20 cohort file, one of the ten day-0
   files item 2 decorates, one of item 4's three
   agent-authored files (item 4 states "**Nothing ever re-touches these three**" — a constraint this
   commit must honour and cannot see from its own item), one of item 5's three, one of item 6's six
   renamed files, one of item 7's three deletes, item 10's fix file, `NOTES.md`, either placeholder or either
   stub. Nothing stated
   anywhere on this page moves under that choice; unstated, the page's hand-derivability claim would
   rest on the implementer picking forty files that happen to avoid every named cohort.
9. **days 160, 170, 180, 190, 210, 220, 230, 240, 250** — **nine** ordinary commits, each
   touching exactly the same **pair** of files (`src/svc/order.ts` + `test/order.spec.ts`) and
   nothing else. Support(order.ts, order.spec.ts) = **9 ≥ `minSupport` 8**
   (`v6-spec.md:187`; `config-parser.ts:112`), and no other *counted* commit touches either file
   — the day-0 seed is excluded by the mega-commit cap — so `commits(order.ts)` = 9 and
   confidence = 9/9 = **1.0 ≥ `minConfidence` 0.75**. This pair, and only this pair, persists.
10. **day 200** — a `fix: …` commit touching **one** day-0 file (`fix_touches` on that file's
    scopes). **That one file is named in the spec and carries the same exclusions**: it is not an
    `order`/`ship` pair file, not a day-20 cohort file, not one of item 4's three, not one of item
    5's three, not one of item 6's six renamed files, not one of item 7's three deletes, and not a
    placeholder or a stub. Its first modification is therefore day 200, and 200 > `churnEarlyDays`
    14, so `churned_early` stays false exactly as item 3 states for every day-0 scope. A one-file
    commit has fewer than 2 changed files, so it contributes no pair and
    moves no `commits(a)` denominator; it is sequenced between the day-190 and day-210 pair
    commits purely to keep the offsets ascending.
11. **days 300, 320, 340, 360, 380** — **five** ordinary commits each touching a second pair
    (`src/svc/ship.ts` + `test/ship.spec.ts`) and nothing else, **every one of them authored by the
    human `alice`** — never `claude` and never carrying an agent trailer, because T8's `agentShare`
    criterion asserts this population is non-empty *and* has no agent-authored member. The pair is
    **created by the
    day-300 commit**: neither file exists in the day-0 seed, so the `ship` scopes' `first_seen` is
    day 300, their first modification is day 320 (20 > `churnEarlyDays` 14 ⇒ `churned_early`
    false), and their `last_modified` is day 380 — `stable_days` = 400 − 380 = 20 at the clock ⇒
    `w_surv = min(1, 20/120) = 0.166667`. That is the one weight in this golden whose un-floored,
    un-saturated `w_surv` is visible in the model — the other three hand-derivable values (1.0,
    0.25 and the floored 0.05) are each pinned by a saturation or a floor rather than by the
    survival ratio itself — and it is what makes a wrong clock visible (MR-26). Support 5 <
    `minSupport` 8, so
    this pair deliberately never clears the floor: it is the negative control proving the filter
    actually runs, and without it a broken filter would look identical to a working one.
12. **day 395** — the *fresh-code* cohort, deliberately **inside** the clock's 14-day fresh
    window: **one** new file (`src/svc/refund.ts`) carrying **exactly three top-level functions,
    none of them containing a further scope**, so all three are `method`-kind by §6.2's
    container/leaf rule (`src/roots/extract.ts:370-372`: `type` when the body subtree holds another
    scope node, `method` otherwise) — **three `method` scopes plus the one mandatory `file` scope,
    four in all**. All three
    conform to a
    convention the day-0 seed already established — the same surface T8 acceptance 2 reads, so all
    three are inside that surface's domain and carry its expected value. **The kind and the count
    are both pinned, and neither is a stylistic choice.** Cells — and therefore facts — are
    partitioned by scope kind (`CELL_KINDS = ['method', 'type', 'file', 'module']`,
    `src/roots/mine-stages.ts:371`; the three cell constructions at `src/roots/mine.ts:290`,
    `:329`, `:356` each build per kind out of `unitsByKind`), so no single fact's counts can ever
    see this file's `file` scope **and** its named-body scopes together: a `method`-kind fact sees
    the three methods and a `file`-kind fact sees the one file scope. A cohort spread over two
    kinds, or one whose named-body count is a range, makes T8 acceptance 2's delta
    unstateable — which is exactly the arithmetic that criterion hand-derives.
    **Authored by the human `alice`** for the same
    reason item 11 is — this cohort is the other half of the population T8's `agentShare === 0`
    rests on, and one agent author here would make it `> 0`. One changed file is fewer than 2, so the commit
    contributes no co-change pair and moves no `commits(a)` denominator — every number in items 9
    and 11 is untouched. Its scopes are 400 − 395 = **5 days old** at the clock, so `age_days`
    5 < `freshPenaltyDays` 14 ⇒ **unsurvived**, and `w_surv = (5/120) × 0.5 = 0.020833` floors to
    `baseFloor` **0.05**. Without this cohort every instance in the golden is survived, and T8's
    "the survived population is visibly not the raw one" criterion is vacuously true — the same
    failure mode D8 exists to prevent, one level up.
13. **day 400** — the trailing `NOTES.md` commit (D8's clock anchor).

That is **25 commits** (1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 9 + 1 + 5 + 1 + 1) at 25 strictly ascending
day offsets: 0, 20, 30, 60, 65, 90, 120, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250,
300, 320, 340, 360, 380, 395, 400.

**Steps.**
- [ ] **Step 1: Extend the fixture helpers additively**, with a test proving the existing helpers'
  output is unchanged (two builds of an unmodified landed spec still produce identical SHAs —
  `git-fixture-determinism.test.ts` is the existing pattern). Land the `dayOffset` monotonicity
  guard in the same step, with a test that a deliberately out-of-order spec throws before any
  repository is created — a guard nothing exercises is a comment. Land
  `tests/support/branch-merge-fixture.ts` here too (Files list), lifting the shape T2's local
  capture pinned and asserting the two agree on branch topology and on the date dip.
  **A `dayOffset` cannot be delivered through `extraEnv`, and that is the natural implementer move
  — a silent-failure trap, not a detail.** `deterministicGitFixtureEnv`
  (`tests/support/git-fixture.ts:201-215`; the load-bearing "they always win" sentence is its doc
  comment at `:196-199`) merges `extraEnv` into the underlying `gitFixtureEnv`
  call and *then* applies `TZ`/`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` on top, and its own doc
  comment says so in as many words ("they always win"). `roots-golden.ts`'s `runOrThrow` already
  passes `authorEnv(commit.author)` through `extraEnv`, so putting a date beside it looks right,
  compiles, runs, and is **silently discarded** — every commit keeps its index-derived instant and
  the whole scripted history quietly collapses onto 60-second spacing.
  Every date must therefore travel through the **`commitIndex` grid**, which expresses a day
  offset exactly: `DETERMINISTIC_COMMIT_INTERVAL_MS` is 60 000 ms, so 1440 indices are one day and
  `deterministicCommitDateAt(day, seq) = deterministicCommitDate(day * 1440 + seq)` — the `seq`
  slot leaving room for several commits inside one day where a fixture needs them. That mapping is
  what `dayOffset` compiles to in `buildGoldenRepo`, what `branch-merge-fixture.ts` uses, and what
  T9 case (b)'s day-390/day-410 appends use. Pin it with a test that reads the built commit's `%ct`
  back and compares it against the epoch plus `day * 86400`.
- [ ] **Step 2: Add the trailing commit to the seven specs, rebuild the seven bundles**, and run
  every landed golden suite **without editing a single expectation**. If any expectation moves,
  STOP: the trailing commit was supposed to add no scopes and no partition marker, and something
  else changed.
- [ ] **Step 3: Write the `history/` golden** exactly as scripted above — 25 commits, strictly
  ascending offsets — build its bundle, assert equivalence, and assert its size clears §6.8's
  300-scope floor with margin (named-body + file scopes, the denominator `partitions.ts`
  documents). Assert the two co-change populations by hand from the built repository before any
  mining code reads them: nine commits touch the `order` pair, five touch the `ship` pair.
- [ ] **Step 4: Graph ritual + report** (new fixture files join the fixtures node's directory
  mapping; `tests/support/branch-merge-fixture.ts` joins the `tests/support` node's mapping and its
  description; the new test file joins the roots unit test node per file).

**Acceptance criteria.**
1. `assertGoldenBundleEquivalence` passes for all **eight** goldens.
2. Every landed golden test passes with no expectation edit in this task's diff.
3. Building the `history/` golden twice yields identical HEAD SHAs.
4. `git log` in the built `history/` golden shows the **25** scripted commits with the scripted
   dates, strictly ascending from day 0 to day 400 — so the builder's array order, the parent chain
   and the day offsets written on this page are all the same order, and every derived quantity the
   script states can be re-derived by hand from the offsets alone.
5. A spec whose `dayOffset` sequence decreases anywhere throws from `buildGoldenRepo`, naming the
   golden and the offending index, before any repository is created.
6. In the built `history/` golden, `src/svc/order.ts` and `test/order.spec.ts` are touched
   together in exactly nine commits of 2 files each, and `src/svc/ship.ts` /
   `test/ship.spec.ts` in exactly five — the supports T6 and T8 are written against. Neither
   `order` file, neither `ship` file and none of `NOTES.md` appears in any *other* counted commit:
   assert that too, since it is the day-20 / day-60 / day-65 / day-90 / day-120 exclusions that
   make `commits(order.ts)` equal 9 rather than 10 and confidence exactly 1.0.
7. **Both shapes of the helper, since its `trailingMainCommit` default decides which one you
   get.** `buildBranchMergeFixture()` — no options, so `trailingMainCommit` is its default
   **`true`** — produces, twice on the same machine and reproducibly across
   machines, the **five-commit** history: the side-branch commit's committer date is **earlier**
   than the main-line commit it is merged past, `git log --reverse --date-order --no-merges`
   delivers the side-branch commit *before* that main-line commit, and **HEAD is `main2`, whose
   parent is the merge** — the merge sits *inside* the history, which is the shape T5's
   order-independence and split-walk acceptances need. `buildBranchMergeFixture({trailingMainCommit:
   false})` produces the **same topology and the same dip stopping at the merge, so HEAD *is* the
   merge commit** — the variant T8's control (iv) and T9's case (g) consume. Assert each against
   its own shape; asserting "HEAD is the merge" of the default call is the contradiction this
   criterion exists to avoid, and "fixing" it by flipping the default breaks T5's acceptances 8–9.
   Both halves are the same topology and the same dip T2's local capture pinned, from an
   independent construction.
   `appendMergeOfOlderSideBranch` applied to a freshly built `history/` golden leaves HEAD a merge
   whose second parent is dated before the golden's own tip.
   **Assert the content contract here too, since this task owns it and T5 acceptance 8 spends it:**
   in the default variant, the side-branch commit adds an extracted file carrying at least one
   named-body scope that exists in no earlier commit, `main1` touches only `base`'s file, and
   `main2` touches only the side branch's — so a scope born on the side branch has a first commit
   and a strictly later last touch, both derivable from the day offsets. A fixture whose commits
   write nothing satisfies every topology clause above and makes T5's acceptance unwritable.
8. In the built `history/` golden, `src/svc/placeholder.ts` and `docs/PLACEHOLDER.md` are both
   empty and `git log --raw` reports the **same** blob sha for both —
   `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` — with `docs/PLACEHOLDER.md` listed first in the
   day-0 commit's records. Assert the shared sha and the record order here, at the fixture level,
   so T8 acceptance 8(b) can assert the `historyStats` consequence without re-deriving the premise.
   **The second same-blob pair in the same commit, which is the premise T8 acceptance 8(c) reads:**
   `src/stub/same.ts` and `src/stub/same.py` carry byte-identical one-line content and therefore
   one shared blob sha too — assert that the two paths report the same sha, that the content is
   identical, and that the two extensions resolve to **different** registered grammars
   (`src/utils/language-registry.ts`: `.ts` → typescript, `.py` → python), which is what makes
   their two cache keys differ from one shared sha.

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
binding cache (`:237`), §6.4 ordinals across key spaces (`:247`), §6.8's exclusion list (`:271`,
D17), §20.1 blob-rate budget (`:712`);
program plan's key clause (`:75-76`); Appendix F's cache row (`:972`); code:
`src/roots/partitions.ts:78-136` (`BUILT_IN_EXCLUSIONS` and `makeRootsFileFilters` — this task
imports the factory rather than re-deriving either predicate; roots-engine → roots-engine, already
an allowed edge),
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
// any unrelated grammar moves. A blob whose historical path **fails D17's gate 2** — no registered
// grammar for its extension, or excluded from the parse set by `makeRootsFileFilters(config)
// .forParsing` (§6.8's merged built-in + config exclusions plus the mining-only test-pattern
// carve-out) — has no binding at all, so it is resolved BEFORE any key is computed:
// `makeBlobRecordReader` returns an **in-memory** `{bytes: 0, skipped: true, reason: 'no-grammar' |
// 'excluded'}` record and never touches the
// cache — never keyed, never probed, never written, never fetched (D11, D17, D4, R4-I6; T8 Step 1's
// probe-then-fetch protocol states the same rule from the caller's side). Both answers are pure
// functions of the path, so caching either would buy nothing and cost one JSON file per
// distinct blob of every non-code file in the whole history.
export function blobCacheKey(blobSha: string, extractorVersion: string, bindingHash: string): string;
export interface BlobScopeRecord {
  bytes: number;            // D4's `mb` input
  skipped: false;
  scopes: StoredRawScope[]; // RawScope minus the two grammar constants (D11)
}
// `reason` has four values but only TWO of them are ever persisted: `oversize` and `unparseable`
// are knowable only after the bytes are in hand or a parse has been attempted, so recording them is
// what makes the skip permanent. `no-grammar` and `excluded` are produced in memory from the path
// alone and are never written (above) — they are D17 gate 2's two causes, kept distinct because a
// reader of a `debugWrite` line needs to know which one fired.
export interface SkippedBlobRecord { bytes: number; skipped: true; reason: 'oversize' | 'no-grammar' | 'excluded' | 'unparseable' }
export type BlobRecord = BlobScopeRecord | SkippedBlobRecord;
// The blob arrives as bytes and is decoded as UTF-8 for parsing, because `withParsedFile` takes
// a `string` (`src/ast/parser.ts:134-137`); but `bytes` and the `blobMaxBytes` comparison are
// the **raw byte length before decoding**, matching the live path's
// `Buffer.byteLength(content, 'utf8')` check at `pipeline.ts:126`. A decode that produces
// replacement characters is still parsed — content is never sniffed (R4-I6).
export function extractBlobRecord(relPath: string, content: Buffer, config: RootsConfig): Promise<BlobScopeRecord | SkippedBlobRecord>;
export function makeBlobRecordReader(cacheDir: string, config: RootsConfig, onParsed?: () => void): (sha: string, relPath: string, content: Buffer | undefined) => Promise<BlobRecord>;
```

**Steps.**
- [ ] **Step 1: The parse gate, and grammar selection by historical path only.** Apply **D17's
  gate 2** first, from the historical path alone and before any cache key exists: run
  `makeRootsFileFilters(config).forParsing(historicalPath)` — the same factory the live pipeline
  composes from (`src/roots/partitions.ts:127`), never a second exclusion list — and then resolve
  the grammar with `getGrammarForExtension(path.extname(historicalPath))`. A path failing either
  half yields an **in-memory** skip record (`reason: 'excluded'` or `'no-grammar'`) returned before
  any cache key exists, with nothing written to the cache (Interfaces, D11, D17). Gate 1
  (`forMarkers`) is the **caller's**: a record failing it never reaches this reader at all (T8
  Step 1, T6 Step 1). **Never** inspect content to guess (R4-I6).
  Note what is and is not in the registry before writing the test: `.json`, `.yaml`, `.yml` and
  `.toml` **are** registered, so `package-lock.json` is a parse candidate like any other file; the
  no-grammar cases are `yarn.lock`, `NOTES.md`, `.png`. Reuse `pipeline.ts`'s asset-name rule
  and per-grammar binding cache — extract the shared helper rather than copying it, and note in
  the report if extracting it touches `pipeline.ts` (a roots-engine → roots-engine edge, already
  allowed).
- [ ] **Step 2: Extraction.** Parse via `withParsedFile(historicalPath, content, …)` — the pool
  keys the grammar off that path, which is what makes R4-I6 structural rather than a check — and
  call the *same* `extractUnits` the live path calls, so ordinals and `qualifiedName` are
  identical in both key spaces (R4-I7). Oversize (`> history.blobMaxBytes`) ⇒ a recorded skip
  *before* parsing (`v6-spec.md:607`). A throw from the parser ⇒ an `unparseable` skip plus one
  `debugWrite`, and the caller continues (R4-I10).
  **The historical reader applies the live path's *second* size gate too, and that is stated here
  because the plan otherwise names only `blobMaxBytes`.** `parseAndExtractAll` skips a file on
  either of two conditions — `Buffer.byteLength(content) > config.history.blobMaxBytes`
  (`pipeline.ts:126`) **and** `content.split('\n').length > 40000` (`:127`, the constant at
  `:117`) — and the historical reader applies **both**, in that order, with the same 40 000
  threshold. Two reasons, either sufficient: R4-I7's one key space only holds if the two paths admit
  the *same* files, and a file the live pass never parses would otherwise acquire historical scopes
  that join nothing while inflating `parsed` and `mb` (D4). The line count is knowable only once the
  bytes are in hand, so it is an **expensive** skip in D11's sense and is **recorded**, under the
  existing `reason: 'oversize'` — no fifth reason value is added, because the record's purpose is
  "do not fetch and re-attempt this key", which is identical for both gates. Assert it: a blob of
  40 001 one-character lines, comfortably under `blobMaxBytes`, records
  `{skipped: true, reason: 'oversize'}` and is never parsed on this run or any later one.
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
   this run or any later one. **The second size gate in the same criterion:** a blob of 40 001
   one-character lines — well **under** `blobMaxBytes`, so only the line count can reject it —
   records the same `{skipped: true, reason: 'oversize'}`, matching the live path's own second
   condition (`pipeline.ts:127`, constant at `:117`) and keeping the two paths' admitted file sets
   identical (R4-I7, Step 2). A 39 999-line blob of the same shape extracts normally, which is what
   makes the criterion about the **gate** rather than about the fixture.
6. Records land at `<cacheDir>/<key[0:2]>/<key>.json` — one directory per 2-hex prefix, one file
   per key, per D14; never §13.2's aggregate `<2-hex>.json` shard file.
7. A blob whose historical path is `NOTES.md` (or `yarn.lock`, or a `.png`) returns
   `{bytes: 0, skipped: true, reason: 'no-grammar'}` and leaves the cache directory **byte-for-byte
   unchanged** — no shard directory created, no file written, and no `readBlobs` fetch issued for
   it. Assert the empty cache directory, not merely the returned record: the whole point is that
   the answer costs nothing to recompute and so is never stored.
8. **D17's gate 2, on its exclusion half.** A blob whose historical path is
   `dist/index.js`, `vendor/lib.ts`, `src/types/api.d.ts` or `src/foo.test.ts` — every one of them
   a real registered-grammar path, so the extension test alone would admit all four — returns
   `{bytes: 0, skipped: true, reason: 'excluded'}` and leaves the cache directory byte-for-byte
   unchanged, exactly as criterion 7 requires of the no-grammar half. `src/foo.ts` in the same
   test extracts normally, which is what makes the criterion about the **filter** rather than
   about the fixture. A path in the project's own configured `exclude` behaves identically, since
   `makeRootsFileFilters` merges the two lists (`v6-spec.md:271`).
9. **An empty blob is `parsed`, not skipped.** An empty `src/empty.ts` extracts to
   `{bytes: 0, skipped: false, scopes: [<the single mandatory `file` scope>]}` — **one `file` scope
   and no named-body scope**. `extractUnits` appends that scope unconditionally, after the walk,
   for every parsed file (`src/roots/extract.ts:530-556`; §6.3, "exactly one per file"; the
   function's own header note at `:396-397`), and `parseAndExtractAll` has no empty-file
   short-circuit (`src/roots/pipeline.ts:107-137`), so `scopes: []` is **unreachable** and asserting
   it would fail against a correct extractor — and the tempting "fix", special-casing empty files
   inside `extractUnits`, is a real regression against §6.3. Assert `scopes.length === 1` and
   `scopes[0].kind === 'file'`. The criterion D4's `parsed` reads is `skipped: false`, never
   "produced at least one **named-body** scope". The same empty blob at
   `docs/EMPTY.md` yields the in-memory `no-grammar` record instead — **one sha, two opposite
   verdicts, one of them keyed and one of them not** — which is the collision T8 acceptance 8(b)
   measures at the `historyStats` level.

**Test obligations / mutation round-trips.**
- **MR-8 (path-derived grammar):** replace the path-extension lookup with a content sniff ⇒
  acceptance 4 fails.
- **MR-9 (cache key completeness):** drop `extractorVersion` (or `bindingHash`) from the key ⇒
  acceptance 2 (or 3) fails.
- **MR-10 (skip recording, both directions):** treat an oversize blob as a cache miss instead of a
  recorded skip ⇒ acceptance 5's "never parsed on any later run" half fails. Conversely, key and
  persist the `no-grammar` case (the sentinel-in-the-`bindingHash`-position spelling an earlier
  draft prescribed) ⇒ acceptance 7 fails on the untouched-cache assertion. Third mutation, on
  D17's gate 2: **delete the `forParsing` half of Step 1's gate**, keeping only the
  registered-grammar test ⇒ acceptance 8 fails on all four of its excluded paths, every one of
  which the extension test alone admits. Fourth mutation, on the second size gate: **delete the
  40 000-line condition**, keeping `blobMaxBytes` ⇒ acceptance 5's line-count half fails, since the
  40 001-line blob extracts instead of recording a skip.

**NON-goals.** No lifecycle, no events, no walking (T5, T9 own those). No pipeline wiring.

---

## Task 5 — Replay: per-scope lifecycle, value events, aliases

**Scope.** Fold the walk's commit records into the two artifacts everything downstream reads —
lifecycle rows and value events — plus the rename alias edges. **The fold is over the commit *set*,
not over a sequence** (D16): `replayCommit` may be handed the same records in any order and
`finishReplay` must return byte-identical output. That is not a nice-to-have here; it is what makes
a resumed index equal a full one (R4-I2), because a resume range is a set difference and not a
suffix of anything.

**Authorities.** Spec §13.3 in full (`v6-spec.md:609-615`), §6.5 change signature (`:249-252`),
§6.4 ordinals (`:244-247`), §9.1's lifecycle-row fields (`:368-379`), §18.2/§18.3 for what
`author_kind` and `last_human_commit_ts` are later used for (`:683`, `:685`); design §12's
lifecycle rows (`integration-design.md:439-467`); Appendix F rows `:974`, `:975`.

**Files.**
- Create `source/cli/src/roots/history-replay.ts`.
- Create `source/cli/tests/unit/roots/history-replay.test.ts` — acceptances 8 and 9 build on
  `tests/support/branch-merge-fixture.ts` (T3's Files list), so confirm the roots unit test node
  carries the `{target: cli/tests/support, type: uses}` relation and declare it if it does not.

**Interfaces produced.**
```ts
export interface LifecycleRow {
  // A SCOPE-level row's key is `skeyR` — `relPath#kind#qualifiedName` (D6). A FILE-level row's key
  // is the bare `relPath`, with no `#` component at all, which is what makes T7's
  // `LifecycleIndex.rowFor(skeyR, relPath)` a two-step lookup in one table (scope key first, path
  // second) rather than two tables. The two key spaces are therefore DISJOINT and `key` alone is
  // already a total sort key; `lifecycle.jsonl` still sorts by `(key, level)` (T1) so the two
  // levels group readably and the order is stated rather than incidental, never because `key`
  // needed a tie-break.
  key: string;
  level: 'scope' | 'file';
  firstSeenTs: number;              // min touch ts
  // Second-smallest DISTINCT touch ts, or null when the scope has been touched once. Carried as a
  // field rather than folded into `churnedEarly` because the persisted row IS the accumulator (D1):
  // a later run can deliver a commit older than everything already recorded, which moves both the
  // birthday and the first modification at once, and a stored boolean could not be recomputed.
  firstModifiedTs: number | null;
  lastModifiedTs: number;           // max touch ts
  modifications: number;            // distinct touching commits, minus the introduction
  churnedEarly: boolean;       // DERIVED at finishReplay: firstModifiedTs - firstSeenTs <= history.churnEarlyDays
  fixTouches: number;
  authorKind: 'human' | 'agent';   // kind of the touch with the greatest (ts, sha) — G.2
  lastTouchSha: string;             // that touch's sha; the tie-break `authorKind` needs across runs
  lastHumanCommitTs: number | null; // max ts over human touches
}
// `sha` is the commit the event came from. It is not a spec field; it is the tie-break that makes
// `(ts, key, kind, sha)` a TOTAL order **on the raw events** — the ones `events.jsonl` persists,
// whose `key` still carries the pre-rewrite path — without which two commits at the same second
// could write the event file in either order and break byte-identity (D5, D16).
// The qualifier is not decoration. AFTER `finishReplay` rewrites each event's path component
// through the alias closure (Step 5 (2)), the tuple is no longer total: two distinct live paths
// whose closures land on the same final path, both touched in one commit, produce two events
// identical in all four fields. Rows are explicitly MERGED on that collision; events explicitly
// are not. That is harmless in R4 — nothing serializes the finished event list and
// `historyStats.events` is a count of the raw ones (D4) — so the *semantic* question, whether such
// events should merge the way rows do, is recorded as **R6 debt**, to be answered when R6 first
// reads a finished event. R4 meanwhile keeps the returned ORDER deterministic by breaking such
// ties on the pre-rewrite key (Step 5), which is all byte-identity needs and decides nothing R6
// has to live with.
export interface ValueEvent { key: string; ts: number; kind: 'introduction' | 'change'; value: ValueTuple; authorHash: string; authorKind: 'human' | 'agent'; sha: string }
// One rename edge as the walk recorded it. Edges are accumulated raw and the chain is compressed at
// `finishReplay` (D1) — compressing during the walk would make the result depend on arrival order.
export interface AliasEdge { from: string; to: string; ts: number; sha: string }
// `events_n` is NOT `events.length`, and that is why it is a field rather than a derivation: it is
// the **raw** count the fold emitted, before Step 4(a)'s appearance-cap demotion removed a subset,
// and it is what `historyStats.events` accumulates (D4). `events` is the demoted, rewritten,
// sorted list. On a repository with a file touched in more than `lifecycleMaxAppearances` commits
// the two differ, by design.
export interface ReplayResult { lifecycle: LifecycleRow[]; events: ValueEvent[]; aliases: Array<[string, string]>; events_n: number }
// `records` resolves BOTH shas of every file record — the pre-image blob as well as the post-image
// one — because a change is `signature(postSha) != signature(preSha)` (D16). Order-free: calling
// this over the same commits in any order leaves `state` equivalent.
//
// `BlobRecordLookup` is keyed on **`(sha, relPath)`, never on `sha` alone**, and the shape is
// declared here because nothing else in the plan fixes it. Two reasons, either sufficient: a blob
// record depends on the path's grammar, not only on the content (T4's `makeBlobRecordReader`
// returns `(sha, relPath, content) => …`, and one sha routinely reaches two paths under two
// grammars — the `.ts`/`.py` stub pair in T3's day-0 seed is exactly that); and an `R`/`C` record's
// two shas sit at two different paths, the pre-image at `path` and the post-image at `newPath`
// (T8 Step 1), so a sha-keyed lookup could not even express the rename case:
//   interface BlobRecordLookup { get(sha: string, relPath: string): BlobRecord | undefined }
export function replayCommit(state: ReplayState, commit: HistoryCommitRecord, records: BlobRecordLookup): void;
export function finishReplay(state: ReplayState): ReplayResult;
```

**Steps.**
- [ ] **Step 1: The fold, and why it carries nothing between commits.** There is **no**
  `prevState[path]` map (D16). Each file record is folded on its own, using the two blob shas the
  record itself carries: `scopeKey = kind#qualifiedName` (ordinal inside `qualifiedName`), the
  post-image blob's records give the scope set after the commit, and the **pre-image** blob's
  records give the scope set before it — in that commit's own parent, which is what §13.3's
  "`prevState[path]`" (`v6-spec.md:610`) was always describing. So:
  - `A` (`preSha` null): every scope in the post-image is an **introduction**.
  - `M`/`R`/`C`: a scope key in both images with a different signature is a **change**; a key in the
    post image only is an **introduction**; a key in the pre image only is nothing (the scope left,
    and Step 4(b)'s rule keeps its row).
  - `R`/`C` additionally record an **alias edge** `{from: oldPath, to: newPath, ts, sha}` — one raw
    edge, appended to a set. **Chains are not compressed here.** `finishReplay` computes the
    closure (`a→b`, `b→c` ⇒ `a→c` and `b→c`) once, over the whole accumulated edge set, walking
    edges in `(ts, sha)` order — the exact one-pass algorithm, and why it is a pass rather than a
    fixpoint loop, is dictated in Step 5. Compressing during the fold would make the stored map
    depend on which run saw which edge.
    **The `C` half of that bullet is defensive and is unreachable under R4's binding flag set — say
    so in the code rather than letting a reader infer that copies are supported.** The walk is
    `-M` only, never `-C` (`plugin-marketplace-plan.md:75`), so git emits no copy records at all.
    The handling is written as `R`/`C` because the status union carries `'C'`, not because a copy
    behaves like a rename: a copy leaves the **source in place**, so recording `{from: source, to:
    dest}` as an alias edge would move the *source's* whole lifecycle history onto the copy and
    strand the original. Adding `-C` to the walk is therefore not a flag change but a design change
    that must revisit this edge rule first; note that in the file where the branch lives.
  - `D` records nothing beyond the fact of the touch (Step 4(b)). A `T` behaves identically — a
    touch and nothing else, never blob-resolved and never event-producing, landing on the path's
    **file-level row only** (no blob is resolved, so no scope key exists to touch, and reaching for
    scope rows the path is known to carry from other commits would be carried state, D16) — per the
    rule stated once on `HistoryFileRecord.status` (T2's interfaces). Acceptance 12 is its killer.
  Why this shape and not a carried map: a running previous-value map is not merely order-sensitive,
  it is **wrong on any branched history**. Two commits on divergent branches both edit the same
  file; whichever the walk hands over second is compared against the other branch's blob rather
  than against its own parent, and no ordering of the DAG avoids it (D16, with the fixture). The
  per-record pre-image is both correct and order-free, and it is why `prevstate.jsonl` does not
  exist.
- [ ] **Step 2: Lifecycle rows** per (path, scopeKey), every field per §13.3's list. Maintain
  **file-level rows in parallel, always** — they are the documented fallback for the 4–6 % of
  scopes the replay cannot resolve (`:612`), and a fallback computed only on demand is a fallback
  that was never tested. **"Always" means "for every path that clears both of D17's gates"**, and
  nothing else: a path the walk sees but R4 does not extract gets **no lifecycle row at all**,
  neither scope-level nor file-level. That covers both of gate 2's causes —
  a path whose extension has **no registered grammar** (`NOTES.md`, `yarn.lock`, a `.png`; note
  that `.json`, `.yaml`, `.yml` and `.toml` **are** registered and so do get rows) and a path
  only `forParsing` excludes (the `*.test.*`/`*.spec.*` mining carve-out — `dist/**`,
  `vendor/**` and `*.d.ts` are BUILT_IN_EXCLUSIONS and already fall at gate 1)
  — and gate 1's exclusions never reach the replay at all.
  Such a path is never fetched (D4), can never carry a scope,
  and a row for it would feed nothing while quietly making `max(lastModified)` over the lifecycle
  table equal HEAD's timestamp on every golden — hiding exactly the clock defect MR-26 exists to
  catch. An oversize or unparseable blob is the opposite case: its path clears both gates, so
  it keeps its file-level row. This is not in tension with §6.8's "non-code files are fully
  counted" (`v6-spec.md:271`): that clause governs co-change and the history's own counters, which
  do count them (T6 for co-change, T8 for the counters; D4, D17). Lifecycle rows exist only to
  weigh scopes, and a file whose scopes are never mined has nothing to weigh — a test file's live
  scopes are excluded by the same `forParsing` predicate, so a historical row for one would join
  nothing.
  **Every field is a set function of the row's touches, with a stated tie-break** (D16). A record
  **touches a scope row** exactly when the row's scope key is among the record's resolved
  post-image's scope keys — so a `T` or `D` record, which resolves no post-image scopes, touches
  file-level rows only (their own bullets below), and a record whose post-image still carries the
  scope touches it whether or not the value signature changed. Arrival
  order is not ascending by timestamp, not parent order, and not the same between a full walk and a
  resume, so no field may be last-write-wins:
  - `firstSeenTs = min(ts)` and `lastModifiedTs = max(ts)` over the row's touches.
  - `modifications` and `fixTouches` are plain counters over distinct touching commits (keyed by
    sha, so a commit folded twice cannot double-count).
  - `churnedEarly` is **derived at `finishReplay`** from the **two smallest** touch timestamps the
    row carries — `firstSeenTs` and `firstModifiedTs` — as `(firstModifiedTs − firstSeenTs) ≤
    churnEarlyDays`, `false` when `firstModifiedTs` is null. Both timestamps are persisted fields,
    not scratch: a later run can deliver a commit older than everything already recorded, which
    moves the birthday and the first modification together, and a stored boolean could not be
    recomputed. "The earliest modification I have seen so far after the birthday I have seen so
    far" is exactly the formulation that fails here.
  - `authorKind` describes the **most recent** touch, selected by the greatest
    `(committerTs, sha)`; the row carries that touch's `lastTouchSha` so the comparison stays
    decidable when a later run delivers a commit at the same second.
  - `lastHumanCommitTs` is `max(ts)` over the row's human-authored touches — a plain max, needing
    no tie-break.
  A row that simply overwrote on arrival would let a merged side branch rewrite a scope's birthday
  and silently invert `churned_early`; a row that took "most recent" as "last seen" would flip
  `authorKind` on the same history depending on where a resume boundary fell.
- [ ] **Step 3: Value events.** An **introduction** event for a scope key present in a record's
  post-image and absent from its pre-image (author = that commit's author — without it, values
  adopted in new code are invisible, `:614`), and a **change** event for a key present in both whose
  value-tuple signature differs between them. Both are computed from the one record, so the event
  set is a function of the commit set (D16) rather than of the order the walk delivered it in. The
  tuple (D5) carries `nameShape(name)`, first-statement type, return shape, sorted decorator
  list, sorted supertype list, sorted node types present, sorted callee texts; the signature is a
  sha256 over its canonical JSON. A decorator added with no body change **must** emit an event —
  that is the prototype-found defect this rule exists for. Each event carries the commit's `sha`,
  which is not consumed by any consumer in R4 and exists only to make Step 5's sort total.
- [ ] **Step 4: Cost guards, and what they do to rows already emitted.** A file over
  `history.lifecycleFileMaxKb` or appearing in more than `history.lifecycleMaxAppearances` commits
  stays **file-level only** (`:615`) — no per-scope rows, no per-scope events; record the demotion
  once with `debugWrite`. Two consequences the spec leaves open are fixed here, because the state
  is persisted and reloaded and both are load-bearing for R4-I2's byte-identity:
  **(a) the demotion is decided at `finishReplay`, over the total count, and applies
  retroactively.** The fold accumulates the per-path appearance counter and emits scope rows and
  scope events unconditionally; `finishReplay` then drops **every** scope row and scope event of any
  path whose accumulated count exceeds `lifecycleMaxAppearances`, leaving the file-level row —
  maintained in parallel from the file's first commit (Step 2) — to carry it. Deciding at finish is
  the only formulation that is both order-free and resume-safe: "demote from the crossing onward"
  depends on which commits arrived before the crossing, which is exactly what differs between a full
  walk and a resume, and the counter itself lives in `meta.json` across runs (D1). The same rule
  applies to rows loaded from a previous run's `lifecycle.jsonl`: they are dropped too, since the
  crossing may happen in this run.
  **One consequence D4 fixes rather than leaves open:** because a path can cross the cap in *this*
  run, no run can retro-subtract a previous run's contribution from a running sum, so
  `historyStats.events` counts the events the fold **emitted**, before this demotion — not the
  events that survive it. `finishReplay`'s returned list is therefore shorter than
  `historyStats.events` on any repository with a file touched in more than
  `lifecycleMaxAppearances` commits, and that is the defined behavior, not a discrepancy (D4).
  **(b) a `D` record prunes no lifecycle rows.** A deleted file's scopes keep their rows with their
  existing `firstSeenTs`/`lastModifiedTs`; the delete contributes its touch **to the file-level row
  only** and nothing else — the same D16 grounds as the `T` rule: crediting scope rows the path is
  "known to carry" would be carried state. The
  live join is by `skeyR` against the *current* tree, so a deleted path simply never joins and costs
  nothing; pruning would additionally destroy the rename case, where the alias closure will move the
  row to the new key at finish while the old path may still appear as a delete. Pruning would also
  be order-sensitive — whether the delete arrived before or after some other touch would decide
  whether a row exists — which alone disqualifies it (D16).
- [ ] **Step 5: Deterministic output, and the alias resolution that produces it.** `finishReplay`
  does four things in this order: (1) compute the alias closure over the accumulated edge set,
  walking edges by `(ts, sha)`; (2) rewrite every lifecycle row's and every event's `relPath`
  component through that closure to the path's final name, **merging** rows that land on the same
  `skeyR` by the same `min`/`max`/counter rules Step 2 uses (this is what gives a renamed scope one
  row carrying its original `firstSeenTs` — the rename is resolved at the end, not tracked as the
  walk goes); (3) apply Step 4(a)'s appearance-cap demotion; (4) sort. Rows sort by `(key, level)`
  — `key` alone is already total, since a scope-level key always carries a `#` component and a
  file-level key never does, so `level` is in the key to group the two levels readably and to keep
  the order stated rather than incidental, never as a tie-break `key` needed —
  events by `(ts, key, kind, sha)`, aliases by `from` then `to`. Rows and aliases are **totally**
  ordered. **Events are total on the raw list `events.jsonl` persists and only *nearly* total on
  the rewritten list this function returns**, since two live paths whose alias closures land on the
  same final path can collide in all four fields; ties among such events are broken by the
  pre-rewrite key so the sort is at least *stable and deterministic* here, and the residual R6 debt
  is recorded on `ValueEvent` above. Nothing in R4 serializes the returned list.
  A sort key that is merely *usually* unique is a byte-identity defect waiting for a fixture with
  two commits in the same second, which is why `sha` is in the event tuple at all. Neither the
  replay's own iteration order nor the walk's arrival order may leak into the state files or the
  model (R4-I1/I2, D16).
  **The closure is one linear pass, and the algorithm is dictated here rather than left to be
  invented, because the obvious formulation does not terminate.** `a→b, b→c ⇒ a→c and b→c` reads as
  a fixpoint, and a naive repeat-until-nothing-changes loop runs forever on a cycle — which git
  emits routinely: `git mv a.ts c.ts` followed later by `git mv c.ts a.ts` yields **two** `R100`
  records, `a.ts → c.ts` and `c.ts → a.ts` (verified). The dictated algorithm is: start from an
  empty map; walk the edge set once in ascending `(ts, sha)`; for each edge `(from, to)` set
  `map[from] = to` and then **retarget every entry already pointing at `from`** to `to`. One pass,
  no fixpoint, no cycle to spin on. On the rename-back pair it produces `map = {a.ts: a.ts, c.ts:
  a.ts}` — `a.ts` resolving to itself, which is the correct final name — and on the ordinary chain
  `a→b, b→c` it produces `{a: c, b: c}`, which is what clause (1) asks for.
  Three shapes the plan names so an implementer does not have to guess. **The outgoing case:** a
  `from` path carrying
  **two** outgoing edges at different times (reachable whenever a path is renamed away, re-created
  and renamed again) resolves to the **later** edge's target, because the later edge overwrites
  `map[from]` — the accepted approximation, since the closure is keyed on path alone and cannot
  tell the two incarnations apart. **Its incoming mirror, which the same approximation produces in
  the other direction:** `A→B`, then `B→C`, then `D→B` leaves `map = {A: C, B: C, D: B}` — so a row
  written at `B` **after** `B` was re-created by the `D→B` rename still resolves to `C`, the target
  `B`'s own earlier incarnation was renamed to. Same cause, same accepted cost: the map is keyed on
  path alone and cannot tell two incarnations of `B` apart. Name both in the module comment so a
  later reader recognises the behaviour as decided rather than as a bug. **And a *swap*** of two
  paths is not a rename cycle at all, since
  `-M` emits two `M` records for it rather than two renames (verified). Assert the rename-back case
  in this task's tests: it is the one input that separates the dictated pass from a fixpoint loop.
- [ ] **Step 6: Tests + graph ritual + report.**

**Acceptance criteria (hand-checkable, on scripted micro-histories and the `history/` golden).**
1. A scope introduced at day 0, modified at day 200, HEAD at day 400: `firstSeenTs` = day 0,
   `lastModifiedTs` = day 200, `modifications` = 1, `churnedEarly` = false.
2. Same scope modified at day 10 instead: `churnedEarly` = true (10 ≤ 14); at day 15: false.
3. `git mv a.ts b.ts` at day 90: after `finishReplay`'s alias resolution the scope has **one** row,
   keyed `b.ts#…`, with `firstSeenTs` still day 0, and `aliases` contains `a.ts → b.ts`. Without the
   resolution there would be two rows — `a.ts#…` at day 0 and `b.ts#…` at day 90 — so assert the
   single merged row and its day-0 value, not merely that a row exists. Feeding the two commits in
   the reverse order yields the identical single row.
4. Adding `@Injectable` to a class with no other change emits exactly one **change** event, whose
   tuple differs from the previous one only in the decorator list.
5. A file with two same-named overloads produces two lifecycle rows whose keys differ by the
   `#k` ordinal — **two rows, not one**: a record touches every scope key its post-image carries
   (Step 2), so both rows carry the *same* `modifications` count, and it is the row **count** that
   MR-13's ordinal-stripping mutant destroys.
6. A file exceeding `lifecycleMaxAppearances` yields a file-level row and zero scope rows for
   that path.
7. `finishReplay` on the same walk, twice, returns byte-identical JSON.
8. **Order independence — the property the whole replay design rests on.** On the merged-side-branch
   fixture `buildBranchMergeFixture()` builds — the **default** `trailingMainCommit: true`
   five-commit shape, whose HEAD is `main2` and whose merge therefore sits *inside* the history
   (`tests/support/branch-merge-fixture.ts`, T3): a scope
   born on the side branch keeps `firstSeenTs` = its own
   first commit and `lastModifiedTs` = its latest touch. Then feed the **identical** commit records
   to a fresh replay in a *different* arrival order — reversed, and one shuffled permutation with a
   fixed seed — and assert `finishReplay`'s output is **byte-identical** across all three: rows,
   events and aliases alike. This is the killer case for the whole of D16, and it is the one an
   order-dependent implementation cannot survive: a last-write-wins row moves, a running
   previous-value map emits a different event set, an incrementally-compressed alias chain resolves
   differently, and a demote-from-the-crossing-onward cap keeps different scope rows.
9. **The split-walk case, the same property stated the way a resume meets it.** Partition that same
   helper's fixture commits into two disjoint sets — the ones an index at the pre-merge main-line commit
   would have applied, and the rest — fold the first into one replay, round-trip the accumulated
   state through T1's `writeHistoryState`/`readHistoryState` into a real temporary directory, fold
   the second into a replay resumed from it, and assert the result is byte-identical to folding all
   of them at once. Using the real store rather than an in-memory copy is deliberate: it is what
   proves the persisted shape carries everything the fold needs — `firstModifiedTs`,
   `lastTouchSha`, the raw alias edges and the appearance counters included. This is
   R4-I2's replay half, provable here at unit level without an index, and it fails outright on the
   ordering design D16 replaces: the side-branch commit lands on the far side of the split.
10. A commit touching only `NOTES.md` — or only `src/foo.test.ts`, D17 gate 2's other cause, a
    registered-grammar path the parse filter excludes — produces **no lifecycle row of either
    level** for that path, while the commit's other records fold normally. Scoped to exactly that,
    on purpose: `commits` and `blobs` are `historyStats` fields, which T8 assembles in `history.ts`
    (T6's opening note), and this task's `ReplayResult` is `{lifecycle, events, aliases, events_n}`
    with no `commits` and no `blobs` anywhere in its surface — so the "still counted, still
    rostered" half is **T8 acceptance 10's**, not assertable here. A `dist/bundle.js` clause would
    be wrong here in a second way as well: gate 1 removes it inside `buildHistoryJoin` (T8), so the
    replay never sees such a record at all and cannot be fed one.
11. **The rename-back cycle.** `git mv a.ts c.ts` at day 90 and `git mv c.ts a.ts` at day 120 —
    which git emits as two `R100` records, not as a delete plus an add — resolve through Step 5's
    one-pass closure to `{a.ts: a.ts, c.ts: a.ts}`, leaving the scope **one** row keyed `a.ts#…`
    with `firstSeenTs` still day 0. `finishReplay` returns rather than hanging, which is the half
    a fixpoint loop fails: assert it with a real timeout on the test, not merely by inspecting the
    output.
12. **A `T` record is a touch on the file-level row and nothing else** — the killer for the rule
    homed on `HistoryFileRecord.status` (T2's interfaces), which no other fixture in this increment
    exercises. Two halves, both on a path clearing both of D17's gates:
    (a) a path whose **only** record in the whole history is a `T` carries a **file-level row** —
    with that touch's `lastModifiedTs`/`authorKind` — and **zero scope rows**, since nothing ever
    resolved a scope set for it; (b) a path with ordinary `A`/`M` records **plus** one later `T` has
    its file-level `modifications` incremented by that `T` while **every one of its scope rows is
    byte-identical** to the same replay run without the `T` commit — no scope-level counter moves,
    and no event is emitted for it. Feed the records directly (the fold is order-free, D16), taking
    the record shape from T2 acceptance 9's captured output rather than hand-inventing it.

**Test obligations / mutation round-trips.**
- **MR-11 (rename replay):** delete the `R`-record alias edge ⇒ acceptance 3 fails (two rows, the
  later one born at day 90). Replace Step 5's one-pass closure with a repeat-until-fixpoint loop
  ⇒ acceptance 11 fails by timing out on the rename-back cycle.
- **MR-12 (change-signature completeness):** drop decorators (or supertypes, or nameshape) from
  the tuple ⇒ acceptance 4 fails.
- **MR-13 (ordinals in historical keys):** strip the ordinal from the historical `scopeKey` ⇒
  acceptance 5 fails (the two overloads collapse into one row).
- **MR-14 (introduction events):** emit change events only ⇒ a test asserting a
  never-modified scope still has exactly one event fails.
- **MR-15 (order-freedom):** replace the per-record pre-image comparison with a running
  `prevState[path]` map carried across commits — the shape an earlier draft prescribed — ⇒
  acceptance 8 fails on the reversed and shuffled feeds, and acceptance 9 fails on the split walk.
  Cheaper mutations that must also fail: make `authorKind` last-write-wins instead of
  greatest-`(ts, sha)` ⇒ 8 fails; compress the alias chain during the fold instead of at finish ⇒ 8
  fails; apply the appearance-cap demotion from the crossing onward instead of at finish ⇒ 9 fails.
  This round-trip is the one that would catch an ordering regression reintroduced by a later
  refactor, and R4-I15 requires it to be run live.
- **MR-35 (the `T` rule, both directions — numbered after T9's MR-34 because it was added last;
  it belongs to this task):** treat `T` as an unrecognised status and drop the record
  ⇒ acceptance 12's file-level counter half fails (the touch is lost). Conversely treat `T` as
  blob-resolvable — key and resolve its two shas and fold them like an `M` — ⇒ acceptance 12's
  "zero scope rows" half fails, and 12(b)'s byte-identity of the scope rows fails with it. This is
  the round-trip R4-I15 demands for a rule the plan states as load-bearing and homes in exactly one
  comment; without it the `T` branch would ship with no killer test at all.

**NON-goals.** Trends, cohorts, nucleation, calibration (R6) — this task produces their inputs
and reads none of them. No weights (T7).

---

## Task 6 — Co-change and coupling

**Scope.** The repo-global, non-lifecycle products of the same walk: pair supports, the derived cut,
and the coupling percentiles.

**Why `agentShare` and the `historyStats` assembly are *not* here.** §18.4's share is
`Σ base(...) / Σ base`, and `base(s)` is §9.1's base weight, whose single home is **T7's**
`weights.ts` (`makeWeightFns(...).baseWeight`, D7). Under the strict `T1 → T10` order T7 lands
*after* this task, so a `computeAgentShare` here would have no `base` to call and would force a
second transcription of §9.1 inside `history-cochange.ts` — the drift D7 exists to prevent. Both
`computeAgentShare` and the `historyStats` assembly therefore live in **T8**, in `history.ts`, next
to the model body they feed and downstream of the weights they need; T8's Step 4 and its acceptance
criteria carry them, together with the golden assertions that used to sit here. Nothing about
either definition changes — only which task lands it. (D4 and §18.4 stay the authorities either
way, and R4-I3 already names *(T4, T8, T9)* rather than this task, so the move also puts the
cold-versus-warm `historyStats` criterion where that invariant already said it belonged.)

**Authorities.** Spec §13.5 (`v6-spec.md:621-625`), Appendix G.3 coupling (`:1018`), Appendix D's
`cochange`/`couplingBy*` fields (`:866-892`), §6.8's exclusion scoping — test files and non-code
files are **fully counted** in co-change and history (`:271`); Appendix F's co-change row (`:981`);
D1's raw-versus-cut rule and D17's two gates above.

**Files.**
- Create `source/cli/src/roots/history-cochange.ts`.
- Create `source/cli/tests/unit/roots/history-cochange.test.ts`.

**Interfaces produced.** `accumulateCochange(state, commit)` and
`finishCochange(state, config, resolvePath: (p: string) => string):
{pairs: CochangePair[]; couplingByFile: Record<string, number>; couplingByModule: Record<string,
number>}`. Both are order-free by construction (D16): `accumulateCochange` only increments per-pair
supports and per-file commit counts under **the paths the walk recorded** — as already filtered
through D17's gate 1 by the caller, never re-filtered here — keyed by commit sha so a
record folded twice cannot double-count, and every rename resolution, filter, sort and cut happens
in `finishCochange`. `resolvePath` is the alias closure T5's `finishReplay` produces — injected
rather than recomputed, so there is one rename map in the process; this task's own tests pass the
identity function or a hand-written map.

**Steps.**
- [ ] **Step 1: Pair accumulation, over records D17's gate 1 has already admitted.** This function
  applies **no** exclusion of its own and must not grow one: `buildHistoryJoin` filters each
  commit's `files` array through `makeRootsFileFilters(config).forMarkers` exactly once, before
  any consumer sees it (D17, T8 Step 1), so a record under `dist/`, `vendor/`, `node_modules/`,
  `*.d.ts` or `.yggdrasil/**` never arrives here at all. Two consequences to hold on to, because
  they are what the single application buys. **The changed-file band is therefore measured over
  survivors**, which is the right reading and not an accident: a commit touching forty `dist/`
  files and two source files is an ordinary two-file commit whose one pair counts, not a
  mega-commit that contributes nothing. And **gate 2 is deliberately not applied anywhere on this
  path** — a path with no registered grammar, or one `forParsing` excludes, still counts fully for
  co-change, which is exactly §6.8's "test-pattern files … remain fully counted for co-change and
  history" (`v6-spec.md:271`) and D17's middle tier. The killer test for the gate itself is T8's,
  since T8 is where the gate is applied; this task's tests feed `accumulateCochange` records
  directly and pin that it counts whatever it is given.
  Then: only non-merge commits with **≥ 2
  and ≤ `history.megaCommitFileCap` (30)** changed files (`:622`); every unordered file
  pair increments
  support; per-file commit counts accumulate over the same commit set. An `R`/`C` record counts
  under its **new** path for its own commit's pairs, and nothing else happens at that moment: the
  supports and commit counts earlier commits accumulated under the **old** path stay there and are
  folded into the new path at `finishCochange`, through `resolvePath`. A running remap — rewriting
  past supports the moment a rename arrives — is forbidden, because whether the rename arrives
  before or after a given co-change differs between a full walk and a resume, and the two would
  disagree (D16). Repo-global — never per partition — and inclusive of non-code and
  test-pattern files (the `routing.py ↔ test_routing.py` signal is exactly this).
- [ ] **Step 2: The cut is a derived output, not state.** At `finishCochange`, in this order:
  resolve every file key through `resolvePath` and **merge** the supports and commit counts that
  land on the same final path (Step 1); then `confidence(a→b) = support(a,b)/commits(a)`; keep pairs
  with `support ≥ cochange.minSupport`
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
- [ ] **Step 4: Tests + graph ritual + report.**

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
5. Folding the same commits into `accumulateCochange` in a different order — reversed, and split
   into two disjoint halves with a persist/reload between them — yields byte-identical
   `finishCochange` output (D16, and the co-change half of R4-I2).

**Test obligations / mutation round-trips.**
- **MR-16 (mega-commit cap):** remove the ≤ 30 filter ⇒ acceptance 2 fails.
- **MR-17 (support-ordered cut):** cut by insertion order ⇒ acceptance 3 fails.
- **MR-18 (rename resolution at finish):** drop the `resolvePath` fold ⇒ acceptance 4 fails (two
  pairs at support 3 and 8 instead of one at 11). Move it back to a running remap inside
  `accumulateCochange` ⇒ acceptance 5's reversed and split feeds fail, because the rename then lands
  on the wrong side of the co-changes.

**NON-goals.** `agentShare` and the `historyStats` assembly — T8's, for the reason stated at the
top of this task; do not add a local `base` to make them fit here. The Stop-channel completeness
sweep (`v6-spec.md:625`) is R5's — R4 produces the pairs it will read. Campaigns and the report
surface are R7's.

---

## Task 7 — Weights: §9.1, exactly

**Scope.** A pure module implementing `w(s,q)`, `base(s)` and the age/survival predicates from
lifecycle rows, ledger marks, the dirty set and the clock. No wiring — T8 wires it. `baseWeight` is
also the `base(s)` §18.4's `agentShare` sums over, which is why that computation waits for T8 rather
than sitting in T6 (see T6's opening note).

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
| human, first_seen −10 d, last_modified −10 d | `w_surv = 10/120 = 0.083333 × 0.5` (age < 14) `= 0.041667`; floor | **0.05** |
| human, stable 60 d, churned early | `w_surv = 0.5`; `w_churn = 0.25` ⇒ 0.125 | **0.125** |
| agent, stable 60 d | `w_prov = 0.15 + 0.85 × min(1, 60/180) = 0.433333`; `w_surv = 0.5` ⇒ 0.216667 | **0.216667** |
| agent, stable 200 d | `w_prov = 0.15 + 0.85 × 1 = 1`; `w_surv = 1` | **1.0** |
| no lifecycle row | first branch | **0.3** |
| dirty in the working tree (row present) | second branch | **0.3** |

**Row 2's dates are load-bearing and must not be "tidied" to a fresher number.** The row pins the
`baseFloor` *and* is MR-20's named killer, and only a narrow window of `stable_days` does both. The
fresh-penalty factor is observable only when the un-penalised product clears the floor and the
penalised one does not — i.e. `stable_days ∈ (6, 12]` with `age_days < 14`, since
`d/120 > 0.05 ⇔ d > 6` and `d/240 < 0.05 ⇔ d < 12` (at `d = 12` the penalised product is exactly
the floor, which still differs from the un-penalised 0.1). At **−10 d** the two readings are
`10/120 × 0.5 = 0.041667` → floor **0.05** with the factor, and `10/120` = **0.083333** without it.
At the −5 d this row previously carried, **both** readings floor to 0.05 and MR-20's mutant would
have passed the row untouched — the same defect class as the MR-19 entry in Self-review, one row
over.

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
- **MR-19 (cap last):** move the ledger cap before the `max(baseFloor, …)` ⇒ the marked-scope row
  whose base is 0.05 wrongly rises to 0.05→(min after floor is 0.05 either way) — so use the
  1.0 row: applying the cap *before* the floor yields `max(0.05, min(1, 0.15)) = 0.15` and
  applying it after yields `min(max(0.05, 1), 0.15) = 0.15` — identical. The killer test is the
  **degraded branch**: with no lifecycle row and a mark present, cap-last gives `min(0.3, 0.15) =
  0.15` while cap-inside-the-product gives 0.3. Pin that case.
- **MR-20 (fresh penalty):** delete the `age_days < freshPenaltyDays ? 0.5 : 1` factor ⇒ row 2's
  derivation test fails — **0.083333 against the row's 0.05**, which is why that row is dated
  −10 d / −10 d and not fresher (the note under the table derives the window). Nothing else in this
  plan catches the deletion: criteria 1–3 do not read `w_surv`, and T8's day-395 cohort is 5 days
  old and floors to 0.05 with the factor and without it, so a −5 d row here would have left this
  factor shipping with no killer at all (R4-I15).
- **MR-21 (churn):** delete `w_churn` ⇒ row 3 fails.
- **MR-22 (release gap):** delete the `releaseMinDaysAfterMark` conjunct ⇒ criterion 1's third
  case fails.

**NON-goals.** `hookShapedConform` counting and any model field (T8). Telemetry and mark
*writing* (R5) — R4 only reads a ledger that is empty until then, which is exactly why its tests
supply hand-written `ledger.jsonl` fixtures.

---

## Task 8 — Wiring: the history join, eligibility flips, model body, degraded modes

**Scope.** The behavioral landing. `runRootsIndex` performs the walk, joins history to the mined
field, and the model gains its history-fed fields. Golden expectations move here, in one place.

**Authorities.** Spec §9.4c (`v6-spec.md:405-409`), §16.2 (`:655`), §18.4 agentShare (`:687`),
§21.1 (`:719`), Appendix D
(`:861-897`), §13.4 clock and reshaping (`:617-619`); design §12 (`integration-design.md:439-467`),
§13.5's fail-closed control (`:497-499`); D4, D7, D9, D16 above; code: `src/roots/pipeline.ts:161-225`,
`src/roots/mine.ts:75-204`, `:854-987`, `src/roots/mine-stages.ts:189-216`,
`src/cli/roots.ts:332-395`.

**Files.**
- Modify `source/cli/src/roots/history.ts` — the orchestration entry point
  `buildHistoryJoin(repoRoot, config, deps): Promise<HistoryJoin | undefined>` composing T2's
  walk, T4's cache, T5's replay and T6's co-change; `undefined` ⇒ the degraded mode. **`HistoryJoin`
  is enumerated here, field by field, because three acceptance criteria below assert quantities that
  no vaguer description makes reachable:**
  ```ts
  export interface HistoryJoin {
    lifecycle: LifecycleRow[]; events: ValueEvent[]; aliases: Array<[string, string]>;
    cochange: CochangePair[];                       // the CUT set (T6 Step 2)
    couplingByFile: Record<string, number>; couplingByModule: Record<string, number>;
    agentShare: number | null;
    historyStats: { commits: number; events: number; blobs: number; parsed: number; mb: number };
    // The two rosters `historyStats` is computed FROM (D4), returned rather than collapsed to
    // their cardinalities. Acceptances 8(b), 8(c) and 10 ask per-sha and per-key membership
    // questions — "this sha appears exactly once", "the key roster gains two entries", "this
    // post-image sha is absent" — and an integer cannot answer one, which is how the same class
    // of defect reached T5's old acceptance 10 (Self-review, last section). They are also
    // exactly the two objects T9 persists into `meta.json`, so T9 writes THESE rather than
    // rebuilding a second pair that could disagree with the numbers already in the model.
    blobShas: ReadonlySet<string>;                  // distinct blob SHAs the walk resolved
    parsedKeys: ReadonlyMap<string, number>;        // distinct non-skipped cache key -> bytes
    // The clock, named ONCE and in both representations, because two criteria below read it
    // under two different names. `clockTs` is HEAD's committer timestamp in epoch seconds — the
    // value `WeightInputs.clockTs` takes (T7) — and `clockIso` is the strict ISO-8601 string the
    // model header's `clock` carries (`utils/git.ts:100-111`; `stores.ts:82` types it
    // `string | null`). Both come from the single `readHead` call of Step 1 — which returns both
    // (T2's interface), reading them from the ONE HELPER PAIR in `utils/git.ts` the header itself
    // already uses. Neither is re-derived from the other: the header's `%cI` form is not what
    // `toISOString()` on `clockTs` would produce. The type is nullable because `readHead`'s is —
    // and a null HEAD (empty repository) is itself a degraded cause returning `undefined` for the
    // whole join, so a RETURNED join always carries a real string; the type records the source's
    // honesty, not a reachable state of this field.
    clockTs: number; clockIso: string | null;
  }
  ```
  `historyStats.blobs` is `blobShas.size` and `parsed` is `parsedKeys.size` by construction, so the
  integers cannot drift from the rosters they summarise. Two of those
  products are landed **here**, not upstream (T6's opening note says why): `computeAgentShare` and
  the `historyStats` assembly, both of which this file owns because `base(s)` only exists once T7
  has landed. It also owns the wiring order the two impose — the replay finishes first (its alias
  closure is what `finishCochange` resolves paths through, T6), then the weights are constructed
  from the finished lifecycle index, then `agentShare` sums `baseWeight` over the windowed
  population.
- Modify `source/cli/src/roots/pipeline.ts` — `runRootsIndex(repoRoot, config, seeds, options?)`
  where `options` carries `{ historyDeps?: { cacheDir, stateDir, ledger, dirtyPaths },
  onProgress? }`. **`onProgress` is *forwarded* into `buildHistoryJoin` here, even though nothing
  emits on it until T9** — the same declared-now-so-a-later-task-adds-behavior doctrine `stateDir`
  gets in the next sentence, and for a sharper reason: every quantity that will ride on the
  callback (D12's blob count and ETA, T9 Step 4's commits-walked and blobs-parsed summary) is known
  only inside `buildHistoryJoin` — and the callback carries **structured data only** (counts and a
  phase tag), never preformatted text: D12 keeps the engine `no-direct-console` and the COMMAND owns
  every rendered word (the maintainer's no-internals rule constrains that wording, and T9's cases
  (c)/(e)/(g) read the rendered numbers) — so if the forwarding waited for T9 it would be a *second*
  `pipeline.ts` edit in a task whose own Files list authorizes exactly one and says nothing else in
  that file moves. Wiring it here costs T8 one parameter and keeps that clause true.
  **`stateDir` is declared here and read by nothing in this task** — this task
  never loads or saves replay state; T9's Files list is what adds "state load/save" and is the
  first thing to open it. It is declared now so T9 adds behavior rather than widening a public
  shape mid-increment, and the field is named as declared-and-inert here so a T8 reviewer reads
  its absence of use as intended rather than as an omission. Absent options ⇒ exactly today's behavior: constant `noLifecycleWeight` 0.3, no
  AgeFn, no history-fed field. **That default is the degraded path, not the golden path**, and the
  distinction is what makes this task's fixture work bite: every one of the five landed golden test files (covering the seven
  landed golden fixtures) calls the three-argument form today — `golden.test.ts:46`, `:127`;
  `golden-data.test.ts:55`, `:66`, `:77`; `golden-more.test.ts:37`; `golden-python.test.ts:41`,
  `:63`; `golden-controls.test.ts:136`, `:206`, `:311`, `:312` — so leaving them there would keep
  them mining at 0.3 forever, D8's trailing day-400 commit would move nothing, and Step 5 would
  have no expectation to re-derive. **Every one of those call sites moves to the four-argument
  form**, each passing a `historyDeps` built from a per-test temporary `cacheDir`/`stateDir`
  (created and removed by the suite, never shared *between* tests — the two calls *within*
  `golden-controls.test.ts`'s determinism control at `:311`/`:312` deliberately share one), an
  **empty** `ledger` and an **empty** `dirtyPaths`. Exactly one of the twelve is special, in that it
  is rewritten rather than merely re-argumented: `:206` sits inside part (a) (`:191-213`), which
  Step 6 replaces wholesale. The degraded-mode controls of Step 6 (i) and (ii) pass `historyDeps` too — their
  degradation must come from the repository's own state, never from an omitted argument.
  **The twelve golden call sites move; six further landed 3-arg call sites stay 3-arg on purpose**
  — `tests/unit/roots/pipeline.test.ts:160`, `:168`, `:178`, `:194`, `:198` and
  `tests/unit/roots/pipeline-binding-set.test.ts:44`. None of them breaks: they test the pipeline
  itself at the constant 0.3, which is exactly what they are for, and
  `pipeline-binding-set.test.ts:44` is additionally the guard on T9's binding-set lift. Converting
  or deleting them is a defect, not tidying. On top of those six, **one new** test asserts the
  degraded default explicitly: a call without options mines at constant `noLifecycleWeight` 0.3
  with no history-fed field.
- Modify `source/cli/src/roots/mine.ts` — a small, **enumerated** edit set (prompt ceiling;
  re-measure afterwards): `MineInput` gains `surfaceWeightFn?` and `hookShapedFn?`; `survivedOf`
  becomes per-(stableId, surface) and folds `hookShapedFn`; the `weightOf` definition
  (`mine.ts:860`) gains a **surface-aware sibling** rather than changing meaning, and
  `roleWeightOf` (`:326`) becomes surface-aware through it; `MinedFact.hookShapedConform` becomes
  a real count; `MinedPartition` drops the four coverage/debt keys (D9). The **top-level**
  `MinedModel` additions are `historyStats`, `cochange` and `agentShare` — Appendix D's top-level
  trio (`v6-spec.md:866-868`) — plus `aliases`, which Appendix D does *not* list and which is
  authorized instead by `integration-design.md:130` ("model.json … co-change, **aliases**") and
  `:456` ("persisted `aliases`" as a productionized gap): the cache copy (D1) is the raw rename
  **edges** the walk accumulated, and the model copy is the **compressed closure** `finishReplay`
  derives from them, sorted and canonical — the same raw-state / derived-output split D1 applies to
  co-change. `couplingByFile` and
  `couplingByModule` are **not** top-level — Appendix D puts them inside each `partitions[]`
  entry beside `seeds` (`v6-spec.md:892`), which is where `moduleOfFile` already lives
  (`mine.ts:169`, produced at `:978`) and what `MinedModel`'s own header comment records. Put any
  helper that computes any of them in `history.ts`, not in `mine.ts`.
  **`MinedModel`'s own header comment (`mine.ts:178-185`) is on this rewrite list, and it is the
  easy one to miss** — the same hazard this task's Files list already names for
  `golden-controls.test.ts:37-45`, one file over. It states that
  `historyStats`/`cochange`/`agentShare` are "**STRUCTURALLY ABSENT** — omitted from the type
  entirely, not defaulted … R4/R5", which is precisely what this task falsifies by adding all
  three. Rewrite it in the same diff to say what is now true — the three are present and
  history-fed, `couplingByFile`/`couplingByModule` remain per-partition (Appendix D `:892`), and
  the four coverage/debt keys are the ones now structurally absent (D9) — so the comment keeps
  describing the type instead of contradicting it for `source-hygiene` and the doc-consistency
  review to find.
- Modify `source/cli/src/roots/mine-stages.ts` — `countRealInstancesIntoCell`
  (`mine-stages.ts:189-216`) and the three cell constructions that feed it (`mine.ts:290`,
  `:329` via `roleWeightOf` at `:326`, `:356`) take a **surface-aware** weight callback derived
  from `surfaceWeightFn`; `computeRoleLiftForPartition` (`mine.ts:462`, `:497`, `:905`) keeps the
  **per-scope `w_base`** callback unchanged — §8.10's `n_eff(r)` is base weight, never `w(s,q)`,
  as that function's own in-file comment states ("at FULL base weight, no ambiguous discount"). A
  wholesale widening of `weightOf` at all ten of its call sites would route the ledger-capped
  per-surface weight into `role_lift`'s divisor: precisely the conflation D7 forbids and
  Increment 2 documented, and silent unless MR-27 is written.
- Modify `source/cli/src/cli/roots.ts` — load the ledger and the dirty set, pass `historyDeps`,
  keep `computeDirtyHash`'s `.yggdrasil/roots/**` exclusion (`:170-181`) exactly as it is.
- Modify the landed expectation pins: `tests/unit/roots/golden*.test.ts`,
  `tests/unit/cli/roots.test.ts:223-226` and `tests/unit/roots/mine.test.ts:471-477` — both
  ranges run one line further than a quick read suggests (`debtPerInstance` is the last key in
  each, at `:226` and `:477`), and a leftover key becomes a TypeScript excess-property error the
  moment D9 removes it from the type.
- Replace `tests/unit/roots/golden-controls.test.ts`'s part-(a) control (`:191-213`) with the
  four controls of Step 6 below (two degraded-mode, one positive, one merge-HEAD); part (b) of
  that file is untouched. **Three statements in that same file go stale in this same diff, and all
  three are rewritten in it** — the file describes itself in prose in three places and this task
  falsifies every one:
  1. `:37-45`, the FAIL-CLOSED CONTROL paragraph, documents part (a) ("seven goldens' `MinedModel`
     shows ZERO `hookEligible` facts … through the real `runRootsIndex` entry point"), which becomes
     false the moment the control it describes is replaced.
  2. `:47-50`, the DETERMINISM CONTROL paragraph, ends "The blob cache is R4 — nothing writes
     `.cache/` this increment, so cache independence is NOT claimable yet and is not asserted
     here." Both halves are falsified here: `.cache/` is written from T4 on, and this task's own
     move of `:311`/`:312` to the four-argument form with a **shared** `cacheDir` makes the second
     call genuinely **warm**.
  3. The determinism test's own title at `:308` carries the same dead parenthetical — "(no
     cache-independence claim — R4's blob cache does not exist yet)".
  Rewrite 2 and 3 to state the **stronger** property the shared `cacheDir` now buys: the second call
  runs against a warm blob cache and still produces byte-identical bodies, which is R4-I3's
  cold-versus-warm claim asserted at the pipeline level rather than a disclaimed non-claim. A
  self-contradicting comment or test title is exactly what `source-hygiene` and the doc-consistency
  review read, and what a later reader would trust over the code.
- Create `source/cli/tests/unit/roots/history-join.test.ts` and
  `tests/unit/roots/golden-history.test.ts`.
- Modify `CHANGELOG.md` — **draft** the single `## [Unreleased]` entry, in release-notes voice,
  covering what this task first makes adopter-visible: mined conventions are now weighted by how
  long code has stood and who wrote it. One entry, amended in place at T9 and again at T10, never
  joined by a second (CHANGELOG policy, which already dictates its content and voice and already
  says the entry is drafted here — this line is what gives it a file to be drafted in).

**Steps.**
- [ ] **Step 1: The join.** `buildHistoryJoin` runs the walk, feeds every commit to the replay and
  the co-change accumulator, reads blobs through T4's cache in batches, and returns the finished
  products. **The clock and `headSha` come from T2's `readHead`, never from the walk.** The walk
  is `--no-merges`, so when HEAD is a merge commit — the common case on any repository that
  merges PRs, this one included at dogfood time — the walk's last record is neither HEAD's sha
  nor HEAD's timestamp, while §13.4 is categorical that the clock is HEAD's committer timestamp,
  full stop (`v6-spec.md:618`). There is exactly **one** reader of HEAD in the roots engine:
  `readHead`
  delegates to the same `utils/git.ts` helper pair the model header already uses (T2) and returns
  both representations, so the header's
  `clock` and the weights' `clockTs` come from one helper pair rather than from two
  independently-written readers that might drift. (`cli/roots.ts:376` still calls
  `getHeadCommitterTimestamp` itself when it assembles the header, which is why the pin below is on
  the **conversion** between the join's two fields and not on a reconciliation of the header
  against the join — nothing in R4 asserts the two are equal.) **Both representations are carried
  on the join itself** —
  `clockIso` (the strict ISO-8601 string the header takes, `utils/git.ts:100-111`; `stores.ts:82`
  types it `string | null`) and `clockTs` (the epoch seconds `WeightInputs.clockTs` takes, T7) —
  which is what makes the property assertable in this task at all: `runRootsIndex` returns
  `{body, bindingSetHash, candidateCountLog2}` and **no header**, so a criterion phrased against
  `header.clock` would have nothing to read here (the same reason Step 6 (iv) gives for leaving the
  `lastIndexedSha` half to T9). The suite therefore asserts
  `Date.parse(join.clockIso) / 1000 === join.clockTs`, and that `join.clockTs` is the value handed
  to `makeWeightFns` — a pin on the **conversion**, not a reconciliation of two independent readers.
  **D17's gate 1 is applied here, once, and nowhere else.** As each `HistoryCommitRecord` arrives,
  filter its `files` array through `makeRootsFileFilters(config).forMarkers` (§6.8's merged
  built-in + config exclusions — `v6-spec.md:271`, `src/roots/partitions.ts:127`) **before** any
  consumer sees it: the replay, the co-change accumulator, the blob roster and the probe-then-fetch
  protocol below all read the filtered array. One application keeps those four consumers from
  drifting and makes T6's changed-file band, T5's rows and D4's `blobs` all agree on what "a
  changed file" means. The commit itself is still walked and still counted in
  `historyStats.commits` even when every one of its records is filtered away. Gate 2 stays T4's,
  inside `makeBlobRecordReader`.
  **`forMarkers` takes one path and a record can carry two, so the path fed to it is fixed by D17
  and is not the implementer's to choose: a record's gate-1 path is its *post-image* path —
  `newPath ?? path` for *every* status, which for `D` and `T` (neither carries a `newPath`) is
  just `path`.** Write it as the single expression rather than as a per-status enumeration; an
  enumeration of `A`/`M`/`R`/`C` plus `D` silently leaves `T` — a status git really does emit —
  unhandled. A record failing on that path is dropped
  whole — for an `R`/`C` that means no alias edge either, and the old path's rows simply stop
  receiving touches. A rename **out of** an excluded prefix (`dist/a.js` → `src/a.js`) passes gate
  1 on its new name and is kept; its pre-image is then answered by gate 2 from the **old** path, so
  it yields the in-memory skip record with no scopes and every post-image scope is an
  **introduction** at that commit. Filtering on `path` instead would invert both directions at
  once, which is what MR-30's second-half mutation kills.
  **The probe-then-fetch protocol**, stated here because no other step owns it and "a warm run
  parses zero blobs" is satisfiable while still paying full `cat-file` I/O. For every surviving
  `A`/`M`/`R`/`C` record, and for **both** of that record's blob shas — the post-image *and* the
  pre-image, since a change event is `signature(postSha) != signature(preSha)` (D16): (1) recognise
  the historical path — a path failing D17's gate 2, whether because its extension carries no
  registered grammar or because `forParsing` excludes it, yields its in-memory skip record
  immediately and is **never keyed, never probed, never fetched, never
  cached** (D4, D11, D17, R4-I6); (2) for the rest derive `key = blobCacheKey(sha, EXTRACTOR_VERSION,
  bindingHash-of-that-path's-grammar)` for each non-null sha, which is computable from the path and
  the sha **without the content** — the whole reason a warm run costs no I/O. **Each sha takes the
  grammar of its own path**, which on an `R`/`C` record are two different paths: the pre-image blob
  lived at `path` (the old name) and the post-image at `newPath`, so a rename that also changes the
  extension (`a.ts` → `a.py`) extracts its pre-image under typescript and its post-image under
  python. Anything else would sniff content, which R4-I6 forbids; (3) probe the shard
  for every key and collect the **misses only**; (4) fetch just those SHAs through the walk's
  single open `BlobReader` (T2), which chunks them 400 at a time, then extract and write each
  record. `makeBlobRecordReader`'s
  `content: Buffer | undefined` parameter is exactly this distinction: `undefined` on a hit, the
  fetched bytes on a miss. `parsed` and `mb` are read off the returned record either way (D4), so a
  warm run parses zero blobs **and** fetches zero blobs and §20.1's blob-rate budget is never spent
  on a re-index.
  **The unit of step (4) — the fetch — is a commit *window*, never a single commit, and steps (1)
  to (3) run as each commit is appended to that window. State both halves, because the difference
  is one child process per commit.** Run per-commit and paired with a one-shot
  `readBlobs`, this protocol would spawn one `git cat-file --batch` child per non-merge commit:
  100 000 process spawns and 100 000 object-store initialisations on a 100 000-commit repository,
  on top of the walk, against §13.2's categorical "**a single** `git cat-file --batch` child"
  (`v6-spec.md:605`) and the ≤ 15 ms/blob budget §20.1 sets on that basis. Two things together fix
  it, and both are contract rather than optimisation:
  - **One reader for the whole walk.** `buildHistoryJoin` calls `openBlobReader(repoRoot)` once,
    before the walk, and `close()`s it in a `finally`. Every window's fetch is a `read()` on that
    one handle (T2 Step 4, T2 acceptance 6). A one-shot `readBlobs` per window is a defect, not a
    simplification.
  - **A buffered window, and the probe happens on append, not on flush** — stated that way round
    because one of the two flush triggers names a quantity only the probe can know, so a design
    that probed at flush time could not evaluate its own trigger. `walkHistory`'s `onCommit(c)`
    callback does not fold; it **appends** the (gate-1-filtered) commit to a pending window and,
    as it appends, **derives and probes each of that commit's keys** (steps (2) and (3) above —
    derivation is a pure function of the path and the sha, and the probe is a local shard read; a
    `cat-file` fetch is the one thing neither of them does). The pending set is therefore
    already partitioned into hits and misses at every moment, and both flush triggers are
    computable: the window is flushed when either the pending **miss** set reaches the reader's
    400-sha chunk or the window reaches K commits
    (K a named constant in `history.ts`, not a magic literal) — and unconditionally once, after the
    walk ends, so a partial final window is never dropped. Flushing then means:
    fetch the accumulated misses in one `read()`, then fold the buffered commits through
    `replayCommit` and `accumulateCochange`. A key probed in one window and probed again in a later
    one is a **re-read, never a re-parse**, so R4-I8 is untouched by the repetition.
    **Order within a window is irrelevant by D16**, which is exactly what
    makes the buffer safe — a design that depended on arrival order could not buffer at all, and
    this is the first place D16 pays for itself in throughput rather than in correctness.
    The window is bounded in commits *and* in pending shas, so memory is bounded whatever the
    repository's shape; the report names the constant it chose and the peak pending-sha count it
    measured at T10.
  **Adding the pre-image to the key set costs almost nothing, and the report says so with a
  number.** On a full walk from the root, a record's `preSha` is either null (status `A`) or the
  post-image of an earlier commit on that path's own parent chain — i.e. a sha the walk already
  named — so the distinct-blob set grows only by blobs that exist solely inside a merge's tree (a
  conflict resolution). On a resume the range's opening pre-images were extracted by the previous
  run and are cache hits. Measure it at T10's dogfood run and report distinct pre-image-only shas
  as a fraction of the total; if it is not a low-single-digit percentage on this repository, that is
  a finding worth reporting, not a number to bury.
  **The order the join feeds its consumers is fixed** (T6's `resolvePath`): finish the replay first,
  hand its alias closure to `finishCochange`, then build the weights from the finished lifecycle
  index, then compute `agentShare` and assemble `historyStats` (Step 4).
- [ ] **Step 2: Degraded modes (R4-I4).** No git repository, a **shallow** clone, or a walk that
  throws ⇒ `buildHistoryJoin` returns `undefined` and the pipeline keeps R1's constant weights and
  no AgeFn. The history-fed model fields are then **absent** (not zeroed) except `agentShare:
  null` (§18.4's `n/a`), and no fact is hook-eligible. One `debugWrite` per cause; the command
  reports the degradation to the user in plain terms at T10.
- [ ] **Step 3: Wire the weights.** `induceRoles` receives `baseWeight` (w_base — D7); `mine`
  receives `weightFn: baseWeight`, `surfaceWeightFn: surfaceWeight`, `ageFn: ageDays`,
  `hookShapedFn: isHookShaped`. Role-cell counts keep their `× (ambiguous ? 0.5 : 1)` factor over
  `surfaceWeight` (`mine.ts:326`), unchanged in shape.
- [ ] **Step 4: `agentShare`, `historyStats`, and the model body.**
  **`agentShare` (§18.4), landed here because `base(s)` is T7's.**
  `Σ base(agent-authored, stable_days < weights.agentPromoteDays) / Σ base` over scopes first seen
  in the trailing **120 days** (fixed) of the clock, with `base` being `makeWeightFns(...).baseWeight`
  (T7) — never a second transcription of §9.1; `null` when there is no history. A denominator of
  0 — no scope first seen inside that window at all — is an **empty population, not a zero share**,
  and is encoded `null`, the same way §18.4 encodes the no-history case (`v6-spec.md:687`). 0/0 is
  undefined, and `JSON.stringify(NaN)` silently emits `null` anyway, so an unguarded division ships
  the defect as a plausible-looking value rather than crashing. Only a **non-empty** population with
  no agent-authored member yields `0`. This is not a corner case here: after D8 the **seven landed**
  goldens' code is all first seen at day 0 with the clock at day 400, so their trailing-120-day
  population is empty by construction and their `agentShare` is `null`. The eighth — the `history/`
  golden — is the deliberate counter-case: its `ship` scopes (first seen day 300) and its day-395
  cohort both fall inside the window and both are human-authored (T3 items 11 and 12 name the
  authors for exactly this reason), so its population is **non-empty with no agent member** and its
  `agentShare` is exactly **0**. Each of the two encodings therefore has a real fixture behind it
  rather than a scripted micro-history alone. It is a composition diagnostic in R4 — the alarm and
  `status --exit-code` are R6/R7.
  **`historyStats` per D4**, integers only, no timing field, every one of the five a property of the
  history rather than of this run.
  **The body.** At the **top level** add `historyStats` (D4), `cochange`
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
  `share` are serialized as raw numbers, so every weighted accumulation must run in a
  **deterministic order** — and the task report names each accumulation site together with the
  ordered source its order derives from (R4-I16). A `Set` or `Map` built from an ordered array
  qualifies, since JS iterates both in insertion order; one assembled in incidental order does not.
  The three sites that exist today already qualify and need no re-sorting.
- [ ] **Step 5: Re-derive the golden expectations.** With `w = 1.0` uniformly (D8), each of the
  **seven landed** goldens has `n_eff` equal to its `n_raw`. That uniformity is exactly what the
  eighth does not have: by T3's script the `history/` golden carries 1.0, 0.25 (the **twenty**
  day-20
  scopes churned at day 30 — ten named-body scopes and the ten `file` scopes of the same files),
  0.166667 (the day-380 `ship` scopes) and 0.05 (the day-395 cohort), so
  its expectations live in their own suite (`golden-history.test.ts`) and are derived case by case
  rather than by a single scaling argument.
  Work each moved expectation out **by hand from the spec's formulas first**, then compare with
  what the code produces; a fact that newly accepts must be explainable
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
  **(iv) Merge-HEAD control — the clock half only.** A scripted fixture repository —
  `buildBranchMergeFixture({trailingMainCommit: false})` from
  `tests/support/branch-merge-fixture.ts` (T3) — the same helper T5's acceptances 8–9 drive in its
  **default** five-commit variant and T9's case (g) drives in **this** one, the variant that stops
  at the merge — whose HEAD **is** a merge commit indexes with the *merge's* committer
  timestamp as the clock: assert `Date.parse(join.clockIso) / 1000` equals the merge's `%ct`, and
  assert the merge itself is absent from the walk's records. Both facts are invisible to a
  `--no-merges` walk, which is why the clock comes from `readHead`.
  **The `lastIndexedSha` half is deliberately not here.** This task does not write it: header
  assembly still hardcodes `lastIndexedSha: null` (`src/cli/roots.ts:212`, inside
  `assembleRootsModelHeader` at `:208-223`; `RootsHeaderInputs`
  has no such field, `:184-194`) and two landed tests pin that null
  (`tests/unit/cli/roots.test.ts:177`, `:191-205`; `tests/e2e/cli-roots-basic.test.ts:64`). The
  header write and those pins are **T9's**, and T9's determinism case (g) already asserts the
  merge's sha through `meta.json`. Asserting it here would also have nothing to read: this task's
  controls call `runRootsIndex`, which returns `{body, bindingSetHash, candidateCountLog2}` and no
  header at all.
  Part (b) of the landed control (the synthetic-AgeFn flip at the `mine` level) stays as it is,
  and acceptance 4 below explains why it, and not the no-git control, is where the
  "acceptance never reads survival" claim lives.
- [ ] **Step 7: Graph ritual + report**, including a `node scripts/prompt-headroom.mjs` reading
  after the `mine.ts` edits.

**Acceptance criteria.**
1. Every golden mines a non-empty field and the `history/` golden has ≥ 1 hook-eligible fact.
2. On the `history/` golden, a fact whose accepted instances include the **day-395 cohort** has an
   `nTotalRaw` that **excludes** that cohort: those scopes are 5 days old at the day-400 clock,
   5 < `freshPenaltyDays` 14, so they are counted and **not** survived.
   **Choose the fact deliberately, because both halves below are arithmetic and the cell decides
   the arithmetic.** Cells are partitioned by scope kind (`CELL_KINDS`, `mine-stages.ts:371`), so
   pick a fact on a **`method`-kind** cell — the kind T3 item 12 pins all three of
   `src/svc/refund.ts`'s named-body scopes to — and specifically on an **`_all` or `dir`** cell of
   that kind, never a role cell. The exclusion of role cells is not tidiness: a role cell counts
   through `roleWeightOf` (`mine.ts:326`), which halves an ambiguous member's weight, so a cohort
   scope would move `counts` by 0.025 rather than 0.05 and the stated delta would be wrong by a
   factor the criterion cannot see. Name the chosen cell in the suite.
   **Phrase the first half against `nTotalRaw` alone and hand-derive its value; do not phrase it as
   a comparison against `n_raw`.** `n_raw` is §9.4a's **formula vocabulary** (acceptance 4 below and
   T8 Step 5 both use it that way, correctly), not a model field: there is none on `MinedFact` — the
   type carries
   `counts`, `nConformRaw`, `nTotalRaw`, `share`, `bitsPerInstance`, `bitsSaved`, `deviantsN` and
   the rest, and the unsurvived raw total appears nowhere in it (verified against `src/roots/mine.ts`
   — `nTotalRaw` is `sumMapValues(cell.counts.survivedRaw)`, and the raw population reaches the
   model only through `deviantsN`, the raw **non**-conformer count). A criterion written against a
   field the type does not have is unwritable, which is the same defect this plan already excised
   one level up (Self-review's entry on T5's old acceptance 10). So: assert `nTotalRaw`
   **by value**, equal to the hand-derived count of **survived** members of that cell **that are in
   the surface's domain** (`countRealInstancesIntoCell` skips a member outside the surface's
   `domainSet` or with no value for it — `mine-stages.ts:207-213`) — every such member except
   **those of the day-395 cohort's scopes that are members of this cell**, which on the chosen
   `method`-kind cell is all **three** of them; both numbers derived from T3's script.
   **And pin the antecedent so the criterion cannot pass vacuously:** assert in the same block that
   the day-395 scopes reached the fact at all, through the fact's own weighted `counts[expected]` —
   `MinedFact.counts` is computed over **all** in-domain instances, survived or not
   (`mine-stages.ts:213`), so unlike the partition's `assignments` map — which is keyed per scope
   but NOT total over scopes: it omits any unit under `roles.minOwnFeatures`, any unit
   `classifyAgainstMedoids` leaves roleless (`roles.ts:815-826`, `:914`), and file-kind units whose
   named scopes got no roles — `counts` is a surface **the same three scopes** move, and on an
   `_all`/`dir` `method` cell they move it by exactly `3 × 0.05 = 0.15`, hand-derivable from T3's
   script with no role assumption. **Both halves therefore read one population — the cohort's
   members of *this* cell — and that identity is what makes the pair hand-checkable**; a cohort
   spread across two kinds, or counted on a role cell, would make the two halves speak about
   different sets. Without the antecedent half, a
   golden that simply failed to mine `src/svc/refund.ts`
   would satisfy the `nTotalRaw` assertion for the wrong reason. The survived population is then
   visibly not the raw one — and the criterion has a population that makes its antecedent true,
   which a golden whose youngest scope is older than 14 days would not.
3. A hand-planted `ledger.jsonl` mark on a conforming scope's (stable_id, surface) drops that
   fact's `nConformRaw` by one and raises `hookShapedConform` to one, and the fact's weighted
   count drops by `base − 0.15`. **And, in the same assertion block, the sibling half that makes
   the criterion per-*surface* rather than merely per-scope:** a *different* surface's fact whose
   accepted instances include that same scope has its weighted count **unchanged**. Without that
   half, a per-scope reduction that caps whenever the scope carries any unreleased mark on any
   surface — the exact shape MR-27 spells out for `role_lift` — still moves the marked fact's count
   by `base − 0.15` and passes, so the mutation lives. The golden must therefore carry a scope
   conforming on two surfaces at once; state which one in the suite.
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
7. On the `history/` golden two weights are asserted **by value**, because a wrong clock is
   invisible everywhere else: the `ship` scopes (born day 300, last modified day 380, first
   modification day 320 ⇒ `churned_early` false, `w_prov` 1) weigh
   `w_surv = min(1, 20/120) = 0.166667`, and the day-395 cohort weighs the `baseFloor` **0.05**
   (`w_surv = (5/120) × 0.5 = 0.020833`, floored). Both derive by hand from T3's script and
   §9.1's table; MR-26 is the round-trip they kill.
8. **`historyStats` is a property of the history, in both of the ways D4 says so, and MR-28 is the
   round-trip.** (a) For a fixed golden it is identical whether the blob cache is cold or warm
   (R4-I3), field for field — including `parsed` and `mb`, which is where a run-scoped definition
   would collapse to zero on the warm pass. (b) **The one-sha-two-verdicts collision**, which
   nothing else exercises: the `history/` golden's day-0 seed carries an empty
   `src/svc/placeholder.ts` and an empty `docs/PLACEHOLDER.md`, which are the **same blob**
   `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` (T3 acceptance 8), listed in that order — the
   no-grammar one first. **These are per-sha and per-key membership questions, so they are asserted
   against `join.blobShas` and `join.parsedKeys` — the two rosters `buildHistoryJoin` returns
   (Files list) — and not against the five integers**, which cannot answer one: assert that
   `blobShas` contains that sha and that `blobShas` has exactly one entry for it (it is a `Set`, so
   the membership *is* the once), that `parsedKeys` **does** carry the key derived from the `.ts`
   path's grammar, that it carries **no** key for the `.md` path, and that that one entry's
   `bytes` is 0, so it adds nothing to the byte sum `mb` reads. (`parsed` is a **cardinality**, and
   the entry does move it, by one; the byte sum belongs to `mb` alone — D4.) A `parsed` accumulated on a blob's *first appearance in a
   sha-keyed roster* sees the no-grammar verdict first and undercounts by one, which is exactly the
   arrival-order residue D4 removes by counting keys instead of shas.
   **(c) One sha, two *keyed* paths under different grammars** — the second same-blob pair the
   day-0 seed carries for exactly this, `src/stub/same.ts` and `src/stub/same.py` with
   byte-identical content (T3 item 1, T3 acceptance 8). Assert by value that `blobShas` carries
   their shared sha (one entry) while `parsedKeys` carries **two** keys for it — the `.ts` and
   `.py` grammars' keys, distinct because `blobCacheKey` folds the per-grammar `bindingHash` — so
   `parsed` counts 2 against `blobs`' 1 for this blob. **`mb` is the one quantity here that is
   prose, not an assertion:** `mb` is floored MiB (D4) and is **0** on every fixture in this plan,
   so the stub's length entering the byte sum twice is arithmetically real and observably invisible.
   Assert the doubling on `parsedKeys`' two `bytes` values instead, where it is visible, and say in
   the criterion that `mb` cannot carry it at this fixture size. This is D4's "`parsed` may exceed
   `blobs`" consequence asserted on a fixture instead of only argued, and it is a strictly different
   mutant from (b): a sha-keyed roster **restricted to keyed records** never sees the `.md` verdict
   at all and survives (b) untouched, while it fails here by one. (b) and (c) together are what make
   "two rosters, keyed on the cache key" a tested rule rather than a stated one.
9. **`agentShare` distinguishes an empty population from a zero share, and MR-29 is the
   round-trip.** It is `null` on each of the **seven** landed goldens — nothing is first seen in the
   clock's trailing 120 days, so the population is empty — and `null` on a repo with no history. On
   the **`history/`** golden it is exactly **0**: the `ship` scopes (first seen day 300) and the
   day-395 cohort put a non-empty population inside the window, and none of them is agent-authored.
   A separate assertion proves no `NaN` ever reaches the serializer on any input, since a
   serialized `NaN` would arrive as an indistinguishable `null` (§18.4, `v6-spec.md:687`).
10. **D17's two gates, asserted at the only place gate 1 is applied.** Build the `history/` golden,
    add a
    commit touching `dist/bundle.js`, `node_modules/pkg/index.js`, `src/generated/api.d.ts` and
    two ordinary source files, then index.
    **The two ordinary source files are the golden's already-supported pair — `src/svc/order.ts`
    and `test/order.spec.ts` — and the co-change half of this criterion is asserted as that pair's
    `support` by value. Both halves of that sentence are load-bearing, because at the default
    `cochange.minSupport` **8** (`src/io/config-parser.ts:112`) a support-1 pair never reaches
    `cochange` at all, so any clause phrased against a *new* pair's presence or absence there tests
    nothing.** Every pair a freshly-invented five-file commit could create sits at support 1, which
    is why the old phrasing ("the commit contributes the one pair its two source files make", "none
    of the three appears in `cochange`") was true under the mutants too. Reusing the `order` pair
    puts the whole control above the floor. Add the mega-commit half in the same test — a second
    commit touching forty `dist/` files **and the same two source files** — and the arithmetic is
    then hand-derivable and mutant-separating:
    - **Correct** ⇒ each of the two commits survives gate 1 with exactly its two source files, both
      land inside the counted 2…30 band, `commits(order.ts)` = 9 + 1 + 1 = 11 and
      `support(order.ts, order.spec.ts)` = **11**, confidence 11/11 = 1.0 ≥ `minConfidence` 0.75, so
      the pair is in `cochange` at support 11.
    - **Gate applied *after* the band is measured** (MR-30's second mutation) ⇒ the 42-file commit
      reads as a mega-commit and contributes nothing, giving support **10**. Killed by one.
    - **Gate deleted outright** (MR-30's first mutation) ⇒ the five-file commit still counts (5 ≤
      30) but the 42-file commit is again a mega-commit, giving support **10**. Killed by one as
      well — and killed independently by this criterion's lifecycle-row and `blobShas` clauses,
      which is why those stay.
    Assert the support by value. Do **not** re-express the excluded paths' absence against
    `cochange`: keep that as prose and assert their exclusion where it *is* observable — **no
    lifecycle row of either level** for any of the three, and **none of their blob shas in
    `join.blobShas`** (the roster, not the `blobs` integer — an integer answers no membership
    question, Files list). Every one of the three excluded paths carries a registered grammar, so
    nothing but the exclusion list distinguishes them.
    **Every commit this control appends** — the two above and the rename half's setup and rename
    commits below — is dated after the golden's day-400 tip and in ascending order, through
    `deterministicCommitDateAt`'s commit-index grid (T3 Step 1) and never through `extraEnv`, which
    silently discards a date. Reusing the `order` pair moves no number **T3's page** states and no
    other criterion here: T3 acceptance 6 and T6 acceptance 3 both read the **pristine** golden,
    which this test never mutates in place, and acceptances 7 and 9 above read their own build of it.
    **The rename half, both directions, since D17 fixes gate 1's path to the post-image and the two
    directions disagree.** The two moved files are **created by this test's own setup commit**
    (`src/mover.ts` and `dist/legacy.js`) rather than taken from the golden's script, so no quantity
    T3's page states and no other criterion here can move: a later commit then does
    `git mv src/mover.ts vendor/mover.ts` and `git mv dist/legacy.js src/legacy.js`. **Each of the
    two must edit the moved file's body in the same commit, and that is a requirement rather than a
    flourish:** a *pure* `git mv` emits `R100` with the pre-image and post-image sha **identical**
    (verified on `git version 2.43.0`), so its post-image sha is already in the blob roster from the
    commit that created the file and "the sha does not enter the roster" would assert nothing. With a
    body edit git emits a single scored record — **a scored `R` token of the form `R0xx`**, old path
    `dist/legacy.js`, new path `src/legacy.js`, one record,
    two **distinct** shas (verified) — and the post-image sha is genuinely new, which makes the
    assertion real. **Assert the token's *shape*, never a literal score.** The digits are a
    similarity percentage computed from the content the fixture happens to carry: the same
    rename-plus-small-edit reproduced on two different bodies gives `R095` and `R083` (both measured
    on `git version 2.43.0`), so pinning `R066` would pin the fixture rather than the behaviour —
    and the parser strips the digits anyway (T2 Step 1). **The body edit also carries a real
    constraint that must be stated:** it has to stay **above `-M`'s default 50 % similarity
    threshold**, or git stops emitting a rename at all and emits a `D` plus an `A` instead
    (verified: replacing 20 lines with 60 unrelated ones turns the record pair into
    `D src/legacy.js` + `A src/legacy2.js`), which would silently make the whole rename half of this
    criterion test nothing. Keep the edit to a line or two on a file of at least ~20 lines.
    Then assert the
    first is dropped whole — no alias edge from `src/mover.ts`, no lifecycle row under
    `vendor/mover.ts`, and **its new post-image sha absent from
    `join.blobShas`**. The load-bearing clauses here are the alias edge, the lifecycle row and the
    roster entry; a `cochange` clause is deliberately **not** among them, for this half's own second
    reason on top of the `minSupport` 8 one stated above — each rename commit touches a single file,
    so it creates no pair in either direction under any implementation.
    Meanwhile
    `src/mover.ts`'s existing rows keep the values they had and simply stop moving — and
    assert the second **survives**: a lifecycle row and a `join.blobShas` entry for its new
    post-image sha
    under `src/legacy.js`, its
    post-image scopes recorded as **introductions** because its pre-image path `dist/legacy.js`
    fails gate 2 and so resolves to the in-memory skip record with no scopes, and no lifecycle row
    anywhere under `dist/legacy.js`.
    **And gate 2's mirror image, which is the only place either number exists.** A commit touching
    only `NOTES.md`, and a commit touching only `src/foo.test.ts` — a registered-grammar path the
    parse filter excludes — each carry **no lifecycle row of either level** for that path, while the
    commit is still counted in `historyStats.commits` and the blob is still rostered in
    `join.blobShas` with **no** corresponding entry in `join.parsedKeys`, so it contributes nothing
    to `parsed` and nothing to `mb` (D4, D17 gate 2) — the roster pair again, since "is this sha in
    the roster and this key out of it" is the question and the integers cannot answer it. That is the exact opposite of the gate-1 clauses above, and the pair of them is
    what makes the two tiers distinguishable by test rather than only on this page.

**Test obligations / mutation round-trips.**
- **MR-23 (per-surface weight):** revert `surfaceWeightFn` to a per-scope weight — and spell the
  mutation the faithful way, the same way MR-27 spells its own: cap at `hookShapedWeight` 0.15
  whenever the scope carries **any** unreleased mark, on **any** surface ⇒ acceptance 3's *sibling*
  assertion fails, because the unmarked surface's fact loses `base − 0.15` too. Spelling it as
  "drop the cap entirely" instead would be a weaker mutant that acceptance 3's first half already
  kills, and would leave the real per-scope reduction alive.
- **MR-24 (hook-shaped exclusion):** stop excluding unreleased marks from the survived population
  ⇒ acceptance 3's `nConformRaw` half fails.
- **MR-25 (fail-closed):** make `survivedOf` default true when no AgeFn is present (the
  prototype's inversion) ⇒ the no-git control fails.
- **MR-26 (clock):** neither wrong clock is detectable on a D8 golden alone — with every scope 400
  days stable, `w_surv` saturates at 1, so two runs seconds apart under a real wall clock are
  deep-equal and acceptance 6 passes anyway. The round-trip is pinned where the three candidate
  clocks genuinely differ. Take the clock from `max(lastModified)` over the replay ⇒ it becomes day
  **395**, since the day-400 `NOTES.md` commit carries no lifecycle row at all (T5 Step 2), so the
  `history/` golden's `ship` scopes read `stable_days` 15 ⇒ `w_surv = 0.125` instead of 20 ⇒
  `0.166667` and acceptance 7 fails; the merge-HEAD control (Step 6 (iv)) fails with it, because the
  walk's last non-merge commit does not carry HEAD's timestamp. Take it from
  `Date.now()` ⇒ acceptance 7 fails on both rows (a wall clock is not 400 days after day 0) and the
  merge-HEAD control's clock assertion fails too. The *sha* half of the merge-HEAD property — that
  `lastIndexedSha` is the merge's sha and not the last non-merge commit's — is not this task's to
  kill: nothing here writes that field. It is pinned by T9's determinism case (g).
- **MR-27 (`role_lift`'s divisor stays `w_base`):** `computeRoleLiftForPartition`'s
  `nEff += weightOf(u.stableId)` (`mine.ts:497`) sits in a loop with **no surface in hand**, so the
  mutation has to choose one — and the shape a wholesale `weightOf` widening actually produces is
  "cap whenever *any* unreleased mark exists on the scope, on any surface". Spell it that way:
  replace `weightOf` at that line with a scope-level wrapper capping at `hookShapedWeight` 0.15
  when the scope carries any unreleased mark ⇒ a test pinning `role_lift` on a partition holding
  exactly one unreleased ledger mark fails, because the capped 0.15 shrinks the divisor and
  inflates the lift — the §8.10 corruption a wholesale widening would introduce silently.
- **MR-28 (`historyStats` is run-independent — three mutants, one per clause of acceptance 8):**
  define `parsed`/`mb` over the
  blobs
  this run **fetched** ⇒ acceptance 8(a) fails on the warm pass, where they collapse to zero —
  and it fails on `parsed` **alone**, which is what makes 8(a) a real killer at this fixture size:
  `mb` is floored MiB and is 0 on every fixture in this plan, so it moves for no mutant here and
  carries no assertion (acceptance 8(c) says so).
  Roster `parsed` on the blob **sha** instead of the cache key, over **all** records keyed and
  unkeyed, accumulating on first appearance ⇒
  acceptance 8(b) fails by one, because the shared empty blob's no-grammar path arrives first —
  observable because 8(b) reads `parsedKeys` itself, which the correct implementation keys per
  grammar and this mutant keys per sha.
  Roster `parsed` on the blob **sha** but **only over records R4 keys** — the narrower sha-keyed
  mutant, which 8(b) does **not** kill, since it never sees the `.md` verdict — ⇒ acceptance 8(c)
  fails by one, because the `.ts`/`.py` stub pair's two keys collapse to one sha. All three are
  needed: each survives the others' mutations, which is why D4 states two rosters keyed on the
  cache key and not one roster keyed on the sha.
- **MR-29 (empty population is `null`, not `0`):** return `0` from `computeAgentShare` when the
  denominator is 0 — the shape an unguarded `sum / total` ships, since `JSON.stringify(NaN)`
  emits `null` and hides it — ⇒ acceptance 9 fails on all seven landed goldens, whose
  trailing-120-day population is empty by construction (D8) and which are the only fixtures where
  the two encodings differ. Conversely encode the `history/` golden's genuine zero as `null` ⇒
  acceptance 9 fails on the eighth.
- **MR-30 (D17's gate 1):** delete the `forMarkers` filter from Step 1's per-commit record
  handling ⇒ acceptance 10 fails on several clauses at once — the excluded paths' shas appear in
  `join.blobShas`, they carry lifecycle rows, and the `order` pair's support reads **10** instead
  of 11 (the five-file commit still counts, but the 42-file commit becomes a genuine mega-commit
  and drops out). Second mutation, on the *placement* rather than the presence: apply the
  filter **after** measuring the changed-file band ⇒ the `order` pair's support reads **10** as
  well, since the forty-`dist/`-file commit reads as a 42-file mega-commit and contributes nothing
  where it should contribute one pair. **Both mutants land on 10 against the correct 11, and that
  is fine — the criterion's job is to separate each mutant from the *correct* value, not from the
  other mutant** (the first is separated from the second anyway, by the roster and lifecycle-row
  clauses it alone breaks). What matters is that the support is asserted **by value** on a pair
  already above `minSupport` 8; the round-4 phrasing measured a brand-new support-1 pair, which
  never reaches `cochange` under *any* of the three readings, so this second mutant survived it.
  Third mutation, on the *path* rather than the presence or the
  placement: feed `forMarkers` a record's `path` instead of its post-image `newPath ?? path` (D17
  clause 1) ⇒ acceptance 10's rename half fails in **both** directions at once — the
  rename-into-`vendor/` case leaks a lifecycle row and an alias edge under `vendor/mover.ts`,
  and the rename-out-of-`dist/` case is dropped, losing `src/legacy.js`'s row and its `blobs`
  entry. This is the mutation the round-4 text could not kill, because it never said which of a
  rename record's two paths the gate reads.

**NON-goals.** No `lastIndexedSha` header field and no change to the tests that pin it `null`
(T9's). No verdict, message, session, telemetry or demotion surface. No trends, cohorts,
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
  decision function `decideWalkMode(...)` (pure and separately unit-tested: `--full`, no state —
  which includes a state the store refused to load at all, whether for a malformed line or an
  epoch disagreement (T1, D15) — schema mismatch, inputs mismatch, unreachable sha, windowing ⇒
  `full`; else `resume`).
  **`meta.json`'s two rosters are the persisted form of the two `buildHistoryJoin` already returns**
  — `blobShas` and `parsedKeys` (T8's Files list) — not a second pair assembled here, and the flow
  runs **both ways**: on a resume the stored rosters are loaded **into** the join's, this run's
  entries are added to them, and the union is what both `historyStats` counts and `writeHistoryState`
  persists. That is what keeps `historyStats.blobs === blobShas.size` and
  `historyStats.parsed === parsedKeys.size` true on a resumed run as well as a full one (D4's
  running-totals rule). A locally rebuilt roster could disagree with the `historyStats` integers
  already in the model, and D4's whole point is that the two are one thing.
- Modify `source/cli/src/cli/roots.ts` — `--full` flag; acquire/release the build lock around the
  whole index; write `lastIndexedSha` into the header **only when the history walk actually ran and
  its state was committed**; progress rendering (D12).
  **The condition on that write is not a detail, and stating it is what keeps the field honest.**
  `lastIndexedSha`'s spec meaning is the resume anchor — "the walk resumes from the **snapshot's**
  `lastIndexedSha`" (§6.6 clause 3, `v6-spec.md:257`) — so it names the commit the history is
  indexed **through**. In every degraded mode (no git repository, a **shallow clone**, or a walk
  that threw) `buildHistoryJoin` returns `undefined` (T8 Step 2): nothing is walked, no replay state
  is written, no `meta.json` exists. Writing HEAD's sha into the header there would put a false
  statement into a committed artifact and would invite the next run to "resume" from a commit
  nothing ever applied — the exact inversion §21.1/R4-I4 exist to prevent. So it stays **`null`** in
  all three, exactly as in a non-git repo, and this is the same honesty doctrine the rest of the
  increment already applies: `agentShare: null` for an empty population (T8 Step 4), the four
  coverage/debt keys absent rather than `0` (D9), `historyStats` absent rather than zeroed in
  degraded mode (T8 Step 2).
- Modify `source/cli/src/roots/pipeline.ts` — **one** authorized edit, and D13 needs it: lift the
  used-asset set and its `bindingSetHash` fold (`pipeline.ts:205-222`) out of `runRootsIndex` into
  an exported standalone function, so the command can compute the header's `bindingHash` **before**
  mining. Without this the short-circuit's input comparison is unimplementable: `bindingHash` is
  `runRootsIndex`'s *output* today (`cli/roots.ts:370-380` reads it off `result.bindingSetHash`,
  at `:378`),
  so there is no cheap pre-pass that yields it.
  **This is a re-specification, not a copy of the landed lines, and the difference is the whole
  point.** As landed, the fold walks the parse set and then *looks each asset up in the
  module-level `bindingCache`* (`pipeline.ts:48`), which only `bindingForAsset` fills and which
  `parseAndExtractAll` fills earlier in the same call — and only for assets that got past its
  `blobMaxBytes` and 40 000-line gates (`:126-129`). Lifted verbatim and called **cold**, which is
  exactly how the short-circuit calls it, every lookup misses, the map is empty, the fold hashes
  `"{}"`, D13's condition 1 can never hold and the short-circuit is dead code. So dictate the
  semantics:
  - The exported function takes `(repoRoot, config)` and owns its own pass: `walkRepoFiles` →
    `forMarkers` → `forParsing` → `getGrammarForExtension` → `assetNameOfWasmFile`, and it
    **derives** each used asset's binding through the shared `bindingForAsset`. It is
    cache-*warming*, not cache-*reading*, so it returns the same hash on a cold process and a warm
    one.
  - **Name the one behavioural difference rather than claiming there is none.** The used-asset set
    becomes the *parse-candidate* set (every asset with ≥ 1 file passing `forParsing`) instead of
    the *actually-parsed* set (every asset with ≥ 1 file that survived the oversize and max-lines
    gates). The two differ only for a repository in which **every** candidate file of some grammar
    is over `blobMaxBytes` or over 40 000 lines — in which case that grammar's hash now enters the
    fold where it previously did not, and `runRootsIndex`'s header `bindingHash` changes. That is a
    deliberate, stated change, and it is the *right* direction: the header is describing which
    grammars this repository's source would be read with, not which ones happened to survive a size
    gate. Report it; do not claim "unchanged byte-for-byte", which is false.
  - `runRootsIndex` then calls that same function instead of running the loop inline, so there is
    exactly one definition.
  T4 may already have lifted the asset-name rule and the per-grammar binding *cache* out of this
  file (T4 Step 1); this edit is the used-asset **set** and its fold, which is a separate function.
  Nothing else in `pipeline.ts` moves in this task.
- Modify `source/cli/src/roots/stores.ts` — nothing new expected; confirm.
- **Keep green, do not convert:** `tests/unit/roots/pipeline-binding-set.test.ts:44` and
  `tests/unit/roots/pipeline.test.ts:194`/`:198` are the guards on this lift. The first pins that
  the fold covers *this run's* used grammars and never the process-lifetime cache — it indexes a
  TypeScript repo, then a Python repo, then the TypeScript repo again in one process and asserts
  the first and third hashes match — and the derivation form above keeps it passing, while a
  cache-*reading* form would make the third run inherit python and fail it. The other two pin
  insertion-order independence and cross-run stability. All three stay 3-arg (T8's Files list) and
  all three must be run before and after this edit.
- Modify `tests/e2e/cli-roots-basic.test.ts:64` and `:104-116` (the landed double-`index` case,
  which becomes the **no-op short-circuit** case — see Step 5(a)) and
  `tests/unit/cli/roots.test.ts:177-203` (`lastIndexedSha` pins).
- Modify `CHANGELOG.md` — **amend the single `## [Unreleased]` entry T8 drafted, in place**, to
  cover what this task makes adopter-visible: a re-index is incremental, `--full` is the reference,
  and an index refuses rather than writing over a run already in progress. One entry, never a
  second (CHANGELOG policy).
- Create `source/cli/tests/unit/roots/history-resume.test.ts` and
  `tests/e2e/cli-roots-incremental.test.ts` — the e2e suite drives the built `dist/bin.js` and uses
  `tests/support/**` only: `tests/support/branch-merge-fixture.ts` (T3) for cases (b) and (g), and
  `roots-golden.ts`/`git-fixture.ts` for the rest. It creates no fixture helper of its own.

**Steps.**
- [ ] **Step 1: `inputsHash`, the walk decision, and the no-op short-circuit.** The walk decision
  is exactly D2's, with a unit test per trigger. A resumed walk that produces a state whose
  `lastIndexedSha` is not HEAD is a bug, not a fallback — assert it. Add one case for D2's
  discard rule: seed the state directory with a state whose counters are non-zero, force `full`,
  and assert the resulting state's `modifications`, co-change supports and `historyStats` equal a
  from-scratch walk's rather than their sum.
  **`inputsHash` needs a test of its own *composition*, and it is the only thing in this plan that
  can have one — state this as a separate obligation from the trigger tests, because the two are
  blind to different halves.** A trigger test feeds `decideWalkMode` a hash that mismatches, and
  case (e) hand-edits the hash **stored** in `meta.json`; neither observes which ingredients the
  hash folds, so both pass unchanged against a `computeInputsHash` that silently dropped one. So
  assert directly, on the function, that the hash **differs** when exactly one ingredient differs
  and nothing else does — one assertion per ingredient D2 enumerates: the **state schema version**,
  the **extractor version**, **any one grammar's binding hash**, and the canonical
  `history:` + `include`/`exclude` **config subtree** — plus one that two identical input tuples
  hash equal, so the assertions cannot be satisfied by a hash that simply changes every call. This
  is MR-32's killer and MR-32 names it; the four full-walk triggers keep their own tests.
  Before any of that — and **before `acquireBuildLock`** — D13's short-circuit. The command
  computes the eight **input** fields D13 enumerates (`bindingHash` among them, through the
  standalone binding-set fold this task lifts out of `pipeline.ts`), compares them field by field
  against the on-disk header, and short-circuits only when all four of D13's conditions hold:
  equal inputs, `decideWalkMode` ⇒ `resume`, an empty `lastIndexedSha..HEAD` range with
  `meta.json`'s `lastIndexedSha` equal to `readHead().sha`, and a blob cache directory that exists.
  Then the run ends with "already current" and **zero writes**. One unit test per condition, each
  flipping exactly that one and asserting the run proceeds — the four together are what keep the
  short-circuit from swallowing cases (d), (e) and (f) below, every one of which leaves a present,
  parseable, inputs-matching state on disk. A **fifth** unit test covers the read itself: an
  unreadable on-disk model — unparseable JSON, a wrong `{header, body}` shape, or a `rootsVersion`
  the CLI does not read — makes `readModel` throw (`stores.ts:156-182`), which D13 turns into "no
  comparable header": one `debugWrite`, condition 1 fails, the run proceeds and rewrites the model
  rather than failing the command.
- [ ] **Step 2: Lock the writer.** `index` acquires `.cache/.build.lock` before the first write and
  releases it in a `finally` — and **after** D13's short-circuit has already decided the run has
  work to do, since creating and then deleting the lock file is itself a write to the cache
  directory and §6.6's clause 6 allows a no-op run **zero** (`v6-spec.md:260`).
  A held fresh lock is **waited on for the bounded window T1's `acquireBuildLock` implements, and
  only then refused**, with a what/why/next message naming the
  holding pid (`buildIssueMessage` — the command formats, the store returns data): §4.4's binding
  clause is "wait briefly, then fail" (`v6-spec.md:139`; design `:160-163`), and a run that
  refuses instantly implements half of it. A holder that releases inside the window is waited out
  and the second run proceeds normally. `status` never takes the lock.
- [ ] **Step 3: `--full`.** Documented as the determinism reference (`integration-design.md:79`):
  it forces the walk and, per §6.6, is what an adopter runs after a merge conflict on
  `model.json`. It also bypasses D13's no-op short-circuit — an explicit `--full` always
  recomputes and rewrites, which is what makes it usable as the reference.
- [ ] **Step 4: Progress and the run summary (D12).** When the count of *uncached* blobs projects
  past 60 s at the
  spec's ≈ 12 ms/blob (`v6-spec.md:602`, `:712`), print one line to stderr with the blob count and
  the ETA, then an update every 500 blobs. Nothing reaches the model.
  **Beside the conditional progress line, every `index` run that walks writes one stderr summary
  line — a short-circuited run prints "already current" instead — and it is specified here because three cases below read numbers from it that
  nothing else prints.** D12 mandates only the >60 s progress line, and D4 says run diagnostics "go
  to stderr and nowhere else" without requiring any to be printed — so as written, case (c)'s
  "parses zero blobs", case (e)'s 25-commit full-walk figure and case (g)'s "walked 0 commits" would
  have no surface to read. The summary
  carries, in plain user terms (no internal vocabulary — the maintainer's own rule), at least
  **commits walked this run** and **blobs parsed this run**; both are run diagnostics, so neither
  reaches the model (R4-I1). The no-op short-circuit's "already current" line is that run's summary
  and replaces it — a run that decided it had nothing to do has no walk to describe, and §6.6
  clause 6 constrains **writes to the cache directory**, not stderr.
  **Both figures travel on the `onProgress` callback, and naming the transport is what makes them
  reachable at all.** Each is known only inside `buildHistoryJoin`; `runRootsIndex` returns
  `{body, bindingSetHash, candidateCountLog2}` and gains no field here, and this task's
  `pipeline.ts` clause authorizes exactly one edit to that file and says nothing else in it moves.
  So `history.ts` — which this task already modifies — **emits** them through the optional
  `onProgress` callback T8 declares on `runRootsIndex`'s `options` and T8 already forwards into
  `buildHistoryJoin` (D12: the engine carries
  `no-direct-console`), and `src/cli/roots.ts` renders the summary line to **stderr**, the same
  path the >60 s progress line already takes. **`pipeline.ts` therefore needs no edit for this** —
  the transport is already wired — so this task's one authorized `pipeline.ts` edit stays the
  binding-set lift and nothing else in that file moves.
- [ ] **Step 5: The determinism suite** — the increment's centerpiece:
  (a) **double `--full`** on one tree ⇒ byte-identical `model.json`, header included. **That tree
  is the pristine `history/` golden**, named here because cases (d), (e) and (f) all compare their
  model against this one's and (e) hand-derives a commit count from it: its **25** commits (T3) are
  every one a non-merge, so a full walk of it reports 25 commits walked. This is a
  **new** case, added beside the landed cross-process one. The landed case
  (`tests/e2e/cli-roots-basic.test.ts:104-121`) runs plain `index` twice on an unchanged tree,
  which after this task does **not** resume: all four of D13's conditions hold, so the second run
  short-circuits, walks zero commits and writes nothing (acceptance 2, §6.6 clause 6). It is
  relabelled the **no-op short-circuit** case and its assertion is strengthened to match — bytes
  *and* mtime unchanged, stderr saying "already current" — never described as a resume. Nothing
  about a genuine resume can be observed from it, since it never reaches `decideWalkMode`'s resume
  path at all; **case (b) is the only byte-comparison of a real resume against a full walk**, and an
  implementer who "fixes" the contradiction by weakening D13 so the second run really does resume
  breaks acceptance 2 and §6.6 clause 6. The relabelled case's home is **acceptance 2** below, not a
  lettered case of its own, so this suite is exactly (a)–(h);
  (b) **incremental ≡ full — the only real resume comparison in the suite**: index the `history/`
  golden at commit N, append three **prescribed** commits, index again (resume), then index a
  *fresh clone* of the same tree with `--full` ⇒ byte-identical `model.json` **and** byte-identical
  replay state. The three are appended directly on the built repository — N+1 and N+2 through
  `tests/support/git-fixture.ts`'s deterministic primitives, N+3 through
  `tests/support/branch-merge-fixture.ts`'s `appendMergeOfOlderSideBranch` (T3) — and **not** by
  extending the golden's `GoldenCommit`
  array: one of them is a merge, and one is dated before the commit that precedes it, neither of
  which `buildGoldenRepo` can express (it builds a linear chain and its monotonicity guard would
  reject the dip — T3, deliberately, since the golden's own hand-derived arithmetic depends on
  ascending offsets). The commits are prescribed because commits that merely add a new file exercise
  none of the quantities a resume accumulates.
  **Every one of the three carries a prescribed day offset, because the appended history has to
  stay hand-derivable exactly as the golden's own does:** N+1 at **day 402** and N+2 at **day 405**
  — both strictly between the golden's day-400 tip and N+3's day-410 merge, so the main line stays
  ascending — and N+3's side commit at day 390 with its merge at day 410. All four go through
  `deterministicCommitDateAt`'s commit-index grid (T3 Step 1), never through `extraEnv`, which
  silently discards a date.
  **Commit N+1 (day 402)** adds a decorator to an existing scope with **no body change** — a change
  event the
  resumed walk can only produce by resolving that record's *pre-image* blob, which no commit in its
  own range wrote; it comes from the blob cache the previous run filled, and an implementation that
  assumed an absent pre-image would report an introduction instead (D16).
  **Commit N+2 (day 405)** re-touches an already-supported co-change pair — proving the raw supports and the
  per-file commit counts survived the run boundary, so `support` and `confidence` match the full
  walk — **and** renames a tracked file in the same commit, proving the alias edges accumulated
  across runs and the closure is taken over the union, not per run.
  **Commit N+3 is a merge of a side branch whose own commit is dated *before* commit N** — branch
  off a commit earlier than N, make one commit there at **day 390** (the golden's tip commit N is at
  day 400), then merge at day 410, so HEAD is the merge. Build it with
  `appendMergeOfOlderSideBranch` from `tests/support/branch-merge-fixture.ts` (T3), which is the
  helper that owns this shape and the only thing on the e2e side allowed to construct it — an e2e
  suite may use `tests/support/**` plus the public CLI surface and nothing else. Its day offsets go
  through the commit-index grid, never through `extraEnv`, which silently discards a date (T3
  Step 1). This is the ordinary "merge a feature
  branch started before the last index" shape, and the case that broke the design D16 replaces. The
  resume range `<N>..HEAD` then contains the day-390 commit, which the full walk applies in a
  completely different relative position; byte-identity here is the empirical proof that nothing in
  the replay depends on arrival order. Without this commit the case is satisfiable by an
  order-dependent implementation, which is how the defect survived earlier drafts. (It also makes
  HEAD a merge, so this case exercises the merge-HEAD clock alongside case (g)'s sha.)
  Delete any one of `cochange-raw.jsonl`'s supports, its per-file commit counts, `aliases.jsonl`'s
  edges, or `meta.json`'s appearance counters, and this case fails; reintroduce a carried
  previous-value map and it fails on N+3;
  (c) **cache-state independence**: delete `.cache/` entirely, re-index ⇒ byte-identical
  `model.json`. The
  deleted cache is a pending rebuild, so D13's short-circuit does not fire here — the run really
  does re-walk and re-parse, and the model still comes out byte-identical.
  **The zero-parse assertion does not belong to that run and must not be attached to it:** deleting
  `.cache/` makes it a **cold** run by construction, so it fetches and parses every blob in the
  history. It belongs to the run that **follows** — an `index --full` against the now-warm cache,
  which re-walks every commit and parses **zero** blobs — read off Step 4's stderr run summary,
  which is the only surface an E2E driving the built `dist/bin.js` has for it — which
  is R4-I8's property and the one the cold run cannot exhibit. `--full` rather than a plain `index`
  because a plain one would be answered by D13's short-circuit and would prove nothing: it would
  parse zero blobs without walking anything;
  (d) **unreachable SHA**: hand-edit the state's `lastIndexedSha` to a well-formed but absent sha
  ⇒ the run falls back to a full walk and the model is byte-identical to (a)'s. The state is still
  present, parseable and inputs-matching, so nothing but `decideWalkMode`'s own reachability probe
  distinguishes it — which is exactly why D13 conditions its short-circuit on that verdict rather
  than on a list of state defects;
  (e) **inputs mismatch**: bump `EXTRACTOR_VERSION` in a copy of the state's `inputsHash` inputs ⇒
  full walk, same model — **and `historyStats` equal to (a)'s field for field**. That second
  assertion is one of the case's two points: editing the stored hash leaves the real
  `EXTRACTOR_VERSION`
  alone, so every blob-cache key still hits and the forced full walk fetches nothing at all, which
  is precisely where a cache-dependent `parsed`/`mb` would collapse to zero (D4).
  **The full walk itself has to be *observed*, and that is the case's other point — without it the
  case cannot tell a full walk from a resume and asserts only that the model is stable.** The
  state's `lastIndexedSha` is HEAD, so a run that wrongly **resumed** would walk an empty range,
  re-emit `historyStats` unchanged from state and write a byte-identical `model.json` — passing
  every clause above while doing the opposite of what the case is named for. So assert the
  **commits-walked figure in Step 4's stderr run summary equals the full walk's count: 25** on
  case (a)'s `history/` golden, whose 25
  commits (T3) are every one a non-merge. A run that resumed reports **0**, and a
  `decideWalkMode` that ignored the inputs mismatch outright is killed by the same number. **This is
  the case's only observable of the walk mode; it is not what kills MR-32**, which is a claim about
  how `inputsHash` is *composed* and is answered by Step 1's composition test instead;
  (f) **hostile state**: truncate `events.jsonl` mid-line ⇒ full walk, same model, one debug line,
  no crash — the store rejects the whole state rather than skipping the torn line (T1), which is
  what makes this a real case instead of a silent partial load. Same case, second shape: rewrite
  `meta.json` with an earlier state's `stateEpoch` beside the current accumulators (D15's
  torn-write shape) ⇒ the same full walk and the same model. Third shape: **delete one of the six
  files outright**, leaving the other five clean and epoch-consistent (R4-I10's failed-write
  shape, D15) ⇒ the same full walk and the same model;
  (g) **merge HEAD**: a fixture repository whose HEAD is a merge commit —
  `buildBranchMergeFixture({trailingMainCommit: false})` from
  `tests/support/branch-merge-fixture.ts` (T3), in the same `trailingMainCommit: false` variant
  T8's control (iv) uses and **not** the default five-commit one T5's acceptances 8–9 drive —
  indexes and records the
  merge's sha as `lastIndexedSha`. A second `index` on an *unchanged* tree would be answered by
  D13's short-circuit and observe nothing, so the case **dirties one tracked file first**: the
  input comparison then differs on `dirtyHash`, the short-circuit does not fire, and the run
  reaches `decideWalkMode` — which must return `resume` and walk `<merge>..HEAD`, i.e. no commits,
  rather than falling back to a full walk. Assert it through `meta.json`'s `lastIndexedSha` and the
  commits-walked figure in Step 4's stderr run summary (zero), **not** through the model bytes,
  which a dirty file legitimately moves (`dirtyWeight`). The `--no-merges` walk never names the merge sha, so only
  `readHead` can supply it, and a resume anchored on the last non-merge commit would silently
  re-apply commits already replayed. **This case is the sole home of the merge-sha half of the
  merge-HEAD property** — T8's control (iv) asserts the clock only, because nothing before this task
  writes `lastIndexedSha` at all;
  (h) **degraded walks leave `lastIndexedSha` null** — the negative half of case (g), and the case
  acceptance 5 is written against. Two repositories, both buildable through the public CLI surface
  an e2e is limited to: one with no `.git` at all, and one **shallow clone** (`--depth 1` of a
  golden — the fixture T8 Step 6 (ii) already builds). Each indexes successfully, exits 0, writes a
  `model.json` — and each leaves the header's `lastIndexedSha` **`null`**, with **no** replay state
  directory beside it. D2's third degraded cause, a walk that **throws**, is not driven from here
  because an e2e has no injection point for it; it needs none, because the header write is
  conditioned on `buildHistoryJoin` returning a join at all and that function returns `undefined`
  for all three causes alike (T8 Step 2) — the two cases here pin the condition, not each cause.
  Without this case the header write is unconditioned and a shallow CI clone would record a resume
  anchor for a walk that never happened.
- [ ] **Step 6: Graph ritual + report.**

**Acceptance criteria.**
1. All **eight** determinism cases (a)–(h) green. Each of the **six** that compares models asserts
   *byte* identity of the file, not a deep-equal of a parsed object; cases **(g) and (h)** compare
   no models across runs — (g) because a dirtied working file legitimately moves the body
   (`dirtyWeight`), (h) because a degraded index is not byte-comparable to a full one — and each
   asserts its own named surface instead: `meta.json`'s `lastIndexedSha` plus the run summary's
   zero-commits figure for (g); the header field and the absent state directory for (h).
   **A model comparison is never a case's *only* assertion where the walk mode is the thing under
   test:** case (e) is byte-identical to (a) whether it walked or wrongly resumed, so it carries the
   run summary's 25-commit figure on top of its model comparison. Two cases therefore read the
   summary's commits-walked number for opposite values — 25 in (e), 0 in (g).
2. A second `yg roots index` on an unchanged tree parses zero blobs, walks zero commits and —
   per D13 and §6.6's clause 6 (`v6-spec.md:260`) — **writes nothing at all**: `model.json`'s
   bytes *and* its mtime are unchanged, and no state or cache file is rewritten. The run says
   "already current" in plain terms and exits 0. **The zero-parse and zero-walk halves are asserted
   from the untouched bytes and mtime plus that line, not from Step 4's run summary** — this run
   never walks, so it has no walk to summarise and the "already current" line is what it prints
   instead. Cases (c), (e) and (g), which do walk, are where the summary's own numbers are read.
3. `yg roots index --full` on the same tree produces the same bytes as the incremental run.
4. Two concurrent `index` runs where the holder **never** releases: the second waits up to the
   bounded window and only then exits non-zero with a message naming the holder's pid, and the
   first's model is intact. That half is deterministic at any machine load, which is why it is the
   E2E. The **release-inside-the-window** half is deliberately *not* asserted here: observing it
   would require a full index of the `history/` golden — 25 commits, ~92 files, a cold blob cache —
   to finish inside `waitMs` 2000, which is a timing assertion in the commit gate and flaky by
   construction, exactly what this plan's global constraints forbid. It lives at the unit level
   instead, on T1's `acquireBuildLock` with its injected clock and injected sleep (T1 Step 2, T1
   acceptance 2), where the release happens on the test's schedule and nothing waits.
5. The header's `lastIndexedSha` equals `readHead().sha` after any successful index **that walked
   history** — including when HEAD is a merge commit, which the walk itself never reports — and
   stays `null` in a non-git repo, **in a shallow clone, and after any degraded walk** (case (h)).
   "Any successful index in a git repo" would be the wrong quantifier and is the reading this
   criterion exists to exclude: a shallow clone is a git repo, and so is one whose walk threw, and
   in both `buildHistoryJoin` returns `undefined` and no commit is indexed through. The field names
   the commit the history is indexed through; when nothing is, it is `null`.

**Test obligations / mutation round-trips.**
- **MR-31 (reachability check):** delete the unreachable-SHA branch ⇒ case (d) fails (the resumed
  walk errors or silently walks nothing).
- **MR-32 (inputsHash composition):** drop `EXTRACTOR_VERSION` from the `inputsHash` fold ⇒ **Step
  1's composition test fails** — the assertion that two input tuples differing only in the extractor
  version hash differently. Run the same round-trip for the other three ingredients (a grammar's
  binding hash, the `history:` + `include`/`exclude` subtree, the state schema version); each drops
  its own assertion and nothing else.
  **Case (e) is deliberately *not* named here, and the reason is worth keeping.** It edits the hash
  **stored** in `meta.json` and then compares whatever the run computes against that stored value,
  so the mismatch fires whatever the fold contains — the case passes under every one of these
  mutations. A composition claim can only be killed by a composition assertion, and case (e)'s job
  is the neighbouring one: to observe that the mismatch produced a **full walk** (its 25-commit
  figure), which no unit test on `decideWalkMode` can see either.
- **MR-33 (build lock, both halves):** stop acquiring the lock ⇒ this task's acceptance 4 fails,
  because the second run no longer refuses. Make `acquireBuildLock` refuse immediately instead of
  retrying until `waitMs` elapses ⇒ **T1's** wait-branch unit test fails (T1 acceptance 2: a holder
  that releases inside the window is acquired, not refused) — that is where the second half of
  §4.4's "wait briefly, then fail" is pinned, with an injected clock rather than against two real
  concurrent indexes.
- **MR-34 (windowing/resume interlock, D3):** allow resume while `maxCommits > 0` ⇒ a test that
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
`docs/roots.md:42-46`, `:48-51`, `:68-70`, `docs/configuration.md:372-373`, `:553-616`,
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
  how much history the last index read — the commit count, and **`historyStats.parsed` described as
  "revisions of your code read from history"**, never as a file count. **That wording is a
  correctness point, not a style point:** `parsed` is distinct non-skipped **cache keys** (D4) —
  blobs under a grammar — so on a repository where one file has 300 revisions it exceeds the file
  count by two orders of magnitude, and "distinct files parsed" would be a plainly wrong number
  wearing plain language. R4 tracks no per-file quantity `status` could print instead. Then: how far
  behind HEAD the index is (`git rev-list --count <lastIndexedSha>..HEAD`, failing soft to
  silence). **That `<lastIndexedSha>` is `meta.json`'s, read best-effort — never the model header's,
  even though the header now carries one too (T9).** Two copies exist from T9 on, and naming which
  one is read keeps this line aligned with both R4-I12 (the reader takes no lock, reads the replay
  state best-effort, and **omits the line entirely** when the state does not read cleanly — never an
  error, never a fabricated number) and T9's rule that the header field is `null` in every degraded
  mode. A `status` that read the header instead would print a behind-count for a repository whose
  history was never walked. It also reports whether the repository has no history or is a shallow
  clone and what that costs
  ("nothing is counted as established yet, so nothing is reported as a convention"), and whether
  history windowing is active (`v6-spec.md:599` requires this to be visible).
- [ ] **Step 2: `docs/roots.md`.** **Five** true-ups, each currently false or about to be:
  `:42-46`'s "nothing is inherited across runs" (now: incremental by default, `--full` forces the
  walk, a re-index parses only new code); `:48`'s "Exits with an error only for a genuine problem"
  (now: another index still holding the build lock when the wait window elapses is also a non-zero
  exit — describe it in the same plain terms, as refusing to write over a run already in progress,
  which is the reading R4-I9 gives it too); `:69`'s ledger row (`:68` is the seeds row, still true through R4) (now: marks, when they exist,
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
  **The worked `roots:` example just above that table (`:561-568`) needs the same pass, and it is
  the easier one to miss because it is code rather than prose.** It sets `history: windowMonths: 24`
  (`:564-565`), which at R4's defaults does **nothing at all** — `windowMonths` is only consulted
  while `history.full` is `false` (spec §13.1; `config-parser.ts:45-47`), and the default is
  `true`. Its second key is no better: `weights: seedDefaultWeight: 8` (`:566-567`) sets that key
  to its own parsed default (`config-parser.ts:73`), so **both** keys in the worked example are
  no-ops and the example teaches the opposite of what the row now says. Either swap them for keys
  that are live at the defaults, or set `full: false` beside `windowMonths` and say in one line
  what that costs.
  **The same inert example is shipped a second time, in a template adopters' agents read, and only
  one of the two copies is currently named anywhere in this plan.**
  `src/templates/knowledge/configuration.ts:92-93` carries the identical
  `history: windowMonths: 24` block — a knowledge template consumed in **every adopting
  repository** (AGENTS.md's product-scope rule), not a doc page. Fix both, against the source
  constant rather than the one you noticed first, exactly as this step's own instruction two
  paragraphs up already demands of the `.cache/` claim; acceptance 1 is widened below to cover the
  templates, since as written it covers only `docs/`. T10's verification rule — every claim checked
  against the built binary, not against this plan — is what catches it, so verify each example by
  running it.
  **Each example carries a sentence *describing* it, and rewriting the example falsifies the
  sentence — name both here so the pass does not stop at the code block.** In
  `docs/configuration.md`, the paragraph immediately after the block reads "the example above
  **sets two values** and leaves the other eighteen sections … at their defaults" (`:570-573`); in
  the template, the inline comment on the key itself reads "Example: **override one leaf**,
  everything else stays default" (`configuration.ts:93`). Adding `full: false` beside
  `windowMonths` — the second of the two options above — makes the first sentence say two where
  three is true and the second say one leaf where two is true. Update whichever of the two the
  chosen option falsifies, in the same diff as the block it describes; a code sample and its own
  caption disagreeing is exactly what the doc-consistency review reads.
- [ ] **Step 4: CHANGELOG** — the single entry drafted at T8 and amended at T9 is amended in place
  here a final time, never joined by a second one. One entry under `## [Unreleased]`, release-notes voice, describing
  the adopter-visible change: mined conventions are now weighted by how long code has stood and
  who wrote it; a re-index is incremental; `--full` exists and is the reference; `status` reports
  history and honestly says when a repository (or a shallow CI clone) has no established history.
  Not a work log: one entry for the increment, no per-task lines, no method notes.
- [ ] **Step 5: Dogfood measurement (report only).** Run the built binary against a *copy* of this
  repository with a temporary `roots:` block — cold and warm — and record: walk seconds, distinct
  blobs, ms/blob against §20.1's ≤ 15 ms budget, warm-run parse count, model size, and whether
  the mined field looks sane. **Report `meta.json`'s own size and its write time beside the model
  size**, since D1 states plainly that it grows with the history and is rewritten whole on every
  index with no pruning rule, and this is the first repository real enough to say what that costs.
  **Add one number D16 makes worth knowing:** the count of distinct
  blob shas that appear only as a record's *pre-image* and never as any record's post-image, as a
  fraction of all distinct blobs. The design argues that fraction is near zero on a full walk from
  the root (a pre-image is normally an earlier commit's post-image; only a merge's own conflict
  resolution escapes that), and this is the first repository real enough to check it on. If it is
  not a low single-digit percentage, report it as a finding — the blob-rate budget assumed
  otherwise. **Do not commit a `roots:` block, a `model.json`, or any cache into
  this repository** — enabling the dogfood is the maintainer's call (Open Question 2). Report the
  numbers.
- [ ] **Step 6: Docs build + markdownlint + graph ritual + report.** No digest regeneration:
  R4 edits neither `templates/rules.ts` nor `templates/digest.ts`, so the digest gate has nothing
  to re-run (state that in the report so the omission reads as scoped).

**Acceptance criteria.**
1. Every claim in `docs/roots.md` and `docs/configuration.md` — **and in
   `src/templates/knowledge/configuration.ts` and `onboarding.ts`, which ship into every adopting
   repository and are therefore in scope, not just `docs/`** — is verified against the built
   binary's actual behavior, not against this plan. That explicitly includes every worked `roots:`
   example: no example may set a key to its own default, in either the docs copy or the template
   copy.
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
which AGENTS.md's changelog rules forbid. Timing, since T8 **and T9** land adopter-visible behavior
in their own gated commits several commits ahead of T10: the entry is **drafted at T8**, the
first task whose commit changes what an adopter sees, **amended in place at T9** when the
incremental resume, `--full`, the build-lock refusal and "already current" land, and **amended in
place again at T10** when `status` and the docs land. **T9 needs its own amendment point and the
earlier phrasing gave it none** — naming T9 as adopter-visible and then routing the entry from T8
straight to T10 left T9's commit changing adopter-visible behavior with no changelog line, against
AGENTS.md's "every code or behavior change gets an entry … as part of normal work". Amending in
place is exactly what the one-entry rule already permits. That satisfies the rule at every commit
that makes a change, while keeping one entry per change. No second entry is ever added. The existing R1–R3 entry is left as it
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
  `PASS (1 warning)`? And for T8 specifically: does the report **name every weighted accumulation
  site together with the ordered source its order derives from**, and is each of those sources
  deterministic (R4-I16)? A `Set` or a `Map` built from an ordered array is not a finding — JS
  iterates both in insertion order, and the landed counting path is already correct — so the
  question is whether the *source* is ordered, never whether the container is a `Set`.
- **Plan perfection criterion:** two consecutive clean reviews of this document before execution
  starts, the same bar the previous increments used.
- **STOP conditions** (report, do not improvise): an architecture edit appears necessary; a golden
  fails a *structural* MUST-NOT-mine assertion after the weight change; a determinism case cannot
  be made to pass without weakening the assertion; a spec section contradicts a decision D1–D17
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
- **Fixed a mutation round-trip that would not have killed anything.** MR-19 was originally "move
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
- **Replaced the replay's ordering premise with an order-free construction (D16), after checking
  git rather than assuming it.** Two claims earlier drafts leaned on turned out to be false against
  real repositories: `--reverse --date-order` does not deliver ascending committer timestamps (its
  topological constraint outranks the date, so a linear chain dated day 60 → day 0 → day 121 walks
  in exactly that dipping order), and a resume range is a set difference rather than a suffix of the
  full walk (merging a branch started before the last index reorders it). Worse, a running
  `prevState[path]` map is wrong on *any* branched history whatever the order, since one of the two
  divergent commits is always compared against the other's blob. The fix is per-record: `--raw`
  already hands each file record its own pre-image blob sha, so a change is
  `signature(postSha) != signature(preSha)` with nothing carried, every lifecycle field is a set
  function with a stated `(ts, sha)` tie-break, and the alias closure, the appearance-cap demotion
  and the co-change cut all move to finish time. `prevstate.jsonl` disappears — the replay state is
  six files, not seven — and the resume-equals-full claim now holds by construction. MR-15 is the
  round-trip that kills any reintroduction of an ordering dependency, and T9's case (b) grew a
  merge-of-an-older-branch commit so the E2E cannot be satisfied by an order-dependent
  implementation.
- **Caught a lift that would have made D13 dead code.** T9's `bindingSetHash` lift was specified as
  "the same fold, behavior unchanged byte-for-byte". The landed fold *reads* a module-level binding
  cache that `parseAndExtractAll` fills earlier in the same call, so lifted verbatim and called cold
  — the only way the short-circuit can call it — it hashes `"{}"`, and the no-op short-circuit could
  never fire. T9 now dictates a cache-*warming* derivation and names the one real behavioural
  difference (parse-candidate set instead of actually-parsed set) rather than claiming there is
  none.
- **Moved `agentShare` and the `historyStats` assembly from the co-change task to the wiring task.**
  §18.4's share sums `base(s)`, whose one home is the weights module that lands a task later; under
  the strict task order the earlier task had no `base` to call and would have had to transcribe
  §9.1 a second time — the exact drift D7 forbids.
- **Stopped the blob cache from storing an answer it can recompute for free.** Two tasks gave
  opposite contracts for a blob whose path has no registered grammar: one keyed it with a sentinel
  and cached a skip record, the other never keyed it at all. The first would add one JSON file per
  distinct blob of every `NOTES.md`, `.png` and `yarn.lock` in the whole history to a cache budgeted
  for code. The path's extension answers it in memory; nothing is written.
- **Killed the `--max-count` claim the previous pass left standing, the same way D16 killed the two
  before it: by running git.** The plan said the cap takes "the newest N by committer date". It does
  not. `--max-count=N` truncates the *traversal*, and `--reverse` runs afterwards, so on the dipping
  day 60 → day 0 → day 121 chain `--reverse --date-order --max-count=2` returns day 0 and day 121
  and **drops the newer day 60**; on a merged branch older than the mainline tip it returns the tip
  and the *oldest* side commit rather than the two newest. That sentence was the only surviving
  justification for naming `--date-order` and for the `--topo-order` ban, and T2 Step 6 was about to
  write it into `git-history.ts`'s header as a stated contract. The flag ban now rests on the
  narrower true ground — a stated window beats an inherited one — and D3 is untouched.
- **Made `historyStats.parsed`/`mb` set functions of the cache *key*, not of a blob's first
  appearance.** Every empty file in a repository is one blob sha, so an empty `src/foo.ts` and an
  empty `NOTES.md` are the same sha with opposite extraction verdicts, and "first appearance
  decides" made a model-visible field depend on which path the walk handed over first — precisely
  the residue D16 exists to remove, surviving on the one field nobody re-checked. `meta.json` now
  carries two rosters, the `history/` golden carries the collision by construction, and MR-28 kills
  both halves.
- **Decided `historyStats.events`, which was defined two incompatible ways at once** — "produced by
  the replay" against "a running sum" — on any repository with a file touched in more than 200
  commits, since `finishReplay`'s appearance-cap demotion drops events a previous run's sum already
  counted. It is the raw, pre-demotion count, because that is the only one a running sum can carry.
- **Wrote down where §6.8's exclusions bind a *historical* path (D17), which no authority states and
  three tasks were each about to guess.** Without it every revision of `dist/`, `vendor/`,
  `node_modules/` and `*.d.ts` would be keyed, fetched, parsed and cached, and co-change would
  couple build output to everything beside it. Two gates, applied once each — `forMarkers` in the
  join, `forParsing` ∧ grammar in the blob reader — with §6.8's test-file carve-out landing exactly
  where the spec puts it.
- **Stopped the probe-then-fetch protocol from spawning one `git cat-file --batch` child per
  commit.** Per-commit probing plus one-child-per-call is one process spawn per non-merge commit,
  against §13.2's "a single child" and the budget §20.1 sets on it. T2 now exports a reusable
  `BlobReader` handle opened once for the whole walk, and T8 buffers commits into a window before
  probing — which is only safe because D16 made order within the window irrelevant, the first place
  that decision pays in throughput rather than in correctness.
- **Gave the shared branch-and-merge fixture an owner.** Five acceptance criteria across three
  tasks were written against "the helper T2's merge case uses", and no Files list created one; T2's
  capture lives inside a unit test file no e2e suite may reach, and T3 had explicitly declined the
  shape. T3 now owns `tests/support/branch-merge-fixture.ts`, T2's capture is stated as
  deliberately local, and every citing site names the helper.
- **Caught a premise error that had propagated into stated values: `extractUnits` appends one
  `file` scope to *every* parsed file, unconditionally, so "zero scopes" is unreachable.** The
  extractor's own header note says so in as many words (`extract.ts:396-397`, §6.3's "exactly one
  per file"), and `parseAndExtractAll` has no empty-file short-circuit — so a `BlobScopeRecord`
  can never carry `scopes: []`, not for an empty file and not for a totally garbled one. T4's
  acceptance 9 was asserting exactly that literal, which would have failed against a correct
  extractor and made "special-case empty files in `extractUnits`" the tempting fix — a real
  regression. Four stated counts on the `history/` golden's page were short by their files' file
  scopes (the day-20 cohort 10 → 20, item 4's 12 → 15, item 12's 2–3 → 3–4 — since pinned to
  exactly three `method` scopes plus the file scope, i.e. **4**, by the entry below — and the
  placeholder pair's "no scopes" → one), and D4's rationale was arguing from a case that cannot
  happen. No weight moves — every extra file scope lands in the same population as its named
  siblings — but hand-derivability, which this page claims for every number on it, did. The rule is
  now stated once where the golden's arithmetic is introduced.
- **Said which of a rename record's two paths gate 1 reads, which D17 had left to be guessed one
  level below the guessing it was written to end.** `forMarkers` takes one `relPath`; an `R`/`C`
  record carries two, and their verdicts genuinely differ in both directions (`git mv src/a.ts
  vendor/a.ts` and `git mv dist/a.js src/a.js` — verified on git 2.43.0). Because the gate is
  applied once and four consumers read the result, the unstated choice moved the changed-file band,
  the pair counts, the `blobs` roster and the **alias edge** at once. The gate-1 path is now the
  **post-image** (`newPath ?? path`, `path` for `D`), a rename into an excluded prefix is dropped
  whole, one out of one survives with its pre-image answered by gate 2, and MR-30 grew the mutation
  that kills the other reading. T8 acceptance 10's rename half also had to edit the moved file's
  body, since a *pure* `git mv` emits `R100` with **identical** pre- and post-image shas (verified)
  and "the sha does not enter `blobs`" would have asserted nothing.
- **Removed two criteria that could not pass in the task that owned them.** T3's acceptance 7
  called `buildBranchMergeFixture()` with no options — i.e. the default `trailingMainCommit: true`,
  i.e. HEAD is `main2` — and asserted "HEAD is the merge" in the same sentence; it is now split
  along the helper's two variants, and every citing site names which one it drives. T5's
  acceptance 10 asserted `historyStats.commits` and `blobs`, neither of which exists anywhere in
  T5's `ReplayResult`; that half moved to T8 acceptance 10, which is where the numbers live, and
  its `dist/bundle.js` clause was deleted outright because gate 1 means the replay is never handed
  such a record.
- **Made the buffered window's flush trigger computable, and gave `historyStats`' second mutant a
  fixture.** The window was to flush when "the pending **miss** set reaches 400", but misses are
  knowable only after the probe — so the probe moved to append time, where the pending set is
  partitioned as it grows. And MR-28's sha-keyed mutant came in two shapes, only one of which the
  placeholder pair kills: a sha-keyed roster restricted to *keyed* records never sees the `.md`
  verdict. The day-0 seed now carries a second same-blob pair, `src/stub/same.ts` /
  `src/stub/same.py` under two grammars, so acceptance 8 kills both.
- **Pinned the day-395 cohort's *kind* as well as its count, because a fact's `counts` can never
  span two scope kinds.** T8 acceptance 2's antecedent pin stated the cohort moves `counts` by
  "3–4 × 0.05" — the file's named-body scopes *plus* its mandatory `file` scope. But cells, and
  therefore facts, are partitioned by kind (`CELL_KINDS`, `mine-stages.ts:371`; the three cell
  constructions at `mine.ts:290`, `:329`, `:356` each build per kind), so the `file` scope sits in
  the `file`-kind cell and can never share a fact with the named-body scopes: a `method`-kind fact
  moves by *its* kind's members alone. An implementer hand-deriving `counts[expected]` with four
  nickels folded in would have written a red test against correct code — the failure mode round 7
  was removing one level up. T3 item 12 now pins **three `method` scopes plus one `file` scope**,
  the delta is `3 × 0.05`, the criterion picks an `_all`/`dir` `method` cell (a role cell would
  halve an ambiguous member through `roleWeightOf`, `mine.ts:326`, giving 0.025), and both halves
  of the criterion now read one population — the cohort's members of *this* cell.
- **Re-dated T7's floor row so MR-20 kills something.** At the row's old −5 d, `5/120 × 0.5` and
  `5/120` both floor to `baseFloor` 0.05, so deleting the fresh-penalty factor left the row's
  derivation test green and the factor shipped with no killer anywhere (R4-I15). The factor is
  observable only for `stable_days ∈ (6, 12]` with `age_days < 14`; at **−10 d** the two readings
  are 0.05 and 0.083333. Same defect class as the MR-19 entry above, found on the row beside it.
- **Gave MR-32 a killer and case (e) an observable, which turned out to be two different problems.**
  MR-32 named case (e) as its killer, but that case hand-edits the `inputsHash` **stored** in
  `meta.json` and compares whatever the run computes against it — the mismatch fires whatever the
  fold contains, so dropping `EXTRACTOR_VERSION` from the fold left every clause green. A
  composition claim needs a composition assertion, so T9 Step 1 now dictates one per ingredient and
  MR-32 names *that*. Separately, case (e) could not see its own subject: the state's
  `lastIndexedSha` is HEAD, so a wrongly-resumed run walks an empty range, re-emits `historyStats`
  from state and writes byte-identical bytes. It now asserts the run summary's commits-walked
  figure equals the golden's 25, which is what makes "full walk" an assertion rather than a title.
- **Widened `readHead` to return the committer timestamp in both representations.** T8's
  `HistoryJoin` declares `clockIso`, T2 declared `readHead` returning epoch seconds only, and
  `git-history.ts` is not on T8's Files list — so the ISO string had no legal source, and deriving
  it from `clockTs` would not reproduce the header's `%cI` form (`'…+00:00'`, pinned at
  `tests/unit/cli/roots.test.ts:178`). The "single call" claim is softened to the true one: one
  helper pair, with `cli/roots.ts:376` still reading HEAD itself for the header.
- Verified every code anchor cited here against the tree (`pipeline.ts:161`, `mine.ts:75/171/854`,
  `mine-stages.ts:189`, `stores.ts:143/211/239`, `cli/roots.ts:170/208/332`, `utils/git.ts:81-142`,
  `extract.ts:185/399`, `enumerate.ts:58`, `roles.ts:497`) and every pin R4 moves
  (`cli-roots-basic.test.ts:64`, `:104-116`, `unit/cli/roots.test.ts:177-226`,
  `mine.test.ts:471-477`, `golden-controls.test.ts:191-213`).
