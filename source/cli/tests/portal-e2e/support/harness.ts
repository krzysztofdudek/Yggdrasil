/*
 * Portal E2E harness — the PUBLIC-surface drivers shared by every portal spec.
 *
 * Two delivery modes, both driving the REAL `yg portal` output of a REAL on-disk fixture
 * project through the PUBLIC CLI surface only (spawn dist/bin.js):
 *
 *   staticPage(fixture)   — run `yg portal --static`, return the file:// URL of the emitted
 *                            self-contained page. Used for the views, navigation, palette,
 *                            routing, honesty rendering, and a11y — every read-only surface.
 *   servedPortal(opts)    — spawn `yg portal --port 0` over a FRESH temp copy of a fixture,
 *                            resolve its loopback URL. Used for Refresh, the Approve dry-run /
 *                            cost-preview, the real write, and the --no-write 409 guard.
 *
 * No portal internal is imported; no PortalData is fabricated. The only inputs are the spawned
 * CLI, the file it wrote, and the loopback HTTP responses. Every server is tracked and killed,
 * every temp dir removed, by the per-worker fixtures in fixtures.ts so a run always terminates.
 */
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLI_ROOT = path.join(__dirname, '../../..');
export const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
export const FIXTURES_DIR = path.join(CLI_ROOT, 'tests', 'fixtures');

/** Absolute path to a committed fixture project (a real `.yggdrasil/` graph + source). */
export function fixtureRoot(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/** Track temp dirs + child processes so a worker can tear everything down. */
export interface Teardown {
  tmpDirs: string[];
  procs: ChildProcess[];
}

export function newTeardown(): Teardown {
  return { tmpDirs: [], procs: [] };
}

export function teardown(t: Teardown): void {
  for (const p of t.procs) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const d of t.tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  t.procs.length = 0;
  t.tmpDirs.length = 0;
}

/** Copy a committed fixture into a fresh temp dir so a real Approve never mutates it. */
export function freshFixtureCopy(t: Teardown, name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-portal-e2e-${name}-`));
  t.tmpDirs.push(dir);
  const dest = path.join(dir, 'project');
  cpSync(fixtureRoot(name), dest, { recursive: true });
  // Drop any pre-baked deterministic cache so a first approve genuinely fills it.
  const detCache = path.join(dest, '.yggdrasil', '.yg-lock.deterministic.json');
  if (existsSync(detCache)) rmSync(detCache, { force: true });
  return dest;
}

/** Run `yg portal --static` over `cwd`, returning the emitted page's file:// URL. */
export function staticPage(t: Teardown, opts: { fixture?: string; cwd?: string }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-e2e-static-'));
  t.tmpDirs.push(dir);
  const out = path.join(dir, 'portal.html');
  const cwd = opts.cwd ?? fixtureRoot(opts.fixture ?? 'portal-basic');
  const res = spawnSync('node', [BIN_PATH, 'portal', '--static', '--out', out], { cwd, encoding: 'utf-8' });
  if (res.status !== 0 || !existsSync(out)) {
    throw new Error(`yg portal --static failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
  return 'file://' + out;
}

/** Read the inlined PortalData JSON straight out of an emitted static page. */
export function readInlinedData(fileUrl: string): unknown {
  const filePath = fileUrl.replace(/^file:\/\//, '');
  const html = readFileSync(filePath, 'utf-8');
  const m = html.match(/<script id="portal-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inlined portal-data script in the emitted page');
  return JSON.parse(m[1]);
}

/** Spawn `yg portal --port 0` over `cwd`; resolve once it prints its loopback URL. */
export function servedPortal(
  t: Teardown,
  opts: { cwd: string; noWrite?: boolean },
): Promise<{ baseUrl: string; proc: ChildProcess }> {
  const args = [BIN_PATH, 'portal', '--port', '0'];
  if (opts.noWrite) args.push('--no-write');
  return new Promise((resolve, reject) => {
    const proc = spawn('node', args, { cwd: opts.cwd });
    t.procs.push(proc);
    let out = '';
    const timer = setTimeout(
      () => reject(new Error(`portal server did not start in time. stdout so far:\n${out}`)),
      30_000,
    );
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

/** Spawn `yg check` over a fixture and return its raw stdout+stderr + exit code (consistency check). */
export function runCheck(cwd: string): { out: string; status: number | null } {
  const res = spawnSync('node', [BIN_PATH, 'check'], { cwd, encoding: 'utf-8' });
  return { out: (res.stdout ?? '') + (res.stderr ?? ''), status: res.status };
}

/**
 * Spawn `yg check --approve --only-deterministic` over `cwd` — a real, live,
 * keyless fill of every deterministic pair (no reviewer call, no committed
 * lock needed beforehand). Used to give a fixture a genuine refused/verified
 * verdict before a spec reads the portal or the CLI header over it.
 */
export function approveDeterministic(cwd: string): { out: string; status: number | null } {
  const res = spawnSync('node', [BIN_PATH, 'check', '--approve', '--only-deterministic'], { cwd, encoding: 'utf-8' });
  return { out: (res.stdout ?? '') + (res.stderr ?? ''), status: res.status };
}
