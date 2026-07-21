import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileOrDefault } from '../../../src/io/read-or-default.js';
import { readLogSafe, statLogFile, writeLogFile } from '../../../src/io/log-store.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'yg-test-')); });
afterAll(async () => { await rm(dir, { recursive: true }); });

describe('readFileOrDefault', () => {
  it('returns file content when file exists', async () => {
    const file = join(dir, 'exists.txt');
    await writeFile(file, 'hello', 'utf-8');
    const result = await readFileOrDefault(file, 'fallback');
    expect(result).toBe('hello');
  });

  it('returns default when file is missing (no debugContext)', async () => {
    const result = await readFileOrDefault(join(dir, '__missing__.txt'), 'default-value');
    expect(result).toBe('default-value');
  });

  it('returns default when file is missing (with debugContext)', async () => {
    const result = await readFileOrDefault(join(dir, '__missing__.txt'), 'default-value', 'test-context');
    expect(result).toBe('default-value');
  });

  it('rethrows non-ENOENT errors (EISDIR)', async () => {
    await expect(readFileOrDefault(dir, 'fallback')).rejects.toThrow();
  });
});

// =============================================================================
// io/log-store.ts — readLogSafe, statLogFile, writeLogFile. Colocated here as
// sibling "read a file, degrade a missing one to a default" I/O primitives
// alongside readFileOrDefault, which this file already covers.
// =============================================================================

describe('readLogSafe', () => {
  it('returns the file content when it exists', async () => {
    const d = mkdtempSync(join(tmpdir(), 'yg-log-store-'));
    try {
      const p = join(d, 'log.md');
      writeFileSync(p, '## entry\nsome text\n');
      expect(await readLogSafe(p)).toBe('## entry\nsome text\n');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('returns "" when the file is missing', async () => {
    const d = mkdtempSync(join(tmpdir(), 'yg-log-store-'));
    try {
      expect(await readLogSafe(join(d, 'nope.md'))).toBe('');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('statLogFile', () => {
  it('returns isSymbolicLink: false and a hardLinkCount for a plain file', async () => {
    const d = mkdtempSync(join(tmpdir(), 'yg-log-store-'));
    try {
      const p = join(d, 'log.md');
      writeFileSync(p, 'x');
      const stats = await statLogFile(p);
      expect(stats).not.toBeNull();
      expect(stats!.isSymbolicLink).toBe(false);
      expect(stats!.hardLinkCount).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('returns null when the file does not exist (ENOENT)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'yg-log-store-'));
    try {
      expect(await statLogFile(join(d, 'nope.md'))).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('rethrows a non-ENOENT lstat failure (e.g. a path component that is a file, not a directory)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'yg-log-store-'));
    try {
      // 'notADir' is a regular FILE — lstat('notADir/log.md') fails with ENOTDIR,
      // a genuinely different error class than "missing", which must propagate
      // rather than being silently swallowed like the ENOENT case.
      const notADir = join(d, 'notADir');
      writeFileSync(notADir, 'x');
      await expect(statLogFile(join(notADir, 'log.md'))).rejects.toMatchObject({ code: 'ENOTDIR' });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('writeLogFile', () => {
  it('writes content to disk atomically', async () => {
    const d = mkdtempSync(join(tmpdir(), 'yg-log-store-'));
    try {
      const p = join(d, 'sub', 'log.md');
      await writeLogFile(p, '## new entry\n');
      expect(readFileSync(p, 'utf-8')).toBe('## new entry\n');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
