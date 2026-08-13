import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgressiveFixture, type ProgressiveFixture } from '../support/progressive-fixture.js';
import { runGitFixture } from '../support/git-fixture.js';
import { startMockReviewer, runAsync, type MockReviewer } from './support/mock-reviewer.js';

// ---------------------------------------------------------------------------
// Hermetic E2E for the BYTE GUARD, driven through the real built binary over
// throwaway git repositories.
//
// The hole it closes: the measurement decides what a change is accountable for
// by asking git which files differ. Git can be told to answer that wrongly —
// `git update-index --assume-unchanged` (and `--skip-worktree`) make a file
// with real edits report as untouched, in `git status` and in every diff. The
// obligation covering that file then falls outside the change, its live finding
// is re-coded as inherited debt, and the build goes green over an edit the gate
// never saw.
//
// So every case below arranges exactly that state and asserts the run stays
// red. The discriminator that makes each one a real proof rather than a
// tautology is the SECOND component: `beta` carries a genuine pre-existing
// refusal that no case touches, and it must still be reported as a non-blocking
// warning in the same run. A run that had simply given up and gated everything
// would block on beta too — that is the outcome these tests are written to tell
// apart from the intended one.
//
// No network / clock / random: every rule here is deterministic, so no reviewer
// is ever contacted.
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

/** The edit that makes `alpha` violate the one rule in the fixture. */
const VIOLATING_EDIT = '// TODO: introduced by this very change.\nexport const alpha = 1;\n';

/** Run a git command in the fixture, failing loudly rather than silently. */
function git(dir: string, args: string[]): void {
  const r = runGitFixture(dir, args);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
  }
}

/** `git status --porcelain` as git reports it — the answer the guard second-guesses. */
function porcelain(dir: string): string {
  const r = runGitFixture(dir, ['status', '--porcelain', '-uall']);
  return r.stdout ?? '';
}

/**
 * Mark a tracked path as one git must report as unmodified from now on, THEN
 * write the edit through it. Both index bits produce the same lie in different
 * words: `assume-unchanged` promises git the file will not change (a
 * performance hint on slow filesystems), `skip-worktree` tells git to pretend
 * the work tree copy does not exist (the sparse-checkout mechanism). Either
 * one, set by hand, is a working way to edit a file that no diff will mention.
 */
function hideEdit(
  dir: string,
  relPath: string,
  content: string,
  bit: '--assume-unchanged' | '--skip-worktree' = '--assume-unchanged',
): void {
  git(dir, ['update-index', bit, '--', relPath]);
  writeFileSync(path.join(dir, relPath), content, 'utf-8');
  // The premise of every case in this file: after this, git denies the edit.
  // Asserted on the hidden path specifically rather than on an empty report,
  // because a run that has already recorded verdicts leaves its own (untracked)
  // record behind and that is not what any of these cases are about.
  expect(porcelain(dir)).not.toContain(relPath);
}

/** The local, gitignored file a deterministic recording run writes its verdicts to. */
function recordedVerdicts(dir: string): string {
  return readFileSync(path.join(dir, '.yggdrasil', '.yg-lock.deterministic.json'), 'utf-8');
}

/**
 * A fixture sitting on its own reference branch with every deterministic verdict
 * already recorded: `alpha` clean and approved, `beta` carrying the one
 * pre-existing refusal every case measures against. The work tree is clean and
 * the change is empty — so with git telling the truth, NOTHING is in scope, and
 * anything that ends up blocking got there on the strength of file content.
 */
function scaffoldRecorded(label: string, progressiveReference?: string): ProgressiveFixture {
  const fixture = createProgressiveFixture({ label, progressiveReference });
  fixtures.push(fixture);
  run(['check', '--approve', '--only-deterministic'], fixture.dir);
  expect(recordedVerdicts(fixture.dir)).toContain('no-todo-comments');
  return fixture;
}

describe.skipIf(!distExists)('yg check — the byte guard', () => {
  it('blocks on a file edited behind assume-unchanged, while inherited debt stays a warning', () => {
    const fixture = scaffoldRecorded('assume-unchanged', 'main');
    hideEdit(fixture.dir, 'src/alpha/alpha.ts', VIOLATING_EDIT);

    const { status, stdout } = run(['check'], fixture.dir);

    // The obligation covering the hidden file is answered for…
    expect(status).toBe(1);
    expect(headerOf(stdout)).toContain('yg check: FAIL');
    expect(errorSection(stdout)).toContain("- alpha  aspect 'no-todo-comments'");
    // …and the run is still a MEASURED one, not a whole-project gate in
    // disguise: the refusal it genuinely inherited is still only a warning.
    expect(headerOf(stdout)).toContain('outside your changes vs main');
    expect(warningSection(stdout)).toContain(TODO_IN('beta'));
    expect(errorSection(stdout)).not.toContain(TODO_IN('beta'));
  });

  it('blocks the same way on skip-worktree, the other index bit with the same effect', () => {
    const fixture = scaffoldRecorded('skip-worktree', 'main');
    hideEdit(fixture.dir, 'src/alpha/alpha.ts', VIOLATING_EDIT, '--skip-worktree');

    const { status, stdout } = run(['check'], fixture.dir);

    expect(status).toBe(1);
    expect(errorSection(stdout)).toContain("- alpha  aspect 'no-todo-comments'");
    expect(warningSection(stdout)).toContain(TODO_IN('beta'));
  });

  it('blocks on a recorded REFUSAL of hidden content — the shape that would ship green', () => {
    // The purest form of the hole. The free deterministic pass answers for the
    // whole project, so it re-reviews the hidden file and records a refusal for
    // its new content. That refusal is live, current, and caused by the edit —
    // and with the file absent from every diff, the report would have re-coded
    // it as debt inherited from the reference and exited 0.
    const fixture = scaffoldRecorded('hidden-refusal', 'main');
    hideEdit(fixture.dir, 'src/alpha/alpha.ts', VIOLATING_EDIT);
    run(['check', '--approve', '--only-deterministic'], fixture.dir);

    const { status, stdout } = run(['check'], fixture.dir);

    expect(status).toBe(1);
    expect(errorSection(stdout)).toContain(TODO_IN('alpha'));
    expect(warningSection(stdout)).toContain(TODO_IN('beta'));
  });

  it('blocks on a hidden edit even on a branch whose own committed change is clean', () => {
    // The realistic CI shape: a branch with an ordinary, honest commit, plus one
    // file quietly edited behind the index. The honest half of the change is
    // measured as usual; the hidden half is what the guard adds back.
    const fixture = scaffoldRecorded('hidden-on-branch', 'main');
    fixture.branchWithEdit('feature', 'notes.md', '# notes\n');
    run(['check', '--approve', '--only-deterministic'], fixture.dir);
    hideEdit(fixture.dir, 'src/alpha/alpha.ts', VIOLATING_EDIT);

    const { status, stdout } = run(['check'], fixture.dir);

    expect(status).toBe(1);
    expect(errorSection(stdout)).toContain("- alpha  aspect 'no-todo-comments'");
    expect(warningSection(stdout)).toContain(TODO_IN('beta'));
  });

  it('adds nothing when the hidden file is genuinely unmodified', () => {
    // The guard runs here in full — `beta`'s standing refusal is exactly the
    // out-of-scope failing obligation it inspects — and must re-admit nothing,
    // because every subject still hashes to the id the reference recorded. A
    // comparer that got the object-id form wrong would turn this ordinary green
    // run red, and every run in every repository with it.
    const fixture = scaffoldRecorded('unmodified-hidden', 'main');
    const before = run(['check'], fixture.dir);
    git(fixture.dir, ['update-index', '--assume-unchanged', '--', 'src/alpha/alpha.ts']);

    const after = run(['check'], fixture.dir);

    expect(before.status).toBe(0);
    expect(after.stdout).toBe(before.stdout);
    expect(after.stderr).toBe(before.stderr);
    expect(after.status).toBe(before.status);
    expect(warningSection(after.stdout)).toContain(TODO_IN('beta'));
  });

  // ── The class a rule-check-only guard left wide open ──────────────────────
  //
  // Not every finding is identified by a rule check. An undeclared dependency
  // between two components names only the COMPONENT — no rule check moves at
  // all — so a guard that widened the rule-check set and nothing else went on
  // reporting the whole class as inherited debt. These cases are the reviewer's
  // own reproduction, kept as the regression it is.
  describe('a finding identified by a component rather than by a rule', () => {
    /** An import of the other component, with no relation declared for it. */
    const UNDECLARED_IMPORT = "import { beta } from '../beta/beta.js';\nexport const alpha = beta;\n";

    /**
     * Hide an edit that introduces an undeclared cross-component dependency, and
     * re-record the free verdicts over the hidden content so that alpha's own
     * rule checks are all VERIFIED again. What is left blocking on alpha is then
     * exactly one finding, and it carries no rule check at all — which is the
     * whole point of the case.
     */
    function hiddenUndeclaredImport(label: string): ProgressiveFixture {
      const fixture = scaffoldRecorded(label, 'main');
      hideEdit(fixture.dir, 'src/alpha/alpha.ts', UNDECLARED_IMPORT);
      run(['check', '--approve', '--only-deterministic'], fixture.dir);
      return fixture;
    }

    it('blocks on the undeclared dependency the hidden edit introduced', () => {
      const fixture = hiddenUndeclaredImport('hidden-undeclared-import');

      const { status, stdout } = run(['check'], fixture.dir);

      expect(status).toBe(1);
      expect(errorSection(stdout)).toContain('relation-undeclared-dependency');
      expect(errorSection(stdout)).toContain('alpha');
      // Still a measured run, not a whole-project gate in disguise.
      expect(headerOf(stdout)).toContain('outside your changes vs main');
      expect(warningSection(stdout)).toContain(TODO_IN('beta'));
    });

    it('says in its own output that it kept the finding, and why that can happen', () => {
      // Without this line the state is indistinguishable from an ordinary red
      // build — which matters most on a repository where a checkout filter makes
      // EVERY file differ and the mode has therefore switched itself off.
      const fixture = hiddenUndeclaredImport('hidden-undeclared-notice');

      const { stdout } = run(['check'], fixture.dir);

      expect(stdout).toContain('Content check: 1 finding kept in scope');
      expect(stdout).toContain("differs from 'main' although git reports no change there");
      expect(stdout).toContain('.gitattributes');
    });

    it('counts the hidden file among the changed inputs it gated on', () => {
      // The header quotes this number. Reporting git's smaller count beside a
      // finding that only the file's content justifies would be a claim about
      // the person's diff that is not true.
      const fixture = hiddenUndeclaredImport('hidden-undeclared-count');

      const { stdout } = run(['check'], fixture.dir);

      expect(headerOf(stdout)).toContain('(1 changed input)');
    });

    it('reports the same finding when the identical edit is committed honestly', () => {
      // The control: the guard is re-admitting a finding the run would have had
      // anyway, not inventing one.
      const fixture = scaffoldRecorded('honest-undeclared-import', 'main');
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', UNDECLARED_IMPORT);
      run(['check', '--approve', '--only-deterministic'], fixture.dir);

      const { status, stdout } = run(['check'], fixture.dir);

      expect(status).toBe(1);
      expect(errorSection(stdout)).toContain('relation-undeclared-dependency');
    });
  });

  // ── The advice a run gives has to be advice that works ────────────────────
  it('reviews a re-admitted reviewer-judged rule when told to, instead of blocking forever', async () => {
    // The report blocks on a re-admitted rule check and points at the recording
    // command. If the recording half read the unwidened measurement it would
    // call that same rule outside the change and decline to review it — zero
    // reviewer calls, the identical failure, and no way out through the step the
    // run advises.
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    mocks.push(mock);
    const fixture = createProgressiveFixture({
      label: 'guard-fill',
      progressiveReference: 'main',
      reviewedAspect: { endpoint: mock.endpoint },
    });
    fixtures.push(fixture);
    // Settle the WHOLE project first (`--full`, since a clean checkout of the
    // reference is accountable for nothing and would buy nothing), so the only
    // outstanding reviewer obligation afterwards is the hidden one.
    await runAsync(['check', '--full', '--approve'], fixture.dir);
    const beforeHiding = mock.chatCount();
    expect(beforeHiding).toBeGreaterThan(0);

    hideEdit(fixture.dir, 'src/alpha/alpha.ts', '// alpha, documented.\nexport const alpha = 2;\n');

    const blocked = run(['check'], fixture.dir);
    expect(blocked.status).toBe(1);
    expect(errorSection(blocked.stdout)).toContain("- alpha  aspect 'has-doc-comment'");

    const filled = await runAsync(['check', '--approve'], fixture.dir);

    // It bought the review the report was blocking over…
    expect(mock.chatCount()).toBeGreaterThan(beforeHiding);
    expect(filled.status).toBe(0);
    // …and the same run comes back clean, so the advice actually resolved it.
    expect(headerOf(filled.stdout)).toContain('yg check: PASS');
  });

  // ── The same divergence, one layer down ───────────────────────────────────
  //
  // The report asks about a finding's whole COMPONENT; the stage that buys
  // reviews once asked only about each rule check's OWN subject files. So when
  // the hidden edit lands on a NEIGHBOURING file of the same component, the
  // report blocked on every review that component owes while the advised command
  // bought only the one whose own file moved — the identical unfixable shape as
  // the last round's, just narrower. Both halves now re-admit a component whole,
  // exactly as the honest measurement does for a file git reported.
  describe('a hidden edit on a neighbouring file of the same component', () => {
    /**
     * `alpha` owns two files and owes ONE review per file, and NEITHER has been
     * reviewed yet. That second part is what makes the case: a review whose own
     * file never moves is still outstanding, so the report has something to
     * block on that the narrow gathering would never have offered to buy.
     */
    async function perFileProject(label: string): Promise<{ fixture: ProgressiveFixture; mock: MockReviewer }> {
      const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
      mocks.push(mock);
      const fixture = createProgressiveFixture({
        label,
        progressiveReference: 'main',
        reviewedAspect: { endpoint: mock.endpoint, perFile: true },
      });
      fixtures.push(fixture);
      fixture.commit('src/alpha/helper.ts', '// helper, documented.\nexport const helper = 1;\n');
      return { fixture, mock };
    }

    const EDITED_HELPER = '// helper, documented.\nexport const helper = 2;\n';

    it('buys every review the component owes when the edit is visible to git', async () => {
      // The control, and the definition of correct: an honest commit re-gates
      // the whole component, so BOTH of its reviews are bought and it passes.
      const { fixture, mock } = await perFileProject('neighbour-visible');
      fixture.branchWithEdit('feature', 'src/alpha/helper.ts', EDITED_HELPER);

      const filled = await runAsync(['check', '--approve'], fixture.dir);

      expect(mock.chatCount()).toBe(2);
      expect(filled.status).toBe(0);
      expect(headerOf(filled.stdout)).toContain('yg check: PASS');
    });

    it('buys the same reviews, and clears, when the edit is hidden from git', async () => {
      // Before this round: the report blocked on both reviews while the advised
      // command bought one, and further runs bought nothing at all — only the
      // whole-project form could clear it.
      const { fixture, mock } = await perFileProject('neighbour-hidden');
      hideEdit(fixture.dir, 'src/alpha/helper.ts', EDITED_HELPER);

      const filled = await runAsync(['check', '--approve'], fixture.dir);

      expect(mock.chatCount()).toBe(2);
      expect(filled.status).toBe(0);
      expect(headerOf(filled.stdout)).toContain('yg check: PASS');

      // And it stays cleared: a second run has nothing left to buy or block on.
      const again = await runAsync(['check'], fixture.dir);
      expect(again.status).toBe(0);
    });

    it('blocks on the neighbour’s review too, not only the edited file’s', async () => {
      // The report's own half of the same agreement, asserted directly rather
      // than only through what the fill buys: reaching a component re-gates
      // every review it owes, which is what the honest commit above produces.
      const { fixture } = await perFileProject('neighbour-report');
      hideEdit(fixture.dir, 'src/alpha/helper.ts', EDITED_HELPER);

      const { status, stdout } = run(['check', '--details'], fixture.dir);

      expect(status).toBe(1);
      expect(errorSection(stdout)).toContain("'has-doc-comment' on file:src/alpha/helper.ts");
      expect(errorSection(stdout)).toContain("'has-doc-comment' on file:src/alpha/alpha.ts");
      // …while the component the change never reached keeps its reviews outside.
      expect(errorSection(stdout)).not.toContain('file:src/beta/beta.ts');
    });
  });

  it('re-admits an uncovered file, and still says it kept something', async () => {
    // The one finding classification REBUILDS instead of handing back: the
    // coverage finding is split into a blocking and an inherited half, so a
    // count tracked by finding identity saw nothing for a run whose only
    // re-admission was an uncovered file — it blocked with no explanation at
    // all, which is the single case the explanation exists for.
    const fixture = scaffoldRecorded('coverage-kept', 'main');
    // A file under the covered root that no component maps: an inherited
    // coverage finding on the reference, non-blocking while nothing reaches it.
    fixture.commit('src/orphan/orphan.ts', 'export const orphan = 1;\n');

    const inherited = run(['check'], fixture.dir);
    expect(inherited.status).toBe(0);
    expect(warningSection(inherited.stdout)).toContain('src/orphan/orphan.ts');
    expect(inherited.stdout).not.toContain('Content check:');

    hideEdit(fixture.dir, 'src/orphan/orphan.ts', 'export const orphan = 2;\n');
    const kept = run(['check'], fixture.dir);

    expect(kept.status).toBe(1);
    expect(errorSection(kept.stdout)).toContain('src/orphan/orphan.ts');
    expect(kept.stdout).toContain('Content check: 1 finding kept in scope');
  });

  it('is byte-identical to the whole-project gate on a project that never opted in', () => {
    // The feature-off guarantee, proved with the evasion PRESENT on both sides:
    // a project carrying no reference must produce exactly what this command
    // produced before any of this existed — same bytes on both streams, same
    // exit code — so nothing the guard adds (a tree listing, a notice, a
    // re-ordered finding) can leak into a run that asked for no measurement.
    const off = scaffoldRecorded('guard-parity-off', undefined);
    const on = scaffoldRecorded('guard-parity-on', 'main');
    hideEdit(off.dir, 'src/alpha/alpha.ts', VIOLATING_EDIT);
    hideEdit(on.dir, 'src/alpha/alpha.ts', VIOLATING_EDIT);

    const bare = run(['check'], off.dir);
    const audit = run(['check', '--full'], on.dir);

    expect(bare.stdout).toBe(audit.stdout);
    expect(bare.stderr).toBe(audit.stderr);
    expect(bare.status).toBe(audit.status);
    expect(bare.status).toBe(1);
  });
});
