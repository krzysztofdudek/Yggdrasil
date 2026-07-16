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
