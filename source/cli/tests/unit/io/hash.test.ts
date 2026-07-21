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
  expandMappingPathsExcluding,
  normalizeLineEndings,
} from '../../../src/io/hash.js';
import { readFileBytes, listDirEntries, statKind, probeUnreadable } from '../../../src/io/graph-fs.js';

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

describe('expandMappingPathsExcluding', () => {
  it('returns all files when no exclusions are given', async () => {
    const root = await tmpTree({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    const out = await expandMappingPathsExcluding(root, ['src'], []);
    expect(out.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('excludes files matched by a child-mapping prefix (child carve-out)', async () => {
    const root = await tmpTree({ 'src/a.ts': 'a\n', 'src/child/c.ts': 'c\n' });
    const out = await expandMappingPathsExcluding(root, ['src'], ['src/child']);
    expect(out).toEqual(['src/a.ts']);
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
