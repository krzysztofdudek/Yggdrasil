import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync, cpSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Public-surface E2E for the file-aware loop (5.2) + attestation provenance (5.1).
 *
 * Spawns the built dist/bin.js against a REAL fixture project copied to a temp dir. It first
 * closes a baseline via `yg check --approve` (writes the committed source fingerprint), emits a
 * `yg portal --static` page, then edits one mapped source file and re-emits — asserting that the
 * touched node flips to unverified on the page while the untouched one stays verified, and that
 * the page's meta carries the committed-lock hash + the git commit ref. ZERO src/** import
 * (e2e-public-surface): the only inputs are the spawned CLI and the pages it wrote.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FRESH_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'portal-fresh');
const distExists = existsSync(BIN_PATH);

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

interface PortalNodeLite {
  path: string;
  state: string;
  fresh: boolean;
}
interface PortalDataLite {
  meta: { lockHash: string; commitRef: string | null };
  nodes: PortalNodeLite[];
}

/** Parse the inlined PortalData back out of an emitted static page (the public artifact). */
function parsePage(html: string): PortalDataLite {
  const m = html.match(/<script id="portal-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inlined portal-data script in the emitted page');
  const json = m[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&');
  return JSON.parse(json) as PortalDataLite;
}

function emit(cwd: string, outPath: string): void {
  const run = spawnSync('node', [BIN_PATH, 'portal', '--static', '--out', outPath], { cwd, encoding: 'utf-8' });
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
}

describe.skipIf(!distExists)('CLI E2E — yg portal --static file-aware loop (5.2) + provenance (5.1)', () => {
  let before: PortalDataLite;
  let after: PortalDataLite;

  beforeAll(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-fileaware-'));
    tmpDirs.push(dir);
    cpSync(FRESH_FIXTURE, dir, { recursive: true });

    // Close the baseline through the public CLI (writes the committed source fingerprint).
    const approve = spawnSync('node', [BIN_PATH, 'check', '--approve'], { cwd: dir, encoding: 'utf-8' });
    expect(approve.status, `${approve.stdout}\n${approve.stderr}`).toBe(0);

    // Page 1 — the closed baseline.
    const out1 = path.join(dir, 'before.html');
    emit(dir, out1);
    before = parsePage(readFileSync(out1, 'utf-8'));

    // Edit one mapped source file (a real byte change) — no re-approve.
    appendFileSync(path.join(dir, 'src/orders/orders.service.ts'), '\n// a manual edit since the reviewer pass\n', 'utf-8');

    // Page 2 — after the edit.
    const out2 = path.join(dir, 'after.html');
    emit(dir, out2);
    after = parsePage(readFileSync(out2, 'utf-8'));
  });

  it('the baseline page reads verified + not-fresh for both nodes', () => {
    const orders = before.nodes.find((n) => n.path === 'api/orders')!;
    const users = before.nodes.find((n) => n.path === 'api/users')!;
    expect(orders.fresh).toBe(false);
    expect(orders.state).toBe('verified');
    expect(users.state).toBe('verified');
  });

  it('after the edit, ONLY the touched node reads unverified — never repo-green over it', () => {
    const orders = after.nodes.find((n) => n.path === 'api/orders')!;
    const users = after.nodes.find((n) => n.path === 'api/users')!;
    expect(orders.fresh).toBe(true);
    expect(orders.state).toBe('unverified');
    expect(orders.state).not.toBe('verified');
    // The untouched node is undisturbed.
    expect(users.fresh).toBe(false);
    expect(users.state).toBe('verified');
  });

  it('the page meta pins the committed-lock hash and the git commit ref', () => {
    expect(before.meta.lockHash).toMatch(/^[0-9a-f]{64}$/);
    // The temp copy carries the repo's .git via cpSync? No — a fresh temp dir has no .git, so the
    // commit ref is honestly null (the digest then states "no commit ref"), never fabricated.
    expect(before.meta.commitRef === null || /^[0-9a-f]{40}$/.test(before.meta.commitRef)).toBe(true);
    // The edit changed the working tree but NOT the committed lock — the lock hash is stable.
    expect(after.meta.lockHash).toBe(before.meta.lockHash);
  });
});
