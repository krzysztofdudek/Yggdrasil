/**
 * `yg context --file` classifies the type-level coverage lattice
 * (coverage.type_level) and enumerates the whole-graph pair set AT MOST ONCE
 * per invocation, in every configuration that can legally share the work.
 * Before this fix, the arm-preview enumeration in `composeBriefExtras` and
 * the resolver's own internal measurement in `resolveChangeScope` each paid
 * for their own — up to three whole-repo classifications for one type-covered
 * `--file` call (the arm preview, the resolver, and the relation-pass seed).
 *
 * `resolveChangeScope`'s `ChangeScopeInput.precomputed` field is the seam:
 * `measure()` now trusts a forwarded classification and/or pair enumeration
 * instead of paying for its own, under the contract ruling in
 * progressive-scope-resolve.ts (`resolveTypeCoverage`'s doc, :317-329) — the
 * resolver's OWN enumeration must stay edge-less (a pessimistic gate), so an
 * edges-resolved enumeration is never forwarded, only the (edge-independent)
 * classification and an edge-less pair set.
 *
 * Three cases pin the three shapes this can take:
 *   A — node-owned: the arm preview's ONE enumeration also serves the
 *       resolver (no `edges`, so pairs ARE forwarded).
 *   B — type-covered: the arm preview's enumeration carries an edges-resolved
 *       lattice, so only the CLASSIFICATION is forwarded — the resolver still
 *       pays for its own (cheap, edge-less) enumeration, by design.
 *   C — direct threading: `resolveChangeScope` called with a `precomputed`
 *       pair set directly, proving `measure()` actually consumes it rather
 *       than silently ignoring an unread field.
 *
 * Isolated into its own file because it mocks TWO modules
 * (core/type-coverage.js and core/pairs.js) — mirroring
 * fill-classify-once.test.ts's own convention of moving a module-mocking test
 * out of a file whose other tests load the same modules for real (see
 * build-context-progressive.test.ts). Real on-disk/throwaway-git fixtures
 * throughout; no fabricated call-count data — see each case's own comment for
 * why its inputs are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync, cpSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line no-var
var typeCoverageRealFn: (typeof import('../../../src/core/type-coverage.js'))['computeTypeCoverageCached'] | undefined;
vi.mock('../../../src/core/type-coverage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/type-coverage.js')>();
  typeCoverageRealFn = actual.computeTypeCoverageCached;
  return {
    ...actual,
    computeTypeCoverageCached: vi.fn(actual.computeTypeCoverageCached),
  };
});
import { computeTypeCoverageCached } from '../../../src/core/type-coverage.js';
const mockComputeTypeCoverage = vi.mocked(computeTypeCoverageCached);

// eslint-disable-next-line no-var
var pairsRealFn: (typeof import('../../../src/core/pairs.js'))['computeExpectedPairs'] | undefined;
vi.mock('../../../src/core/pairs.js', async (importOriginal) => {
  // `...actual` preserves FileUnreadableError's class identity for the
  // `instanceof` check in build-context.ts's deriveLogGateState (~:263) —
  // mocking only the named export would replace the whole module and break
  // that identity check for every other in-process caller in this file.
  const actual = await importOriginal<typeof import('../../../src/core/pairs.js')>();
  pairsRealFn = actual.computeExpectedPairs;
  return {
    ...actual,
    computeExpectedPairs: vi.fn(actual.computeExpectedPairs),
  };
});
import { computeExpectedPairs } from '../../../src/core/pairs.js';
const mockComputeExpectedPairs = vi.mocked(computeExpectedPairs);

import { createProgressiveFixture, REFERENCE_BRANCH, type ProgressiveFixture } from '../../support/progressive-fixture.js';
import { runGitFixture } from '../../support/git-fixture.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { buildFileContextData } from '../../../src/core/context-builder.js';
import { composeBriefExtras } from '../../../src/cli/build-context.js';
import { resolveChangeScope } from '../../../src/cli/progressive-scope-resolve.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';
import { scanUncoveredFiles } from '../../../src/core/check.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';
import type { FileContextData } from '../../../src/formatters/context-file.js';
import type { TypeCoverageInput } from '../../../src/core/pairs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');

const fixtures: ProgressiveFixture[] = [];

beforeEach(() => {
  mockComputeTypeCoverage.mockClear();
  mockComputeExpectedPairs.mockClear();
});

afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

/**
 * A type-level fixture (no owning component) with a committed progressive
 * reference — copied verbatim from `build-context-progressive.test.ts`'s own
 * `createTypeLevelProgressiveFixture` (module-private there, so duplicated
 * here rather than imported): copy `tests/fixtures/type-level-engine`
 * (coverage.type_level ON), append the reference, commit on `main`, branch to
 * `work`, edit `src/leaf/a.ts`, commit again. The two commits are
 * load-bearing — without a merge base `measure()` returns at the
 * global-fallback row before it ever classifies, which would pin nothing.
 */
function createTypeLevelProgressiveFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-context-classify-once-typecov-'));
  cpSync(path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine'), dir, { recursive: true });
  appendFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), `progressive:\n  reference: ${REFERENCE_BRANCH}\n`, 'utf-8');

  const git = (args: string[]): void => {
    const r = runGitFixture(dir, args);
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
    }
  };
  git(['init', '-q', '-b', REFERENCE_BRANCH]);
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  git(['checkout', '-q', '-b', 'work']);
  appendFileSync(path.join(dir, 'src', 'leaf', 'a.ts'), 'export const b = 2;\n', 'utf-8');
  git(['add', '-A']);
  git(['commit', '-qm', 'edit leaf']);
  return dir;
}

describe('build-context — classifies/enumerates at most once per invocation', () => {
  it('Case A (node-owned): the arm preview\'s one enumeration also serves scope resolution', async () => {
    // The reference MUST be passed explicitly — it is off by default
    // (tests/support/progressive-fixture.ts:52-62); without it
    // computeScopeMarking is never reached and this test would be vacuously
    // green regardless of the fix.
    const f = createProgressiveFixture({ label: 'classify-once-a', progressiveReference: REFERENCE_BRANCH });
    fixtures.push(f);
    f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    const graph = await loadGraph(f.dir);
    const data = buildFileContextData(graph, 'src/alpha/alpha.ts', 'alpha');

    await composeBriefExtras(graph, 'src/alpha/alpha.ts', data);

    // Today (pre-fix) the arm preview enumerates once and resolveChangeScope's
    // measure() re-enumerates a second time for itself — 2 calls.
    expect(mockComputeExpectedPairs).toHaveBeenCalledTimes(1);
    expect(pairsRealFn).toBeDefined();
    // Non-vacuity: the pre-fix RED here is 2 enumerations, not 0 or 1 — that is
    // what establishes this path is actually reached. A future short-circuit
    // that skipped enumeration entirely would surface as 0/1 drift in Case C's
    // kind-guard (decision.kind !== 'scoped') and in Case B's exact-two pin.
  });

  it('Case B (type-covered): one classification serves both the arm preview and resolveTypeCoverage', async () => {
    const dir = createTypeLevelProgressiveFixture();
    try {
      const graph = await loadGraph(dir);
      const repoFiles = await walkRepoFiles(dir);
      // buildTypeCoveredFileContextData is module-private and
      // buildFileContextData carries the wrong (node-owned) owner semantics,
      // so the type-covered FileContextData shape is built directly here.
      // This is not fabricated evidence: the fixture, graph, and config on
      // disk are all real, the call-count under test depends only on
      // graph+config, and `data` merely selects the type-covered branch — the
      // same way the formatter suite builds its own type-covered literals.
      const data: FileContextData = {
        filePath: 'src/leaf/a.ts', aspects: [], dependencies: [], dependentCount: 0,
        typeCoverage: { typeId: 'leaf', chainTerminationText: 'Inherited rules stop at the type.', applied: [], dropped: [] },
      };
      // A stub TypedEdgeIndex (one-method interface, relations/pass.ts:103-108)
      // suffices to take the edges-spread branch. Running the real relation
      // pass would pollute the counts and computeRelationEdgesForContext is
      // not exported for a targeted call.
      const shared = { edges: { edgesFrom: () => [] }, repoFiles };

      // Cleared immediately before the measured call so only it is counted —
      // loadGraph/walkRepoFiles above classify/enumerate nothing themselves,
      // but this keeps the assertion robust to that changing.
      mockComputeTypeCoverage.mockClear();
      mockComputeExpectedPairs.mockClear();

      await composeBriefExtras(graph, 'src/leaf/a.ts', data, shared);

      expect(mockComputeTypeCoverage).toHaveBeenCalledTimes(1);
      expect(typeCoverageRealFn).toBeDefined();
      // NOT asserted at 1: per the contract ruling, the type-covered
      // enumeration carries an edges-resolved lattice, which the resolver's
      // pessimistic edge-less contract (progressive-scope-resolve.ts:317-329)
      // refuses to consume, so this path legitimately pays a SECOND
      // enumeration (no second classification) by design — pinned at exactly
      // two so a future THIRD enumeration still fails this test.
      expect(mockComputeExpectedPairs).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Case B2 (type-covered, classification forwarded): a real seeded typeCoverage classifies zero times', async () => {
    const dir = createTypeLevelProgressiveFixture();
    try {
      const graph = await loadGraph(dir);
      const repoFiles = await walkRepoFiles(dir);
      // Same helper chain Case B's own composeBriefExtras call resolves
      // internally (computeTypeCoverageForContext, module-private) — built
      // here directly so the test can seed `shared.typeCoverage` with a real
      // classification rather than a fabricated one.
      const uncovered = scanUncoveredFiles(graph, repoFiles);
      const result = await computeTypeCoverageCached(graph, uncovered, new FileContentCache());
      const typeCoverage: TypeCoverageInput = { covered: result.covered, ambiguousPaths: result.ambiguous.map((a) => a.file) };
      const data: FileContextData = {
        filePath: 'src/leaf/a.ts', aspects: [], dependencies: [], dependentCount: 0,
        typeCoverage: { typeId: 'leaf', chainTerminationText: 'Inherited rules stop at the type.', applied: [], dropped: [] },
      };
      const shared = { edges: { edgesFrom: () => [] }, repoFiles, typeCoverage };

      // Cleared immediately before the measured call so only it is counted —
      // the classification above (building the seed itself) must not be
      // attributed to composeBriefExtras.
      mockComputeTypeCoverage.mockClear();
      mockComputeExpectedPairs.mockClear();

      await composeBriefExtras(graph, 'src/leaf/a.ts', data, shared);

      // Pins the CONSUMER half of the seed reuse: with a real `typeCoverage`
      // forwarded, composeBriefExtras's `shared?.typeCoverage ??` branch never
      // falls through to computeTypeCoverageCached — zero classifications.
      // (The PRODUCER half — the command action itself seeding
      // `shared.typeCoverage` for a live invocation — has no in-process seam
      // to assert on directly; only this consumer branch is testable here.)
      expect(mockComputeTypeCoverage).toHaveBeenCalledTimes(0);
      // Enumeration is unaffected by classification reuse — still exactly two,
      // matching Case B's own pin, since the edges-spread branch always pays
      // for its own enumeration regardless of where the classification came from.
      expect(mockComputeExpectedPairs).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Case C (direct threading): resolveChangeScope trusts a forwarded pair set instead of re-enumerating', async () => {
    // Its own fresh fixture — the per-case cleanup tears fixtures down, so
    // Case A's instance is never reused here.
    const f = createProgressiveFixture({ label: 'classify-once-c', progressiveReference: REFERENCE_BRANCH });
    fixtures.push(f);
    f.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 2;\n');
    const graph = await loadGraph(f.dir);
    const repoFiles = await walkRepoFiles(f.dir);
    const { pairs } = await computeExpectedPairs(graph, {});

    mockComputeExpectedPairs.mockClear();
    mockComputeTypeCoverage.mockClear();

    const decision = await resolveChangeScope({
      graph,
      projectRoot: f.dir,
      coverageVisibleFiles: repoFiles,
      fullFlag: false,
      precomputed: { pairs },
    });

    // Asserted FIRST: a decision that short-circuits earlier (e.g.
    // 'whole-project' or 'unmeasurable') would make the call-count assertion
    // below vacuous.
    expect(decision.kind).toBe('scoped');
    // The classification half is vacuous on this fixture by construction —
    // createProgressiveFixture emits no coverage.type_level, so
    // mockComputeTypeCoverage is 0 both before and after; Case B carries the
    // classification proof. The enumeration half is the load-bearing
    // assertion here: before the fix, `precomputed` is not a field on
    // ChangeScopeInput, it is ignored at runtime, and measure() enumerates
    // for itself (1 call instead of 0).
    expect(mockComputeTypeCoverage).not.toHaveBeenCalled();
    expect(mockComputeExpectedPairs).not.toHaveBeenCalled();
  });
});
