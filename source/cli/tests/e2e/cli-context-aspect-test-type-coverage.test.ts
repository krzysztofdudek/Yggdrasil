/**
 * `yg context --node` and `yg aspect test --node` both now thread real
 * type-coverage classification into computeExpectedPairs, rather than leaving
 * the call silently unwired. For BOTH of these call sites the effect is
 * provably a no-op today: attachLockObservability (build-context.ts) and the
 * LLM pair lookup (aspect-test.ts) each filter pairs by `p.nodePath ===
 * nodePath` — a componentless pair's `nodePath` is `undefined`, which can
 * never equal a real component path, so it can never enter either filtered
 * set. This suite pins that claim directly rather than leaving it as
 * unverified prose: a real node's `context`/`aspect-test` output is
 * byte-identical whether or not unrelated componentless files exist
 * alongside it in the same graph.
 *
 * Real fixture (tests/fixtures/type-level-engine/ merged with its
 * two-covered-files variant), real spawned binary, twin comparison —
 * WITH src/leaf/{a,b}.ts present (componentless pairs exist) vs WITHOUT them
 * (removed from an otherwise-identical copy), both against the SAME real
 * node (`owned`, type `leaf`, which independently gets its own file-level
 * pair from `llm-leaf-rule` since it shares that type).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FIXTURE_TWO_COVERED_FILES } from '../fixtures/type-level-engine/variants/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

/** Merged fixture (base + two-covered-files), with a reviewer tier added so
 *  llm-leaf-rule (which the variant attaches) resolves a tier for --dry-run. */
function mergedFixtureCopy(withLeafFiles: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-ctx-aspecttest-typecov-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  cpSync(FIXTURE_TWO_COVERED_FILES, dir, { recursive: true });
  appendFileSync(
    path.join(dir, '.yggdrasil', 'yg-config.yaml'),
    '\nreviewer:\n  default: standard\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: "mock-model"\n        endpoint: "http://127.0.0.1:1"\n',
  );
  if (!withLeafFiles) {
    // Both leaf files removed: `leaf` no longer matches anything uncovered, so
    // NO componentless pair exists anywhere in this graph — the twin.
    rmSync(path.join(dir, 'src', 'leaf', 'a.ts'), { force: true });
    rmSync(path.join(dir, 'src', 'leaf', 'b.ts'), { force: true });
  }
  return dir;
}

describe.skipIf(!distExists)('yg context / yg aspect test — type-level threading is a no-op for a real node', () => {
  it('yg context --node owned is byte-identical with and without componentless files present', () => {
    const withFiles = mergedFixtureCopy(true);
    const withoutFiles = mergedFixtureCopy(false);
    try {
      const a = run(['context', '--node', 'owned'], withFiles);
      const b = run(['context', '--node', 'owned'], withoutFiles);
      expect(a.status).toBe(b.status);
      expect(a.stdout).toBe(b.stdout);
      expect(a.stderr).toBe(b.stderr);
    } finally {
      rmSync(withFiles, { recursive: true, force: true });
      rmSync(withoutFiles, { recursive: true, force: true });
    }
  });

  it('yg aspect test --node owned --aspect llm-leaf-rule --dry-run is byte-identical with and without componentless files present', () => {
    const withFiles = mergedFixtureCopy(true);
    const withoutFiles = mergedFixtureCopy(false);
    try {
      const a = run(['aspect-test', '--node', 'owned', '--aspect', 'llm-leaf-rule', '--dry-run'], withFiles);
      const b = run(['aspect-test', '--node', 'owned', '--aspect', 'llm-leaf-rule', '--dry-run'], withoutFiles);
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      expect(a.stdout).toBe(b.stdout);
      expect(a.stderr).toBe(b.stderr);
      // Sanity: this is a real prompt preview, not an early error both sides share.
      expect(a.stdout).toContain('prompt for file:src/owned/o.ts');
    } finally {
      rmSync(withFiles, { recursive: true, force: true });
      rmSync(withoutFiles, { recursive: true, force: true });
    }
  });
});
