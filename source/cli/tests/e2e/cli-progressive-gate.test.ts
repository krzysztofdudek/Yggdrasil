import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

/** The local, gitignored file a deterministic recording run writes its verdicts to. */
function recordedVerdicts(dir: string): string {
  return readFileSync(path.join(dir, '.yggdrasil', '.yg-lock.deterministic.json'), 'utf-8');
}

/**
 * A fixture whose reference branch already holds recorded deterministic
 * verdicts — so `beta`'s TODO is a PRE-EXISTING refusal rather than a pair
 * nobody has ever looked at. Everything downstream measures against that.
 *
 * The state is asserted through the RECORD the run wrote, not through its exit
 * code, because the exit code is no longer a property of the fixture: recording
 * is whole-project (it is free), but the report a recording run prints is
 * measured like any other, so this run reports beta's refusal as blocking on a
 * project that names no reference and as inherited on one that does. The record
 * is the same either way, and it is what every case below builds on.
 */
function scaffoldReference(label: string, progressiveReference?: string): ProgressiveFixture {
  const fixture = createProgressiveFixture({ label, progressiveReference });
  fixtures.push(fixture);
  run(['check', '--approve', '--only-deterministic'], fixture.dir);
  expect(recordedVerdicts(fixture.dir)).toContain('no-todo-comments');
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
    // It also reads as the SAME kind of finding it would have been, with one
    // phrase saying whose business it is — never as a raw internal code.
    expect(warningSection(stdout)).toContain('enforced (outside changes)');
    expect(stdout).not.toContain('aspect-violation-enforced-outside');
    expect(errorSection(stdout)).toBe('');
    // The header names what the change was measured against and how much of it
    // there was, so the count above can be read against something.
    expect(headerOf(stdout)).toContain('1 obligation outside your changes vs main (1 changed input)');
    // And the single next step is the audit, never a repo-wide review of debt
    // this change did not cause.
    expect(stdout).toContain("1 enforced obligation(s) outside your changes — run 'yg check --full' for the complete audit");
    // The classifier leaves messageData untouched, so a twin's own `next` still
    // names its mirror's remedy verbatim — here, the deterministic refusal's
    // "Fix the listed violations" text. Printing it would mislead: this
    // finding is a warning specifically because the change did not reach it,
    // and the run's own next step above already names the honest one. The
    // renderer suppresses the line rather than repeat it — the SAME block, in
    // full, minus only that one line.
    const twinBlock = warningSection(stdout);
    expect(twinBlock).toContain(
      "enforced (outside changes)  1 pairs  1 nodes  aspect 'no-todo-comments'\n"
      + '            A deterministic check recorded these violations. The result is cached — the same inputs reproduce the same verdict, so the check is not re-run.\n'
      + '            - beta  Violations:\n',
    );
    expect(twinBlock).toContain(TODO_IN('beta'));
    expect(twinBlock).not.toContain('Fix the listed violations');
  });

  // Among warnings, an inherited (`-outside`) finding sorts last regardless of
  // its own label — never merely tied with an ordinary warning and left to
  // alphabetical order. Proved with NO extra fixture setup: every fixture here
  // ships with no installed agent-rules digest, so `rules-digest-stale` is a
  // genuine, unrelated warning present on every run, and its label
  // ('rules-digest-stale', 'r') sorts AFTER the twin's own label ('enforced
  // (outside changes)', 'e') — so a pure alphabetical tie-break (the pre-fix
  // behavior) would have rendered the inherited debt FIRST, ahead of a warning
  // this run is genuinely responsible for.
  it('sorts a genuine warning ahead of an inherited twin even when the twin\'s own label would sort first', () => {
    const fixture = scaffoldReference('warning-subrank', 'main');
    fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);
    run(['check', '--approve', '--only-deterministic'], fixture.dir);

    const { stdout } = run(['check'], fixture.dir);

    const warnings = warningSection(stdout);
    const genuineAt = warnings.indexOf('rules-digest-stale');
    const twinAt = warnings.indexOf('enforced (outside changes)');
    expect(genuineAt).toBeGreaterThan(-1);
    expect(twinAt).toBeGreaterThan(-1);
    expect(genuineAt).toBeLessThan(twinAt);
  });

  // The `unverified-outside` shape (as opposed to `aspect-violation-enforced-
  // outside`, exercised above): a pair the reference never reviewed at all,
  // inherited unchanged. `scaffoldReference` always pre-fills the reference via
  // `--approve --only-deterministic`, which leaves nothing unverified there —
  // so this scaffolds the reference WITHOUT that fill, leaving both alpha's and
  // beta's pairs unverified at the reference. Touching only alpha keeps its
  // pair blocking (a real `unverified` error) while beta's becomes the twin —
  // the shape LABEL_GLOSS's twin entry and the --summary/--aspect/--top
  // disclosures below all exist for.
  describe('the unverified-outside shape, across every triage view', () => {
    function scoped(label: string): ProgressiveFixture {
      const fixture = createProgressiveFixture({ label, progressiveReference: 'main' });
      fixtures.push(fixture);
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);
      return fixture;
    }

    it('default view: glosses the twin like its mirror and omits its Fix: line', () => {
      const fixture = scoped('unverified-outside-full');
      const { status, stdout } = run(['check'], fixture.dir);

      // alpha's own pair is genuinely unverified AND touched — still blocks.
      expect(status).toBe(1);
      expect(errorSection(stdout)).toContain('Fix: yg check --approve');
      // beta's pair is the SAME kind of finding, glossed the same way, marked
      // as outside the change — and with no Fix: line repeating a command
      // that would, for this one finding, review the whole project.
      expect(warningSection(stdout)).toContain(
        'unverified (not yet reviewed) (outside changes)  1 pairs  1 nodes\n'
        + '            The lock holds no entry for this pair, or its inputs changed since the verdict was recorded (source edit, aspect edit, or a fill that did not complete). A verdict is valid only while its inputs hash to the stored value.\n'
        + "            - beta  aspect 'no-todo-comments'\n",
      );
    });

    it('--summary gives the inherited pair its own bucket, never "other"', () => {
      const fixture = scoped('unverified-outside-summary');
      const { stdout } = run(['check', '--summary'], fixture.dir);

      expect(stdout).toMatch(/\balpha\s+1 unverified \(1 deterministic-free, 0 LLM\), 0 refused\n/);
      expect(stdout).toMatch(/\bbeta\s+0 unverified \(0 deterministic-free, 0 LLM\), 0 refused, 1 outside changes\n/);
      expect(stdout).not.toMatch(/\bbeta\s+.*\bother\b/);
    });

    it('--aspect reprints the progressive segment the plain header carries, and keeps both pairs visible', () => {
      const fixture = scoped('unverified-outside-aspect');
      const { stdout } = run(['check', '--aspect', 'no-todo-comments'], fixture.dir);

      const headerLine = headerOf(stdout);
      expect(headerLine).toContain("aspect 'no-todo-comments'");
      // Same computation the plain header uses — not a second, aspect-scoped
      // tally: one changed input (alpha), one obligation outside it (beta).
      expect(headerLine).toContain('1 obligation outside your changes vs main (1 changed input)');
      // Both pairs are visible: alpha's own blocking pair keeps its Fix line…
      expect(errorSection(stdout)).toContain('Fix: yg check --approve');
      // …beta's inherited pair reads the same way minus that line.
      expect(warningSection(stdout)).toContain(
        'unverified (not yet reviewed) (outside changes)  1 pairs  1 nodes\n'
        + '            The lock holds no entry for this pair, or its inputs changed since the verdict was recorded (source edit, aspect edit, or a fill that did not complete). A verdict is valid only while its inputs hash to the stored value.\n'
        + "            - beta  aspect 'no-todo-comments'\n",
      );
    });

    it('--top surfaces the same outside disclosure as the default view', () => {
      const fixture = scoped('unverified-outside-top');
      const { stdout } = run(['check', '--top', '5'], fixture.dir);

      expect(warningSection(stdout)).toContain('unverified (not yet reviewed) (outside changes)');
      expect(warningSection(stdout)).toContain("- beta  aspect 'no-todo-comments'");
      expect(warningSection(stdout)).not.toContain('Fix: yg check --approve');
    });
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
    // A full clone that simply has no such branch — the typo / renamed-branch /
    // never-fetched shape. (The shallow-checkout shape is its own case below;
    // the two produce deliberately different explanations.)
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
    expect(stderr).toContain('git fetch');
    // Not the shallow REMEDY: this clone has its whole history (the reason says
    // so in as many words), and telling anyone to deepen it would send them
    // after the wrong thing.
    expect(stderr).not.toContain('git fetch --unshallow');
  });

  it('names the truncated history, not a missing branch, in a shallow checkout', () => {
    // The CI default: clone one branch at depth 1. The reference is not behind,
    // it is absent, and the fix is to fetch more history rather than to correct
    // the configuration — a distinction the run has to get right, since acting
    // on the other explanation changes nothing.
    const fixture = scaffoldReference('shallow', 'origin/main');
    fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);
    const shallow = fixture.shallowCheckout('feature');

    const { status, stdout, stderr } = run(['check'], shallow);

    expect(status).toBe(1);
    expect(headerOf(stdout)).not.toContain('outside your changes');
    expect(stderr).toContain('shallow clone');
    expect(stderr).toContain('git fetch --unshallow');
    expect(stderr).toContain('checkout depth');
    // …and NOT the full-clone explanation, which would send someone to edit a
    // configuration key that is perfectly correct.
    expect(stderr).not.toContain('progressive.reference in yg-config.yaml');
  });

  // A run that RECORDS verdicts is measured like any other. It used to be the
  // one hole in the promise: recording answered for the whole project, so the
  // same working tree could pass `yg check` and fail `yg check --approve`, and
  // the command the failing report pointed at was the one that answered for
  // everything. What stays whole-project is only what costs nothing — the free
  // deterministic checks whose recorded observations are what a later
  // measurement reads.
  describe('a run that records verdicts', () => {
    it('answers for the change, exactly as the plain gate does', () => {
      const fixture = scaffoldReference('recording-scoped', 'main');
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);

      const recording = run(['check', '--approve', '--only-deterministic'], fixture.dir);
      const plain = run(['check', '--no-approve'], fixture.dir);

      // The two agree about the build, which is the whole point…
      expect(recording.status).toBe(0);
      expect(plain.status).toBe(0);
      expect(warningSection(recording.stdout)).toContain(TODO_IN('beta'));
      expect(headerOf(recording.stdout)).toContain('outside your changes vs main');
      // …and there is no longer anything to warn about, because nothing about
      // this run answered for more than the change did.
      expect(recording.stderr).not.toContain('WHOLE project');
      // The free half still covers everything: beta's verdict is recorded here
      // even though this change never reached it.
      expect(recordedVerdicts(fixture.dir)).toContain('node:beta');
    });

    it('answers for the change even when no flag was typed and the configuration chose it', () => {
      // The shape that used to be worst: `auto_approve` promotes a bare
      // `yg check` to the recording path, so the person asked for the plain gate
      // and silently got the whole-project answer.
      const fixture = createProgressiveFixture({
        label: 'auto-approve',
        progressiveReference: 'main',
        autoApprove: 'deterministic',
      });
      fixtures.push(fixture);
      run(['check'], fixture.dir);
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);

      const auto = run(['check'], fixture.dir);
      const scoped = run(['check', '--no-approve'], fixture.dir);

      // Same answer, whether or not the run happened to record anything.
      expect(auto.status).toBe(0);
      expect(scoped.status).toBe(0);
      expect(headerOf(auto.stdout)).toContain('outside your changes vs main');
      expect(auto.stderr).not.toContain('WHOLE project');
    });

    it('prices the preview the same way, with no whole-project claim', () => {
      const fixture = scaffoldReference('recording-preview', 'main');
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);

      const { status, stdout, stderr } = run(['check', '--approve', '--dry-run'], fixture.dir);

      expect(status).toBe(0);
      expect(stderr).not.toContain('WHOLE project');
      // Free work is priced for the whole project because it costs nothing;
      // there is no reviewer-backed rule here, so the bill is zero either way.
      expect(stdout).toContain('0 reviewer calls (consensus included)');
    });

    it('says so, and gates everything, when the change could not be measured', () => {
      // The one case a recording run still owes an explanation for — and it is
      // the same explanation a plain read gives, from the same measurement.
      const fixture = scaffoldReference('recording-unmeasurable', 'origin/main');
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);

      const { status, stdout, stderr } = run(['check', '--approve', '--only-deterministic'], fixture.dir);

      expect(status).toBe(1);
      expect(errorSection(stdout)).toContain(TODO_IN('beta'));
      expect(stderr).toContain('whole project');
      expect(stderr).toContain('likely does not exist or was never fetched');
    });

    it('answers for everything again when the whole project is asked for', () => {
      const fixture = scaffoldReference('recording-full', 'main');
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);

      const { status, stdout, stderr } = run(['check', '--approve', '--only-deterministic', '--full'], fixture.dir);

      expect(status).toBe(1);
      expect(errorSection(stdout)).toContain(TODO_IN('beta'));
      expect(headerOf(stdout)).not.toContain('outside your changes');
      // Fill progress goes to stderr; what must not be there is a notice.
      expect(stderr).not.toContain('Notice:');
    });

    it('is the plain whole-project run on a project that never opted in', () => {
      const fixture = scaffoldReference('recording-off', undefined);
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);

      const { status, stdout, stderr } = run(['check', '--approve', '--only-deterministic'], fixture.dir);

      expect(status).toBe(1);
      expect(errorSection(stdout)).toContain(TODO_IN('beta'));
      expect(stderr).not.toContain('Notice:');
    });
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

    /**
     * The branch is deliberately arranged to be GREEN if the record is read
     * correctly: it edits `alpha` and re-records that component's verdict, so
     * the only finding left is the refusal inherited from the reference. The
     * exit code therefore carries the whole answer — a run that swallowed the
     * unreadable record and measured against an empty one would pass, which is
     * precisely the failure this row exists to catch.
     */
    function scaffoldWithBaseRecord(label: string, atReference: string): ProgressiveFixture {
      const fixture = scaffoldReference(label, 'main');
      fixture.commit(LOCK, atReference);
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);
      // Both branches end holding a readable record on disk, so the run itself
      // is identical and only the bytes AT THE REFERENCE differ. (When the
      // reference already holds the readable copy there is nothing to restore,
      // and git rightly refuses an empty commit.)
      if (atReference !== READABLE) fixture.commit(LOCK, READABLE);
      run(['check', '--approve', '--only-deterministic'], fixture.dir);
      return fixture;
    }

    it('measures normally against a readable-but-empty record', () => {
      const readable = scaffoldWithBaseRecord('base-readable', READABLE);
      const { status, stdout } = run(['check'], readable.dir);
      expect(status).toBe(0);
      expect(headerOf(stdout)).toContain('outside your changes vs main');
    });

    it('gates the whole project when the record at the reference is unparseable', () => {
      const garbled = scaffoldWithBaseRecord('base-garbled', '{ this is not json');
      const { status, stdout, stderr } = run(['check'], garbled.dir);
      expect(status).toBe(1);
      expect(headerOf(stdout)).not.toContain('outside your changes');
      expect(stderr).toContain('whole project');
      expect(stderr).toContain('Repair that file on the reference branch');
    });

    it('gates the whole project when the record at the reference was there but EMPTY', () => {
      // The case a test on the content alone gets wrong: a file that was never
      // committed and one that was committed and then truncated read back
      // identically — as nothing — and the second is a record whose entries
      // this change destroyed.
      const emptied = scaffoldWithBaseRecord('base-emptied', '');
      const { status, stdout, stderr } = run(['check'], emptied.dir);
      expect(status).toBe(1);
      expect(headerOf(stdout)).not.toContain('outside your changes');
      expect(stderr).toContain('whole project');
    });

    it('measures normally when the record was simply never committed at the reference', () => {
      // The other side of the same coin, and why an empty read cannot simply
      // be refused: a project that never recorded a reviewer verdict has no
      // such file at all, and that absence IS provable.
      const never = scaffoldReference('base-absent', 'main');
      never.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);
      run(['check', '--approve', '--only-deterministic'], never.dir);
      const { status, stdout } = run(['check'], never.dir);
      expect(status).toBe(0);
      expect(headerOf(stdout)).toContain('outside your changes vs main');
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
      // Three obligations inherited from the reference — the log entry, the
      // component's own unreviewed change, and beta's standing refusal — against
      // one changed file that reached none of them.
      expect(headerOf(stdout)).toContain('3 obligations outside your changes vs main (1 changed input)');
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
      // Nothing is left outside — one declaration edit reached both components —
      // and the header says so rather than falling silent about the measurement.
      expect(headerOf(stdout)).toContain('0 obligations outside your changes vs main (1 changed input)');
    });
  });
});
