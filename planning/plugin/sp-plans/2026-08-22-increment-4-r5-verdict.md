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

**Architecture:** Six new pure engine modules under `source/cli/src/roots/`
(`verdict.ts`, `speech.ts`, `session-state.ts`, `health.ts` — mapped by a new `cli/roots/speech`
node — plus `exemplars.ts` and `extract-file.ts`, which map into the **existing** `cli/roots/engine`
node because both are production extraction/mining code, and mapping `exemplars.ts` elsewhere would
close a graph cycle), four new persistence
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
pairs it will read" (`2026-08-20-increment-3-r4-history.md:2321-2322`). D20 records why it belongs
here and nowhere else.

---

## Maintainer authorization (status: none expected, with one escalation path and one naming trap)

**No `.yggdrasil/yg-architecture.yaml` edit is expected in this increment.** Every file R5 adds
classifies under an existing node type by an existing `when:` predicate, and every import it needs
is already on an existing type's relation allow-list. Verified at HEAD (a761dda):

| New file | Classified by | Allowed because |
| --- | --- | --- |
| `src/roots/verdict.ts`, `speech.ts`, `session-state.ts`, `health.ts`, `exemplars.ts`, `extract-file.ts` | `roots-engine` — `when: all_of[path "source/cli/src/roots/*.ts", not stores.ts, not *.test.ts]` (`yg-architecture.yaml:742-748`) | roots-engine `calls: [roots-engine, ast-adapter, persistence-adapter, utility]`, `uses: [types]` (`:759-760`) — every import these six need (other roots modules, `ast/parser.ts` via `ast-adapter`, `utils/language-registry.ts` via `utility`, `model/graph.ts` types) is on that list. They import **no** persistence adapter at all under D1. Note the *node* split is finer than the *type*: all six are `roots-engine`, but `exemplars.ts`/`extract-file.ts` map to `cli/roots/engine` and the other four to the new `cli/roots/speech` — see the node list below for why. |
| `src/io/roots-session-store.ts`, `roots-telemetry-store.ts`, `roots-demotions-store.ts`, `roots-incidents-store.ts` | `persistence-adapter` — `when: any_of[... path "source/cli/src/io/*-store.ts" ...]` (`:183`) | **Inbound:** `command` → persistence-adapter and roots-engine → persistence-adapter are both allowed `calls` edges (`:61`, `:759`). **Outbound is the tighter half and the one that dictates their signatures:** persistence-adapter's own list is `calls: [persistence-adapter, utility]`, `uses: [types]`, `default: deny` (`:206-209`) — **`roots-store` is absent**, so none of these four may import `rootsStateDir`/`STATE_DIRNAME` from `src/roots/stores.ts`. They take an absolute `stateDir: string` instead (T1's contract), exactly as `roots-blob-cache.ts` takes `cacheDir` and `roots-history-store.ts` takes `dir`. They may reach `io/atomic-write.ts`, `io/read-or-default.ts`, `io/debug-log-writer.ts`, `io/hash.ts` and `src/utils/*`, which is everything they need. |
| `src/cli/roots-check.ts` | `command` — `when: all_of[path "source/cli/src/cli/*.ts", not *.test.ts, content "export\s+function\s+register[A-Z]\w*Command\("]` (`:43-48`) | `command` `calls:` includes both `roots-engine` and `roots-store` (`:61`) — the only type in the tree that may reach both. |
| *(edited, not new)* `scripts/prompt-headroom.mjs` | `build-script` — `when: any_of[path "scripts/*.sh", "scripts/*.mjs", "scripts/*.ts"]` (`:442-449`) | Already mapped by the `scripts` node's `scripts/*.mjs` glob (`.yggdrasil/model/scripts/yg-node.yaml:8`), which declares `relations: []`; the type carries only `source-no-raw-control-chars` (enforced) and the advisory `repo-check-gate-steps` (`:450-454`). **No node, no mapping, no edge, and no gate step added or removed** (R5-I16). Listed here because it is the increment's one edit outside `source/cli/`, and the authorization table is where that is recorded rather than discovered. |

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
- `command` carries **seven aspects from its type** (`yg-architecture.yaml:49-57`):
  `source-no-raw-control-chars` (`status: enforced`, and it does bind), `cli-command-contract`,
  `diagnostic-logging`, `command-contract-shape`, `source-hygiene`,
  `command-error-via-buildissuemessage` and `sibling-test-file`. Read all seven before writing the
  file. **Seven is the type-level count, not the effective set** — four more enforced aspects reach
  every file in this tree by *node* inheritance rather than by type, and they are enumerated once in
  the Global constraints' aspect bullet below. None of the four binds the command file's own
  content, but one of them binds `extract-file.ts`, so the enumeration is where an implementer of
  any task reads it.

**Graph nodes this increment creates (design-locked in T1, before any code):**
- `model/cli/roots/speech/yg-node.yaml` — type `roots-engine`, mapping **four** of the five new
  engine files: `verdict.ts`, `speech.ts`, `session-state.ts`, `health.ts`. A sibling of the existing
  `roots/engine` node rather than an extension of it: `roots/engine`'s `description:` is already the
  longest in the graph, and one more subsystem inside it would make that node's own review prompt
  the repo's tightest. (Graph-node `description:` text is excluded from the assembled reviewer
  prompt — `src/llm/prompt.ts:179-181` — so this is a *reviewability* argument about the node's own
  aspect surface and mapping size, not a prompt-size one; state it that way in the node.)
- **`exemplars.ts` joins `cli/roots/engine`, NOT `roots/speech` — and that placement is a
  correctness constraint, not a filing preference.** It is index-time production code: it runs
  inside `mine()`, and `mine.ts` *calls* it (T2). Mapping it to `roots/speech` would create a
  runtime edge `cli/roots/engine → cli/roots/speech`, while `verdict.ts` (a `roots/speech` file)
  already needs the exported `isBooleanSurface` from `mine-stages.ts` (`cli/roots/engine`) per D7 —
  a runtime edge in the opposite direction. Two declared `calls` edges in opposite directions is a
  **`structural-cycle`**: `checkNoCycles` (`src/core/checks/relations.ts:73-123`) walks
  `uses`/`calls`/`extends`/`implements` depth-first and emits it at `severity: 'error'`; it is in
  `STRUCTURAL_CODES` (`src/core/check-codes.ts:28-36`), the set whose own doc says these "fail
  `yg check` regardless of verification state"; and the validator calls it unconditionally
  (`src/core/validator.ts:192`). Plain `yg check` would go red the moment T2 landed, and the remedy
  would be a node-mapping change no task is authorized to make. With `exemplars.ts` in
  `roots/engine`, `roots/speech` has **one** outbound edge (`→ cli/roots/engine`) and no back edge,
  and `routePartition` is still reachable from `src/cli/roots-check.ts` as `command → roots-engine`
  (`:61`). `cli/roots/engine`'s own relation count is unchanged; `roots/speech` carries one `calls`
  and one `uses: types`.

**The full new-edge audit, done once here so no task re-derives the allow-list question** (each
task's graph ritual still declares the edges it lands — see the note below the table; type-only
imports create no
edge — `src/relations/extractors/typescript.ts:180-181` excludes whole-statement `import type` — so
every module naming `MinedFact`/`MinedPartition`/`LedgerEntry` as a type is free):

| New/edited node | Outbound runtime edges this increment adds | Back edge? |
| --- | --- | --- |
| `cli/roots/speech` (verdict, speech, session-state, health) | `→ cli/roots/engine` (`isBooleanSurface` only; `isDecorativeRole` is called by the **command** layer when it builds `decorativeRoles`, not by the engine). **`classifyAgainstMedoids` and `buildRoleFeatureBag` are NOT on this edge:** T3 Step 2's role ladder lives in `extract-file.ts` (D6's `resolveRolesForCheck`), which is intra-node with `roles.ts`, and `VerdictInput.roleOf` receives the already-resolved role. `roleJaccard`'s only consumer is D4's `m1` computation in `exemplars.ts` — also intra-node, which is what lets D4 keep `roles.ts` and its frozen test unedited. | none — nothing in `roots/engine` imports from `roots/speech` |
| `cli/roots/engine` (+ `exemplars.ts`, `extract-file.ts`) | **none new at all** — `mine.ts → exemplars.ts`, `pipeline.ts → extract-file.ts` (for `minimalFileScope` **and `MAX_PARSE_LINES`**, both moved there so no import cycle remains), `extract-file.ts → extract.ts` / `binding.ts` / **`partitions.ts`** (D6's gate 0, `makeRootsFileFilters`), `extract-file.ts → roles.ts` (M1's `resolveRolesForCheck`: `buildRoleFeatureBag`, `classifyAgainstMedoids`) and `exemplars.ts → roles.ts` (D4's `m1`: `roleJaccard`, `buildRoleFeatureBag`) are all intra-node. **Gate −1's `repo-scanner.ts` helpers are NOT on this node** — see the `cli/commands/roots-check` row; T3 Step 8 resolves the file set in the **command layer**, before any read, and R5-I4 keeps `extract-file.ts` free of `lstat`/`readdir`/`readFile` (it carries `deterministic` and `no-direct-fs`). An earlier draft of this row listed them here, which invited exactly the file read the aspect forbids. `→ cli/io/stores`, `→ cli/ast/runtime` and `→ cli/language-registry` are all already declared on this node (`.yggdrasil/model/cli/roots/engine/yg-node.yaml:173-174`, `:179-180`, `:185-186`). **So this node's `relations:` block is not edited by this increment; only its `mapping:` grows.** | — |
| `cli/io/roots-state` (four stores) | `→ cli/io/atomic-write` (`atomicWriteFile`), **`→ cli/io/stores`** (`appendToDebugLog` and `readFileOrDefault` are mapped there — `debug-log-writer.ts` and `read-or-default.ts` at `.yggdrasil/model/cli/io/stores/yg-node.yaml:18`/`:28`, **not** by `cli/io/atomic-write`, which maps only `atomic-write.ts`), `→ cli/utils`, `uses cli/model/graph` | none — no `io` node imports a roots node |
| `cli/roots/stores` (edited: `appendLedgerMarks`, `snapshotContentHash`) | **none new** — `stores.ts` already imports `appendToDebugLog`/`hashString`/`readFileOrDefault` from `cli/io/stores` and the node already declares that edge. Stated because the neighbouring row differs: the *new* io node needs the edge declared, this one does not | — |
| `cli/commands/roots-check` | `→ cli/roots/engine`, `→ cli/roots/speech`, `→ cli/roots/stores`, `→ cli/io/roots-state`, **`→ cli/io/stores`** (`readTextFile`/`hashString` — `graph-fs.ts` and `hash.ts` are mapped there, `.yggdrasil/model/cli/io/stores/yg-node.yaml:24`/`:25`; the command layer reads the bytes D6's engine function may not — **and this is also where gate −1's `repo-scanner.ts` helpers land: `loadRootGitignoreStack`, `isIgnoredByStack` and T3's newly-exported `isNestedProjectBoundary`**, since T3 Step 8 does the whole resolution here, before any read. `findNestedProjectRoots` is **not** on any production edge — after M2 the production predicate is `isNestedProjectBoundary`, and the whole-tree function is called only by criterion 14b's **unit-tier** assertion, which lives in `tests/unit/io/repo-scanner-nested.test.ts` because `e2e-public-surface` refuses that import to every e2e file) and **`→ cli/language-registry`** (`getGrammarForExtension`, for T9's "changed **code** files" test — D6 moved the *parse* into `src/roots/extract-file.ts`, a `cli/roots/engine` file that already declares `cli/ast/runtime` and `cli/language-registry`, expressly so the command file would not carry it, so **no `→ cli/ast/runtime` edge is needed here** and an earlier draft of this row justified two edges with a reason D6 had removed) — both legal for `command` (`utility`, `persistence-adapter` on `:61`) — plus the config/utils/formatter/preamble edges `cli/commands/roots` already declares, and `uses cli/tests/unit/cli` (`sibling-test-file`) | none — no engine, store, io or test node imports a command |
| `cli/commands/roots` (edited) | `→ cli/commands/roots-check` (the registrar call), `→ cli/roots/speech` (T8's aggregation call), **`→ cli/io/roots-state`** (T8 reads telemetry and session logs and writes `demotions.json`; T10's `status` reads demotions) — **10 → 13 relations**, still far under `max_direct_relations: 20` and clear of the 23 leaderboard tie | none |
| `cli/tests/e2e/roots-verdict` | **`uses cli/tests/support`, `uses cli/tests/fixtures`** — the suites use `buildGoldenRepo` and the golden specs, exactly as the landed sibling node declares (`.yggdrasil/model/cli/tests/e2e/roots-basic/yg-node.yaml`). It imports nothing from `src/**` — **`e2e-public-surface` is enforced and is declared on the PARENT node `cli/tests/e2e` (`yg-node.yaml:5`), reaching this node by inheritance**; the new node's own `aspects:` list is empty exactly as `roots-basic`'s is, and that inheritance is what decides where criterion 14b's `findNestedProjectRoots` assertion may live. A different claim from "no edges" | none — neither support node reaches roots or commands |
| `cli/tests/unit/roots` (edited) | `→ cli/io/roots-state` (T1's four store tests import `src/io/roots-*-store.ts`) and `→ cli/roots/speech` (T3's `verdict.test.ts`/`speech.test.ts`, T6's `session-state.test.ts`, T7's `verdict-closure.test.ts`, T8's `health.test.ts`, T9's `sweep-state.test.ts`) — **13 → 15 relations**. Legality is trivial (`test-suite` declares no type-level relation allow-list, `yg-architecture.yaml:418-431`) and both counts stay far under `max_direct_relations: 20` and far below the 23 leaderboard tie — but the row exists because the count *moves*, and a moving count with no row is what round 4's M6 was | none — no source node imports a test node |
| `cli/tests/unit/cli/roots` (edited) | `→ cli/commands/roots-check` (T3's `roots-check.test.ts`, the file `sibling-test-file` requires; T5's and T10's new files in this node target modules it already declares) — **7 → 8**, and one more per node any of the three reaches for a *value* rather than a type (`cli/roots/speech`'s `channelFilter` is the likely one; `import type` creates no edge). The count is the task's to declare, not this table's to predict — what the table settles is that each such edge is legal | none — the landed `cli/commands/roots` ↔ `cli/tests/unit/cli/roots` pair has this exact shape today, because `sibling-test-file`'s own edge targets the PARENT node `cli/tests/unit/cli`, not this child |

Every edge points from command → engine/store → io/types (and test → test-support), one direction
only. **The table settles the *allow-list* question once, so no task re-derives whether an edge is
legal — each task's graph ritual still declares the edges it actually lands, and
`relation-undeclared-dependency` is blocking (`src/core/check-codes.ts:96`), so an undeclared import
fails at that task's own gate.** T1 Step 1 runs `checkNoCycles` over the design-locked nodes; it
cannot verify edges that only arrive at T2-T8, which is precisely why the table exists.
- `model/cli/io/roots-state/yg-node.yaml` — type `persistence-adapter`, mapping the four new
  `src/io/roots-*-store.ts` files, mirroring `io/roots-cache`'s own stated "three files of one
  subsystem in one node … to keep the fan-out leaderboard still"
  (`.yggdrasil/model/cli/io/roots-cache/yg-node.yaml:11-13`).
- `model/cli/commands/roots-check/yg-node.yaml` — type `command`, mapping `src/cli/roots-check.ts`.
  A node of its own, not an extension of `commands/roots`: `sibling-test-file`'s check reads
  `ctx.node.files[0]` (`check.mjs:3`) and would only ever test the first mapped file, so two
  command files in one node would silently leave the second unpinned. **The registrar is called
  from `cli/roots.ts`, not from `cli/entry`** — so the new command edge lands on
  `cli/commands/roots` (ten relations today) and `cli/entry` stays at the **23** the fan-out
  leaderboard pins it at (`tests/integration/portal-derive-rest.test.ts:77-78`). Registering it
  from `entry` instead would take `entry` to 24 and rewrite the leaderboard's top three; that is
  the concrete reason for the call site, not a preference.
- `model/cli/tests/e2e/roots-verdict/yg-node.yaml` — **one new e2e node mapping all eight new
  `tests/e2e/cli-roots-*.test.ts` files** of this increment. One node, not eight: multi-file e2e
  nodes are already the norm here (`tests/e2e/check-validation` maps six,
  `relation-conformance-scripting` and `attention-dump` five each), and eight single-file nodes
  would add eight new fan-out sources for no reviewability gain.
- **Every new unit-test file joins an existing node, and none creates one.** The ~16 new
  `tests/unit/roots/*.test.ts` files (engine and store alike) join `cli/tests/unit/roots`, which
  already maps R4's store tests by the same convention. **All three** new `tests/unit/cli/*` files —
  `roots-check.test.ts` (T3), `roots-check-channels.test.ts` (T5) and
  `roots-status-modulators.test.ts` (T10) — join the existing `cli/tests/unit/cli/roots` node;
  `sibling-test-file`'s `collectTestFiles` recurses the children of `cli/tests/unit/cli`
  (`check.mjs:35-41`), so a file mapped there satisfies the check without a node of its own, and the
  leaderboard does not move. **`unmapped-files` is a
  blocking finding under `coverage.required: ["/"]` (`.yggdrasil/yg-config.yaml:9`)**, so a new file
  landing in no node fails the gate in whichever task first adds it — which is why the ownership is
  fixed here, once, rather than per task.
  **A mapping is not the whole of it: both nodes' `relations:` blocks grow too**, because the new
  files import modules those nodes do not reach today — which is why both appear in the edge audit
  above as edited rows (`cli/tests/unit/roots` 13 → 15, `cli/tests/unit/cli/roots` 7 → 8) rather
  than only here. This paragraph fixes *where a file lives*; the table fixes *what its node may
  reach*, and a task that adds only the mapping fails `relation-undeclared-dependency` at its own
  gate.

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
  findings, on a malformed model, on an internal throw, on a path outside the repo, **on a directory
  with no `.yggdrasil/` at all** (where `index` legitimately refuses with exit 1 and `check` must
  not — T3 Step 7), on a dormant project (`integration-design.md:80`; program plan `:270-271`). No `--exit-code` flag exists on
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
  (`v6-spec.md:719`). **This invariant governs faults that ESCAPE; it does not manufacture them.**
  Most of the fault classes the spec lists are absorbed before they can reach the boundary, by
  contracts this plan states elsewhere: a corrupt session line is skipped (T1 Step 3's per-record
  tolerance), an unreadable `demotions.json` reads as `undefined` (T1 Step 3's I/O half and criterion
  5b — the *content*-shaped cases are criterion 5, and the two are different faults with one
  outcome), a missing grammar is a `[]` skip and a parse failure degrades to `minimalFileScope`
  (D6's gates 1 and 5), **and a failed `.state/` append returns normally with the derived state lost
  (T1 Step 3b's writer contract and criterion 6c)**. Each of
  those is **one `debugWrite` and a continued run with normal findings — no incident** (R5-I15), and
  the two invariants are therefore complementary rather than contradictory: **R5-I15 lists what is
  absorbed, R5-I2 governs everything else.** What reaches the boundary is a genuine escape — a
  malformed model row, an unexpected throw inside a stage — and it exits through one catch. The **one** exception is the test/mutation harness
  path, which rethrows, because a harness that fails open converts every crash into a "no findings"
  pass. One boundary, two modes, selected by an explicit function option — never an environment
  variable (D18). *(T5 — criterion 4 pins the escaping regime, criterion 4b the absorbed one.)*
- **R5-I3 — Downgrade or silence, never upgrade (I2b).** Every machine-local modulator may lower
  severity or suppress; none may raise it (`v6-spec.md:81`). The complete modulator table for R5:
  (1) session dedup + budgets; (2) telemetry demotion via `demotions.json`; (3) staleness; (4)
  bash-sweep `seedTruncated` / `floodSkipped`. **Modulators (1) and (4) are session-scoped and
  surface in the session, not in `status`** — `status` has no session to speak of (T10 Step 1);
  (2) and (3) are repository-scoped and `status` lists them. So: **`status` lists every
  *repository-scoped* active modulator (T10); the two session-scoped ones surface on the channel that
  set them.** That is a deliberate, reasoned divergence from §3.3's literal "`status` lists every
  active modulator" (`v6-spec.md:81`) — derived at T10 Step 1, and flagged here the way D10 flags the
  channel names — not an omission. Modulator (4) of the spec's list — daemon-absent —
  is permanently active in this product (there is no daemon, `integration-design.md:374-381`) and
  is therefore folded into the channel table itself rather than being a live switch. *(T6, T9, T10)*
- **R5-I4 — Engine purity.** `verdict.ts`, `speech.ts`, `session-state.ts`, `health.ts`,
  `exemplars.ts` and `extract-file.ts` contain no `node:fs`, no `console.*`, no `Date.now()`, no
  `process.env`, no `process.stdout` — `extract-file.ts` included, which is why its signature takes
  `(relPath, content)` and the command layer reads the bytes (D6). Every clock reading, session identity, file read and file append is a parameter
  supplied by the command layer, and every side effect is *returned as data* (D1). This is not a
  style preference: `roots-engine` carries `deterministic`, `no-direct-fs` and `no-direct-console`
  (`yg-architecture.yaml:749-755`), and all three refuse the alternative. *(T2–T8 — `exemplars.ts`
  and `extract-file.ts` are created in T2 and T3, so the range starts at T2, not T3.)*
- **R5-I5 — Model determinism survives (I2a).** The three snapshot fields R5 adds (`exemplars`,
  `partitionRouting`, and the co-change rows' `commitsA`/`commitsB`) are total functions of inputs
  the snapshot already fixes, ordered by a stated total order, carrying no wall clock. Two `index --full` runs remain byte-identical, and an
  incremental index still equals a full one. *(T2)*
- **R5-I6 — Hook-time enumeration ≡ index-time enumeration.** For identical file content, the
  surfaces the check path computes for a scope equal, value for value, the surfaces the index
  computed for that same scope — same `stableId`, same `skeyR`, same domain membership. This is the
  hinge the whole increment hangs from: if it fails, every verdict is measured against a value the
  index never recorded. It is pinned by an explicit equivalence test over a golden fixture, not
  assumed from shared code. **D6's gates −1 and 0 are part of this invariant, not additions to it:**
  a file the index never *walked* (gitignored, symlinked, inside a nested checkout) and a file it
  walked but never *parsed* (test-pattern, excluded, outside `include`) both have no index-time
  enumeration to be equivalent to, so the honest equivalence is silence — which T3 criteria 14 and
  14b observe and T3 Step 1's harness, which drives a file that *was* mined, structurally cannot.
  *(T3 **Step 1**'s equivalence harness for the positive half, T3 criteria 14 and 14b for the silent
  half.)* The pointer names the **step**, not a criterion: T3's numbered criteria 1-6 are the six
  rows of its Δ-arithmetic table, and an earlier `criteria 1, 14 and 14b` resolved "1" to that
  table's first row — a Δ figure that has nothing to do with this invariant. Found by round 10's own
  mechanical cross-reference sweep after MAJOR-1, which is the sweep's whole point.
- **R5-I7 — Config verbatim.** R5 invents **no** config key. Every threshold it reads already
  exists in `DEFAULT_ROOTS` (`src/io/config-parser.ts:41-140`) with the spec's own default; the
  parser is where a default is checkable. The keys R5 newly *consumes* are named in D23. No graph
  schema version moves (AGENTS.md's two-version rule): the roots store carries its own
  `ROOTS_VERSION`, which **does** move (1 → 2, D3) precisely because the roots store's own format
  changed — while the graph's did not. That is the two-version rule working, not an exception to
  it, and no migration under `migrations/` is written because a derived snapshot's only correct
  migration is regeneration. **A THIRD version notion exists and does not move:**
  `HISTORY_STATE_SCHEMA_VERSION` (`src/roots/history-resume.ts:62`), the replay state's own schema
  version, is folded into `inputsHash` — bumping it makes `decideWalkMode` return `full`, i.e. a
  **whole-history re-walk for every adopter**, exactly the cost D11 refuses to impose for
  `body_hash`. Its own doc invites a bump when "a co-change row … changes shape", and T2 changes a
  co-change row, so the trap is live and the answer is derived rather than assumed: the resume path
  reads back **only** `cochange-raw.jsonl` (`parseCochangeRawRows(state.cochangeRaw)`,
  `history-resume.ts:394`), whose two row shapes (`{a,b,support}`, `{path,commits}`) T2 does **not**
  touch; the row T2 widens is the finished cut `CochangePair`, persisted to `cochange.jsonl`, which
  is "informational only — a resume reconstructs the finished cut fresh from `cochange-raw.jsonl`
  via `finishCochange`" (`history.ts:1091-1094`) and is never read back. **So: it does not move in
  R5.** Only a package that changes a *raw* accumulator row or a `meta.json` field may bump it, and
  that package owes every adopter a full re-walk in the same breath — a bounded, stated cost, not a
  free edit. *(T1, T2, T3, T6, T8, T9)*
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
  round-trips **every MR named in the tasks below**, MR-1 through MR-41 including the lettered
  variants (72 ids at present) — the phrase "every MR named
  in the tasks below" is the binding half and the numeric range is only an aid, so a task that adds a
  killer cannot fall outside the invariant every reviewer checks). A rule with no killer test is not done.
  **The invariant cuts both ways, and round 8 is why that is written down: an MR whose mutation
  cannot change any observable is not a killer, and keeping it is worse than having none** — it
  reports coverage the plan does not have. Three were retired for that reason (MR-32c and MR-32d,
  deleted outright at T8; MR-9c's original mutation, replaced). When a rule turns out to have no
  possible killer, the honest outcomes are to delete the rule or to record it explicitly as
  unkillable defense-in-depth; both were taken this round, and neither is left implicit. *(every task)*
- **R5-I12 — Every functional change lands with an end-to-end test.** AGENTS.md's standing rule
  (`AGENTS.md:101`): the test drives the complete user flow through the public surface — spawn the
  built `bin.js`, act as an adopter would, assert the flow's observable outcome (stdout, exit code,
  and the committed/derived files on disk). Unit tests alone are insufficient evidence. Each task
  below names its e2e file and the flow it drives; the two tasks with no adopter-visible flow
  (T1, T11) say so explicitly and name the task whose e2e covers their contracts. E2E files import
  nothing from `src/**` (`e2e-public-surface`). *(every task)*
- **R5-I13 — Compliance accounting never double-counts, and the STORE KEY is the mechanism.**
  Every append is idempotent under its own key. For telemetry the key is
  `(sessionId, stableId, surface, observedAfter)` and `observedAfter` is §9.10's **two-valued
  outcome label** (`'complied'`/`'ignored'`, absent on the intervention row) — so **at most three
  rows can exist per intervention**: the intervention row, one `complied`, one `ignored`
  (D13a(a),(c)). That is not a guard bolted on beside the rule; it *is* §9.10's "at most once per
  session per intervention" bound (`v6-spec.md:479`), realized mechanically. **No repeated `index`
  run, repeated in-session check, or changed deviating value can add a row** — the deviating value
  lives in `observed`, which is not in the key. Three earlier drafts of this invariant credited the
  bound to a fold flag or to two producers being mutually exclusive; both readings were wrong and
  both produced mutation tests that could not fail, so the invariant now names the key and only the
  key. **Two things the key does not bound, and each has its own named owner:** rows from different
  sessions (legitimate pooling — D13a(d), the only way n = 8 is reachable), and an `ignored` row
  followed later by a `complied` row for the same intervention (governed by transition 4's terminal
  `scope: 'cross-session'` marker — T8 Step 2b's terminal-marker rule). One row per outcome is permitted and correct;
  §18.2's own direction requires it, since suppressing a late `complied` biases that intervention to
  0 and pushes toward demoting a convention that was in fact followed. And the write order is chosen
  so a torn write biases toward *under*-recording, never toward demoting a healthy convention (D14).
  *(D13a is the derivation; T1 criteria 4b/4c for the key and the log enumeration, T6 for the fold
  field, T7 criterion 2 for the session-log half of the in-session bound, T8 criteria 4b/4c/4d for
  the terminal marker, the live-session exclusion and the re-run idempotence.)*
- **R5-I14 — No internal vocabulary in user-facing output.** Design §11's table
  (`integration-design.md:410-426`) binds every rendered string: no `FACT`, no `pid`, no `surface`,
  no `factKey`, no `roleKey`, no `Δ`, no `τ`, no "hook_shaped", no "partition `_all`". Numbers that
  are *evidence* (N of M established, share) stay. Cell keys, enumerator ids and thresholds appear
  only in `yg roots explain` — which is R7's, so in R5 they appear **nowhere** in stdout, and in
  `debugWrite` lines only. *(T4, T10)*
- **R5-I15 — Degrade, never abort; symmetric across reads and writes.** A corrupt session file, an
  unreadable `demotions.json`, a missing grammar, a file that will not parse, an `EACCES` on a
  `.state/` append — each is one `debugWrite` line and a continued run, **with findings still
  emitted and no incident recorded** (R4-I10). This is the **absorbed** list;
  R5-I2 governs what escapes it, and the two lists are disjoint by construction so the same input
  never has two prescribed outcomes.
  **Every one of the five names its owning contract, because "absorbed by construction" is only true
  if something absorbs it** — and two of the five are absorbed by contracts this plan had to *add*,
  since the landed helpers refuse them: `readFileOrDefault` rethrows every non-ENOENT error
  (`read-or-default.ts:5-6`) and `appendToDebugLog` is a bare `appendFileSync`
  (`debug-log-writer.ts:7-9`), so neither the unreadable file nor the failed append absorbs itself.
  The owners: corrupt session file → T1 Step 3's per-record tolerance; unreadable `demotions.json` →
  T1 Step 3's I/O half (criterion 5b); missing grammar and unparseable file → D6's gates 1 and 5;
  failed `.state/` append → T1 Step 3b's writer contract (criterion 6c). T5 criterion 4b is where all
  five are observable together, and MR-19b is the killer for any of them being "fixed" into a throw.
  **This is a declared divergence from a literal reading of §21.1, flagged in the same register as
  D10's channel names and T1's two file names rather than left as a silent reinterpretation.**
  §21.1 (`v6-spec.md:719`) writes: "The fail-open boundary MUST wrap the whole verdict entry
  point … a parse failure, a missing grammar, **a corrupt session file** or a malformed model row
  all have to exit through the same catch, **returning zero findings plus one incident**." Read
  literally, that prescribes an incident *and the loss of every finding in the run* for a single
  bad line in a session log. R5 reads the clause as governing faults that **escape**, and absorbs
  these five before they reach the boundary — because §21.1's own neighbouring clauses already
  prescribe degradation for two of them ("grammar or node-types load failure ⇒ that grammar
  disabled for the session; a blob that fails to parse is recorded as empty and the walk
  continues"), because I1 generalizes it, and because the literal reading would let one malformed
  line silence a whole run. **So `:719` is cited here as the text this invariant departs from, not
  as its authority** — an earlier draft cited it as support for the opposite of what it says. The
  corrupt-session-file case is the one §21.1 names explicitly on the incident side, and it is the
  one this invariant most deliberately flips; T5 criterion 4b is where that flip is observable. Derived state may be lost; the product may never be lost silently,
  and no degradation may ever *increase* what roots says. *(T1, T5, T6)*
- **R5-I16 — No new repo-check step.** The 17-step list in AGENTS.md is untouched; everything
  enters through the existing typecheck/lint/build/test/coverage/graph steps
  (`integration-design.md:513-517`). Latency budgets (`v6-spec.md:586`, `:712`) are measured by
  hand at T11 and reported, never gated — a timing assertion in the commit gate is flaky by
  construction. **T1 Step 6's `--file` query mode is inside this invariant, not an exception to
  it:** it adds an optional argument to a tool an existing step already runs, changes that step's
  own invocation and output not at all (criterion 8b is the byte-identity guard), and adds no step —
  so AGENTS.md's list and the advisory `repo-check-gate-steps` rule that protects seven of its
  entries are both untouched. *(T1, T11)*
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
  known.

  **The instrument that makes "each file's own margin" obtainable, named once here so all six
  measuring sites inherit it — and landed by T1 before the first of them runs.** As it stands
  `scripts/prompt-headroom.mjs` takes **no arguments** and prints, per tier, the single largest
  assembled prompt plus the next two (`:558-565`) and nothing else — so "read the per-file numbers"
  had no answer for any file outside that top three, which is every file this increment edits.
  **T1 Step 6 adds an optional `--file <repo-relative-path>` (repeatable) query mode** and all six
  sites call it. **The six, enumerated so the count is anchored rather than asserted:** T2 Step 1
  (`mine.ts`'s pre-edit baseline), T2 Step 6 (its after-report), and the four `roots-check.ts`
  obligations at T5 Step 6, T6 Step 6, T7 Step 5 and T9 Step 6. A seventh site used to be counted —
  D4's `m1` fallback gate on `roles.ts` — and it is gone: D4 no longer edits that file, so there is
  no margin for a gate to read. It is a small, purely additive change to repo tooling, and it is the right half of
  the fork for three reasons: the measurement it would otherwise be replaced by (hand-writing a
  1-char `max_prompt_chars` into the gitignored `yg-secrets.yaml` overlay, running
  `check --details`, grepping, restoring) is *precisely what this script already automates behind a
  signal-safe restore* (`:16-26`, `:33-45`), and asking six task steps to perform it by hand
  re-implements that restore six times; the data is already in hand at the print site (every parsed
  entry carries `unitKey` in the form `file:<path>`, its `chars`, its `aspectId` and its
  `tierName`); and `scripts/` is exactly where AGENTS.md puts dogfood measurement instruments.
  **"The margin" means one thing:** the tier ceiling minus that file's **largest** assembled prompt,
  since one file can appear in several LLM pairs. **A path that is no LLM subject at all has no
  margin**, the mode says so in those words, and every rule below that reads a margin is inapplicable
  to it rather than satisfied by it.

  **What the numbers are predicted to be, so a wildly different measurement is itself a signal.**
  A `roots-engine` file has exactly **one** LLM pair: `deterministic` (`yg-architecture.yaml:749-755`
  lists `source-no-raw-control-chars`, `deterministic`, `no-direct-fs`, `no-direct-console` and
  `source-hygiene`; only `deterministic` is `reviewer.type: llm`, `per: file`, content.md **1 182 B**
  — `source-hygiene` is an `aggregate` whose six children are all deterministic). By this section's
  own `file bytes + aspect bytes + ~1.8 K` relationship that puts `roles.ts` near **14 600** chars of
  margin and `mine.ts` near **13 400** — both an order of magnitude above the 2 000 trigger, so the
  fallback is expected **not** to fire. The prediction does not replace the measurement; it makes the
  measurement falsifiable. (`roles.ts`'s figure is retained as the calibration point it also is;
  the file itself is no longer edited — see the next paragraph.)

  **`src/roots/roles.ts` is not edited by this increment at all**, so `mine.ts` is the only large
  landed file whose margin this discipline applies to. D4 computes `m1` in `exemplars.ts` rather
  than extending `RoleClassification`, because that extension would break three exact-shape
  assertions in `tests/unit/roots/roles.test.ts` — the frozen file named two paragraphs above — and
  D4 carries the derivation. `exemplars.ts` and `extract-file.ts` reach `roles.ts`'s exported
  `roleJaccard`, `buildRoleFeatureBag` and `classifyAgainstMedoids` as *imports*; an import edits
  nothing.
  **So T2 measures `mine.ts`'s real margin BEFORE editing it**
  (`node scripts/prompt-headroom.mjs --file source/cli/src/roots/mine.ts` from repo root), caps its
  three edits at ~30 lines, and re-measures immediately after. If the pre-edit margin is under 2000
  chars, the edit moves to a new sibling module instead (T2 Step 2 names the equivalent: the
  exemplar and routing stages are already separate functions in `exemplars.ts` and can be *called*
  from `mine.ts` in two lines rather than inlined). Everything else goes in new files; every new
  test goes in a new sibling file; split before crowding the ceiling, never after.

  **One file in this increment has no legal split target, and the constraint is stated up front
  rather than discovered at T9:** `src/cli/roots-check.ts` receives orchestration from five tasks
  (stdin resolution, path safety, channel protocols, the session-identity ladder, intent
  application, staleness, the fail-open boundary), and both obvious escapes are closed by the
  architecture — a helper under `src/cli/` classifies as `command-support`, whose `calls:` reaches
  neither `roots-engine` nor `roots-store` (`yg-architecture.yaml:82`), and a second
  `register*Command` export is refused outright by `command-contract-shape` (`check.mjs:50-62`).
  Its practical ceiling is ≈ **66 KB of source** (the measured relationship is
  file bytes + aspect bytes + ~1.8 K of scaffolding, and `command`'s largest LLM aspect,
  `cli-command-contract`, is 3 124 B; for scale, `src/cli/roots.ts` is 40 830 B today and
  `src/cli/aspect-test.ts` is 64 438 B). **T5, T6, T7 and T9 each re-measure it with
  `node scripts/prompt-headroom.mjs --file source/cli/src/cli/roots-check.ts` in their own final
  step — the obligation is written into those
  four steps, not left here as a global note nobody owns — and report the figure.** The `--file`
  form is what makes those four obligations answerable at all: unless that one file happens to be
  inside the top three, the bare invocation prints three unrelated filenames and no figure for it. If it crosses, that is an
  architecture question — a new type or a widened `command-support` allow-list — and therefore a
  **STOP and report**, never a refactor a task performs on its own. (Graph-node `description:` growth is not a prompt risk — `src/llm/prompt.ts:179-181`
  excludes it from the assembled prompt.)
- **Aspect reviewers refuse, up front.** Before writing code, read the aspects binding your file's
  type. Beyond the seven `command` aspects named in the authorization section, **five** bind every
  new `src/io/` file (`yg-architecture.yaml:197-203`) — `source-no-raw-control-chars` (enforced),
  `silent-missing-files`, `atomic-write-contract`, `source-hygiene` and
  `read-or-default-via-helper`. The three with teeth on this increment: `read-or-default-via-helper` (an inline
  ENOENT-swallow around the **async** `readFile` must instead go through `readFileOrDefault` —
  that is the aspect's actual, narrower scope, `check.mjs:37-46`, not a blanket ban on try/catch),
  `atomic-write-contract` (**no `writeFile` / `writeFileSync` / `appendFile` / `appendFileSync` /
  `createWriteStream` imported from `node:fs` in any `src/io/*.ts`** — the JSONL appends of this
  increment route through `io/debug-log-writer.ts`'s `appendToDebugLog(filePath, text)`, the
  repository's existing single-write chokepoint for exactly this shape, already used by the
  committed advise register and the incident ledger), and `silent-missing-files` (an LLM aspect,
  judged per file). `roots-engine` additionally carries `deterministic` and `no-direct-console`.

  **Every count above is a *type-level* count, and the effective set is larger — the difference is
  enumerated here once so no task discovers it at its own gate.** Four enforced aspects are declared
  on the **`cli` node** and reach every descendant by node inheritance rather than by type
  (`.yggdrasil/model/cli/yg-node.yaml`'s own `aspects:` list): `wasm-tree-lifecycle`,
  `events-reader-boundary`, `instrument-import-fence` and `rules-artifact-names-single-source`. A
  fifth, `no-buildissuemessage-in-engine`, is declared on **`cli/io`** and therefore reaches the four
  new stores but not the command file. Measured live: `yg context --node cli/commands/roots` reports
  **18** must-satisfy aspects (the seven type-level ones, `cli-command-contract`'s implied
  `command-exit-codes`, `source-hygiene`'s six children, and the four inherited) and
  `--node cli/io/stores` reports **16** (five type-level, six children, the four inherited, and
  `no-buildissuemessage-in-engine`).
  **Two of the five have teeth on this increment and the rest are inert:**
  - **`wasm-tree-lifecycle`** forbids importing `parseFile` from `ast/parser` directly and requires
    `withParsedFile`, which is exactly what D6's gate 5 specifies (`withParsedFile(relPath, content,
    …)`). The compliance is therefore not accidental, but `src/roots/extract-file.ts` is precisely
    the file an implementer would reach for `parseFile` in — it is the increment's only new parsing
    module, and T5 criterion 4b even discusses `parseFile` throwing — so the rule is named here
    rather than left to be met by copying the landed loop.
  - **`no-buildissuemessage-in-engine`** refuses a `buildIssueMessage` call from `io/` (and `core/`,
    `ast/`): the four new stores return structured data and the command layer renders it. This is
    the one that cuts against a habit — the CLI message rule pushes every diagnostic through
    `buildIssueMessage`, and that rule is a *command-layer* rule.
  The other three (`events-reader-boundary`, `instrument-import-fence`,
  `rules-artifact-names-single-source`) bind import boundaries and artifact-name literals no file in
  this increment goes near.

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
  `speech.ts`, `session-state.ts`, `health.ts`, `exemplars.ts` **and `extract-file.ts`** perform no
  I/O — **six** modules, the sixth being the one whose no-read signature this decision spends a
  paragraph on (`(relPath, content)`, never a path to read; R5-I4 and the authorization table have
  said six since round 4, and this enumeration is the decision an implementer reads to learn what
  may touch the filesystem). **The pipeline,
  named once here so no task has to infer it:**
  ```
  extractScopesForCheck(relPath, content, config) -> RawScope[]  // extract-file.ts (T3) — the parse
  resolveRolesForCheck(units, partition, config)  -> roleOf      // extract-file.ts (T3) — the §8 ladder,
                                                                 //   upstream of the engine ON PURPOSE (M1)
  evaluate(VerdictInput) -> { findings, closureIntents }        // verdict.ts   (T3; closure filled at T7)
  applyBudgetsAndDedup(findings, fold, config, { sessionId, nowIso })
                          -> { emitted, emissionIntents }        // session-state.ts (T6) — §11.3's ONE authority
  render(emitted)         -> string[] | VerdictJson              // speech.ts   (T3 minimal, T4 complete)
  ```
  **The fourth argument is this stage's whole contract with the world, and it is fixed here rather
  than left to T6 to discover.** `sessionId` and `nowIso` are the *same two values* `VerdictInput`
  carries — one identity resolution (D12's ladder) and one clock reading per run, both performed by
  `src/cli/roots-check.ts`, never a second pair. The stage needs them because the records it returns
  demand them: §18.1's intervention row requires a `sessionId` **and** a `ts`, and the `'warned'`
  session event requires a `ts`. Neither is reachable from anything else it is handed — `findings`
  carry content only (every field of `TelemetryRecord` except those two), `foldSession`'s result
  carries no session id (the id is a *parameter* of the fold, not a field of its result) and no
  clock, and `RootsConfig` carries thresholds. R5-I4 forbids `session-state.ts` reading a clock or
  deriving an identity, so a parameter is the only legal form — exactly as it is for `evaluate`,
  which carries the same two fields for the same reason. **This is the argument list, whole: no
  later task widens it again**, and a task that finds it insufficient stops and reports rather than
  adding a fifth.

  `Intents` is a plain, sorted record of *what should be appended where* —
  `{ sessionEvents, telemetry, ledgerMarks }`. **There are two engine producers and one
  command-layer producer**, and the third is named here because a round of review found it had none:
  the **`'checked'` session event** (T6 Step 1b) is a **command-layer fact**, constructed by
  `src/cli/roots-check.ts` from the file set it resolved and merged into the applied `Intents`
  alongside the two engine-produced sets. It cannot come from either engine stage:
  `applyBudgetsAndDedup`'s only view of the run's *subjects* is `findings`, which exist solely for
  deviating scopes (the two context values beside them are an identity and a clock, not a file set)
  — so the silent-file case, the entire reason the event exists (T9 criterion 5b), is invisible to
  it by construction; and `evaluate`'s `closureIntents` is defined as the closure's records only. Putting
  it in the command layer moves no signature, which is what keeps T3's "every later task adds *data*,
  never a new parameter" true. All three sets are merged by the caller, and
  `src/cli/roots-check.ts` is the single place that applies them, in the single order D14 fixes.
  "Messages" in this plan always means `render`'s output, never `evaluate`'s return.

  **`evaluate` is called once per partition, and the concatenation order is fixed here** because
  §11.3's sort key `(severity desc, Δ desc, surface asc)` is **not total** — two findings on the
  same surface from different partitions tie on all three components, and the concatenation order
  would silently decide which of them survives the 3-per-response cut. A bare `yg roots check` over
  the dirty set routinely spans partitions in a monorepo. So: the command layer groups the resolved
  scopes by `partitionId`, calls `evaluate` once per group **in ascending `partitionId` order**, and
  concatenates the findings in that order, each group in its own input order. §11.3 then orders and
  truncates the concatenation, exactly once (R5-I9). Three reasons, each
  independently sufficient: `roots-engine` carries `no-direct-fs` and `deterministic`
  (`yg-architecture.yaml:749-755`), so the alternative is not available; a returned intent is
  assertable by value in a unit test, where a performed write is only assertable through the
  filesystem; and the fail-open boundary (R5-I2) can only be *one* catch if there is exactly one
  place that touches the world. The seam also makes the harness mode trivial — a harness runs
  `evaluate()` and discards `intents` (`v6-spec.md:730`: the harness runs hermetically, with no
  telemetry or session reads/writes).

  **The composition seam has three instances, and they are one rule.** Wherever the engine and the
  store would have to hand each other a symbol, `src/cli/roots-check.ts` (or `src/cli/roots.ts`)
  supplies it as a parameter instead, because `roots-engine` and `roots-store` are mutually
  unreachable (`roots-engine.calls` `:759` has no `roots-store`; `roots-store.calls` `:774-777` has
  no `roots-engine`) while `command` reaches both (`:61`): **(i)** the four `.state/` stores take an
  absolute `stateDir` rather than importing `rootsStateDir` (T1); **(ii)** `appendLedgerMarks` takes
  `keyOf` rather than importing `markKey` (D15); **(iii)** `health.ts` takes the snapshot stamp as a
  `snapshotContentHash: string` **parameter** rather than importing `snapshotContentHash` from
  `stores.ts` — the command layer computes it once from the body it just loaded and passes it in
  (D16, T8). Instance (iii) is stated here because it is the one an implementer would otherwise
  write without noticing: `health.ts` and `stores.ts` sit in the same directory, the ESLint
  genericity fence permits `src/roots/` → `src/roots/` (`eslint.config.js:133-134`), and plain
  `yg check` never runs the deterministic checkers — so the refusal would arrive only at
  `check --approve --only-deterministic`, at the end of the task, with the signature already cut.

  **Where the intent record shapes live, so neither layer has to import the other.** The engine must
  *name* what it returns and the stores must *name* what they append, and neither may import the
  other: `persistence-adapter`'s `calls:` is `[persistence-adapter, utility]`
  (`yg-architecture.yaml:207`) with `roots-engine` absent, while an engine that imported the stores
  would falsify the authorization table's own sentence and add an undeclared edge. So
  `SessionEvent`, `TelemetryRecord` and `DemotionsFile` are declared in **`src/model/graph.ts`** —
  the `types` node — exactly where `LedgerEntry` and `SeedEntry` already live and exactly how
  `stores.ts` already consumes them (`stores.ts` imports both from `../model/graph.js`). Both sides
  reach it legally (`roots-engine` `uses: [types]`, `:760`; `persistence-adapter` `uses: [types]`,
  `:208`), all three are pure interfaces so the `types` node's own "no runtime behavior" contract
  (`:341`) holds, and the authorization table's "they import no persistence adapter at all"
  stays true. **A function may not follow them there** — which is precisely why D15's `markKey`
  takes the caller-passes route instead.
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
  The rule `stores.ts` records at the constant today (`src/roots/stores.ts:25-37`) is a
  **release-boundary** rule, not a readability one, and R5 is overriding it — so it is rebutted here
  rather than recharacterized, the way D3 rebuts design §10's migrations paragraph below. The landed
  comment says the body "has never shipped in a release, so no adopter holds a v1 `model.json` …
  A version bump belongs to whichever package first changes the body's shape **AFTER a release**."
  R5 bumps for a *pre*-release body-shape change, against that rule's letter, because the rule
  answers a different question: it is about **compatibility** — who might hold an old-shaped file —
  and R5's problem is **regeneration**.
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
  (`roots.ts:403-409`). **No migration file is written, and that is not an omission — but it does
  need a rebuttal, because the design says otherwise and this plan cites the page it says it on.**
  Design §10 states "`rootsVersion` governs store migrations through the CLI's existing
  `migrations/` infrastructure" (`integration-design.md:406`). That infrastructure is
  **graph-schema-only**: `src/migrations/index.ts` is a `MIGRATIONS: Migration[]` list typed by
  `core/migrator.ts` and populated with `to-5.1.0`, and every entry rewrites the *committed graph*
  against `CLI_SUPPORTED_SCHEMA`. `model.json` is not graph state — it is derived, rebuildable
  state whose only correct migration is regeneration, and `readModel`'s throw *is* the trigger for
  it. Writing a `Migration` that "migrates" a file the next `index` regenerates from scratch would
  add a graph-schema entry that runs on graph loads and touches nothing roots owns. **This is the
  increment's second design-vs-landed reconciliation** (the first being D10's channel names and
  T1's two file names), recorded here so the execution protocol's "a spec section contradicts a
  decision" STOP does not fire on a contradiction this plan already resolved. T2 adds the criterion that pins it (an R4-shaped body on disk ⇒ the
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
    medoid bags `induceRoles` already built. **It is computed in `exemplars.ts`, from the exported
    `roleJaccard` (`roles.ts:194`) over those bags and the scope's own bag from the exported
    `buildRoleFeatureBag` (`roles.ts:149`). `RoleClassification` (`src/roots/roles.ts:335-339`) is
    NOT extended with an `m1` field, and `src/roots/roles.ts` is not edited by this increment at
    all.** Extending it was this plan's stated preference for eleven rounds and is **rejected on
    evidence**, recorded here rather than quietly swapped so no later round re-proposes it:
    `RoleClassification` is `classifyAgainstMedoids`' return type (its doc comment and declaration
    at `roles.ts:335-339`; the signature that returns it at `:351-357`),
    and three landed assertions in `tests/unit/roots/roles.test.ts` — `:162`, `:214`, `:230`, each
    `expect(result).toEqual({ roleIndex: 0, ambiguous: false })` — pin that object's **exact shape**,
    which vitest fails on an extra defined key. All three are success paths, so `m1?: number` buys
    nothing: left unset it defeats the one-home argument the extension existed for, and set it breaks
    the same three. And that file is one of the three the Global constraints freeze at 660 chars of
    margin and forbid growing "by a single character" — so the extension would have put a
    decision-vs-constraint contradiction, which this plan's protocol turns into a STOP, into T2's
    lap. (The other five `roleIndex` sites in that file — `:167`, `:171`, `:189`, `:197`, `:241` —
    read the field rather than the object and would have survived; three is the whole exposure, and
    three is enough.) `exemplars.ts` reaches both exported helpers **intra-node** (both are
    `cli/roots/engine`), so the computation costs no graph edge, no byte of `roles.ts` and no byte of
    its frozen test.
    **There is no margin-gated fallback on this bullet, and the absence is deliberate.** The
    condition the old fallback hung on — `roles.ts` measuring inside 2000 chars of the ceiling — is
    ruled out by the Global constraints' own prediction (≈14 600 chars of margin), and a conditional
    whose condition cannot hold is not a fallback but dead text that reports a safety net the plan
    does not have. It is the same failure R5-I11 names for killers, applied to a decision.
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
    the agent is shown as *the pattern to copy*. The rank key is therefore a **tuple**: the spec's
    score first, its own final tie-break last, one strictly-refining step between — and the middle
    element differs by cell class, per the `m1` bullet above: role facts rank by
    `(w·m1·centrality desc, w·m1 desc, stable_id asc)`, `_all` and directory facts by
    `(w·centrality desc, w desc, stable_id asc)`. This never contradicts the spec (it only breaks
    ties the spec left to a hash) and it is what makes the all-zero case sane.
  - **Top 3**, rendered `path:line#name` (`v6-spec.md:484`), stored as
    `{ rel, line, name }` exactly as Appendix D shows (`:890`).
  - **Render-time re-validation** (spec: "reaped scopes never render") is a **file-existence
    check**, not a re-parse. Re-parsing three exemplar files per message would
    multiply the hook's parse cost by four against a 700 ms cold budget (`v6-spec.md:586`), and the
    index — not the hook — is the authority on a scope's line number. A message whose exemplars all
    fail the existence check still renders, without the `See:` line; it does not become silence,
    because the deviation is still true.
    **It is performed by `src/cli/roots-check.ts`, as a step of the `VerdictFact` projection (D9),
    and "render-time" therefore does NOT mean "in the renderer".** That is not a filing preference:
    D1 puts rendering in `speech.ts`, which carries `no-direct-fs` and `deterministic` (R5-I4,
    `yg-architecture.yaml:749-755`) and may not `stat` anything, and `verdict.ts` may not either —
    so the only layer that can ask the filesystem a question is the one that already does, the
    command layer (`command` carries neither aspect, `:49-57`, and T3 Step 8 already `lstat`s every
    candidate path there). The rule is one sentence: **each `MinedFact.exemplars` entry survives
    into `VerdictFact.exemplars` only if `<repoRoot>/<rel>` still exists as a regular file**, and a
    failing `lstat` is a drop rather than an exception, exactly as in T3 Step 8. Placing it in the
    projection buys two things beyond legality: the renderer needs **no new rule at all**, because
    "no `See:` line when `exemplars` is empty" is behavior it already owes a fact with no
    conformers (T2 criterion 2); and the cost is bounded and statable — at most three `lstat`s per
    projected fact, once per run, no read and no parse, against the re-parse D4 rejected. **Owned by
    T3 Step 7b, observed by T3 criterion 16, killed by MR-14g.** Named that way here because a
    decision whose text lives only in this block is a decision the T1→T11 protocol will not build.
- **D5 — Hook-time partition resolution: `partitionRouting`.** `stable_id` folds `partitionId`
  (`v6-spec.md:245`), and telemetry, the ledger and the hook-shaped weight cap all key on
  `stable_id` — so a check path that guessed the partition would write marks the next index could
  never match. Re-deriving partitions live is not available: `derivePartitions`
  (`src/roots/partitions.ts:221`) needs the whole repo's raw scopes to apply the 300-scope floor.
  The snapshot therefore carries the *decision function*, not the decision.

  **The id domain first, because it rules out the obvious sentinel.** A partition id is one of:
  a package-root directory string, the literal `'_root'`, or the literal `'_repo'`
  (`partitions.ts:284`). And a package-root directory string **can be the empty string**:
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

  **A detected package root with no mined scopes still gets an entry, carrying the `_repo` bucket's
  own outcome.** `packageRootDirs` is built from the *file* list while `scopesByKey` is built from
  the *scope* list (`partitions.ts:232-250`), so a `packages/foo/package.json` whose directory holds
  no parseable scope appears in `sortedRoots` and in **no** `statusOfKey` entry — it has no final id
  at all, and "the final id `derivePartitions` gave that key" is undefined for it. Emitting `null`
  (silent) and omitting the entry (fall through to `fallback`) are both wrong for the same reason:
  the moment a scope *is* created there, that key enters `scopesByKey` below the 300-scope floor and
  merges into `_repo`. So the entry carries exactly that — `'_repo'` when the merged bucket survived,
  `null` when it did not — which is what the next index would assign to the first scope written
  there. Criterion 4b(v) pins it.

  **`fallback` answers the same question the same way when no scope ever routed to `'_root'`** — a
  monorepo whose every file lives under some package root, which includes fixtures (i) and (ii).
  `'_root'` is then absent from `scopesByKey` and has no final id either, so `fallback` carries the
  `_repo` bucket's own outcome: `'_repo'` if the merged bucket survived, `null` if it did not. Same
  rule, same reason — that is what the next index would assign to the first file created outside
  every package root, which is exactly the new-file case the hook exists for. Criterion 4b asserts
  it on fixtures (i) and (ii).

  **The matcher has one home, and it is not a second `keyFor`.** The lookup above is genuinely a
  second *implementation* of the arm test (the projection is of the decision, not of the code), so
  it is exported **once**, from `exemplars.ts` (engine-pure, no I/O), as
  `routePartition(routing, relPath): string | null`. Its **production caller is
  `src/cli/roots-check.ts`**, which routes each edited file before building the fact projection
  (D6); `mine.ts` never calls it, because the index already knows every mined file's partition. T2
  criterion 4 drives **that exported function** over every mined file rather than re-deriving the
  walk in the test, so there is exactly one copy of the matcher and the criterion checks it rather
  than a paraphrase of it.

  **Lookup replicates `keyFor` exactly** (`partitions.ts:239-244`), all three arms, in order:
  ```
  for (const r of roots) if (r.dir === '' || rel === r.dir || rel.startsWith(r.dir + '/')) return r.partitionId;
  return fallback;
  ```
  The first arm is not decoration: `keyFor` treats a root-level marker as matching everything, and a
  `startsWith(dir + '/')`-only lookup would both miss that case and miss a file whose own path
  equals the root string.

  **Order.** `derivePartitions` sorts `sortedRoots` by **descending string length**
  (`partitions.ts:237`), not by nesting depth, so the plan does not claim "most-nested first" as the
  rule. The persisted array is sorted `(dir.length desc, dir asc)`, which is *behaviorally
  identical* to `sortedRoots` and additionally total: two distinct equal-length directories can
  never both be ancestors of the same path (equal-length prefixes of one string are equal), and the
  one universal matcher, `''`, has length 0 and therefore sorts last — exactly the nesting semantics
  `keyFor` implements. The added `dir asc` tie-break changes no lookup and removes the only
  dependence on `Set` insertion order.

  **A routing entry also reconstructs the module-root arm** `finalizeUnits` needs (D6) — and it is
  derivable from the **resolved id alone**, which is the only way it can be stated here:
  `routePartition` returns `string | null` and structurally cannot report *which arm matched*, while
  this decision forbids a second copy of the arm walk. `derivePartitions`' own line is
  `moduleRootDir = finalId === '_repo' ? '' : key === '_root' ? '' : key` (`partitions.ts:291`), and
  an own-floor key's final id **is** that key (`finalId = status === 'own-floor' ? key : '_repo'`,
  `:284`) — so every branch collapses to a test on the id:
  ```ts
  moduleRootDir = (id === '_repo' || id === '_root') ? '' : id;
  ```
  Every case checks out against the landed line: a merged entry resolves to `'_repo'` ⇒ `''`; a
  `_root` arm that cleared its own floor resolves to `'_root'` ⇒ `''`; a root-level package's
  own-floor id is the empty string, which is also its `dir`, so both readings give `''`; every other
  own-floor id is literally the matched entry's `dir`. A `null` id is silence and has no module root
  to reconstruct. Nothing extra is persisted for it, and no caller re-walks `roots` to learn which
  arm answered — an earlier phrasing of this rule ("`''` when the resolved id is `'_repo'` **or the
  `fallback` arm matched**, otherwise the matched entry's `dir`") named a fact the return type does
  not carry, and an implementer needing `moduleRootDirOfFile` for D6's synthesized `PartitionMap`
  would have written exactly the second matcher this decision exists to prevent.

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
  silently change every surface id.

  **The parse step has a home, an interface and a node, decided here rather than left as a STOP for
  T3.** `extractUnits(relPath, source, tree, binding, options)` (`extract.ts:417`) takes an
  already-parsed `Tree` and a resolved `RootsBinding`, and the index produces both inside a ten-line
  loop in `parseAndExtractAll` (`pipeline.ts:101-118`) that has **no exported single-file
  equivalent**. R5 adds one: **`src/roots/extract-file.ts`**, a `roots-engine` module joining
  **`cli/roots/engine`**'s mapping (intra-node — it adds no edge, and it keeps the parse out of
  `src/cli/roots-check.ts`, whose ≈66 KB ceiling has no legal split target):
  ```ts
  export function minimalFileScope(relPath: string, binding: RootsBinding): RawScope;      // MOVED here from pipeline.ts
  export async function extractScopesForCheck(relPath: string, content: string,
                                              config: RootsConfig): Promise<RawScope[]>;

  // The §8 role ladder for the check path — rungs 0/1/2 (T3 Step 2). It lives HERE, beside the
  // parse, and not in `verdict.ts`, for the reason M1 exposed: rung 0 needs a whole `ScopeUnit`
  // (`unit.name`/`supertypes`/`decorators`/`fileImports` — `buildRoleFeatureBag(unit)`,
  // `roles.ts:149`) and rung 2 needs `RoleMedoid[]` plus three config numbers that do NOT all live
  // in one block — `roles.cloneMedoidJaccard` plus `thresholds.roleAmbiguityGap` and
  // `thresholds.roleMinMembership` (D23; the landed call site is `roles.ts:913`, which reads them
  // from exactly those two blocks) — so the whole `RootsConfig` is the honest parameter.
  // Those are exactly the inputs this module
  // already holds and `evaluate` deliberately does not. `extract-file.ts` is intra-node with
  // `roles.ts` (both `cli/roots/engine`), so both imports are edge-free.
  export function resolveRolesForCheck(units: readonly ScopeUnit[],       // finalizeUnits' output, this file
                                       partition: MinedPartition,        // the routed partition (D5)
                                       config: RootsConfig): (skeyR: string) => string | null;
  //   returns the RESOLVED governing role key, or null meaning "_all governance only".
  //   '-1' is never returned: an ambiguous scope resolves to null, exactly like an ineligible one,
  //   because both mean the same thing downstream (no role speech, `_all` still applies).
  ```
  Its body is the single-file projection of that loop — but a loop has an *input* as well as gates,
  and both halves have to be projected.

  **Gate −1: the file universe.** `parseAndExtractAll` iterates `walkRepoFiles(repoRoot)`
  (`pipeline.ts:92`), whose documented membership predicate (`src/io/repo-scanner.ts:524-538`,
  implemented in `collectFiles` `:55-96`) excludes **gitignore-matched paths** (a per-directory
  stack), **symlinks**, `.git` in both its directory and pointer-file forms, and **every
  separate-project subtree** — a nested checkout, submodule or linked worktree, pruned via
  `findNestedProjectRoots`. `forParsing` knows none of that: it is
  `include ∧ ¬(BUILT_IN_EXCLUSIONS ∪ config.exclude ∪ TEST_PATTERN_EXCLUSIONS)`
  (`partitions.ts:136`). The residue is real, not theoretical — `.git`, `.yggdrasil/`, `dist/`,
  `vendor/`, `node_modules/` are all built-in, but an adopter's gitignored `local-scratch/` or
  `.venv/`, and **a submodule at `packages/external/`**, are not. `getDirtyFiles` happens to be safe
  (`git status --porcelain` never lists ignored paths), but the other two candidate sources are not:
  a hook payload names whatever the agent just edited, and a positional `yg roots check <path>`
  accepts anything. Such a path would parse, route by directory prefix (which matches a submodule
  path under a package root perfectly happily), and be measured against `_all` facts mined from a
  tree it was never part of — the same harm gate 0 exists to prevent, one layer up, and it would mint
  `stableId`s the next index can never match, which then ride into `telemetry.jsonl` and, on
  compliance, into the **committed** `ledger.jsonl`.

  **The mechanism, chosen for cost as well as fidelity — three per-path tests built from
  `repo-scanner.ts`'s own exported helpers, never a re-implementation and never an O(repo) walk:**
  1. **`lstat`** — the path exists and is a **regular file**: not a directory, and **not a symlink**
     (`collectFiles` admits an entry only under `entry.isFile()`, `:99` — a symlink is neither
     `isDirectory()` nor `isFile()` and falls out of both arms). One syscall, and it
     **subsumes the existence filter** T3 Step 8 already performs, so the two are one test.
  2. **Nested-project boundary** — no ancestor directory strictly between the path and the repo root
     is a project boundary. **"Contains a `.git` or a `.yggdrasil` entry" is NOT the landed
     predicate, and the difference decides real cases**, so it is written out here rather than
     paraphrased (`repo-scanner.ts:260-269`, with `isGitBoundary` at `:322-335`,
     `isGitdirPointerContent` at `:305` and `directoryHasAnyFile` at `:339`). A directory is a
     boundary iff **either**:
     - it holds a `.git` **directory** containing at least one regular file at any depth, **or** a
       `.git` **file** whose content matches `/^gitdir:\s*\S/` once trailing newlines are stripped —
       git's own gitfile-pointer format. A `.git` **symlink**, an **empty** `.git/`, and a `.git`
       file holding anything else are each explicitly **not** boundaries, and the landed comment
       says so in those words;
     - **or** it holds a `.yggdrasil` **directory** (`e.isDirectory()`, not a file of that name)
       containing at least one regular file at any depth.

     **The narrowing is a call, not a copy.** `isGitBoundary` and `directoryHasAnyFile` are
     module-private today, so T3 **exports one new helper from `repo-scanner.ts`** —
     `isNestedProjectBoundary(dir: string, entries?: Dirent[]): Promise<boolean>` — containing
     exactly the `:261-266` predicate, and rewrites `walkForNestedProjectRoots` to call it with the
     `entries` it already has (so the index path gains **no** extra `readdir`). Gate −1 calls the
     same function per ancestor, omitting `entries`. That is what makes "cannot drift" a structural
     fact rather than a claim a test has to keep re-establishing; a second transcription of a
     four-branch predicate is precisely the thing this plan refuses elsewhere (D15, D20).
     **Cost, re-derived against the real predicate:** one `readdir` per ancestor (not an
     `existsSync` — the dirent *type* is load-bearing), plus, only for an ancestor that actually
     carries a marker, one short `readFile` (`.git` file) or one short-circuiting
     `directoryHasAnyFile` (a real `.git/` hits `HEAD` immediately). Over an ordinary chain that is
     zero or one extra call in total. Still **O(path depth), not O(repo)** — the headline the next
     paragraph rests on is unchanged.
  3. **Gitignore** — `isIgnoredByStack(absPath, stack)` (`repo-scanner.ts:33`), the exported matcher,
     with the stack assembled for the path's **own ancestor chain**: the root's via the exported
     `loadRootGitignoreStack` (`:21`) plus each intermediate directory's `.gitignore`, which is
     exactly the per-directory stack `collectFiles` accumulates as it descends (`:61-68`). No
     matching logic is rewritten here; only the traversal is replaced by a walk *up* one chain.

  **The cost is O(path depth) file reads per candidate, not O(repo)** — which is why
  `walkRepoFiles` itself is not called, even though intersecting with it would be the most literal
  projection: a recursive tree walk with a `.gitignore` read per directory does not fit a 700 ms cold
  hook budget, and `index` pays it once per build where `check` would pay it per edit. T11's dogfood
  step measures the real per-invocation cost of gate −1 beside its other figures.

  Then the loop's own gates, **all six, starting with the one an earlier draft of this decision
  dropped**:
  **(0) `makeRootsFileFilters(config).forParsing(relPath)`** (`pipeline.ts:103`, the filter itself at
  `partitions.ts:127-137`) false ⇒ `[]`; **(1)** `getGrammarForExtension` (`:104`) — no registered
  grammar ⇒ `[]`, the same skip the index performs; **(2)** `config.history.blobMaxBytes` and
  **(3)** `MAX_PARSE_LINES` (`:108-109`) ⇒ `[]`; **(4)** `bindingForAsset(assetNameOfWasmFile(...))`
  (`:111`); **(5)** `withParsedFile(relPath, content, …)` → `extractUnits` with `ExtractOptions`
  drawn from `config.enumerate.*` (`:96-100`), and the same catch degrading to `minimalFileScope`
  (`:117`).

  **Gate 0 is the load-bearing one and it deserves its own paragraph, because dropping it is not a
  performance bug — it is the product speaking where it has no evidence.** `forParsing` enforces
  `config.include`, `BUILT_IN_EXCLUSIONS` (`node_modules`, `dist`, `build`, `out`, `vendor`,
  `target`, `migrations`, `fixtures`, `__mocks__`, `**/*.d.ts`, `**/*generated*/**`, …) **and**
  `TEST_PATTERN_EXCLUSIONS` = `['**/*.test.*','**/*.spec.*']` (`partitions.ts:101-102`, `:128-130`).
  Without it, `extractScopesForCheck` returns real scopes for `src/order.test.ts`, for
  `dist/bundle.js`, for `types/api.d.ts` and for anything the adopter listed in `roots.exclude` —
  scopes carrying `stableId`s the index never minted, routed by `partitionRouting` (which knows only
  directory prefixes, never exclusions), and measured against `_all` facts mined **exclusively from
  non-test production code**. The predictable output is a WARN on an agent's test file for not
  carrying the decorator its production siblings carry, on the file class agents edit most often, in
  a product whose whole promise is precision. And an adopter's explicit `exclude:` would be silently
  inoperative on the only surface they ever see.

  **Is mining-only test exclusion the right rule for *speech*, or only for evidence? It is the right
  rule for both, and the reason is not symmetry — it is honesty about what was measured.** The index
  never mined a test file, so no fact was ever conditioned on one and no scope in one has an identity
  the model knows. Speaking about `src/order.test.ts` would mean measuring it against conventions
  derived entirely from code it is not a member of, and reporting the mismatch as a deviation. There
  is no evidence behind that sentence, so R5 does not say it: **silence on a file the index never
  mined is the only honest answer**, and it is the same answer §9.4c's survived-display gate gives
  for a fact with no established instances. (An adopter who *wants* test conventions mined removes
  the pattern from `roots.exclude`'s neighbourhood by widening `include`/narrowing exclusions — a
  config change that moves the index and the check path together, which is exactly the property gate
  0 preserves. A separate "conventions for tests" feature is not R5's, and is not smuggled in here by
  omission.)

  Reproducing every gate is not tidiness — omitting one makes hook-time and index-time enumeration
  differ on exactly the files where it matters, which is R5-I6.
  `minimalFileScope` is **module-private in `pipeline.ts` today** (`:44`), so T3 **moves** it here and
  `pipeline.ts` imports it back (intra-node): one implementation, shared by both paths by
  construction rather than by intent.
  **The signature takes `(relPath, content)`, never a path to read**, because `--content <p> --as <q>`
  (T5) evaluates content that is not on disk at `q` — settled now so the seam is not re-cut two tasks
  later — and because `roots-engine` carries `no-direct-fs`: the command layer reads the bytes and
  passes them.

  `finalizeUnits` reads `partitions.moduleRootDirOfFile`
  (`extract.ts:748`) — the **pre-merge package-root directory**, not `MinedPartition.moduleOfFile`
  (the resolved module directory, a different quantity) — so the synthesized map fills that slot by
  D5's own reconstruction rule, which reads off the resolved id alone:
  `(id === '_repo' || id === '_root') ? '' : id`, exactly equivalent to `derivePartitions`' own line
  (`partitions.ts:291`) given that an own-floor key's final id is that key (`:284`). Module-kind units are discarded before evaluation (§9.10's runner
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
  (`v6-spec.md:440`) — in R5 that cap is invisible because nothing reaches DENY, and it is still
  implemented and tested, because R6 turns the cap on the same day it turns DENY on.
- **D8 — Specificity governance: the evidence class is the survived-raw total.** §9.10 says at most
  one fact governs a scope per surface: "the applicable fact with the smallest evidence class
  (fewest survived-raw instances), ties broken role < directory < `_all`" (`v6-spec.md:455-456`).
  The concrete quantity is `MinedFact.nTotalRaw`, which `mine.ts`'s own field doc already defines
  as the survived raw population (`src/roots/mine.ts:130-132`) — not `counts`, which is weighted and
  seed-inclusive, and not `deviantsN`. Applicability is the spec's own three-way test: role facts
  of the scope's resolved role only, and **nothing** from a role that is ambiguous for this scope,
  untyped, or decorative (§8.10's `role_lift ≤ 0` demotion, `:360-362` — reachable via
  `isDecorativeRole`); directory facts whose `<dir>` is an ancestor of the scope's path; `_all`
  facts always. A scope with no role and no directory context is governed by `_all` alone (I5).
- **D9 — Severity in R5, and the inert DENY row.** The composed rule, stated once so no task
  restates half of it: **`severity = (denyEligible && !novel) ? DENY : WARN`**, where `novel` is
  D7's ⊥ case (the observed value is outside the fact's alphabet). The `!novel` conjunct is
  §9.7's binding clause — "a never-seen value is never denied" (`v6-spec.md:440`) — and it is a
  load-bearing rule with its own killer (MR-12b), not a note attached to D7. `denyEligible` reaches
  the engine as a plain `boolean` on `verdict.ts`'s **own** input projection — not as `MinedFact`'s
  literal `false` type. **The projection is built by `src/cli/roots-check.ts` from one
  `MinedPartition`, and FOUR of its fields are not copies of a `MinedFact` field**, so they are
  named here rather than left to be discovered: `partitionId` comes from the enclosing
  `MinedPartition.id`; `roleLabel` is the `label` of the `MinedRole` whose `roleKey` matches the
  fact's, and `null` for an `_all` or `d[<dir>]` cell (§11.1's first line needs the label, and
  §9.4i's `local (<dir>/)` / `package-wide (<id>)` / `repo-wide` labels need the partition id —
  without both, three of the four locality labels are unrenderable); `denyEligible` is the
  boolean widening above; and **`exemplars` is the surviving subset, not a copy** — D4's
  file-existence filter runs here, because the layers downstream of it (`verdict.ts`, `speech.ts`)
  carry `no-direct-fs` and cannot ask the filesystem anything (T3 Step 7b, T3 criterion 16, MR-14g).
  Every module-kind fact is dropped by the projection (T3).
  **The partition-label rule has THREE arms §9.4i does not spell out, decided here — because the
  id domain has three literals the naive rule renders wrongly, not one.** §9.4i
  (`v6-spec.md:428`, the section's closing sentence — the same line D9 cites below for the contrast
  wording; `:429` is the redundant-refinement-pruning paragraph and says nothing about labels)
  says `repo-wide` in `_repo` and `package-wide (<partition>)` otherwise. Both other literals in
  D5's own enumerated id domain are live final ids, and both break that rule in user-facing stdout:
  - **`''`** — the mainstream adopter shape (a `package.json` at the repository root). Literal rule
    ⇒ **`package-wide ()`**: an empty parenthesis.
  - **`'_root'`** — `keyFor` returns it for any file matching **no** package root
    (`partitions.ts:243`), and `finalId = status === 'own-floor' ? key : '_repo'` (`:284`), so a
    `_root` bucket that clears the 300-scope floor **survives under its own name** and `mine()`
    mines it like any other partition. Literal rule ⇒ **`package-wide (_root)`**: an internal
    sentinel printed at an agent. The shape that produces it is not exotic — package markers in
    subdirectories, **no** root-level marker, and ≥ 300 scopes outside every package: a monorepo
    with `packages/*/package.json` plus a large top-level `src/`, `tools/` or `server/`.

  So the rule is **`partitionId === '_repo' || partitionId === '' || partitionId === '_root'` ⇒
  `repo-wide`**, and `package-wide (<id>)` keeps its meaning for every named package. The label
  describes what a convention spans: a package whose root *is* the repository root spans the
  repository, and a catch-all bucket of everything outside every package likewise spans the
  repository — it is emphatically **not** a package, so `package-wide (_root)` would be false as
  well as ugly. `_root`'s own `moduleRootDir` is `''` (`partitions.ts:291`), which is the same
  answer arrived at from the other direction. **Both special arms are enumerated here once**, since
  the first was found in round 3 and the second in round 8 by the same reasoning applied to the same
  three-literal domain — a rule written as "`_repo` plus the exceptions we have hit so far" is what
  produced two rounds of this. That single indirection is what lets the
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
- **D11 — Non-hook scope selection: a declared, bounded superset of §19's rule.** **Spec §19
  (`v6-spec.md:698`) is the only authority for the no-argument form** — design §3's row documents
  `check <file...>` with the files required and says nothing about running with none
  (`integration-design.md:80`), so it is cited for the `[paths…]` half only. §19: with no path
  arguments the scope set is "scopes whose `body_hash` differs from HEAD, plus enclosing types and
  file scopes"; with `[paths…]` it is **every** scope in those files. The second half R5 implements exactly. The first half it
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
  **Degraded fallback, with the two cases kept apart.** `getDirtyFiles` returns **`null`**, never
  `[]`, when it cannot tell — its own contract says so in those words (`utils/git.ts:113-124`) — and
  the two answers mean different things: `null` is "not a git repository, or git is missing", and
  `[]` is "a git repository with a clean tree". `null` ⇒ silence plus one `debugWrite` line; `[]` ⇒
  silence and **no** log line, because a clean tree is the normal, correct, uninteresting case. A
  **shallow clone is not a degraded case here at all**: `git status` reports dirty files normally in
  one, so the shallow-clone caveat that belongs to the history walk does not belong to this path.
  Neither case is ever an error (R5-I15).

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
  **All three rungs yield the SAME shape — 12 lowercase hex characters — and the third is hashed
  too**, `sha256(ppid ∥ cwd ∥ UTC-day)[:12]`, matching the second rung's form. The spec writes the
  third rung as the tuple itself (`v6-spec.md:554`), and taking that literally would put a `cwd` —
  absolute, containing `/`, and on Windows a `\` and a drive colon — inside a value T1 turns straight
  into a file name (`sessionLogPath`) and T8 reads back out of one (`listSessionLogs`). Hashing is
  not a deviation from the ladder; it is the same one-way fold the rung above already applies, and it
  is what makes the id ↔ file-name inverse total. The day granularity survives the hash intact,
  since the UTC day is an *input* to it. **Consequence for T8:** the day is therefore **not**
  recoverable from a session id, which is why T8's "ended session" test reads the log's mtime rather
  than parsing its name.
- **D13 — The session log is the authority; telemetry is the durable mirror.** §11.4 defines
  session state as an append-only event log whose state is a fold (`v6-spec.md:554`), and §11.3
  says budgets are "enforced from the session event log" (`:551`). So: dedup keys, per-response and
  per-session budget counts, and the set of *open interventions* are all read from the session
  fold. `telemetry.jsonl` carries the same interventions in a role-free, cross-session, retained
  form for §18.2's pooling (`:681`, `:683`) and is never consulted for a budget decision. Both are
  idempotent under replay: the fold treats duplicate `(stable_id, surface, direction)` events as
  one, and §18.3's ledger dedupes on `(stable_id, surface, date)`. **Telemetry needs its own key and
  now has one: `(sessionId, stableId, surface, observedAfter)`** — an earlier draft asserted "each
  append idempotent under its key" (T7 Step 3) while naming keys for only two of the three stores,
  which left the one set that T8's re-runnable aggregation appends to unprotected.

  ---

  #### D13a — The sampling and demotion derivation (T7 / T8 / D13, one pass, from the spec)

  **This subsection is the single authority for the telemetry / demotion complex.** Three
  consecutive rounds produced a local patch here that a later round had to undo, each time because a
  step was re-derived without re-reading the spec's own field definitions. Rounds 6 and 7 both
  argued from "`observedAfter` is the observed value"; §9.10 says otherwise, in the very paragraph
  those rounds cited. So the whole story is derived once, here, and **T6, T7, T8, D14, R5-I13 and
  every criterion and MR in the complex restate this and add nothing to it.** T6 is on that list
  because T6 Step 3 is where the §18.1 *intervention* row is actually produced — an earlier draft
  omitted it and the table's Writer column then disagreed with the task (round 9, MINOR-6). A task
  that finds this derivation wrong stops and reports; it does not patch locally.

  **(a) The telemetry row, field by field, from §18.1 and §9.10.**
  §18.1 (`v6-spec.md:681`) fixes the row: "every message ⇒ `{sessionId, ts, stable_id, surface,
  factKey, expected, observed, severity, deltaBits}` to `telemetry.jsonl`; subsequent same-session
  observation of the same (stable_id, surface) ⇒ `{…, observedAfter}` (§9.10 closure)". §9.10
  (`:479`) fixes `observedAfter`'s domain, literally:

  > If one exists and `v == f.expected`: append `observedAfter: complied` to `telemetry.jsonl`
  > **and** the `{stable_id, surface, date}` mark to `hook-ledger.jsonl` (§18.3). If one exists and
  > `v` still deviates: append `observedAfter: ignored`

  So there are exactly **two kinds of row**, and `observedAfter` is a **two-valued outcome label**,
  never a value read off the code:

  | Field | On the INTERVENTION row (a message fired) | On the CLOSURE row (the pair was re-observed) |
  | --- | --- | --- |
  | `sessionId` | the session the message was emitted in (D12) | the same session — T7 is in it; T8 reads it from the log's file name |
  | `ts` | when the message fired | when the closure was observed |
  | `stableId`, `surface` | the intervention's identity | identical |
  | `factKey` | the fact as it was *then* (§18.2 re-resolves it at pooling time — T8 Step 1) | the `factKey` the closure observation itself resolved: identical for T7's in-session closures (same snapshot, same candidate fact), the **current** one for T8's pass, which resolved it forward. Either way §18.2 re-resolves at pooling time, so the stored string is a record, never a pooling key |
  | `expected` | the fact's expected value (§18.2's flip filter reads this) | identical |
  | `observed` | **the deviating value** — this is the only field that ever carries a code value | the value at closure, informational |
  | `severity`, `deltaBits` | as emitted | **as emitted — carried forward on the open intervention, never re-derived** (see the derivability note below) |
  | `observedAfter` | **ABSENT** — §18.2: "Resolved = has `observedAfter`; unresolved excluded from the denominator" | **`'complied'` or `'ignored'`, nothing else** |

  **`observed` and `observedAfter` are different fields and only the first holds a code value.** An
  earlier draft of T8 conflated them and built an arithmetic argument on the conflation; the whole
  of (c) below exists because that must not happen a fourth time.

  **Derivability, walked writer by writer — because a field this table names is a field some stage
  has to be *able* to construct.** Each producer's declared inputs were walked against this row list
  and two of them needed a contract change, both made at the definitions rather than left to an
  implementer:
  - **`sessionId` and `ts` on the intervention row** (and `ts` on the `'warned'` event) are not
    reachable from `applyBudgetsAndDedup`'s `findings`/`fold`/`config`, and R5-I4 forbids that module
    reading a clock or an identity — so **D1's pipeline gives the stage a fourth argument,
    `{ sessionId, nowIso }`**, the same pair `VerdictInput` carries and from the same producer.
  - **`severity` and `deltaBits` on a closure row** are the *emitted* pair, and a closure producer
    has no way to recover them by observation: at a `complied` closure the observed value equals
    `expected`, so a recomputed Δ is 0 rather than the gap the agent was actually shown, and a
    recomputation would additionally put a second copy of D7's arithmetic inside `verdict.ts`'s
    closure and a third inside `health.ts`. So **the `'warned'` session event carries `deltaBits`
    beside its `severity`, and `OpenIntervention` carries both forward** (T1's union, T3's
    interface): every closure producer — T7's in-session pair and T8's terminal pass alike — reads
    them off the fold and copies them. That is what makes "as emitted" literally true rather than
    aspirational.

  Everything else on this table is reachable without a contract change: `stableId`/`surface`/
  `expected` from the open intervention, `observed` from `surfaceValue` at closure (T7) or from the
  current index (T8), the closure `sessionId` from `VerdictInput` (T7) or the log's file name (T8),
  and the closure `ts` from `nowIso` (T7) or the injected `nowMs` (T8).

  **(b) The lifecycle of one intervention.** An intervention is identified by
  `(sessionId, stableId, surface)`. Every transition names the event that causes it, the rows it
  writes, and who writes them:

  | # | From → To | Event written (session log) | Telemetry row | Ledger | Writer |
  | --- | --- | --- | --- | --- | --- |
  | 1 | — → **OPEN** | `'warned'` | intervention row (no `observedAfter`) — *unresolved* | — | **T6**'s `applyBudgetsAndDedup`, in `emissionIntents`, for exactly the findings the budget emitted; applied by the command layer (D14) |
  | 2 | OPEN → **OPEN (ignore banked)** | `'closed'` `{outcome:'ignored', scope:'session'}` | `observedAfter:'ignored'` | — | T7, on an in-session re-check that still deviates |
  | 3 | OPEN *or* OPEN(ignore banked) → **CLOSED** | `'closed'` `{outcome:'complied', scope:'session'}` | `observedAfter:'complied'` | one mark | T7, on an in-session re-check that now conforms |
  | 4 | OPEN *or* OPEN(ignore banked) → **CLOSED (terminal)** | `'closed'` `{outcome:…, scope:'cross-session'}` | `observedAfter:'complied'` or `'ignored'` per the current index | one mark on the `complied` arm only | T8's pass, over an **ended** log |
  | 5 | any → **DROPPED** | *nothing* | *nothing* | — | T8's pass, when `stableId` no longer resolves |

  **Transition 1's writer is T6, not T7, and the two-task split is the point.** §18.1's row is
  written for "every **message**", and only the budget stage knows which findings became messages —
  a finding the per-response cap dropped was never shown to anyone and must not be recorded as an
  intervention (T6 Step 3 says so where it produces the set). T7 owns transitions 2 and 3: the
  *closure* rows and the ledger. An earlier draft's Writer cell said "T7, on emission", which
  contradicted T6 Step 3 in the one table the plan tells a task to trust literally.

  Three properties of this table are load-bearing and each is stated because a previous round got
  one of them wrong. **(i) Transition 2 does not close the record** — §9.10's bound is written over
  "the open record", present tense, *after* the ignore, so an `ignored` closure leaves the
  intervention open and only sets `ignoredRecordedInSession`. **(ii) Transition 4 is the pass's one
  and only touch of that intervention** — it is terminal for both outcomes, which is what the
  `scope:'cross-session'` marker records. **(iii) An intervention can legitimately produce both an
  `ignored` and a `complied` row** (2 then 3, or 2 then 4): one row per *outcome*, which is what
  R5-I13's bound — written over the `ignored` branch — permits and what §18.2's own safety direction
  requires (see T8 Step 2).

  **(c) What the dedupe key actually bounds, given (a).** The key is
  `(sessionId, stableId, surface, observedAfter)` with `observedAfter ∈ {absent, 'complied',
  'ignored'}`. Therefore **at most three telemetry rows can ever exist for one intervention** — the
  intervention row, the complied row and the ignored row — **and no fixture, re-run, re-fire,
  changed value or repeated `index` can produce a fourth.** Written out, because the plan has twice
  claimed the opposite:

  - **Bounded by the key (no other mechanism needed):** repeated messages for one pair in one
    session; repeated in-session `ignored` closures; the cross-session pass firing on the same
    intervention on many `index` runs; the pass banking an `ignored` that T7 already banked in the
    same session; **and a deviating value that changes between observations** — the value lives in
    `observed`, which is not in the key, so a changed value produces **no** new row.
    *(A note for any fixture that does change a deviating value for some other reason: it must
    change a surface that does **not** feed `stableId`, i.e. a decorator, a supertype or an import —
    never the scope's name or arity. `stableId = hash(partitionId ∥ relPath ∥ kind ∥ qualifiedName ∥
    arity)` (`extract.ts:627-628`), so a rename makes the recorded event unresolvable and T8 Step 1
    **drops** it, which is a different outcome from the one such a fixture is usually trying to
    show.)*
  - **NOT bounded by the key, and therefore the only places a real over-count can arise:**
    (1) rows from **different sessions** — which is legitimate pooling, not a defect: eight sessions
    that each warned and were each ignored *are* eight samples; and (2) **two different outcomes for
    one intervention** — an `ignored` row and a later `complied` row, which transition 4's terminal
    marker is what governs (T8 Step 2b's terminal-marker rule).

  **Consequence, recorded so no later round re-litigates it:** §9.10's "at most once per session per
  intervention" bound on the `ignored` branch is **enforced mechanically by this store key**, not by
  a fold flag. `ignoredRecordedInSession` therefore keeps exactly one job — stopping T7 appending a
  second `'closed'` event to the **session log** on a re-check (observable there, killed by T7
  criterion 2) — and T8's pass needs no rule of its own for it (T8 Step 2).

  **(d) Which demotion scenarios are reachable through the product.** Demotion needs
  `WilsonLB95(complied / (complied+ignored)) < 0.3` over `≥ 8` **resolved** rows (rows with an
  `observedAfter`). Given (c), resolved rows accrue **one per (session, intervention, outcome)**, so
  the only way to reach n = 8 is **eight distinct sessions** (or eight distinct `(stableId, surface)`
  pairs pooling into one `factKey`, which is the same arithmetic). Two producible paths:
  - **S1 — in-session, needs no `index` between sessions.** Eight sessions, each: `yg roots check`
    (warn) → edit something else → `yg roots check` again while the scope still deviates
    (transition 2). Eight `ignored` rows. **This is the path T8's e2e drives**, and it needs no
    filesystem-time manipulation at all.
  - **S2 — cross-session.** Eight sessions that each warned and never re-checked, whose logs are
    **ended** (mtime on an earlier UTC day — T8 Step 2a), then one `yg roots index`. Eight `ignored`
    rows from transition 4. Producible in a test by back-dating the eight logs' mtimes with
    `utimes`; producible in life by a week of ordinary work.
  - **NOT producible, and no criterion may assume it:** any n > 1 arising from repeated `index`
    runs, repeated checks in one session, or a changing deviating value. All three are bounded by
    (c). **An acceptance number that depends on one of them is unsatisfiable and must be deleted,
    not weakened.**

  **(e) The arithmetic, re-derived at a reachable n.** `WilsonLB95` at z = 1.96, n = 8 — the
  smallest n that can demote at all, and the n both S1 and S2 produce:

  | complied / ignored | p̂ | `WilsonLB95` | vs 0.3 |
  | --- | --- | --- | --- |
  | 0 / 8 | 0 | **0** (exactly — the `z·√(z²/4n²)` term cancels `z²/2n`) | demote |
  | 4 / 4 | 0.5 | **0.2152** | demote |
  | 5 / 3 | 0.625 | **0.3057** | **keep** — by 0.0057 |
  | 6 / 2 | 0.75 | **0.4093** | keep |

  The 4/4 and 5/3 rows are the pair that makes the *lower bound* observable rather than the point
  estimate: p̂ = 0.5 is comfortably above `minCompliance` 0.3, so a mutant that demotes on p̂ keeps a
  fact the rule demotes. The 5/3 row is the boundary and is quoted to four places because it clears
  0.3 by less than a hundredth — a criterion asserting "not demoted" there fails on any drift in z,
  in the formula, or in the rounding. Criterion 1's n = 10 rows are retained as unit-level pool
  arithmetic and are now labelled with the state that produces them (ten sessions), per (d).

  ---
- **D14 — Write order, chosen for the direction a torn write biases in.** Emission: render →
  **write the output first** → append the **`'checked'`** session event (the command-layer record of
  which files this run looked at — first among the session appends, so a run that emits nothing
  still records that it ran) → append the `'warned'` session events → append telemetry intervention
  lines. Closure: append the session `'closed'` event → append the telemetry `observedAfter` line →
  append the ledger mark (complied only). **The sweep path's two kinds ride the same order, and
  `'sweep'` does NOT replace `'checked'`:** on the bash channel a sweep that evaluates files appends
  **`'checked'` first** — carrying the ≤ `budgets.bashSweepMaxFiles` changed paths it **took up in
  that sweep** (its *participation* set: T3 Step 8 filter 1's output, capped by path order so the cap
  stays deterministic and matches §12.4's bound), never the seeded set and never the narrower
  post-`forParsing` set, since the payload is participation everywhere (T3 Step 8's fork) — and
  **then** `'sweep'` carrying the sweep's own state; a *seed* sweep, which
  evaluates nothing by design (T9 Step 1), appends `'sweep'` alone. `'stop'` is appended last on the
  stop channel, after any completeness output, since nothing reads it back within the same run.
  **The replacement reading is rejected explicitly**, because it is silently fatal rather than merely
  ambiguous: the `'sweep'` arm carries no `files` payload and folds only into
  `fileState`/`seedTruncated`/`floodSkipped`/`lastSweepTs`, so it is structurally incapable of
  feeding `writtenFiles` — under replacement, `writtenFiles` would be empty for **every**
  bash-shaped session, T9's completeness input `D` would be empty on exactly the flow T9's own e2e
  drives, and T6 Step 1b's stated reason for rejecting `fileState` as a source ("it covers Bash-sweep
  sessions only") would be inverted into its mirror defect. The alternative repair — giving `'sweep'`
  a `files` payload that also folds into `writtenFiles` — is also rejected: it would make two event
  kinds producers of one fold field, against D1's one-producer-per-set rule, for no gain. All five
  kinds are covered by this one order. **One writer sits outside the check path and is named here so
  "the single order" stays true: T8's cross-session closure pass** appends a terminal `'closed'`
  event with `scope: 'cross-session'` into an *ended* session's log — "ended" being the mtime-on-an-
  earlier-UTC-day predicate T8 Step 2a defines, not a loose word — followed by its telemetry sample
  and — on `complied` only — its ledger mark: the same session → telemetry → ledger order, applied by
  `index` rather than by a check run. The reasoning is the failure mode, not the happy path. A
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
  chokepoint per `atomic-write-contract`.

  **The dedupe key is supplied by the caller, not imported by the store, and that is an
  architecture constraint rather than a taste.** `markKey` lives in `src/roots/weights.ts:267-269`,
  which is type `roots-engine`; `stores.ts` is type `roots-store`, whose allow-list is
  `calls: [persistence-adapter, utility]`, `uses: [types]`, `default: deny`
  (`yg-architecture.yaml:774-777`) — **`roots-engine` is absent**, and `stores.ts`'s own header
  already states the rule in the other direction. So the signature is
  `appendLedgerMarks(yggRoot, marks, keyOf)`: `src/cli/roots-check.ts` — the one type that legally
  reaches both (`command` `calls:` includes `roots-engine` and `roots-store`, `:61`) — imports
  `markKey` and passes it in. This is the same shape T1 already uses for `stateDir`: the composition
  seam supplies what the two layers may not hand each other directly. **There is therefore exactly
  one key format in the tree and nothing to keep in sync** — no duplicated derivation, and so no
  divergence killer is needed. **That waiver has three obligations, and each is discharged onto an
  observer that can actually fail** — the sentence is written out that way because two earlier
  drafts discharged it onto one that could not:
  - **the engine's projection** (does the mark carry the identity the finding had?) — **T7 criterion
    7 leg B**, which drives `evaluate`'s own `closureIntents.ledgerMarks[0]` through R4's
    `releasedMarks` (`src/roots/weights.ts:250`) against a lifecycle index keyed on the *finding's*
    `stableId`, killed by **MR-29b**;
  - **the store/seam contract** (does a mark survive the write→read→`markKey` path byte-identical,
    and does `releasedMarks`' arithmetic hold at its exact thresholds?) — **leg A**, killed by
    **MR-29c**;
  - **the whole-domain case** (every `stableId` in the run drawn from the wrong domain, so mark and
    intervention agree with each other and are both wrong) — **T3 Step 1's equivalence harness**,
    the only thing in the increment that compares against the index itself. The `date` shape is T1
    criterion 3.

  Round 10's version named a criterion that did not exist; round 11's first repair named one whose
  inputs were literals, so the producer never ran under it. Both left the same real gap: a mark
  carrying a `stableId` from the wrong domain or a `surface` from the wrong projection passing T1
  criterion 3 and T7 criteria 1 and 5 and staying invisible to the P5 regulator forever, with the
  whole increment green. Two consequences are intended and must be stated in the
  docs, not hidden: `git status` shows a dirty `ledger.jsonl` after a productive session ("roots
  records that it shaped this code — commit it with your change", `:685`), and because
  `ledgerHash` is one of the model header's inputs, the **next** `yg roots index` will not take
  R4's D13 no-op short-circuit. That is the mechanism working: a new mark genuinely changes what the
  next model should say.
- **D16 — Where the demotion aggregation runs, and why it is outside the no-op short-circuit.**
  §18.2 says aggregation runs "in the same transaction as every snapshot write … and at
  `report`/`status`; never in hooks" (`v6-spec.md:683`). Taken literally against the landed `index`,
  that would strand it: **accumulating telemetry moves none of the eight header inputs
  `isNoOpShortCircuit` compares** (`src/cli/roots.ts:491-510`), so on a quiet repository — an agent
  ignoring the same convention across sessions without committing, which is *precisely* the case
  demotion exists for — `index` short-circuits, the aggregation never runs, and nothing ever
  demotes. R5 therefore fixes the placement explicitly:

  1. **The short-circuit governs the MINING, not the run.** `yg roots index` evaluates R4's D13
     short-circuit exactly as it does today, and when it fires it still writes nothing to `.cache/`
     and leaves `model.json` byte-identical — §6.6 clause 6's own wording is about writes to the
     cache (`v6-spec.md:260`).
  2. **The aggregation then runs unconditionally, after that decision**, reading whatever
     `model.json` is on disk and writing only `.yggdrasil/roots/.state/demotions.json` — a superset
     of §18.2's "every snapshot write", never a subset.
  3. **It takes no build lock, and needs none.** The lock serializes `.cache/` and `model.json`
     writers (R4-I12). `demotions.json` is a single file written through `atomicWriteFile`, so a
     reader never sees a torn one; two concurrent runs each write a complete, valid answer, and
     **last writer wins**. The justification is *not* that the two answers are necessarily identical
     — a hook can append to a session log between two runs' reads, so they may legitimately differ —
     it is the fail-open direction §18.2 itself fixes (`v6-spec.md:683`): a stale or missing
     `demotions.json` resurrects a fact, never silences one, so losing a race costs at most one
     round of speech and can never mute a healthy convention. Taking the lock, by contrast, would
     put a `.cache/` write back into the no-op path that R4's D13 exists to keep write-free — and
     that path is asserted by a landed test (D16.4).
  4. **It writes only on change — and on a repository with no telemetry it creates nothing at
     all, not even a directory.** The stricter half matters because R4's no-op assertion is
     stronger than a byte comparison: `cli-roots-basic.test.ts:46-52` snapshots **every path under
     `.yggdrasil/roots/` with its mtime and size** via
     `readdirSync(root, { recursive: true, withFileTypes: true })`, which includes dot-directories,
     and asserts `toEqual` on the second run (`:159`). `.state/` does not exist after any R4 run
     (`rootsStateDir`, `stores.ts:61-63`), so a single `mkdir(stateDir, { recursive: true })` at the
     top of a store writer — the most natural first line there is, and the obvious opener for a
     compaction pass that wants to `readdir` the session directory — adds a `.state` entry to that
     snapshot and **fails the landed test**. So: every read on this path goes through
     `readFileOrDefault` or an `existsSync` guard, and `mkdir` happens **only inside the writer,
     after the content-differs check has already decided to write**. **This prohibition is scoped to
     the aggregation path — `demotions.json` and the telemetry compaction at `index` — and is not a
     blanket ban on `mkdir`:** every *other* store writer creates its parent directory immediately
     before its first real write (T1 Step 2b), because nothing else creates `.state/` at all.
     `atomicWriteFile` already satisfies the rule on this path by mkdir-ing only inside itself
     (`atomic-write.ts:27-28`), so "skip the write when the content matches" is the whole of the
     implementation here. T8 criterion 7's converse asserts the whole-tree snapshot, not merely
     `demotions.json`'s absence, so the rule has a killer rather than a promise.
  5. **`status` computes and displays, and writes nothing** — the reader/writer split
     (`integration-design.md:161-164`). Concretely, and this is the part §18.2 hides: its
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
  (`2026-08-20-increment-3-r4-history.md:2321-2322`) — and R5 is in any case the only package that
  *can* host it, because its two inputs are the co-change cut (landed in R4) and the session's
  written-file set (which does not exist until this increment's session log). It is gated by
  `hooks.claudeCode.stopCompleteness` and `completeness.mode`, both already parsed with their
  defaults, and it renders Appendix A's **T5** template. Dropping it would leave the program plan's
  own scope law ("nothing here is deferred out of it") violated by omission.

  **The committed row cannot support it as landed, so T2 extends the row.** §13.5's rule is
  *directional* — `confidence(a→b) = support(a,b)/commits(a)` — and Appendix A's T5 evidence phrase is
  `{support}/{commits}`. What the snapshot carries today is `{a, b, sup, conf}` with `a < b`
  canonical (`history-cochange.ts:94`) and, decisively, `conf = Math.max(confAB, confBA)`
  (`history-cochange.ts:396-398`). From the max alone `confidence(a→b)` is **not recoverable**:
  using it as a proxy names `b` in the wrong direction whenever `b` is the churnier file — the
  commonest asymmetric pair there is (a test that changes often beside a source file that does not)
  — producing a false "you forgot to touch X" on exactly the pairs completeness exists to catch.
  And `commits(a)`, that template's own denominator, lives **only** in the gitignored
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
  instances yet" — §9.4c.4's J4 explanation, `:409`, `:697`), and the **composition alarm** —
  **Appendix A's T7 *content*, rendered in design §11's vocabulary rather than its literal template**
  (T10 Step 3 derives why: the template names a config key and a configured threshold, both of which
  R5-I14 confines to `explain`) — when `agentShare ≥ health.agentShareAlarm`. It does **not** gain `--exit-code`
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
  `confidence(a→b) ≥ minConfidence` admits (D20); `ledger.*` for release, already consumed by R4. **Three groups an earlier draft omitted, added
  because D23's inclusion criterion is "keys the check path reads" (it already lists `thresholds.*`
  and `cochange.*`, which R1-R4 also consume) and because "any new key is a STOP" makes the list
  load-bearing:** `enumerate.*` — `shapeDepth`, `shapeMaxStatements`, `localVarSampleMax`
  (`config-parser.ts:57-62`), the `ExtractOptions` D6's gate 5 passes to `extractUnits`, and
  `support`/`topK`, which reach the check path only through the snapshot's persisted vocabulary and
  are never recomputed (D6); **`history.blobMaxBytes`** (`:51`), D6's gate 2; and **`roles.*`** —
  **`minOwnFeatures`** (`config-parser.ts:136` — **not** `:135`, which is the neighbouring `minClusterSize: 3`), which T3 Step 2's **rung 0** needs, plus
  `cloneMedoidJaccard` (`:137`), `roleAmbiguityGap` and `roleMinMembership` (`:91-92`, in the
  `thresholds` block, not the `roles:` block — the `roles:` block itself is `:131-138`), which its
  rung 2 needs because the landed classifier's signature is
  `classifyAgainstMedoids(bag, medoids, cloneMedoidJaccard, roleAmbiguityGap, roleMinMembership)`
  (`src/roots/roles.ts:351-357`). All four are landed with the spec's defaults; none is new, so none
  trips this decision's own "any new key is a STOP".
  **Two more this list still omitted after round 10, and they are the two most load-bearing keys in
  the whole increment** — added because a T3 or T10 implementer checking a read against this list
  would find a key the decision does not name, and this plan's protocol turns a decision-vs-task
  contradiction into a STOP:
  - **`include` and `exclude`** (`config-parser.ts:42-43`, defaults `['**/*']` and `[]`). D6's
    **gate 0** *is* these two keys: `forParsing` is
    `matchesAny(relPath, includes) && !matchesAny(relPath, [...BUILT_IN_EXCLUSIONS, ...config.exclude,
    ...TEST_PATTERN_EXCLUSIONS])` (`partitions.ts:127-136`), and T3 criterion 14 drives **both** arms
    by name ("a path the fixture's `roots.exclude` names, and … a path outside a narrowed
    `roots.include`"). Nothing in the check path is read more often.
  - **`mdl.minInstancesRaw`** (`:78`, default 5). T10 Step 2's withheld predicate is
    `hookEligible === false ∧ nTotalRaw < mdl.minInstancesRaw`, and it is a **config** value, not a
    snapshot field. That it is `status`-side rather than check-side is no exclusion: this list
    already carries `health.agentShareAlarm`, which is `status`-only, so the operative bound is
    "keys R5 reads", which is what the decision's title says.
  Both are landed with the spec's defaults, so neither trips the STOP and R5-I7 holds unchanged.
  `budgets.daemonBudgetMs` is present in the config and is **never read** — there is no daemon
  (`integration-design.md:374`); leave it parsed and unused, and say so once where the budget
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
  **Owned by T10 — Step 6, criterion 6, MR-41.** Named here because a decision whose text lives only
  in this block, a carry-in and an open question is a decision the T1→T11 protocol will not build:
  a fresh implementer is told to build "the task from this plan plus the repository alone", and no
  task listed `src/cli/roots.ts`'s scaffold notice until round 8. T10 is its home because T10 is the
  increment's only other edit to that file's user-facing text.

---

## Task 1 — Seams, graph design-lock, and the four `.state/` stores

**Scope.** Everything that touches the filesystem, before anything computes a verdict: the four new
`src/io/roots-*-store.ts` modules, the ledger *append* added to `src/roots/stores.ts`, the snapshot
content-hash helper D16 needs, the two new graph nodes for them, and the verification that the
architecture admits all of it. **Plus one instrument: the `--file` query mode six later steps
measure with** — it is here because T1 is the only task that runs before the first of them. No
verdict logic, no message text, no command.

**Authorities.** Spec §11.4 (`v6-spec.md:554`), §18.1 (`:681`), §18.2's `demotions.json` stamp
(`:683`), §18.3 (`:685`), §21.1's incident FIFO (`:719`); design §4's storage layout
(`integration-design.md:122-165`), §12's "sessions as append-only event logs" and "incidents FIFO
500" rows (`:456`, `:466`); AGENTS.md's local-state rule.

**Files.**
- Create `source/cli/src/io/roots-session-store.ts`, `roots-telemetry-store.ts`,
  `roots-demotions-store.ts`, `roots-incidents-store.ts`.
- Edit `source/cli/src/roots/stores.ts` — add `appendLedgerMarks` and `snapshotContentHash`.
- Edit `source/cli/src/model/graph.ts` — declare `SessionEvent`, `TelemetryRecord` and
  `DemotionsFile` beside `LedgerEntry` (`:273`) and `SeedEntry` (`:248`), per D1. All three are pure
  interfaces, so the `types` node's "no runtime behavior" contract (`yg-architecture.yaml:341`)
  holds; that node carries no `log_required`, so the edit costs no log entry.
- Create `.yggdrasil/model/cli/io/roots-state/yg-node.yaml`,
  `.yggdrasil/model/cli/roots/speech/yg-node.yaml` (empty mapping until T3 — the design lock lands
  first), `.yggdrasil/model/cli/commands/roots-check/yg-node.yaml` (likewise), and
  `.yggdrasil/model/cli/tests/e2e/roots-verdict/yg-node.yaml` (likewise — **T2 lands the first e2e
  file into it**, and `unmapped-files` is blocking under `coverage.required: ["/"]`
  (`.yggdrasil/yg-config.yaml:9`), so the node cannot wait for the task that fills it).
- Create `source/cli/tests/unit/roots/session-store.test.ts`, `telemetry-store.test.ts`,
  `demotions-store.test.ts`, `incidents-store.test.ts`, and `stores-ledger-append.test.ts` — all
  under `source/cli/tests/unit/roots/`, **not** `tests/unit/io/`, following R4's own landed
  precedent for this subsystem's store tests (`blob-cache.test.ts`, `history-store.test.ts`,
  `build-lock-store.test.ts` all live there and are mapped by `cli/tests/unit/roots`). The new
  `stores-ledger-append.test.ts` is a **new sibling**: the existing `stores-ledger.test.ts` covers
  reading and is not to be grown into a second subject.
- Edit `scripts/prompt-headroom.mjs` — Step 6's optional `--file` query mode and its exported
  `selectFileMargins` seam; and extend `source/cli/tests/unit/prompt-headroom.test.ts`, the landed
  file that already owns that script's pure pieces (mapped by
  `.yggdrasil/model/cli/tests/unit/prompt-headroom`). **The one non-`source/cli` edit in this
  increment**, named here so it is not read as scope creep: it is a measurement instrument under
  `scripts/`, six later steps depend on it, and it changes no `repo-check.sh` step (R5-I16).

**Two names in this task diverge from the spec, both deliberately, both following the landed
tree** — flagged the way D10 flags the channel names, so a reviewer does not read either as a
misquote. The spec calls the committed mark file `hook-ledger.jsonl` (`v6-spec.md:685`); the design
(`integration-design.md:133`) and R4's landed `LEDGER_FILENAME` (`src/roots/stores.ts:43`) both say
**`ledger.jsonl`**, and R4 shipped it. The spec puts incidents in `.roots-state/incidents.jsonl`
(`:719`); the design's storage layout (`:137-138`) and R4's landed `STATE_DIRNAME` both say
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
  `readFile` (`check.mjs:36-48`) — `readFileSync` with a bare try/catch is legal and is the
  established pattern in `incidents-store.ts:170-174`. Sync would therefore have been *permitted*;
  it is rejected here for the `atomicWriteFile` reason above, not by that aspect.)*

**Interfaces produced.**
```ts
// The three record shapes below are declared in `src/model/graph.ts` (the `types` node), NOT in
// these files — D1's seam: the engine returns them and the stores append them, and neither layer
// may import the other. They sit beside `LedgerEntry` and `SeedEntry`, which `stores.ts` already
// imports from exactly there. The stores import them and re-export nothing.
//
//   SessionEvent — a discriminated union on `kind`; every payload field below feeds a named
//   `foldSession` result (T6 Step 1), so none of them may be left to an implementer's choice:
//     { ts, kind: 'checked', files: string[] }                                  -> writtenFiles
//     { ts, kind: 'warned',  stableId, surface, expected, observed, factKey,
//                            severity: 'WARN' | 'DENY', deltaBits: number }     -> warnCount, dedupKeys,
//                                                                                  openInterventions
//       `severity` and `deltaBits` are §18.1's emitted pair, and they are on the EVENT so that
//         `OpenIntervention` can carry them forward to whoever closes the intervention — T7 in the
//         same session, T8's pass a day later. Without them on the log, a closure row's "as
//         emitted" pair (D13a(a)) would have to be recomputed from the fact at closure time, which
//         on the complied arm yields 0 rather than the gap the agent was shown and puts a second
//         copy of D7's arithmetic in two more modules.
//     { ts, kind: 'closed',  stableId, surface,
//                            outcome: 'complied' | 'ignored',
//                            scope: 'session' | 'cross-session' }               -> openInterventions
//       scope 'cross-session' is TERMINAL for BOTH outcomes: T8's pass has already recorded that
//         intervention's outcome and the session that owned it is over, so no later sighting can
//         add anything; the marker is what stops the pass re-firing on every subsequent index
//         (D16.2 runs it unconditionally). Only T8 writes it; T7 always writes 'session'.
//       With scope 'session':
//       'complied' REMOVES the intervention from openInterventions (it is finished).
//       'ignored'  LEAVES IT OPEN and only sets ignoredRecordedInSession = true — §9.10's bound is
//                  written over "the open record", present tense, AFTER the ignore
//                  (`v6-spec.md:479`), and ignoredRecordedInSession is meaningless on a record
//                  that no longer exists. See T7 Step 2 for what removal would cost.
//     { ts, kind: 'sweep',   fileState: Record<string,string>,
//                            seedTruncated: boolean, floodSkipped: boolean }    -> fileState,
//                                                                                  seedTruncated,
//                                                                                  floodSkipped,
//                                                                                  lastSweepTs (= ts)
//     { ts, kind: 'stop',    completenessEmitted: boolean }                     -> completenessEmitted
//   T6 folds every one of these; T9 only POPULATES the two sweep kinds, so T6 cannot defer their
//   shapes to T9.                                                                            // §11.4
//   TelemetryRecord { sessionId, ts, stableId, surface, factKey, expected, observed,
//                     severity, deltaBits,
//                     observedAfter?: 'complied' | 'ignored' }                              // §18.1
//     `observed` is the deviating CODE VALUE; `observedAfter` is §9.10's two-valued OUTCOME LABEL
//     (`v6-spec.md:479`), absent on the intervention row and present on the closure row. They are
//     different fields with different domains — D13a(a). The union type is written out rather than
//     left as `string?` precisely so a `TelemetryRecord` carrying a code value in `observedAfter`
//     does not typecheck: three review rounds conflated the two, and the type is the cheapest place
//     to make that impossible.
//   DemotionsFile   { snapshotContentHash, demoted: string[] }  // sorted factKeys           // §18.2

// roots-session-store.ts — §11.4: O_APPEND, one event per line, state = fold.
export function sessionLogPath(stateDir: string, sessionId: string): string;
export function readSessionEvents(stateDir: string, sessionId: string): Promise<SessionEvent[]>;      // tolerant: bad line skipped
export function appendSessionEvents(stateDir: string, sessionId: string, events: readonly SessionEvent[]): Promise<void>;
export function listSessionLogs(stateDir: string): Promise<{ sessionId: string; mtimeMs: number }[]>;
                                          // sorted by sessionId asc; [] when .state/sessions/ is absent — it
                                          // CREATES nothing. `sessionId` is `sessionLogPath`'s inverse: the
                                          // file stem. T8's cross-session pass is the only consumer and needs
                                          // BOTH halves — the id because no event carries one (T6 Step 1), and
                                          // the mtime because that is how "ended session" is decided (T8 Step 2a).
                                          // Without this the pass has no way to enumerate its own domain, which
                                          // is the gap that let "ended session" go undefined through six rounds.
export function pruneSessions(stateDir: string, pruneDays: number, nowMs: number): Promise<number>;   // mtime-based, returns count

// roots-telemetry-store.ts — §18.1: role-free keys, retention compacted at index.
export function readTelemetry(stateDir: string): Promise<TelemetryRecord[]>;
export function appendTelemetry(stateDir: string, records: readonly TelemetryRecord[]): Promise<void>;
                                          // dedupes on (sessionId, stableId, surface, observedAfter) — D13
export function compactTelemetry(stateDir: string, retentionDays: number, nowMs: number): Promise<number>;

// roots-demotions-store.ts — §18.2: stamped with the snapshot content hash.
export function readDemotions(stateDir: string): Promise<DemotionsFile | undefined>;// absent/corrupt => undefined
export function writeDemotions(stateDir: string, file: DemotionsFile): Promise<void>;// atomic; skipped by the caller when unchanged (D16.4)

// roots-incidents-store.ts — §21.1: FIFO 500, local, machine-written.
export interface RootsIncident { ts: string; stage: string; message: string }
export function appendIncident(stateDir: string, incident: RootsIncident): Promise<void>;  // trims to the FIFO cap
export function readIncidents(stateDir: string): Promise<RootsIncident[]>;

// stores.ts additions (this file keeps its yggRoot-shaped signatures — it is the roots store,
// and it already owns `rootsStoreDir`; only the four `src/io/` modules take an absolute dir)
export function appendLedgerMarks(yggRoot: string, marks: readonly LedgerEntry[],
                                  keyOf: (m: LedgerEntry) => string): Promise<void>;  // dedupes by keyOf — D15
export function snapshotContentHash(body: unknown): string;                                       // see Step 5 for the exact envelope
```

**Steps.**
- [ ] **Step 1: Verify the architecture admits every new file and node** — the table in the
  authorization section, checked live: each `when:` predicate against the real path, each import
  edge against the real `relations:` list, `max_direct_relations` against the new nodes' edge
  counts, **the acyclicity of the new relation set** — `checkNoCycles`
  (`src/core/checks/relations.ts:73`), the one architecture check the rest of this list does not
  perform, and the one that the increment's own node design can break without touching
  `yg-architecture.yaml` at all — and the fan-out leaderboard pin. **STOP and report a dictated minimal
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
- [ ] **Step 2b: The directory contract, because nothing creates `.state/` and the mandated append
  helper will not.** `appendToDebugLog` is `appendFileSync(filePath, text, 'utf-8')` and nothing
  else (`src/io/debug-log-writer.ts:7-9`) — it creates the **file**, never the **directory** — while
  `atomicWriteFile` **does** `await mkdir(dir, { recursive: true })` (`src/io/atomic-write.ts:27-28`).
  The asymmetry runs exactly the wrong way here: the one path D16.4 forbids from creating anything
  eagerly (`demotions.json`) gets its `mkdir` for free, and the three that **must** create it — the
  session log, `telemetry.jsonl`, `incidents.jsonl` — do not. And `.state/` does not exist: no R4 run
  ever creates it (`rootsStateDir`, `stores.ts:61-63` — D16.4's whole argument depends on that), and
  §11.4's session path needs a **second** level, `.state/sessions/`. Implemented as written, every
  append would throw ENOENT, R5-I15 would degrade it to one `debugWrite`, and the product would ship
  with permanently empty session state — no budgets, no dedup, no compliance loop, no incidents —
  and no error anywhere.
  **So, stated once and applying to every store in this task:** each *writer* calls
  `mkdir(path.dirname(target), { recursive: true })` immediately before its first write — never at
  module load, never on a read path — and each *reader* goes through `readFileOrDefault` or an
  `existsSync` guard and creates nothing. `mkdir` is legal here: it is absent from
  `atomic-write-contract`'s `RAW_WRITE_FNS` (`check.mjs:4`), and `persistence-adapter` does not carry
  `no-direct-fs` (`yg-architecture.yaml:197-203`). This is **not** in tension with D16.4, whose
  prohibition is scoped to the *aggregation* path — see D16.4's own wording.
- [ ] **Step 3: Tolerance, per store, stated in each file's header.** Session, telemetry and
  incident logs are **per-record tolerant** — a malformed line is skipped, never fatal (I1, and the
  same tolerance `readSeeds`/`readLedger` already document). `demotions.json` is **all-or-nothing**:
  a corrupt or stale-stamped file reads as `undefined`, which means "no demotions", which is the
  fail-open direction §18.2 chooses. Each header names which tolerance it has and why.
  **The tolerance is over I/O as well as over records, and that half has to be written down because
  the mandated helper refuses it.** `readFileOrDefault` swallows **ENOENT only** and rethrows every
  other error by documented contract — "Any other error (EACCES, EISDIR, EIO, …) is rethrown —
  callers must handle real failures" (`src/io/read-or-default.ts:5-6`). So an unreadable
  `demotions.json` — a mode-`000` file, or a directory sitting where the file should be — does **not**
  currently read as `undefined`; it throws out of the store, out of the check path, and into R5-I2's
  single catch, which would silence the whole run and mint an incident for a fault R5-I15 names as
  absorbed. **Therefore: every reader in this task returns its empty/`undefined` answer on ANY read
  failure, not only ENOENT and not only a parse error.** Each reader wraps its
  `readFileOrDefault`/`existsSync` call and emits one `debugWrite` line naming the path and the
  errno. That wrapper is legal here and the reason is mechanical rather than a judgement call:
  `read-or-default-via-helper` fires only on an inline ENOENT-swallow around the **async `readFile`**
  itself — its own test is `/\breadFile\s*\(/` on the try body **and** an `'ENOENT'` check in the
  handler (`check.mjs:36-48`) — and a `try { await readFileOrDefault(…) } catch` matches neither
  half.
- [ ] **Step 3b: The writer contract — degrade, never abort, symmetric with Step 3.** The append
  chokepoint Step 2 mandates is a bare synchronous write: `appendToDebugLog` is
  `appendFileSync(filePath, text, 'utf-8')` and nothing else (`src/io/debug-log-writer.ts:7-9`), so
  an `EACCES`, `EROFS`, `ENOSPC` or `EISDIR` on a `.state/` append **throws** out of
  `appendSessionEvents` / `appendTelemetry` / `appendIncident`. Left unhandled it would reach R5-I2's
  boundary, and R5-I2's own rule would then prescribe "zero findings plus exactly one incident
  record" for an input R5-I15 promises is absorbed — the one pair of invariants this plan says are
  disjoint. **So: every writer in this task swallows its own failure to one `debugWrite` line and
  returns normally.** A failed `.state/` append loses derived state, which R5-I15 permits; it may
  never lose the run's findings and it may never mint an incident.
  **Three reasons, each independently sufficient, and the direction is the spec's own.** §18.2 fixes
  the acceptable direction for losing exactly this class of local derived state — "a lost demotion
  resurrects a FACT, never falsely silences one" (`v6-spec.md:683`) — and converting a lost append
  into a silent run is the opposite direction. §21.1's neighbouring clauses already prescribe
  degradation rather than abortion for the faults it does not put on the incident side ("store
  corrupt ⇒ degraded + doctor rebuild"; "a blob that fails to parse is recorded as empty and the walk
  continues", `v6-spec.md:719`). And D14 writes the **output first**, before any append, so by the
  time an append can fail the message is already on stdout: a catch reporting "zero findings" would
  be describing a run that in fact spoke, and it would be trying to record its incident in the very
  directory that just refused a write.
  **This is not in tension with Step 2b.** Step 2b makes the writer create its parent directory
  before its first write; this step governs what happens when the write fails anyway. A `mkdir` that
  itself fails is a write failure like any other and takes the same path.
  `appendLedgerMarks` (`src/roots/stores.ts`) follows the same rule for the same reason, with one
  difference stated so it is not read as an inconsistency: its target is the **committed**
  `ledger.jsonl` rather than `.state/`, so a failed append there loses a compliance discount — the
  status quo ante, and the direction §18.2 permits — rather than local state.
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
- [ ] **Step 6: The per-file prompt-margin query mode — because six later steps are told to read a
  number the instrument cannot print.** `scripts/prompt-headroom.mjs` takes no arguments today; it
  prints, per tier, the largest assembled prompt and the next two (`:558-565`) and stops. T2 Step 1,
  T2 Step 6, and the four `roots-check.ts` obligations at T5 Step 6, T6 Step 6, T7 Step 5 and T9
  Step 6 all ask for a *specific file's* margin — six sites, enumerated in Global constraints. This step lands the mode, in T1 because T1 is the only task that runs
  before the first of them.
  **Interface — additive, and the no-argument invocation's output must not change by one byte**,
  since `scripts/repo-check.sh:209`'s step and the gate's reported figure are that output:
  ```
  node scripts/prompt-headroom.mjs [--file <repo-relative-path>]...      # repeatable
  ```
  With one or more `--file`, **after the existing per-tier block AND its summary line — i.e. as the
  last thing printed before `process.exit(0)` (`:570`)** — the script prints, for each requested
  path in the order given:
  - one line per measured pair whose `unitKey` is `file:<path>` — `<chars> chars (aspect '<id>',
    '<tier>' tier) — margin <ceiling − chars>` — sorted by margin ascending;
  - one summary line, `<path>: margin <M>`, where **M is the smallest of those margins** (the ceiling
    minus that file's *largest* assembled prompt). That is what "the margin" means everywhere in this
    plan, and it is spelled out because a file can appear in several LLM pairs;
  - and, when the path matched no pair at all, `<path>: no LLM aspect binds this file — no assembled
    prompt and no margin`, then continue to the next path. **Not an error and not an empty line, and
    the exit code does not move:** an unmatched path is not a failure — the script exits 0 on its
    normal reporting path (`prompt-headroom.mjs:570`) and reserves the **non-zero** exit of `fail()`
    (`:452`) for a run it could not perform at all (a missing built binary `:455`, a missing config
    `:456`, an unresolvable tier ceiling, a `parsePromptTooLargeEntries` wording mismatch). **Do not
    "fix" `fail()` to exit 0** — that is the gate step's own error reporting, and an earlier draft's
    "exits 0 on every path" invited exactly that. A rule below that reads a margin is
    *inapplicable* to an unmatched file rather than satisfied by it.
  **The placement of that block is a rule, not a description, and criterion 8b is why.** 8b asserts
  that the no-argument run's per-tier block **and its summary line** are byte-identical to the
  `--file` run's first N lines, with the query block appended after them and nothing else. The
  per-tier block ends at `:565` and the summary line is printed at `:567`, so an implementer who
  read "after the existing per-tier block" literally and inserted between the two would split the
  baseline the guard compares against — failing 8b while passing every test of the new mode itself.
  The query block goes after `:567` and before `:570`, full stop.
  **The pure seam and its test.** Factor the selection into an exported
  `selectFileMargins(entries, tierLimits, paths) -> [{ path, pairs: [{aspectId, tierName, chars,
  margin}], worstMargin: number | null }]` and unit-test it offline in
  `source/cli/tests/unit/prompt-headroom.test.ts`, exactly as that file already tests
  `computeTierMargins`, `resolveTierLimits` and `parsePromptTooLargeEntries` — no subprocess, no
  `dist/`, hand-built `entries`. The data needed is already in hand at the print site: every parsed
  entry carries `unitKey` (`file:<path>`), `chars`, `aspectId` and `tierName`
  (`prompt-headroom.mjs:249-254`), and `computeTierMargins` already resolves each tier's ceiling.
  **The default-output guard (criterion 8b) is the one piece that must spawn**, and it spawns
  against a **scratch fixture project with a frozen graph**, not against this repository — whose
  measured pair count this very increment moves by ~34. That file already builds exactly such a
  project for its signal test (`:470-500`), so the shape is landed precedent rather than new
  machinery.
  **Graph cost: none.** `scripts/*.mjs` is already mapped by the `scripts` node
  (`.yggdrasil/model/scripts/yg-node.yaml:8`), whose type is `build-script` with
  `relations: []` and two aspects — `source-no-raw-control-chars` (enforced) and
  `repo-check-gate-steps` (advisory, `yg-architecture.yaml:442-454`). No node, no mapping, no
  edge, and the advisory step-list rule is untouched because no gate step is added or removed.
- [ ] **Step 7: Graph ritual + report.** **Four** new nodes, mappings, relations, `yg log add` on every
  log-gated node touched, `check --approve --only-deterministic` clean.

**Acceptance criteria.**
1. `appendSessionEvents` then `readSessionEvents` round-trips N events in append order; a line of
   garbage inserted in the middle is skipped and the other N are still returned; the file is opened
   O_APPEND so two interleaved writers never truncate each other.
2. `pruneSessions` removes exactly the session files whose mtime is older than
   `sessions.pruneDays` (7) against an injected `nowMs`, and returns the count. It never removes a
   file it cannot stat.
3. `appendLedgerMarks(yggRoot, marks, keyOf)` writes one line per mark with `date` in exactly
   `YYYY-MM-DD` (UTC) and **dedupes by `keyOf`** — the caller-supplied key function (D15: the store
   may not import `markKey` from the engine), against both the marks in the same call and the marks
   already in the file — and leaves an existing file byte-identical when every mark in the call is
   already present. The unit test supplies `weights.ts`'s real `markKey`, which is legal from a test
   and is what production passes. **A mark whose `date` is not exactly `YYYY-MM-DD` is SKIPPED, not
   thrown on** — the store writes the other marks in the call, returns normally, and emits one
   `debugWrite` line naming the rejected mark. Throwing would be the wrong shape three ways: R5-I15
   is degrade-never-abort, D14 places the ledger append *after* the message has already been
   printed (so a throw would abandon intents the agent has already been told about), and R5-I2's
   single catch would convert it into an incident, which is reserved for faults rather than for a
   caller passing a malformed record. **Two marks for the same `(stableId, surface)` produced by two runs on the same
   UTC day collapse to one line**; a mark whose `date` carries a time component is rejected by the
   store rather than written (it would silently defeat this dedupe and shift `releasedMarks`'
   `Date.parse` arithmetic, `weights.ts:256`).
4. `compactTelemetry` drops records older than `health.telemetryRetentionDays` (180) against an
   injected `nowMs` and preserves the rest in order; a run with nothing to drop rewrites nothing.
4b. `appendTelemetry` **dedupes on `(sessionId, stableId, surface, observedAfter)`** (D13/D13a):
   appending the same record twice leaves the file byte-identical. **Asserted as the three-row
   ceiling D13a(c) derives, by value, because this criterion is where the whole complex's arithmetic
   is pinned:** for one `(sessionId, stableId, surface)`, append in order — the intervention row
   (`observedAfter` **absent**), an `observedAfter: 'ignored'` row, that same `ignored` row again,
   an `observedAfter: 'complied'` row, and an intervention row **whose `observed` differs** —
   and the file holds exactly **three** lines: the intervention row (the first one, with the first
   `observed`), the `ignored` row and the `complied` row. The last append is the one that matters
   and the one an earlier draft got backwards: `observed` carries the deviating **code value** and
   is **not** in the key, so a changed value adds **no** row. `observedAfter` carries §9.10's
   two-valued **outcome label** and is, so the two closures do.
4c. `listSessionLogs` returns one entry per `*.jsonl` under `.state/sessions/`, `sessionId` equal to
   the file stem and `mtimeMs` equal to the file's own mtime, sorted by `sessionId` ascending;
   returns `[]` — creating nothing, not even `.state/` — when the directory is absent; and skips a
   non-`.jsonl` entry and a subdirectory rather than throwing. Round-tripped against
   `sessionLogPath` for a session id drawn from D12's ladder, which is what pins the id ↔ file-name
   inverse both T8 and this store rely on.
5. `readDemotions` returns `undefined` for: an absent file, a file that is not JSON, a file whose
   `snapshotContentHash` is not a string, and a file whose `demoted` is not an array of strings.
5b. **A read that FAILS, not a read that returns nonsense (Step 3's I/O half).** Criterion 5's four
   cases are all malformed *content*, which the mandated helper handles; this one is the I/O failure
   it rethrows by contract. With a **directory** at `.state/demotions.json` and another at
   `.state/telemetry.jsonl` — a fixture that needs no `chmod` and is therefore **not** skipped under
   root, since `readFile` on a directory throws `EISDIR` for every user — `readDemotions` returns
   `undefined` and `readTelemetry` returns `[]`, each without throwing and each emitting one
   `debugWrite` line. Repeated with a mode-`000` file at both paths for the `EACCES` arm, skipped
   where the suite already skips its chmod-simulation cases under root. **This criterion is also the
   killer:** without the wrapper the first assertion throws `EISDIR` out of the store, which is the
   same escape that would silence a whole check run four tasks later behind a fail-open catch.
6. `appendIncident` keeps the newest 500 records and drops the oldest; the 501st append leaves
   exactly 500 records with the first one gone.
6b. **The directory contract, both directions, on a `stateDir` that does not exist** — the case every
   unit test otherwise hides, because the landed precedent (`freshStateDir()`) hands the store an
   already-created temp directory. Given a `stateDir` whose path is absent: the first
   `appendSessionEvents` **creates `.state/` and `.state/sessions/`** and the round-trip returns the
   event; the first `appendTelemetry` and `appendIncident` likewise create what they need; and
   `readSessionEvents`, `readTelemetry`, `readIncidents` and `readDemotions` on the same absent
   directory **create nothing** and return empty/`undefined`. This criterion is also the killer:
   without the `mkdir` the first assertion fails with ENOENT rather than two tasks later behind a
   fail-open catch.
6c. **A write that FAILS returns normally (Step 3b).** With a **directory** at
   `.state/telemetry.jsonl`, at `.state/incidents.jsonl` and at `.state/sessions/<id>.jsonl` — again
   `EISDIR`, so no `chmod` and no root skip — `appendTelemetry`, `appendIncident` and
   `appendSessionEvents` each **return normally**, each emit one `debugWrite` line, and **none
   throws**. The companion arm is the one that makes this a statement about the product rather than
   about a store: with `.state/` itself read-only (mode `0555`, skipped where the suite already skips
   its chmod-simulation cases under root) the same three calls return normally too. **This criterion
   is also the killer:** every one of the three is a bare `appendFileSync` through
   `appendToDebugLog` (`debug-log-writer.ts:7-9`), so deleting the swallow makes all three throw —
   and a throw here is what R5-I2's boundary would turn into "zero findings plus one incident" for
   an input R5-I15 promises is absorbed.
7. `snapshotContentHash` is stable across key-insertion-order permutations of the same body and
   changes when any body value changes; it is unaffected by the header.
8. **The `--file` query mode, by value on hand-built entries (Step 6).** `selectFileMargins` over
   entries containing two pairs for `file:a.ts` (60 000 and 65 000 chars) and one for `file:b.ts`
   (10 000), against a single 72 000 ceiling, returns for `a.ts` both pairs ordered
   **margin-ascending** (7 000 then 12 000) and `worstMargin` **7 000** — the ceiling minus the
   *largest* prompt, not the first-listed one; for `b.ts`, `worstMargin` 62 000; and for a path in
   no entry, `pairs: []` and `worstMargin: null`. **The multi-pair case is the criterion**, because a
   one-pair fixture is satisfied by an implementation that returns whichever entry it finds first,
   and the four `roots-check.ts` obligations read exactly this number.
8b. **The no-argument invocation is byte-identical — against a SCRATCH FIXTURE PROJECT, never
   against this repository.** Spawn the real, unmodified script twice against a scratch project with
   a small **frozen** graph — one tier, a handful of LLM pairs, the stand-in `dist/bin.js` shape
   `prompt-headroom.test.ts` already builds for its signal test (`:470-500`, `mkdtempSync` + a
   `node_modules` symlink + a scripted stand-in) — once with no arguments and once with `--file`
   naming one of that project's own subjects: **the no-argument run's per-tier block and summary
   line are byte-identical to the `--file` run's first N lines**, and the `--file` run appends its
   query block and nothing else.
   **This repository's own output is deliberately NOT the baseline, and that is the whole finding.**
   The summary line is
   ``measured ${entries.length} LLM pair(s) across ${tierMargins.tiers.length} tier(s). Tightest
   margin anywhere: ${worstMarginOverall}.`` (`prompt-headroom.mjs:567`), and `entries.length` is a
   measurement of *this graph* — **1198 today, and this increment moves it**: 6 new `roots-engine`
   files × 1 LLM pair, 4 new `persistence-adapter` stores × 1, `roots-check.ts` × 2, and ~22 new
   `tests/**` files × 1 — roughly **34** new pairs, five of them at T2 alone. A landed byte
   comparison against this repo's captured output would be **red from T2 onward**, and the execution
   protocol commits once per task against a green `repo-check.sh`. The implementer would then either
   delete a criterion the plan calls a regression guard or spend a cycle rediscovering why. The
   scratch fixture makes the guard test **the script**, which is what it was always for, rather than
   this repo's pair count, which is not a property of the script at all.
   *(For completeness, the two things that do **not** move it: `scripts/prompt-headroom.mjs` itself
   is no LLM subject — `build-script` binds only the deterministic `source-no-raw-control-chars` and
   the advisory `repo-check-gate-steps` — and `prompt-headroom.test.ts`'s own growth cannot enter the
   top three, at ≈35 K assembled against a 849-char third place.)*
   The guard's target is unchanged: `scripts/repo-check.sh:209` runs the script with no arguments and
   reports that output, so a query mode that reshuffled the default block would change the gate's
   report while passing every test of the new mode.

**E2E coverage (R5-I12).** This task ships **no adopter-visible behavior** — nothing calls these
stores until T3. Its contracts are pinned by the unit tests above and are exercised end-to-end in
three places, each named for the half it covers: **T3's `cli-roots-check.test.ts`** asserts the
incident file after a version-mismatched snapshot (T3 Step 7 is the only thing T3 writes — T3's own
scope says "no budgets, dedup, session state, telemetry, ledger"); **T6's
`cli-roots-check-budgets.test.ts`** is where the **session log**'s on-disk content is first proven;
and **T7's `cli-roots-compliance-loop.test.ts`** is where telemetry and the committed ledger are. Stated here so the gap is scoped, not forgotten: an implementer who
finishes T1 has not yet proven anything an adopter can see.

**Test obligations / mutation round-trips.**
- **MR-1 (ledger dedupe):** delete the `(stableId, surface, date)` dedupe ⇒ criterion 3's
  "byte-identical on a repeat call" fails.
- **MR-1c (the per-file margin's definition):** return the ceiling minus the file's **smallest**
  assembled prompt (or minus its first-listed one) instead of its largest ⇒ criterion 8's `a.ts`
  case fails with 12 000 where 7 000 is required. The mutation is the plausible misreading, not a
  typo: "the margin" reads as a single number until a file turns out to have two LLM pairs, and the
  wrong one is always the comfortable one — a 2000-char split trigger fed the optimistic figure
  never fires, and the STOP T2 Step 1 attaches to a near-2000 reading never fires either.
- **MR-1b (the telemetry key's shape):** add `observed` to `appendTelemetry`'s dedupe key ⇒
  criterion 4b fails with **four** rows, because the changed-value intervention row survives. The
  mirror mutation — drop `observedAfter` from the key ⇒ criterion 4b fails with **one** row, the two
  closures collapsing into the intervention. Both directions are named because the complex's whole
  arithmetic (D13a(c),(d)) rests on this key holding exactly its stated shape, and three review
  rounds mis-stated it in one direction or the other.
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
(`:340`), §8.10 (`:360-362`), §6.8's partition rule (`:269-273`), §13.5's directional confidence
(`:622`), Appendix D's fact record (`:875-891`) and its co-change row (`:867`), §20.2 (`:713`);
design §12's "§9.11 exemplar ranking … with render-time re-validation" row (`:454`) — **T2 lands the
*ranking* half of that row; the re-validation half is the command layer's and lands at T3 Step 7b**
(D4), so an implementer reading the row here does not go looking for a check time this task has no
access to.

**Files.**
- Create `source/cli/src/roots/exemplars.ts`.
- Edit `source/cli/src/roots/mine.ts` — three edits only: call the exemplar stage, emit
  `partitionRouting` (both as *calls* into `exemplars.ts`, never inlined logic), and widen the
  `MinedModel.cochange` row type.
- **`source/cli/src/roots/roles.ts` is NOT edited** — D4 computes `m1` inside `exemplars.ts` from
  that file's already-exported `roleJaccard` (`:194`) and `buildRoleFeatureBag` (`:149`), rather than
  extending `RoleClassification`, which would break three exact-shape assertions in the frozen
  `roles.test.ts`. Listed as a non-edit because eleven earlier rounds of this plan said otherwise.
- Edit `source/cli/src/roots/history-cochange.ts` — `CochangePair` gains `commitsA`/`commitsB`,
  filled from the `commitsOf(a)`/`commitsOf(b)` values `finishCochange` already computes at the cut
  (`:394-398`); nothing else in that file changes, and the cut predicate is untouched.
- Edit `source/cli/src/roots/stores.ts` — `ROOTS_VERSION` 1 → 2 (D3). That constant is the whole of
  the edit to this file; the assertions the bump breaks live elsewhere, in the four test files
  below.
- Edit `source/cli/tests/unit/cli/roots.test.ts`, `source/cli/tests/e2e/cli-roots-basic.test.ts`,
  `source/cli/tests/unit/roots/history-cochange.test.ts` and
  `source/cli/tests/unit/roots/mine.test.ts` — the **fifteen** landed assertion sites Step 1
  enumerates (seven `rootsVersion: 1` header fixtures and one `toBe(1)`; six exact-shape co-change
  `toEqual`s; one `exemplars` absence assertion and its test title). All four are already mapped —
  the first and third/fourth by `cli/tests/unit/cli/roots` and `cli/tests/unit/roots`, the second by
  `cli/tests/e2e/roots-basic` — so **no node moves and no mapping is added**. Listed as files of
  their own because one of the four is an **e2e** file in a different node from everything else this
  task touches, and every other task in this plan lists such a file explicitly (T3 lists
  `repo-scanner-nested.test.ts`; T10 lists `cli-roots-basic.test.ts`).
- Edit `source/cli/src/roots/pipeline.ts` — thread whatever the exemplar stage needs (weights,
  coupling) that `mine()` does not already hold.
- Create `source/cli/tests/unit/roots/exemplars.test.ts`,
  `source/cli/tests/unit/roots/roles-membership.test.ts` (**new sibling** — it holds the `m1`
  membership computation's own by-value test, and it is a file of its own rather than a section of
  either neighbour: `roles.test.ts` is frozen at 660 chars of margin, and `exemplars.test.ts`'s
  subject is the *ranking*, not the membership quantity the ranking multiplies in) and
  `source/cli/tests/unit/roots/roots-version-regen.test.ts`.
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
  **measure `mine.ts`'s prompt margin now, before editing it** —
  `node scripts/prompt-headroom.mjs --file source/cli/src/roots/mine.ts` from repo root, T1 Step 6's
  query mode, reading that file's `margin` summary line (the ceiling minus its **largest** assembled
  prompt; it is a single-LLM-pair file, so it reports one pair) — and apply the stated fallback if it
  is under 2000 chars. **It is predicted to come in near 13 400** (Global constraints derives it), so
  a measured figure anywhere near 2 000 means something has changed about the graph since this plan
  was written and is itself a **STOP and report**, not a quiet fallback. `roles.ts` is deliberately
  absent from this measurement: this increment does not edit it (D4), so there is no pre-edit
  baseline to take.
  **The bump breaks eight landed assertions, and they are named here so none is discovered as a
  mystery failure:** seven hard-coded `rootsVersion: 1` header fixtures in
  `tests/unit/cli/roots.test.ts` (`:202`, `:342`, `:375`, `:404`, `:432`, `:639`, `:674`) and
  `expect(model.header.rootsVersion).toBe(1)` in `tests/e2e/cli-roots-basic.test.ts:73`. The seven
  unit fixtures fail **misleadingly** — after the bump `readModel` throws on them, so `status`
  renders its "could not be read" paragraph instead of the content each test asserts, and the
  failure reads as a `status` regression rather than a version mismatch. Update all eight to the new
  constant (the fixtures should reference `ROOTS_VERSION` rather than a literal, as
  `tests/unit/roots/stores.test.ts:43` already does, so the next bump costs one line).
  **The body-shape change breaks seven more, named here for the same reason:** six exact-shape
  co-change assertions in `tests/unit/roots/history-cochange.test.ts` (`:178`, `:181`, `:203`,
  `:244`, `:367`, `:572`), each a `toEqual({ a, b, sup, conf })` that vitest fails on an extra key
  once `commitsA`/`commitsB` arrive; and `tests/unit/roots/mine.test.ts:470`
  (`expect('exemplars' in fact).toBe(false)`) — **whose test title at `:457` must change too**
  ("…stabilityDays/calib/trend/cohorts/exemplars are absent from every fact"), since `exemplars` is
  no longer absent. Fifteen landed assertions in total: none is a bug, all are this increment's own
  contract moving.
  **Fifteen is the whole list, and the three assertions that are NOT on it are named here because
  an earlier route would have put them there:** `tests/unit/roots/roles.test.ts:162`, `:214` and
  `:230` are exact-shape `toEqual({ roleIndex: 0, ambiguous: false })` assertions on
  `classifyAgainstMedoids`' return object, and they break the moment that object gains a key. D4's
  chosen route reaches **zero** of them — `m1` is computed in `exemplars.ts` from `roleJaccard`, so
  no return shape anywhere moves, `roles.ts` is unedited and its 660-char-margin freeze holds
  literally. If a later package ever does extend `RoleClassification`, these three are its
  enumeration to inherit.
  **A sixteenth site is not an assertion but a comment, and it goes stale in exactly the way this
  plan refuses to let comments go stale:** `MinedFact`'s own "STRUCTURALLY ABSENT (keys omitted
  entirely, not nulled)" block (`mine.ts:155-160`) lists `exemplars` (`:156`) among the keys no fact
  carries, with `(§9.11)` as its reason on `:157`. T2 makes that false. Remove `exemplars` from the
  list and from `:157`'s reason clause, leaving `calib`, `trend`/`cohorts` and `stabilityDays` —
  all three still genuinely absent in R5 — and add `exemplars` to the interface as a documented
  field beside `parentExp`. A "structurally absent" comment that lies is worse than no comment: it
  is the line a future reader consults to decide whether a key exists.
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
  is a **projection of an existing decision**, and the matcher over it is exported **once** as
  `routePartition(routing, relPath)` from `exemplars.ts` (D5), never re-written in a test or a
  caller: one test asserts that routing every file the index actually mined through that function
  reproduces `partitionOfFile` exactly, and
  a second asserts the module-root reconstruction — `(id === '_repo' || id === '_root') ? '' : id`
  over `routePartition`'s **returned id**, never over "which arm matched", which the `string | null`
  return does not carry (D5) — reproduces `moduleRootDirOfFile` exactly.
- [ ] **Step 4: Directional co-change (D20).** `finishCochange` emits `commitsA`/`commitsB` beside
  `sup`/`conf`; the model body's row type widens to match; the cut predicate, the sort and the
  `maxPairs` cut are all **unchanged**, so no golden's co-change expectation moves except by the two
  added keys. **`HISTORY_STATE_SCHEMA_VERSION` (`history-resume.ts:62`) does NOT move**, and the
  task report says so explicitly rather than leaving the non-bump silent: its doc invites a bump
  when "a co-change row … changes shape", but the row this step widens is the finished cut, which
  the resume never reads back — R5-I7 carries the derivation. Bumping it would force a full history
  re-walk on every adopter's next index. State at the field, in the code, that `conf` remains the max of the two directions and
  that the directional confidence is now derivable as `sup / commitsA` (or `sup / commitsB`).
- [ ] **Step 5: Determinism.** All three fields are sorted by their stated total orders and carry no
  wall clock. The existing double-`index --full` byte-identity suite must pass unchanged, and the
  incremental ≡ full suite too — after being re-baselined once for the new body shape, which is a
  regeneration of committed expectations, not a weakening of an assertion.
- [ ] **Step 6: Re-measure the prompt headroom** on `mine.ts`, `history-cochange.ts`, the new
  `exemplars.ts` and every other file touched — `node scripts/prompt-headroom.mjs --file <path>` per
  file (T1 Step 6's query mode; `--file` is repeatable, so this is one invocation) — and report the
  numbers, `mine.ts`'s as a before/after against Step 1's baseline (it is the only file that has
  one). **A file the mode reports as binding no LLM
  aspect has no margin and is simply absent from the report**, which is a legitimate outcome, not a
  measurement failure.
- [ ] **Step 7: Graph ritual + report** — `exemplars.ts` joins **`cli/roots/engine`'s** mapping
  (**not** `roots/speech`'s: it is index-time code called by `mine()`, and mapping it to `speech`
  would close a `structural-cycle` — the authorization section derives it), log entries on every
  log-gated node touched, and the report states that `checkNoCycles` is clean.

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
3c. **The degenerate case D4 actually argues from (`centrality = 0` for every candidate).** A
   fixture whose partition **has** a `couplingByFile` map but in which none of the fact's candidates
   appears in it — the small-repository case D4 names, where no file clears the co-change cut. Every
   candidate's first tuple element is then exactly 0, so the *second* element is what orders them;
   the test states the `w·m1` values and the resulting order by value. **The fixture's `w·m1` order
   must differ from its `stable_id` order** — otherwise deleting the middle element changes nothing
   observable and MR-6 would still not kill. This, not criterion 3, is
   what makes D4's refinement observable: with `couplingByFile` **absent** the centrality factor is
   1, which makes the first and second tuple elements numerically equal and the refinement invisible.
4. Routing every mined file through **`exemplars.ts`'s exported `routePartition`** — the single
   matcher, not a paraphrase written in the test — reproduces `partitionOfFile` for **every** file on
   every golden, and the module-root reconstruction reproduces `moduleRootDirOfFile` for every one
   of them.
4b. **The routing fixtures, purpose-built** — no landed golden carries a package marker at all
   (`packageRootDirs` is empty on every one of them, so criterion 4 alone exercises only the
   `fallback` arm and the `roots` array's order is unobservable). Five cases, and **four of them need
   generated scopes** — the first, second and fourth to clear `PARTITION_SCOPE_FLOOR`
   (`partitions.ts:69`) in an **own-floor** bucket, and the fifth to clear it in the **merged**
   bucket (see (v)) — so
   their sources are **generated programmatically by the fixture builder**, never hand-written:
   (i) a `package.json` at the repo **root**, above the floor ⇒ partition id `''`, and routing any
   file returns `''` — **not** silence (this is the case a wrong sentinel makes fatal);
   (ii) **nested** package roots `a/` and `a/b/`, **each clearing the 300-scope floor in its own
   bucket — ~600 generated scopes in total**, since `keyFor` assigns every file to its closest
   ancestor root (`partitions.ts:239-244`) and files under `a/b/` therefore never count toward `a`'s
   bucket ⇒ a file under `a/b/` routes to `a/b` and a file under `a/` but outside `a/b/` routes to
   `a` — the closest-ancestor rule, and the only case in which the array's order is observable;
   (iii) a single package root whose scopes fall below the floor **and** whose `_repo` bucket also
   falls below it ⇒ routing returns `null`;
   (iv) no package marker anywhere ⇒ every file routes through `fallback`;
   (v) a detected package root directory holding **no mined scopes at all** ⇒ the entry carries the
   `_repo` bucket's own outcome (D5), and a synthetic path under it routes there rather than to
   `null`. **The "rather than to `null`" half is only producible if the `_repo` merge survives, and
   that constrains the rest of the fixture:** a key with no scopes never enters `scopesByKey`, so
   the entry inherits whatever `repoBucketSurvives` decided — and `repoBucketSurvives` is
   `mergedCount ≥ 300` where `mergedCount` sums **only the keys that individually fell below the
   floor** (`partitions.ts:257-275`; a key at ≥ 300 takes `'own-floor'` and never joins the merge).
   So this fixture needs **at least two distinct sub-floor keys whose scopes sum to ≥ 300** —
   e.g. a package root `x/` with 200 generated scopes plus a `_root` remainder of 150 — alongside
   the empty package-root directory under test. One large bucket, or a small hand-written tree,
   both make `repoBucketSurvives` false, every merged key `'dropped'`, and the entry `null`, which
   fails the criterion's own clause while looking like a routing bug.
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
- **MR-6 (tie-break refinement):** drop the middle element of D4's tuple ⇒ **criterion 3c** fails —
  every candidate scores 0 on the first element and the order collapses to `stable_id`. It is
  pointed at 3c and not at criterion 3 on purpose: in criterion 3's `couplingByFile`-absent case
  centrality is 1 for everyone, so `w·m1·centrality` **equals** `w·m1` and deleting the middle
  element changes nothing — a killer that cannot fail is worse than no killer (R5-I11).
- **MR-6b (cell-class split):** apply `m1` to `_all` facts too, with `m1 = 1` for a role-less scope
  ⇒ criterion 3b fails, with the role-less scopes wrongly leading the exemplar list.
- **MR-7 (routing order):** sort `partitionRouting.roots` ascending by length ⇒ **criterion 4b(ii)**
  fails: `a` matches before `a/b` and the inner package's files route to the outer partition. Pointed
  at 4b(ii) because no landed golden has a package root at all, so criterion 4 on the goldens cannot
  observe the order.
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
`calib` — those stay structurally absent until R6, and Appendix A's T1 template omits their notes
accordingly (`v6-spec.md:513`: `{stability_note}` is omitted when absent). No change to the
co-change **cut** (predicate, sort or `maxPairs`) — two added integers per surviving row, nothing
else. No `body_hash` (D11 states why that stays unbuilt and what it costs).

---

## Task 3 — The walking skeleton: `verdict.ts`, a minimal render, and `yg roots check`

**Scope.** The first flow an adopter can run end to end. `verdict.ts` (pure): scope resolution,
candidate facts, specificity governance, surface values, Δ, τ, severity, the channel table. A
minimal `speech.ts` rendering only Appendix A's T1 three-beat body with exemplars. `src/cli/roots-check.ts`
registering `yg roots check <file...>` on the `generic` channel with human-readable stdout. **No**
budgets, dedup, session state, telemetry, ledger, hook protocols or fail-open boundary yet — each of
those is a named later task that widens this same flow and re-runs this same e2e.

**Authorities.** Spec §9.10 in full (`v6-spec.md:447-481`), §9.7 (`:439`), §9.3 (`:385`), §8.6's
sticky rule (`:345`), §8.9 (`:356-358`), §8.10 (`:360-362`), §11.1 (`:505-527`), §19's `check` row
(`:698`); design §3's command row (`integration-design.md:80`), §11's naming table (`:410-426`).

**Files.**
- Create `source/cli/src/roots/verdict.ts`, `source/cli/src/roots/speech.ts`,
  `source/cli/src/roots/extract-file.ts` (D6 — the single-file parse path; joins
  **`cli/roots/engine`**'s mapping, not `roots/speech`'s, exactly as `exemplars.ts` does and for the
  same reason: it is production extraction code, and the node assignment keeps the check path's
  parse out of the command file's byte budget).
- Edit `source/cli/src/roots/pipeline.ts` — **move** `minimalFileScope` (`:44`) **and
  `MAX_PARSE_LINES` (`:41`)** into `extract-file.ts`, and have `pipeline.ts` and the existing second
  consumer `history.ts:89` import them from there. Moving the constant with the function is not
  tidiness: `extract-file.ts` reproduces gate 3, so leaving `MAX_PARSE_LINES` behind would make
  `pipeline.ts → extract-file.ts → pipeline.ts` a real (if benign) ESM import cycle, unstated. No
  behavior change, one implementation of each.
- Edit `source/cli/src/io/repo-scanner.ts` — **export** `isNestedProjectBoundary(dir, entries?)`,
  the `:261-266` predicate lifted verbatim into a function, and have `walkForNestedProjectRoots`
  call it with the `entries` it already read (D6 gate −1's test 2). Behavior-preserving on the index
  path by construction — the same branches, called from the same place, with the same dirents — and
  **`source/cli/tests/unit/io/repo-scanner-nested.test.ts`** (the landed file that already owns this
  area, mapped by `cli/tests/unit/support/io`, `yg-node.yaml:40`) gains the **seven-case** table
  against the **newly exported predicate**: `.git` directory with a file / **empty** `.git`
  directory / `.git` gitdir-pointer file / `.git` file with garbage / `.git` **symlink** /
  `.yggdrasil` directory with a file / **empty** `.yggdrasil` directory — boundary in cases 1, 3 and
  6, not a boundary in the other four. **What is new about the table is the subject, not the cases,
  and the distinction is written out because the loose claim invites skipping it:** six of the seven
  are already asserted by value at the **whole-walk** level — the empty-`.yggdrasil` pair plus its
  real-file control at `repo-scanner-nested.test.ts:97-154`, and the empty-`.git/`, garbage-`.git`
  and empty-`.git`-file cases plus both controls at `:173-233`, all driven through
  `findNestedProjectRoots`. Re-asserting them against `isNestedProjectBoundary` is what pins the
  **extracted function** itself, so the export cannot drift from the walk that used to contain it;
  the `.git` **symlink** case is the one no landed test covers at all. Adds no graph edge and no node: it is an export in an already-mapped file, and
  `cli/io/stores` gains no import. **The same file also gains criterion 14b's
  `findNestedProjectRoots(repoRoot)` assertion**, over the shared fixture builder below — it is the
  one node that may legally import that function, since `e2e-public-surface` refuses it to every
  e2e file.
- Create a programmatic fixture builder under `source/cli/tests/support/` — criterion 14b's tree
  (a gitignored source file, a symlink, a real nested checkout, and the two pseudo-package
  directories), joining `cli/tests/support`'s mapping. It writes files through `node:fs` and imports
  nothing from `src/**`, which is what lets both tiers of criterion 14b build the *same* fixture.
  **No new edge:** the new e2e node declares `uses cli/tests/support` and
  `cli/tests/unit/support/io` already declares it.
  **And extend that node's `description:` to name the fifth file**, keeping its
  "all N files import only Node builtins; nothing from `src/**`" sentence true. That node's landed
  description is written as an *enumeration* — "A **fourth** file builds the shared
  branch-and-merge fixture … **All four files** import only Node builtins"
  (`.yggdrasil/model/cli/tests/support/yg-node.yaml`) — so mapping a fifth file makes it false the
  moment the mapping lands, in exactly the way T2 tracks `mine.ts:155-160`'s "STRUCTURALLY ABSENT"
  comment as a sixteenth site. The graph ritual covers mappings, relations, ceilings and log
  entries and says nothing about node descriptions, so it is named here; AGENTS.md's
  reflect-changes-in-documentation rule covers `.yggdrasil/` metadata, and a node description is
  that node's own documentation. **Prompt cost: nil** — node `description:` text is excluded from
  the assembled reviewer prompt (`src/llm/prompt.ts:179-181`, the same anchor the node list above
  cites).
- Create `source/cli/src/cli/roots-check.ts` (exactly one `registerRootsCheckCommand` export).
- Edit `source/cli/src/cli/roots.ts` — one line, calling the new registrar.
- Create `source/cli/tests/unit/roots/extract-file.test.ts` (the gate-for-gate equivalence harness
  of Step 1 lives here — it is a `tests/unit/roots/*` file joining `cli/tests/unit/roots`, like every
  other unit test in this increment. **It also owns the unit half of criteria 8, 8b and 8c**, because
  M1 put the role ladder in this module: `resolveRolesForCheck` is where rungs 0/1/2 and the
  medoid-index→`roleKey` mapping can be observed by value at all).
- Create `source/cli/tests/unit/roots/verdict.test.ts`, `speech.test.ts`,
  `source/cli/tests/unit/cli/roots-check.test.ts` (required by `sibling-test-file`).
- Create `source/cli/tests/e2e/cli-roots-check.test.ts`.

**Interfaces produced.**
```ts
// verdict.ts — pure. Its INPUT is a projection of the snapshot, not the snapshot itself (D9).
export interface VerdictFact {
  // `appliesKind` is NARROWER than `MinedFact`'s `ScopeKind | 'module'` (`mine.ts:125`):
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
                            // the SURVIVING subset of `MinedFact.exemplars`, not a copy: D4's
                            // file-existence filter runs in the projection (Step 7b), because
                            // `verdict.ts` and `speech.ts` carry `no-direct-fs`. Empty is legal and
                            // means "render the message, omit the `See:` line".
  partitionId: string;      // §9.4i's label: `repo-wide` for `_repo`, for the root-level package whose id is `''`, AND for the catch-all `_root` bucket (D9's three arms); `package-wide (<id>)` otherwise
  roleLabel: string | null; // the `MinedRole.label` (`mine.ts:165`) of `roleKey`; null for `_all` and `d[<dir>]`
}
export type Channel = 'pre' | 'post' | 'bash' | 'stop' | 'generic';
export type Severity = 'WARN' | 'DENY';

/** One open intervention, folded from the session log. Every field is load-bearing, in two groups.
 *  The first six carry §9.10's once-per-session ignore bound (`v6-spec.md:479`: "the open record
 *  carries the session that would close it; a re-view inside the same session is not a fresh
 *  ignore") — modelled as `{stableId, surface}` alone the bound cannot be implemented at all, and
 *  with only `openedSessionId` it cannot tell "already recorded an ignore this session" from
 *  "opened this session". The last two carry §18.1's EMITTED `severity`/`deltaBits` pair forward
 *  from the `'warned'` event, because every closure row repeats them "as emitted" (D13a(a)) and no
 *  closure producer can recover them by observation: at a complied closure the observed value IS
 *  `expected`, so a recomputed Δ is 0 rather than the gap the agent was shown. */
export interface OpenIntervention {
  stableId: string; surface: string; expected: string;
  severity: 'WARN' | 'DENY'; deltaBits: number;   // §18.1's emitted pair — copied, never recomputed
  openedSessionId: string; openedTs: string;
  ignoredRecordedInSession: boolean;   // set once this session has appended its one 'closed'{ignored} EVENT.
                                       // ONE consumer: T7's session-log write guard (T7 Step 2, criterion 2).
                                       // NOT read by T8's cross-session pass — the telemetry key already
                                       // collapses a duplicate `ignored` row (D13a(c)), so a pass-side rule
                                       // reading this field could not change any stored byte.
}

/** One post-edit scope the command layer resolved (D6) — the engine never parses anything itself. */
export interface EvaluatedScope {
  stableId: string; skeyR: string; kind: 'method' | 'type' | 'file';
  relPath: string; name: string; line: number; partitionId: string;
}

/** Everything `evaluate` reads. Every field is supplied by `src/cli/roots-check.ts`; the engine
 *  reads no file, no clock and no environment (R5-I4), which is what makes this list the whole
 *  contract. Each field names its PRODUCER, because "the command layer supplies it" was not
 *  specific enough to catch M1: two of these are *resolved* lookups, not raw snapshot reads, and
 *  the resolution happens upstream precisely so `evaluate` needs neither a `ScopeUnit` nor a
 *  `RootsConfig`. `evaluate` takes no `config` parameter and this list is why it does not need one. */
export interface VerdictInput {
  //  field              producer (who computes the value handed in)
  channel: Channel;                    // roots-check.ts, from --hook/argv (D10)
  scopes: readonly EvaluatedScope[];   // roots-check.ts, projecting extract-file.ts's finalizeUnits output,
                                       //   in that function's own deterministic order
  surfaceValue: (stableId: string, surface: string) => string | null;
                                       // roots-check.ts, closing over enumerate.ts's per-scope bag+domain
                                       //   for this file (D6); null = out of domain, distinct from false
  facts: readonly VerdictFact[];       // roots-check.ts, projecting ONE MinedPartition's facts (D5 routing,
                                       //   D7's projection fields); module facts already dropped
  roleOf: (skeyR: string) => string | null;
                                       // extract-file.ts's `resolveRolesForCheck` (D6), wrapped by
                                       //   roots-check.ts. Already RESOLVED: rung 0's `_untyped` gate,
                                       //   rung 1's sticky lookup and rung 2's `classifyAgainstMedoids`
                                       //   have all run. null means "_all governance only" and covers
                                       //   BOTH the ineligible and the ambiguous ('-1') scope; the raw
                                       //   `assignments` map never reaches the engine.
  decorativeRoles: ReadonlySet<string>;// roots-check.ts, from the snapshot's MinedRole.roleLift <= 0
                                       //   (`isDecorativeRole`, roles.ts:598) — §8.10
  demoted: ReadonlySet<string>;        // roots-check.ts, from demotions.json via readDemotions (T8; empty until then)
  openInterventions: readonly OpenIntervention[];
                                       // roots-check.ts, from foldSession over the session log (T7; empty until then)
  sessionId: string;                   // roots-check.ts's D12 ladder — opaque to the engine
  nowIso: string;                      // roots-check.ts's injected clock — telemetry ts / ledger date
}
// NOT here, and each absence is a decision rather than an omission:
//   * no `config` — see the note below the block;
//   * no role LABEL lookup — `Finding.roleLabel` is copied from the GOVERNING fact's own
//     `VerdictFact.roleLabel`, which the projection already carries, so a second lookup keyed on
//     `roleKey` would be a parallel derivation of a value the input already holds (the exact
//     duplication D15 refuses elsewhere);
//   * no raw `assignments` map, no `RoleMedoid[]`, no `ScopeUnit` — the role ladder resolved
//     upstream (M1).

export interface Finding {
  stableId: string; scopeKind: string; scopeName: string; relPath: string; line: number;
  partitionId: string;                 // the locality label needs it (D9)
  roleLabel: string | null;            // `MinedRole.label` of the governing role; null for `_all`/directory
  fact: VerdictFact; observed: string; deltaBits: number; severity: Severity;
  novel: boolean; downgraded: boolean; localityContrast: boolean;
}

export interface Intents {
  sessionEvents: SessionEvent[]; telemetry: TelemetryRecord[]; ledgerMarks: LedgerEntry[];
}

export function evaluate(input: VerdictInput): { findings: Finding[]; closureIntents: Intents };
                                          // findings in INPUT ORDER, untruncated (R5-I9)
export function channelFilter(channel: Channel, severity: Severity): { severity: Severity; downgraded: boolean } | null;
```
`closureIntents` is empty until T7 fills it; `openInterventions`, `demoted` and `decorativeRoles`
arrive empty in T3 and are populated by T7, T8 and T3's own projection respectively. Declaring them
in T3 rather than widening the signature three times is deliberate: every later task adds *data*,
never a new parameter, so no task re-opens this file's contract.

**One field carries the whole of M1's answer, and the reason belongs here rather than in a task.**
`roleOf` is a *resolved lookup*, not a snapshot projection. The alternative —
handing `evaluate` the raw `assignments` map plus `RoleMedoid[]` plus `roles.minOwnFeatures` /
`roles.cloneMedoidJaccard` / `thresholds.roleAmbiguityGap` / `thresholds.roleMinMembership` (four
numbers drawn from **two** config blocks, per D23) plus, for rung 0, a whole
`ScopeUnit` per scope so `buildRoleFeatureBag` could run inside the engine — was considered and
rejected on three counts, each independently sufficient: (1) it would put a `RootsConfig` inside
`VerdictInput`, and `evaluate` taking no config is what makes every acceptance criterion in T3
hand-derivable from literal inputs; (2) `EvaluatedScope` would have to grow into a `ScopeUnit`,
so the engine would hold the parse's full output and the "the engine never parses anything itself"
rule would survive only in letter; (3) `classifyAgainstMedoids` returns a `roleIndex` into a
parallel array, so the engine would additionally carry a `medoidRoleKeys` array and the index→key
mapping — a coupling with no test of its own. Resolution upstream costs one closure and buys a
contract with no configuration in it. **The consequence for the graph is stated in the edge table:
`cli/roots/speech` imports neither `buildRoleFeatureBag` nor `classifyAgainstMedoids`.**

**Steps.**
- [ ] **Step 1: Land `extract-file.ts`, then prove R5-I6 before building on it.** Write
  `extractScopesForCheck` to D6's gate list first, move `minimalFileScope` into it, then write the
  equivalence harness: take an unmodified file from a golden fixture, run the index's own path over
  the whole repository, run the check path's single-file path over that file, and assert `stableId`, `skeyR` and **every** surface
  value agree. **STOP and report** any divergence — a single-file `finalizeUnits` that shifts an
  ordinal or a partition id makes every downstream key wrong, and it is far cheaper to find here
  than in T7's ledger mismatch.
- [ ] **Step 2: Scope resolution — the eligibility gate FIRST, then sticky, then classify.** The
  ladder has three rungs, not two, and the missing one is the reason an earlier draft would have
  assigned roles the index categorically refuses to assign.
  **Where it lives: `extract-file.ts`'s `resolveRolesForCheck` (D6), not `verdict.ts`.** Rung 0 takes
  a whole `ScopeUnit` and rung 2 takes `RoleMedoid[]` plus three config numbers drawn from **two**
  blocks (`roles.cloneMedoidJaccard`, `thresholds.roleAmbiguityGap`, `thresholds.roleMinMembership` —
  D23, and the landed call site `roles.ts:913`); both are
  inputs the parse module already holds and `VerdictInput` deliberately excludes (see the contract's
  own note). `extract-file.ts` is intra-node with `roles.ts`, so both imports are edge-free, and
  what crosses into the engine is the *resolved* `roleOf`. Write the ladder here, then hand
  `roots-check.ts` the closure.
  **Rung 0 — `_untyped` eligibility (§8.1).** A scope is eligible for *any* role only if its kind is
  `method` or `type` **and** `buildRoleFeatureBag(unit)` (`roles.ts:149`) yields
  `ownFeatureCount >= config.roles.minOwnFeatures`. That is the index's own filter
  (`inducePartitionRoles`, `roles.ts:819-825` — the landed name is `inducePartitionRoles`, and it is
  module-private, which is a second reason the ladder is written here rather than imported), and the
  landed comment states the consequence in
  binding terms (`:815-818`): fewer than `minOwnFeatures` own features "excludes a scope from
  clustering **AND from role-conditioned conventions entirely** — it never enters `eligible` at all,
  so it gets no assignments-map entry". §8.10 (`v6-spec.md:362`) names the class: `_untyped` members
  fall back to `_all`. **An ineligible scope therefore gets no sticky lookup, no classification and
  `_all` governance only.** Skipping this rung is not a near-miss: `classifyAgainstMedoids` contains
  no such gate — its only rejections are §8.5's membership floor and the ambiguity gap, both of which
  a one-own-feature scope (a single `sup:` or `dec:` tag matching a medoid) clears routinely — so the
  scope would receive a role, and D8 would then let that role's facts, being the smaller evidence
  class, **shadow** the `_all` facts that are its only correct governance: a wrong message that also
  suppresses the right one, on the ordinary small method.
  **Rung 1 — sticky, rung 2 — classify:** `stickyRole(scope) ?? classify(scope, ctx)`
  (`v6-spec.md:345`) — where `classify` is the **landed** `classifyAgainstMedoids(bag, medoids,
  cloneMedoidJaccard, roleAmbiguityGap, roleMinMembership)` (`src/roots/roles.ts:351-357`), called
  with medoid bags rebuilt from the snapshot's `medoidFeatures`, never a second implementation of
  §8.4/§8.5 (named here the way D6 names `extractUnits`, because it is the one landed seam this step
  otherwise referenced only by the spec's pseudocode name), with `RoleMedoid[]` rebuilt from the
  routed `MinedPartition`'s `roles[i].medoidFeatures` **in `roles[]`'s own array order** (so
  `classifyAgainstMedoids`' returned `roleIndex` indexes straight back into `roles[]` for the key —
  the index→key mapping is the reason this rebuild and the classify call must sit in one function,
  and never in two places).
  **What that order actually is, and the one exposure it carries — stated because an earlier draft
  wrote "the partition's own role order" as though it were a third thing.** `MinedPartition.roles`
  is sorted by `roleKey` ascending, twice over: `induceRoles` ends with `roles.sort(compareRoles)`
  (`roles.ts:1030`, `compareRoles` = `(partitionId asc, roleKey asc)`, `:1054-1057`), and `mine.ts`
  re-sorts when it projects `MinedRole[]` (`:1035`). So "`roles[]` order" **is** "`roleKey` order",
  and there is no order to choose between. **The index, however, classified against `medoids[]` in
  cluster/push order** (`roles.ts:904`), which is not `roleKey` order — and the snapshot does not
  persist it. `classifyAgainstMedoids` resolves its winner with a strict `>` scan (`roles.ts:363-369`),
  so on an **exact `m1` tie between two medoids** it returns whichever comes first in the array, and
  the check path can therefore land on a different role than the index did. **That exposure is
  accepted and named rather than engineered around**: reconstructing push order is impossible from
  the snapshot; the tie requires two medoids at identical Jaccard against the same bag; rung 1's
  sticky lookup covers every scope the index already assigned, so the exposure is confined to scopes
  that are **new or renamed since the index**; and §8.5's ambiguity gap already sends most near-ties
  to `'-1'` (no role, `_all` governance) before the tie-break is reached. Say this in
  `resolveRolesForCheck`'s header, because a reader comparing it to `inducePartitionRoles` will
  otherwise assume the orders match. **T3 Step 1's equivalence harness structurally cannot see it**
  — it drives an unmodified mined file, so every scope resolves by sticky lookup.
  Rung 1 reads `assignments` from the
  snapshot by `relPath#kind#qualifiedName` —
  which already carries the §6.4 occurrence ordinal (`src/roots/extract.ts:203-204`). A scope stored as
  `'-1'` **stays ambiguous**: `resolveRolesForCheck` returns `null` for it, exactly as it does for an
  ineligible scope, so it gets no role speech; `_all` still applies. (`'-1'` is deliberately not
  propagated into `VerdictInput` — the engine has no use for the distinction, and a sentinel that
  reaches a consumer which cannot act on it is the shape of D5's own round-1 defect.) File-scope roles follow
  §8.9(b)'s plurality of the same post-edit parse. The rationale belongs in the code, because it is
  the non-obvious half: a deviation that strips a role-defining marker also strips the membership
  evidence, so feature-only reclassification would let the deviating scope escape the role and
  silence exactly the message that should fire.
  **The rest of `roles.ts`'s induction path was walked end to end once, here, so no other landed gate
  is missing the way rung 0 was:** `minClusterSize` (`roles.ts:887`, a total member weight, dropped
  clusters' members falling back to `_all`) and `clusterSampleCap` (`:871`) are **build-time**
  gates — they decide which roles exist at all, and the check path inherits their outcome by reading
  only the roles the snapshot persisted, so there is nothing for it to re-apply. §8.9(b)'s file-role
  plurality (`:704-712`) is already on this step. Rung 0 was the only omission.
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
  never-seen value is never denied" (`v6-spec.md:440`) is binding and is invisible if the novelty
  cap lives in a comment; `channelFilter` as a pure total function of `(channel, severity)`
  implementing the complete table, including the DENY→WARN downgrade with its note on every
  non-`pre` channel.
- [ ] **Step 6: Minimal render.** Appendix A's T1, first three lines plus the `See:` line, with the labels
  §9.4i and design §11 fix: `local (<dir>/)` for a directory fact, `repo-wide` for the `_repo`
  partition **and for the root-level package whose id is `''` and for the catch-all `'_root'`
  bucket** (D9's three arms), `package-wide (<partition>)`
  for every other named partition, and the group's medoid label for a role fact.
  The locality contrast sentence renders verbatim when `parentExp ≠ expected`. **The `See:` line
  renders exactly the exemplars `VerdictFact.exemplars` hands it and is omitted when that list is
  empty** — the renderer performs no validation of its own and may not (`no-direct-fs`); D4's
  existence filter has already run in the projection (Step 7b), so an empty list here means either
  a fact with no conformers or a fact whose exemplars have been reaped, and both render the same
  way: the message, without the line. Everything else of Appendix A is T4's.
- [ ] **Step 7: The command.** `yg roots check [file...]`, config-only load (I10 — `findYggRoot` +
  `parseConfig`, **never** `loadGraphOrAbort`; the same delegation `cli/roots.ts` already
  documents), **no `.yggdrasil/` at all ⇒ print nothing, record NO incident, exit 0** — the case a
  hook runtime with an inherited cwd hits first (the hazard carry-in 1 is about), and the one place
  `check` must **not** reuse `findYggRootOrFail` (`src/cli/roots.ts:99-113`), which calls
  `abortUnlessYggdrasilExists` and **exits 1**: that refusal is right for `index`, which cannot build
  without a project, and wrong for a verdict path that never gates. No incident, because there is no
  `.yggdrasil/roots/.state/` to record one in. **A throw before the root is resolved ⇒ silence, exit
  0, one `debugWrite` and no incident**, for the same reason — R5-I2's catch needs a `yggRoot` it
  does not yet have. Then: dormant ⇒ print nothing and exit 0, no snapshot ⇒ print nothing and exit
  0, a snapshot whose `rootsVersion` does not match ⇒ print nothing, record one incident, exit 0.
  Registered from `cli/roots.ts` (never from `cli/entry` — the fan-out pin), exit 0 on every verdict
  outcome, exit 1 only on the argument-validation carve-out R5-I1 names.
- [ ] **Step 7b: The `VerdictFact` projection — including D4's exemplar existence filter, which
  lives here because this is the last layer allowed to touch the filesystem.** *(A step number, not
  a position in the run: the projection is built per routed partition, after Step 8 has resolved the
  file set and D5's routing has answered. It sits beside Step 7 because it is the command layer's
  other construction job, and because Step 8's own numbering is spoken for — its three filters are
  a sequence T5 lands into.)* Build `VerdictFact[]` from the
  routed `MinedPartition` exactly as D9 fixes it: copy the `MinedFact` fields, drop every
  module-kind fact, and fill D9's four non-copies — `partitionId` from the enclosing
  `MinedPartition.id`, `roleLabel` from the matching `MinedRole`, `denyEligible` as the boolean
  widening, and **`exemplars` as the surviving subset**: each `MinedFact.exemplars` entry is kept
  only if `<repoRoot>/<rel>` still exists as a regular file. That is §9.11's "re-validated at render
  (reaped scopes never render)" (`v6-spec.md:484`) and design §12's productionized row
  (`integration-design.md:454`), and it cannot live in the renderer: `speech.ts` and `verdict.ts`
  both carry `no-direct-fs` and `deterministic` (R5-I4), while this layer already `lstat`s every
  candidate path in Step 8. **Three rules, so an implementer needs no judgement:** the test is
  existence and file kind, never a re-parse — the index remains the authority on a scope's line
  number (D4); a failing `lstat` (any errno) drops that entry rather than throwing, the same
  totality rule Step 8 states for its own per-path tests; and **an empty surviving list is a normal
  outcome, not silence** — the message still renders and simply carries no `See:` line, because the
  deviation is still true. The renderer needs no new branch for it: a fact with no exemplars is
  already a case it owes (T2 criterion 2). Cost, stated because D4's own argument is a cost
  argument: at most three `lstat`s per projected fact, once per run, no read and no parse.
  **Two invariants it does not touch, checked rather than assumed.** R5-I9: the filter removes
  entries from one fact's evidence list and never reorders them, while that invariant governs the
  ordering and truncation of *findings* — §11.3 is still the only place either happens. R5-I18: the
  filter narrows an in-memory projection; the committed `model.json` keeps all three exemplars, so
  the next `index` re-derives them from the tree as it finds it and no check run has written back
  into the model.
- [ ] **Step 8: Resolving the file set — one place, and it produces TWO sets, not one.** Whatever
  supplied the candidate paths (positional arguments, a hook payload, or D11's `getDirtyFiles`), the
  command layer resolves them **once**, before any read, in this order:
  1. **Membership in the index's file universe — D6's gate −1**, whose three per-path tests
     (`lstat` regular-file-and-not-symlink; no nested-project boundary above it; not gitignored)
     also **subsume the existence check**, so this is one filter rather than two — **for an on-disk
     source. Which tests apply to which path is set by the gate matrix below, and the `lstat` half
     is the one that moves.** The existence half
     is not defensive padding: `getDirtyFiles`' own contract states that "a rename/copy contributes
     **BOTH** its old and new path" (`src/utils/git.ts:113-124`), so the set routinely contains
     deleted files and the old side of every rename; and without the filter `readFile` (or T5 Step
     4's `realpath`, earlier still) throws ENOENT on such a path — which, because R5-I2 mandates
     **one** catch around the whole run and MR-19 forbids a per-file one, would abort the entire
     invocation: zero findings for **every** file, one incident, nothing an adopter can see. One
     `git mv` would silence the product for that run. One `debugWrite` per drop.
     **⇒ The surviving set is the PARTICIPATION set: the files this run legitimately looked at.**
  2. **`forParsing`** — `makeRootsFileFilters(config).forParsing(relPath)` (D6 gate 0). A path the
     index would never *mine* is dropped here rather than inside `extractScopesForCheck`, so the set
     the verdict path works from is already the set the index would have recognized. (The gate still
     lives in `extractScopesForCheck` too, for callers reaching it directly — belt and braces on the
     one rule whose absence makes the product speak without evidence.)
     **⇒ The surviving set is the EVALUATION set.**
  3. **Path safety** — specified and landed at **T5 Step 4**, applied to the evaluation set. T3
     implements filters 1 and 2 only; the slot is named here so T5 widens an existing resolution step
     rather than inventing a second one somewhere else.

  **The per-source gate matrix — because filter 1 is not one rule but two, and the plan said one.**
  Every test above assumes the bytes come from the path. One input source breaks that assumption:
  `--content <p> --as <q>` supplies the bytes *itself*, and `q` is a path that need not exist —
  which is the entire purpose of `--as`. A filter 1 that `lstat`s every candidate would drop `q` by
  construction, taking T5 criterion 3 and D6's own "answers for files that did not exist when the
  index ran" with it. So the resolution is **keyed on whether the run supplies the bytes**, and the
  three sources are written out rather than left to be inferred:

  | Source | Bytes from | `lstat` regular-file test | Nested-project + gitignore | Gate 0 `forParsing` | T5 Step 4 containment |
  | --- | --- | --- | --- | --- | --- |
  | Positional `<path>…`, and D11's `getDirtyFiles` set | the path, read by the command layer | **on the path** — this is where deleted paths and rename old-sides leave the set | on the path | on the path | `realpath(path)` |
  | `--content <p> --as <q>` | **`p`**, read once by the command layer | **on `p` always; on `q` only if `q` exists.** `q` need not exist — that is `--as`'s purpose — but **if it does exist it must be a regular file**, not a symlink and not a directory | **on `q`** — an agent may not get answers about a path the index would never have walked, whether or not the bytes are real | **on `q`** | resolved against the **nearest existing ancestor** of `q` |
  | Hook payload paths (`--hook`) | the path, read by the command layer | on the path — a `post`/`bash` payload names a file the tool has already written | on the path | on the path | `realpath(path)` |

  Three consequences the table makes binding. **First, `q` is not gated on existence — but it IS
  gated on file *kind* whenever it exists.** The rule is one sentence: **`q` must not exist, or must
  be a regular file.** A `--as` target inside a submodule, inside a gitignored directory, or matching
  a test pattern is refused exactly as a real file there would be — the honesty rule is about *where
  the path claims to live*, and content the caller supplied does not buy an exemption from it. **The
  same rule reaches an existing symlink or directory at `q`, and an earlier draft's "`q` gets none of
  the `lstat` test" did not:** `collectFiles` admits an entry only under `entry.isFile()`
  (`repo-scanner.ts:99`), so a symlinked source file is **never mined**, and answering about one
  mints a `stableId` the next index can never match — the precise harm gate −1 exists to prevent,
  arrived at through the one row that was meant to be the exception. Because `q` may not
  exist, both walks start at `q`'s **nearest existing ancestor** (walking up until one `stat`s), so
  no `ENOENT` arises in the walk at all; and the containment test resolves that ancestor, then
  re-appends `q`'s remaining segments and normalizes, so a `..` escape is still refused. `ENOENT` on
  `q` itself is therefore **never a drop**. Stated positively, since the negative form of this
  sentence has read as "everything else is a drop", which is false: the two admitted outcomes on `q`
  are **absent** and **a regular file**; every other `lstat` outcome — a symlink, a directory, any
  other dirent kind — is a drop.
  **Second, `p` is gated on existence and kind, and on nothing else.** `p` is a byte source, not a
  subject: it is `lstat`ed
  and read, and nothing is ever said about `p`'s own location. A `--content` path that is missing,
  unreadable or not a regular file yields **silence, exit 0 and one incident** (not exit 1 — it is a
  missing input, not a malformed argument, and R5-I1's carve-out is deliberately narrow; T5
  criterion 3's exit-1 case is the option-mutex violation, which is a different fault).
  **This outcome is an explicit exception to this step's own totality clause below**, and the clause
  now names it: every other `lstat` failure in this step is a silent drop with a `debugWrite`,
  because a path that fails is one subject fewer in a set; `p` is in neither set, so a failure there
  is a run with no input at all, which is a fault the adopter should be able to see in the incident
  count. One prescribed outcome per input, stated in both places.
  **Third, the `pre` channel reads no path at all in R5** and this is why the table's third row says
  "already written": `pre` drops WARN and R5 mints no DENY (D10, R5-I3), so a `pre` payload's
  target — which genuinely may not exist yet — is never resolved. A later increment that makes `pre`
  speak inherits row 2's treatment for it, and that sentence is the deferral, not an omission.

  **Why the fork, why it is exactly one filter wide AT T3, and where T5's filter 3 lands.** The
  heading carries the qualifier because the claim stops being true at T5: filter 3 (path safety) is
  applied to the **evaluation** set only, so after T5 the two sets are two filters apart, not one.
  **The consequence is small, real, and stated rather than left to be found:** a path that
  realpaths *outside* the repository survives filter 1 — it `lstat`s as a regular file, has no
  nested-project ancestor above it inside the repo, and matches no in-repo gitignore stack — so it
  **enters the participation set** and is recorded in the `'checked'` session event, hence in
  `writtenFiles` and §13.5's `D`, even though §21.2 makes it silent on stdout (T5 criterion 5).
  Nothing observable breaks: an out-of-repo path matches no repo-relative co-change row, so it can
  never produce a completeness partner, and T5 criterion 5's "silence" is a statement about output,
  not about the participation record. This is deliberate — participation records what the run
  *looked at*, and it did look at it — and the narrowing is left to filter 3 rather than duplicated
  into filter 1, so path safety has exactly one home (T5 Step 4). The `'checked'` session event — and
  therefore `writtenFiles`, and therefore §13.5's `D` — is built from the **participation** set, not
  the evaluation set. Gate 0's honesty argument is about *speaking about a file's own conventions*,
  and completeness does no such thing: it uses membership in `D` only as a session-participation
  signal and names a **partner**, which is never evaluated and never spoken about. Building `D`
  post-`forParsing` would make it structurally **test-free** — `TEST_PATTERN_EXCLUSIONS` is inside
  `forParsing` — which would silence the single most useful completeness direction there is ("you
  changed the test; you usually also change `src/order.ts`"), kill D20's own motivating pair, and
  leave T9 criterion 5's second and third cases unreachable through the product while still passing
  as unit tests. So: participation is broad and says nothing; evaluation is narrow and speaks.
  T6 Step 1b carries the same statement where the event is produced.

  **Every filter is total, and the step as a whole cannot throw (m5).** `lstat`, the ancestor scan
  and `realpath` all throw on `EACCES` / `ELOOP` / `ENAMETOOLONG`, and by this point the graph root
  is resolved, so T3 Step 7's pre-root catch no longer applies: **any throw inside a per-path test is
  a drop with one `debugWrite`, never an exception.** That is what lets the step sit **deliberately
  OUTSIDE R5-I2's fail-open boundary** without weakening R5-I1 — it is set *construction* performed
  before the boundary opens, not error *recovery* inside it, and MR-19's "one catch" claim is
  untouched. A path that cannot be resolved is not an exception to be caught; it is a path that is
  not in the set.
  **The one path this clause does NOT cover is `--content`'s byte source `p`, and the exception is
  stated here because the two rules otherwise prescribe different outcomes for the same `lstat`
  failure.** `p` is not a member of the participation set or the evaluation set — it is not a
  subject at all, only the place the bytes come from (the gate matrix's "Second" consequence). So a
  failing `lstat` on `p` is **not a drop**: dropping the only byte source leaves the run with no
  input rather than with one fewer subject, and the prescribed outcome is **silence, exit 0 and
  exactly one incident** (T5 criterion 3c). An implementer who read the bolded totality sentence as
  universal would build a silent drop with a `debugWrite` and no incident, and fail 3c.

  With no positional paths and no `--hook`, the candidate set is `getDirtyFiles(repoRoot)`
  (`src/utils/git.ts:125`) and **every** scope in the surviving files is evaluated — the declared, budget-bounded superset of §19's `body_hash`-filtered set, for the
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
| absence (`expected false`), `counts {false:20, true:1}`, observed `true`, **vocabulary** tier | 2 | `log2((20.5/22)/(1.5/22)) = log2(41/3) = 3.7726` | 3.5 | **yes** |
| the same fact at the **structural** tier | 2 | 3.7726 | 4.5 | **no** |
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
   produces its `_all` finding. Asserted twice at two layers, because M1 moved the rung:
   `resolveRolesForCheck` returns `null` for it (`extract-file.test.ts`), and the end-to-end run
   emits only the `_all` message.
8b. **`_untyped` is silence too, and for a different reason.** A scope with fewer than
   `roles.minOwnFeatures` (2) own features — an ordinary small method — has **no** `assignments`
   entry at all, and produces its `_all` finding and **no role finding**, even when its single
   feature would match a medoid comfortably. Asserted on a scope built to clear
   `roleMinMembership` against a fixture medoid, so the criterion fails if rung 0 is skipped rather
   than passing by accident. **The unit-level half of this criterion is asserted against
   `resolveRolesForCheck`** (`tests/unit/roots/extract-file.test.ts`), which is where the ladder
   lives after M1 — a version of this criterion pointed at `verdict.ts` would have nothing to
   observe, since `VerdictInput.roleOf` arrives already resolved.
8c. **The role a scope resolves to is the right one, by name — and rung 2 is what answers.** On a
   partition carrying **two**
   roles whose medoid bags differ sharply (so no tie is in play), a scope matching the **second**
   entry's medoid resolves to `roles[1].roleKey` and a scope matching the first resolves to
   `roles[0].roleKey` — both asserted by value against `resolveRolesForCheck`, and the second one
   end to end by the emitted message naming that role's own `label`. **Both directions are
   required**: a one-role fixture, or a fixture where only one arm is checked, is satisfied by an
   implementation that returns a constant.
   **The fixture property that makes rung 2 the answering rung, without which neither arm tests
   anything:** both scopes must carry **no `assignments` entry** — i.e. they are *new since the
   index ran*. `induceRoles` writes an entry (a `roleKey` or `'-1'`) for every eligible scope it
   saw (`roles.ts:983`), and rung 1's sticky lookup returns on a hit, so a scope present in the
   mined golden never reaches rung 2 at all. Planting a *deviation* does not help: `skeyR` is
   `relPath#kind#qualifiedName` (`extract.ts:203-204`), which an edited body does not move, so the
   sticky hit survives the edit. The e2e arm therefore **adds a new method to an already-mined
   file** after `yg roots index` has run. Two consequences the fixture must respect and which are
   named here rather than discovered: the new method must be **eligible** (kind `method`,
   `ownFeatureCount ≥ roles.minOwnFeatures` — rung 0, criterion 8b's own gate) and it must carry the
   features of `roles[1]`'s medoid; and putting it in an **existing** file in an existing directory
   is what keeps `routePartition` (D5) answering the same partition as its siblings, so no new
   routing entry and no re-index are needed. A brand-new *file* would need both.
   **The fixture makes no claim about sort order**, and an
   earlier draft's did — it asked for two roles "whose `roleKey`s sort in the opposite order to
   their position in `roles[]`", which is a `MinedPartition` **no index run can emit**, since
   `roles[]` *is* `roleKey`-sorted (`roles.ts:1030`, `mine.ts:1035`). That fixture was
   unconstructible through the product and only hand-buildable by violating a landed invariant.
9. **Decorative roles contribute nothing.** A role with `role_lift ≤ 0` yields neither facts nor
   shadows; its members fall back to `_all` (`isDecorativeRole`, `roles.ts:598`). The set is built
   by `roots-check.ts` from the snapshot and handed in as `decorativeRoles`; the engine applies it
   and does not derive it.
10. **The channel table, complete.** For each of the five channels × two severities, the returned
    pair matches the table: `pre` passes DENY and drops WARN; the other four pass WARN and downgrade
    DENY with the note. **Nothing in this table depends on the model** — it is exercised with
    synthetic findings.
11. **Out-of-domain is not a deviation.** A surface whose domain excludes the scope yields `null`
    and no finding, distinct from a sparse boolean's absent-means-false.
12. Exit code is **0** for: findings, no findings, dormant project, missing snapshot, unreadable
    snapshot, a **version-mismatched** snapshot (an R4-shaped `model.json` after the D3 bump — which
    additionally prints nothing and records exactly one incident), a path outside the repository,
    and **a working directory with no `.yggdrasil/` anywhere above it** — which prints nothing and
    records **no** incident, there being no state directory to record one in, and which must NOT
    reuse `findYggRootOrFail` (`src/cli/roots.ts:99-113`, exit 1 — right for `index`, wrong here).
    Exit is **1** only for the argument-validation carve-out R5-I1 names, and T5 criterion 3 is its
    one instance.
13. **The no-argument form (D11).** On a golden with two dirty files and one clean one, bare
    `yg roots check` evaluates every scope in the two dirty files and none in the clean one; with
    an explicit path argument it evaluates that file whether or not it is dirty. With git
    unavailable the same invocation is silent and exits 0.
14. **A file the index never mined is silent (D6 gate 0).** On a golden, plant the *same* deviation
    in `src/x.ts` and in `src/x.test.ts` (matching `**/*.test.*`), then run
    `yg roots check src/x.ts src/x.test.ts`: exactly one message, about `src/x.ts`. Repeat with a
    path the fixture's `roots.exclude` names, and with a path outside a narrowed `roots.include`:
    silent in both cases, exit 0, no incident. This is the criterion that observes gate 0 — T3 Step
    1's equivalence harness cannot, because it drives a file the index *did* mine.
14b. **A file outside the index's universe is silent (D6 gate −1) — and a file that only *looks*
    like it is, speaks.** **This fixture is built programmatically at test time, not committed**, and
    the criterion says so because the implementer will otherwise spend a cycle discovering it: git
    tracks neither empty directories (the `.yggdrasil/` negative case) nor anything under a nested
    `.git/` (the positive case), and a committed symlink is a portability hazard on Windows
    checkouts. Same convention T2 criterion 4b already states for its own routing fixtures. On a fixture carrying a **gitignored** source file, a **symlink** to a
    real source file, and a **nested checkout** (a `packages/external/` directory whose `.git/`
    holds a real `HEAD`), each planted with the same deviation: `yg roots check` on each of the
    three prints nothing, exits 0, records no incident.
    **The negative half is what makes this criterion able to see M2's defect, and it is not
    optional.** Two more directories carry the same planted deviation and **must produce their
    message**: `packages/pseudo-a/`, holding an **empty** `.yggdrasil/` directory, and
    `packages/pseudo-b/`, holding a `.git` **symlink**. Neither is a boundary under the landed
    predicate, and a gate −1 written as the paraphrase "contains a `.git` or a `.yggdrasil` entry"
    silences both — a whole package directory going quiet with no diagnostic anywhere, which is the
    exact failure shape this product cannot afford. The **same fixture, asserted at both tiers**,
    additionally drives the landed `findNestedProjectRoots(repoRoot)` once and asserts its result
    contains `packages/external` and contains **neither** `packages/pseudo-a` **nor**
    `packages/pseudo-b` — so gate −1's per-path narrowing and the function it narrows are pinned
    together in both directions, which a single positive fixture cannot do. (After M2's fix the two
    share one implementation, so this criterion additionally guards the refactor that made them
    share it.)
    **Where the three pieces live, because the obvious single home is refused by an aspect this
    plan itself cites.** `findNestedProjectRoots` is exported from
    `source/cli/src/io/repo-scanner.ts:229`, and `e2e-public-surface` forbids **any** e2e file from naming a specifier that resolves under
    `source/cli/src/` in any form — static import, `import type`, re-export, dynamic `import()`,
    `require()` (`.yggdrasil/aspects/e2e-public-surface/check.mjs`, `SRC_ROOT = 'source/cli/src/'`).
    It is **enforced** and it is declared on **`cli/tests/e2e`** itself
    (`.yggdrasil/model/cli/tests/e2e/yg-node.yaml:5`), so it reaches every child by node inheritance
    — including the new `roots-verdict` node, whose own `aspects:` list is empty exactly as its
    landed sibling `roots-basic`'s is. An implementer who put both halves in
    `tests/e2e/cli-roots-check.test.ts` would meet a **blocking deterministic refusal** at T3's own
    `check --approve --only-deterministic` gate. So the criterion is one fixture and two tiers:
    - **the programmatic builder is a new helper under `source/cli/tests/support/`**, joining
      `cli/tests/support`'s mapping. It writes files and imports nothing from `src/**` — which is
      exactly the shared-helper shape `e2e-public-surface`'s own description permits ("Shared e2e
      helpers under `support/` are fine: they read committed artifacts via `node:fs` and import
      nothing from `src/**`"). **It costs no edge in either direction:** the new e2e node already
      declares `uses cli/tests/support` (the edge table's last row), and
      `cli/tests/unit/support/io` already declares it too, in its landed `relations:` block;
    - **the five `yg roots check` legs stay in `tests/e2e/cli-roots-check.test.ts`** — the three
      silent cases and the two pseudo-package messages, all driven through the spawned binary;
    - **the `findNestedProjectRoots(repoRoot)` assertion lands in
      `source/cli/tests/unit/io/repo-scanner-nested.test.ts`** — the file T3 already edits for the
      seven-case boundary table, mapped by `cli/tests/unit/support/io`, and the one node that may
      legally import that function — built over the **same** builder. It must call
      `resetNestedProjectRootsCache()` (`repo-scanner.ts:218`) first: `findNestedProjectRoots` is
      memoized per resolved root and that landed file already imports the reset, so without it the
      assertion can read another test's cached answer and pass or fail for a reason that has nothing
      to do with the predicate.
    The two-directional pin the stated reason needs is carried by the **shared fixture**, not by a
    shared test function: both tiers assert against the same planted tree, so a boundary predicate
    that is wrong makes the e2e legs and the unit assertion wrong together. "The same test" would
    have been unbuildable here, and the criterion says "the same fixture" instead.
15. **A deleted path does not silence the run (Step 8.1).** On a golden where one dirty path has been
    deleted (or `git mv`-ed, so the set carries its old name) and another still deviates, bare
    `yg roots check` **reports the deviation**, exits 0, and records **no** incident — the deleted
    path contributing one `debugWrite` line and nothing else. **The same holds for a path whose
    parent directory is unreadable** (mode `000`, skipped where the suite already skips its
    chmod-simulation cases under root): the per-path test throws, the path is dropped with one
    `debugWrite`, and the other file's finding still prints — the totality clause of Step 8, whose
    absence would surface as a stack trace and a non-zero exit on a hook path.
16. **A reaped exemplar never renders (D4, Step 7b).** On a golden, run `yg roots index`, then
    **delete from disk every file the deviating fact's `exemplars` name** (read them out of the
    committed `model.json`, so the fixture depends on no hand-guessed path), then plant the
    deviation and run `yg roots check <file>`: the message is emitted, its first three lines are
    **byte-identical** to the same run with the exemplars present, and it carries **no `See:`
    line** — not silence, and not a `See:` naming a file that is gone. Paired with the partial case,
    which is the one a "drop the whole list if any is missing" implementation fails: with **one** of
    the three surviving, `See:` names that one and only that one. Driven through the spawned binary
    in `cli-roots-check.test.ts`, beside the positive `See:` assertion its e2e already makes —
    deleting a file between `index` and `check` *is* the adopter situation the rule exists for (the
    exemplars are other files' scopes, and D5's whole premise is that the tree has moved since).
    **One fixture constraint, stated so it is not debugged:** the chosen fact's three exemplars must
    all live in files *other* than the one the deviation is planted in. The deviating scope can
    never be its own exemplar — an exemplar is a conformer — but a **sibling** scope in the same file
    can be, and deleting that file would remove the subject of the check along with the evidence.

**E2E coverage.** `cli-roots-check.test.ts` drives the adopter flow end to end on a golden fixture:
`yg roots index`, then edit a file to violate a mined convention, then `yg roots check <file>` —
asserting exactly one message, its three-beat shape, its `N of M established` evidence phrase, and a
`See:` line pointing at a real file and line; then revert the edit and assert **silence** and exit
0. The silence half is not decoration: precision is the product, and a check that cannot be quiet
is worse than no check. The same file drives the **bare** form (D11): with the deviation planted and
uncommitted, `yg roots check` with no arguments finds it; with the tree clean, it is silent.

**Test obligations / mutation round-trips.**
- **MR-9 (sticky roles):** replace `stickyRole(scope) ?? classify(...)` with `classify(...)` alone
  **in `resolveRolesForCheck`** ⇒
  the e2e's strip-a-role-marker case goes silent (the deviating scope escapes its role) — the exact
  50 %→93 % detection effect §8.6 records.
- **MR-9c (the medoid index→key mapping):** index `roles[]` by
  **`medoids.length - 1 - roleIndex`** instead of by the `roleIndex` `classifyAgainstMedoids`
  returned ⇒ criterion 8c fails on both arms: each scope resolves to the *other*
  role's `roleKey`, and the end-to-end message names the wrong `label` while still being a message —
  which the e2e arm can observe **only because criterion 8c's scopes are new since the index and
  therefore reach rung 2**; over a mined scope, rung 1's sticky hit returns the right key and this
  mutant survives end to end. One mutation, named exactly: an earlier draft offered "or by the
  position in a locally re-sorted copy" without naming the sort key, and the natural reading of
  "re-sorted" is by `roleKey` — which is the **no-op** the next sentence retires, performed under a
  new name. An ambiguous mutation is not a killer.
  **The mutation an earlier draft named — "rebuild `RoleMedoid[]` in sorted-by-`roleKey` order
  instead of `roles[]` order" — is a no-op and is retired**: `roles[]` is `roleKey`-sorted by
  construction (`roles.ts:1030` + `mine.ts:1035`), so the mutant and the original build the same
  array. A killer that cannot fail is the defect R5-I11 exists to prevent, and this one shipped for
  one round. The mapping is still worth a killer — it is invisible to every criterion that only asks
  "is there a role finding" — so it keeps one that can actually fail.
- **MR-9b (rung 0):** delete the `ownFeatureCount >= minOwnFeatures` gate ⇒ criterion 8b fails: the
  `_untyped` scope receives a role, and D8's smallest-evidence-class rule then shadows the `_all`
  finding the criterion also asserts, so both halves move at once.
- **MR-10 (governance smallest-first):** pick the **largest** evidence class ⇒ criterion 7 fails.
- **MR-11 (τ from the fact):** hard-code `preferenceGapBits` in the verdict ⇒ acceptance row 4 fires
  when it must not.
- **MR-12 (novelty detection):** treat an unseen value as an in-alphabet zero-count value ⇒ row 5's
  **novelty note disappears** and its WARN cap stops applying. **Δ does not move, and the plan says
  so rather than sending an implementer after a delta that cannot exist:** `p̂(e)/p̂(v)` cancels the
  shared KT denominator to `(n_e + ½)/(n_v + ½)`, and an in-alphabet zero-count value has
  `n_v = 0` exactly as ⊥ does — §9.3's own words, "numerically like ⊥ but **NOT novel**"
  (`v6-spec.md:385`). The observable difference is the flag, not the arithmetic.
- **MR-13 (channel downgrade):** make the non-`pre` channels pass DENY through unchanged ⇒
  criterion 10 fails, and R5-I3 is broken in the one direction it forbids.
- **MR-12b (novelty cap):** delete the `!novel` conjunct from D9's severity rule ⇒ a test driven
  from a **synthetic DENY-eligible** fact with an out-of-alphabet observed value now yields DENY
  where it must yield WARN. MR-12 kills the novelty *detection*; this one kills the *cap*, and
  nothing else in the plan observes it. The test lives beside criterion 10's
  synthetic-severity cases, since no real R5 snapshot can reach it.
- **MR-14 (domain skip):** treat out-of-domain as `false` ⇒ criterion 11 fails and every
  undecidable surface becomes a deviation.
- **MR-14b (no-argument file set):** make the no-argument form a silent no-op ⇒ criterion 13's first
  case fails. Conversely, widening it from the dirty set to the whole repository ⇒ criterion 13's
  clean-file clause fails.
- **MR-14c (gate 0):** delete the `forParsing` gate from the set resolution **and** from
  `extractScopesForCheck` ⇒ criterion 14 fails on all three of its cases — the test file, the
  excluded path and the narrowed include — which is the product speaking about code it never mined.
- **MR-14e (gate −1):** delete any one of gate −1's three tests ⇒ criterion 14b fails on the
  corresponding case (gitignored / symlink / nested checkout). Deleting the whole gate fails all
  three at once **and** re-breaks criterion 15, since the existence check lives inside it.
- **MR-14f (the boundary predicate itself):** replace `isNestedProjectBoundary`'s body with bare
  existence — "a `.git` or `.yggdrasil` entry of any kind is a boundary" ⇒ criterion 14b fails **in
  both of the files its split puts it in, on one mutation**: its two negative cases fail in
  `tests/e2e/cli-roots-check.test.ts` (both pseudo-package files go silent), **and** the
  `findNestedProjectRoots` assertion fails in `tests/unit/io/repo-scanner-nested.test.ts`, because
  the shared implementation makes the index path wrong in the same edit. Two files, one mutation —
  which is the point of the shared fixture rather than an artifact of it. This is the mutation
  MR-14e cannot make: deleting a test is not the same defect as writing a looser one, and the looser
  one is the one a paraphrase actually produces.
- **MR-14d (existence filter):** delete the existence filter from Step 8.1 ⇒ criterion 15 fails, and
  it fails in the shape that matters: not a wrong message but **silence plus one incident** for the
  whole run, which is how this defect would present in production.
- **MR-14g (the exemplar existence filter):** copy `MinedFact.exemplars` straight into
  `VerdictFact.exemplars` — i.e. delete D4's re-validation from the projection (Step 7b) ⇒
  criterion 16 fails on both halves: the all-deleted case emits a `See:` line naming three files
  that no longer exist, and the one-surviving case names all three. Distinct from MR-14d despite the
  shared word: 14d is about the *subject* paths a run looks at and presents as silence, while this
  one is about the *evidence* a message shows and presents as a message pointing at nothing —
  the product's most literal promise ("here are three real examples to copy") turned into three dead
  paths, which no other criterion in the increment can see.

**NON-goals.** No budgets, dedup or session state (T6); no telemetry, ledger or closure (T7); no
hook channels or stdin (T5); no demotion (T8); no bash sweep or completeness (T9); no `status`
changes (T10).

---

## Task 4 — The verbalizer and the complete message catalog

**Scope.** `speech.ts` grown to the whole of §11.1–§11.2 and Appendix A: one generic phrase per
enumerator, every note the template can carry, every deviation phrase, and the naming table applied
to every rendered string.

**A notation rule this task makes load-bearing.** Appendix A's templates are also named T1, T2, T3,
T5 and T7, and this plan's tasks are named T1–T11. Every reference to a template is written
**"Appendix A's T<n>"**, never bare — a bare `T2` in a plan whose Task 2 is the snapshot-fields task
is a guess-point, not a shorthand. Task references stay bare.

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
  R5-I14 makes the naming table binding on every rendered string). **Two rows of that same table are
  deliberately overridden in the other direction — spec over design — and are flagged here for the
  same reason:** `:416` maps `d[...]` to "local to `<dir>/`" while this increment renders §9.4i's own
  **`local (<dir>/)`**, and `:417` maps a role to "group «label»" while it renders the **bare medoid
  label**. In both cases §11.1's *rendered examples* (`v6-spec.md:517`) are the more literal
  authority for the message **body**, while design §11's table governs vocabulary choices the spec
  leaves open; T4 criterion 3 asserts the spec's forms "verbatim", and this is what "verbatim" means.
  ), `{seed_note}` (" (+seeded)"),
  `{novelty_note}`, `{stability_note}` (**omitted** in R5 — `stabilityDays` is structurally absent
  until R6, and the spec's own rule at `:513` is "omitted when absent"), and **the locality contrast
  sentence, which has two forms, keyed on cell class**: §9.4i gives it as "this is the local default
  of this directory / **of this group**" (`v6-spec.md:428`), and `parentExp` is `null` only for
  `_all` facts (`mine.ts:141-142` — the doc comment, then the field) — so a **role** fact carries it too and must render the *group*
  wording, while §11.1's quoted example (`:527`) shows only the directory wording. "Verbatim" in T4
  criterion 3 therefore means "verbatim in the form its cell class selects". No transition text ever renders in a message (Appendix A's T3 is report-only, `:513`).
  **One switch that looks like a note and is not, named here so this enumeration reads as complete:**
  whether the `See:` line renders at all is **not** a note this task switches. It follows from
  whether `VerdictFact.exemplars` is empty, and the emptying is D4's file-existence filter, which
  runs one layer earlier in the command layer's projection (T3 Step 7b, T3 criterion 16, MR-14g)
  because `speech.ts` carries `no-direct-fs`. The renderer's whole obligation is the one it already
  owes a fact with no conformers: render the message, omit the line.
- [ ] **Step 4: `{unit_plural}` from `appliesKind`** — methods / types / files / directories — and
  the per-row deviation phrase ("does not…", "is `<observed>`" for categoricals), which design §12
  names as a productionized gap the prototype left generic (`:463`).
- [ ] **Step 5: Appendix A's **T2** (the DENY reason), landing only the lines R5 can source.**
  Its six lines do not all belong to this increment (`v6-spec.md:774-782`): line 3 needs
  `{reach_reason}` and `{calibPrecision}`, both produced only by §14 calibration — **R6** — and
  lines 5-6 advertise `yg roots seed add`, a command this plan's own NON-goals assign to **R8**. So
  R5 renders **lines 1, 2 and 4** (the header, the evidence sentence, the exemplars), the renderer
  takes the reach/precision pair as an optional argument that nothing supplies yet, and the message
  simply ends after `See:` rather than advertising a command that ships two packages later.
  R6 adds line 3 by supplying that argument and flips the eligibility flag; R8 adds the remedy line.
  The narrowed claim — and the only one this plan makes — is that **R6 does not have to restructure
  this renderer**, not that the template is complete.
- [ ] **Step 6: The naming-table test.** A single test asserts that no rendered message in the whole
  corpus of fixtures contains any of the forbidden internal tokens: `FACT`, `pid`, `surface=`,
  `factKey`, `roleKey`, `Δ`, `tau`, `_all`, `hook_shaped`, `d[`, **`agentShare`**,
  **`package-wide ()`** (round 3's empty-parenthesis label), **`_root`** — the token itself, not
  just `package-wide (_root)`, since a sentinel is forbidden in stdout however it is wrapped
  (round 8's M3) — **`_repo`**, on the same reasoning and for free, and **a bare configured threshold rendered
  as a number-versus-number comparison** (the `>= {alarm}` shape §18.4's own template carries —
  R5-I14 and design §11 (`:426`) put thresholds in `explain` alone, and `explain` is R7's). The
  corpus this runs over is **what exists when this task runs: the rendered messages**. Execution is
  strict T1 → T11, so `status`'s strings — where `agentShare` and a bare threshold comparison could
  appear — do not exist for another six tasks; asserting over them here would be vacuous by
  construction. **T10 Step 6 extends this same test's corpus to the `status` renderer's output**, and
  says so by its own number. This is R5-I14's killer, and it is worth more than any individual
  phrasing assertion.
- [ ] **Step 7: Graph ritual + report.**

**Acceptance criteria.**
1. Every §11.2 row renders both its `expected = true` and its `expected = false` form (where the row
   has one) for a hand-built fact, matching the spec's text word for word.
2. The `nameshape` row renders three example names and **never** the shape string.
3. A directory fact whose `parentExp ≠ expected` renders the `local (<dir>/)` label and appends the
   locality sentence's **directory** form verbatim; the same fact with `parentExp == expected`
   renders neither. **A role fact with `parentExp ≠ expected` renders the sentence's *group* form**
   (§9.4i's second wording) beside its medoid label — the arm an earlier draft left both unstated and
   untested, though `parentExp` is non-null for every role fact.
3b. **All five partition labels render — `''` and `'_root'` included.** A fact from partition
   `'_repo'` renders `repo-wide`; a fact from partition `''` — the root-level-package shape D5
   builds a fixture for — **also** renders `repo-wide`, never `package-wide ()`; a fact from
   **`'_root'`** — the catch-all bucket that survives its own 300-scope floor in a monorepo with no
   root-level package marker — **also** renders `repo-wide`, never `package-wide (_root)`; a fact
   from `'packages/api'` renders `package-wide (packages/api)`; a role fact renders its medoid
   label. Stated by value, because `''` and `'_root'` are the two the literal §9.4i rule gets wrong,
   and both are live final ids rather than internal keys.
4. A fact with `hookShapedConform = 2` renders the echo-shaped note with N = 2; with 0 it renders no
   note at all.
5. The naming-table test passes over every fixture message, and fails if any forbidden token is
   reintroduced (demonstrate by reintroducing one).
6. Appendix A's T1 body is exactly the spec's four lines in order, with the optional `{named_fix_line}`
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

**NON-goals.** No Appendix A T5 (the completeness message — T9), no Appendix A T6 (seed tension) or
T8 (export text) — both R8 — and no Appendix A T7 rendering here (T10 owns where the alarm prints).

---

## Task 5 — Channels, hook protocols, and the fail-open boundary

**Scope.** `--hook pre|post|bash|stop|generic`, `--session`, `--content`, `--as`; the stdin payload
and the exact JSON each channel emits; the single fail-open boundary with its harness rethrow; path
safety; the hard deadline.

**Authorities.** Spec §12.1–§12.3 (`v6-spec.md:562-580`), §12.5's deadline (`:586`), §12.7's
staleness (`:592`), §21.1–§21.2 (`:719-720`); design §3's command row
(`integration-design.md:80`), §8.1's protocol path (`:316-338`), §9's DENY boundary (`:365-383`),
§13's hook-integration suite (`:510-511`).

**Files.** Edit `source/cli/src/cli/roots-check.ts`; create
`source/cli/tests/unit/cli/roots-check-channels.test.ts`; create
`source/cli/tests/e2e/cli-roots-check-channels.test.ts`; create recorded stdin fixtures under
`source/cli/tests/fixtures/roots-hook-payloads/`.

**Steps.**
- [ ] **Step 1: Input resolution, per D10.** Payload-then-flags-then-positional precedence, stated
  once in the file header as a table. Stdin is read **only** when `--hook` was passed and stdin is
  not a TTY, and that read carries its own timeout — an unclosed pipe is the one genuinely
  asynchronous wait on this path, and a timer is the right tool only there.
  **`--content <p>` is read here, once, by the command layer**, and which gate applies to `p` versus
  to `--as`'s target `q` is fixed by T3 Step 8's per-source gate matrix — this step implements that
  row rather than inventing a second policy. `p` is `lstat`ed and read and nothing is ever said
  about where `p` lives; `q` is gated on everything except existence. A `p` that is missing,
  unreadable or not a regular file is silence, exit 0 and one incident (criterion 3c) — not exit 1,
  which R5-I1 reserves for malformed arguments.
- [ ] **Step 1b: The hard deadline is cooperative, not a watchdog** (`v6-spec.md:586`). §12.5 is
  explicit about the mechanism and about why: `hookHardTimeoutMs` (900) is enforced "via
  cooperative checks **between stages** (parse → enumerate → role → verdict → format); **sync work
  is uninterruptible**, so the largest stage bounds overshoot." A `setTimeout` wrapped around the
  run cannot fire while `extractUnits`/`enumerate` execute synchronously — which is exactly where
  the cold budget goes — so a timer would provably never fire on the case it exists for. The
  implementation is therefore one `deadlineExceeded()` check at each of the five named stage
  boundaries; on the first one that trips, the run abandons the remaining stages, emits the
  channel's "nothing to say" output, records one incident naming the stage, and exits 0. **The
  honest promise is the one §12.5 makes**: overshoot is bounded by the largest single stage, not by
  900 ms absolutely — say that in the code and in `docs/roots.md`, never "never a hang".
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
- [ ] **Step 3: The one boundary — and the two regimes it separates.** Wrap the entire entry point.
  On any throw that reaches it: zero findings, one incident (stage + message), the channel's own
  "nothing to say" output, exit 0. The harness option rethrows instead.
  **Verify it by injecting throws at §12.5's five stage boundaries** — parse → enumerate → role →
  verdict → format (`v6-spec.md:586`) — through the **same test-only injection seam** Step 1b's
  deadline check uses, one boundary per case. Do **not** verify it by corrupting a session file, a
  `demotions.json`, a grammar registration or a source file, **or by making a `.state/` append
  fail**: all five are **absorbed** by contracts this plan states (T1 Step 3 for the record-level and
  I/O-level read tolerance, T1 criterion 5 for malformed content, T1 Step 3b for the writer, D6 gates
  1 and 5 for the parse), so they produce a normal run with
  findings and zero incidents — an earlier draft of this step listed four of them and was
  unsatisfiable, because satisfying it would have meant *breaking* T1's tolerance contract. Criterion
  4 covers the escaping regime, criterion 4b the absorbed one, and 4b's five legs are exactly
  R5-I15's five faults.
- [ ] **Step 4: Path safety (§21.2) — landing into T3 Step 8's third slot, not beside it.** This is
  filter 3 of the set resolution T3 Step 8 already owns, applied to the **evaluation** set and
  inheriting that step's totality rule: a `realpath` that throws (`EACCES`/`ELOOP`/`ENAMETOOLONG`) is
  a drop with one `debugWrite`, never an exception, so the step as a whole still cannot throw and
  still sits outside R5-I2's boundary. Every input path is realpath-resolved and must lie inside the
  repository; one incident per session for the whole class, not one per path; symlink escape
  refused. A rejected path is silence, not an error.
  **The `--as` target resolves differently, per T3 Step 8's gate matrix, and the difference is not
  an exception to this step but a row of it.** `realpath(q)` throws `ENOENT` whenever `q` does not
  exist — which for a `--as` target is the *normal* case — so `q` is resolved by realpath-ing its
  **nearest existing ancestor**, re-appending the remaining segments and normalizing, and testing
  containment on the result. `ENOENT` is therefore **not** in this step's drop list for a
  supplied-bytes target (it remains a drop for every on-disk source, where it means the file is
  gone); `EACCES`/`ELOOP`/`ENAMETOOLONG` stay drops for both. A `--as` target of `../../etc/passwd`
  is still refused, because normalization happens after the re-append — which is the case that would
  otherwise be silently admitted by "skip the check when the path does not exist".
- [ ] **Step 5: Staleness (D17).** Compute the cheap tuple, and when it differs from the snapshot
  header, record the staleness modulator for T10's `status` line and note it on any message that
  would have been DENY (in R5, none). Say in the code exactly which input is **not** compared and
  who catches it.
- [ ] **Step 6: Graph ritual + report — including `src/cli/roots-check.ts`'s prompt headroom.**
  Re-measure with `node scripts/prompt-headroom.mjs --file source/cli/src/cli/roots-check.ts` from
  repo root (T1 Step 6's query mode — the bare invocation reports only the three tightest pairs
  repo-wide and says nothing about this file) and report the figure against
  the ≈66 KB ceiling the Global constraints derive; crossing it is a **STOP**, never a refactor.

**Acceptance criteria.**
1. Each of the five channels, driven by a recorded stdin fixture, produces byte-exact expected
   output — including the two "nothing" cases (`post` with no findings; `pre` always).
2. `stop_hook_active: true` produces no output and exits 0.
3. `--content <p> --as <q>` evaluates the content of `p` as though it lived at `q`, and the emitted
   `path` is `q`. `--content` with more than one positional file is a what/why/next error and exit
   **1** — the single argument-validation carve-out R5-I1 already names and scopes, raised before
   any evaluation begins, wrapped in `buildIssueMessage` exactly as `cli-command-contract` requires
   of an option-mutex violation. It is refusing to run, not reporting a finding.
3b. **The `--as` target need not exist — asserted on a path that does not.** With `p` an **existing**
   golden file carrying a planted deviation and `q` = `src/brand-new.ts`, a path present nowhere in
   the working tree: the run emits **one** finding whose `path` is `src/brand-new.ts`, exits 0, and
   records no incident. This is the criterion T3 Step 8's gate matrix exists for; without it a
   filter 1 that `lstat`s every candidate passes every other criterion in this plan while making
   `--as` structurally dead. Paired with its three refusals, so the gating that survives is visible
   too: the same invocation with `q` = `packages/external/x.ts` (inside the nested checkout),
   `q` = `src/x.test.ts` (a test pattern), `q` = `../outside.ts`, and **`q` = an existing symlink to
   a real source file** is **silent** in all four,
   exit 0 — the first two by gate −1 and gate 0 on the target, the third by this step's containment
   test resolving through `q`'s nearest existing ancestor, and the fourth by the file-kind clause:
   `q` may be absent, or a regular file, and nothing else. The fourth refusal is the one that fails
   if `q` is exempted from `lstat` outright rather than exempted from *existence*.
3c. **`--content` naming a path that is not a readable regular file** — missing, a directory, or
   mode `000` (skipped where the suite already skips its chmod cases under root) — is **silence,
   exit 0 and exactly one incident**, never exit 1 and never a stack trace. The exit code is the
   point: R5-I1's carve-out covers malformed *arguments*, and a missing input file is not one.
   **The incident is the other half of the assertion and the half that collides with T3 Step 8's
   totality clause if the exception there is missed:** `p` is a byte source, not a set member, so
   this is not the silent `debugWrite` drop every other `lstat` failure in that step produces. Both
   sites now say so — T3 Step 8's "Second" consequence and its totality clause — and this criterion
   asserts `.state/incidents.jsonl` gained exactly one line, not merely that the run was silent.
4. **Escaping faults.** A forced throw at each of **§12.5's five stage boundaries** (parse,
   enumerate, role, verdict, format — the same seam criterion 5b uses, and the same five the phrase
   "the five stages" means everywhere in this plan) yields zero findings, exit 0, and **exactly one**
   incident naming that stage — driven over a **three-file** run, so "exactly one" is a statement
   about the run and not about a single file (MR-19 depends on it); with the harness option the same
   injection throws instead.
4b. **Absorbed faults, the half no criterion previously observed — all FIVE of R5-I15's.** With a
   deliberately corrupted session log line, a non-JSON `demotions.json`, a file whose grammar is
   unregistered, **a forced `parseFile` throw**, and **a failed `.state/` append** — the fourth
   driven through the **same test-only injection seam**
   criterion 4 and 5b use, **not** by writing malformed source: tree-sitter is error-tolerant, so
   broken syntax yields a tree full of ERROR nodes and never throws, and D6 gate 5's catch
   (`pipeline.ts:115-118`) is reachable only when `parseFile` itself throws (a grammar-load failure,
   or `parser.parse()` returning null — `ast/parser.ts:115-122`). A fixture file cannot produce it,
   and a criterion that looked satisfied by a file which in fact parsed cleanly would be the same
   unsatisfiable shape this criterion exists to replace. `extract-file.test.ts` additionally covers
   the `minimalFileScope` degrade directly, since no landed test exercises it today.
   **The fifth is produced by putting a directory where `.state/telemetry.jsonl` should be**, so the
   append throws `EISDIR` for every user and the leg needs no `chmod` and is not skipped under root —
   and, decisively for this criterion, `.state/` itself stays writable, so an incident **could** be
   recorded and "zero incidents" is a real assertion rather than a vacuous one. (A read-only
   `.state/` would make the incident file unwritable too and the assertion would pass for the wrong
   reason; T1 criterion 6c carries that arm, where the subject is the store rather than the run.)
   Each of the five present in a run that also contains one genuinely deviating file —
   the run **still emits that file's finding**, exits 0, and records **zero** incidents. Each
   degradation contributes one `debugWrite` line and nothing else. This is R5-I15 made observable,
   and it is the criterion that fails if anyone "fixes" tolerance by throwing. The fifth leg is what
   gives R5-I15's fifth clause a killer at all: before it, an append that threw would have exited
   through R5-I2's catch and no criterion in the plan would have noticed.
5. A path outside the repository yields silence and one incident for the session, however many such
   paths were passed.
5b. **The deadline fires at a stage boundary.** With an injected slow stage (the same injection
   seam criterion 4 uses), the run abandons the remaining stages at the next boundary, prints the
   channel's nothing-to-say output, exits 0, and records exactly one incident naming the stage that
   overran. Asserted with an injected deadline far below 900 ms so the test costs milliseconds and
   pins the mechanism rather than the number (R5-I16: no timing assertion enters the gate).
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
  incident" fails on the three-file run and a partial result escapes.
- **MR-19b (the two regimes stay disjoint):** make any one of R5-I15's five absorbed faults throw
  instead of degrading — let a malformed session line abort the fold, or **delete the swallow from a
  `.state/` writer so a failed append rethrows out of `appendToDebugLog`** — ⇒ criterion 4b fails on
  that fault's leg. **The failure is not the same on both arms, and the MR says which, because an
  implementer performing R5-I11's live round-trip looks for the stated observable and would
  otherwise read a surviving mutant as dead:**
  - **the four read-side faults** (corrupt session line, non-JSON `demotions.json`, unregistered
    grammar, injected `parseFile` throw) all precede evaluation, so the run genuinely produces
    nothing: **the deviating file's finding disappears and an incident appears** where R5-I15
    promises none;
  - **the writer arm** fails on 4b's **zero-incidents** assertion and on that alone. D14 writes the
    **output first**, before any append (T1 Step 3b's third reason), so under this mutation the
    message is already on stdout when the telemetry append throws and the boundary catch then
    records an incident. The finding survives; the incident is the tell. **That is also the whole
    reason 4b's fifth leg keeps `.state/` itself writable** — an unwritable `.state/` would swallow
    the incident too and the assertion would pass for the wrong reason (T1 criterion 6c carries the
    read-only arm, where the subject is the store rather than the run).

  The writer arm is named explicitly because it is the one whose mutation is a *deletion of two
  lines* rather than a rewrite, and the landed helper's own shape (`appendFileSync`,
  `debug-log-writer.ts:7-9`) is the un-mutated state.
- **MR-20 (harness rethrow):** make the harness option fail open too ⇒ criterion 4's second half
  fails, and every future mutation-harness crash would report as a clean run.
- **MR-21 (`stop_hook_active`):** ignore the flag ⇒ criterion 2 fails (and a real host would loop).
- **MR-22 (path safety):** drop the realpath containment test ⇒ criterion 5 fails.
- **MR-22b (the supplied-bytes row):** apply filter 1's `lstat` to the `--as` target as an
  *existence* test, as it is applied to the on-disk sources ⇒ criterion 3b's first half fails —
  `src/brand-new.ts` is dropped and the run goes silent. Conversely, **skip the `lstat` on `q`
  entirely** (rather than skipping only its existence requirement) ⇒ criterion 3b's **fourth**
  refusal fails and an existing symlink at `q` gets spoken about. And **skip gate −1 and gate 0
  entirely for a supplied-bytes target** ⇒ criterion 3b's first three refusals fail. Three mutations,
  because the row is a narrow distinction — *absent or a regular file* — and each of the three ways
  to get it wrong fails a different case.
- **MR-22c (ENOENT on the target):** resolve containment with a bare `realpath(q)` ⇒ criterion 3b's
  first half fails with a drop, and the failure is invisible on every fixture whose `--as` target
  happens to exist — which is why 3b's target is required to be a path that does not.

**NON-goals.** No sweep, no completeness (T9). No hook *installer* (R8). No `permissionDecision`
ever emitted from a real snapshot (D9).

---

## Task 6 — Session state, budgets, dedup

**Scope.** `session-state.ts` (pure fold), the session identity ladder in the command layer, and
§11.3 applied as the single ordering and truncation authority.

**Authorities.** Spec §11.3 (`v6-spec.md:551`), §11.4 (`:554-556`), §12.5 (`:586`); design §8.1's
session-identity ladder (`integration-design.md:329-334`), §12's "sessions as append-only event
logs" row (`:466`).

**Files.** Create `source/cli/src/roots/session-state.ts`; edit `verdict.ts`/`roots-check.ts` to
route findings through it; create `source/cli/tests/unit/roots/session-state.test.ts`; create
`source/cli/tests/e2e/cli-roots-check-budgets.test.ts`.

**Steps.**
- [ ] **Step 1: The fold.** `foldSession(events, sessionId) → { warnCount, dedupKeys, openInterventions,
  writtenFiles, fileState, seedTruncated, floodSkipped, lastSweepTs, completenessEmitted }`. Pure,
  total, and **idempotent under duplicate events** (D13) — a replayed event must not double-count a
  warning, and `writtenFiles` is a de-duplicated set, not a list. **The `sessionId` parameter is not
  decoration:** no `SessionEvent` arm carries one — the session is a property of the *log file*
  (`sessionLogPath(stateDir, sessionId)`), not of any event — so `OpenIntervention.openedSessionId`
  is underivable without it. T8's cross-session pass supplies each ended session's id from the file
  name it read.
- [ ] **Step 1b: The `'checked'` event, because completeness has no other honest source.** T9's
  sweep needs *D = the files this session wrote* (§13.5, `v6-spec.md:625`), and neither the other
  four event kinds nor `fileState` can supply it: deriving `D` from `warned` events would make it
  "files that produced a message", so a session that edited ten files cleanly and one badly would
  get completeness advice about one — and the clean files are exactly the ones a completeness sweep
  exists to pair up; deriving it from `fileState` covers Bash-sweep sessions only, and T9 Step 3
  itself says an Edit-only session leaves `fileState` unset. So a **`'checked'`** event carrying
  `{ files: string[] }` is appended by **every** run that evaluates files — a per-file check, a
  protocol-path run over the dirty set, and a bash sweep alike — **regardless of whether it found
  anything** — **including a bash sweep, which appends `'checked'` (the paths it evaluated) and then
  `'sweep'` (its own state); the two are not alternatives, and D14 says so in those words.** The one
  run that appends no `'checked'` is a *seed* sweep, because it evaluates nothing at all by design
  (T9 Step 1). **Its producer is the command layer** — `src/cli/roots-check.ts` builds it from the
  **participation** set (T3 Step 8 filter 1's output: everything in the index's file universe that
  this run legitimately looked at), **not** from the narrower evaluation set, and merges it into the
  applied `Intents` (D1); neither engine stage can, and D1 says why. **The distinction is
  load-bearing, not bookkeeping:** the evaluation set is post-`forParsing`, which contains
  `TEST_PATTERN_EXCLUSIONS`, so building the payload from it would make `writtenFiles` — and
  therefore §13.5's `D` — structurally **test-free**, silencing the most useful completeness
  direction there is ("you changed the test; you usually also change `src/order.ts`"), killing D20's
  own motivating pair, and leaving T9 criterion 5's second and third cases unreachable through the
  product while still passing as unit tests. Participation is broad and speaks about nothing;
  evaluation is narrow and speaks. T3 Step 8 carries the same statement where the fork happens —
  **including its one asymmetry: T5's path-safety filter narrows the evaluation set only, so a path
  that resolves outside the repository is silent on stdout yet still recorded here as looked-at.**
  Its place in the write order is **first among the session events**, before the
  `warned` appends and before `'sweep'` (D14), so a run that prints nothing still records that it
  looked.
  `foldSession` unions their `files` into `writtenFiles`.
  **The field is an over-inclusive approximation of §13.5's `D`, and the direction is stated rather
  than left to be discovered:** §13.5 says "files written this session", while `'checked'` fires for
  every file a run *evaluated* — including `yg roots check <file>` on a file the session merely
  inspected, the form R9 will teach agents to run. So completeness may name a partner for a file
  nobody edited. That is bounded by `completeness.maxItems` (5) and the once-per-session guard, and
  it errs toward *offering* a pairing rather than withholding one, which is the safe direction for an
  advisory note. Note the direction is over-inclusive in one axis and **exactly right in another**:
  a test file the agent edited *is* in `D` (D6 gate 0 keeps it out of *evaluation*, never out of
  participation), which is what makes the test→source completeness direction reachable at all.
  **The alternative — restricting `D` to files the session actually changed — is
  rejected explicitly, not by silence:** roots observes checks, not edits, so "changed" would have to
  be reconstructed from content hashes across runs, which is the bash sweep's own mechanism (T9) and
  is unavailable on the Edit path. This is a widening of T1's `SessionEvent` union and T6's fold result, landed
  **here**, so T9 consumes shapes that already exist rather than re-opening two contracts this plan
  calls closed.
- [ ] **Step 2: Dedup, WARN-only.** Key `(stable_id, surface, direction)`; DENY never deduplicated,
  with the reason in the code: a block a retry defeats is not a block, and repeated denies are
  naturally rate-limited because the denied edit never lands.
- [ ] **Step 3: Budgets — `applyBudgetsAndDedup(findings, fold, config, { sessionId, nowIso }) →
  { emitted, emissionIntents }`**, the signature D1's pipeline names, so Steps 2 and 3 land as one
  exported function rather than two loose helpers. **The fourth argument is not this step's
  invention and may not be dropped:** the two records this step returns require a `ts` (both) and a
  `sessionId` (the telemetry row), `findings`/`fold`/`config` carry neither, and R5-I4 forbids this
  module reading a clock or deriving an identity — so `src/cli/roots-check.ts` passes in the *same*
  `sessionId` and `nowIso` it put on `VerdictInput`, one resolution and one clock reading per run.
  D1 fixes the signature; this step implements it. Per response ≤ 3 ordered
  `(severity desc, Δ desc, surface asc)`; per session ≤ 12 WARNs, then DENY only. Both read the
  **post-`channelFilter`** severity. `emissionIntents` carries the `warned` session events and the
  §18.1 telemetry lines for exactly the findings that were emitted — never for the ones the budget
  dropped, which the agent never saw. The overshoot
  bound from concurrent hook processes is documented at the function, not locked against.
- [ ] **Step 4: Identity ladder** in `roots-check.ts` per D12, with each rung's fallback logged once
  at `debugWrite` level so a support question about merged budgets is answerable. **All three rungs
  return 12 lowercase hex characters** — including the last resort, which D12 hashes rather than
  emitting the `ppid ∥ cwd ∥ UTC-day` tuple raw. That is not cosmetic: T1 turns the id straight into
  a file name (`sessionLogPath`) and T8 reads it back out of one (`listSessionLogs`), so a raw `cwd`
  in the id — absolute, slash-bearing, drive-colon-bearing on Windows — breaks the round-trip in
  both directions. Asserted here as a shape test on all three rungs (`/^[0-9a-f]{12}$/`) and
  round-tripped at T1 criterion 4c.
- [ ] **Step 5: Pruning, and the growth law it is the only bound on.** `sessions.pruneDays` (7)
  applied opportunistically — at most once per run, never blocking the verdict, failures swallowed
  to one `debugWrite` (R5-I15). **State the law where the prune lives**, because the `'checked'`
  event changed it: before it a quiet session wrote ~0 events, and now **every evaluating run writes
  one**, while `foldSession` reads the whole log on every hook invocation inside the 700 ms cold
  budget. There is no size cap and no rotation — unlike incidents (FIFO 500) and telemetry
  (retention compaction) — so mtime-based pruning at 7 days is the only bound, and that is a
  deliberate choice rather than an oversight: one short line per run over at most seven days is
  small, and a second capping mechanism would be machinery bought for a cost nobody has measured.
  T11's dogfood step reports the observed session-log size beside its other figures.
- [ ] **Step 6: Graph ritual + report — including `src/cli/roots-check.ts`'s prompt headroom**
  (`node scripts/prompt-headroom.mjs --file source/cli/src/cli/roots-check.ts`, against the
  ≈66 KB ceiling; crossing it is a **STOP**).

**Acceptance criteria.**
1. Five findings on one response emit **3**, and the three are the top three under
   `(severity desc, Δ desc, surface asc)` — asserted by value on hand-built findings whose Δ values
   are 4.0, 3.7, 3.7, 2.9, 2.6 with two of them sharing Δ so the `surface asc` tie-break is
   exercised. **The five are supplied in an input order — `(roleKey asc, surface asc)` — whose first
   three are *not* the three highest by Δ**; without that the pre-budget truncation MR-26 mutates in
   would produce the same three and the killer would not kill.
2. The same `(stable_id, surface, direction)` warned twice in one session emits once; the same
   `stable_id` and `surface` with a **different** observed value emits again (direction is part of
   the key).
3. **On the `pre` channel**, a synthetic DENY finding repeated in one session emits **both** times
   (§11.3: DENY is never deduplicated). The channel is named because it is load-bearing: on any
   other channel the same finding is downgraded to WARN by `channelFilter` and dedup *does* apply.
4. **On a `post` channel session**, after 12 WARNs the 13th is silent; a `pre`-channel run in the
   same session with a synthetic DENY still passes (§11.3: "then DENY only"). The mixed-channel
   shape is stated because `pre` drops WARN, so twelve WARNs can never accumulate on `pre` alone.
4b. **The downgraded DENY is a WARN for both purposes.** On a non-`pre` channel, a DENY-eligible
   synthetic fact — downgraded to WARN by `channelFilter` — is **silent** after the twelfth warn,
   and **is deduplicated** on its second sighting in the session; the identical fact on `pre` passes
   both times. This is §11.3's own sentence ("a DENY downgraded to WARN on a non-pre channel is a
   WARN for both purposes") and it is the only criterion that observes it.
4c. **The `'checked'` event reaches the fold from the command layer.** A run that evaluates two
   files and emits **no** message still appends exactly one `'checked'` event naming both, and
   `foldSession`'s `writtenFiles` contains both — the merge point D1 assigns to
   `src/cli/roots-check.ts`, asserted through the applied `Intents` rather than by inspecting the
   engine. A second run naming one of the same files leaves `writtenFiles` with two entries, not
   three (it is a set).
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
- **MR-25 (post-filter severity):** read severity **before** `channelFilter` ⇒ **criterion 4b**
  fails in both halves: the downgraded DENY escapes the WARN budget (it emits after the twelfth
  warn) and escapes the dedup (it emits twice). Pointed at 4b and not at criterion 4, which contains
  no downgraded finding and therefore could never have observed this.
- **MR-26 (single truncation authority):** truncate `evaluate`'s output to 3 **before** the budget
  stage — i.e. in input order, `(roleKey asc, surface asc)`, rather than in §11.3's
  `(severity desc, Δ desc, surface asc)` — ⇒ criterion 1's by-value ordering assertion fails,
  because the three findings that survive are the first three by surface rather than the three
  highest by Δ. Stated that way on purpose: a second `.slice(0, 3)` applied *after* §11.3 has
  already truncated to 3 changes nothing observable and would have been a killer that cannot fail
  (R5-I11).

**NON-goals.** **Closure telemetry and the ledger (T7)** — narrowed from "telemetry and closure",
which contradicted this task's own Step 3: the §18.1 **intervention** rows are produced *here*, by
`applyBudgetsAndDedup`, because only the budget stage knows which findings became messages
(D13a(b), transition 1). Sweep state is folded here but not *populated* until T9.

---

## Task 7 — Compliance closure, telemetry, and ledger writing

**Scope.** The loop that makes §18 real: notice at the next
sight of the same (scope, surface) whether the agent complied, write the **closure** telemetry line
and — on compliance — the committed ledger mark. **The §18.1 *intervention* row itself is T6's**
(D13a(b), transition 1: only the budget stage knows which findings became messages), and this task
owns transitions 2 and 3 only. An earlier Scope line said "record every message as an intervention",
which round 9 moved to T6 everywhere except here — and this line is the first thing a fresh T7
implementer reads.

**Authorities.** Spec §9.10's `closeIntervention` paragraph (`v6-spec.md:479`), §18.1 (`:681`),
§18.3 (`:685`); design §13's compliance-loop E2E (`integration-design.md:501-504`), §12's
"compliance closure with the once-per-session ignored bound" row (`:437`).

**Files.** Edit `verdict.ts` (the closure hook T3 left in place), `roots-check.ts` (applying
intents); create `source/cli/tests/unit/roots/verdict-closure.test.ts`; create
`source/cli/tests/unit/roots/ledger-release-roundtrip.test.ts` (criterion 7 — a **new sibling**
rather than a section of `verdict-closure.test.ts`, whose subject is the closure fold, not the
R4/R5 ledger seam; it joins `cli/tests/unit/roots`, which already declares
`uses cli/roots/engine` and `uses cli/roots/stores`
(`.yggdrasil/model/cli/tests/unit/roots/yg-node.yaml:287-288`), so it costs a mapping line and no
edge); create `source/cli/tests/e2e/cli-roots-compliance-loop.test.ts`.

**Steps.**
- [ ] **Step 1: Closure runs before every skip** (T3 Step 4's ordering), for every candidate fact of
  every evaluated scope, whether or not that fact will speak. It emits **no message** and is exempt
  from budgets (`:479`).
- [ ] **Step 2: The two branches — and which of them actually closes anything.** Open intervention
  on `(stable_id, surface)` and `v == expected` ⇒ telemetry `observedAfter: complied` **and** a
  ledger mark, **and the intervention is removed from `openInterventions`**: it is finished. Open and
  still deviating ⇒ `observedAfter: ignored`, **at most once per session per intervention** — and
  **the intervention stays open**, with only `ignoredRecordedInSession` set. **Every closure T7
  writes carries `scope: 'session'`**; `'cross-session'` is T8's alone (T1's union), and the
  in-session bound is therefore untouched by T8's terminal marker. **Both closure rows repeat the
  intervention's `severity` and `deltaBits` off `OpenIntervention`** — D13a(a)'s "as emitted" pair,
  copied and never recomputed, since at a complied closure the observed value *is* `expected` and a
  recomputed Δ would be 0. **How this composes with §11.3's
  dedup, since both fire on a re-check:** the third and later sightings of the same deviation in one
  session are suppressed as *messages* by the WARN dedup key `(stable_id, surface, direction)`, while
  closure still runs on every sighting — it precedes every skip (T3 Step 4) — and
  `ignoredRecordedInSession` is what stops those silent re-views appending a second `'closed'`
  **event to the session log**. Dedup bounds what the agent *sees*; the flag bounds what the
  **session log records**; the **store key** bounds what the pool counts. **The third clause is the
  one three rounds got wrong and D13a(c) now settles: the flag is NOT what bounds the pool.** A
  second `ignored` telemetry row carries the same `(sessionId, stableId, surface, 'ignored')` key as
  the first and is collapsed by `appendTelemetry` whatever the flag does — `observedAfter` is
  §9.10's outcome label, not the observed value. So the flag's remaining job is exactly one, it is
  observable in exactly one place (the session log), and criterion 2 asserts it there. The asymmetry is the
  whole mechanism and it is stated because the natural reading of "closed" is removal, which is
  wrong in two ways at once:
  - a PostToolUse hook fires on every Edit, so re-checks of the same file inside one session are the
    norm; if an `ignored` removed the record, the ordinary sequence *warn → re-check (ignored) → the
    agent fixes it* would produce **no** `complied` telemetry line and **no** ledger mark — T7's
    entire reason to exist, and R5-I8's one new committed file, silently never written;
  - nothing would be left open at session end, so T8 Step 2's cross-session pass would have no
    interventions to close and its `ignored` branch — the one whose own comment says "without it the
    dominant real path (agent warned, moves on, session ends) never enters the denominator" — would
    be dead code that every hand-built fixture still passes.
  §9.10 settles it in its own words: the bound is "at most once per session per intervention (**the
  open record** carries the session that would close it)" (`v6-spec.md:479`) — present tense, after
  the ignore. State
  the measured reason in the code: without the bound, a sweep or an agent re-reading a file before
  editing inflates the `ignored` denominator and can demote a 96 %-share convention within minutes.
- [ ] **Step 3: Intents, merged then applied in D14's order** by the command layer — **three** sets
  concatenate into one `Intents` record: `evaluate`'s `closureIntents`,
  `applyBudgetsAndDedup`'s `emissionIntents`, and the command layer's own `'checked'` session event
  (D1's third producer, which no engine stage can emit). Applied session events first (`'checked'`
  ahead of `'warned'`, D14), then telemetry, then ledger marks, each append idempotent under its
  key. There is exactly one applier and exactly one order.
- [ ] **Step 4: What a mark costs, said out loud.** The ledger append makes `git status` dirty and
  makes the next `index` do real work (D15). Both are intended; both go in the docs at T11.
- [ ] **Step 5: Graph ritual + report — including `src/cli/roots-check.ts`'s prompt headroom**
  (`node scripts/prompt-headroom.mjs --file source/cli/src/cli/roots-check.ts`, against the
  ≈66 KB ceiling; crossing it is a **STOP**).

**Acceptance criteria.**
1. **The closed loop, by value:** deviation → one WARN → the file is fixed → the next check is
   **silent**, and exactly one `complied` telemetry line and exactly one ledger mark exist, with the
   mark's `(stableId, surface)` equal to the intervention's.
2. **Three checks of the same unfixed scope in one session produce exactly one `'closed'`
   `{outcome:'ignored', scope:'session'}` event IN THE SESSION LOG** — and exactly one `ignored`
   telemetry row. **The session-log half is the load-bearing assertion and the telemetry half is
   not**, and the criterion says which is which: the telemetry row is collapsed by the store key
   regardless (D13a(c)), so asserting only "one `ignored` record" would pass with
   `ignoredRecordedInSession` deleted. Asserted over the raw `.state/sessions/<id>.jsonl` lines.
3. The same scope still unfixed in a **new** session produces a second `ignored` record (the bound
   is per session, not forever) — which is only reachable because the intervention survived the
   first session's ignore, **and which is the accrual D13a(d) identifies as the only path to a
   demoting sample count**: n grows one per session, never one per check and never one per `index`.
3b. **Ignored, then fixed, in the same session.** A scope is warned, re-checked while still deviating
   (one `ignored` recorded), then **fixed**, then checked again — all inside one session. The result
   is exactly one `complied` telemetry line and exactly one ledger mark, alongside the one `ignored`.
   This is the criterion that fails if an `ignored` closure removes the intervention, and it is the
   ordinary sequence of an agent that reads a warning, keeps typing, and then complies.
4. A fact that has become hook-**ineligible** since the intervention still closes it (Step 1's
   ordering).
5. A ledger mark already present is not appended twice (T1's dedupe, exercised through the real
   flow).
6. Telemetry records carry `expected`, `observed`, `deltaBits` and `factKey`, and **no separate
   `roleKey` field and no role label**. The draft's justification was wrong and is corrected here:
   §18.1 lists `factKey` *inside* the record (`v6-spec.md:681`) and `factKey` is literally
   `` `${roleKey}|${surface}` `` (`mine.ts:121`), so a record that carries `factKey` does carry the
   role key — "role-free keys" in §18.1 constrains the *identity* the pooling keys on
   (`(stable_id, surface)`), not the record's contents. Asserting "no role information" would
   therefore be asserting something false, and M3's whole forward-resolution step exists *because*
   the recorded role key goes stale. What this criterion checks is the shape §18.1 actually
   specifies: **its nine fields, plus `observedAfter` on a closure record — the tenth field §18.1
   itself adds (`{…, observedAfter}`) and the one the whole of T7 exists to write — and nothing
   else**: no separate `roleKey`, no role label.
7. **The mark R5 writes is the mark R4 releases — the wiring D15 waives a divergence killer on, and
   the only criterion in the plan that crosses the R4/R5 seam. Two legs, and the second one is what
   makes the waiver honest.**
   **Leg A — the seam, from literals.** No clock
   control and no filesystem beyond a temp dir. Write a mark with
   `appendLedgerMarks(yggRoot, [{stableId: S, surface: 'auto.deco:Injectable', date: '2026-01-01'}],
   markKey)` — the real `markKey` (`weights.ts:267`), which is what production passes (D15) — read
   it back with `readLedger(yggRoot)` (`stores.ts:274`), and feed the result to
   `releasedMarks(marks, lifecycle, clockTs, config)` (`weights.ts:250`) with everything by value:
   - a `LifecycleIndex` whose `rowFor(S, S)` returns a row — **the two-argument call is
     `(mark.stableId, mark.stableId)`** (`weights.ts:253`), so the test's index must be
     `stableId`-keyed, exactly as `releasedMarks`' own header (`:235-244`) tells its caller to build;
   - `row.lastModifiedTs = 1767225600` (2026-01-01T00:00:00Z) and
     `clockTs = 1775001600` (2026-04-01T00:00:00Z) ⇒ `stableDaysOf` = **exactly 90**
     (`weights.ts:108-110`), which clears `ledger.releaseStableDays` (90) on `<`;
   - `row.lastHumanCommitTs = 1768435200` (2026-01-15T00:00:00Z) = exactly
     `floor(Date.parse('2026-01-01')/1000) + 14 × 86400`, the `releaseMinDaysAfterMark` threshold,
     which clears it on `>=`.

   **⇒ `releasedMarks` returns a set containing `markKey(mark)`.** Then the two negatives, each
   flipping one input by the smallest step the rule can see: `lastHumanCommitTs = 1768348800`
   (2026-01-14, one day early) ⇒ **not** released; and `clockTs` one day earlier
   (`1774915200`, 2026-03-31) ⇒ `stableDaysOf` = 89 ⇒ **not** released. Both boundary values are
   exact-equality cases on purpose: an off-by-one in either comparison is invisible to a fixture
   that clears the threshold by a week.
   **What leg A can and cannot see, said plainly, because D15's waiver used to claim more.** Its
   `stableId`, `surface` and `date` are **literals the test chose**, so *the producer never runs* and
   no mutation of the code that decides which identity goes onto a mark can move one byte of it. Leg
   A pins the **seam**: `releasedMarks`' `rowFor(stableId, stableId)` shape, `markKey`'s format, the
   `YYYY-MM-DD`/`Date.parse` arithmetic, and any store that would rewrite or normalize a mark on the
   way to disk. That is real and nothing else pins it — but it is not the producer.

   **Leg B — the same round-trip, over a mark the ENGINE produced.** Build a `VerdictInput` with one
   open intervention on `(S, surf)` and a scope whose `surfaceValue` now equals `expected`, call
   `evaluate` (pure — this is the same shape `verdict-closure.test.ts` already builds), and take
   **`closureIntents.ledgerMarks[0]`** rather than a literal. Feed *that* through
   `appendLedgerMarks` → `readLedger` → `releasedMarks`, with the `LifecycleIndex` keyed on the
   **finding's own** `stableId` (`input.scopes[0].stableId`) and the `date` derived from the same
   `nowIso` the input carried — never from the mark. Assert two things by value before the
   round-trip and one after: `ledgerMarks[0].stableId === input.scopes[0].stableId`,
   `ledgerMarks[0].surface === fact.surface`, and then the release. **Keying the index on the
   expected identity rather than on the mark's own is the whole mechanism**: a closure that emits
   the scope's `skeyR`, or a `surface` sliced out of `factKey` (`` `${roleKey}|${surface}` ``,
   `mine.ts:121`), produces a mark `rowFor` cannot find, and leg B goes red where leg A would still
   be green. This is the leg MR-29b is pointed at.

   **Three properties, three owners, none of them assumed** — the waiver's obligations, each with a
   real observer: the **engine's projection choice** is leg B and MR-29b; the **store/seam contract**
   is leg A and MR-29c; and the **whole-domain** case D15 most fears — every `stableId` in the run
   drawn from pre-partition raw scopes, so the mark and the intervention agree with each other and
   are both wrong — is **T3 Step 1's equivalence harness**, which asserts `stableId`, `skeyR` and
   every surface value against the index itself and is the only thing in the increment that can.
   The `date` shape is T1 criterion 3. Until round 11 this criterion's closing sentence claimed all
   three, and leg A could observe none of them.

**E2E coverage.** `cli-roots-compliance-loop.test.ts` — the design's own named suite
(`integration-design.md:501-504`), miniaturized: spawn the built binary, `index`, plant a deviation,
`check` (assert the WARN), fix the file, `check` again (assert silence), then read
`.state/telemetry.jsonl` and the committed `ledger.jsonl` from disk and assert exactly one
`complied` and exactly one mark. This is the single most important e2e in the increment: it is the
only proof that the product's regulator is a closed loop rather than three unconnected files.

**Test obligations / mutation round-trips.**
- **MR-27 (closure before skips):** move `closeIntervention` after the `hookEligible` skip ⇒
  criterion 4 fails.
- **MR-28 (ignored bound):** remove the once-per-session bound (`ignoredRecordedInSession`) ⇒
  criterion 2 fails **on the session log** with three `'closed'` events where there must be one.
  **It does not fail on the telemetry count, and the plan says so instead of promising a failure the
  store key forbids:** the three rows share `(sessionId, stableId, surface, 'ignored')` and collapse
  to one (D13a(c)). Nor does demotion become reachable within one session — that claim was an
  earlier draft's and D13a(d) retires it. What this mutation actually costs is an unbounded session
  log on the hook path, read in full inside a 700 ms cold budget on every invocation (T6 Step 5's
  growth law), which is why the rule survives with the killer re-pointed rather than being deleted.
- **MR-28b (ignored does not close):** make an `ignored` closure remove the intervention from
  `openInterventions` ⇒ criterion 3b fails — no `complied` line, no ledger mark — and T8 criterion 4's
  cross-session pass has nothing left to close. Both halves of M4's consequence, one mutation.
- **MR-29 (mark on compliance only):** write the mark on the `ignored` branch too ⇒ criterion 1's
  mark count fails, and roots would discount evidence it never shaped.
- **MR-29b (the engine's ledger projection):** in the closure, build the `LedgerEntry` from the
  **scope's `skeyR`** instead of its `stableId`, or slice its `surface` out of `factKey`
  (`` `${roleKey}|${surface}` ``, `mine.ts:121`) instead of reading `fact.surface` ⇒ **criterion 7's
  leg B fails**, in two places: the by-value assertions on `ledgerMarks[0]` before the round-trip,
  and the release itself, because the index is keyed on the finding's identity and `rowFor` misses.
  **Leg B is named specifically and leg A is not**, because leg A's mark is a literal the test
  chose — the producer never runs there, so this mutation is invisible to it. MR-29 watches the
  mark's existence, T7 criterion 5 its dedupe, T1 criterion 3 its `date` shape; none of them asks
  whether R4 can find what the engine actually emitted.
- **MR-29c (the store/seam contract):** have `appendLedgerMarks` normalize a mark on write —
  lower-case the `stableId`, or strip the `auto.` prefix from the `surface` — ⇒ **criterion 7's
  leg A fails**: `readLedger` returns a mark whose `markKey` names a key nobody looks up and whose
  `rowFor` misses. Separated from MR-29b because the two mutations live in different layers and
  exactly one leg can see each; a single MR over both would have been satisfied by whichever leg
  happened to fail, which is how round 10's version came to point at a leg that could not fail at
  all.
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
two-sided, **fixed**), Appendix E.7 (`:922`); design §12's "per-fact expected-flip filter plus the
cross-session closure pass in demotion pooling" row (`integration-design.md:447-448`).

**Files.** Create `source/cli/src/roots/health.ts`; edit `src/cli/roots.ts` (the `index` action, to
compute `snapshotContentHash(model.body)` and run the aggregation with it **after R4's D13
short-circuit has made its decision and outside the build lock, on every `index` regardless of that
decision** — D16.1-D16.3 — and the `status` renderer to compute-without-writing);
create `source/cli/tests/unit/roots/health.test.ts`; create
`source/cli/tests/e2e/cli-roots-demotion.test.ts`.
**`health.ts` reads nothing itself (R5-I4).** `src/cli/roots.ts` enumerates the session logs with
T1's `listSessionLogs`, reads the ended ones with `readSessionEvents`, reads `telemetry.jsonl`, and
passes the folds plus `nowMs` in; `health.ts` returns `{demotions, sessionEvents, telemetry,
ledgerMarks}` and the command layer applies them — on `index` only (Step 5). The ended-session
predicate of Step 2a is therefore evaluated in `health.ts` over the `mtimeMs` values handed to it,
not by stat-ing anything: that is what keeps it unit-testable against an injected `nowMs` and
what makes criterion 4d a value assertion rather than a clock race.
**`nowMs` is this pass's only clock and it drives BOTH time-dependent outputs** — the
ended-session predicate *and* the `YYYY-MM-DD` `date` stamped on the ledger marks it returns. D15
fixes the format and says the command layer supplies the *reading*; that holds on both paths, since
`nowMs` is a parameter here exactly as `nowIso` is a `VerdictInput` field on the check path
(R5-I4). Deriving the date from anything else inside `health.ts` would reintroduce a wall-clock
read into a `roots-engine` module carrying `deterministic`, and would make criterion 4b(i) — the
one place the terminal marker's day-crossing effect is observable at all — unwritable.

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
- [ ] **Step 2: Cross-session closure — which sessions it touches, which arm each rule binds, and a
  close that cannot re-fire.**

  **(a) "Ended session", defined — because the pass is otherwise written over an undefined set and
  the only implementable reading of "every log under `.state/sessions/`" includes the LIVE one.**
  A session log is **ended** for this pass iff its file **mtime falls on a strictly earlier UTC
  calendar day** than the `nowMs` the caller injects. The command layer enumerates with T1's
  `listSessionLogs(stateDir) -> {sessionId, mtimeMs}[]` — one `readdir` plus one `stat` per log,
  creating nothing — and `health.ts` applies the predicate to the `mtimeMs` values it is handed, so
  the engine still touches no filesystem and no clock (R5-I4). Three reasons this predicate and not another: **mtime is already
  this plan's liveness signal** (`pruneSessions` is mtime-based, T6 Step 5), so no second notion of
  session age enters the codebase; **the UTC day is already this plan's coarsest clock granularity**
  — D12's last-resort session identity is day-keyed and §18.3's ledger dedupe is
  `(stableId, surface, date)` — so R5-I7's "invent no constant" holds without a new config key; and
  a **terminal-event** predicate (close when a `'stop'` event exists) was rejected because R5 installs
  no hooks at all (that is R8), so most real session logs would carry no `'stop'` and the pass would
  never run.
  **What it costs, stated rather than discovered.** A session that spans UTC midnight and is *still
  live* can be closed early: its open interventions are sampled and terminally closed while the agent
  might still have fixed them. The bound on that harm is exactly one sample per intervention per
  outcome (the store key, D13a(c)) plus the terminal marker below, it requires the warning to fall
  before midnight and the fix after it, and it requires
  the agent to run `index` in between. The alternative — never closing anything that might be live —
  loses **every** sample from the dominant path, which §18.2 says is the whole reason the `ignored`
  branch exists. **A log whose mtime is on the current UTC day is skipped entirely: no sample, no
  ledger mark, and no terminal event written into it.**
  **One consequence worth naming, because it does half of the terminal marker's job for free:** the
  pass *writes into* the log it closes, so that log's mtime becomes "now" and it is no longer ended.
  Every further `index` **on the same UTC day** therefore skips it whatever the marker does. The
  marker is what governs the day **after** — which is exactly why criterion 4b's same-day leg cannot
  kill MR-32b on its own and needs the fix-then-re-index legs beside it.

  For each ended log the aggregation folds with `foldSession(events, sessionId)` —
  **supplying the id from the log's own file name** (`sessionLogPath`'s inverse), since no event
  carries one (T6 Step 1) — and closes the interventions that session left open, per §18.2
  (`v6-spec.md:681`): current index shows the pair at `expected` ⇒ a `complied` sample **and** the
  §18.3 mark (same dedupe); the pair exists and still deviates ⇒ an `ignored` sample; the scope is
  gone ⇒ the intervention is dropped, with no event and no sample. **Each sample repeats the
  intervention's own `severity` and `deltaBits` off the folded `OpenIntervention`** (D13a(a)'s "as
  emitted" pair), so this pass computes no Δ of its own and needs no `counts`/`alphabet` beyond what
  Step 1's forward resolution already reads.

  **(b) ONE rule, not two — and the rule that used to be rule 1 is deleted, with its reason
  recorded.** Rounds 6 and 7 gave this pass a second rule: skip (or, after round 7, suppress the
  `ignored` sample of) any open intervention whose fold already set `ignoredRecordedInSession`.
  **D13a(c) retires it.** The pass supplies the same `sessionId` (from the log's file name) that T7
  used, and the same `(stableId, surface)`, and `observedAfter` is the label `'ignored'` — so the
  pass's row and T7's row are **key-identical** and `appendTelemetry` collapses them whatever the
  pass does. The rule could not change a byte on any store, in any fixture, and MR-32c could
  therefore never fail. **Two rules the plan cannot keep are: an unkillable one (R5-I11) and one
  whose deletion is invisible.** It is deleted rather than kept as defense-in-depth because
  keeping it also forced the arm-scoping subtlety of round 7's M5, which is a live way to lose the
  `complied` branch and its ledger mark for no benefit at all. `ignoredRecordedInSession` remains on
  `OpenIntervention` — T7 needs it for the session-log bound (T7 Step 2, criterion 2) — and this
  pass simply does not read it.

  So the pass has exactly one rule of its own:
  1. **It appends a terminal `'closed'` event with `scope: 'cross-session'`** into that ended
     session's own log, through `Intents.sessionEvents` like every other write (D1/D14), and the fold
     treats a cross-session close as **terminal for both outcomes** — this pass has already recorded
     that intervention's outcome, and the session that owned it is over, so no later sighting can
     add anything to it. (Note what "terminal" does *not* mean: the pass itself is exactly where an
     ended session's `complied` gets recorded. Terminal describes the record after this pass has run,
     not before it — and T7's in-session `ignored`, which leaves the record open, is not a close at
     all.) Without a representable terminal
     marker the pass has no way to record that it already ran: `demotions.json` is content-addressed
     output, not a cursor, and D16.2 runs the aggregation **unconditionally on every `index`**, so
     each later run would re-fold the same un-pruned log (`sessions.pruneDays` = 7) and re-fire the
     same close.

     **What the marker prevents — the third derivation of this, and the first one written against
     §9.10's actual field domain.** Given D13a(c), the marker's scope is much narrower than rounds 6
     and 7 both claimed, and the narrowness is the honest answer rather than a weakening:
     - **NOT the `ignored` re-fire.** Every re-fire writes `(sessionId, stableId, surface,
       'ignored')` — the same key — so the store collapses them. This holds whether the tree is
       unchanged, whether the deviating value changes, and however many times `index` runs. Both the
       round-6 derivation ("eight runs over an unchanged tree") and the round-7 replacement ("eight
       runs across eight changed values") were arithmetically false, and each shipped a mutation
       test that could not fail. **There is no `ignored` over-sampling for this marker to prevent.**
     - **YES: a `complied` row (and its ledger mark) for an intervention this pass already sampled
       `ignored`.** Day N: the pass banks `ignored` and closes. Day N+k: the scope has been brought
       to `expected` by someone. Un-terminated, the pass re-opens the same intervention and banks
       `observedAfter: 'complied'` — a **different key**, so a real second row, plus a §18.3 ledger
       mark under a **new** `date`, which the ledger's own `(stableId, surface, date)` dedupe
       (`weights.ts:267-269`) does not catch. That is a genuine over-count: nobody was warned in the
       later session, so there is no intervention for the fix to have complied with, and the mark
       would discount evidence roots did not shape. **This is the marker's whole correctness
       justification, and criterion 4b is built directly on it** — as an assertion about a row and a
       mark that are *present or absent*, never about a dedupe outcome, which is what makes it
       executable without a clock (M2).
     - **AND: the work.** Without it every `index` re-folds every un-pruned log for up to seven
       days. A cost, named as a cost and not dressed as a correctness claim.

  **One loss this design accepts, stated rather than discovered:** `sessions.pruneDays` is 7 and
  mtime-based, so a session log pruned before any `index` ran takes its open interventions with it —
  their samples are never banked. That is a *lost* sample, and §18.2 fixes the acceptable direction
  for exactly this ("a lost demotion resurrects a FACT, never falsely silences one",
  `v6-spec.md:683`). It is the same direction D16.5 chose for a stale `demotions.json`, and the
  opposite of the direction the un-terminated pass fails in — which is why the terminal marker is a
  mechanism and the prune window is left alone. **The window is comfortable, not tight:** a log
  becomes closable the UTC day after its last write and is pruned at 7 days, so any `index` inside
  that six-day span banks its samples. The `ignored` branch is load-bearing and the code says why: without
  it the dominant real path — agent warned, moves on, session ends — never enters the denominator,
  compliance is biased high, and precisely the conventions agents ignore never demote.
- [ ] **Step 3: The bound.** Demote when `WilsonLB95(compliance) < health.minCompliance` (0.3) with
  ≥ `health.minSamples` (8) resolved. z = 1.96 two-sided, fixed, not configurable.
- [ ] **Step 4: The stamp, computed by the caller.** `demotions.json` carries the snapshot content
  hash, and `health.ts` receives it as a **parameter** — `src/cli/roots.ts` calls T1's
  `snapshotContentHash(model.body)` and passes the string in. `health.ts` may not import it:
  `stores.ts` is `roots-store`, which is absent from `roots-engine`'s `calls:` list
  (`yg-architecture.yaml:759`), and this is instance (iii) of D1's composition seam. The
  check path ignores a mismatched stamp, which resurrects a demoted fact rather than silencing a
  healthy one (§18.2's stated direction).
- [ ] **Step 5: Where it runs (D16), precisely.** Inside `yg roots index`, **after** R4's D13 no-op
  short-circuit has made its decision and regardless of what it decided — because telemetry moves
  none of the eight inputs that short-circuit compares, and an aggregation that only ran on a
  mining run would never fire on the quiet repositories demotion exists for. It takes **no build
  lock** (D16.3) and it **writes only when the computed content differs from what is on disk, and
  creates neither a file nor the `.state/` directory when there is nothing to aggregate** (D16.4) —
  so a repository with no telemetry leaves the whole `.yggdrasil/roots/` tree, dot-directories
  included, exactly as R4's no-op assertion snapshots it.
  At `status`: computed for display, **nothing written** — and specifically, `health.ts` *returns*
  **all three** of the cross-session pass's write sets as intents (D1's seam) — the terminal
  `'closed'` session events, the telemetry samples and the ledger marks — and only `index` applies
  them. The ledger half is the R5-I8 argument: §18.2's cross-session `complied` branch appends a
  **committed** mark and a read surface may not. The session-event half is the one an earlier draft
  named only implicitly and it is the more likely accident: applying it from `status` would
  terminally close interventions that `index` was going to close, so a `yg roots status` between two
  builds would silently delete compliance evidence. All three ride the one seam precisely so there is
  no per-set decision to get wrong (T8 criterion 6 asserts the whole `.state/` tree, not just
  `demotions.json`). Telemetry compaction (`health.telemetryRetentionDays`) runs beside the aggregation,
  under the same write-only-on-change rule. **The count `status` computes here is not rendered until
  T10** — this task proves the computation and the absence of writes; T10 adds the line.
- [ ] **Step 6: Graph ritual + report.**

**Acceptance criteria — by value.**
1. **Wilson, hand-derived, over pools the product can actually produce.** Every row names the state
   that produces it, per D13a(d): a resolved sample accrues **one per (session, intervention,
   outcome)**, so `n = 10` means ten sessions and `n = 8` means eight — never ten checks or eight
   `index` runs, both of which the store key collapses to one.
   **At n = 10 (ten sessions):** 2 complied / 8 ignored (p̂ = 0.2) ⇒ `WilsonLB95` **0.0567** ⇒
   demoted; 5/5 (p̂ = 0.5) ⇒ **0.2366** ⇒ still demoted; 7/3 (p̂ = 0.7) ⇒ **0.3968** ⇒ **not**
   demoted.
   **At n = 8 — `health.minSamples` exactly, the smallest demoting pool and the one both producible
   paths of D13a(d) reach:** 0/8 (p̂ = 0) ⇒ **0** exactly — the `z·√(z²/4n²)` term equals `z²/2n`
   and the numerator vanishes — ⇒ demoted; 4/4 (p̂ = 0.5) ⇒ **0.2152** ⇒ demoted; 5/3 (p̂ = 0.625) ⇒
   **0.3057** ⇒ **not** demoted; 6/2 (p̂ = 0.75) ⇒ **0.4093** ⇒ not demoted.
   Each number appears in a comment beside its inputs. **The 5/3 row is quoted to four places
   because it clears 0.3 by 0.0057** — any drift in z, in the formula's shape, or in rounding fails
   it — and the 4/4 row is the one that separates the lower bound from the point estimate (p̂ = 0.5
   is comfortably above 0.3, so a point-estimate mutant keeps a fact the rule demotes). The n = 8
   rows are the ones T8's e2e can drive end to end; the n = 10 rows are unit-level pool arithmetic
   and are labelled as such.
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
4b. **Idempotence of the pass itself, over the two keys the stores' own dedupe does NOT cover.**
   **Every leg of this criterion runs the aggregation twice, and every one of them must carry call
   1's returned session events into call 2's input** — through the command layer in the two e2e legs
   (which apply for real, so it happens by itself) and **explicitly in the unit leg, which applies
   nothing**. That is the whole discriminating step and it is stated once, here, for all three legs.
   Running the aggregation **twice** over the same ended-session log leaves the pool count,
   `telemetry.jsonl` and `ledger.jsonl` **byte-identical** after the second run, over an unchanged
   tree — the same-day leg, which observes D16.2's unconditional-aggregation path and the fact that
   the pass's own write moves the log's mtime out of the ended set (Step 2a), so run 2 skips the log
   before the marker is even consulted. **The session log is
   the one file that legitimately changes** — the first run appends the terminal `'closed'` event —
   so it is asserted separately: byte-identical between the second run and the first, and exactly
   **one** `scope: 'cross-session'` event in it after both.
   **This leg alone does not kill MR-32b, and the criterion says so rather than implying otherwise.**
   The marker's correctness effect is a `complied` row that does or does not appear on a **later**
   day (Step 2b), and no clock override exists in this CLI to move a spawned run's day: `nowMs` is a
   function parameter, D18 rules out an environment variable and D23 makes a new config key a STOP.
   So the effect is asserted at the two levels where it genuinely is observable:
   **(i) Unit level, in `health.test.ts`** — `health.ts` takes `nowMs` and derives from it both the
   ended-session predicate **and** the `date` it stamps on the ledger marks it returns (that is why
   it takes the clock at all, R5-I4). Call the aggregation twice with `nowMs`
   on two different UTC days, the scope deviating on the first call and at `expected` on the second:
   with the marker the second call returns **no** telemetry sample and **no** ledger mark; without
   it, one of each. Pure values, no filesystem, no wall clock.
   **The step that makes this discriminate, and without which it cannot:
   call 2's session-event input is call 1's input PLUS the terminal `'closed'` event call 1
   returned.** `health.ts` applies nothing — it is pure, and the terminal event is a *returned
   value*, not a mutation of any fixture (this task's own Files block). So a test that fed both
   calls the *same* events would give the correct implementation and the mutant identical output —
   call 2's fold would never see a marker in either — and MR-32b would lose its only unit-level
   killer. **The unit test performs the apply the command layer performs in production**, and
   nothing else about call 2's input differs from call 1's, so the marker is the only variable.
   (The mutant leg has nothing to feed forward, which *is* the difference: it returned no terminal
   event.)
   **(ii) E2E level, in `cli-roots-demotion.test.ts`, with no clock at all** — the observable is
   *presence versus absence*, not a dedupe outcome, so the day never has to move. Two legs, each
   driving the built binary: seed an ended session log (mtime back-dated with `utimes`, the same
   setup criterion 4d already needs) holding one open intervention on a deviating scope; run
   `yg roots index` (both legs bank the `ignored`); back-date the log again; **fix the scope**; run
   `yg roots index` a second time. **The marker leg writes no `complied` row and no ledger mark; the
   mutant leg writes one of each.** Both runs land on the same UTC day and the ledger is empty
   beforehand, so the `(stableId, surface, date)` dedupe is not in play in either leg — which is
   exactly what makes the assertion executable.
4c. **The cross-session pass banks one sample per intervention, and the complied arm is never
   suppressed.** Three cases, each stated against D13a's lifecycle table.
   **(i) The dominant path.** A scope warned and never re-checked, whose session then ends: the pass
   banks its one `ignored` (transition 4) and appends the terminal event. `telemetry.jsonl` holds
   exactly one `ignored` for that pair.
   **(ii) The cross-producer path.** A scope warned and re-checked while still deviating (T7 banks
   one `ignored`, transition 2, record stays open), whose session then ends: `telemetry.jsonl` still
   holds exactly **one** `ignored` for that pair after the pass runs. **The plan is explicit that
   this is the store key's doing and not a rule's** (D13a(c)) — the pass's row is key-identical to
   T7's — so this case is a regression guard on the key, not a killer for any pass-side logic, and
   no MR claims otherwise.
   **(iii) The arm that must flow.** A scope warned, re-checked while still deviating (one `ignored`
   banked), whose session then ends and whose scope now sits at `expected` ⇒ `telemetry.jsonl` holds
   exactly one `ignored` **and** exactly one `complied` for that pair, and `ledger.jsonl` gains
   exactly **one** mark. Losing the mark is the failure that matters — the §18.3 regulator is what
   stops roots-shaped code counting as its own evidence — and any rule that skips a whole
   intervention loses it silently, which is why no such rule exists (Step 2b).
4d. **A live session is not closed.** With one session log written **during** the `index` run (its
   mtime on the current UTC day) carrying an open intervention, and one whose mtime is on an earlier
   UTC day carrying an equivalent one: after the run, the earlier log has exactly one
   `scope: 'cross-session'` event and its intervention has contributed one sample; the current-day
   log is **byte-identical**, contributes **no** sample and gains **no** event. Asserted at unit
   level with an injected `nowMs` (pinning the predicate, not the wall clock — R5-I16) and end to
   end by back-dating the older log's mtime with `utimes`, which needs no clock control because the
   *other* log is genuinely current. Without this
   criterion the pass has no defined domain at all, and the shape of the defect it prevents is the
   worst one available: an agent mid-session has its open warning terminally closed as `ignored`,
   and the fix it makes a minute later can never be recorded as compliance.
5. A `demotions.json` whose stamp does not match the current snapshot is ignored: the fact speaks.
6. `status` **computes** the same demotion count `index` would write — asserted through
   `health.ts`'s returned value, not through rendered output, because **the rendered line is T10's**
   (D22) and T10 criterion 1 requires a no-demotion repository to still print the a761dda bytes — and
   **writes nothing**: asserted on a repository
   that has open cross-session interventions whose scopes now sit at `expected` (i.e. the case that
   would otherwise append a mark from a read surface) **and whose session logs are all ENDED** (so
   the cross-session pass would fire if it were allowed to). The assertion is **the whole
   `.yggdrasil/roots/.state/` tree plus the committed `ledger.jsonl`** — every path with its mtime
   and size, `readdirSync(recursive)` so dot-directories count, the shape
   `cli-roots-basic.test.ts:46-52` already uses — byte-identical across the `status` run. Naming
   only `demotions.json` and `ledger.jsonl` would miss the write this pass is most likely to make by
   accident: the **terminal `'closed'` event appended into a session log**, which is a session-state
   mutation performed by a read surface and would leave `demotions.json` untouched while destroying
   the very intervention `index` was going to close.
7. **Demotion happens on an otherwise-unchanged tree (B2).** With HEAD, config, seeds, ledger,
   bindings and the dirty set all unchanged — so `yg roots index` takes the no-op short-circuit and
   writes neither `model.json` nor anything under `.cache/` — a repository carrying ≥ 8 resolved
   ignored samples still ends that run with the fact demoted in `demotions.json`. Asserted through
   the built binary, and paired with its converse, asserted the way R4 asserts it: the same run on a
   repository with **no** telemetry leaves the **whole `.yggdrasil/roots/` tree snapshot** unchanged
   — every path with its mtime and size, `readdirSync(recursive)` so dot-directories count, the
   shape `cli-roots-basic.test.ts:46-52` already uses. Asserting only "`demotions.json` is absent"
   would pass while a stray `mkdir` of `.state/` broke the landed no-op test (D16.4).

**E2E coverage.** `cli-roots-demotion.test.ts`, driving the built binary, in three legs whose
sample accrual is exactly D13a(d)'s — **the "eight" is eight sessions, and the test is written so
that it cannot be mistaken for eight anything else**.

**The re-plant mechanic, stated once here because one leg is impossible without it and the other is
wrong with it.** An intervention opens only when a session's **first** check sees a deviating scope.
So in any leg where a session *fixes* the scope, every later session's first check sees a conforming
scope, emits no warning, opens no intervention and contributes no sample. A leg with fixing sessions
must therefore **(re-)plant the deviation before each session**, with the **same** deviating value
every time — same value because it must not touch a surface that feeds `stableId`
(`relPath ∥ kind ∥ qualifiedName ∥ arity`, `extract.ts:627-628`; D13a(c)'s fixture rule), so all
eight sessions' interventions share one identity and pool into one `factKey`. A leg where the scope
is never fixed needs **no** re-plant and must not have one.
- **The demotion leg (path S1, no filesystem-time manipulation, NO re-plant).** Plant a deviation
  once, then for each
  of **8 distinct `--session` ids**: `yg roots check <file>` (the WARN, opening the intervention)
  and `yg roots check <file>` again with the scope still deviating (transition 2, banking that
  session's one `ignored`). The scope is never fixed, so every session's first check still warns and
  the single plant is enough. Assert `telemetry.jsonl` holds exactly 8 `observedAfter: 'ignored'`
  rows — one per session, and the assertion is per-`sessionId` so a regression that collapsed them
  is visible as a count, not as a pass. Then `yg roots index`, then `yg roots check` once more and
  assert **silence** for that fact while a different fact still speaks. `WilsonLB95(0/8) = 0`,
  criterion 1's first n = 8 row, reached through the product. No mark is ever written here, so
  eligibility is untouched.
- **The non-demotion control (RE-PLANT BEFORE EACH SESSION).** Eight distinct `--session` ids;
  before **each** one the deviation is re-planted at the same scope with the same value, per the
  mechanic above. Five sessions then fix the scope before their second check (transition 3) and
  three leave it deviating (transition 2) ⇒ **5 complied / 3 ignored, n = 8,
  `WilsonLB95 = 0.3057 > 0.3`** — and the fact **still speaks** after `index`.
  **The re-plant is not bookkeeping, and the leg is worthless without it:** executed without one,
  the first fixing session leaves the scope conforming, every later session contributes nothing, and
  the pool is **one** resolved row. The assertion "still speaks" then passes — but on the
  `minSamples` floor (n = 1 < 8), not on the Wilson bound, which is exactly the passing-for-the-wrong-
  reason failure this control exists to prevent, reproduced inside the control. D13a(d) rules that
  out in its own words: an acceptance number that depends on an unreachable state is unsatisfiable
  and must be deleted, not weakened.
  **Two consequences of the five `complied` closures, derived here so the leg is not debugged
  twice.** (i) Their five ledger marks collapse to **one** line — §18.3 dedupes on
  `(stableId, surface, date)` and a single test day is one `date` (T7 criterion 5's own rule), so the
  leg asserts one mark, not five. (ii) That one mark is **unreleased**, so at the next `index` its
  scope's conforming instance is echo-shaped and drops out of the §9.4c survived-display population;
  the fixture's fact therefore needs enough survived conformers to stay at or above
  `mdl.minInstancesRaw` (5, `config-parser.ts:78`) **after losing one**, or the fact stops being
  hook-eligible and the leg fails silent for a third, unrelated reason that looks exactly like
  demotion.
- **The cross-session leg (path S2)** is criterion 4b(ii)'s two legs, which reuse this file's
  fixture and add `utimes` back-dating. It plants once and never fixes before the final step, so it
  needs no re-plant either; its one "fix the scope" step is *between* the two `index` runs, after all
  sampling is done.
This is the product promise "a convention agents keep ignoring stops interrupting them", proven the
only way it can be: from the outside.

**Test obligations / mutation round-trips.**
- **MR-31 (expected-flip filter):** remove the filter ⇒ criterion 3 fails.
- **MR-32 (cross-session `ignored` branch):** record only `complied` on the cross-session pass ⇒
  criterion 4 fails and nothing ever demotes in the dominant real path.
- **MR-32b (the terminal marker):** stop writing the `scope: 'cross-session'` close ⇒ criterion 4b's
  **fix-then-re-index** legs fail in both places they are asserted: at unit level the second
  aggregation returns a `complied` sample and a ledger mark where it must return neither — **which
  is observable only because 4b feeds call 1's returned events into call 2**; a version of that leg
  that fed both calls the same input would let this mutant live — and end to
  end the second `yg roots index` appends a `complied` row to `telemetry.jsonl` and a mark to
  `ledger.jsonl` where the marker leg appends nothing. **Presence versus absence, in an empty
  ledger — no dedupe outcome and no clock override is involved**, which is what makes this MR
  live where its two predecessors were not. It does **not** fail on any `ignored` re-fire, and the
  plan says so (Step 2b) rather than promising a failure the store key forbids.
- **Retired this round — MR-32c and MR-32d — and the deletion is itself the finding.** MR-32c ("let the pass sample
  every open intervention") and MR-32d ("widen the suppression to the whole intervention") both
  mutated a rule that no longer exists: the `ignoredRecordedInSession` suppression in the
  cross-session pass, retired by Step 2b because `appendTelemetry`'s key already collapses the row
  it was meant to prevent (D13a(c)). Neither mutation could change a byte in any store — MR-32c
  because the two rows are key-identical, MR-32d because with no suppression there is no arm to
  widen. They are recorded here as removed rather than silently dropped, since R5-I11 counts MRs and
  a reader of an earlier round will look for them. Criterion 4c(ii) keeps the *observation* they
  were reaching for, as a regression guard on the key.
- **MR-32e (the ended-session predicate):** treat every session log as ended ⇒ criterion 4d fails —
  the live log is mutated and its intervention sampled. Conversely, treat none as ended (require a
  `'stop'` event, which R5 never writes) ⇒ criteria 4, 4b, 4c and 4d's first half all fail with an
  empty pool, which is the failure mode of an over-cautious predicate.
- **MR-32f (`status` is a read surface):** let `status` apply the intents `health.ts` returns
  instead of only computing them ⇒ criterion 6 fails on the `.state/` tree — the terminal
  `'closed'` events appear in the session logs — **and** on `ledger.jsonl`. A criterion that watched
  only `demotions.json` would pass this mutant, which is why criterion 6 watches the tree.
- **MR-33 (stamp check):** honor a stale stamp ⇒ criterion 5 fails and a stale demotion silences a
  live fact.
- **MR-34 (point estimate vs lower bound):** demote on the **point estimate** instead of the Wilson
  lower bound ⇒ **criterion 1's 5/10 and 4/4 rows both fail**, and no new case is needed to see
  either: p̂ = 0.5 is ≥ `minCompliance` 0.3 so the mutant does not demote, while
  `WilsonLB95(5/10) = 0.2366` and `WilsonLB95(4/4 of 8) = 0.2152` are both < 0.3 so the rule does.
  (The 2/10, 7/10, 0/8, 5/3 and 6/2 rows agree under both readings, which is exactly why the two
  p̂ = 0.5 rows are in the criterion.) **The 4/4 row is the one that matters after round 8**, because
  it sits at the reachable n = 8 rather than at a pool size only a unit test can build. The lower
  bound is what makes demotion require a sample large enough to be sure, not merely a low ratio.
- **MR-34d (the control leg's re-plant):** drop the per-session re-plant from the non-demotion
  control ⇒ the leg's own **pool-shape assertion** fails — it asserts `telemetry.jsonl` holds
  **8 resolved rows for that pair, 5 `complied` and 3 `ignored`**, and without the re-plant it holds
  one. Named as an MR because the *outcome* assertion ("the fact still speaks") passes either way;
  only the pool-shape assertion separates a leg that proves `WilsonLB95(5/8) = 0.3057 > 0.3` from a
  leg that proves `n = 1 < 8`. This is the one mutation that turns a control into a tautology.
- **MR-34c (the sample floor):** demote at `n ≥ 1` instead of `n ≥ health.minSamples` (8) ⇒
  criterion 2's n = 7 case fails. Named because D13a(d) makes the floor the *only* thing standing
  between one unlucky session and a demotion, now that the store key has removed every other way n
  could grow.
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
completeness paragraph (`:625`) and its directional confidence (`:622`), Appendix A's T5
(`:791-796`), Appendix G.4 (`:1020`); the R4 plan's own assignment of the sweep to R5
(`2026-08-20-increment-3-r4-history.md:2321-2322`); the landed row shape
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
  **Where the cap is applied, and the one consequence of applying it there.** §12.4's bound is on
  *evaluation*, and that is what this step caps: the sweep evaluates at most 5. D14, by contrast,
  caps the `'checked'` event's payload at the same 5 **changed paths it took up in that sweep** —
  its *participation* set, T3 Step 8 filter 1's output, capped by path order. The two sets are
  capped at the same number but are not the same set: participation is pre-`forParsing`, so a
  sweep whose 5 taken-up paths include a test file or an excluded path **evaluates fewer than 5**.
  That is correct and intended — the test file is legitimately in `writtenFiles` for completeness
  (T3 Step 8's fork) and legitimately unevaluated — but it is stated here because "evaluate at most
  5" and "record 5" read as the same sentence and are not, and an implementer reconciling them by
  capping evaluation *after* gate 0 would quietly widen §12.4's bound. Cap participation first,
  then gate; never re-fill the evaluation set to 5 from paths the cap already excluded.
- [ ] **Step 3: Stop.** Honor `stop_hook_active` (T5). Run the deferred sweep summary **iff**
  `floodSkipped` was set, evaluating the session diff against the **first-sweep** `fileState` once
  and reporting at most `budgets.maxMessagesPerResponse` findings; with `fileState` unset (an
  Edit-only session) it is a no-op.
- [ ] **Step 4: Completeness (D20), over the row shape T2 actually persists.** Gated by
  `hooks.claudeCode.stopCompleteness` and `completeness.mode` (`stop-feedback-once`). D = files
  written this session — **`foldSession`'s `writtenFiles`, unioned from the `'checked'` events T6
  Step 1b lands**, not a derivation from `warned` events or `fileState`. For each written file `f`
  and each committed
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
  emit **Appendix A's T5** listing at most `completeness.maxItems` (5) partners, ordered by descending
  confidence then ascending path, each with its `{sup}/{commits}` evidence — the same two numbers
  the gate used, so the message can never show evidence that does not justify it. Once per session.
- [ ] **Step 5: WARN-only, structurally.** Bash-path violations are WARN-only, so file *moves* are
  WARN-only (D21). Say it once, in the code and in the docs.
- [ ] **Step 6: Graph ritual + report — including `src/cli/roots-check.ts`'s prompt headroom**
  (`node scripts/prompt-headroom.mjs --file source/cli/src/cli/roots-check.ts`, against the
  ≈66 KB ceiling; crossing it is a **STOP**). This is
  the last task to touch that file, so its figure is the increment's final one.

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
5b. **A silently-checked file still counts.** A session whose only edit produced **no** message —
   the conforming, uninteresting case, and the majority one — still names that file's co-change
   partner at `stop`. This is the criterion that fails if `D` is ever derived from `warned` events
   instead of from the `'checked'` events, which is the derivation an implementer reaches for first.
5d. **A session whose only edit was a test file still gets its source partner named.** With the
   criterion-5 row and a session that edited `test/order.test.ts` **and nothing else**, the `stop`
   run names `src/order.ts` with evidence `9/12`. This is the case that is unreachable if `'checked'`
   is built from the evaluation set instead of the participation set (T3 Step 8's fork), and it is
   the direction the spec's own measured signal exhibits (`v6-spec.md:623`:
   `routing.py ↔ tests/test_routing.py`, support 54) and the landed fixture carries
   (`history-cochange.test.ts:367`: `{a:'src/new.ts', b:'test/x.spec.ts'}`). Driven through the
   **e2e**, not only as a unit test, so "reachable through the product" is asserted rather than
   assumed.
5c. **Completeness has live data on the Bash flow (D14/M2).** A session whose files were changed
   outside the Edit tool — seed sweep, edits, second sweep — has those swept paths in
   `foldSession`'s `writtenFiles`, so the `stop` run names their co-change partners. The seed sweep
   contributes **nothing** to `writtenFiles` (it evaluates nothing), and the second sweep contributes
   exactly the ≤ `bashSweepMaxFiles` changed paths it took up — its **participation** set, so a
   swept test file is in `writtenFiles` even though it is never evaluated (T3 Step 8's fork), which
   is what makes criterion 5d reachable on the Bash channel too — and not the whole seeded listing.
6. `stop` on a session with no written files emits nothing — which after 5c means a session whose
   only sweep was the silent seed, not merely a session that printed nothing.

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
- **MR-37e (participation vs evaluation):** build the `'checked'` payload from the **evaluation**
  set (post-`forParsing`) instead of the participation set ⇒ criterion 5d fails — `writtenFiles` is
  test-free, `D` never contains a test file, and the test→source direction goes permanently silent
  while every other completeness criterion still passes.
- **MR-37d (`'sweep'` does not replace `'checked'`):** make the bash channel append `'sweep'` alone
  ⇒ criterion 5c fails with an empty `writtenFiles` and a silent `stop`, which is the defect in its
  production shape: completeness dead on the entire Bash flow while every unit test still passes.

**NON-goals.** No Bash command parsing (D21). No pre-tool move blocking (out of scope by decision).

---

## Task 10 — `status`: modulators, withheld conventions, and the agentShare alarm

**Scope.** The three additions of D22 to the existing `status` renderer, **plus D25's one-line
change to the scaffold notice** — which is here because it is the increment's only other edit to
`src/cli/roots.ts`'s user-facing text, and because a decision with no owning task does not get
built (round 8's M4: D25 appeared in the decisions block, a carry-in and an open question, and in no
task's Files, Steps, criteria or MRs). Nothing else.

**Authorities.** Spec §3.3's I2b ("`status` lists every active modulator", `v6-spec.md:81` — quoted
as the text R5-I3 declares a **reasoned divergence** from, not as this task's rule: Step 1 lists
every *repository-scoped* modulator and deliberately refuses the two session-scoped ones),
§9.4c.4's withheld explanation (`:409`), §18.4 and Appendix A's T7 (`:687`, `:803-806`), §19's
`status` row (`:697`); design §3's `status` row (`integration-design.md:84`).

**Files.** Edit `source/cli/src/cli/roots.ts` — `renderRootsStatusInner` (Steps 1-4) **and
`ROOTS_SCAFFOLD_MESSAGE` / its `index`-action call site (`:128-129`, **Step 6** / D25)**; create
`source/cli/tests/unit/cli/roots-status-modulators.test.ts` (**new sibling** — the existing status
tests stay as they are); create `source/cli/tests/e2e/cli-roots-status-speech.test.ts`; extend
`source/cli/tests/e2e/cli-roots-basic.test.ts` (the scaffold-notice assertions it already owns at
`:209`, `:212`, `:237`).

**Steps.**
- [ ] **Step 1: Active modulators**, one line each, in plain terms: how many conventions are locally
  quieted, and whether the index is behind the current commit. **The two sweep modulators —
  `seedTruncated` and `floodSkipped` — are deliberately NOT here.** They are *session*-scoped:
  `status` takes no `--session`, runs from a different process tree than the hooks do, and D12's
  identity ladder lives in `roots-check.ts`, so `status` has no principled way to say *whose*
  session was truncated — picking, say, the most-recently-modified session log would report a
  stranger's state as the reader's. They surface where they apply: in the session, on the channel
  that set them (T9). Names, not mechanisms (R5-I14).
- [ ] **Step 2: The withheld line, over a predicate the snapshot can actually answer.**
  "K conventions withheld: no established instances yet" — §9.4c.4's J4 explanation. The draft's
  phrasing ("failed **only** the survived-display gate") is not computable from what is persisted:
  the snapshot carries a single `hookEligible` boolean, so re-deriving §9.4c's other three gates
  (fallback bucket, placement, fire-ability) would mean re-implementing them from `expected`,
  `surface`, `roleKey`, `counts` and `tau` inside a status renderer — a mining-stage
  re-implementation living in the wrong layer and free to drift. **So "withheld" is defined as what
  the persisted fields do answer: `hookEligible === false` and `nTotalRaw < mdl.minInstancesRaw`**
  — the display gate's own degenerate case, stated in §9.4c.4 in exactly those terms ("a fact whose
  survived population holds fewer than `minInstancesRaw` instances is not hook-eligible"). A fact
  held back by a different gate is not counted and not claimed. On a repository with no history that
  number is every accepted fact, because nothing survives — and saying so is the whole point: the
  product must explain its own silence. The wording R5 prints stays exactly the spec's.
- [ ] **Step 3: The alarm — Appendix A's T7 *content*, in design §11's vocabulary.** When
  `agentShare ≥ health.agentShareAlarm` (0.85), say so. **The spec's literal template may not ship
  as written, and the divergence is deliberate — flagged here exactly as T4 Step 3 flags
  "echo-shaped".** T7 reads
  `[roots] agentShare = {v} >= {alarm}: {pct}% of recent norm weight comes from unsurvived
  agent-authored code.` — which puts a **config key name** (`agentShare`) and a **configured
  threshold** (`{alarm}`) in stdout, and R5-I14 with design §11 (`:426`) confine thresholds, cell
  keys and enumerator ids to `yg roots explain` (R7's). It also collides with the maintainer's
  standing "don't expose internals in user-facing surfaces". R5 therefore renders T7's **second
  sentence and its measurement**, in product English: *"{pct}% of the convention weight from
  recently-added code comes from agent-written code that has not yet stood the test of time. Recent
  conventions largely reflect unreviewed agent output. Either review that code, or wait for it to
  settle."* The percentage stays — it is evidence, and design §11 keeps evidence numbers. The key
  name and the threshold do not. R7's `explain`/`report` may print the raw pair when it lands.
  **No exit code** — `--exit-code` is R7's, and until it exists the alarm is information.
- [ ] **Step 4: Everything status already prints stays byte-identical** where none of the three
  conditions holds. Pin that with a test, because a status regression is how a read surface starts
  lying.
- [ ] **Step 5: Extend the naming-table test's corpus to `status`.** T4 Step 6 owns the test and
  scopes its corpus to the rendered messages, because at T4 nothing else exists. This step adds the
  `status` renderer's output for **all three** new lines — the quieted-conventions line, the withheld
  line and the alarm — to that same test, so R5-I14's only killer covers the half of R5's stdout most
  likely to leak `_all`, `d[` or a raw partition id. Same forbidden-token list, one corpus.
- [ ] **Step 6: D25 — the scaffold notice names the file it modifies.** `ROOTS_SCAFFOLD_MESSAGE`
  becomes a function of the resolved config path and the notice prints that **absolute** path, so an
  agent whose inherited cwd resolved to a project it did not mean to touch can see which file is
  being written. One line, no design change, no new flag (the confirmation gate stays OQ2). Message
  shape per the CLI's what/why/next rule: what (a `roots:` block is missing from `<abs path>`), why
  (roots needs one and is adding it with defaults), next (nothing to do — it is already done, and
  the path is there to be checked). The existing sentence stays intact inside it, because
  `cli-roots-basic.test.ts` asserts `toContain('No \`roots:\` block found')` in three places
  (`:209`, `:212`, `:237`) and those assertions must keep passing unchanged — appending information
  is compatible, rewording is not.
- [ ] **Step 7: Graph ritual + report.**

**Acceptance criteria.**
1. A repository with no demotions, a fresh index, **no withheld conventions (K = 0)** and no alarm
   prints exactly what it printed at a761dda, byte for byte. The K = 0 clause is load-bearing and is
   not a way of dodging the case: Step 2's own text says a historyless repository withholds *every*
   accepted fact, so a fixture chosen without regard to K would print the withheld line and this
   criterion would contradict Step 2. The fixture is named in the test — a repository with history
   deep enough that its accepted facts have survived instances.
1b. The converse: a repository whose facts are all unsurvived prints the withheld line with K equal
   to the count of accepted facts, and still exits 0.
2. A repository with 3 demoted facts prints the quieted-conventions line with 3.
3. A snapshot whose `headSha` differs from the current HEAD prints the behind-the-commit modulator.
4. `agentShare = 0.9` prints the alarm; `0.84` does not; `null` prints neither the alarm nor a
   fabricated number. The printed text contains **no** `agentShare` token and **no** `0.85`, and the
   percentage it does print is `90%` — asserted by value, and covered by **this task's Step 5**,
   which extends T4's naming-table test to the `status` corpus.
5. Every state still exits **0**.
6. **The scaffold notice names its file (D25).** `yg roots index` in a project whose
   `yg-config.yaml` has no `roots:` block prints a notice containing the **absolute** path of that
   file, still contains the literal `No \`roots:\` block found`, still precedes the mining summary,
   and still exits 0 — asserted through the built binary, and `cli-roots-basic.test.ts`'s three
   existing scaffold assertions pass **unchanged**. The converse also holds: a project that already
   has a `roots:` block prints no notice and no path (that file's second scaffold test).

**Test obligations / mutation round-trips.** T10 is the only code task that reached round 4 without
this section; its three load-bearing rules had criteria and no killers, against R5-I11.
- **MR-38 (the naming table reaches `status`):** reintroduce `agentShare = {v} >= {alarm}` as the
  alarm's literal text ⇒ Step 5's extended token test fails on two tokens. Without Step 5 this
  mutation is invisible, which is exactly why the corpus extension is a step and not a note.
- **MR-39 (the withheld predicate):** count *every* ineligible fact instead of
  `hookEligible === false ∧ nTotalRaw < mdl.minInstancesRaw` ⇒ criterion 1b's K fails against the
  fixture's own accepted-fact count, and criterion 1's K = 0 repository starts printing the line.
- **MR-40 (the byte-identical baseline):** emit any of the three new lines unconditionally ⇒
  criterion 1 fails — the a761dda output is the baseline, and a `status` that always speaks is a
  `status` that has stopped reporting.
- **MR-41 (the scaffold notice's path):** print the config path **relative** to cwd instead of
  absolute ⇒ criterion 6 fails. The mutation is the defect D25 exists to prevent in its purest
  form: a relative path resolved against an inherited cwd is exactly the ambiguity the dogfood
  report recorded, and it reads as correct in every test whose cwd happens to be the project root —
  so criterion 6's fixture runs the binary from a **subdirectory** of the project.

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
- [ ] **Step 1: `docs/roots.md` becomes true.** **Four** statements are now false and must be
  rewritten, not patched — the fourth is the page's own section heading, `## The two commands`
  (`docs/roots.md:37`), which after T3 describes three: "What's not here yet → Speak up while you edit" (it does now), the `.state/` row
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
- [ ] **Step 6: Carry-in measurement (R4 debt).** **One** number, from R4's own T10 Step 5
  (`2026-08-20-increment-3-r4-history.md:3565-3574`): the fraction of distinct blob shas that appear
  only as a record's pre-image and never as any post-image. It is **report-only and conditional on
  Step 5 running at all**; if the dogfood measurement is not run it is reported as not-measured with
  that reason, never as absent. (Carry-in 5 carries no figure — see the Carry-ins section for why
  the obligation to restate one was deleted rather than deferred.)
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
- **Excluded by design, permanently.** No daemon or socket (`integration-design.md:374-381`), no
  `check --exit-code`, no `scaffold`, no recognizer pack (§10.2 ships none, and a named-fix layer
  must be earned from message-quality telemetry rather than designed ahead of it), no `EXT2GRAMMAR`
  of roots' own.

**One declared scope reduction, recorded here rather than left as a quiet divergence.** §19's
non-hook scope set — "scopes whose `body_hash` differs from HEAD" (`v6-spec.md:698`; the design does
not state a no-argument form at all, so this diverges from the spec alone) — is implemented as the
**file-level superset**: every scope in every
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
changelog rules forbid. **T1 Step 6's `--file` query mode gets no entry either, and that is a
decision rather than an omission:** `scripts/` holds this repo's own measurement instruments, not
shipped CLI surface (AGENTS.md's scripts-directory rule and `CONTRIBUTING.md`'s own section on it),
so no adopter's release notes are made truer by it. A maintainer reading `git log` finds it in the
T1 commit message, which is where a tooling change belongs.

Timing: the entry is **drafted at T2**, not T3. T2 is the first task whose commit changes what an
adopter sees — the `ROOTS_VERSION` bump makes every adopter's next `yg roots index` re-walk and
rewrite `model.json` instead of reporting "already current", which is exactly the behavior T11 Step 3
requires the docs to describe ("upgrading the CLI re-indexes once"). A one-sentence T2 draft covering
that, then **amended in place** at T3 (the first spoken message), at T5 (channels and the JSON
contract), T7 (the compliance loop and the
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
at; item 4 comes from the R4 **plan** itself (`:3565-3574`); **item 5 could not be located in
either source** and is carried as a constraint rather than as work — see its own entry. Each is decided
here or deliberately deferred with a reason. Where this section's paraphrase and a source document
disagree, **the source document wins** and the controller amends this section — T1's report
re-reads all three before T11 relies on any of them.

1. **Scaffold-on-missing-block (the dogfood entry of 2026-08-22).** **Decided — D25, built at T10
   Step 6 (criterion 6, MR-41).** R5 takes the
   half that needs no design change: the scaffold notice prints the **absolute path** of the config
   it is about to modify. The owning task is named here as well as in D25 because round 8 found this
   carry-in promising a dogfood-report update for a change no task was going to make. The confirmation gate stays an open question (OQ2) with a default of *do
   not add*, because the design authority mandates auto-scaffold and a prompt would break the
   non-interactive use every agent and CI makes of `index`. **The entry records a second sharp edge
   that R5 neither takes nor fixes, and naming it is what keeps this carry-in honest:** the scaffold
   rewrites `yg-config.yaml` through the CST-preserving `parseDocument`/`Document#set` path, which
   "may re-space a flow collection's brackets" (`src/cli/roots.ts:150-154`) — a cosmetic diff in a
   committed file the adopter did not ask for. Fixing that means changing how the YAML writer emits,
   not how roots calls it, so it is out of scope for R5. Recorded in the dogfood report as
   **partially** resolved at T11, with the formatting side-effect explicitly still open.
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
5. **"A measured figure stands in place of a window constant."** **Decided — carried as a
   constraint only, with its false attribution removed.** The figure does not exist in either
   source: searching the R4 plan (3880 lines) and the R4 ledger (181 lines) for "miss-set", "window
   constant" and "measured figure" returns no match, and the R4-plan line the draft attributed it to
   is the completeness-sweep sentence D20 already carries. **So there is nothing to restate, and
   T11 Step 6's obligation to restate it is deleted rather than deferred** — an unexecutable
   obligation is worse than an absent one. What R5 genuinely inherits is the *rule* the phrase
   encodes, and R5 satisfies it structurally rather than by measurement: **introduce no new window
   or threshold constant** — R5-I7 makes that mechanical, since every number R5 reads is a landed
   config key or a spec-declared fixed constant, and D23 enumerates them — and **never replace a
   measured quantity with a constant**, which is why D11 declares a superset rather than inventing a
   staleness window and why §11.3's caps are read from `budgets.*` rather than hard-coded. If the
   maintainer can point at the original item, the controller adds the figure and its citation;
   nothing in this increment waits on that.

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
  when a root-level marker exists (`partitions.ts:239-244`), and `finalId = key` for an own-floor
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
  (`check.mjs:36-48`).
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

### Round 2 — what the second adversarial review changed (2 blocking, 10 major, 16 minor)

Both blockers were **regressions introduced by round-1 fixes**, which is the failure mode the round
was asked to hunt; both are fixed structurally, and each fix was re-checked against the architecture
before being written.

**Blocking**

- **B1 — the round-1 M10 fix made `stores.ts` import `markKey` from `weights.ts`.** Verified:
  `markKey` is `roots-engine` (`weights.ts:267-269`), `stores.ts` is `roots-store`, and
  `roots-store`'s `calls:` is `[persistence-adapter, utility]` (`yg-architecture.yaml:775-778`) —
  `roots-engine` absent. That is B6's own failure mode re-created by B6's sibling fix. **Fixed by
  the caller-passes route:** `appendLedgerMarks(yggRoot, marks, keyOf)`, with `roots-check.ts` (the
  one type that legally reaches both) importing `markKey` and passing it. Rejected the
  move-to-`src/model/graph.ts` option on evidence: the `types` node's contract is "pure
  type/interface/enum declarations, no runtime behavior" (`:341`), so a *function* may not live
  there. There is now exactly one key format and nothing to keep in sync, so no divergence killer is
  needed; what is pinned instead is the wiring (T7 criterion 7: a mark this path writes is the mark
  R4's `releasedMarks` later releases).
- **B2 — T8's Files line still said "inside the build lock"** after round 1 rewrote D16 around it.
  Confirmed it is not a wording nit: `cli-roots-basic.test.ts:124-163` asserts both a whole-tree
  path+mtime+size snapshot and `.build.lock` absence on a no-op second index, so acquiring the lock
  fails a landed test by construction. Files line replaced with D16's own words, and grepped the
  whole document — three "build lock" mentions remain and all three now say the same thing.

**Major**

- **M1 — D16.4 did not cover creating `.state/`,** and the plan twice claimed R4's assertion is a
  byte comparison. It is a `readdirSync(recursive)` tree snapshot including dot-directories
  (`cli-roots-basic.test.ts:46-52`), and `.state/` exists after no R4 run — so one
  `mkdir(stateDir, {recursive:true})` fails it. D16.4 now forbids creating a directory or a file
  when there is nothing to aggregate (`mkdir` only inside the writer, after the content-differs
  check), the "byte for byte" claims are gone, and T8 criterion 7's converse asserts the whole-tree
  snapshot. D16.3's "identical answer" justification was also overstated (a concurrent hook can
  append between two reads) and is restated as §18.2's fail-open direction, which is what actually
  licenses taking no lock.
- **M2 — the intent record shapes had no legal home.** `SessionEvent`/`TelemetryRecord`/
  `DemotionsFile` now live in `src/model/graph.ts` beside `LedgerEntry` and `SeedEntry` — the exact
  pattern `stores.ts` already uses — reachable by `uses: [types]` from both layers, all three pure
  interfaces, and the authorization table's "they import no persistence adapter at all" stays true.
- **M3 — the increment's central seam was undefined.** `VerdictInput` is now declared field by
  field (with `EvaluatedScope`, `Intents` and the `openInterventions`/`demoted`/`decorativeRoles`
  slots that later tasks fill with data rather than with new parameters), and D1 states the
  three-stage pipeline once: `evaluate → applyBudgetsAndDedup → render`, with "messages" defined as
  `render`'s output so `{messages, intents}` and `{findings}` stop being two answers.
- **M4 — three of the four locality labels were unrenderable** from the declared interfaces.
  `VerdictFact` and `Finding` gain `partitionId` and `roleLabel`, and D9 names where the projection
  fills each from.
- **M5 — three named killers could not kill.** MR-6 was inert (with `couplingByFile` absent,
  centrality is 1, so the first and second tuple elements are equal) — new criterion 3c builds the
  `centrality = 0` case D4 actually argues from, and MR-6 points there. MR-26 was a no-op (a second
  slice after truncation) — restated as truncating *before* the budget stage's ordering, which the
  by-value assertion catches. MR-7 had no fixture (no golden carries a package marker) — criterion
  4b grows a nested-package case and MR-7 points at it. MR-19's criterion now runs over three files
  so "exactly one incident" is a claim about the run.
- **M6 — "T2's DENY text lands complete" was false three ways.** Verified against
  `v6-spec.md:774-782`: line 3 needs two calibration values (R6) and lines 5-6 advertise
  `seed add` (R8). R5 now renders lines 1, 2 and 4 only, the reach/precision pair is an unsupplied
  optional argument, and the claim is narrowed to "R6 need not restructure the renderer".
- **M7 — Appendix A's template names collide with this plan's task labels.** Every template
  reference is now written "Appendix A's T<n>", and T4 states the notation rule.
- **M8 — D3's "no migration file" contradicted design §10 without rebutting it.** Verified
  `integration-design.md:406` and `src/migrations/index.ts` (a `MIGRATIONS: Migration[]` list of
  graph-schema migrations). D3 now carries the rebuttal and is recorded as the increment's second
  design-vs-landed reconciliation, so the STOP condition does not fire on it.
- **M9 — carry-in 5 cited a figure that exists in neither source.** Confirmed by grepping both
  documents. The attribution is removed, T11 Step 6's obligation to restate the figure is **deleted**
  rather than deferred, and the carry-in is restated as the constraint it encodes (introduce no new
  window constant; never replace a measured quantity with one) — which R5 satisfies structurally
  through R5-I7 and D23.
- **M10 — the 900 ms deadline was specified as a watchdog,** which cannot preempt the synchronous
  work it exists to bound. Restated in §12.5's own terms: cooperative checks at the five named stage
  boundaries, the largest stage as the stated overshoot bound, the "never a hang" promise withdrawn,
  and a new T5 criterion 5b driving an injected slow stage.

**Minor** — all 16 applied. Thirteen anchors re-verified individually against the source, including
the four `partitions.ts` anchors of the round-1 B1 fix (`keyFor` `:239-244`, the sort `:237`,
`finalId` `:284`, the module-root rule `:291`) and three round-1 corrections that were themselves
wrong (design `:463` not `:464`, design `:466` not `:465`, R4 plan `:2321-2322` not `:2320-2321`).
**Arithmetic:** Δ rows 3 and 4 corrected from 3.7724 to **3.7726** — `log2(41/3) = 3.7725895`, and a
`toBeCloseTo(…, 4)` written against the old figure would have failed by 1.9e-4 against a 5e-5
threshold. Plus: the eight landed `rootsVersion: 1` assertion sites the bump breaks are named in T2
Step 1 (with the note that seven of them fail *misleadingly*, as a `status` regression); D5 decides
what a package root with zero mined scopes routes to and exports the matcher **once** so criterion 4
drives the real function; T10 criterion 1 gains its K = 0 clause and Step 2's withheld predicate is
rewritten over fields the snapshot actually carries; `getDirtyFiles`' `null`-vs-`[]` distinction is
restored and the false shallow-clone caveat removed; the CHANGELOG is drafted at T2, not T3; T7
criterion 6's "role-free" reasoning is replaced (§18.1 puts `factKey` *inside* the record, and
`factKey` contains the role key); T2's duplicate `mine.ts` bullet is merged.

**Not applied:** none. One remedy was chosen against the reviewer's first suggestion, with the
evidence stated inline (B1's `types`-node option).

### Round 3 — what the third adversarial review changed (1 blocking, 7 major, 21 minor)

**Blocking**

- **B1 — the increment's own node design closed a `structural-cycle`.** Verified from source:
  `checkNoCycles` (`src/core/checks/relations.ts:73-123`) walks `uses`/`calls`/`extends`/`implements`
  and emits `structural-cycle` at `severity: 'error'`; it is in `STRUCTURAL_CODES`
  (`check-codes.ts:28-36`), the set that fails `yg check` "regardless of verification state"; the
  validator calls it unconditionally (`validator.ts:192`). The two edges were both mandated by the
  plan: `mine.ts` (`cli/roots/engine`) **calls** `exemplars.ts`, which T2 mapped to
  `cli/roots/speech`; and `verdict.ts` (`cli/roots/speech`) **calls** `isBooleanSurface` from
  `mine-stages.ts` (`cli/roots/engine`) per D7. **Fixed by mapping `exemplars.ts` into
  `cli/roots/engine`** — it is index-time code that runs inside `mine()`, `routePartition` stays
  reachable from the command layer as `command → roots-engine`, and `roots/speech` is left with one
  outbound edge and no back edge. Beyond the one fix, the authorization section now carries a
  **full new-edge audit table** for every node this increment creates or edits (speech, engine,
  roots-state, roots-check, commands/roots, the e2e node), each row stating its outbound edges and
  whether any back edge exists — and **T1 Step 1 now runs `checkNoCycles`**, the one architecture
  check its list did not perform. Type-only imports were confirmed not to create edges
  (`relations/extractors/typescript.ts:180-181`), so the type-naming imports are free.

**Major**

- **M1 — D1's round-2 type-home decision never reached T1.** This was the third "decision rewritten,
  task not" failure, so it triggered the global sweep below. T1's interface block now points at
  `src/model/graph.ts` for all three record shapes instead of declaring them in the stores, and
  `src/model/graph.ts` is on T1's Files list with the note that the `types` node carries no
  `log_required`.
- **M2 — `snapshotContentHash` was the *third* instance of the engine↔store edge, unnamed.**
  `health.ts` is `roots-engine`; `stores.ts` is `roots-store`; the import would be refused only at
  `--approve --only-deterministic`. D1 now states the composition seam as **one rule with three
  instances** (`stateDir`, `keyOf`, `snapshotContentHash`), and T8 Step 4 + Files say the command
  layer computes and passes it.
- **M3 — completeness had no computable input.** Neither the four declared event kinds nor the fold
  carried "files written this session", and both natural workarounds are wrong in the same
  direction (from `warned` events ⇒ only files that produced a message; from `fileState` ⇒
  bash-sweep sessions only). T6 Step 1b lands a **`'checked'` event** carrying `{files}`, appended
  by every run that evaluates files *regardless of findings*, and `writtenFiles` in the fold; T9
  consumes those landed shapes, and criterion 5b pins the silently-checked file.
- **M4 — the `''` partition rendered `package-wide ()`** on D5's own "mainstream adopter shape".
  D9 adds the third arm (`'_repo'` **or** `''` ⇒ `repo-wide`), T3 Step 6 restates it, T4 criterion
  3b renders all four labels by value, and `package-wide ()` joins Step 6's forbidden-token test.
- **M5 — T6 criteria 3–4 named no channel and MR-25 had no killer.** Criteria 3 and 4 now name
  `pre` and `post`, new criterion 4b pins §11.3's own sentence (a downgraded DENY is a WARN for both
  budget and dedup), and MR-25 points at 4b.
- **M6 — Appendix A's T7 puts a config key and a configured threshold in stdout**, which R5-I14 and
  design §11 (`:426`) confine to `explain`. T10 Step 3 now renders T7's *content* in product
  English, flags the divergence the way T4 Step 3 flags "echo-shaped", criterion 4 asserts the
  absent tokens and the printed `90%`, and `agentShare` + a bare threshold comparison join the
  token test.
- **M7 — a third version notion was in scope and unnamed.** `HISTORY_STATE_SCHEMA_VERSION`
  (`history-resume.ts:62`) invites a bump when "a co-change row … changes shape" — and T2 changes
  one. Derived and stated in R5-I7 and T2 Step 4: **it does not move**, because the resume reads
  back only `cochange-raw.jsonl` (`history-resume.ts:394`), whose rows T2 does not touch, while the
  widened `CochangePair` is the informational cut `finishCochange` rebuilds every run
  (`history.ts:1091-1094`). Bumping it would force a whole-history re-walk on every adopter — the
  exact cost D11 refuses.

**Minor** — all 21 applied: the seven landed **body-shape** assertions the change breaks are now
named beside the eight `rootsVersion` ones (six `toEqual({a,b,sup,conf})` in
`history-cochange.test.ts` and `mine.test.ts:470` **plus its test title at `:457`** — fifteen in
total); R5-I11's MR range widened to every MR the tasks name; four bare `D13`s disambiguated to
"R4's D13"; T4's NON-goals joined the Appendix-A notation pass; **MR-12's Δ claim corrected** — an
in-alphabet zero-count value prices *identically* to ⊥ because the KT denominator cancels (§9.3's
own "numerically like ⊥ but NOT novel"), so MR-12 is restated as a novelty-flag killer and MR-12b's
rationale with it; T1's e2e attribution split across T3/T6/T7 by what each actually proves; T7
criterion 6 widened to nine fields **plus `observedAfter`**, which it previously excluded; six
anchors corrected (design `:133`/`:137-138`, the fan-out pin `:77-78`, `yg-architecture.yaml:207`
and `:774-777`, §8.10 `:360-362`, `check.mjs:36-48`); the two unassigned `tests/unit/cli/*` files
given their node; criterion 4b(ii) sized at **~600** generated scopes (two buckets must clear 300
independently); criteria 3c and 1 given the fixture properties MR-6 and MR-26 depend on;
`src/cli/roots-check.ts`'s ≈66 KB ceiling and its **STOP** escalation stated (no legal split target
exists); multi-partition runs specified (per-partition `evaluate`, ascending `partitionId`,
concatenate then order once) because §11.3's sort key is not total; the fourth false docs statement
(`docs/roots.md:37`) named; T1 criterion 3 says a malformed date is **skipped**, not thrown;
D5 decides what `fallback` carries when nothing routed to `'_root'`; D25 records the untaken
YAML-reformatting half of the dogfood entry; and T10 Step 1 **drops** the two sweep modulators with
the reason (`status` has no session), with R5-I3's table updated to match.

**Global consistency sweep** (mandated after M1, the third decision-vs-task drift). Every decision
amended in rounds 1–3 was grepped against every task, criterion and MR that restates it: D1
(pipeline/intents), D3 (`ROOTS_VERSION`), D4 (tie-break), D5 (sentinel/routing/fallback), D6, D9
(severity + projection), D11 (superset), D15 (`keyOf`), D16 (aggregation placement), D19 (budgets),
D20 (directional co-change), D22 (`status` contents), D23, D24. **Four drifts found and repaired,
none of which the review had flagged:** T6 Step 3 did not name `applyBudgetsAndDedup` or its return,
so D1's pipeline existed in one place only; T7 Step 3 said "intents applied" without saying the two
producers' records **merge**; D4's tie-break bullet still stated the single role-fact tuple after
the cell-class split was added two bullets above it; and D22 still described the alarm as Appendix
A's literal T7 after M6 replaced it with T7's content. The remaining ten decisions read identically
everywhere they appear.

**Not applied:** none.

### Round 4 — what the fourth adversarial review changed (0 blocking, 6 major, 13 minor)

First round with no blocking defect: round-3's cycle fix was re-derived independently and holds.
Four of the six majors were created or left open by round-3's own edits, which is why both targeted
sweeps were re-run afterwards.

**Major**

- **M1 — nothing created `.yggdrasil/roots/.state/`, and the mandated append helper does not.**
  Verified: `appendToDebugLog` is `appendFileSync` and nothing else (`debug-log-writer.ts:7-9`) — it
  creates the *file*, never the *directory* — while `atomicWriteFile` **does** `mkdir`
  (`atomic-write.ts:27-28`). The asymmetry ran exactly backwards: the one path D16.4 forbids from
  creating anything eagerly got its `mkdir` free, and the three that must create it did not, so
  every append would have thrown ENOENT behind a fail-open catch and shipped permanently empty
  session state. T1 Step 2b now states the directory contract (writers `mkdir` their parent
  immediately before the first write; readers create nothing), D16.4's prohibition is **scoped to the
  aggregation path** rather than reading as a blanket ban, and criterion 6b drives an absent
  `stateDir` in both directions — the case every unit test hides, since the landed `freshStateDir()`
  precedent hands the store a directory that already exists. `mkdir`'s legality re-checked:
  absent from `RAW_WRITE_FNS` (`check.mjs:4`), and `persistence-adapter` does not carry
  `no-direct-fs` (`:197-203`).
- **M2 — the single-file parse path, the hinge R5-I6 rests on, had no home.** `extractUnits`
  (`extract.ts:417`) takes a parsed `Tree` and a resolved `RootsBinding`, and the index builds both
  in a loop with no exported single-file equivalent (`pipeline.ts:101-118`). **Decided now rather
  than left as a STOP:** a new `src/roots/extract-file.ts` exporting
  `extractScopesForCheck(relPath, content, config)`, mapped into `cli/roots/engine` (intra-node, no
  new edge, and it keeps the parse out of `roots-check.ts`'s ≈66 KB budget), reproducing the index's
  gates **one by one** (registry lookup, `blobMaxBytes`, `MAX_PARSE_LINES`, `bindingForAsset`,
  `withParsedFile`, the `minimalFileScope` degrade). `minimalFileScope` is module-private today
  (`pipeline.ts:44`), so T3 **moves** it there and `pipeline.ts` imports it back — one
  implementation shared by both paths by construction. The signature takes `(relPath, content)`,
  settled by `--content/--as` and by `no-direct-fs`.
- **M3 — round 3's `'checked'` event had no producer.** Worked through all three candidates:
  `applyBudgetsAndDedup` structurally cannot (it sees only `findings`, so the silent-file case that
  motivated the event is invisible to it); `evaluate`'s `closureIntents` is defined as closure
  records only. **D1 now names a third, command-layer producer** — `roots-check.ts` builds the event
  from the file set it resolved and merges it into the applied `Intents`, so no signature moves — and
  T6 Step 1b, T7 Step 3 and a new T6 criterion 4c all say the same thing.
- **M4 — `OpenIntervention` was used in the central contract and defined nowhere**, and
  `SessionEvent`'s payloads hid behind a `…` that the fold, the dedup key and the once-per-session
  bound all read. Both are now declared to the field: `OpenIntervention` carries
  `{stableId, surface, expected, openedSessionId, openedTs, ignoredRecordedInSession}` — every field
  load-bearing for §9.10's bound (`v6-spec.md:479`) — and `SessionEvent` is a five-arm discriminated
  union with each payload mapped to the fold result it feeds.
- **M5 — R5-I14's only killer was assigned a corpus that does not exist when it runs.** T4 Step 6's
  test cannot see `status` strings six tasks before T10 writes them, and T10's criterion 4 pointed
  at a "Step 6" T10 did not have. T4's corpus is now scoped to the rendered messages, **T10 gains
  Step 5** extending the same test to the `status` renderer's three new lines, and criterion 4 points
  at it by its own number.
- **M6 — the edge-audit table, billed as the increment's single graph authority, was incomplete in
  five rows.** Verified each omission at source and added them: `cli/io/roots-state → cli/io/stores`
  (`debug-log-writer.ts` and `read-or-default.ts` are mapped there, `:18`/`:28` — not by
  `cli/io/atomic-write`); `cli/commands/roots → cli/io/roots-state`, which moves that node **10 → 13**
  relations, not 10 → 11; `cli/commands/roots-check → cli/ast/runtime` and `→ cli/language-registry`
  (required by M2's parse); and `cli/tests/e2e/roots-verdict → cli/tests/support` + `→ cli/tests/
  fixtures`, exactly as the landed sibling node declares. Added a `cli/roots/stores` row stating it
  needs **no** new edge (it already declares `cli/io/stores`) precisely because the neighbouring case
  differs. None creates a cycle. The table's claim is softened to settling the *allow-list* question,
  since `relation-undeclared-dependency` is blocking (`check-codes.ts:96`) at each task's own gate.

**Minor** — 12 of 13 applied, 1 rejected with evidence. Applied: `checkNoCycles`'s anchor corrected
to `:73-123` in all three places (it was the anchor of round 3's own blocking fix);
`history-cochange.test.ts:571` → `:572`; T3's `VerdictFact.partitionId` comment brought in line with
the `''` rule (the one place round 3's M4 fix did not reach); the two `M4:` review-finding ids removed
from a code block written to be copied verbatim (`self-contained-references`); R5-I4's range widened
to *(T2–T8)*; **D14 extended to all five event kinds**, having covered two; the `roots-check.ts`
headroom re-measurement written into T5/T6/T7/T9's final steps instead of a global note nobody owned;
**T10 given its missing mutation round-trips** (MR-38/39/40, the last code task without any);
`writtenFiles`' over-inclusive approximation of §13.5's `D` named with its direction, and the
restrict-to-changed alternative rejected explicitly; **the no-`.yggdrasil/` case decided** — silence,
exit 0, **no** incident, and explicitly not `findYggRootOrFail` (which exits 1, right for `index`,
wrong here) — plus the pre-root-resolution throw; D3's characterisation of the landed constant
replaced by a **rebuttal** of the release-boundary rule it overrides; the session log's growth law
stated at `pruneSessions` with prune named as its only bound; §13.5 `:621`→`:622` and §8.10's
`:360-364`→`:360-362`.
**Rejected — minor 13(c):** the claim that `nTotalRaw`'s doc is at `mine.ts:129` and outside the
cited `:130-132`. Read at HEAD, `:128` is `counts`, `:129` is `alphabet`, `:130` is the doc comment
`/** The SURVIVED raw population of §9.4c …`, `:131` is `nConformRaw` and `:132` is `nTotalRaw` — so
`mine.ts:130-132` covers the doc and both fields exactly, and `:129` is a different field. Left as
written.

**Sweep A — decisions vs restatements** (limited to what rounds 3–4 touched: D1, D5, D6, D9, D14,
D16.4, and the edge audit). **Two drifts found and repaired, neither flagged by the review:**
T7 Step 3 still merged **two** intent sets after D1 gained a third producer; and the edge-audit
table's "no task re-derives it" claim contradicted the graph ritual's per-task declaration duty
(softened to the allow-list question, with `relation-undeclared-dependency`'s blocking status named).
The rest — D5's `routePartition` home, D6's gate list, D9's `''` label in all four places, D14's five
kinds, D16.4's scoped prohibition — read identically everywhere.

**Sweep B — invariants and MRs vs tasks** (same scope). **Four drifts found and repaired:** R5-I11's
MR range still read "MR-1 through MR-37c" after T10 added MR-38/39/40 — the exact class the invariant
exists to prevent, so the range is now explicitly the aid and "every MR named in the tasks below" the
binding half; R5-I4 and the Architecture paragraph and the authorization table's first row all still
listed **five** engine modules after `extract-file.ts` made it six; R5-I13 pinned only *(T7, T8)*
though T6 now lands the `ignoredRecordedInSession` field the bound is implemented with; and T3's
Files list had no unit test for the module it creates. MR ids re-checked for uniqueness: 49 distinct
ids, no collisions.

**Not applied:** minor 13(c) only, rejected above with evidence.

### Round 5 — what the fifth adversarial review changed (0 blocking, 5 major, 6 minor)

All five majors were new — none raised in rounds 1-4 — and two (M2, M3) were products of round-4
edits that did not reconcile with each other. The three others live in a seam no round had audited
end to end: which files the check path looks at, and what it does when one misbehaves.

**Major**

- **M1 — D6's "gate for gate" list omitted the first gate in the loop it projects.** Verified at
  source: `parseAndExtractAll` runs six gates and `filters.forParsing` is gate 1
  (`pipeline.ts:103`), enforcing `config.include`, `BUILT_IN_EXCLUSIONS`, `config.exclude` **and**
  `TEST_PATTERN_EXCLUSIONS = ['**/*.test.*','**/*.spec.*']` (`partitions.ts:101-102`, `:128-137`).
  Without it the check path would return real scopes for test files, `dist/`, `**/*.d.ts` and
  anything an adopter put in `roots.exclude`, measure them against `_all` facts mined exclusively
  from production code, and WARN on an agent's test file for not carrying its production siblings'
  decorator. **Gate 0 added to D6 and to the set resolution**, with the question the coordinator
  raised answered on the merits rather than by symmetry: the index never mined a test file, so no
  fact was conditioned on one and no scope in one has an identity the model knows — **silence is the
  only honest answer**, and an adopter who wants test conventions changes config, which moves the
  index and the check path together. New T3 criterion 14 (same deviation planted in `src/x.ts` and
  `src/x.test.ts` ⇒ exactly one message; plus an excluded path and a narrowed `include`) and MR-14c;
  R5-I6 now states that gate 0 is part of it, since Step 1's harness drives a file that *was* mined
  and structurally cannot observe the excluded class.
- **M2 — D14 and T6 Step 1b disagreed about whether a Bash sweep appends `'checked'`.** Under D14's
  "in place of" wording, `writtenFiles` would be empty for every bash-shaped session — the `'sweep'`
  arm carries no `files` payload — so T9's completeness input would be empty on exactly the flow
  T9's e2e drives, re-creating round 3's M3 defect for the Bash channel. **D14 now says what T6 Step
  1b says:** a sweep that evaluates files appends `'checked'` (the ≤ `bashSweepMaxFiles` paths it
  evaluated, never the seeded set) and then `'sweep'`; a seed sweep appends `'sweep'` alone. The
  alternative repair (a `files` payload on `'sweep'`) is rejected in text — two producers for one
  fold field, against D1's one-producer rule. New T9 criterion 5c and MR-37d; criterion 6 sharpened
  so "no written files" now means "only a seed sweep".
- **M3 — T5 criterion 4 was unsatisfiable and R5-I2/R5-I15 prescribed opposite outcomes.** Four of
  the five injected faults are absorbed by contracts this plan states (T1 Step 3's per-record
  tolerance, T1 criterion 5's `undefined`, D6's `[]` skip and `minimalFileScope` degrade), so they
  produce a normal run with findings and no incident; satisfying the criterion would have meant
  *breaking* T1's tolerance. **The two regimes are now separated once:** R5-I15 is the absorbed list
  (one `debugWrite`, findings still emitted, **no** incident), R5-I2 governs what escapes, and the
  lists are disjoint by construction. T5 Step 3 and criterion 4 are rewritten over **§12.5's five
  stage boundaries** — resolving the second conflation, where "the five named stages" meant five
  *fault kinds* in one place and five *stages* in two others — and new criterion 4b observes the
  absorbed half for the first time, with MR-19b killing any "fix" that makes tolerance throw.
- **M4 — the `'closed'` event read as removing the intervention on either outcome.** §9.10's bound is
  written over "**the open record** … after the ignore" (`v6-spec.md:479`), and
  `ignoredRecordedInSession` is meaningless on a removed record. Under removal, the ordinary
  sequence *warn → re-check (ignored) → agent fixes it* would write **no** `complied` line and **no**
  ledger mark, and T8's cross-session `ignored` branch — the "dominant real path" — would be dead.
  **Now stated in both places:** `complied` removes, `ignored` leaves the record open and only sets
  the flag. New T7 criterion 3b (warned → ignored → fixed, same session ⇒ one `complied` + one mark)
  and MR-28b, which kills both halves with one mutation.
- **M5 — the dirty set was never filtered to files that exist.** `getDirtyFiles` "contributes BOTH
  its old and new path" for a rename (`utils/git.ts:113-124`), so deleted files and rename
  old-sides are routine; `readFile`/`realpath` throws ENOENT on them; and because R5-I2 mandates one
  whole-run catch and MR-19 forbids a per-file one, a single `git mv` would abort the entire
  invocation — zero findings for every file, one incident, nothing visible. **T3 Step 8 is now a
  three-filter set-resolution step** (existence with one `debugWrite` per drop, then `forParsing`,
  then path safety), stated as *set construction outside* R5-I2's boundary so MR-19's one-catch claim
  is untouched. New criterion 15 and MR-14d, whose failure shape is the production one: silence plus
  one incident.

**Minor** — all 6 applied: `foldSession(events, sessionId)`, since no event arm carries a session id
and `OpenIntervention.openedSessionId` was otherwise underivable (T8's cross-session pass supplies it
from the log's file name); T1 now creates **four** nodes, adding the e2e node T2's first e2e file
lands into (`unmapped-files` is blocking under `coverage.required: ["/"]`); five anchor drifts
corrected (`pipeline.ts:108-109` and `:111`, `history-resume.ts:62`, `integration-design.md:374-381`,
roots-cache `:11-13`, `yg-config.yaml:9`); the edge table's `roots-check` row no longer justifies
`→ cli/ast/runtime` with a reason D6 removed — the parse lives in `extract-file.ts`, so the row now
carries `→ cli/io/stores` (the byte read) and keeps `→ cli/language-registry` on its real ground;
"three bind every new `src/io/` file" corrected to **five**, named; D23 gains the three groups the
check path reads (`enumerate.*`, `history.blobMaxBytes`, `roles.*`) and T3 Step 2 now names the
landed `classifyAgainstMedoids` signature the way D6 names `extractUnits`.

**Sweep A — decisions vs restatements** (scoped to rounds 4-5: D1, D6, D14, D16.4, D23, the edge
audit). **Two drifts found and repaired, neither review-flagged:** the edge table's `extract-file.ts`
row did not list `partitions.ts` after gate 0 gave it a new intra-node import; and T8 Step 2's
cross-session pass did not say where the `sessionId` that `foldSession` now requires comes from. D14's
five kinds, D6's six gates, D1's three producers and D23's key list read identically everywhere else.

**Sweep B — invariants and MRs vs tasks** (same scope). **Two drifts found and repaired:** R5-I11's
range read "MR-1 through MR-40" while the round's five new killers pushed the id set to 54 (the range
now names the lettered variants and the count, with "every MR named in the tasks below" still the
binding half); and R5-I2's pin said only *(T5)* without distinguishing the criterion that now covers
each regime, while R5-I6's pin named only Step 1's harness — the one test that structurally cannot
observe gate 0. MR ids re-checked: **54 distinct, each defined exactly once, no collisions.**

**Not applied:** none.

### Round 6 — what the sixth adversarial review changed (0 blocking, 4 major, 9 minor)

Three of the four majors are **interactions between round-5's own fixes** — the class neither scoped
sweep can see, since each sweep follows one decision through its restatements rather than following
two decisions into each other. An **interaction pass** is added to this round's procedure and is
recorded below; it found three further defects on its own.

**Major**

- **M1 — D6 projected the loop's gates but not the *universe* the loop iterates.**
  `parseAndExtractAll` iterates `walkRepoFiles(repoRoot)` (`pipeline.ts:92`), which excludes
  gitignored paths, symlinks, `.git` in both forms, and **every separate-project subtree**
  (`repo-scanner.ts:524-538`, `collectFiles` `:55-96`). `forParsing` knows none of that, so a hook
  payload or a positional argument naming a gitignored `local-scratch/` file or a **submodule** path
  would parse, route by directory prefix and be measured against facts mined from a tree it was never
  part of — gate 0's harm one layer up, minting `stableId`s the next index can never match, which
  ride into telemetry and, on compliance, into the **committed** ledger. **Gate −1 added**, and the
  mechanism chosen against both options the review offered: not `walkRepoFiles` (an O(repo) walk with
  a `.gitignore` read per directory does not fit a 700 ms cold hook budget) and not a
  re-implementation, but **three per-path tests built from `repo-scanner.ts`'s own exported helpers**
  — `lstat` (regular file, not a symlink; this **subsumes** the existence filter, so it is one test
  rather than two), an ancestor scan for `.git`/`.yggdrasil` (`findNestedProjectRoots`' predicate
  applied to one path, at most `depth` `existsSync` calls), and `isIgnoredByStack` with the stack
  assembled up the path's own chain via `loadRootGitignoreStack`. Cost is O(depth), stated, and T11
  measures it. New criterion 14b drives a gitignored file, a symlink and a nested checkout **and**
  calls the real `findNestedProjectRoots` so the narrowing cannot drift; MR-14e.
- **M2 — T3 Step 2's role ladder omitted §8.1's `_untyped` eligibility gate.** The index filters
  before it classifies (`roles.ts:819-825` — anchor corrected in round 7 with the enclosing
  function's real name, `inducePartitionRoles`), and the landed comment states the consequence in binding
  terms: below `minOwnFeatures` a scope is excluded "from clustering **AND from role-conditioned
  conventions entirely**". `classifyAgainstMedoids` has no such gate, so the check path would assign a
  role the index refuses — and D8 would let that role's facts, being the smaller evidence class,
  **shadow** the `_all` facts that are the scope's only correct governance: a wrong message that also
  suppresses the right one, on the ordinary small method. **Rung 0 added** ahead of sticky and
  classify. The coordinator's instruction to walk the classifier path end to end was carried out and
  its result recorded in the step: `minClusterSize` and `clusterSampleCap` are **build-time** gates
  whose outcome the check path inherits by reading only the roles the snapshot persisted, and §8.9(b)
  was already present — rung 0 was the only omission. `minOwnFeatures` added to D23. New criterion 8b
  (built to clear `roleMinMembership`, so it fails only if the gate is skipped) and MR-9b.
- **M3 — gate 0's placement emptied `writtenFiles` of every test file.** `'checked'` was built from
  the *resolved* set, which is post-`forParsing`, which contains `TEST_PATTERN_EXCLUSIONS` — so
  §13.5's `D` was structurally test-free, D20's own motivating pair (a test beside its source) was
  dead, and T9 criterion 5's second and third cases were unreachable through the product while still
  passing as unit tests. **Reconciled honestly rather than by dropping the criterion, exactly as
  instructed:** T3 Step 8 now produces **two sets** one filter apart — a **participation** set (post
  gate −1) that feeds `'checked'`/`writtenFiles`, and an **evaluation** set (post gate 0) that feeds
  the verdict. The argument is on the merits: gate 0's honesty rule is about *speaking about a file's
  own conventions*, and completeness speaks about none — it uses `D` as a session-participation
  signal and names a **partner** that is never evaluated. New T9 criterion 5d (a session whose only
  edit was a test file still gets its source partner, driven through the **e2e**) and MR-37e.
- **M4 — the cross-session pass had neither termination nor an idempotency key.** After round 5 made
  an `ignored` closure leave the intervention open, T8 Step 2 — unrevisited — still sampled every
  open intervention unconditionally, so the dominant path (warn → re-check → session ends) banked
  **two** `ignored` samples for one intervention, against R5-I13; and with no representable terminal
  marker, D16.2's unconditional per-`index` aggregation re-fired the same close every run. **Worked
  through and re-derived after the fix, as instructed:** eight `index` runs in one week reached
  `health.minSamples` (8) from a *single* intervention and `WilsonLB95(0/8) = 0 < 0.3` demoted a
  healthy convention; with the two new rules — skip any intervention whose fold set
  `ignoredRecordedInSession`, and append a terminal `'closed'` with **`scope: 'cross-session'`**,
  terminal for both outcomes — that intervention contributes **n = 1 < 8** and never re-enters the
  pool, so the number of `index` runs stops being an input to compliance at all. The `complied`
  mirror (a re-fire on a new UTC day slipping past the ledger's date-keyed dedupe) closes with it.
  Telemetry's missing idempotency key named in D13 and T1: `(sessionId, stableId, surface,
  observedAfter)`. New T8 criteria 4b (run the aggregation twice ⇒ all three stores byte-identical)
  and 4c (one sample per intervention across both producers, unchanged by eight runs), MR-32b/32c,
  T1 criterion 4b. One loss is accepted and stated: a session log pruned at 7 days before any `index`
  takes its samples with it — §18.2's permitted direction, the same one D16.5 chose.

**Minor** — all 9 applied: R5-I3's closing sentence no longer contradicts its own table (repository-
scoped modulators in `status`, session-scoped ones on their channel, flagged as a reasoned divergence
from `v6-spec.md:81`); four anchors corrected (`partitions.ts:101-102`, `pipeline.ts:96-100`,
`config-parser.ts:91-92`/`:131-138`/`:135`/`:137`, `integration-design.md:161-164`); the edge table's
speech row now names the symbols T3 Step 2 actually imports (`classifyAgainstMedoids`,
`buildRoleFeatureBag`) instead of `roleJaccard`, whose only consumer went intra-node in round 3;
T5 criterion 4b's fourth absorbed fault is driven through the **injection seam** rather than by
malformed source (tree-sitter is error-tolerant and never throws — a fixture could not produce it,
and `extract-file.test.ts` covers the `minimalFileScope` degrade no landed test exercises); two
design-§11 rows are flagged as deliberate spec-over-design choices beside "echo-shaped"; T8 criterion
6 now asserts the count through `health.ts`'s return value and the absence of writes, since **the
rendered line is T10's**; `MAX_PARSE_LINES` moves with `minimalFileScope` so
`pipeline.ts → extract-file.ts → pipeline.ts` is not left as an unstated import cycle; and the
locality contrast sentence's **group** form is stated and given its own arm in T4 criterion 3.

**Sweep A — decisions vs restatements** (rounds 5-6: D6's gates, D13, D14, D23, T3 Step 8's fork,
T7/T8's closure semantics, the edge audit). **Three drifts found and repaired:** R5-I6 named gate 0
but not gate −1 after M1 added it; D14 claimed to be "the single order" while T8's cross-session
close — a fourth writer — sat outside it; and T7 Step 2 did not say which `scope` value it writes now
that the discriminator exists.

**Sweep B — invariants and MRs vs tasks.** **Two drifts:** R5-I11's count read 54 after the round's
five new killers took it to **59**; R5-I13 gained a third mechanism (the telemetry key) and two more
pinning sites without its parenthetical moving. Both repaired. MR ids re-checked: **59 distinct, each
defined once, no collisions.**

**Interaction pass (new).** For every pair of mechanisms rounds 5-6 amended, one line on how they
compose, verified in both places. **Nine pairs checked, three defects found — none of which either
sweep could have seen:**
- *gate −1 × existence filter* — one test, not two (both sites say "subsumes"). ✓
- *gate −1 × participation set* — `D` is built post-gate-−1, so a gitignored file never reaches
  completeness either. ✓
- *gate 0 × `writtenFiles`* — the fork; both sites carry the same reasoning. ✓ (this was M3)
- *bash `'checked'` × participation set* — **DEFECT:** D14 and T9 criterion 5c both still said the
  sweep's `'checked'` carries the paths it *evaluated*, which after M3 is the wrong set and would
  have left the test→source direction dead on the Bash channel specifically. Both re-pointed at the
  participation set, with `bashSweepMaxFiles` applied to it by path order so §12.4's bound holds.
- *ignored-stays-open × §11.3's WARN dedup* — **DEFECT (unstated composition):** both fire on a
  re-check and neither substitutes for the other. Now stated: dedup bounds what the agent *sees*,
  `ignoredRecordedInSession` bounds what the pool *counts*, and closure runs on every sighting
  because it precedes every skip.
- *three-filter set × MR-19's one-catch* — construction outside the boundary, totality clause makes
  it safe. ✓
- *gate −1's `lstat` × T5's `realpath`* — **DEFECT:** T5 Step 4 still read as a standalone step after
  T3 Step 8 claimed the resolution. Re-pointed at slot 3, inheriting the totality rule.
- *terminal close × `sessions.pruneDays`* — a log pruned before aggregation loses its samples; a
  permitted direction, now stated rather than left to be discovered.
- *rung 0 × D8's applicability* — D8 already excludes an "untyped" role from contributing facts or
  shadows, so the two compose exactly. ✓

**Not applied:** none.

### Round 7 — what the seventh adversarial review changed (0 blocking, 6 major, 9 minor)

Three of the six majors were again interactions of round 5-6's newest mechanisms with older
contracts, and two of them (M4, M5) were defects the plan had *introduced* while fixing round 6.

- **M1 — `VerdictInput` could not express the role ladder T3 Step 2 describes.** The input carried
  `roleOf: (skeyR) => string | null` (the raw `assignments` read), but rung 0 needs a whole
  `ScopeUnit` (`buildRoleFeatureBag(unit)`, `roles.ts:149`) and rung 2 needs `RoleMedoid[]`
  (`roles.ts:330-333`) plus three config numbers (`classifyAgainstMedoids`, `:351-357`), while
  `evaluate` takes no `config` at all. **Resolved by moving the ladder, not by widening the type** —
  and by a third option neither the review nor the plan had named: it lives in **`extract-file.ts`'s
  new `resolveRolesForCheck(units, partition, config)`** (D6), which already holds the units, is
  **intra-node with `roles.ts`**, and therefore costs **zero** new graph edges. `VerdictInput.roleOf`
  is now the *resolved* role (`null` for ineligible **and** for ambiguous — `'-1'` never reaches the
  engine), and `VerdictInput` is restated **field by field with each field's producer named**, with
  the rejected alternative recorded and its three costs. The edge table's speech row loses
  `classifyAgainstMedoids` and `buildRoleFeatureBag` (and `isDecorativeRole`, which the command layer
  calls); D1's pipeline block gains the two `extract-file.ts` stages; T3 Step 2, criteria 8/8b and
  T3's Files list all say where the ladder is. **Three things the D×T re-run over every construction
  site turned up on its own:** the three classifier numbers are **not** all in `config.roles` —
  `roleAmbiguityGap`/`roleMinMembership` are `thresholds.*` (`config-parser.ts:91-92`,
  `roles.ts:913`), exactly as D23 already said and as this round's first draft of the fix did not;
  `roleLabelOf`, added in that first draft, was **removed as redundant** — `Finding.roleLabel` copies
  the governing `VerdictFact.roleLabel`, which the projection already carries; and the
  medoid-index→`roleKey` mapping had no killer, so **criterion 8c** (a partition whose role order is
  the reverse of its key order) and **MR-9c** were added.
- **M2 — gate −1's nested-project test did not match the landed predicate.** `.yggdrasil` counts only
  as a **directory containing ≥1 regular file at any depth** (`directoryHasAnyFile`,
  `repo-scanner.ts:339`); `.git` only via `isGitBoundary` (`:322-335`) — a directory with ≥1 file, or
  a **file** matching `/^gitdir:\s*\S/` (`isGitdirPointerContent`, `:305`). A `.git` symlink, an
  empty `.git/` and a garbage `.git` file are each **not** boundaries. The paraphrase "contains a
  `.git` or `.yggdrasil` entry" would have silenced whole package directories with no diagnostic.
  The predicate is now written out in full, and — better than restating it — **T3 exports
  `isNestedProjectBoundary(dir, entries?)` from `repo-scanner.ts`** and rewrites
  `walkForNestedProjectRoots` to call it, so the index path and gate −1 share one implementation and
  gain no syscall. Criterion 14b gains the **negative** cases the review demanded (an empty
  `.yggdrasil/` and a `.git` symlink, each asserted absent from the real `findNestedProjectRoots`
  **and** asserted to still produce their message), and **MR-14f** kills the looser predicate — the
  mutation MR-14e structurally could not make. Cost re-derived: one `readdir` per ancestor rather
  than one `existsSync`, plus at most one cheap call per ancestor that carries a marker; still
  O(depth).
- **M3 — `lstat` and `realpath` silently dropped content-supplied paths.** Filter 1 and T5 Step 4
  both assumed the bytes come from the path, which makes `--content <p> --as <q>` structurally dead
  and falsifies T5 criterion 3 and D6's own "answers for files that did not exist when the index
  ran". T3 Step 8 now carries an explicit **per-source gate matrix** (positional/dirty-set,
  `--content`+`--as`, hook payloads) fixing which of the four tests applies to which path: `q` is
  gated on universe membership, gitignore and `forParsing` but **not** on existence; both walks start
  at `q`'s nearest existing ancestor so `ENOENT` never arises; containment re-appends and normalizes,
  so `../../etc/passwd` is still refused. `p` is a byte source only, gated on existence alone, and a
  missing `p` is silence + one incident, **not** exit 1. Criteria **3b** (a target that exists
  nowhere, plus three refusals) and **3c**, and **MR-22b/MR-22c**, make each half killable; T5 Step 1
  and Step 4 both point at the matrix rather than restating it.
- **M4 — the terminal marker's justification was arithmetically false, and MR-32b was inert.**
  `appendTelemetry` dedupes on `(sessionId, stableId, surface, observedAfter)` and the pass supplies
  the same `sessionId` every time, so eight re-fires over an unchanged tree write **one** row with or
  without the marker: the "eight index runs reach `minSamples` and `WilsonLB95(0/8) = 0` demotes"
  derivation could not fail under the mutation, and neither could criteria 4b/4c. Replaced with an
  honest derivation of what the dedupe does **not** bound: a re-fire whose `observedAfter` **differs**
  (an agent that keeps tweaking a still-deviating value — this preserves the `WilsonLB95(0/8) = 0`
  worked number in a scenario that can actually reach n = 8), a `complied` re-fire on a **new UTC
  day** slipping past the ledger's `(stableId, surface, date)` dedupe (`weights.ts:267-269`), and the
  re-folding cost, named as a cost. Criterion 4b now straddles an **injected UTC-day boundary** and
  states that the session log legitimately changes on the first run and is byte-identical after;
  MR-32b is re-pointed at the ledger arm and **MR-32b2** added for the `ignored` arm. **A defect
  beyond M4, found while re-deriving it:** the same dedupe made **MR-32c** inert too — T7's
  in-session sample and the pass's would-be sample share `sessionId` and `(stableId, surface)`, so
  criterion 4c's first case had to be rebuilt over a **changed** deviating value before rule 1 could
  be killed at all.
- **M5 — rule 1's unconditional skip suppressed the `complied` arm.** §18.2 conditions both arms on
  the current index only, and skipping the whole intervention lost not just a sample but the **§18.3
  ledger mark** — the P5 weight regulator, and R5-I8's one new committed file. Rule 1 is now scoped
  to the **`ignored` sample**: the terminal event is still written and the `complied` arm is
  untouched. §18.2's direction re-derived: recording the `ignored` alone drives that intervention's
  compliance to 0 and pushes toward demoting a convention that was in fact eventually followed —
  the direction "a lost demotion resurrects a FACT, never falsely silences one" (`v6-spec.md:683`)
  rules out. R5-I13 is amended to say what it always meant — its bound is written over the `ignored`
  branch (`:479`) and over that branch alone. Criterion 4c gains a **third** case (one `ignored`,
  one `complied`, one mark) and **MR-32d** kills the widened skip.
- **M6 — "ended session" was undefined, and the only implementable reading closed the LIVE one.**
  Defined at T8 Step 2a: a log is ended iff its **mtime falls on a strictly earlier UTC calendar
  day** than the injected `nowMs`. Chosen because mtime is already this plan's liveness signal
  (`pruneSessions`) and the UTC day is already its coarsest clock granularity (D12's last-resort
  identity, §18.3's ledger dedupe) — so R5-I7's "invent no config key" holds; a terminal-event
  predicate was rejected because R5 installs no hooks (R8), so most logs carry no `'stop'`. The
  midnight-spanning cost is stated with its three-way bound. New **criterion 4d** (a log written
  during the run is byte-identical, contributes nothing and gains no event; an older log closes
  normally) and **MR-32e** (both directions). T1 gains **`listSessionLogs(stateDir)`** returning
  `{sessionId, mtimeMs}[]` — minor 7's finding, which M6 turned out to need — with criterion 4c;
  T8's Files note keeps `health.ts` file-free by having the command layer enumerate and the engine
  apply the predicate to values.

**Minor** — all 9 applied: the edge table no longer calls `cli/roots/engine → cli/io/stores` new (it
is that node's **first** declared relation, `yg-node.yaml:173-174`, so the node's `relations:` block
is untouched by this increment); `induceRolesForPartition` corrected to **`inducePartitionRoles`**
with its real anchors (`roles.ts:803`, filter `:819-825`, comment `:815-818`) in both the task text
and round 6's changelog entry; `repo-scanner.ts:229-244` corrected to `:260-269` (and `entry.isFile()`
`:97` → `:98`); `parentExp` corrected to `mine.ts:141-142`; T9 Step 2 now states that §12.4's cap is
on **evaluation** while D14's is on **participation**, and the consequence (a sweep may evaluate
fewer than 5) with the wrong reconciliation named; D12's last-resort session id is **hashed** like
the rung above it, with the file-name round-trip as the reason and the consequence for T8 stated;
`listSessionLogs` added (above); T8 criterion 6 now asserts the **whole `.yggdrasil/roots/.state/`
tree** across a `status` run — the terminal `'closed'` event is the write it would otherwise miss —
with **MR-32f**; and `MinedFact`'s "STRUCTURALLY ABSENT" comment (`mine.ts:155-160`) joins T2's named
assertion sites as a **sixteenth**, since T2 makes its `exemplars` entry false.

**Not applied:** none — all six majors and all nine minors were verified against the authority each
cited and found correct. **One review claim was narrowed rather than adopted whole:** M5 asked for
"one `ignored` AND one `complied` AND one mark", which reads as a double count under R5-I13. It is
adopted in full only after checking R5-I13's own wording, which bounds the **`ignored` branch**
(`v6-spec.md:479`) and says nothing about `complied` — so the pair is one sample per outcome, not two
of either, and R5-I13 now says so explicitly rather than being read charitably.

**Sweep A (decisions vs restatements), scoped to rounds 6-7.** D1 (pipeline block now names the two
`extract-file.ts` stages; T7 Step 3's "three sets" is check-path-scoped and D14 still names T8 as the
one writer outside it) ✓; D6 (gates −1/0, `resolveRolesForCheck`, the gate matrix — restated at T3
Steps 1/2/8, T5 Steps 1/4, criteria 14/14b/3b/3c, R5-I6) ✓; D12 (hashed rung 3 → T6 Step 4's shape
test, T1 criterion 4c's round-trip, T8 Step 2a's "not recoverable from the id") ✓; D13 (telemetry
key → T1 criterion 4b, T8 Step 2b, R5-I13) ✓; D14 (write order → T8 Step 2b's terminal-marker rule, T7 Step 3) ✓;
D16 (aggregation site → T8 Step 5, now naming **all three** intent sets rather than the ledger alone)
✓; D23 (`thresholds.*` vs `roles.*` → T3 Step 2, the `VerdictInput` note) ✓ — **one defect found and
fixed by this sweep**: this round's own first draft of the M1 fix called all three classifier numbers
`config.roles` numbers, which D23 already contradicted.

**Sweep B (invariants/MRs vs tasks), scoped to rounds 6-7.** R5-I4 (engine purity — `health.ts`
gains no fs after M6; `extract-file.ts` gains no clock after M1) ✓; R5-I7 (no new config key — M6's
predicate uses none) ✓; R5-I8 (one new committed file — M5's fix is what makes it actually get
written) ✓; R5-I13 (amended; T6/T7/T8 all re-checked) ✓; R5-I16 (no timing assertion — criteria 4b
and 4d use injected `nowMs`) ✓. **MR ids: 67 distinct, every one defined exactly once, and every
`MR-*` mentioned anywhere in the document has a definition** (mechanically checked). Eight added this
round: MR-9c, MR-14f, MR-22b, MR-22c, MR-32b2, MR-32d, MR-32e, MR-32f. Every new criterion (8c, 3b,
3c, 4c on T1, 4d) is named by at least one MR, and every MR re-pointed this round names a criterion
that can observe its mutation — which is the property M4 showed three of them had lost.

**Interaction pass, scoped to rounds 6-7** — every pair of mechanisms amended in the last two
rounds, stated in one line and verified against the plan, including the three pairs the coordinator
named. **Eleven pairs checked, two defects found:**
- *`VerdictInput` × `extract-file.ts`* — the resolver produces `roleOf`; the engine consumes it and
  never sees a unit, a medoid or a config. ✓
- *`VerdictInput` × the projection (`VerdictFact`)* — **DEFECT:** the first draft added `roleLabelOf`
  beside `roleOf`, duplicating `VerdictFact.roleLabel`. Removed, with the absence documented in the
  type block so it is not re-added.
- *`VerdictInput` × the command layer (`decorativeRoles`, `demoted`, `openInterventions`)* — all
  three are still command-produced sets; M1 moved a *lookup* upstream, not a set. ✓
- *`VerdictInput` × the edge table* — speech's only remaining engine import is `isBooleanSurface`;
  `isDecorativeRole` moved to the command layer with the set it builds. ✓
- *gate −1 matrix × positional/dirty-set source* — unchanged behavior; the matrix's first row is the
  pre-existing rule, so criterion 15 and MR-14d still hold. ✓
- *gate −1 matrix × `--content`/`--as`* — `p` existence-only, `q` everything-but-existence; T5
  Step 1 and Step 4 both defer to the matrix. ✓
- *gate −1 matrix × hook payloads* — `post`/`bash` targets already exist; `pre` reads no path in R5
  and the deferral to a later increment is stated. ✓
- *gate −1 matrix × `isNestedProjectBoundary`* — the ancestor walk for `q` starts at its nearest
  existing ancestor, which is exactly the directory the boundary predicate needs; no `ENOENT` path
  exists in either. ✓
- *telemetry dedup × terminal marker × ledger arm* — the dedupe bounds identical re-fires; the marker
  bounds changed-`observedAfter` re-fires and new-UTC-day ledger marks; criterion 4b watches the
  ledger across a day boundary and 4c/MR-32b2 watch the changed value. The three now partition the
  space instead of overlapping on a case none of them could observe. ✓
- *ended-session predicate × `sessions.pruneDays`* — the closable window is days 1-7 of a log's life
  (ended from the next UTC day, pruned at 7), so the predicate does not shrink the prune window's
  already-accepted loss to zero. ✓
- *ended-session predicate × `status` as a read surface* — **DEFECT:** with M6 the pass now writes
  session events as well as ledger marks, and T8 Step 5 named only the ledger as the reason `status`
  must not apply intents. Widened to all three sets, with the session-event half called out as the
  likelier accident (a `status` between two builds would delete compliance evidence), and criterion
  6 re-pointed at the whole `.state/` tree.

### Round 8 — the stabilization round (1 blocking, 4 major, 5 minor)

Rounds 6, 7 and 8 each found the *same defect class* in the T7/T8/D13 complex, and each of the first
two answered with a local patch that the next round had to undo. This round did not patch. It
re-derived the whole sampling-and-demotion story from §9.10, §18.1, §18.2 and §18.3 in one pass and
wrote the derivation into the plan as **D13a**, which is now the complex's single authority; T7, T8,
D14, R5-I13 and every criterion and MR in the complex restate it and add nothing.

- **B1 — `observedAfter` is §9.10's two-valued OUTCOME LABEL, not the observed value.** The spec
  says it in the paragraph both earlier rounds cited as their own authority (`v6-spec.md:479`:
  "append `observedAfter: complied` … append `observedAfter: ignored`"), and §18.1 (`:681`) puts the
  code value in a *different* field, `observed`. T7 transcribed this correctly; T8 was written
  against the opposite reading. Four consequences, all now repaired at the derivation rather than
  one by one: T8 Step 2b's "eight index runs across eight changed values reach `minSamples`" was
  arithmetically impossible (the eight re-fires share a key and collapse to one row — **verbatim the
  failure round 7's M4 diagnosed, re-homed rather than repaired**); MR-32b2 and MR-32c were both
  inert; and T1 criterion 4b's second half was **unsatisfiable**, asking an implementer to assert
  that two rows differing only in `observedAfter` both survive when under the real domain they are
  the same row — a cross-task contract break on a store key, four tasks before T7 would have
  contradicted it.

  **The derivation, in the five parts the stabilization order asked for.**
  **(a) Every field of the telemetry row**, in a table, with `observed` (the deviating code value,
  on the intervention row) and `observedAfter` (`'complied' | 'ignored'`, on the closure row) set
  side by side so the conflation cannot recur; the union type is now written into
  `TelemetryRecord` itself so a record carrying a code value in `observedAfter` does not typecheck.
  **(b) The full lifecycle**, as a five-transition table naming for each the session event written,
  the telemetry row, the ledger mark and the writer — including the three properties earlier rounds
  each got one of wrong (an `ignored` closure does not close; the pass's touch is terminal; one
  intervention may legitimately yield one row per *outcome*).
  **(c) What the key actually bounds.** At most **three** rows per intervention. Bounded by the key
  and needing no rule: repeated messages, repeated in-session ignores, the pass re-firing over many
  `index` runs, the pass duplicating T7's ignore, **and a changed deviating value**. Not bounded:
  rows from *different sessions* (legitimate pooling) and *two different outcomes* for one
  intervention (the terminal marker's job).
  **(d) Reachable demotion scenarios.** Resolved rows accrue one per (session, intervention,
  outcome), so **n = 8 means eight sessions** — never eight checks, eight values or eight `index`
  runs. Two producible paths are named (S1 in-session, needing no clock or filesystem-time control;
  S2 cross-session over back-dated logs), and the three unreachable ones are named as unreachable
  with the instruction that an acceptance number depending on them must be **deleted, not
  weakened**.
  **(e) The arithmetic, re-derived at a reachable n.** New n = 8 table: **0/8 → 0** (exactly),
  **4/4 → 0.2152**, **5/3 → 0.3057** (the boundary — it clears 0.3 by 0.0057), **6/2 → 0.4093**. The
  n = 10 rows are kept as unit-level pool arithmetic and are now labelled with the state that
  produces them (ten sessions). MR-34 gains the 4/4 row, which is the point-estimate killer at the
  reachable n; **MR-34c** is added for the `minSamples` floor, now the only thing between one
  unlucky session and a demotion.

  **(e continued) Every criterion and MR in the complex, rewritten or deleted.** T1 criterion 4b is
  now the three-row ceiling asserted by value (with **MR-1b** killing the key's shape in both
  directions); T7 criterion 2 moves its load-bearing half to the **session log** and says which half
  is which, with MR-28 re-pointed and its false "demotion becomes reachable within one session"
  claim retired; T8 criterion 1 gains the n = 8 table, 4c is restructured into three named cases
  (one of which is explicitly a regression guard on the key rather than a killer for any rule), and
  T8's e2e is rewritten into three legs whose "eight" is unambiguously eight sessions, plus a
  non-demoting 5/3 control that stops the demotion leg passing for the wrong reason.
  **T8's rule 1 is deleted outright** — the `ignoredRecordedInSession` suppression in the
  cross-session pass could not change a stored byte, and keeping it also forced round 7's M5
  arm-scoping subtlety, a live way to lose the `complied` branch and its ledger mark for no benefit.
  **MR-32c and MR-32d are retired with it**, recorded as retired rather than silently dropped.
  `ignoredRecordedInSession` keeps exactly one job (T7's session-log guard) and its type comment now
  says so.

- **M1 — MR-9c was a no-op and criterion 8c's fixture was unconstructible.** `MinedPartition.roles`
  is `roleKey`-sorted twice over (`roles.ts:1030` with `compareRoles` `:1054-1057`, then
  `mine.ts:1035`), so "`roles[]` order" **is** "`roleKey` order" and MR-9c's mutation changed
  nothing; criterion 8c asked for a partition whose two orders disagree, which no index run can
  emit. Criterion 8c is rebuilt on two roles with sharply different medoid bags, **both arms
  asserted** (a one-arm version is satisfied by a constant), and MR-9c is restated as indexing
  `roles[]` by anything other than the returned `roleIndex`. **The real hazard the old MR was
  reaching for is now stated instead of mutated:** the index classifies against `medoids[]` in
  cluster/push order (`roles.ts:904`), the check path against the same bags in `roleKey` order, and
  `classifyAgainstMedoids` breaks an exact `m1` tie by array position (`:363-369`) — so a
  hook-vs-index divergence is possible on an exact tie. Push order is not persisted, so the exposure
  is **accepted and bounded in writing** (sticky covers every already-assigned scope, leaving only
  new/renamed ones; §8.5's ambiguity gap sends most near-ties to `'-1'` first), and T3 Step 1's
  harness is noted as structurally unable to see it.
- **M2 — T8 criterion 4b demanded a clock this CLI does not have.** `nowMs` is a function parameter,
  `header.clock` is a git timestamp, D18 rules out an environment variable and D23 makes a new key a
  STOP — so "two `yg roots index` runs separated by an injected UTC-day boundary" was unrunnable,
  and MR-32b had no live observation. Restated at the two levels where the effect *is* observable,
  neither needing a clock override: **(i) unit**, calling the aggregation twice with two `nowMs`
  values (`health.ts` now explicitly derives **both** the ended-session predicate and the ledger
  `date` from `nowMs`, stated in T8's Files); **(ii) e2e**, as *presence versus absence* over an
  empty ledger — seed an ended log, `index`, back-date with `utimes`, **fix the scope**, `index`
  again: the marker leg writes no `complied` row and no mark, the mutant leg writes one of each,
  both on the same UTC day so no dedupe is in play. The same-day byte-identity leg is kept for what
  it does prove, and now says what it does not.
- **M3 — `'_root'` is a live partition id and rendered `package-wide (_root)`.** `keyFor` returns it
  for any file matching no package root (`partitions.ts:243`) and `finalId = status === 'own-floor'
  ? key : '_repo'` (`:284`), so a `_root` bucket clearing the 300-scope floor survives under its own
  name — a mainstream monorepo shape (packages in subdirectories, no root marker, a large top-level
  `src/`). D9's arm becomes `'_repo' | '' | '_root'` ⇒ `repo-wide`, with the reason (a catch-all
  bucket spans the repository and is emphatically not a package) and with **both** special arms
  enumerated together, since round 3 found the first by the same reasoning that found this one.
  Restated in T3 Step 6 and `VerdictFact.partitionId`; T4 criterion 3b now renders **five** labels by
  value; T4 Step 6's forbidden-token list gains the bare tokens `_root` and `_repo`.
- **M4 — D25 had no owning task.** It appeared in the decisions block, a carry-in and an open
  question, and in no task's Files, Steps, criteria or MRs — so under the plan's own T1→T11 protocol
  it would not have been built, while carry-in 1 promised the dogfood report would record it
  resolved. Given a home: **T10 Step 6, criterion 6 and MR-41**, with `src/cli/roots.ts`'s scaffold
  notice (`:128-129`) added to T10's Files and `cli-roots-basic.test.ts` to its test list. The
  notice appends the absolute path and leaves the existing sentence intact, because that file's
  three landed assertions (`:209`, `:212`, `:237`) must keep passing unchanged; MR-41's mutation is
  a *relative* path, and criterion 6 runs from a subdirectory so the mutation can fail.

**Minor** — all 5 applied: D13a(c) now carries the constraint that any fixture changing a deviating
value must change a surface that does **not** feed `stableId` (a rename makes the event unresolvable
and T8 Step 1 drops it — `extract.ts:627-628`); the edge-audit table's gate −1 clause moves from
`cli/roots/engine` to `cli/commands/roots-check` (where T3 Step 8 actually does the reads, and where
R5-I4's `no-direct-fs` is not in force) and names `isNestedProjectBoundary` rather than
`findNestedProjectRoots`, which after round 7's M2 is called only from a test;
`buildRoleFeatureBag` corrected to `roles.ts:149` in all three places; the gate matrix gains the
file-**kind** clause for an *existing* `--as` target (`q` must be absent **or** a regular file — an
existing symlink or directory at `q` is refused, since `collectFiles` admits only `entry.isFile()`,
`repo-scanner.ts:98`), with a fourth refusal in criterion 3b and a third arm in MR-22b; and
criterion 14b now says its fixture is built programmatically at test time, since git tracks neither
empty directories nor paths under a nested `.git`.

**Not applied:** none. Every finding was verified against its cited authority — §9.10/§18.1's field
domains, `roles.ts`'s two sorts, `partitions.ts:243`/`:284`, the absence of any clock seam, and
`src/cli/roots.ts:128-129` — and all ten held.

**Sweep A (decisions vs restatements), scoped to the complex and rounds 7-8.** D13/D13a → T1 (the
`TelemetryRecord` shape, criterion 4b, MR-1b), T7 (Step 2, criteria 2/3, MR-28), T8 (Steps 2a/2b,
criteria 1/4b/4c/4d, the e2e, MR-32/32b/32e/34/34c), R5-I13, D14 ✓; D9's three arms → T3 Step 6,
`VerdictFact.partitionId`, T4 criterion 3b, T4 Step 6 ✓; D15's `date` → T8's Files (the `nowMs`
derivation) ✓; D25 → T10 Scope/Files/Step 6/criterion 6/MR-41, carry-in 1 ✓; D6's gate matrix → T3
Step 8, T5 Steps 1/4, criteria 3b/3c ✓. **One defect found by this sweep**: three places still spoke
of "rule 1" after Step 2b deleted it, and the Step 2a cost paragraph still credited it with bounding
the midnight-spanning harm.

**Sweep B (invariants/MRs vs tasks), scoped to the complex and rounds 7-8.** R5-I11 rewritten — it
now states the converse it always implied (an MR that cannot fail is worse than none) and records
this round's three retirements; its id count is refreshed to 67. R5-I13 rewritten to name the store
key as the mechanism instead of a fold flag or two mutually-exclusive producers. R5-I4 ✓
(`health.ts` still reads no file and no clock; `nowMs` is a parameter). R5-I14 ✓ (`_root` added to
the forbidden tokens). R5-I16 ✓ (criteria 4b(i) and 4d pin predicates with injected values, never
wall-clock timing). **MR ids: 67 live definitions, no duplicates, and every `MR-*` referenced in the
task body is defined — except `MR-32c`/`MR-32d`, which appear only in their own retirement notice**
(mechanically checked). Net: +3 (MR-1b, MR-34c, MR-41), −2 (MR-32c, MR-32d), one restated (MR-9c),
one re-pointed (MR-32b), one widened (MR-22b), one absorbed (MR-32b2 into MR-32b's honest scope).

**Interaction pass over the complex's pairs, final.** Nine pairs, two defects:
- *`observedAfter` domain × the dedupe key* — three rows maximum; every "bounded/not bounded" claim
  in D13a(c) re-derived from the two together. ✓
- *`observedAfter` domain × `ignoredRecordedInSession`* — the flag's pool-level job is subsumed by
  the key, leaving only the session-log job. Flag kept, T8's use of it deleted, type comment
  updated. ✓
- *dedupe key × the terminal marker* — the marker's only surviving correctness claim is the
  `ignored`-then-later-`complied` pair (a different key) and its ledger mark. ✓
- *terminal marker × the ended-session predicate* — **DEFECT (unstated composition):** the pass
  writes into the log it closes, so that log's mtime leaves the ended set and every same-day `index`
  skips it regardless of the marker. This is why criterion 4b's same-day leg cannot kill MR-32b, and
  it is now stated at both ends.
- *ended-session predicate × `utimes` back-dating* — back-dating is fixture setup, not a clock
  override, and it is what makes S2, criterion 4b(ii) and criterion 4d executable through the
  binary. ✓
- *the n = 8 pool × the e2e's `--session` loop* — eight sessions × (check, re-check) is path S1 and
  needs no time control; the e2e now asserts the per-`sessionId` row count so a collapse is visible.
  ✓
- *D9's `_root` arm × the naming-table test* — the forbidden-token list is what makes the arm
  killable at all; adding the arm without adding the token would have left M3 half-fixed. ✓
- *M1's tie exposure × T3 Step 1's equivalence harness* — the harness drives an unmodified mined
  file, so every scope resolves by sticky lookup and the tie is unreachable there. Stated at both
  ends rather than left as an assumed gap. ✓
- *D25 × T10's byte-identical baseline (criterion 1)* — **DEFECT:** T10 criterion 1 pins `status`
  output to a761dda bytes, and D25 changes `index` output, not `status`; the two do not collide, but
  the Files line had to say which function each step edits or an implementer would read criterion 1
  as forbidding Step 6. Now split explicitly (`renderRootsStatusInner` for Steps 1-4,
  `ROOTS_SCAFFOLD_MESSAGE` for Step 6).

### Round 9 — what the ninth adversarial review changed (0 blocking, 2 major, 7 minor)

**D13a held under full independent re-derivation** — the review re-derived §9.10's and §18.1's field
domains, the five-transition lifecycle, the ≤3-rows bound, both producible demotion paths and all
eight Wilson figures from the spec rather than from the plan, and found the substance correct. Both
majors are **executability** gaps: a mandated measurement the named tool cannot produce, and a
criterion whose recipe omits the one step that makes it discriminate.

- **M1 — the mandated per-file prompt-margin measurement is not obtainable from the named tool, and
  a design fallback is gated on it.** `scripts/prompt-headroom.mjs` takes **no arguments**
  (`process.argv` appears once, at `:576`, only to detect direct invocation) and prints, per tier,
  the largest assembled prompt plus the next two and a summary (`:558-565`). Six sites ask it for a
  *specific file's* number: T2 Step 1's pre-edit baseline, T2 Step 6's before/after report, D4's
  `m1` fallback gate, and T5/T6/T7/T9's four `roots-check.ts` obligations — the four the plan
  deliberately gave owners so the figure would not be "a global note nobody owns". None of those
  files is inside the top three, so the tool answered none of them.
  **Resolved by landing the instrument, not by weakening the rules — T1 Step 6 adds an optional,
  repeatable `--file <path>` query mode**, and Global constraints names it once so all six sites
  inherit it. The fork was decided on three grounds, all checked at source: the alternative
  mechanism (hand-writing a 1-char ceiling into the gitignored `yg-secrets.yaml`, running
  `check --details`, grepping, restoring) is *exactly what this script already automates behind a
  four-signal restore* (`:16-26`, `:33-45`), and six task steps re-implementing that by hand is the
  opposite of this plan's discipline; the data is already in hand at the print site (every parsed
  entry carries `unitKey` as `file:<path>`, plus `chars`, `aspectId`, `tierName` —
  `prompt-headroom.mjs:249-254`); and the graph cost is **zero** (`scripts/*.mjs` is already mapped
  by the `scripts` node, type `build-script`, `relations: []`, aspects
  `source-no-raw-control-chars` + advisory `repo-check-gate-steps`, `yg-architecture.yaml:442-454`).
  **"The margin" is now defined once** — the ceiling minus that file's *largest* assembled prompt,
  since one file can appear in several LLM pairs — with **MR-1c** killing the comfortable
  misreading, criterion **8** pinning it on a two-pair fixture, and criterion **8b** guarding the
  no-argument output byte-for-byte because `scripts/repo-check.sh:209`'s reported figure *is* that
  output. A path binding no LLM aspect is reported as having no margin, and every rule that reads a
  margin is declared inapplicable to it rather than satisfied by it.
  **The 2000-char trigger is left as it is, and is now backed by a prediction.** Re-measured live
  on today's tree (`node scripts/prompt-headroom.mjs`, reproducing 1198 pairs and margins
  657/660/849 exactly): a `roots-engine` file has exactly **one** LLM pair, `deterministic`
  (`reviewer.type: llm`, `per: file`, content.md **1 182 B** — `source-hygiene` is an `aggregate`
  whose six children are all deterministic, so it contributes no prompt), which by the section's own
  `file bytes + aspect bytes + ~1.8 K` relationship puts `roles.ts` near **14 600** and `mine.ts`
  near **13 400**. T2 Step 1 now says a measured figure anywhere near 2 000 is itself a **STOP**,
  not a quiet fallback — the prediction makes the measurement falsifiable rather than replacing it.
- **M2 — criterion 4b(i) could not discriminate the marker from MR-32b.** `health.ts` applies
  nothing; the terminal `'closed'` event is a **returned value**, and the marker's only effect is on
  a *later fold* of that session's events. Two calls "over the same fixture" therefore feed call 2
  an event stream with no marker in it under both the correct implementation and the mutant, so both
  return a `complied` sample and a ledger mark and the criterion's expectation is false for the
  correct code. **The missing step is now stated: call 2's session-event input is call 1's input
  plus the terminal event call 1 returned — the unit test performs the apply the command layer
  performs in production**, and nothing else about call 2's input differs, so the marker is the only
  variable. MR-32b re-verified under the clause and now says outright that a same-input version of
  the leg would let the mutant live. **The same feedback shape was checked everywhere the
  aggregation runs twice**, and criterion 4b now carries the requirement once for all three of its
  legs: the two e2e legs get it free (the command layer really applies), the unit leg must do it
  explicitly. No other site calls the aggregation twice — 4c mixes producers but asserts on files,
  4d and 3b are single runs, and criterion 6's `status` applies nothing by design.

**Minor** — all 7 applied: the two live pointers to "T8 Step 2 rule 2" (a rule round 8 renumbered)
now read "T8 Step 2b's terminal-marker rule" — they sat in R5-I13 and in D13a(c), the two documents a
task is told to trust literally; **criterion 8c** now states the fixture property that makes rung 2
the answering rung (both scopes carry **no `assignments` entry** — added to an already-mined file
*after* `index` ran, since `induceRoles` writes an entry for every eligible scope it saw
(`roles.ts:983`) and an edited body does not move `skeyR`), together with the two constraints that
keep it constructible (the new method must clear rung 0's eligibility gate, and living in an
existing file in an existing directory is what keeps `routePartition` answering without a new
routing entry); **MR-9c** drops its ambiguous second mutation ("the position in a locally re-sorted
copy" reads most naturally as re-sorted by `roleKey`, which is the no-op the same bullet retires) and
keeps the unambiguous reversal alone; **T2 criterion 4b(v)** gains its sizing — `repoBucketSurvives`
is `mergedCount ≥ 300` over **only the sub-floor keys** (`partitions.ts:257-275`), so the case needs
two distinct sub-floor buckets summing above the floor or its entry is `null` and the criterion
fails looking like a routing bug; two anchors corrected (`minOwnFeatures` is
`config-parser.ts:136`, **not** `:135`, which is the neighbouring `minClusterSize: 3` — a repair
introduced by round 6's own correction; and §9.4i's label sentence is `v6-spec.md:428`, the
section's closing sentence, not `:429`); D13a(b)'s Writer column for transition 1 is corrected from
T7 to **T6's `applyBudgetsAndDedup`** with T6's NON-goal narrowed to "closure telemetry and the
ledger (T7)" and T6 added to D13a's own list of restating documents; and **R5-I15** now flags its
§21.1 divergence in the D10 register — `v6-spec.md:719` is cited as the text the invariant *departs
from*, not as its authority, with the corrupt-session-file case named as the one §21.1 puts on the
incident side and this plan deliberately absorbs.

**Also fixed, from the review's "checked and did not raise" list:** the gate matrix's "the *only*
`lstat` outcome on `q` that is not [a drop]" is restated positively — the two admitted outcomes are
**absent** or **a regular file**, every other dirent kind is a drop.

**Not applied:** none. All nine findings were verified against their cited authority before being
acted on — the script's argument handling and output block, `roles.ts:983`/`:1030`,
`partitions.ts:257-275`, `config-parser.ts:131-140`, `v6-spec.md:428`/`:479`/`:681`/`:719`, and
`scripts/prompt-headroom.mjs:249-254`/`:558-565`/`:576` — and all nine held.

**Sweep A (decisions vs restatements), scoped to rounds 8-9.** The prompt-margin mechanism → Global
constraints (named once), T1 Step 6 (landed), T2 Step 1, T2 Step 6, D4's fallback, T5/T6 Step 6,
T7 Step 5 and T9 Step 6 ✓ — **eight sites reconciled to one command form**, which is what the "name it once so
all six inherit it" instruction requires. D13a → T6 (newly added to the list), T7, T8, D14, R5-I13 ✓.
D9's three arms → T3 Step 6, `VerdictFact.partitionId`, T4 criterion 3b, T4 Step 6 ✓ (untouched this
round, re-checked). D25 → T10 ✓. **One defect found by this sweep:** the four `roots-check.ts`
obligations were textually identical in three places and one more in T2's neighbour, so a
find-and-replace risked missing the one whose wording differed; each was checked individually and
all four now carry `--file source/cli/src/cli/roots-check.ts`.

**Sweep B (invariants/MRs vs tasks), scoped to rounds 8-9.** R5-I11's id count refreshed to **68**
(net +1: MR-1c added). R5-I13 and R5-I15 both amended above; R5-I4 ✓ (the script is repo tooling,
not engine code, and `health.ts` still takes its clock as a parameter); R5-I16 ✓ (**no repo-check
step is added or removed** — T1 Step 6 changes what an existing step's tool can be *asked*, not the
17-step list, so the advisory `repo-check-gate-steps` rule is untouched); R5-I12 ✓ (T1's new step
ships with unit criteria 8/8b, and T1's standing "no adopter-visible behavior" e2e note still holds
— a measurement instrument has no adopter flow). **MR ids: 68 live definitions, no duplicates, every
`MR-*` referenced in the task body defined except `MR-32c`/`MR-32d` in their retirement notice**
(mechanically re-checked).

**Interaction pass, scoped to rounds 8-9.** Seven pairs, one defect:
- *`--file` mode × the no-argument gate step* — additive only; criterion 8b is the byte-identity
  guard on `scripts/repo-check.sh:209`'s own reported figure. ✓
- *`--file` mode × the 2000-char fallback* — the trigger is unchanged and now decidable; the
  prediction (≈14 600 / ≈13 400) makes a near-trigger reading a STOP rather than a silent fallback. ✓
- *`--file` mode × a file that binds no LLM aspect* — reported as "no margin", and every margin rule
  is declared inapplicable rather than satisfied. ✓
- *4b(i)'s feedback clause × `health.ts`'s purity* — the clause is the unit test doing what the
  command layer does; purity is preserved, which is why the clause is needed at all. ✓
- *4b(i)'s feedback clause × 4b's other two legs* — **DEFECT:** the requirement was stated only
  inside leg (i), where a reader could take it for a local detail. Hoisted to 4b's opening as a
  statement about every leg, with the note that the e2e legs satisfy it by applying for real.
- *criterion 8c's new-scope fixture × `routePartition`* — an added method in an **existing** mined
  file routes by the same directory prefix as its siblings, so no new routing entry and no re-index;
  a brand-new file would have needed both, and the criterion now says so. ✓
- *criterion 8c's new-scope fixture × rung 0* — a new method that fails `minOwnFeatures` never
  reaches rung 2 either, so the fixture's method must clear criterion 8b's own gate. Stated. ✓

### Round 10 — what the tenth adversarial review changed (0 blocking, 2 major, 5 minor)

Both majors are the same class as round 9's — **executability, not correctness**. The review
re-derived every worked number from the spec (all eight Wilson figures, all six Δ rows, T9's
completeness trio, the 4b(ii) and 4b(v) fixture sizings, criterion 8's margin arithmetic) and
independently reproduced round 9's one-LLM-pair prediction from three live calibration points,
landing `roles.ts` at **14 223–14 752** and `mine.ts` at **13 048–13 577** — the plan's ≈14 600 and
≈13 400 both sit inside the band. Nothing in the derivation moved.

- **M1 — D15 discharged an R5-I11 obligation by pointing at an acceptance criterion that did not
  exist.** D15 waives the *format* divergence killer on the strength of "T7 criterion 7 asserts that
  a mark this path writes is the same mark R4's `releasedMarks` later recognizes and releases".
  T7's criteria were 1, 2, 3, 3b, 4, 5, 6. The waiver therefore removed an obligation and replaced
  it with nothing: a mark carrying a `stableId` from the wrong domain, a `surface` from the wrong
  projection or a `date` from the wrong clock passes T1 criterion 3 and T7 criteria 1 and 5, and is
  invisible to the P5 echo defense forever — with the increment green.
  **T7 criterion 7 is now written, as the pure value round-trip the reviewer prescribed** (no clock
  control, no e2e): write with `appendLedgerMarks(…, markKey)`, read back with `readLedger`, feed to
  `releasedMarks(marks, lifecycle, clockTs, config)` (`weights.ts:250`) with a **`stableId`-keyed**
  `LifecycleIndex` — the call is `rowFor(mark.stableId, mark.stableId)` (`:253`), which the store's
  own header (`:235-244`) tells its caller — and every threshold hit **on the nose**:
  `date '2026-01-01'` (epoch 1 767 225 600), `lastModifiedTs` = the same and `clockTs` = 1 775 001 600
  (2026-04-01) ⇒ `stableDaysOf` exactly **90**, clearing `releaseStableDays` on `<`;
  `lastHumanCommitTs` = 1 768 435 200 (2026-01-15) = exactly `floor(Date.parse(date)/1000) + 14 ×
  86400`, clearing `releaseMinDaysAfterMark` on `>=`. Two negatives flip one input by one day each
  (1 768 348 800 ⇒ not released; `clockTs` 1 774 915 200 ⇒ 89 days ⇒ not released), because
  exact-equality boundaries are the only ones an off-by-one can fail. **MR-29b** kills the seam
  itself (wrong `stableId` domain / wrong `surface` projection ⇒ `rowFor` misses or `markKey` names
  a key nobody looks up), and it is the one mutation MR-29, T7 criterion 5 and T1 criterion 3 all
  structurally cannot see. Its home is a **new sibling** `tests/unit/roots/ledger-release-roundtrip.test.ts`
  under `cli/tests/unit/roots`, which already declares `uses cli/roots/engine` and
  `uses cli/roots/stores` (`yg-node.yaml:287-288`) — a mapping line, no edge.
  **The cross-reference property was then re-established mechanically, as instructed**, and the
  sweep immediately paid for itself: see the sweep results below.
- **M2 — criterion 8b pinned the script's default output against a baseline this increment moves.**
  The summary line embeds `entries.length`, a measurement of *this* graph (1198 today), and R5 adds
  ~34 LLM subjects — 6 `roots-engine` files, 4 `persistence-adapter` stores, `roots-check.ts` × 2
  aspects, ~22 new test files — five of them at T2 alone. Landed as a byte comparison against this
  repository's captured output the criterion is **red from T2 onward**, against an execution
  protocol that commits once per task on a green gate. **Rewritten onto a scratch fixture project
  with a frozen graph** — the shape `prompt-headroom.test.ts` already builds for its signal test
  (`:470-500`) — so the guard tests **the script**, which is what it was always for, rather than
  this repo's pair count, which is not a property of the script at all. The two non-movers are
  recorded too (the script is no LLM subject under `build-script`; the test file's own growth cannot
  reach the top three at ≈35 K assembled against a 849-char third place).

**Minor** — all 5 applied: `scripts/repo-check.sh:127` → **`:209`** at both live sites (`:127` is
the markdownlint step; `:209` is the prompt-headroom `run_step`, and the anchor is load-bearing
because criterion 8b is billed as that step's regression guard); `repo-scanner.ts:98` → **`:99`** at
both live sites (`:98` is the recursive `collectFiles` push; `entry.isFile()` is `:99` — round 7
moved this anchor `:97`→`:98` and the answer was one further on); **R5-I3's trailing sentence
deleted** — it restated verbatim the literal §3.3 rule the invariant had just declared a reasoned
divergence from, three sentences earlier, and a reviewer holding T10 Step 1 against the invariant's
last line would have found a decision-vs-task contradiction, which this plan's protocol turns into a
STOP; **T7's Scope** no longer says "record every message as an intervention" (round 9 moved that to
T6 everywhere except the one line a fresh T7 implementer reads first); and the **`--content` byte
source** now has one prescribed outcome stated in both places — T3 Step 8's totality clause carries
an explicit exception for `p`, its "Second" consequence says why (`p` is in neither set, so a
failure is a run with no input rather than one subject fewer), and T5 criterion 3c now asserts the
incident line rather than only the silence.

**Not applied:** none. Each finding was verified at source before being acted on —
`weights.ts:250`/`:253`/`:108-110`/`:267`, `stores.ts:274`, `repo-check.sh:127` vs `:209` (read at
HEAD), `repo-scanner.ts:88-101`, `prompt-headroom.mjs:567`, and the epoch arithmetic recomputed
(1 767 225 600 / 1 768 435 200 / 1 775 001 600 / 1 768 348 800 all confirmed against UTC dates).

**Sweep A (decisions vs restatements), scoped to rounds 9-10.** D15 → T7 criterion 7 + MR-29b + T7's
Files ✓ (this was M1). The prompt-margin mechanism → all eight sites still carry one command form,
and criterion 8b's baseline is now stated where the test lives ✓. D13a(b) transition 1 → T6 Step 3,
T6's NON-goal, T7's Scope ✓ (T7's Scope was the residue; T7's Steps were already consistent, and
Step 3 was re-read to confirm it names `emissionIntents` as an *input*). R5-I3 → T10 Step 1 and
T10's Authorities line, which now quotes §3.3 as the text diverged from rather than as the rule ✓.
**Full-document mechanical re-validation, as instructed:** every task's criterion list was extracted
and every `T<n> criterion <m>` reference in the body checked against it. **Zero dangling references
now; one was found and fixed beyond the review's list** — R5-I6's closing pointer read
`*(T3, criteria 1, 14 and 14b)*`, and T3's numbered criteria 1-6 are the six rows of its
Δ-arithmetic table, so "criterion 1" resolved to a Δ figure with nothing to do with the invariant.
It names **T3 Step 1's equivalence harness** now. Step references were validated the same way: zero
dangling (`T8 Step 2a`/`2b` are Step 2's labelled `(a)`/`(b)` subsections, and D16.1–D16.5 are D16's
numbered items — both real).

**Sweep B (invariants/MRs vs tasks), scoped to rounds 9-10.** R5-I11's id count refreshed to **69**
(net +1: MR-29b). R5-I11's own converse is what M1 and M2 both turn on and it now has two worked
instances behind it: a waiver pointing at nothing, and a guard whose baseline moves. R5-I3 amended;
R5-I8 ✓ (criterion 7 asserts the wiring of the one committed file R5 adds, which nothing else did);
R5-I12 ✓ (criterion 7 is deliberately unit-level — a value round-trip has no adopter flow, and T7's
e2e already covers the flow that produces marks); R5-I16 ✓ (unchanged). **MR ids: 69 live
definitions, no duplicates, every `MR-*` referenced in the task body defined except `MR-32c`/`MR-32d`
in their retirement notice** (mechanically re-checked).

**Interaction pass, scoped to rounds 9-10.** Six pairs, one defect:
- *criterion 7 × D15's caller-passes-`keyOf` rule* — the round-trip supplies the **real** `markKey`,
  which is what production passes, so the test exercises the composition seam rather than a stand-in.
  ✓
- *criterion 7 × T1 criterion 3* — disjoint by design: T1 pins the store's `date` shape and dedupe,
  criterion 7 pins whether R4 can find the result. Neither subsumes the other, which is why the
  waiver needed this one specifically. ✓
- *criterion 8b's scratch fixture × T1 Step 6's "graph cost: none"* — a scratch project is created
  and torn down inside the test; it adds no fixture directory to this repo's graph and no LLM
  subject. ✓
- *criterion 8b's scratch fixture × the four `roots-check.ts` obligations* — those measure **this**
  repo with `--file` and are unaffected by where the guard runs; the guard covers the default block
  they do not use. ✓
- *the `--content` exception × MR-19's "one catch"* — **DEFECT:** stating the exception only in the
  totality clause would have left the matrix's "Second" consequence and T5 criterion 3c reading as
  two independent rules. All three now cross-reference, and MR-19's claim is untouched because the
  incident is raised by the run's own no-input path, not by a per-file catch.
- *R5-I3's deletion × T10 criterion 1's byte baseline* — deleting a sentence in an invariant changes
  no rendered output; T10 Step 1's refusal to list the two session-scoped modulators is now
  consistent with the invariant's operative sentence instead of contradicting its last one. ✓

### Round 11 — what the eleventh adversarial review changed (0 blocking, 2 major, 5 minor)

Both majors are executability again, and both are **round 10's own repairs failing their second
test**: a killer landed onto a criterion whose inputs are literals, and an e2e leg whose stated pool
cannot be constructed by the recipe above it. Everything else held — the review re-derived the six Δ
rows, all eight Wilson figures, T9's completeness trio, both fixture sizings, criterion 8's margins,
round 10's five epoch constants against the landed `weights.ts`, and the prompt-margin prediction
(reproducing 14 617 and 13 442 against the plan's ≈14 600 / ≈13 400), and re-verified ~95 anchors.

- **M1 — MR-29b was pointed at a criterion that structurally could not observe it, and D15's
  discharge sentence was therefore false.** T7 criterion 7 is "a pure value round-trip": its
  `stableId`, `surface` and `date` are **literals the test chose**, and the `LifecycleIndex` is built
  so that `rowFor(S, S)` hits. **The producer never runs**, so no mutation of the code that decides
  which identity goes onto a mark can move one byte of it — and R5-I11's live round-trip obligation
  would have had the T7 implementer perform MR-29b's mutation, run the test, and find it **passing**.
  **Closed by the reviewer's option 3 plus option 2, because a killer must run the code the mutation
  lives in.** Criterion 7 is now **two legs**: leg A is the literal round-trip, unchanged, with an
  explicit statement of what it can and cannot see (it pins the *seam* — `rowFor`'s two-argument
  shape, `markKey`'s format, the `Date.parse`/`YYYY-MM-DD` arithmetic at its exact thresholds, and
  any store that rewrites a mark on write); **leg B drives `evaluate`'s own
  `closureIntents.ledgerMarks[0]`** — a produced mark, not a literal — through the same
  `appendLedgerMarks` → `readLedger` → `releasedMarks` path, **with the lifecycle index keyed on the
  finding's `stableId` rather than on the mark's own**, which is the whole mechanism: a closure that
  emits `skeyR`, or a `surface` sliced out of `factKey`, produces a mark `rowFor` cannot find. Cheap
  and unit-level, since the engine is pure and `verdict-closure.test.ts` already builds that input
  shape. **MR-29b is re-pointed at leg B** (and says why leg A cannot see it), **MR-29c is added**
  for the store-normalization mutation only leg A can see, and **D15's waiver is rewritten as three
  obligations with three named owners** — the engine's projection (leg B / MR-29b), the store-seam
  contract (leg A / MR-29c), and the whole-domain case where mark and intervention agree with each
  other and are both wrong (**T3 Step 1's equivalence harness**, the only thing in the increment
  that compares against the index itself), with the `date` shape at T1 criterion 3.
- **M2 — T8's non-demotion control could not produce the 5/3 pool it asserts, and executed as
  written passed for the wrong reason.** "The same 8 sessions, but 5 of them fix the scope" inherits
  the demotion leg's recipe, which plants **once**. An intervention opens only when a session's first
  check sees a deviating scope — so the moment the first fixing session's second check lands, the
  scope conforms and stays conforming, every later session warns about nothing, and the pool is
  **one** resolved row. "The fact still speaks" then passes on the `minSamples` floor (n = 1 < 8)
  rather than on `WilsonLB95(5/8) = 0.3057 > 0.3` — the exact passing-for-the-wrong-reason failure
  the control exists to prevent, reproduced inside the control, and the shape D13a(d) says must be
  deleted rather than weakened.
  **The re-plant mechanic is now stated once**, at the top of the e2e block, with its reason (an
  intervention opens only on a session's first check) and its constraint (the same value every time,
  because it must not touch a surface feeding `stableId` — `extract.ts:627-628`, D13a(c)'s rule — so
  all eight interventions share one identity and pool into one `factKey`), **and all three legs
  reference it**: the control re-plants before each session; the demotion leg explicitly needs none
  and says so (the scope is never fixed); the cross-session leg needs none because its one fix falls
  *between* the two `index` runs, after sampling. The control's arithmetic is re-derived as **5
  complied / 3 ignored, n = 8, 0.3057 > 0.3**, and **MR-34d** kills the missing re-plant — pointed at
  the leg's **pool-shape** assertion (8 resolved rows, 5 + 3), because the *outcome* assertion passes
  either way and only the pool shape separates the Wilson bound from the sample floor.
  **Two derived consequences added in the same breath, so the leg is not debugged twice:** the five
  `complied` closures' marks collapse to **one** ledger line under §18.3's `(stableId, surface, date)`
  dedupe on a single test day; and that one *unreleased* mark makes its scope's conforming instance
  echo-shaped at the next `index`, so the fixture's fact needs enough survived conformers to stay at
  or above `mdl.minInstancesRaw` (5, `config-parser.ts:78`) **after losing one**, or the leg fails
  silent for a third, unrelated reason that looks exactly like demotion.

**Minor** — all 5 applied: T10's Files line pointed D25 at **Step 7**; D25 is **Step 6** (D25 itself,
carry-in 1, criterion 6 and MR-41 all said 6 — this was the bare in-task form round 10's sweep did not
cover). **D23 gains `include`/`exclude`** (`config-parser.ts:42-43` — D6's gate 0 *is* these two keys,
`partitions.ts:127-136`, and T3 criterion 14 drives both arms by name) **and `mdl.minInstancesRaw`**
(`:78`, T10 Step 2's withheld predicate; the list already carries the `status`-only
`health.agentShareAlarm`, so "keys R5 reads" is the operative bound) — neither trips the STOP, both
being landed with spec defaults. T1 Step 6's exit-code claim is corrected: the script does **not**
exit 0 on every path — `fail()` exits **1** for a missing binary, a missing config, an unresolvable
ceiling or a parser wording mismatch, and only the normal reporting path exits 0 (`:570`); the rule
the sentence supports is unchanged, but the justification is now true and the text says **not** to
"fix" `fail()`. *(The three anchors this entry carried for those lines — `:451`, `:454`, `:455` —
were themselves wrong and are corrected by round 12 to `:452`, `:455`, `:456`; `:570` was right.)* D1's no-I/O enumeration named
five engine modules; **`extract-file.ts` is the sixth** — the one whose no-read signature D1 itself
spends a paragraph on. And T3 Step 8's "exactly one filter wide" heading now says **at T3**, with the
consequence stated: T5's filter 3 narrows the **evaluation** set only, so a path resolving outside
the repository is silent on stdout yet still recorded as looked-at in `writtenFiles` — harmless (an
out-of-repo path matches no repo-relative co-change row) and now stated at both the fork and its T6
mirror.

**Not applied:** none. Every finding was verified at source first. **Two of the review's own anchors
were judged off by one and the measured values used instead:** `fail()` was recorded as
`prompt-headroom.mjs:451` (against the review's `:452`) and the normal exit as `:570` (against the
review's `:569`) — re-read at HEAD, along with `config-parser.ts:42-43`/`:78`,
`partitions.ts:127-136`, and the `weights.ts` release arithmetic. **One of those two overrides was
itself wrong**: `:451` is `log()` and `:452` is `fail()`, so the review had it right and this round's
"correction" moved a correct anchor and dragged its two neighbours with it. Round 12 restores
`:452`/`:455`/`:456`; the `:570` override was correct and stands.

**Sweep A (decisions vs restatements), scoped to rounds 10-11.** D15 → T7 criterion 7's two legs,
MR-29b, MR-29c, T3 Step 1 ✓ (this was M1, and the sweep is what confirmed T3 Step 1's harness really
does assert `stableId`/`skeyR`/every surface value, which is what lets D15 name it as an owner).
D13a(c)'s same-value fixture rule → the new re-plant mechanic ✓. D13a(d)'s
"unsatisfiable-must-be-deleted" rule → the control leg, which was violating it ✓. D1's no-I/O list →
R5-I4, the Architecture paragraph and the authorization table, all of which already said six ✓.
D23 → T3 criterion 14 and T10 Step 2, the two tasks whose reads it omitted ✓. T3 Step 8's fork →
T6 Step 1b's mirror, which now carries the T5 asymmetry too ✓.

**Sweep B (invariants/MRs vs tasks), scoped to rounds 10-11.** R5-I11's id count refreshed to **71**
(net +2: MR-29c, MR-34d) and its converse now has a **third** worked instance behind it — round 10's
own repair produced a killer that could not fail, which is the failure mode the converse names.
R5-I7 ✓ (D23's two additions are landed keys with spec defaults, so "R5 invents no config key"
holds). R5-I12 ✓ (leg B is unit-level and correctly so — the engine is pure; T7's e2e still covers
the adopter flow). R5-I4 ✓ (D1's enumeration now matches it). **Full mechanical re-validation,
extended as instructed to the BARE in-task `Step N` form round 10's sweep missed** — qualified
criterion refs, qualified step refs and bare in-task step refs, with previous-line joining so a
wrapped "T6 / Step 1b" is not a false positive: **zero dangling in all three classes.** MR ids: 71
live definitions, no duplicates, every `MR-*` in the task body defined except `MR-32c`/`MR-32d` in
their retirement notice.

**Interaction pass, scoped to rounds 10-11.** Six pairs, one defect:
- *criterion 7 leg B × D1's intents seam* — leg B reads `closureIntents.ledgerMarks[0]`, a returned
  value, and applies it itself; the engine still performs no I/O, so leg B is inside R5-I4 rather
  than an exception to it. ✓
- *criterion 7 leg B × leg A* — disjoint observers by construction: the index is keyed on the
  finding's identity in B and on the mark's own in A, which is exactly why one MR can see each and
  neither can see both. ✓
- *the re-plant × D13a(c)'s changed-value rule* — **the two compose only because the re-plant uses
  the SAME value**: a re-plant with a *different* deviating value would move `qualifiedName` only if
  it renamed the scope (it does not), but it would produce eight interventions whose telemetry rows
  differ in `observed` — harmless for the key, yet it would break the "one `factKey`" pooling
  premise if the surface changed. Stated as a constraint on the mechanic rather than left to chance.
- *the re-plant × the ledger dedupe* — five `complied` closures on one test day are one mark, not
  five; the leg now asserts one. ✓
- *the one unreleased mark × §9.4c's survived-display population* — **DEFECT (unstated
  composition):** the mark makes its own scope echo-shaped at the next `index`, so a fixture sized to
  exactly `mdl.minInstancesRaw` conformers drops below the floor and the fact goes silent for a
  reason that is indistinguishable from demotion. The fixture's sizing constraint is now stated.
- *D23's `include`/`exclude` × R5-I7* — both landed with spec defaults, so adding them to the list
  changes what the list *says*, not what R5 *reads*; the STOP is untripped. ✓

### Round 12 — what the twelfth adversarial review changed (0 blocking, 3 major, 5 minor)

All three majors are executability defects of the class the last four rounds have found, and two of
them are **this plan's own long-standing preferences failing a test nobody had run against them**: a
criterion whose only stated home is refused by an enforced aspect the plan itself cites, and a
*preferred* implementation, unchanged since round 1, that breaks three landed assertions in a file
the plan freezes absolutely. The third is an invariant clause that had named a fault for eleven
rounds without ever giving it an owner. Everything else held: the review re-derived the six Δ rows,
all eight Wilson figures, T9's completeness trio, both fixture sizings, criterion 8's margins and
round 10's five epoch constants, and re-verified ~70 landed anchors.

- **M1 — T3 criterion 14b required one test to both spawn the binary and import `src/**`, and its
  only legal home is refused by an enforced aspect.** 14b said "**The same test** calls the landed
  `findNestedProjectRoots(repoRoot)`" while its other five legs drive `yg roots check`.
  `findNestedProjectRoots` is exported from `source/cli/src/io/repo-scanner.ts:229`, and
  `e2e-public-surface` — **enforced**, declared on `cli/tests/e2e` (`yg-node.yaml:5`) and reaching
  every child by node inheritance, not only the node that declares it — forbids any e2e file from
  naming a specifier that resolves under `source/cli/src/` in any form
  (`check.mjs`, `SRC_ROOT = 'source/cli/src/'`). An implementer landing 14b in
  `tests/e2e/cli-roots-check.test.ts` — T3's only spawning file, and the home criteria 14 and 15
  either side of it imply — would have hit a **blocking deterministic refusal at T3's own
  `check --approve --only-deterministic` gate**, with both legal escapes unsanctioned by the plan.
  **Fixed by the split the aspect allows, without losing the two-directional pin, and it turns out to
  cost nothing:** the programmatic fixture builder moves to a new helper under
  `source/cli/tests/support/` (it writes files and imports nothing from `src/**` — the exact shape
  `e2e-public-surface`'s own description sanctions for a shared helper); the five `yg roots check`
  legs stay in the e2e; the `findNestedProjectRoots` assertion lands in
  `source/cli/tests/unit/io/repo-scanner-nested.test.ts`, the file T3 already edits and the one node
  that may legally import it; and "the same test" becomes "**the same fixture**, asserted at both
  tiers", which is what the criterion's own stated reason actually needs. **No new edge in either
  direction** — verified at source, not assumed: the new e2e node declares `uses cli/tests/support`
  (as its landed sibling does) and `cli/tests/unit/support/io` already declares it in its landed
  `relations:` block. The leg additionally has to call `resetNestedProjectRootsCache()`
  (`repo-scanner.ts:218`) first, since the function is memoized per resolved root and that landed
  file already imports the reset. **MR-14f is re-pointed** at both files — still one mutation, now
  failing in two places, which is the shared fixture working rather than an artifact of it. The whole
  document was then swept for any other criterion mixing a spawned-binary step with a `src/**`
  import: **14b was the only one** — T3 criteria 8/8b/8c already name their two tiers and their two
  files, T7 criterion 7's two legs are unit-level by design, and T8 criterion 6 asserts through
  `health.ts`'s returned value.
- **M2 — D4's *preferred* `m1` implementation breaks three landed `toEqual` assertions in a file the
  plan freezes at "not a single character".** Extending `RoleClassification`
  (`roles.ts:335-339`) with `m1: number` changes the return object of `classifyAgainstMedoids`
  (`:351-357`), and three landed assertions pin that object's exact shape —
  `tests/unit/roots/roles.test.ts:162`, `:214`, `:230`, each
  `expect(result).toEqual({ roleIndex: 0, ambiguous: false })`, all three on success paths, all three
  failed by vitest on an extra defined key. That file is one of the three the Global constraints
  freeze at **660** chars of margin. The plan therefore carried a decision-vs-constraint
  contradiction, which its own protocol turns into a STOP, plus three assertions missing from the
  enumeration that exists to stop exactly this being discovered as a mystery failure. The
  margin-gated fallback did not save it: the fallback fires only if `roles.ts` measures inside 2000
  chars of the ceiling, and the plan's own prediction is ≈14 600 — a gate that cannot trip.
  **Fixed by taking the route that touches the frozen file's subject not at all**, which the plan
  already carried as its alternative: `m1` is computed in `exemplars.ts` from the already-exported
  `roleJaccard` (`roles.ts:194`) and `buildRoleFeatureBag` (`:149`), both **intra-node** with
  `exemplars.ts` (`cli/roots/engine`), so the computation costs no graph edge, no byte of `roles.ts`
  and no byte of its frozen test. `RoleClassification` is not extended and
  **`src/roots/roles.ts` is not edited by this increment at all** — recorded as an explicit non-edit
  in T2's Files, because eleven rounds of this plan said otherwise. **The margin-gated fallback is
  deleted rather than inverted**, with its reason recorded: a conditional whose condition cannot hold
  is not a fallback but dead text reporting a safety net the plan does not have — the same failure
  R5-I11 names for killers, applied to a decision. Three consequences, each re-derived rather than
  adjusted: the landed-assertion enumeration **stays at fifteen**, and the three `roles.test.ts`
  sites are named there as the ones the chosen route reaches **zero** of (with the note that a later
  package extending `RoleClassification` inherits them); the `--file` measuring sites drop from a
  list of seven items labelled "six"/"five" in four places to **exactly six**, now enumerated by name
  (T2 Step 1, T2 Step 6, T5 Step 6, T6 Step 6, T7 Step 5, T9 Step 6); and T2 Step 1's pre-edit
  baseline narrows to `mine.ts` alone, since there is no longer a `roles.ts` edit to take a baseline
  for. Round 3's `structural-cycle` argument was re-checked under the new import and holds:
  `exemplars.ts → roles.ts` is intra-node, so `roots/speech` still has one outbound edge and no back
  edge.
- **M3 — R5-I15's fifth absorbed fault had no owning task, no criterion and no killer, and both
  landed helpers refuse it.** R5-I15 lists five faults each absorbed into "one `debugWrite` and a
  continued run, with findings still emitted and no incident recorded"; R5-I2's enumeration listed
  **four** and assigned each an owner. The fifth — an `EACCES` on a `.state/` append — appeared in no
  T1 step, no T1 criterion, and no T5 leg, and the landed write path refuses it outright:
  `appendToDebugLog` is `appendFileSync(filePath, text, 'utf-8')` and nothing else
  (`debug-log-writer.ts:7-9`), so the throw would have reached R5-I2's single catch and produced
  "zero findings plus exactly one incident" — the opposite outcome, for the same input, in the one
  pair of invariants the plan says are disjoint by construction. The read side had the same hole:
  "an unreadable `demotions.json`" is R5-I15's own second fault, and `readFileOrDefault` rethrows
  every non-ENOENT error by documented contract (`read-or-default.ts:5-6`), while T1 criterion 5's
  four cases are all malformed *content*.
  **Decided on the spec's own text rather than by removing the clause.** §21.1 puts the incident on
  "any hook **throw**" that reaches the boundary and lists faults R5-I15 already declares a departure
  from; its neighbouring clauses prescribe degradation for the ones it does not put on that side
  ("store corrupt ⇒ degraded"; "a blob that fails to parse is recorded as empty and the walk
  continues", `v6-spec.md:719`). §18.2 fixes the direction for losing exactly this class of local
  derived state, in its own words: "a lost demotion resurrects a FACT, never falsely silences one"
  (`:683`). And D14 writes the **output first**, so by the time any `.state/` append can fail the
  message is already on stdout — a catch reporting "zero findings" would describe a run that in fact
  spoke, and would try to record its incident in the directory that just refused a write. So the
  fault gets a real owner: **T1 Step 3 gains its I/O half** (every reader returns its
  empty/`undefined` answer on **any** read failure, not only ENOENT and not only a parse error, with
  the note that wrapping `readFileOrDefault` in a try/catch trips no aspect — `read-or-default-via-helper`
  fires only on `/\breadFile\s*\(/` **plus** an `'ENOENT'` handler, `check.mjs:36-48`), and **new T1
  Step 3b** states the writer contract (every writer swallows its own failure to one `debugWrite` and
  returns normally; a failed append loses derived state, which R5-I15 permits, and may never lose the
  run's findings or mint an incident), with `appendLedgerMarks`' committed target called out as the
  one different-but-consistent case. **New T1 criteria 5b and 6c** observe the two halves and are
  their own killers, in the pattern criterion 6b already uses. **T5 criterion 4b goes from four
  absorbed faults to five** and **MR-19b names the writer arm explicitly**, so R5-I15's fifth clause
  finally has a killer. **R5-I2's enumeration goes from four to five** and R5-I15 now names an owner
  for each of its five, since "absorbed by construction" is only true if something absorbs it — and
  two of the five are absorbed by contracts this round had to *add*. The fixtures were chosen better
  than the review proposed: a **directory** at the target path throws `EISDIR` for every user, so
  both new criteria and 4b's fifth leg need no `chmod` and are **not** skipped under root, and — the
  point that matters for 4b — `.state/` itself stays writable, so "records zero incidents" is a real
  assertion rather than one satisfied by the incident file being unwritable too. The chmod arms are
  kept beside them, skipped where the suite already skips its chmod cases under root.

**Minor** — all 5 applied.
**(1) Three off-by-one anchors in T1 Step 6, two of them introduced by round 11's own "correction".**
Measured at HEAD: `:451` is `log()`, **`:452` is `fail()`**, `:455` is the missing-binary check and
`:456` the missing-config check; `:567`, `:570` and `:576` are right. Round 11 recorded the review's
`:452` as wrong and replaced it with `:451`, dragging the neighbouring two back with it — so a
correct anchor was overwritten and the entry saying so was itself false. The anchors are restored to
`:452`/`:455`/`:456`, and **round 11's changelog is corrected in place** (the same treatment round 11
gave round 6's `inducePartitionRoles` entry) so the record does not keep asserting a wrong anchor.
The anchor is load-bearing because the same sentence tells the implementer **not** to "fix" `fail()`
to exit 0.
**(2) T1 Step 6's query-block placement contradicted criterion 8b's prefix identity.** Step 6 said
"after the existing per-tier block", which ends before the summary line at `:567`, while 8b requires
the per-tier block **and** the summary line to be the `--file` run's byte-identical first N lines.
The placement is now stated as a rule with its reason: after `:567`, before `process.exit(0)`
(`:570`) — the last thing printed — and the paragraph explains what the literal reading would cost.
**(3) The aspect inventories were type-level only and stated as complete.** The "seven" `command`
aspects and "five" `src/io/` aspects are both correct as type-level lists and are not the effective
set: four enforced aspects are declared on the **`cli` node** and reach every descendant by node
inheritance (`wasm-tree-lifecycle`, `events-reader-boundary`, `instrument-import-fence`,
`rules-artifact-names-single-source`), and a fifth, `no-buildissuemessage-in-engine`, is declared on
`cli/io`. Measured live: `yg context --node cli/commands/roots` reports **18** and
`--node cli/io/stores` reports **16**. Both counts are now scoped as type-level, the inherited
aspects are enumerated once in the Global constraints' aspect bullet, and the two with teeth are
named: **`wasm-tree-lifecycle`** (the single-file parse path must go through `withParsedFile`, never
`parseFile` — D6's gate 5 already complies, but `extract-file.ts` is precisely the file an
implementer would reach for `parseFile` in, and T5 criterion 4b even discusses `parseFile` throwing)
and **`no-buildissuemessage-in-engine`** (the four new stores return data; the command layer
renders — the one that cuts against the CLI message rule's habit).
**(4) D5's module-root reconstruction was written over "which arm matched".** `routePartition`
returns `string | null` and cannot report that, while D5 forbids a second copy of the arm walk — so
an implementer needing `moduleRootDirOfFile` for D6's synthesized `PartitionMap` would have written
exactly the second matcher the decision exists to prevent. It is derivable from the **resolved id
alone**, because an own-floor key's final id *is* that key (`finalId = status === 'own-floor' ? key
: '_repo'`, `partitions.ts:284`) and the landed line is
`moduleRootDir = finalId === '_repo' ? '' : key === '_root' ? '' : key` (`:291`). The rule is now
`moduleRootDir = (id === '_repo' || id === '_root') ? '' : id`, with all four cases checked out by
hand (merged ⇒ `''`; own-floor `_root` ⇒ `''`; a root-level package's own-floor id is `''`, which is
also its `dir`; every other own-floor id is the matched `dir`) and `null` noted as silence with no
module root to reconstruct. Restated identically at D6 and at T2 Step 3.
**(5) One dangling qualified step reference** in the round-9 changelog, which listed the four
`roots-check.ts` headroom obligations as T5, T6 and T7 all at "Step 6" plus "T9's step". T7 has
Steps 1-5 and its headroom obligation is **Step 5**; T9's is Step 6. The list now reads
"T5/T6 Step 6, T7 Step 5 and T9 Step 6", and the same four are enumerated that way in Global
constraints.

**Not applied:** none. Every finding was verified at source before being acted on — the three
`prompt-headroom.mjs` line numbers, the three `roles.test.ts` assertion lines and
`RoleClassification`'s two anchors, `e2e-public-surface`'s `SRC_ROOT` and its declaring node,
`repo-scanner.ts`'s exports and the memoization reset, both landed relation blocks that make the
14b split edge-free, `read-or-default.ts:5-6`, `debug-log-writer.ts:7-9`, `partitions.ts:284`/`:291`,
and the live `yg context` aspect counts. **Two of the review's own remedies were improved on rather
than taken verbatim, both stated inline:** M2's first option (add the three sites to the enumeration
and grant a bounded exception to the freeze) is rejected in favour of its own alternative, because
the freeze is stated absolutely and the route that honours it costs nothing; and M3's chmod-based
fixtures are replaced by `EISDIR` fixtures that run under root and, in T5 criterion 4b's case, keep
`.state/` writable so the "zero incidents" assertion is not vacuous.

**Sweep A (decisions vs restatements), scoped to rounds 11-12.** D4's `m1` route → the edge table's
speech row and engine row (the latter gaining `exemplars.ts → roles.ts` as intra-node), Global
constraints' prediction and measurement paragraphs, T2's Files, T2 Step 1, T2 Step 6, T2 Step 1's
fifteen-site enumeration ✓. D6's gate −1 and the `findNestedProjectRoots` home → criterion 14b, T3's
Files, MR-14f, the edge table's `roots-check` row (which described the caller as "criterion 14b's
*test*" and now names the tier and the reason) and its e2e row (which now names the aspect's
declaring node) ✓. R5-I15's five faults → R5-I2's enumeration, T1 Steps 3 and 3b, T1 criteria 5b and
6c, T5 Step 3 (which still said "all four"), T5 criterion 4b, MR-19b ✓. D5's module-root rule → D6's
`finalizeUnits` paragraph, T2 Step 3 ✓. **Two drifts found by this sweep and repaired, neither
review-flagged:** T5 Step 3's "do not verify it by …: all four are absorbed" was still a
four-item list after R5-I15's fifth gained an owner; and the `--file` measuring-site count was stated
as "six" in two places and "five" in three others while the enumeration behind it held seven items —
re-derived to six and enumerated by name, with the retired seventh (D4's fallback gate) named as
retired.

**Sweep B (invariants/MRs vs tasks), scoped to rounds 11-12.** **MR ids: 71 live definitions, no
duplicates, every `MR-*` referenced in the task body defined except `MR-32c`/`MR-32d` in their
retirement notice** — mechanically re-checked, and **the count does not move**: this round added no
killer and retired none. MR-14f was re-pointed across the 14b split, MR-19b widened to name the
writer arm, MR-1c reworded off the deleted fallback gate onto the split trigger and T2 Step 1's STOP.
R5-I11's "(71 ids at present)" is therefore unchanged, and its converse gains a **fourth** worked
instance: a *decision's* fallback that could not fire, which is the same defect as a killer that
cannot fail. R5-I2 and R5-I15 both amended above and re-checked against each other — the two lists
are five and disjoint, and every one of R5-I15's five now names the contract that absorbs it. R5-I4 ✓
(`exemplars.ts` computing `m1` from `roleJaccard` reads no file and no clock; the new T1 writer
contract is in `src/io/`, which carries no `deterministic`). R5-I12 ✓ (14b's five spawned-binary legs
stay in the e2e; the moved leg was never an adopter flow). R5-I16 ✓ (no repo-check step added or
removed). **Full mechanical re-validation of all three reference classes** — qualified criterion refs,
qualified step refs, and bare in-task `Step N`, with previous-line joining so a wrapped reference is
not a false positive: **zero dangling in all three.** Counts touched: T1 goes from 8 steps to **9**
(Step 3b) and from 12 acceptance criteria to **14** (5b, 6c); T5 criterion 4b from **four** absorbed
legs to **five**; R5-I2's enumeration from **four** to **five**; T2's Files loses one edit bullet and
gains an explicit non-edit.

**Interaction pass, scoped to rounds 11-12.** Ten pairs, one defect:
- *14b's split × `e2e-public-surface`* — the builder lives under `support/` and imports nothing from
  `src/**`, which is the shape the aspect's own description sanctions; the e2e legs name no `src/**`
  specifier at all. ✓
- *14b's split × the edge audit* — edge-free in both directions, checked against both landed
  `relations:` blocks rather than assumed. The new support file joins `cli/tests/support`'s mapping,
  so `unmapped-files` (blocking under `coverage.required: ["/"]`) cannot fire on it. ✓
- *14b's split × `findNestedProjectRoots`' memoization* — the unit leg must reset the per-root cache
  first, or it can read another test's answer and pass or fail for a reason unrelated to the
  predicate. Stated in the leg. ✓
- *D4's exemplars route × round 3's `structural-cycle` fix* — `exemplars.ts` and `roles.ts` are both
  `cli/roots/engine`, so the new import is intra-node and `roots/speech` keeps one outbound edge and
  no back edge. The cycle argument is untouched. ✓
- *D4's exemplars route × the ESLint genericity fence* — `src/roots/` → `src/roots/` is on the
  allowlist, so the import is legal at lint as well as at the graph. ✓
- *T1 Step 3's I/O tolerance × `read-or-default-via-helper`* — the aspect needs a `readFile(` call
  **and** an `'ENOENT'` handler in the same try/catch; a wrapper around `readFileOrDefault` has
  neither. Checked against the regex, not against the aspect's title. ✓
- *T1 Step 3b × D16.4* — **DEFECT (unstated composition):** D16.4 forbids the aggregation path from
  creating anything eagerly, and Step 2b requires every other writer to `mkdir` before its first
  write; a new rule about what happens when a write *fails* reads as a third, conflicting
  instruction unless it says which of the two it sits beside. Step 3b now states that it governs the
  failure of a write already decided on, and that a failed `mkdir` is a write failure like any other.
- *T1 Step 3b × D14's write order* — output is written before any append, so an append failure cannot
  cost a printed finding; that is what makes "no incident" honest rather than lossy, and it is the
  concrete reason the literal §21.1 reading misdescribes this case. ✓
- *T1 criterion 6c × T5 criterion 4b's fifth leg* — deliberately different fixtures for different
  subjects: 6c may make `.state/` read-only because its subject is the store, while 4b must keep
  `.state/` writable (a directory at `telemetry.jsonl` only) or its "zero incidents" assertion would
  pass because the incident file was unwritable too. Stated at both ends. ✓
- *the inherited-aspect enumeration × D6's gate 5* — `wasm-tree-lifecycle` is satisfied by
  construction, because gate 5 already specifies `withParsedFile`; naming the aspect changes no
  design and exists so the compliance stops being accidental. ✓

### Round 13 — what the thirteenth adversarial review changed (0 blocking, 2 major, 5 minor)

Both majors sit in a seam no round had audited end to end: **what each pipeline stage can actually
construct from the parameters D1 hands it, and which layer is allowed to perform each thing a
decision requires.** One stage was assigned two record types it structurally could not build; one
decision's fifth bullet described behaviour that could not live where the pipeline put it and that
no task, criterion or MR owned. Round 12's three repairs all held under re-derivation, as did the
six Δ rows, the eight Wilson figures, T9's completeness trio, both fixture sizings, criterion 8's
margins, the five epoch constants and the three live prompt margins (657 / 660 / 849, reproduced
byte for byte).

- **M1 — `applyBudgetsAndDedup(findings, fold, config)` was assigned §18.1's intervention row and
  the `'warned'` session events, and its parameters carried neither a session id nor a clock.** Both
  records require a `ts`; `TelemetryRecord` additionally requires a `sessionId`; neither field is
  optional in T1's declared shapes and neither is reachable from what the stage is handed —
  `Finding` carries every *content* field and no clock and no identity, `foldSession`'s result
  carries no session id (the id is a *parameter* of the fold, not a field of its result) and no
  timestamp, and `RootsConfig` carries thresholds. R5-I4 then closes the only escape by naming
  `session-state.ts` among the six modules that read no clock and derive no identity. That is a
  contradiction inside D1 itself, and a `tsc --noEmit` failure on T6's first build rather than a
  judgement call — the mirror of round 7's M1 one stage later, and the round-7 fix's own sentence
  ("every later task adds *data*, never a new parameter") is scoped to `VerdictInput` and never
  covered this signature.
  **Closed at the contract, not by an implementer widening it under protest.** D1's pipeline block
  now declares `applyBudgetsAndDedup(findings, fold, config, { sessionId, nowIso })`, with a
  paragraph at the declaration saying what the two values are (the *same* pair `VerdictInput`
  carries — one identity resolution and one clock reading per run, both `src/cli/roots-check.ts`'s),
  why they cannot come from anywhere else, and that the argument list is now whole. T6 Step 3
  restates the signature and the reason where the function is built; D1's neighbouring sentence
  about the `'checked'` event, which said the stage "sees only `findings`", is corrected to "its only
  view of the run's *subjects* is `findings`" so the two paragraphs stop disagreeing. Transition 1's
  Writer cell is unaffected (T6 still writes the row), R5-I4 is unaffected (the clock is still read
  exactly once, in the command layer), and T6 criterion 4c and MR-1b assert through the applied
  `Intents` and are unaffected by the widening.
  **The instruction was to walk EVERY writer in D13a's table, not only the one the review found —
  and there was a second.** D13a(a) promises `severity` and `deltaBits` "as emitted" on the closure
  row, and no closure producer could honour it: the `'warned'` session event carried `severity` but
  **no `deltaBits`**, `OpenIntervention` carried neither, and so both T7's in-session closures and
  T8's terminal pass would have had to *recompute* the pair — which on the `complied` arm yields
  Δ = 0 (the observed value **is** `expected`) rather than the gap the agent was actually shown, and
  which would have put a second copy of D7's arithmetic in `verdict.ts`'s closure and a third in
  `health.ts`, a module that would then have needed `counts`/`alphabet` and `isBooleanSurface` for a
  field nothing reads. **Fixed at the two definitions:** T1's `'warned'` arm carries `deltaBits`
  beside its `severity`, and T3's `OpenIntervention` carries both forward, so every closure producer
  *copies* the emitted pair off the fold and computes nothing. T7 Step 2 and T8 Step 2 restate it
  where they write. The same walk corrected one more cell: the closure row's `factKey` was written
  as "identical", which T8's pass cannot honour — it resolves the fact **forward** (Step 1) and
  necessarily emits the current key — so the cell now states both cases and notes that §18.2
  re-resolves at pooling time either way, making the stored string a record rather than a pooling
  key. A short derivability note under the table records the walk, so the next round audits it
  rather than re-deriving it. Every other field of every other writer checks out: the three closure
  identity fields off `OpenIntervention`, `observed` from `surfaceValue` (T7) or the current index
  (T8), the closure `sessionId` from `VerdictInput` (T7) or the log's file name (T8), the closure
  `ts` from `nowIso` (T7) or `nowMs` (T8), both ledger marks' `YYYY-MM-DD` from the same two clocks,
  and all five session-event kinds from the command layer that holds the clock.
- **M2 — D4's render-time exemplar re-validation had no owning task, no step, no criterion and no
  killer, and the stage the decision named may not perform it.** D4 decides the mechanism (a
  file-existence check, not a re-parse) and the fallback (render without the `See:` line), on real
  authority — §9.11 (`v6-spec.md:484`) and design §12's productionized row
  (`integration-design.md:454`). Nothing built it: T2 is index-time and correctly does not own it,
  T3 Step 6 renders the `See:` line without validating its paths, T4 Step 3 enumerates every note
  the template can carry and does not carry the suppression, no criterion asserts the
  deleted-exemplar case (T3's e2e asserts only the positive direction) and no MR kills its absence.
  And the named home refuses it: D1 puts rendering in `speech.ts`, which carries `no-direct-fs`
  (R5-I4, `yg-architecture.yaml:749-755`), so "render-time" cannot mean "in the renderer". Under the
  execution protocol a fresh T3/T4 implementer would have shipped `See:` lines pointing at files
  that no longer exist — the product's most literal promise turned into three dead paths, with
  nothing in the increment able to notice. It is round 8's M4 shape applied to a decision that had
  never been given a home.
  **Given the only home the architecture allows, verified at source rather than assumed.** The check
  needs the filesystem; `command` carries neither `no-direct-fs` nor `deterministic`
  (`yg-architecture.yaml:49-57`), the `cli` node's four inherited aspects ban no such thing, and the
  command layer already `lstat`s every candidate path in T3 Step 8 — so the filter is a **step of
  the `VerdictFact` projection** in `src/cli/roots-check.ts`: each `MinedFact.exemplars` entry
  survives only if `<repoRoot>/<rel>` still exists as a regular file, and a failing `lstat` is a
  drop rather than an exception, the same totality rule Step 8 already states. **Placing it in the
  projection rather than immediately before `render` is what makes the renderer need no new rule at
  all**: "no `See:` line when `exemplars` is empty" is behaviour it already owes a fact with no
  conformers (T2 criterion 2), so the fallback D4 decides falls out instead of being implemented
  twice. Landed at five sites: D4's bullet names the owner, the mechanism and the three rules; **D9's
  projection paragraph goes from three non-copy fields to four**, which is the enumeration that
  exists precisely so none is discovered later; `VerdictFact.exemplars`' comment becomes "the
  surviving subset"; **new T3 Step 7b** owns the projection and the filter; T3 Step 6 states the
  renderer's half (it renders what it is handed and validates nothing); and T4 Step 3 names the
  `See:` switch as the one thing that looks like a note and is not, so its enumeration reads as
  complete. **New T3 criterion 16** deletes every exemplar file between `index` and `check` — read
  out of the committed `model.json`, so the fixture guesses no path — and asserts the message
  renders with its first three lines byte-identical and **no** `See:` line, paired with the
  one-surviving case that a "drop the whole list" implementation fails. **New MR-14g** kills the
  filter's removal and states why it is not MR-14d (14d is about the *subjects* a run looks at and
  presents as silence; 14g is about the *evidence* a message shows and presents as a message
  pointing at nothing). T2's Authorities line now scopes design `:454` explicitly — T2 lands the
  ranking half of that row, T3 Step 7b the re-validation half — so no T2 implementer goes looking
  for a check time that task cannot reach. Two invariants were checked rather than assumed: R5-I9 is
  untouched (the filter removes entries from one fact's evidence list and never orders or truncates
  *findings*) and R5-I18 is untouched (the committed `model.json` keeps all three; only an in-memory
  projection narrows).

**Minor** — all 5 applied.
**(1) MR-19b promised an observable D14's own write order rules out on one of its two arms.** For the
four read-side faults the run genuinely produces nothing, so "the deviating file's finding
disappears" is right. For the **writer** arm it is not: D14 writes the output first, so by the time
the append throws the message is already on stdout (T1 Step 3b's own third reason), and what fails
is criterion 4b's **zero-incidents** assertion. An implementer performing R5-I11's live round-trip
would have found the finding still printed and could have read a live mutant as dead. MR-19b now
splits its stated failure by arm and closes the loop on why 4b's fifth leg keeps `.state/` itself
writable.
**(2) T3's Files claimed the seven-case boundary table is asserted by no landed test; six of the
seven already are.** Measured at HEAD: the empty-`.yggdrasil/` pair and its real-file control at
`repo-scanner-nested.test.ts:97-154`, and the empty-`.git/`, garbage-`.git` and empty-`.git`-file
cases with both controls at `:173-233` — all driven through `findNestedProjectRoots`. Only the
`.git` **symlink** case is genuinely new (`grep -n symlink` over that file returns nothing). The
table is still worth landing, and the bullet now says what is new about it: the **subject**. The
landed six run at the whole-walk level; re-asserting them against the newly exported
`isNestedProjectBoundary` is what pins the extracted function so it cannot drift from the walk that
used to contain it.
**(3) The "full new-edge audit" omitted the two existing unit-test nodes that gain edges**, while
carrying a row for the new e2e test node — so test nodes were in scope and two were missing, both
gaining edges to nodes this increment creates. Two rows added, with counts stated the way the
`cli/commands/roots` row states 10 → 13: `cli/tests/unit/roots` **13 → 15**
(`→ cli/io/roots-state` for T1's four store tests, `→ cli/roots/speech` for six later tasks' tests)
and `cli/tests/unit/cli/roots` **7 → 8** (`→ cli/commands/roots-check`, the file `sibling-test-file`
requires), the second stated as a floor rather than a prediction since a test may reach a further
node for a *value*. Nothing breaks — `test-suite` declares no type-level relation allow-list
(`yg-architecture.yaml:418-431`), both counts stay far under `max_direct_relations: 20`, and neither
node is among the six the fan-out leaderboard pins (`portal-derive-rest.test.ts:69-80`; the pinned
`cli/tests/unit/cli/general` at 32 is a different node) — but the same omission was round 4's M6
when a count moved. The ownership paragraph, which discussed mapping only, now says in one clause
that both nodes' `relations:` blocks grow too and points at the table.
**(4) `cli/tests/support`'s node description enumerates its files, and T3 adds a fifth.** That
node's landed `description:` reads "A **fourth** file builds the shared branch-and-merge fixture …
**All four files** import only Node builtins", so it goes false the moment T3's fixture builder is
mapped — the same way T2 tracks `mine.ts:155-160`'s "STRUCTURALLY ABSENT" comment as a sixteenth
site. The graph ritual covers mappings, relations, ceilings and log entries and never node
descriptions, so T3's Files bullet now carries the obligation, with AGENTS.md's
reflect-changes-in-documentation rule as its authority and the note that the prompt cost is nil
(`src/llm/prompt.ts:179-181`).
**(5) T2's Files named two of the four test files it edits and mis-attributed them.** "Edit
`stores.ts` — `ROOTS_VERSION` 1 → 2, **plus the eight landed test sites Step 1 names**" attached to
`stores.ts` eight sites that are not in it, and omitted the seven body-shape sites entirely. The
`stores.ts` bullet is now the constant alone, and a new bullet lists all four files — `roots.test.ts`,
`cli-roots-basic.test.ts`, `history-cochange.test.ts`, `mine.test.ts` — as the fifteen sites Step 1
enumerates, with each one's node named and verified so the "no node moves" claim is checkable. One
of the four is an **e2e** file in a different node from everything else T2 touches, and every other
task in this plan lists such a file explicitly.

**Not applied:** none. Every finding was verified at source before being acted on — the two landed
`describe` blocks and the absent `symlink` case, the three test nodes' `relations:` blocks and
mappings, `cli/tests/support`'s landed description, `command`'s type-level aspects and the `cli`
node's four inherited ones, `test-suite`'s missing allow-list, the leaderboard's six pinned paths,
`prompt.ts`'s description exclusion, and the fifteen T2 assertion sites by count
(7 `rootsVersion: 1` + 1 `toBe(1)` + 6 co-change `toEqual` + 1 `exemplars` absence = 15).
**Two of the review's own anchors were narrowed, each checked twice before being changed:** the
first `describe` block ends at **`:154`**, not `:165` (`:155-172` is the comment block that
introduces the next one, and `:173` opens it), and the description-exclusion citation is given as
`prompt.ts:179-181` rather than `:177-181` — the anchor this plan already uses in two other places,
and the one whose first line is the exclusion sentence itself. Neither narrowing changes a claim.
**One of the review's remedies was improved on rather than taken verbatim, and it is stated inline:**
M2's criterion was proposed for T4; it lands in **T3** instead, because T3 is the task whose gate
must observe the rule it lands — a mechanism whose only killer runs one task later is the
no-owner shape M2 is about — and T4 Step 3 gets the pointer instead, which is what its enumeration
actually needed.

**Sweep A (decisions vs restatements), scoped to rounds 12-13.** D1's widened pipeline signature →
T6 Step 3, D1's own `'checked'`-event paragraph, D13a(b)'s transition-1 Writer cell (unchanged and
still true), T6's NON-goals and T7 Step 3 (both name the function, neither its signature) ✓.
D13a(a)'s "as emitted" pair → T1's `SessionEvent` union, T3's `OpenIntervention` (whose "every field
is load-bearing" sentence is re-cut into two groups rather than left false), T7 Step 2, T8 Step 2,
T7 criterion 6 (still §18.1's nine fields plus `observedAfter` — the two new carriers are on the
*event* and the *fold*, not on the record) ✓. D4's re-validation owner → D9's projection paragraph,
`VerdictFact.exemplars`, T3 Step 6, T3 Step 7b, T3 criterion 16, T4 Step 3, T2's Authorities,
MR-14g ✓. The edge audit's two new rows → the unit-test ownership paragraph ✓. **One drift found by
this sweep and repaired, not review-flagged:** T3 Step 6 described the `See:` line with no statement
of when it is *absent*, which after M2 is the renderer's whole obligation — it now says the renderer
renders what the projection hands it, validates nothing, and omits the line on an empty list,
whether that list is empty from having no conformers or from having been reaped.

**Sweep B (invariants/MRs vs tasks), scoped to rounds 12-13.** **MR ids: 72 live definitions, no
duplicates, every `MR-*` referenced in the task body defined except `MR-32c`/`MR-32d` in their
retirement notice** — mechanically re-checked. The arithmetic: **71 + 1 (MR-14g) − 0 retired = 72**,
and R5-I11's "(71 ids at present)" is updated to **72**. **Full mechanical re-validation of all
three reference classes** — qualified criterion refs, qualified step refs and bare in-task `Step N`
/ `criterion N`, with previous-line joining so a wrapped reference is not a false positive:
**zero dangling in all three**, after one real hit this round's own edit introduced (a bare
"criterion 16" written inside T4 and inside D9, both now qualified as `T3 criterion 16`). The
remaining apparent hits are the two documented classes: `T8 Step 2a`/`2b`, which are Step 2's
labelled `(a)`/`(b)` subsections, and wrapped `T7 criterion 2` / `T5 criterion 3` / `T3 criterion 13`
/ `T6 Step 1b`. **Counts touched, each re-derived rather than adjusted:** `applyBudgetsAndDedup`
3 → **4** arguments; the `'warned'` event payload 7 → **8** fields; `OpenIntervention` 6 → **8**
fields; D9's non-copy projection fields 3 → **4**; T3 from 9 steps to **10** (Step 7b) and from 15
criteria running to 15 to criteria running to **16**; the new-edge audit from 7 rows to **9**; T2's Files from one `stores.ts` bullet
carrying a mis-attributed parenthetical to that bullet plus **one** new four-file bullet. Unmoved
and confirmed unmoved: T5 criterion 4b's **five** absorbed legs, R5-I2's **five**-item enumeration,
T2 Step 1's **fifteen** landed assertion sites, the **six** `--file` measuring sites, T1's 9 steps
and 14 criteria. R5-I4 ✓ (both fixes keep every clock reading and every `stat` in the command
layer). R5-I7 ✓ (no config key touched). R5-I12 ✓ (criterion 16 is an e2e leg on an existing file).
R5-I16 ✓ (no repo-check step added or removed).

**Interaction pass, scoped to rounds 12-13.** Nine pairs, one defect:
- *the fourth argument × R5-I4* — `session-state.ts` still contains no `Date.now()` and derives no
  identity; it receives two strings the command layer already computed for `VerdictInput`. ✓
- *the fourth argument × "every later task adds data, never a new parameter"* — that rule is
  `VerdictInput`'s and is stated in T3's contract block; this widening happens at **D1**, before any
  task, and D1 now says the list is closed. The two are not in tension, and the tension the review
  feared (an implementer widening it under protest) is exactly what fixing it at the decision
  prevents. ✓
- *`deltaBits` on the `'warned'` event × T6 Step 5's growth law* — one number per warned event on a
  log already bounded only by 7-day mtime pruning; the law's argument ("one short line per run") is
  unchanged. ✓
- *the emitted pair × T8's pass reading no `counts`* — carrying the pair on the fold is what keeps
  `health.ts` free of a Δ computation it would otherwise need `counts`/`alphabet` and
  `isBooleanSurface` for, i.e. the fix removes a dependency rather than adding one. ✓
- *the exemplar filter × `no-direct-fs`* — the filter is in `command`, which carries neither
  `no-direct-fs` nor `deterministic` at type level and inherits no such aspect from the `cli` node;
  checked at both `yg-architecture.yaml:49-57` and `.yggdrasil/model/cli/yg-node.yaml`. ✓
- *the exemplar filter × R5-I2's boundary* — it sits **inside** the boundary (the graph root is
  resolved by then), unlike T3 Step 8, which is set construction before it. It borrows Step 8's
  totality rule, not its position, and since it cannot throw the distinction costs nothing. Stated
  that way in Step 7b so the two are not read as one. ✓
- *the exemplar filter × R5-I9 and R5-I18* — **DEFECT (unstated composition):** a step that shortens
  a persisted list reads as a truncation the plan forbids elsewhere and as a write-back into the
  model. Step 7b now states both negatives: R5-I9 governs the ordering and truncation of *findings*,
  and this filter neither orders nor touches one; and the committed `model.json` keeps all three
  exemplars, so nothing the check path does re-enters the model.
- *criterion 16 × T3's existing e2e* — the positive `See:` assertion and the negative live in one
  file over one golden, and 16's "byte-identical first three lines" is written against the
  exemplars-present run, so the two legs pin each other. ✓
- *the two new edge rows × the fan-out leaderboard* — neither node is pinned, and 15 and 8 are far
  below the 23 tie; checked against the landed assertions rather than against the plan's own
  description of them. ✓

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
