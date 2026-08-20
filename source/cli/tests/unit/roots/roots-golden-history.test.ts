import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGoldenRepo,
  assertGoldenBundleEquivalence,
  type GoldenRepoSpec,
  type GoldenCommit,
} from '../../support/roots-golden.js';
import {
  runGitFixture,
  initDeterministicGitFixture,
  runDeterministicGitFixture,
  deterministicCommitDateAt,
  deterministicCommitIndexAt,
} from '../../support/git-fixture.js';
import { buildBranchMergeFixture, appendMergeOfOlderSideBranch } from '../../support/branch-merge-fixture.js';
import { buildTypeScriptGoldenSpec } from '../../fixtures/roots/golden/typescript/spec.js';
import { buildHistoryGoldenSpec } from '../../fixtures/roots/golden/history/spec.js';
import { parseAndExtractAll } from '../../../src/roots/pipeline.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import { getLanguageForExtension } from '../../../src/utils/language-registry.js';

// =============================================================================
// tests/unit/roots/roots-golden-history.test.ts — the golden harness's
// time-depth extension (a `dayOffset` field on `GoldenCommit`, the
// day-offset monotonicity guard, `deterministicCommitDateAt`/
// `deterministicCommitIndexAt`, and the shared branch-and-merge fixture),
// plus the R4 history golden itself: builder<->bundle equivalence, the
// scripted 25-commit shape, the two co-change populations counted by hand
// against the real repository, and the same-blob-two-verdicts pairs the
// golden carries by construction. No mining assertions run here — this
// golden's mined shape is a later suite's job once the mechanisms that
// read history land.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_BUNDLE_PATH = path.join(__dirname, '../../fixtures/roots/golden/history/history.bundle');
const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

const dirsToCleanup: string[] = [];
afterEach(() => {
  for (const d of dirsToCleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function track(dir: string): string {
  dirsToCleanup.push(dir);
  return dir;
}

/** `git <args>` in `dir`, throwing with real stderr/stdout on failure, returning trimmed stdout. */
function git(dir: string, args: string[]): string {
  const r = runGitFixture(dir, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
  return r.stdout;
}

function headSha(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** Every repo-relative path a commit's tree changed relative to its (sole, or none for the root commit) parent, sorted. */
function changedFilesOf(dir: string, sha: string): string[] {
  return git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha])
    .split('\n')
    .filter((l) => l.length > 0)
    .sort();
}

// -----------------------------------------------------------------------------
// The commit-index grid: `deterministicCommitDateAt`/`deterministicCommitIndexAt`
// pinned against real git output, and a proof that every export
// `git-fixture.ts` already had keeps its exact behavior.
// -----------------------------------------------------------------------------

describe('git-fixture.ts — deterministicCommitDateAt / deterministicCommitIndexAt (additive)', () => {
  it('a commit built at commit-index deterministicCommitIndexAt(day) reads back a %ct matching the epoch plus day*86400 seconds', () => {
    const dir = track(mkdtempSync(path.join(tmpdir(), 'yg-daygrid-')));
    const init = initDeterministicGitFixture(dir);
    expect(init.status).toBe(0);

    const epochSeconds = Math.floor(Date.parse(deterministicCommitDateAt(0)) / 1000);

    for (const day of [0, 7, 400]) {
      const idx = deterministicCommitIndexAt(day);
      const r = runDeterministicGitFixture(dir, ['commit', '--allow-empty', '-q', '-m', `day ${day}`], idx);
      expect(r.status).toBe(0);
      const ct = Number(git(dir, ['log', '-1', '--format=%ct']).trim());
      expect(ct).toBe(epochSeconds + day * 86_400);
    }
  });

  it('two builds of an unmodified landed golden spec still produce byte-identical HEAD SHAs', () => {
    const spec = buildTypeScriptGoldenSpec();
    const a = track(buildGoldenRepo(spec));
    const b = track(buildGoldenRepo(spec));
    expect(headSha(a)).toBe(headSha(b));
  });
});

// -----------------------------------------------------------------------------
// The dayOffset monotonicity guard.
// -----------------------------------------------------------------------------

describe('roots-golden.ts — dayOffset monotonicity guard', () => {
  function specWith(commits: GoldenCommit[], name = 'dip-spec'): GoldenRepoSpec {
    return { name, commits };
  }

  it('a spec whose dayOffset sequence decreases throws before any repository is created, naming the golden and the offending commit index', () => {
    const spec = specWith([
      { author: 'alice', dayOffset: 100, files: { 'a.txt': 'a\n' }, message: 'first' },
      { author: 'alice', dayOffset: 50, files: { 'b.txt': 'b\n' }, message: 'second (dips)' },
    ]);

    let thrown: unknown;
    try {
      buildGoldenRepo(spec);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('"dip-spec"');
    expect(message).toContain('commit index 1');
  });

  it('a mixed spec — an absent dayOffset (its index-derived day) followed by an explicit dayOffset — passes when ascending, exactly the shape every landed golden takes after its own trailing time-depth commit', () => {
    const spec = specWith(
      [
        { author: 'alice', files: { 'a.txt': 'a\n' }, message: 'seed (no dayOffset — resolves to day 0)' },
        { author: 'alice', dayOffset: 400, files: { 'NOTES.md': 'trailing\n' }, message: 'trailing note' },
      ],
      'mixed-ok',
    );
    expect(() => buildGoldenRepo(spec)).not.toThrow();
  });

  it('a mixed spec that genuinely dips — an explicit dayOffset followed by an absent one whose index-derived day is earlier — still throws', () => {
    // Commit 0 is explicitly dated day 500; commit 1 has no dayOffset, so
    // its resolved day is its own array index (1) worth of 60-second
    // spacing — far earlier than day 500. The guard catches this even
    // though only ONE commit in the pair names an explicit dayOffset.
    const spec = specWith(
      [
        { author: 'alice', dayOffset: 500, files: { 'a.txt': 'a\n' }, message: 'first, far in the future' },
        { author: 'alice', files: { 'b.txt': 'b\n' }, message: 'second, index-derived day is tiny' },
      ],
      'mixed-dip',
    );
    expect(() => buildGoldenRepo(spec)).toThrow(/dayOffset sequence dips/);
  });
});

// -----------------------------------------------------------------------------
// The shared branch-and-merge fixture.
// -----------------------------------------------------------------------------

describe('branch-merge-fixture.ts — buildBranchMergeFixture', () => {
  it('default call (trailingMainCommit true): the side branch is dated BEFORE main1, a full walk in build order delivers side before main1, and HEAD is main2 whose sole parent is the merge', () => {
    const fx = buildBranchMergeFixture();
    track(fx.dir);
    expect(fx.shas.main2).toBeDefined();

    const sideDate = Number(git(fx.dir, ['log', '-1', '--format=%ct', fx.shas.side]).trim());
    const main1Date = Number(git(fx.dir, ['log', '-1', '--format=%ct', fx.shas.main1]).trim());
    expect(sideDate).toBeLessThan(main1Date);

    const order = git(fx.dir, ['log', '--reverse', '--date-order', '--no-merges', '--format=%H'])
      .trim()
      .split('\n');
    expect(order.indexOf(fx.shas.side)).toBeLessThan(order.indexOf(fx.shas.main1));

    expect(headSha(fx.dir)).toBe(fx.shas.main2);
    expect(git(fx.dir, ['rev-parse', 'HEAD^']).trim()).toBe(fx.shas.merge);
  });

  it('trailingMainCommit false: same topology and date dip, but HEAD IS the merge commit and main2 is absent', () => {
    const fx = buildBranchMergeFixture({ trailingMainCommit: false });
    track(fx.dir);
    expect(fx.shas.main2).toBeUndefined();
    expect(headSha(fx.dir)).toBe(fx.shas.merge);

    const sideDate = Number(git(fx.dir, ['log', '-1', '--format=%ct', fx.shas.side]).trim());
    const main1Date = Number(git(fx.dir, ['log', '-1', '--format=%ct', fx.shas.main1]).trim());
    expect(sideDate).toBeLessThan(main1Date);
  });

  it("content contract: side introduces a file existing in no earlier commit; main1 touches only base's file; main2 touches only side's file; the merge writes nothing of its own", () => {
    const fx = buildBranchMergeFixture();
    track(fx.dir);

    expect(changedFilesOf(fx.dir, fx.shas.base)).toEqual(['src/base.ts']);

    expect(changedFilesOf(fx.dir, fx.shas.side)).toEqual(['src/side.ts']);
    const atBase = runGitFixture(fx.dir, ['cat-file', '-e', `${fx.shas.base}:src/side.ts`]);
    expect(atBase.status).not.toBe(0);

    expect(changedFilesOf(fx.dir, fx.shas.main1)).toEqual(['src/base.ts']);
    expect(changedFilesOf(fx.dir, fx.shas.main2 as string)).toEqual(['src/side.ts']);

    // A merge commit's OWN diff (no `-m`/`-c`) is empty for a clean,
    // conflict-free merge — git suppresses it by default, which is exactly
    // "the merge writes nothing of its own".
    expect(changedFilesOf(fx.dir, fx.shas.merge)).toEqual([]);
  });

  it("agrees, from an independent construction, with the direction the git-history unit suite's own local branch-and-merge capture pins: a full, date-ordered, no-merges walk places the side-branch commit before the mainline commit it is later merged past", () => {
    // Not a literal SHA comparison (different content/dates by design) —
    // the property both constructions must share is the ordering. Built
    // with trailingMainCommit false so the expected order is exactly
    // three commits (no main2 to account for).
    const fx = buildBranchMergeFixture({ trailingMainCommit: false });
    track(fx.dir);
    const order = git(fx.dir, ['log', '--reverse', '--date-order', '--no-merges', '--format=%H'])
      .trim()
      .split('\n');
    expect(order).toEqual([fx.shas.base, fx.shas.side, fx.shas.main1]);
  });
});

describe('branch-merge-fixture.ts — appendMergeOfOlderSideBranch', () => {
  it("applied to a freshly built history golden: HEAD becomes a merge whose second parent is dated before the golden's own tip", () => {
    const goldenDir = track(buildGoldenRepo(buildHistoryGoldenSpec()));
    const originalTip = headSha(goldenDir);
    const originalTipDate = Number(git(goldenDir, ['log', '-1', '--format=%ct', originalTip]).trim());
    const rootSha = git(goldenDir, ['rev-list', '--max-parents=0', 'HEAD']).trim();

    const result = appendMergeOfOlderSideBranch(goldenDir, {
      branchFrom: rootSha,
      sideDayOffset: 50, // well before the golden's own day-400 tip
      mergeDayOffset: 410, // after the golden's own tip
    });

    expect(headSha(goldenDir)).toBe(result.mergeSha);
    const parents = git(goldenDir, ['log', '-1', '--format=%P', result.mergeSha]).trim().split(' ');
    expect(parents).toContain(result.sideSha);

    const sideDate = Number(git(goldenDir, ['log', '-1', '--format=%ct', result.sideSha]).trim());
    expect(sideDate).toBeLessThan(originalTipDate);
  });
});

// -----------------------------------------------------------------------------
// The history golden itself.
// -----------------------------------------------------------------------------

describe('golden: history — builder spec <-> committed bundle equivalence', () => {
  it('the committed bundle still matches what the builder spec produces', () => {
    expect(() => assertGoldenBundleEquivalence(buildHistoryGoldenSpec(), HISTORY_BUNDLE_PATH)).not.toThrow();
  });

  it('a one-byte content drift in the spec, without rebuilding the bundle, fails equivalence naming "history" and the stale-bundle diagnostic', () => {
    const spec = buildHistoryGoldenSpec();
    const mutated: GoldenRepoSpec = {
      ...spec,
      commits: spec.commits.map((commit, index) =>
        index === 0 ? { ...commit, files: { ...commit.files, 'src/idle/idle0.ts': commit.files['src/idle/idle0.ts'] + '// one byte of drift\n' } } : commit,
      ),
    };

    let thrown: unknown;
    try {
      assertGoldenBundleEquivalence(mutated, HISTORY_BUNDLE_PATH);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('golden "history"');
    expect(message).toContain('HEAD sha mismatch');
    expect(message).toContain('stale');
  });
});

describe('golden: history — the scripted 25-commit shape', () => {
  it('building the golden twice yields identical HEAD SHAs', () => {
    const spec = buildHistoryGoldenSpec();
    const a = track(buildGoldenRepo(spec));
    const b = track(buildGoldenRepo(spec));
    expect(headSha(a)).toBe(headSha(b));
  });

  it('git log shows exactly the 25 scripted commits at the scripted dates, strictly ascending from day 0 to day 400', () => {
    const dir = track(buildGoldenRepo(buildHistoryGoldenSpec()));
    const lines = git(dir, ['log', '--reverse', '--date-order', '--format=%ct'])
      .trim()
      .split('\n')
      .map(Number);
    expect(lines.length).toBe(25);

    const expectedDays = [0, 20, 30, 60, 65, 90, 120, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 300, 320, 340, 360, 380, 395, 400];
    expect(expectedDays.length).toBe(25);

    const epochSeconds = Math.floor(Date.parse(deterministicCommitDateAt(0)) / 1000);
    const expectedTs = expectedDays.map((d) => epochSeconds + d * 86_400);
    expect(lines).toEqual(expectedTs);

    for (let i = 1; i < lines.length; i++) expect(lines[i]).toBeGreaterThan(lines[i - 1]);
  });
});

describe('golden: history — the 300-scope partition floor', () => {
  it('the live tree at HEAD clears the floor with real margin', async () => {
    const dir = track(buildGoldenRepo(buildHistoryGoldenSpec()));
    const config = await defaultRootsConfig();
    const { rawScopes } = await parseAndExtractAll(dir, config);
    // Hand-derived total, walked through spec.ts's own header arithmetic: 472.
    expect(rawScopes.length).toBe(472);
    expect(rawScopes.length).toBeGreaterThanOrEqual(400); // clears the 300 floor with real margin
  });
});

describe('golden: history — co-change populations counted by hand from the real repository', () => {
  it('src/svc/order.ts + test/order.spec.ts are touched together in exactly nine 2-file commits; src/svc/ship.ts + test/ship.spec.ts in exactly five; neither pair, nor NOTES.md, appears in any other 2..30-file commit', () => {
    const dir = track(buildGoldenRepo(buildHistoryGoldenSpec()));
    const shas = git(dir, ['log', '--reverse', '--format=%H']).trim().split('\n');
    expect(shas.length).toBe(25);

    let orderPairCount = 0;
    let shipPairCount = 0;

    for (const sha of shas) {
      const files = changedFilesOf(dir, sha);
      const touchesOrder = files.includes('src/svc/order.ts') || files.includes('test/order.spec.ts');
      const touchesShip = files.includes('src/svc/ship.ts') || files.includes('test/ship.spec.ts');
      const touchesNotes = files.includes('NOTES.md');

      if (files.length === 2 && touchesOrder) {
        expect(files).toEqual(['src/svc/order.ts', 'test/order.spec.ts']);
        orderPairCount++;
      }
      if (files.length === 2 && touchesShip) {
        expect(files).toEqual(['src/svc/ship.ts', 'test/ship.spec.ts']);
        shipPairCount++;
      }

      // The counted co-change band is 2..30 changed files: the day-0 seed
      // (93 files) and the day-150 mega-commit (40 files) both sit above
      // the cap and are excluded from it.
      if (files.length >= 2 && files.length <= 30) {
        if (touchesOrder) expect(files.length).toBe(2);
        if (touchesShip) expect(files.length).toBe(2);
        if (touchesNotes) throw new Error(`NOTES.md unexpectedly appears in a counted commit ${sha}: [${files.join(', ')}]`);
      }
    }

    expect(orderPairCount).toBe(9);
    expect(shipPairCount).toBe(5);
  });
});

describe('golden: history — the placeholder pair and the stub pair', () => {
  it("src/svc/placeholder.ts and docs/PLACEHOLDER.md are both empty, share the well-known empty blob sha, and docs/PLACEHOLDER.md is listed first in the day-0 commit's raw record order", () => {
    const dir = track(buildGoldenRepo(buildHistoryGoldenSpec()));
    const rootSha = git(dir, ['rev-list', '--max-parents=0', 'HEAD']).trim();

    const placeholderTs = git(dir, ['rev-parse', `${rootSha}:src/svc/placeholder.ts`]).trim();
    const placeholderMd = git(dir, ['rev-parse', `${rootSha}:docs/PLACEHOLDER.md`]).trim();
    expect(placeholderTs).toBe(EMPTY_BLOB_SHA);
    expect(placeholderMd).toBe(EMPTY_BLOB_SHA);

    const dayZeroFiles = changedFilesOf(dir, rootSha);
    expect(dayZeroFiles.indexOf('docs/PLACEHOLDER.md')).toBeLessThan(dayZeroFiles.indexOf('src/svc/placeholder.ts'));
  });

  it('src/stub/same.ts and src/stub/same.py carry byte-identical content and one shared blob sha, resolving to two different registered grammars', () => {
    const dir = track(buildGoldenRepo(buildHistoryGoldenSpec()));
    const rootSha = git(dir, ['rev-list', '--max-parents=0', 'HEAD']).trim();

    const tsSha = git(dir, ['rev-parse', `${rootSha}:src/stub/same.ts`]).trim();
    const pySha = git(dir, ['rev-parse', `${rootSha}:src/stub/same.py`]).trim();
    expect(tsSha).toBe(pySha);

    const tsContent = git(dir, ['cat-file', '-p', tsSha]);
    const pyContent = git(dir, ['cat-file', '-p', pySha]);
    expect(tsContent).toBe(pyContent);

    expect(getLanguageForExtension('.ts')).toBe('typescript');
    expect(getLanguageForExtension('.py')).toBe('python');
    expect(getLanguageForExtension('.ts')).not.toBe(getLanguageForExtension('.py'));
  });
});

// =============================================================================
// Review-inherited pins (Task 3 verify round): three properties the fixture
// harness promises that the scripted goldens alone never exercise — each was
// a live surviving mutant or an unasserted acceptance clause until pinned
// here.
// =============================================================================
describe('roots-golden.ts / branch-merge-fixture.ts — harness contracts the goldens alone do not exercise', () => {
  it('renames execute BEFORE the commit\'s files are written: a commit carrying both a rename and new content at the destination yields ONE R record with the changed content, and a commit writing one path while deleting another yields exactly {A, D}', () => {
    const body = (v: number): string =>
      [
        'export function stable0() { return 0; }',
        'export function stable1() { return 1; }',
        'export function stable2() { return 2; }',
        'export function stable3() { return 3; }',
        'export function stable4() { return 4; }',
        'export function stable5() { return 5; }',
        'export function stable6() { return 6; }',
        'export function stable7() { return 7; }',
        `export const edited = ${v};`,
        '',
      ].join('\n');
    const spec: GoldenRepoSpec = {
      name: 'rename-order-contract',
      commits: [
        { author: 'roots-golden', files: { 'src/a/x.ts': body(1), 'src/keep.ts': 'export const k = 1;\n' }, message: 'seed' },
        { author: 'roots-golden', renames: [{ from: 'src/a/x.ts', to: 'src/b/x.ts' }], files: { 'src/b/x.ts': body(2) }, message: 'move plus edit' },
        { author: 'roots-golden', files: { 'src/new.ts': 'export const n = 1;\n' }, deletes: ['src/keep.ts'], message: 'write plus delete' },
      ],
    };
    const dir = track(buildGoldenRepo(spec));
    const shas = git(dir, ['log', '--reverse', '--format=%H']).trim().split('\n');

    const moveRaw = git(dir, ['show', '--raw', '-M', '--format=', shas[1]])
      .trim()
      .split('\n');
    expect(moveRaw).toHaveLength(1);
    expect(moveRaw[0]).toMatch(/ R\d+\tsrc\/a\/x\.ts\tsrc\/b\/x\.ts$/);
    expect(git(dir, ['show', `${shas[1]}:src/b/x.ts`])).toContain('edited = 2');

    const wdRaw = git(dir, ['show', '--raw', '-M', '--format=', shas[2]])
      .trim()
      .split('\n')
      .sort();
    expect(wdRaw).toHaveLength(2);
    expect(wdRaw.join('\n')).toMatch(/ A\tsrc\/new\.ts$/m);
    expect(wdRaw.join('\n')).toMatch(/ D\tsrc\/keep\.ts$/m);
  });

  it('absent dayOffset resolves to the commit\'s OWN array index: a two-commit offsetless spec lands at the fixed epoch and epoch+60s, and a landed golden\'s seed commit sits exactly at the epoch', () => {
    const epoch = Date.parse('2024-01-01T00:00:00Z') / 1000;
    const spec: GoldenRepoSpec = {
      name: 'offsetless-grid',
      commits: [
        { author: 'roots-golden', files: { 'a.ts': 'export const a = 1;\n' }, message: 'c0' },
        { author: 'roots-golden', files: { 'b.ts': 'export const b = 1;\n' }, message: 'c1' },
      ],
    };
    const dir = track(buildGoldenRepo(spec));
    const cts = git(dir, ['log', '--reverse', '--format=%ct']).trim().split('\n').map(Number);
    expect(cts).toEqual([epoch, epoch + 60]);

    const landed = track(buildGoldenRepo(buildTypeScriptGoldenSpec()));
    const rootCt = Number(git(landed, ['log', '--reverse', '--format=%ct']).trim().split('\n')[0]);
    expect(rootCt).toBe(epoch);
  });

  it('buildBranchMergeFixture is reproducible: two independent builds yield identical SHAs for all five commits', () => {
    const a = buildBranchMergeFixture();
    track(a.dir);
    const b = buildBranchMergeFixture();
    track(b.dir);
    expect(b.shas).toEqual(a.shas);
  });
});
