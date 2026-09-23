// =============================================================================
// CLI E2E — a reader that closes its end of yg's output pipe.
//
// `yg check --approve 2>&1 | head -2` and `yg check --json | head -c 50` are
// ordinary agent habits. Once the reader is gone, every further write to that
// pipe fails with EPIPE. Output nobody reads is not a reason to abort: the run
// must finish, persist what it verified, and exit with its own code — never a
// raw "Error: write EPIPE" and never a lost fill.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '../..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

/** A keyless project with one deterministic rule over two files. */
function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-closed-pipe-'));
  const init = spawnSync('node', [BIN_PATH, 'init', '--no-reviewer'], { cwd: dir, encoding: 'utf-8' });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  const w = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  w('src/a.ts', 'export const a = 1;\n');
  w('src/b.ts', 'export const b = 2;\n');
  w('.yggdrasil/aspects/no-todo/yg-aspect.yaml', 'name: NoTodo\ndescription: "No TODO markers"\nerrs: exact\nreviewer:\n  type: deterministic\nstatus: enforced\nreview_by: 2027-01-01\n');
  w('.yggdrasil/aspects/no-todo/check.mjs', 'export function check(ctx) { return ctx.node.files.filter((f) => f.content.includes("TODO")).map((f) => ({ file: f.path, message: "TODO found" })); }\n');
  w('.yggdrasil/yg-architecture.yaml', 'node_types:\n  module:\n    description: A module\n    when:\n      path: "src/**"\n');
  w('.yggdrasil/model/svc/yg-node.yaml', 'name: Svc\ntype: module\ndescription: The svc\naspects: [no-todo]\nmapping:\n  - src\n');
  return dir;
}

/** Run yg with both output pipes closed by the reader before yg writes anything. */
function runWithClosedPipes(args: string[], cwd: string): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const child = spawn('node', [BIN_PATH, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    child.stderr.destroy();
    child.on('exit', (status, signal) => resolve({ status, signal }));
  });
}

describe.skipIf(!distExists)('CLI E2E — closed output pipe', () => {
  it('a fill whose reader went away still persists every verdict and exits with its own code', async () => {
    const dir = project();
    try {
      const { status, signal } = await runWithClosedPipes(['check', '--approve', '--only-deterministic'], dir);
      expect(signal).toBeNull();
      expect(status).toBe(0);
      // The verdict landed: a plain check afterwards is green with nothing to fill.
      const after = spawnSync('node', [BIN_PATH, 'check', '--no-approve'], { cwd: dir, encoding: 'utf-8' });
      expect(after.stdout).toContain('verified (');
      expect(after.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('check --json into a closed pipe exits with the check result, not a write error', async () => {
    const dir = project();
    try {
      spawnSync('node', [BIN_PATH, 'check', '--approve', '--only-deterministic'], { cwd: dir, encoding: 'utf-8' });
      const { status } = await runWithClosedPipes(['check', '--json'], dir);
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
