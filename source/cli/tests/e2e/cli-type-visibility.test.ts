/**
 * CLI E2E — the type-visibility surfaces. Spawns the real built
 * bin.js against tests/fixtures/type-level-engine/ (+ its zero-enforcement
 * variant), asserting the per-type block, the zero-applicable-rules honesty
 * line, and the `yg context --file` typed view — all from real stdout, no
 * in-process shortcuts.
 *
 * Every assertion about the per-type listing runs `yg check --coverage`:
 * since 6.0.0 the listing is rendered only when asked for by name. The first
 * describe block below pins the other half of that contract — what a plain
 * `yg check` must NOT print, and that the verdict, the header counts and the
 * exit code are the same either way.
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

/** The distinctive lines of the per-type coverage listing — nothing but `--coverage` may print any of them. */
const LISTING_MARKERS = [
  'Type coverage:',
  ' file covered:',
  ' files covered:',
  'Enforced:',
  'Attached but not enforced',
  'matched by a type',
  'inherited rules stop at',
];

/** The verdict line — the first line of the report, PASS/FAIL plus every header count. */
function verdictLine(out: string): string {
  return out.split('\n')[0];
}

describe.skipIf(!distExists)('yg check — the coverage listing is asked for by name (E2E)', () => {
  // The reversal 050 exists for: on a repo with many classifying types the
  // per-type listing was the bulk of every run's output, green or not, so the
  // verdict and the warnings sat under a wall of paths. It is the same report
  // as before minus that enumeration — never a different verdict, never a
  // different count, never a different exit code.
  it('plain yg check prints no coverage listing at all, while --coverage prints it — same verdict, same header counts, same exit code', () => {
    const dir = copyFixture(ZERO_ENFORCEMENT);
    try {
      const plain = run(['check'], dir);
      const withCoverage = run(['check', '--coverage'], dir);

      for (const marker of LISTING_MARKERS) {
        expect(plain.stdout).not.toContain(marker);
        expect(withCoverage.stdout).toContain(marker);
      }
      // The zero-enforcement roll-up and its file samples travel with it —
      // both halves of the listing move behind the flag together.
      expect(plain.stdout).not.toContain('satisfy coverage with no enforcement');
      expect(plain.stdout).not.toContain('src/ep/e2.ts');
      expect(withCoverage.stdout).toMatch(/2 files matched by a type have no rules that apply to them/);

      // What must NOT move: the verdict line (which carries every header
      // count), the exit code, and the single Next: line.
      expect(verdictLine(plain.stdout)).toBe(verdictLine(withCoverage.stdout));
      expect(plain.status).toBe(withCoverage.status);
      const nextOf = (out: string): string | undefined => out.split('\n').find((l) => l.startsWith('Next: '));
      expect(nextOf(plain.stdout)).toBe(nextOf(withCoverage.stdout));

      // The plain report is not empty of content — it still carries what the
      // run found. Dropping the listing must not drop the findings with it.
      expect(plain.stdout).toMatch(/Errors \(\d+\)|Warnings \(\d+\)|PASS/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --summary is the narrowest read-only view there is; it used to carry one
  // counter line per type ahead of its own body, which on a 20-type repo is a
  // 21-line wall in the view whose entire purpose is not having one.
  it('--summary carries no per-type listing — not even the counts-only form', () => {
    const dir = copyFixture(ZERO_ENFORCEMENT);
    try {
      const { stdout } = run(['check', '--summary'], dir);
      for (const marker of LISTING_MARKERS) expect(stdout).not.toContain(marker);
      expect(stdout).not.toMatch(/rules? enforced/);
      expect(stdout).not.toMatch(/attached-but-not-enforced instance/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The gate lane runs `yg check --approve --only-deterministic`, and the view
  // flags are refused there by design — so before 050 the writer path had no
  // route to a short report at all. It inherits the new default instead, and
  // --coverage is legal on it when someone does want the listing (proved by
  // the --approve tests further down, which read the listing from exactly
  // that command).
  it('--approve --only-deterministic, with no view flag, inherits the concise default', () => {
    const dir = copyFixture(ZERO_ENFORCEMENT);
    try {
      const { stdout } = run(['check', '--approve', '--only-deterministic'], dir);
      for (const marker of LISTING_MARKERS) expect(stdout).not.toContain(marker);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --details is the OTHER axis: how issue blocks are grouped. 050 left it
  // exactly as it was, so it must behave like the default here — concise
  // without --coverage, full with it.
  it('--details keeps its own meaning: no listing on its own, the full listing with --coverage', () => {
    const dir = copyFixture(ZERO_ENFORCEMENT);
    try {
      const alone = run(['check', '--details'], dir);
      const withCoverage = run(['check', '--details', '--coverage'], dir);
      for (const marker of LISTING_MARKERS) {
        expect(alone.stdout).not.toContain(marker);
        expect(withCoverage.stdout).toContain(marker);
      }
      expect(alone.status).toBe(withCoverage.status);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--coverage with --json is refused, naming what the document already carries', () => {
    const dir = copyFixture();
    try {
      const { stderr, status } = run(['check', '--coverage', '--json'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('--coverage cannot be combined with --json.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!distExists)('yg check / yg context --file — type-visibility (E2E)', () => {
  it('yg check --coverage shows the per-type block, a half-expanded bundle, and one fork chain-termination line', () => {
    const dir = copyFixture();
    try {
      const { stdout, status } = run(['check', '--coverage'], dir);
      expect([0, 1]).toContain(status); // may FAIL on unrelated fixture issues; the render surface is what's pinned
      expect(stdout).toContain('Type coverage:');
      expect(stdout).toMatch(/bundle: file-level part applies; whole-unit part needs a component/);
      expect(stdout.match(/inherited rules stop at a fork \(mid \| top\)/g)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yg check --coverage shows the zero-applicable-rules honesty line with samples', () => {
    const dir = copyFixture(ZERO_ENFORCEMENT);
    try {
      const { stdout } = run(['check', '--coverage'], dir);
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
  it('yg check --coverage distinguishes an uncomputable rule set (implies cycle) from a genuinely empty one, naming the cycle', () => {
    const dir = copyFixture(CYCLIC_TYPE);
    try {
      const { stdout, status } = run(['check', '--coverage'], dir);
      expect(status).toBe(1); // aspect-implies-cycle keeps the run red — unaffected by this fix
      expect(stdout).toContain('aspect-implies-cycle');

      // The fault itself is never behind the flag: a plain run still fails,
      // still names the cycle as its blocking error, and still says so in its
      // Next: line. Only the per-type enumeration of the files it reaches
      // needs --coverage.
      const plain = run(['check'], dir);
      expect(plain.status).toBe(1);
      expect(plain.stdout).toContain('aspect-implies-cycle');
      expect(plain.stdout).not.toContain('Rules could not be worked out:');

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
  //
  // This is also the pin that --coverage is LEGAL on the writer path, which is
  // the whole reason it is its own axis rather than a fifth view flag: the
  // fill-only "cannot run" reason exists nowhere else, so a coverage flag the
  // writer refused would put it permanently out of reach.
  it('yg check --approve --coverage names a component-free disposition its own fill just watched happen; a later plain yg check --coverage falls back to the qualified wording', () => {
    const dir = copyFixture(NEEDS_NODE_CONTEXT);
    try {
      const approve = run(['check', '--approve', '--only-deterministic', '--coverage'], dir);
      expect(approve.status).toBe(1); // the fill runs and the run stays red — the flag widens the report, it never touches the verdict
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
      const plain = run(['check', '--coverage'], dir);
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
      const first = run(['check', '--approve', '--only-deterministic', '--coverage'], dir);
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
      const second = run(['check', '--approve', '--only-deterministic', '--coverage'], dir);
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
      const plainAfterEdit = run(['check', '--coverage'], dir);
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
