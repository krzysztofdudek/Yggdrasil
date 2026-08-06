/**
 * CLI E2E — the type-visibility surfaces. Spawns the real built
 * bin.js against tests/fixtures/type-level-engine/ (+ its zero-enforcement
 * variant), asserting the per-type block, the zero-applicable-rules honesty
 * line, and the `yg context --file` typed view — all from real stdout, no
 * in-process shortcuts.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
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

  // The type-coverage block's "1 cannot run" clause and the Errors section's
  // `unverified` group used to disagree about the SAME pair in the SAME
  // stdout: the block said the rule can never run, while the group's Fix
  // line and the footer's Next: line both still said "yg check --approve" —
  // an instruction an agent could follow forever without the count ever
  // moving. This pins that the run now agrees with itself: nowhere does it
  // point back at the command it just proved does nothing for this pair.
  it('the run that says a pair cannot run never also tells the reader to re-run --approve for that same pair', () => {
    const dir = copyFixture(NEEDS_NODE_CONTEXT);
    try {
      const first = run(['check', '--approve', '--only-deterministic'], dir);
      expect(first.status).toBe(1);
      expect(first.stdout).toMatch(/Enforced: needs-node-context \(1, 1 cannot run/);

      // Nowhere in this run's stdout does a Fix:/Next: line send the reader
      // back to the exact command this same run just proved reproduces the
      // identical result for src/crashy/a.ts.
      expect(first.stdout).not.toContain('Fix: yg check --approve');
      expect(first.stdout).not.toMatch(/Next: yg check --approve\b/);
      // The real remedy — the one and only unverified pair left after this
      // fill, so it also becomes the run's own top-level Next: line.
      expect(first.stdout).toMatch(/Next: Give the file a component of its own/);

      // Never persisted, never stale: re-running is byte-identical — the
      // same honest, self-consistent report every time, not a promise that
      // quietly stops being true on a second attempt.
      const second = run(['check', '--approve', '--only-deterministic'], dir);
      expect(second.stdout).toBe(first.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // `yg owner --file` used to print a flat "Enforced by its architecture
  // type, not by a component." with zero regard for whether the lock holds
  // any verdict at all — weaker than plain `yg check`, which at least says
  // "(1, 1 unverified)" for the identical pair. This pins that a cold,
  // never-filled project (no .yg-lock.deterministic.json on disk at all)
  // gets the same qualified caveat here.
  it('yg owner --file names a type-covered pair with no recorded lock entry, the same way plain yg check already does', () => {
    const dir = copyFixture(NEEDS_NODE_CONTEXT);
    try {
      const { stdout, status } = run(['owner', '--file', 'src/crashy/a.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('src/crashy/a.ts -> type:crashy');
      expect(stdout).toMatch(
        /Enforced by its architecture type, not by a component \(1 of 1 rule unverified — no valid verdict is currently on record for it\)\./,
      );

      // A DIFFERENT file whose rules will fill successfully (src/leaf/a.ts,
      // unrelated to this fixture's own crashy pair) carries the identical
      // caveat before any fill has ever run.
      const leafBefore = run(['owner', '--file', 'src/leaf/a.ts'], dir);
      expect(leafBefore.stdout).toMatch(/\(\d+ of \d+ rules? unverified — no valid verdict is currently on record for (?:it|them)\)/);

      const approve = run(['check', '--approve', '--only-deterministic'], dir);
      expect(approve.status).toBe(1); // still red overall (unrelated fixture issues) — not the concern here

      // src/crashy/a.ts's own pair fails closed every attempt — its check.mjs
      // reads ctx.node unconditionally, a structurally impossible ask for a
      // component-free file — fail-closed means no verdict is EVER written
      // for it, so the caveat still names it after a real --approve attempt.
      const crashyAfter = run(['owner', '--file', 'src/crashy/a.ts'], dir);
      expect(crashyAfter.stdout).toContain('1 of 1 rule unverified — no valid verdict is currently on record for it');

      // src/leaf/a.ts's rules DID fill successfully — the caveat disappears
      // entirely once every one of them has a recorded verdict, never a
      // stale claim after the lock genuinely catches up, and byte-identical
      // to the pre-caveat wording once it does.
      const leafAfter = run(['owner', '--file', 'src/leaf/a.ts'], dir);
      expect(leafAfter.stdout).toContain('Enforced by its architecture type, not by a component.\n');
      expect(leafAfter.stdout).not.toContain('unverified');
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

  // The caveat above only ever checked whether the lock held AN entry at
  // all — a present entry whose recorded verdict no longer matches the
  // file's current bytes read as clean, the exact silent staleness a
  // per-file honesty caveat exists to catch. This drives one pair from
  // missing, through a real fill that records a valid verdict, to STALE
  // again after a plain source edit with no re-approve — and checks that
  // `yg owner --file` and `yg context --file` both name it unverified at
  // every one of those three moments, the same way plain `yg check` does,
  // not only at the first.
  it('yg owner --file and yg context --file also name a STALE lock entry, not only a missing one', () => {
    const dir = copyFixture(NEEDS_NODE_CONTEXT);
    try {
      // Before any fill: no entry at all.
      const ownerCold = run(['owner', '--file', 'src/leaf/a.ts'], dir);
      expect(ownerCold.stdout).toMatch(/\(\d+ of \d+ rules? unverified — no valid verdict is currently on record for (?:it|them)\)/);
      const contextCold = run(['context', '--file', 'src/leaf/a.ts'], dir);
      expect(contextCold.stdout).toMatch(/own-file-rule \[enforced, unverified\] —/);

      // A real fill genuinely writes a valid verdict for every one of
      // src/leaf/a.ts's own rules (all deterministic — --only-deterministic
      // fills every one of them; unrelated to src/crashy/a.ts's own
      // permanent failure, which keeps the overall run red).
      const approve = run(['check', '--approve', '--only-deterministic'], dir);
      expect(approve.status).toBe(1);
      const ownerFilled = run(['owner', '--file', 'src/leaf/a.ts'], dir);
      expect(ownerFilled.stdout).toContain('Enforced by its architecture type, not by a component.\n');
      const contextFilled = run(['context', '--file', 'src/leaf/a.ts'], dir);
      expect(contextFilled.stdout).toMatch(/own-file-rule \[enforced\] —/);
      expect(contextFilled.stdout).not.toContain('unverified');

      // A plain source edit, no re-approve: the lock still holds an entry
      // for every one of this file's rules, but none of them match the
      // file's current bytes any more — STALE, not missing. Plain `yg
      // check` already calls this "unverified" for the identical pair; the
      // per-file surfaces must agree, not read the mere presence of an
      // entry as proof it is still current.
      writeFileSync(path.join(dir, 'src', 'leaf', 'a.ts'), 'export const a = 2; // edited after approve\n');
      const plainAfterEdit = run(['check'], dir);
      const leafIdx = plainAfterEdit.stdout.indexOf("'leaf'");
      const nextBlockIdx = plainAfterEdit.stdout.indexOf("\n  '", leafIdx + 1);
      const leafBlock = plainAfterEdit.stdout.slice(leafIdx, nextBlockIdx === -1 ? undefined : nextBlockIdx);
      expect(leafBlock).toContain('unverified');

      const ownerStale = run(['owner', '--file', 'src/leaf/a.ts'], dir);
      expect(ownerStale.stdout).toMatch(/\(\d+ of \d+ rules? unverified — no valid verdict is currently on record for (?:it|them)\)/);
      const contextStale = run(['context', '--file', 'src/leaf/a.ts'], dir);
      expect(contextStale.stdout).toMatch(/own-file-rule \[enforced, unverified\] —/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
