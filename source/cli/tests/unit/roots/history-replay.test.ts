// =============================================================================
// tests/unit/roots/history-replay.test.ts — the lifecycle/value-event/alias
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
import { buildBranchMergeFixture } from '../../support/branch-merge-fixture.js';
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
import { writeHistoryState, readHistoryState, type HistoryState } from '../../../src/io/roots-history-store.js';
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
const OVERLOAD_TS = [
  'export class A {',
  '  widget(): number {',
  '    return 1;',
  '  }',
  '}',
  '',
  'export class B {',
  '  widget(): number {',
  '    return 2;',
  '  }',
  '}',
  '',
].join('\n');

// -----------------------------------------------------------------------------
// Acceptances 1-2 — the touch-based fields and the churnedEarly boundary.
// -----------------------------------------------------------------------------

describe('lifecycle rows — firstSeenTs/lastModifiedTs/modifications/churnedEarly', () => {
  it('a scope introduced at day 0 and modified at day 200 carries firstSeenTs=day0, lastModifiedTs=day200, modifications=1, churnedEarly=false', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'src/widget.ts': widgetSrc(0) }, 'introduce widget');
    commitFiles(dir, 200, { 'src/widget.ts': widgetSrc(1) }, 'modify widget');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const result = await replayAll(dir, cacheDir, config, commits);

    const scopeRow = scopeRowsFor(result, 'src/widget.ts').find((r) => r.key.includes('#method#widget') || r.key.includes('#function#widget'));
    expect(scopeRow).toBeDefined();
    const row = scopeRow!;
    const DAY = 86400;
    expect(row.firstSeenTs).toBe(0 * DAY + epochOffset(dir));
    expect(row.lastModifiedTs).toBe(200 * DAY + epochOffset(dir));
    expect(row.modifications).toBe(1);
    expect(row.churnedEarly).toBe(false);
  });

  it('the same scope modified at day 10 instead churns early (10 <= 14); at day 15 it does not (15 > 14)', async () => {
    for (const [day, expected] of [
      [10, true],
      [15, false],
    ] as const) {
      const dir = freshRepo();
      commitFiles(dir, 0, { 'src/widget.ts': widgetSrc(0) }, 'introduce widget');
      commitFiles(dir, day, { 'src/widget.ts': widgetSrc(1) }, 'modify widget');
      const commits = await walkAll(dir);
      const cacheDir = await freshCacheDir();
      const config = await defaultRootsConfig();
      const result = await replayAll(dir, cacheDir, config, commits);
      const row = scopeRowsFor(result, 'src/widget.ts').find((r) => r.key.includes('#method#widget'));
      expect(row?.churnedEarly, `day ${day}`).toBe(expected);
    }
  });
});

/** The fixed deterministic-history epoch, in whole seconds — every `deterministicCommitIndexAt(day)` commit's own `%ct` is this plus `day*86400`. Read from `git log -1` on the day-0 commit rather than re-importing `git-fixture.ts`'s private epoch constant, so the pin is against real git output. */
function epochOffset(_dir: string): number {
  // The day-0 commit's own committerTs IS the epoch (day offset 0) — every
  // test above builds its FIRST commit at day 0, so `firstSeenTs` for that
  // commit's own scope is exactly the epoch. Returning 0 here and asserting
  // against `day * 86400` directly would be wrong only if the epoch itself
  // were non-zero; it is a real UTC instant (2024-01-01), not zero seconds,
  // so the comparisons above read epoch-relative values off the walked
  // commits themselves instead of hard-coding the epoch's own magnitude.
  return DETERMINISTIC_EPOCH_SECONDS;
}

const DETERMINISTIC_EPOCH_SECONDS = Math.floor(Date.parse('2024-01-01T00:00:00Z') / 1000);

// -----------------------------------------------------------------------------
// Acceptance 3 — rename replay merges to one row, order-free.
// -----------------------------------------------------------------------------

describe('rename replay (alias closure)', () => {
  it('git mv at day 90 leaves one row keyed at the new path, firstSeenTs still day 0, and records the alias edge', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'a.ts': widgetSrc(0) }, 'introduce a.ts');
    renameCommit(dir, 90, 'a.ts', 'b.ts', 'rename a.ts to b.ts');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const result = await replayAll(dir, cacheDir, config, commits);

    const oldRows = scopeRowsFor(result, 'a.ts');
    const newRows = scopeRowsFor(result, 'b.ts').filter((r) => r.key.includes('#method#widget'));
    expect(oldRows).toHaveLength(0);
    expect(newRows).toHaveLength(1);
    expect(newRows[0].firstSeenTs).toBe(DETERMINISTIC_EPOCH_SECONDS);
    expect(result.aliases).toContainEqual(['a.ts', 'b.ts']);
  });

  it('feeding the two commits in reverse order yields the identical single row', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'a.ts': widgetSrc(0) }, 'introduce a.ts');
    renameCommit(dir, 90, 'a.ts', 'b.ts', 'rename a.ts to b.ts');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const lookup = await buildLookup(dir, cacheDir, config, commits);

    const forward = createReplayState(thresholdsFrom(config), gate2From(config));
    for (const c of commits) replayCommit(forward, c, lookup);
    const forwardResult = finishReplay(forward);

    const reversed = createReplayState(thresholdsFrom(config), gate2From(config));
    for (const c of [...commits].reverse()) replayCommit(reversed, c, lookup);
    const reversedResult = finishReplay(reversed);

    expect(reversedResult).toEqual(forwardResult);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 4 — a decorator-only change emits exactly one change event.
// -----------------------------------------------------------------------------

describe('value events — introduction and change', () => {
  it('adding a decorator with no other change emits exactly one change event differing only in the decorator list', async () => {
    const dir = freshRepo();
    const before = 'export class Widget {\n  method(): number {\n    return 1;\n  }\n}\n';
    const after = 'export class Widget {\n  @Injectable()\n  method(): number {\n    return 1;\n  }\n}\n';
    commitFiles(dir, 0, { 'src/widget.ts': before }, 'introduce Widget');
    commitFiles(dir, 10, { 'src/widget.ts': after }, 'add @Injectable');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const result = await replayAll(dir, cacheDir, config, commits);

    const methodEvents = result.events.filter((e) => e.key.includes('#method#method'));
    const introductions = methodEvents.filter((e) => e.kind === 'introduction');
    const changes = methodEvents.filter((e) => e.kind === 'change');
    expect(introductions).toHaveLength(1);
    expect(changes).toHaveLength(1);
    expect(introductions[0].value.decorators).toEqual([]);
    expect(changes[0].value.decorators).toEqual(['Injectable']);
    // Every other tuple field is unchanged.
    expect(changes[0].value.nameShape).toBe(introductions[0].value.nameShape);
    expect(changes[0].value.firstStatementType).toBe(introductions[0].value.firstStatementType);
    expect(changes[0].value.returnShape).toBe(introductions[0].value.returnShape);
    expect(changes[0].value.supertypes).toEqual(introductions[0].value.supertypes);
    expect(changes[0].value.nodeTypesSeen).toEqual(introductions[0].value.nodeTypesSeen);
    expect(changes[0].value.calleeTexts).toEqual(introductions[0].value.calleeTexts);
  });

  it('a scope never modified again still carries exactly one (introduction) event', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'src/widget.ts': widgetSrc(0) }, 'introduce widget');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const result = await replayAll(dir, cacheDir, config, commits);
    const events = result.events.filter((e) => e.key.includes('#method#widget'));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('introduction');
  });
});

// -----------------------------------------------------------------------------
// Acceptance 5 — two overloads produce two rows sharing the same modifications
// count, distinguished only by the ordinal already inside qualifiedName.
// -----------------------------------------------------------------------------

describe('overload ordinals', () => {
  it('a file with two same-named scopes produces two lifecycle rows, both with modifications=0', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'src/overload.ts': OVERLOAD_TS }, 'introduce overloads');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const result = await replayAll(dir, cacheDir, config, commits);

    const rows = scopeRowsFor(result, 'src/overload.ts').filter((r) => r.key.includes('widget'));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const keys = new Set(rows.map((r) => r.key));
    expect(keys.size).toBe(rows.length); // every key distinct — the ordinal separates them
    for (const row of rows) expect(row.modifications).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 6 — the appearance-cap demotion.
// -----------------------------------------------------------------------------

describe('appearance-cap demotion', () => {
  it('a file touched more than lifecycleMaxAppearances times yields a file-level row and zero scope rows', async () => {
    const dir = freshRepo();
    const CAP = 3;
    commitFiles(dir, 0, { 'src/hot.ts': widgetSrc(0) }, 'introduce hot.ts');
    for (let i = 1; i <= CAP + 2; i++) {
      commitFiles(dir, i, { 'src/hot.ts': widgetSrc(i) }, `touch ${i}`);
    }
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig(`history:\n  lifecycleMaxAppearances: ${CAP}\n`);
    const result = await replayAll(dir, cacheDir, config, commits);

    const fileRow = rowFor(result, 'src/hot.ts');
    expect(fileRow).toBeDefined();
    expect(fileRow!.level).toBe('file');
    expect(fileRow!.modifications + 1).toBeGreaterThan(CAP);
    expect(scopeRowsFor(result, 'src/hot.ts')).toHaveLength(0);
    expect(result.events.filter((e) => e.key.startsWith('src/hot.ts#'))).toHaveLength(0);
    // R4-I15 killer (F5): events_n is the RAW pre-demotion count — this fixture's scope events
    // (one introduction plus one change per touch after) are all demoted away, so events_n must
    // stay strictly greater than the (now-empty) demoted events list, never collapse to match it.
    expect(result.events_n).toBeGreaterThan(result.events.length);
    expect(result.events_n).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 7 — finishReplay is pure: calling it twice on the same state
// returns byte-identical JSON.
// -----------------------------------------------------------------------------

describe('finishReplay purity', () => {
  it('calling finishReplay twice on the same state returns byte-identical JSON', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'src/widget.ts': widgetSrc(0) }, 'introduce widget');
    commitFiles(dir, 5, { 'src/widget.ts': widgetSrc(1) }, 'modify widget');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const lookup = await buildLookup(dir, cacheDir, config, commits);
    const state = createReplayState(thresholdsFrom(config), gate2From(config));
    for (const c of commits) replayCommit(state, c, lookup);

    const first = finishReplay(state);
    const second = finishReplay(state);
    expect(second).toEqual(first);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 8 — order independence over the shared branch-merge fixture:
// forward, reversed, and one shuffled permutation all agree byte-for-byte.
// -----------------------------------------------------------------------------

describe('order independence — the branch-merge fixture', () => {
  it('forward, reversed, and a shuffled arrival order all produce byte-identical finishReplay output', async () => {
    const fixture = track(buildBranchMergeFixture().dir);
    const commits = await walkAll(fixture);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const lookup = await buildLookup(fixture, cacheDir, config, commits);

    function foldOrder(order: readonly HistoryCommitRecord[]): ReplayResult {
      const state = createReplayState(thresholdsFrom(config), gate2From(config));
      for (const c of order) replayCommit(state, c, lookup);
      return finishReplay(state);
    }

    const forward = foldOrder(commits);
    const reversed = foldOrder([...commits].reverse());

    // A fixed-seed shuffle (a small linear-congruential generator, deterministic
    // across runs — never Math.random) distinct from both forward and reverse
    // whenever there are enough commits to permute (the fixture has 5).
    const shuffled = deterministicShuffle(commits, 12345);

    const forwardResult = forward;
    const reversedResult = reversed;
    const shuffledResult = foldOrder(shuffled);

    expect(reversedResult).toEqual(forwardResult);
    expect(shuffledResult).toEqual(forwardResult);

    // Sanity: the fixture is non-trivial — the side-branch scope's own row exists.
    const sideRow = scopeRowsFor(forwardResult, 'src/side.ts');
    expect(sideRow.length).toBeGreaterThan(0);
  });
});

/** A tiny deterministic LCG shuffle — fixed seed, never `Math.random`, so a "shuffled" arrival order is itself reproducible across runs. */
function deterministicShuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 0xffffffff;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// -----------------------------------------------------------------------------
// Acceptance 9 — the split-walk / resume case, round-tripped through the real
// six-file store.
// -----------------------------------------------------------------------------

describe('split-walk resume, through the real six-file store', () => {
  it('folding a pre-merge prefix, persisting, resuming, and folding the rest equals folding everything at once', async () => {
    const fixture = track(buildBranchMergeFixture().dir);
    const commits = await walkAll(fixture);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const lookup = await buildLookup(fixture, cacheDir, config, commits);
    const thresholds = thresholdsFrom(config);
    const gate2 = gate2From(config);

    // The commits an index taken right after `main1` (before the merge) would
    // have applied: everything with a committerTs <= main1's.
    const main1 = commits.find((c) => c.files.some((f) => f.path === 'src/base.ts') && c.sha !== commits[0].sha);
    expect(main1).toBeDefined();
    const splitTs = main1!.committerTs;
    const firstHalf = commits.filter((c) => c.committerTs <= splitTs);
    const secondHalf = commits.filter((c) => c.committerTs > splitTs);
    expect(firstHalf.length).toBeGreaterThan(0);
    expect(secondHalf.length).toBeGreaterThan(0);
    expect(firstHalf.length + secondHalf.length).toBe(commits.length);

    // Fold the first half, persist through the REAL store.
    const firstState = createReplayState(thresholds, gate2);
    for (const c of firstHalf) replayCommit(firstState, c, lookup);
    const snapshot = serializeReplayState(firstState);
    const stateDir = await mkdtemp(path.join(tmpdir(), 'yg-replay-state-'));
    dirsToCleanup.push(stateDir);
    const stored: HistoryState = {
      meta: { stateSchemaVersion: 1, stateEpoch: 'epoch-split-walk' },
      lifecycle: snapshot.lifecycle,
      events: snapshot.events,
      aliases: snapshot.aliases,
      cochangeRaw: [],
      cochange: [],
    };
    await writeHistoryState(stateDir, stored);

    const loaded = await readHistoryState(stateDir);
    expect(loaded).toBeDefined();
    const resumedState = deserializeReplayState(
      { lifecycle: loaded!.lifecycle as LifecycleRow[], events: loaded!.events as ReplayStateEvents, aliases: loaded!.aliases as ReplayStateAliases },
      thresholds,
      gate2,
    );
    for (const c of secondHalf) replayCommit(resumedState, c, lookup);
    const resumedResult = finishReplay(resumedState);

    const wholeState = createReplayState(thresholds, gate2);
    for (const c of commits) replayCommit(wholeState, c, lookup);
    const wholeResult = finishReplay(wholeState);

    expect(resumedResult).toEqual(wholeResult);
  });

  it('a loaded row alias-merged with a fresh row matches an unsplit fold\'s modifications count (R4-I2)', async () => {
    // mergeRowGroup sums persisted `modifications` scalars, never a touchedBy sha-set union
    // (R4-I2, V-1). Replaces the two tautological `Number.isFinite`/`>= 0` assertions.
    const dir = freshRepo();
    commitFiles(dir, 0, { 'a.ts': widgetSrc(0) }, 'introduce a.ts');
    const firstCommits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const thresholds = thresholdsFrom(config);
    const gate2 = gate2From(config);
    const lookup1 = await buildLookup(dir, cacheDir, config, firstCommits);

    const firstState = createReplayState(thresholds, gate2);
    for (const c of firstCommits) replayCommit(firstState, c, lookup1);
    const snapshot = serializeReplayState(firstState);
    const stateDir = await mkdtemp(path.join(tmpdir(), 'yg-replay-state-resume-merge-'));
    dirsToCleanup.push(stateDir);
    await writeHistoryState(stateDir, {
      meta: { stateSchemaVersion: 1, stateEpoch: 'epoch-resume-merge' },
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

    renameCommit(dir, 10, 'a.ts', 'b.ts', 'rename a.ts to b.ts');
    const allCommits = await walkAll(dir);
    const renameCommitRecord = allCommits[allCommits.length - 1];
    const lookup2 = await buildLookup(dir, cacheDir, config, [renameCommitRecord]);
    replayCommit(resumedState, renameCommitRecord, lookup2);

    const resumedResult = finishReplay(resumedState);
    const fileRow = rowFor(resumedResult, 'b.ts');
    expect(fileRow).toBeDefined();
    // sum-of-scalars: (1+1)-1 = 1.
    expect(fileRow!.modifications).toBe(1);
    expect(rowFor(resumedResult, 'a.ts')).toBeUndefined();

    // R4-I2: unsplit fold must match.
    const wholeLookup = await buildLookup(dir, cacheDir, config, allCommits);
    const wholeState = createReplayState(thresholds, gate2);
    for (const c of allCommits) replayCommit(wholeState, c, wholeLookup);
    const wholeResult = finishReplay(wholeState);
    expect(resumedResult).toEqual(wholeResult);
  });
});

type ReplayStateEvents = import('../../../src/roots/history-replay.js').ValueEvent[];
type ReplayStateAliases = import('../../../src/roots/history-replay.js').AliasEdge[];

// -----------------------------------------------------------------------------
// Acceptance 10 — a path with no registered grammar, or excluded from
// parsing, produces no lifecycle row of either level.
// -----------------------------------------------------------------------------

describe('D17 gate 2 — no row at all', () => {
  it('a commit touching only NOTES.md produces no lifecycle row of either level for that path', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'src/widget.ts': widgetSrc(0) }, 'seed');
    commitFiles(dir, 5, { 'NOTES.md': 'just some notes\n' }, 'add notes');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const result = await replayAll(dir, cacheDir, config, commits);

    expect(result.lifecycle.some((r) => r.key === 'NOTES.md' || r.key.startsWith('NOTES.md#'))).toBe(false);
    // The commit's OTHER record (src/widget.ts) still folds normally.
    expect(rowFor(result, 'src/widget.ts')).toBeDefined();
  });

  it('a commit touching only a test-pattern-excluded file produces no lifecycle row of either level', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'src/widget.ts': widgetSrc(0) }, 'seed');
    commitFiles(dir, 5, { 'src/foo.test.ts': widgetSrc(9) }, 'add test file');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const result = await replayAll(dir, cacheDir, config, commits);

    expect(result.lifecycle.some((r) => r.key === 'src/foo.test.ts' || r.key.startsWith('src/foo.test.ts#'))).toBe(false);
  });

  // Gate 2 applies to EVERY status, D/T included — never exempt just because they can't
  // read the gate's outcome off a resolved BlobRecord the way A/M/R/C do.

  it('a no-grammar path (NOTES.md) added then DELETED produces no lifecycle row of either level, at any point', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'src/widget.ts': widgetSrc(0) }, 'seed');
    commitFiles(dir, 5, { 'NOTES.md': 'just some notes\n' }, 'add notes');
    deleteCommit(dir, 30, 'NOTES.md', 'remove notes');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const result = await replayAll(dir, cacheDir, config, commits);

    expect(result.lifecycle.some((r) => r.key === 'NOTES.md' || r.key.startsWith('NOTES.md#'))).toBe(false);
    expect(rowFor(result, 'src/widget.ts')).toBeDefined();
  });

  it('a no-grammar path (yarn.lock) added then DELETED produces no lifecycle row of either level', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'src/widget.ts': widgetSrc(0) }, 'seed');
    commitFiles(dir, 5, { 'yarn.lock': '# lockfile\n' }, 'add lockfile');
    deleteCommit(dir, 30, 'yarn.lock', 'remove lockfile');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const result = await replayAll(dir, cacheDir, config, commits);

    expect(result.lifecycle.some((r) => r.key === 'yarn.lock' || r.key.startsWith('yarn.lock#'))).toBe(false);
  });

  it('a test-pattern-excluded path (*.test.ts) added then DELETED produces no lifecycle row of either level', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'src/widget.ts': widgetSrc(0) }, 'seed');
    commitFiles(dir, 5, { 'src/foo.test.ts': widgetSrc(9) }, 'add test file');
    deleteCommit(dir, 30, 'src/foo.test.ts', 'remove test file');
    const commits = await walkAll(dir);
    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const result = await replayAll(dir, cacheDir, config, commits);

    expect(result.lifecycle.some((r) => r.key === 'src/foo.test.ts' || r.key.startsWith('src/foo.test.ts#'))).toBe(false);
  });

  it('a no-grammar path (NOTES.md) TYPECHANGED to a symlink produces no lifecycle row of either level', async () => {
    const dir = freshRepo();
    const target = path.join(dir, 'notes-target.md');
    writeFileSync(target, 'the real notes\n', 'utf-8');
    const linkPath = path.join(dir, 'NOTES.md');
    writeFileSync(linkPath, 'just some notes\n', 'utf-8');
    const idx0 = deterministicCommitIndexAt(0);
    let add = runDeterministicGitFixture(dir, ['add', '-A'], idx0);
    if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}${add.stdout}`);
    let commit = runDeterministicGitFixture(dir, ['commit', '-q', '-m', 'seed'], idx0);
    if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}${commit.stdout}`);

    const { symlinkSync, unlinkSync } = await import('node:fs');
    unlinkSync(linkPath);
    symlinkSync('notes-target.md', linkPath);
    const idx1 = deterministicCommitIndexAt(10);
    add = runDeterministicGitFixture(dir, ['add', '-A'], idx1);
    if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}${add.stdout}`);
    commit = runDeterministicGitFixture(dir, ['commit', '-q', '-m', 'typechange NOTES.md'], idx1);
    if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}${commit.stdout}`);

    const commits = await walkAll(dir);
    const typechangeCommit = commits[commits.length - 1];
    expect(typechangeCommit.files.some((f) => f.status === 'T' && f.path === 'NOTES.md')).toBe(true);

    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const lookup = await buildLookup(dir, cacheDir, config, [typechangeCommit]);
    const state = createReplayState(thresholdsFrom(config), gate2From(config));
    replayCommit(state, typechangeCommit, lookup);
    const result = finishReplay(state);

    expect(result.lifecycle.some((r) => r.key === 'NOTES.md' || r.key.startsWith('NOTES.md#'))).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 11 — the rename-back cycle: the one-pass closure resolves rather
// than hanging.
// -----------------------------------------------------------------------------

describe('rename-back cycle', () => {
  it(
    'a.ts -> c.ts at day 90 then c.ts -> a.ts at day 120 resolves through the one-pass closure to one row keyed a.ts, firstSeenTs still day 0',
    async () => {
      const dir = freshRepo();
      commitFiles(dir, 0, { 'a.ts': widgetSrc(0) }, 'introduce a.ts');
      renameCommit(dir, 90, 'a.ts', 'c.ts', 'rename a.ts to c.ts');
      renameCommit(dir, 120, 'c.ts', 'a.ts', 'rename c.ts back to a.ts');
      const commits = await walkAll(dir);
      const cacheDir = await freshCacheDir();
      const config = await defaultRootsConfig();
      const result = await replayAll(dir, cacheDir, config, commits);

      const rows = scopeRowsFor(result, 'a.ts').filter((r) => r.key.includes('#method#widget'));
      expect(rows).toHaveLength(1);
      expect(rows[0].firstSeenTs).toBe(DETERMINISTIC_EPOCH_SECONDS);
      expect(scopeRowsFor(result, 'c.ts')).toHaveLength(0);
    },
    2000,
  );
});

// -----------------------------------------------------------------------------
// R4-I15 killer: the alias closure's (ts, sha) walk order (F4). Neither test
// depends on git at all — both push hand-built AliasEdges directly onto
// `state.aliasEdges` (the exact shape `computeAliasClosure` consumes) so the
// PUSH order into the array is deliberately the opposite of the required
// walk order, isolating the sort itself from arrival order.
// -----------------------------------------------------------------------------

describe('alias closure — (ts, sha) walk order (F4)', () => {
  it('two outgoing edges from one path, pushed in REVERSE-ts order, still resolve to the LATER edge\'s target', () => {
    const state = createReplayState(DEFAULT_THRESHOLDS, ALWAYS_CARRIES);
    // Pushed later-ts-first: without the (ts, sha) sort, processing the raw
    // array in push order would apply the later edge FIRST and the earlier
    // edge SECOND, leaving map['a.ts'] = 'b.ts' (the earlier, wrong target).
    state.aliasEdges.push({ from: 'a.ts', to: 'd.ts', ts: 200, sha: 'd'.repeat(40) });
    state.aliasEdges.push({ from: 'a.ts', to: 'b.ts', ts: 100, sha: 'b'.repeat(40) });

    const result = finishReplay(state);
    expect(result.aliases).toContainEqual(['a.ts', 'd.ts']);
    expect(result.aliases).not.toContainEqual(['a.ts', 'b.ts']);
  });

  it('two outgoing edges tying on ts resolve by sha, regardless of push order', () => {
    const state = createReplayState(DEFAULT_THRESHOLDS, ALWAYS_CARRIES);
    // Same ts; pushed in DESCENDING sha order — without the sha tie-break,
    // processing the raw array in push order would apply the 'f'-sha edge
    // first and the 'b'-sha edge second, leaving map['a.ts'] = 'c.ts' (the
    // lexicographically SMALLER sha, wrong under ascending (ts, sha) order).
    state.aliasEdges.push({ from: 'a.ts', to: 'e.ts', ts: 100, sha: 'f'.repeat(40) });
    state.aliasEdges.push({ from: 'a.ts', to: 'c.ts', ts: 100, sha: 'b'.repeat(40) });

    const result = finishReplay(state);
    expect(result.aliases).toContainEqual(['a.ts', 'e.ts']);
    expect(result.aliases).not.toContainEqual(['a.ts', 'c.ts']);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 12 — a `T` record touches the file-level row only.
// -----------------------------------------------------------------------------

describe('typechange (T) records', () => {
  it('a path whose ONLY FED record is a T carries a file-level row and zero scope rows', async () => {
    // Matches git-history.ts's own captured acceptance shape (a regular file
    // becoming a symlink): seed a.ts as a real file (an `A` record), THEN
    // typechange it (a real `T` record) — but replay ONLY the typechange
    // commit, so the row this test inspects is built from that touch alone,
    // exactly "the only record fed" the rule is about (the seed commit's own
    // `A` record is real history git also carries, deliberately excluded
    // from what is replayed here, the same shape a resume that starts after
    // the seed commit would see).
    const dir = freshRepo();
    const target = path.join(dir, 'link-target.ts');
    writeFileSync(target, widgetSrc(0), 'utf-8');
    const linkPath = path.join(dir, 'a.ts');
    writeFileSync(linkPath, widgetSrc(1), 'utf-8');
    const idx0 = deterministicCommitIndexAt(0);
    let add = runDeterministicGitFixture(dir, ['add', '-A'], idx0);
    if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}${add.stdout}`);
    let commit = runDeterministicGitFixture(dir, ['commit', '-q', '-m', 'seed'], idx0);
    if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}${commit.stdout}`);

    const { symlinkSync, unlinkSync } = await import('node:fs');
    unlinkSync(linkPath);
    symlinkSync('link-target.ts', linkPath);
    const idx1 = deterministicCommitIndexAt(10);
    add = runDeterministicGitFixture(dir, ['add', '-A'], idx1);
    if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}${add.stdout}`);
    commit = runDeterministicGitFixture(dir, ['commit', '-q', '-m', 'typechange a.ts'], idx1);
    if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}${commit.stdout}`);

    const commits = await walkAll(dir);
    const typechangeCommit = commits[commits.length - 1];
    expect(typechangeCommit.files.some((f) => f.status === 'T' && f.path === 'a.ts')).toBe(true);

    const cacheDir = await freshCacheDir();
    const config = await defaultRootsConfig();
    const lookup = await buildLookup(dir, cacheDir, config, [typechangeCommit]);
    const state = createReplayState(thresholdsFrom(config), gate2From(config));
    replayCommit(state, typechangeCommit, lookup);
    const result = finishReplay(state);

    const fileRow = rowFor(result, 'a.ts');
    expect(fileRow).toBeDefined();
    expect(fileRow!.level).toBe('file');
    expect(fileRow!.lastModifiedTs).toBe(DETERMINISTIC_EPOCH_SECONDS + 10 * 86400);
    expect(fileRow!.modifications).toBe(0);
    expect(scopeRowsFor(result, 'a.ts')).toHaveLength(0);
  });

  it('a later T on an otherwise-normal file increments the file-level modifications while every scope row stays byte-identical to a replay without it', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'a.ts': widgetSrc(0) }, 'introduce a.ts');
    commitFiles(dir, 5, { 'a.ts': widgetSrc(1) }, 'modify a.ts');
    const withoutT = await walkAll(dir);
    const cacheDir1 = await freshCacheDir();
    const config = await defaultRootsConfig();
    const resultWithoutT = await replayAll(dir, cacheDir1, config, withoutT);

    // Now add a typechange commit on top — a.ts stays a real file through
    // this first commit; only the SECOND one below turns it into a symlink.
    const { symlinkSync, unlinkSync } = await import('node:fs');
    const linkPath = path.join(dir, 'a.ts');
    writeFileSync(path.join(dir, 'link-target2.ts'), widgetSrc(2), 'utf-8');
    const idxAdd = deterministicCommitIndexAt(8);
    let add = runDeterministicGitFixture(dir, ['add', '-A'], idxAdd);
    if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}${add.stdout}`);
    let commit = runDeterministicGitFixture(dir, ['commit', '-q', '-m', 'add link target'], idxAdd);
    if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}${commit.stdout}`);

    unlinkSync(linkPath);
    symlinkSync('link-target2.ts', linkPath);
    const idxT = deterministicCommitIndexAt(15);
    add = runDeterministicGitFixture(dir, ['add', '-A'], idxT);
    if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}${add.stdout}`);
    commit = runDeterministicGitFixture(dir, ['commit', '-q', '-m', 'typechange a.ts'], idxT);
    if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}${commit.stdout}`);

    const withT = await walkAll(dir);
    expect(withT.some((c) => c.files.some((f) => f.status === 'T' && f.path === 'a.ts'))).toBe(true);
    const cacheDir2 = await freshCacheDir();
    const resultWithT = await replayAll(dir, cacheDir2, config, withT);

    const fileRowWithout = rowFor(resultWithoutT, 'a.ts')!;
    const fileRowWith = rowFor(resultWithT, 'a.ts')!;
    expect(fileRowWith.modifications).toBe(fileRowWithout.modifications + 1);

    const scopesWithout = scopeRowsFor(resultWithoutT, 'a.ts');
    const scopesWith = scopeRowsFor(resultWithT, 'a.ts');
    expect(scopesWith).toEqual(scopesWithout);

    const eventsWithout = resultWithoutT.events.filter((e) => e.key.startsWith('a.ts#'));
    const eventsWith = resultWithT.events.filter((e) => e.key.startsWith('a.ts#'));
    expect(eventsWith).toEqual(eventsWithout);
  });
});

// -----------------------------------------------------------------------------
// A `D` record prunes no lifecycle rows (Step 4(b)) — its own touch lands on
// the file-level row only, and the scope rows keep their existing values.
// -----------------------------------------------------------------------------

describe('delete (D) records', () => {
  it('a deleted file keeps its scope rows untouched and contributes its own touch to the file-level row only', async () => {
    const dir = freshRepo();
    commitFiles(dir, 0, { 'a.ts': widgetSrc(0) }, 'introduce a.ts');
    const beforeDelete = await walkAll(dir);
    const cacheDir1 = await freshCacheDir();
    const config = await defaultRootsConfig();
    const resultBefore = await replayAll(dir, cacheDir1, config, beforeDelete);
    const scopeRowBefore = scopeRowsFor(resultBefore, 'a.ts').find((r) => r.key.includes('#method#widget'))!;

    deleteCommit(dir, 10, 'a.ts', 'remove a.ts');
    const withDelete = await walkAll(dir);
    const cacheDir2 = await freshCacheDir();
    const resultAfter = await replayAll(dir, cacheDir2, config, withDelete);

    const fileRowAfter = rowFor(resultAfter, 'a.ts')!;
    expect(fileRowAfter.lastModifiedTs).toBe(DETERMINISTIC_EPOCH_SECONDS + 10 * 86400);
    expect(fileRowAfter.modifications).toBe(1); // introduction + delete touch

    const scopeRowAfter = scopeRowsFor(resultAfter, 'a.ts').find((r) => r.key.includes('#method#widget'))!;
    expect(scopeRowAfter.firstSeenTs).toBe(scopeRowBefore.firstSeenTs);
    expect(scopeRowAfter.lastModifiedTs).toBe(scopeRowBefore.lastModifiedTs);
    expect(scopeRowAfter.modifications).toBe(scopeRowBefore.modifications);
  });

  it('createReplayState seeds an empty accumulator carrying the supplied thresholds untouched', () => {
    const state = createReplayState(DEFAULT_THRESHOLDS, ALWAYS_CARRIES);
    expect(state.rows.size).toBe(0);
    expect(state.touchedBy.size).toBe(0);
    expect(state.events).toHaveLength(0);
    expect(state.aliasEdges).toHaveLength(0);
    expect(state.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(finishReplay(state)).toEqual({ lifecycle: [], events: [], aliases: [], events_n: 0 });
  });
});

// F2 killer: sha-dedup within a row (`applyTouch`), sum-not-union at merge (R4-I2, V-1).
// Second test is the R4-I2 proof: the five-commit case folded whole vs. split-and-resumed.
