/**
 * Unit tests for io/hash.ts — the file/directory/glob hashing + mapping
 * expansion primitives used by the fingerprint and pair-hash machinery.
 *
 * HERMETIC: each case writes a fresh mkdtemp tree and rm's it after. No network,
 * no clock/random assertions. These pin the branch behavior of directory vs file
 * vs glob handling, gitignore filtering, and the unsupported-path-type throw.
 */

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  hashFile,
  hashString,
  hashBytes,
  hashPath,
  perFileHashes,
  expandMappingPaths,
  expandMappingPathsWithinOwnGraph,
  normalizeLineEndings,
} from '../../../src/io/hash.js';
import { runGitFixture } from '../../support/git-fixture.js';
import { readFileBytes, listDirEntries, statKind, probeUnreadable } from '../../../src/io/graph-fs.js';
import type { CoverageConfig } from '../../../src/model/graph.js';

/** No adopter-configured coverage.excluded roots — isolates these cases to the filesystem-derived nested-project boundary alone. */
const NO_EXCLUDED: CoverageConfig = { required: [], excluded: [], typeLevel: false };

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmpTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-hash-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

describe('hash primitives', () => {
  it('hashString / hashBytes / hashFile agree for identical content', async () => {
    const root = await tmpTree({ 'a.txt': 'hello' });
    const fromString = hashString('hello');
    const fromBytes = hashBytes(Buffer.from('hello', 'utf8'));
    const fromFile = await hashFile(path.join(root, 'a.txt'));
    expect(fromBytes).toBe(fromString);
    expect(fromFile).toBe(fromString);
    // Different content → different hash.
    expect(hashString('hello!')).not.toBe(fromString);
  });
});

describe('line-ending-insensitive content hashing', () => {
  it('hashBytes ignores CRLF vs LF vs lone CR', () => {
    const lf = hashBytes(Buffer.from('a\nb\nc\n', 'utf8'));
    const crlf = hashBytes(Buffer.from('a\r\nb\r\nc\r\n', 'utf8'));
    const cr = hashBytes(Buffer.from('a\rb\rc\r', 'utf8'));
    const mixed = hashBytes(Buffer.from('a\r\nb\rc\n', 'utf8'));
    expect(crlf).toBe(lf);
    expect(cr).toBe(lf);
    expect(mixed).toBe(lf);
  });

  it('hashFile gives the same digest for a CRLF file and its LF twin', async () => {
    const root = await tmpTree({});
    const crlfPath = path.join(root, 'crlf.ts');
    const lfPath = path.join(root, 'lf.ts');
    await writeFile(crlfPath, 'export const x = 1;\r\nexport const y = 2;\r\n');
    await writeFile(lfPath, 'export const x = 1;\nexport const y = 2;\n');
    expect(await hashFile(crlfPath)).toBe(await hashFile(lfPath));
  });

  it('does NOT collapse content that differs beyond line endings', () => {
    // Same line-ending style, genuinely different text → different hash.
    expect(hashBytes(Buffer.from('a\nb\n', 'utf8')))
      .not.toBe(hashBytes(Buffer.from('a\nB\n', 'utf8')));
    // A literal backslash-r-backslash-n (two chars: '\\' 'r') is NOT a line ending
    // and must stay distinct from a real CRLF.
    expect(hashBytes(Buffer.from('a\\nb', 'utf8')))
      .not.toBe(hashBytes(Buffer.from('a\nb', 'utf8')));
  });

  it('normalizeLineEndings is a byte-identical no-op on all-LF (and CR-free) input', () => {
    const lf = Buffer.from('already\nlf\nonly\n', 'utf8');
    expect(normalizeLineEndings(lf).equals(lf)).toBe(true);
    const noNewlines = Buffer.from('no newlines here', 'utf8');
    expect(normalizeLineEndings(noNewlines).equals(noNewlines)).toBe(true);
  });

  it('normalizeLineEndings rewrites CRLF and lone CR to LF', () => {
    expect(normalizeLineEndings(Buffer.from('a\r\nb\rc', 'utf8')))
      .toEqual(Buffer.from('a\nb\nc', 'utf8'));
  });
});

describe('hashPath', () => {
  it('hashes a single FILE (gitignore does not apply to a directly-named file)', async () => {
    const root = await tmpTree({ 'src/x.ts': 'export const x = 1;\n', '.gitignore': 'src/x.ts\n' });
    const h = await hashPath(path.join(root, 'src', 'x.ts'), { projectRoot: root });
    expect(h).toBe(await hashFile(path.join(root, 'src', 'x.ts')));
  });

  it('hashes a DIRECTORY as a stable fold over its files', async () => {
    const root = await tmpTree({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    const h1 = await hashPath(path.join(root, 'src'), { projectRoot: root });
    // Re-hashing the same tree yields the same digest (order-independent fold).
    const h2 = await hashPath(path.join(root, 'src'), { projectRoot: root });
    expect(h1).toBe(h2);
    // Changing a file changes the directory hash.
    await writeFile(path.join(root, 'src', 'a.ts'), 'a-changed\n');
    expect(await hashPath(path.join(root, 'src'), { projectRoot: root })).not.toBe(h1);
  });

  it('directory hashing honors a root .gitignore (ignored files do not contribute)', async () => {
    const root = await tmpTree({ 'src/keep.ts': 'k\n', 'src/skip.log': 'noise\n', '.gitignore': '*.log\n' });
    const withLog = await hashPath(path.join(root, 'src'), { projectRoot: root });
    // Mutating the ignored file must NOT change the directory hash.
    await writeFile(path.join(root, 'src', 'skip.log'), 'different noise\n');
    expect(await hashPath(path.join(root, 'src'), { projectRoot: root })).toBe(withLog);
  });

  it('hashPath with no projectRoot still hashes a directory (no gitignore stack)', async () => {
    // Known-value: the directory contains exactly one file 'one.ts' with content '1\n'.
    // hashPath folds per-file hashes as "<relPath>:<sha256>" sorted then sha256 of that.
    // relPath is relative to the directory root, so "one.ts".
    const content = '1\n';
    const root = await tmpTree({ 'd/one.ts': content });
    const fileHash = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
    const foldInput = `one.ts:${fileHash}`;
    const expectedHash = createHash('sha256').update(foldInput).digest('hex');
    const h = await hashPath(path.join(root, 'd'));
    expect(h).toBe(expectedHash);
  });

  it('rejects with a system error (ENOENT) when the target path does not exist', async () => {
    const root = await tmpTree({});
    const missing = path.join(root, 'does-not-exist');
    await expect(hashPath(missing)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects with "Unsupported mapping path type" when stat() succeeds but the entry is neither a file nor a directory', async () => {
    // A FIFO is a real, portable (CI is Linux-only) way to reach the guard: stat()
    // succeeds (it exists), but isFile() and isDirectory() are both false.
    const root = await tmpTree({});
    const fifoPath = path.join(root, 'a.fifo');
    execFileSync('mkfifo', [fifoPath]);
    await expect(hashPath(fifoPath)).rejects.toThrow(/Unsupported mapping path type/);
  });
});

describe('perFileHashes', () => {
  it('returns [] for an empty mapping', async () => {
    const root = await tmpTree({ 'a.ts': 'a\n' });
    expect(await perFileHashes(root, { paths: [] })).toEqual([]);
    expect(await perFileHashes(root, {})).toEqual([]);
  });

  it('hashes a FILE mapping entry', async () => {
    const root = await tmpTree({ 'src/a.ts': 'a\n' });
    const out = await perFileHashes(root, { paths: ['src/a.ts'] });
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('src/a.ts');
    expect(out[0].hash).toBe(await hashFile(path.join(root, 'src', 'a.ts')));
  });

  it('expands a DIRECTORY mapping entry to per-file hashes (POSIX paths)', async () => {
    const root = await tmpTree({ 'src/a.ts': 'a\n', 'src/sub/b.ts': 'b\n' });
    const out = await perFileHashes(root, { paths: ['src'] });
    const paths = out.map((o) => o.path).sort();
    expect(paths).toEqual(['src/a.ts', 'src/sub/b.ts']);
  });

  it('silently skips a mapping entry that is neither a file nor a directory (e.g. a FIFO)', async () => {
    const root = await tmpTree({ 'src/a.ts': 'a\n' });
    execFileSync('mkfifo', [path.join(root, 'a.fifo')]);
    const out = await perFileHashes(root, { paths: ['src/a.ts', 'a.fifo'] });
    expect(out.map((o) => o.path)).toEqual(['src/a.ts']);
  });
});

describe('expandMappingPaths', () => {
  it('returns a file path as-is and recurses a directory', async () => {
    const root = await tmpTree({ 'src/a.ts': 'a\n', 'src/sub/b.ts': 'b\n', 'top.ts': 't\n' });
    const out = await expandMappingPaths(root, ['top.ts', 'src']);
    expect(out.sort()).toEqual(['src/a.ts', 'src/sub/b.ts', 'top.ts']);
  });

  it('silently skips a missing mapping path', async () => {
    const root = await tmpTree({ 'a.ts': 'a\n' });
    const out = await expandMappingPaths(root, ['a.ts', 'ghost.ts', 'ghost-dir']);
    expect(out).toEqual(['a.ts']);
  });

  it('expands a glob entry against the base directory, honoring gitignore', async () => {
    const root = await tmpTree({
      'src/a.ts': 'a\n',
      'src/b.ts': 'b\n',
      'src/c.test.ts': 'c\n',
      'src/skip.log': 'noise\n',
      '.gitignore': '*.log\n',
    });
    const out = await expandMappingPaths(root, ['src/*.ts']);
    // Globs match the .ts files (incl. c.test.ts) but the gitignored .log is gone.
    expect(out.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.test.ts']);
  });

  it('a glob whose base directory is missing yields no matches', async () => {
    const root = await tmpTree({ 'a.ts': 'a\n' });
    const out = await expandMappingPaths(root, ['no-such-dir/**/*.ts']);
    expect(out).toEqual([]);
  });
});

describe('expandMappingPaths containment (security: no out-of-repo path)', () => {
  it('never returns a path that resolves outside the repo root', async () => {
    // Build an outer dir with the project root nested inside and a secret file as
    // a SIBLING of the root, so `../` from the root reaches it. An escaping
    // mapping must never surface an out-of-repo path (which would flow into a
    // reviewer prompt); the node-parser rejects these at parse time, and this is
    // the belt-and-suspenders guard in the expansion layer.
    const outer = await mkdtemp(path.join(tmpdir(), 'yg-hash-outer-'));
    dirs.push(outer);
    const root = path.join(outer, 'proj');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'in.ts'), 'in\n');
    await writeFile(path.join(outer, 'outside.ts'), 'secret\n');

    // An escaping file entry, an escaping directory entry, and an escaping glob
    // are all present alongside one legitimate in-repo entry.
    const out = await expandMappingPaths(root, [
      'src/in.ts',
      '../outside.ts',
      '../',
      '../*.ts',
    ]);

    // Only the in-repo file survives.
    expect(out).toEqual(['src/in.ts']);
    // Belt-and-suspenders: no returned path resolves outside the root.
    for (const p of out) {
      const rel = path.relative(root, path.resolve(root, p));
      expect(rel.startsWith('..')).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
    }
  });

  it('preserves an in-repo `a/../b` mapping (resolves back inside the root)', async () => {
    const root = await tmpTree({ 'b/x.ts': 'x\n' });
    // `a/../b` resolves to root/b — inside the repo — so it must be kept, matching
    // the node-parser's escapesRepo tolerance (depth never goes negative).
    const out = await expandMappingPaths(root, ['a/../b']);
    expect(out).toEqual(['b/x.ts']);
  });
});

describe('directory-only gitignore pattern vs a like-named FILE (C-27 twin)', () => {
  it('keeps a tracked FILE whose name matches a directory-only pattern (build/)', async () => {
    const root = await tmpTree({
      'src/keep.ts': 'k\n',
      // A FILE literally named `build` — git does NOT ignore it under a `build/`
      // (directory-only) rule, so it must stay in the node's subject set.
      'src/scripts/build': '#!/bin/sh\necho hi\n',
      '.gitignore': 'build/\n',
    });
    const out = await expandMappingPaths(root, ['src']);
    // Before the fix the "both forms" query dropped src/scripts/build (a false
    // green — a mapped file the reviewer would never see).
    expect(out.sort()).toEqual(['src/keep.ts', 'src/scripts/build']);
  });

  it('still prunes a real DIRECTORY matching a directory-only pattern (build/)', async () => {
    const root = await tmpTree({
      'src/keep.ts': 'k\n',
      // A DIRECTORY named `build` — git ignores it under `build/`, so the fix must
      // still prune it (the trailing-slash query runs for directories).
      'src/build/artifact.js': 'compiled\n',
      '.gitignore': 'build/\n',
    });
    const out = await expandMappingPaths(root, ['src']);
    expect(out).toEqual(['src/keep.ts']);
  });
});

// =============================================================================
// A directory OR glob mapping never hashes/reviews `.git` as source.
//
// `collectDirectoryFilePaths` (the shared walker behind both a directory
// mapping and a glob mapping's base-directory walk) used to have no `.git`
// skip at all, unlike the coverage walk (`walkRepoFiles`) which has always
// skipped it. A mapping that covers the project root — or any directory that
// happens to carry its own `.git` — would hash and expose git's own internal
// object store as though it were mapped source.
// =============================================================================
describe('a directory/glob mapping never expands into `.git`', () => {
  it('a directory mapping over the project root skips `.git` entirely', async () => {
    const root = await tmpTree({ 'src/a.ts': 'a\n' });
    expect(runGitFixture(root, ['init', '-q', '-b', 'main']).status).toBe(0);
    const out = await expandMappingPaths(root, ['.']);
    expect(out.sort()).toEqual(['src/a.ts']);
    expect(out.some((f) => f.startsWith('.git/') || f === '.git')).toBe(false);
  });

  it('a glob mapping over the project root skips `.git` entirely', async () => {
    const root = await tmpTree({ 'src/a.ts': 'a\n', 'src/b.py': 'b\n' });
    expect(runGitFixture(root, ['init', '-q', '-b', 'main']).status).toBe(0);
    const out = await expandMappingPaths(root, ['**/*.ts']);
    expect(out).toEqual(['src/a.ts']);
  });
});

// =============================================================================
// expandMappingPathsWithinOwnGraph — the enforcement-side boundary is derived
// from the FILESYSTEM (io/repo-scanner.ts's findNestedProjectRoots), not from
// whatever candidates a given mapping's own expansion happens to produce. A
// glob's extension filter, or a `.gitignore` line hiding just the marker, must
// not blind the guard — and the guard must fire identically for a `.yggdrasil`
// graph AND for a git boundary (a nested checkout, a real submodule, a real
// linked worktree).
// =============================================================================
describe('expandMappingPathsWithinOwnGraph — the boundary is read off the filesystem', () => {
  const IDENTITY = {
    GIT_AUTHOR_NAME: 'yg-test',
    GIT_AUTHOR_EMAIL: 'yg-test@fixture.test',
    GIT_COMMITTER_NAME: 'yg-test',
    GIT_COMMITTER_EMAIL: 'yg-test@fixture.test',
  };

  it('a GLOB mapping stops at a nested `.yggdrasil/` graph even though the glob itself never surfaces the marker path', async () => {
    // services/**/*.py never yields a `.yggdrasil/yg-config.yaml` path — the
    // extension filter strips it before a candidate-list-derived guard could
    // ever see it. The filesystem-derived guard must still catch it.
    const root = await tmpTree({
      'services/alpha.py': 'def alpha(): return 1\n',
      'services/vendorlib/.yggdrasil/yg-config.yaml': 'version: "5.2.0"\n',
      'services/vendorlib/other.py': 'SECRET = 1\n',
    });
    const out = await expandMappingPathsWithinOwnGraph(root, ['services/**/*.py'], NO_EXCLUDED);
    expect(out).toEqual(['services/alpha.py']);
  });

  it('a `.gitignore` line hiding only the nested `.yggdrasil/` marker does not blind the guard', async () => {
    const root = await tmpTree({
      'services/alpha.py': 'def alpha(): return 1\n',
      'services/vendorlib/.yggdrasil/yg-config.yaml': 'version: "5.2.0"\n',
      'services/vendorlib/other.py': 'SECRET = 1\n',
      '.gitignore': 'services/vendorlib/.yggdrasil/\n',
    });
    const out = await expandMappingPathsWithinOwnGraph(root, ['services'], NO_EXCLUDED);
    expect(out).toEqual(['services/alpha.py']);
  });

  it('a directory mapping stops at a nested, fully independent git repository (`.git` is a directory)', async () => {
    const root = await tmpTree({ 'services/alpha.py': 'def alpha(): return 1\n' });
    const nestedRepo = path.join(root, 'services', 'sub');
    await mkdir(nestedRepo, { recursive: true });
    await writeFile(path.join(nestedRepo, 'lib.py'), 'def lib(): return 1\n');
    expect(runGitFixture(nestedRepo, ['init', '-q', '-b', 'main']).status).toBe(0);

    const out = await expandMappingPathsWithinOwnGraph(root, ['services'], NO_EXCLUDED);
    expect(out).toEqual(['services/alpha.py']);
  });

  it('a directory mapping stops at a REAL git submodule (`.git` is a gitdir pointer FILE)', async () => {
    const outer = await tmpTree({ 'services/alpha.py': 'def alpha(): return 1\n' });
    const inner = await tmpTree({ 'lib.py': 'def lib(): return 1\n' });
    expect(runGitFixture(inner, ['init', '-q', '-b', 'main']).status).toBe(0);
    expect(runGitFixture(inner, ['add', '-A'], { extraEnv: IDENTITY }).status).toBe(0);
    expect(runGitFixture(inner, ['commit', '-q', '-m', 'init'], { extraEnv: IDENTITY }).status).toBe(0);

    expect(runGitFixture(outer, ['init', '-q', '-b', 'main']).status).toBe(0);
    const add = runGitFixture(
      outer,
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', inner, 'services/vendorlib'],
      { extraEnv: IDENTITY },
    );
    expect(add.status).toBe(0);

    const out = await expandMappingPathsWithinOwnGraph(outer, ['services'], NO_EXCLUDED);
    expect(out).toEqual(['services/alpha.py']);
  });

  it('a directory mapping stops at a REAL linked git worktree (`.git` is a gitdir pointer FILE)', async () => {
    const outer = await tmpTree({ 'services/alpha.py': 'def alpha(): return 1\n' });
    expect(runGitFixture(outer, ['init', '-q', '-b', 'main']).status).toBe(0);
    expect(runGitFixture(outer, ['add', '-A'], { extraEnv: IDENTITY }).status).toBe(0);
    expect(runGitFixture(outer, ['commit', '-q', '-m', 'init'], { extraEnv: IDENTITY }).status).toBe(0);

    const wt = runGitFixture(
      outer,
      ['worktree', 'add', '-q', path.join('services', 'wt1'), '-b', 'wt-branch'],
      { extraEnv: IDENTITY },
    );
    expect(wt.status).toBe(0);

    const out = await expandMappingPathsWithinOwnGraph(outer, ['services'], NO_EXCLUDED);
    expect(out).toEqual(['services/alpha.py']);
  });

  it('an ORDINARY subdirectory (no `.yggdrasil/`, no `.git`) is still absorbed normally', async () => {
    const root = await tmpTree({
      'services/alpha.py': 'def alpha(): return 1\n',
      'services/sub/control.py': 'def control(): return 1\n',
    });
    const out = await expandMappingPathsWithinOwnGraph(root, ['services'], NO_EXCLUDED);
    expect(out.sort()).toEqual(['services/alpha.py', 'services/sub/control.py']);
  });

  it('does NOT exclude a dependency directory by name alone (node_modules is ordinary, not a boundary)', async () => {
    // No name-based guessing. A `node_modules`/`vendor`/etc. directory
    // with no `.yggdrasil/` or `.git` of its own is absorbed exactly like any
    // other subdirectory — it stays visible in the coverage/pair count rather
    // than silently vanishing, which is the adopter's own business to exclude
    // via config if they want it gone.
    const root = await tmpTree({
      'services/alpha.py': 'def alpha(): return 1\n',
      'services/node_modules/pkg/index.py': 'x = 1\n',
    });
    const out = await expandMappingPathsWithinOwnGraph(root, ['services'], NO_EXCLUDED);
    expect(out.sort()).toEqual(['services/alpha.py', 'services/node_modules/pkg/index.py']);
  });

  it('two nodes expanded separately (enforcement) and together (audit-style) draw the SAME boundary', async () => {
    // The audit universe (portal/api/suppress-eligibility.ts) expands every
    // node's mapping entries TOGETHER; enforcement expands one node's mapping
    // at a time. Both must agree — the boundary is a property of the
    // filesystem, never of which candidates a particular call happened to expand.
    const root = await tmpTree({
      'services/alpha.py': 'def alpha(): return 1\n',
      'services/vendorlib/.yggdrasil/yg-config.yaml': 'version: "5.2.0"\n',
      'services/vendorlib/other.py': 'SECRET = 1\n',
      'services/config.yaml': 'k: v\n',
    });
    const pyOnly = await expandMappingPathsWithinOwnGraph(root, ['services/**/*.py'], NO_EXCLUDED);
    const yamlOnly = await expandMappingPathsWithinOwnGraph(root, ['services/**/*.yaml'], NO_EXCLUDED);
    const combined = await expandMappingPathsWithinOwnGraph(root, ['services/**/*.py', 'services/**/*.yaml'], NO_EXCLUDED);

    expect(pyOnly).toEqual(['services/alpha.py']);
    expect(yamlOnly).toEqual(['services/config.yaml']);
    expect(combined.sort()).toEqual([...pyOnly, ...yamlOnly].sort());
    // Neither the individually-expanded nor the combined view ever reveals the
    // vendored files — same boundary, regardless of composition.
    for (const list of [pyOnly, yamlOnly, combined]) {
      expect(list.some((f) => f.startsWith('services/vendorlib/'))).toBe(false);
    }
  });
});

// =============================================================================
// io/graph-fs.ts — the low-level file read / directory listing / stat-kind
// helpers shared across the read-only ctx surfaces. Colocated here as sibling
// I/O primitives alongside the content-hashing helpers this file already covers.
// =============================================================================

describe('readFileBytes', () => {
  const gfsDirs: string[] = [];
  afterEach(() => {
    for (const d of gfsDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('returns the real bytes of an existing file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-graph-fs-'));
    gfsDirs.push(dir);
    const p = path.join(dir, 'a.txt');
    writeFileSync(p, 'hello');
    const bytes = await readFileBytes(p);
    expect(bytes).not.toBeNull();
    expect(bytes!.toString('utf-8')).toBe('hello');
  });

  it('returns null when the file does not exist', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-graph-fs-'));
    gfsDirs.push(dir);
    expect(await readFileBytes(path.join(dir, 'nope.txt'))).toBeNull();
  });
});

describe('listDirEntries', () => {
  const gfsDirs: string[] = [];
  afterEach(() => {
    for (const d of gfsDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('lists files and subdirectories, classified correctly', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-graph-fs-'));
    gfsDirs.push(dir);
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    mkdirSync(path.join(dir, 'sub'));
    const entries = await listDirEntries(dir);
    expect(entries).not.toBeNull();
    const byName = new Map(entries!.map((e) => [e.name, e.kind]));
    expect(byName.get('a.txt')).toBe('file');
    expect(byName.get('sub')).toBe('dir');
  });

  it('returns null when the directory does not exist', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-graph-fs-'));
    gfsDirs.push(dir);
    expect(await listDirEntries(path.join(dir, 'nope'))).toBeNull();
  });
});

describe('statKind', () => {
  const gfsDirs: string[] = [];
  afterEach(() => {
    for (const d of gfsDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('returns "file" for a regular file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-graph-fs-'));
    gfsDirs.push(dir);
    const p = path.join(dir, 'a.txt');
    writeFileSync(p, 'x');
    expect(await statKind(p)).toBe('file');
  });

  it('returns "dir" for a directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-graph-fs-'));
    gfsDirs.push(dir);
    expect(await statKind(dir)).toBe('dir');
  });

  it('returns false when the path does not exist', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-graph-fs-'));
    gfsDirs.push(dir);
    expect(await statKind(path.join(dir, 'nope'))).toBe(false);
  });

  it('returns false for a non-regular, non-directory entry (a FIFO)', async () => {
    // Mirrors ctx.fs.exists' three-token mapping: a socket/fifo/device is
    // NEITHER 'file' nor 'dir' — folds to false so the exists: observation
    // stays byte-symmetric between record and re-observe.
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-graph-fs-'));
    gfsDirs.push(dir);
    const fifoPath = path.join(dir, 'a.fifo');
    execFileSync('mkfifo', [fifoPath]);
    expect(await statKind(fifoPath)).toBe(false);
  });
});

describe('probeUnreadable', () => {
  const gfsDirs: string[] = [];
  afterEach(() => {
    for (const d of gfsDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('returns null (readable) for an existing, readable file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-graph-fs-'));
    gfsDirs.push(dir);
    const p = path.join(dir, 'a.txt');
    writeFileSync(p, 'x');
    expect(await probeUnreadable(p)).toBeNull();
  });

  it('returns the OS error message for a vanished path', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-graph-fs-'));
    gfsDirs.push(dir);
    const msg = await probeUnreadable(path.join(dir, 'nope.txt'));
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/ENOENT|no such file/i);
  });
});
