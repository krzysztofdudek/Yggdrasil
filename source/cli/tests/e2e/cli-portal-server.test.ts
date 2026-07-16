import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Public-surface E2E for the loopback portal server (Phase 2.1–2.3). Spawns the built
// dist/bin.js (`yg portal --port 0`) against a REAL fixture project copy, then drives the
// live endpoints with a real HTTP client. Spawning the bin is the ONLY way the approve /
// dry-run paths can be exercised honestly: those re-enter the running bin via
// process.argv[1], which is the yg bin here (not the test runner). No src/** import
// (e2e-public-surface aspect): the only inputs are the spawned CLI and the HTTP responses.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE_SRC = path.join(CLI_ROOT, 'tests', 'fixtures', 'portal-basic');

const distExists = existsSync(BIN_PATH);

// Minimal response shapes for the typed casts of fetch().json() (which is `unknown`). No
// src import — the e2e-public-surface aspect forbids it; these mirror only the fields asserted.
interface PortalDataLike {
  meta: { writeEnabled: boolean; counts: { nodes: number; unverified: number; refused: number; errors: number } };
}
interface DryRunLike { pairs: number; deterministic: number; reviewerCalls: number; raw: string }
interface ApproveLike { ok: boolean; exitCode: number }

const tmpDirs: string[] = [];
const procs: ChildProcess[] = [];

afterAll(() => {
  for (const p of procs) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Copy the fixture into a fresh temp dir so a real approve never mutates the committed fixture. */
function freshFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-server-e2e-'));
  tmpDirs.push(dir);
  const dest = path.join(dir, 'project');
  cpSync(FIXTURE_SRC, dest, { recursive: true });
  // Drop any pre-baked deterministic cache so the first approve genuinely fills it.
  const detCache = path.join(dest, '.yggdrasil', '.yg-lock.deterministic.json');
  if (existsSync(detCache)) rmSync(detCache, { force: true });
  return dest;
}

/** Spawn `yg portal --port 0` in `cwd`; resolve once it prints its loopback URL. */
function startPortalServer(cwd: string): Promise<{ baseUrl: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [BIN_PATH, 'portal', '--port', '0'], { cwd });
    procs.push(proc);
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start in time. stdout so far:\n${out}`)), 30_000);
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
      const m = out.match(/Portal running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ baseUrl: m[1], proc });
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// The portal page attaches a marker header to its /data, /approve/dry-run and /approve calls;
// the server refuses a guarded request that lacks it (cross-origin / CSRF guard). These tests
// simulate the page, so they send it — the un-guarded HTML page routes (/) stay bare fetch.
function apiFetch(url: string, init: Record<string, unknown> = {}) {
  const headers = { ...(init.headers as Record<string, string> | undefined), 'x-yg-portal': '1' };
  return fetch(url, { ...init, headers } as Parameters<typeof fetch>[1]);
}

describe.skipIf(!distExists)('CLI E2E — yg portal server (loopback, refresh, approve)', () => {
  let projectRoot: string;
  let baseUrl: string;

  beforeAll(async () => {
    projectRoot = freshFixture();
    const started = await startPortalServer(projectRoot);
    baseUrl = started.baseUrl;
  }, 60_000);

  it('binds a loopback URL and serves the live page', async () => {
    expect(baseUrl.startsWith('http://127.0.0.1:')).toBe(true);
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
  });

  it('GET /data returns valid PortalData (live, fresh re-extraction)', async () => {
    const res = await apiFetch(`${baseUrl}/data`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as PortalDataLike;
    expect(data.meta.counts.nodes).toBe(3);
    expect(data.meta.writeEnabled).toBe(true);
  });

  it('GET /approve/dry-run returns a reviewer-call / cost preview with a count', async () => {
    const res = await apiFetch(`${baseUrl}/approve/dry-run?llm=false`);
    expect(res.status).toBe(200);
    const preview = (await res.json()) as DryRunLike;
    // The preview carries the engine's own budget numbers — never re-implemented.
    expect(typeof preview.pairs).toBe('number');
    expect(typeof preview.deterministic).toBe('number');
    expect(typeof preview.reviewerCalls).toBe('number');
    expect(preview.reviewerCalls).toBe(0); // llm=false → free, keyless path
    expect(preview.raw).toContain('reviewer calls');
  }, 60_000);

  it('the server never reads the secrets file (no yg-secrets.yaml in the fixture, and none created)', () => {
    // The committed-only contract: the server/CLI surface never depends on a secrets file.
    // This fixture has none; assert the server ran fine without one (proven by the prior
    // passing requests) and that the approve path will own keys via the spawned CLI, not here.
    expect(existsSync(path.join(projectRoot, '.yggdrasil', 'yg-secrets.yaml'))).toBe(false);
  });

  it('POST /approve {llm:false} runs the deterministic fill and the next /data reflects it', async () => {
    // Snapshot the committed lock before; the deterministic approve writes only the
    // gitignored deterministic cache, never the committed lock.
    const ygDir = path.join(projectRoot, '.yggdrasil');
    const committedLock = path.join(ygDir, 'yg-lock.nondeterministic.json');
    const committedBefore = existsSync(committedLock)
      ? { bytes: readFileSync(committedLock, 'utf-8'), mtimeMs: statSync(committedLock).mtimeMs }
      : null;

    const res = await apiFetch(`${baseUrl}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApproveLike;
    expect(body.ok).toBe(true);
    expect(body.exitCode).toBe(0);

    // The deterministic cache now exists (the fill genuinely ran via the spawned CLI).
    const detCache = path.join(ygDir, '.yg-lock.deterministic.json');
    expect(existsSync(detCache)).toBe(true);

    // The committed lock is byte-unchanged: the deterministic approve never touches it.
    if (committedBefore) {
      const after = { bytes: readFileSync(committedLock, 'utf-8'), mtimeMs: statSync(committedLock).mtimeMs };
      expect(after.bytes).toBe(committedBefore.bytes);
    }

    // The next /data reflects the post-approve truth — counts re-derived live, never a
    // silent success. The deterministic pairs are now verified (the fixture is all-green).
    const after = (await (await apiFetch(`${baseUrl}/data`)).json()) as PortalDataLike;
    expect(after.meta.counts.unverified).toBe(0);
    expect(after.meta.counts.refused).toBe(0);
    expect(after.meta.counts.errors).toBe(0);
  }, 120_000);
});
