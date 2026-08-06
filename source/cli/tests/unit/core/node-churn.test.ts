import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { countChurnByNode, countChurnByTypeCoveredFile, ownerOfForGraph } from '../../../src/core/node-churn.js';
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

// The trap: countChurnByNode attributes churn via ownerOf(file), so a file with no
// owning node is silently dropped — which is EVERY type-covered file, by
// definition. That reads as "no churn" when the real problem is "wrong function".
describe('the churn-counting trap: countChurnByNode cannot see type-covered files', () => {
  it('countChurnByNode returns an EMPTY map over commits that only touch owner-less files — looks like "no churn", is really "wrong function"', () => {
    const commits = [['src/svc/handler.ts'], ['src/svc/handler.ts', 'src/svc/other.ts']];
    const noOwnerEver = (): string | undefined => undefined; // every type-covered file has no node
    expect(countChurnByNode(commits, noOwnerEver).size).toBe(0);
  });
});

describe('countChurnByTypeCoveredFile — per-FILE commit churn over parsed touch sets (the fix for the trap above)', () => {
  it('counts the SAME commits by file path directly, not by node ownership', () => {
    const commits = [['src/svc/handler.ts'], ['src/svc/handler.ts', 'src/svc/other.ts']];
    const typeCovered = new Set(['src/svc/handler.ts', 'src/svc/other.ts']);
    const churn = countChurnByTypeCoveredFile(commits, typeCovered);
    expect(churn.get('src/svc/handler.ts')).toEqual({ churn: 2, files: ['src/svc/handler.ts'] });
    expect(churn.get('src/svc/other.ts')).toEqual({ churn: 1, files: ['src/svc/other.ts'] });
  });

  it('ignores a file NOT in the type-covered set — it contributes no churn even if touched', () => {
    const commits = [['src/svc/handler.ts', 'README.md']];
    const typeCovered = new Set(['src/svc/handler.ts']);
    const churn = countChurnByTypeCoveredFile(commits, typeCovered);
    expect(churn.size).toBe(1);
    expect(churn.get('src/svc/handler.ts')).toEqual({ churn: 1, files: ['src/svc/handler.ts'] });
  });

  it('omits a file with zero churn entirely (no 0-churn entries in the map)', () => {
    expect(countChurnByTypeCoveredFile([], new Set(['src/svc/handler.ts'])).size).toBe(0);
    expect(countChurnByTypeCoveredFile([['other.ts']], new Set(['src/svc/handler.ts'])).size).toBe(0);
  });

  it('counts a commit touching the same file only once (defensive dedup, mirrors countChurnByNode)', () => {
    const commits = [['src/svc/handler.ts', 'src/svc/handler.ts']];
    const churn = countChurnByTypeCoveredFile(commits, new Set(['src/svc/handler.ts']));
    expect(churn.get('src/svc/handler.ts')).toEqual({ churn: 1, files: ['src/svc/handler.ts'] });
  });
});

describe('ownerOfForGraph — the real buildOwnerIndex-backed resolver, guarded against exclusion', () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function graphWithMapping(mapping: string[], excluded: string[]): Graph {
    root = mkdtempSync(path.join(tmpdir(), 'node-churn-owner-'));
    mkdirSync(path.join(root, '.yggdrasil'), { recursive: true });
    const nodes = new Map<string, GraphNode>();
    nodes.set('orders/service', {
      meta: { name: 'service', type: 'service', description: 'x', mapping },
      parent: undefined,
      children: [],
      aspects: [],
    } as unknown as GraphNode);
    return {
      nodes,
      rootPath: path.join(root, '.yggdrasil'),
      config: { coverage: { required: [], excluded, typeLevel: false } },
    } as unknown as Graph;
  }

  it('resolves a mapped file to its owning node path, and undefined for an unmapped one', async () => {
    const graph = graphWithMapping(['src/orders/service.ts'], []);

    const ownerOf = await ownerOfForGraph(graph);
    expect(ownerOf('src/orders/service.ts')).toBe('orders/service');
    expect(ownerOf('src/unmapped/other.ts')).toBeUndefined();
  });

  it('answers undefined for a file coverage.excluded names, even though the node\'s mapping textually matches it', async () => {
    const graph = graphWithMapping(['src/orders/service.ts'], ['src/orders/service.ts']);

    const ownerOf = await ownerOfForGraph(graph);
    expect(ownerOf('src/orders/service.ts')).toBeUndefined();
  });

  it('control: a sibling file under the SAME node, not excluded, still resolves — the guard does not silence ownership generally', async () => {
    const graph = graphWithMapping(['src/orders/service.ts', 'src/orders/kept.ts'], ['src/orders/service.ts']);

    const ownerOf = await ownerOfForGraph(graph);
    expect(ownerOf('src/orders/service.ts')).toBeUndefined();
    expect(ownerOf('src/orders/kept.ts')).toBe('orders/service');
  });
});
