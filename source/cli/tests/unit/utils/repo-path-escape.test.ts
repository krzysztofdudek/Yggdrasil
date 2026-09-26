import { describe, it, expect } from 'vitest';
import { escapesRepo } from '../../../src/utils/repo-path-escape.js';
import { toPosixPath } from '../../../src/utils/posix.js';

// The one containment check every parser asks before a root-relative path it
// read from an authored file is joined to that root (node mappings, aspect
// references and companions, marketplace package paths, packages-lock records).
describe('escapesRepo — the shared path-escape check', () => {
  it('accepts plain downward relative paths', () => {
    for (const p of ['src', 'src/a.ts', './src/a.ts', 'a/b/c/', 'a//b', '.', '']) {
      expect(escapesRepo(p), p).toBe(false);
    }
  });

  it('tolerates an in-root .. that never climbs above the start', () => {
    for (const p of ['a/../b', 'a/b/../../c', 'a/./../b', 'a/b/..']) {
      expect(escapesRepo(p), p).toBe(false);
    }
  });

  it('rejects a .. that climbs above the start, wherever it appears', () => {
    for (const p of ['..', '../', '../a', 'a/../../b', 'a/b/../../../c', './../a', 'a/../..']) {
      expect(escapesRepo(p), p).toBe(true);
    }
  });

  it('rejects absolute POSIX paths, including UNC-style double slashes', () => {
    for (const p of ['/', '/etc/passwd', '//server/share/x']) {
      expect(escapesRepo(p), p).toBe(true);
    }
  });

  it('rejects Windows drive letters in either case, with or without a separator', () => {
    for (const p of ['C:', 'C:/Windows', 'c:/windows', 'z:relative', 'D:\\x']) {
      expect(escapesRepo(p), p).toBe(true);
    }
  });

  it('rejects a home-relative ~ path', () => {
    for (const p of ['~', '~/secret', '~user/x']) {
      expect(escapesRepo(p), p).toBe(true);
    }
  });

  it('treats a backslash as an ordinary character: callers convert with toPosixPath first', () => {
    // Lexical and POSIX-only by contract: raw Windows separators are one segment,
    // so the escape is visible only after conversion. Every caller (node mappings,
    // aspect references and companions, package paths and lock records) converts
    // with toPosixPath before asking, so '..\\x' is refused as escaping on every OS.
    expect(escapesRepo('..\\secret')).toBe(false);
    expect(escapesRepo(toPosixPath('..\\secret'))).toBe(true);
    expect(escapesRepo(toPosixPath('a\\..\\..\\b'))).toBe(true);
    expect(escapesRepo(toPosixPath('\\etc\\passwd'))).toBe(true);
    expect(escapesRepo(toPosixPath('a\\..\\b'))).toBe(false);
  });

  it('is purely lexical: a name that merely contains dots is not traversal', () => {
    for (const p of ['...', '..a', 'a..', 'a/..b/c', '.hidden/x', 'a/.../b']) {
      expect(escapesRepo(p), p).toBe(false);
    }
  });
});
