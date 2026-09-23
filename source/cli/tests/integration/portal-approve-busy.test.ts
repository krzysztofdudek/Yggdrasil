/**
 * The portal's Approve refuses with 409 while an approval is already running in
 * the repository — its own, or one started from a terminal — instead of
 * spawning a second run that would overwrite the first one's verdicts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startServer, type ServerHandle } from '../../src/portal/server/server.js';
import { APPROVE_LOCK_PATH, approveInProgress } from '../../src/portal/server/approve.js';
import { APPROVE_LOCK_FILE_NAME } from '../../src/io/lock-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(path.resolve(__dirname, '../..'), 'tests', 'fixtures', 'portal-basic');

function post(url: string): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-yg-portal': '1' }, body: JSON.stringify({ llm: false }) });
}

describe('portal Approve while an approval is running', () => {
  let handle: ServerHandle;
  let projectRoot: string;
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'yg-portal-busy-'));
    projectRoot = path.join(tmp, 'project');
    cpSync(FIXTURE_ROOT, projectRoot, { recursive: true });
    handle = await startServer({ projectRoot, port: 0, writeEnabled: true });
  }, 60_000);

  afterAll(async () => {
    await handle.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('the portal spells the approval lock the way the lock store does', () => {
    expect(APPROVE_LOCK_PATH).toBe(path.join('.yggdrasil', APPROVE_LOCK_FILE_NAME));
  });

  it('POST /approve returns 409 while a live process holds the approval lock, and runs nothing', async () => {
    const lockFile = path.join(projectRoot, APPROVE_LOCK_PATH);
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), command: 'yg check --approve', token: 't' }));
    try {
      const res = await post(`${handle.url}/approve`);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('approve-in-progress');
      expect(existsSync(path.join(projectRoot, '.yggdrasil', '.yg-lock.deterministic.json'))).toBe(false);
    } finally {
      rmSync(lockFile, { force: true });
    }
  });

  it('a lock whose holder is gone does not block the button', () => {
    const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
    const lockFile = path.join(projectRoot, APPROVE_LOCK_PATH);
    writeFileSync(lockFile, JSON.stringify({ pid: dead, host: hostname(), startedAt: new Date().toISOString(), command: 'yg check --approve', token: 't' }));
    try {
      expect(approveInProgress(projectRoot)).toBe(false);
    } finally {
      rmSync(lockFile, { force: true });
    }
  });

  it('a second click while the portal\'s own approval runs is refused with 409', async () => {
    const first = post(`${handle.url}/approve`);
    // Give the first request time to reach the spawn.
    await new Promise((r) => setTimeout(r, 150));
    const second = await post(`${handle.url}/approve`);
    expect(second.status).toBe(409);
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
  }, 60_000);
});
