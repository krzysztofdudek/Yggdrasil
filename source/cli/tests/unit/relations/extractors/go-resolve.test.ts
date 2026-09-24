import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { makeResolvePathToFile, parseGoModulePath, parseGoWorkUses } from '../../../../src/relations/resolve-path.js';
import { resolveGoImport, type GoResolveDeps } from '../../../../src/relations/extractors/go-resolve.js';

// The Go resolver maps an import PATH → a package directory → a representative
// `.go` file. It reads go.mod for the module path and lists the package directory
// on disk, so these tests build a real temp repo and clean it up in `finally`.
// Driven through the production makeResolvePathToFile (disk-backed go.mod + readdir).

describe('resolveGoImport via makeResolvePathToFile (disk-backed)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'go-resolve-'));
    // module example.com/m, with a package at foo/bar containing baz.go.
    writeFileSync(path.join(root, 'go.mod'), 'module example.com/m\n\ngo 1.22\n', 'utf-8');
    mkdirSync(path.join(root, 'foo', 'bar'), { recursive: true });
    writeFileSync(path.join(root, 'foo', 'bar', 'baz.go'), 'package bar\n', 'utf-8');
    // An empty package directory (exists but no .go file).
    mkdirSync(path.join(root, 'foo', 'empty'), { recursive: true });
    // A package directory with ONLY a test file.
    mkdirSync(path.join(root, 'foo', 'onlytest'), { recursive: true });
    writeFileSync(path.join(root, 'foo', 'onlytest', 'x_test.go'), 'package onlytest\n', 'utf-8');
    // A package directory with a production + test file — production must win.
    mkdirSync(path.join(root, 'foo', 'mixed'), { recursive: true });
    writeFileSync(path.join(root, 'foo', 'mixed', 'a.go'), 'package mixed\n', 'utf-8');
    writeFileSync(path.join(root, 'foo', 'mixed', 'a_test.go'), 'package mixed\n', 'utf-8');
    // The module root itself holds a .go file (for the module-root import case).
    writeFileSync(path.join(root, 'main.go'), 'package main\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves an in-module import path to a representative .go file in its directory', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/m/foo/bar', 'foo/app/main.go', 'go')).toBe('foo/bar/baz.go');
  });

  it('resolves the module path itself to a .go file at the module root', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/m', 'foo/app/main.go', 'go')).toBe('main.go');
  });

  it('prefers a production file over a *_test.go file', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/m/foo/mixed', 'foo/app/main.go', 'go')).toBe('foo/mixed/a.go');
  });

  it('falls back to a *_test.go file when the directory has only tests', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/m/foo/onlytest', 'foo/app/main.go', 'go')).toBe(
      'foo/onlytest/x_test.go',
    );
  });

  it('returns undefined for a stdlib import (not under the module path)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('fmt', 'foo/app/main.go', 'go')).toBeUndefined();
    expect(resolve('os', 'foo/app/main.go', 'go')).toBeUndefined();
  });

  it('returns undefined for an external module import (not under the module path)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('github.com/gorilla/mux', 'foo/app/main.go', 'go')).toBeUndefined();
  });

  it('returns undefined for an in-module path whose directory has no .go file', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/m/foo/empty', 'foo/app/main.go', 'go')).toBeUndefined();
  });

  it('returns undefined for an in-module path whose directory does not exist', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/m/foo/nope', 'foo/app/main.go', 'go')).toBeUndefined();
  });

  it('returns undefined when there is no go.mod (module path unknown)', () => {
    const noMod = mkdtempSync(path.join(tmpdir(), 'go-nomod-'));
    try {
      mkdirSync(path.join(noMod, 'foo', 'bar'), { recursive: true });
      writeFileSync(path.join(noMod, 'foo', 'bar', 'baz.go'), 'package bar\n', 'utf-8');
      const resolve = makeResolvePathToFile(noMod);
      expect(resolve('example.com/m/foo/bar', 'foo/app/main.go', 'go')).toBeUndefined();
    } finally {
      rmSync(noMod, { recursive: true, force: true });
    }
  });

  it('does not confuse a prefix that is not a path boundary (modulePath + non-slash)', () => {
    // import path `example.com/main` shares the textual prefix `example.com/m`
    // but is NOT under module `example.com/m` (next char is not `/`) → silence.
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/main', 'foo/app/main.go', 'go')).toBeUndefined();
  });
});

describe('resolveGoImport — pure unit (injected deps)', () => {
  const deps: GoResolveDeps = {
    modulePathFor: () => ({ modulePath: 'example.com/m', moduleDir: '' }),
    dirExists: (d) => d === 'foo/bar' || d === '',
    goFilesIn: (d) =>
      d === 'foo/bar' ? ['foo/bar/baz.go', 'foo/bar/aux.go'] : d === '' ? ['main.go'] : [],
  };

  it('picks the lexicographically-first .go file deterministically', () => {
    // aux.go sorts before baz.go → stable representative choice.
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', deps)).toBe('foo/bar/aux.go');
  });

  it('returns undefined when modulePathFor yields nothing', () => {
    const noMod: GoResolveDeps = { ...deps, modulePathFor: () => undefined };
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', noMod)).toBeUndefined();
  });

  it('silences a package directory split across 2+ owners (F20 package granularity)', () => {
    // foo/bar holds aux.go (owned by node "y") and baz.go (owned by node "x").
    // With an ownerOf that reports a SPLIT package, the import must resolve to
    // nothing — no representative file, no edge — rather than attributing the
    // whole package to whoever owns the lexicographically-first file.
    const split: GoResolveDeps = {
      ...deps,
      goFilesIn: (d) => (d === 'foo/bar' ? ['foo/bar/baz.go', 'foo/bar/aux.go'] : []),
      ownerOf: (f) => (f === 'foo/bar/aux.go' ? 'y' : f === 'foo/bar/baz.go' ? 'x' : undefined),
    };
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', split)).toBeUndefined();
  });

  it('resolves a single-owner package even when ownerOf is supplied (positive)', () => {
    // Both files in foo/bar belong to node "x" → one owner → attribute the
    // representative (lexicographically-first production file, aux.go).
    const oneOwner: GoResolveDeps = {
      ...deps,
      goFilesIn: (d) => (d === 'foo/bar' ? ['foo/bar/baz.go', 'foo/bar/aux.go'] : []),
      ownerOf: () => 'x',
    };
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', oneOwner)).toBe('foo/bar/aux.go');
  });

  it('excluding the split package member that sorts FIRST attributes the import to whichever owner is left', () => {
    // foo/bar holds aux.go (owner y, sorts first) and baz.go (owner x, sorts
    // last) — a real two-owner split. Dropping the excluded file BEFORE deciding
    // ownership means the decision is made over what remains: only baz.go is
    // left, owned solely by x, so the import now attributes to x's own file —
    // the exclusion removed aux.go from consideration and nothing else; it did
    // not invent an owner x never had, and it did not bury the real dependency
    // the package's other, non-excluded file still justifies.
    const splitFirstExcluded: GoResolveDeps = {
      ...deps,
      goFilesIn: (d) => (d === 'foo/bar' ? ['foo/bar/baz.go', 'foo/bar/aux.go'] : []),
      ownerOf: (f) => (f === 'foo/bar/aux.go' ? 'y' : f === 'foo/bar/baz.go' ? 'x' : undefined),
      isExcluded: (f) => f === 'foo/bar/aux.go',
    };
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', splitFirstExcluded)).toBe('foo/bar/baz.go');
  });

  it('excluding the split package member that sorts LAST attributes the import to whichever owner is left', () => {
    // Mirror of the FIRST case: baz.go (owner x, sorts last) is excluded this
    // time, leaving aux.go (owner y) as the sole remaining owner.
    const splitLastExcluded: GoResolveDeps = {
      ...deps,
      goFilesIn: (d) => (d === 'foo/bar' ? ['foo/bar/baz.go', 'foo/bar/aux.go'] : []),
      ownerOf: (f) => (f === 'foo/bar/aux.go' ? 'y' : f === 'foo/bar/baz.go' ? 'x' : undefined),
      isExcluded: (f) => f === 'foo/bar/baz.go',
    };
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', splitLastExcluded)).toBe('foo/bar/aux.go');
  });

  it('a package split across THREE distinct owners still silences the import after excluding one member', () => {
    // foo/bar holds three files owned by three different nodes. Excluding one
    // still leaves two distinct owners among what remains — genuinely still
    // split, so the import must stay silent, not collapse to either survivor.
    const threeWaySplit: GoResolveDeps = {
      ...deps,
      goFilesIn: (d) => (d === 'foo/bar' ? ['foo/bar/aux.go', 'foo/bar/baz.go', 'foo/bar/qux.go'] : []),
      ownerOf: (f) =>
        f === 'foo/bar/aux.go' ? 'x' : f === 'foo/bar/baz.go' ? 'y' : f === 'foo/bar/qux.go' ? 'z' : undefined,
      isExcluded: (f) => f === 'foo/bar/aux.go',
    };
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', threeWaySplit)).toBeUndefined();
  });

  it('a single-file package resolves to its one owner when nothing is excluded', () => {
    const singleFile: GoResolveDeps = {
      ...deps,
      goFilesIn: (d) => (d === 'foo/bar' ? ['foo/bar/only.go'] : []),
      ownerOf: (f) => (f === 'foo/bar/only.go' ? 'x' : undefined),
    };
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', singleFile)).toBe('foo/bar/only.go');
  });

  it('a single-file package excluding an UNRELATED path elsewhere is unaffected', () => {
    // isExcluded here answers true for a path outside this package directory
    // entirely — the package's own only file is never excluded, so resolution
    // is byte-identical to the no-exclusion case above.
    const singleFileUnrelatedExcluded: GoResolveDeps = {
      ...deps,
      goFilesIn: (d) => (d === 'foo/bar' ? ['foo/bar/only.go'] : []),
      ownerOf: (f) => (f === 'foo/bar/only.go' ? 'x' : undefined),
      isExcluded: (f) => f === 'somewhere/else/entirely.go',
    };
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', singleFileUnrelatedExcluded)).toBe('foo/bar/only.go');
  });

  it('picks a NON-EXCLUDED file to represent a single owner when the lexicographically-first one is excluded', () => {
    // Both files belong to node "x" (single owner, not split). aux.go sorts
    // first and would normally be the representative, but it is excluded —
    // the representative must shift to the other file the SAME owner maps
    // (baz.go), never fall through to "no representative".
    const oneOwnerFirstExcluded: GoResolveDeps = {
      ...deps,
      goFilesIn: (d) => (d === 'foo/bar' ? ['foo/bar/baz.go', 'foo/bar/aux.go'] : []),
      ownerOf: () => 'x',
      isExcluded: (f) => f === 'foo/bar/aux.go',
    };
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', oneOwnerFirstExcluded)).toBe('foo/bar/baz.go');
  });

  it('falls back to the sole owner\'s own file (never a different owner\'s) when EVERY one of its files is excluded', () => {
    const allExcluded: GoResolveDeps = {
      ...deps,
      goFilesIn: (d) => (d === 'foo/bar' ? ['foo/bar/baz.go', 'foo/bar/aux.go'] : []),
      ownerOf: () => 'x',
      isExcluded: () => true,
    };
    // Still names one of x's own files (never undefined, never a fabricated
    // owner) — the downstream, exclusion-guarded owner lookup on that file is
    // what actually silences the edge, the same as a wholly-excluded package.
    expect(resolveGoImport('example.com/m/foo/bar', 'foo/x.go', allExcluded)).toBe('foo/bar/aux.go');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-module repositories: ancestor modules, go.work members, nested-module claims.
describe('resolveGoImport — multi-module repositories (disk-backed)', () => {
  let ws: string;
  const put = (rel: string, text: string): void => {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), text, 'utf-8');
  };
  beforeEach(() => {
    ws = mkdtempSync(path.join(tmpdir(), 'go-multi-'));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('a nested module importing its parent binds the parent module`s package', () => {
    put('go.mod', 'module example.com/m\n');
    put('creds/c.go', 'package creds\n');
    put('sec/tls/go.mod', 'module example.com/m/sec/tls\n');
    put('sec/tls/internal/util/u.go', 'package util\n');
    put('internal/util/decoy.go', 'package util\n');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('example.com/m/creds', 'sec/tls/tls.go', 'go')).toBe('creds/c.go');
    // The nested module's own path is the longer match → its own directory, never the decoy.
    expect(resolve('example.com/m/sec/tls/internal/util', 'sec/tls/tls.go', 'go')).toBe('sec/tls/internal/util/u.go');
  });

  it('a go.work member binds another member`s package (single-line and block `use`)', () => {
    put('go.work', 'go 1.22\n\nuse ./a // first\nuse (\n  "./b"\n  ../outside\n)\n');
    put('a/go.mod', 'module example.com/a\n');
    put('b/go.mod', 'module example.com/b\n');
    put('b/lib/lib.go', 'package lib\n');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('example.com/b/lib', 'a/app/main.go', 'go')).toBe('b/lib/lib.go');
    // Without the workspace the sibling module is external.
    rmSync(path.join(ws, 'go.work'));
    expect(makeResolvePathToFile(ws)('example.com/b/lib', 'a/app/main.go', 'go')).toBeUndefined();
  });

  it('a package directory claimed by a deeper go.mod with a different path is silenced', () => {
    put('go.mod', 'module example.com/m\n');
    put('vendorish/go.mod', 'module example.com/other\n');
    put('vendorish/pkg/p.go', 'package pkg\n');
    put('sub/go.mod', 'module example.com/m/sub\n');
    put('sub/pkg/p.go', 'package pkg\n');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('example.com/m/vendorish/pkg', 'app/main.go', 'go')).toBeUndefined();
    // A nested module whose own path names the same directory is consistent → bound.
    expect(resolve('example.com/m/sub/pkg', 'app/main.go', 'go')).toBe('sub/pkg/p.go');
  });

  it('reads a quoted, raw-string, commented or block-form module path', () => {
    expect(parseGoModulePath('module "example.com/q" // c\n')).toBe('example.com/q');
    expect(parseGoModulePath('module `example.com/r`\n')).toBe('example.com/r');
    expect(parseGoModulePath('// module example.com/no\nmodule example.com/yes\n')).toBe('example.com/yes');
    expect(parseGoModulePath('module (\n  "example.com/b"\n)\n')).toBe('example.com/b');
    expect(parseGoModulePath('module (example.com/c)\n')).toBe('example.com/c');
    expect(parseGoModulePath('modulex example.com/no\n')).toBeUndefined();
  });

  it('reads go.work `use` directives in every form', () => {
    expect(parseGoWorkUses('use ./a\nuse "./b"\nuse (\n ./c // x\n `./d`\n)\nuse (./e)\n')).toEqual([
      './a',
      './b',
      './c',
      './d',
      './e',
    ]);
  });
});

describe('resolveGoImport — longest-prefix module pick (injected deps)', () => {
  const baseDeps = (modules: Array<{ modulePath: string; moduleDir: string }>): GoResolveDeps => ({
    modulePathFor: () => modules[0],
    modulesFor: () => modules,
    dirExists: () => true,
    goFilesIn: (d) => [`${d}/x.go`],
  });

  it('picks the longest matching module path', () => {
    const deps = baseDeps([
      { modulePath: 'example.com/m/sub', moduleDir: 'sub' },
      { modulePath: 'example.com/m', moduleDir: '' },
    ]);
    expect(resolveGoImport('example.com/m/sub/p', 'sub/a.go', deps)).toBe('sub/p/x.go');
    expect(resolveGoImport('example.com/m/q', 'sub/a.go', deps)).toBe('q/x.go');
  });

  it('silences two candidates claiming the same longest path in different directories', () => {
    const deps = baseDeps([
      { modulePath: 'example.com/dup', moduleDir: 'one' },
      { modulePath: 'example.com/dup', moduleDir: 'two' },
    ]);
    expect(resolveGoImport('example.com/dup/p', 'one/a.go', deps)).toBeUndefined();
  });
});

describe('go.mod / go.work parsing — degenerate forms', () => {
  it('an empty or empty-string module block declares nothing', () => {
    expect(parseGoModulePath('module (\n)\n')).toBeUndefined();
    expect(parseGoModulePath('module (\n  ""\n)\n')).toBeUndefined();
    expect(parseGoModulePath('module ()\n')).toBeUndefined();
    expect(parseGoModulePath('module ""\nmodule example.com/late\n')).toBe('example.com/late');
  });

  it('go.work: empty block, empty path and a non-use directive are ignored', () => {
    expect(parseGoWorkUses('use (\n)\nuse ""\nusefoo ./x\ntoolchain go1.22\nuse (\n  ""\n)\n')).toEqual([]);
  });
});

describe('resolveGoImport — go.work at the repository root', () => {
  let ws: string;
  const put = (rel: string, text: string): void => {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), text, 'utf-8');
  };
  beforeEach(() => {
    ws = mkdtempSync(path.join(tmpdir(), 'go-work-root-'));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('a `use .` member is the repository-root module', () => {
    put('go.work', 'use (\n  .\n  ./tools\n)\n');
    put('go.mod', 'module example.com/root\n');
    put('tools/go.mod', 'module example.com/tools\n');
    put('lib/l.go', 'package lib\n');
    put('tools/gen/g.go', 'package gen\n');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('example.com/tools/gen', 'lib/l.go', 'go')).toBe('tools/gen/g.go');
    expect(resolve('example.com/root/lib', 'tools/gen/g.go', 'go')).toBe('lib/l.go');
  });

  it('a nested module root imported by its own path from the parent module is bound', () => {
    put('go.mod', 'module example.com/m\n');
    put('sub/go.mod', 'module example.com/m/sub\n');
    put('sub/s.go', 'package sub\n');
    const resolve = makeResolvePathToFile(ws);
    expect(resolve('example.com/m/sub', 'app/main.go', 'go')).toBe('sub/s.go');
  });
});
