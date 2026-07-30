/**
 * `yg context --file` on a file enforced by its architecture type alone (no
 * owning component) — the typed view (build-context.ts / formatters/
 * context-file.ts) that REPLACES today's "not covered by any node" error for
 * such a file. Real spawned binary, real tests/fixtures/type-level-engine/
 * (Step 3).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const distExists = existsSync(BIN_PATH);

function copyFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-context-file-typecov-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describe.skipIf(!distExists)('yg context --file — typed view for a type-covered file (Step 3)', () => {
  it('shows the matched type, chain termination, applied and dropped rules, the derived-relations note, and the graduation next-step', () => {
    const dir = copyFixture();
    try {
      const { stdout, status } = run(['context', '--file', 'src/leaf/a.ts'], dir);
      expect(status).toBe(0);
      // The matched type.
      expect(stdout).toContain('Matched type: leaf');
      // The inherited chain, where and why it stops (leaf -> mid -> top, absent parents).
      expect(stdout).toMatch(/inherited rules stop at 'top' — no parents declared/);
      // A rule that DOES apply.
      expect(stdout).toContain('own-file-rule');
      // A rule attached to the type that does NOT apply, with its reason.
      expect(stdout).toContain('drafty');
      expect(stdout).toMatch(/drafty.*draft/);
      expect(stdout).toContain('never-here');
      // The derived-relations honesty note.
      expect(stdout).toMatch(/worked out from this file's own imports/);
      // The graduation next-step.
      expect(stdout).toMatch(/give this file a component of its own/);
      // The OLD not-covered text must be gone for this file.
      expect(stdout).not.toContain('This file is not covered by any node.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // src/unclassified/x.ts matches no architecture type's when: at all — this
  // task must not change its behavior: the real, live "no graph coverage"
  // error (not context-file.ts's own long-dead "This file is not covered by
  // any node." branch, which no build-context.ts call site has ever reached)
  // still fires, unchanged.
  it('an ordinary unmapped, unclassified file keeps today\'s "no graph coverage" error unchanged', () => {
    const dir = copyFixture();
    try {
      const { stderr, status } = run(['context', '--file', 'src/unclassified/x.ts'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('has no graph coverage.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
