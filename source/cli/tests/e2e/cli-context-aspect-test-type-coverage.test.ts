/**
 * `yg context --node` and `yg aspect test --node` both now thread real
 * type-coverage classification into computeExpectedPairs, rather than leaving
 * the call silently unwired. For BOTH of these call sites the effect is
 * provably a no-op today: attachLockObservability (build-context.ts) and the
 * LLM pair lookup (aspect-test.ts) each filter pairs by `p.nodePath ===
 * nodePath` — a componentless pair's `nodePath` is `undefined`, which can
 * never equal a real component path, so it can never enter either filtered
 * set. This suite pins that claim directly, with real output on both sides
 * (not two empty error pages that happen to match): a real node's
 * `context`/`aspect-test` output is byte-identical whether or not unrelated
 * plain, componentless files exist alongside it in the same graph.
 *
 * The fixture (tests/fixtures/type-coverage-node-twin/) is a small, dedicated
 * graph — not an overlay on tests/fixtures/type-level-engine/, whose
 * architecture deliberately carries an unrelated parents: cycle and a
 * strict-without-when type (both exist there to pin cascade-engine cycle
 * termination, nothing to do with this suite). Those make `validate()` fail
 * before `yg context` ever reaches attachLockObservability, so both twin runs
 * would exit 1 with the same validation error regardless of whether the
 * threaded call does anything at all — a match that proves nothing. This
 * fixture's graph validates cleanly, so the command reaches the real,
 * threaded code path on both sides.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-node-twin');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

/** Fresh mkdtemp copy of the fixture, optionally stripped of its two plain
 *  leaf siblings (src/leaf/{a,b}.ts) — the twin comparison this suite runs. */
function twinFixtureCopy(withLeafFiles: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-ctx-aspecttest-typecov-'));
  cpSync(FIXTURE, dir, { recursive: true });
  if (!withLeafFiles) {
    rmSync(path.join(dir, 'src', 'leaf', 'a.ts'), { force: true });
    rmSync(path.join(dir, 'src', 'leaf', 'b.ts'), { force: true });
  }
  return dir;
}

describe.skipIf(!distExists)('yg context / yg aspect test — type-level threading is a no-op for a real node', () => {
  it('yg context --node owned is byte-identical, and real, with and without plain leaf files present', () => {
    const withFiles = twinFixtureCopy(true);
    const withoutFiles = twinFixtureCopy(false);
    try {
      const a = run(['context', '--node', 'owned'], withFiles);
      const b = run(['context', '--node', 'owned'], withoutFiles);
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      expect(a.stdout).toBe(b.stdout);
      expect(a.stderr).toBe(b.stderr);
      // Sanity: this is the real node-context body, not an early validation
      // error both sides would share regardless of the threaded call.
      expect(a.stdout).toContain('Must satisfy (1 aspect)');
      expect(a.stdout).toContain('llm-leaf-rule');
    } finally {
      rmSync(withFiles, { recursive: true, force: true });
      rmSync(withoutFiles, { recursive: true, force: true });
    }
  });

  it('yg aspect test --node owned --aspect llm-leaf-rule --dry-run is byte-identical, and real, with and without plain leaf files present', () => {
    const withFiles = twinFixtureCopy(true);
    const withoutFiles = twinFixtureCopy(false);
    try {
      const a = run(['aspect-test', '--node', 'owned', '--aspect', 'llm-leaf-rule', '--dry-run'], withFiles);
      const b = run(['aspect-test', '--node', 'owned', '--aspect', 'llm-leaf-rule', '--dry-run'], withoutFiles);
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      expect(a.stdout).toBe(b.stdout);
      expect(a.stderr).toBe(b.stderr);
      // Sanity: this is a real prompt preview, not an early error both sides share.
      expect(a.stdout).toContain('prompt for file:src/leaf/owned.ts');
    } finally {
      rmSync(withFiles, { recursive: true, force: true });
      rmSync(withoutFiles, { recursive: true, force: true });
    }
  });
});
