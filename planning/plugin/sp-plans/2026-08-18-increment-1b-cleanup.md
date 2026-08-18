# Increment 1b — Context-View Consolidation & Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pay down the debts the Increment-1 whole-branch review priced — one derivation for
"this file's effective rules", one assembly for the scope marking, one whole-repo
classification per `yg context --file` invocation with one pair enumeration on the
node-owned paths (the type-covered paths keep a second, edge-less enumeration in the
marking chain — Task 3's contract ruling; the view-building enumeration at
`build-context.ts:159` is untouched and out of scope), and tests for the unpinned decision
branch and the worst-case line budget.

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
  `context-file-brief.test.ts`, `context-file.test.ts`) PLUS
  `tests/unit/cli/context-file-type-coverage.test.ts` (the suite dedicated to the
  type-covered full view; `build-context-progressive.test.ts:133-142` also pins its scope
  suffix) and `tests/unit/cli/build-context.test.ts` (option-registration
  smoke) pass unchanged in every task — this six-suite list
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
- Formatters render already-decided text; business decisions live in `build-context.ts`. TWO
  recorded exceptions stand: the draft/no-suffix decision lives in the formatter (D12), and
  Task 1 places `effectiveAspects` — the statement of which rules govern a file — in
  `context-file.ts` (co-located with the `FileContextData` type it reads and consumed by the
  renderer itself; the alternative would put a formatter's own read behind an import from
  its caller — note the `formatter` architecture type's own "no business logic" wording:
  no aspect enforces it, and changing the architecture is the maintainer's call, so the
  exception is recorded here instead). Do not move either.
- Graph ritual per task, same as Increment 1: any file whose behavior-describing
  `description:` changes gets that edit in the same commit; the `cli/commands/build-context`
  node is log-gated (`yg log add` with self-contained WHY prose — no references to plans,
  files, steps, or session state); new test files are added to the owning test node's
  `mapping:`; a new import edge between mapped nodes needs its relation declared (watch
  `max_direct_relations` and the fan-out leaderboard pin in
  `tests/integration/portal-derive-rest.test.ts` — currently `cli/tests/unit/cli/general` at
  30, `cli/commands/build-context` at 23/23; if a count moves, update the pin's assertion AND
  its narrative comment in the same commit).
- **Every step that runs a dist-spawning guard suite or `dist/bin.js` is preceded by
  `npm run build` in `source/cli/`** (a pure in-process RED step needs no build) — `dist/` is gitignored and never refreshed as a side effect; three of the
  six guard suites spawn the built binary behind `describe.skipIf(!distExists)`, including
  the byte-identity baseline, and a stale build makes them pass vacuously against pre-change
  code.
- `scripts/repo-check.sh` green before every commit (controller runs it; 7 chmod-simulation
  failures under root are documented container artifacts, not yours).
- No CHANGELOG entry per task; Task 5 closes the increment with ONE entry under
  `## [Unreleased]` covering the user-relevant part (cheaper file context on
  type-classified projects) — internal refactors are not release notes.
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
`composeBriefExtras`, feeding the third-pointer gate at `:496`, its push at `:497`, and
the scope-marking `aspectIds` at `:566`) and two hard-coded single-branch forms at the full-view
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

In `context-file-brief.test.ts`, add a NEW top-level describe after the existing ones
(import `effectiveAspects` alongside the existing imports):

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

- [ ] **Step 2: Run it — expect FAIL.** Under this repo's vitest, a named import the
  module does not export fails the WHOLE FILE at collection with
  `does not provide an export named 'effectiveAspects'` — every case in the file reports
  red, and that collection error IS the expected RED (do not read it as having broken the
  existing suite):
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
  `cd source/cli && npm run build && npx vitest run tests/unit/formatters/context-file-brief.test.ts tests/unit/formatters/context-file.test.ts tests/unit/cli/build-context-brief.test.ts tests/unit/cli/build-context-progressive.test.ts tests/unit/cli/context-file-type-coverage.test.ts tests/unit/cli/build-context.test.ts`
  (build first — three suites spawn `dist/bin.js`; the six-suite guard list from Global
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
  data: FileContextData, precomputed?: { edges?: TypedEdgeIndex; repoFiles?: string[];
  pairsWithUnreadable?: { pairs: ExpectedPair[]; unreadable: UnreadableSubject[] };
  typeCoverage?: TypeCoverageInput }): Promise<ScopeMarking>` (the full four-field shape —
  Step 1 dictates the body) — the single gate-walk-classify-enumerate-mark sequence. All three
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
(The compact site's current fallback is `?? []` — dead code in fact, because the retained
`:565` gate implies the walk at `:508-509` already ran; the helper's walk fallback is
equally unreachable from that site and live only for the node-owned full view, so
byte-identity holds at every site.)
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
    // reproduce the compact site's edges-spread guard (:529-531) — its two conditions
    // keep the node-owned full-view site on the un-spread arm:
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
`repoFiles` BEFORE `unreadable`. Keep the site-specific sentences AT their sites (the type-covered view's
`:756-770` comment about its single-entry covered map and already-made walk, and the
compact site's `:519-523` comment about `wholeGraphPairs` surviving the `try`, are true
only there); move only the shared gate-walk-classify-enumerate-mark rationale into the
helper.

- [ ] **Step 2: Replace all three call sites.** Compact (`composeBriefExtras`): the outer
  gate at `:565` — `if (graph.config.progressive?.reference !== undefined &&
  wholeGraphPairs !== undefined)` — is RETAINED VERBATIM. It is load-bearing twice over:
  when the arm-preview block throws, marking is deliberately skipped rather than paying for
  its own re-enumeration (the comment at `:519-523` says exactly this — the skip sentence is `:522-523`), and the byte-identity
  suites do not exercise that path, so a helper that silently enumerated there would change
  output unobserved. Inside the retained gate, call the helper with
  `{ edges: shared?.edges, repoFiles, pairsWithUnreadable: { pairs: wholeGraphPairs,
  unreadable: wholeGraphUnreadable ?? [] }, typeCoverage: wholeGraphTypeCoverage }` — the
  surviving variables are `wholeGraphPairs`/`wholeGraphUnreadable` (declared `:525-526`, assigned `:533`/`:534`; the
  `unreadable` binding at `:532` dies with the `try` block, and the retained gate narrows
  only `wholeGraphPairs`, hence the `?? []`, matching what `:566` passes today). The
  classification is try-local today (`const typeCoverage` at `:528`): hoist
  `let wholeGraphTypeCoverage: TypeCoverageInput | undefined;` alongside the other two
  hoisted variables, REPLACE the `const typeCoverage` binding at `:528` with an assignment
  to the hoisted name, and update the three reads at `:529-531` (the guard, the spread, and the else arm of the
  `typeCoverageWithEdges` construction) to read the hoisted name — no chained assignment. Without this the compact
  site has no classification to forward and Task 3's classify-once case cannot go green.
  (Note for the naming decision Task 1 bound: the `:566` reference to `governing` is
  deleted with the inlined block — the helper calls `effectiveAspects(data)` itself;
  `:496`/`:497` keep `governing`. This is not a violation of Task 1's decision. Comment
  placement: the reference-first/skip-the-enumeration sentence AND the fresh-whole-graph-
  enumeration/edges-spread clause move into the helper WITH the code they describe; what
  stays at the site is only the why-hand-over clause — this file's own `data` came from a
  single-entry covered map so nothing above is reusable, and `repoFiles` is the walk
  already made.)
  Type-covered full view: `{ edges, repoFiles }`. Node-owned full view: no precomputed
  argument beyond what it has today. Delete the three inlined blocks; the two full-view
  `reference !== undefined` gates MAY be deleted with them — the helper's own early return
  precedes the walk, so the cost property the site comments describe is preserved either
  way (say which you chose in the report).

- [ ] **Step 3: Prove byte-identity** — full guard suite run as in Task 1 Step 5 (all six
  suites, build first, + typecheck + lint). The in-process `computeScopeMarking` cases and every spawned
  progressive case must pass UNCHANGED.

- [ ] **Step 4: Graph ritual + report** — as Task 1 Step 6 (log entry: one assembly so the
  three views cannot drift in HOW they measure, matching the one derivation of WHAT they
  measure).

### Task 3: One classification, and one enumeration where the contract allows it

**Files:**
- Modify: `source/cli/src/cli/build-context.ts`
- Modify: `source/cli/src/cli/progressive-scope-resolve.ts`
- Test: Create `source/cli/tests/unit/cli/build-context-classify-once.test.ts`
- Modify: `.yggdrasil/model/cli/tests/unit/cli/general/yg-node.yaml` (mapping + description + any relation)
- Modify: `.yggdrasil/model/cli/progressive-scope-resolve/yg-node.yaml` (description — Step 6)
- Modify: `source/cli/tests/integration/portal-derive-rest.test.ts` (leaderboard pin — Step 6)

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
  `TypeCoverageResult`, a different exported interface from `core/type-coverage.ts:13-36`
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
  edge-less discriminator for all four runtime configurations of the three call sites
  (compact node-owned: `shared` absent;
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
    `tests/support/progressive-fixture.ts:52-62`; without it `computeScopeMarking` is never
    reached and the test is vacuously green) — build `graph` and `data` exactly as the
    sibling in-process cases do (`build-context-progressive.test.ts:151-153`: `loadGraph`
    on the fixture dir, `buildFileContextData` for the node-owned file) and cut a real
    measured branch like every sibling does:
    `f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');`.
    Assert `computeExpectedPairs` called EXACTLY ONCE for the whole call (a
    `beforeEach` `mockClear` on both spies, as the precedent file does, keeps every case
    self-contained). Expected first run: FAIL with 2 calls (today `measure()`
    re-enumerates).
  - Case B (classification-once, type-covered): use the
    `createTypeLevelProgressiveFixture` pattern from
    `build-context-progressive.test.ts:60-79` — copy ALL FIVE of its steps verbatim: copy
    `tests/fixtures/type-level-engine` (which HAS `coverage.type_level` on), append the
    reference, `git init -b main`/`add -A`/commit, `checkout -b work`, append to
    `src/leaf/a.ts`, `git add -A`, and commit (the add is required — nothing is staged).
    Bind `const graph = await loadGraph(dir);` before the dictated `repoFiles` line. The
    commits are load-bearing: without a merge base
    `measure()` returns at the global-fallback row BEFORE it ever classifies, and the case
    would pass at RED while pinning nothing. The type-covered
    `FileContextData` producer (`buildTypeCoveredFileContextData`) is module-private and
    `buildFileContextData` carries the wrong owner semantics, so build the third argument
    directly — this is NOT fabricated evidence (the fixture, graph, and config on disk are
    real; the call-count under test depends only on graph+config, and `data` merely selects
    the type-covered branch, the same way the formatter suite builds its own type-covered
    literals):

    ```ts
    const repoFiles = await walkRepoFiles(dir);
    const data: FileContextData = {
      filePath: 'src/leaf/a.ts', aspects: [], dependencies: [], dependentCount: 0,
      typeCoverage: { typeId: 'leaf', chainTerminationText: 'Inherited rules stop at the type.', applied: [], dropped: [] },
    };
    ```

    Then in-process `composeBriefExtras` on that data with
    `shared = { edges: { edgesFrom: () => [] }, repoFiles }` — a stub `TypedEdgeIndex`
    (one-method interface, `relations/pass.ts:103-108`) suffices to take the edges-spread
    branch and classifies nothing itself (`computeRelationEdgesForContext` is not exported,
    and running the real relation pass would pollute the counts). Call
    `mockComputeTypeCoverage.mockClear()` and `mockComputeExpectedPairs.mockClear()`
    IMMEDIATELY before the measured `composeBriefExtras` call so only it is counted.
    Assert `computeTypeCoverageCached` called EXACTLY ONCE. Expected first run: FAIL with
    2 calls (site + `measure()`'s `resolveTypeCoverage`). Do NOT assert
    `computeExpectedPairs === 1` here — per the contract ruling the type-covered path
    legitimately enumerates twice; assert EXACTLY TWO with a comment stating the rule inline (the type-covered
    enumeration carries an edges-resolved lattice, which the resolver's pessimistic
    edge-less contract — `progressive-scope-resolve.ts:308-320` — refuses to consume, so
    this path pays a second enumeration — no second classification — by design; no cost
    adjective: nothing here measures it), so a future third enumeration
    still fails.
  - Case C (direct threading): on its OWN fresh fixture (the Case-A recipe — a new
    `createProgressiveFixture({ ..., progressiveReference: REFERENCE_BRANCH })` +
    `branchWithEdit`; the per-case cleanup tears fixtures down, so never reuse Case A's
    instance): `resolveChangeScope` called directly with the full input —
    `{ graph, projectRoot: f.dir, coverageVisibleFiles: repoFiles, fullFlag: false,
    precomputed: { pairs } }` (no `typeCoverage` — this fixture classifies nothing by
    construction; the other fields are required by `ChangeScopeInput`, and a wrong
    `projectRoot` or `fullFlag: true` would silently resolve whole-project/unmeasurable) —
    `pairs` built from one explicit enumeration on the Case-A fixture → assert `expect(decision.kind).toBe('scoped')` FIRST (a decision that
    short-circuits earlier would make the count assertion vacuous), then that the spies show
    the call added ZERO further classification or enumeration calls (mockClear before the
    call). Note in a comment that the classification half is vacuous on this fixture by
    construction (`createProgressiveFixture` emits no `coverage.type_level`, so
    classification is 0 before and after — Case B carries the classification proof); the
    enumeration half is the load-bearing assertion here. Expected first run: FAIL — before
    the fix `precomputed` is not a field on `ChangeScopeInput`, it is ignored at runtime,
    and `measure()` enumerates for itself (enumeration spy at 1 instead of 0).

  Run the file BEFORE implementing — `cd source/cli && npx vitest run
  tests/unit/cli/build-context-classify-once.test.ts` (pure in-process; no build needed) —
  and record all three cases' observed counts (A: 2 enumerations; B: 2 classifications;
  C: 1 enumeration) as the RED evidence.

- [ ] **Step 2: Implement.** In `progressive-scope-resolve.ts`: add the optional
  `precomputed` field to `ChangeScopeInput` with a doc comment ("an already-computed
  classification and/or edge-less whole-graph enumeration from THIS invocation — measure()
  trusts it instead of paying for its own; callers own the freshness guarantee AND the
  guarantee that forwarded pairs were enumerated WITHOUT an edges-resolved lattice — see
  resolveTypeCoverage's own doc above for why the pessimistic, edge-less set is the
  contract" — state the rule inline and cite the in-repo doc, never a planning artifact); in `measure()`, use
  `input.precomputed?.typeCoverage ?? await resolveTypeCoverage(...)` and
  `input.precomputed?.pairs ?? (await computeExpectedPairs(graph, { typeCoverage })).pairs`.
  **Step 2b (the seed classification — the T4-review's deferred skip):**
  `computeRelationEdgesForContext` (`build-context.ts:124-128`, module-private, one caller
  at `:717`) already computes a whole-repo classification as its first line and throws it
  away after seeding the relation pass. Widen its return from the edge index alone to
  `{ edges, typeCoverage }` (adjust the one caller). Then widen `composeBriefExtras`'s
  `shared` parameter to `{ edges?: TypedEdgeIndex; repoFiles?: string[]; typeCoverage?:
  TypeCoverageInput }` (`build-context.ts:482` — additive and optional, so the existing
  in-process callers and Task 3's own Case B compile unchanged; `shared.typeCoverage` is
  NEW — only `assembleScopeMarking`'s `precomputed.typeCoverage` pre-exists from Task 2)
  and pass the seed's classification there at `:754`, plus into `assembleScopeMarking`'s
  `precomputed` at the type-covered full-view site. `composeBriefExtras` then
  uses `shared?.typeCoverage ?? await computeTypeCoverageForContext(...)` at its arm-preview
  classification (`:528` region), so a type-covered invocation classifies ONCE, at the seed.
  Node-owned paths are unaffected (no relation pass runs there). Update BOTH doc comments
  the widening falsifies: `composeBriefExtras`'s `shared` paragraph (`:465-477` — "passes
  both" becomes the walk, the edge index and the classification) and
  `computeRelationEdgesForContext`'s own (`:112-123` — it now returns the classification it
  seeds the pass with rather than discarding it) — plus the inline note at `:706-708`,
  whose second named consumer (composeBriefExtras's own classification) is gone: the walk
  now feeds the relation pass, the seed classification, and `assembleScopeMarking`.

  In `build-context.ts`: `computeScopeMarking` gains the two trailing optionals from the
  Produces block and threads `precomputed: { typeCoverage: precomputedTypeCoverage,
  pairs: precomputedPairs }` into `resolveChangeScope` (either may be undefined — the `??`
  fallbacks in `measure()` handle each independently); `assembleScopeMarking` (Task 2)
  passes the classification it computed or received, and sets `precomputedPairs =
  enumeration.pairs` ONLY when `precomputed?.edges === undefined` (the edge-less
  discriminator), with a comment citing the resolver's pessimism doc
  (`progressive-scope-resolve.ts:308-320`). Widen the resolver's `core/pairs.js` import to
  carry `type ExpectedPair` (today it imports only `computeExpectedPairs` and
  `type TypeCoverageInput` — `:37`; `cli/core/pairs` is already a declared relation on that
  node, so no graph edge changes). UPDATE `computeScopeMarking`'s own doc comment
  (`build-context.ts:386-404`): document both new trailing parameters, and replace the
  "the resolver ... does its own internal pair enumeration" clause with the new truth —
  the resolver reuses a forwarded edge-less enumeration when one is given, and only the
  type-covered configurations still let it enumerate for itself. (That clause was itself a
  prior review fix; leaving it stale re-opens a closed defect.) Verify: on the
  node-owned `--brief` path the arm preview's single enumeration now serves the preview AND
  the entire scope resolution; on the type-covered paths, with Step 2b, the SEED'S
  classification is the only one — reused by the arm preview and the resolver alike, ONE
  whole-repo classification per invocation, down from three. Note in your report that Case
  B's in-process window (stubbed edge index — the relation pass never runs there) exercises
  the site-level and resolver-level reuse only; the seed-level reuse has NO mechanical pin
  (the seed lives in the unexported command action, out of in-process reach, and the
  spawned suites assert output only) — Step 5's timing is its sole corroboration; say so
  in your report.
- [ ] **Step 3: The cache-boundary test stays green** — run
  `npx vitest run tests/unit/core/type-coverage.test.ts` (no new bare call sites) and
  `tests/unit/core/fill-classify-once.test.ts` (fill's own pin untouched).
- [ ] **Step 4: Run the new test — GREEN**, plus the full Task-1-Step-5 guard suites, plus
  `tests/unit/cli/check*.test.ts`, any suite named for `progressive` under
  `tests/unit/cli/`, AND the three progressive E2E suites the Global Constraints promise for
  this task: `tests/e2e/cli-progressive-gate.test.ts tests/e2e/cli-progressive-approve.test.ts
  tests/e2e/cli-progressive-byte-guard.test.ts` (the `resolveChangeScope` signature is
  consumed by `yg check` — its behavior must be provably unchanged when `precomputed` is
  absent, and these are the end-to-end proof).
- [ ] **Step 5: Measure and record.** This repo's own config has NO `progressive:` block and
  `type_level: false` — timing the repo itself proves nothing (the changed paths never run).
  `createTypeLevelProgressiveFixture` is a private test function — reproduce it by hand
  once — with <scratch-dir> OUTSIDE the repository tree (a raw git init inside it can
  discover the real .git; the hermetic test helper exists for exactly this reason):
  `cp -r source/cli/tests/fixtures/type-level-engine <scratch-dir>`; append
  `progressive:\n  reference: main` to its `.yggdrasil/yg-config.yaml`; inside the dir
  `git init -b main && git add -A && git -c user.name=yg-test -c user.email=yg-test@fixture.test commit -m base`;
  `git checkout -b work`; append a line to `src/leaf/a.ts`; then
  `git add -A && git -c user.name=yg-test -c user.email=yg-test@fixture.test commit -m edit`
  (the `add` is required — nothing is staged; the `-c` flags keep the measurement
  independent of whatever identity the host carries; the `cp -r` destination must not
  already exist). Then the timing, remembering two traps — `dist/` is gitignored so a bare
  `git stash` does NOT swap the binary, and the scratch dir is its own git repo so every
  `git stash` runs FROM THE REPOSITORY ROOT: time AFTER first (`npm run build` in
  `source/cli/`, then 3 runs of `node <abs-path>/dist/bin.js context --file src/leaf/a.ts
  --brief` in the fixture dir, median); then from the repo root `git stash`, rebuild in
  `source/cli/`, time BEFORE the same way; then `git stash pop` and rebuild. Delete
  `.yggdrasil/.type-class-cache/` and `.yggdrasil/.ast-cache/` in the fixture before EVERY
  timed run, including the first — the copied fixture already carries a warm AST cache from
  this repo's own test runs, so deleting only between runs would mix two cost regimes in
  one median. (The deletions dirty the scratch worktree; harmless — an unclean tree blocks
  only the honest-empty row, never scoped.) Alternatively record the medians explicitly as
  warm-cache lower bounds. Record both
  medians in the report; delete the scratch dir afterward. The call-count test is the
  primary evidence; the timing is corroboration, not a gate.
- [ ] **Step 6: Graph ritual + report** — mapping for the new test file; relation check (the
  new test imports `core/type-coverage` and `core/pairs` for spying — declare `uses` edges on
  the test node ONLY if the relation pass demands them). The general node currently sits at
  30 relations with `limit: 31` whose `reason:` prose names "the current count (30)" — one
  new edge lands on 31/31 with stale prose: bump the limit with headroom if the maintainer
  convention allows, or at minimum update the reason text to the new count, AND move the
  fan-out leaderboard pin (`portal-derive-rest.test.ts` — title, assertion, narrative
  comment) in the same commit. TWO description updates in the same commit, both promised by
  the Files list: (a) `cli/progressive-scope-resolve`'s node description — its unconditional
  "enumerates the run's expected obligations" sentence becomes conditional (the resolver
  classifies and enumerates for itself UNLESS the caller hands it an already-computed,
  edge-less pair set and/or classification from the same invocation, which it then trusts;
  the caller owns freshness and the edge-less guarantee) — `command-support` is not
  log-gated and nothing mechanical catches a stale description here, this step is the only
  guard; (b) one clause in `cli/tests/unit/cli/general`'s description noting the umbrella
  now carries a cost-invariant (call-count) suite. Log entry for `cli/commands/build-context`
  (product prose: a file's context reuses the measurement it already made instead of
  repeating it).

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
  loads while the architecture file lands in the touched set. (Two import adjustments the
  snippet needs in this file: add `readFileSync` to the existing `node:fs` import list, and
  write `path.join(...)` — the file imports `path` as a default binding, there is no bare
  `join`.) (Verify `f.commit` exists on
  the fixture handle; if the helper offers a different commit primitive, use it — the
  two-commit shape is the requirement.) Name the trigger in a test comment.
- [ ] **Step 2: Write the spawned case.** Coverage-closing for existing behavior (the
  Increment-1 rule): write it to the real behavior, then run it with a fresh build —
  `cd source/cli && npm run build && npx vitest run tests/unit/cli/build-context-progressive.test.ts`
  — and confirm the new case ACTUALLY RAN: the spawned block is `describe.skipIf(!distExists)`,
  so with no dist the whole block SKIPS, which is not a pass. If the case FAILS, STOP and
  report — a failure is a product bug. Fixture whose measured change touches
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
- Consumes: the budget arithmetic — on the two arms this command can reach (node-owned,
  type-covered; the unmapped arm exits 1 before --brief is honored and can emit one line
  more), the renderer's worst case WITH the scope header included is 28 at the 8-rule cap
  and 29 with the truncation tail; the +1 stdout mapping line on the
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
  cleanup becomes a matching `afterAll` — the fixture copy must not leak. (Add `beforeAll`
  and `afterAll` to the `vitest` import at `:1` — the file imports only
  `describe, it, expect, afterEach` today.)
- [ ] **Step 2: Write the worst-case budget pin.** One in-process case in
  `tests/unit/formatters/context-file-brief.test.ts` — the renderer is the budget's owner,
  that file already holds the 8-aspect cap fixture (`eight`, ~:18-26) this case is a sibling
  of, and `src/formatters/**` is coverage-measured. Build a `FileContextData` +
  `FileBriefExtras` with EVERY extra present and the aspect list at 9 (cap 8 + truncation
  tail): scope header, 8×2 aspect lines + tail line, arm preview, 4+ dependencies (overflow
  marker), dependents, log gate, flows, 3 pointers — and assert
  `formatFileContextBrief(...).trimEnd().split('\n').length` equals EXACTLY the arithmetic
  total (derive it in the test from TEST-LOCAL named constants — `const CAP = 8; const
  LINES_PER_RULE = 2;` etc.; do NOT export `BRIEF_ASPECT_CAP` from the formatter, this task
  touches no source file — with a comment mapping each line to the arithmetic derived
  below, inline in the test, citing nothing outside the repo: path 1 + owner 1 + scope 1 + must-satisfy 1 + 16 + tail 1 + arm 1 + depends 1 +
  dependents 1 + log 1 + flows 1 + next 3 = 29). Then restate the CLI-level claim in the option help's own terms:
  `expect(rendered.trimEnd().split('\n').length + 1).toBe(30)` — the +1 stdout mapping
  line landing exactly on "≤ 30 lines". (Implied by the first assertion, kept as
  documentation, not an independent guard — say so in its comment.) A future line added to the renderer breaks this test by name.
- [ ] **Step 3: Full guard suites + typecheck + lint.**
- [ ] **Step 4: CHANGELOG.** One line under `## [Unreleased]` in a `### Changed` section —
  the file currently has `### Added`, `### Fixed`, `### Documentation` and no `### Changed`;
  create it between `### Added` and `### Fixed` (Keep-a-Changelog order). The line must not
  over-claim — the type-covered paths deliberately keep a second enumeration per the
  contract ruling, and a relation-pass classification remains out of scope — so state ONLY the
  half that is never an over-claim: on projects that classify files by architecture type, a
  file's context view now reuses the classification it already made in the same run instead
  of redoing it, so it costs less on large repositories (the seed-level reuse needs no
  reference branch, so the branch-measurement conjunct would wrongly exclude a whole class
  of beneficiaries). (The enumeration claim is NOT
  unconditional — two of the four configurations still enumerate twice by design — and any
  magnitude adjective must be backed by Task 3 Step 5's recorded medians or omitted.) No
  counts, no path-specific claims — adopter-voiced, no internals. (This is the increment's only changelog line;
  Tasks 1-4 are internal.)
- [ ] **Step 5: Graph ritual + report** — mapping unchanged; log entry only if command
  source drifted (it does not in this task — say so).

---

## Execution notes (controller)

- Order is strict: T1 → T2 → T3 (each shapes the next); T4 and T5 may run in either order
  after T3.
- **The T4 task-review's deferred "redundant-classification skip" (its minor #3)** named
  the OTHER duplicate — the relation-pass seeding classification
  (`computeRelationEdgesForContext`'s first line) repeating the compact site's own on
  type-covered invocations; both existed at T4, before scope marking did. Task 3's Step 2b
  now pays it: the seed's classification is returned alongside `edges` and threaded through
  a new optional `shared.typeCoverage` field (Step 2b widens the parameter), taking
  type-covered invocations to ONE whole-repo classification.
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
