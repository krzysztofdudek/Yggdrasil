/**
 * Unit tests for core/type-visibility.ts: the artifact that records, per
 * (file, aspectId), why a rule attached to a type-covered file's type does
 * not enforce on it — assembled from Task 6's static pair-enumeration drops
 * and the deterministic runner's own typed dispositions. Pure assembler: no
 * I/O of its own, so every scenario either drives the REAL producers
 * (computeExpectedPairs, runStructureAspect) against real on-disk fixtures,
 * or hand-builds a minimal Graph the same way pairs-type-coverage.test.ts
 * does, for the one reason (scope.files-excluded) no fixture aspect declares.
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
import type { TypeVisibilityRow } from '../../../src/core/type-visibility.js';
import { computeExpectedPairs } from '../../../src/core/pairs.js';
import type { TypeCoverageInput } from '../../../src/core/pairs.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { runStructureAspect, StructureRunnerError } from '../../../src/structure/runner.js';
import type { StructureUnit } from '../../../src/structure/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { cleanupTestGraphs } from '../helpers/build-test-graph.js';
import { FIXTURE_NODELESS_RUNNER } from '../../fixtures/type-level-engine/variants/index.js';
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

// ---------------------------------------------------------------------------
// Step 1 — one row per reason (7 its; 6 real, 1 .todo for Task 9)
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
    const { drops } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, []);
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
    const { drops } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, []);
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
    const { drops } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, []);
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
    const { drops } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, []);
    expect(report.rows).toEqual<TypeVisibilityRow[]>([
      { file: 'src/leaf/a.ts', aspectId: 'narrow-rule', reason: 'scope.files-excluded' },
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
      );
      expect(report.rows).toEqual<TypeVisibilityRow[]>([row]);
    });
  });

  // Task 9 owns the companion-hook failure this reason represents; until then
  // no producer ever constructs a row with it. Unskip there.
  it.todo('companion-context-failed: a companion.mjs that could not resolve a dependency for a type-covered file');
});

// ---------------------------------------------------------------------------
// The report shape: zero-enforcement, half-expanded bundles, chain
// termination, dropped counts — driven by the REAL base fixture.
// ---------------------------------------------------------------------------

describe('buildTypeVisibility — report shape (real type-level-engine fixture)', () => {
  it('names a half-expanded bundle: the file-level half enforces, the whole-unit half is dropped', async () => {
    const graph = await loadGraph(BASE_FIXTURE);
    const typeCoverage = tc([['src/leaf/a.ts', 'leaf']]);
    const { drops } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, []);
    const leafBlock = report.byType.find((b) => b.typeId === 'leaf')!;
    expect(leafBlock.halfExpandedBundles).toEqual([
      { bundleId: 'bundle', enforced: ['own-file-rule'], dropped: ['whole-unit-rule'] },
    ]);
  });

  it('reports the fork chain termination for the "forked" type, candidates sorted', async () => {
    const graph = await loadGraph(BASE_FIXTURE);
    const typeCoverage = tc([['src/forked/f.ts', 'forked']]);
    const { drops } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, []);
    const forkedBlock = report.byType.find((b) => b.typeId === 'forked')!;
    expect(forkedBlock.chainTermination).toEqual({ reason: 'fork', candidates: ['mid', 'top'] });
  });

  it('a type whose only attached rule is enforced has an empty dropped list and a non-empty enforced list', async () => {
    const graph = await loadGraph(BASE_FIXTURE);
    const typeCoverage = tc([['src/helper/h.ts', 'classifying-parent']]);
    const { drops } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, []);
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
    const covered = new Map([
      ['src/leaf/a.ts', 'leaf'],
      ['src/leaf/b.ts', 'leaf'],
      ['src/leaf/c.ts', 'leaf'],
    ]);
    // own-rule is dropped (when-not-satisfied, a stand-in reason) for b.ts and
    // c.ts only -- it actually enforces on exactly ONE of the three files.
    const staticDrops = [
      { file: 'src/leaf/b.ts', aspectId: 'own-rule', reason: 'when-not-satisfied' as const },
      { file: 'src/leaf/c.ts', aspectId: 'own-rule', reason: 'when-not-satisfied' as const },
    ];
    const report = buildTypeVisibility(graph, covered, staticDrops, []);
    const block = report.byType.find((b) => b.typeId === 'leaf')!;
    expect(block.enforced).toEqual(['own-rule']);
    expect(block.enforcedCounts).toEqual([{ aspectId: 'own-rule', count: 1 }]);
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
    const { drops } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, []);
    expect(report.zeroEnforcement).toEqual({ count: 1, samples: ['src/ep/e.ts'] });
  });

  it('a file with at least one enforced rule is never counted as zero-enforcement', async () => {
    const graph = await loadGraph(BASE_FIXTURE);
    const typeCoverage = tc([['src/leaf/a.ts', 'leaf']]);
    const { drops } = await computeExpectedPairs(graph, { typeCoverage });
    const report = buildTypeVisibility(graph, typeCoverage.covered, drops, []);
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
    const report = buildTypeVisibility(graph, covered, staticDrops, []);
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
    const report = buildTypeVisibility(graph, covered, staticDrops, []);
    expect(report.zeroEnforcement.count).toBe(20);
    expect(report.zeroEnforcement.samples).toHaveLength(12);
    expect(report.zeroEnforcement.samples).toEqual(files.slice(0, 12));
  });

  it('rows are sorted by (file, aspectId, reason) in code-point order, never locale', () => {
    const graph = buildTypeCoverageGraph(tmpDir, { nodeTypes: [{ id: 't', aspects: [] }], aspects: [] });
    const covered = new Map([['b.ts', 't'], ['a.ts', 't']]);
    const staticDrops = [
      { file: 'b.ts', aspectId: 'zeta', reason: 'draft' as const },
      { file: 'a.ts', aspectId: 'omega', reason: 'draft' as const },
      { file: 'a.ts', aspectId: 'alpha', reason: 'draft' as const },
    ];
    const report = buildTypeVisibility(graph, covered, staticDrops, []);
    expect(report.rows.map((r) => `${r.file}:${r.aspectId}`)).toEqual(['a.ts:alpha', 'a.ts:omega', 'b.ts:zeta']);
  });

  it('describeTypeVisibilityReason gives a distinct, non-empty phrase for every reason', () => {
    const reasons = [
      'when-not-satisfied', 'draft', 'whole-unit-rule', 'scope.files-excluded',
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
