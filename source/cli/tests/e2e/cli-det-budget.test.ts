// =============================================================================
// CLI E2E — a deterministic check that never returns.
//
// The keyless gate (`yg check --approve --only-deterministic`, pre-commit and CI)
// must not hang on a rule whose check.mjs spins forever. The check runs under a
// wall-clock budget: past it, the check is stopped, the run reports a runtime
// error naming the rule and the unit, writes nothing for it, and finishes every
// other pair.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '../..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-det-budget-'));
  const init = spawnSync('node', [BIN_PATH, 'init', '--no-reviewer'], { cwd: dir, encoding: 'utf-8' });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  const w = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  w('src/a.ts', 'export const a = 1;\n');
  const aspect = (id: string, body: string) => {
    w(`.yggdrasil/aspects/${id}/yg-aspect.yaml`, `name: ${id}\ndescription: "${id}"\nerrs: exact\nreviewer:\n  type: deterministic\nstatus: enforced\nreview_by: 2027-01-01\n`);
    w(`.yggdrasil/aspects/${id}/check.mjs`, body);
  };
  aspect('spins-forever', 'export function check(ctx) { while (true) { /* never returns */ } }\n');
  aspect('returns-clean', 'export function check(ctx) { return []; }\n');
  w('.yggdrasil/yg-architecture.yaml', 'node_types:\n  module:\n    description: A module\n    when:\n      path: "src/**"\n');
  w('.yggdrasil/model/svc/yg-node.yaml', 'name: Svc\ntype: module\ndescription: The svc\naspects: [spins-forever, returns-clean]\nmapping:\n  - src\n');
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — deterministic check budget', () => {
  it('stops a check that never returns, names it, and still records the rest', () => {
    const dir = project();
    try {
      const r = spawnSync('node', [BIN_PATH, 'check', '--approve', '--only-deterministic'], {
        cwd: dir,
        encoding: 'utf-8',
        env: { ...process.env, YG_DET_TASK_TIMEOUT_MS: '1500' },
        timeout: 60_000,
      });
      const all = (r.stdout ?? '') + (r.stderr ?? '');
      // Finished on its own, well inside the spawn's 60 s ceiling — not killed
      // by it: a check that never returned would end in SIGTERM here.
      expect(r.signal).toBeNull();
      expect(r.status).toBe(1);
      expect(all).toContain('spins-forever');
      expect(all).toContain('did not finish within 1.5s');
      // The other rule on the same unit was recorded.
      const after = spawnSync('node', [BIN_PATH, 'check', '--no-approve'], { cwd: dir, encoding: 'utf-8' });
      expect(after.stdout).toContain('1 pair verified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
