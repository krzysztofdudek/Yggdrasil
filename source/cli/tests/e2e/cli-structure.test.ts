import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Subprocess E2E for `yg structure` — the read-only structural dashboard.
// Harness mirrors cli-commands-surface.test.ts: run() wraps spawnSync on the
// compiled dist/bin.js, each case builds its own hermetic temp dir and removes
// it in a finally. Public CLI surface only (spawn the binary; assert on
// stdout/stderr/exit). No internal imports, no network, no clock.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
// sample-project has clean cross-tree structural relations
// (checkout/controller -> orders/order-service; orders/order-service ->
// auth/auth-api and users/user-repo) AND a red check state (unverified LLM
// pairs) — so it exercises both the section rendering and lock-blindness.
const SAMPLE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');

const distExists = existsSync(BIN_PATH);

const LEGEND =
  'edges = declared structural relations ∪ statically detected dependencies; event relations excluded; weights not computed';

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the sample-project fixture into a fresh temp dir. */
function copySample(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-structure-${label}-`));
  cpSync(SAMPLE, dir, { recursive: true });
  return dir;
}

/** An empty temp dir with NO .yggdrasil/ — for the no-graph loader-error path. */
function emptyDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `yg-structure-empty-${label}-`));
}

describe.skipIf(!distExists)('CLI E2E — yg structure (read-only structural dashboard)', () => {
  it('renders the edge-universe legend, tunnels, modules, and change reach; exit 0', () => {
    const dir = copySample('render');
    try {
      const { stdout, status } = run(['structure'], dir);
      expect(status).toBe(0);

      // Legend printed ALWAYS, verbatim.
      expect(stdout).toContain(LEGEND);

      // Tunnels section names the known cross-tree edge with its span in WORDS.
      expect(stdout).toContain('Tunnels');
      expect(stdout).toContain('checkout/controller → orders/order-service');
      expect(stdout).toMatch(/jumps \d+ level/);

      // Modules per-depth view: sample-project has 4 top-level groups, so a
      // depth-1 section renders and names the groups.
      expect(stdout).toContain('Modules');
      expect(stdout).toMatch(/depth 1\b/);
      expect(stdout).toMatch(/\bgroups\b/);

      // Change reach line, phrased in plain language with a percentage.
      expect(stdout).toMatch(
        /From an average component, \d+% of the system is reachable through dependencies\./,
      );

      // Plain-language guard: no method jargon leaks into the output.
      for (const banned of ['LCA', 'conductance', 'SCC', 'Laplacian', 'Fiedler', 'eigenvalue']) {
        expect(stdout).not.toContain(banned);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays exit 0 even when `yg check` is red (lock-blind instrument)', () => {
    const dir = copySample('lockblind');
    try {
      // sample-project has unverified pairs — check is RED (non-zero).
      const check = run(['check'], dir);
      expect(check.status).not.toBe(0);

      // structure never reads the lock and never gates — it still exits 0.
      const structure = run(['structure'], dir);
      expect(structure.status).toBe(0);
      expect(structure.stdout).toContain(LEGEND);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors with the standard loader message and non-zero exit when no .yggdrasil/', () => {
    const dir = emptyDir('nograph');
    try {
      const { status, stderr } = run(['structure'], dir);
      expect(status).not.toBe(0);
      expect(stderr).toContain('No .yggdrasil/ directory found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
