import { describe, it, expect } from 'vitest';
import { resolvePythonModule } from '../../../../src/relations/extractors/python-resolve.js';

// `exists` predicate over a fixed set of repo-relative POSIX files.
const known = new Set([
  'src/a/b.py',
  'src/a/__init__.py',
  'src/a/pkg/mod.py',
  'src/a/sib.py',
  'src/pkg/__init__.py',
  'top.py',
]);
const exists = (p: string) => known.has(p);

describe('resolvePythonModule — absolute', () => {
  it('resolves a module file via an ancestor source root', () => {
    // Importing from src/a/c.py, module `a.b` lives at src/a/b.py (root = src/).
    expect(resolvePythonModule('a.b', 'src/a/c.py', exists)).toBe('src/a/b.py');
  });

  it('resolves a package to its __init__.py', () => {
    expect(resolvePythonModule('pkg', 'src/a/c.py', exists)).toBe('src/pkg/__init__.py');
  });

  it('resolves `from a import b` (last segment is a submodule file)', () => {
    // `from a import b` emits candidate `a.b` → src/a/b.py.
    expect(resolvePythonModule('a.b', 'src/x.py', exists)).toBe('src/a/b.py');
  });

  it('longest-match: `a.b.thing` falls back to the parent module a.b', () => {
    // No src/a/b/thing.py; the parent module a.b (src/a/b.py) is the owning file.
    expect(resolvePythonModule('a.b.thing', 'src/a/c.py', exists)).toBe('src/a/b.py');
  });

  it('resolves a top-level module at the repo root', () => {
    expect(resolvePythonModule('top', 'src/a/c.py', exists)).toBe('top.py');
  });

  it('returns undefined for a stdlib/third-party module (no mapped file)', () => {
    expect(resolvePythonModule('os', 'src/a/c.py', exists)).toBeUndefined();
    expect(resolvePythonModule('requests', 'src/a/c.py', exists)).toBeUndefined();
  });

  it('returns undefined for a non-existent module (no file, no resolvable parent)', () => {
    // `nope.deep`: neither nope/deep.py, nope/deep/__init__.py, nope.py, nor
    // nope/__init__.py exists at any source root → a true resolution miss.
    expect(resolvePythonModule('nope.deep', 'src/a/c.py', exists)).toBeUndefined();
  });

  it('returns undefined for an empty specifier (no module segments)', () => {
    expect(resolvePythonModule('', 'src/a/c.py', exists)).toBeUndefined();
  });

  it('resolves a top-level module when the importing file sits at the repo root', () => {
    // dirname('main.py') === '.', so the ancestor walk starts from the repo root.
    const rootKnown = new Set(['top.py']);
    expect(resolvePythonModule('top', 'main.py', (p) => rootKnown.has(p))).toBe('top.py');
  });

  it('longest-match: `a.nope` falls back to package `a` __init__ (nope may be a symbol there)', () => {
    // Documented behaviour: `from a import nope` where `nope` is not a submodule
    // file resolves to the package a (src/a/__init__.py); the symbol lives inside.
    expect(resolvePythonModule('a.nope', 'src/a/c.py', exists)).toBe('src/a/__init__.py');
  });

  it('returns undefined when the own dir shadows a genuine root (2+ distinct files)', () => {
    // Importing file src/a/b.py does `from b.bar import x`. The genuine root is
    // src/, where b.bar -> src/b/bar.py (a real cross-node target). But the
    // importer's OWN dir src/a/ also "roots" the parent module b -> src/a/b.py
    // (the importing file itself). Two distinct files match across roots, so the
    // absolute resolver must SILENCE (undefined) rather than pick the nearer self.
    const shadow = new Set(['src/a/b.py', 'src/b/bar.py']);
    expect(resolvePythonModule('b.bar', 'src/a/b.py', (p) => shadow.has(p))).toBeUndefined();
  });

  it('returns undefined when an intermediate dir shadows a genuine root', () => {
    // Importing file src/pkg/a/c.py does an absolute `import pkg.mod`. The genuine
    // root is src/ -> src/pkg/mod.py. But the intermediate dir src/pkg/ also roots
    // pkg.mod -> src/pkg/pkg/mod.py. Two distinct files -> silence.
    const shadow = new Set(['src/pkg/pkg/mod.py', 'src/pkg/mod.py']);
    expect(resolvePythonModule('pkg.mod', 'src/pkg/a/c.py', (p) => shadow.has(p))).toBeUndefined();
  });

  it('still resolves a single-root cross-node import (no shadowing file present)', () => {
    // Paired positive: ONLY the genuine target exists (no self-shadow). The legit
    // cross-node edge `from b.bar import x` at the source root must still resolve.
    const clean = new Set(['src/b/bar.py']);
    expect(resolvePythonModule('b.bar', 'src/a/foo.py', (p) => clean.has(p))).toBe('src/b/bar.py');
  });

  describe('exclusion awareness', () => {
    // Same shadow shape as the "own dir shadows a genuine root" test above: two
    // ancestor roots each hold a file matching the same dotted module, so the
    // absolute resolver treats it as genuinely ambiguous and stays silent. An
    // `isExcluded` predicate that marks one of the two matches as graph-excluded
    // must drop it from the ambiguity count BEFORE the silence decision, the same
    // drop-then-decide rule the Go/Java package resolvers already apply.
    const shadow = new Set(['src/a/b.py', 'src/b/bar.py']);
    const shadowExists = (p: string) => shadow.has(p);

    it('control: with nothing excluded, two distinct roots stay ambiguous — silent', () => {
      expect(resolvePythonModule('b.bar', 'src/a/b.py', shadowExists)).toBeUndefined();
    });

    it('excluding the match that sorts FIRST resolves to the survivor', () => {
      // 'src/a/b.py' < 'src/b/bar.py' lexicographically.
      const isExcluded = (p: string) => p === 'src/a/b.py';
      expect(resolvePythonModule('b.bar', 'src/a/b.py', shadowExists, isExcluded)).toBe(
        'src/b/bar.py',
      );
    });

    it('excluding the match that sorts LAST resolves to the survivor', () => {
      const isExcluded = (p: string) => p === 'src/b/bar.py';
      expect(resolvePythonModule('b.bar', 'src/a/b.py', shadowExists, isExcluded)).toBe(
        'src/a/b.py',
      );
    });

    it('excluding an UNRELATED path elsewhere leaves a genuinely ambiguous resolution silent', () => {
      const isExcluded = (p: string) => p === 'somewhere/else/entirely.py';
      expect(
        resolvePythonModule('b.bar', 'src/a/b.py', shadowExists, isExcluded),
      ).toBeUndefined();
    });
  });
});

describe('resolvePythonModule — relative', () => {
  it('resolves `..pkg.mod` from src/a/b/c.py to src/a/pkg/mod.py', () => {
    expect(resolvePythonModule('..pkg.mod', 'src/a/b/c.py', exists)).toBe('src/a/pkg/mod.py');
  });

  it('resolves `.sib` (one dot, same package) from src/a/x.py to src/a/sib.py', () => {
    expect(resolvePythonModule('.sib', 'src/a/x.py', exists)).toBe('src/a/sib.py');
  });

  it('resolves a bare `.` to the importing package __init__', () => {
    expect(resolvePythonModule('.', 'src/a/x.py', exists)).toBe('src/a/__init__.py');
  });

  it('returns undefined when the relative climb escapes the repo', () => {
    expect(resolvePythonModule('....deep', 'src/a/x.py', exists)).toBeUndefined();
  });

  it('returns undefined when the relative target does not exist', () => {
    expect(resolvePythonModule('.missing', 'src/a/x.py', exists)).toBeUndefined();
  });
});
