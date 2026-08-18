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

**Spec:** The Increment-1 whole-branch review's findings as recorded in the SHIP-verdict and
cleanup-queue ledger entries near the end of
`.superpowers/sdd/2026-08-17-increment-1-context-disclosure/progress.md` (the ledger is
flat prose — the review's own section headings are not reproduced there; the cleanup-queue
line carries the whole item list), plus the caching-API reference reproduced in relevant
parts inside Task 3 below. The strategic context is §C1/§C2 of
`planning/plugin/2026-08-17-plugin-marketplace-plan.md` — the plugin increment's per-edit hook
is the consumer that makes this cost work load-bearing.

## Global Constraints

- Default `yg context --file <p>` output stays **byte-identical**: the committed baseline test
  (`source/cli/tests/unit/cli/build-context-brief.test.ts`, "leaves the default full view
  byte-identical when no new flag is passed") is re-run in EVERY task and named in every
  report.
- The `--brief` / `--aspect` / progressive outputs also stay byte-identical: the Increment-1
  suites (`build-context-brief.test.ts`, `build-context-progressive.test.ts`,
  `context-file-brief.test.ts`, `context-file.test.ts`) PLUS the two suites that cover the
  type-covered full view (`tests/unit/cli/context-file-type-coverage.test.ts`,
  `tests/unit/cli/build-context.test.ts`) pass unchanged in every task — this six-suite list
  is "the guard suites" wherever a step names them. No assertion edits except where a task
  below explicitly says otherwise. Task 3 additionally re-runs the three progressive E2E
  suites (`tests/e2e/cli-progressive-gate.test.ts`, `cli-progressive-approve.test.ts`,
  `cli-progressive-byte-guard.test.ts`) — the end-to-end proof that `resolveChangeScope`'s
  gating is unchanged for `yg check`.
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
- **Every step that runs a guard suite or `dist/bin.js` is preceded by `npm run build` in
  `source/cli/`** — `dist/` is gitignored and never refreshed as a side effect; two of the
  six guard suites spawn the built binary behind `describe.skipIf(!distExists)`, including
  the byte-identity baseline, and a stale build makes them pass vacuously against pre-change
  code.
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
`build-context.ts:495` — a `const effectiveAspects = ...` local near the top of
`composeBriefExtras`, feeding BOTH the third-pointer gate at `:497` and the scope-marking
`aspectIds` at `:566`) and two hard-coded single-branch forms at the full-view
scope-marking call sites (`data.typeCoverage?.applied.map((a) => a.aspectId) ?? []` on the
type-covered branch — note the `?? []`, which the replacement absorbs — and
`data.aspects.map(...)` on the node-owned branch). The two hard-coded forms are correct only
because each site knows its branch; routing them through the helper makes the invariant
unforgeable.

**Naming decision (binding):** the new export collides with the existing local
`const effectiveAspects` at `build-context.ts:495`. The local is RENAMED to
`const governing = effectiveAspects(data);` and ALL THREE of its references read
`governing`: the `:496` length gate (miss this one and it silently reads the imported
FUNCTION's `.length` — an always-true gate that typechecks), the `:497` pointer, and the
`:566` scope-marking map. Do not shadow, do not alias the import.

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
      typeCoverage: { typeId: 'leaf', applied: base.aspects, chainTerminationText: 'Inherited rules stop at the type.', dropped: [] },
    };
    expect(effectiveAspects(typeCovered)).toBe(base.aspects);
    const unmapped: FileContextData = {
      filePath: 'src/loose.ts', aspects: [], dependencies: [], dependentCount: 0,
    };
    expect(effectiveAspects(unmapped)).toEqual([]);
  });
});
```

(Check the literal against the real `FileTypeCoverageView` shape — `context-file.ts:29-37`
requires `chainTerminationText` and `dropped`; the existing type-covered fixtures in this
test file at ~:118/:181/:232 show the working minimal form — copy theirs if the above does
not typecheck. Identity assertions via `toBe` are the point: the helper returns the same
array, no copy.)

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
  `formatFileContextAspect`. In `build-context.ts`: the `const effectiveAspects = ...` local
  at `:495` becomes `const governing = effectiveAspects(data);` with `:496`, `:497` and
  `:566` reading `governing` (the binding naming decision above); and the two full-view
  scope-marking call sites — replace `data.typeCoverage?.applied.map((a) => a.aspectId) ?? []`
  and `data.aspects.map((a) => a.aspectId)` with `effectiveAspects(data).map((a) =>
  a.aspectId)` (the `?? []` is absorbed by the helper). The import of `effectiveAspects`
  joins the existing `formatFileContext...` import line — same module, no new graph relation.

- [ ] **Step 5: Run the guard suites** — the new case green, everything else byte-unchanged:
  `npm run build && npx vitest run tests/unit/formatters/context-file-brief.test.ts tests/unit/formatters/context-file.test.ts tests/unit/cli/build-context-brief.test.ts tests/unit/cli/build-context-progressive.test.ts tests/unit/cli/context-file-type-coverage.test.ts tests/unit/cli/build-context.test.ts`
  (build first — two suites spawn `dist/bin.js`; the six-suite guard list from Global
  Constraints). Then `npm run typecheck && npm run lint`.

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
- Consumes: `computeScopeMarking(graph, filePath, aspectIds, pairs, repoFiles, unreadable)`
  (the real post-I2 order — `build-context.ts:405-412`, pinned positionally by the
  in-process case at `build-context-progressive.test.ts:187`), `computeTypeCoverageForContext`,
  `computeExpectedPairs`, `effectiveAspects` (Task 1).
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
    /** the classification the caller already paid for — forwarded, never recomputed */
    typeCoverage?: TypeCoverageInput;
  },
): Promise<ScopeMarking> {
```

Body: return `{}` immediately when `graph.config.progressive?.reference === undefined`;
`repoFiles = precomputed?.repoFiles ?? await walkRepoFiles(projectRootFromGraph(graph.rootPath))`.
The enumeration — and the classification that feeds it — happen ONLY on the branch that has
no `precomputed.pairsWithUnreadable` (a second classification at a site that already
enumerated would recreate the exact double-pay Task 3 exists to remove, and would make
Task 3's call-count test unsatisfiable):

```ts
const typeCoverage =
  precomputed?.typeCoverage ??
  (precomputed?.pairsWithUnreadable === undefined
    ? await computeTypeCoverageForContext(graph, repoFiles)
    : undefined);
const enumeration =
  precomputed?.pairsWithUnreadable ??
  (await (async () => {
    // reproduce the type-covered site's edges-spread guard verbatim:
    const input = precomputed?.edges !== undefined && typeCoverage !== undefined
      ? { typeCoverage: { ...typeCoverage, edges: precomputed.edges } }
      : { typeCoverage };
    const { pairs, unreadable } = await computeExpectedPairs(graph, input);
    return { pairs, unreadable };
  })());
```

(`typeCoverage` is kept in scope — Task 3 forwards it into the marking. A site that supplied
`pairsWithUnreadable` supplies `typeCoverage` alongside it when it has one; the helper never
classifies on that branch.)

(Adapt the `input` literal to the exact shape the current type-covered full-view site builds
— copy its code, do not re-derive.) Then
`computeScopeMarking(graph, filePath, effectiveAspects(data).map((a) => a.aspectId),
enumeration.pairs, repoFiles, enumeration.unreadable)` — note the real argument order,
`repoFiles` BEFORE `unreadable`. Move the sites' existing comments into the helper rather
than rewriting them.

- [ ] **Step 2: Replace all three call sites.** Compact (`composeBriefExtras`): the outer
  gate at `:565` — `if (graph.config.progressive?.reference !== undefined &&
  wholeGraphPairs !== undefined)` — is RETAINED VERBATIM. It is load-bearing twice over:
  when the arm-preview block throws, marking is deliberately skipped rather than paying for
  its own re-enumeration (the comment at `:519-523` says exactly this — the skip sentence is `:522-523`), and the byte-identity
  suites do not exercise that path, so a helper that silently enumerated there would change
  output unobserved. Inside the retained gate, call the helper with
  `{ edges: shared?.edges, repoFiles, pairsWithUnreadable: { pairs: wholeGraphPairs,
  unreadable: wholeGraphUnreadable ?? [] }, typeCoverage: wholeGraphTypeCoverage }` — the
  surviving variables are `wholeGraphPairs`/`wholeGraphUnreadable` (`:525-526`, `:534`; the
  `unreadable` binding at `:532` dies with the `try` block, and the retained gate narrows
  only `wholeGraphPairs`, hence the `?? []`, matching what `:566` passes today). The
  classification is try-local today (`const typeCoverage` at `:528`): hoist
  `let wholeGraphTypeCoverage: TypeCoverageInput | undefined;` alongside the other two
  hoisted variables and assign it at `:528` — without this the compact site has no
  classification to forward and Task 3's classify-once case cannot go green.
  Type-covered full view: `{ edges, repoFiles }`. Node-owned full view: no precomputed
  argument beyond what it has today. Delete the three inlined blocks.

- [ ] **Step 3: Prove byte-identity** — full guard suite run as in Task 1 Step 5 (all six
  suites, build first, + typecheck + lint). The in-process `computeScopeMarking` cases and every spawned
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
  `precomputed?: { typeCoverage?: TypeCoverageInput; pairs?: ExpectedPair[] }` —
  `TypeCoverageInput` is `resolveTypeCoverage`'s real return type
  (`progressive-scope-resolve.ts:324`, already imported in both files; do NOT use
  `TypeCoverageResult`, a different exported interface from `core/type-coverage.ts:13-25`
  that would typecheck nothing here). NO `unreadable` field: `measure()` discards
  enumeration unreadables today (`:448` destructures only `pairs`) and the honesty gate
  lives one layer up in `computeScopeMarking` — inventing a refusal here would create a new
  `yg check`-reachable path. `measure()` uses supplied values instead of re-deriving when
  present. `computeScopeMarking` gains TWO TRAILING optionals —
  `precomputedTypeCoverage?: TypeCoverageInput, precomputedPairs?: ExpectedPair[]` — both
  after `unreadable`, so the six-argument positional call in the guard suite at
  `build-context-progressive.test.ts:187` still compiles UNCHANGED. (Two, not one: the
  existing `pairs` parameter may be edges-resolved and so may NOT be forwarded to
  `measure()`; the caller must hand the forwardable set separately.)
  `assembleScopeMarking` (Task 2) passes the classification it computed or received, and
  passes `precomputedPairs` ONLY when `precomputed?.edges === undefined` — that flag IS the
  edge-less discriminator for all four call sites (compact node-owned: `shared` absent;
  compact type-covered: `shared.edges` set; type-covered full view: `edges` set; node-owned
  full view: none). This is the route by which M4's head item (the duplicate whole-repo
  classification) actually dies.

**Contract ruling (binding) — what may be forwarded to `measure()`:**
`resolveTypeCoverage`'s doc (`progressive-scope-resolve.ts:308-320`; the edge-less paragraph is `:313-319`) deliberately keeps the
resolver's enumeration EDGE-LESS — a pessimistic gate. Forwarding an edges-resolved
enumeration would let the burn set differ. Therefore:
- the CLASSIFICATION (`typeCoverage` result — edge-independent, the expensive half) is
  forwarded from EVERY site that has one — always the PRE-SPREAD `typeCoverage` binding,
  never `typeCoverageWithEdges` (`build-context.ts:529-531`): the spread is exactly what
  the ruling excludes;
- PAIRS are forwarded ONLY from sites whose enumeration carried no `edges` spread — i.e. the
  node-owned paths (no `shared.edges`). The type-covered sites forward classification only
  and accept `measure()`'s own (cheap, edge-less) enumeration; a comment at the threading
  site records this asymmetry and cites the resolver's doc.

- [ ] **Step 1: Write the failing call-count test** (new file
  `build-context-classify-once.test.ts`), mirroring `fill-classify-once.test.ts`'s
  `vi.mock`/`importOriginal`/`...actual` mechanics — applied to TWO modules
  (`core/type-coverage.js` and `core/pairs.js`) where the precedent mocks one; the
  `...actual` spread preserves `FileUnreadableError`'s class identity for the `instanceof`
  at ~`build-context.ts:258`. Fixture choice is load-bearing — the wrong one is green before
  the fix:
  - Case A (enumeration-once, node-owned): in-process `composeBriefExtras` on
    `createProgressiveFixture({ label: ..., progressiveReference: REFERENCE_BRANCH })` —
    the reference MUST be passed explicitly (it is off by default,
    `tests/support/progressive-fixture.ts:51-62`; without it `computeScopeMarking` is never
    reached and the test is vacuously green) — and cut a real measured branch like every
    sibling in-process case does:
    `f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');`.
    Assert `computeExpectedPairs` called EXACTLY ONCE for the whole call. Expected first
    run: FAIL with 2 calls (today `measure()` re-enumerates).
  - Case B (classification-once, type-covered): use the
    `createTypeLevelProgressiveFixture` pattern from
    `build-context-progressive.test.ts:60-79` (copies `tests/fixtures/type-level-engine` —
    which HAS `coverage.type_level` on — and appends the reference); in-process
    `composeBriefExtras` on the type-covered file with
    `shared = { edges: { edgesFrom: () => [] }, repoFiles }` — a stub `TypedEdgeIndex`
    (one-method interface, `relations/pass.ts:103-108`) suffices to take the edges-spread
    branch and classifies nothing itself (`computeRelationEdgesForContext` is not exported,
    and running the real relation pass would pollute the counts). Call
    `mockComputeTypeCoverage.mockClear()` and `mockComputeExpectedPairs.mockClear()`
    IMMEDIATELY before the measured `composeBriefExtras` call so only it is counted.
    Assert `computeTypeCoverageCached` called EXACTLY ONCE. Expected first run: FAIL with
    2 calls (site + `measure()`'s `resolveTypeCoverage`). Do NOT assert
    `computeExpectedPairs === 1` here — per the contract ruling the type-covered path
    legitimately enumerates twice; assert EXACTLY TWO with a comment citing the ruling, so
    a future third enumeration still fails.
  - Case C (direct threading): `resolveChangeScope` called directly with
    `precomputed: { typeCoverage, pairs }` built from one explicit enumeration on the Case-A
    fixture → assert `expect(decision.kind).toBe('scoped')` FIRST (a decision that
    short-circuits earlier would make the count assertion vacuous), then that the spies show
    the call added ZERO further classification or enumeration calls (mockClear before the
    call).

- [ ] **Step 2: Implement.** In `progressive-scope-resolve.ts`: add the optional
  `precomputed` field to `ChangeScopeInput` with a doc comment ("an already-computed
  classification and/or edge-less whole-graph enumeration from THIS invocation — measure()
  trusts it instead of paying for its own; callers own the freshness guarantee AND the
  edge-less-pairs guarantee — see the contract ruling"); in `measure()`, use
  `input.precomputed?.typeCoverage ?? await resolveTypeCoverage(...)` and
  `input.precomputed?.pairs ?? (await computeExpectedPairs(graph, { typeCoverage })).pairs`.
  In `build-context.ts`: `computeScopeMarking` gains the two trailing optionals from the
  Produces block and threads `precomputed: { typeCoverage: precomputedTypeCoverage,
  pairs: precomputedPairs }` into `resolveChangeScope` (either may be undefined — the `??`
  fallbacks in `measure()` handle each independently); `assembleScopeMarking` (Task 2)
  passes the classification it computed or received, and sets `precomputedPairs =
  enumeration.pairs` ONLY when `precomputed?.edges === undefined` (the edge-less
  discriminator), with a comment citing the resolver's pessimism doc
  (`progressive-scope-resolve.ts:308-320`). Verify: on the
  node-owned `--brief` path the arm preview's single enumeration now serves the preview AND
  the entire scope resolution; on the type-covered paths the classification is computed once
  and only the resolver's own edge-less enumeration remains.
- [ ] **Step 3: The cache-boundary test stays green** — run
  `npx vitest run tests/unit/core/type-coverage.test.ts` (no new bare call sites) and
  `tests/unit/core/fill-classify-once.test.ts` (fill's own pin untouched).
- [ ] **Step 4: Run the new test — GREEN**, plus the full Task-1-Step-5 guard suites, plus
  `tests/unit/cli/check*.test.ts` and any suite named for `progressive` under
  `tests/unit/cli/` (the `resolveChangeScope` signature is consumed by `yg check` — its
  behavior must be provably unchanged when `precomputed` is absent).
- [ ] **Step 5: Measure and record.** This repo's own config has NO `progressive:` block and
  `type_level: false` — timing the repo itself proves nothing (the changed paths never run).
  `createTypeLevelProgressiveFixture` is a private test function — reproduce it by hand
  once: `cp -r source/cli/tests/fixtures/type-level-engine <scratch-dir>`; append
  `progressive:\n  reference: main` to its `.yggdrasil/yg-config.yaml`; inside the dir
  `git init -b main && git add -A && git commit -m base`; `git checkout -b work`; append a
  line to `src/leaf/a.ts`; commit. Then — remembering `dist/` is gitignored, so a bare
  `git stash` does NOT swap the binary — time AFTER first (`npm run build`, then 3 runs of
  `node <abs-path>/dist/bin.js context --file src/leaf/a.ts --brief` in the fixture dir,
  median); then `git stash && npm run build`, time BEFORE; then `git stash pop &&
  npm run build`. Record both medians in the report. The call-count test is the primary
  evidence; the timing is corroboration, not a gate.
- [ ] **Step 6: Graph ritual + report** — mapping for the new test file; relation check (the
  new test imports `core/type-coverage` and `core/pairs` for spying — declare `uses` edges on
  the test node ONLY if the relation pass demands them). The general node currently sits at
  30 relations with `limit: 31` whose `reason:` prose names "the current count (30)" — one
  new edge lands on 31/31 with stale prose: bump the limit with headroom if the maintainer
  convention allows, or at minimum update the reason text to the new count, AND move the
  fan-out leaderboard pin (`portal-derive-rest.test.ts` — title, assertion, narrative
  comment) in the same commit. Log entry (product prose: a file's context now costs one
  measurement, not two).

### Task 4: Pin the measured-with-caveat branch; document the dead one

**Files:**
- Test: `source/cli/tests/unit/cli/build-context-progressive.test.ts` (one new spawned case)
- Modify: `source/cli/src/cli/build-context.ts` (one comment line)

**Interfaces:**
- Consumes: `createProgressiveFixture` / `runGitFixture` from `tests/support` (as the file
  already uses); the D9 measured-with-caveat WHAT in `build-context.ts` —
  `Scope marking measured against '<reference>' — with a caveat:`.
- Produces: nothing consumed later — closes the increment-review I3 gap.

The review asked for two branch tests; the `whole-project` branch turned out to be DEAD from
this command: `resolveChangeScope` returns it only when `requestedReference` is undefined or
the state mode is `off`/`full` (`progressive-scope-resolve.ts:498-499`, `:421`;
`progressive-preflight.ts:133-135`, `:144-146`), and `computeScopeMarking` hardcodes
`fullFlag: false` and is entered only with a defined reference. Do NOT try to construct it.

- [ ] **Step 1: Verify the caveat trigger from the source, then build the fixture.** A
  `scoped` decision carries `notice` when the burn has a `globalCause`; editing
  `.yggdrasil/yg-architecture.yaml` sets it (`core/progressive-scope.ts:598` →
  `globalCause` at `:661-668` → notice at `progressive-scope-resolve.ts:481-482`).
  `createProgressiveFixture` writes that file (`progressive-fixture.ts:345`), but its
  architecture generator is private and `branchWithEdit` commits exactly ONE path — so the
  measured branch is built in two commits: first
  `f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n')`, then
  `f.commit('.yggdrasil/yg-architecture.yaml', readFileSync(join(f.dir,
  '.yggdrasil/yg-architecture.yaml'), 'utf-8').replace("'Discrete service unit'",
  "'Discrete service unit — reworded'"))` — a description-only edit, so the graph still
  loads while the architecture file lands in the touched set. (Verify `f.commit` exists on
  the fixture handle; if the helper offers a different commit primitive, use it — the
  two-commit shape is the requirement.) Name the trigger in a test comment.
- [ ] **Step 2: Write the spawned case.** Coverage-closing for existing behavior (the
  Increment-1 rule): write it to the real behavior, run, and if it FAILS, STOP and report —
  a failure is a product bug. Fixture whose measured change touches
  `.yggdrasil/yg-architecture.yaml` + an ordinary source file → spawn
  `context --file <ordinary-file> --brief`; assert exit 0, stderr contains
  `Scope marking measured against '` and `— with a caveat:`, stdout still carries a
  `(yours)`/`(inherited)` suffix (marking AND notice, per D9).
- [ ] **Step 3: Document the dead branch.** At the `whole-project` arm inside
  `computeScopeMarking` (`build-context.ts:428` region), add one comment line stating it is
  defensively unreachable from this command (reference is always defined here and
  `fullFlag` is hardcoded false) and kept for the day a caller changes that.
- [ ] **Step 4: Full guard suites** (Task 1 Step 5 list) + typecheck + lint.
- [ ] **Step 5: Graph ritual + report** (no mapping change — the file is already mapped; the
  one-line comment in the command source WILL drift the node's fingerprint → `yg log add`
  with self-contained WHY prose).

### Task 5: Worst-case budget pin, spawn consolidation, and the increment's changelog line

**Files:**
- Test: `source/cli/tests/unit/cli/build-context-brief.test.ts` (spawn consolidation)
- Test: `source/cli/tests/unit/formatters/context-file-brief.test.ts` (budget pin)
- Modify: `CHANGELOG.md` (one line, Step 4)

**Interfaces:**
- Consumes: the budget arithmetic — the renderer's worst case WITH the scope header included
  is 28 at the 8-rule cap and 29 with the truncation tail; the +1 stdout mapping line on the
  node-owned path makes the CLI's worst case exactly 30, matching the option help's "≤ 30
  lines". The three existing `type-level-engine` spawns (verified identical flags:
  `['context','--file','src/leaf/a.ts','--brief']` at ~:175, :187, :309; the fourth
  `copyTypeFixture` case at ~:244 spawns twice with different flags and stays independent).
- Produces: nothing consumed later.

- [ ] **Step 1: Consolidate the three identical type-covered spawns.** In
  `build-context-brief.test.ts`, the three cases above become one `describe` with a single
  `beforeAll` copy+spawn storing `{ stdout, stderr, exitCode }`, and three `it`s asserting
  their distinct claims against the shared result. Keep each `it`'s title and assertions
  verbatim — only the execution is shared. The per-case `try/finally { rmSync(dir, ...) }`
  cleanup becomes a matching `afterAll` — the fixture copy must not leak.
- [ ] **Step 2: Write the worst-case budget pin.** One in-process case in
  `tests/unit/formatters/context-file-brief.test.ts` — the renderer is the budget's owner,
  that file already holds the 8-aspect cap fixture (`eight`, ~:18-26) this case is a sibling
  of, and `src/formatters/**` is coverage-measured. Build a `FileContextData` +
  `FileBriefExtras` with EVERY extra present and the aspect list at 9 (cap 8 + truncation
  tail): scope header, 8×2 aspect lines + tail line, arm preview, 4+ dependencies (overflow
  marker), dependents, log gate, flows, 3 pointers — and assert
  `formatFileContextBrief(...).trimEnd().split('\n').length` equals EXACTLY the arithmetic
  total (derive it in the test from named constants, with a comment mapping each line to the
  ledger: path 1 + owner 1 + scope 1 + must-satisfy 1 + 16 + tail 1 + arm 1 + depends 1 +
  dependents 1 + log 1 + flows 1 + next 3 = 29). Then assert the CLI-level claim the ledger
  cares about: `expect(RENDERER_WORST_CASE + 1).toBe(30)` — the +1 stdout mapping line
  landing exactly on the option help's "≤ 30 lines" (no redundant `lessThanOrEqual` of the
  same number). A future line added to the renderer breaks this test by name.
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
- **Explicitly deferred (not dropped):** the node-view freshness recompute
  (`build-context.ts:321-331` — the `deriveLogGateState → undefined` branch re-reads the
  lock to keep the node view's definite `logState`). Deliberate, four lines, commented, the
  whole-branch review sized it lowest-value; it stays as-is.
- **User-gated, awaiting the maintainer (not this increment's to do):** the 12:28 log entry
  that cites session state (editing log history needs an explicit decision); the
  `read-or-default-via-helper` overdue `review_by`; the root-container chmod skipIf question
  in `.temp/dogfood-report.md`.
- Same SDD loop as Increment 1: fresh Sonnet implementer per task (no commits, no
  repo-check, combined-CA-bundle export in every shell command), Opus task review per task,
  fix loop, controller-run gate, one commit per task, push.
- Byte-identity is the increment's soul: any task whose guard suites show ANY output drift
  is BLOCKED, not adapted — the plan is wrong or the code is; escalate to the controller.
