/**
 * A rename that fails for a moment (Windows EPERM/EBUSY while a scanner or an
 * editor holds the target, a directory briefly read-only) is retried instead of
 * losing the write.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';

const failures = { left: 0, code: 'EBUSY' };
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...orig,
    rename: vi.fn(async (from: string, to: string) => {
      if (failures.left > 0) {
        failures.left -= 1;
        const e = new Error(`${failures.code}: resource busy or locked, rename`) as NodeJS.ErrnoException;
        e.code = failures.code;
        throw e;
      }
      return orig.rename(from, to);
    }),
  };
});

const { atomicWriteFile } = await import('../../../src/io/atomic-write.js');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); failures.left = 0; });

describe('atomicWriteFile transient-failure retry', () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    it(`retries a rename that fails with ${code} and then lands the write`, async () => {
      const d = mkdtempSync(path.join(tmpdir(), 'yg-aw-retry-'));
      dirs.push(d);
      failures.left = 2;
      failures.code = code;
      const target = path.join(d, 'lock.json');
      await atomicWriteFile(target, 'content\n');
      expect(readFileSync(target, 'utf-8')).toBe('content\n');
      // No temp left behind by the failed attempts.
      expect(readdirSync(d)).toEqual(['lock.json']);
    });
  }

  it('does not retry a failure that is not transient', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'yg-aw-retry-'));
    dirs.push(d);
    failures.left = 1;
    failures.code = 'ENOSPC';
    await expect(atomicWriteFile(path.join(d, 'x.json'), 'a')).rejects.toThrow(/ENOSPC/);
  });
});
