# Increment 1b — Context-View Consolidation & Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pay down the debts the Increment-1 whole-branch review priced — one derivation for
"this file's effective rules", one assembly for the scope marking, one classification and one
pair enumeration per `yg context --file` invocation, and tests for the two decision branches
and the worst-case line budget that shipped unpinned.

**Architecture:** Pure consolidation and cost work on the surface Increment 1 shipped
(`source/cli/src/cli/build-context.ts`, `source/cli/src/formatters/context-file.ts`). No new
user-visible behavior: every output the compact view, the full views, and the expansion print
today stays byte-identical — the committed baseline and the Increment-1 suites are the proof
harness, re-run per task. The cost fix copies the codebase's own precedent
(`core/fill.ts`'s compute-once + `precomputedTypeCoverage` threading, pinned by
`tests/unit/core/fill-classify-once.test.ts`).

**Tech Stack:** TypeScript, vitest, spawned `dist/bin.js` against real on-disk fixtures
(repo convention — no mocks except the call-count spy pattern `fill-classify-once` already
established).

**Spec:** The `### Increment-level issues`, `### Deferred-debt assessment` and `### Seam
verification` sections of the Increment-1 whole-branch review, as recorded in
`.superpowers/sdd/2026-08-17-increment-1-context-disclosure/progress.md` (SHIP verdict entry
and the cleanup-queue entry), plus the caching-API reference reproduced in relevant parts
inside Task 3 below. The strategic context is §C1/§C2 of
`planning/plugin/2026-08-17-plugin-marketplace-plan.md` — the plugin increment's per-edit hook
is the consumer that makes this cost work load-bearing.

## Global Constraints

- Default `yg context --file <p>` output stays **byte-identical**: the committed baseline test
  (`source/cli/tests/unit/cli/build-context-brief.test.ts`, "leaves the default full view
  byte-identical when no new flag is passed") is re-run in EVERY task and named in every
  report.
- The `--brief` / `--aspect` / progressive outputs also stay byte-identical: the Increment-1
  suites (`build-context-brief.test.ts`, `build-context-progressive.test.ts`,
  `context-file-brief.test.ts`, `context-file.test.ts`) pass unchanged in every task — no
  assertion edits except where a task below explicitly says otherwise.
- The type-classification cache boundary is enforced by enumeration
  (`tests/unit/core/type-coverage.test.ts` — scans `src/` for direct calls to the bare
  `classifySingleFile`/`computeTypeCoverage`): every classification call goes through
  `classifySingleFileCached`/`computeTypeCoverageCached` or an already-legal wrapper. No new
  bare call sites.
- Formatters render already-decided text; business decisions live in `build-context.ts`. The
  one recorded exception stands: the draft/no-suffix decision lives in the formatter (D12) —
  do not move it.
- Graph ritual per task, same as Increment 1: any file whose behavior-describing
  `description:` changes gets that edit in the same commit; the `cli/commands/build-context`
  node is log-gated (`yg log add` with self-contained WHY prose — no references to plans,
  files, steps, or session state); new test files are added to the owning test node's
  `mapping:`; a new import edge between mapped nodes needs its relation declared (watch
  `max_direct_relations` and the fan-out leaderboard pin in
  `tests/integration/portal-derive-rest.test.ts` — currently `cli/tests/unit/cli/general` at
  30, `cli/commands/build-context` at 23/23; if a count moves, update the pin's assertion AND
  its narrative comment in the same commit).
- `scripts/repo-check.sh` green before every commit (controller runs it; 7 chmod-simulation
  failures under root are documented container artifacts, not yours).
- No CHANGELOG entry per task; Task 5 closes the increment with ONE entry under
  `## [Unreleased]` covering the user-relevant part (faster compact view) — internal
  refactors are not release notes.
- Line-number anchors below are from the post-4b608e2 tree; re-locate by the quoted code, not
  the number, and note drift in your report.

---

### Task 1: One producer for the effective rule set

**Files:**
- Modify: `source/cli/src/formatters/context-file.ts` (new export + two internal consumers)
- Modify: `source/cli/src/cli/build-context.ts` (three consumers)
- Test: `source/cli/tests/unit/formatters/context-file-brief.test.ts` (one new case)

**Interfaces:**
- Consumes: `FileContextData` (context-file.ts:12) — fields `ownerPath`, `aspects`,
  `typeCoverage?.applied`.
- Produces: `export function effectiveAspects(data: FileContextData): FileContextAspect[]` —
  THE single statement of "which rules govern this file": `data.ownerPath` present ⇒
  `data.aspects`; else `data.typeCoverage?.applied ?? []`. Tasks 2-4 and any future caller
  import this instead of re-deriving.

The invariant is currently stated five ways: three identical ternaries
(`context-file.ts` in `formatFileContextBrief` and `formatFileContextAspect`;
`build-context.ts` in `composeBriefExtras`'s third-pointer gate) and two hard-coded
single-branch forms at the full-view scope-marking call sites
(`data.typeCoverage?.applied.map(...)` on the type-covered branch, `data.aspects.map(...)` on
the node-owned branch). The two hard-coded forms are correct only because each site knows its
branch; routing them through the helper makes the invariant unforgeable.

- [ ] **Step 1: Write the failing test**

In `context-file-brief.test.ts`, add to the top-level describe (import `effectiveAspects`
alongside the existing imports):

```ts
describe('effectiveAspects', () => {
  it('is the single source for "which rules govern this file" across owner kinds', () => {
    const owned = { ...base };
    expect(effectiveAspects(owned)).toBe(owned.aspects);
    const typeCovered: FileContextData = {
      filePath: 'src/leaf/a.ts', aspects: [], dependencies: [], dependentCount: 0,
      typeCoverage: { typeId: 'leaf', applied: base.aspects },
    };
    expect(effectiveAspects(typeCovered)).toBe(base.aspects);
    const unmapped: FileContextData = {
      filePath: 'src/loose.ts', aspects: [], dependencies: [], dependentCount: 0,
    };
    expect(effectiveAspects(unmapped)).toEqual([]);
  });
});
```

(Adapt the `typeCoverage` literal to the real `FileTypeCoverageView` shape in the file — copy
whatever minimal extra fields the existing type-covered fixtures in this test file already
supply; identity assertions via `toBe` are the point: the helper returns the same array, no
copy.)

- [ ] **Step 2: Run it — expect FAIL** (`effectiveAspects is not a function`):
  `cd source/cli && npx vitest run tests/unit/formatters/context-file-brief.test.ts`

- [ ] **Step 3: Implement the helper in `context-file.ts`**, placed directly above
  `formatFileContextBrief`, with a doc comment naming it the single producer and pointing the
  five former sites at it:

```ts
/**
 * THE single statement of which rules govern a file: a node-owned file answers with its
 * owner's effective aspects; a type-covered file with the applied list its type carries;
 * anything else with nothing. Every view (compact, expansion, scope marking) and every
 * caller-side decision reads this — never a local re-derivation — so "the list the renderer
 * shows" and "the list a pointer or a suffix is computed from" cannot drift apart.
 */
export function effectiveAspects(data: FileContextData): FileContextAspect[] {
  return data.ownerPath ? data.aspects : (data.typeCoverage?.applied ?? []);
}
```

- [ ] **Step 4: Route all five sites through it.** In `context-file.ts`: the ternary in
  `formatFileContextBrief` (`const aspects = data.ownerPath ? data.aspects :
  (data.typeCoverage?.applied ?? []);`) and the identical one opening
  `formatFileContextAspect`. In `build-context.ts`: the ternary inside `composeBriefExtras`'s
  third-pointer gate, and the two full-view scope-marking call sites — replace
  `data.typeCoverage?.applied.map((a) => a.aspectId)` and `data.aspects.map((a) =>
  a.aspectId)` with `effectiveAspects(data).map((a) => a.aspectId)` (the import of
  `effectiveAspects` joins the existing `formatFileContext...` import line — same module, no
  new graph relation).

- [ ] **Step 5: Run the guard suites** — the new case green, everything else byte-unchanged:
  `npx vitest run tests/unit/formatters/context-file-brief.test.ts tests/unit/formatters/context-file.test.ts tests/unit/cli/build-context-brief.test.ts tests/unit/cli/build-context-progressive.test.ts`
  Then `npm run typecheck && npm run lint`.

- [ ] **Step 6: Graph ritual + report** — `node source/cli/dist/bin.js check --approve` from
  repo root (log-gate: this changes no behavior, but the formatter and command sources drift →
  add the `yg log add` entry for `cli/commands/build-context` in product terms: one shared
  producer so the views cannot disagree about a file's rule set). No commit (controller
  commits).

### Task 2: One assembly for the scope marking

**Files:**
- Modify: `source/cli/src/cli/build-context.ts`
- Test: `source/cli/tests/unit/cli/build-context-progressive.test.ts` (existing in-process
  cases keep passing; no new test — Task 3 adds the call-count pin that also covers this
  shape)

**Interfaces:**
- Consumes: `computeScopeMarking(graph, filePath, aspectIds, pairs, unreadable, repoFiles)`
  (the Task-6/I2 shape), `computeTypeCoverageForContext`, `computeExpectedPairs`,
  `effectiveAspects` (Task 1).
- Produces: one private `async function assembleScopeMarking(graph: Graph, filePath: string,
  data: FileContextData, precomputed?: { edges?: TypedEdgeIndex; repoFiles?: string[] }):
  Promise<ScopeMarking>` — the single gate-walk-classify-enumerate-mark sequence. All three
  call sites (compact via `composeBriefExtras`, type-covered full view, node-owned full view)
  call it; the per-site differences (whether `edges` exists to spread, whether a walk already
  happened) live in the `precomputed` argument, not in copied blocks.

The three near-identical blocks each re-express "gate on `progressive.reference` → walk →
typeCoverage → `computeExpectedPairs` → `computeScopeMarking`". The compact site additionally
reuses the arm preview's enumeration (`wholeGraphPairs`) — that reuse must SURVIVE: the helper
accepts optional `pairsWithUnreadable?: { pairs: ExpectedPair[]; unreadable:
UnreadableSubject[] }` and only enumerates itself when not given one.

- [ ] **Step 1: Extract the helper.** Signature:

```ts
async function assembleScopeMarking(
  graph: Graph,
  filePath: string,
  data: FileContextData,
  precomputed?: {
    edges?: TypedEdgeIndex;
    repoFiles?: string[];
    pairsWithUnreadable?: { pairs: ExpectedPair[]; unreadable: UnreadableSubject[] };
  },
): Promise<ScopeMarking> {
```

Body: return `{}` immediately when `graph.config.progressive?.reference === undefined`;
`repoFiles = precomputed?.repoFiles ?? await walkRepoFiles(projectRootFromGraph(graph.rootPath))`;
`typeCoverage = await computeTypeCoverageForContext(graph, repoFiles)`; enumeration =
`precomputed?.pairsWithUnreadable ?? computeExpectedPairs(graph, { typeCoverage:
{ ...typeCoverage-shape the current sites build, with the edges spread exactly as the
type-covered site does it when precomputed?.edges && typeCoverage } })` — reproduce the
current sites' edges-spread guard verbatim; then
`computeScopeMarking(graph, filePath, effectiveAspects(data).map((a) => a.aspectId),
enumeration.pairs, enumeration.unreadable, repoFiles)`. Move the sites' existing comments
into the helper rather than rewriting them.

- [ ] **Step 2: Replace all three call sites.** Compact (`composeBriefExtras`): pass
  `{ edges: shared?.edges, repoFiles, pairsWithUnreadable: wholeGraphPairs !== undefined ?
  { pairs: wholeGraphPairs, unreadable } : undefined }` — preserving both the arm-preview
  reuse and the I2 refusal (the helper receives the same `unreadable` the preview saw).
  Type-covered full view: `{ edges, repoFiles }`. Node-owned full view: no precomputed
  argument beyond what it has today. Delete the three inlined blocks.

- [ ] **Step 3: Prove byte-identity** — full guard suite run as in Task 1 Step 5 (all four
  suites + typecheck + lint). The in-process `computeScopeMarking` cases and every spawned
  progressive case must pass UNCHANGED.

- [ ] **Step 4: Graph ritual + report** — as Task 1 Step 6 (log entry: one assembly so the
  three views cannot drift in HOW they measure, matching the one derivation of WHAT they
  measure).

### Task 3: One classification and one enumeration per invocation

**Files:**
- Modify: `source/cli/src/cli/build-context.ts`
- Modify: `source/cli/src/cli/progressive-scope-resolve.ts`
- Test: Create `source/cli/tests/unit/cli/build-context-classify-once.test.ts`
- Modify: `.yggdrasil/model/cli/tests/unit/cli/general/yg-node.yaml` (mapping + any relation)

**Interfaces:**
- Consumes: the researched cache/enumeration facts (verified against the tree before use):
  - `computeTypeCoverageCached(graph, uncoveredFiles, cache)` — `core/type-coverage.ts`
    (~:235-242) — the only legal whole-repo entry; constructs its own `TypeClassCache`.
  - `resolveChangeScope(input: ChangeScopeInput)` — `cli/progressive-scope-resolve.ts`; its
    `measure()` (~:416-485) calls `resolveTypeCoverage` (~:447, fresh `FileContentCache`,
    full reclassify) and `computeExpectedPairs` (~:448, second whole-graph enumeration) —
    the duplicate work this task removes. `ChangeScopeInput` (~:79-87) has no precomputed
    field today; adding optional ones is additive (`cli/check.ts:324` is the only other
    caller and remains valid unchanged).
  - Precedent to mirror: `core/fill.ts` computes type coverage once and threads
    `precomputedTypeCoverage`; `tests/unit/core/fill-classify-once.test.ts` pins one
    classification per run by spying `computeTypeCoverageCached` call counts.
- Produces: `ChangeScopeInput` gains
  `precomputed?: { typeCoverage?: TypeCoverageInput; pairs?: ExpectedPair[]; unreadable?: UnreadableSubject[] }`;
  `measure()` uses the supplied values instead of re-deriving when present.
  `assembleScopeMarking` (Task 2) and `composeBriefExtras` pass what they already computed.

- [ ] **Step 1: Write the failing call-count test** (new file
  `build-context-classify-once.test.ts`), mirroring `fill-classify-once.test.ts`'s spy
  pattern exactly (read it first and copy its mocking mechanics — module spy on
  `core/type-coverage.js`'s `computeTypeCoverageCached` and on `core/pairs.js`'s
  `computeExpectedPairs`):
  - Case A: in-process `composeBriefExtras` on a progressive git fixture (reuse
    `createProgressiveFixture` from `tests/support` exactly as
    `build-context-progressive.test.ts`'s in-process cases do) → after the call,
    `computeExpectedPairs` was called EXACTLY ONCE and `computeTypeCoverageCached` AT MOST
    ONCE.
  - Case B: same fixture, `resolveChangeScope` called directly with
    `precomputed: { typeCoverage, pairs, unreadable }` built from one explicit
    `computeExpectedPairs` call → the spies show `measure()` added ZERO further calls.
  Expected first run: FAIL (today `measure()` always re-enumerates — Case A sees 2 calls).

- [ ] **Step 2: Implement.** In `progressive-scope-resolve.ts`: add the optional
  `precomputed` field to `ChangeScopeInput` with a doc comment ("an already-computed
  whole-graph enumeration/classification from THIS invocation — measure() trusts it instead
  of paying for its own; callers own the guarantee that it is fresh"); in `measure()`, use
  `input.precomputed?.typeCoverage ?? await resolveTypeCoverage(...)` and
  `input.precomputed?.pairs/unreadable ?? computeExpectedPairs(...)` (keep the
  unreadable-honesty semantics: if the supplied `unreadable` is non-empty, behave exactly as
  when the internal enumeration reports the same). In `build-context.ts`: `computeScopeMarking`
  passes its received `pairs`/`unreadable`/`typeCoverage` through to `resolveChangeScope`'s
  new field; `assembleScopeMarking` (Task 2) already computes each exactly once. Verify: on
  the node-owned `--brief` path the arm preview's single enumeration now serves BOTH the
  preview and the entire scope resolution — no second `computeExpectedPairs` anywhere in the
  invocation.
- [ ] **Step 3: The cache-boundary test stays green** — run
  `npx vitest run tests/unit/core/type-coverage.test.ts` (no new bare call sites) and
  `tests/unit/core/fill-classify-once.test.ts` (fill's own pin untouched).
- [ ] **Step 4: Run the new test — GREEN**, plus the full Task-1-Step-5 guard suites, plus
  `tests/unit/cli/check*.test.ts` and any suite named for `progressive` under
  `tests/unit/cli/` (the `resolveChangeScope` signature is consumed by `yg check` — its
  behavior must be provably unchanged when `precomputed` is absent).
- [ ] **Step 5: Measure and record.** Time `node source/cli/dist/bin.js context --file
  source/cli/src/cli/build-context.ts --brief` (3 runs, report the median) before your change
  (git stash) and after — record both numbers in your report. Expected: the ~1.3s
  whole-graph-enumeration double-pay disappears on progressive invocations; no regression on
  non-progressive ones.
- [ ] **Step 6: Graph ritual + report** — mapping for the new test file; relation check (the
  new test imports `core/type-coverage` and `core/pairs` for spying — declare `uses` edges on
  the test node ONLY if the relation pass demands them; if the general node's count moves,
  bump its limit with an updated reason AND move the fan-out leaderboard pin + narrative);
  log entry (product prose: a file's context now costs one measurement, not two).

### Task 4: Pin the two unexercised decision branches

**Files:**
- Test: `source/cli/tests/unit/cli/build-context-progressive.test.ts` (two new spawned cases)

**Interfaces:**
- Consumes: `createProgressiveFixture` / `runGitFixture` from `tests/support` (as the file
  already uses); the D9 strings in `build-context.ts` — measured-with-caveat WHAT
  `Scope marking measured against '<reference>' — with a caveat:`; the `whole-project`
  decision (no notice, no marking).
- Produces: nothing consumed later — closes the increment-review I3 gap.

- [ ] **Step 1: Read the resolver's branch conditions** (`progressive-scope-resolve.ts`) to
  build each fixture state from the real trigger, not a guess: the measured-with-caveat row
  is a measured change that reaches a globally-gated file (the fixture edits
  `.yggdrasil/yg-architecture.yaml` — or whichever file class `measure()` maps to the
  caveat-carrying `scoped` decision; verify by reading, name the trigger in a comment); the
  `whole-project` row per its own condition (e.g. the resolver's documented
  fallback — read and cite it).
- [ ] **Step 2: Write both spawned cases, RED-first against a deliberately-wrong
  expectation is NOT the method here** — these are coverage-closing tests for existing
  dictated behavior (the Increment-1 rule): write them to the real behavior, run, and if
  either FAILS, STOP and report — a failure here is a product bug, not a test bug.
  - Case 1 (measured-with-caveat): fixture whose staged change touches the trigger file +
    an ordinary source file → spawn `context --file <ordinary-file> --brief`; assert exit 0,
    stderr contains `Scope marking measured against '` and `— with a caveat:`, stdout still
    carries a `(yours)`/`(inherited)` suffix (marking AND notice, per D9).
  - Case 2 (whole-project): fixture in the state Step 1 identified → spawn the same command;
    assert exit 0, stderr contains NO `Scope marking` line, stdout carries NO scope suffix
    and NO `your change so far:` header.
- [ ] **Step 3: Full guard suites** (Task 1 Step 5 list) + typecheck + lint.
- [ ] **Step 4: Graph ritual + report** (no mapping change — the file is already mapped; log
  entry only if the command node's source drifted, which it does not in a test-only task —
  state that explicitly in the report).

### Task 5: Worst-case budget pin, spawn consolidation, and the increment's changelog line

**Files:**
- Test: `source/cli/tests/unit/cli/build-context-brief.test.ts`
- Modify: `CHANGELOG.md` (one line, Step 4)

**Interfaces:**
- Consumes: the budget arithmetic (renderer worst case 28 at the 8-rule cap, 29 with the
  truncation tail; +1 stdout mapping line on the node-owned path ⇒ 29 at cap / 30 at tail;
  scope header +1 lands exactly on 30); the three existing `type-level-engine` spawns.
- Produces: nothing consumed later.

- [ ] **Step 1: Consolidate the three identical type-covered spawns.** In
  `build-context-brief.test.ts`, the three cases that each copy `type-level-engine` and spawn
  `context --file src/leaf/a.ts --brief` become one `describe` with a single
  `beforeAll` copy+spawn storing `{ stdout, stderr, exitCode }`, and three `it`s asserting
  their distinct claims against the shared result. Keep each `it`'s title and assertions
  verbatim — only the execution is shared. (If any of the three passes different flags,
  it stays independent — verify before merging.)
- [ ] **Step 2: Write the worst-case budget pin.** One in-process case (the renderer is the
  budget's owner; `src/formatters/**` is coverage-measured): build a `FileContextData` +
  `FileBriefExtras` with EVERY extra present and the aspect list at 9 (cap 8 + truncation
  tail) — scope header, 8×2 aspect lines + tail line, arm preview, 4+ dependencies (overflow
  marker), dependents, log gate, flows, 3 pointers — and assert
  `formatFileContextBrief(...).trimEnd().split('\n').length` equals EXACTLY the arithmetic
  total (derive it in the test from named constants, with a comment mapping each line to the
  plan's ledger: path 1 + owner 1 + scope 1 + must-satisfy 1 + 16 + tail 1 + arm 1 + depends
  1 + dependents 1 + log 1 + flows 1 + next 3 = 29), and `toBeLessThanOrEqual(29)` — leaving
  the +1 stdout mapping line inside the CLI's 30. A future line added to the renderer breaks
  this test by name.
- [ ] **Step 3: Full guard suites + typecheck + lint.**
- [ ] **Step 4: CHANGELOG.** One line under `## [Unreleased]` → `### Changed` (or the
  section the file's house style uses for performance): the compact view now performs the
  scope measurement once per invocation instead of twice, cutting its cost on progressive
  projects — adopter-voiced, no internals. (This is the increment's only changelog line;
  Tasks 1-4 are internal.)
- [ ] **Step 5: Graph ritual + report** — mapping unchanged; log entry only if command
  source drifted (it does not in this task — say so).

---

## Execution notes (controller)

- Order is strict: T1 → T2 → T3 (each shapes the next); T4 and T5 may run in either order
  after T3.
- Same SDD loop as Increment 1: fresh Sonnet implementer per task (no commits, no
  repo-check, combined-CA-bundle export in every shell command), Opus task review per task,
  fix loop, controller-run gate, one commit per task, push.
- Byte-identity is the increment's soul: any task whose guard suites show ANY output drift
  is BLOCKED, not adapted — the plan is wrong or the code is; escalate to the controller.
