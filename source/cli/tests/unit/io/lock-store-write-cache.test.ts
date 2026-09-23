/**
 * writeLock's partition narrowing and its memory of what it last wrote: a
 * write limited to one partition leaves the others alone, and a file changed
 * behind the writer's back is still rewritten (the memory never hides it).
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { writeLock, writeLockSync, detLockPath, nondetLockPath, readLock } from '../../../src/io/lock-store.js';
import type { LockFile } from '../../../src/model/lock.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function ygg(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'yg-lockcache-'));
  dirs.push(d);
  const root = path.join(d, '.yggdrasil');
  mkdirSync(root, { recursive: true });
  return root;
}
const DET = new Set(['det-a']);
function lockWith(detUnits: string[], llmUnits: string[]): LockFile {
  const v: LockFile['verdicts'] = {};
  if (detUnits.length) v['det-a'] = Object.fromEntries(detUnits.map((u) => [u, { verdict: 'approved', hash: 'd' }]));
  if (llmUnits.length) v['llm-a'] = Object.fromEntries(llmUnits.map((u) => [u, { verdict: 'approved', hash: 'l' }]));
  return { version: 1, verdicts: v, nodes: {} } as unknown as LockFile;
}

describe('writeLock partitions', () => {
  it('a write narrowed to the committed partition leaves the deterministic file untouched', async () => {
    const root = ygg();
    await writeLock(root, lockWith(['node:a'], ['node:x']), { scope: 'all', deterministicAspectIds: DET });
    const detBefore = readFileSync(detLockPath(root), 'utf-8');
    await writeLock(root, lockWith(['node:a', 'node:b'], ['node:x', 'node:y']), {
      scope: 'all', deterministicAspectIds: DET, partitions: { nondet: true },
    });
    expect(readFileSync(detLockPath(root), 'utf-8')).toBe(detBefore);
    expect(readFileSync(nondetLockPath(root), 'utf-8')).toContain('node:y');
  });
});

describe('writeLock memory of the last write', () => {
  it('rewrites a file that was changed behind its back, even to the same content it last wrote', async () => {
    const root = ygg();
    const lock = lockWith(['node:a'], []);
    await writeLock(root, lock, { scope: 'deterministic', deterministicAspectIds: DET });
    const written = readFileSync(detLockPath(root), 'utf-8');
    writeFileSync(detLockPath(root), written.replace('node:a', 'node:z'));
    await writeLock(root, lock, { scope: 'deterministic', deterministicAspectIds: DET });
    expect(readFileSync(detLockPath(root), 'utf-8')).toBe(written);
  });

  it('the synchronous last-resort write produces the same bytes as the normal one', async () => {
    const a = ygg();
    const b = ygg();
    const lock = lockWith(['node:a', 'node:b'], ['node:x']);
    await writeLock(a, lock, { scope: 'all', deterministicAspectIds: DET });
    writeLockSync(b, lock, { scope: 'all', deterministicAspectIds: DET });
    expect(readFileSync(detLockPath(b), 'utf-8')).toBe(readFileSync(detLockPath(a), 'utf-8'));
    expect(readFileSync(nondetLockPath(b), 'utf-8')).toBe(readFileSync(nondetLockPath(a), 'utf-8'));
    expect(Object.keys(readLock(b).verdicts['det-a'])).toEqual(['node:a', 'node:b']);
  });
});
