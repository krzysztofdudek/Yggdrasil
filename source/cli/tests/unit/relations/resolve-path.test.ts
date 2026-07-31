import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { makeResolvePathToFile } from '../../../src/relations/resolve-path.js';

// Unit coverage for the production resolvePathToFile dispatcher: it must route
// TS-family languages through resolveTsPath against on-disk files, and return
// undefined for every other (symbol-resolved or not-yet-implemented) language.

describe('makeResolvePathToFile', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'resolve-path-'));
    mkdirSync(path.join(root, 'src', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'b', 'bar.ts'), 'export const bar = 1;\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a relative TypeScript import against a file on disk', () => {
    const resolve = makeResolvePathToFile(root);
    // NodeNext '.js' specifier rewrites to the '.ts' source that exists on disk.
    expect(resolve('../b/bar.js', 'src/a/foo.ts', 'typescript')).toBe('src/b/bar.ts');
  });

  it('dispatches tsx and javascript through the same TS resolver', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../b/bar.js', 'src/a/foo.tsx', 'tsx')).toBe('src/b/bar.ts');
    expect(resolve('../b/bar.js', 'src/a/foo.js', 'javascript')).toBe('src/b/bar.ts');
  });

  it('returns undefined when the resolved file does not exist on disk', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../b/missing.js', 'src/a/foo.ts', 'typescript')).toBeUndefined();
  });

  it('returns undefined for a bare/external specifier', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('zod', 'src/a/foo.ts', 'typescript')).toBeUndefined();
  });

  it('returns undefined for a non-TS language (symbol-resolved or not yet implemented)', () => {
    const resolve = makeResolvePathToFile(root);
    // Even a specifier that would resolve under TS is ignored for other languages.
    expect(resolve('../b/bar.js', 'src/a/foo.py', 'python')).toBeUndefined();
    expect(resolve('../b/bar.js', 'src/a/foo.go', 'go')).toBeUndefined();
    expect(resolve('../b/bar.js', 'src/a/foo.x', '')).toBeUndefined();
  });
});

// The dispatcher routes the non-TS, path-precise languages through their per-language
// disk-backed dep factories (go.mod / Cargo.toml / composer.json discovery, package=dir
// for Java, quoted includes for C/C++, require_relative for Ruby). These build a real
// temp project on disk with each language's manifest and source files and drive the
// production makeResolvePathToFile through every language dispatch arm — including the
// manifest cache-hit (resolve two files under the same manifest dir) and the
// absent-manifest walk-up-to-root → undefined fail-to-silence.
describe('makeResolvePathToFile — per-language dispatch (disk-backed)', () => {
  let root: string;

  function w(rel: string, content = '// x\n'): void {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'resolve-path-langs-'));

    // GO: a module rooted at example.com/app. The go.mod leads with a comment and a
    // blank line before the `module` directive so the comment/blank skip is exercised.
    w('go.mod', '// module manifest\n\nmodule example.com/app\n\ngo 1.21\n');
    w('svc/handler.go', 'package svc\n');
    w('svc/util.go', 'package svc\n');
    w('cmd/main.go', 'package main\n');
    w('cmd/extra.go', 'package main\n');

    // PHP: composer PSR-4 mapping App\ → src/.
    w('composer.json', JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }) + '\n');
    w('src/Payment/Gateway.php', '<?php\n');
    w('app/start.php', '<?php\n');
    w('app/run.php', '<?php\n');

    // JAVA: package = directory; a wildcard import lists the package dir's .java files.
    // A non-.java sibling (package-info-less README) exercises the .java-only filter in
    // javaFilesIn (the directory entry that is skipped).
    w('com/foo/Bar.java', 'package com.foo;\n');
    w('com/foo/App.java', 'package com.foo;\n');
    w('com/foo/Baz.java', 'package com.foo;\n');
    w('com/foo/README.md', '# not java\n');

    // RUST: a crate named "my-crate" (hyphen → underscore identifier rule). A
    // `[workspace]` section with a key precedes `[package]`, so the crate-name scan
    // encounters a non-section line while OUTSIDE the [package] section (the
    // not-in-package skip), then finds the name inside [package].
    w('Cargo.toml', '[workspace]\nresolver = "2"\n\n[package]\nname = "my-crate"\nversion = "0.1.0"\n');
    w('src/lib.rs', '// lib\n');
    w('src/orders/mod.rs', '// orders\n');
    w('src/a.rs', '// a\n');
    w('src/b.rs', '// b\n');
    // A NESTED crate under crates/core (its Cargo.toml is not at the repo root), so
    // crate-root discovery returns a non-empty src dir; two files under its src/ make
    // the second resolution serve the crate root from the crateRootFor cache.
    w('crates/core/Cargo.toml', '[package]\nname = "core"\nversion = "0.1.0"\n');
    w('crates/core/src/lib.rs', '// core lib\n');
    w('crates/core/src/x.rs', '// x\n');
    w('crates/core/src/y.rs', '// y\n');

    // C/C++: a quoted include resolving relative to the including file.
    w('inc/foo.h', '/* h */\n');
    w('csrc/main.c', '#include "../inc/foo.h"\n');

    // RUBY: require_relative resolving relative to the requiring file.
    w('lib/order.rb', '# order\n');
    w('lib/app.rb', "require_relative 'order'\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a Go import through the nearest go.mod module path', () => {
    const resolve = makeResolvePathToFile(root);
    // example.com/app + "/svc" → directory svc/ → its lexically-first .go file.
    expect(resolve('example.com/app/svc', 'cmd/main.go', 'go')).toBe('svc/handler.go');
  });

  it('resolves a Go import from a TOP-LEVEL file (no directory component)', () => {
    // 'root.go' (no directory) exercises the dirname-normalization branch in
    // modulePathFor (posix.dirname returns '.' for a bare filename).
    w('root.go', 'package main\n');
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/app/svc', 'root.go', 'go')).toBe('svc/handler.go');
  });

  it('reads the Go module path once and serves a second file from the cache', () => {
    const resolve = makeResolvePathToFile(root);
    // cmd/main.go and cmd/extra.go share the same nearest go.mod (the repo root); the
    // second resolution hits the modulePathFor cache rather than re-reading go.mod.
    expect(resolve('example.com/app/svc', 'cmd/main.go', 'go')).toBe('svc/handler.go');
    expect(resolve('example.com/app/svc', 'cmd/extra.go', 'go')).toBe('svc/handler.go');
  });

  it('resolves a PHP FQN through composer PSR-4, and serves a second file from the cache', () => {
    const resolve = makeResolvePathToFile(root);
    // app/start.php and app/run.php share the same nearest composer.json (the repo
    // root); the second resolution hits the psr4For cache.
    expect(resolve('App\\Payment\\Gateway', 'app/start.php', 'php')).toBe('src/Payment/Gateway.php');
    expect(resolve('App\\Payment\\Gateway', 'app/run.php', 'php')).toBe('src/Payment/Gateway.php');
  });

  it('resolves a PHP FQN from a TOP-LEVEL file (no directory component)', () => {
    // 'root.php' (no directory) exercises the dirname-normalization branch in
    // psr4For (posix.dirname returns '.' for a bare filename).
    w('root.php', '<?php\n');
    const resolve = makeResolvePathToFile(root);
    expect(resolve('App\\Payment\\Gateway', 'root.php', 'php')).toBe('src/Payment/Gateway.php');
  });

  it('resolves a Java type FQN to its package=dir file', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('com.foo.Bar', 'com/foo/App.java', 'java')).toBe('com/foo/Bar.java');
  });

  it('returns undefined for a Java package FQN without isPackage=true (no fall-through)', () => {
    const resolve = makeResolvePathToFile(root);
    // Without the isPackage flag, a package-directory FQN must NOT fall through to
    // package resolution — the type guard returns undefined instead of a phantom edge.
    expect(resolve('com.foo', 'src/Main.java', 'java')).toBeUndefined();
  });

  it('resolves a Java wildcard package import when isPackage=true and all files share one owner', () => {
    // With isPackage=true and an ownerOf that maps both com/foo .java files to 'foo',
    // the owner set has exactly one member → return the lexically-first file.
    const ownerOf = (f: string): string | undefined =>
      f.startsWith('com/foo/') && f.endsWith('.java') ? 'foo' : undefined;
    const resolve = makeResolvePathToFile(root, ownerOf);
    // From a root-level file the ancestor walk reaches com/foo/ at the repo root.
    expect(resolve('com.foo', 'src/Main.java', 'java', true)).toBe('com/foo/App.java');
  });

  it('silences a Java wildcard package import when files split across two owners', () => {
    // Two different owners → 2 distinct values in the owner set → silence (undefined).
    const ownerOf = (f: string): string | undefined => {
      if (f === 'com/foo/App.java') return 'node-a';
      if (f === 'com/foo/Bar.java') return 'node-b';
      return undefined;
    };
    const resolve = makeResolvePathToFile(root, ownerOf);
    expect(resolve('com.foo', 'src/Main.java', 'java', true)).toBeUndefined();
  });

  it('excluding one file of a split Java wildcard package attributes the import to whichever owner is left', () => {
    // Same split as above (App.java → node-a, Bar.java → node-b), but App.java is
    // now excluded. Dropping it BEFORE deciding ownership means only Bar.java is
    // left — owned solely by node-b — so the import now attributes to node-b: the
    // exclusion removed App.java from consideration and nothing else.
    const ownerOf = (f: string): string | undefined => {
      if (f === 'com/foo/App.java') return 'node-a';
      if (f === 'com/foo/Bar.java') return 'node-b';
      return undefined;
    };
    const isExcluded = (f: string): boolean => f === 'com/foo/App.java';
    const resolve = makeResolvePathToFile(root, ownerOf, isExcluded);
    expect(resolve('com.foo', 'src/Main.java', 'java', true)).toBe('com/foo/Bar.java');
  });

  it('excluding the OTHER file of the same split package attributes it to the other owner', () => {
    // Mirror of the case above: Bar.java (node-b) excluded this time, leaving
    // App.java (node-a) as the sole remaining owner.
    const ownerOf = (f: string): string | undefined => {
      if (f === 'com/foo/App.java') return 'node-a';
      if (f === 'com/foo/Bar.java') return 'node-b';
      return undefined;
    };
    const isExcluded = (f: string): boolean => f === 'com/foo/Bar.java';
    const resolve = makeResolvePathToFile(root, ownerOf, isExcluded);
    expect(resolve('com.foo', 'src/Main.java', 'java', true)).toBe('com/foo/App.java');
  });

  it('a Java wildcard package split across THREE owners still silences the import after excluding one member', () => {
    // com/foo now has three files, each owned by a different node. Excluding one
    // still leaves two distinct owners among what remains — genuinely still
    // split, so the import stays silent rather than collapsing to a survivor.
    const ownerOf = (f: string): string | undefined => {
      if (f === 'com/foo/App.java') return 'node-a';
      if (f === 'com/foo/Bar.java') return 'node-b';
      if (f === 'com/foo/Baz.java') return 'node-c';
      return undefined;
    };
    const isExcluded = (f: string): boolean => f === 'com/foo/App.java';
    const resolve = makeResolvePathToFile(root, ownerOf, isExcluded);
    expect(resolve('com.foo', 'src/Main.java', 'java', true)).toBeUndefined();
  });

  it('a Java wildcard package where EVERY file is excluded resolves to no owner', () => {
    // Both of com/foo's files belong to node 'foo', but both are excluded —
    // nothing remains to decide ownership from, so the import stays silent
    // (the same silence a wholly-unmapped package gets).
    const ownerOf = (f: string): string | undefined =>
      f.startsWith('com/foo/') && f.endsWith('.java') ? 'foo' : undefined;
    const isExcluded = (f: string): boolean => f.startsWith('com/foo/') && f.endsWith('.java');
    const resolve = makeResolvePathToFile(root, ownerOf, isExcluded);
    expect(resolve('com.foo', 'src/Main.java', 'java', true)).toBeUndefined();
  });

  it('picks a NON-EXCLUDED file to represent a single-owner Java package when the lexically-first one is excluded', () => {
    // Both files belong to 'foo' (not split). App.java sorts first and would
    // normally be the representative, but it is excluded — the representative
    // must shift to Bar.java (the SAME owner's other file), never silence.
    const ownerOf = (f: string): string | undefined =>
      f.startsWith('com/foo/') && f.endsWith('.java') ? 'foo' : undefined;
    const isExcluded = (f: string): boolean => f === 'com/foo/App.java';
    const resolve = makeResolvePathToFile(root, ownerOf, isExcluded);
    expect(resolve('com.foo', 'src/Main.java', 'java', true)).toBe('com/foo/Bar.java');
  });

  it('resolves a Rust crate path through the nearest Cargo.toml src dir', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::orders', 'src/lib.rs', 'rust')).toBe('src/orders/mod.rs');
  });

  it('treats the crate package name (hyphen→underscore) like `crate`', () => {
    const resolve = makeResolvePathToFile(root);
    // `my_crate::a` uses the crate's own package name (Cargo.toml `name = "my-crate"`,
    // hyphen normalized) → rooted like crate, resolving under the crate's src dir.
    expect(resolve('my_crate::a', 'src/lib.rs', 'rust')).toBe('src/a.rs');
  });

  it('resolves crate-root-relative files from a TOP-LEVEL file (no directory component)', () => {
    // 'main.rs' (no directory) exercises the dirname-normalization branch
    // (posix.dirname returns '.' for a bare filename, normalized to '').
    w('main.rs', 'fn main() {}\n');
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::a', 'main.rs', 'rust')).toBe('src/a.rs');
  });

  it('resolves a nested-crate path and serves the crate root from the cache on a second file', () => {
    const resolve = makeResolvePathToFile(root);
    // crates/core has its OWN Cargo.toml (not at the repo root), so crate-root
    // discovery returns a non-root src dir. Resolving a second file under the same
    // crate dir serves the crate root from the crateRootFor cache rather than
    // re-walking to a fresh Cargo.toml read.
    expect(resolve('crate::x', 'crates/core/src/lib.rs', 'rust')).toBe('crates/core/src/x.rs');
    expect(resolve('crate::y', 'crates/core/src/y.rs', 'rust')).toBe('crates/core/src/y.rs');
  });

  it('resolves a quoted C/C++ include relative to the including file', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../inc/foo.h', 'csrc/main.c', 'c')).toBe('inc/foo.h');
    expect(resolve('../inc/foo.h', 'csrc/main.cpp', 'cpp')).toBe('inc/foo.h');
  });

  it('resolves a Ruby require_relative relative to the requiring file', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('order', 'lib/app.rb', 'ruby')).toBe('lib/order.rb');
  });

});

describe('makeResolvePathToFile — a Cargo.toml [package] section with no `name` line', () => {
  it('still resolves the plain `crate::` keyword via srcDir (crateName undefined, no crash)', () => {
    // [package] is present (so the section-tracking `inPackage` flips true) but the
    // ONLY line inside it is `version = "..."`, which the name regex attempts and
    // misses — unlike a line outside [package] (skipped before the match is tried).
    const bareRoot = mkdtempSync(path.join(tmpdir(), 'resolve-path-noname-'));
    try {
      mkdirSync(path.join(bareRoot, 'src'), { recursive: true });
      writeFileSync(path.join(bareRoot, 'Cargo.toml'), '[package]\nversion = "0.1.0"\n', 'utf-8');
      writeFileSync(path.join(bareRoot, 'src', 'lib.rs'), '// lib\n', 'utf-8');
      writeFileSync(path.join(bareRoot, 'src', 'a.rs'), '// a\n', 'utf-8');
      const resolve = makeResolvePathToFile(bareRoot);
      expect(resolve('crate::a', 'src/lib.rs', 'rust')).toBe('src/a.rs');
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });
});

describe('makeResolvePathToFile — a go.mod with no `module` directive (malformed manifest)', () => {
  it('resolves to undefined rather than crashing when the nearest go.mod has no module line', () => {
    // A go.mod that exists but carries only a comment — readModulePath's line scan
    // reaches EOF without a `module <path>` match, so resolution falls through to
    // undefined at this dir; with no OTHER go.mod anywhere up to the root, the walk
    // exhausts the tree and resolution is undefined (never a guessed source root).
    const bareRoot = mkdtempSync(path.join(tmpdir(), 'resolve-path-badmod-'));
    try {
      mkdirSync(path.join(bareRoot, 'vendor'), { recursive: true });
      // A non-comment, non-empty line that is NOT a `module <path>` directive —
      // the match attempt runs and misses, unlike a comment/blank line (skipped
      // before the match is even attempted).
      writeFileSync(path.join(bareRoot, 'vendor', 'go.mod'), 'go 1.21\n', 'utf-8');
      writeFileSync(path.join(bareRoot, 'vendor', 'lib.go'), 'package lib\n', 'utf-8');
      const resolve = makeResolvePathToFile(bareRoot);
      expect(resolve('example.com/anything', 'vendor/lib.go', 'go')).toBeUndefined();
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });
});

// Absent-manifest fail-to-silence: with no go.mod / composer.json / Cargo.toml anywhere,
// each per-language resolver walks up to the repo root, finds no manifest, and returns
// undefined rather than guessing a source root.
describe('makeResolvePathToFile — absent manifests resolve to undefined', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'resolve-path-bare-'));
    mkdirSync(path.join(root, 'svc'), { recursive: true });
    mkdirSync(path.join(root, 'app'), { recursive: true });
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'svc', 'handler.go'), 'package svc\n', 'utf-8');
    writeFileSync(path.join(root, 'app', 'start.php'), '<?php\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'lib.rs'), '// lib\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('Go import with no go.mod ancestor → undefined', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('example.com/app/svc', 'svc/handler.go', 'go')).toBeUndefined();
  });

  it('PHP FQN with no composer.json ancestor → undefined', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('App\\Payment\\Gateway', 'app/start.php', 'php')).toBeUndefined();
  });

  it('Rust path with no Cargo.toml ancestor → undefined', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('crate::orders', 'src/lib.rs', 'rust')).toBeUndefined();
  });
});
