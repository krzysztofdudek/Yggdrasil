import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '../..', 'dist', 'bin.js');

// chmod 000 does not stop root from reading, so the scenario only exists for a
// non-root user.
const canMakeUnreadable = typeof process.getuid === 'function' && process.getuid() !== 0;

function run(args: string[], cwd: string): { all: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

/**
 * A node of a log_required type whose only mapped file cannot be read. The node
 * has no aspects, so no pair ever reports the file: the log gate is the only
 * place that notices the fingerprint cannot be computed.
 */
function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-loggate-unreadable-'));
  mkdirSync(path.join(dir, '.yggdrasil', 'model', 'app'), { recursive: true });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'version: "6.0.0"\n');
  writeFileSync(
    path.join(dir, '.yggdrasil', 'yg-architecture.yaml'),
    'node_types:\n  component:\n    description: A component\n    log_required: true\n    when:\n      path: "src/**"\n',
  );
  writeFileSync(
    path.join(dir, '.yggdrasil', 'model', 'app', 'yg-node.yaml'),
    'name: App\ntype: component\ndescription: The app\nmapping:\n  - src\n',
  );
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  return dir;
}

describe.skipIf(!existsSync(BIN_PATH) || !canMakeUnreadable)('log gate over an unreadable mapped file', () => {
  it('yg context and yg check agree that the gate is closed, and check names the unreadable file as the cause', () => {
    const dir = makeProject();
    try {
      expect(run(['context', '--node', 'app'], dir).all).toContain('log entry required before --approve: yes');
      chmodSync(path.join(dir, 'src', 'a.ts'), 0o000);

      // context uses the same gate computation as check: an uncomputable
      // fingerprint keeps the gate closed rather than reporting "no entry owed".
      const ctx = run(['context', '--node', 'app'], dir);
      expect(ctx.all).toContain('log entry required before --approve: yes');

      const check = run(['check', '--no-approve', '--details'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('file-unreadable');
      expect(check.all).toContain('src/a.ts');
      // The prescribed fix is to make the file readable, not to write a log entry.
      expect(check.all).not.toContain('log-entry-missing');
    } finally {
      try { chmodSync(path.join(dir, 'src', 'a.ts'), 0o644); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
