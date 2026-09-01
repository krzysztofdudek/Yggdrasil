import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgressiveFixture, type ProgressiveFixture } from '../support/progressive-fixture.js';
import { runGitFixture } from '../support/git-fixture.js';
import { startMockReviewer, runAsync, type MockReviewer } from './support/mock-reviewer.js';

// ---------------------------------------------------------------------------
// Hermetic E2E for the state the byte guard's own notice warns about: a project
// where something REWRITES FILES BETWEEN STORAGE AND THE WORKING COPY, so the
// bytes on disk can never hash to the id the reference branch recorded.
//
// The sibling suite (cli-progressive-byte-guard.test.ts) proves the guard closes
// a deliberate evasion — one file, hidden on purpose, everything else honest.
// This one is the opposite shape and a different claim: NOTHING here is hidden
// and nobody is evading anything, yet EVERY file mismatches on EVERY run, and
// the documented consequence is that measuring against a branch stops narrowing
// anything at all. That consequence had a paragraph in the documentation, a
// sentence in the run's own output, and no test — the run printed a string
// naming `.gitattributes` while no test had ever put a `.gitattributes` in front
// of it.
//
// Two mechanisms, both named in the notice, both reproduced with nothing but
// git itself:
//
//   - `text eol=…`, which stores LF and checks out CRLF;
//   - a `filter=` clean/smudge driver, which is precisely the shape large-file
//     storage takes — the branch holds one thing, the working copy holds
//     another, and the clean filter hides the difference from every diff.
//
// Neither is confined to a platform, and neither leaves a trace in `git status`:
// each case below asserts the clean report FIRST, because a case where git had
// simply noticed the difference would prove nothing about the guard.
//
// The claim under test is the whole of what the notice promises, in three parts:
// the run stays red (nothing is inherited), it says why in its own words, and
// — the part that costs real money — a recording run then buys the whole
// project's reviews, exactly as the whole-project form would.
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

/**
 * The violation line a component's TODO produces, as the report prints it.
 *
 * Matched with the line NUMBER left open on purpose: a smudge filter that
 * prepends anything moves every line of the file it materializes, and the
 * subject of these cases is which SECTION the finding lands in, never where in
 * the file it was found.
 */
const TODO_IN = (dir: string): RegExp => new RegExp(`src/${dir}/${dir}\\.ts:\\d+: TODO comment found`);

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

/** The local, gitignored file a deterministic recording run writes its verdicts to. */
function recordedVerdicts(dir: string): string {
  return readFileSync(path.join(dir, '.yggdrasil', '.yg-lock.deterministic.json'), 'utf-8');
}

/**
 * Discard the work-tree copy of every tracked file under `src/` and let git
 * write it back — the one step that turns a configured rewrite into bytes on
 * disk. It is what a fresh clone does to every file it materializes, and it has
 * to happen through git rather than by writing the rewritten bytes directly:
 * a hand-written copy leaves the index's stat cache stale, and git then reports
 * the file as modified for that reason alone, which is the very state these
 * cases must not be confused with.
 *
 * `.gitattributes` is deliberately left in place throughout — deleting the file
 * that configures the rewrite while the rewrite is being applied would make the
 * outcome depend on the order git happens to restore paths in.
 */
function recheckoutSources(dir: string, relPaths: string[]): void {
  for (const rel of relPaths) rmSync(path.join(dir, rel), { force: true });
  git(dir, ['checkout', '--', 'src']);
}

/** The fixture's two source files, which every case here rewrites. */
const SOURCES = ['src/alpha/alpha.ts', 'src/beta/beta.ts'];

/**
 * Commit a rewriting `.gitattributes` on the reference branch and materialize
 * its effect, THEN record the deterministic verdicts over the bytes that are
 * actually on disk.
 *
 * The order is the whole point. A project that has a checkout filter has always
 * had it: its verdicts were recorded against the smudged bytes, so what these
 * cases exercise is a repository that is internally consistent and still cannot
 * be measured — not one whose verdicts merely went stale when a test rewrote its
 * files underneath them.
 */
function rewritingProject(label: string, attributes: string, configure?: (dir: string) => void): ProgressiveFixture {
  const fixture = createProgressiveFixture({ label, progressiveReference: 'main' });
  fixtures.push(fixture);
  configure?.(fixture.dir);
  fixture.commit('.gitattributes', attributes);
  recheckoutSources(fixture.dir, SOURCES);
  run(['check', '--approve', '--only-deterministic'], fixture.dir);
  expect(recordedVerdicts(fixture.dir)).toContain('no-todo-comments');
  return fixture;
}

/** The `text eol=` half of the notice: LF in the object store, CRLF on disk. */
const EOL_ATTRIBUTES = '* text eol=crlf\n';

/**
 * The `filter=` half, which is also the large-file-storage shape: the branch
 * holds one thing and the working copy holds another, with a clean filter
 * hiding the difference from every diff. A marker line rather than a pointer
 * file, because the mechanism under test is the round trip, not the payload —
 * and it is written as a `//` comment so the relation extractor still parses
 * the file as the TypeScript it claims to be.
 */
const FILTER_ATTRIBUTES = '*.ts filter=fakelfs\n';
const FILTER_MARKER = '// smudged';

function configureFilterDriver(dir: string): void {
  // `%` as sed's address delimiter, not `/`: the marker is a `//` comment, and
  // the default delimiter would end the address inside it.
  git(dir, ['config', 'filter.fakelfs.clean', `sed '\\%^${FILTER_MARKER}$%d'`]);
  git(dir, ['config', 'filter.fakelfs.smudge', `sed '1i ${FILTER_MARKER}'`]);
}

describe.skipIf(!distExists)('yg check — a project whose files are rewritten on checkout', () => {
  // ── The premise every case rests on ──────────────────────────────────────
  //
  // Asserted once per mechanism, and asserted FIRST: if git reported these files
  // as modified, they would be in scope through the ordinary touched-set reader
  // and the byte guard would have nothing to do with the outcome below. The
  // cases would still pass, and would be proving nothing.
  it.each([
    ['a line-ending rewrite', EOL_ATTRIBUTES, undefined],
    ['a clean/smudge filter driver', FILTER_ATTRIBUTES, configureFilterDriver],
  ])('%s leaves git reporting a clean tree while the bytes disagree', (label, attributes, configure) => {
    const fixture = rewritingProject(`premise-${label.replace(/\W+/g, '-')}`, attributes, configure);

    // Git's own answer: nothing has changed. `.yg-lock.deterministic.json` is
    // gitignored and the record the run just wrote is untracked, so the tracked
    // tree is the whole of what this asserts.
    for (const source of SOURCES) expect(porcelain(fixture.dir)).not.toContain(source);
    // …and yet the working copy is not what the branch stores.
    const stored = runGitFixture(fixture.dir, ['rev-parse', `HEAD:${SOURCES[0]}`]).stdout?.trim();
    const onDisk = runGitFixture(fixture.dir, ['hash-object', '--no-filters', SOURCES[0]]).stdout?.trim();
    expect(stored).toBeTruthy();
    expect(onDisk).toBeTruthy();
    expect(onDisk).not.toBe(stored);
  });

  // ── What that costs the person running the gate ──────────────────────────
  it.each([
    ['a line-ending rewrite', EOL_ATTRIBUTES, undefined],
    ['a clean/smudge filter driver', FILTER_ATTRIBUTES, configureFilterDriver],
  ])('%s keeps every inherited finding blocking, on a branch that changed nothing', (label, attributes, configure) => {
    const fixture = rewritingProject(`blocks-${label.replace(/\W+/g, '-')}`, attributes, configure);

    const { status, stdout } = run(['check'], fixture.dir);

    // beta's TODO is debt on the reference branch that this checkout never went
    // near. On a measurable project it is a warning (the control below proves
    // exactly that); here it blocks, because nothing can be shown to be inherited.
    expect(status).toBe(1);
    expect(errorSection(stdout)).toMatch(TODO_IN('beta'));
    expect(warningSection(stdout)).not.toMatch(TODO_IN('beta'));
    // Still a MEASURED run, not a whole-project fallback wearing its clothes —
    // the distinction the notice below depends on to mean anything.
    expect(headerOf(stdout)).toContain('outside your changes vs main');
  });

  it('says so in its own output, naming the two things that do this', () => {
    // The line that separates "your build is red" from "this mode is currently
    // buying you nothing". Without it the two are indistinguishable, and the
    // second is the one with a fix that is not in the code.
    const fixture = rewritingProject('rewrite-notice', EOL_ATTRIBUTES);

    const { stdout } = run(['check'], fixture.dir);

    expect(stdout).toContain('Content check: 1 finding kept in scope');
    expect(stdout).toContain("differs from 'main' although git reports no change there");
    expect(stdout).toContain("a committed .gitattributes 'text eol='/'filter=', or large-file storage");
    expect(stdout).toContain("'yg check --approve' pays to review the whole project");
  });

  // ── The control, without which none of the above is a proof ──────────────
  it('inherits that same finding, quietly, on the identical project with nothing rewriting it', () => {
    const fixture = createProgressiveFixture({ label: 'no-rewrite-control', progressiveReference: 'main' });
    fixtures.push(fixture);
    run(['check', '--approve', '--only-deterministic'], fixture.dir);

    const { status, stdout } = run(['check'], fixture.dir);

    expect(status).toBe(0);
    expect(warningSection(stdout)).toMatch(TODO_IN('beta'));
    expect(errorSection(stdout)).not.toMatch(TODO_IN('beta'));
    // And no notice, because the guard kept nothing: the line appears only where
    // it has something to report.
    expect(stdout).not.toContain('Content check:');
  });

  // ── `--full` reports the same set either way ─────────────────────────────
  it('reports the same findings as the whole-project audit, which is what makes it only ever stricter', () => {
    // The documented invariant for this state: the guard errs toward gating
    // more, and `yg check --full` reports the same set. Compared as two real
    // runs of the same project rather than by exit code, because "both were red"
    // would hold even if the measured run had gated a different set.
    const fixture = rewritingProject('rewrite-vs-full', EOL_ATTRIBUTES);

    const measured = run(['check'], fixture.dir);
    const full = run(['check', '--full'], fixture.dir);

    expect(measured.status).toBe(1);
    expect(full.status).toBe(1);
    expect(errorSection(full.stdout)).toBe(errorSection(measured.stdout));
    expect(warningSection(full.stdout)).toBe(warningSection(measured.stdout));
  });

  // ── The part that costs real money ───────────────────────────────────────
  //
  // "Nothing is then inherited, so `yg check --approve` pays to review the whole
  // project." That sentence is the reason this state is worth a notice at all,
  // and it is a claim about REVIEWER CALLS — so it is asserted as a count off
  // the reviewer itself, three times over, on three otherwise identical projects.
  describe('what a recording run then buys', () => {
    /**
     * A project whose only rule is reviewer-judged, so every purchase is
     * visible in the mock's call count and nothing can be settled locally.
     * The free rule is off deliberately: with it attached, a component carrying
     * its refusal has its paid pairs skipped for that run, and the count would
     * be measuring that rather than the scope.
     */
    async function reviewedProject(
      label: string,
      rewritten: boolean,
    ): Promise<{ fixture: ProgressiveFixture; mock: MockReviewer }> {
      const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
      mocks.push(mock);
      const fixture = createProgressiveFixture({
        label,
        progressiveReference: 'main',
        deterministicAspect: false,
        reviewedAspect: { endpoint: mock.endpoint },
      });
      fixtures.push(fixture);
      if (rewritten) {
        fixture.commit('.gitattributes', EOL_ATTRIBUTES);
        recheckoutSources(fixture.dir, SOURCES);
      }
      return { fixture, mock };
    }

    it('buys nothing at all when the project can be measured and the change reached nothing', async () => {
      const { fixture, mock } = await reviewedProject('cost-measurable', false);

      const filled = await runAsync(['check', '--approve'], fixture.dir);

      expect(mock.chatCount()).toBe(0);
      expect(filled.status).toBe(0);
    });

    it('buys every component’s review under a rewrite, though the change still reached nothing', async () => {
      const { fixture, mock } = await reviewedProject('cost-rewritten', true);

      await runAsync(['check', '--approve'], fixture.dir);

      // Two components, one reviewed rule each. Not one, and not zero: the
      // measurement is intact and reports itself as such, but there is nothing
      // left for it to leave out.
      expect(mock.chatCount()).toBe(2);
    });

    it('buys exactly what the whole-project form buys, which is the point of the warning', async () => {
      const { fixture, mock } = await reviewedProject('cost-full', false);

      await runAsync(['check', '--full', '--approve'], fixture.dir);

      expect(mock.chatCount()).toBe(2);
    });
  });

  // ── The feature stays off for everyone who never opted in ────────────────
  it('is byte-identical to the whole-project gate on a rewritten project that never opted in', () => {
    // The guard reads nothing without a scope, so a repository with a checkout
    // filter and no `progressive` block must be untouched by any of this — the
    // one assertion that keeps a state this pervasive from reaching people who
    // never asked for the mode.
    const withMode = rewritingProject('rewrite-optin', EOL_ATTRIBUTES);
    // The same project in every respect but the one key — built without going
    // through `rewritingProject`, which opts in by construction.
    const plain = createProgressiveFixture({ label: 'rewrite-optout' });
    fixtures.push(plain);
    plain.commit('.gitattributes', EOL_ATTRIBUTES);
    recheckoutSources(plain.dir, SOURCES);
    run(['check', '--approve', '--only-deterministic'], plain.dir);

    const measured = run(['check'], withMode.dir);
    const unmeasured = run(['check'], plain.dir);

    expect(unmeasured.status).toBe(1);
    // The unmeasured run knows nothing of scopes, so it carries no progressive
    // segment and no notice; what must match is the FINDINGS, which is the whole
    // claim that the guard only ever adds scope.
    expect(errorSection(unmeasured.stdout)).toBe(errorSection(measured.stdout));
    expect(unmeasured.stdout).not.toContain('Content check:');
    expect(unmeasured.stdout).not.toContain('outside your changes');
  });
});
