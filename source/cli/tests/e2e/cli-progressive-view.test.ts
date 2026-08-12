import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgressiveFixture, type ProgressiveFixture } from '../support/progressive-fixture.js';

// ---------------------------------------------------------------------------
// Hermetic E2E for the read-only progressive VIEW line on `yg check`.
//
// The line reports how much of a run's issue set the current change is
// accountable for, measured against a committed reference branch. It is
// informational only in this build: no severity, no issue code, and no exit
// code moves because of it.
//
// Two things are pinned here, and the second is the one the whole feature
// rests on:
//   1. With a reference configured, the line appears above the report and its
//      counts split a real, hand-built situation correctly (one issue on the
//      file the branch edited, one pre-existing failure it never touched).
//   2. With the reference ABSENT, the run is byte-identical to what it was
//      before this feature existed — same report, same exit code — and with it
//      present, everything below the one added line still agrees byte for byte.
//
// No network / clock / random: the reviewer tier points at a loopback that is
// never dialed (the only rule is deterministic, so no reviewer is contacted).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const fixtures: ProgressiveFixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

function run(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Build the fixture, record the deterministic verdicts on the reference branch
 * (so `beta`'s TODO becomes a PRE-EXISTING refusal rather than a never-checked
 * pair), then cut a branch that edits `alpha`'s file only.
 */
function scaffoldBranchedRepo(label: string, progressiveReference?: string): ProgressiveFixture {
  const fixture = createProgressiveFixture({ label, progressiveReference });
  fixtures.push(fixture);
  const fill = run(['check', '--approve', '--only-deterministic'], fixture.dir);
  // beta's TODO refuses, so the fill's own report exits 1 — that is the point.
  expect(fill.status).toBe(1);
  fixture.branchWithEdit(
    'feature',
    'src/alpha/alpha.ts',
    'export const alpha = 1;\nexport const alphaAgain = 3;\n',
  );
  return fixture;
}

describe.skipIf(!distExists)('yg check — progressive view line', () => {
  it('prints the split above the report, counting only the issue the branch is accountable for', () => {
    const fixture = scaffoldBranchedRepo('view', 'main');
    const { status, stdout } = run(['check'], fixture.dir);

    // Three findings, split 2/1:
    //   IN SCOPE  — `alpha` has no current verdict, because this branch edited
    //               the very file its rule was recorded against.
    //   IN SCOPE  — the agent-rules digest warning every repo without installed
    //               rules artifacts gets. It names no rule, component or file,
    //               so nothing can prove the change did not reach it, and the
    //               conservative direction counts it in.
    //   OUTSIDE   — `beta`'s refusal, recorded on the reference branch and
    //               untouched by anything this branch did.
    const firstLine = stdout.split('\n')[0];
    expect(firstLine).toBe(
      'progressive view: 2 of 3 issue(s) within scope of main (1 outside) — gate unchanged in this build',
    );
    expect(stdout).toContain("alpha  aspect 'no-todo-comments'");
    expect(stdout).toContain('src/beta/beta.ts:1: TODO comment found');
    // The gate is untouched: the pre-existing refusal still fails the build.
    expect(status).toBe(1);
  });

  it('is absent, and changes nothing at all, when no reference is configured', () => {
    const fixture = scaffoldBranchedRepo('off', undefined);
    const { status, stdout } = run(['check'], fixture.dir);

    expect(stdout).not.toContain('progressive view:');
    expect(status).toBe(1);
  });

  it('feature-off parity: everything below the view line is byte-identical to a run without the reference', () => {
    const withReference = scaffoldBranchedRepo('parity-on', 'main');
    const withoutReference = scaffoldBranchedRepo('parity-off', undefined);

    const on = run(['check'], withReference.dir);
    const off = run(['check'], withoutReference.dir);

    expect(on.status).toBe(off.status);
    const onBelowViewLine = on.stdout.slice(on.stdout.indexOf('\n') + 1);
    expect(onBelowViewLine).toBe(off.stdout);
  });

  it('--full suppresses the view line without changing the report or the exit code', () => {
    const fixture = scaffoldBranchedRepo('full', 'main');

    const scoped = run(['check'], fixture.dir);
    const full = run(['check', '--full'], fixture.dir);

    expect(full.stdout).not.toContain('progressive view:');
    expect(full.status).toBe(scoped.status);
    expect(full.stdout).toBe(scoped.stdout.slice(scoped.stdout.indexOf('\n') + 1));
  });

  // The reference's committed verdict record is the only proof a verdict ever
  // existed there, so a change that DELETES entries from it has to be noticed.
  // That check is driven by the set of pairs that held a verdict at the
  // reference — and "the reference held none" and "the record could not be
  // read" are the same empty set. Reading one as the other would quietly switch
  // the check off, so an unreadable record must decline to say anything at all.
  // Both repos below are identical except for the bytes of that ONE file at the
  // reference; the branch restores a readable copy in both, so the run itself is
  // unaffected and the difference in output can only come from the reference.
  describe('an unreadable verdict record at the reference', () => {
    const READABLE = '{"version":1,"verdicts":{},"nodes":{}}\n';
    const LOCK = '.yggdrasil/yg-lock.nondeterministic.json';

    function scaffoldWithBaseRecord(label: string, atReference: string): ProgressiveFixture {
      const fixture = createProgressiveFixture({ label, progressiveReference: 'main' });
      fixtures.push(fixture);
      fixture.commit(LOCK, atReference);
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', 'export const alpha = 42;\n');
      // Leave both branches holding a readable record on disk, so the run
      // itself is identical and only the bytes AT THE REFERENCE differ. (When
      // the reference already holds the readable copy there is nothing to
      // restore, and git rightly refuses an empty commit.)
      if (atReference !== READABLE) fixture.commit(LOCK, READABLE);
      return fixture;
    }

    it('says nothing, where a readable-but-empty one measures normally', () => {
      const readable = scaffoldWithBaseRecord('base-readable', READABLE);
      const garbled = scaffoldWithBaseRecord('base-garbled', '{ this is not json');

      expect(run(['check'], readable.dir).stdout).toContain('progressive view:');
      expect(run(['check'], garbled.dir).stdout).not.toContain('progressive view:');
    });
  });

  it('a reference that does not resolve prints no line and still runs the full gate', () => {
    const fixture = scaffoldBranchedRepo('badref', 'no-such-branch');
    const { status, stdout } = run(['check'], fixture.dir);

    expect(stdout).not.toContain('progressive view:');
    expect(status).toBe(1);
  });
});
