/**
 * Tests for core/pairs.ts's NODELESS enumeration pass (Task 6): the set of
 * pairs added after the ordinary per-node loop for files enforced by their
 * architecture type alone (`opts.typeCoverage`), plus the `PairDrop[]`
 * channel that records why an attached rule does not run on such a file.
 *
 * Two fixture styles, matching the existing convention split in this
 * directory:
 *   - A lightweight hand-built Graph (mirrors pairs.test.ts's own
 *     buildPairsGraph) for the enumeration algorithm itself — fast,
 *     self-contained, no fixture-project dependency.
 *   - The REAL committed tests/fixtures/type-level-engine/ project (Task 5)
 *     plus its `excluded-but-mapped` variant for Step 3 (the explicit-mapping
 *     guard), copied into a mkdtemp per test — never mutated in place.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fileUnit } from '../../../src/model/lock.js';
import { computeExpectedPairs } from '../../../src/core/pairs.js';
import type { TypeCoverageInput } from '../../../src/core/pairs.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode, AspectDef, ScopeDef, WhenPredicate } from '../../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const VARIANT_EXCLUDED_BUT_MAPPED = path.join(BASE_FIXTURE, 'variants', 'excluded-but-mapped');

// ---------------------------------------------------------------------------
// Lightweight hand-built graph (mirrors pairs.test.ts's buildPairsGraph,
// extended with architecture node_types carrying `aspects:` so the nodeless
// cascade — computeTypeAspectCascade — has real declared attachments to walk)
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
  opts: { nodeTypes: TCArchType[]; aspects: TCAspect[]; coverageExcluded?: string[] },
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
      coverage: { required: ['/'], excluded: opts.coverageExcluded ?? [], typeLevel: true },
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
  tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-pairs-typecov-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content = 'content'): void {
  const abs = path.join(tmpDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function tc(covered: Array<[string, string]>, ambiguousPaths: string[] = []): TypeCoverageInput {
  return { covered: new Map(covered), ambiguousPaths };
}

// ---------------------------------------------------------------------------
// Step 2 — enumeration rows
// ---------------------------------------------------------------------------

describe('computeExpectedPairs — nodeless enumeration (Step 2)', () => {
  it('absent opts.typeCoverage: zero pairs, zero drops, zero added cost (feature-off contract)', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['own-file-rule'] }],
      aspects: [{ id: 'own-file-rule', kind: 'deterministic', scope: { per: 'file' } }],
    });
    const { pairs, drops } = await computeExpectedPairs(graph);
    expect(pairs).toEqual([]);
    expect(drops).toEqual([]);
  });

  it('a covered file with a per-file deterministic rule yields exactly one nodeless pair', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['own-file-rule'] }],
      aspects: [{ id: 'own-file-rule', kind: 'deterministic', scope: { per: 'file' } }],
    });
    const { pairs, drops } = await computeExpectedPairs(graph, { typeCoverage: tc([['src/leaf/a.ts', 'leaf']]) });
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect(p.aspectId).toBe('own-file-rule');
    expect(p.kind).toBe('deterministic');
    expect(p.unitKey).toBe(fileUnit('src/leaf/a.ts'));
    expect(p.nodePath).toBeUndefined();
    expect(p.status).toBe('enforced');
    expect(p.subjectFiles).toEqual(['src/leaf/a.ts']);
    expect(drops).toEqual([]);
  });

  it('a per-component (whole-unit) rule yields NOTHING for the file and records whole-unit-rule', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['comp-rule'] }],
      aspects: [{ id: 'comp-rule', kind: 'deterministic' }], // no scope → defaults to per:node
    });
    const { pairs, drops } = await computeExpectedPairs(graph, { typeCoverage: tc([['src/leaf/a.ts', 'leaf']]) });
    expect(pairs).toEqual([]);
    expect(drops).toEqual([{ file: 'src/leaf/a.ts', aspectId: 'comp-rule', reason: 'whole-unit-rule' }]);
  });

  it('an aspect whose scope.files excludes the file yields nothing and records scope.files-excluded', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['narrow-rule'] }],
      aspects: [{
        id: 'narrow-rule',
        kind: 'deterministic',
        scope: { per: 'file', files: { path: 'src/leaf/never-matches/**' } },
      }],
    });
    const { pairs, drops } = await computeExpectedPairs(graph, { typeCoverage: tc([['src/leaf/a.ts', 'leaf']]) });
    expect(pairs).toEqual([]);
    expect(drops).toEqual([{ file: 'src/leaf/a.ts', aspectId: 'narrow-rule', reason: 'scope.files-excluded' }]);
  });

  it('a draft rule yields nothing under the default, and records draft (from the cascade itself)', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['draft-rule'] }],
      aspects: [{ id: 'draft-rule', kind: 'deterministic', scope: { per: 'file' }, status: 'draft' }],
    });
    const { pairs, drops } = await computeExpectedPairs(graph, { typeCoverage: tc([['src/leaf/a.ts', 'leaf']]) });
    expect(pairs).toEqual([]);
    expect(drops).toEqual([{ file: 'src/leaf/a.ts', aspectId: 'draft-rule', reason: 'draft' }]);
  });

  it('the SAME draft rule yields a pair under includeDraft (GC universe mode)', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['draft-rule'] }],
      aspects: [{ id: 'draft-rule', kind: 'deterministic', scope: { per: 'file' }, status: 'draft' }],
    });
    const { pairs, drops } = await computeExpectedPairs(graph, {
      includeDraft: true,
      typeCoverage: tc([['src/leaf/a.ts', 'leaf']]),
    });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].status).toBe('draft');
    // The cascade's own 'draft' drop is STILL present even though a pair was
    // ALSO emitted — Task 5's contract: draft is simultaneously effective and
    // dropped, so a caller can tell "attached but dormant" apart from "attached
    // but its when: failed."
    expect(drops).toEqual([{ file: 'src/leaf/a.ts', aspectId: 'draft-rule', reason: 'draft' }]);
  });

  it('a file under the excluded root yields nothing at all — the single exclusion authority, no drop either', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['own-file-rule'] }],
      aspects: [{ id: 'own-file-rule', kind: 'deterministic', scope: { per: 'file' } }],
      coverageExcluded: ['src/leaf'],
    });
    const { pairs, drops } = await computeExpectedPairs(graph, { typeCoverage: tc([['src/leaf/a.ts', 'leaf']]) });
    expect(pairs).toEqual([]);
    // Silent — not even a drop. The file never reaches the cascade at all.
    expect(drops).toEqual([]);
  });

  it('an LLM aspect over a binary file yields no pair, and records binary-subject (never silent — a binary can never be a review subject, and a type-covered file has no owning component to fall back on)', async () => {
    writeFile('src/leaf/logo.png', 'binary-ish content');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['llm-rule'] }],
      aspects: [{ id: 'llm-rule', kind: 'llm', scope: { per: 'file' } }],
    });
    const { pairs, drops } = await computeExpectedPairs(graph, { typeCoverage: tc([['src/leaf/logo.png', 'leaf']]) });
    expect(pairs).toEqual([]);
    expect(drops).toEqual([{ file: 'src/leaf/logo.png', aspectId: 'llm-rule', reason: 'binary-subject' }]);
  });

  it('an aggregate rule contributes no pair and no drop', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['agg-rule'] }],
      aspects: [{ id: 'agg-rule', kind: 'aggregate' }],
    });
    const { pairs, drops } = await computeExpectedPairs(graph, { typeCoverage: tc([['src/leaf/a.ts', 'leaf']]) });
    expect(pairs).toEqual([]);
    expect(drops).toEqual([]);
  });

  // An aspect `implies` cycle stops the cascade before it can decide what
  // applies (computeTypeAspectCascade's own exception contract). Before this
  // was tracked, the file contributed NEITHER a pair NOR a drop — indistinguishable
  // from a file whose type genuinely attaches nothing at all — so a caller
  // reading "no pairs, no drops" as "zero applicable rules" (core/type-visibility.ts
  // did, until this fix) reported the file as satisfying coverage with no
  // enforcement, when its rules were simply never worked out. This pins that
  // the cycle now lands on its own channel instead.
  it('an aspect implies cycle contributes no pair and no drop, and is recorded on uncomputableTypeCoverage instead', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['loop-a'] }],
      aspects: [
        { id: 'loop-a', kind: 'deterministic', implies: ['loop-b'] },
        { id: 'loop-b', kind: 'deterministic', implies: ['loop-a'] },
      ],
    });
    const { pairs, drops, uncomputableTypeCoverage } = await computeExpectedPairs(graph, {
      typeCoverage: tc([['src/leaf/a.ts', 'leaf']]),
    });
    expect(pairs).toEqual([]);
    expect(drops).toEqual([]);
    expect(uncomputableTypeCoverage).toEqual([
      { file: 'src/leaf/a.ts', typeId: 'leaf', cycle: { aspectId: 'loop-a' } },
    ]);
  });

  it('an aspect id the architecture attaches with no matching aspect definition yields no pair, and records aspect-undefined (never silent)', async () => {
    writeFile('src/leaf/a.ts');
    // A graph a real loader rejects (checkDanglingAspectRefs) — reachable here
    // only via a hand-built Graph that bypasses the parser, mirroring the
    // existing 'empty-parents' precedent for the identical reason.
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['ghost-rule'] }],
      aspects: [],
    });
    const { pairs, drops } = await computeExpectedPairs(graph, { typeCoverage: tc([['src/leaf/a.ts', 'leaf']]) });
    expect(pairs).toEqual([]);
    expect(drops).toEqual([{ file: 'src/leaf/a.ts', aspectId: 'ghost-rule', reason: 'aspect-undefined' }]);
  });

  it('an unreadable subject file is recorded on the SAME unreadable channel the node loop uses, with no owning node, PLUS a drop row (never silent)', async () => {
    // A file listed in typeCoverage.covered but that has since vanished from
    // disk is unreadable — probeUnreadable must report it, and the resulting
    // UnreadableSubject carries no nodePath. A caller deriving "enforced" from
    // the absence of a drop must never read this gap as enforcement, so a
    // drop row is recorded alongside the blocking error.
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['own-file-rule'] }],
      aspects: [{ id: 'own-file-rule', kind: 'deterministic', scope: { per: 'file' } }],
    });
    const { pairs, unreadable, drops } = await computeExpectedPairs(graph, {
      typeCoverage: tc([['src/leaf/missing.ts', 'leaf']]),
    });
    expect(pairs).toEqual([]);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].nodePath).toBeUndefined();
    expect(unreadable[0].path).toBe('src/leaf/missing.ts');
    expect(unreadable[0].aspectId).toBe('own-file-rule');
    expect(drops).toEqual([{ file: 'src/leaf/missing.ts', aspectId: 'own-file-rule', reason: 'unreadable' }]);
  });

  it('multiple attached aspects on one covered file each emit their own pair, sorted with component pairs', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['aaa-rule', 'zzz-rule'] }],
      aspects: [
        { id: 'aaa-rule', kind: 'deterministic', scope: { per: 'file' } },
        { id: 'zzz-rule', kind: 'deterministic', scope: { per: 'file' } },
      ],
    });
    const { pairs } = await computeExpectedPairs(graph, { typeCoverage: tc([['src/leaf/a.ts', 'leaf']]) });
    expect(pairs.map((p) => p.aspectId)).toEqual(['aaa-rule', 'zzz-rule']); // aspectId-sorted
  });
});

// ---------------------------------------------------------------------------
// Step 3 — the explicit-mapping scope guard (real fixture + variant)
// ---------------------------------------------------------------------------

describe('computeExpectedPairs — explicit mapping outranks coverage.excluded (Step 3)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'yg-pairs-excl-mapped-'));
    cpSync(BASE_FIXTURE, projectDir, { recursive: true });
    cpSync(VARIANT_EXCLUDED_BUT_MAPPED, projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("keeps enforcing a file a component explicitly maps, even under an excluded root", async () => {
    const graph = await loadGraph(projectDir);
    // Simulate the file ALSO appearing in the type-coverage lattice's `covered`
    // map (a hand-built TypeCoverageInput, as the classifier itself would never
    // classify an explicitly-mapped file as "uncovered" in the first place —
    // this directly tests computeExpectedPairs's OWN redundant safety net,
    // independent of whether the upstream classifier's own filter is correct).
    const TC = tc([['vendor/mapped.ts', 'leaf']]);
    const { pairs, drops } = await computeExpectedPairs(graph, { typeCoverage: TC });
    const vendorPairs = pairs.filter((p) => p.subjectFiles.includes('vendor/mapped.ts'));
    expect(vendorPairs.length).not.toBe(0);
    // Every one of them is the REAL node's own pair (node loop untouched) —
    // never a nodeless pair for the same file.
    for (const p of vendorPairs) expect(p.nodePath).toBe('vendor-owner');
    // The nodeless pass itself contributed NOTHING for vendor/mapped.ts — the
    // exclusion silently wins there (no drop either — the file never reaches
    // the cascade), exactly like Step 2's "excluded root" row.
    expect(drops.some((d) => d.file === 'vendor/mapped.ts')).toBe(false);
    expect(pairs.some((p) => p.nodePath === undefined && p.subjectFiles.includes('vendor/mapped.ts'))).toBe(false);
  });

  it('the node loop never consults isExcludedByCoverage at all (explicit mapping is unconditional)', async () => {
    const graph = await loadGraph(projectDir);
    // No typeCoverage supplied at all — the node's own pair must still exist;
    // proves the guard the brief names ("the component loop must never
    // consult isExcludedByCoverage") holds independent of the feature.
    const { pairs } = await computeExpectedPairs(graph);
    expect(pairs.some((p) => p.nodePath === 'vendor-owner' && p.subjectFiles.includes('vendor/mapped.ts'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 8 — K13: the shared-record merge, UNIT level. Two file-level entries
// under the SAME aspect (as if reconciled from two branches, each adding a
// different covered file) coexist and each self-validates independently — no
// cross-contamination, no special merge caveat needed for the nodeless case.
// (Task 10 owns the GIT-level end-to-end version — a real branch merge with a
// real conflict. This is the reconciliation logic itself, exercised directly.)
// ---------------------------------------------------------------------------

describe('verifyLock — K13 shared-record merge at the UNIT level (Step 8)', () => {
  it('two file-level entries under one aspect, for two different files, both verify independently after a take-a-side union', async () => {
    writeFile('src/leaf/a.ts', 'export const a = 1;\n');
    writeFile('src/leaf/b.ts', 'export const b = 1;\n');
    const graph = buildTypeCoverageGraph(tmpDir, {
      nodeTypes: [{ id: 'leaf', aspects: ['own-file-rule'] }],
      aspects: [{ id: 'own-file-rule', kind: 'deterministic', scope: { per: 'file' } }],
    });
    const typeCoverage = tc([['src/leaf/a.ts', 'leaf'], ['src/leaf/b.ts', 'leaf']]);

    // Compute the pairs, then hash each one FOR REAL (mirrors what a real fill
    // would have written on each of the two "branches" before the merge).
    const { computeDetInputHash } = await import('../../../src/core/pair-hash.js');
    const { ruleHashFor } = await import('../../../src/core/pair-inputs.js');
    const { hashFile } = await import('../../../src/io/hash.js');
    const projectRoot = path.dirname(graph.rootPath);
    const aspectDef = graph.aspects.find((a) => a.id === 'own-file-rule')!;
    const ruleHash = ruleHashFor(aspectDef, 'check.mjs');

    const hashFor = async (file: string): Promise<string> => {
      const abs = path.join(projectRoot, file);
      return computeDetInputHash({
        aspectId: 'own-file-rule',
        scope: { per: 'file' },
        ruleHash,
        files: [[file, await hashFile(abs)]],
        touched: [],
        verdict: 'approved',
      });
    };

    // The "merged" lock document: both file-level entries present, as a
    // take-a-side git resolution would leave them (the union, not one side).
    const lock = {
      version: 1,
      verdicts: {
        'own-file-rule': {
          [fileUnit('src/leaf/a.ts')]: { verdict: 'approved' as const, hash: await hashFor('src/leaf/a.ts') },
          [fileUnit('src/leaf/b.ts')]: { verdict: 'approved' as const, hash: await hashFor('src/leaf/b.ts') },
        },
      },
      nodes: {},
    };

    const { verifyLock } = await import('../../../src/core/verify-lock.js');
    const verification = await verifyLock(graph, lock, typeCoverage);
    const byUnit = new Map(verification.pairs.map((vp) => [vp.pair.unitKey, vp.state.kind]));
    expect(byUnit.get(fileUnit('src/leaf/a.ts'))).toBe('verified');
    expect(byUnit.get(fileUnit('src/leaf/b.ts'))).toBe('verified');
  });
});
