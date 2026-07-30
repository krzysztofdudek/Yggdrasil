/**
 * Unit tests for core/type-visibility.ts: the artifact that records, per
 * (file, aspectId), why a rule attached to a type-covered file's type does
 * not enforce on it — assembled from core/pairs.ts's static drops, the
 * deterministic runner's own typed dispositions, and the REAL applied-pair
 * set (the one and only ground truth for "enforced" / "advisory").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTypeVisibility,
  classifyRunnerDisposition,
  describeTypeVisibilityReason,
} from '../../../src/core/type-visibility.js';
import type { TypeVisibilityRow, TypeVisibilityAppliedPair } from '../../../src/core/type-visibility.js';
import { computeExpectedPairs } from '../../../src/core/pairs.js';
import type { TypeCoverageInput, ExpectedPair } from '../../../src/core/pairs.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { runStructureAspect, StructureRunnerError } from '../../../src/structure/runner.js';
import type { StructureUnit } from '../../../src/structure/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { cleanupTestGraphs } from '../helpers/build-test-graph.js';
import { FIXTURE_NODELESS_RUNNER, FIXTURE_CYCLIC_TYPE } from '../../fixtures/type-level-engine/variants/index.js';
import type { Graph, GraphNode, AspectDef, ScopeDef, WhenPredicate } from '../../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');

// ---------------------------------------------------------------------------
// Minimal hand-built graph (mirrors pairs-type-coverage.test.ts's own
// buildTypeCoverageGraph) — used only for the one reason no fixture aspect
// declares (scope.files) plus the two other static reasons, each isolated to
// exactly one drop so "exactly one row" is unambiguous.
// ---------------------------------------------------------------------------

interface TCAspect {
  id: string;
  kind: 'llm' | 'deterministic' | 'aggregate';
  status?: 'draft' | 'advisory' | 'enforced';
  scope?: ScopeDef;
  implies?: string[];
}

interface TCArchType {
  id: string;
  aspects?: string[];
  parents?: string[];
  when?: WhenPredicate;
}

function buildTypeCoverageGraph(
  tmpDir: string,
  opts: { nodeTypes: TCArchType[]; aspects: TCAspect[] },
): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });

  const aspectDefs: AspectDef[] = opts.aspects.map((a) => ({
    id: a.id,
    name: a.id,
    reviewer: { type: a.kind },
    status: a.status ?? 'enforced',
    artifacts: a.kind === 'aggregate' ? [] : [{ filename: a.kind === 'llm' ? 'content.md' : 'check.mjs', content: 'rule' }],
    scope: a.scope,
    implies: a.implies,
  } as AspectDef));

  const nodeTypes: Record<string, { description: string; aspects?: string[]; parents?: string[]; when?: WhenPredicate }> = {};
  for (const t of opts.nodeTypes) {
    nodeTypes[t.id] = { description: t.id, aspects: t.aspects, parents: t.parents, when: t.when };
  }

  return {
    config: {
      version: '5.2.0',
      reviewer: { tiers: { default: { provider: 'ollama', model: 'test', temperature: 0, consensus: 1 } }, default: 'default' },
      coverage: { required: ['/'], excluded: [], typeLevel: true },
    },
    architecture: { node_types: nodeTypes },
    nodes: new Map<string, GraphNode>(),
    aspects: aspectDefs,
    flows: [],
    rootPath,
  } as unknown as Graph;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-type-visibility-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content = 'content'): void {
  const abs = path.join(tmpDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function tc(covered: Array<[string, string]>): TypeCoverageInput {
  return { covered: new Map(covered), ambiguousPaths: [] };
}

/** The real, nodeless (file-only) pairs computeExpectedPairs produced — the ONLY ground truth buildTypeVisibility's enforced/advisory derivation may use. */
function applied(pairs: ExpectedPair[]): TypeVisibilityAppliedPair[] {
  return pairs
    .filter((p) => p.nodePath === undefined)
    .map((p) => ({ file: p.subjectFiles[0], aspectId: p.aspectId, status: p.status }));
}

// ---------------------------------------------------------------------------
// Step 1 — one row per reason (9 its; 8 real, 1 .todo for Task 9)
// ---------------------------------------------------------------------------

describe('buildTypeVisibility — one row per reason (Step 1)', () => {
  it('when-not-satisfied: an attached rule whose when: never matches a file-level unit', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['port-gated-rule'] }],
      aspects: [{
        id: 'port-gated-rule',
        kind: 'deterministic',
        scope: { per: 'file' },
      }],
    });
    // Attach-site when unavailable on TCArchType (aspectWhens), so gate it on
    // the aspect's own global `when` instead — same effect (never true here).
    (graph.aspects[0] as AspectDef).when = { node: { has_port: 'x' } };
    const typeCoverage = tc([['src/leaf/a.ts', 'leaf']]);
    const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    expect(report.rows).toEqual<TypeVisibilityRow[]>([
      { file: 'src/leaf/a.ts', aspectId: 'port-gated-rule', reason: 'when-not-satisfied' },
    ]);
  });

  it('draft: an attached rule whose status is draft', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['draft-rule'] }],
      aspects: [{ id: 'draft-rule', kind: 'deterministic', scope: { per: 'file' }, status: 'draft' }],
    });
    const typeCoverage = tc([['src/leaf/a.ts', 'leaf']]);
    const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    expect(report.rows).toEqual<TypeVisibilityRow[]>([
      { file: 'src/leaf/a.ts', aspectId: 'draft-rule', reason: 'draft' },
    ]);
  });

  it('whole-unit-rule: a per:node rule has no component to run on for a nodeless file', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['comp-rule'] }],
      aspects: [{ id: 'comp-rule', kind: 'deterministic' }], // no scope -> per: node default
    });
    const typeCoverage = tc([['src/leaf/a.ts', 'leaf']]);
    const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    expect(report.rows).toEqual<TypeVisibilityRow[]>([
      { file: 'src/leaf/a.ts', aspectId: 'comp-rule', reason: 'whole-unit-rule' },
    ]);
  });

  it('scope.files-excluded: the rule\'s own file filter excludes this file', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['narrow-rule'] }],
      aspects: [{
        id: 'narrow-rule',
        kind: 'deterministic',
        scope: { per: 'file', files: { path: 'src/leaf/never-matches/**' } },
      }],
    });
    const typeCoverage = tc([['src/leaf/a.ts', 'leaf']]);
    const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    expect(report.rows).toEqual<TypeVisibilityRow[]>([
      { file: 'src/leaf/a.ts', aspectId: 'narrow-rule', reason: 'scope.files-excluded' },
    ]);
  });

  it('aspect-undefined: the architecture attaches an id no aspect defines — never silently dropped', async () => {
    writeFile('src/leaf/a.ts');
    // A graph a real loader rejects (checkDanglingAspectRefs) — reachable here
    // only via a hand-built Graph that bypasses the parser, mirroring the
    // 'empty-parents' precedent for the same reason.
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['ghost-rule'] }],
      aspects: [],
    });
    const typeCoverage = tc([['src/leaf/a.ts', 'leaf']]);
    const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage });
    expect(pairs).toEqual([]);
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    expect(report.rows).toEqual<TypeVisibilityRow[]>([
      { file: 'src/leaf/a.ts', aspectId: 'ghost-rule', reason: 'aspect-undefined' },
    ]);
  });

  it('unreadable: a subject file that vanished from disk is dropped, not silently read as enforced', async () => {
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['own-file-rule'] }],
      aspects: [{ id: 'own-file-rule', kind: 'deterministic', scope: { per: 'file' } }],
    });
    const typeCoverage = tc([['src/leaf/missing.ts', 'leaf']]);
    const { drops, pairs, unreadable } = await computeExpectedPairs(graph, { typeCoverage });
    expect(pairs).toEqual([]);
    expect(unreadable).toHaveLength(1);
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    expect(report.rows).toEqual<TypeVisibilityRow[]>([
      { file: 'src/leaf/missing.ts', aspectId: 'own-file-rule', reason: 'unreadable' },
    ]);
  });

  it('binary-subject: an LLM rule over a binary file records a reason, never a silent gap', async () => {
    writeFile('src/leaf/logo.png', 'binary-ish content');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['llm-rule'] }],
      aspects: [{ id: 'llm-rule', kind: 'llm', scope: { per: 'file' } }],
    });
    const typeCoverage = tc([['src/leaf/logo.png', 'leaf']]);
    const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage });
    expect(pairs).toEqual([]);
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    expect(report.rows).toEqual<TypeVisibilityRow[]>([
      { file: 'src/leaf/logo.png', aspectId: 'llm-rule', reason: 'binary-subject' },
    ]);
  });

  describe('runtime reasons — real Task 7 fixtures (nodeless-runner)', () => {
    let projectRoot: string;
    beforeEach(() => {
      projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-type-visibility-runtime-'));
      cpSync(BASE_FIXTURE, projectRoot, { recursive: true });
      cpSync(FIXTURE_NODELESS_RUNNER, projectRoot, { recursive: true });
    });
    afterEach(() => {
      rmSync(projectRoot, { recursive: true, force: true });
      cleanupTestGraphs();
    });

    const emptyGraph = () => buildTestGraphForStructure({ nodes: [] });
    const aspectDir = (id: string) => path.join(projectRoot, '.yggdrasil', 'aspects', id);
    function fileUnit(allowedReads: string[], file = 'src/leaf/a.ts', typeId = 'leaf'): StructureUnit {
      return { kind: 'file', file, typeId, allowedReads };
    }

    it('read-beyond-architecture: a real STRUCTURE_UNDECLARED_FS_READ disposition', async () => {
      let caught: unknown;
      try {
        await runStructureAspect({
          aspectDir: aspectDir('reads-forbidden'),
          aspectId: 'reads-forbidden',
          unit: fileUnit(['src/leaf/a.ts']), // 'src/forbidden/x.ts' deliberately absent
          graph: emptyGraph(),
          projectRoot,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(StructureRunnerError);
      const reason = classifyRunnerDisposition((caught as StructureRunnerError).code);
      expect(reason).toBe('read-beyond-architecture');
      const row: TypeVisibilityRow = { file: 'src/leaf/a.ts', aspectId: 'reads-forbidden', reason: reason! };
      const report = buildTypeVisibility(
        buildTestGraphForStructure({ nodes: [] }),
        new Map([['src/leaf/a.ts', 'leaf']]),
        [],
        [row],
        [],
      );
      expect(report.rows).toEqual<TypeVisibilityRow[]>([row]);
    });

    it('node-context-required: a real STRUCTURE_NODE_CONTEXT_UNAVAILABLE disposition', async () => {
      let caught: unknown;
      try {
        await runStructureAspect({
          aspectDir: aspectDir('touches-node'),
          aspectId: 'touches-node',
          unit: fileUnit(['src/leaf/a.ts']),
          graph: emptyGraph(),
          projectRoot,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(StructureRunnerError);
      const reason = classifyRunnerDisposition((caught as StructureRunnerError).code);
      expect(reason).toBe('node-context-required');
      const row: TypeVisibilityRow = { file: 'src/leaf/a.ts', aspectId: 'touches-node', reason: reason! };
      const report = buildTypeVisibility(
        buildTestGraphForStructure({ nodes: [] }),
        new Map([['src/leaf/a.ts', 'leaf']]),
        [],
        [row],
        [],
      );
      expect(report.rows).toEqual<TypeVisibilityRow[]>([row]);
    });
  });

  // Task 9 owns the companion-hook failure this reason represents; until then
  // no producer ever constructs a row with it. Unskip there.
  it.todo('companion-context-failed: a companion.mjs that could not resolve a dependency for a type-covered file');
});

// ---------------------------------------------------------------------------
// The report shape: enforced/advisory (from real pairs, never inferred),
// zero-enforcement, half-expanded bundles, chain termination, dropped counts.
// ---------------------------------------------------------------------------

describe('buildTypeVisibility — report shape (real type-level-engine fixture)', () => {
  it('names a half-expanded bundle: the file-level half enforces, the whole-unit half is dropped', async () => {
    const graph = await loadGraph(BASE_FIXTURE);
    const typeCoverage = tc([['src/leaf/a.ts', 'leaf']]);
    const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    const leafBlock = report.byType.find((b) => b.typeId === 'leaf')!;
    expect(leafBlock.halfExpandedBundles).toEqual([
      { bundleId: 'bundle', enforced: ['own-file-rule'], dropped: ['whole-unit-rule'] },
    ]);
  });

  it('reports the fork chain termination for the "forked" type, candidates sorted', async () => {
    const graph = await loadGraph(BASE_FIXTURE);
    const typeCoverage = tc([['src/forked/f.ts', 'forked']]);
    const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    const forkedBlock = report.byType.find((b) => b.typeId === 'forked')!;
    expect(forkedBlock.chainTermination).toEqual({ reason: 'fork', candidates: ['mid', 'top'] });
  });

  it('a type whose only attached rule is enforced has an empty dropped list and a non-empty enforced list', async () => {
    const graph = await loadGraph(BASE_FIXTURE);
    const typeCoverage = tc([['src/helper/h.ts', 'classifying-parent']]);
    const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    const block = report.byType.find((b) => b.typeId === 'classifying-parent')!;
    expect(block.enforced).toEqual(['classifying-parent-rule']);
    expect(block.dropped).toEqual([]);
    expect(block.files).toEqual(['src/helper/h.ts']);
  });

  // K2 mitigation (dead-law relaxation): a rule live on only ONE accidental
  // file must be visible as a count of 1, never just a bare, uncounted name.
  it('enforcedCounts names how many files of the type each enforced rule actually runs on', () => {
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['own-rule'] }],
      aspects: [{ id: 'own-rule', kind: 'deterministic', scope: { per: 'file' } }],
    });
    // own-rule enforces on a.ts only; b.ts and c.ts are dropped for some OTHER
    // reason (a stand-in — the exact reason does not matter to this pin) and
    // correspondingly carry no applied pair.
    const covered = new Map([
      ['src/leaf/a.ts', 'leaf'],
      ['src/leaf/b.ts', 'leaf'],
      ['src/leaf/c.ts', 'leaf'],
    ]);
    const staticDrops = [
      { file: 'src/leaf/b.ts', aspectId: 'own-rule', reason: 'when-not-satisfied' as const },
      { file: 'src/leaf/c.ts', aspectId: 'own-rule', reason: 'when-not-satisfied' as const },
    ];
    const appliedPairs: TypeVisibilityAppliedPair[] = [
      { file: 'src/leaf/a.ts', aspectId: 'own-rule', status: 'enforced' },
    ];
    const report = buildTypeVisibility(graph, covered, staticDrops, [], appliedPairs);
    const block = report.byType.find((b) => b.typeId === 'leaf')!;
    expect(block.enforced).toEqual(['own-rule']);
    expect(block.enforcedCounts).toEqual([{ aspectId: 'own-rule', count: 1 }]);
  });

  it('advisory rules are counted and named separately from enforced — never folded under the same heading', () => {
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['warn-only'] }],
      aspects: [{ id: 'warn-only', kind: 'deterministic', scope: { per: 'file' }, status: 'advisory' }],
    });
    const covered = new Map([['src/leaf/a.ts', 'leaf']]);
    const appliedPairs: TypeVisibilityAppliedPair[] = [
      { file: 'src/leaf/a.ts', aspectId: 'warn-only', status: 'advisory' },
    ];
    const report = buildTypeVisibility(graph, covered, [], [], appliedPairs);
    const block = report.byType.find((b) => b.typeId === 'leaf')!;
    expect(block.enforced).toEqual([]);
    expect(block.enforcedCounts).toEqual([]);
    expect(block.advisory).toEqual(['warn-only']);
    expect(block.advisoryCounts).toEqual([{ aspectId: 'warn-only', count: 1 }]);
    // An advisory-only file still HAS enforcement running on it (a real pair
    // exists) — it must never be counted as zero-enforcement.
    expect(report.zeroEnforcement).toEqual({ count: 0, samples: [] });
  });

  it('enforced/advisory disagreeing with the absence of a drop can never happen: a missing drop row does not manufacture enforcement', () => {
    // No staticDrops recorded for 'ghost-rule' AND no applied pair for it —
    // exactly the shape a silent `continue` used to produce. The old
    // subtraction-based derivation ("declared minus dropped") would have
    // wrongly counted this as enforced; the real-pairs derivation does not.
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['ghost-rule'] }],
      aspects: [], // never defined — nothing can ever produce a pair for it
    });
    const covered = new Map([['src/leaf/a.ts', 'leaf']]);
    const report = buildTypeVisibility(graph, covered, [], [], []);
    const block = report.byType.find((b) => b.typeId === 'leaf')!;
    expect(block.enforced).toEqual([]);
    expect(block.advisory).toEqual([]);
    expect(report.zeroEnforcement).toEqual({ count: 1, samples: ['src/leaf/a.ts'] });
  });

  it('zero-enforcement: a file whose only attached rule is whole-unit has zero applicable rules', async () => {
    // 'emptyparents' declared with ONLY whole-unit-rule -> src/ep/e.ts is
    // covered by its type with nothing that can ever run at file granularity.
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'emptyparents', aspects: ['whole-unit-rule'], parents: [] }],
      aspects: [{ id: 'whole-unit-rule', kind: 'deterministic' }], // per: node default
    });
    writeFile('src/ep/e.ts');
    const typeCoverage = tc([['src/ep/e.ts', 'emptyparents']]);
    const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    expect(report.zeroEnforcement).toEqual({ count: 1, samples: ['src/ep/e.ts'] });
  });

  it('a type-covered file whose type hit an implies cycle is excluded from zero-enforcement and reported as uncomputable instead, grouped by the cycle aspect id (real fixture)', async () => {
    // Combines the base fixture's own genuine zero-enforcement file
    // (src/ep/e.ts — 'emptyparents' declares no aspects at all) with the
    // cyclic-type variant's file (src/cyclic/z.ts — the cascade absorbs an
    // implies cycle) in the SAME run, so the two honest-but-distinct outcomes
    // ("resolution ran and found nothing" vs. "resolution never ran") are
    // pinned side by side, never folded into one bucket.
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-type-visibility-cyclic-'));
    cpSync(BASE_FIXTURE, projectRoot, { recursive: true });
    cpSync(FIXTURE_CYCLIC_TYPE, projectRoot, { recursive: true });
    try {
      const graph = await loadGraph(projectRoot);
      const typeCoverage = tc([
        ['src/cyclic/z.ts', 'cyclic'],
        ['src/ep/e.ts', 'emptyparents'],
      ]);
      const { drops, pairs, uncomputableTypeCoverage } = await computeExpectedPairs(graph, { typeCoverage });
      const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs), uncomputableTypeCoverage);
      expect(report.zeroEnforcement).toEqual({ count: 1, samples: ['src/ep/e.ts'] });
      expect(report.uncomputable).toEqual({
        count: 1,
        groups: [{ aspectId: 'cyclic-a', files: ['src/cyclic/z.ts'] }],
      });
      const cyclicBlock = report.byType.find((b) => b.typeId === 'cyclic')!;
      expect(cyclicBlock.uncomputable).toEqual([{ aspectId: 'cyclic-a', files: ['src/cyclic/z.ts'] }]);
      // No pair was ever produced for it, so 'Enforced' stays empty too — but
      // this block's own `uncomputable` entry is what tells the two apart,
      // never an absence a caller could misread as "nothing applies".
      expect(cyclicBlock.enforced).toEqual([]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('buildTypeVisibility groups uncomputable files by their cycle aspect id, files sorted within a group', () => {
    const graph = buildTypeCoverageGraph(tmpDir, { nodeTypes: [{ id: 'leaf', aspects: [] }], aspects: [] });
    const covered = new Map([['src/leaf/b.ts', 'leaf'], ['src/leaf/a.ts', 'leaf'], ['src/leaf/c.ts', 'leaf']]);
    const uncomputable = [
      { file: 'src/leaf/b.ts', typeId: 'leaf', cycle: { aspectId: 'loop-a' } },
      { file: 'src/leaf/a.ts', typeId: 'leaf', cycle: { aspectId: 'loop-a' } },
      { file: 'src/leaf/c.ts', typeId: 'leaf', cycle: { aspectId: 'loop-x' } },
    ];
    const report = buildTypeVisibility(graph, covered, [], [], [], uncomputable);
    const block = report.byType.find((b) => b.typeId === 'leaf')!;
    expect(block.uncomputable).toEqual([
      { aspectId: 'loop-a', files: ['src/leaf/a.ts', 'src/leaf/b.ts'] },
      { aspectId: 'loop-x', files: ['src/leaf/c.ts'] },
    ]);
    expect(report.uncomputable).toEqual({
      count: 3,
      groups: [
        { aspectId: 'loop-a', files: ['src/leaf/a.ts', 'src/leaf/b.ts'] },
        { aspectId: 'loop-x', files: ['src/leaf/c.ts'] },
      ],
    });
    // None of these three files count toward zero-enforcement — their rules
    // were never resolved, not resolved-and-empty.
    expect(report.zeroEnforcement).toEqual({ count: 0, samples: [] });
  });

  it('a file with at least one enforced rule is never counted as zero-enforcement', async () => {
    const graph = await loadGraph(BASE_FIXTURE);
    const typeCoverage = tc([['src/leaf/a.ts', 'leaf']]);
    const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    expect(report.zeroEnforcement).toEqual({ count: 0, samples: [] });
  });

  it('dropped counts group by (aspectId, reason) across every file of the type, never capped', () => {
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['comp-rule'] }],
      aspects: [{ id: 'comp-rule', kind: 'deterministic' }],
    });
    const covered = new Map([['src/leaf/a.ts', 'leaf'], ['src/leaf/b.ts', 'leaf']]);
    const staticDrops = [
      { file: 'src/leaf/a.ts', aspectId: 'comp-rule', reason: 'whole-unit-rule' as const },
      { file: 'src/leaf/b.ts', aspectId: 'comp-rule', reason: 'whole-unit-rule' as const },
    ];
    const report = buildTypeVisibility(graph, covered, staticDrops, [], []);
    const block = report.byType.find((b) => b.typeId === 'leaf')!;
    expect(block.dropped).toEqual([{ aspectId: 'comp-rule', reason: 'whole-unit-rule', count: 2 }]);
  });

  it('caps the zero-enforcement sample list but never the count', () => {
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'emptyparents', aspects: ['whole-unit-rule'] }],
      aspects: [{ id: 'whole-unit-rule', kind: 'deterministic' }],
    });
    const files = Array.from({ length: 20 }, (_, i) => `src/ep/e${String(i).padStart(2, '0')}.ts`);
    const covered = new Map(files.map((f) => [f, 'emptyparents']));
    const staticDrops = files.map((f) => ({ file: f, aspectId: 'whole-unit-rule', reason: 'whole-unit-rule' as const }));
    const report = buildTypeVisibility(graph, covered, staticDrops, [], []);
    expect(report.zeroEnforcement.count).toBe(20);
    expect(report.zeroEnforcement.samples).toHaveLength(12);
    expect(report.zeroEnforcement.samples).toEqual(files.slice(0, 12));
  });

  // Mixed-case identifiers so a reversion to locale-sensitive (.localeCompare)
  // collation actually produces a DIFFERENT order than code-point (<) —
  // plain lowercase ascii names collate identically either way and would
  // leave a comparator swap undetected. Verified in this exact Node runtime:
  // code-point sorts ['Beta.ts', 'alpha.ts', 'bravo.ts'] ('B'=0x42 < 'a'=0x61
  // < 'b'=0x62); .localeCompare (en-US) sorts ['alpha.ts', 'Beta.ts',
  // 'bravo.ts'] (case is a tertiary difference, so base letters a < b decide
  // first) — a genuinely different order, not just a coincidentally-identical
  // one.
  it('rows are sorted by (file, aspectId, reason) in code-point order, never locale', () => {
    const graph = buildTypeCoverageGraph(tmpDir, { nodeTypes: [{ id: 't', aspects: [] }], aspects: [] });
    const covered = new Map([['bravo.ts', 't'], ['alpha.ts', 't'], ['Beta.ts', 't']]);
    const staticDrops = [
      { file: 'bravo.ts', aspectId: 'z', reason: 'draft' as const },
      { file: 'alpha.ts', aspectId: 'Bravo', reason: 'draft' as const },
      { file: 'alpha.ts', aspectId: 'alpha', reason: 'draft' as const },
      { file: 'Beta.ts', aspectId: 'z', reason: 'draft' as const },
    ];
    const report = buildTypeVisibility(graph, covered, staticDrops, [], []);
    expect(report.rows.map((r) => `${r.file}:${r.aspectId}`)).toEqual([
      'Beta.ts:z',
      'alpha.ts:Bravo',
      'alpha.ts:alpha',
      'bravo.ts:z',
    ]);
  });

  // Same divergence, applied to the dropped-list comparator (grouped by
  // aspectId within one type's block) — a distinct comparator from rows'.
  it('dropped rows are grouped and sorted by (aspectId, reason) in code-point order, never locale', () => {
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['bravo-rule', 'alpha-rule', 'Beta-rule'] }],
      aspects: [
        { id: 'bravo-rule', kind: 'deterministic' },
        { id: 'alpha-rule', kind: 'deterministic' },
        { id: 'Beta-rule', kind: 'deterministic' },
      ],
    });
    const covered = new Map([['src/leaf/a.ts', 'leaf']]);
    const staticDrops = [
      { file: 'src/leaf/a.ts', aspectId: 'bravo-rule', reason: 'whole-unit-rule' as const },
      { file: 'src/leaf/a.ts', aspectId: 'alpha-rule', reason: 'whole-unit-rule' as const },
      { file: 'src/leaf/a.ts', aspectId: 'Beta-rule', reason: 'whole-unit-rule' as const },
    ];
    const report = buildTypeVisibility(graph, covered, staticDrops, [], []);
    const block = report.byType.find((b) => b.typeId === 'leaf')!;
    expect(block.dropped.map((d) => d.aspectId)).toEqual(['Beta-rule', 'alpha-rule', 'bravo-rule']);
  });

  // Same divergence again, applied to the half-expanded-bundle comparator
  // (sorted by bundleId) — a third, independent comparator.
  it('half-expanded bundles are ordered by bundleId in code-point order, never locale', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['bravo-bundle', 'alpha-bundle', 'Beta-bundle'] }],
      aspects: [
        { id: 'bravo-bundle', kind: 'aggregate', implies: ['bravo-file-rule', 'bravo-node-rule'] },
        { id: 'alpha-bundle', kind: 'aggregate', implies: ['alpha-file-rule', 'alpha-node-rule'] },
        { id: 'Beta-bundle', kind: 'aggregate', implies: ['beta-file-rule', 'beta-node-rule'] },
        { id: 'bravo-file-rule', kind: 'deterministic', scope: { per: 'file' } },
        { id: 'bravo-node-rule', kind: 'deterministic' },
        { id: 'alpha-file-rule', kind: 'deterministic', scope: { per: 'file' } },
        { id: 'alpha-node-rule', kind: 'deterministic' },
        { id: 'beta-file-rule', kind: 'deterministic', scope: { per: 'file' } },
        { id: 'beta-node-rule', kind: 'deterministic' },
      ],
    });
    const typeCoverage = tc([['src/leaf/a.ts', 'leaf']]);
    const { drops, pairs } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, [], applied(pairs));
    const block = report.byType.find((b) => b.typeId === 'leaf')!;
    expect(block.halfExpandedBundles.map((b) => b.bundleId)).toEqual(['Beta-bundle', 'alpha-bundle', 'bravo-bundle']);
  });

  it('describeTypeVisibilityReason gives a distinct, non-empty phrase for every reason', () => {
    const reasons = [
      'when-not-satisfied', 'draft', 'whole-unit-rule', 'scope.files-excluded',
      'aspect-undefined', 'unreadable', 'binary-subject',
      'read-beyond-architecture', 'node-context-required', 'companion-context-failed',
    ] as const;
    const phrases = reasons.map(describeTypeVisibilityReason);
    expect(new Set(phrases).size).toBe(reasons.length);
    for (const p of phrases) expect(p.length).toBeGreaterThan(0);
  });

  it('classifyRunnerDisposition returns undefined for a code this artifact does not represent', () => {
    expect(classifyRunnerDisposition('STRUCTURE_CHECK_THROWN')).toBeUndefined();
  });
});
