import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyFile } from '../../../src/core/type-classifier.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';
import type { Graph, ArchitectureNodeType } from '../../../src/model/graph.js';
import type { FileWhenPredicate } from '../../../src/model/file-when.js';

function makeGraph(
  types: Record<string, Partial<ArchitectureNodeType>>,
  rootPath: string,
): Graph {
  const node_types: Record<string, ArchitectureNodeType> = {};
  for (const [id, def] of Object.entries(types)) {
    node_types[id] = { description: id, ...def };
  }
  return {
    config: {},
    architecture: { node_types },
    nodes: new Map(),
    aspects: [],
    flows: [],
    rootPath,
  };
}

describe('classifyFile', () => {
  let tmpDir: string;
  let cache: FileContentCache;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tc-'));
    cache = new FileContentCache();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns full matches when file satisfies when predicate', async () => {
    writeFileSync(join(tmpDir, 'cmd.ts'), '');
    const graph = makeGraph(
      { command: { when: { path: '*.ts' } } },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(join(tmpDir, 'cmd.ts'), 'cmd.ts', graph, cache);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].typeId).toBe('command');
    expect(result.closest).toHaveLength(0);
  });

  it('skips types without when predicate (organizational types)', async () => {
    writeFileSync(join(tmpDir, 'cmd.ts'), '');
    const graph = makeGraph(
      {
        command: { when: { path: '*.ts' } },
        module: { /* no when */ },
      },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(join(tmpDir, 'cmd.ts'), 'cmd.ts', graph, cache);
    expect(result.matches).toHaveLength(1);
    const typeIds = result.matches.map(m => m.typeId);
    expect(typeIds).not.toContain('module');
  });

  it('returns closest types ranked by satisfied-fraction descending', async () => {
    writeFileSync(join(tmpDir, 'cmd.ts'), 'hello');
    const graph = makeGraph(
      {
        // path=true(1.0), content=false(0.0) → all_of score = (1+0)/2 = 0.5
        typeA: { when: { all_of: [{ path: '*.ts' }, { content: 'missing' }] } },
        // path=false(0.0) → score = 0.0
        typeB: { when: { path: '*.py' } },
      },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(join(tmpDir, 'cmd.ts'), 'cmd.ts', graph, cache);
    expect(result.matches).toHaveLength(0);
    expect(result.closest.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < result.closest.length; i++) {
      expect(result.closest[i].score).toBeLessThanOrEqual(result.closest[i - 1].score);
    }
    expect(result.closest[0].typeId).toBe('typeA');
    expect(result.closest[0].score).toBeCloseTo(0.5);
  });

  it('all_of computes average of children scores', async () => {
    writeFileSync(join(tmpDir, 'cmd.ts'), 'hello');
    const graph = makeGraph(
      {
        // path=true(1.0), content=false(0.0) → avg = 0.5
        typeA: { when: { all_of: [{ path: '*.ts' }, { content: 'missing' }] } },
      },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(join(tmpDir, 'cmd.ts'), 'cmd.ts', graph, cache);
    expect(result.closest).toHaveLength(1);
    expect(result.closest[0].score).toBeCloseTo(0.5);
  });

  it('any_of takes max of children scores', async () => {
    writeFileSync(join(tmpDir, 'cmd.ts'), 'hello');
    // typeA: any_of([all_of(*.ts,missing), *.py])
    //   child1: all_of(*.ts=true, missing=false) → score=0.5, result=false
    //   child2: *.py → score=0.0, result=false
    //   any_of result=false, score=max(0.5, 0.0)=0.5
    //
    // typeB: all_of([all_of(*.ts,missing), *.py])
    //   child1: all_of(*.ts=true, missing=false) → score=0.5, result=false
    //   child2: *.py → score=0.0, result=false
    //   all_of result=false, score=avg(0.5, 0.0)=0.25
    const typeAPred: FileWhenPredicate = {
      any_of: [
        { all_of: [{ path: '*.ts' }, { content: 'missing' }] },
        { path: '*.py' },
      ],
    };
    const typeBPred: FileWhenPredicate = {
      all_of: [
        { all_of: [{ path: '*.ts' }, { content: 'missing' }] },
        { path: '*.py' },
      ],
    };
    const graph = makeGraph(
      { typeA: { when: typeAPred }, typeB: { when: typeBPred } },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(join(tmpDir, 'cmd.ts'), 'cmd.ts', graph, cache);
    expect(result.matches).toHaveLength(0);
    const typeA = result.closest.find(c => c.typeId === 'typeA');
    const typeB = result.closest.find(c => c.typeId === 'typeB');
    expect(typeA).toBeDefined();
    expect(typeB).toBeDefined();
    expect(typeA!.score).toBeCloseTo(0.5);  // max(0.5, 0.0)
    expect(typeB!.score).toBeCloseTo(0.25); // avg(0.5, 0.0)
    expect(typeA!.score).toBeGreaterThan(typeB!.score);
  });

  it('not inverts child score', async () => {
    writeFileSync(join(tmpDir, 'cmd.ts'), '');
    // not(path:*.ts) for cmd.ts: child=true(1.0) → not result=false, score=1-1.0=0.0
    const graph = makeGraph(
      { typeA: { when: { not: { path: '*.ts' } } } },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(join(tmpDir, 'cmd.ts'), 'cmd.ts', graph, cache);
    expect(result.matches).toHaveLength(0);
    expect(result.closest).toHaveLength(1);
    expect(result.closest[0].score).toBeCloseTo(0.0);
  });

  it('limits closest to at most 3 types', async () => {
    writeFileSync(join(tmpDir, 'cmd.ts'), '');
    const types: Record<string, Partial<ArchitectureNodeType>> = {};
    for (let i = 0; i < 5; i++) {
      types[`type${i}`] = { when: { path: '*.py' } };
    }
    const graph = makeGraph(types, join(tmpDir, '.yggdrasil'));
    const result = await classifyFile(join(tmpDir, 'cmd.ts'), 'cmd.ts', graph, cache);
    expect(result.closest.length).toBeLessThanOrEqual(3);
    expect(result.matches).toHaveLength(0);
  });

  it('closest picks the top 3 by (score, typeId) — declaration order alone must never decide WHICH 3 make the cut', async () => {
    writeFileSync(join(tmpDir, 'cmd.ts'), '');
    // Four equally-scoring (0.00) path-only types: a stable sort on score
    // alone leaves ties in whatever order Object.entries(node_types) walks
    // them in, so .slice(0, 3) would pick membership by declaration order,
    // not by anything about the types themselves. Declared here in REVERSE
    // alphabetical insertion order (delta, charlie, bravo, alpha) so a
    // declaration-order-driven selection would pick delta/charlie/bravo —
    // the canonical (typeId-ascending) selection is alpha/bravo/charlie.
    const graph = makeGraph(
      {
        delta: { when: { path: '*.py' } },
        charlie: { when: { path: '*.py' } },
        bravo: { when: { path: '*.py' } },
        alpha: { when: { path: '*.py' } },
      },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(join(tmpDir, 'cmd.ts'), 'cmd.ts', graph, cache);
    expect(result.matches).toHaveLength(0);
    expect(result.closest.map((c) => c.typeId)).toEqual(['alpha', 'bravo', 'charlie']);

    // The SAME file classified against the types declared in their canonical
    // (alphabetical) order must select the identical set — proving the
    // selection is a function of (score, typeId) alone, never of
    // Object.entries' iteration order.
    const canonicalGraph = makeGraph(
      {
        alpha: { when: { path: '*.py' } },
        bravo: { when: { path: '*.py' } },
        charlie: { when: { path: '*.py' } },
        delta: { when: { path: '*.py' } },
      },
      join(tmpDir, '.yggdrasil'),
    );
    const canonicalResult = await classifyFile(join(tmpDir, 'cmd.ts'), 'cmd.ts', canonicalGraph, cache);
    expect(canonicalResult.closest.map((c) => c.typeId)).toEqual(result.closest.map((c) => c.typeId));
  });

  it('closest ranks by score FIRST, typeId only as a tiebreak — a higher-scoring type must never lose its place to an alphabetically-earlier, lower-scoring one', async () => {
    writeFileSync(join(tmpDir, 'cmd.ts'), 'hello');
    // zeta scores 0.5 (path matches, content does not — same all_of shape as
    // the score-computation test above); alpha/bravo/charlie each score 0.0
    // (path-only, non-matching). Declared and named so that typeId-ascending
    // order (alpha, bravo, charlie, zeta) is the EXACT OPPOSITE of score-
    // descending order (zeta, alpha, bravo, charlie) — the two other closest-
    // ranking tests in this file both happen to name their higher scorer
    // alphabetically first, so neither can tell a genuine score sort apart
    // from an accidental typeId sort. This one can.
    const graph = makeGraph(
      {
        alpha: { when: { path: '*.py' } },
        bravo: { when: { path: '*.py' } },
        charlie: { when: { path: '*.py' } },
        zeta: { when: { all_of: [{ path: '*.ts' }, { content: 'missing' }] } },
      },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(join(tmpDir, 'cmd.ts'), 'cmd.ts', graph, cache);
    expect(result.matches).toHaveLength(0);
    // The one 0.5-scoring type must be first, and must still be IN the top 3
    // at all — a selection that sorted by typeId instead of score would drop
    // it (4th alphabetically) in favor of charlie.
    expect(result.closest.map((c) => c.typeId)).toEqual(['zeta', 'alpha', 'bravo']);
    expect(result.closest[0].score).toBeCloseTo(0.5);
    expect(result.closest[1].score).toBeCloseTo(0.0);
    expect(result.closest[2].score).toBeCloseTo(0.0);
  });

  it('exempt: file under .yggdrasil/ auto-matches any type with when', async () => {
    const graph = makeGraph(
      { typeA: { when: { path: '*.py' } } },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(
      join(tmpDir, '.yggdrasil', 'model', 'x', 'yg-node.yaml'),
      '.yggdrasil/model/x/yg-node.yaml',
      graph,
      cache,
    );
    // .yggdrasil/ files are auto-exempt → result=true → matches
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].trace.kind).toBe('exempt');
  });

  it('all_of empty children scores 1.0 when embedded in larger predicate', async () => {
    writeFileSync(join(tmpDir, 'cmd.ts'), '');
    // outer all_of: [inner all_of([]), path:*.py]
    // inner all_of([]) → result=true (vacuous truth), score=1.0
    // path:*.py → result=false, score=0.0
    // outer all_of result=false (*.py fails), score=avg(1.0, 0.0)=0.5
    const pred: FileWhenPredicate = {
      all_of: [
        { all_of: [] as FileWhenPredicate[] },
        { path: '*.py' },
      ],
    };
    const graph = makeGraph({ typeA: { when: pred } }, join(tmpDir, '.yggdrasil'));
    const result = await classifyFile(join(tmpDir, 'cmd.ts'), 'cmd.ts', graph, cache);
    expect(result.closest).toHaveLength(1);
    expect(result.closest[0].score).toBeCloseTo(0.5);
  });

  it('any_of empty children scores 0.0 when embedded in larger predicate', async () => {
    writeFileSync(join(tmpDir, 'cmd.ts'), '');
    // outer all_of: [inner any_of([]), path:*.ts]
    // inner any_of([]) → result=false (no children), score=0.0
    // path:*.ts → result=true, score=1.0
    // outer all_of result=false (any_of fails), score=avg(0.0, 1.0)=0.5
    const pred: FileWhenPredicate = {
      all_of: [
        { any_of: [] as FileWhenPredicate[] },
        { path: '*.ts' },
      ],
    };
    const graph = makeGraph({ typeA: { when: pred } }, join(tmpDir, '.yggdrasil'));
    const result = await classifyFile(join(tmpDir, 'cmd.ts'), 'cmd.ts', graph, cache);
    expect(result.closest).toHaveLength(1);
    expect(result.closest[0].score).toBeCloseTo(0.5);
  });

  it('reports content-predicate types as unreadable for a >5MB file instead of silently non-matching', async () => {
    const bigPath = join(tmpDir, 'huge.ts');
    writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const graph = makeGraph(
      { 'content-typed': { when: { content: 'a' } } },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(bigPath, 'huge.ts', graph, cache);
    expect(result.matches).toHaveLength(0);
    expect(result.unreadable.map(u => u.typeId)).toContain('content-typed');
    expect(result.unreadable.find(u => u.typeId === 'content-typed')!.reason).toMatch(/5MB/);
    expect(result.unreadable.find(u => u.typeId === 'content-typed')!.kind).toBe('too-large');
  });

  it('binary file under a content predicate stays a clean non-match, not unreadable (deliberate asymmetry)', async () => {
    writeFileSync(join(tmpDir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x61]));
    const graph = makeGraph(
      { 'content-typed': { when: { content: 'a' } } },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(join(tmpDir, 'bin.dat'), 'bin.dat', graph, cache);
    expect(result.matches).toHaveLength(0);
    expect(result.unreadable).toHaveLength(0);
    expect(result.closest.map(c => c.typeId)).toContain('content-typed');
  });

  it('a type whose path atom definitively fails is a clean non-match even when its content atom is unreadable for the same oversized file', async () => {
    const bigPath = join(tmpDir, 'huge.ts');
    writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const graph = makeGraph(
      // 'src/**' never matches the flat repo-relative path 'huge.ts' — the
      // all_of can never match regardless of the (also unreadable) content atom.
      { 'scoped-content': { when: { path: 'src/**', content: 'a' } } },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(bigPath, 'huge.ts', graph, cache);
    expect(result.matches).toHaveLength(0);
    expect(result.unreadable).toHaveLength(0);
    expect(result.closest.map((c) => c.typeId)).toContain('scoped-content');
  });

  it('a path-only type is unaffected by another type being unreadable for the same file', async () => {
    const bigPath = join(tmpDir, 'huge.ts');
    writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const graph = makeGraph(
      {
        'content-typed': { when: { content: 'a' } },
        'path-typed': { when: { path: '*.ts' } },
      },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(bigPath, 'huge.ts', graph, cache);
    expect(result.matches.map(m => m.typeId)).toContain('path-typed');
    expect(result.unreadable.map(u => u.typeId)).toContain('content-typed');
    expect(result.unreadable.map(u => u.typeId)).not.toContain('path-typed');
  });

  it('unreadable is sorted by typeId — declaration order alone must never decide the rendered order of a blocking file-unreadable list', async () => {
    const bigPath = join(tmpDir, 'huge.ts');
    writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    // Three content-only types, all unreadable against the oversized file,
    // declared in reverse alphabetical order — a plain accumulation loop over
    // Object.entries(node_types) would report them charlie, bravo, alpha.
    const graph = makeGraph(
      {
        charlie: { when: { content: 'a' } },
        bravo: { when: { content: 'a' } },
        alpha: { when: { content: 'a' } },
      },
      join(tmpDir, '.yggdrasil'),
    );
    const result = await classifyFile(bigPath, 'huge.ts', graph, cache);
    expect(result.unreadable.map((u) => u.typeId)).toEqual(['alpha', 'bravo', 'charlie']);
  });
});
