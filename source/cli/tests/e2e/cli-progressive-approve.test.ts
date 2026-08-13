import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgressiveFixture, type ProgressiveFixture } from '../support/progressive-fixture.js';
import { startMockReviewer, runAsync, type MockReviewer } from './support/mock-reviewer.js';
import { readLock } from './support/read-lock.js';

// ---------------------------------------------------------------------------
// Hermetic E2E for what a RECORDING run buys once a project measures its
// changes: `yg check --approve` and its cost preview, driven through the real
// built binary over throwaway git repositories, with a reviewer-backed rule
// answered by an in-process mock speaking the real wire protocol.
//
// The promise under test: reviewer work is bought for the obligations the
// change is accountable for and no others. Everything free stays whole-project
// — a deterministic check costs nothing, and its recorded observations are what
// the next measurement reads — and so does the mandatory-log gate, which is
// all-or-nothing about the code as it stands rather than about who moved it.
//
// The fixture always holds THREE components: `alpha` (clean, the one branches
// touch), `beta` (ships a TODO, so its free check refuses), and `gamma` (clean,
// never touched by anything). Two untouched components rather than one is
// deliberate: a count of one proves nothing about summing or pluralising.
//
// No network, no clock, no randomness: the reviewer is a loopback mock on an
// ephemeral port, and every assertion is on an exact count or an exact line.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const fixtures: ProgressiveFixture[] = [];
const mocks: MockReviewer[] = [];

afterEach(async () => {
  for (const f of fixtures.splice(0)) f.cleanup();
  for (const m of mocks.splice(0)) await m.close();
});

/** Synchronous run, for the cases whose rules are all deterministic. */
function run(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The edit a branch makes to `alpha` when the point is that it is CLEAN. */
const CLEAN_EDIT = '// alpha, documented.\nexport const alpha = 1;\nexport const alphaAgain = 3;\n';
/** The edit a branch makes to `alpha` when the point is that its FREE check refuses it. */
const VIOLATING_EDIT = '// TODO: introduced by this very change.\nexport const alpha = 1;\n';

/**
 * A project with a reviewer-backed rule on three components and nothing
 * reviewed yet, so all three of its paid obligations are outstanding. The mock
 * approves whatever it is asked about — what these cases measure is how many
 * times it is asked at all, and about what.
 */
async function reviewedProject(label: string): Promise<{ fixture: ProgressiveFixture; mock: MockReviewer }> {
  const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
  mocks.push(mock);
  const fixture = createProgressiveFixture({
    label,
    progressiveReference: 'main',
    extraComponents: ['gamma'],
    reviewedAspect: { endpoint: mock.endpoint },
  });
  fixtures.push(fixture);
  return { fixture, mock };
}

/** The committed record of reviewer verdicts, as the run left it. */
function reviewedUnits(dir: string): string[] {
  const lock = readLock(path.join(dir, '.yggdrasil'));
  return Object.keys(lock.verdicts['has-doc-comment'] ?? {}).sort();
}

describe.skipIf(!distExists)('yg check --approve — buying review for the change', () => {
  // ── The cost preview ─────────────────────────────────────────────────────
  describe('the cost preview', () => {
    it('prices exactly the obligations the change is accountable for', async () => {
      const { fixture, mock } = await reviewedProject('preview-scoped');
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);

      const { status, stdout } = await runAsync(['check', '--approve', '--dry-run'], fixture.dir);

      expect(status).toBe(0);
      // Free work covers all three components; paid work covers the one the
      // change reached. The header quotes the bill this run would actually run up.
      expect(stdout).toContain(
        'Filling 4 unverified pairs across 3 nodes — 3 deterministic (no cost), 1 reviewer calls (consensus included)',
      );
      // And it says what it is NOT buying, so the smaller bill never reads as
      // "there was nothing else".
      expect(stdout).toContain(
        '2 LLM pair(s) outside this change — run `yg check --full --approve` to review them.',
      );
      // The breakdown names the one paid subject and neither of the others…
      expect(stdout).toContain('[llm] has-doc-comment on node:alpha — 1 reviewer call(s)');
      expect(stdout).not.toContain('[llm] has-doc-comment on node:beta');
      expect(stdout).not.toContain('[llm] has-doc-comment on node:gamma');
      // …while the free checks are listed for every component, priced at nothing.
      expect(stdout).toContain('[det] no-todo-comments on node:beta — free');
      expect(stdout).toContain('[det] no-todo-comments on node:gamma — free');
      // A preview writes nothing and asks nobody anything.
      expect(mock.chatCount()).toBe(0);
      expect(reviewedUnits(fixture.dir)).toEqual([]);
    });

    it('prices the whole backlog again when the whole project is asked for', async () => {
      const { fixture } = await reviewedProject('preview-full');
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);

      const { stdout } = await runAsync(['check', '--approve', '--dry-run', '--full'], fixture.dir);

      expect(stdout).toContain('3 reviewer calls (consensus included)');
      expect(stdout).toContain('[llm] has-doc-comment on node:beta — 1 reviewer call(s)');
      expect(stdout).not.toContain('outside this change');
    });

    it('prices nothing when the change reached nothing', async () => {
      // A clean checkout of the reference itself: every obligation in the
      // project is outstanding and not one of them is this run's business.
      const { fixture, mock } = await reviewedProject('preview-nothing');

      const { status, stdout } = await runAsync(['check', '--approve', '--dry-run'], fixture.dir);

      expect(status).toBe(0);
      expect(stdout).toContain(
        'Filling 3 unverified pairs across 3 nodes — 3 deterministic (no cost), 0 reviewer calls (consensus included)',
      );
      expect(stdout).toContain(
        '3 LLM pair(s) outside this change — run `yg check --full --approve` to review them.',
      );
      expect(stdout).not.toContain('[llm] has-doc-comment');
      expect(mock.chatCount()).toBe(0);
    });
  });

  // ── The recording run itself ─────────────────────────────────────────────
  describe('the recording run', () => {
    it('reviews the change’s obligation and records that one alone', async () => {
      const { fixture, mock } = await reviewedProject('fill-scoped');
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);

      const { status, stdout, stderr } = await runAsync(['check', '--approve'], fixture.dir);

      // Exactly one reviewer call, about exactly the component the change reached.
      expect(mock.chatCount()).toBe(1);
      expect(mock.chatRequests[0].prompt).toContain('src/alpha/alpha.ts');
      expect(mock.chatRequests[0].prompt).not.toContain('src/beta/beta.ts');
      // The committed record holds that one verdict and no others — the two
      // obligations this change did not reach are still waiting for a reviewer.
      expect(reviewedUnits(fixture.dir)).toEqual(['node:alpha']);
      // The run says what it bought and what it left…
      expect(stderr).toContain('1 reviewer calls (consensus included)');
      expect(stderr).toContain('2 LLM pair(s) outside this change');
      // …and passes: what it left is reported, without blocking.
      expect(status).toBe(0);
      expect(stdout).toContain('yg check: PASS');
      expect(stdout).toContain('outside your changes vs main');
    });

    it('says what it left unreviewed even when it bought nothing at all', async () => {
      const { fixture, mock } = await reviewedProject('fill-nothing');

      const { status, stderr } = await runAsync(['check', '--approve'], fixture.dir);

      expect(status).toBe(0);
      expect(mock.chatCount()).toBe(0);
      expect(reviewedUnits(fixture.dir)).toEqual([]);
      // Never "all expected pairs hold valid verdicts": three of them do not.
      expect(stderr).toContain(
        '0 reviewer calls made — 3 LLM pair(s) outside this change left unverified.',
      );
      expect(stderr).not.toContain('all expected pairs hold valid verdicts');
      // And a run that deliberately filled nothing is not a convergence failure:
      // the sentinel that watches for a fill accomplishing nothing stays silent.
      expect(stderr).not.toContain('Verification claimed nothing needed checking');
    });

    it('still skips paid review on a unit whose free check refused it', async () => {
      // The free-check-first optimisation, on a component the change DID reach:
      // paying a reviewer to read code a free check already rejected is waste,
      // and narrowing the paid set must not have quietly disabled that.
      const { fixture, mock } = await reviewedProject('fill-det-refusal');
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', VIOLATING_EDIT);

      const { status, stdout, stderr } = await runAsync(['check', '--approve'], fixture.dir);

      // alpha was in scope and would have been reviewed — the refusal is what
      // stopped it, and the run says so.
      expect(stderr).toContain('1 reviewer calls (consensus included)');
      expect(stderr).toContain("LLM fills for node 'alpha' skipped");
      expect(mock.chatCount()).toBe(0);
      expect(reviewedUnits(fixture.dir)).toEqual([]);
      // The refusal the change caused blocks; the ones it inherited do not.
      expect(status).toBe(1);
      expect(stdout).toContain('src/alpha/alpha.ts:1: TODO comment found');
    });
  });

  // ── The mandatory-log gate, deliberately NOT narrowed ────────────────────
  //
  // The gate asks whether a component's source has drifted from the state its
  // recorded verdicts were written over. That question is about the code, not
  // about the branch, so it is asked of every component owning an unverified
  // pair — including one the change never reached. The consequence is real and
  // has to be lived with rather than papered over: a plain read can PASS while
  // the recording run refuses to record anything, and the refusal has to
  // explain itself well enough that the two do not read as a contradiction.
  // The gate's whole point is that an edit nobody explained cannot be recorded
  // over. That promise survives only if the justification an edit was explained
  // WITH is consumed once and cannot be spent again on a later, different edit.
  // Consuming it used to be positive closure's job alone — and closure needs
  // every rule on the component settled, which a narrowed run deliberately does
  // not do. These cases run the whole sequence on a component the branch never
  // touches, with BOTH a justification requirement and a reviewer-backed rule.
  describe('an entry is spent once, even when the run left that component’s review alone', () => {
    /**
     * A project whose components carry both a mandatory-justification type and a
     * reviewer-backed rule, recorded whole (`--full`) so every component starts
     * from a real baseline — the state a reference branch is in after an audit.
     */
    async function auditedProject(label: string): Promise<{ fixture: ProgressiveFixture; mock: MockReviewer }> {
      const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
      mocks.push(mock);
      const fixture = createProgressiveFixture({
        label,
        progressiveReference: 'main',
        logRequired: true,
        extraComponents: ['gamma'],
        reviewedAspect: { endpoint: mock.endpoint },
      });
      fixtures.push(fixture);
      for (const component of ['alpha', 'beta', 'gamma']) {
        run(['log', 'add', '--node', component, '--reason', 'First entry, recorded before anything moved.'], fixture.dir);
      }
      await runAsync(['check', '--approve', '--full'], fixture.dir);
      fixture.commitAll('record the baselines for the whole project');
      return { fixture, mock };
    }

    /**
     * The sequence, on `gamma`, which no branch below touches:
     *   1. ON THE REFERENCE, gamma's source moves and an entry explains it.
     *   2. a branch that touches only `alpha` records verdicts — gamma's review
     *      is deliberately left alone, so gamma does not settle.
     *   3. gamma's source moves AGAIN with nothing explaining it.
     * Step 3 must be refused. It is refused only if step 2 spent the entry from
     * step 1; otherwise that entry — written for an edit that is now history —
     * still counts as newer than whatever gamma last settled at, and answers for
     * an edit nobody described.
     */
    async function throughStepTwo(label: string): Promise<{ fixture: ProgressiveFixture; mock: MockReviewer }> {
      const { fixture, mock } = await auditedProject(label);
      fixture.commit('src/gamma/gamma.ts', '// gamma, documented.\nexport const gamma = 3;\nexport const moved = 4;\n');
      run(['log', 'add', '--node', 'gamma', '--reason', 'Explaining gamma’s move, at the time it happened.'], fixture.dir);
      fixture.commitAll('gamma moves on the reference, with its reason');
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', CLEAN_EDIT);
      // The branch explains its OWN edit — the type asks for one, and without it
      // the gate stops this run over alpha and the sequence never reaches the
      // state it is about.
      run(['log', 'add', '--node', 'alpha', '--reason', 'Explaining this branch’s own edit to alpha.'], fixture.dir);
      fixture.commitAll('alpha moves on the branch, with its reason');
      await runAsync(['check', '--approve'], fixture.dir);
      return { fixture, mock };
    }

    it('refuses to record over a later edit nobody explained', async () => {
      const { fixture } = await throughStepTwo('entry-spent-once');

      // Step 3: gamma moves again, with nothing said about it.
      fixture.commit('src/gamma/gamma.ts', '// gamma, documented.\nexport const gamma = 3;\nexport const unexplained = 5;\n');
      const { status, stderr } = await runAsync(['check', '--approve'], fixture.dir);

      expect(stderr).toContain("No fresh log entry for node 'gamma'");
      expect(status).toBe(1);
      // Nothing was recorded over it — the gate stops the whole run.
      expect(stderr).not.toContain('reviewer calls made');
    });

    it('reports that same unexplained edit on a plain read', async () => {
      // The read path shares the predicate, so the hole closed there too.
      const { fixture } = await throughStepTwo('entry-spent-once-read');

      fixture.commit('src/gamma/gamma.ts', '// gamma, documented.\nexport const gamma = 3;\nexport const unexplained = 5;\n');
      const { status, stdout } = await runAsync(['check', '--no-approve', '--full'], fixture.dir);

      expect(status).toBe(1);
      expect(stdout).toContain("No fresh log entry for node 'gamma'");
    });

    // The other half of the same property, and the reason spending the entry is
    // not enough on its own: what an entry was spent ON has to be recorded with
    // it. Advance the entry alone and the component is left permanently drifted
    // with nothing left to satisfy the gate — every later run demands a brand-new
    // justification for code nobody has touched since.
    it('asks for nothing further when nothing moved again', async () => {
      const { fixture } = await throughStepTwo('entry-spent-once-idempotent');

      const second = await runAsync(['check', '--approve'], fixture.dir);
      const third = await runAsync(['check', '--approve'], fixture.dir);

      expect(second.stderr).not.toContain('No fresh log entry');
      expect(third.stderr).not.toContain('No fresh log entry');
      expect(second.status).toBe(0);
      expect(third.status).toBe(0);
    });

    it('still records nothing for the component whose review it left alone', async () => {
      // Spending the entry must not be mistaken for having reviewed anything:
      // gamma's reviewer-backed rule is still outstanding afterwards.
      const { fixture } = await throughStepTwo('entry-spent-once-not-a-verdict');

      const { stdout } = await runAsync(['check', '--no-approve', '--full'], fixture.dir);

      expect(stdout).toContain("- gamma  aspect 'has-doc-comment'");
    });
  });

  describe('a component whose log fell behind, outside the change', () => {
    /**
     * A repository where `alpha`'s source has moved past the entry its log
     * records — a debt sitting on the reference branch — while the branch under
     * test edits a file no component owns at all.
     *
     * It has to be `alpha` rather than `beta`: the baseline a later drift is
     * measured from is only recorded for a component whose rules all passed, and
     * beta's TODO means beta never records one.
     */
    function scaffoldDriftedLog(label: string): ProgressiveFixture {
      const fixture = createProgressiveFixture({
        label,
        progressiveReference: 'main',
        logRequired: true,
        extraComponents: ['gamma'],
      });
      fixtures.push(fixture);
      for (const component of ['alpha', 'beta', 'gamma']) {
        run(['log', 'add', '--node', component, '--reason', 'First entry, recorded before anything moved.'], fixture.dir);
      }
      // A full recording run: only that records the log baseline later drift is
      // measured against.
      run(['check', '--approve'], fixture.dir);
      fixture.commitAll('record the log baselines');
      // ON THE REFERENCE, and so inherited by every branch cut from it: alpha's
      // source moves with NO accompanying entry (the debt the gate refuses over)
      // and gamma's moves WITH one (a free check the run would happily re-record,
      // and the proof that nothing at all ran once the gate refused).
      fixture.commit('src/alpha/alpha.ts', 'export const alpha = 1;\nexport const drifted = 7;\n');
      fixture.commit('src/gamma/gamma.ts', 'export const gamma = 3;\nexport const explained = 9;\n');
      run(['log', 'add', '--node', 'gamma', '--reason', 'Explaining gamma’s own move, at the time it happened.'], fixture.dir);
      fixture.commitAll('gamma moves, with its reason');
      fixture.branchWithEdit('unrelated', 'notes.md', '# notes\n');
      return fixture;
    }

    it('aborts the whole recording run, all-or-nothing, even though the change never reached it', () => {
      const fixture = scaffoldDriftedLog('log-gate-outside');
      const recorded = (): string => readFileSync(path.join(fixture.dir, '.yggdrasil', '.yg-lock.deterministic.json'), 'utf-8');
      const before = recorded();

      const plain = run(['check', '--no-approve'], fixture.dir);
      const recording = run(['check', '--approve'], fixture.dir);

      // The read is green: this change is accountable for none of it.
      expect(plain.status).toBe(0);
      // The recording run is not, and it names the component it is waiting on.
      expect(recording.status).toBe(1);
      expect(recording.stderr).toContain("No fresh log entry for node 'alpha'");
      // The reason has to survive the collision above: someone reading a green
      // read and a red recording run together must be able to tell that the
      // drift is measured from the recorded verdicts, not from their branch.
      expect(recording.stderr).toContain('drifted from the state its recorded verdicts were written over');
      expect(recording.stderr).toContain('earlier commits can be as much the cause');
      // All-or-nothing, proved on a component the gate did NOT object to:
      // gamma's free check was ready to run and record, and did not, because one
      // OTHER component owes an entry. Byte-identical record, no fill summary.
      expect(recorded()).toBe(before);
      expect(recording.stderr).not.toContain('reviewer calls made');
    });

    it('records again once the entry the gate asked for exists', () => {
      const fixture = scaffoldDriftedLog('log-gate-satisfied');

      run(['log', 'add', '--node', 'alpha', '--reason', 'Explaining the move that happened on the reference.'], fixture.dir);
      const { status, stderr } = run(['check', '--approve'], fixture.dir);

      expect(stderr).not.toContain('No fresh log entry');
      // The free half is whole-project, so both inherited drifts are re-checked
      // and recorded even though the change reached neither.
      expect(stderr).toContain('Filling 2 unverified pairs across 2 nodes — 2 deterministic (no cost)');
      // beta's TODO still refuses — inherited, so the run stays green.
      expect(status).toBe(0);
    });
  });
});
