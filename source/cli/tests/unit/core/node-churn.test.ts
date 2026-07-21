import { describe, it, expect } from 'vitest';
import { countChurnByNode, ownerOfForGraph } from '../../../src/core/node-churn.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

// Pure churn counting over SYNTHETIC per-commit touch sets — no git, no fixture.
// The owner resolver is a stand-in for buildOwnerIndex(...).ownerOf: it maps a
// repo-relative POSIX path to the first segment under `src/`, and returns
// undefined for anything unmapped (top-level files, docs).
function ownerBySrcDir(file: string): string | undefined {
  const m = /^src\/([^/]+)\//.exec(file);
  return m ? m[1] : undefined;
}

describe('countChurnByNode — per-node commit churn over parsed touch sets', () => {
  it('counts distinct commits per node and collects the touched files (sorted)', () => {
    const commits = [['src/a/x.ts'], ['src/a/y.ts', 'src/a/z.ts'], ['src/b/p.ts']];
    const churn = countChurnByNode(commits, ownerBySrcDir);
    expect(churn.get('a')).toEqual({
      churn: 2,
      files: ['src/a/x.ts', 'src/a/y.ts', 'src/a/z.ts'],
    });
    expect(churn.get('b')).toEqual({ churn: 1, files: ['src/b/p.ts'] });
  });

  it('counts a commit touching several files of ONE node as a single commit', () => {
    const commits = [['src/a/x.ts', 'src/a/y.ts', 'src/a/z.ts']];
    expect(countChurnByNode(commits, ownerBySrcDir).get('a')).toEqual({
      churn: 1,
      files: ['src/a/x.ts', 'src/a/y.ts', 'src/a/z.ts'],
    });
  });

  it('ignores unmapped files (owner undefined) — they contribute no churn', () => {
    const commits = [['README.md', 'src/a/x.ts'], ['docs/guide.md']];
    const churn = countChurnByNode(commits, ownerBySrcDir);
    expect(churn.get('a')).toEqual({ churn: 1, files: ['src/a/x.ts'] });
    // The README+doc commit and the doc-only commit produce no node entry.
    expect(churn.size).toBe(1);
  });

  it('omits nodes with zero churn entirely (no 0-churn entries in the map)', () => {
    expect(countChurnByNode([], ownerBySrcDir).size).toBe(0);
    expect(countChurnByNode([['top-level.ts']], ownerBySrcDir).size).toBe(0);
  });

  it('caps the file list at 5, sorted, with a "+N more" marker from the TRUE count', () => {
    // 8 distinct files across 8 commits → churn 8, files = 5 sorted + "+3 more".
    const commits = ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'].map((n) => [`src/a/${n}.ts`]);
    const churn = countChurnByNode(commits, ownerBySrcDir);
    expect(churn.get('a')!.churn).toBe(8);
    expect(churn.get('a')!.files).toEqual([
      'src/a/a.ts',
      'src/a/b.ts',
      'src/a/c.ts',
      'src/a/d.ts',
      'src/a/e.ts',
      '+3 more',
    ]);
  });

  it('adds no marker at exactly 5 files, and "+1 more" at 6', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((n) => [`src/a/${n}.ts`]);
    const fiveFiles = countChurnByNode(five, ownerBySrcDir).get('a')!.files;
    expect(fiveFiles).toHaveLength(5);
    expect(fiveFiles.some((f) => f.endsWith('more'))).toBe(false);
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => [`src/a/${n}.ts`]);
    expect(countChurnByNode(six, ownerBySrcDir).get('a')!.files).toEqual([
      'src/a/a.ts',
      'src/a/b.ts',
      'src/a/c.ts',
      'src/a/d.ts',
      'src/a/e.ts',
      '+1 more',
    ]);
  });

  it('is window-agnostic and deterministic — it counts exactly the commits it is given', () => {
    // The same file re-touched across 3 commits → churn 3, one distinct file. The
    // window bound is the caller's (git log -n <window>); the counter honours it by
    // counting only the commits handed in.
    const commits = [['src/a/x.ts'], ['src/a/x.ts'], ['src/a/x.ts']];
    expect(countChurnByNode(commits, ownerBySrcDir).get('a')).toEqual({
      churn: 3,
      files: ['src/a/x.ts'],
    });
  });
});

describe('ownerOfForGraph — the real buildOwnerIndex-backed resolver', () => {
  it('resolves a mapped file to its owning node path, and undefined for an unmapped one', () => {
    const nodes = new Map<string, GraphNode>();
    nodes.set('orders/service', {
      meta: { name: 'service', type: 'service', description: 'x', mapping: ['src/orders/service.ts'] },
      parent: undefined,
      children: [],
      aspects: [],
    } as unknown as GraphNode);
    const graph = { nodes } as Graph;

    const ownerOf = ownerOfForGraph(graph);
    expect(ownerOf('src/orders/service.ts')).toBe('orders/service');
    expect(ownerOf('src/unmapped/other.ts')).toBeUndefined();
  });
});
