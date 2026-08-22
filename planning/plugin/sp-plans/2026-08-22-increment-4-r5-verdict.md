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
*append* added to the existing `source/cli/src/roots/stores.ts`, and two additive fields in the
committed snapshot body produced by `source/cli/src/roots/mine.ts`. The engine stays pure: every
side effect the verdict path implies is returned as data and applied by the command layer (D1).

**Tech Stack:** TypeScript, `web-tree-sitter` via the CLI's existing parser pool
(`src/ast/parser.ts` — no second loader), `node:child_process` for git through the existing
`utils/git.ts` / `utils/git-history.ts` helpers, vitest, spawned `dist/bin.js` E2E, the golden git
repositories R4 landed (`tests/support/git-fixture.ts` + `tests/support/roots-golden.ts`).

**Spec:** R5 as quoted verbatim below; spec §9.10 (`v6-spec.md:447-481`), §9.7 (`:439`), §9.9
(`:445`), §9.11 (`:483-484`), §10 (`:488-501`), §11 in full (`:503-556`), §12 (`:558-594`), §13.5's
completeness clause (`:621-625`), §18 (`:679-687`), §19's `check` row (`:698`), §20.1 (`:711`),
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
pairs it will read" (`2026-08-20-increment-3-r4-history.md:2321-2322`). D20 records why it belongs
here and nowhere else.

---

## Maintainer authorization (status: none expected, with one escalation path and one naming trap)

**No `.yggdrasil/yg-architecture.yaml` edit is expected in this increment.** Every file R5 adds
classifies under an existing node type by an existing `when:` predicate, and every import it needs
is already on an existing type's relation allow-list. Verified at HEAD (a761dda):

| New file | Classified by | Allowed because |
| --- | --- | --- |
| `src/roots/verdict.ts`, `speech.ts`, `session-state.ts`, `health.ts`, `exemplars.ts` | `roots-engine` — `when: all_of[path "source/cli/src/roots/*.ts", not stores.ts, not *.test.ts]` (`yg-architecture.yaml:742-748`) | roots-engine `calls: [roots-engine, ast-adapter, persistence-adapter, utility]`, `uses: [types]` (`:759-760`) — every import these five need (other roots modules, `ast/parser.ts`, `utils/*`, `model/graph.ts` types) is on that list. They import **no** persistence adapter at all under D1. |
| `src/io/roots-session-store.ts`, `roots-telemetry-store.ts`, `roots-demotions-store.ts`, `roots-incidents-store.ts` | `persistence-adapter` — `when: any_of[... path "source/cli/src/io/*-store.ts" ...]` (`:183`) | `command` → persistence-adapter and roots-engine → persistence-adapter are both allowed `calls` edges (`:61`, `:759`). |
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
- `command` carries `cli-command-contract`, `command-error-via-buildissuemessage`,
  `diagnostic-logging` and `source-hygiene`. Read all four before writing the file.

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
  command files in one node would silently leave the second unpinned.

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

- **R5-I1 — Roots never gates CI.** `yg roots check` exits **0 always** — on findings, on a
  malformed model, on an internal throw, on a path outside the repo, on a dormant project
  (`integration-design.md:80`; program plan `:270-271`). No `--exit-code` flag exists on `check`;
  the spec's exit-4 is deliberately not ported (`integration-design.md:470-478`). `yg check`,
  `yg context` and `yg build-context` output does not change by a single byte in this increment.
  *(T3, T5, every task's dormancy pin)*
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
- **R5-I5 — Model determinism survives (I2a).** The two snapshot fields R5 adds (`exemplars`,
  `partitionRouting`) are total functions of inputs the snapshot already fixes, ordered by a stated
  total order, carrying no wall clock. Two `index --full` runs remain byte-identical, and an
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
  `ROOTS_VERSION`, and D3 explains why even that does not move. *(T1, T3, T6, T8, T9)*
- **R5-I8 — One new committed write, and only one.** R5 writes exactly one committed file that R4
  did not: appended marks in `.yggdrasil/roots/ledger.jsonl` (`v6-spec.md:685` — committed on
  purpose, so regulation binds every machine and CI). Everything else R5 writes lives under
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
  key; the `ignored` branch fires at most once per session per intervention (`v6-spec.md:459-462` —
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
  (`integration-design.md:513-517`). Latency budgets (`v6-spec.md:586`, `:711`) are measured by
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
  character.** `src/roots/roles.ts` (54.4 k of source) does not appear among them, so its margin
  exceeds 849 — but the exact figure is unmeasured, so the one edit this plan permits there (D4's
  `m1` field, ~30 lines) is capped at that size and **re-measured with
  `node scripts/prompt-headroom.mjs` from repo root immediately after landing**. `src/roots/mine.ts`
  (49.6 k) takes only the two edits T2 names and is re-measured the same way. Everything else goes
  in new files; every new test goes in a new sibling file; split before crowding the ceiling, never
  after. (Graph-node `description:` growth is not a prompt risk — `src/llm/prompt.ts:179-181`
  excludes it from the assembled prompt.)
- **Aspect reviewers refuse, up front.** Before writing code, read the aspects binding your file's
  type. Beyond the four `command` aspects named in the authorization section, three bind every new
  `src/io/` file (`yg-architecture.yaml:197-203`): `read-or-default-via-helper` (every
  ENOENT-swallowing read goes through `readFileOrDefault`, never a bare try/catch),
  `atomic-write-contract` (**no `writeFile` / `writeFileSync` / `appendFile` / `appendFileSync` /
  `createWriteStream` imported from `node:fs` in any `src/io/*.ts`** — the JSONL appends of this
  increment route through `io/debug-log-writer.ts`'s `appendToDebugLog(filePath, text)`, the
  repository's existing single-write chokepoint for exactly this shape, already used by the
  committed advise register and the incident ledger), and `silent-missing-files` (an LLM aspect,
  judged per file). `roots-engine` additionally carries `deterministic` and `no-direct-console`.
  Satisfy them all by construction, not by retrofit.
- **Graph ritual, every task.** New source and test files join their owning node's `mapping:`; new
  import edges between mapped nodes get declared relations; watch `max_direct_relations` ceilings
  and the fan-out leaderboard pin in `tests/integration/portal-derive-rest.test.ts` (it pins five
  paths with counts, a sixth bounded value, descending order, the title and a narrative comment —
  any movement means updating the whole set coherently). `log_required: true` sits on
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
  `evaluate()` and discards `intents` (`v6-spec.md:735`: the harness runs hermetically, with no
  telemetry or session reads/writes).
- **D2 — File placement and the names that carry meaning.** As tabulated in the authorization
  section. Restated as a rule an implementer can check: a new `src/io/` file MUST end in
  `-store.ts` or `-cache.ts`; a new `src/cli/` file MUST export exactly one
  `register<Pascal>Command`; a new `src/roots/` file is automatically `roots-engine` unless it is
  literally `stores.ts`. A file placed against this rule is a blocking `unmapped-files` /
  `type-strict-orphan` finding, not a style nit.
- **D3 — What R5 adds to the committed snapshot, and why `ROOTS_VERSION` does not move.** The
  verdict path needs two things the model body does not yet carry: per-fact `exemplars`
  (Appendix D `:889` lists the field; §9.11 makes the exemplar contrast *the witness itself*,
  `v6-spec.md:490-496`) and a way to resolve an arbitrary file to the partition the index would
  have put it in (D5). R5 therefore adds `MinedFact.exemplars` and a body-level `partitionRouting`.
  `ROOTS_VERSION` stays **1**, for the reason `stores.ts` already records at the constant
  (`src/roots/stores.ts:25-39`): the body has never shipped in a release, so no adopter holds a
  `model.json` written under the old shape, and every reader treats each added field as
  independently optional. **T2 Step 1 verifies that premise against reality** (no released version
  of `@chrisdudek/yg` has ever written a `model.json`) rather than inheriting it as folklore; if it
  is false, T2 stops and reports, because a bump then needs a migration. The graph schema version
  (`CLI_SUPPORTED_SCHEMA`, `templates/default-config.ts`) is untouched — no graph format changes
  (AGENTS.md's two-version rule).
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
    (`roles.ts:194`) over the same bags, and pin the two against each other by value. For a scope
    with no role at all, `m1 = 1` (a constant factor across that fact's candidates, so it cannot
    reorder them).
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
    `{ rel, line, name }` exactly as Appendix D shows (`:889`).
  - **Render-time re-validation** (spec: "reaped scopes never render") is a **file-existence
    check** at check time, not a re-parse. Re-parsing three exemplar files per message would
    multiply the hook's parse cost by four against a 700 ms cold budget (`v6-spec.md:586`), and the
    index — not the hook — is the authority on a scope's line number. A message whose exemplars all
    fail the existence check still renders, without the `See:` line; it does not become silence,
    because the deviation is still true.
- **D5 — Hook-time partition resolution: `partitionRouting`.** `stable_id` folds `partitionId`
  (`v6-spec.md:246`), and telemetry, the ledger and the hook-shaped weight cap all key on
  `stable_id` — so a check path that guessed the partition would write marks the next index could
  never match. Re-deriving partitions live is not available: `derivePartitions`
  (`src/roots/partitions.ts:221`) needs the whole repo's raw scopes to apply the 300-scope floor.
  The snapshot therefore carries the *decision function*, not the decision: an ordered array
  `partitionRouting: Array<[dirPrefix, partitionId]>`, most-nested directory first, with
  `dirPrefix: ""` as the no-package-root arm and an **empty-string `partitionId` meaning "this
  root's partition was dropped — files here are not mined"**. Lookup is the first entry whose
  `dirPrefix` is an ancestor of the file's path, which is exactly `keyFor`'s own search. A file that
  routes to a dropped partition, or to nothing, is **silent** — the same answer the index gave it.
  This is O(number of package roots) in the snapshot, not O(files), and it answers for files that
  did not exist when the index ran, which is precisely the case the hook exists for (an agent
  writing a new handler).
- **D6 — Hook-time enumeration reuses the index's own functions, with the snapshot's vocabulary.**
  The check path runs `extractUnits` → `finalizeUnits` (over a synthesized single-file
  `PartitionMap`) → `enumerate(units, vocabFromSnapshot, config)`, and reads a surface's value from
  the resulting `FeatureBag`/`DomainMap` pair: present in `surfaces` ⇒ that value; absent but in the
  surface's domain ⇒ `'false'` for a boolean surface; not in the domain ⇒ **`null`, which skips**
  (undecidable is never a deviation, `v6-spec.md:213`). Vocabularies are **never** recomputed at
  check time — they are a partition-wide statistic and recomputing them from one file would
  silently change every surface id. `finalizeUnits`' synthesized map uses the snapshot's
  `moduleOfFile` entry as the module-root arm when the file is known and the file's own directory
  otherwise; module-kind units are discarded before evaluation (§9.10's runner evaluates method,
  type and file scopes only, `:481`), so that choice cannot reach a verdict. **T3 Step 1 proves the
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
  (fewest survived-raw instances), ties broken role < directory < `_all`" (`v6-spec.md:452-454`).
  The concrete quantity is `MinedFact.nTotalRaw`, which `mine.ts`'s own field doc already defines
  as the survived raw population (`src/roots/mine.ts:130-132`) — not `counts`, which is weighted and
  seed-inclusive, and not `deviantsN`. Applicability is the spec's own three-way test: role facts
  of the scope's resolved role only, and **nothing** from a role that is ambiguous for this scope,
  untyped, or decorative (§8.10's `role_lift ≤ 0` demotion, `:360-364` — reachable via
  `isDecorativeRole`); directory facts whose `<dir>` is an ancestor of the scope's path; `_all`
  facts always. A scope with no role and no directory context is governed by `_all` alone (I5).
- **D9 — Severity in R5, and the inert DENY row.** `severity(f) = f.denyEligible ? DENY : WARN`,
  where `denyEligible` reaches the engine as a plain `boolean` on `verdict.ts`'s **own** input
  projection — not as `MinedFact`'s literal `false` type. That single indirection is what lets the
  channel table's DENY row be exercised by unit tests today while remaining unreachable from any
  real snapshot until R6 sets the flag (`integration-design.md:365-383`: DENY arms at R6, never in
  CI, only in a hook's JSON payload). **R5 emits no `permissionDecision` under any input**, because
  the `pre` channel drops WARN and R5 can produce nothing but WARN; a test that constructs a
  synthetic DENY finding and drives the table directly is how the row is covered, and an e2e that
  asserts `--hook pre` prints nothing and exits 0 is how the product promise is covered.
- **D10 — Channel vocabulary, stdin precedence, and no installer.** The channel names are the
  design's — `pre | post | bash | stop | generic` (`integration-design.md:80`) — not the spec's
  `claude-*` spellings (`v6-spec.md:562`); the design supersedes on integration shape, and a
  host-branded flag value in a host-agnostic CLI is exactly the internal leak §11's naming rule
  forbids. Input precedence, fixed: a JSON payload on stdin (read only when `--hook` was passed and
  stdin is not a TTY) supplies session id and file set; explicit `--session`, `--content`, `--as`
  and positional `<file...>` arguments override whatever the payload said; with neither a payload
  nor a file argument the run is a silent no-op that exits 0. **No hook installer ships in R5**
  (`hooks install` is R8, program plan `:121`), so every channel is reachable only by explicit
  invocation and by tests — which is also why the protocol path (`yg roots check <file>`, the form
  R9 will teach in `rules.ts`) must work perfectly without any hook runtime at all.
- **D11 — Non-hook scope selection, and its degraded fallback.** Design §3's `check` row and spec
  §19's (`:698`) agree: with no path arguments the scope set is "scopes whose `body_hash` differs
  from HEAD, plus enclosing types and file scopes"; with `[paths…]` it is **every** scope in those
  files. R5 implements the first through the machinery R4 already built — `getDirtyFiles`
  (`src/utils/git.ts:125`) for the candidate paths, and the existing blob-record reader for HEAD's
  own extraction of each, so the comparison is scope-by-scope rather than file-by-file. **Degraded
  fallback, stated:** with git unavailable, a shallow clone, or a HEAD blob that will not resolve,
  the run evaluates every scope in the candidate files and says nothing about it — one `debugWrite`
  line, never an error, never a different verdict for a scope that *is* evaluated (R5-I15).
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
  (`v6-spec.md:685`), `date` being the UTC calendar day supplied by the command layer. Appends go
  through `appendLedgerMarks` in `src/roots/stores.ts` — the file that already owns `readLedger`,
  so the store's read and write halves stay in one place — routed through `appendToDebugLog`'s
  chokepoint per `atomic-write-contract`. Two consequences are intended and must be stated in the
  docs, not hidden: `git status` shows a dirty `ledger.jsonl` after a productive session ("roots
  records that it shaped this code — commit it with your change", `:685`), and because
  `ledgerHash` is one of the model header's inputs, the **next** `yg roots index` will not take
  D13's no-op short-circuit. That is the mechanism working: a new mark genuinely changes what the
  next model should say.
- **D16 — Where the demotion aggregation runs, and where it only *reads*.** §18.2 says aggregation
  runs "in the same transaction as every snapshot write … and at `report`/`status`; never in hooks"
  (`v6-spec.md:683`). R5 writes `demotions.json` **only** inside `yg roots index`, under the build
  lock that R4-I12 already requires of every writer. `status` **computes and displays** the same
  figures but writes nothing: a read surface that took the build lock would violate the design's
  own reader/writer split (`integration-design.md:160-163`), and a read surface that wrote without
  the lock could tear against a concurrent index. The freshness cost is bounded and safe by §18.2's
  own rule — a stale or missing `demotions.json` means a demoted fact keeps speaking, never that a
  healthy one goes silent. `demotions.json` is stamped with the **snapshot content hash** (a
  sha256 over the canonical JSON of the model *body*, header excluded — a small exported helper in
  `stores.ts`, one home, used by both the writer and the check path's reader), and the check path
  ignores a stamp that does not match the snapshot it just loaded.
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
  silence plus one incident (`:593`).
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
  (`2026-08-20-increment-3-r4-history.md:2321-2322`) — and R5 is in any case the only package that
  *can* host it, because its two inputs are the co-change cut (landed in R4) and the session's
  written-file set (which does not exist until this increment's session log). It is gated by
  `hooks.claudeCode.stopCompleteness` and `completeness.mode`, both already parsed with their
  defaults, and it renders Appendix A's **T5** template. Dropping it would leave the program plan's
  own scope law ("nothing here is deferred out of it") violated by omission.
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
  `minConfidence` 0.75 for completeness (`:122`); `ledger.*` for release, already consumed by R4.
  `budgets.daemonBudgetMs` is present in the config and is **never read** — there is no daemon
  (`integration-design.md:373`); leave it parsed and unused, and say so once where the budget
  constants are consumed, so a later reader does not "fix" the omission. Any new key is a STOP.
- **D24 — The documentation boundary.** R5 owns making the *existing* docs true: `docs/roots.md`
  (whose "What's not here yet → Speak up while you edit" section, `.state/` row and ledger row all
  become false in this increment), `docs/configuration.md`'s roots block if any statement about
  dormancy or state changes, and `docs/cli-reference.md`'s command list. It does **not** own the new
  concepts/quickstart/honesty pages, the two knowledge topics, the `roots:` schema entry or the
  `rules.ts`/`digest.ts` roots section — all R9 (program plan `:124-133`). Because R5 edits neither
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
- Edit `source/cli/src/roots/stores.ts` — add `appendLedgerMarks`, `snapshotContentHash`, and the
  `.state/` path helpers' peers if any are missing.
- Create `.yggdrasil/model/cli/io/roots-state/yg-node.yaml`,
  `.yggdrasil/model/cli/roots/speech/yg-node.yaml` (empty mapping until T3 — the design lock lands
  first), `.yggdrasil/model/cli/commands/roots-check/yg-node.yaml` (likewise).
- Create `source/cli/tests/unit/io/roots-session-store.test.ts`,
  `roots-telemetry-store.test.ts`, `roots-demotions-store.test.ts`, `roots-incidents-store.test.ts`,
  and `source/cli/tests/unit/roots/stores-ledger-append.test.ts` (a **new sibling** — the existing
  `stores-ledger.test.ts` covers reading and is not to be grown into a second subject).

**Interfaces produced.**
```ts
// roots-session-store.ts — §11.4: O_APPEND, one event per line, state = fold.
export interface SessionEvent { ts: string; kind: 'warned' | 'closed' | 'sweep' | 'stop'; /* + kind-specific fields */ }
export function sessionLogPath(yggRoot: string, sessionId: string): string;
export function readSessionEvents(yggRoot: string, sessionId: string): SessionEvent[];      // tolerant: bad line skipped
export function appendSessionEvents(yggRoot: string, sessionId: string, events: readonly SessionEvent[]): void;
export function pruneSessions(yggRoot: string, olderThanMs: number, nowMs: number): number; // mtime-based, returns count

// roots-telemetry-store.ts — §18.1: role-free keys, retention compacted at index.
export interface TelemetryRecord { sessionId: string; ts: string; stableId: string; surface: string;
  factKey: string; expected: string; observed: string; severity: 'WARN' | 'DENY'; deltaBits: number;
  observedAfter?: 'complied' | 'ignored' }
export function readTelemetry(yggRoot: string): TelemetryRecord[];
export function appendTelemetry(yggRoot: string, records: readonly TelemetryRecord[]): void;
export function compactTelemetry(yggRoot: string, retentionDays: number, nowMs: number): number;

// roots-demotions-store.ts — §18.2: stamped with the snapshot content hash.
export interface DemotionsFile { snapshotContentHash: string; demoted: string[] }   // sorted factKeys
export function readDemotions(yggRoot: string): DemotionsFile | undefined;          // absent/corrupt => undefined
export function writeDemotions(yggRoot: string, file: DemotionsFile): Promise<void>;// atomic

// roots-incidents-store.ts — §21.1: FIFO 500, local, machine-written.
export interface RootsIncident { ts: string; stage: string; message: string }
export function appendIncident(yggRoot: string, incident: RootsIncident): void;     // trims to the FIFO cap
export function readIncidents(yggRoot: string): RootsIncident[];

// stores.ts additions
export function appendLedgerMarks(yggRoot: string, marks: readonly LedgerEntry[]): void;  // dedupes on (stableId, surface, date)
export function snapshotContentHash(body: unknown): string;                                // canonical JSON of the BODY only
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
  single-write chokepoint, which is what keeps `atomic-write-contract` satisfied without a
  suppression. `demotions.json` is a whole-file write and goes through `atomicWriteFile`. Read
  `atomic-write-contract`'s own `RAW_WRITE_FNS` list before reaching for any `node:fs` writer.
- [ ] **Step 3: Tolerance, per store, stated in each file's header.** Session, telemetry and
  incident logs are **per-record tolerant** — a malformed line is skipped, never fatal (I1, and the
  same tolerance `readSeeds`/`readLedger` already document). `demotions.json` is **all-or-nothing**:
  a corrupt or stale-stamped file reads as `undefined`, which means "no demotions", which is the
  fail-open direction §18.2 chooses. Each header names which tolerance it has and why.
- [ ] **Step 4: The FIFO, done without reading the world twice.** `appendIncident` appends and then
  trims to 500 only when the file has grown past a cheap line-count threshold — the audit trail must
  survive a cache wipe (`v6-spec.md:719` calls it a durable store), so trimming is by age of entry
  (oldest first), never by truncating the file to zero.
- [ ] **Step 5: `snapshotContentHash`.** sha256 over the canonical JSON of the model **body**
  alone, reusing `stores.ts`'s existing deep-key-sort so it cannot drift from what `writeModel`
  serializes. Appendix D's "header excluded from content hash" (`:861`) is the rule; this is its one
  implementation.
- [ ] **Step 6: Graph ritual + report.** Three new nodes, mappings, relations, `yg log add` on every
  log-gated node touched, `check --approve --only-deterministic` clean.

**Acceptance criteria.**
1. `appendSessionEvents` then `readSessionEvents` round-trips N events in append order; a line of
   garbage inserted in the middle is skipped and the other N are still returned; the file is opened
   O_APPEND so two interleaved writers never truncate each other.
2. `pruneSessions` removes exactly the session files whose mtime is older than
   `sessions.pruneDays` (7) against an injected `nowMs`, and returns the count. It never removes a
   file it cannot stat.
3. `appendLedgerMarks` writes one line per mark, **dedupes on `(stableId, surface, date)`** against
   both the marks in the same call and the marks already in the file, and leaves an existing file
   byte-identical when every mark in the call is already present.
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

## Task 2 — What the verdict path reads: exemplars and partition routing in the snapshot

**Scope.** The two additive snapshot fields of D3, produced at index time: per-fact `exemplars`
(§9.11, via a new pure `exemplars.ts`) and body-level `partitionRouting` (D5). Determinism
preserved end to end.

**Authorities.** Spec §9.11 (`v6-spec.md:483-484`), §8.5's membership and weight-index table
(`:340`), §8.10 (`:360-364`), §6.8's partition rule (`:269-273`), Appendix D's fact record
(`:875-891`), §20.2 (`:713`); design §12's "§9.11 exemplar ranking … with render-time
re-validation" row (`:453`).

**Files.**
- Create `source/cli/src/roots/exemplars.ts`.
- Edit `source/cli/src/roots/mine.ts` — two edits only: call the exemplar stage, and emit
  `partitionRouting`. Re-measure `prompt-headroom.mjs` after.
- Edit `source/cli/src/roots/roles.ts` — the single `m1` field of D4, capped at ~30 lines, then
  re-measure.
- Edit `source/cli/src/roots/pipeline.ts` — thread whatever the exemplar stage needs (weights,
  coupling) that `mine()` does not already hold.
- Create `source/cli/tests/unit/roots/exemplars.test.ts` and
  `source/cli/tests/unit/roots/roles-membership.test.ts` (**new sibling** — `roles.test.ts` is
  frozen at 660 chars of margin).
- Create `source/cli/tests/e2e/cli-roots-index-verdict-inputs.test.ts`.

**Steps.**
- [ ] **Step 1: Verify D3's premise before changing the body shape.** Confirm that no released
  version of the package has ever written a `model.json` (check `CHANGELOG.md`'s released sections
  and `source/cli/package.json`'s version history against the branch). If a release *has* shipped a
  body, **STOP and report** — the addition then needs a `ROOTS_VERSION` bump and a migration, which
  is a different task.
- [ ] **Step 2: `exemplars.ts`, pure.** Candidate set, `m1`, centrality and the refined tie-break
  exactly as D4 fixes them; top 3; output `{ rel, line, name }`, `rel` POSIX-normalized. No I/O, no
  clock. The module header states the D4 tie-break refinement **and its reason** (the all-zero
  centrality case in a repository with no co-change pairs) beside the spec citation, since a reader
  comparing the code to §9.11 will otherwise read the extra tuple element as drift.
- [ ] **Step 3: `partitionRouting`.** Emit the ordered `[dirPrefix, partitionId]` array from the
  same `PartitionMap` the mining run already holds — most-nested first, `""` last, empty
  `partitionId` for a dropped root. It is a **projection of an existing decision**, never a second
  implementation of `keyFor`: a test asserts that routing every file the index actually mined
  through the emitted array reproduces `partitionOfFile` exactly.
- [ ] **Step 4: Determinism.** Both fields are sorted by their stated total orders and carry no
  wall clock. The existing double-`index --full` byte-identity suite must pass unchanged, and the
  incremental ≡ full suite too.
- [ ] **Step 5: Re-measure the prompt headroom** on `roles.ts`, `mine.ts` and every file touched,
  and report the numbers. If `roles.ts` came inside 2000 chars, apply D4's stated fallback.
- [ ] **Step 6: Graph ritual + report** — `exemplars.ts` joins the new `roots/speech` node's
  mapping (not `roots/engine`'s), log entries on every log-gated node touched.

**Acceptance criteria — hand-derivable on the landed goldens.**
1. On the TypeScript golden, a named `_all` boolean fact carries exactly 3 exemplars, each of which
   really does hold `expected` for that surface, none of which is a scope `assignments` marks `-1`,
   and whose order matches D4's tuple recomputed by hand from the fixture's own weights and coupling
   figures (the test states the three scores in a comment).
2. A fact with fewer than 3 non-ambiguous conformers renders the ones it has; a fact whose
   conformers are **all** ambiguous falls back to all conformers rather than emitting zero.
3. With `couplingByFile` structurally absent (a golden with history stripped), every candidate's
   centrality is 1 and the ordering is by `w·m1` then `stable_id` — i.e. the degraded case has a
   defined, non-hash order.
4. Routing every mined file through `partitionRouting` reproduces `partitionOfFile` for **every**
   file on every golden, and a synthetic path under a dropped package root routes to the empty
   partition id.
5. Two `index --full` runs on the same tree produce byte-identical `model.json`, header included;
   an incremental index equals a forced full one.

**E2E coverage.** `cli-roots-index-verdict-inputs.test.ts`: spawn the built `bin.js`, run
`yg roots index` on a golden fixture repository, read the **committed** `model.json` from disk, and
assert (a) at least one fact carries a non-empty `exemplars` array whose `rel`/`line`/`name` point
at a real scope in a real file at that line, (b) `partitionRouting` is present and routes a chosen
file to the partition that file's facts live in, and (c) a second `index --full` leaves the file
byte-identical. The flow driven is an adopter's: *index a repository, and the committed snapshot now
contains what a later check can speak from.*

**Test obligations / mutation round-trips.**
- **MR-5 (ambiguity filter):** delete the non-ambiguous filter ⇒ criterion 1 fails (an ambiguous
  scope enters the top 3 on the fixture chosen for it).
- **MR-6 (tie-break refinement):** drop the middle `w·m1` element of D4's tuple ⇒ criterion 3 fails
  (the degraded ordering collapses to `stable_id`).
- **MR-7 (routing order):** sort `partitionRouting` shallowest-first ⇒ criterion 4 fails on a nested
  package root.
- **MR-8 (dropped-root marker):** emit `_repo` instead of the empty partition id for a dropped root
  ⇒ criterion 4's synthetic-path case fails, and a scope the index never mined would become
  speakable.

**NON-goals.** No verdict, no message, no `check` command. No `stabilityDays`, no `trend`, no
`calib` — those stay structurally absent until R6, and T1's message template omits their notes
accordingly (`v6-spec.md:513`: `{stability_note}` is omitted when absent).

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
- [ ] **Step 5: Δ, severity, channel.** D7's posteriors; severity per D9; `channelFilter` as a pure
  total function of `(channel, severity)` implementing the complete table, including the
  DENY→WARN downgrade with its note on every non-`pre` channel.
- [ ] **Step 6: Minimal render.** T1's first three lines plus the `See:` line, with the labels
  §9.4i and design §11 fix: `local (<dir>/)` for a directory fact, `repo-wide` in the `_repo`
  partition, `package-wide (<partition>)` otherwise, and the group's medoid label for a role fact.
  The locality contrast sentence renders verbatim when `parentExp ≠ expected`. Everything else of
  Appendix A is T4's.
- [ ] **Step 7: The command.** `yg roots check [file...]`, config-only load (I10 — `findYggRoot` +
  `parseConfig`, **never** `loadGraphOrAbort`; the same delegation `cli/roots.ts` already
  documents), dormant ⇒ print nothing and exit 0, no snapshot ⇒ print nothing and exit 0, exit 0
  always.
- [ ] **Step 8: Graph ritual + report.**

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
12. Exit code is 0 for: findings, no findings, dormant project, missing snapshot, unreadable
    snapshot, a path outside the repository.

**E2E coverage.** `cli-roots-check.test.ts` drives the adopter flow end to end on a golden fixture:
`yg roots index`, then edit a file to violate a mined convention, then `yg roots check <file>` —
asserting exactly one message, its three-beat shape, its `N of M established` evidence phrase, and a
`See:` line pointing at a real file and line; then revert the edit and assert **silence** and exit
0. The silence half is not decoration: precision is the product, and a check that cannot be quiet
is worse than no check.

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
- **MR-14 (domain skip):** treat out-of-domain as `false` ⇒ criterion 11 fails and every
  undecidable surface becomes a deviation.

**NON-goals.** No budgets, dedup or session state (T6); no telemetry, ledger or closure (T7); no
hook channels or stdin (T5); no demotion (T8); no bash sweep or completeness (T9); no `status`
changes (T10).

---

## Task 4 — The verbalizer and the complete message catalog

**Scope.** `speech.ts` grown to the whole of §11.1–§11.2 and Appendix A: one generic phrase per
enumerator, every note the template can carry, every deviation phrase, and the naming table applied
to every rendered string.

**Authorities.** Spec §11.1 (`v6-spec.md:505-527`), §11.2's binding table (`:529-549`), §9.4i's
locality labels and contrast sentence (`:425-429`), §10.1's witness argument (`:490-496`), Appendix
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
  tested: `{hook_shaped_note}` (" (N echo-shaped conformers excluded from evidence)" — design §11's
  wording, **not** the spec's internal "hook-shaped"), `{seed_note}` (" (+seeded)"),
  `{novelty_note}`, `{stability_note}` (**omitted** in R5 — `stabilityDays` is structurally absent
  until R6, and the spec's own rule at `:513` is "omitted when absent"), and the locality
  contrast sentence. No transition text ever renders in a message (T3 is report-only, `:511`).
- [ ] **Step 4: `{unit_plural}` from `appliesKind`** — methods / types / files / directories — and
  the per-row deviation phrase ("does not…", "is `<observed>`" for categoricals), which design §12
  names as a productionized gap the prototype left generic (`:462`).
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
   **1** — a usage error is not a verdict, and it is the one non-zero exit `check` may produce
   (state it in the command's help and in D-scope: it is refusing to run, not reporting a finding).
4. Fault injection at each of the five named stages yields zero findings, exit 0, and **exactly
   one** incident; with the harness option the same injection throws.
5. A path outside the repository yields silence and one incident for the session, however many such
   paths were passed.
6. A run whose stdin is a TTY and which was given no file arguments exits 0 having read nothing.

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

**Authorities.** Spec §9.10's `closeIntervention` paragraph (`v6-spec.md:459-462`), §18.1 (`:681`),
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
- [ ] **Step 1: Pooling.** Per `factKey = (roleKey|_all, surface)` via **current** membership,
  filtered to events whose recorded `(surface, expected)` matches the current fact — an expected
  flip must not poison the pool. Resolved = has `observedAfter`; unresolved excluded from the
  denominator.
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
- [ ] **Step 5: Where it runs (D16).** Inside `index`, in the same transaction as the snapshot
  write, under the build lock; at `status`, computed for display and **not written**. Telemetry
  compaction (`health.telemetryRetentionDays`) rides the index transaction.
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
4. Cross-session closure over a session log whose session is gone produces the three outcomes of
   Step 2 on three hand-built scopes.
5. A `demotions.json` whose stamp does not match the current snapshot is ignored: the fact speaks.
6. `status` reports the same demotion count `index` would write, and **writes nothing** — asserted
   by file mtime and content before/after.

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
  lower bound ⇒ criterion 1's 7/10 row fails (p̂ = 0.7 ≥ 0.3 either way — so use the 4/10 row:
  p̂ = 0.4 ≥ 0.3 does not demote on the point estimate, while `WilsonLB95(0.4, n=10) = 0.1682` does.
  Pin **that** case). The lower bound is what makes demotion require evidence of badness rather than
  a small sample.

**NON-goals.** Calibration and its UB-demotion branch (R6). `report`'s health section (R7).

---

## Task 9 — The Bash sweep and the Stop channel

**Scope.** §12.4's content-hash sweep and §13.5's completeness note — the two channels whose
behavior is stateful rather than per-file.

**Authorities.** Spec §12.4 (`v6-spec.md:583`), §12.2's `claude-stop` clause (`:574`), §13.5's
completeness paragraph (`:625`), Appendix A's T5 (`:791-798`), Appendix G.4 (`:1020`); the R4 plan's
own assignment of the sweep to R5 (`2026-08-20-increment-3-r4-history.md:2321-2322`).

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
- [ ] **Step 4: Completeness (D20).** Gated by `hooks.claudeCode.stopCompleteness` and
  `completeness.mode` (`stop-feedback-once`). D = files written this session (from the session log);
  E = `{b : ∃a∈D, confidence(a→b) ≥ cochange.minConfidence ∧ support ≥ cochange.minSupport} \ D \
  deleted`, read from the snapshot's own `cochange` rows; if E ≠ ∅ emit **T5** listing at most
  `completeness.maxItems` (5) items with their `{support}/{commits}` evidence. Once per session.
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
5. Completeness: with a session that wrote `a`, and a snapshot co-change row `a→b` at support 9 /
   confidence 1.0, the `stop` run emits T5 naming `b` with `9/9`; a second `stop` run in the same
   session emits nothing; with `stopCompleteness: false` neither run emits.
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

**Authorities.** AGENTS.md's documentation and changelog rules; spec §20.1's budgets (`:711`),
§12.5's latency budgets (`:586`); design §14's docs list (`integration-design.md:520-531`).

**Files.** Edit `docs/roots.md`, `docs/configuration.md` (only where a statement became false),
`docs/cli-reference.md`, `CHANGELOG.md`. No template edits (D24) — therefore no digest regeneration.

**Steps.**
- [ ] **Step 1: `docs/roots.md` becomes true.** Three sections are now false and must be rewritten,
  not patched: "What's not here yet → Speak up while you edit" (it does now), the `.state/` row
  ("Nothing writes to it in this release" — everything does now), and the `ledger.jsonl` row
  ("Nothing writes a new mark yet"). Add the two consequences an adopter will actually meet: a dirty
  `ledger.jsonl` after a productive session and what to do with it, and the fact that a check
  **never** fails a build.
- [ ] **Step 2: `docs/cli-reference.md`** gains the `yg roots check` entry, written for a person: the
  flags, the exit-code promise, and the two regimes (a hook runtime drives the JSON channels; a
  person or an agent runs it directly and reads prose).
- [ ] **Step 3: Verify every claim against the built binary**, not against this plan — the same
  discipline R4's own docs task used. That explicitly includes every worked example: no example may
  set a key to its own default.
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
1. Every claim in `docs/roots.md`, `docs/configuration.md` and `docs/cli-reference.md` is verified
   against the built binary's actual behavior.
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

R4's execution ledger names five items deferred to this increment. Each is decided here or
deliberately deferred with a reason.

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

## Self-review

Reviewed end to end once before finishing. What that pass changed:

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
