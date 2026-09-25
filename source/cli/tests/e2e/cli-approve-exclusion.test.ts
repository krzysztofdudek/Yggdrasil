import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Public-surface E2E: a second `yg check --approve` while one holds the approval
// lock fails with an explained environment error (never "This is a bug"), and 8
// parallel `yg log add` processes on one node all land. Only the built bin and
// the files it writes are inputs (e2e-public-surface: no src import).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE_SRC = path.join(CLI_ROOT, 'tests', 'fixtures', 'portal-basic');
const distExists = existsSync(BIN_PATH);

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-approve-excl-'));
  tmpDirs.push(dir);
  const dest = path.join(dir, 'project');
  cpSync(FIXTURE_SRC, dest, { recursive: true });
  return dest;
}

describe.skipIf(!distExists)('yg check --approve exclusion (e2e)', () => {
  it('a held approval lock makes a second approve fail fast with what/why/next, not as a bug', () => {
    const root = project();
    writeFileSync(
      path.join(root, '.yggdrasil', '.yg-approve.lock'),
      JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), command: 'yg check --approve', token: 't' }),
    );
    const r = spawnSync(process.execPath, [BIN_PATH, 'check', '--approve', '--only-deterministic'], { cwd: root, encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Another fill is already running in this repository/);
    expect(r.stderr).not.toMatch(/This is a bug/);
    expect(existsSync(path.join(root, '.yggdrasil', '.yg-lock.deterministic.json'))).toBe(false);
  }, 60_000);

  it('8 parallel `yg log add` on one node all land', async () => {
    const root = project();
    const node = readdirFirstNode(path.join(root, '.yggdrasil', 'model'));
    const logFile = path.join(root, '.yggdrasil', 'model', node, 'log.md');
    const before = existsSync(logFile) ? (readFileSync(logFile, 'utf-8').match(/^## \[/gm) ?? []).length : 0;
    const runs = Array.from({ length: 8 }, (_, i) => new Promise<number>((resolve) => {
      const c = spawn(process.execPath, [BIN_PATH, 'log', 'add', '--node', node, '--reason', `Parallel entry number ${i} explaining why.`], { cwd: root, stdio: 'ignore' });
      c.on('close', (code) => resolve(code ?? 1));
    }));
    const codes = await Promise.all(runs);
    expect(codes).toEqual(Array(8).fill(0));
    const after = (readFileSync(logFile, 'utf-8').match(/^## \[/gm) ?? []).length;
    expect(after - before).toBe(8);
  }, 120_000);
});

function readdirFirstNode(modelDir: string): string {
  for (const name of readdirSync(modelDir).sort()) {
    if (statSync(path.join(modelDir, name)).isDirectory() && existsSync(path.join(modelDir, name, 'yg-node.yaml'))) return name;
  }
  throw new Error('no node in fixture');
}
