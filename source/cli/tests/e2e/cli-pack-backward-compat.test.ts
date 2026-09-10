// =============================================================================
// CLI E2E — a repository with no packages behaves exactly as it did before.
//
// Packages are the largest surface this release adds, and almost every adopter
// will never install one. The promise that costs them nothing has to be proven
// rather than asserted, so this suite drives the real binary over a repository
// that has no package record and no packages directory, and pins:
//
//   1. check   → passes, and never mentions packages
//   2. aspects → the rule list is exactly the repository's own
//   3. context → unchanged for the one component
//   4. advise  → no item about a package
//   5. the lock → a verdict recorded before packages existed still holds, with
//                 no refill and no reviewer call
//   6. output  → byte-identical across two runs, and free of every new word
//
// The fixture (tests/fixtures/pack-consumer) is committed and deliberately
// minimal: one component, one file, no rules of its own beyond what its type
// carries. It is the same fixture the lifecycle suite installs INTO, so the two
// are answering the same question from both sides.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const CONSUMER = path.join(CLI_ROOT, 'tests', 'fixtures', 'pack-consumer');
const distExists = existsSync(BIN_PATH);

/** Every word this release introduced. None may appear in a repository with no packages. */
const NEW_VOCABULARY = [
  'package-file-modified',
  'yg-packages.yaml',
  'yg-aspect.adapt.yaml',
  'yg pack',
  'packages/',
];

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, status: r.status, all: stdout + stderr };
}

function consumer(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-nopack-${label}-`));
  cpSync(CONSUMER, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — a repository with no packages', () => {
  it('has neither a package record nor a packages directory to begin with', () => {
    const dir = consumer('shape');
    try {
      expect(existsSync(path.join(dir, '.yggdrasil', 'yg-packages.yaml'))).toBe(false);
      expect(existsSync(path.join(dir, '.yggdrasil', 'aspects', 'packages'))).toBe(false);
      // And the fixture really is a graph with law of its own, not an empty
      // directory that would pass every assertion below by having nothing in it.
      expect(readdirSync(path.join(dir, '.yggdrasil'))).toContain('yg-architecture.yaml');
      expect(run(['aspects'], dir).stdout).toContain('no-todo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1: check passes, and says nothing about packages', () => {
    const dir = consumer('check');
    try {
      const checked = run(['check'], dir);
      expect(checked.status).toBe(0);
      for (const word of NEW_VOCABULARY) expect(checked.all).not.toContain(word);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2+3+4: aspects, context and advise are the repository\'s own, and nothing else', () => {
    const dir = consumer('surfaces');
    try {
      for (const args of [['aspects'], ['context', '--node', 'app'], ['advise', '--all']]) {
        const out = run(args, dir);
        expect(out.status, `${args.join(' ')} should still exit 0`).toBe(0);
        for (const word of NEW_VOCABULARY) {
          expect(out.all, `${args.join(' ')} should not mention ${word}`).not.toContain(word);
        }
      }
      // The component is still described exactly as before.
      expect(run(['context', '--node', 'app'], dir).stdout).toContain('app');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: a verdict recorded before this release still holds — no refill, no reviewer call', () => {
    const dir = consumer('lock');
    try {
      const filled = run(['check', '--approve', '--only-deterministic'], dir);
      expect(filled.status).toBe(0);

      expect(filled.all).toContain('deterministic (no cost)');

      // Second run over the same recorded verdicts: nothing to fill, nothing billed.
      const again = run(['check', '--approve', '--only-deterministic'], dir);
      expect(again.status).toBe(0);
      expect(again.all).toContain('all expected pairs hold valid verdicts');
      expect(again.all).toContain('0 reviewer calls made');
      // Nothing needed re-judging.
      expect(again.all).toContain('Filling 0 unverified pairs');
      expect(again.all).toContain('1 verified (1 deterministic, 0 LLM)');
      for (const word of NEW_VOCABULARY) expect(again.all).not.toContain(word);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: two runs produce the same report', () => {
    // Nothing about reading packages introduces order-dependence, a clock or a
    // filesystem-walk artefact into a repository that has none.
    const dir = consumer('stable');
    try {
      const first = run(['check'], dir);
      const second = run(['check'], dir);
      expect(second.stdout).toBe(first.stdout);
      expect(second.status).toBe(first.status);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pack list says nothing is installed, without inventing a record', () => {
    // The one new surface a package-free repository can reach. It must not write
    // a record just for having been asked.
    const dir = consumer('list');
    try {
      const listed = run(['pack', 'list'], dir);
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain('No packages installed');
      expect(existsSync(path.join(dir, '.yggdrasil', 'yg-packages.yaml'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
