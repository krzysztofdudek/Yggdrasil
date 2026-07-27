import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hermetic E2E for the type-level classification lattice (coverage.type_level)
// against the committed fixture tests/fixtures/type-coverage-basic/, spawning
// the real built binary. Companion to tests/unit/core/type-coverage.test.ts,
// which exercises computeTypeCoverage and the runCheck wiring directly — this
// suite confirms the same behavior is reachable through the actual CLI
// process: real exit code, real stdout.
//
// No git is needed: `yg check`'s primary coverage scan is a plain disk walk
// (io/repo-scanner.ts's walkRepoFiles), independent of git; only the
// tracked∩gitignored anomaly check consults real git, and it best-effort
// skips when none is found — neither of which this suite exercises.
//
// The committed fixture is never mutated — every run works on a mkdtemp copy,
// removed in a finally block.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-basic');
const distExists = existsSync(BIN_PATH);

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-type-coverage-e2e-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function run(args: string[], cwd: string): { status: number | null; out: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe.skipIf(!distExists)('E2E: type-level classification lattice via the real CLI binary', () => {
  it('exits 1 (FAIL) and renders the ambiguous-node-type block naming both overlapping types', () => {
    const dir = copyFixture();
    try {
      const { status, out } = run(['check', '--details'], dir);
      expect(status).toBe(1);
      expect(out).toContain('FAIL');
      expect(out).toContain('ambiguous-node-type');
      expect(out).toContain('src/svc/overlap.ts');
      expect(out).toContain('svc');
      expect(out).toContain('util');
      expect(out).toContain('Two exits');
      // The strict-claimed file is reported by the strict scan, never as an
      // ambiguity, even though it also matches a non-strict type.
      expect(out).toContain('type-strict-orphan');
      // The excluded-root match (vendor/tool.ts) is muted entirely.
      expect(out).not.toContain('vendor/tool.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The grouped PASS header does not yet split out type-covered files from
  // plain node-mapped ones, so there is nothing observable yet to assert here.
  // Once it does, a fixture variant with no ambiguous file (flag still on)
  // should print that split on a clean PASS run — placeholder until then.
  it.todo('a PASS-twin fixture (no ambiguous file, flag on) prints the split PASS header');
});
