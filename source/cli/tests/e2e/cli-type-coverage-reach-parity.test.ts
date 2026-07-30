// =============================================================================
// E2E — a type-covered file's architecture-derived read allowance must permit
// exactly what the live type-relation gate would permit, file for file, and a
// component-free (nodeless) verdict must read back verified forever — never
// re-fill on a later plain check.
//
// Real spawned binary, against the REAL committed tests/fixtures/type-level-
// engine/ project merged with its `reach-parity` variant: a type-covered file
// (`reach-leaf`) whose architecture relations restrict it to depending on
// `reach-parent-type` only, and two real components under src/reach/parent/ —
// `reach-parent` maps the WHOLE directory, and a nested `reach-parent/child`
// maps one specific file inside it as a type `reach-leaf` may NOT depend on
// (child-wins).
//
// HERMETIC: fresh mkdtemp merge (base + variant) per test, mutated in place,
// rmSync'd in finally. No reviewer needed — both aspects under test are
// deterministic.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock } from './support/read-lock.js';
import { FIXTURE_REACH_PARITY } from '../fixtures/type-level-engine/variants/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function copyMergedFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-reach-parity-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  cpSync(FIXTURE_REACH_PARITY, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)("CLI E2E — a type-covered file's read allowance matches the live type gate", () => {
  it("admits a permitted component's genuinely-owned file but refuses a forbidden child component's file inside the SAME mapped directory", () => {
    const dir = copyMergedFixture();
    try {
      const fill = run(['check', '--approve'], dir);

      const lock = readLock(path.join(dir, '.yggdrasil'));
      // The permitted read: reach-parent's OWN file is genuinely reachable.
      expect(lock.verdicts['reach-parent-file-rule']?.['file:src/reach/leaf/a.ts']?.verdict).toBe('approved');

      // The forbidden read: reach-child-type's file sits inside reach-parent's
      // mapped directory, but child-wins means reach-parent never owns it — the
      // read is refused as infrastructure, never silently admitted, and no
      // entry is written for the pair.
      expect(lock.verdicts['reach-child-file-rule']?.['file:src/reach/leaf/a.ts']).toBeUndefined();
      expect(fill.all).toContain(
        "Deterministic check 'reach-child-file-rule' failed to run on file:src/reach/leaf/a.ts — left unverified (aspect-check-runtime-error).",
      );
      expect(fill.all).toContain("Aspect tried to read undeclared path 'src/reach/parent/child.ts'");
      // The real remedy is an architecture or graph change — widen the type's
      // relations, or give the file a component of its own — never "fix
      // check.mjs" (there is nothing wrong with the check).
      expect(fill.all).toContain(
        "Allow 'reach-leaf' to depend on whatever owns 'src/reach/parent/child.ts' in yg-architecture.yaml, or give 'src/reach/leaf/a.ts' a component of its own (a yg-node.yaml mapping it) so it can declare an explicit relation instead.",
      );
      expect(fill.all).not.toContain('Fix the check.mjs, then re-run: yg check --approve');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('a component-free pair, once approved, reads back verified on a later plain check — no re-fill, no drift', () => {
    const dir = copyMergedFixture();
    try {
      expect(run(['check', '--approve'], dir).status).not.toBeNull();

      const before = readLock(path.join(dir, '.yggdrasil'));
      const beforeEntry = before.verdicts['reach-parent-file-rule']?.['file:src/reach/leaf/a.ts'];
      expect(beforeEntry?.verdict).toBe('approved');

      const verified = run(['check'], dir);
      // Never re-fills: a plain check with a stored hash that no longer
      // matches what verify recomputes would report this pair unverified —
      // forever, since neither side of that mismatch ever changes again.
      const unverifiedForThisPair = verified.stdout
        .split('\n')
        .filter((l) => l.includes('unverified') || l.includes("aspect 'reach-parent-file-rule'"));
      expect(unverifiedForThisPair.join('\n')).not.toContain('reach-parent-file-rule');

      const after = readLock(path.join(dir, '.yggdrasil'));
      const afterEntry = after.verdicts['reach-parent-file-rule']?.['file:src/reach/leaf/a.ts'];
      // Byte-identical hash: a plain check never re-fills. If the stored hash
      // and the freshly recomputed one had diverged, this pair would come
      // back unverified above instead.
      expect(afterEntry?.hash).toBe(beforeEntry?.hash);
      expect(afterEntry?.verdict).toBe('approved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
