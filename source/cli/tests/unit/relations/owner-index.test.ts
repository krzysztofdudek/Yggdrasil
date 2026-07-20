import { describe, it, expect } from 'vitest';
import { buildOwnerIndex } from '../../../src/relations/owner-index.js';

const node = (p: string, mapping: string[]) => ({ path: p, meta: { mapping } });

describe('OwnerIndex', () => {
  it('resolves a file to the longest-mapping owner', () => {
    const idx = buildOwnerIndex(new Map([
      ['a', node('a', ['src/a'])],
      ['a/b', node('a/b', ['src/a/b'])],
    ]) as any);
    expect(idx.ownerOf('src/a/b/x.ts')).toBe('a/b');
    expect(idx.ownerOf('src/a/y.ts')).toBe('a');
    expect(idx.ownerOf('src/other/z.ts')).toBeUndefined();
  });
  it('is deterministic on an equal-length tie (lexicographic node path), not iteration order', () => {
    const idx1 = buildOwnerIndex(new Map([['zzz', node('zzz', ['src/x'])], ['aaa', node('aaa', ['src/x'])]]) as any);
    const idx2 = buildOwnerIndex(new Map([['aaa', node('aaa', ['src/x'])], ['zzz', node('zzz', ['src/x'])]]) as any);
    expect(idx1.ownerOf('src/x/f.ts')).toBe(idx2.ownerOf('src/x/f.ts'));
    expect(idx1.ownerOf('src/x/f.ts')).toBe('aaa');
  });
  it('resolves a glob mapping', () => {
    const idx = buildOwnerIndex(new Map([['r', node('r', ['src/**/*.ts'])]]) as any);
    expect(idx.ownerOf('src/deep/x.ts')).toBe('r');
  });

  it('child wins an equal-length mapping tie against its ancestor (deeper node), independent of insertion order', () => {
    // Parent glob and child plain entry both match src/x/y.ts and are the same
    // length (10). The deeper node (the child) must win — matching the graph's
    // child-carve-out model — regardless of Map insertion order.
    const forward = buildOwnerIndex(new Map([
      ['app', node('app', ['src/*/y.ts'])],
      ['app/x', node('app/x', ['src/x/y.ts'])],
    ]) as any);
    const reverse = buildOwnerIndex(new Map([
      ['app/x', node('app/x', ['src/x/y.ts'])],
      ['app', node('app', ['src/*/y.ts'])],
    ]) as any);
    expect(forward.ownerOf('src/x/y.ts')).toBe('app/x');
    expect(reverse.ownerOf('src/x/y.ts')).toBe('app/x');
  });
});

describe('OwnerIndex.ownerEntryOf', () => {
  it('returns the winning entry and node path (unmapped → undefined)', () => {
    const idx = buildOwnerIndex(new Map([
      ['a', node('a', ['src/a'])],
      ['a/b', node('a/b', ['src/a/b'])],
    ]) as any);
    expect(idx.ownerEntryOf('src/a/b/x.ts')).toEqual({ nodePath: 'a/b', mapping: 'src/a/b', kind: 'directory' });
    expect(idx.ownerEntryOf('src/other/z.ts')).toBeUndefined();
  });

  it('(a) between siblings, the longer mapping wins and its kind is reported', () => {
    // x maps src/a (dir, len 5); y maps src/a/b (dir, len 7). x and y are
    // non-hierarchical node paths, so the longer (more specific) mapping wins.
    const idx = buildOwnerIndex(new Map([
      ['x', node('x', ['src/a'])],
      ['y', node('y', ['src/a/b'])],
    ]) as any);
    const entry = idx.ownerEntryOf('src/a/b/f.ts');
    expect(entry).toEqual({ nodePath: 'y', mapping: 'src/a/b', kind: 'directory' });
    // ownerOf and ownerEntryOf must never diverge on the winning node.
    expect(idx.ownerOf('src/a/b/f.ts')).toBe(entry?.nodePath);
  });

  it("(b) a descendant that maps a SHORTER/broader glob still beats its ancestor's longer directory (hierarchy-first, kind 'glob')", () => {
    // The confirmed bug shape: ancestor `app` maps a long directory; descendant
    // `app/child` maps a short glob that also covers the file. Hierarchy-first
    // means the DESCENDANT wins regardless of mapping length — the case a
    // length-first resolver gets wrong.
    const forward = buildOwnerIndex(new Map([
      ['app', node('app', ['src/app/feature/deep/'])],
      ['app/child', node('app/child', ['src/**/*.ts'])],
    ]) as any);
    const reverse = buildOwnerIndex(new Map([
      ['app/child', node('app/child', ['src/**/*.ts'])],
      ['app', node('app', ['src/app/feature/deep/'])],
    ]) as any);
    const file = 'src/app/feature/deep/thing.ts';
    expect(forward.ownerEntryOf(file)).toEqual({ nodePath: 'app/child', mapping: 'src/**/*.ts', kind: 'glob' });
    expect(reverse.ownerEntryOf(file)).toEqual({ nodePath: 'app/child', mapping: 'src/**/*.ts', kind: 'glob' });
    // The ancestor's longer directory mapping (len 20) loses to the child's
    // shorter glob (len 11) purely on hierarchy — the length-first bug's tell.
    expect(forward.ownerOf(file)).toBe('app/child');
    expect(reverse.ownerOf(file)).toBe('app/child');
  });

  it("(c) an exact literal match reports kind 'exact'", () => {
    const idx = buildOwnerIndex(new Map([
      ['r', node('r', ['src/lib/one.ts'])],
    ]) as any);
    const entry = idx.ownerEntryOf('src/lib/one.ts');
    expect(entry).toEqual({ nodePath: 'r', mapping: 'src/lib/one.ts', kind: 'exact' });
    expect(idx.ownerOf('src/lib/one.ts')).toBe(entry?.nodePath);
  });

  it('(d) ownerOf(f) equals ownerEntryOf(f)?.nodePath across mapped, unmapped, glob, and hierarchy cases', () => {
    const idx = buildOwnerIndex(new Map([
      ['a', node('a', ['src/a'])],
      ['a/b', node('a/b', ['src/a/b'])],
      ['g', node('g', ['lib/**/*.ts'])],
      ['app', node('app', ['pkg/app/feature/deep/'])],
      ['app/child', node('app/child', ['pkg/**/*.ts'])],
    ]) as any);
    for (const f of [
      'src/a/b/x.ts',                 // hierarchy: a/b wins over a
      'src/a/top.ts',                 // only a
      'lib/deep/nested/z.ts',         // glob
      'pkg/app/feature/deep/thing.ts',// hierarchy: app/child (short glob) wins over app (long dir)
      'nowhere/unmapped.ts',          // undefined both sides
    ]) {
      expect(idx.ownerOf(f)).toBe(idx.ownerEntryOf(f)?.nodePath);
    }
  });
});
