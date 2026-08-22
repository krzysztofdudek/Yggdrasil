# Increment 4 — R5: Verdict, Speech & Telemetry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land R5 in full — the layer that makes everything R1–R4 mined actually *speak* to an
agent. After this increment `yg roots check` exists: it re-parses an edited file, resolves the
scopes it contains against the committed snapshot, decides which single convention governs each
(scope, surface), measures the preference gap, filters by channel, renders a contrastive message in
plain product English with real exemplars, budgets and deduplicates what it says, records the
intervention, notices when the agent complied, writes the echo-defense mark, and demotes a
convention agents keep ignoring. Nothing gates CI, nothing blocks an edit, nothing is promoted, and
no rule is armed to deny — those are R6–R8.

**Architecture:** Five new pure engine modules under `source/cli/src/roots/`
(`verdict.ts`, `speech.ts`, `session-state.ts`, `health.ts`, `exemplars.ts`), four new persistence
modules under `source/cli/src/io/` for the gitignored `.state/` triad plus incidents
(`roots-session-store.ts`, `roots-telemetry-store.ts`, `roots-demotions-store.ts`,
`roots-incidents-store.ts`), one new command file `source/cli/src/cli/roots-check.ts`, a ledger
*append* added to the existing `source/cli/src/roots/stores.ts`, and three additive fields (plus a
store-version bump) in the committed snapshot body produced by `source/cli/src/roots/mine.ts` and
`source/cli/src/roots/history-cochange.ts`. The engine stays pure: every
side effect the verdict path implies is returned as data and applied by the command layer (D1).

**Tech Stack:** TypeScript, `web-tree-sitter` via the CLI's existing parser pool
(`src/ast/parser.ts` — no second loader), `node:child_process` for git through the existing
`utils/git.ts` / `utils/git-history.ts` helpers, vitest, spawned `dist/bin.js` E2E, the golden git
repositories R4 landed (`tests/support/git-fixture.ts` + `tests/support/roots-golden.ts`).

**Spec:** R5 as quoted verbatim below; spec §9.10 (`v6-spec.md:447-481`), §9.7 (`:439`), §9.9
(`:445`), §9.11 (`:483-484`), §10 (`:488-501`), §11 in full (`:503-556`), §12 (`:558-594`), §13.5's
completeness clause (`:621-625`), §18 (`:679-687`), §19's `check` row (`:698`), §20.1 (`:712`),
§21.1–§21.2 (`:718-720`), §22 (`:725-739`), Appendix A (`:770-817`), Appendix D (`:861-897`),
Appendix E.1/E.2/E.6/E.7 (`:905`, `:907`, `:920`, `:922`), Appendix G.4 (`:1020`); design §3's command table
(`integration-design.md:80`), §4's storage (`:122-165`), §8 (`:310-363`), §9's DENY boundary
(`:365-383`), §10's config rule (`:386-408`), §11's naming table (`:410-426`), §12's productionized
rows (`:428-478`), §13's testing law (`:479-517`).
**Every implementer reads, in full, the spec and design sections their task cites before writing
code.** This plan dictates structure, seams, signatures, decisions and test shapes; it defers
formulas to the sections it cites rather than re-transcribing them — a transcription is a second
copy that can drift.

### R5, verbatim (`plugin-marketplace-plan.md:84-92`)

> **R5 — Verdict, speech, telemetry (design §3, §8.3, §12; spec §9.10, §11, §18)**
> Specificity governance (role < dir < `_all`, smallest evidence class), Δ gates with calibrated
> τ_c override, channel table (DENY passes only on `pre`; downgrade-never-upgrade elsewhere),
> severity, novelty capped at WARN, verbalizer with locality labels + contrast line, budgets
> (3/response, 12 WARN/session), WARN-only dedup, compliance closure (complied → ledger mark;
> ignored once per session), health demotion (Wilson LB, expected-flip filter — telemetry carries
> expected/observed/Δ), sessions as **append-only event logs** (productionized), incidents FIFO 500,
> fail-open on the hook path with harness rethrow. Naming table (design §11) binds all rendered
> output; agent messages keep the three-beat deviation → evidence+scope → exemplar shape.

Two clauses of that paragraph are **not** buildable in R5 and are handled honestly rather than
faked: "Δ gates with calibrated τ_c override" — calibration is R6, so the override path reads the
snapshot's persisted `tau` and there is nothing to override yet (D7); and the channel table's DENY
row, which lands complete and is unreachable because no fact can be DENY-eligible before
calibration exists (D9, design `:365-383`). Neither is a descope: the mechanism ships, its input
arrives in R6.

One clause is **added** to R5 by the previous increment's own written assignment: the Stop-channel
completeness sweep (`v6-spec.md:625`), which R4's plan states plainly is "R5's — R4 produces the
pairs it will read" (`2026-08-20-increment-3-r4-history.md:2320-2321`). D20 records why it belongs
here and nowhere else.

---

## Maintainer authorization (status: none expected, with one escalation path and one naming trap)

**No `.yggdrasil/yg-architecture.yaml` edit is expected in this increment.** Every file R5 adds
classifies under an existing node type by an existing `when:` predicate, and every import it needs
is already on an existing type's relation allow-list. Verified at HEAD (a761dda):

| New file | Classified by | Allowed because |
| --- | --- | --- |
| `src/roots/verdict.ts`, `speech.ts`, `session-state.ts`, `health.ts`, `exemplars.ts` | `roots-engine` — `when: all_of[path "source/cli/src/roots/*.ts", not stores.ts, not *.test.ts]` (`yg-architecture.yaml:742-748`) | roots-engine `calls: [roots-engine, ast-adapter, persistence-adapter, utility]`, `uses: [types]` (`:759-760`) — every import these five need (other roots modules, `ast/parser.ts`, `utils/*`, `model/graph.ts` types) is on that list. They import **no** persistence adapter at all under D1. |
| `src/io/roots-session-store.ts`, `roots-telemetry-store.ts`, `roots-demotions-store.ts`, `roots-incidents-store.ts` | `persistence-adapter` — `when: any_of[... path "source/cli/src/io/*-store.ts" ...]` (`:183`) | **Inbound:** `command` → persistence-adapter and roots-engine → persistence-adapter are both allowed `calls` edges (`:61`, `:759`). **Outbound is the tighter half and the one that dictates their signatures:** persistence-adapter's own list is `calls: [persistence-adapter, utility]`, `uses: [types]`, `default: deny` (`:206-209`) — **`roots-store` is absent**, so none of these four may import `rootsStateDir`/`STATE_DIRNAME` from `src/roots/stores.ts`. They take an absolute `stateDir: string` instead (T1's contract), exactly as `roots-blob-cache.ts` takes `cacheDir` and `roots-history-store.ts` takes `dir`. They may reach `io/atomic-write.ts`, `io/read-or-default.ts`, `io/debug-log-writer.ts`, `io/hash.ts` and `src/utils/*`, which is everything they need. |
| `src/cli/roots-check.ts` | `command` — `when: all_of[path "source/cli/src/cli/*.ts", not *.test.ts, content "export\s+function\s+register[A-Z]\w*Command\("]` (`:43-48`) | `command` `calls:` includes both `roots-engine` and `roots-store` (`:61`) — the only type in the tree that may reach both. |

**The `command` / `command-support` split is the load-bearing trap of this increment, and it is a
one-character-class difference in a regex.** A file under `src/cli/` that does **not** export a
`register<Pascal>Command` function classifies as `command-support` (`:68-74`), whose `calls:` list
is `[engine, parser-adapter, persistence-adapter, formatter, utility, llm-shared, template,
command-support]` (`:82`) — **`roots-engine` and `roots-store` are absent**. A helper file named
`roots-check.ts` that merely exported `runRootsCheck()` would therefore become a blocking
relation finding the moment it imported `roots/verdict.ts`, and would force an architecture edit
this increment is not authorized to make. `src/cli/roots-check.ts` MUST export exactly one
`registerRootsCheckCommand(rootsCommand: Command): void` — exactly one, because
`command-contract-shape`'s check refuses zero and refuses two or more
(`.yggdrasil/aspects/command-contract-shape/check.mjs:46-62`).

**Two more consequences of that classification, both mechanical:**
- `command` carries `sibling-test-file`, whose check demands a test file whose basename matches the
  command file's stem under the `cli/tests/unit/cli` node
  (`.yggdrasil/aspects/sibling-test-file/check.mjs:6-31`). So
  `source/cli/tests/unit/cli/roots-check.test.ts` is **required**, not optional, and the new
  command node must carry `uses: cli/tests/unit/cli`.
- `command` carries **seven** aspects (`yg-architecture.yaml:49-56`): `source-no-raw-control-chars`
  (`status: enforced`, and it does bind), `cli-command-contract`, `diagnostic-logging`,
  `command-contract-shape`, `source-hygiene`, `command-error-via-buildissuemessage` and
  `sibling-test-file`. Read all seven before writing the file.

**Graph nodes this increment creates (design-locked in T1, before any code):**
- `model/cli/roots/speech/yg-node.yaml` — type `roots-engine`, mapping the five new engine files.
  A sibling of the existing `roots/engine` node rather than an extension of it: `roots/engine`'s
  `description:` is already the longest in the graph, and one more subsystem inside it would make
  that node's own review prompt the repo's tightest. (Graph-node `description:` text is excluded
  from the assembled reviewer prompt — `src/llm/prompt.ts:179-181` — so this is a
  *reviewability* argument about the node's own aspect surface and mapping size, not a prompt-size
  one; state it that way in the node.)
- `model/cli/io/roots-state/yg-node.yaml` — type `persistence-adapter`, mapping the four new
  `src/io/roots-*-store.ts` files, mirroring `io/roots-cache`'s own stated "three files of one
  subsystem in one node … to keep the fan-out leaderboard still"
  (`.yggdrasil/model/cli/io/roots-cache/yg-node.yaml:12-14`).
- `model/cli/commands/roots-check/yg-node.yaml` — type `command`, mapping `src/cli/roots-check.ts`.
  A node of its own, not an extension of `commands/roots`: `sibling-test-file`'s check reads
  `ctx.node.files[0]` (`check.mjs:3`) and would only ever test the first mapped file, so two
  command files in one node would silently leave the second unpinned. **The registrar is called
  from `cli/roots.ts`, not from `cli/entry`** — so the new command edge lands on
  `cli/commands/roots` (ten relations today) and `cli/entry` stays at the **23** the fan-out
  leaderboard pins it at (`tests/integration/portal-derive-rest.test.ts:74-75`). Registering it
  from `entry` instead would take `entry` to 24 and rewrite the leaderboard's top three; that is
  the concrete reason for the call site, not a preference.
- `model/cli/tests/e2e/roots-verdict/yg-node.yaml` — **one new e2e node mapping all eight new
  `tests/e2e/cli-roots-*.test.ts` files** of this increment. One node, not eight: multi-file e2e
  nodes are already the norm here (`tests/e2e/check-validation` maps six,
  `relation-conformance-scripting` and `attention-dump` five each), and eight single-file nodes
  would add eight new fan-out sources for no reviewability gain.
- **Every new unit-test file joins an existing node, and none creates one.** The ~14 new
  `tests/unit/roots/*.test.ts` files (engine and store alike) join `cli/tests/unit/roots`, which
  already maps R4's store tests by the same convention. `tests/unit/cli/roots-check.test.ts` joins
  the existing `cli/tests/unit/cli/roots` node — `sibling-test-file`'s `collectTestFiles` recurses
  the children of `cli/tests/unit/cli` (`check.mjs:35-41`), so a file mapped there satisfies the
  check without a node of its own, and the leaderboard does not move. **`unmapped-files` is a
  blocking finding under `coverage.required: ["/"]` (`.yggdrasil/yg-config.yaml:8`)**, so a new file
  landing in no node fails the gate in whichever task first adds it — which is why the ownership is
  fixed here, once, rather than per task.

**Escalation path (Task 1, Step 1).** If the Task-1 verification finds any of the above false — a
predicate that does not admit a new file, a relation the allow-list denies, an aspect whose own
`when:` makes it inert or newly binding, a `max_direct_relations` ceiling crossed by the new
nodes' edges — the implementer **STOPS and reports** with the exact minimal `yg-architecture.yaml`
block that would fix it. Architecture edits are user-gated: the controller presents the block to
the maintainer for explicit approval before any execution continues. No task in this plan may edit
`yg-architecture.yaml` on its own initiative.

The standing invariants hold throughout: no `review_by` changes, no `yg-suppress` markers, no
fabricated incidents, no hand-edited lock files, no graph mutation from roots (I10).

---

## Increment-wide invariants (R5-I1 … R5-I18)

Every task's reviewer checks these. Each names the test family that pins it (task in parentheses).

- **R5-I1 — Roots never gates CI.** `yg roots check` exits **0 on every verdict outcome** — on
  findings, on a malformed model, on an internal throw, on a path outside the repo, on a dormant
  project (`integration-design.md:80`; program plan `:270-271`). No `--exit-code` flag exists on
  `check`; the spec's exit-4 is deliberately not ported (`integration-design.md:470-478`).
  **The one carve-out, stated here so no task has to invent it:** a *usage* error — mutually
  exclusive or malformed arguments, before any evaluation happens — exits **1** with a
  what/why/next message on stderr, because `cli-command-contract` requires exactly that of
  option-mutex violations and because refusing to run is not a verdict about anyone's code. The
  boundary is mechanical: once the command has begun resolving files against the snapshot, every
  exit is 0. `yg check`, `yg context` and `yg build-context` output does not change by a single
  byte in this increment. *(T3, T5, every task's dormancy pin)*
- **R5-I2 — One fail-open boundary, one exception.** The whole verdict entry point is wrapped in a
  single catch that returns zero findings plus exactly one incident record — not per-stage catches
  (`v6-spec.md:719`: a parse failure, a missing grammar, a corrupt session file and a malformed
  model row all exit through the same catch). The **one** exception is the test/mutation harness
  path, which rethrows, because a harness that fails open converts every crash into a "no findings"
  pass. One boundary, two modes, selected by an explicit function option — never an environment
  variable (D18). *(T5)*
- **R5-I3 — Downgrade or silence, never upgrade (I2b).** Every machine-local modulator may lower
  severity or suppress; none may raise it (`v6-spec.md:81`). The complete modulator table for R5:
  (1) session dedup + budgets; (2) telemetry demotion via `demotions.json`; (3) staleness; (4)
  bash-sweep `seedTruncated` / `floodSkipped`. Modulator (4) of the spec's list — daemon-absent —
  is permanently active in this product (there is no daemon, `integration-design.md:373-379`) and
  is therefore folded into the channel table itself rather than being a live switch. `status` lists
  every active modulator (T10). *(T6, T9, T10)*
- **R5-I4 — Engine purity.** `verdict.ts`, `speech.ts`, `session-state.ts`, `health.ts` and
  `exemplars.ts` contain no `node:fs`, no `console.*`, no `Date.now()`, no `process.env`, no
  `process.stdout`. Every clock reading, session identity, file read and file append is a parameter
  supplied by the command layer, and every side effect is *returned as data* (D1). This is not a
  style preference: `roots-engine` carries `deterministic`, `no-direct-fs` and `no-direct-console`
  (`yg-architecture.yaml:749-755`), and all three refuse the alternative. *(T3–T8)*
- **R5-I5 — Model determinism survives (I2a).** The three snapshot fields R5 adds (`exemplars`,
  `partitionRouting`, and the co-change rows' `commitsA`/`commitsB`) are total functions of inputs
  the snapshot already fixes, ordered by a stated total order, carrying no wall clock. Two `index --full` runs remain byte-identical, and an
  incremental index still equals a full one. *(T2)*
- **R5-I6 — Hook-time enumeration ≡ index-time enumeration.** For identical file content, the
  surfaces the check path computes for a scope equal, value for value, the surfaces the index
  computed for that same scope — same `stableId`, same `skeyR`, same domain membership. This is the
  hinge the whole increment hangs from: if it fails, every verdict is measured against a value the
  index never recorded. It is pinned by an explicit equivalence test over a golden fixture, not
  assumed from shared code. *(T3)*
- **R5-I7 — Config verbatim.** R5 invents **no** config key. Every threshold it reads already
  exists in `DEFAULT_ROOTS` (`src/io/config-parser.ts:41-140`) with the spec's own default; the
  parser is where a default is checkable. The keys R5 newly *consumes* are named in D23. No graph
  schema version moves (AGENTS.md's two-version rule): the roots store carries its own
  `ROOTS_VERSION`, which **does** move (1 → 2, D3) precisely because the roots store's own format
  changed — while the graph's did not. That is the two-version rule working, not an exception to
  it, and no migration under `migrations/` is written because a derived snapshot's only correct
  migration is regeneration. *(T1, T2, T3, T6, T8, T9)*
- **R5-I8 — One new committed file written, and only one.** R5 writes exactly one committed file
  that R4 did not: appended marks in `.yggdrasil/roots/ledger.jsonl` (`v6-spec.md:685` — committed
  on purpose, so regulation binds every machine and CI). *(The committed `model.json` also changes
  — T2 adds three fields to its body and D3 bumps its version — but that is the same file R4
  already wrote, regenerated; this invariant is about the set of committed paths roots touches, and
  that set grows by exactly one.)* Everything else R5 writes lives under
  `.yggdrasil/roots/.state/`, is gitignored, and is safe to delete at any moment. No graph node, no
  `yg-architecture.yaml`, no lock file, no aspect (I10). *(T1, T7)*
- **R5-I9 — One ordering and truncation authority.** §11.3 (`v6-spec.md:551`) is the *only* place
  that orders or truncates output. Every earlier stage emits in its own stated deterministic input
  order and truncates nothing; every later stage preserves what §11.3 produced. A second `.slice()`
  or `.sort()` on findings anywhere else is a defect. *(T6)*
- **R5-I10 — Speech is gated; inquiry is not.** No value that failed an acceptance, eligibility or
  demotion gate may reach the check path under any flag (`integration-design.md:358-363`). R5 ships
  no inquiry surface at all, so this invariant is a *fence*: it forbids adding one here.
  *(every task)*
- **R5-I11 — Every load-bearing rule has a killer test.** For each rule this plan names as
  load-bearing there is a test that FAILS when the rule alone is deleted, and the implementer
  demonstrates that by actually deleting it, running the test, and restoring (the live mutation
  round-trips MR-1…MR-34, named per task). A rule with no killer test is not done. *(every task)*
- **R5-I12 — Every functional change lands with an end-to-end test.** AGENTS.md's standing rule
  (`AGENTS.md:101`): the test drives the complete user flow through the public surface — spawn the
  built `bin.js`, act as an adopter would, assert the flow's observable outcome (stdout, exit code,
  and the committed/derived files on disk). Unit tests alone are insufficient evidence. Each task
  below names its e2e file and the flow it drives; the two tasks with no adopter-visible flow
  (T1, T11) say so explicitly and name the task whose e2e covers their contracts. E2E files import
  nothing from `src/**` (`e2e-public-surface`). *(every task)*
- **R5-I13 — Compliance accounting never double-counts.** Every append is idempotent under its own
  key; the `ignored` branch fires at most once per session per intervention (`v6-spec.md:479` —
  without that bound the harness's own re-checks demoted a 96 %-share convention mid-run); and the
  write order is chosen so a torn write biases toward *under*-recording, never toward demoting a
  healthy convention (D14). *(T7, T8)*
- **R5-I14 — No internal vocabulary in user-facing output.** Design §11's table
  (`integration-design.md:410-426`) binds every rendered string: no `FACT`, no `pid`, no `surface`,
  no `factKey`, no `roleKey`, no `Δ`, no `τ`, no "hook_shaped", no "partition `_all`". Numbers that
  are *evidence* (N of M established, share) stay. Cell keys, enumerator ids and thresholds appear
  only in `yg roots explain` — which is R7's, so in R5 they appear **nowhere** in stdout, and in
  `debugWrite` lines only. *(T4, T10)*
- **R5-I15 — Degrade, never abort; symmetric across reads and writes.** A corrupt session file, an
  unreadable `demotions.json`, a missing grammar, a file that will not parse, an `EACCES` on a
  `.state/` append — each is one `debugWrite` line and a continued run
  (`v6-spec.md:719`; R4-I10). Derived state may be lost; the product may never be lost silently,
  and no degradation may ever *increase* what roots says. *(T1, T5, T6)*
- **R5-I16 — No new repo-check step.** The 17-step list in AGENTS.md is untouched; everything
  enters through the existing typecheck/lint/build/test/coverage/graph steps
  (`integration-design.md:513-517`). Latency budgets (`v6-spec.md:586`, `:712`) are measured by
  hand at T11 and reported, never gated — a timing assertion in the commit gate is flaky by
  construction. *(T11)*
- **R5-I17 — Dormant without config, silent without evidence.** A project with no `roots:` block
  gets zero runtime change: `yg roots check` prints nothing and exits 0. A project with a block but
  no snapshot, or a snapshot in which nothing is hook-eligible (the J4 case — a young repo, a
  shallow clone, no git at all), is *silent*, and `status` explains why (`v6-spec.md:409`,
  `:697`). Silence is a designed outcome, never an error. *(T3, T10)*
- **R5-I18 — Speech never re-enters the model through the back door.** Nothing the check path
  writes may change what the *current* snapshot says. The ledger mark it appends is read by the
  **next** `index`, by design (`v6-spec.md:685`); telemetry and demotions are local modulators that
  are never folded into any verdict hash. A check run that changed the model in place would make
  the echo defense a feedback loop instead of a brake. *(T7, T8)*

---

## Global constraints

- **Additive to every existing surface.** No `yg check` / `yg context` / `yg build-context` output
  changes byte-for-byte; the Increment-1 guard suites and the dormancy pin
  (`tests/unit/roots/dormancy.test.ts`) pass unchanged in every task. Build first
  (`cd source/cli && npm run build`) before any dist-spawning suite — a
  `describe.skipIf(!distExists)` skip is NOT a pass.
- **Dormant without config.** R5 adds no new unconditional surface. The gitignore entries
  `roots/.cache/` and `roots/.state/` are already in the managed list
  (`src/cli/init-scaffold.ts:143`, `:147`) — **verify that in T1, do not assume it**; `.state/`
  goes live for the first time in this increment and a missing entry would commit local telemetry.
- **Coverage.** `src/roots/**`, `src/io/**`, `src/cli/**` are all coverage-measured against the
  ≥ 90 % gate. Spawned E2E contributes **no** coverage — every new module needs in-process unit
  tests as well as its e2e. Degraded and error branches are the ones that go uncovered: make them
  reachable by parameter injection (an injected clock, an injected session id, an injected reader),
  which D1's seam already gives you for free everywhere in the engine.
- **Prompt-ceiling discipline.** The per-file LLM review runs on every roots-engine, command and
  persistence-adapter file, and the reviewer prompt ceiling is `max_prompt_chars: 72000`
  (`.yggdrasil/yg-config.yaml:43`). Measured live at a761dda with `node scripts/prompt-headroom.mjs`
  (1198 LLM pairs, one tier): the three tightest assembled prompts are
  `tests/unit/core/fill-det.test.ts` **657** chars of margin, `tests/unit/roots/roles.test.ts`
  **660**, and `src/core/advise-nominations.ts` **849**. Those three **must not grow by a single
  character.** Neither `src/roots/roles.ts` (**54 401** bytes) nor `src/roots/mine.ts` (**55 576**
  bytes — the *larger* of the two, and therefore the one whose assembled prompts are plausibly the
  tighter; an earlier draft of this plan said 49.6 k and had the risk ordering backwards) appears
  among the three tightest, so each has more than 849 chars of margin — but neither exact figure is
  known. **So T2 measures both files' real margins BEFORE editing either** (`node
  scripts/prompt-headroom.mjs` from repo root, reading the per-file numbers), applies the same
  discipline to both — D4's `m1` field in `roles.ts` and T2's three edits in `mine.ts`, each capped at
  ~30 lines — and re-measures immediately after. If either file's pre-edit margin is under 2000
  chars, its edit moves to a new sibling module instead (D4 already names that fallback for
  `roles.ts`; T2 Step 2 names the equivalent for `mine.ts`: the exemplar and routing stages are
  already separate functions in `exemplars.ts` and can be *called* from `mine.ts` in two lines
  rather than inlined). Everything else goes in new files; every new test goes in a new sibling
  file; split before crowding the ceiling, never after. (Graph-node `description:` growth is not a prompt risk — `src/llm/prompt.ts:179-181`
  excludes it from the assembled prompt.)
- **Aspect reviewers refuse, up front.** Before writing code, read the aspects binding your file's
  type. Beyond the seven `command` aspects named in the authorization section, three bind every new
  `src/io/` file (`yg-architecture.yaml:197-203`): `read-or-default-via-helper` (an inline
  ENOENT-swallow around the **async** `readFile` must instead go through `readFileOrDefault` —
  that is the aspect's actual, narrower scope, `check.mjs:37-46`, not a blanket ban on try/catch),
  `atomic-write-contract` (**no `writeFile` / `writeFileSync` / `appendFile` / `appendFileSync` /
  `createWriteStream` imported from `node:fs` in any `src/io/*.ts`** — the JSONL appends of this
  increment route through `io/debug-log-writer.ts`'s `appendToDebugLog(filePath, text)`, the
  repository's existing single-write chokepoint for exactly this shape, already used by the
  committed advise register and the incident ledger), and `silent-missing-files` (an LLM aspect,
  judged per file). `roots-engine` additionally carries `deterministic` and `no-direct-console`.

  **And one ESLint rule, not an aspect, judges every file R5 adds under `src/roots/`:**
  `local/roots-genericity-fence` (`source/cli/eslint.config.js:14-136`), which refuses three things
  — an import outside the allowlist `src/roots/`, `src/ast/`, `src/utils/`, `src/io/`, `src/model/`
  and `node:` builtins; a direct grammar-package or `.wasm` import; and **a switch on a per-language
  file-extension literal**. It matters more in this increment than in any before it: `speech.ts` is
  the most string-heavy file R5 adds and the likeliest place for a concrete framework or decorator
  name to appear as an example or a default, and `verdict.ts`/`exemplars.ts` are the likeliest to
  want a path-or-extension branch. Neither is allowed. Satisfy them all by construction, not by
  retrofit.
- **Graph ritual, every task.** New source and test files join their owning node's `mapping:`; new
  import edges between mapped nodes get declared relations; watch `max_direct_relations` ceilings
  and the fan-out leaderboard pin in `tests/integration/portal-derive-rest.test.ts` (it pins **six**
  paths with exact counts — 32 / 25 / 24 / 23 / 23 / 23 at `:69-80` — plus a separate bounded lookup
  for `cli/commands/aspect-test`, a descending-order loop, the `it` title and a narrative comment;
  any movement means updating the whole set coherently. The three-way tie at 23 includes
  `cli/entry`, which is why this increment registers its new command from `cli/roots.ts` rather than
  from `entry` — see the authorization section). `log_required: true` sits on
  `roots-engine`, `roots-store`, `persistence-adapter`, `command` and more, so every task whose diff
  touches a log-gated node's mapped files or mappings adds `yg log add --node <id>` with
  self-contained WHY prose (no references to plans, tasks, steps or file paths).
  `node source/cli/dist/bin.js check --approve` from repo root must end **PASS with zero warnings**
  — that is the state the branch reached at a761dda and this increment does not spend it.
- **Comment discipline.** `self-contained-references` binds every roots node and every test node
  via `source-hygiene`: no "this task", "a later task", "the plan", no step or task codes in
  comments or test names. A spec-section citation (`§9.10`) is fine as a *pointer beside* a rule
  stated in full, never as the rule itself. **Plain `yg check` never runs deterministic checkers**,
  so this refusal only appears at `--approve` time — run
  `node source/cli/dist/bin.js check --approve --only-deterministic` before declaring a task done.
- **No new repo-check steps** (R5-I16).
- **Environment** (verified across three increments): every shell command doing npm/node network
  work starts with
  `cat /root/.ccr/ca-bundle.crt /etc/ssl/certs/ca-certificates.crt > /root/.ccr/node-ca-combined.crt && export NODE_EXTRA_CA_CERTS=/root/.ccr/node-ca-combined.crt`;
  7 chmod-simulation tests fail under root (container artifacts, never yours); gates run
  **backgrounded** (a foreground command dies at 10 minutes) and their `cwd` must be given
  absolutely, because a backgrounded shell does not inherit the previous call's directory; the
  typecheck that matters is `tsconfig.check.json` (a plain `tsc --noEmit` skips the test tree and
  will miss a type-alias break); eslint runs **from `source/cli`**, not from the repo root; the
  build must be run **unpiped** (piping its output has truncated it before);
  **NEVER run `init` from a subdirectory**; the signing service returns transient 503s — retry,
  never route around; container restarts and snapshot rollbacks have happened **eight times** in
  this program, so the discipline is tight verify→commit cycles and committing immediately after a
  green gate, never batching two tasks into one commit; and no `repo-check.sh` and no commits from
  the implementer (the controller gates and commits).
- **Anchors.** Line anchors are from the tree at a761dda. Re-locate by the quoted code if an anchor
  has drifted, and report the drift.

---

## Decisions taken in this plan (D1–D25)

Each resolves something the authorities leave under-determined, or reconciles two of them. A task
may not re-litigate one; a task that finds a decision *wrong* stops and reports.

- **D1 — The intents seam: a pure engine that returns its side effects as data.** `verdict.ts`,
  `speech.ts`, `session-state.ts`, `health.ts` and `exemplars.ts` perform no I/O. `evaluate()`
  returns `{ messages, intents }` where `intents` is a plain, sorted record of *what should be
  appended where* — session events, telemetry lines, ledger marks — and `src/cli/roots-check.ts`
  is the single place that applies them, in the single order D14 fixes. Three reasons, each
  independently sufficient: `roots-engine` carries `no-direct-fs` and `deterministic`
  (`yg-architecture.yaml:749-755`), so the alternative is not available; a returned intent is
  assertable by value in a unit test, where a performed write is only assertable through the
  filesystem; and the fail-open boundary (R5-I2) can only be *one* catch if there is exactly one
  place that touches the world. The seam also makes the harness mode trivial — a harness runs
  `evaluate()` and discards `intents` (`v6-spec.md:730`: the harness runs hermetically, with no
  telemetry or session reads/writes).
- **D2 — File placement and the names that carry meaning.** As tabulated in the authorization
  section. Restated as a rule an implementer can check: a new `src/io/` file MUST end in
  `-store.ts` or `-cache.ts`; a new `src/cli/` file MUST export exactly one
  `register<Pascal>Command`; a new `src/roots/` file is automatically `roots-engine` unless it is
  literally `stores.ts`. A file placed against this rule is a blocking `unmapped-files` /
  `type-strict-orphan` finding, not a style nit.
- **D3 — What R5 adds to the committed snapshot, and why `ROOTS_VERSION` moves to 2.** The
  verdict path needs three things the model body does not yet carry: per-fact `exemplars`
  (Appendix D `:890` lists the field; §9.11 makes the exemplar contrast *the witness itself*,
  `v6-spec.md:490-496`), a way to resolve an arbitrary file to the partition the index would have
  put it in (D5), and the two directional co-change counts completeness needs (D20). R5 therefore
  adds `MinedFact.exemplars`, a body-level `partitionRouting`, and `commitsA`/`commitsB` on every
  co-change row.
  The reason `stores.ts` records at the constant today
  (`src/roots/stores.ts:25-39`) is about *readability* — and readability is not the problem R5 has.
  The problem is **regeneration**. `evaluateNoOpShortCircuit` (`src/cli/roots.ts:538-585`) compares
  exactly eight header INPUT fields — `headSha`, `clock`, `dirtyHash`, `configHash`, `seedsHash`,
  `decisionsHash`, `ledgerHash`, `bindingHash` — and **not one of them moves when the CLI's body
  shape changes**. So on any repository whose HEAD, config, seeds, ledger, bindings and dirty set
  are unchanged, the first `yg roots index` after the R5 upgrade would print "Already current" and
  leave an R4-shaped body on disk: no `exemplars` (so no `See:` line — D4's whole witness argument),
  no `partitionRouting` (so every file routes to nothing — silence, permanently, until someone runs
  `--full`). **`ROOTS_VERSION` therefore moves to 2.** The bump is not a compatibility gesture; it
  is the *one mechanism that already exists* for forcing a rebuild, and three landed call sites
  already implement its consequences: `readModel` throws on a version mismatch
  (`src/roots/stores.ts:206-211`), `evaluateNoOpShortCircuit` catches that throw and treats it as
  "no comparable header", returning `false` so the run proceeds (`roots.ts:551-556`), and `status`
  already renders the "could not be read — run `yg roots index`" paragraph
  (`roots.ts:403-409`). **No migration file is written, and that is not an omission:** `model.json`
  is derived, rebuildable state whose only correct migration is regeneration, and the version gate's
  throw *is* the trigger for it. T2 adds the criterion that pins it (an R4-shaped body on disk ⇒ the
  next `index` rewrites it), and T3 adds the criterion that pins the other side (a version-mismatched
  model ⇒ `check` is silent, exits 0, records one incident — never a crash). The graph schema
  version (`CLI_SUPPORTED_SCHEMA`, `templates/default-config.ts`) is untouched: no graph format
  changes, and AGENTS.md's two-version rule is satisfied precisely because these are the roots
  store's own version and not the graph's.
- **D4 — §9.11's exemplar rule, made total.** The spec gives a formula and a filter
  (`v6-spec.md:484`); four things it leaves open are decided here, all at index time in
  `exemplars.ts`:
  - **Candidate set.** Real (non-seed) instances of the fact's cell whose observed value equals
    `expected`, of the fact's `appliesKind`, **excluding role-ambiguous scopes**; if that leaves
    none, fall back to all conformers (the spec's own fallback). For `_all` and directory facts
    "non-ambiguous role member" reads as "not marked ambiguous in `assignments`" — the ambiguity
    filter is about the scope being a poor representative, which is true regardless of which cell
    class is speaking.
  - **`m1`.** §8.5's own definition — `max_k jaccard(F(s), F(medoid_k))` — computed from the same
    medoid bags `induceRoles` already built. **Preferred implementation: extend
    `RoleClassification` (`src/roots/roles.ts:335-339`) with `m1: number`**, so the membership has
    one home; that is a ~30-line edit inside the prompt-ceiling cap the Global constraints set, and
    it is re-measured immediately. If the post-edit measurement shows `roles.ts` inside 2000 chars
    of the ceiling, revert to computing `m1` in `exemplars.ts` from the exported `roleJaccard`
    (`roles.ts:194`) over the same bags, and pin the two against each other by value.
    **`m1` applies to role facts only.** §9.11's own filter is written over "non-ambiguous **role
    members**", and §8.5 defines `m1` as a membership against medoids — a quantity with no meaning
    for a cell that is not a role. An `_all` or directory cell's candidate set mixes role members
    with scopes that have no role at all (§8.4: no role is precisely `m1 = 0`), and §8.7 records
    that `_all` carries most of the enforceable mass, so this is the majority path, not an edge
    case. Assigning role-less scopes a neutral `m1 = 1` would rank them **above** every genuine
    group member — the inverse of "the pattern to copy" — and assigning them 0 would zero the whole
    tuple. So the rank key is cell-class-dependent, stated once here: role facts rank by
    `(w·m1·centrality desc, w·m1 desc, stable_id asc)`; `_all` and directory facts rank by
    `(w·centrality desc, w desc, stable_id asc)`.
  - **`centrality`.** "In-degree normalized" resolves to the co-change coupling percentile R4
    already computes and stores per partition: `couplingByFile[relPath] / 100`. When the map is
    structurally absent (every degraded-mode build — R4-I4), centrality is `1` for every candidate,
    a constant that cannot reorder. When the map is present but the path is absent from it, the
    file genuinely has no co-change partners above the cut and centrality is `0`.
  - **The tie-break, refined.** The spec ranks by `w(s,q)·m1·centrality` with ties by `stable_id`.
    Taken literally, a small repository with no co-change pairs at all gives every candidate a
    score of exactly 0 and picks exemplars by hash — the worst possible ordering for the one thing
    the agent is shown as *the pattern to copy*. The rank key is therefore the **tuple**
    `(w·m1·centrality desc, w·m1 desc, stable_id asc)`: the spec's score first, its own final
    tie-break last, one strictly-refining step between. This never contradicts the spec (it only
    breaks ties the spec left to a hash) and it is what makes the all-zero case sane.
  - **Top 3**, rendered `path:line#name` (`v6-spec.md:484`), stored as
    `{ rel, line, name }` exactly as Appendix D shows (`:890`).
  - **Render-time re-validation** (spec: "reaped scopes never render") is a **file-existence
    check** at check time, not a re-parse. Re-parsing three exemplar files per message would
    multiply the hook's parse cost by four against a 700 ms cold budget (`v6-spec.md:586`), and the
    index — not the hook — is the authority on a scope's line number. A message whose exemplars all
    fail the existence check still renders, without the `See:` line; it does not become silence,
    because the deviation is still true.
- **D5 — Hook-time partition resolution: `partitionRouting`.** `stable_id` folds `partitionId`
  (`v6-spec.md:245`), and telemetry, the ledger and the hook-shaped weight cap all key on
  `stable_id` — so a check path that guessed the partition would write marks the next index could
  never match. Re-deriving partitions live is not available: `derivePartitions`
  (`src/roots/partitions.ts:221`) needs the whole repo's raw scopes to apply the 300-scope floor.
  The snapshot therefore carries the *decision function*, not the decision.

  **The id domain first, because it rules out the obvious sentinel.** A partition id is one of:
  a package-root directory string, the literal `'_root'`, or the literal `'_repo'`
  (`partitions.ts:283`). And a package-root directory string **can be the empty string**:
  `dirnameOf` returns `''` for a path with no slash (`extract.ts:795-798`), so a repository with a
  root-level `package.json` / `pyproject.toml` / `go.mod` — the mainstream adopter shape — produces
  `packageRootDirs = {''}`, and if that bucket clears the 300-scope floor its final id is
  **literally `''`**. `''` is therefore a *live, valid partition id* and can never be a sentinel;
  using it as one would make `yg roots check` permanently silent on exactly the repositories the
  product targets, with no fixture in this repo catching it unless a golden carries a root-level
  package marker *and* ≥ 300 scopes.

  **The shape, therefore:**
  ```ts
  partitionRouting: {
    roots: Array<{ dir: string; partitionId: string | null }>;  // `null` = dropped ⇒ silent
    fallback: string | null;                                    // the `_root` arm's final id, or null
  }
  ```
  `null` is the sentinel — a JSON value no partition id can take. The `roots` array holds one entry
  per detected package-root directory (including a `dir: ""` entry when the marker sits at the repo
  root), each carrying the **final** id `derivePartitions` gave that key (`key` itself when it stood
  on its own floor, `'_repo'` when the merge absorbed it, `null` when the merged bucket was dropped).
  `fallback` is the `'_root'` arm — the key `keyFor` returns when *no* root matched — carrying its
  own final id or `null`; it is a separate field rather than a magic array entry because `'_root'`
  is not a directory prefix and must never be matched as one.

  **Lookup replicates `keyFor` exactly** (`partitions.ts:210-215`), all three arms, in order:
  ```
  for (const r of roots) if (r.dir === '' || rel === r.dir || rel.startsWith(r.dir + '/')) return r.partitionId;
  return fallback;
  ```
  The first arm is not decoration: `keyFor` treats a root-level marker as matching everything, and a
  `startsWith(dir + '/')`-only lookup would both miss that case and miss a file whose own path
  equals the root string.

  **Order.** `derivePartitions` sorts `sortedRoots` by **descending string length**
  (`partitions.ts:236`), not by nesting depth, so the plan does not claim "most-nested first" as the
  rule. The persisted array is sorted `(dir.length desc, dir asc)`, which is *behaviorally
  identical* to `sortedRoots` and additionally total: two distinct equal-length directories can
  never both be ancestors of the same path (equal-length prefixes of one string are equal), and the
  one universal matcher, `''`, has length 0 and therefore sorts last — exactly the nesting semantics
  `keyFor` implements. The added `dir asc` tie-break changes no lookup and removes the only
  dependence on `Set` insertion order.

  **A routing entry also reconstructs the module-root arm** `finalizeUnits` needs (D6), by
  `derivePartitions`' own rule (`partitions.ts:280-282`): `''` when the resolved id is `'_repo'` or
  the `fallback` arm matched, otherwise the matched entry's `dir`. Nothing extra is persisted for it.

  A file that resolves to `null` is **silent** — the same answer the index gave it. The whole
  structure is O(number of package roots), not O(files), and it answers for files that did not exist
  when the index ran, which is precisely the case the hook exists for (an agent writing a new
  handler).
- **D6 — Hook-time enumeration reuses the index's own functions, with the snapshot's vocabulary.**
  The check path runs `extractUnits` → `finalizeUnits` (over a synthesized single-file
  `PartitionMap`) → `enumerate(units, vocabFromSnapshot, config)`, and reads a surface's value from
  the resulting `FeatureBag`/`DomainMap` pair: present in `surfaces` ⇒ that value; absent but in the
  surface's domain ⇒ `'false'` for a boolean surface; not in the domain ⇒ **`null`, which skips**
  (undecidable is never a deviation, `v6-spec.md:213`). Vocabularies are **never** recomputed at
  check time — they are a partition-wide statistic and recomputing them from one file would
  silently change every surface id. `finalizeUnits` reads `partitions.moduleRootDirOfFile`
  (`extract.ts:748`) — the **pre-merge package-root directory**, not `MinedPartition.moduleOfFile`
  (the resolved module directory, a different quantity) — so the synthesized map fills that slot by
  D5's own reconstruction rule: `''` when the resolved id is `'_repo'` or the fallback arm matched,
  otherwise the matched routing entry's `dir`, which is exactly `derivePartitions`' own line
  (`partitions.ts:280-282`). Module-kind units are discarded before evaluation (§9.10's runner
  evaluates method, type and file scopes only, `:481`), and module-kind **facts** are dropped by
  the `VerdictFact` projection (T3), so the slot cannot reach a verdict either way — but it is
  filled from the right field, because an implementer told to use the wrong one will reach for
  `moduleOfFile`, find it, and never learn that it meant something else. **T3 Step 1 proves the
  equivalence (R5-I6) rather than assuming it**, and STOPs on divergence.
- **D7 — Δ, τ and the posteriors all read the snapshot.** `Δ = log2(p̂(expected)/p̂(observed))`
  with KT smoothing α = ½ over the fact's own persisted `counts` and `alphabet`
  (`v6-spec.md:385`): `n_eff = Σ counts`, `K = 2` for a boolean surface and `|alphabet| + 1`
  otherwise, `p̂(v) = (n_v + ½)/(n_eff + K/2)`, and `p̂(⊥) = ½/(n_eff + K/2)` when the observed
  value is outside the alphabet. Boolean-versus-categorical is decided by the **exported**
  `isBooleanSurface` (`src/roots/mine-stages.ts:52`), never by inspecting the alphabet's contents —
  a categorical whose observed values happened to be `true`/`false` must not be mistaken for a
  boolean. τ is the fact's own persisted `tau` field, which the index already set from §9.4f's
  tiers; the verdict **never re-derives the tier**, so the fire-ability gate and the verdict can
  never disagree about τ by construction. R6's calibrated `τ_c` will move that same field, and the
  verdict will need no change. Unseen value (⊥) ⇒ novelty note and severity **capped at WARN**
  (`v6-spec.md:439`) — in R5 that cap is invisible because nothing reaches DENY, and it is still
  implemented and tested, because R6 turns the cap on the same day it turns DENY on.
- **D8 — Specificity governance: the evidence class is the survived-raw total.** §9.10 says at most
  one fact governs a scope per surface: "the applicable fact with the smallest evidence class
  (fewest survived-raw instances), ties broken role < directory < `_all`" (`v6-spec.md:455-456`).
  The concrete quantity is `MinedFact.nTotalRaw`, which `mine.ts`'s own field doc already defines
  as the survived raw population (`src/roots/mine.ts:130-132`) — not `counts`, which is weighted and
  seed-inclusive, and not `deviantsN`. Applicability is the spec's own three-way test: role facts
  of the scope's resolved role only, and **nothing** from a role that is ambiguous for this scope,
  untyped, or decorative (§8.10's `role_lift ≤ 0` demotion, `:360-364` — reachable via
  `isDecorativeRole`); directory facts whose `<dir>` is an ancestor of the scope's path; `_all`
  facts always. A scope with no role and no directory context is governed by `_all` alone (I5).
- **D9 — Severity in R5, and the inert DENY row.** The composed rule, stated once so no task
  restates half of it: **`severity = (denyEligible && !novel) ? DENY : WARN`**, where `novel` is
  D7's ⊥ case (the observed value is outside the fact's alphabet). The `!novel` conjunct is
  §9.7's binding clause — "a never-seen value is never denied" (`v6-spec.md:439`) — and it is a
  load-bearing rule with its own killer (MR-12b), not a note attached to D7. `denyEligible` reaches
  the engine as a plain `boolean` on `verdict.ts`'s **own** input projection — not as `MinedFact`'s
  literal `false` type. That single indirection is what lets the
  channel table's DENY row be exercised by unit tests today while remaining unreachable from any
  real snapshot until R6 sets the flag (`integration-design.md:365-383`: DENY arms at R6, never in
  CI, only in a hook's JSON payload). **R5 emits no `permissionDecision` under any input**, because
  the `pre` channel drops WARN and R5 can produce nothing but WARN; a test that constructs a
  synthetic DENY finding and drives the table directly is how the row is covered, and an e2e that
  asserts `--hook pre` prints nothing and exits 0 is how the product promise is covered.
- **D10 — Channel vocabulary, stdin precedence, and no installer.** The channel names are the
  design's — `pre | post | bash | stop | generic` (`integration-design.md:80`) — not the spec's
  `claude-*` spellings (`v6-spec.md:563`); the design supersedes on integration shape, and a
  host-branded flag value in a host-agnostic CLI is exactly the internal leak §11's naming rule
  forbids. Input precedence, fixed: a JSON payload on stdin (read only when `--hook` was passed and
  stdin is not a TTY) supplies session id and file set; explicit `--session`, `--content`, `--as`
  and positional `<file...>` arguments override whatever the payload said. **On a `--hook` channel**
  with neither a payload nor a file argument the run is a silent no-op that exits 0 — a hook
  invoked with nothing to look at has nothing to say. **Without `--hook`** the no-argument form is
  not a no-op: it resolves its own file set per D11. **No hook installer ships in R5**
  (`hooks install` is R8, program plan `:121`), so every channel is reachable only by explicit
  invocation and by tests — which is also why the protocol path (`yg roots check <file>`, the form
  R9 will teach in `rules.ts`) must work perfectly without any hook runtime at all.
- **D11 — Non-hook scope selection: a declared, bounded superset of §19's rule.** Design §3's
  `check` row and spec §19's (`:698`) agree: with no path arguments the scope set is "scopes whose
  `body_hash` differs from HEAD, plus enclosing types and file scopes"; with `[paths…]` it is
  **every** scope in those files. The second half R5 implements exactly. The first half it
  implements as a **superset**, and the reason is a cost, not a preference: **`body_hash` does not
  exist.** §6.5 defines it (`v6-spec.md:250`), but the landed extractor never computed it — there is
  no `bodyHash` field anywhere on `RawScope`/`ScopeUnit`, and R4's history layer compares scopes by
  a replay-side change signature instead. Adding it means adding a field to the extracted record,
  which means bumping `EXTRACTOR_VERSION` (`extract.ts:72`), which is folded into `blobCacheKey` —
  **invalidating every cached historical blob and forcing a full re-parse of the entire history on
  the next index, for every adopter.** R5 will not impose a whole-history re-parse to refine a
  convenience form of the command.

  So: **with no paths and no `--hook`, `check` evaluates every scope in every dirty file**
  (`getDirtyFiles`, `src/utils/git.ts:125`), which is a strict superset of §19's set — the same
  files, without the per-scope filter. What the superset costs is bounded by the layer that already
  exists for exactly this: §11.3's 3-per-response budget and WARN dedup mean the extra scopes can
  add noise but cannot flood, and a deviation already reported in this session is not repeated.
  **Degraded fallback:** with git unavailable or a shallow clone, `getDirtyFiles` returns nothing
  and the run is silent with one `debugWrite` line — never an error (R5-I15).

  **This is a declared scope reduction against `integration-design.md:80` and `v6-spec.md:698`, and
  it is recorded as one** in the NON-goals section rather than left as a quiet divergence. Its owner
  is **the package that next bumps `EXTRACTOR_VERSION`** — R6 is the natural candidate, since trends
  and calibration already re-walk history and can absorb a cache invalidation in the same
  increment. If no package ever does, the superset stands permanently and the docs say so.
- **D12 — Session identity is the command layer's job.** §11.4's ladder (`v6-spec.md:554`) — the
  payload's `session_id` hashed, else `sha256(ppid ∥ cwd ∥ ppid-start-time)[:12]`, else
  `ppid ∥ cwd ∥ UTC-day` — reads the process table and the wall clock, both forbidden in
  `roots-engine` by the `deterministic` aspect. It lives in `src/cli/roots-check.ts` and reaches the
  engine as an opaque string. The last-resort day-granular form is genuinely last-resort and is
  documented where it is computed: it merges two same-day sessions in one checkout into one budget
  (`integration-design.md:331`), which costs an agent some speech and can never cause any.
- **D13 — The session log is the authority; telemetry is the durable mirror.** §11.4 defines
  session state as an append-only event log whose state is a fold (`v6-spec.md:554`), and §11.3
  says budgets are "enforced from the session event log" (`:551`). So: dedup keys, per-response and
  per-session budget counts, and the set of *open interventions* are all read from the session
  fold. `telemetry.jsonl` carries the same interventions in a role-free, cross-session, retained
  form for §18.2's pooling (`:681`, `:683`) and is never consulted for a budget decision. Both are
  idempotent under replay: the fold treats duplicate `(stable_id, surface, direction)` events as
  one, and §18.3's ledger dedupes on `(stable_id, surface, date)`.
- **D14 — Write order, chosen for the direction a torn write biases in.** Emission: render →
  **write the output first** → append session `warned` events → append telemetry intervention
  lines. Closure: append the session `closed` event → append the telemetry `observedAfter` line →
  append the ledger mark (complied only). The reasoning is the failure mode, not the happy path. A
  crash after printing but before recording loses an intervention: compliance is measured slightly
  high and a healthy convention is *not* demoted. A crash in the other order records an
  intervention the agent never saw, which later closes as `ignored` and pushes a healthy convention
  toward demotion — the one outcome §18.2's own fail-open direction rules out ("a lost demotion
  resurrects a FACT, never falsely silences one", `v6-spec.md:683`). Within closure, the same logic
  orders the three appends: losing the ledger mark loses a discount, which is the status quo ante;
  losing the closure entirely leaves the intervention open for the cross-session pass to finish.
- **D15 — Ledger writing, and the index churn it causes on purpose.** On a complied intervention the
  check path appends `{stableId, surface, date}` to the committed `.yggdrasil/roots/ledger.jsonl`
  (`v6-spec.md:685`), `date` being the UTC calendar day supplied by the command layer **as exactly
  `YYYY-MM-DD`**. The format is not cosmetic and is pinned here because two landed pieces of
  arithmetic depend on it: `markKey` joins `(stableId, surface, date)` verbatim
  (`src/roots/weights.ts:267-269`), so an ISO *datetime* would make two marks on the same day two
  distinct keys and defeat the per-day dedupe entirely; and `releasedMarks` does
  `Date.parse(mark.date)` (`weights.ts:256`) to compute `markDate + releaseMinDaysAfterMark`, which
  a datetime silently shifts by up to a day. `YYYY-MM-DD` parses as UTC midnight, which is what that
  arithmetic assumes. Appends go
  through `appendLedgerMarks` in `src/roots/stores.ts` — the file that already owns `readLedger`,
  so the store's read and write halves stay in one place — routed through `appendToDebugLog`'s
  chokepoint per `atomic-write-contract`. Two consequences are intended and must be stated in the
  docs, not hidden: `git status` shows a dirty `ledger.jsonl` after a productive session ("roots
  records that it shaped this code — commit it with your change", `:685`), and because
  `ledgerHash` is one of the model header's inputs, the **next** `yg roots index` will not take
  D13's no-op short-circuit. That is the mechanism working: a new mark genuinely changes what the
  next model should say.
- **D16 — Where the demotion aggregation runs, and why it is outside the no-op short-circuit.**
  §18.2 says aggregation runs "in the same transaction as every snapshot write … and at
  `report`/`status`; never in hooks" (`v6-spec.md:683`). Taken literally against the landed `index`,
  that would strand it: **accumulating telemetry moves none of the eight header inputs
  `isNoOpShortCircuit` compares** (`src/cli/roots.ts:491-510`), so on a quiet repository — an agent
  ignoring the same convention across sessions without committing, which is *precisely* the case
  demotion exists for — `index` short-circuits, the aggregation never runs, and nothing ever
  demotes. R5 therefore fixes the placement explicitly:

  1. **The short-circuit governs the MINING, not the run.** `yg roots index` evaluates D13's
     short-circuit exactly as it does today, and when it fires it still writes nothing to `.cache/`
     and leaves `model.json` byte-identical — R4's guarantee is preserved word for word, because
     §6.6 clause 6's own wording is about writes to the cache (`v6-spec.md:260`).
  2. **The aggregation then runs unconditionally, after that decision**, reading whatever
     `model.json` is on disk and writing only `.yggdrasil/roots/.state/demotions.json` — a superset
     of §18.2's "every snapshot write", never a subset.
  3. **It takes no build lock, and needs none.** The lock serializes `.cache/` and `model.json`
     writers (R4-I12). `demotions.json` is a single file written through `atomicWriteFile`, and its
     content is a pure function of (model, telemetry, session logs) — so two concurrent runs each
     write a complete, valid, *identical* answer. Taking the lock here would be strictly worse: it
     would put a `.cache/` write back into the no-op path that R4's D13 exists to keep write-free.
  4. **It writes only on change.** The computed content is compared against what is on disk and the
     write is skipped when they match. A repository with no telemetry therefore has nothing to
     aggregate and writes nothing at all — R4's "a genuine no-op run writes nothing" test keeps
     passing byte for byte.
  5. **`status` computes and displays, and writes nothing** — the reader/writer split
     (`integration-design.md:160-163`). Concretely, and this is the part §18.2 hides: its
     cross-session closure pass would otherwise **append committed ledger marks** from a read
     surface (§18.2 says a cross-session `complied` sample "appends the §18.3 ledger mark"). Per
     D1's seam, `health.ts` *returns* those marks as intents; only `index` applies them. T8
     criterion 6 pins `ledger.jsonl` byte-identical across a `status` run that has open
     cross-session interventions.

  `demotions.json` is stamped with the **snapshot content hash**, and the check path ignores a stamp
  that does not match the snapshot it just loaded. The freshness cost of (5) is bounded and safe by
  §18.2's own rule — a stale or missing `demotions.json` means a demoted fact keeps speaking, never
  that a healthy one goes silent.
- **D17 — Hook-time staleness is a cheap, honest subset.** §12.7 compares
  `(headSha, configHash, seedsHash, rootsVersion, bindingHash)` and explicitly excludes
  `ledgerHash`/`dirtyHash` (`v6-spec.md:592`). Four of those five are cheap at check time; the
  fifth is not — `bindingHash` requires a repo-wide parse-candidate re-pass
  (`computeUsedGrammarSetHash`, `src/roots/pipeline.ts`), which would spend the entire hook budget
  to detect a condition that only a CLI upgrade can create. The check path therefore compares
  `headSha`, `configHash`, `seedsHash` and `rootsVersion`, and **states in the plan and in the code
  what it does not check**: a grammar-package upgrade that changes `bindingHash` without changing
  `rootsVersion` leaves the check path unaware the model is stale. `yg roots index` and
  `yg roots status` compute the full tuple and are where that case surfaces. Stale ⇒ the run
  proceeds against the stale model with a staleness note in the modulator list; snapshot missing ⇒
  silence plus one incident (`:592`).
- **D18 — The fail-open boundary, incidents, and what an incident is *not*.** One `try`/`catch`
  around the whole entry point (R5-I2). Its catch writes one record to
  `.yggdrasil/roots/.state/incidents.jsonl`, a **gitignored, local, machine-written FIFO of 500**
  (`v6-spec.md:719`; design `:456`). Harness mode is an explicit option on the exported entry
  function (`{ rethrow: true }`), never an environment variable: an env var is a product surface an
  adopter can trip, and a fail-open engine that silently rethrows in production is worse than
  either mode. **These are not `yg incident` entries.** That command's ledger is committed human
  testimony in `.yggdrasil/incidents.md` (`src/io/incidents-store.ts:1-35`), governed by the
  standing "never fabricate an incident" invariant. Roots' incidents are machine diagnostics in a
  different file, a different format and a different lifecycle; the two must never be conflated in
  code, in docs, or in a `status` line, and the new store file's header says so.
- **D19 — §11.3 is the one ordering and truncation authority.** Dedup key
  `(stable_id, surface, direction)` with `direction = (expected, observed)`, **WARN-tier only, once
  per session**; DENY is never deduplicated. Both dedup and budgets read the **post-`channelFilter`**
  severity, so a downgraded DENY is a WARN for both purposes. Per response ≤
  `budgets.maxMessagesPerResponse` (3), ordered `(severity desc, Δ desc, surface asc)`. Per session
  ≤ `budgets.sessionMaxWarnings` (12) WARNs, then DENY only — which in R5 means silence. Overshoot
  from concurrently in-flight hook processes is bounded by that concurrency and is documented, not
  locked against: a lock on the session log would put a mutex in a 900 ms hook path to prevent an
  agent occasionally seeing a fourth message.
- **D20 — Completeness (T5, the Stop message) is R5's.** The program plan's R-package paragraphs
  assign the completeness sweep to no package by name; R4's plan assigns it explicitly — "The
  Stop-channel completeness sweep (`v6-spec.md:625`) is R5's — R4 produces the pairs it will read"
  (`2026-08-20-increment-3-r4-history.md:2320-2321`) — and R5 is in any case the only package that
  *can* host it, because its two inputs are the co-change cut (landed in R4) and the session's
  written-file set (which does not exist until this increment's session log). It is gated by
  `hooks.claudeCode.stopCompleteness` and `completeness.mode`, both already parsed with their
  defaults, and it renders Appendix A's **T5** template. Dropping it would leave the program plan's
  own scope law ("nothing here is deferred out of it") violated by omission.

  **The committed row cannot support it as landed, so T2 extends the row.** §13.5's rule is
  *directional* — `confidence(a→b) = support(a,b)/commits(a)` — and T5's evidence phrase is
  `{support}/{commits}`. What the snapshot carries today is `{a, b, sup, conf}` with `a < b`
  canonical (`history-cochange.ts:94`) and, decisively, `conf = Math.max(confAB, confBA)`
  (`history-cochange.ts:396-398`). From the max alone `confidence(a→b)` is **not recoverable**:
  using it as a proxy names `b` in the wrong direction whenever `b` is the churnier file — the
  commonest asymmetric pair there is (a test that changes often beside a source file that does not)
  — producing a false "you forgot to touch X" on exactly the pairs completeness exists to catch.
  And `commits(a)`, T5's own denominator, lives **only** in the gitignored
  `.cache/history/cochange-raw.jsonl` (`history-cochange.ts:109-112`), absent on a fresh clone and
  outside the check path's committed-data contract. **T2 therefore persists two more integers per
  row — `{a, b, sup, conf, commitsA, commitsB}`** — the same `commitsOf(a)`/`commitsOf(b)` values
  `finishCochange` already holds at cut time. Cost: two numbers on at most `cochange.maxPairs`
  (5000) rows, tens of kilobytes on a large repository, on a body D3 is already reshaping and
  version-bumping. This is an Appendix-D extension of the same class as `exemplars` and
  `partitionRouting`, and it is what makes both the directional test and the rendered evidence
  honest.

  **Two consequences the sweep must respect.** `a < b` is canonical, not directional, so the sweep
  scans **both** sides of every row — an edited file may be either `a` or `b`. And because the
  persisted `conf` is the *max*, the committed cut set is a **superset** of what the directional
  test admits, which makes re-applying `cochange.minConfidence` per direction at check time a real
  gate rather than a redundant one (D23).
- **D21 — The Bash sweep needs no command parsing.** §12.4 (`v6-spec.md:583`) is a content-hash
  diff, not a shell parser: the first sweep **seeds** `fileState` from `git status --porcelain -uall`
  (which `getDirtyFiles` already returns, sorted and POSIX-normalized) and emits **nothing**;
  later sweeps debounce, re-list, hash, diff, and evaluate at most `budgets.bashSweepMaxFiles` (5)
  changed code files. Over `budgets.bashFloodThreshold` (20) at seed time sets `seedTruncated`
  (suppressing messages for unseeded paths for the whole session); over it in one sweep sets
  `floodSkipped` and defers to the Stop summary. A consequence the spec states and the docs must
  repeat: file *moves* are structurally WARN-only, because blocking them would need a Bash
  command-parsing PreToolUse matcher, which is out of scope by decision.
- **D22 — What `status` gains in R5, and what it does not.** It gains exactly three things, each
  demanded by an invariant R5 creates: the list of **active modulators** (I2b's own requirement,
  `v6-spec.md:81`), the **withheld-conventions** line ("K conventions withheld: no established
  instances yet" — §9.4c.4's J4 explanation, `:409`, `:697`), and the **agentShare alarm** rendered
  as Appendix A's T7 when `agentShare ≥ health.agentShareAlarm`. It does **not** gain `--exit-code`
  or `--diagnose` (R7, `integration-design.md:84`), and it still always exits 0. The three
  additions are text in the existing renderer, not a new command surface; R7 restructures the same
  content into its fuller form.
- **D23 — The config keys R5 consumes, all already landed with spec defaults.** `budgets.*`
  (`maxMessagesPerResponse` 3, `sessionMaxWarnings` 12, `hookHardTimeoutMs` 900, `hookColdBudgetMs`
  700, `bashSweepDebounceMs` 5000, `bashSweepMaxFiles` 5, `bashFloodThreshold` 20 —
  `config-parser.ts:114-123`); `health.*` (`minCompliance` 0.3, `minSamples` 8,
  `telemetryRetentionDays` 180, `agentShareAlarm` 0.85 — `:124`); `sessions.pruneDays` 7 (`:139`);
  `completeness.mode` `stop-feedback-once`, `maxItems` 5 (`:125`); `hooks.claudeCode.*`
  (`postTool` true, `preTool` false, `bash` true, `userPromptBrief` false, `stopCompleteness` true
  — `:128-130`); `thresholds.preferenceGapBits` / `absenceGapBits` / `absenceGapBitsStructural`
  (read only through the fact's persisted `tau`, per D7); `cochange.minSupport` 8 /
  `minConfidence` 0.75 for completeness (`:112`) — **live gates at check time, not a re-application
  of a filter already applied**: `finishCochange` cut on `support ≥ minSupport ∧ max(confAB, confBA)
  ≥ minConfidence`, so the committed set is a superset of what the *directional*
  `confidence(a→b) ≥ minConfidence` admits (D20); `ledger.*` for release, already consumed by R4.
  `budgets.daemonBudgetMs` is present in the config and is **never read** — there is no daemon
  (`integration-design.md:373`); leave it parsed and unused, and say so once where the budget
  constants are consumed, so a later reader does not "fix" the omission. Any new key is a STOP.
- **D24 — The documentation boundary.** R5 owns making the *existing* docs true: `docs/roots.md`
  (whose "What's not here yet → Speak up while you edit" section, `.state/` row and ledger row all
  become false in this increment), `docs/configuration.md`'s roots block if any statement about
  dormancy or state changes. **It does not touch `docs/cli-reference.md`, and that is a decision,
  not an oversight:** that page (1276 lines) documents **no `yg roots` command at all** today — not
  `index`, not `status`; its only `roots` mentions are the gitattributes/gitignore lines at
  `:1238-1243`. So nothing in it becomes false in this increment, and adding a `check` entry alone
  would mean either creating the whole roots section (documenting `index` and `status` too, which
  this decision assigns to R9) or leaving a section that documents one command out of three. R5
  documents `check` where roots is already documented — `docs/roots.md`, which already covers
  `index` and `status` — and the CLI reference gains its roots section whole, once, in R9. R5 also
  does **not** own the new concepts/quickstart/honesty pages, the two knowledge topics, the `roots:`
  schema entry or the `rules.ts`/`digest.ts` roots section — all R9 (program plan `:124-133`). Because R5 edits neither
  `templates/rules.ts` nor `templates/digest.ts`, **the digest freshness gate has nothing to
  re-run**, and no `init --upgrade` is needed at the root or in any `examples/*/` — T11 states that
  in its report so the omission reads as scoped rather than forgotten.
- **D25 — The scaffold notice names the file it is about to modify.** Carried in from R4's dogfood
  report (`.temp/dogfood-report.md`, 2026-08-22): `yg roots index` scaffolds a `roots:` block into
  whatever project its inherited cwd resolves to, and the notice it prints
  (`src/cli/roots.ts:129`) does not say *which file*. R5 takes the half that needs no design change
  — the notice prints the **absolute path** of the config it is about to modify, since the design
  already mandates "scaffolds it with defaults, printed first" (`integration-design.md:401`) and
  naming the path is strictly more informative. A confirmation gate or an `--init` flag is a design change and stays an open
  question (OQ2), because a prompt would break the non-interactive use every agent and CI makes of
  this command.

---

## Task 1 — Seams, graph design-lock, and the four `.state/` stores

**Scope.** Everything that touches the filesystem, before anything computes a verdict: the four new
`src/io/roots-*-store.ts` modules, the ledger *append* added to `src/roots/stores.ts`, the snapshot
content-hash helper D16 needs, the two new graph nodes for them, and the verification that the
architecture admits all of it. No verdict logic, no message text, no command.

**Authorities.** Spec §11.4 (`v6-spec.md:554`), §18.1 (`:681`), §18.2's `demotions.json` stamp
(`:683`), §18.3 (`:685`), §21.1's incident FIFO (`:719`); design §4's storage layout
(`integration-design.md:122-165`), §12's "sessions as append-only event logs" and "incidents FIFO
500" rows (`:456`, `:465`); AGENTS.md's local-state rule.

**Files.**
- Create `source/cli/src/io/roots-session-store.ts`, `roots-telemetry-store.ts`,
  `roots-demotions-store.ts`, `roots-incidents-store.ts`.
- Edit `source/cli/src/roots/stores.ts` — add `appendLedgerMarks` and `snapshotContentHash`.
- Create `.yggdrasil/model/cli/io/roots-state/yg-node.yaml`,
  `.yggdrasil/model/cli/roots/speech/yg-node.yaml` (empty mapping until T3 — the design lock lands
  first), `.yggdrasil/model/cli/commands/roots-check/yg-node.yaml` (likewise).
- Create `source/cli/tests/unit/roots/session-store.test.ts`, `telemetry-store.test.ts`,
  `demotions-store.test.ts`, `incidents-store.test.ts`, and `stores-ledger-append.test.ts` — all
  under `source/cli/tests/unit/roots/`, **not** `tests/unit/io/`, following R4's own landed
  precedent for this subsystem's store tests (`blob-cache.test.ts`, `history-store.test.ts`,
  `build-lock-store.test.ts` all live there and are mapped by `cli/tests/unit/roots`). The new
  `stores-ledger-append.test.ts` is a **new sibling**: the existing `stores-ledger.test.ts` covers
  reading and is not to be grown into a second subject.

**Two names in this task diverge from the spec, both deliberately, both following the landed
tree** — flagged the way D10 flags the channel names, so a reviewer does not read either as a
misquote. The spec calls the committed mark file `hook-ledger.jsonl` (`v6-spec.md:685`); the design
(`integration-design.md:127`) and R4's landed `LEDGER_FILENAME` (`src/roots/stores.ts:43`) both say
**`ledger.jsonl`**, and R4 shipped it. The spec puts incidents in `.roots-state/incidents.jsonl`
(`:719`); the design's storage layout (`:132-133`) and R4's landed `STATE_DIRNAME` both say
**`.yggdrasil/roots/.state/`**. The landed names win in both cases; this increment renames nothing
R4 shipped.

**Two contracts fixed here, both settled by landed precedent rather than by preference.**

- **The stores take an absolute `stateDir: string`, never a `yggRoot`.** `persistence-adapter`'s
  own relation list is `calls: [persistence-adapter, utility]` (`yg-architecture.yaml:206-209`) —
  **`roots-store` is not on it** — so a `src/io/` file may not import `rootsStateDir`/`STATE_DIRNAME`
  from `src/roots/stores.ts`, and duplicating the path constant would create a second source of
  truth for a path `stores.ts` already owns. The command layer legally reaches both types and
  resolves the directory once. This is exactly the shape R4 already shipped in this node:
  `roots-blob-cache.ts` takes `cacheDir: string` (`:98`, `:122`) and `roots-history-store.ts` takes
  `dir: string` (`:172`, `:261`).
- **Every function here is `async`.** Not a style choice: `readFileOrDefault` is `async`
  (`src/io/read-or-default.ts:10`), `atomicWriteFile` is `async` (`src/io/atomic-write.ts:26`), and
  `atomic-write-contract` bans `writeFileSync` outright (`check.mjs:4`), so the incident FIFO trim
  and the telemetry compaction — both whole-file rewrites — *must* go through `atomicWriteFile` and
  therefore cannot be synchronous. `appendLedgerMarks` must read the file to dedupe, and
  `readLedger` is async. R4's two stores in this node are async throughout. One policy, no
  exceptions, so no implementer has to guess per function.
  *(A correction to a stricter paraphrase that appears in some repo guidance: the
  `read-or-default-via-helper` aspect fires only on an inline ENOENT-swallow around the **async**
  `readFile` (`check.mjs:37-46`) — `readFileSync` with a bare try/catch is legal and is the
  established pattern in `incidents-store.ts:170-174`. Sync would therefore have been *permitted*;
  it is rejected here for the `atomicWriteFile` reason above, not by that aspect.)*

**Interfaces produced.**
```ts
// roots-session-store.ts — §11.4: O_APPEND, one event per line, state = fold.
export interface SessionEvent { ts: string; kind: 'warned' | 'closed' | 'sweep' | 'stop'; /* + kind-specific fields */ }
export function sessionLogPath(stateDir: string, sessionId: string): string;
export function readSessionEvents(stateDir: string, sessionId: string): Promise<SessionEvent[]>;      // tolerant: bad line skipped
export function appendSessionEvents(stateDir: string, sessionId: string, events: readonly SessionEvent[]): Promise<void>;
export function pruneSessions(stateDir: string, pruneDays: number, nowMs: number): Promise<number>;   // mtime-based, returns count

// roots-telemetry-store.ts — §18.1: role-free keys, retention compacted at index.
export interface TelemetryRecord { sessionId: string; ts: string; stableId: string; surface: string;
  factKey: string; expected: string; observed: string; severity: 'WARN' | 'DENY'; deltaBits: number;
  observedAfter?: 'complied' | 'ignored' }
export function readTelemetry(stateDir: string): Promise<TelemetryRecord[]>;
export function appendTelemetry(stateDir: string, records: readonly TelemetryRecord[]): Promise<void>;
export function compactTelemetry(stateDir: string, retentionDays: number, nowMs: number): Promise<number>;

// roots-demotions-store.ts — §18.2: stamped with the snapshot content hash.
export interface DemotionsFile { snapshotContentHash: string; demoted: string[] }   // sorted factKeys
export function readDemotions(stateDir: string): Promise<DemotionsFile | undefined>;// absent/corrupt => undefined
export function writeDemotions(stateDir: string, file: DemotionsFile): Promise<void>;// atomic; skipped by the caller when unchanged (D16.4)

// roots-incidents-store.ts — §21.1: FIFO 500, local, machine-written.
export interface RootsIncident { ts: string; stage: string; message: string }
export function appendIncident(stateDir: string, incident: RootsIncident): Promise<void>;  // trims to the FIFO cap
export function readIncidents(stateDir: string): Promise<RootsIncident[]>;

// stores.ts additions (this file keeps its yggRoot-shaped signatures — it is the roots store,
// and it already owns `rootsStoreDir`; only the four `src/io/` modules take an absolute dir)
export function appendLedgerMarks(yggRoot: string, marks: readonly LedgerEntry[]): Promise<void>; // dedupes on (stableId, surface, date)
export function snapshotContentHash(body: unknown): string;                                       // see Step 5 for the exact envelope
```

**Steps.**
- [ ] **Step 1: Verify the architecture admits every new file and node** — the table in the
  authorization section, checked live: each `when:` predicate against the real path, each import
  edge against the real `relations:` list, `max_direct_relations` against the new nodes' edge
  counts, and the fan-out leaderboard pin. **STOP and report a dictated minimal
  `yg-architecture.yaml` block if any row is false.** Also verify, do not assume, that
  `YGGDRASIL_GITIGNORE_LINES` already carries `roots/.state/`
  (`src/cli/init-scaffold.ts:143`, `:147`) — this increment is the first to write there, and a
  missing entry would commit an adopter's local telemetry.
- [ ] **Step 2: The append chokepoint.** Every JSONL append in this task goes through
  `appendToDebugLog(filePath, text)` (`src/io/debug-log-writer.ts:7`) — the repository's existing
  single-write chokepoint, and the file `atomic-write-contract` names as its own sanctioned append
  exemption (`check.mjs:15`), which is what keeps the aspect satisfied without a suppression.
  `demotions.json`, the incident FIFO trim and the telemetry compaction are whole-file writes and go
  through `atomicWriteFile`. `appendLedgerMarks` lives in `src/roots/stores.ts`, which the aspect
  does **not** bind (its glob is `**/src/io/*.ts`, `check.mjs:19`) — it still routes through
  `appendToDebugLog` rather than importing `node:fs`, both to keep that file's stated no-`node:fs`
  shape and so the ledger's append has the same single chokepoint as everything else. Read
  `RAW_WRITE_FNS` (`check.mjs:4`) before reaching for any `node:fs` writer.
- [ ] **Step 3: Tolerance, per store, stated in each file's header.** Session, telemetry and
  incident logs are **per-record tolerant** — a malformed line is skipped, never fatal (I1, and the
  same tolerance `readSeeds`/`readLedger` already document). `demotions.json` is **all-or-nothing**:
  a corrupt or stale-stamped file reads as `undefined`, which means "no demotions", which is the
  fail-open direction §18.2 chooses. Each header names which tolerance it has and why.
- [ ] **Step 4: The FIFO, done without reading the world twice.** `appendIncident` appends and then
  trims to 500 only when the file has grown past a cheap line-count threshold — the audit trail must
  survive a cache wipe (`v6-spec.md:719` calls it a durable store), so trimming is by age of entry
  (oldest first), never by truncating the file to zero.
- [ ] **Step 5: `snapshotContentHash`, envelope named exactly.**
  `hashString(JSON.stringify(sortKeysDeep(body)))` — the **compact** form: no indent, no trailing
  newline, body only. It deliberately does **not** equal any prefix or substring of what
  `writeModel` writes: `canonicalModelJson` serializes the whole `{header, body}` envelope with
  2-space indent and a trailing newline (`stores.ts:160-162`). The two share exactly one thing,
  `sortKeysDeep`, which is the part that makes either hash stable under key-insertion order.
  Appendix D's "header excluded from content hash" (`:861`) is the rule; this is its one
  implementation, and the reason it is exported rather than inlined is that D16's writer and the
  check path's reader must agree on it byte for byte.
- [ ] **Step 6: Graph ritual + report.** Three new nodes, mappings, relations, `yg log add` on every
  log-gated node touched, `check --approve --only-deterministic` clean.

**Acceptance criteria.**
1. `appendSessionEvents` then `readSessionEvents` round-trips N events in append order; a line of
   garbage inserted in the middle is skipped and the other N are still returned; the file is opened
   O_APPEND so two interleaved writers never truncate each other.
2. `pruneSessions` removes exactly the session files whose mtime is older than
   `sessions.pruneDays` (7) against an injected `nowMs`, and returns the count. It never removes a
   file it cannot stat.
3. `appendLedgerMarks` writes one line per mark with `date` in exactly `YYYY-MM-DD` (UTC),
   **dedupes on `(stableId, surface, date)`** — reusing `weights.ts`'s exported `markKey`
   (`:267-269`), never a second key format — against both the marks in the same call and the marks
   already in the file, and leaves an existing file byte-identical when every mark in the call is
   already present. **Two marks for the same `(stableId, surface)` produced by two runs on the same
   UTC day collapse to one line**; a mark whose `date` carries a time component is rejected by the
   store rather than written (it would silently defeat this dedupe and shift `releasedMarks`'
   `Date.parse` arithmetic, `weights.ts:256`).
4. `compactTelemetry` drops records older than `health.telemetryRetentionDays` (180) against an
   injected `nowMs` and preserves the rest in order; a run with nothing to drop rewrites nothing.
5. `readDemotions` returns `undefined` for: an absent file, a file that is not JSON, a file whose
   `snapshotContentHash` is not a string, and a file whose `demoted` is not an array of strings.
6. `appendIncident` keeps the newest 500 records and drops the oldest; the 501st append leaves
   exactly 500 records with the first one gone.
7. `snapshotContentHash` is stable across key-insertion-order permutations of the same body and
   changes when any body value changes; it is unaffected by the header.

**E2E coverage (R5-I12).** This task ships **no adopter-visible behavior** — nothing calls these
stores until T3. Its contracts are pinned by the unit tests above and are exercised end-to-end by
**T3's `cli-roots-check.test.ts`**, which asserts the exact on-disk content of the session log and
the incident file after a real `yg roots check` run through the spawned binary, and by **T7's**
ledger/telemetry assertions. Stated here so the gap is scoped, not forgotten: an implementer who
finishes T1 has not yet proven anything an adopter can see.

**Test obligations / mutation round-trips.**
- **MR-1 (ledger dedupe):** delete the `(stableId, surface, date)` dedupe ⇒ criterion 3's
  "byte-identical on a repeat call" fails.
- **MR-2 (FIFO direction):** trim the *newest* 500 instead of the oldest ⇒ criterion 6 fails on
  which record survived.
- **MR-3 (demotions all-or-nothing):** make `readDemotions` return a partial object for a
  mis-shaped file ⇒ criterion 5's third and fourth cases fail.
- **MR-4 (append chokepoint):** replace `appendToDebugLog` with a direct `appendFileSync` import ⇒
  the `atomic-write-contract` deterministic aspect refuses the file at
  `check --approve --only-deterministic`. (This one is killed by the graph, not by vitest — run it
  and report the refusal text.)

**NON-goals.** No verdict, no message, no command, no session identity derivation (D12 puts that in
the command layer), no demotion *math* (T8), no telemetry *writing* from a real run (T7).

---

## Task 2 — What the verdict path reads: exemplars, partition routing, directional co-change

**Scope.** The **three** additive snapshot fields the verdict path needs, produced at index time:
per-fact `exemplars` (§9.11, via a new pure `exemplars.ts`), body-level `partitionRouting` (D5),
and the two directional co-change counts `commitsA`/`commitsB` (D20) — plus the `ROOTS_VERSION`
bump to 2 that makes an upgraded repository actually regenerate them (D3). Determinism preserved
end to end.

**Authorities.** Spec §9.11 (`v6-spec.md:483-484`), §8.5's membership and weight-index table
(`:340`), §8.10 (`:360-364`), §6.8's partition rule (`:269-273`), §13.5's directional confidence
(`:621`), Appendix D's fact record (`:875-891`) and its co-change row (`:867`), §20.2 (`:713`);
design §12's "§9.11 exemplar ranking … with render-time re-validation" row (`:454`).

**Files.**
- Create `source/cli/src/roots/exemplars.ts`.
- Edit `source/cli/src/roots/mine.ts` — three edits only: call the exemplar stage, emit
  `partitionRouting` (both as *calls* into `exemplars.ts`, never inlined logic), and widen the
  `MinedModel.cochange` row type.
- Edit `source/cli/src/roots/roles.ts` — the single `m1` field of D4, capped at ~30 lines.
- Edit `source/cli/src/roots/history-cochange.ts` — `CochangePair` gains `commitsA`/`commitsB`,
  filled from the `commitsOf(a)`/`commitsOf(b)` values `finishCochange` already computes at the cut
  (`:394-398`); nothing else in that file changes, and the cut predicate is untouched.
- Edit `source/cli/src/roots/mine.ts`'s `MinedModel.cochange` row type and
  `source/cli/src/roots/stores.ts` — `ROOTS_VERSION` 1 → 2 (D3).
- Edit `source/cli/src/roots/pipeline.ts` — thread whatever the exemplar stage needs (weights,
  coupling) that `mine()` does not already hold.
- Create `source/cli/tests/unit/roots/exemplars.test.ts`,
  `source/cli/tests/unit/roots/roles-membership.test.ts` (**new sibling** — `roles.test.ts` is
  frozen at 660 chars of margin) and `source/cli/tests/unit/roots/roots-version-regen.test.ts`.
- Create `source/cli/tests/e2e/cli-roots-index-verdict-inputs.test.ts`.

**Steps.**
- [ ] **Step 1: Bump `ROOTS_VERSION` to 2, and prove it regenerates.** D3 fixes why: the eight
  header inputs the no-op short-circuit compares never move when the body's *shape* changes, so
  without the bump an upgraded repository keeps an R4-shaped body and `check` is permanently silent.
  Change the constant, rewrite its doc comment to state the regeneration reason (not the
  readability one it states today), and verify the three landed consequences by test rather than by
  reading: `readModel` throws on the mismatch (`stores.ts:206-211`), `evaluateNoOpShortCircuit`
  turns that throw into "no comparable header" and proceeds (`roots.ts:551-556`), and `status`
  renders its existing "could not be read — run `yg roots index`" paragraph. **Write no migration
  file:** `model.json` is derived state whose only correct migration is regeneration. Also
  **measure both `roles.ts` and `mine.ts` prompt margins now, before editing either** (Global
  constraints), and apply the stated fallback to whichever is under 2000 chars.
- [ ] **Step 2: `exemplars.ts`, pure.** Candidate set, `m1`, centrality and the refined tie-break
  exactly as D4 fixes them; top 3; output `{ rel, line, name }`, `rel` POSIX-normalized. No I/O, no
  clock. The module header states the D4 tie-break refinement **and its reason** (the all-zero
  centrality case in a repository with no co-change pairs) beside the spec citation, since a reader
  comparing the code to §9.11 will otherwise read the extra tuple element as drift.
- [ ] **Step 3: `partitionRouting`, exactly D5's shape.** Emit
  `{ roots: Array<{dir, partitionId: string|null}>, fallback: string|null }` from the same
  `PartitionMap` the mining run already holds: one `roots` entry per detected package-root
  directory (including a `dir: ""` entry when a marker sits at the repo root — a **live** id, never
  a sentinel), each carrying its final id or `null` when the merged bucket was dropped; `fallback`
  carrying the `'_root'` arm's own final id or `null`. Sorted `(dir.length desc, dir asc)`,
  matching `sortedRoots`' descending-length order and adding the total tie-break D5 justifies. It
  is a **projection of an existing decision**, never a second implementation of `keyFor`: one test
  asserts that routing every file the index actually mined reproduces `partitionOfFile` exactly, and
  a second asserts the module-root reconstruction (`''` for `_repo` and for the fallback arm,
  otherwise the matched `dir`) reproduces `moduleRootDirOfFile` exactly.
- [ ] **Step 4: Directional co-change (D20).** `finishCochange` emits `commitsA`/`commitsB` beside
  `sup`/`conf`; the model body's row type widens to match; the cut predicate, the sort and the
  `maxPairs` cut are all **unchanged**, so no golden's co-change expectation moves except by the two
  added keys. State at the field, in the code, that `conf` remains the max of the two directions and
  that the directional confidence is now derivable as `sup / commitsA` (or `sup / commitsB`).
- [ ] **Step 5: Determinism.** All three fields are sorted by their stated total orders and carry no
  wall clock. The existing double-`index --full` byte-identity suite must pass unchanged, and the
  incremental ≡ full suite too — after being re-baselined once for the new body shape, which is a
  regeneration of committed expectations, not a weakening of an assertion.
- [ ] **Step 6: Re-measure the prompt headroom** on `roles.ts`, `mine.ts`, `history-cochange.ts`
  and every other file touched, and report the before/after numbers from Step 1's baseline.
- [ ] **Step 7: Graph ritual + report** — `exemplars.ts` joins the new `roots/speech` node's
  mapping (not `roots/engine`'s), log entries on every log-gated node touched.

**Acceptance criteria — hand-derivable on the landed goldens.**
1. On the TypeScript golden, a named `_all` boolean fact carries exactly 3 exemplars, each of which
   really does hold `expected` for that surface, none of which is a scope `assignments` marks `-1`,
   and whose order matches D4's tuple recomputed by hand from the fixture's own weights and coupling
   figures (the test states the three scores in a comment).
2. A fact with fewer than 3 non-ambiguous conformers renders the ones it has; a fact whose
   conformers are **all** ambiguous falls back to all conformers rather than emitting zero.
3. With `couplingByFile` structurally absent (a golden with history stripped), every candidate's
   centrality is 1 and the ordering is by the second tuple element then `stable_id` — i.e. the
   degraded case has a defined, non-hash order.
3b. **The cell-class split (D4).** For an `_all` fact whose candidate set mixes role members with
   role-less scopes, the ranking uses `(w·centrality, w, stable_id)` and a role-less scope does
   **not** outrank a group member merely by carrying no membership; for a role fact over the same
   scopes the ranking uses `(w·m1·centrality, w·m1, stable_id)`. Both orders are stated by value in
   the test.
4. Routing every mined file through `partitionRouting` reproduces `partitionOfFile` for **every**
   file on every golden, and the module-root reconstruction reproduces `moduleRootDirOfFile` for
   every one of them.
4b. **The root-level-package case, on a purpose-built fixture** (B1's blind spot): a repository
   whose `package.json` sits at the repo root and which clears the 300-scope floor mines under
   partition id `''`, and routing any file in it returns `''` — **not** silence. A second fixture
   whose only package root is dropped by the floor routes its files to `null`, and a third with no
   package marker at all routes through `fallback`.
5. Two `index --full` runs on the same tree produce byte-identical `model.json`, header included;
   an incremental index equals a forced full one.
6. **The upgrade actually re-indexes (D3/B2).** With an R4-shaped `model.json` on disk
   (`rootsVersion: 1`, no `exemplars`, no `partitionRouting`) and every one of the eight header
   inputs unchanged, `yg roots index` **rewrites** the file with `rootsVersion: 2` and all three new
   fields — it does not print "already current". Driven through the built binary, since the
   short-circuit is a command-layer behavior.
7. `commitsA`/`commitsB` on every emitted co-change row equal the per-file commit counts the raw
   accumulator holds, and `sup / commitsA` reproduces `confAB` for a pair whose two directions
   differ (state both numbers in the test). The cut set itself is unchanged from R4's expectation
   on every golden.

**E2E coverage.** `cli-roots-index-verdict-inputs.test.ts`: spawn the built `bin.js`, run
`yg roots index` on a golden fixture repository, read the **committed** `model.json` from disk, and
assert (a) at least one fact carries a non-empty `exemplars` array whose `rel`/`line`/`name` point
at a real scope in a real file at that line, (b) `partitionRouting` is present and routes a chosen
file to the partition that file's facts live in, (c) every co-change row carries `commitsA` and
`commitsB`, (d) the header reads `rootsVersion: 2`, and (e) a second `index --full` leaves the file
byte-identical. A second leg drives the **upgrade** flow that criterion 6 defines: an R4-shaped
`model.json` on disk with every header input unchanged, then `yg roots index` — which must rewrite
it rather than report "already current". The flow driven is an adopter's: *upgrade the CLI, index a
repository, and the committed snapshot now contains what a later check can speak from.*

**Test obligations / mutation round-trips.**
- **MR-5 (ambiguity filter):** delete the non-ambiguous filter ⇒ criterion 1 fails (an ambiguous
  scope enters the top 3 on the fixture chosen for it).
- **MR-6 (tie-break refinement):** drop the middle element of D4's tuple ⇒ criterion 3 fails (the
  degraded ordering collapses to `stable_id`).
- **MR-6b (cell-class split):** apply `m1` to `_all` facts too, with `m1 = 1` for a role-less scope
  ⇒ criterion 3b fails, with the role-less scopes wrongly leading the exemplar list.
- **MR-7 (routing order):** sort `partitionRouting.roots` ascending by length ⇒ criterion 4 fails on
  a nested package root (the outer root shadows the inner one).
- **MR-8 (sentinel collision):** use the empty string instead of `null` as the dropped marker ⇒
  criterion 4b's **first** case fails — the root-level-package repository routes every file to the
  dropped arm and the whole product goes silent. This is the mutation that a plain `_repo`-vs-`''`
  test would have missed, which is why 4b builds the fixture rather than reusing a golden.
- **MR-8b (the universal-match arm):** drop `r.dir === ''` from the lookup ⇒ criterion 4b's first
  case fails again, from the other direction: a root-level marker stops matching anything and every
  file falls through to `fallback`.
- **MR-8c (regeneration):** leave `ROOTS_VERSION` at 1 ⇒ criterion 6 fails — the upgraded index
  short-circuits and the R4-shaped body survives.
- **MR-8d (directional counts):** emit `conf` alone and let T9 divide by it ⇒ criterion 7's
  differing-direction case fails.

**NON-goals.** No verdict, no message, no `check` command. No `stabilityDays`, no `trend`, no
`calib` — those stay structurally absent until R6, and T1's message template omits their notes
accordingly (`v6-spec.md:513`: `{stability_note}` is omitted when absent). No change to the
co-change **cut** (predicate, sort or `maxPairs`) — two added integers per surviving row, nothing
else. No `body_hash` (D11 states why that stays unbuilt and what it costs).

---

## Task 3 — The walking skeleton: `verdict.ts`, a minimal render, and `yg roots check`

**Scope.** The first flow an adopter can run end to end. `verdict.ts` (pure): scope resolution,
candidate facts, specificity governance, surface values, Δ, τ, severity, the channel table. A
minimal `speech.ts` rendering only T1's three-beat body with exemplars. `src/cli/roots-check.ts`
registering `yg roots check <file...>` on the `generic` channel with human-readable stdout. **No**
budgets, dedup, session state, telemetry, ledger, hook protocols or fail-open boundary yet — each of
those is a named later task that widens this same flow and re-runs this same e2e.

**Authorities.** Spec §9.10 in full (`v6-spec.md:447-481`), §9.7 (`:439`), §9.3 (`:385`), §8.6's
sticky rule (`:345`), §8.9 (`:356-358`), §8.10 (`:360-364`), §11.1 (`:505-527`), §19's `check` row
(`:698`); design §3's command row (`integration-design.md:80`), §11's naming table (`:410-426`).

**Files.**
- Create `source/cli/src/roots/verdict.ts`, `source/cli/src/roots/speech.ts`.
- Create `source/cli/src/cli/roots-check.ts` (exactly one `registerRootsCheckCommand` export).
- Edit `source/cli/src/cli/roots.ts` — one line, calling the new registrar.
- Create `source/cli/tests/unit/roots/verdict.test.ts`, `speech.test.ts`,
  `source/cli/tests/unit/cli/roots-check.test.ts` (required by `sibling-test-file`).
- Create `source/cli/tests/e2e/cli-roots-check.test.ts`.

**Interfaces produced.**
```ts
// verdict.ts — pure. Its INPUT is a projection of the snapshot, not the snapshot itself (D9).
export interface VerdictFact {
  // `appliesKind` is NARROWER than `MinedFact`'s `ScopeKind | 'module'` (`mine.ts:123`):
  // the projection DROPS every module-kind fact, matching D6's dropping of module-kind units.
  // Not a typing convenience — a module scope can never be survived (`weights.ts` header), so a
  // module fact can never be hook-eligible, and carrying one into the verdict would be dead
  // weight with a live type hole.
  factKey: string; roleKey: string; surface: string; appliesKind: 'method' | 'type' | 'file';
  expected: string; counts: Record<string, string>; alphabet: string[];
  nConformRaw: number; nTotalRaw: number; tau: number; absence: boolean;
  hookEligible: boolean; denyEligible: boolean; suppressedValue: string | null;
  seeded: boolean; parentExp: string | null; hookShapedConform: number;
  exemplars: ReadonlyArray<{ rel: string; line: number; name: string }>;
}
export type Channel = 'pre' | 'post' | 'bash' | 'stop' | 'generic';
export type Severity = 'WARN' | 'DENY';
export interface Finding {
  stableId: string; scopeKind: string; scopeName: string; relPath: string; line: number;
  fact: VerdictFact; observed: string; deltaBits: number; severity: Severity;
  novel: boolean; downgraded: boolean; localityContrast: boolean;
}
export function evaluate(input: VerdictInput): { findings: Finding[] };   // INPUT ORDER only (R5-I9)
export function channelFilter(channel: Channel, severity: Severity): { severity: Severity; downgraded: boolean } | null;
```

**Steps.**
- [ ] **Step 1: Prove R5-I6 before building on it.** Write the equivalence harness first: take an
  unmodified file from a golden fixture, run the index's own path over the whole repository, run the
  check path's single-file path over that file, and assert `stableId`, `skeyR` and **every** surface
  value agree. **STOP and report** any divergence — a single-file `finalizeUnits` that shifts an
  ordinal or a partition id makes every downstream key wrong, and it is far cheaper to find here
  than in T7's ledger mismatch.
- [ ] **Step 2: Scope resolution, sticky first.** `stickyRole(scope) ?? classify(scope, ctx)`
  (`v6-spec.md:345`), reading `assignments` from the snapshot by `relPath#kind#qualifiedName` —
  which already carries the §6.4 occurrence ordinal (`src/roots/extract.ts:203-204`). A scope stored as
  `'-1'` **stays ambiguous** and gets no role speech; `_all` still applies. File-scope roles follow
  §8.9(b)'s plurality of the same post-edit parse. The rationale belongs in the code, because it is
  the non-obvious half: a deviation that strips a role-defining marker also strips the membership
  evidence, so feature-only reclassification would let the deviating scope escape the role and
  silence exactly the message that should fire.
- [ ] **Step 3: Candidate facts and governance** exactly as D8 fixes them, iterating in
  `(roleKey asc, surface asc)` input order and truncating nothing (R5-I9).
- [ ] **Step 4: The skip ladder, in the spec's order** (`:455-470`): compliance closure would run
  first (T7 — leave the hook in place with a comment stating what fills it and why it must run
  *before* the skips); then `!hookEligible`; then locally demoted (T8); then `v == null`,
  `v == expected`, `v == suppressedValue`; then `Δ < τ`. **Order is behavior, not style:** closure
  before every skip is what makes a fact that has become ineligible still able to close an open
  intervention.
- [ ] **Step 5: Δ, severity, channel.** D7's posteriors; severity as D9's **composed** rule
  `(denyEligible && !novel) ? DENY : WARN` — one expression, both conjuncts, because §9.7's "a
  never-seen value is never denied" (`v6-spec.md:439`) is binding and is invisible if the novelty
  cap lives in a comment; `channelFilter` as a pure total function of `(channel, severity)`
  implementing the complete table, including the DENY→WARN downgrade with its note on every
  non-`pre` channel.
- [ ] **Step 6: Minimal render.** T1's first three lines plus the `See:` line, with the labels
  §9.4i and design §11 fix: `local (<dir>/)` for a directory fact, `repo-wide` in the `_repo`
  partition, `package-wide (<partition>)` otherwise, and the group's medoid label for a role fact.
  The locality contrast sentence renders verbatim when `parentExp ≠ expected`. Everything else of
  Appendix A is T4's.
- [ ] **Step 7: The command.** `yg roots check [file...]`, config-only load (I10 — `findYggRoot` +
  `parseConfig`, **never** `loadGraphOrAbort`; the same delegation `cli/roots.ts` already
  documents), dormant ⇒ print nothing and exit 0, no snapshot ⇒ print nothing and exit 0, a
  snapshot whose `rootsVersion` does not match ⇒ print nothing, record one incident, exit 0.
  Registered from `cli/roots.ts` (never from `cli/entry` — the fan-out pin), exit 0 on every verdict
  outcome, exit 1 only on the argument-validation carve-out R5-I1 names.
- [ ] **Step 8: The no-argument file set (D11).** With no positional paths and no `--hook`, the file
  set is `getDirtyFiles(repoRoot)` (`src/utils/git.ts:125`) and **every** scope in those files is
  evaluated — the declared, budget-bounded superset of §19's `body_hash`-filtered set, for the
  reason D11 gives (`body_hash` is not extracted, and adding it forces a whole-history re-parse).
  The command's own help text and `docs/roots.md` say what it does in plain terms ("checks the files
  you have changed"), never mentioning the superset — that belongs in the plan and the code comment,
  not in a user's face. Git unavailable or a shallow clone ⇒ empty set ⇒ silence plus one
  `debugWrite` line.
- [ ] **Step 9: Graph ritual + report.**

**Acceptance criteria — the arithmetic, by value, at the §4.5 defaults.**
Every row below is a unit test whose numbers appear in a comment. `p̂(v) = (n_v + ½)/(n_eff + K/2)`.

| Fact | K | Δ | τ | Fires? |
| --- | --- | --- | --- | --- |
| boolean, `counts {true:3, false:0}`, observed `false` | 2 | `log2((3.5/4)/(0.5/4)) = log2 7 = 2.807` | 2.5 | **yes** |
| boolean, `counts {true:6, false:0}`, observed `false` | 2 | `log2 13 = 3.700` | 2.5 | **yes** |
| absence (`expected false`), `counts {false:20, true:1}`, observed `true`, **vocabulary** tier | 2 | `log2((20.5/22)/(1.5/22)) = log2(41/3) = 3.7724` | 3.5 | **yes** |
| the same fact at the **structural** tier | 2 | 3.7724 | 4.5 | **no** |
| categorical, alphabet size 4, `counts` all 20 at `expected`, observed **outside** the alphabet | 5 | `log2((20.5/22.5)/(0.5/22.5)) = log2 41 = 5.358` | 2.5 | **yes**, WARN-capped, novelty note |
| boolean at share 2/3, `counts {true:2, false:1}`, observed `false` | 2 | `log2((2.5/4)/(1.5/4)) = 0.737` | 2.5 | **no** |

Rows 3 and 4 are the **same numbers under two τ values** on purpose: they are the only pair that
proves the two absence tiers are read from the fact rather than hard-coded. Row 5 reproduces
Appendix E.6 exactly (`v6-spec.md:920` — 5.36); row 1 reproduces E.1's `log2(2·n_eff + 1)` identity
(`:905`); row 6 sits under E.2's stated supremum of 1.0 bit at share 2/3 (`:907`).

Additional criteria:
7. **Governance.** A scope governed by a role fact, a directory fact and an `_all` fact on the same
   surface produces **exactly one** finding, from the smallest `nTotalRaw`; with equal
   `nTotalRaw`, the role wins over the directory, which wins over `_all`.
8. **Ambiguity is silence.** A scope stored as `'-1'` produces no role-fact finding and still
   produces its `_all` finding.
9. **Decorative roles contribute nothing.** A role with `role_lift ≤ 0` yields neither facts nor
   shadows; its members fall back to `_all` (`isDecorativeRole`, `roles.ts:598`).
10. **The channel table, complete.** For each of the five channels × two severities, the returned
    pair matches the table: `pre` passes DENY and drops WARN; the other four pass WARN and downgrade
    DENY with the note. **Nothing in this table depends on the model** — it is exercised with
    synthetic findings.
11. **Out-of-domain is not a deviation.** A surface whose domain excludes the scope yields `null`
    and no finding, distinct from a sparse boolean's absent-means-false.
12. Exit code is **0** for: findings, no findings, dormant project, missing snapshot, unreadable
    snapshot, a **version-mismatched** snapshot (an R4-shaped `model.json` after the D3 bump — which
    additionally prints nothing and records exactly one incident), and a path outside the
    repository. Exit is **1** only for the argument-validation carve-out R5-I1 names, and T5
    criterion 3 is its one instance.
13. **The no-argument form (D11).** On a golden with two dirty files and one clean one, bare
    `yg roots check` evaluates every scope in the two dirty files and none in the clean one; with
    an explicit path argument it evaluates that file whether or not it is dirty. With git
    unavailable the same invocation is silent and exits 0.

**E2E coverage.** `cli-roots-check.test.ts` drives the adopter flow end to end on a golden fixture:
`yg roots index`, then edit a file to violate a mined convention, then `yg roots check <file>` —
asserting exactly one message, its three-beat shape, its `N of M established` evidence phrase, and a
`See:` line pointing at a real file and line; then revert the edit and assert **silence** and exit
0. The silence half is not decoration: precision is the product, and a check that cannot be quiet
is worse than no check. The same file drives the **bare** form (D11): with the deviation planted and
uncommitted, `yg roots check` with no arguments finds it; with the tree clean, it is silent.

**Test obligations / mutation round-trips.**
- **MR-9 (sticky roles):** replace `stickyRole(scope) ?? classify(...)` with `classify(...)` alone ⇒
  the e2e's strip-a-role-marker case goes silent (the deviating scope escapes its role) — the exact
  50 %→93 % detection effect §8.6 records.
- **MR-10 (governance smallest-first):** pick the **largest** evidence class ⇒ criterion 7 fails.
- **MR-11 (τ from the fact):** hard-code `preferenceGapBits` in the verdict ⇒ acceptance row 4 fires
  when it must not.
- **MR-12 (⊥ pricing):** treat an unseen value as an in-alphabet zero-count value ⇒ row 5's Δ and its
  novelty flag both change.
- **MR-13 (channel downgrade):** make the non-`pre` channels pass DENY through unchanged ⇒
  criterion 10 fails, and R5-I3 is broken in the one direction it forbids.
- **MR-12b (novelty cap):** delete the `!novel` conjunct from D9's severity rule ⇒ a test driven
  from a **synthetic DENY-eligible** fact with an out-of-alphabet observed value now yields DENY
  where it must yield WARN. This is the killer M8 identified as missing: MR-12 kills the ⊥
  *pricing*, and nothing else in the plan observes the *cap*. The test lives beside criterion 10's
  synthetic-severity cases, since no real R5 snapshot can reach it.
- **MR-14 (domain skip):** treat out-of-domain as `false` ⇒ criterion 11 fails and every
  undecidable surface becomes a deviation.
- **MR-14b (no-argument file set):** make the no-argument form a silent no-op ⇒ criterion 13's first
  case fails. Conversely, widening it from the dirty set to the whole repository ⇒ criterion 13's
  clean-file clause fails.

**NON-goals.** No budgets, dedup or session state (T6); no telemetry, ledger or closure (T7); no
hook channels or stdin (T5); no demotion (T8); no bash sweep or completeness (T9); no `status`
changes (T10).

---

## Task 4 — The verbalizer and the complete message catalog

**Scope.** `speech.ts` grown to the whole of §11.1–§11.2 and Appendix A: one generic phrase per
enumerator, every note the template can carry, every deviation phrase, and the naming table applied
to every rendered string.

**Authorities.** Spec §11.1 (`v6-spec.md:505-527`), §11.2's binding table (`:529-549`), §9.4i's
locality labels and contrast sentence (`:427-429`), §10.1's witness argument (`:490-496`), Appendix
A (`:770-817`), Appendix B's per-row verbalizer obligation (`:819-844`); design §11's naming table
(`integration-design.md:410-426`).

**Files.** Edit `source/cli/src/roots/speech.ts`; create
`source/cli/tests/unit/roots/speech-verbalizer.test.ts`; extend
`source/cli/tests/e2e/cli-roots-check.test.ts` with the phrase assertions this task makes possible.

**Steps.**
- [ ] **Step 1: One table-driven row per enumerator**, transcribed from §11.2 and cross-checked
  against Appendix B's own repetition of it — including the `nameshape`/`filenameshape` row, which
  is **named by example, never by the raw shape string** (`(Ua)+` is not human speech), and the
  `stshape` row's 60-character truncation.
- [ ] **Step 2: The unknown-surface rule is a lint, not a runtime error** (`:547`). An enumerator
  with no row renders `{surface} = {value}` and **fails a test that enumerates every surface prefix
  the twelve enumerators can emit** against the table's keys. That test is the mechanism; the
  fallback string exists so a future enumerator cannot crash a hook.
- [ ] **Step 3: Every note the template carries**, each independently switchable and independently
  tested: `{hook_shaped_note}` (" (N echo-shaped conformers excluded from evidence)" — **a
  deliberate divergence from the spec's own literal string** " (N hook-shaped excluded from
  evidence)" (`v6-spec.md:513`), flagged here the way D10 flags the channel names so a reviewer does
  not read it as a transcription error: design §11's naming table (`integration-design.md:410-426`)
  maps `hook_shaped` to "echo-shaped" precisely because "hook-shaped" is internal vocabulary, and
  R5-I14 makes the naming table binding on every rendered string), `{seed_note}` (" (+seeded)"),
  `{novelty_note}`, `{stability_note}` (**omitted** in R5 — `stabilityDays` is structurally absent
  until R6, and the spec's own rule at `:513` is "omitted when absent"), and the locality
  contrast sentence. No transition text ever renders in a message (T3 is report-only, `:511`).
- [ ] **Step 4: `{unit_plural}` from `appliesKind`** — methods / types / files / directories — and
  the per-row deviation phrase ("does not…", "is `<observed>`" for categoricals), which design §12
  names as a productionized gap the prototype left generic (`:464`).
- [ ] **Step 5: T2's DENY reason text** lands complete and unreachable (D9), so R6 turns DENY on
  without touching this file.
- [ ] **Step 6: The naming-table test.** A single test asserts that no rendered message in the whole
  corpus of fixtures contains any of the forbidden internal tokens (`FACT`, `pid`, `surface=`,
  `factKey`, `roleKey`, `Δ`, `tau`, `_all`, `hook_shaped`, `d[`). This is R5-I14's killer, and it is
  worth more than any individual phrasing assertion.
- [ ] **Step 7: Graph ritual + report.**

**Acceptance criteria.**
1. Every §11.2 row renders both its `expected = true` and its `expected = false` form (where the row
   has one) for a hand-built fact, matching the spec's text word for word.
2. The `nameshape` row renders three example names and **never** the shape string.
3. A directory fact whose `parentExp ≠ expected` renders the `local (<dir>/)` label and appends the
   locality sentence verbatim; the same fact with `parentExp == expected` renders neither.
4. A fact with `hookShapedConform = 2` renders the echo-shaped note with N = 2; with 0 it renders no
   note at all.
5. The naming-table test passes over every fixture message, and fails if any forbidden token is
   reintroduced (demonstrate by reintroducing one).
6. The T1 body is exactly the spec's four lines in order, with the optional `{named_fix_line}`
   absent (no recognizer pack ships — `integration-design.md:474-478`).

**E2E coverage.** The extension to `cli-roots-check.test.ts`: after planting a deviation of a
*known kind* on a golden fixture (a dropped supertype, a missing decorator, an alien name shape),
the message an adopter sees contains the exact §11.2 phrase for that enumerator — proving the
verbalizer is reachable through the real command, not just callable in a unit test.

**Test obligations / mutation round-trips.**
- **MR-15 (row completeness):** delete one enumerator's row ⇒ Step 2's coverage test fails naming
  that enumerator.
- **MR-16 (nameshape by example):** render the shape string instead of examples ⇒ criterion 2 fails.
- **MR-17 (locality contrast):** render the contrast sentence unconditionally ⇒ criterion 3's second
  case fails, and every fact starts claiming to be a local exception.
- **MR-18 (naming leak):** render the raw `factKey` in the header line ⇒ criterion 5 fails.

**NON-goals.** No T5 completeness message (T9), no T6 seed-tension or T8 export text (R8), no T7
agentShare alarm rendering (T10 owns where it prints).

---

## Task 5 — Channels, hook protocols, and the fail-open boundary

**Scope.** `--hook pre|post|bash|stop|generic`, `--session`, `--content`, `--as`; the stdin payload
and the exact JSON each channel emits; the single fail-open boundary with its harness rethrow; path
safety; the hard deadline.

**Authorities.** Spec §12.1–§12.3 (`v6-spec.md:562-580`), §12.5's deadline (`:586`), §12.7's
staleness (`:592-593`), §21.1–§21.2 (`:719-720`); design §3's command row
(`integration-design.md:80`), §8.1's protocol path (`:316-338`), §9's DENY boundary (`:365-383`),
§13's hook-integration suite (`:510-511`).

**Files.** Edit `source/cli/src/cli/roots-check.ts`; create
`source/cli/tests/unit/cli/roots-check-channels.test.ts`; create
`source/cli/tests/e2e/cli-roots-check-channels.test.ts`; create recorded stdin fixtures under
`source/cli/tests/fixtures/roots-hook-payloads/`.

**Steps.**
- [ ] **Step 1: Input resolution, per D10.** Payload-then-flags-then-positional precedence, stated
  once in the file header as a table. Stdin is read **only** when `--hook` was passed and stdin is
  not a TTY; the read is bounded and the whole run is wrapped in the `budgets.hookHardTimeoutMs`
  (900) watchdog, whose expiry is a silent exit 0 plus one incident — never a hang, because a hook
  that hangs is worse for an agent than a hook that says nothing.
- [ ] **Step 2: Per-channel output, exact.**
  - `generic` — request `{files:[{path,newContent}], sessionId?, channel?}` → response
    `{verdicts:[{path, scopeKind, scopeName, line, surface, expected, observed, severity,
    deltaBits, message}]}` (`v6-spec.md:577`). This is the machine surface and the one place a
    field named `surface` legitimately appears — it is JSON for a tool, not prose for a human, so
    R5-I14 is satisfied by the `message` field carrying the human text.
  - `post` — findings ⇒ `{"decision":"block","reason": MSG}`; no findings ⇒ **nothing at all**.
  - `pre` — R5 can produce no DENY (D9), so: nothing, exit 0, always. The code path that would
    emit `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}`
    is written and unreachable, with a test driving it from a synthetic DENY finding.
  - `stop` — honors `stop_hook_active` (`v6-spec.md:576`) (a payload flag: when set, do nothing and exit 0, or the
    hook loops); its own content is T9's.
  - `bash` — accepted here as a channel; its sweep behavior is T9's.
  - **Non-hook** (no `--hook`) — channel `generic` semantics with **human-readable** stdout, per
    design §3's row: the protocol path an agent uses directly is a person-readable surface.
- [ ] **Step 3: The one boundary.** Wrap the entire entry point. On any throw: zero findings, one
  incident (stage + message), the channel's own "nothing to say" output, exit 0. Verify the shape
  by **stage-fault injection** — a parse failure, a missing grammar, a corrupt session file, a
  malformed model row, a corrupt demotions file — each producing exactly one incident and zero
  findings. The harness option rethrows instead.
- [ ] **Step 4: Path safety (§21.2).** Every input path is realpath-resolved and must lie inside the
  repository; one incident per session for the whole class, not one per path; symlink escape
  refused. A rejected path is silence, not an error.
- [ ] **Step 5: Staleness (D17).** Compute the cheap tuple, and when it differs from the snapshot
  header, record the staleness modulator for T10's `status` line and note it on any message that
  would have been DENY (in R5, none). Say in the code exactly which input is **not** compared and
  who catches it.
- [ ] **Step 6: Graph ritual + report.**

**Acceptance criteria.**
1. Each of the five channels, driven by a recorded stdin fixture, produces byte-exact expected
   output — including the two "nothing" cases (`post` with no findings; `pre` always).
2. `stop_hook_active: true` produces no output and exits 0.
3. `--content <p> --as <q>` evaluates the content of `p` as though it lived at `q`, and the emitted
   `path` is `q`. `--content` with more than one positional file is a what/why/next error and exit
   **1** — the single argument-validation carve-out R5-I1 already names and scopes, raised before
   any evaluation begins, wrapped in `buildIssueMessage` exactly as `cli-command-contract` requires
   of an option-mutex violation. It is refusing to run, not reporting a finding.
4. Fault injection at each of the five named stages yields zero findings, exit 0, and **exactly
   one** incident; with the harness option the same injection throws.
5. A path outside the repository yields silence and one incident for the session, however many such
   paths were passed.
6. **On a `--hook` channel**, a run whose stdin is a TTY and which was given no file arguments
   exits 0 having read nothing — a hook with nothing to look at has nothing to say. **Without
   `--hook`** the same invocation is D11's no-argument form and resolves the dirty set instead (T3
   criterion 13); the two are pinned in the same test so the split cannot be read as an
   inconsistency.

**E2E coverage.** `cli-roots-check-channels.test.ts`: for each channel, spawn the built binary with
the recorded payload on stdin and assert the exact stdout and exit code; then re-run the `post`
channel against a fixture repository whose snapshot has been corrupted on disk and assert silence,
exit 0, and one incident line in `.state/incidents.jsonl`. The flow driven is the one a hook runtime
drives — which is the only way to prove the JSON contract an agent host will actually parse.

**Test obligations / mutation round-trips.**
- **MR-19 (one boundary):** move the catch inside the per-file loop ⇒ criterion 4's "exactly one
  incident" fails for a multi-file run and a partial result escapes.
- **MR-20 (harness rethrow):** make the harness option fail open too ⇒ criterion 4's second half
  fails, and every future mutation-harness crash would report as a clean run.
- **MR-21 (`stop_hook_active`):** ignore the flag ⇒ criterion 2 fails (and a real host would loop).
- **MR-22 (path safety):** drop the realpath containment test ⇒ criterion 5 fails.

**NON-goals.** No sweep, no completeness (T9). No hook *installer* (R8). No `permissionDecision`
ever emitted from a real snapshot (D9).

---

## Task 6 — Session state, budgets, dedup

**Scope.** `session-state.ts` (pure fold), the session identity ladder in the command layer, and
§11.3 applied as the single ordering and truncation authority.

**Authorities.** Spec §11.3 (`v6-spec.md:551`), §11.4 (`:554-556`), §12.5 (`:586`); design §8.1's
session-identity ladder (`integration-design.md:329-334`), §12's "sessions as append-only event
logs" row (`:465`).

**Files.** Create `source/cli/src/roots/session-state.ts`; edit `verdict.ts`/`roots-check.ts` to
route findings through it; create `source/cli/tests/unit/roots/session-state.test.ts`; create
`source/cli/tests/e2e/cli-roots-check-budgets.test.ts`.

**Steps.**
- [ ] **Step 1: The fold.** `foldSession(events) → { warnCount, dedupKeys, openInterventions,
  fileState, seedTruncated, floodSkipped, lastSweepTs, completenessEmitted }`. Pure, total, and
  **idempotent under duplicate events** (D13) — a replayed event must not double-count a warning.
- [ ] **Step 2: Dedup, WARN-only.** Key `(stable_id, surface, direction)`; DENY never deduplicated,
  with the reason in the code: a block a retry defeats is not a block, and repeated denies are
  naturally rate-limited because the denied edit never lands.
- [ ] **Step 3: Budgets.** Per response ≤ 3 ordered `(severity desc, Δ desc, surface asc)`; per
  session ≤ 12 WARNs, then DENY only. Both read the **post-`channelFilter`** severity. The overshoot
  bound from concurrent hook processes is documented at the function, not locked against.
- [ ] **Step 4: Identity ladder** in `roots-check.ts` per D12, with each rung's fallback logged once
  at `debugWrite` level so a support question about merged budgets is answerable.
- [ ] **Step 5: Pruning.** `sessions.pruneDays` (7) applied opportunistically — at most once per
  run, never blocking the verdict, failures swallowed to one `debugWrite` (R5-I15).
- [ ] **Step 6: Graph ritual + report.**

**Acceptance criteria.**
1. Five findings on one response emit **3**, and the three are the top three under
   `(severity desc, Δ desc, surface asc)` — asserted by value on hand-built findings whose Δ values
   are 4.0, 3.7, 3.7, 2.9, 2.6 with two of them sharing Δ so the `surface asc` tie-break is
   exercised.
2. The same `(stable_id, surface, direction)` warned twice in one session emits once; the same
   `stable_id` and `surface` with a **different** observed value emits again (direction is part of
   the key).
3. A synthetic DENY finding repeated in one session emits **both** times.
4. After 12 WARNs in a session, the 13th is silent, and a synthetic DENY still passes.
5. Replaying the identical event log twice produces identical fold state (idempotence).
6. Two runs sharing an explicit `--session` share the budget; two runs with no `--session` in the
   same process tree and cwd also share it (the ladder's middle rung).

**E2E coverage.** `cli-roots-check-budgets.test.ts`: on a fixture with many planted deviations,
spawn the built binary repeatedly with one `--session <id>`, and assert across the sequence that at
most 3 messages appear per invocation, that a repeated deviation is silent the second time, and that
the session log on disk contains exactly the events those outcomes imply. The flow is an agent's
real session: many edits, bounded interruption.

**Test obligations / mutation round-trips.**
- **MR-23 (dedup direction):** drop `direction` from the key ⇒ criterion 2's second case fails and a
  changed deviation goes unreported.
- **MR-24 (DENY never deduped):** include DENY in dedup ⇒ criterion 3 fails.
- **MR-25 (post-filter severity):** read severity **before** `channelFilter` ⇒ a downgraded DENY
  escapes both the WARN budget and the dedup, which criterion 4 catches with a downgraded finding
  after the 12th warn.
- **MR-26 (single truncation authority):** add a second `.slice(0, 3)` in the command layer ⇒ a test
  asserting the exact ordering of a 5-finding response before and after the budget stage fails
  (R5-I9's killer).

**NON-goals.** Telemetry and closure (T7). Sweep state is folded here but not *populated* until T9.

---

## Task 7 — Compliance closure, telemetry, and ledger writing

**Scope.** The loop that makes §18 real: record every message as an intervention, notice at the next
sight of the same (scope, surface) whether the agent complied, write the telemetry line and — on
compliance — the committed ledger mark.

**Authorities.** Spec §9.10's `closeIntervention` paragraph (`v6-spec.md:479`), §18.1 (`:681`),
§18.3 (`:685`); design §13's compliance-loop E2E (`integration-design.md:501-504`), §12's
"compliance closure with the once-per-session ignored bound" row (`:437`).

**Files.** Edit `verdict.ts` (the closure hook T3 left in place), `roots-check.ts` (applying
intents); create `source/cli/tests/unit/roots/verdict-closure.test.ts`; create
`source/cli/tests/e2e/cli-roots-compliance-loop.test.ts`.

**Steps.**
- [ ] **Step 1: Closure runs before every skip** (T3 Step 4's ordering), for every candidate fact of
  every evaluated scope, whether or not that fact will speak. It emits **no message** and is exempt
  from budgets (`:462`).
- [ ] **Step 2: The two branches.** Open intervention on `(stable_id, surface)` and `v == expected`
  ⇒ telemetry `observedAfter: complied` **and** a ledger mark. Open and still deviating ⇒
  `observedAfter: ignored`, **at most once per session per intervention** — the open record carries
  the session that would close it, so a re-view inside the same session is not a fresh ignore. State
  the measured reason in the code: without the bound, a sweep or an agent re-reading a file before
  editing inflates the `ignored` denominator and can demote a 96 %-share convention within minutes.
- [ ] **Step 3: Intents, applied in D14's order** by the command layer, each append idempotent under
  its key.
- [ ] **Step 4: What a mark costs, said out loud.** The ledger append makes `git status` dirty and
  makes the next `index` do real work (D15). Both are intended; both go in the docs at T11.
- [ ] **Step 5: Graph ritual + report.**

**Acceptance criteria.**
1. **The closed loop, by value:** deviation → one WARN → the file is fixed → the next check is
   **silent**, and exactly one `complied` telemetry line and exactly one ledger mark exist, with the
   mark's `(stableId, surface)` equal to the intervention's.
2. Three checks of the same unfixed scope in one session produce exactly **one** `ignored` record.
3. The same scope still unfixed in a **new** session produces a second `ignored` record (the bound
   is per session, not forever).
4. A fact that has become hook-**ineligible** since the intervention still closes it (Step 1's
   ordering).
5. A ledger mark already present is not appended twice (T1's dedupe, exercised through the real
   flow).
6. Telemetry records carry `expected`, `observed`, `deltaBits` and `factKey` and **no role key**
   (§18.1's "role-free keys") — the field is absent, not empty.

**E2E coverage.** `cli-roots-compliance-loop.test.ts` — the design's own named suite
(`integration-design.md:501-504`), miniaturized: spawn the built binary, `index`, plant a deviation,
`check` (assert the WARN), fix the file, `check` again (assert silence), then read
`.state/telemetry.jsonl` and the committed `ledger.jsonl` from disk and assert exactly one
`complied` and exactly one mark. This is the single most important e2e in the increment: it is the
only proof that the product's regulator is a closed loop rather than three unconnected files.

**Test obligations / mutation round-trips.**
- **MR-27 (closure before skips):** move `closeIntervention` after the `hookEligible` skip ⇒
  criterion 4 fails.
- **MR-28 (ignored bound):** remove the once-per-session bound ⇒ criterion 2 fails with three
  records, and demotion becomes reachable within one session.
- **MR-29 (mark on compliance only):** write the mark on the `ignored` branch too ⇒ criterion 1's
  mark count fails, and roots would discount evidence it never shaped.
- **MR-30 (write order):** apply intents before writing output ⇒ a test that kills the process
  between the two stages leaves an intervention with no message — assert the ordering directly by
  the intents applier's own call sequence, since the crash itself is not reproducible in-process.

**NON-goals.** Demotion math (T8). Cross-session closure (T8 — it runs at index, not in a hook).

---

## Task 8 — Convention health, demotions, and the index-time aggregation

**Scope.** §18.2 in full: pooling, the expected-flip filter, the cross-session closure pass, the
Wilson lower bound, `demotions.json` and its stamp, and the telemetry compaction that rides the same
transaction.

**Authorities.** Spec §18.2 (`v6-spec.md:683`), §14's Wilson conventions (`:637` — z = 1.96
two-sided, **fixed**), Appendix E.7 (`:915`); design §12's "per-fact expected-flip filter plus the
cross-session closure pass in demotion pooling" row (`integration-design.md:447-448`).

**Files.** Create `source/cli/src/roots/health.ts`; edit `src/cli/roots.ts` (the `index` action, to
run the aggregation inside the build lock, and the `status` renderer to compute-without-writing);
create `source/cli/tests/unit/roots/health.test.ts`; create
`source/cli/tests/e2e/cli-roots-demotion.test.ts`.

**Steps.**
- [ ] **Step 1: Pooling — and the resolution step that makes it work at all.** §18.2 says "pooled
  per `factKey` … **via current membership**", and the emphasis is the whole instruction. A
  telemetry record carries the `factKey` that was true when the message fired, and a role key is
  `sha256(sorted member stable_ids)[:12]` with **no cross-build inheritance** (`v6-spec.md:353`) —
  it changes on *every* re-induction. Grouping by the recorded string therefore pools nothing after
  the first re-induction, silently, and produces a demotion engine that passes every fixture and
  never fires in production. So the pass resolves each event forward: `stableId` → the current
  scope in the snapshot → its current role (or `_all`/its directory context) → the **current**
  `factKey`, and pools on that. An event whose `stableId` no longer resolves — the scope is gone, or
  its partition changed, which moves `stableId` itself (`extract.ts:628`) — is **dropped**, not
  guessed at. Then filter to events whose recorded `(surface, expected)` matches the current fact —
  an expected flip must not poison the pool. Resolved = has `observedAfter`; unresolved excluded
  from the denominator.
- [ ] **Step 2: Cross-session closure.** The aggregation also closes interventions left open by
  ended sessions: current index shows the pair at `expected` ⇒ a `complied` sample **and** the §18.3
  mark (same dedupe); the pair exists and still deviates ⇒ an `ignored` sample; the scope is gone ⇒
  the intervention is dropped. The `ignored` branch is load-bearing and the code says why: without
  it the dominant real path — agent warned, moves on, session ends — never enters the denominator,
  compliance is biased high, and precisely the conventions agents ignore never demote.
- [ ] **Step 3: The bound.** Demote when `WilsonLB95(compliance) < health.minCompliance` (0.3) with
  ≥ `health.minSamples` (8) resolved. z = 1.96 two-sided, fixed, not configurable.
- [ ] **Step 4: The stamp.** `demotions.json` carries `snapshotContentHash` from T1's helper; the
  check path ignores a mismatched stamp, which resurrects a demoted fact rather than silencing a
  healthy one (§18.2's stated direction).
- [ ] **Step 5: Where it runs (D16), precisely.** Inside `yg roots index`, **after** the D13 no-op
  short-circuit has made its decision and regardless of what it decided — because telemetry moves
  none of the eight inputs that short-circuit compares, and an aggregation that only ran on a
  mining run would never fire on the quiet repositories demotion exists for. It takes **no build
  lock** (D16.3) and it **writes only when the computed content differs from what is on disk**
  (D16.4), so a repository with no telemetry still performs the zero writes R4's no-op test asserts.
  At `status`: computed for display, **nothing written** — and specifically, `health.ts` *returns*
  the cross-session ledger marks as intents (D1's seam) and only `index` applies them, because
  §18.2's cross-session `complied` branch appends a **committed** ledger mark and a read surface may
  not (R5-I8). Telemetry compaction (`health.telemetryRetentionDays`) runs beside the aggregation,
  under the same write-only-on-change rule.
- [ ] **Step 6: Graph ritual + report.**

**Acceptance criteria — by value.**
1. **Wilson, hand-derived.** With 2 complied and 8 ignored (n = 10, p̂ = 0.2), `WilsonLB95` is
   **0.0567** (to 4 dp) — below 0.3 with n ≥ 8 ⇒ **demoted**. With 5 complied and 5 ignored
   (n = 10, p̂ = 0.5), `WilsonLB95` is **0.2366** ⇒ still below 0.3 ⇒ demoted. With 7 complied and
   3 ignored (n = 10, p̂ = 0.7), `WilsonLB95` is **0.3968** ⇒ **not** demoted. Each number appears in
   a comment beside its inputs, and the boundary case is the point: a convention followed 7 times in
   10 keeps speaking; one followed twice in ten does not.
2. n = 7 resolved samples at p̂ = 0 does **not** demote (below `minSamples`), and unresolved
   interventions are absent from the denominator entirely.
3. An event recorded under a **different** `expected` for the same surface is excluded from the pool
   (the flip filter), demonstrated with a pool that demotes with the stale events and does not
   without them.
3b. **The pool survives a re-induction (M3).** Eight ignored samples are recorded, then a member is
   added to the fact's role so its `role_key` changes, then the aggregation runs: the fact still
   demotes. The recorded `factKey` strings in `telemetry.jsonl` no longer match any current fact —
   the resolution through `stableId` is what finds them.
4. Cross-session closure over a session log whose session is gone produces the three outcomes of
   Step 2 on three hand-built scopes.
5. A `demotions.json` whose stamp does not match the current snapshot is ignored: the fact speaks.
6. `status` reports the same demotion count `index` would write, and **writes nothing** — asserted
   by mtime and content on `demotions.json` **and on the committed `ledger.jsonl`**, on a repository
   that has open cross-session interventions whose scopes now sit at `expected` (i.e. the case that
   would otherwise append a mark from a read surface). Both files are byte-identical across the
   `status` run.
7. **Demotion happens on an otherwise-unchanged tree (B2).** With HEAD, config, seeds, ledger,
   bindings and the dirty set all unchanged — so `yg roots index` takes the no-op short-circuit and
   writes neither `model.json` nor anything under `.cache/` — a repository carrying ≥ 8 resolved
   ignored samples still ends that run with the fact demoted in `demotions.json`. Asserted through
   the built binary, and paired with its converse: the same run on a repository with **no**
   telemetry writes nothing at all, `demotions.json` included.

**E2E coverage.** `cli-roots-demotion.test.ts`: drive a whole ignore cycle through the built
binary — plant a deviation, check (WARN), leave it unfixed across ≥ 8 distinct `--session` ids,
run `yg roots index`, then check again and assert **silence** for that fact while a different fact
still speaks. This is the product promise "a convention agents keep ignoring stops interrupting
them", proven the only way it can be: from the outside.

**Test obligations / mutation round-trips.**
- **MR-31 (expected-flip filter):** remove the filter ⇒ criterion 3 fails.
- **MR-32 (cross-session `ignored` branch):** record only `complied` on the cross-session pass ⇒
  criterion 4 fails and nothing ever demotes in the dominant real path.
- **MR-33 (stamp check):** honor a stale stamp ⇒ criterion 5 fails and a stale demotion silences a
  live fact.
- **MR-34 (point estimate vs lower bound):** demote on the **point estimate** instead of the Wilson
  lower bound ⇒ **criterion 1's 5/10 row fails**, and no new case is needed to see it: p̂ = 0.5 is
  ≥ `minCompliance` 0.3 so the mutant does not demote, while `WilsonLB95(5/10) = 0.2366 < 0.3` so
  the rule does. (The 2/10 and 7/10 rows agree under both readings, which is exactly why the 5/10
  row is in the criterion.) The lower bound is what makes demotion require a sample large enough to
  be sure, not merely a low ratio.
- **MR-34b (current-membership resolution):** pool on the telemetry record's **recorded** `factKey`
  instead of re-resolving it ⇒ a criterion whose fixture re-induces roles between the interventions
  and the aggregation finds an empty pool and demotes nothing. Add that fixture as criterion 3b: the
  same eight ignored samples, with one member added to the role between the last warning and the
  index, must still demote.

**NON-goals.** Calibration and its UB-demotion branch (R6). `report`'s health section (R7).

---

## Task 9 — The Bash sweep and the Stop channel

**Scope.** §12.4's content-hash sweep and §13.5's completeness note — the two channels whose
behavior is stateful rather than per-file.

**Authorities.** Spec §12.4 (`v6-spec.md:583`), §12.2's `claude-stop` clause (`:576`), §13.5's
completeness paragraph (`:625`) and its directional confidence (`:621`), Appendix A's T5
(`:791-796`), Appendix G.4 (`:1020`); the R4 plan's own assignment of the sweep to R5
(`2026-08-20-increment-3-r4-history.md:2320-2321`); the landed row shape
(`src/roots/history-cochange.ts:94`, `:109-112`, `:394-398`).

**Files.** Edit `session-state.ts` (sweep state), `roots-check.ts` (the two channels), `speech.ts`
(T5); create `source/cli/tests/unit/roots/sweep-state.test.ts`; create
`source/cli/tests/e2e/cli-roots-check-sweep.test.ts`.

**Steps.**
- [ ] **Step 1: Seed, silently.** The first sweep seeds `fileState` from `getDirtyFiles`'s porcelain
  listing — **never** by hashing the whole tree — and emits nothing: pre-existing dirt is not the
  session's doing. Over `budgets.bashFloodThreshold` (20) entries, seeding truncates by path order
  and sets `seedTruncated`, which suppresses messages for unseeded paths for the whole session.
- [ ] **Step 2: Sweep.** Debounce `budgets.bashSweepDebounceMs` (5000) — a skipped sweep needs no
  queue, because the next sweep's hash diff subsumes it. Then list, hash, diff, evaluate at most
  `budgets.bashSweepMaxFiles` (5) changed code files, update `fileState`. Over the flood threshold
  in one sweep ⇒ skip per-file work and set `floodSkipped`.
- [ ] **Step 3: Stop.** Honor `stop_hook_active` (T5). Run the deferred sweep summary **iff**
  `floodSkipped` was set, evaluating the session diff against the **first-sweep** `fileState` once
  and reporting at most `budgets.maxMessagesPerResponse` findings; with `fileState` unset (an
  Edit-only session) it is a no-op.
- [ ] **Step 4: Completeness (D20), over the row shape T2 actually persists.** Gated by
  `hooks.claudeCode.stopCompleteness` and `completeness.mode` (`stop-feedback-once`). D = files
  written this session (from the session log). For each written file `f` and each committed
  co-change row, **both sides are scanned** — `a < b` is canonical, not directional
  (`history-cochange.ts:94`) — so the partner and the denominator are picked by which side `f` is:
  ```
  f === row.a  ⇒  partner = row.b, commits = row.commitsA
  f === row.b  ⇒  partner = row.a, commits = row.commitsB
  confidence(f→partner) = row.sup / commits
  include partner iff row.sup >= cochange.minSupport
                  ∧ confidence(f→partner) >= cochange.minConfidence
                  ∧ partner ∉ D ∧ partner still exists on disk
  ```
  The **directional** confidence is what gates, never the persisted `conf` (which is the max of the
  two directions and would name the partner backwards on every asymmetric pair — D20). If E ≠ ∅
  emit **T5** listing at most `completeness.maxItems` (5) partners, ordered by descending
  confidence then ascending path, each with its `{sup}/{commits}` evidence — the same two numbers
  the gate used, so the message can never show evidence that does not justify it. Once per session.
- [ ] **Step 5: WARN-only, structurally.** Bash-path violations are WARN-only, so file *moves* are
  WARN-only (D21). Say it once, in the code and in the docs.
- [ ] **Step 6: Graph ritual + report.**

**Acceptance criteria.**
1. The first `bash` sweep on a dirty tree emits **nothing** and leaves a seeded `fileState` covering
   exactly the porcelain paths.
2. A second sweep within the debounce window does nothing; after it, a changed file is evaluated and
   an unchanged one is not.
3. 21 dirty paths at seed time set `seedTruncated`, and a message for an unseeded path is suppressed
   for the rest of the session.
4. 21 changed files in one sweep set `floodSkipped` and emit nothing; the following `stop` run emits
   at most 3 findings computed against the first-sweep `fileState`; with `floodSkipped` unset the
   `stop` summary does not run at all.
5. **Completeness, hand-derived from one row.** Snapshot row
   `{a: "src/order.ts", b: "test/order.test.ts", sup: 9, conf: 1.0, commitsA: 9, commitsB: 12}`,
   at the stock `minSupport` 8 / `minConfidence` 0.75:
   - a session that wrote **`src/order.ts`** ⇒ `confidence = 9/9 = 1.0 ≥ 0.75` ⇒ T5 names
     `test/order.test.ts` with evidence **`9/9`**;
   - a session that wrote **`test/order.test.ts`** ⇒ `confidence = 9/12 = 0.75 ≥ 0.75` (the boundary
     holds, inclusive) ⇒ T5 names `src/order.ts` with evidence **`9/12`**;
   - the same row with `commitsB: 20` ⇒ `9/20 = 0.45 < 0.75` ⇒ a session that wrote
     `test/order.test.ts` emits **nothing**, while one that wrote `src/order.ts` still emits. That
     asymmetry is the whole reason T2 persists both counts, and using the persisted `conf` (1.0 in
     every one of these cases) would have emitted all four.
   A second `stop` run in the same session emits nothing; with `stopCompleteness: false` neither run
   emits; a partner that no longer exists on disk is excluded.
6. `stop` on a session with no written files emits nothing.

**E2E coverage.** `cli-roots-check-sweep.test.ts`: drive a realistic bash-shaped session through the
built binary — seed sweep, edit files outside the Edit tool, sweep again, then `stop` — asserting
silence where the spec demands silence and the T5 note where co-change earns it. The flow is the one
an agent produces when it runs a script or a codemod instead of editing file by file, which is
exactly where per-edit hooks see nothing.

**Test obligations / mutation round-trips.**
- **MR-35 (silent seed):** emit findings on the first sweep ⇒ criterion 1 fails, and every session
  would open by blaming the agent for the tree it inherited.
- **MR-36 (flood → stop):** run the stop summary unconditionally ⇒ criterion 4's last clause fails.
- **MR-37 (completeness once):** drop the once-per-session guard ⇒ criterion 5's second run fails.
- **MR-37b (directional confidence):** gate on the persisted `conf` instead of
  `sup / commits<side>` ⇒ criterion 5's third case fails (the `commitsB: 20` session emits a partner
  it must not), which is the false "you forgot to touch X" the row shape alone would have shipped.
- **MR-37c (both sides scanned):** treat `row.a` as always being the edited file ⇒ criterion 5's
  second case fails and every partner on the `b` side goes unreported.

**NON-goals.** No Bash command parsing (D21). No pre-tool move blocking (out of scope by decision).

---

## Task 10 — `status`: modulators, withheld conventions, and the agentShare alarm

**Scope.** The three additions of D22 to the existing `status` renderer, and nothing else.

**Authorities.** Spec §3.3's I2b ("`status` lists every active modulator", `v6-spec.md:81`),
§9.4c.4's withheld explanation (`:409`), §18.4 and Appendix A's T7 (`:687`, `:803-806`), §19's
`status` row (`:697`); design §3's `status` row (`integration-design.md:84`).

**Files.** Edit `source/cli/src/cli/roots.ts` (`renderRootsStatusInner`); create
`source/cli/tests/unit/cli/roots-status-modulators.test.ts` (**new sibling** — the existing status
tests stay as they are); create `source/cli/tests/e2e/cli-roots-status-speech.test.ts`.

**Steps.**
- [ ] **Step 1: Active modulators**, one line each, in plain terms: how many conventions are locally
  quieted, whether the index is behind the current commit, whether a session's sweep was truncated
  or flooded. Names, not mechanisms (R5-I14).
- [ ] **Step 2: The withheld line.** "K conventions withheld: no established instances yet" — the J4
  explanation, computed as the count of accepted facts that failed **only** the survived-display
  gate. On a repository with no history that number is every accepted fact, and saying so is the
  whole point: the product must explain its own silence.
- [ ] **Step 3: The alarm.** When `agentShare ≥ health.agentShareAlarm` (0.85), render T7's text.
  **No exit code** — `--exit-code` is R7's, and until it exists the alarm is information.
- [ ] **Step 4: Everything status already prints stays byte-identical** where none of the three
  conditions holds. Pin that with a test, because a status regression is how a read surface starts
  lying.
- [ ] **Step 5: Graph ritual + report.**

**Acceptance criteria.**
1. A repository with no demotions, a fresh index and no alarm prints exactly what it printed at
   a761dda, byte for byte.
2. A repository with 3 demoted facts prints the quieted-conventions line with 3.
3. A snapshot whose `headSha` differs from the current HEAD prints the behind-the-commit modulator.
4. `agentShare = 0.9` prints T7; `0.84` does not; `null` prints neither the alarm nor a fabricated
   number.
5. Every state still exits **0**.

**E2E coverage.** `cli-roots-status-speech.test.ts`: after driving the T8 demotion cycle through the
built binary, run `yg roots status` and assert the quieted-conventions line reports the same count
the demotion flow produced — the two surfaces agreeing is the assertion, since a status line that
cannot be reconciled with behavior is worse than no status line.

**NON-goals.** `--exit-code`, `--diagnose`, the full report layout (all R7).

---

## Task 11 — Docs, CHANGELOG, dogfood measurement, and the honest-limits pass

**Scope.** Making the shipped documentation true (D24), the one changelog entry, and the measured
numbers this increment owes.

**Authorities.** AGENTS.md's documentation and changelog rules; spec §20.1's budgets (`:712`),
§12.5's latency budgets (`:586`); design §14's docs list (`integration-design.md:520-531`).

**Files.** Edit `docs/roots.md`, `docs/configuration.md` (only where a statement became false),
`CHANGELOG.md`. **Not** `docs/cli-reference.md` (D24). No template edits — therefore no digest
regeneration at the root or in any `examples/*/`.

**Steps.**
- [ ] **Step 1: `docs/roots.md` becomes true.** Three sections are now false and must be rewritten,
  not patched: "What's not here yet → Speak up while you edit" (it does now), the `.state/` row
  ("Nothing writes to it in this release" — everything does now), and the `ledger.jsonl` row
  ("Nothing writes a new mark yet"). Add the two consequences an adopter will actually meet: a dirty
  `ledger.jsonl` after a productive session and what to do with it, and the fact that a check
  **never** fails a build.
- [ ] **Step 2: `docs/roots.md` gains the `check` section** — the flags, the exit-code promise
  (including the one argument-validation exit 1), and the two regimes (a hook runtime drives the
  JSON channels; a person or an agent runs it directly and reads prose), plus what bare
  `yg roots check` looks at ("the files you have changed"). **`docs/cli-reference.md` is deliberately
  not touched** (D24): it documents no `yg roots` command at all today, so nothing in it becomes
  false, and its roots section lands whole in R9. Say so in the report so the omission reads as
  scoped.
- [ ] **Step 3: Verify every claim against the built binary**, not against this plan — the same
  discipline R4's own docs task used. That explicitly includes every worked example: no example may
  set a key to its own default. Two statements in `docs/roots.md` need more than a reword: the
  `ledger.jsonl` row must say that a mark now *appears* after a productive session and that the file
  is meant to be committed with the change, and the `model.json` row must say that upgrading the CLI
  re-indexes once (D3's version bump) rather than silently keeping an older snapshot.
- [ ] **Step 4: CHANGELOG**, per the policy section below.
- [ ] **Step 5: Dogfood measurement (report only).** Against a **copy** of this repository with a
  temporary `roots:` block: index it, then measure the check path — cold run wall time against
  §12.5's 700 ms cold budget, p95 over ~50 files, message counts, and how many of those messages a
  maintainer would call true. Report the numbers and **name the false positives individually** —
  design's own risk 1 says the dogfood is the canary, and a measurement that reports only the mean
  is not a canary. **Do not commit a `roots:` block, a `model.json`, a ledger or any cache into this
  repository** — enabling the dogfood is the maintainer's call (OQ1).
- [ ] **Step 6: Carry-in measurements (R4 debt).** Two numbers R4's own T10 named and this plan
  carries forward (see the Carry-ins section): the D16 pre-image-only blob fraction, and the
  measured global miss-set figure that stands in place of a window constant. Both are **report-only
  and conditional on Step 5 running at all**; if the dogfood measurement is not run, both are
  reported as not-measured with that reason, never as absent.
- [ ] **Step 7: Docs build + markdownlint + graph ritual + report.** State explicitly in the report
  that **no digest regeneration was needed** (D24), so the omission reads as scoped rather than
  forgotten.

**Acceptance criteria.**
1. Every claim in `docs/roots.md` and `docs/configuration.md` is verified against the built
   binary's actual behavior, and `docs/cli-reference.md` is confirmed to contain no statement that
   this increment made false (it documents no roots command — D24).
2. `npm run docs:build` and markdownlint pass; `docs-internal-links` is satisfied.
3. No `.yggdrasil/roots/` directory, no `roots:` block, no ledger and no cache are added to this
   repository.
4. The measurement report names each false positive it found, or states plainly that there were
   none across N messages on M files.

**E2E coverage.** This task ships no code; its gate is the docs build and markdownlint steps of
`repo-check.sh`, plus criterion 1's manual verification against the binary. Stated so the absence is
scoped: a documentation task's proof is that the documented behavior is the behavior, and that is
what criterion 1 asserts.

---

## Increment-wide NON-goals (R6/R7/R8 material that must not leak in)

Naming them so a reviewer can reject them on sight:

- **R6 — trends, calibration, DENY.** No trend windows, no cohort trends, no nucleation detection
  (the verdict's `suppressedValue` skip lands and is permanently inert because nothing sets the
  field), no attractor, no `yg roots calibrate`, no τ_c computation, no Wilson bound anywhere except
  §18.2's demotion (which is R5's by the program plan's own text), no armed DENY, no
  `permissionDecision` emitted from any real snapshot, no `--enable-deny`.
- **R7 — inquiry and reporting.** No `where`, no `spectrum`, no `report`, no `explain`, no
  coverage/debt computation, no `status --exit-code`, no `status --diagnose`, no campaign export.
  In particular: **no surface in R5 may print a Δ, a τ, a `factKey`, a `surface` id or a cell key to
  a human** — that is `explain`'s job and `explain` is R7's.
- **R8 — promotion and steering.** No `promote`, no advise nomination class, no `seed add/list/rm`,
  no `mute`, no `reset`, no `hooks install`, no `--git` trigger.
- **R9/R10.** No `rules.ts`/`digest.ts` roots section (and therefore no digest regeneration at the
  root or in any `examples/*/`), no `yg check` informational line, no knowledge topics, no schema-doc
  entry, no mutation harness, no remaining grammar goldens, no big-corpus sweep, no new repo-check
  step.
- **Excluded by design, permanently.** No daemon or socket (`integration-design.md:373-383`), no
  `check --exit-code`, no `scaffold`, no recognizer pack (§10.2 ships none, and a named-fix layer
  must be earned from message-quality telemetry rather than designed ahead of it), no `EXT2GRAMMAR`
  of roots' own.

**One declared scope reduction, recorded here rather than left as a quiet divergence.** §19's
non-hook scope set — "scopes whose `body_hash` differs from HEAD" (`v6-spec.md:698`, echoed at
`integration-design.md:80`) — is implemented as the **file-level superset**: every scope in every
dirty file (D11). The reason is a measured cost, not a preference: `body_hash` (§6.5, `:250`) was
never extracted by R1–R4, and adding it bumps `EXTRACTOR_VERSION`, which is folded into
`blobCacheKey` and therefore invalidates every cached historical blob — a full re-parse of the whole
history, for every adopter, to refine one convenience form of one command. The superset is bounded
by §11.3's budgets and dedup, its owner is the package that next bumps `EXTRACTOR_VERSION` (R6 being
the natural candidate, since trends and calibration already re-walk history), and if no package ever
does, it stands permanently and the docs say so. **This is the only item of R5's own binding scope
that this plan does not land in full**, and it is named here so a reviewer can reject any other
reduction on sight.

---

## CHANGELOG policy

One entry, under `## [Unreleased]`, in release-notes voice, covering the increment's adopter-visible
surface: conventions mined from a repository now speak during a session — a check against an edited
file names the convention, the evidence behind it and real examples to copy; what it says is
budgeted and deduplicated so a session is never flooded; following the advice is recorded, and a
convention agents keep ignoring stops interrupting them. Tasks are internal stages of that one
change and get no entries of their own — per-task entries would be a work log, which AGENTS.md's
changelog rules forbid.

Timing: the entry is **drafted at T3**, the first task whose commit changes what an adopter sees,
and **amended in place** at T5 (channels and the JSON contract), T7 (the compliance loop and the
committed ledger mark, which is the one entry an adopter must read before their next `git status`),
T8 (demotion), T9 (the sweep and the completeness note) and T11 (docs). Amending in place is exactly
what the one-entry rule permits; every commit that changes adopter-visible behavior leaves the
changelog true at that commit. No second entry is ever added. The existing R1–R4 entries are left as
they stand unless a sentence in one becomes untrue — in which case correct that sentence in the same
commit rather than adding a contradicting entry. The R4 entry's "reading and reporting only" phrasing
is the one to check first: T3 falsifies it.

---

## Execution protocol

- **Order is strict T1 → T11.** T3 depends on T1 and T2 landing first; T4–T9 each widen the flow T3
  opened and may not overlap, because each consumes the previous task's landed shapes and re-runs
  its e2e. T10 and T11 read everything before them.
- **The SDD loop, per task:** a fresh Sonnet implementer implements the task from this plan plus the
  repository alone; an Opus reviewer reviews it against the task's acceptance criteria, invariants
  and cited authorities; the implementer fixes; the controller runs the gate
  (`scripts/repo-check.sh`, backgrounded, absolute cwd), commits once, and pushes. Implementers do
  not commit and do not run the full gate.
- **The reviewer's standing questions**, every task: did the implementer actually read the cited
  spec sections (do the formulas match the spec, or the prototype's simplification)? Does every
  load-bearing rule have a test that fails when the rule alone is deleted, and did the implementer
  run that deletion live and report the failure (R5-I11)? **Is there an end-to-end test that drives
  the whole user flow through the spawned binary, and does it assert the flow's observable outcome
  rather than a substring of a log (R5-I12)?** Did anything R6/R7/R8-shaped leak in? Does every
  rendered string survive the naming table (R5-I14)? Did the graph ritual happen, and does
  `check --approve` end PASS with zero warnings?
- **Sonnet exploratory testing sessions (binding, new in this increment).** Implementers and
  reviewers both read the plan; neither of them is a *user*. So after each of **T3, T7 and T9**
  lands and is committed — the three points where the flow an adopter meets changes shape — the
  controller dispatches a **fresh Sonnet agent with no access to this plan**, briefed only as a
  developer who has just adopted Yggdrasil on a realistic fixture repository, and asked to *use*
  `yg roots check` through the public CLI: index, edit code the way a developer edits code, run the
  check, react to what it says, fix things, ignore things, run it again, try the flags the help text
  advertises, and try a few things the help text does not advertise. A fourth session runs after
  **T10**, over the whole increment.
  - **What it produces:** a findings report — what it expected, what happened, and where the two
    diverged — with every finding classed as *wrong behavior*, *confusing output*, *missing
    affordance*, or *documentation gap*, and each backed by the exact commands it ran.
  - **What it may not do:** it makes **no changes**. Its findings are **proposals**, judged by the
    controller against this plan and the design authorities. A finding that contradicts a decision
    D1–D25 is answered with the decision, not with a code change; a finding that reveals a decision
    was wrong is a STOP and a report to the maintainer.
  - **Why it is in the protocol rather than left to judgment:** every other check in this loop
    verifies the code against the plan. This one is the only check of the plan against a person's
    expectations, and this increment is the first in the program whose output a human being reads.
- **Plan perfection criterion:** two consecutive clean reviews of this document before execution
  starts, the same bar the previous three increments used.
- **STOP conditions** (report, do not improvise): an architecture edit appears necessary; T2 Step 1
  finds a released `model.json` body; T3 Step 1 finds hook-time and index-time enumeration disagree;
  a golden's MUST-NOT-mine assertion starts firing as speech; a spec section contradicts a decision
  D1–D25 in a way this plan did not anticipate; the dogfood measurement at T11 finds the check path
  annoying enough that the maintainer's own canary test fails.

---

## Carry-ins from Increment 3 (each with a decision)

Five items were deferred to this increment. **Their sources differ, and the preamble says so per
item rather than attributing all five to one document:** items 2 and 3 come from R4's execution
ledger (`.superpowers/sdd/2026-08-20-increment-3-r4-history/progress.md`, whose closing section
records seven controller decisions); item 1 comes from the dogfood report entry that ledger points
at; items 4 and 5 come from the R4 **plan** itself (`:3565-3574` and `:2320-2321`). Each is decided
here or deliberately deferred with a reason. Where this section's paraphrase and a source document
disagree, **the source document wins** and the controller amends this section — T1's report
re-reads all three before T11 relies on any of them.

1. **Scaffold-on-missing-block (the dogfood entry of 2026-08-22).** **Decided — D25.** R5 takes the
   half that needs no design change: the scaffold notice prints the **absolute path** of the config
   it is about to modify. The confirmation gate stays an open question (OQ2) with a default of *do
   not add*, because the design authority mandates auto-scaffold and a prompt would break the
   non-interactive use every agent and CI makes of `index`. Recorded in the dogfood report as
   partially resolved at T11.
2. **`agentShare` window config-derivation (§18.4).** **Decided — deliberately not changed.** The
   120-day window is the spec's own word "fixed" (`v6-spec.md:687`), and `history.ts:693-707`
   already records honestly that the promote conjunct is a no-op at stock defaults because the
   window (120) is shorter than `agentPromoteDays` (180). R4 deferred the semantics change to "the
   package that makes the promote gate act on this number" — and R5 is **not** that package: R5 does
   not gate on `agentShare` at all; it only *renders* the alarm (T10, D22), and rendering does not
   read the conjunct. Making the window config-derived here would invent a config key against
   R5-I7 and change a number nothing in R5 consumes. It is re-raised where it can actually matter:
   R7, which owns `status --exit-code 3` — the first surface where `agentShare` has a consequence.
3. **Dogfood enablement (R4's OQ2, "revisit when the check path lands").** **Decided — measure, do
   not commit.** T11 Step 5 runs the measurement on a **copy** of this repository, reports the
   numbers and the individual false positives, and commits nothing. Enabling roots on this
   repository for real is OQ1 below, with a default of *not yet*: the honest reason is that the
   thing that would make the committed model pay for itself is the *plugin* channel (P1/P4), which
   is two increments away, and R5's own canary value is fully obtained from a measurement run.
4. **Optional D16-fraction instrumentation** (the count of distinct blob shas appearing only as a
   record's pre-image, as a fraction of all distinct blobs — R4's T10 Step 5). **Decided —
   carried, conditional.** It rides T11 Step 6, runs only if the dogfood measurement runs at all,
   and is reported as not-measured with that reason otherwise. It is not made unconditional because
   it measures the *history walk*, which R5 does not change: it is R4's outstanding curiosity, not
   R5's evidence, and spending a full cold walk on it inside this increment's gate would be
   R5-I16's forbidden new step in all but name.
5. **T10's measured global miss-set figure standing in place of a window constant.** **Decided —
   carried as a constraint, not as work.** The rule R5 inherits is: where a measured figure exists,
   R5 does not reintroduce a constant that would replace it, and R5 introduces no new window
   constant of its own (R5-I7 makes that mechanical — every number R5 reads is a landed config key
   or a spec-fixed constant). T11 Step 6 restates the measured figure in its report so the next
   increment inherits it rather than re-deriving it. **Honest caveat for the reviewer:** this
   carry-in's exact original wording was reconstructed from the R4 ledger's decision list rather
   than from a surviving numbered item, so T1's report re-reads
   `.superpowers/sdd/2026-08-20-increment-3-r4-history/progress.md` and confirms the figure and its
   context before T11 relies on it; if the ledger says something different from this paragraph, the
   ledger wins and the controller amends this section.

---

## Open questions for the maintainer

Only genuinely owner-gated items are listed. Each states a default so execution is never blocked
waiting for an answer.

1. **Enable roots on this repository for real, now that it speaks?** R5 is the first increment
   whose output a person reads, and design §15's phase-1 definition of done includes dogfooding it
   here (`integration-design.md:546-547`). Against that: enabling commits a `roots:` block, a
   `model.json` that moves on every index of a moving repository (design's own risk 4), and — new
   in this increment — a `ledger.jsonl` that goes dirty whenever an agent working in this repo
   complies with a mined convention. *Recommendation and default: measure at T11 on a copy, report
   the numbers and every false positive, commit nothing. Revisit when the plugin channel (P1/P4)
   makes the committed model pay for itself in ordinary sessions rather than only in deliberate
   ones.*
2. **A confirmation gate before `yg roots index` scaffolds a `roots:` block?** D25 takes the
   informative half (the notice names the absolute path). The remaining question is whether
   scaffolding should require an explicit flag — safer for tooling that spawns the CLI with an
   inherited cwd, and a departure from the design's "scaffolds it with defaults, printed first".
   *Default: no gate. The design authority mandates auto-scaffold, and a prompt would break every
   non-interactive caller — which is most callers.*
3. **How loud should a first session be?** `budgets.maxMessagesPerResponse` 3 and
   `sessionMaxWarnings` 12 are the spec's numbers, and R5 ships them unchanged (R5-I7 forbids
   inventing a key, and these are keys an adopter can already set). The question is only whether
   the maintainer wants the *defaults* revisited after T11's measurement on this repository shows
   what 12 warnings in a session actually feels like. *Default: ship the spec's numbers unchanged;
   report the felt experience at T11 and treat any change as its own decision with its own
   evidence.*

---

## Review history

### Round 1 — what the adversarial review changed (6 blocking, 10 major, 22 minor)

Finding → change. Every fix was verified against the authority the finding cited before it was
written; one finding was applied *differently* from the reviewer's proposed remedy, and that is
called out.

**Blocking**

- **B1 — the `''` sentinel collides with a live partition id.** Verified in the source:
  `dirnameOf('package.json') === ''` (`extract.ts:795-798`), `keyFor` returns `''` for every file
  when a root-level marker exists (`partitions.ts:210-215`), and `finalId = key` for an own-floor
  bucket (`:283`) — so `''` is a *real* id on the mainstream adopter shape and the draft's sentinel
  would have made the product permanently silent there. **D5 rewritten:** the sentinel is `null`;
  the `'_root'` arm is its own `fallback` field rather than a magic array entry; the lookup
  replicates all three of `keyFor`'s arms verbatim; the sort is pinned as
  `(dir.length desc, dir asc)` with the argument for why that is behaviorally identical to
  `sortedRoots`' descending-length order. T2 criterion 4b builds three purpose-made fixtures
  (root-level marker, dropped root, no marker) and MR-8/MR-8b are re-pointed at the two mutations
  that actually produce the silence.
- **B2 — an upgraded snapshot never gains R5's fields, and demotion never runs on a quiet tree.**
  Verified: the eight header inputs `isNoOpShortCircuit` compares (`roots.ts:491-510`) contain
  nothing that moves with a body-shape change. **Two structural fixes, because it is two problems:**
  D3 now bumps `ROOTS_VERSION` to 2 and states the *regeneration* reason (the readability argument
  it made was answering a different question), naming the three landed call sites that already
  implement a version mismatch; and D16 moves the demotion aggregation **outside** the short-circuit
  — it runs on every `index`, takes no build lock, and writes only when its content changed, so R4's
  "a genuine no-op writes nothing" guarantee survives byte for byte while demotion stops being
  reachable only on a dirty tree. T2 criterion 6 and T8 criterion 7 pin the two halves through the
  built binary; MR-8c kills the missing bump.
- **B3 — D10 and D11 contradicted each other, and no task built D11.** Re-derived the cost the draft
  had not: `body_hash` does not exist on `RawScope`/`ScopeUnit` at all, and adding it bumps
  `EXTRACTOR_VERSION`, which is folded into `blobCacheKey` and would force a whole-history re-parse
  for every adopter. **Applied differently from the reviewer's first option:** rather than build
  §19's scope set, D11 now declares a bounded **superset** (all scopes in dirty files), gives it a
  step (T3 Step 8), a criterion (13), an MR (14b) and an e2e leg, fixes D10's precedence to cover
  only the hook path, splits T5 criterion 6 accordingly, and records the reduction explicitly in
  NON-goals with its owner.
- **B4 — completeness consumed data the snapshot does not carry.** Verified
  `conf = Math.max(confAB, confBA)` (`history-cochange.ts:396-398`), `a < b` canonical (`:94`), and
  `commits(a)` living only in the gitignored raw state (`:109-112`). **T2 now persists
  `commitsA`/`commitsB`** (two integers on ≤ 5000 rows, riding the body change D3 already forces);
  D20 carries the derivation and D23 the corrected reading of the thresholds (they *are* live gates
  at check time, because the persisted `conf` is the max); T9 Step 4 scans both sides of every row
  and gates on the directional confidence; criterion 5 is re-derived by hand from one row with
  `commitsA: 9, commitsB: 12` (and a `commitsB: 20` variant) so 9/9, 9/12 and the 0.45 rejection are
  all checkable, and MR-37b/37c kill the two ways to get it wrong.
- **B5 — T5's exit-1 carve-out contradicted R5-I1.** R5-I1 itself now carries the carve-out and its
  boundary ("0 on every verdict outcome; 1 only for argument validation, before evaluation begins"),
  T3 criterion 12 enumerates it, and T5 criterion 3 cites the invariant instead of inventing it.
  Kept exit 1 rather than the reviewer's alternative: `cli-command-contract` requires exactly that of
  an option-mutex violation.
- **B6 — the four new `src/io/` stores cannot reach `rootsStateDir`.** Verified
  `persistence-adapter`'s own list is `calls: [persistence-adapter, utility]`
  (`yg-architecture.yaml:206-209`), with `roots-store` absent. **The stores now take an absolute
  `stateDir: string`**, which is also what R4 already shipped in the same node
  (`roots-blob-cache.ts` takes `cacheDir`, `roots-history-store.ts` takes `dir`); the authorization
  table's second row now states the outbound half, which is the half that dictates the signatures.

**Major**

- **M1 — sync signatures against async helpers.** One policy now, stated in T1 with its reason:
  everything is `async`, because `atomic-write-contract` bans `writeFileSync` (`check.mjs:4`) and
  both the FIFO trim and the telemetry compaction are whole-file rewrites. The draft's stricter
  paraphrase of `read-or-default-via-helper` is corrected to the aspect's real scope
  (`check.mjs:37-46`).
- **M2 — `m1 = 1` for role-less scopes would rank them above real group members** on the `_all`
  path, which §8.7 says is the majority path. D4 now scopes `m1` to role facts only and gives
  `_all`/directory facts their own rank tuple; T2 criterion 3b and MR-6b pin the split.
- **M3 — the demotion pool keyed on a `factKey` that dies at every re-induction** (§8.8: no
  cross-build inheritance). T8 Step 1 now specifies the forward resolution
  `stableId → current scope → current role → current factKey`, with criterion 3b (a re-induction
  between warning and aggregation) and MR-34b.
- **M4 — `mine.ts` is 55 576 bytes, not 49.6 k, and is the larger file.** Corrected, and the
  cap-and-fallback discipline now applies to both files, with the measurement moved *before* the
  edits (T2 Step 1) instead of after.
- **M5 — no owning graph node for ~22 new test files.** The authorization section now assigns every
  one: unit tests to `cli/tests/unit/roots` (R4's own precedent for store tests) and
  `cli/tests/unit/cli/roots`, e2e to one new `cli/tests/e2e/roots-verdict` node, with the
  multi-file-e2e-node precedent cited and the leaderboard consequence stated.
- **M6 — `docs/cli-reference.md` documents no roots command at all.** Verified. D24 now defers the
  whole roots section to R9 and R5 documents `check` in `docs/roots.md`, where `index` and `status`
  already live.
- **M7 — the `roots-genericity-fence` ESLint rule was unmentioned.** Added to the up-front aspect
  list with its three refusals and the two files most likely to trip them.
- **M8 — the novelty cap was in D7's prose and not in D9's formula.** D9 now states the composed
  rule `(denyEligible && !novel) ? DENY : WARN`, T3 Step 5 cites it, and MR-12b kills the cap
  specifically (MR-12 only ever killed the ⊥ *pricing*).
- **M9 — `status` would have appended committed ledger marks.** The cross-session marks are now
  returned as intents and applied only by `index` (D16.5, T8 Step 5), and T8 criterion 6 asserts
  `ledger.jsonl` byte-identical across a `status` run with open interventions.
- **M10 — the ledger `date` format was unpinned** while `markKey` (`weights.ts:267-269`) and
  `Date.parse` (`:256`) both depend on it. D15 and T1 criterion 3 now pin `YYYY-MM-DD` (UTC), add
  the two-runs-same-day dedupe case, and make the store reject a date carrying a time component.

**Minor** — all 22 applied: fourteen line-anchor corrections re-verified one by one against the
source lines (`:245`, `:427-429`, `:455-456`, `:479`, `:563`, `:576`, `:592`, `:712`, `:730`, `:890`,
`:791-796`, `config-parser.ts:112`, `integration-design.md:454`/`:464`, R4 plan
`:2320-2321`); the carry-ins preamble now attributes each item to its real source; the fan-out
leaderboard is described as it is (six pinned paths plus a bounded lookup) and the new command's
registration site is chosen to keep `cli/entry` at 23; MR-34 is re-pointed at criterion 1's 5/10 row
(the redundant 4/10 case is gone); `VerdictFact.appliesKind`'s narrowing is stated as a deliberate
drop of module facts; D6 names `moduleRootDirOfFile` instead of `moduleOfFile` and gives the
reconstruction rule; `snapshotContentHash`'s envelope is named exactly and no longer claims it
matches `writeModel`; the two spec-vs-landed name divergences (`hook-ledger.jsonl` → `ledger.jsonl`,
`.roots-state/` → `.state/`) and the "hook-shaped" → "echo-shaped" wording are each flagged as
deliberate; R5-I8 is reworded to "one new committed **file**"; `command`'s seventh aspect is named.

**Not applied:** none. Every finding was either fixed as proposed or fixed with a different remedy
that is called out above (B3, B5).

### Drafting self-review (pre-review)

Reviewed end to end once before finishing the draft. What that pass changed:

- **Found the `command` / `command-support` trap before it could cost an architecture edit
  mid-increment.** The first draft put the check command's logic in a helper file under `src/cli/`.
  Reading `yg-architecture.yaml:68-83` showed that a file there without a `register<X>Command`
  export classifies as `command-support`, whose `calls:` list contains neither `roots-engine` nor
  `roots-store` — so the helper's very first import would have been a blocking relation finding, and
  the fix would have been an unauthorized architecture edit. The constraint is now stated in the
  authorization section, with the one-export rule `command-contract-shape` actually enforces.
- **Resolved the exemplar gap the R4 model left, rather than routing around it.** `MinedFact` marks
  `exemplars` as structurally absent, but §11.1's message body *is* the exemplar contrast and §10
  makes that contrast the witness. Computing exemplars at check time is impossible (they are other
  files' scopes, at line numbers only the index knows), so R5 must add them to the snapshot — which
  made D3's `ROOTS_VERSION` question load-bearing, and made T2 a task rather than a step.
- **Caught the partition-resolution hole that would have silently broken the ledger.** `stable_id`
  folds `partitionId`, and every telemetry line, ledger mark and weight cap keys on `stable_id`. A
  check path that guessed a new file's partition would have written marks the next index could never
  match — a defect that produces no error, no failing test in the obvious places, and a permanently
  broken echo defense. D5 puts the decision function in the snapshot; T2 criterion 4 proves it
  reproduces `partitionOfFile` exactly.
- **Refined §9.11's tie-break after working the degenerate case by hand.** `w·m1·centrality` with
  centrality drawn from co-change coupling is exactly 0 for every candidate in a repository with no
  co-change pairs above the cut — which is most small repositories — so the spec's literal rule
  would pick the agent's "pattern to copy" by hash. D4 adds one strictly-refining tuple element
  between the score and the hash, and MR-6 kills its removal.
- **Rejected the obvious ordering for applying side effects, twice.** The natural implementation
  records the intervention and then prints. Worked through the crash cases, that is the ordering
  whose torn state pushes a *healthy* convention toward demotion — the one outcome §18.2's own
  fail-open direction rules out. D14 prints first and orders the three closure appends by the same
  test.
- **Found that completeness was assigned to nobody in the program plan and to R5 in R4's.** The
  program plan's R-package paragraphs never name the sweep; R4's plan states it is R5's, and R5 is
  the only package whose inputs make it possible. Left implicit, it would have fallen out of the
  program entirely against the plan's own scope law. D20 records it, T9 builds it.
- **Made R5-I6 a proof obligation with a STOP rather than an assumption.** The whole increment rests
  on a single-file `finalizeUnits` + `enumerate` producing exactly what the index produced. The
  code is shared, so the assumption is *reasonable* — which is precisely why it would never have
  been tested. T3 Step 1 tests it first, before anything is built on it.
- **Held the DENY row complete but unreachable instead of deferring it.** Design §9 arms DENY at R6;
  the temptation is to leave the channel table's DENY row unwritten. But then R6 must edit the
  verdict, the channel filter, the budgets, the dedup and the renderer at the same time as it turns
  calibration on. D9's one-field indirection lets the table, the WARN cap on novelty, the
  never-dedupe rule and T2's reason text all land and be tested now, so R6 changes one flag's
  source.
- **Cut two things that looked like R5 and are not.** `status --exit-code` on the agentShare alarm
  (R7 owns the only gate-capable roots surface) and any `Δ`/`τ` in human output (that is `explain`,
  R7). Both were in the first draft's T10 and are now explicit NON-goals.
