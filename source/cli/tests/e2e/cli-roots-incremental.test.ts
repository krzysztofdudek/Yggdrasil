import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGoldenRepo } from '../support/roots-golden.js';
import { buildHistoryGoldenSpec } from '../fixtures/roots/golden/history/spec.js';
import { buildTypeScriptGoldenSpec } from '../fixtures/roots/golden/typescript/spec.js';
import { buildBranchMergeFixture, appendMergeOfOlderSideBranch } from '../support/branch-merge-fixture.js';
import { deterministicCommitIndexAt, initDeterministicGitFixture, runDeterministicGitFixture, runGitFixture } from '../support/git-fixture.js';

// =============================================================================
// tests/e2e/cli-roots-incremental.test.ts — R4 Task 9's own centerpiece: the
// determinism suite (a)-(h), acceptance criteria 2-5, and the build-lock
// refusal (acceptance 4's e2e half). A genuine `dist/bin.js` child process
// against real on-disk git repositories throughout, never anything imported
// from src/**. Composes ONLY `tests/support/**` primitives plus the
// established golden-spec-import pattern `tests/e2e/cli-roots-basic.test.ts`
// already uses (a golden's own builder spec carries no src/** import
// itself) — this suite creates no fixture helper of its own under
// tests/support/.
//
// Acceptance 1's own reading governs every comparison below: the SIX cases
// that compare models compare FILE BYTES, never a parsed deep-equal: (a),
// (b), (c), (d), (e), (f). Cases (g) and (h) compare no models across runs —
// (g) because a dirtied working file legitimately moves the body
// (`dirtyWeight`), (h) because a degraded index is not byte-comparable to a
// full one — each asserts its own named surface instead.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** Writes a minimal `.yggdrasil/yg-config.yaml` with a `roots: {}` block already present — every case in this suite needs one, never the scaffold path (that is `cli-roots-basic.test.ts`'s own job). */
function writeMinimalConfig(dir: string): void {
  mkdirSync(path.join(dir, '.yggdrasil'), { recursive: true });
  writeFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'version: "5.2.0"\nroots: {}\n', 'utf-8');
}

function modelPath(dir: string): string {
  return path.join(dir, '.yggdrasil', 'roots', 'model.json');
}

function historyStateDir(dir: string): string {
  return path.join(dir, '.yggdrasil', 'roots', '.cache', 'history');
}

function readModelJson(dir: string): { header: Record<string, unknown>; body: Record<string, unknown> } {
  return JSON.parse(readFileSync(modelPath(dir), 'utf-8'));
}

/** A real, freshly-built `history/` golden repository (T3's 25-commit deterministic history) — caller owns cleanup (`rmSync`). */
function buildHistoryProject(): string {
  return buildGoldenRepo(buildHistoryGoldenSpec());
}

/** A real, freshly-built TypeScript golden — used only where this suite needs SOME real git repository and the history golden's own 25-commit shape is not the point (acceptance 3, case (h)'s shallow-clone half) — caller owns cleanup. */
function buildTypeScriptProject(): string {
  return buildGoldenRepo(buildTypeScriptGoldenSpec());
}

/** One deterministic git operation, throwing with real stderr/stdout on failure — the same idiom `tests/support/roots-golden.ts`'s own `runOrThrow` uses, duplicated here (not exported from that module) rather than adding a new tests/support file for this suite alone. */
function runOrThrow(dir: string, args: string[], commitIndex: number, extraEnv: NodeJS.ProcessEnv = {}): void {
  const r = runDeterministicGitFixture(dir, args, commitIndex, { extraEnv });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
  }
}

const ALICE_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'alice',
  GIT_AUTHOR_EMAIL: 'alice@golden.test',
  GIT_COMMITTER_NAME: 'alice',
  GIT_COMMITTER_EMAIL: 'alice@golden.test',
};

function headSha(dir: string): string {
  const r = runGitFixture(dir, ['rev-parse', 'HEAD']);
  if (r.status !== 0) throw new Error(`git rev-parse HEAD failed in ${dir}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

/**
 * Clone `sourceDir`'s full history into a fresh temp directory — `git init` +
 * `git fetch` every ref, NOT `git clone` directly (that command's own
 * repository-discovery step cannot be pinned ahead of time — the same
 * reasoning `tests/support/roots-golden.ts`'s own `cloneGoldenBundle` states
 * for the identical shape, fetching from a bundle file instead of a plain
 * repo path). Mirrors that function exactly, duplicated locally rather than
 * exported (it fetches from a directory, not a `.bundle`, so it is not
 * literally the same function).
 */
function cloneFullHistory(sourceDir: string, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-roots-incr-clone-${label}-`));
  const init = initDeterministicGitFixture(dir);
  if (init.status !== 0) throw new Error(`git init failed in ${dir}: ${init.stderr}${init.stdout}`);
  const fetch = runGitFixture(dir, ['fetch', '-q', sourceDir, 'refs/heads/*:refs/remotes/src/*']);
  if (fetch.status !== 0) throw new Error(`git fetch ${sourceDir} failed in ${dir}: ${fetch.stderr}${fetch.stdout}`);
  const checkout = runGitFixture(dir, ['checkout', '-q', '-B', 'main', 'refs/remotes/src/main']);
  if (checkout.status !== 0) throw new Error(`git checkout main failed in ${dir}: ${checkout.stderr}${checkout.stdout}`);
  return dir;
}

/** A shallow (`--depth 1`) clone of `sourceDir` — plain, non-deterministic git plumbing (a one-off setup command, not a scripted history), matching `tests/unit/roots/golden-controls.test.ts`'s own shallow-clone control. */
function shallowClone(sourceDir: string, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-roots-incr-shallow-${label}-`));
  const throwing = (args: string[]): void => {
    const r = runGitFixture(dir, args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
  };
  throwing(['init', '-q']);
  throwing(['remote', 'add', 'origin', `file://${sourceDir}`]);
  throwing(['fetch', '-q', '--depth', '1', 'origin', 'main']);
  throwing(['checkout', '-q', 'FETCH_HEAD']);
  return dir;
}

const HISTORY_STATE_FILES = ['lifecycle.jsonl', 'events.jsonl', 'aliases.jsonl', 'cochange-raw.jsonl', 'cochange.jsonl', 'meta.json'];

/** Byte-compares every one of the six replay-state files between two state directories — R4-I2's byte-identity claim covers all six, not only `model.json` (D1). */
function expectHistoryStateBytesEqual(dirA: string, dirB: string): void {
  for (const f of HISTORY_STATE_FILES) {
    const a = readFileSync(path.join(historyStateDir(dirA), f));
    const b = readFileSync(path.join(historyStateDir(dirB), f));
    expect(a.equals(b), `history state file ${f} differs`).toBe(true);
  }
}

describe.skipIf(!distExists)('CLI E2E — yg roots index incremental/resume determinism suite (R4 Task 9)', () => {
  // ---------------------------------------------------------------------
  // (a) double `--full` on the pristine history/ golden ⇒ byte-identical
  // model.json, header included. Named here because (d)/(e)/(f) all compare
  // their model against THIS one's, and (e) hand-derives the 25-commit
  // figure from it: every one of the golden's 25 commits is a non-merge
  // (T3), so a full walk reports 25 commits walked.
  // ---------------------------------------------------------------------
  it('(a) double --full on the pristine history/ golden is byte-identical, header included, and both runs report 25 commits walked', () => {
    const dir = buildHistoryProject();
    try {
      writeMinimalConfig(dir);
      const first = run(['roots', 'index', '--full'], dir);
      expect(first.status).toBe(0);
      expect(first.stderr).toContain('Reviewed 25 commit');

      // On a COLD first index (no prior state at all), every
      // resolved key is a genuine miss — `historyStats.parsed`'s own
      // definition (a UNION of every run's non-skipped cache keys, seeded
      // from nothing here) and the stderr summary's own "read N historical
      // file version(s) not seen before" figure (this run's `onParsed`
      // count) name the identical set on a cold run, so they must agree
      // exactly, and neither may be the vacuous zero a broken onParsed
      // wiring would report. One caveat keeps this honest: onParsed also
      // fires for an EXPENSIVE skip (oversize/unparseable), which never
      // enters `parsed` — the two figures coincide here because this
      // golden deliberately carries no such blob; a fixture that adds one
      // must expect the stderr figure to exceed `parsed` by that count.
      const parsedMatch = /read (\d+) historical file version/.exec(first.stderr);
      expect(parsedMatch).not.toBeNull();
      const coldBlobCount = Number(parsedMatch![1]);
      expect(coldBlobCount).toBeGreaterThan(0);
      const coldModel = readModelJson(dir);
      const coldHistoryStats = coldModel.body.historyStats as { parsed: number };
      expect(coldBlobCount).toBe(coldHistoryStats.parsed);

      const firstBytes = readFileSync(modelPath(dir));

      const second = run(['roots', 'index', '--full'], dir);
      expect(second.status).toBe(0);
      expect(second.stderr).toContain('Reviewed 25 commit');
      // The warm counterpart of the cold-run figure above: a full re-walk
      // against the warm cache resolves every key as a hit and extracts
      // nothing, so the summary's not-seen-before figure must be exactly
      // zero — a reader that silently re-extracted hits (reporting them as
      // fresh reads) would move this number, not just waste work.
      expect(second.stderr).toContain('read 0 historical file version');
      const secondBytes = readFileSync(modelPath(dir));

      expect(secondBytes.equals(firstBytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // (b) incremental ≡ full — the ONLY real resume comparison in this suite.
  // ---------------------------------------------------------------------
  it('(b) incremental ≡ full: resuming onto three prescribed commits matches a fresh clone\'s --full walk, model AND replay state byte-identical', () => {
    const dir = buildHistoryProject();
    let freshClone: string | undefined;
    try {
      writeMinimalConfig(dir);

      // N: the golden's own day-400 tip, indexed once (full walk, no state yet).
      const first = run(['roots', 'index'], dir);
      expect(first.status).toBe(0);

      // A commit strictly earlier than N — the day-395 commit (HEAD~1 right
      // after the golden was built, before any of N+1/N+2 below) — captured
      // now, before HEAD moves, so it names a real ancestor for N+3's
      // older-side-branch merge.
      const beforeAppendCheck = runGitFixture(dir, ['rev-parse', 'HEAD~1']);
      expect(beforeAppendCheck.status).toBe(0);
      const olderAncestorSha = beforeAppendCheck.stdout.trim();

      // N+1 (day 402): decorate Order with NO body change — a change event
      // the resumed walk can only produce by resolving the record's own
      // PRE-IMAGE blob from the blob cache the first run already filled
      // (order.ts's day-250 revision, never re-walked in the resume range).
      const orderPath = path.join(dir, 'src/svc/order.ts');
      const orderBefore = readFileSync(orderPath, 'utf-8');
      writeFileSync(orderPath, orderBefore.replace(/^export class Order \{/m, '@Decorated()\nexport class Order {'), 'utf-8');
      const idx1 = deterministicCommitIndexAt(402);
      runOrThrow(dir, ['add', '-A'], idx1, ALICE_ENV);
      runOrThrow(dir, ['commit', '-q', '-m', 'feat: decorate Order (no body change)'], idx1, ALICE_ENV);

      // N+2 (day 405): re-touch the already-supported order pair (proving
      // raw supports and per-file commit counts survive the run boundary)
      // AND rename a tracked file in the SAME commit (proving alias edges
      // accumulate across runs and the closure is taken over the union).
      appendFileSync(orderPath, '// touched again at day 405\n');
      appendFileSync(path.join(dir, 'test/order.spec.ts'), '// touched again at day 405\n');
      const idx2 = deterministicCommitIndexAt(405);
      const mv = runDeterministicGitFixture(dir, ['mv', 'src/idle/idle0.ts', 'src/idle/idle0-renamed.ts'], idx2, { extraEnv: ALICE_ENV });
      expect(mv.status).toBe(0);
      runOrThrow(dir, ['add', '-A'], idx2, ALICE_ENV);
      runOrThrow(dir, ['commit', '-q', '-m', 'chore: retouch order pair + rename idle0'], idx2, ALICE_ENV);

      // N+3: a merge of a side branch whose own commit is dated BEFORE N —
      // side at day 390, merge at day 410, folded onto whatever is checked
      // out now. HEAD afterwards is the merge.
      appendMergeOfOlderSideBranch(dir, {
        branchFrom: olderAncestorSha,
        sideDayOffset: 390,
        mergeDayOffset: 410,
        author: 'alice',
      });

      // Resume: walks lastIndexedSha(N)..HEAD, which contains N+1, N+2's
      // commit, the day-390 side commit, and the merge — in a completely
      // different relative position than a full walk would place the
      // day-390 commit.
      const resumeRun = run(['roots', 'index'], dir);
      expect(resumeRun.status).toBe(0);
      const resumeBytes = readFileSync(modelPath(dir));

      // The reference: a FRESH clone of the exact same final history, --full.
      freshClone = cloneFullHistory(dir, 'b');
      writeMinimalConfig(freshClone);
      const fullRun = run(['roots', 'index', '--full'], freshClone);
      expect(fullRun.status).toBe(0);
      const fullBytes = readFileSync(modelPath(freshClone));

      expect(resumeBytes.equals(fullBytes)).toBe(true);
      expectHistoryStateBytesEqual(dir, freshClone);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (freshClone) rmSync(freshClone, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // (c) cache-state independence: deleting .cache/ entirely and re-indexing
  // yields a byte-identical model (the deleted cache is a pending rebuild,
  // so D13's short-circuit does not fire — condition 4 fails). The
  // zero-parse figure belongs to the FOLLOWING run (--full against the now-
  // warm cache), never to the cold run itself.
  // ---------------------------------------------------------------------
  it('(c) cache-state independence: deleting .cache/ and re-indexing is byte-identical; the NEXT --full parses zero blobs', () => {
    const dir = buildHistoryProject();
    try {
      writeMinimalConfig(dir);
      const first = run(['roots', 'index'], dir);
      expect(first.status).toBe(0);
      const baselineBytes = readFileSync(modelPath(dir));

      rmSync(path.join(dir, '.yggdrasil', 'roots', '.cache'), { recursive: true, force: true });
      const second = run(['roots', 'index'], dir);
      expect(second.status).toBe(0);
      const secondBytes = readFileSync(modelPath(dir));
      expect(secondBytes.equals(baselineBytes)).toBe(true);

      // The cache is warm again now (`second` rebuilt it). A plain `index`
      // here would be answered by D13's short-circuit and prove nothing
      // (it would parse zero blobs without walking anything) — `--full`
      // forces a real re-walk against the now-warm cache instead.
      const third = run(['roots', 'index', '--full'], dir);
      expect(third.status).toBe(0);
      expect(third.stderr).toContain('read 0 historical file version');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // (d) unreachable SHA: hand-edit the state's lastIndexedSha to a
  // well-formed but absent sha ⇒ falls back to a full walk, model
  // byte-identical to (a)'s.
  // ---------------------------------------------------------------------
  it('(d) an unreachable lastIndexedSha forces a full walk, byte-identical model', () => {
    const dir = buildHistoryProject();
    try {
      writeMinimalConfig(dir);
      const first = run(['roots', 'index'], dir);
      expect(first.status).toBe(0);
      const baselineBytes = readFileSync(modelPath(dir));

      const metaPath = path.join(historyStateDir(dir), 'meta.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      expect(typeof meta.lastIndexedSha).toBe('string');
      meta.lastIndexedSha = '0123456789abcdef0123456789abcdef01234567'.slice(0, 40); // well-formed, never a real commit here
      writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');

      const second = run(['roots', 'index'], dir);
      expect(second.status).toBe(0);
      // A model comparison alone would be satisfied by a wrongly-accepted
      // short-circuit that writes nothing — the walk-mode claim this
      // case is named for is only pinned by observing a real full walk ran.
      expect(second.stderr).toContain('Reviewed 25 commit');
      const secondBytes = readFileSync(modelPath(dir));
      expect(secondBytes.equals(baselineBytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // (e) inputs mismatch: corrupt the stored inputsHash (standing in for a
  // bumped EXTRACTOR_VERSION, which this suite cannot flip on the real
  // running binary) ⇒ full walk, same model, AND historyStats equal to
  // (a)'s field for field — the case's SECOND point requires observing the
  // full walk actually happened: the 25-commit figure in the stderr summary,
  // never 0 (which a wrongly-resumed run — the state's lastIndexedSha IS
  // HEAD — would report despite an identical model).
  // ---------------------------------------------------------------------
  it('(e) an inputsHash mismatch forces a full walk, same model, and the summary proves it (25 commits, never 0)', () => {
    const dir = buildHistoryProject();
    try {
      writeMinimalConfig(dir);
      const first = run(['roots', 'index'], dir);
      expect(first.status).toBe(0);
      const baselineBytes = readFileSync(modelPath(dir));
      const baselineModel = readModelJson(dir);

      const metaPath = path.join(historyStateDir(dir), 'meta.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      meta.inputsHash = 'f'.repeat(64); // stands in for a bumped EXTRACTOR_VERSION
      writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');

      const second = run(['roots', 'index'], dir);
      expect(second.status).toBe(0);
      expect(second.stderr).toContain('Reviewed 25 commit');
      const secondBytes = readFileSync(modelPath(dir));
      const secondModel = readModelJson(dir);
      expect(secondBytes.equals(baselineBytes)).toBe(true);
      expect(secondModel.body.historyStats).toEqual(baselineModel.body.historyStats);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // (f) hostile state, three shapes — each forces a full walk, same model,
  // no crash.
  // ---------------------------------------------------------------------
  describe('(f) hostile state', () => {
    it('a torn events.jsonl (truncated mid-line) forces a full walk, same model, no crash', () => {
      const dir = buildHistoryProject();
      try {
        writeMinimalConfig(dir);
        const first = run(['roots', 'index'], dir);
        expect(first.status).toBe(0);
        const baselineBytes = readFileSync(modelPath(dir));

        const eventsPath = path.join(historyStateDir(dir), 'events.jsonl');
        const raw = readFileSync(eventsPath, 'utf-8');
        // Cut off partway through the LAST line's own content — not at a
        // newline boundary — so the store sees a genuinely malformed line,
        // not merely a missing trailing record.
        const truncated = raw.slice(0, Math.max(1, raw.length - 5));
        writeFileSync(eventsPath, truncated, 'utf-8');

        const second = run(['roots', 'index'], dir);
        expect(second.status).toBe(0);
        // Model bytes alone would also be satisfied by a wrongly-accepted
        // short-circuit that writes nothing — assert the walk actually
        // ran.
        expect(second.stderr).toContain('Reviewed 25 commit');
        const secondBytes = readFileSync(modelPath(dir));
        expect(secondBytes.equals(baselineBytes)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('an earlier stateEpoch in meta.json beside current accumulators (a torn-write shape, D15) forces a full walk, same model', () => {
      const dir = buildHistoryProject();
      try {
        writeMinimalConfig(dir);
        const first = run(['roots', 'index'], dir);
        expect(first.status).toBe(0);
        const oldMetaBytes = readFileSync(path.join(historyStateDir(dir), 'meta.json'));

        // Advance the state by one real, MODEL-MOVING commit — a `.md` file
        // has no registered grammar, so a NOTES.md-only commit would produce
        // no lifecycle row, no value event and no co-change pair, making a
        // wrongly-accepted torn state's double-apply invisible to the byte
        // comparison below, which an earlier version of this case wrongly
        // relied on. Appending a new method to
        // `src/svc/order.ts` — a tracked TypeScript file the golden already
        // mines — is a genuine mined-scope introduction: modifications, the
        // event list, and order.ts's own lifecycle row all move, so a torn
        // state that gets wrongly accepted and re-applies this commit on top
        // of accumulators that already contain it changes the model instead
        // of leaving it byte-identical.
        const orderPath = path.join(dir, 'src/svc/order.ts');
        const orderBefore = readFileSync(orderPath, 'utf-8');
        const withNewMethod = orderBefore.replace(/\}\n$/, '  fourth() {\n    return 13;\n  }\n}\n');
        expect(withNewMethod).not.toBe(orderBefore); // the replace actually matched
        writeFileSync(orderPath, withNewMethod, 'utf-8');
        const idx = deterministicCommitIndexAt(401);
        runOrThrow(dir, ['add', '-A'], idx, ALICE_ENV);
        runOrThrow(dir, ['commit', '-q', '-m', 'feat: add Order.fourth()'], idx, ALICE_ENV);
        const resumed = run(['roots', 'index'], dir);
        expect(resumed.status).toBe(0);
        const cleanBytes = readFileSync(modelPath(dir));

        // The torn-write shape: the five accumulators carry the NEW epoch;
        // meta.json is overwritten with the OLD one.
        writeFileSync(path.join(historyStateDir(dir), 'meta.json'), oldMetaBytes);

        const third = run(['roots', 'index'], dir);
        expect(third.status).toBe(0);
        // The torn meta.json must be REJECTED (D15's epoch check), forcing a
        // fresh full walk of all 26 commits (the golden's 25 plus the new
        // order.ts commit) — not a resume that silently re-applies commit 26
        // onto accumulators that already contain it. A model comparison
        // alone cannot distinguish "rejected and re-walked" from "wrongly
        // accepted and harmlessly re-applied a no-op commit" — this
        // is exactly the observable the earlier NOTES.md version lacked.
        expect(third.stderr).toContain('Reviewed 26 commit');
        const thirdBytes = readFileSync(modelPath(dir));
        expect(thirdBytes.equals(cleanBytes)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('one of the six state files missing outright (the other five clean and epoch-consistent) forces a full walk, same model', () => {
      const dir = buildHistoryProject();
      try {
        writeMinimalConfig(dir);
        const first = run(['roots', 'index'], dir);
        expect(first.status).toBe(0);
        const baselineBytes = readFileSync(modelPath(dir));

        rmSync(path.join(historyStateDir(dir), 'cochange.jsonl'));

        const second = run(['roots', 'index'], dir);
        expect(second.status).toBe(0);
        // Model bytes alone would also be satisfied by a wrongly-accepted
        // short-circuit that writes nothing — assert the walk actually
        // ran.
        expect(second.stderr).toContain('Reviewed 25 commit');
        const secondBytes = readFileSync(modelPath(dir));
        expect(secondBytes.equals(baselineBytes)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------
  // (g) merge HEAD: a fixture repository whose HEAD is a merge commit
  // (`trailingMainCommit: false`) — indexes and records the merge's sha as
  // lastIndexedSha. A second index on a DIRTIED tree resumes an EMPTY
  // range (no commits, since HEAD has not moved), never a full walk.
  // Model bytes are never compared here (a dirty file legitimately moves
  // dirtyWeight) — only the anchor and the zero-commits figure.
  // ---------------------------------------------------------------------
  it('(g) a merge HEAD, then a dirtied tree, resumes an empty range: lastIndexedSha unchanged, zero commits walked', () => {
    const fixture = buildBranchMergeFixture({ trailingMainCommit: false });
    const dir = fixture.dir;
    try {
      writeMinimalConfig(dir);
      const first = run(['roots', 'index'], dir);
      expect(first.status).toBe(0);
      const model1 = readModelJson(dir);
      expect(model1.header.lastIndexedSha).toBe(fixture.shas.merge);
      // The header alone is a near-tautology (it is just getHeadSha()) — the
      // surface D13 condition 3 actually anchors on is `meta.json`'s OWN
      // `lastIndexedSha`, so this case must assert that surface too, not
      // only the header's echo of it.
      const meta1 = JSON.parse(readFileSync(path.join(historyStateDir(dir), 'meta.json'), 'utf-8'));
      expect(meta1.lastIndexedSha).toBe(fixture.shas.merge);

      // Dirty ONE tracked file (uncommitted) — the short-circuit's
      // dirtyHash input now differs, so condition 1 fails and the run
      // reaches decideWalkMode instead of being swallowed by D13.
      const baseFile = path.join(dir, 'src/base.ts');
      writeFileSync(baseFile, readFileSync(baseFile, 'utf-8') + '\n// dirty, uncommitted\n');

      const second = run(['roots', 'index'], dir);
      expect(second.status).toBe(0);
      expect(second.stderr).toContain('Reviewed 0 commit');
      const model2 = readModelJson(dir);
      expect(model2.header.lastIndexedSha).toBe(fixture.shas.merge);
      const meta2 = JSON.parse(readFileSync(path.join(historyStateDir(dir), 'meta.json'), 'utf-8'));
      expect(meta2.lastIndexedSha).toBe(fixture.shas.merge);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // (h) degraded walks leave lastIndexedSha null, with NO replay state
  // directory beside it — the negative half of case (g). Two repositories:
  // no .git at all, and a shallow clone.
  // ---------------------------------------------------------------------
  describe('(h) degraded walks leave lastIndexedSha null, no state directory', () => {
    it('a repository with no .git at all: exits 0, writes a model, lastIndexedSha null, no history state directory', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'yg-roots-incr-nogit-'));
      try {
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
        writeMinimalConfig(dir);

        const result = run(['roots', 'index'], dir);
        expect(result.status).toBe(0);
        const model = readModelJson(dir);
        expect(model.header.lastIndexedSha).toBeNull();
        expect(existsSync(historyStateDir(dir))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a shallow clone (--depth 1): exits 0, writes a model, lastIndexedSha null, no history state directory', () => {
      const golden = buildTypeScriptProject();
      let shallow: string | undefined;
      try {
        shallow = shallowClone(golden, 'h');
        const isShallow = runGitFixture(shallow, ['rev-parse', '--is-shallow-repository']);
        expect(isShallow.stdout.trim()).toBe('true');

        writeMinimalConfig(shallow);
        const result = run(['roots', 'index'], shallow);
        expect(result.status).toBe(0);
        const model = readModelJson(shallow);
        expect(model.header.lastIndexedSha).toBeNull();
        expect(existsSync(historyStateDir(shallow))).toBe(false);
      } finally {
        rmSync(golden, { recursive: true, force: true });
        if (shallow) rmSync(shallow, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------
  // D13 condition 3's anchor is `meta.json`'s OWN `lastIndexedSha` — never
  // the stored model header's, which is an OUTPUT the header-assembly step
  // writes as `headSha` on every successful walk and so can never itself
  // prove the replay STATE is safely resumable. Hand-editing only
  // `meta.json`'s `lastIndexedSha` field (its `stateEpoch` deliberately left
  // untouched — the store COMPARES epochs across the six files, never
  // re-derives one from `meta.json`'s other fields, so this edit is not the
  // torn-write shape case (f)'s second shape exercises) simulates a state
  // whose replay position provably lags HEAD while the committed model
  // header still names the true HEAD. The short-circuit must not be fooled
  // by the header alone: it has to see the state is stale and let the run
  // proceed.
  // ---------------------------------------------------------------------
  it('a stale meta.json lastIndexedSha (behind HEAD, model header unaffected) is never declared already-current', () => {
    const dir = buildHistoryProject();
    try {
      writeMinimalConfig(dir);
      const first = run(['roots', 'index'], dir);
      expect(first.status).toBe(0);

      const staleAnchor = runGitFixture(dir, ['rev-parse', 'HEAD~3']);
      expect(staleAnchor.status).toBe(0);
      const staleSha = staleAnchor.stdout.trim();

      const metaPath = path.join(historyStateDir(dir), 'meta.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      expect(meta.lastIndexedSha).not.toBe(staleSha); // genuinely moves the anchor backward
      meta.lastIndexedSha = staleSha; // stateEpoch (and everything else) untouched on purpose
      writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');

      const second = run(['roots', 'index'], dir);
      expect(second.status).toBe(0);
      expect(second.stderr.toLowerCase()).not.toContain('already current');
      expect(second.stderr).toContain('Reviewed ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // Acceptance 3: `yg roots index --full` on the same tree produces the
  // same bytes as the incremental run. Two INDEPENDENTLY-computed full
  // walks — the first plain `index` (a fresh tree has no state, so it is
  // already a full walk by construction) and an explicit `--full` rerun on
  // the SAME unchanged tree (which bypasses D13's short-circuit outright,
  // so this is a genuine second computation, not a repeat of the same
  // bytes trivially).
  // ---------------------------------------------------------------------
  it('acceptance 3: --full on an unchanged tree matches the first plain index run\'s bytes', () => {
    const dir = buildTypeScriptProject();
    try {
      writeMinimalConfig(dir);
      const first = run(['roots', 'index'], dir);
      expect(first.status).toBe(0);
      const firstBytes = readFileSync(modelPath(dir));

      const full = run(['roots', 'index', '--full'], dir);
      expect(full.status).toBe(0);
      const fullBytes = readFileSync(modelPath(dir));

      expect(fullBytes.equals(firstBytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // Acceptance 4 (e2e half): a holder that NEVER releases is waited on for
  // the bounded window and only then refused, naming its pid — and the
  // first run's own model is untouched. The release-inside-the-window half
  // is deliberately NOT asserted here (it lives at T1's own unit level,
  // with an injected clock — see that suite) since observing it against a
  // real index would need a full run to finish inside the 2s default
  // window, a timing assertion this plan's global constraints forbid.
  // ---------------------------------------------------------------------
  it('acceptance 4: a build lock held by a pid that never releases is waited on, then refused by name, leaving the prior model intact', () => {
    const dir = buildTypeScriptProject();
    try {
      writeMinimalConfig(dir);
      const first = run(['roots', 'index'], dir);
      expect(first.status).toBe(0);
      const firstBytes = readFileSync(modelPath(dir));

      const lockPath = path.join(dir, '.yggdrasil', 'roots', '.cache', '.build.lock');
      mkdirSync(path.dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: 999999, createdAtMs: Date.now() }), 'utf-8');

      // `--full` bypasses D13's own short-circuit outright — a plain
      // `index` on this now-unchanged tree would answer "already current"
      // and never even try to acquire the lock, proving nothing about the
      // lock itself.
      const second = run(['roots', 'index', '--full'], dir);
      expect(second.status).not.toBe(0);
      expect(second.stderr).toContain('999999');
      expect(second.stderr.toLowerCase()).toContain('lock');

      const secondBytes = readFileSync(modelPath(dir));
      expect(secondBytes.equals(firstBytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // ---------------------------------------------------------------------
  // Acceptance 5: lastIndexedSha equals readHead().sha after ANY successful
  // index that walked history — including a merge HEAD (case (g) already
  // covers the merge-sha half; this pins the ordinary linear case too) —
  // and stays null in a non-git repo, a shallow clone, and after a degraded
  // walk (case (h) covers those).
  // ---------------------------------------------------------------------
  it('acceptance 5: lastIndexedSha equals HEAD after an ordinary linear-history index', () => {
    const dir = buildHistoryProject();
    try {
      writeMinimalConfig(dir);
      const result = run(['roots', 'index'], dir);
      expect(result.status).toBe(0);
      const model = readModelJson(dir);
      const actualHead = headSha(dir);
      expect(model.header.lastIndexedSha).toBe(actualHead);
      expect(model.header.headSha).toBe(actualHead);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
