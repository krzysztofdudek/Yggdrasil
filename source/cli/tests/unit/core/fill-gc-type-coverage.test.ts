/**
 * Tests for core/fill-gc.ts's type-coverage threading: nodeless
 * (`file:`) verdict entries join the GC universe when `opts.typeCoverage` is
 * threaded through, the ambiguous-path retain family, and the PruneSummary
 * the writer now returns.
 *
 * Mirrors fill-gc.test.ts's own in-memory graph builder, extended with
 * `nodeTypes` so a file can be enforced by its architecture type alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { garbageCollectAndRewrite } from '../../../src/core/fill-gc.js';
import type { TypeCoverageInput } from '../../../src/core/pairs.js';
import { fileUnit } from '../../../src/model/lock.js';
import type { LockFile } from '../../../src/model/lock.js';
import type { Graph, GraphNode, AspectDef, WhenPredicate } from '../../../src/model/graph.js';

// ---------------------------------------------------------------------------
// In-memory graph builder (mirrors fill-gc.test.ts's buildGraph, extended with
// architecture node_types carrying `aspects:` / `aspectWhens:` for nodeless pairs)
// ---------------------------------------------------------------------------

interface GcTcAspect {
  id: string;
  kind?: 'llm' | 'deterministic' | 'aggregate';
  status?: 'draft' | 'advisory' | 'enforced';
  scope?: { per: 'node' | 'file' };
}

interface GcTcNode {
  path: string;
  mapping?: string[];
  aspects?: string[];
  type?: string;
}

interface GcTcArchType {
  id: string;
  aspects?: string[];
  aspectWhens?: Record<string, WhenPredicate>;
}

function buildGraph(
  tmpDir: string,
  nodes: GcTcNode[],
  aspects: GcTcAspect[],
  nodeTypes: GcTcArchType[] = [],
): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });

  const aspectDefs: AspectDef[] = aspects.map((a) => {
    const kind = a.kind ?? 'deterministic';
    return {
      id: a.id,
      name: a.id,
      reviewer: { type: kind },
      status: a.status ?? 'enforced',
      scope: a.scope,
      artifacts:
        kind === 'aggregate'
          ? []
          : [{ filename: kind === 'llm' ? 'content.md' : 'check.mjs', content: 'rule' }],
    } as AspectDef;
  });

  const nodeByPath = new Map<string, GraphNode>();
  for (const n of nodes) {
    nodeByPath.set(n.path, {
      path: n.path,
      meta: { name: n.path, type: n.type ?? 'service', aspects: n.aspects ?? [], mapping: n.mapping ?? [] },
      children: [],
      parent: null,
    } as GraphNode);
  }

  const archNodeTypes: Record<string, { description: string; aspects?: string[]; aspectWhens?: Record<string, WhenPredicate> }> = {
    service: { description: 'test' },
  };
  for (const t of nodeTypes) {
    archNodeTypes[t.id] = { description: t.id, aspects: t.aspects, aspectWhens: t.aspectWhens };
  }

  return {
    config: {
      version: '5.2.0',
      reviewer: { tiers: { default: { provider: 'ollama', model: 'test', temperature: 0, consensus: 1 } }, default: 'default' },
      coverage: { required: ['/'], excluded: [], typeLevel: true },
    },
    architecture: { node_types: archNodeTypes },
    nodes: nodeByPath,
    aspects: aspectDefs,
    flows: [],
    rootPath,
  } as unknown as Graph;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-fill-gc-tc-'));
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

function emptyLockWith(verdicts: LockFile['verdicts']): LockFile {
  return { version: 0, verdicts, nodes: {} };
}

// ---------------------------------------------------------------------------
// (a) first --approve after enabling the feature does NOT prune any
//     file-level result — the pairs are in the universe.
// ---------------------------------------------------------------------------

describe('garbageCollectAndRewrite — nodeless universe (Step 4a)', () => {
  it('a stored file-level verdict survives GC when typeCoverage is threaded (the anti-prune lever)', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildGraph(tmpDir, [], [{ id: 'own-file-rule', scope: { per: 'file' } }], [
      { id: 'leaf', aspects: ['own-file-rule'] },
    ]);
    const lock = emptyLockWith({
      'own-file-rule': { [fileUnit('src/leaf/a.ts')]: { verdict: 'approved', hash: 'h1' } },
    });
    const summary = await garbageCollectAndRewrite(graph, lock, async () => {}, {
      typeCoverage: tc([['src/leaf/a.ts', 'leaf']]),
    });
    expect(lock.verdicts['own-file-rule']?.[fileUnit('src/leaf/a.ts')]?.hash).toBe('h1');
    expect(summary.entries).toEqual([]);
    expect(summary.billedCount).toBe(0);
    expect(summary.freeCount).toBe(0);
  });

  it('WITHOUT threading typeCoverage, the SAME stored entry would be (wrongly) pruned — the negative control proving the lever is load-bearing', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildGraph(tmpDir, [], [{ id: 'own-file-rule', scope: { per: 'file' } }], [
      { id: 'leaf', aspects: ['own-file-rule'] },
    ]);
    const lock = emptyLockWith({
      'own-file-rule': { [fileUnit('src/leaf/a.ts')]: { verdict: 'approved', hash: 'h1' } },
    });
    const summary = await garbageCollectAndRewrite(graph, lock, async () => {}); // no opts at all
    expect(lock.verdicts['own-file-rule']).toBeUndefined();
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0].unitKey).toBe(fileUnit('src/leaf/a.ts'));
  });
});

// ---------------------------------------------------------------------------
// (b) a file reported ambiguous this run RETAINS its file-level results,
//     regardless of which rule they belong to (aspect-agnostic, path-keyed).
// ---------------------------------------------------------------------------

describe('garbageCollectAndRewrite — ambiguous-path retain family (Step 4b)', () => {
  it('retains a file-level entry for ANY aspect when the file is reported ambiguous this run', async () => {
    // No node type attaches 'stale-rule' at all this run — the file is
    // AMBIGUOUS (the machine could not decide its type), not covered by any
    // one type, so 'stale-rule' never appears in the universe either way.
    // Without the retain family this would look positively detached.
    const graph = buildGraph(tmpDir, [], [{ id: 'stale-rule', scope: { per: 'file' } }], []);
    const lock = emptyLockWith({
      'stale-rule': { [fileUnit('src/ambiguous.ts')]: { verdict: 'approved', hash: 'h1' } },
    });
    const summary = await garbageCollectAndRewrite(graph, lock, async () => {}, {
      typeCoverage: tc([], ['src/ambiguous.ts']),
    });
    expect(lock.verdicts['stale-rule']?.[fileUnit('src/ambiguous.ts')]?.hash).toBe('h1');
    expect(summary.entries).toEqual([]);
  });

  it('a DIFFERENT file with the same aspect, NOT reported ambiguous, still prunes normally', async () => {
    const graph = buildGraph(tmpDir, [], [{ id: 'stale-rule', scope: { per: 'file' } }], []);
    const lock = emptyLockWith({
      'stale-rule': {
        [fileUnit('src/ambiguous.ts')]: { verdict: 'approved', hash: 'h1' },
        [fileUnit('src/detached.ts')]: { verdict: 'approved', hash: 'h2' },
      },
    });
    const summary = await garbageCollectAndRewrite(graph, lock, async () => {}, {
      typeCoverage: tc([], ['src/ambiguous.ts']),
    });
    expect(lock.verdicts['stale-rule']?.[fileUnit('src/ambiguous.ts')]).toBeDefined();
    expect(lock.verdicts['stale-rule']?.[fileUnit('src/detached.ts')]).toBeUndefined();
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0].unitKey).toBe(fileUnit('src/detached.ts'));
  });
});

// ---------------------------------------------------------------------------
// (c) with the feature turned back off, the next FULL --approve prunes them.
// ---------------------------------------------------------------------------

describe('garbageCollectAndRewrite — feature turned back off (Step 4c)', () => {
  it('a file-level entry retained while the feature was on is pruned once typeCoverage is absent again', async () => {
    writeFile('src/leaf/a.ts');
    const graph = buildGraph(tmpDir, [], [{ id: 'own-file-rule', scope: { per: 'file' } }], [
      { id: 'leaf', aspects: ['own-file-rule'] },
    ]);
    const lock = emptyLockWith({
      'own-file-rule': { [fileUnit('src/leaf/a.ts')]: { verdict: 'approved', hash: 'h1' } },
    });
    // Run 1: feature ON — retained (Step 4a).
    await garbageCollectAndRewrite(graph, lock, async () => {}, { typeCoverage: tc([['src/leaf/a.ts', 'leaf']]) });
    expect(lock.verdicts['own-file-rule']?.[fileUnit('src/leaf/a.ts')]).toBeDefined();
    // Run 2: feature OFF (no typeCoverage) — now positively detached, pruned.
    const summary = await garbageCollectAndRewrite(graph, lock, async () => {});
    expect(lock.verdicts['own-file-rule']).toBeUndefined();
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0].reason).toBe('no longer in the expected pair set');
  });
});

// ---------------------------------------------------------------------------
// (e) Target-side re-typing: re-typing an IMPORTED file removes an
//     applicability condition on the IMPORTING file; its pair leaves the
//     universe; the entry is pruned and the summary names it.
// ---------------------------------------------------------------------------

describe('garbageCollectAndRewrite — target-side re-typing (Step 4e)', () => {
  it('re-typing the imported file removes the relation-gated rule from the importing file’s universe', async () => {
    writeFile('src/consumer/c.ts');
    // consumerType's rule is gated on relations.uses.target_type === 'ownerType'.
    const nodeTypesFor = (targetType: string) => [
      { id: 'consumerType', aspects: ['needs-dep'], aspectWhens: { 'needs-dep': { relations: { uses: { target_type: targetType } } } } },
    ];
    const aspects = [{ id: 'needs-dep' as const, scope: { per: 'file' as const } }];
    const lock = emptyLockWith({
      'needs-dep': { [fileUnit('src/consumer/c.ts')]: { verdict: 'approved', hash: 'h1' } },
    });

    // BEFORE: the imported file resolves to type 'ownerType' — the predicate
    // is satisfied, the rule is effective, its pair is in the universe.
    const edgesBefore = { edgesFrom: (f: string) => (f === 'src/consumer/c.ts' ? [{ toFile: 'src/owner/o.ts', toOwner: { kind: 'type-covered' as const, type: 'ownerType' } }] : []) };
    const graphBefore = buildGraph(tmpDir, [], aspects, nodeTypesFor('ownerType'));
    const summaryBefore = await garbageCollectAndRewrite(graphBefore, lock, async () => {}, {
      typeCoverage: { covered: new Map([['src/consumer/c.ts', 'consumerType']]), ambiguousPaths: [], edges: edgesBefore },
    });
    expect(lock.verdicts['needs-dep']?.[fileUnit('src/consumer/c.ts')]).toBeDefined();
    expect(summaryBefore.entries).toEqual([]);

    // AFTER: the imported file is RE-TYPED to 'otherType' — the SAME edge now
    // resolves to a different target type, the predicate is no longer
    // satisfied, the rule is no longer effective, and its pair leaves the
    // universe. GC must positively detect this and prune it.
    const edgesAfter = { edgesFrom: (f: string) => (f === 'src/consumer/c.ts' ? [{ toFile: 'src/owner/o.ts', toOwner: { kind: 'type-covered' as const, type: 'otherType' } }] : []) };
    const graphAfter = buildGraph(tmpDir, [], aspects, nodeTypesFor('ownerType'));
    const summaryAfter = await garbageCollectAndRewrite(graphAfter, lock, async () => {}, {
      typeCoverage: { covered: new Map([['src/consumer/c.ts', 'consumerType']]), ambiguousPaths: [], edges: edgesAfter },
    });
    expect(lock.verdicts['needs-dep']).toBeUndefined();
    expect(summaryAfter.entries).toHaveLength(1);
    expect(summaryAfter.entries[0].unitKey).toBe(fileUnit('src/consumer/c.ts'));
  });
});

// ---------------------------------------------------------------------------
// (f) the component-deletion twin: deleting a component whose files then
//     match a type leaves the same `file:` keys in the universe, so nothing
//     is pruned that should not be.
// ---------------------------------------------------------------------------

describe('garbageCollectAndRewrite — component-deletion twin (Step 4f)', () => {
  it('deleting the owning component but having the file re-match a type keeps the same unit key alive', async () => {
    writeFile('src/leaf/a.ts');
    const aspects = [{ id: 'shared-rule', scope: { per: 'file' as const } }];
    const lock = emptyLockWith({
      'shared-rule': { [fileUnit('src/leaf/a.ts')]: { verdict: 'approved', hash: 'h1' } },
    });

    // BEFORE: a real component maps the file and declares the aspect.
    const graphBefore = buildGraph(
      tmpDir,
      [{ path: 'leaf-owner', mapping: ['src/leaf/a.ts'], aspects: ['shared-rule'] }],
      aspects,
    );
    const summaryBefore = await garbageCollectAndRewrite(graphBefore, lock, async () => {});
    expect(lock.verdicts['shared-rule']?.[fileUnit('src/leaf/a.ts')]).toBeDefined();
    expect(summaryBefore.entries).toEqual([]);

    // AFTER: the component is DELETED, but the file now matches architecture
    // type 'leaf', which attaches the SAME aspect — the unit key is identical
    // (fileUnit is a pure function of the path alone), so the entry must stay
    // alive across the transition, never pruned as "node deleted."
    const graphAfter = buildGraph(tmpDir, [], aspects, [{ id: 'leaf', aspects: ['shared-rule'] }]);
    const summaryAfter = await garbageCollectAndRewrite(graphAfter, lock, async () => {}, {
      typeCoverage: tc([['src/leaf/a.ts', 'leaf']]),
    });
    expect(lock.verdicts['shared-rule']?.[fileUnit('src/leaf/a.ts')]).toBeDefined();
    expect(summaryAfter.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (d) The graduation twin, UNIT level: the SAME file before and after a
// component claims it. The unit key is identical (fileUnit is a pure function
// of the path), GC never orphans the entry across the transition (the same
// key stays in the universe from a different source), and the stored
// fingerprint differs once a real owner exists — verifyLock (not GC) is what
// detects that mismatch and asks for a re-fill, which is what "replaced, not
// orphaned" means in practice: the old entry is overwritten by the next
// --approve, never deleted out from under the unit key. This is a unit-level
// pin only; an end-to-end version driven through the built binary is not yet
// covered.
// ---------------------------------------------------------------------------

describe('garbageCollectAndRewrite — graduation twin, UNIT level (Step 4d)', () => {
  it('the unit key survives graduation untouched by GC; verifyLock is what detects the fingerprint no longer matches', async () => {
    writeFile('src/leaf/a.ts', 'export const a = 1;\n');
    const aspects = [{ id: 'own-file-rule', scope: { per: 'file' as const } }];

    // BEFORE: nodeless — own-file-rule attached via the architecture type.
    const graphBefore = buildGraph(tmpDir, [], aspects, [{ id: 'leaf', aspects: ['own-file-rule'] }]);
    const { computeDetInputHash } = await import('../../../src/core/pair-hash.js');
    const { ruleHashFor } = await import('../../../src/core/pair-inputs.js');
    const { hashFile } = await import('../../../src/io/hash.js');
    const projectRoot = path.dirname(graphBefore.rootPath);
    const ruleHash = ruleHashFor(graphBefore.aspects[0], 'check.mjs');
    const fileHash = await hashFile(path.join(projectRoot, 'src/leaf/a.ts'));

    const nodelessHash = computeDetInputHash({
      aspectId: 'own-file-rule', scope: { per: 'file' }, ruleHash,
      files: [['src/leaf/a.ts', fileHash]], touched: [], verdict: 'approved',
    });
    const lock = emptyLockWith({
      'own-file-rule': { [fileUnit('src/leaf/a.ts')]: { verdict: 'approved', hash: nodelessHash } },
    });

    const summaryBefore = await garbageCollectAndRewrite(graphBefore, lock, async () => {}, {
      typeCoverage: tc([['src/leaf/a.ts', 'leaf']]),
    });
    expect(summaryBefore.entries).toEqual([]); // retained — in the universe.
    const keyBefore = Object.keys(lock.verdicts['own-file-rule'])[0];

    // AFTER: a real component now maps the file and declares the SAME aspect —
    // graduation. The file is no longer offered to the type-coverage lattice
    // (a real mapping owns it), so typeCoverage.covered no longer names it.
    const graphAfter = buildGraph(
      tmpDir,
      [{ path: 'leaf-owner', mapping: ['src/leaf/a.ts'], aspects: ['own-file-rule'] }],
      aspects,
    );
    const summaryAfter = await garbageCollectAndRewrite(graphAfter, lock, async () => {});
    const keyAfter = Object.keys(lock.verdicts['own-file-rule'] ?? {})[0];

    // The unit key is IDENTICAL — fileUnit is a pure function of the path,
    // indifferent to which loop (node or nodeless) produced the pair.
    expect(keyAfter).toBe(keyBefore);
    expect(keyAfter).toBe(fileUnit('src/leaf/a.ts'));
    // GC never orphaned it: the same key is still in the (now node-sourced)
    // universe, so nothing was pruned across the transition.
    expect(summaryAfter.entries).toEqual([]);
    // The STORED hash is still the pre-graduation (nodeless) one — GC does not
    // rehash; only a fill overwrites it. verifyLock is what proves it is now
    // stale: the canonical form now includes the real owning component.
    expect(lock.verdicts['own-file-rule'][fileUnit('src/leaf/a.ts')].hash).toBe(nodelessHash);
    const { verifyLock } = await import('../../../src/core/verify-lock.js');
    const verification = await verifyLock(graphAfter, lock);
    const vp = verification.pairs.find((p) => p.pair.unitKey === fileUnit('src/leaf/a.ts'));
    expect(vp?.state.kind).toBe('unverified'); // fingerprint differs — a re-fill will REPLACE, not orphan, this entry.
  });
});
