/**
 * The inter-process exclusive lock file: exactly one holder, a holder that is
 * gone is replaced, and a release never removes a successor's lock.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tryAcquireExclusiveFile, readExclusiveFileHolder } from '../../../src/io/atomic-write.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function lockPath(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'yg-excl-'));
  dirs.push(d);
  return path.join(d, '.yg-test.lock');
}
/** A pid that certainly belonged to a process that has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}
const HOUR = 3_600_000;

describe('tryAcquireExclusiveFile', () => {
  it('lets exactly one caller hold the lock and names the holder to the others', () => {
    const p = lockPath();
    const first = tryAcquireExclusiveFile(p, 'first', Date.now(), HOUR);
    expect(first.ok).toBe(true);
    const second = tryAcquireExclusiveFile(p, 'second', Date.now(), HOUR);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.holder?.pid).toBe(process.pid);
      expect(second.holder?.host).toBe(hostname());
      expect(second.holder?.command).toBe('first');
    }
    if (first.ok) first.release();
    expect(existsSync(p)).toBe(false);
    expect(tryAcquireExclusiveFile(p, 'third', Date.now(), HOUR).ok).toBe(true);
  });

  it('replaces a lock whose holder process on this machine is gone', () => {
    const p = lockPath();
    writeFileSync(p, JSON.stringify({ pid: deadPid(), host: hostname(), startedAt: new Date().toISOString(), command: 'crashed', token: 't' }));
    const r = tryAcquireExclusiveFile(p, 'next', Date.now(), HOUR);
    expect(r.ok).toBe(true);
    expect(readExclusiveFileHolder(p)?.command).toBe('next');
  });

  it('replaces a lock held longer than the stale age, even from another machine', () => {
    const p = lockPath();
    writeFileSync(p, JSON.stringify({ pid: 1, host: 'elsewhere', startedAt: new Date(Date.now() - 2 * HOUR).toISOString(), command: 'old', token: 't' }));
    expect(tryAcquireExclusiveFile(p, 'next', Date.now(), HOUR).ok).toBe(true);
  });

  it('respects a fresh lock from another machine', () => {
    const p = lockPath();
    writeFileSync(p, JSON.stringify({ pid: 1, host: 'elsewhere', startedAt: new Date().toISOString(), command: 'remote', token: 't' }));
    expect(tryAcquireExclusiveFile(p, 'next', Date.now(), HOUR).ok).toBe(false);
  });

  it('treats a just-created, not-yet-written lock as held, and an old unreadable one as abandoned', () => {
    const p = lockPath();
    writeFileSync(p, '');
    expect(tryAcquireExclusiveFile(p, 'next', Date.now(), HOUR).ok).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(p, old, old);
    expect(tryAcquireExclusiveFile(p, 'next', Date.now(), HOUR).ok).toBe(true);
  });

  it('a release never removes a lock that has since passed to someone else', () => {
    const p = lockPath();
    const first = tryAcquireExclusiveFile(p, 'first', Date.now(), HOUR);
    expect(first.ok).toBe(true);
    // Someone judged it abandoned and took it over.
    writeFileSync(p, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), command: 'successor', token: 'other' }));
    if (first.ok) first.release();
    expect(readExclusiveFileHolder(p)?.command).toBe('successor');
  });
});
