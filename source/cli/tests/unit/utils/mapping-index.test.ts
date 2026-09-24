/**
 * utils/mapping-index.ts must give exactly the answers of testing every entry
 * with mappingEntryMatchesFile (the one definition of a match), and
 * normalizeMappingPath's fast path must return exactly what the full
 * normalization returns. Both checked against the linear / reference forms over
 * generated inputs, including the spellings normalization exists for.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { MappingIndex, mappingEntrySet } from '../../../src/utils/mapping-index.js';
import { mappingEntryMatchesFile, normalizeMappingPath } from '../../../src/utils/mapping-path.js';

function referenceNormalize(p: string): string {
  const cleaned = p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleaned === '') return '';
  return path.posix.normalize(cleaned).replace(/\/+$/, '');
}

// Deterministic pseudo-random source (no flaky seeds).
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SEGMENTS = ['src', 'lib', 'a', 'b', 'app', '[id]', 'page.tsx', 'x.ts', 'y.js', '.github', 'workflows', '.', '..', '', '*', '**', '*.ts', ' src', 'b\\c'];

function randomPath(r: () => number): string {
  const n = 1 + Math.floor(r() * 4);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(SEGMENTS[Math.floor(r() * SEGMENTS.length)]!);
  let p = parts.join('/');
  if (r() < 0.1) p = `./${p}`;
  if (r() < 0.1) p = `${p}/`;
  if (r() < 0.05) p = `/${p}`;
  return p;
}

describe('normalizeMappingPath fast path', () => {
  it('returns what the full normalization returns, for canonical and non-canonical spellings alike', () => {
    const r = rng(7);
    for (let i = 0; i < 20_000; i++) {
      const p = randomPath(r);
      expect(normalizeMappingPath(p), JSON.stringify(p)).toBe(referenceNormalize(p));
    }
    for (const p of ['src/a.ts', 'src//a.ts', 'src/./a.ts', 'src/../a.ts', './src', 'src/', ' src ', 'a\\b', '/abs/x', '..', '.', '']) {
      expect(normalizeMappingPath(p), JSON.stringify(p)).toBe(referenceNormalize(p));
    }
  });
});

describe('MappingIndex', () => {
  it('matches exactly the entries a linear mappingEntryMatchesFile scan matches, in entry order', () => {
    const r = rng(42);
    for (let round = 0; round < 200; round++) {
      const entries = Array.from({ length: 1 + Math.floor(r() * 12) }, () => randomPath(r));
      const index = new MappingIndex(entries.map((e, i) => [e, i] as const));
      for (let k = 0; k < 50; k++) {
        const file = randomPath(r).replace(/\*/g, 'z');
        const expected = entries.map((e, i) => (mappingEntryMatchesFile(e, file) ? i : -1)).filter((i) => i >= 0);
        const actual = index.matches(file).map((h) => h.value);
        expect(actual, `${JSON.stringify(file)} vs ${JSON.stringify(entries)}`).toEqual(expected);
        expect(index.matchesAny(file)).toBe(expected.length > 0);
      }
    }
  });

  it('answers directory, exact and glob entries', () => {
    const set = mappingEntrySet(['src/app', 'docs/readme.md', 'tools/**/*.sh', './lib/']);
    expect(set.matchesAny('src/app/x.ts')).toBe(true);
    expect(set.matchesAny('src/application.ts')).toBe(false);
    expect(set.matchesAny('docs/readme.md')).toBe(true);
    expect(set.matchesAny('docs/readme.md.bak')).toBe(false);
    expect(set.matchesAny('tools/a/b/run.sh')).toBe(true);
    expect(set.matchesAny('tools/a/b/run.py')).toBe(false);
    expect(set.matchesAny('lib/z.ts')).toBe(true);
  });
});
