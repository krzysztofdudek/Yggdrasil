import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCtxFs, UndeclaredFsReadError } from '../../../src/structure/ctx-fs.js';

describe('ctx.fs', () => {
  let root: string;
  let touched: string[];
  const allowedSet = new Set(['src/foo.ts', 'src/bar.ts', 'src/lib/baz.ts']);

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-ctx-fs-'));
    mkdirSync(path.join(root, 'src/lib'), { recursive: true });
    writeFileSync(path.join(root, 'src/foo.ts'), 'foo-content');
    writeFileSync(path.join(root, 'src/bar.ts'), 'bar-content');
    writeFileSync(path.join(root, 'src/lib/baz.ts'), 'baz-content');
    touched = [];
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('exists() returns "file" for allowed file', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(fs.exists('src/foo.ts')).toBe('file');
  });

  it('exists() returns "dir" for allowed dir (ancestor of allowed file)', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(fs.exists('src/lib')).toBe('dir');
  });

  it('exists() throws UndeclaredFsReadError for unmapped path', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(() => fs.exists('src/forbidden.ts')).toThrow(UndeclaredFsReadError);
  });

  it('exists() resolves a ./-prefixed allowed path (shared normalizer strips ./)', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(fs.exists('./src/foo.ts')).toBe('file');
    expect(touched).toContain('src/foo.ts');
  });

  it('exists() registers touched (negative dependency, even when missing)', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    fs.exists('src/foo.ts');
    expect(touched).toContain('src/foo.ts');
  });

  it('read() returns file content', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(fs.read('src/foo.ts')).toBe('foo-content');
  });

  it('read() throws for unmapped path', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(() => fs.read('src/forbidden.ts')).toThrow(UndeclaredFsReadError);
  });

  it('read() tracks touched', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    fs.read('src/foo.ts');
    expect(touched).toContain('src/foo.ts');
  });

  it('list() returns entries for allowed dir', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    const entries = fs.list('src/lib');
    expect(entries).toEqual(expect.arrayContaining([{ name: 'baz.ts', kind: 'file' }]));
  });

  it('list() throws for unmapped dir', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(() => fs.list('src/forbidden')).toThrow(UndeclaredFsReadError);
  });

  // Path-traversal escape: an allowed-DIRECTORY prefix followed by enough
  // `..` segments resolves outside the repository. The prefix passes the
  // allow-set's descendant check, but normalize() does not collapse `..` and
  // there is no post-resolve containment re-check — so the read escapes the
  // repo and returns arbitrary files (e.g. /etc/passwd) to untrusted
  // check.mjs. A bare directory mapping ('src/lib') is a realistic allow-set
  // entry; the traversal path starts with 'src/lib/' so isAllowed accepts it.
  const dirAllowedSet = new Set(['src/lib']);

  it('read() throws when traversal escapes the repo via an allowed directory prefix', () => {
    const fs = createCtxFs({ allowedSet: dirAllowedSet, projectRoot: root, touchedFiles: touched });
    expect(() => fs.read('src/lib/../../../../../../../../etc/passwd')).toThrow(UndeclaredFsReadError);
  });

  it('exists() throws when traversal escapes the repo via an allowed directory prefix', () => {
    const fs = createCtxFs({ allowedSet: dirAllowedSet, projectRoot: root, touchedFiles: touched });
    expect(() => fs.exists('src/lib/../../../../../../../../etc/passwd')).toThrow(UndeclaredFsReadError);
  });

  it('read() throws for an absolute path outside the repo', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(() => fs.read('/etc/passwd')).toThrow(UndeclaredFsReadError);
  });

  it('exists() throws for an absolute path outside the repo', () => {
    const fs = createCtxFs({ allowedSet, projectRoot: root, touchedFiles: touched });
    expect(() => fs.exists('/etc/passwd')).toThrow(UndeclaredFsReadError);
  });

  // Symlink escape: the textual path stays inside the repo and passes the
  // allow-set, but an allowed directory is a SYMLINK pointing outside the repo,
  // so the real read would follow the link out. The post-resolve realpath
  // containment check must reject it (the lexical checks above cannot).
  it('read() throws when an allowed path is a symlink pointing OUTSIDE the repo', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'yg-outside-'));
    writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
    // src/lib/escape -> <outside>; src/lib is in the allow-set.
    symlinkSync(outside, path.join(root, 'src/lib/escape'), 'dir');
    try {
      const fs = createCtxFs({ allowedSet: new Set(['src/lib']), projectRoot: root, touchedFiles: touched });
      expect(() => fs.read('src/lib/escape/secret.txt')).toThrow(UndeclaredFsReadError);
      expect(() => fs.exists('src/lib/escape/secret.txt')).toThrow(UndeclaredFsReadError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('read() still works for a symlink pointing to an allowed file INSIDE the repo', () => {
    // A within-repo symlink must not be over-rejected: src/lib/alias -> src/foo.ts.
    symlinkSync(path.join(root, 'src/foo.ts'), path.join(root, 'src/lib/alias.ts'), 'file');
    const fs = createCtxFs({ allowedSet: new Set(['src/lib']), projectRoot: root, touchedFiles: touched });
    expect(fs.read('src/lib/alias.ts')).toBe('foo-content');
  });

  // Glob allowed-set entries: when a node's mapping is a glob, the allowed-reads
  // set holds the glob pattern, so the fs-gate must admit the files it matches
  // (and reject those it does not) via the shared matcher.
  it('admits a file matching a glob allowed-set entry, rejects a non-matching sibling', () => {
    writeFileSync(path.join(root, 'src/lib/FooRepository.ts'), 'repo');
    writeFileSync(path.join(root, 'src/lib/Helper.ts'), 'helper');
    const fs = createCtxFs({ allowedSet: new Set(['src/lib/*Repository.ts']), projectRoot: root, touchedFiles: touched });
    expect(fs.read('src/lib/FooRepository.ts')).toBe('repo');
    expect(() => fs.read('src/lib/Helper.ts')).toThrow(UndeclaredFsReadError);
  });

  it('admits the literal-prefix dir of a glob entry for exists()/list()', () => {
    const fs = createCtxFs({ allowedSet: new Set(['src/lib/*Repository.ts']), projectRoot: root, touchedFiles: touched });
    // 'src/lib' is the glob's literal leading prefix — a directory the check may probe.
    expect(fs.exists('src/lib')).toBe('dir');
  });

  // A directory (or glob) allowed-reads entry can textually cover a path that
  // actually belongs to a SEPARATE project (a nested `.yggdrasil/` graph, or a
  // nested `.git` checkout/submodule/worktree) — nestedProjectRoots is the
  // caller-supplied boundary that must win over the textual allow-set match.
  describe('nestedProjectRoots — a separate project inside an otherwise-allowed directory', () => {
    it('read()/exists()/list() reject a path under a separate-project root even though the directory entry textually allows it', () => {
      mkdirSync(path.join(root, 'src/lib/vendor'), { recursive: true });
      writeFileSync(path.join(root, 'src/lib/vendor/secret.ts'), 'SECRET');
      const fs = createCtxFs({
        allowedSet: new Set(['src/lib']),
        projectRoot: root,
        touchedFiles: touched,
        nestedProjectRoots: new Set(['src/lib/vendor']),
      });
      expect(() => fs.read('src/lib/vendor/secret.ts')).toThrow(UndeclaredFsReadError);
      expect(() => fs.exists('src/lib/vendor/secret.ts')).toThrow(UndeclaredFsReadError);
      expect(() => fs.list('src/lib/vendor')).toThrow(UndeclaredFsReadError);
      // A sibling OUTSIDE the separate project, under the same allowed directory, is unaffected.
      expect(fs.read('src/lib/baz.ts')).toBe('baz-content');
    });

    it('a glob allowed-set entry matching a file inside a separate-project root is also rejected', () => {
      mkdirSync(path.join(root, 'src/lib/vendor'), { recursive: true });
      writeFileSync(path.join(root, 'src/lib/vendor/FooRepository.ts'), 'vendored');
      const fs = createCtxFs({
        allowedSet: new Set(['src/lib/**/*Repository.ts']),
        projectRoot: root,
        touchedFiles: touched,
        nestedProjectRoots: new Set(['src/lib/vendor']),
      });
      expect(() => fs.read('src/lib/vendor/FooRepository.ts')).toThrow(UndeclaredFsReadError);
    });

    it('omitting nestedProjectRoots (default) admits a path a caller with nothing to say about nested projects never excluded', () => {
      mkdirSync(path.join(root, 'src/lib/vendor'), { recursive: true });
      writeFileSync(path.join(root, 'src/lib/vendor/inner.ts'), 'inner');
      const fs = createCtxFs({ allowedSet: new Set(['src/lib']), projectRoot: root, touchedFiles: touched });
      expect(fs.read('src/lib/vendor/inner.ts')).toBe('inner');
    });
  });
});
