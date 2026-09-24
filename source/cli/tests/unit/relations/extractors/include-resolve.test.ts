import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { makeResolvePathToFile } from '../../../../src/relations/resolve-path.js';
import { parseCompileCommands } from '../../../../src/relations/extractors/include-resolve.js';

// The C/C++ include resolver maps an `#include` name → a repo-relative file. A quoted include
// resolves next to the includer first; then, with a compile_commands.json, under its
// -iquote/-I roots, and without one, by a conservative probe (repository root + every
// `include/` dir, multi-segment names only). Across roots exactly one hit resolves; a miss or
// 2+ hits → undefined (silence). Single-segment names are never probed, so a same-basename
// decoy at an ancestor or under an include/ dir is never bound.
// These tests build a real temp tree and drive the production makeResolvePathToFile
// (disk-backed existence) for both the `c` and `cpp` language branches.

describe('resolveIncludePath via makeResolvePathToFile (disk-backed, C + C++)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'c-include-resolve-'));
    // src/a/foo.c  →  #include "../inc/bar.h"  resolves to src/inc/bar.h (relative).
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'inc'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a', 'foo.c'), '#include "../inc/bar.h"\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'inc', 'bar.h'), '/* bar */\n', 'utf-8');
    // A header reachable via the `include/` root convention from src/a (src/a/include/root.h),
    // and one via an ancestor `include/` dir (include/proj/widget.h at repo root).
    mkdirSync(path.join(root, 'include', 'proj'), { recursive: true });
    writeFileSync(path.join(root, 'include', 'proj', 'widget.h'), '/* widget */\n', 'utf-8');
    // A header sitting bare at the repo root (no include/ dir), and a root-level
    // source file — for the include-root walk and the root-directory (fromDir === '.')
    // cases. cfg.h exists ONLY under <root>/include/, so a root-level includer misses
    // the relative join and reaches the include-root walk with the root start dir.
    writeFileSync(path.join(root, 'top.h'), '/* top */\n', 'utf-8');
    writeFileSync(path.join(root, 'main.c'), '#include "cfg.h"\n', 'utf-8');
    writeFileSync(path.join(root, 'include', 'cfg.h'), '/* cfg */\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a relative quoted include against the including file directory (C)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../inc/bar.h', 'src/a/foo.c', 'c')).toBe('src/inc/bar.h');
  });

  it('resolves the same way for the cpp branch (shared resolver)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../inc/bar.h', 'src/a/foo.cpp', 'cpp')).toBe('src/inc/bar.h');
  });

  it('resolves a multi-segment name through the include/ probe when it has exactly one hit', () => {
    const resolve = makeResolvePathToFile(root);
    // From src/a/foo.c, "proj/widget.h" is not under src/a. Without a compilation database
    // the probe tries <root>/proj/widget.h (absent) and <root>/include/proj/widget.h (present):
    // one hit → resolved.
    expect(resolve('proj/widget.h', 'src/a/foo.c', 'c')).toBe('include/proj/widget.h');
  });

  it('silences a probe with two hits', () => {
    mkdirSync(path.join(root, 'libs', 'x', 'include', 'proj'), { recursive: true });
    writeFileSync(path.join(root, 'libs', 'x', 'include', 'proj', 'widget.h'), '/* dup */\n', 'utf-8');
    const resolve = makeResolvePathToFile(root);
    expect(resolve('proj/widget.h', 'src/a/foo.c', 'c')).toBeUndefined();
  });

  it('never probes a name with a . or .. segment, or an angle include without a database', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('./proj/widget.h', 'main.c', 'c')).toBeUndefined();
    expect(resolve('<proj/widget.h>', 'src/a/foo.c', 'c')).toBeUndefined();
  });

  it('normalises backslashes and refuses absolute names', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('..\\inc\\bar.h', 'src/a/foo.c', 'c')).toBe('src/inc/bar.h');
    expect(resolve('/usr/include/stdio.h', 'src/a/foo.c', 'c')).toBeUndefined();
    expect(resolve('C:\\sdk\\x.h', 'src/a/foo.c', 'c')).toBeUndefined();
  });

  it('drops an excluded hit before the exactly-one decision', () => {
    mkdirSync(path.join(root, 'libs', 'x', 'include', 'proj'), { recursive: true });
    writeFileSync(path.join(root, 'libs', 'x', 'include', 'proj', 'widget.h'), '/* excluded */\n', 'utf-8');
    const resolve = makeResolvePathToFile(root, undefined, (p) => p.startsWith('libs/'));
    expect(resolve('proj/widget.h', 'src/a/foo.c', 'c')).toBe('include/proj/widget.h');
  });

  it('returns undefined for a missing header (silence, never a guess)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../inc/missing.h', 'src/a/foo.c', 'c')).toBeUndefined();
    expect(resolve('nope/absent.h', 'src/a/foo.cpp', 'cpp')).toBeUndefined();
  });

  it('returns undefined for an empty specifier', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('', 'src/a/foo.c', 'c')).toBeUndefined();
  });

  it('does NOT resolve an include/-only header for a repo-root source file (walk dropped)', () => {
    const resolve = makeResolvePathToFile(root);
    // main.c lives at the repo root; cfg.h exists only under <root>/include/cfg.h.
    // The canonical relative join (<root>/cfg.h) misses, and the speculative
    // include-root probe is gone → silence.
    expect(resolve('cfg.h', 'main.c', 'c')).toBeUndefined();
  });

  it('does NOT resolve a header bare at an ancestor root (walk dropped)', () => {
    const resolve = makeResolvePathToFile(root);
    // From src/a/foo.c, "top.h" exists only as <root>/top.h — a same-basename
    // file at an ancestor root. The old walk would have grabbed it (a decoy);
    // the canonical-relative-only resolver returns undefined.
    expect(resolve('top.h', 'src/a/foo.c', 'c')).toBeUndefined();
  });

  it('does NOT grab a same-basename decoy at an ancestor root when the relative join misses', () => {
    const resolve = makeResolvePathToFile(root);
    // src/a/foo.c includes "bar.h". A real sibling does NOT exist next to foo.c, but a
    // same-basename decoy lives at <root>/include/proj — created here to model the trap.
    mkdirSync(path.join(root, 'include', 'proj'), { recursive: true });
    writeFileSync(path.join(root, 'include', 'proj', 'bar.h'), '/* decoy */\n', 'utf-8');
    // The relative join <root>/src/a/bar.h misses; with the walk dropped, the decoy is
    // never reached → silence (the old resolver would have returned a wrong path).
    expect(resolve('bar.h', 'src/a/foo.c', 'c')).toBeUndefined();
  });
});

describe('resolveIncludePath with a compile_commands.json', () => {
  let root: string;
  const write = (rel: string, text: string): void => {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text, 'utf-8');
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'c-compile-db-'));
    write('libs/net/include/net/socket.h', '');
    write('libs/util/include/util/log.h', '');
    write('libs/q/quoted/q.h', '');
    write('include/proj/widget.h', '');
    write('apps/server/main.c', '');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves through the unit\'s -I, -iquote and --include-directory roots (absolute directory)', () => {
    write(
      'compile_commands.json',
      JSON.stringify([
        {
          directory: path.join(root, 'apps/server'),
          file: 'main.c',
          command: 'cc -I ../../libs/net/include "-iquote../../libs/q/quoted" --include-directory=../../libs/util/include -isystem ../../include -c main.c',
        },
      ]),
    );
    const resolve = makeResolvePathToFile(root);
    expect(resolve('net/socket.h', 'apps/server/main.c', 'c')).toBe('libs/net/include/net/socket.h');
    expect(resolve('q.h', 'apps/server/main.c', 'c')).toBe('libs/q/quoted/q.h');
    expect(resolve('<util/log.h>', 'apps/server/main.c', 'c')).toBe('libs/util/include/util/log.h');
    // -iquote is for quoted includes only; -isystem is never a root; the probe is off.
    expect(resolve('<q.h>', 'apps/server/main.c', 'c')).toBeUndefined();
    expect(resolve('proj/widget.h', 'apps/server/main.c', 'c')).toBeUndefined();
  });

  it('gives a header that is not a unit the union of every unit\'s roots', () => {
    write('build/compile_commands.json', JSON.stringify([
      { directory: '..', file: 'apps/server/main.c', arguments: ['cc', '-Ilibs/net/include', '-c', 'apps/server/main.c'] },
    ]));
    const resolve = makeResolvePathToFile(root);
    expect(resolve('net/socket.h', 'libs/util/include/util/log.h', 'c')).toBe('libs/net/include/net/socket.h');
  });

  it('reads MSVC /I only for a cl driver, and drops roots outside the repository', () => {
    write('compile_commands.json', JSON.stringify([
      { directory: '.', file: 'apps/server/main.c', arguments: ['cl.exe', '/Ilibs/net/include', '-I/opt/sdk/include', '/c', 'apps/server/main.c'] },
    ]));
    const resolve = makeResolvePathToFile(root);
    expect(resolve('net/socket.h', 'apps/server/main.c', 'c')).toBe('libs/net/include/net/socket.h');
  });

  it('treats an unusable database as absent (the probe applies again)', () => {
    write('compile_commands.json', '{ not json');
    const resolve = makeResolvePathToFile(root);
    expect(resolve('proj/widget.h', 'apps/server/main.c', 'c')).toBe('include/proj/widget.h');
  });

  it('treats a database whose files are all outside the repository as absent', () => {
    write('compile_commands.json', JSON.stringify([{ directory: '/elsewhere', file: 'x.c', arguments: ['cc', '-I.', 'x.c'] }]));
    const resolve = makeResolvePathToFile(root);
    expect(resolve('proj/widget.h', 'apps/server/main.c', 'c')).toBe('include/proj/widget.h');
  });
});

describe('parseCompileCommands', () => {
  const ROOT = path.resolve('/repo');
  const parse = (entries: unknown): ReturnType<typeof parseCompileCommands> =>
    parseCompileCommands(JSON.stringify(entries), ROOT, ROOT);

  it('is undefined for text that is not a database, or one naming no in-repo file', () => {
    expect(parseCompileCommands('{', ROOT, ROOT)).toBeUndefined();
    expect(parse({})).toBeUndefined();
    expect(
      parse([
        null,
        7,
        { directory: 1, file: 'a.c', arguments: ['cc'] },
        { directory: '/elsewhere', file: 'a.c', arguments: ['cc'] },
        { directory: '.', file: '.', arguments: ['cc'] },
        { directory: '.', file: 'a.c' },
      ]),
    ).toBeUndefined();
  });

  it('reads every include-flag spelling and ignores system roots', () => {
    const db = parse([
      {
        directory: '.',
        file: 'a.c',
        arguments: ['cc', 7, '-I', 'i1', '-Ii2', '-iquote', 'q1', '-iquoteq2', '-isystem', 's1', '-idirafter', 's2',
          '--include-directory', 'i3', '--include-directory=i4', '/Inot-msvc', '-I'],
      },
    ])!;
    expect(db.rootsFor('a.c')).toEqual({ quote: ['q1', 'q2'], angle: ['i1', 'i2', 'i3', 'i4'] });
  });

  it('reads /I for a cl driver and merges two entries for one file', () => {
    const db = parse([
      { directory: '.', file: 'a.c', arguments: ['C:\\VS\\cl.exe', '/I', 'w1', '/Iw2', '/I'] },
      { directory: '.', file: 'a.c', arguments: ['clang-cl', '/Iw2', '/Iw3', '-iquotew4'] },
    ])!;
    expect(db.rootsFor('a.c')).toEqual({ quote: ['w4'], angle: ['w1', 'w2', 'w3'] });
    // A file that is not a unit takes the union of every unit's roots.
    expect(db.rootsFor('lib/x.h')).toEqual({ quote: ['w4'], angle: ['w1', 'w2', 'w3'] });
  });

  it('splits a command line with quotes and escapes', () => {
    const db = parse([
      { directory: '.', file: 'a.c', command: `cc -I"dir one" -I'dir two' -Idir\\ three "-I\\"q\\"" -Ilast` },
    ])!;
    expect(db.rootsFor('a.c').angle).toEqual(['dir one', 'dir two', 'dir three', '"q"', 'last']);
  });
});
