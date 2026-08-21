// =============================================================================
// tests/unit/roots/history-replay-fixes.test.ts — sibling to
// history-replay.test.ts, split out for reviewer-prompt headroom (the repo's
// new-pins-go-in-new-files convention): the review-driven killer tests and
// own-mutation pins. Shares the same helper preamble; the main file keeps
// the acceptance-criteria suites. Original header follows.
// the lifecycle/value-event/alias
// replay (`src/roots/history-replay.ts`): per-scope lifecycle rows, D5's raw
// value-tuple change events, and rename-edge alias resolution, folded from
// real commit records over real, deterministic git repositories. Every blob
// is fetched through the real `readBlobs` plumbing and extracted through the
// real `makeBlobRecordReader` read-through cache — the same route a real
// index build uses; nothing here is mocked or hand-typed as a stand-in blob
// record.
//
// The property every acceptance ultimately serves: the fold is a function of
// the commit SET, never of arrival order. Acceptances 8 and 9 pin that
// directly (byte-identical output across three arrival orders; a split-walk
// resumed through the real six-file store equals one un-split fold), and the
// rest establish the per-field rules an order-dependent implementation could
// not satisfy at all.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  initDeterministicGitFixture,
  runDeterministicGitFixture,
  deterministicCommitIndexAt,
} from '../../support/git-fixture.js';
import { walkHistory, readBlobs, type HistoryCommitRecord } from '../../../src/utils/git-history.js';
import { makeBlobRecordReader, carriesLifecycleRows } from '../../../src/roots/history.js';
import type { BlobRecord } from '../../../src/roots/history.js';
import {
  createReplayState,
  replayCommit,
  finishReplay,
  serializeReplayState,
  deserializeReplayState,
  type ReplayThresholds,
  type BlobRecordLookup,
  type LifecycleRow,
  type ReplayResult,
} from '../../../src/roots/history-replay.js';
import { writeHistoryState, readHistoryState } from '../../../src/io/roots-history-store.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import type { RootsConfig } from '../../../src/model/graph.js';

// -----------------------------------------------------------------------------
// Shared fixture plumbing: a real deterministic repo, a real blob-record
// cache, a real `BlobRecordLookup` that pre-resolves every (sha, relPath) a
// set of walked commits could need — the synchronous contract `replayCommit`
// takes, matching T8's own windowed probe-then-fetch protocol's shape
// (resolve first, replay synchronously after).
// -----------------------------------------------------------------------------

const dirsToCleanup: string[] = [];

const DETERMINISTIC_EPOCH_SECONDS = Math.floor(Date.parse('2024-01-01T00:00:00Z') / 1000);

type ReplayStateEvents = import('../../../src/roots/history-replay.js').ValueEvent[];
type ReplayStateAliases = import('../../../src/roots/history-replay.js').AliasEdge[];
afterEach(async () => {
  for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

function track(dir: string): string {
  dirsToCleanup.push(dir);
  return dir;
}

function freshRepo(): string {
  const dir = track(mkdtempSync(path.join(tmpdir(), 'yg-replay-repo-')));
  initDeterministicGitFixture(dir);
  return dir;
}

async function freshCacheDir(): Promise<string> {
  return track(await mkdtemp(path.join(tmpdir(), 'yg-replay-cache-')));
}

function headSha(dir: string): string {
  const r = runDeterministicGitFixture(dir, ['rev-parse', 'HEAD'], 0);
  if (r.status !== 0) throw new Error(`git rev-parse HEAD failed in ${dir}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

/** Write and commit a set of repo-relative files at day `day` (deterministic index grid), returning HEAD's sha. */
function commitFiles(dir: string, day: number, files: Record<string, string>, message: string, seq = 0): string {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
  const idx = deterministicCommitIndexAt(day, seq);
  const add = runDeterministicGitFixture(dir, ['add', '-A'], idx);
  if (add.status !== 0) throw new Error(`git add failed in ${dir}: ${add.stderr}${add.stdout}`);
  const commit = runDeterministicGitFixture(dir, ['commit', '-q', '-m', message], idx);
  if (commit.status !== 0) throw new Error(`git commit failed in ${dir}: ${commit.stderr}${commit.stdout}`);
  return headSha(dir);
}

/** `git mv` + commit at day `day`. */
function renameCommit(dir: string, day: number, from: string, to: string, message: string, seq = 0): string {
  const idx = deterministicCommitIndexAt(day, seq);
  const mv = runDeterministicGitFixture(dir, ['mv', from, to], idx);
  if (mv.status !== 0) throw new Error(`git mv failed in ${dir}: ${mv.stderr}${mv.stdout}`);
  const commit = runDeterministicGitFixture(dir, ['commit', '-q', '-m', message], idx);
  if (commit.status !== 0) throw new Error(`git commit failed in ${dir}: ${commit.stderr}${commit.stdout}`);
  return headSha(dir);
}

/** `git rm` + commit at day `day`. */
function deleteCommit(dir: string, day: number, relPath: string, message: string, seq = 0): string {
  const idx = deterministicCommitIndexAt(day, seq);
  const rmCmd = runDeterministicGitFixture(dir, ['rm', '-q', relPath], idx);
  if (rmCmd.status !== 0) throw new Error(`git rm failed in ${dir}: ${rmCmd.stderr}${rmCmd.stdout}`);
  const commit = runDeterministicGitFixture(dir, ['commit', '-q', '-m', message], idx);
  if (commit.status !== 0) throw new Error(`git commit failed in ${dir}: ${commit.stderr}${commit.stdout}`);
  return headSha(dir);
}

async function walkAll(repoDir: string): Promise<HistoryCommitRecord[]> {
  const commits: HistoryCommitRecord[] = [];
  await walkHistory(repoDir, { agentIdentities: [] }, (c) => commits.push(c));
  return commits;
}

/**
 * Pre-resolve every (sha, relPath) pair a set of commits' file records could
 * need — both images of every `A`/`M`/`R`/`C` record, the SAME resolution
 * `history.ts`'s `makeBlobRecordReader` performs for a real index — into a
 * plain, synchronous `BlobRecordLookup`. `D`/`T` records resolve nothing
 * (matching the module under test's own contract).
 */
async function buildLookup(repoDir: string, cacheDir: string, config: RootsConfig, commits: readonly HistoryCommitRecord[]): Promise<BlobRecordLookup> {
  const needed = new Map<string, { sha: string; relPath: string }>();
  for (const c of commits) {
    for (const f of c.files) {
      if (f.status === 'D' || f.status === 'T') continue;
      const postPath = f.newPath ?? f.path;
      if (f.postSha) needed.set(`${f.postSha}::${postPath}`, { sha: f.postSha, relPath: postPath });
      if (f.preSha) needed.set(`${f.preSha}::${f.path}`, { sha: f.preSha, relPath: f.path });
    }
  }

  const shas = [...new Set([...needed.values()].map((v) => v.sha))];
  const contentBySha = new Map<string, Buffer>();
  if (shas.length > 0) {
    await readBlobs(repoDir, shas, (sha, content) => {
      contentBySha.set(sha, content);
    });
  }

  const reader = makeBlobRecordReader(cacheDir, config);
  const resolved = new Map<string, BlobRecord>();
  for (const { sha, relPath } of needed.values()) {
    const record = await reader(sha, relPath, contentBySha.get(sha));
    resolved.set(`${sha}::${relPath}`, record);
  }

  return {
    get(sha: string, relPath: string): BlobRecord | undefined {
      return resolved.get(`${sha}::${relPath}`);
    },
  };
}

const DEFAULT_THRESHOLDS: ReplayThresholds = { churnEarlyDays: 14, lifecycleFileMaxKb: 300, lifecycleMaxAppearances: 200 };

function thresholdsFrom(config: RootsConfig): ReplayThresholds {
  return {
    churnEarlyDays: config.history.churnEarlyDays,
    lifecycleFileMaxKb: config.history.lifecycleFileMaxKb,
    lifecycleMaxAppearances: config.history.lifecycleMaxAppearances,
  };
}

/** D17 gate 2's path-only predicate, bound to one real config — what `state.carriesLifecycleRows` needs (F1). */
function gate2From(config: RootsConfig): (relPath: string) => boolean {
  return (relPath: string) => carriesLifecycleRows(relPath, config);
}

/** A trivial predicate for tests that build `ReplayState` by hand and never feed a D/T record through `processRecord` — no real config in scope, so nothing needs D17 gate 2 answered for real. */
const ALWAYS_CARRIES = () => true;

/** Fold every commit (in the given order) into a fresh state and finish — the single-shot helper most acceptances need. */
async function replayAll(repoDir: string, cacheDir: string, config: RootsConfig, commits: readonly HistoryCommitRecord[]): Promise<ReplayResult> {
  const lookup = await buildLookup(repoDir, cacheDir, config, commits);
  const state = createReplayState(thresholdsFrom(config), gate2From(config));
  for (const commit of commits) replayCommit(state, commit, lookup);
  return finishReplay(state);
}

function rowFor(result: ReplayResult, key: string): LifecycleRow | undefined {
  return result.lifecycle.find((r) => r.key === key);
}

function scopeRowsFor(result: ReplayResult, relPath: string): LifecycleRow[] {
  return result.lifecycle.filter((r) => r.level === 'scope' && r.key.startsWith(`${relPath}#`));
}

// -----------------------------------------------------------------------------
// Content builders — a single-scope TypeScript file (one exported function),
// varied by a body-only touch marker so a repeated commit is a genuine edit
// without risking `-M`'s rename-similarity threshold.
// -----------------------------------------------------------------------------

function widgetSrc(touch = 0): string {
  return `export function widget(): number {\n  return ${touch};\n}\n`;
}

/**
 * Two DIFFERENT scopes sharing one name, `widget` — the ordinal-disambiguation
 * fixture acceptance 5 needs. `extractUnits`' own occurrence counter is keyed
 * `${kind} ${name}` FILE-WIDE (`extract.ts`'s own comment), never per
 * enclosing class, so two same-named methods in two different classes get
 * distinct `qualifiedName`s (`widget`, `widget#1`) even though neither is an
 * overload SIGNATURE in the TypeScript sense — a bare signature declaration
 * (no body) is not itself a named-body scope `extractUnits` ever emits.
 */

describe('modifications is sha-keyed (F2)', () => {
  it('re-folding the SAME commit a second time does not double-count it', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'a.ts': widgetSrc(0) }, 'introduce a.ts');
    commitFiles(dir, 5, { 'a.ts': widgetSrc(1) }, 'modify a.ts');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const lookup = await buildLookup(dir, cacheDir, config, commits);

    const state = createReplayState(thresholdsFrom(config), gate2From(config));
    for (const c of commits) replayCommit(state, c, lookup);
    // Re-feed the SECOND commit again — must not move modifications.
    replayCommit(state, commits[1], lookup);
    const result = finishReplay(state);

    const fileRow = rowFor(result, 'a.ts')!;
    expect(fileRow.modifications).toBe(1); // two distinct commits, not three calls
    const scopeRow = scopeRowsFor(result, 'a.ts').find((r) => r.key.includes('#method#widget'))!;
    expect(scopeRow.modifications).toBe(1);
  });

  it('R4-I2: two files sharing a commit, alias-merged by rename onto one target — whole fold equals split-and-resumed fold', async () => {
    // a.ts+b.ts introduced/touched together, then a.ts->z.ts, rm z.ts, b.ts->z.ts — closure
    // {a.ts:z.ts, b.ts:z.ts}. Pre-fix, a split fold disagreed with an unsplit one here.
    const dir = freshRepo();
    commitFiles(dir, 0, { 'a.ts': widgetSrc(0), 'b.ts': widgetSrc(0) }, 'introduce a.ts and b.ts');
    commitFiles(dir, 1, { 'a.ts': widgetSrc(1), 'b.ts': widgetSrc(1) }, 'touch a.ts and b.ts');
    renameCommit(dir, 10, 'a.ts', 'z.ts', 'rename a.ts to z.ts');
    deleteCommit(dir, 20, 'z.ts', 'remove z.ts');
    renameCommit(dir, 30, 'b.ts', 'z.ts', 'rename b.ts to z.ts');
    const commits = await walkAll(dir);
    expect(commits).toHaveLength(5);

    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const thresholds = thresholdsFrom(config);
    const gate2 = gate2From(config);
    const lookup = await buildLookup(dir, cacheDir, config, commits);

    // whole: one continuous fold.
    const wholeState = createReplayState(thresholds, gate2);
    for (const c of commits) replayCommit(wholeState, c, lookup);
    const wholeResult = finishReplay(wholeState);

    // split: fold the shared-commit half, persist, resume, fold the alias-merge half.
    const firstHalf = commits.slice(0, 2);
    const secondHalf = commits.slice(2);
    const firstState = createReplayState(thresholds, gate2);
    for (const c of firstHalf) replayCommit(firstState, c, lookup);
    const snapshot = serializeReplayState(firstState);
    const stateDir = await mkdtemp(path.join(tmpdir(), 'yg-replay-state-r4i2-'));
    dirsToCleanup.push(stateDir);
    await writeHistoryState(stateDir, {
      meta: { stateSchemaVersion: 1, stateEpoch: 'epoch-r4i2' },
      lifecycle: snapshot.lifecycle,
      events: snapshot.events,
      aliases: snapshot.aliases,
      cochangeRaw: [],
      cochange: [],
    });
    const loaded = await readHistoryState(stateDir);
    expect(loaded).toBeDefined();
    const resumedState = deserializeReplayState(
      { lifecycle: loaded!.lifecycle as LifecycleRow[], events: loaded!.events as ReplayStateEvents, aliases: loaded!.aliases as ReplayStateAliases },
      thresholds,
      gate2,
    );
    for (const c of secondHalf) replayCommit(resumedState, c, lookup);
    const splitResult = finishReplay(resumedState);

    // R4-I2 itself: structurally identical.
    expect(splitResult).toEqual(wholeResult);

    // Pin exact numbers: pure-sum pools every contributor (2+2+3=7, -1=6 file; -1=5 scope).
    const fileRow = rowFor(wholeResult, 'z.ts');
    const scopeRow = scopeRowsFor(wholeResult, 'z.ts').find((r) => r.key.includes('#method#widget') || r.key.includes('#function#widget'));
    expect(fileRow?.modifications).toBe(6);
    expect(scopeRow?.modifications).toBe(5);
    expect(rowFor(wholeResult, 'a.ts')).toBeUndefined();
    expect(rowFor(wholeResult, 'b.ts')).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// F3 killer: the appearance cap is PER-PATH — each raw, pre-alias row's own
// touch count — never a merged total an alias closure pools from a rename.
// -----------------------------------------------------------------------------

describe('appearance cap is per-path, not pooled across a rename (F3)', () => {
  it('a file renamed near the cap is NOT demoted when neither raw path individually crosses it, though the pooled total would', async () => {
    const dir = freshRepo();
    const CAP = 3;
    // a.ts: 2 raw touches. Renamed to b.ts at day 2 (a touch on b.ts's own
    // raw row). b.ts: 2 raw touches. Neither raw count exceeds CAP=3, but
    // the pooled merged total (4) would.
    commitFiles(dir, 0, { 'a.ts': widgetSrc(0) }, 'introduce a.ts');
    commitFiles(dir, 1, { 'a.ts': widgetSrc(1) }, 'touch a.ts');
    renameCommit(dir, 2, 'a.ts', 'b.ts', 'rename a.ts to b.ts');
    commitFiles(dir, 3, { 'b.ts': widgetSrc(3) }, 'touch b.ts');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig(`history:\n  lifecycleMaxAppearances: ${CAP}\n`);
    const result = await replayAll(dir, cacheDir, config, commits);

    const fileRow = rowFor(result, 'b.ts')!;
    expect(fileRow).toBeDefined();
    // The MERGED file-level row still carries the pooled total.
    expect(fileRow.modifications + 1).toBe(4);
    // But per-path demotion means neither raw contributor crossed the cap.
    expect(scopeRowsFor(result, 'b.ts').filter((r) => r.key.includes('#method#widget'))).toHaveLength(1);
  });

  it('a demoted rename target drops its WHOLE merged scope row at the final key, not just its own contribution (R4 V-2)', async () => {
    const dir = freshRepo();
    const CAP = 2;
    // a.ts under CAP; renamed to b.ts, edited twice more — b.ts's own raw count (3) is over
    // CAP. a.ts's scope row alias-merges onto b.ts's key — pre-fix the drop ran before that
    // merge, so a.ts's row survived alone, stale at day 1 vs day 4.
    commitFiles(dir, 0, { 'a.ts': widgetSrc(0) }, 'introduce a.ts');
    commitFiles(dir, 1, { 'a.ts': widgetSrc(1) }, 'edit a.ts before rename');
    renameCommit(dir, 2, 'a.ts', 'b.ts', 'rename a.ts to b.ts');
    commitFiles(dir, 3, { 'b.ts': widgetSrc(3) }, 'edit b.ts after rename');
    commitFiles(dir, 4, { 'b.ts': widgetSrc(4) }, 'edit b.ts again');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig(`history:\n  lifecycleMaxAppearances: ${CAP}\n`);
    const result = await replayAll(dir, cacheDir, config, commits);

    const fileRow = rowFor(result, 'b.ts')!;
    expect(fileRow).toBeDefined();
    // The file-level row always carries the pooled history; never demoted.
    expect(fileRow.modifications + 1).toBe(5); // 5 distinct commits total
    expect(fileRow.lastModifiedTs).toBe(DETERMINISTIC_EPOCH_SECONDS + 4 * 86400);

    // No scope row survives at the demoted final key.
    const scopeRow = scopeRowsFor(result, 'b.ts').find((r) => r.key.includes('#method#widget'));
    expect(scopeRow).toBeUndefined();

    const survivingEvents = result.events.filter((e) => e.key === 'b.ts#method#widget');
    expect(survivingEvents).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Own mutations: the sha tie-break on same-timestamp touches, the
// lifecycleFileMaxKb size guard, and fixTouches counting.
// -----------------------------------------------------------------------------

describe('own mutation — greatest-(ts, sha) tie-break decides authorKind/lastTouchSha on a timestamp tie', () => {
  it('two touches at the identical committerTs are decided by sha, not by fold order', async () => {
    // Two independent branches merged such that both parents' own commits
    // land at the SAME committer timestamp is awkward to script through git
    // directly; instead this drives replayCommit with two hand-shaped
    // HistoryCommitRecords sharing one file record's scope, over a REAL
    // extracted blob record (never a fabricated scope) so only the
    // tie-break itself is synthetic.
    const dir = freshRepo();
    commitFiles(dir, 0, { 'a.ts': widgetSrc(0) }, 'introduce a.ts');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const lookup = await buildLookup(dir, cacheDir, config, commits);
    const real = commits[0];

    const shaLow = '1'.repeat(40);
    const shaHigh = 'f'.repeat(40);
    const touchA: HistoryCommitRecord = { ...real, sha: shaLow, authorKind: 'human', files: real.files };
    const touchB: HistoryCommitRecord = { ...real, sha: shaHigh, authorKind: 'agent', files: real.files };

    const state = createReplayState(thresholdsFrom(config), gate2From(config));
    replayCommit(state, touchA, lookup);
    replayCommit(state, touchB, lookup);
    const result = finishReplay(state);
    const row = scopeRowsFor(result, 'a.ts').find((r) => r.key.includes('#method#widget'))!;
    expect(row.lastTouchSha).toBe(shaHigh);
    expect(row.authorKind).toBe('agent');

    // Feeding them in the OPPOSITE order must not change the winner — the
    // tie-break is on (ts, sha), never on arrival order.
    const stateReversed = createReplayState(thresholdsFrom(config), gate2From(config));
    replayCommit(stateReversed, touchB, lookup);
    replayCommit(stateReversed, touchA, lookup);
    const resultReversed = finishReplay(stateReversed);
    const rowReversed = scopeRowsFor(resultReversed, 'a.ts').find((r) => r.key.includes('#method#widget'))!;
    expect(rowReversed.lastTouchSha).toBe(shaHigh);
    expect(rowReversed.authorKind).toBe('agent');
  });
});

describe('R4-I15 killer — feedDistinctMin\'s second-smallest-DISTINCT guard (F6)', () => {
  it('two touches sharing the identical committerTs leave firstModifiedTs null (not equal to firstSeenTs) and churnedEarly false', async () => {
    // Same hand-shaped-record technique as the sha-tie-break test above: two
    // HistoryCommitRecords sharing one real file record's committerTs
    // (only their sha/authorKind differ), so the row is touched TWICE at the
    // SAME ts. `firstModifiedTs` must stay null — there is no SECOND DISTINCT
    // touch timestamp, only one value seen twice — which is exactly the
    // guard `feedDistinctMin`'s `v === min1` branch exists to preserve.
    const dir = freshRepo();
    commitFiles(dir, 0, { 'a.ts': widgetSrc(0) }, 'introduce a.ts');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const lookup = await buildLookup(dir, cacheDir, config, commits);
    const real = commits[0];

    const touchA: HistoryCommitRecord = { ...real, sha: '1'.repeat(40), files: real.files };
    const touchB: HistoryCommitRecord = { ...real, sha: '2'.repeat(40), files: real.files };

    const state = createReplayState(thresholdsFrom(config), gate2From(config));
    replayCommit(state, touchA, lookup);
    replayCommit(state, touchB, lookup);
    const result = finishReplay(state);
    const row = scopeRowsFor(result, 'a.ts').find((r) => r.key.includes('#method#widget'))!;

    expect(row.firstModifiedTs).toBeNull();
    expect(row.churnedEarly).toBe(false);
  });
});

describe('own mutation — history.lifecycleFileMaxKb demotes an over-size blob to file-level only', () => {
  it('a blob over the configured lifecycleFileMaxKb keeps its file-level row but produces no scope rows or events', async () => {
    const dir = freshRepo();
    // A real, parseable TypeScript file padded past a tiny configured cap.
    const bigBody = `export function widget(): number {\n  // ${'x'.repeat(4000)}\n  return 1;\n}\n`;
    commitFiles(dir, 0, { 'src/big.ts': bigBody }, 'introduce big.ts');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    // 1 KB cap — the padded body above is several KB.
    const config = await defaultRootsConfig('history:\n  lifecycleFileMaxKb: 1\n');
    const result = await replayAll(dir, cacheDir, config, commits);

    const fileRow = rowFor(result, 'src/big.ts');
    expect(fileRow).toBeDefined();
    expect(fileRow!.level).toBe('file');
    expect(scopeRowsFor(result, 'src/big.ts')).toHaveLength(0);
    expect(result.events.filter((e) => e.key.startsWith('src/big.ts#'))).toHaveLength(0);
  });
});

describe('own mutation — fixTouches counts distinct fix-classified touching commits', () => {
  it('a fix-prefixed commit message increments fixTouches; a non-fix one does not', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'a.ts': widgetSrc(0) }, 'introduce a.ts');
    commitFiles(dir, 5, { 'a.ts': widgetSrc(1) }, 'refactor a.ts');
    commitFiles(dir, 10, { 'a.ts': widgetSrc(2) }, 'fix: correct widget() bug');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const result = await replayAll(dir, cacheDir, config, commits);

    const fileRow = rowFor(result, 'a.ts')!;
    expect(fileRow.fixTouches).toBe(1);
    const scopeRow = scopeRowsFor(result, 'a.ts').find((r) => r.key.includes('#method#widget'))!;
    expect(scopeRow.fixTouches).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Degraded/defensive branches (R4-I10): an oversize/unparseable blob keeps its
// file-level row; an unresolved blob is a logged caller-contract violation,
// never a silent swallow; the same for a record with no postSha at all.
// -----------------------------------------------------------------------------

describe('degraded branches', () => {
  it('an oversize blob (over history.blobMaxBytes) keeps its file-level row with no scope processing', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'src/big.ts': widgetSrc(0) }, 'introduce big.ts');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    // 10-byte cap — any real file is over it, forcing the 'oversize' skip
    // `history.ts` itself records (distinct from this module's OWN
    // `lifecycleFileMaxKb` gate, covered by its own dedicated test above).
    const config = await defaultRootsConfig('history:\n  blobMaxBytes: 10\n');
    const result = await replayAll(dir, cacheDir, config, commits);

    const fileRow = rowFor(result, 'src/big.ts');
    expect(fileRow).toBeDefined();
    expect(fileRow!.level).toBe('file');
    expect(scopeRowsFor(result, 'src/big.ts')).toHaveLength(0);
  });

  it('a record whose post-image blob was never resolved by the caller is logged and skipped, never silently dropped without a trace', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'src/widget.ts': widgetSrc(0) }, 'introduce widget');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const realLookup = await buildLookup(dir, cacheDir, config, commits);

    // A lookup that "forgets" the one resolution the caller should have made.
    const forgetfulLookup: BlobRecordLookup = {
      get(sha: string, relPath: string) {
        if (relPath === 'src/widget.ts') return undefined;
        return realLookup.get(sha, relPath);
      },
    };

    const state = createReplayState(thresholdsFrom(config), gate2From(config));
    for (const c of commits) replayCommit(state, c, forgetfulLookup);
    const result = finishReplay(state);

    expect(rowFor(result, 'src/widget.ts')).toBeUndefined();
    expect(scopeRowsFor(result, 'src/widget.ts')).toHaveLength(0);
  });

  it('a record with no postSha at all (a caller/upstream contract violation) is logged and skipped rather than throwing', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'src/widget.ts': widgetSrc(0) }, 'introduce widget');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const lookup = await buildLookup(dir, cacheDir, config, commits);

    const malformed: HistoryCommitRecord = {
      ...commits[0],
      files: commits[0].files.map((f) => ({ ...f, postSha: null })),
    };

    const state = createReplayState(thresholdsFrom(config), gate2From(config));
    expect(() => replayCommit(state, malformed, lookup)).not.toThrow();
    const result = finishReplay(state);
    expect(result.lifecycle).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// `serializeReplayState`'s own three comparators — tie-break coverage a
// small, naturally-shaped fixture history does not exercise (two rows
// sharing a key at different levels never arises from a real fold, since the
// two key spaces are disjoint; two events/aliases sharing their primary sort
// key does, and is worth pinning directly).
// -----------------------------------------------------------------------------

describe('serializeReplayState — raw accumulator sort orders', () => {
  it('sorts lifecycle rows by (key, level), events by (ts, key, kind, sha), and aliases by (ts, sha, from)', () => {
    const state = createReplayState(DEFAULT_THRESHOLDS, ALWAYS_CARRIES);
    state.rows.set('b.ts', { key: 'b.ts', level: 'file', firstSeenTs: 0, firstModifiedTs: null, lastModifiedTs: 0, modifications: 0, churnedEarly: false, fixTouches: 0, authorKind: 'human', lastTouchSha: 'a'.repeat(40), lastHumanCommitTs: 0 });
    state.rows.set('a.ts', { key: 'a.ts', level: 'file', firstSeenTs: 0, firstModifiedTs: null, lastModifiedTs: 0, modifications: 0, churnedEarly: false, fixTouches: 0, authorKind: 'human', lastTouchSha: 'a'.repeat(40), lastHumanCommitTs: 0 });

    state.events.push(
      { key: 'a.ts#method#z', ts: 100, kind: 'change', value: { nameShape: 'a', firstStatementType: null, returnShape: null, decorators: [], supertypes: [], nodeTypesSeen: [], calleeTexts: [] }, authorHash: 'h', authorKind: 'human', sha: 'b'.repeat(40) },
      { key: 'a.ts#method#z', ts: 100, kind: 'change', value: { nameShape: 'a', firstStatementType: null, returnShape: null, decorators: [], supertypes: [], nodeTypesSeen: [], calleeTexts: [] }, authorHash: 'h', authorKind: 'human', sha: 'a'.repeat(40) },
      { key: 'a.ts#method#z', ts: 100, kind: 'introduction', value: { nameShape: 'a', firstStatementType: null, returnShape: null, decorators: [], supertypes: [], nodeTypesSeen: [], calleeTexts: [] }, authorHash: 'h', authorKind: 'human', sha: 'a'.repeat(40) },
      { key: 'a.ts#method#y', ts: 100, kind: 'change', value: { nameShape: 'a', firstStatementType: null, returnShape: null, decorators: [], supertypes: [], nodeTypesSeen: [], calleeTexts: [] }, authorHash: 'h', authorKind: 'human', sha: 'a'.repeat(40) },
      { key: 'a.ts#method#z', ts: 50, kind: 'change', value: { nameShape: 'a', firstStatementType: null, returnShape: null, decorators: [], supertypes: [], nodeTypesSeen: [], calleeTexts: [] }, authorHash: 'h', authorKind: 'human', sha: 'a'.repeat(40) },
    );

    state.aliasEdges.push(
      { from: 'z.ts', to: 'y.ts', ts: 10, sha: 'a'.repeat(40) },
      { from: 'y.ts', to: 'x.ts', ts: 10, sha: 'a'.repeat(40) },
      { from: 'q.ts', to: 'p.ts', ts: 10, sha: 'b'.repeat(40) },
      { from: 'r.ts', to: 'p.ts', ts: 5, sha: 'c'.repeat(40) },
    );

    const snapshot = serializeReplayState(state);
    expect(snapshot.lifecycle.map((r) => r.key)).toEqual(['a.ts', 'b.ts']);
    expect(snapshot.events.map((e) => [e.ts, e.key, e.kind, e.sha])).toEqual([
      [50, 'a.ts#method#z', 'change', 'a'.repeat(40)],
      [100, 'a.ts#method#y', 'change', 'a'.repeat(40)],
      [100, 'a.ts#method#z', 'change', 'a'.repeat(40)],
      [100, 'a.ts#method#z', 'change', 'b'.repeat(40)],
      [100, 'a.ts#method#z', 'introduction', 'a'.repeat(40)],
    ]);
    expect(snapshot.aliases.map((e) => [e.ts, e.sha, e.from])).toEqual([
      [5, 'c'.repeat(40), 'r.ts'],
      [10, 'a'.repeat(40), 'y.ts'],
      [10, 'a'.repeat(40), 'z.ts'],
      [10, 'b'.repeat(40), 'q.ts'],
    ]);
  });
});

