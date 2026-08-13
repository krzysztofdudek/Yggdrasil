import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgressiveFixture, type ProgressiveFixture } from '../support/progressive-fixture.js';
import { runGitFixture } from '../support/git-fixture.js';

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
  expect(porcelain(dir)).toBe('');
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
