/**
 * CLI E2E — the type-visibility surfaces. Spawns the real built
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
const CYCLIC_TYPE = path.join(BASE_FIXTURE, 'variants', 'cyclic-type');
const NEEDS_NODE_CONTEXT = path.join(BASE_FIXTURE, 'variants', 'needs-node-context');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function copyFixture(...overlays: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-e2e-type-visibility-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  for (const overlay of overlays) cpSync(overlay, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('yg check / yg context --file — type-visibility (E2E)', () => {
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

  // `yg owner --file` and `yg context --file` already tell the truth about a
  // type-covered file whose type's rules hit an implies cycle — they name the
  // cycle instead of claiming the file "satisfies coverage with no
  // enforcement". The whole-run surface (`yg check`) did not: before this
  // fix, src/cyclic/z.ts fell into the same zero-enforcement bucket as a file
  // whose type genuinely attaches nothing (src/ep/e.ts, the base fixture's
  // own 'emptyparents' type — no aspects declared at all), and the type's
  // only declared rule (cyclic-a) never appeared in the render at all. This
  // pins that `yg check` now tells the two apart, naming the cycle the same
  // way the per-file surfaces do, while a genuinely-zero-rule file keeps its
  // honest zero wording.
  it('yg check distinguishes an uncomputable rule set (implies cycle) from a genuinely empty one, naming the cycle', () => {
    const dir = copyFixture(CYCLIC_TYPE);
    try {
      const { stdout, status } = run(['check'], dir);
      expect(status).toBe(1); // aspect-implies-cycle keeps the run red — unaffected by this fix
      expect(stdout).toContain('aspect-implies-cycle');

      // The 'cyclic' per-type block names the cycle and its own declared rule
      // (cyclic-a) instead of rendering an unexplained "Enforced: (none)".
      expect(stdout).toMatch(/'cyclic' — 1 file covered: src\/cyclic\/z\.ts/);
      expect(stdout).toContain('Rules could not be worked out:');
      expect(stdout).toMatch(/src\/cyclic\/z\.ts.*implies cycle at 'cyclic-a'/);

      // The repo-wide rollup: cyclic-a's file is reported as unresolved, in
      // its OWN section — never inside the zero-applicable-rules sentence.
      expect(stdout).toContain('1 file matched by a type could not have its rules worked out:');
      const uncomputableIdx = stdout.indexOf('could not have its rules worked out');
      const uncomputableLine = stdout.slice(uncomputableIdx, stdout.indexOf('\n', uncomputableIdx + 1) + 200);
      expect(uncomputableLine).toContain('src/cyclic/z.ts');

      // The zero-applicable-rules sentence is now SINGULAR and names only the
      // genuinely-empty file — src/cyclic/z.ts must not appear under it, and
      // src/ep/e.ts (a real pin: its type declares no aspects at all) still
      // renders the plain, honest zero wording, unaffected by this fix.
      expect(stdout).toContain('1 file matched by a type has no rules that apply to it — it satisfies coverage with no enforcement:');
      const zeroIdx = stdout.indexOf('has no rules that apply to it');
      const zeroBlock = stdout.slice(zeroIdx, zeroIdx + 200);
      expect(zeroBlock).toContain('src/ep/e.ts');
      expect(zeroBlock).not.toContain('src/cyclic/z.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A rule whose check reads ctx.node unconditionally can never produce a
  // verdict on a component-free file — `yg check --approve` runs the check,
  // watches it runtime-error the same way every time, and its own post-fill
  // report must say so plainly, instead of a bare "unverified" caveat that
  // leaves the reader to guess why. A LATER, separate `yg check` (this run
  // never fills — fail-closed means no verdict was ever written) has nothing
  // to hand off and must fall back to that same qualified wording honestly.
  it('yg check --approve names a component-free disposition its own fill just watched happen; a later plain yg check falls back to the qualified wording', () => {
    const dir = copyFixture(NEEDS_NODE_CONTEXT);
    try {
      const approve = run(['check', '--approve', '--only-deterministic'], dir);
      // The fill-time notice (the runner's own typed disposition, real stderr progress).
      expect(approve.stderr).toContain(
        "check.mjs for aspect 'needs-node-context' accessed ctx.node.id, which is unavailable here.",
      );
      expect(approve.stdout).toMatch(
        /Enforced: needs-node-context \(1, 1 cannot run — it needs component context \(ctx\.node \/ ctx\.graph\) that a type-covered file does not have\)/,
      );
      // The 'crashy' block itself — never a bare "unverified" caveat, and
      // never ALSO an "Attached but not enforced" line for needs-node-context
      // (the file IS enforced; the base fixture's OTHER types legitimately
      // have their own unrelated "Attached but not enforced" sections).
      const crashyIdx = approve.stdout.indexOf("'crashy'");
      const nextBlockIdx = approve.stdout.indexOf("\n  '", crashyIdx + 1);
      const crashyBlock = approve.stdout.slice(crashyIdx, nextBlockIdx === -1 ? undefined : nextBlockIdx);
      expect(crashyBlock).not.toContain('1 unverified)');
      expect(crashyBlock).not.toContain('Attached but not enforced');

      // Fail-closed: the runtime error wrote nothing, so a later, separate
      // (never-filled) `yg check` has no disposition to hand off — the
      // qualified fallback, unchanged from before this handoff existed.
      const plain = run(['check'], dir);
      expect(plain.stdout).toContain('Enforced: needs-node-context (1, 1 unverified)');
      expect(plain.stdout).not.toContain('cannot run');
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
      expect(stdout).toMatch(/inherited rules stop at 'top' — it has no parent type to inherit from/);
      expect(stdout).toContain('own-file-rule');
      expect(stdout).toMatch(/worked out from this file's own imports/);
      expect(stdout).toMatch(/give this file a component of its own/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
