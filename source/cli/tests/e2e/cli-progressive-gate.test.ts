import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgressiveFixture, type ProgressiveFixture } from '../support/progressive-fixture.js';

// ---------------------------------------------------------------------------
// Hermetic E2E for the progressive GATE on `yg check`, driven through the real
// built binary over throwaway git repositories.
//
// The gate's promise: once a project names a reference branch, a run errors
// only for what its change is accountable for, and everything else it inherits
// is still named, still counted, and no longer blocking. Every state the
// command can land in gets its own case below, because the interesting failure
// mode of a feature like this is not a wrong number — it is a state nobody
// thought about resolving quietly green.
//
// Two cases carry more weight than the rest:
//   - the reference cannot be resolved: the whole project is gated and the run
//     says so out loud, rather than scoping against a guess;
//   - a project that never opted in: byte-identical to the whole-project gate,
//     compared as two real runs rather than by exit code.
//
// No network / clock / random: the reviewer tier points at a loopback that is
// never dialed (every rule here is deterministic, so no reviewer is contacted).
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

/** The header line — the first line of every report, in every view. */
const headerOf = (stdout: string): string => stdout.split('\n')[0];

/** Everything the report prints under Errors, up to the warnings subheader. */
function errorSection(stdout: string): string {
  const from = stdout.indexOf('Errors (');
  if (from < 0) return '';
  const to = stdout.indexOf('Warnings (');
  return to < 0 ? stdout.slice(from) : stdout.slice(from, to);
}

/** Everything the report prints under Warnings. */
function warningSection(stdout: string): string {
  const from = stdout.indexOf('Warnings (');
  return from < 0 ? '' : stdout.slice(from);
}

/** The violation line each component's TODO produces, as the report prints it. */
const TODO_IN = (dir: string): string => `src/${dir}/${dir}.ts:1: TODO comment found`;

/**
 * A fixture whose reference branch already holds recorded deterministic
 * verdicts — so `beta`'s TODO is a PRE-EXISTING refusal rather than a pair
 * nobody has ever looked at. Everything downstream measures against that.
 */
function scaffoldReference(label: string, progressiveReference?: string): ProgressiveFixture {
  const fixture = createProgressiveFixture({ label, progressiveReference });
  fixtures.push(fixture);
  // beta's TODO refuses, so the recording run's own report exits 1 — the point
  // of the fixture, not a failure of it.
  expect(run(['check', '--approve', '--only-deterministic'], fixture.dir).status).toBe(1);
  return fixture;
}

/** The edit a branch makes to `alpha` when the point is that it is CLEAN. */
const CLEAN_EDIT = 'export const alpha = 1;\nexport const alphaAgain = 3;\n';
/** The edit a branch makes to `alpha` when the point is that it VIOLATES the rule. */
const VIOLATING_EDIT = '// TODO: introduced by this very change.\nexport const alpha = 1;\n';

describe.skipIf(!distExists)('yg check — the progressive gate', () => {
  it('blocks when the change violates an enforced rule in a file it touched', () => {
    const fixture = scaffoldReference('violates', 'main');
    fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', VIOLATING_EDIT);
    // Record the branch's own verdicts first, exactly as a CI run does before
    // the gate: without it the new content is merely unreviewed, and the case
    // would prove the gate blocks on a missing verdict rather than on a real
    // refusal the change caused.
    run(['check', '--approve', '--only-deterministic'], fixture.dir);

    const { status, stdout } = run(['check'], fixture.dir);

    expect(status).toBe(1);
    expect(headerOf(stdout)).toContain('yg check: FAIL');
    // The refusal the change caused blocks…
    expect(errorSection(stdout)).toContain(TODO_IN('alpha'));
    // …while the one it inherited is reported beside it without blocking.
    expect(warningSection(stdout)).toContain(TODO_IN('beta'));
  });

  it('does not block for a violation already on the reference that the change never reached', () => {
    const fixture = scaffoldReference('inherited', 'main');
    fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);
    run(['check', '--approve', '--only-deterministic'], fixture.dir);

    const { status, stdout } = run(['check'], fixture.dir);

    expect(status).toBe(0);
    expect(headerOf(stdout)).toContain('yg check: PASS');
    // Named and counted, never hidden: the inherited refusal keeps its full
    // violation text, one warning among the run's warnings.
    expect(warningSection(stdout)).toContain(TODO_IN('beta'));
    expect(stdout).toContain('Warnings (2)');
    expect(errorSection(stdout)).toBe('');
    // The header names what the change was measured against and how much of it
    // there was, so the count above can be read against something.
    expect(headerOf(stdout)).toContain('1 obligation outside your changes vs main (1 changed input)');
    // And the single next step is the audit, never a repo-wide review of debt
    // this change did not cause.
    expect(stdout).toContain("1 enforced obligation(s) outside your changes — run 'yg check --full' for the complete audit");
  });

  it('blocks again on the same branch when the whole project is asked for', () => {
    const fixture = scaffoldReference('full-audit', 'main');
    fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);
    run(['check', '--approve', '--only-deterministic'], fixture.dir);

    const scoped = run(['check'], fixture.dir);
    const full = run(['check', '--full'], fixture.dir);

    expect(scoped.status).toBe(0);
    expect(full.status).toBe(1);
    expect(errorSection(full.stdout)).toContain(TODO_IN('beta'));
    // Asking for everything drops the measurement entirely — there is no scope
    // left to report.
    expect(headerOf(full.stdout)).not.toContain('outside your changes');
  });

  it('is quiet on a clean checkout of the reference: nothing in scope', () => {
    const fixture = scaffoldReference('clean-reference', 'main');

    const { status, stdout, stderr } = run(['check'], fixture.dir);

    expect(status).toBe(0);
    expect(headerOf(stdout)).toContain('nothing in scope; 1 obligation outside your changes vs main');
    expect(stderr).toBe('');
  });

  it('reads a branch that commits and then reverts exactly like a clean checkout', () => {
    const fixture = scaffoldReference('round-trip', 'main');
    fixture.branchWithEdit('round-trip', 'src/alpha/alpha.ts', CLEAN_EDIT);
    // Back to the reference's exact content, in a second commit — history
    // diverged and came back. Nothing is different; only the path taken is.
    fixture.commit('src/alpha/alpha.ts', 'export const alpha = 1;\n');

    const { status, stdout, stderr } = run(['check'], fixture.dir);

    expect(status).toBe(0);
    expect(headerOf(stdout)).toContain('nothing in scope; 1 obligation outside your changes vs main');
    // Specifically NOT read as a failure to enumerate the change: that would
    // gate the whole project and say so.
    expect(stderr).toBe('');
  });

  it('gates the whole project, loudly, when the reference cannot be resolved', () => {
    // The shape a shallow CI checkout produces: the named branch was never
    // fetched, so there is no common ancestor to measure against.
    const fixture = scaffoldReference('missing-reference', 'origin/main');
    fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);
    run(['check', '--approve', '--only-deterministic'], fixture.dir);

    const { status, stdout, stderr } = run(['check'], fixture.dir);

    // Everything is gated: the inherited refusal blocks again.
    expect(status).toBe(1);
    expect(errorSection(stdout)).toContain(TODO_IN('beta'));
    expect(headerOf(stdout)).not.toContain('outside your changes');
    // …and the run says which state it was in, why that is the outcome, and
    // what to do about it.
    expect(stderr).toContain('whole project');
    expect(stderr).toContain('likely does not exist or was never fetched');
    expect(stderr).toContain('progressive.reference');
    expect(stderr).toContain('yg check --full');
  });

  it('is byte-identical to the whole-project gate when the project never opted in', () => {
    // The feature-off guarantee, proved as two real runs rather than by exit
    // code: the whole-project gate IS what this command did before progressive
    // mode existed, and a project carrying no reference must produce exactly
    // it — same bytes on both streams, same exit code. The two repositories
    // differ in nothing but that one configuration block.
    const off = scaffoldReference('parity-off', undefined);
    const on = scaffoldReference('parity-on', 'main');
    off.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);
    on.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);

    const bare = run(['check'], off.dir);
    const audit = run(['check', '--full'], on.dir);

    expect(bare.stdout).toBe(audit.stdout);
    expect(bare.stderr).toBe(audit.stderr);
    expect(bare.status).toBe(audit.status);
  });

  it('changes nothing when the whole project is asked for and none was configured', () => {
    const fixture = scaffoldReference('full-noop', undefined);
    fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);

    const bare = run(['check'], fixture.dir);
    const full = run(['check', '--full'], fixture.dir);

    expect(full.stdout).toBe(bare.stdout);
    expect(full.stderr).toBe(bare.stderr);
    expect(full.status).toBe(bare.status);
  });

  // The record committed at the reference is the only proof a verdict ever
  // existed there, so a change that DELETES entries from it has to be noticed.
  // The scope engine is told which obligations held a verdict at the reference
  // — and "the reference held none" and "the record could not be read" are the
  // same empty set. Reading one as the other would quietly switch that check
  // off, so an unreadable record must gate the whole project instead.
  describe('an unreadable verdict record at the reference', () => {
    const READABLE = '{"version":1,"verdicts":{},"nodes":{}}\n';
    const LOCK = '.yggdrasil/yg-lock.nondeterministic.json';

    function scaffoldWithBaseRecord(label: string, atReference: string): ProgressiveFixture {
      const fixture = scaffoldReference(label, 'main');
      fixture.commit(LOCK, atReference);
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);
      // Both branches end holding a readable record on disk, so the run itself
      // is identical and only the bytes AT THE REFERENCE differ. (When the
      // reference already holds the readable copy there is nothing to restore,
      // and git rightly refuses an empty commit.)
      if (atReference !== READABLE) fixture.commit(LOCK, READABLE);
      return fixture;
    }

    it('measures normally against a readable-but-empty record', () => {
      const readable = scaffoldWithBaseRecord('base-readable', READABLE);
      expect(headerOf(run(['check'], readable.dir).stdout)).toContain('outside your changes vs main');
    });

    it('gates the whole project when the record at the reference is unparseable', () => {
      const garbled = scaffoldWithBaseRecord('base-garbled', '{ this is not json');
      const { stdout, stderr } = run(['check'], garbled.dir);
      expect(headerOf(stdout)).not.toContain('outside your changes');
      expect(stderr).toContain('whole project');
    });

    it('gates the whole project when the record at the reference was there but EMPTY', () => {
      // The case a test on the content alone gets wrong: a file that was never
      // committed and one that was committed and then truncated read back
      // identically — as nothing — and the second is a record whose entries
      // this change destroyed.
      const emptied = scaffoldWithBaseRecord('base-emptied', '');
      const { stdout, stderr } = run(['check'], emptied.dir);
      expect(headerOf(stdout)).not.toContain('outside your changes');
      expect(stderr).toContain('whole project');
    });

    it('measures normally when the record was simply never committed at the reference', () => {
      // The other side of the same coin, and why an empty read cannot simply
      // be refused: a project that never recorded a reviewer verdict has no
      // such file at all, and that absence IS provable.
      const never = scaffoldReference('base-absent', 'main');
      never.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);
      expect(headerOf(run(['check'], never.dir).stdout)).toContain('outside your changes vs main');
    });
  });

  // A consequence of the scope engine that looks like a bug and is not: a
  // component is re-gated WHOLE when a change reaches it — including through
  // another component's declaration — and "whole" includes its log. So a log
  // finding a project has been carrying can start blocking on a branch that
  // never touched that component's own files. This case exists so the next
  // person to meet it finds it written down rather than filing it.
  describe('a component reached through another component’s declaration', () => {
    /**
     * A repository where `alpha`'s source has moved past the entry its log
     * records — a refusal already sitting on the reference — and where `alpha`
     * declares a relation to `beta`, so a change to BETA's declaration reaches
     * alpha without touching a single file of alpha's own.
     */
    function scaffoldDriftedLog(label: string): ProgressiveFixture {
      const fixture = createProgressiveFixture({
        label,
        progressiveReference: 'main',
        logRequired: true,
        alphaRelatesToBeta: true,
      });
      fixtures.push(fixture);
      run(['log', 'add', '--node', 'alpha', '--reason', 'First entry, recorded before anything moved.'], fixture.dir);
      run(['log', 'add', '--node', 'beta', '--reason', 'First entry, recorded before anything moved.'], fixture.dir);
      // A full recording run, not the deterministic-only one: only that records
      // the log baseline every later drift is measured against.
      run(['check', '--approve'], fixture.dir);
      fixture.commitAll('record the log baselines');
      // Now move alpha's source ON THE REFERENCE with no accompanying entry —
      // the debt every branch below inherits.
      fixture.commit('src/alpha/alpha.ts', 'export const alpha = 1;\nexport const drifted = 7;\n');
      return fixture;
    }

    it('inherits the log refusal without blocking when the change stays away from it', () => {
      const fixture = scaffoldDriftedLog('log-inherited');
      fixture.branchWithEdit('unrelated', 'notes.md', '# notes\n');

      const { status, stdout } = run(['check'], fixture.dir);

      expect(status).toBe(0);
      expect(warningSection(stdout)).toContain("No fresh log entry for node 'alpha'");
    });

    it('blocks on that same log refusal once the change reaches the component', () => {
      const fixture = scaffoldDriftedLog('log-reached');
      fixture.branchWithEdit(
        'declaration',
        '.yggdrasil/model/beta/yg-node.yaml',
        fixture.nodeDeclaration('beta', 'The beta service — reworded on this branch, nothing else.'),
      );

      const { status, stdout } = run(['check'], fixture.dir);

      // Intended, not incidental: reaching a component re-gates everything it
      // answers for, its log included.
      expect(status).toBe(1);
      expect(errorSection(stdout)).toContain("No fresh log entry for node 'alpha'");
    });
  });
});
