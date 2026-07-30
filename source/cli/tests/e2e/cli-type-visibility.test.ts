/**
 * CLI E2E — the type-visibility surfaces (Step 6). Spawns the real built
 * bin.js against tests/fixtures/type-level-engine/ (+ its zero-enforcement
 * variant), asserting the per-type block, the zero-applicable-rules honesty
 * line, and the `yg context --file` typed view — all from real stdout, no
 * in-process shortcuts.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const ZERO_ENFORCEMENT = path.join(BASE_FIXTURE, 'variants', 'zero-enforcement');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', status: r.status };
}

function copyFixture(...overlays: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-type-visibility-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  for (const overlay of overlays) cpSync(overlay, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('yg check / yg context --file — type-visibility (Step 6, E2E)', () => {
  it('yg check shows the per-type block, a half-expanded bundle, and one fork chain-termination line', () => {
    const dir = copyFixture();
    try {
      const { stdout, status } = run(['check'], dir);
      expect([0, 1]).toContain(status); // may FAIL on unrelated fixture issues; the render surface is what's pinned
      expect(stdout).toContain('Type coverage:');
      expect(stdout).toMatch(/bundle: file-level part applies; whole-unit part needs a component/);
      expect(stdout.match(/inherited rules stop at a fork \(mid \| top\)/g)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yg check shows the zero-applicable-rules honesty line with samples', () => {
    const dir = copyFixture(ZERO_ENFORCEMENT);
    try {
      const { stdout } = run(['check'], dir);
      expect(stdout).toMatch(/2 files matched by a type have no rules that apply to them/);
      expect(stdout).toContain('src/ep/e.ts');
      expect(stdout).toContain('src/ep/e2.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yg context --file on a type-covered file shows the typed view, replacing "not covered"', () => {
    const dir = copyFixture();
    try {
      const { stdout, status } = run(['context', '--file', 'src/leaf/a.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Matched type: leaf');
      expect(stdout).toMatch(/inherited rules stop at 'top' — no parents declared/);
      expect(stdout).toContain('own-file-rule');
      expect(stdout).toMatch(/worked out from this file's own imports/);
      expect(stdout).toMatch(/give this file a component of its own/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
