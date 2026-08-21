// =============================================================================
// tests/unit/roots/history-cochange.test.ts — the co-change accumulator and
// its coupling projections (`src/roots/history-cochange.ts`). Most cases
// feed `accumulateCochange` hand-built `HistoryCommitRecord`s directly (the
// module applies no gate-1 exclusion of its own — a caller's job — so a
// hand-built record needs no real filesystem, blob, or git-history behind
// it); the mega-commit and rename-fold cases that reference the shared
// `history` golden repository walk it for real, through the real
// `walkHistory` plumbing, gated through the same `forMarkers` predicate a
// real index build applies before this module ever sees a record.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { walkHistory, type HistoryCommitRecord, type HistoryFileRecord } from '../../../src/utils/git-history.js';
import { makeRootsFileFilters } from '../../../src/roots/partitions.js';
import { buildGoldenRepo } from '../../support/roots-golden.js';
import { buildHistoryGoldenSpec } from '../../fixtures/roots/golden/history/spec.js';
import {
  createCochangeState,
  accumulateCochange,
  finishCochange,
  serializeCochangeState,
  deserializeCochangeState,
  type CochangeState,
  type CochangeThresholds,
} from '../../../src/roots/history-cochange.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';

// -----------------------------------------------------------------------------
// Shared fixture plumbing.
// -----------------------------------------------------------------------------

const dirsToCleanup: string[] = [];
afterEach(() => {
  for (const d of dirsToCleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function track(dir: string): string {
  dirsToCleanup.push(dir);
  return dir;
}

const DEFAULT_THRESHOLDS: CochangeThresholds = { megaCommitFileCap: 30 };

/** A hand-built commit touching exactly `files` (each an ordinary modify — this module never inspects `status`, only the already-resolved path an R/C caller would supply via `newPath ?? path`). Every other `HistoryCommitRecord`/`HistoryFileRecord` field is dummy data `accumulateCochange` never reads. */
function mkCommit(sha: string, files: readonly string[]): HistoryCommitRecord {
  const records: HistoryFileRecord[] = files.map((f) => ({ status: 'M', path: f, preSha: null, postSha: null }));
  return { sha, committerTs: 0, authorHash: 'author-hash', authorKind: 'human', isFix: false, files: records };
}

let shaSeq = 0;
/**
 * A fresh, unique-per-call fake commit sha — the exact 40-hex shape is
 * immaterial (this module treats `sha` as an opaque idempotency key, never
 * parses it), only uniqueness across a test's own commits matters. The
 * counter is zero-padded to a FIXED width before any padding character is
 * appended, specifically so two counter values where one is a prefix of the
 * other (1 and 10, 2 and 20, ...) can never collide the way a bare
 * `` `sha-${n}`.padEnd(40, '0') `` would — `sha-1` padded with `'0'` and
 * `sha-10` padded with one fewer `'0'` are the SAME 40-character string,
 * which silently dropped an entire commit as a false idempotency hit the
 * first time this helper was written without the fixed-width counter.
 */
function nextSha(): string {
  shaSeq += 1;
  return `sha-${String(shaSeq).padStart(8, '0')}`.padEnd(40, 'f');
}

/** `n` two-file commits all pairing `a` with `b` — the common "N shared commits" shape most acceptances need. */
function feedSharedPair(state: CochangeState, a: string, b: string, n: number): void {
  for (let i = 0; i < n; i++) accumulateCochange(state, mkCommit(nextSha(), [a, b]));
}

const identity = (p: string): string => p;

// -----------------------------------------------------------------------------
// accumulateCochange — basics.
// -----------------------------------------------------------------------------

describe('accumulateCochange — pair support and per-file commit counts', () => {
  it('a single two-file commit increments the pair support once and both files\' commit counts once', () => {
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    accumulateCochange(state, mkCommit('c1', ['a.ts', 'b.ts']));

    expect(state.pairSupport.size).toBe(1);
    const [entry] = [...state.pairSupport.values()];
    expect(entry).toEqual({ a: 'a.ts', b: 'b.ts', support: 1 });
    expect(state.fileCommits.get('a.ts')).toBe(1);
    expect(state.fileCommits.get('b.ts')).toBe(1);
  });

  it('the pair key is unordered — the same two files presented in either order land on one accumulator entry', () => {
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    accumulateCochange(state, mkCommit('c1', ['a.ts', 'b.ts']));
    accumulateCochange(state, mkCommit('c2', ['b.ts', 'a.ts']));

    expect(state.pairSupport.size).toBe(1);
    expect([...state.pairSupport.values()][0].support).toBe(2);
  });

  it('a commit folded twice under the same sha is idempotent — no support or count moves a second time', () => {
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    const commit = mkCommit('c1', ['a.ts', 'b.ts']);
    accumulateCochange(state, commit);
    accumulateCochange(state, commit);

    expect([...state.pairSupport.values()][0].support).toBe(1);
    expect(state.fileCommits.get('a.ts')).toBe(1);
  });

  it('a one-file commit contributes no pair and no commit count — below the 2-file floor', () => {
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    accumulateCochange(state, mkCommit('c1', ['a.ts']));

    expect(state.pairSupport.size).toBe(0);
    expect(state.fileCommits.size).toBe(0);
  });

  it('a commit whose raw file records repeat one path counts that path once and forms no self-pair', () => {
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    // Two records both resolve to 'a.ts' — not something a real git walk produces, but this
    // function's own contract (see its doc comment) is to still count 'a.ts' once via the
    // distinct-path Set, not once per record.
    accumulateCochange(state, mkCommit('c1', ['a.ts', 'a.ts', 'b.ts']));

    expect(state.pairSupport.size).toBe(1);
    const [entry] = [...state.pairSupport.values()];
    expect(entry).toEqual({ a: 'a.ts', b: 'b.ts', support: 1 });
    expect(state.fileCommits.get('a.ts')).toBe(1);
    expect(state.fileCommits.get('b.ts')).toBe(1);
  });

  it('an R/C caller resolves to the record\'s own new path before calling — this module never inspects status', () => {
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    const renamed: HistoryCommitRecord = {
      sha: 'c1',
      committerTs: 0,
      authorHash: 'h',
      authorKind: 'human',
      isFix: false,
      files: [
        { status: 'R', path: 'old.ts', newPath: 'new.ts', preSha: 'p', postSha: 'q' },
        { status: 'M', path: 'sibling.ts', preSha: 'r', postSha: 's' },
      ],
    };
    accumulateCochange(state, renamed);

    expect(state.fileCommits.has('new.ts')).toBe(true);
    expect(state.fileCommits.has('old.ts')).toBe(false);
    expect([...state.pairSupport.values()][0]).toEqual({ a: 'new.ts', b: 'sibling.ts', support: 1 });
  });
});

// -----------------------------------------------------------------------------
// pairMapKey's separator must never collide two DISTINCT pairs onto one
// accumulator entry, even when a path itself legally contains the separator
// character a naive choice (e.g. a plain space) would use.
// -----------------------------------------------------------------------------

describe('pairMapKey stays injective over space-containing paths', () => {
  it('two distinct pairs that share no file, but whose raw strings could concatenate to the same joined text under a space separator, stay distinct — every conf stays <= 1', async () => {
    const config = await defaultRootsConfig('cochange:\n  minSupport: 1\n  minConfidence: 0\n');
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    // Both pairs' four paths are ordinary POSIX paths that happen to contain a space.
    // 'docs/a' + 'docs/b docs/c' and 'docs/a docs/b' + 'docs/c' both concatenate, with a plain
    // space joiner, to the identical string "docs/a docs/b docs/c" — the exact collision a
    // space separator (a legal path character) would let through.
    feedSharedPair(state, 'docs/a', 'docs/b docs/c', 3);
    feedSharedPair(state, 'docs/a docs/b', 'docs/c', 5);

    const { pairs } = finishCochange(state, config, identity);

    expect(pairs).toHaveLength(2);
    for (const p of pairs) expect(p.conf).toBeLessThanOrEqual(1);

    const pairAC = pairs.find((p) => p.a === 'docs/a' && p.b === 'docs/b docs/c');
    expect(pairAC).toEqual({ a: 'docs/a', b: 'docs/b docs/c', sup: 3, conf: 1 });

    const pairAB = pairs.find((p) => p.a === 'docs/a docs/b' && p.b === 'docs/c');
    expect(pairAB).toEqual({ a: 'docs/a docs/b', b: 'docs/c', sup: 5, conf: 1 });
  });
});

// -----------------------------------------------------------------------------
// Acceptance 1 — the confidence gate, including the reverse-direction rescue.
// -----------------------------------------------------------------------------

describe('acceptance 1 — support/confidence gate', () => {
  it('support 8 of a 10-commit file, confidence 0.8 in both directions, clears the default gate and persists', async () => {
    const config = await defaultRootsConfig();
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    feedSharedPair(state, 'a.ts', 'b.ts', 8);
    // 2 more qualifying commits for EACH side, symmetric, so commits(a) = commits(b) = 10 and
    // confidence is exactly 0.8 in both directions — an unambiguous max-direction value.
    accumulateCochange(state, mkCommit(nextSha(), ['a.ts', 'x1.ts']));
    accumulateCochange(state, mkCommit(nextSha(), ['a.ts', 'x2.ts']));
    accumulateCochange(state, mkCommit(nextSha(), ['b.ts', 'y1.ts']));
    accumulateCochange(state, mkCommit(nextSha(), ['b.ts', 'y2.ts']));

    const { pairs } = finishCochange(state, config, identity);
    const pair = pairs.find((p) => p.a === 'a.ts' && p.b === 'b.ts');
    expect(pair).toEqual({ a: 'a.ts', b: 'b.ts', sup: 8, conf: 0.8 });
  });

  it('support 8 of a 12-commit file, confidence 0.667 in BOTH directions, is dropped', async () => {
    const config = await defaultRootsConfig();
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    feedSharedPair(state, 'a.ts', 'c.ts', 8);
    for (let i = 0; i < 4; i++) accumulateCochange(state, mkCommit(nextSha(), ['a.ts', `ax${i}.ts`]));
    for (let i = 0; i < 4; i++) accumulateCochange(state, mkCommit(nextSha(), ['c.ts', `cx${i}.ts`]));

    const { pairs } = finishCochange(state, config, identity);
    expect(pairs.some((p) => (p.a === 'a.ts' && p.b === 'c.ts') || (p.a === 'c.ts' && p.b === 'a.ts'))).toBe(false);
  });

  it('support 8 of a 12-commit file (confidence 0.667 forward) still persists when the reverse direction clears minConfidence', async () => {
    const config = await defaultRootsConfig();
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    feedSharedPair(state, 'a.ts', 'd.ts', 8);
    // 'a.ts' has 4 more commits of its own (commits(a) = 12, confidence(a->d) = 8/12 = 0.667);
    // 'd.ts' never appears outside the 8 shared commits (commits(d) = 8, confidence(d->a) = 1.0).
    for (let i = 0; i < 4; i++) accumulateCochange(state, mkCommit(nextSha(), ['a.ts', `ay${i}.ts`]));

    const { pairs } = finishCochange(state, config, identity);
    const pair = pairs.find((p) => p.a === 'a.ts' && p.b === 'd.ts');
    expect(pair).toBeDefined();
    expect(pair?.sup).toBe(8);
    expect(pair?.conf).toBeCloseTo(1.0);
  });

  it('a pair sitting at exactly the default minConfidence (0.75) clears the gate — the boundary is inclusive', async () => {
    // minSupport lowered to isolate the confidence boundary; minConfidence stays at its default 0.75.
    const config = await defaultRootsConfig('cochange:\n  minSupport: 1\n');
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    feedSharedPair(state, 'a.ts', 'b.ts', 3);
    // One more commit for EACH side, symmetric, so commits(a) = commits(b) = 4 and confidence
    // is exactly 3/4 = 0.75 in both directions.
    accumulateCochange(state, mkCommit(nextSha(), ['a.ts', 'x.ts']));
    accumulateCochange(state, mkCommit(nextSha(), ['b.ts', 'y.ts']));

    const { pairs } = finishCochange(state, config, identity);
    const pair = pairs.find((p) => p.a === 'a.ts' && p.b === 'b.ts');
    expect(pair).toEqual({ a: 'a.ts', b: 'b.ts', sup: 3, conf: 0.75 });
  });
});

// -----------------------------------------------------------------------------
// Acceptance 2 — the mega-commit band, measured over records already
// admitted (this module's own tests feed it whatever it is given — the gate
// itself is Task 8's, applied upstream).
// -----------------------------------------------------------------------------

describe('acceptance 2 — mega-commit cap band', () => {
  it('a 40-file commit contributes zero pairs and zero commit counts; a disjoint 30-file commit contributes 30*29/2 = 435 pairs', () => {
    const state = createCochangeState(DEFAULT_THRESHOLDS);

    const megaFiles = Array.from({ length: 40 }, (_, i) => `mega/${i}.ts`);
    const bandFiles = Array.from({ length: 30 }, (_, i) => `band/${i}.ts`);
    accumulateCochange(state, mkCommit('mega', megaFiles));
    accumulateCochange(state, mkCommit('band', bandFiles));

    expect(state.pairSupport.size).toBe((30 * 29) / 2);
    let totalSupport = 0;
    for (const { support } of state.pairSupport.values()) totalSupport += support;
    expect(totalSupport).toBe((30 * 29) / 2);

    for (const f of megaFiles) expect(state.fileCommits.has(f)).toBe(false);
    for (const f of bandFiles) expect(state.fileCommits.get(f)).toBe(1);
  });

  it('exactly megaCommitFileCap (30) changed files still qualifies — the cap is inclusive', () => {
    const state = createCochangeState({ megaCommitFileCap: 30 });
    const files = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    accumulateCochange(state, mkCommit('c1', files));
    expect(state.pairSupport.size).toBe((30 * 29) / 2);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 3 — sort before cut (never insertion order), plus the shared
// `history` golden's own real numbers.
// -----------------------------------------------------------------------------

describe('acceptance 3 — sort-then-cut, and the history golden\'s real co-change population', () => {
  it('with maxPairs 2 and three disjoint pairs of support 40/30/20 inserted OUT of support order, the cut keeps the 40 and 30 pairs', async () => {
    const config = await defaultRootsConfig('cochange:\n  minSupport: 1\n  minConfidence: 0\n  maxPairs: 2\n');
    const state = createCochangeState(DEFAULT_THRESHOLDS);

    // Insertion order deliberately does NOT match descending-support order —
    // a first-N-by-insertion cut (MR-17) would keep the WRONG two pairs.
    feedSharedPair(state, 'low/a.ts', 'low/b.ts', 20);
    feedSharedPair(state, 'high/a.ts', 'high/b.ts', 40);
    feedSharedPair(state, 'mid/a.ts', 'mid/b.ts', 30);

    const { pairs, couplingByFile } = finishCochange(state, config, identity);
    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => p.sup)).toEqual([40, 30]);
    expect(pairs.some((p) => p.a === 'low/a.ts')).toBe(false);

    // The cut-away pair's endpoints must carry no coupling entry at all — percentiles are
    // computed over the CUT set (post-maxPairs), never the wider pre-cut qualifying set.
    expect('low/a.ts' in couplingByFile).toBe(false);
    expect('low/b.ts' in couplingByFile).toBe(false);
    expect(Object.keys(couplingByFile).sort()).toEqual(['high/a.ts', 'high/b.ts', 'mid/a.ts', 'mid/b.ts']);
  });

  it('ties on support are broken by (a, b) ascending, producing a total order', async () => {
    const config = await defaultRootsConfig('cochange:\n  minSupport: 1\n  minConfidence: 0\n');
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    feedSharedPair(state, 'z/a.ts', 'z/b.ts', 5);
    feedSharedPair(state, 'a/a.ts', 'a/b.ts', 5);

    const { pairs } = finishCochange(state, config, identity);
    expect(pairs.map((p) => p.a)).toEqual(['a/a.ts', 'z/a.ts']);
  });

  it('on the real history golden, the order pair reaches support 9 / confidence 1.0 and persists, while the ship pair (support 5) never clears minSupport', async () => {
    const repoDir = track(buildGoldenRepo(buildHistoryGoldenSpec()));
    const config = await defaultRootsConfig();
    const filters = makeRootsFileFilters(config);

    const state = createCochangeState({ megaCommitFileCap: config.history.megaCommitFileCap });
    await walkHistory(repoDir, { agentIdentities: config.history.agentIdentities }, (commit) => {
      // D17 gate 1, applied once by the caller — exactly the contract this module documents.
      const gated: HistoryCommitRecord = {
        ...commit,
        files: commit.files.filter((f) => filters.forMarkers(f.newPath ?? f.path)),
      };
      accumulateCochange(state, gated);
    });

    const { pairs } = finishCochange(state, config, identity);

    const orderPair = pairs.find(
      (p) => (p.a === 'src/svc/order.ts' && p.b === 'test/order.spec.ts') || (p.a === 'test/order.spec.ts' && p.b === 'src/svc/order.ts'),
    );
    expect(orderPair).toBeDefined();
    expect(orderPair?.sup).toBe(9);
    expect(orderPair?.conf).toBeCloseTo(1.0);

    const shipPair = pairs.find(
      (p) => (p.a === 'src/svc/ship.ts' && p.b === 'test/ship.spec.ts') || (p.a === 'test/ship.spec.ts' && p.b === 'src/svc/ship.ts'),
    );
    expect(shipPair).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Acceptance 4 — rename resolution happens at finish, through resolvePath,
// never as a running remap during accumulation.
// -----------------------------------------------------------------------------

describe('acceptance 4 — rename resolution at finish', () => {
  const RESOLVE_CONFIG_OVERRIDE = 'cochange:\n  minSupport: 1\n  minConfidence: 0\n';

  it('3 co-changes under the old path plus 8 under the new path merge, through resolvePath, into ONE pair at support 11 keyed on the new path', async () => {
    const config = await defaultRootsConfig(RESOLVE_CONFIG_OVERRIDE);
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    feedSharedPair(state, 'src/old.ts', 'test/x.spec.ts', 3);
    feedSharedPair(state, 'src/new.ts', 'test/x.spec.ts', 8);

    const resolvePath = (p: string): string => (p === 'src/old.ts' ? 'src/new.ts' : p);
    const { pairs } = finishCochange(state, config, resolvePath);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ a: 'src/new.ts', b: 'test/x.spec.ts', sup: 11, conf: 1 });
  });

  it('the identity resolvePath (no rename applied) leaves the SAME raw data as two separate pairs, at support 3 and 8 — the shape MR-18 restores', async () => {
    const config = await defaultRootsConfig(RESOLVE_CONFIG_OVERRIDE);
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    feedSharedPair(state, 'src/old.ts', 'test/x.spec.ts', 3);
    feedSharedPair(state, 'src/new.ts', 'test/x.spec.ts', 8);

    const { pairs } = finishCochange(state, config, identity);
    const supports = pairs.map((p) => p.sup).sort((a, b) => a - b);
    expect(supports).toEqual([3, 8]);
  });
});

// -----------------------------------------------------------------------------
// D1 / R4-I2 — finishCochange resolves onto a fresh result and never writes
// the rename-resolved data back into the raw accumulator itself.
// -----------------------------------------------------------------------------

describe('finishCochange leaves the raw accumulator untouched under a real (non-identity) resolvePath', () => {
  it('a persisted snapshot taken after finishCochange still holds the RAW, unmerged pairs — not the rename-resolved ones', async () => {
    const config = await defaultRootsConfig('cochange:\n  minSupport: 1\n  minConfidence: 0\n');
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    feedSharedPair(state, 'src/old.ts', 'test/x.spec.ts', 3);
    feedSharedPair(state, 'src/new.ts', 'test/x.spec.ts', 8);
    const before = serializeCochangeState(state);

    const resolvePath = (p: string): string => (p === 'src/old.ts' ? 'src/new.ts' : p);
    finishCochange(state, config, resolvePath);

    // D1: the accumulator must still be raw — two separate pairs at support 3 and 8, keyed on the
    // OLD path — not the single rename-merged pair at support 11 finishCochange just computed.
    const after = serializeCochangeState(state);
    expect(after).toEqual(before);
    expect(after.pairs.map((p) => p.support).sort((a, b) => a - b)).toEqual([3, 8]);
    expect(after.pairs.some((p) => p.a === 'src/old.ts' || p.b === 'src/old.ts')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Acceptance 5 — order-free by construction (D16): folding the same commits
// forward, reversed, or split across a persist/reload boundary yields
// byte-identical `finishCochange` output.
// -----------------------------------------------------------------------------

describe('acceptance 5 — order-free accumulation', () => {
  const ORDER_FREE_CONFIG_OVERRIDE = 'cochange:\n  minSupport: 1\n  minConfidence: 0\n';

  function buildCommits(): HistoryCommitRecord[] {
    return [
      mkCommit('c1', ['f1.ts', 'f2.ts']),
      mkCommit('c2', ['f1.ts', 'f2.ts']),
      mkCommit('c3', ['f1.ts', 'f3.ts']),
      mkCommit('c4', ['f2.ts', 'f3.ts', 'f4.ts']),
      mkCommit('c5', ['f1.ts', 'f2.ts']),
      mkCommit('c6', ['f5.ts', 'f6.ts']),
      mkCommit('c7', ['f1.ts', 'f2.ts', 'f5.ts']),
      mkCommit('c8', ['f3.ts', 'f4.ts']),
    ];
  }

  it('forward order and reversed order produce byte-identical finishCochange output', async () => {
    const config = await defaultRootsConfig(ORDER_FREE_CONFIG_OVERRIDE);
    const commits = buildCommits();

    const forward = createCochangeState(DEFAULT_THRESHOLDS);
    for (const c of commits) accumulateCochange(forward, c);

    const reversed = createCochangeState(DEFAULT_THRESHOLDS);
    for (const c of [...commits].reverse()) accumulateCochange(reversed, c);

    expect(finishCochange(reversed, config, identity)).toEqual(finishCochange(forward, config, identity));
  });

  it('a fold split into two halves with a serialize/deserialize (persist/reload) boundary between them matches the unsplit fold', async () => {
    const config = await defaultRootsConfig(ORDER_FREE_CONFIG_OVERRIDE);
    const commits = buildCommits();

    const unsplit = createCochangeState(DEFAULT_THRESHOLDS);
    for (const c of commits) accumulateCochange(unsplit, c);
    const expected = finishCochange(unsplit, config, identity);

    const firstHalf = commits.slice(0, 4);
    const secondHalf = commits.slice(4);

    let split = createCochangeState(DEFAULT_THRESHOLDS);
    for (const c of firstHalf) accumulateCochange(split, c);
    const snapshot = serializeCochangeState(split);
    split = deserializeCochangeState(snapshot, DEFAULT_THRESHOLDS);
    for (const c of secondHalf) accumulateCochange(split, c);

    expect(finishCochange(split, config, identity)).toEqual(expected);
  });

  it('finishCochange does not mutate state — calling it twice on the same state returns byte-identical output', async () => {
    const config = await defaultRootsConfig(ORDER_FREE_CONFIG_OVERRIDE);
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    for (const c of buildCommits()) accumulateCochange(state, c);

    const first = finishCochange(state, config, identity);
    const second = finishCochange(state, config, identity);
    expect(second).toEqual(first);
  });
});

// -----------------------------------------------------------------------------
// Coupling percentiles (Step 3, G.3) — computed over the cut set.
// -----------------------------------------------------------------------------

describe('coupling percentiles', () => {
  it('a small hand-worked distribution produces the documented rank formula, with ties sharing a percentile, and couplingByModule as the rounded median', async () => {
    const config = await defaultRootsConfig('cochange:\n  minSupport: 1\n  minConfidence: 0\n');
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    // A has 2 partners (B, C); B has 1 (A); C has 2 (A, D); D has 1 (C).
    feedSharedPair(state, 'src/x/a.ts', 'src/x/b.ts', 8);
    feedSharedPair(state, 'src/x/a.ts', 'src/y/c.ts', 8);
    feedSharedPair(state, 'src/y/c.ts', 'src/y/d.ts', 8);

    const { couplingByFile, couplingByModule } = finishCochange(state, config, identity);

    expect(couplingByFile).toEqual({
      'src/x/a.ts': 50,
      'src/x/b.ts': 0,
      'src/y/c.ts': 50,
      'src/y/d.ts': 0,
    });
    expect(couplingByModule).toEqual({ 'src/x': 25, 'src/y': 25 });
  });

  it('an odd-sized module with a skewed distribution takes the MEDIAN percentile, not the mean', async () => {
    const config = await defaultRootsConfig('cochange:\n  minSupport: 1\n  minConfidence: 0\n');
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    // A 4-file star: hub has 3 distinct partners (a1, a2, leaf3); each leaf has exactly 1.
    // partnerCounts: hub=3, a1=1, a2=1, leaf3=1 — sorted [1,1,1,3], total 4, so hub's percentile
    // is round(100*3/4)=75 and each leaf's is round(100*0/4)=0.
    accumulateCochange(state, mkCommit(nextSha(), ['modA/hub.ts', 'modA/a1.ts']));
    accumulateCochange(state, mkCommit(nextSha(), ['modA/hub.ts', 'modA/a2.ts']));
    accumulateCochange(state, mkCommit(nextSha(), ['modA/hub.ts', 'other/leaf3.ts']));

    const { couplingByFile, couplingByModule } = finishCochange(state, config, identity);
    expect(couplingByFile).toEqual({ 'modA/hub.ts': 75, 'modA/a1.ts': 0, 'modA/a2.ts': 0, 'other/leaf3.ts': 0 });

    // modA's own three files are [0, 0, 75] — median 0, mean 25. The MEDIAN (rounded) is 0; a
    // mean substitution would emit 25.
    expect(couplingByModule['modA']).toBe(0);
  });

  it('an even-sized module with a fractional midpoint median rounds to the nearest integer', async () => {
    const config = await defaultRootsConfig('cochange:\n  minSupport: 1\n  minConfidence: 0\n');
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    // A 3-file path graph p—q—r: p and r each have 1 distinct partner (q); q has 2 (p, r).
    // partnerCounts: p=1, q=2, r=1 — sorted [1,1,2], total 3, so q's percentile is
    // round(100*2/3)=67 and p/r's is round(100*0/3)=0.
    accumulateCochange(state, mkCommit(nextSha(), ['modB/p.ts', 'modB/q.ts']));
    accumulateCochange(state, mkCommit(nextSha(), ['modB/q.ts', 'other2/r.ts']));

    const { couplingByFile, couplingByModule } = finishCochange(state, config, identity);
    expect(couplingByFile).toEqual({ 'modB/p.ts': 0, 'modB/q.ts': 67, 'other2/r.ts': 0 });

    // modB's own two files are [0, 67] — median (0 + 67) / 2 = 33.5, which must round to 34.
    // Dropping the rounding would leave the fractional 33.5 unpinned.
    expect(couplingByModule['modB']).toBe(34);
  });

  it('a file whose only pair never clears minSupport carries no coupling entry, even though a DIFFERENT pair in the same run does', async () => {
    const config = await defaultRootsConfig('cochange:\n  minConfidence: 0\n');
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    feedSharedPair(state, 'a.ts', 'b.ts', 8); // qualifies: support 8 >= default minSupport 8
    accumulateCochange(state, mkCommit(nextSha(), ['a.ts', 'lonely.ts'])); // support 1 — dropped

    const { pairs, couplingByFile } = finishCochange(state, config, identity);
    expect(pairs.some((p) => p.a === 'lonely.ts' || p.b === 'lonely.ts')).toBe(false);
    expect(couplingByFile).toEqual({ 'a.ts': 0, 'b.ts': 0 });
    expect('lonely.ts' in couplingByFile).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The defensive collision guard: two raw paths whose resolvePath both land
// on the same final path form no self-pair.
// -----------------------------------------------------------------------------

describe('resolvePath collision guard', () => {
  it('two raw files that resolve to the same final path drop their pair entirely rather than emitting a self-pair', async () => {
    const config = await defaultRootsConfig('cochange:\n  minSupport: 1\n  minConfidence: 0\n');
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    feedSharedPair(state, 'a.ts', 'b.ts', 8);

    const collideToSame = (p: string): string => (p === 'a.ts' || p === 'b.ts' ? 'z.ts' : p);
    const { pairs, couplingByFile } = finishCochange(state, config, collideToSame);

    expect(pairs).toEqual([]);
    expect(couplingByFile).toEqual({});
  });

  it('resolvePath re-canonicalizes (a, b) ordering when the rewrite flips which side sorts first', async () => {
    const config = await defaultRootsConfig('cochange:\n  minSupport: 1\n  minConfidence: 0\n');
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    // Raw order is ('a.ts', 'z.ts') — 'a.ts' sorts first. Resolving 'a.ts' to 'zz.ts' flips it:
    // 'z.ts' < 'zz.ts', so the FINAL pair must re-sort rather than keep the raw side assignment.
    feedSharedPair(state, 'a.ts', 'z.ts', 8);
    const flipOrder = (p: string): string => (p === 'a.ts' ? 'zz.ts' : p);

    const { pairs } = finishCochange(state, config, flipOrder);
    expect(pairs).toEqual([{ a: 'z.ts', b: 'zz.ts', sup: 8, conf: 1 }]);
  });
});

// -----------------------------------------------------------------------------
// serializeCochangeState / deserializeCochangeState — the raw accumulator
// snapshot `cochange-raw.jsonl` persists (D1), in the store's own documented
// per-file order.
// -----------------------------------------------------------------------------

describe('serializeCochangeState / deserializeCochangeState', () => {
  it('serializes pairs sorted by (a, b) and file-commit rows sorted by path, regardless of accumulation order', () => {
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    accumulateCochange(state, mkCommit('c1', ['zeta.ts', 'alpha.ts']));
    accumulateCochange(state, mkCommit('c2', ['mu.ts', 'beta.ts']));

    const snapshot = serializeCochangeState(state);

    expect(snapshot.pairs.map((p) => [p.a, p.b])).toEqual([
      ['alpha.ts', 'zeta.ts'],
      ['beta.ts', 'mu.ts'],
    ]);
    expect(snapshot.fileCommits.map((f) => f.path)).toEqual(['alpha.ts', 'beta.ts', 'mu.ts', 'zeta.ts']);
  });

  it('a deserialize/serialize round trip reproduces the same snapshot, and continued accumulation adds onto the loaded totals', () => {
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    feedSharedPair(state, 'a.ts', 'b.ts', 3);
    const snapshot = serializeCochangeState(state);

    const reloaded = deserializeCochangeState(snapshot, DEFAULT_THRESHOLDS);
    expect(serializeCochangeState(reloaded)).toEqual(snapshot);

    feedSharedPair(reloaded, 'a.ts', 'b.ts', 2);
    const grown = serializeCochangeState(reloaded);
    expect(grown.pairs).toEqual([{ a: 'a.ts', b: 'b.ts', support: 5 }]);
    expect(grown.fileCommits).toEqual([
      { path: 'a.ts', commits: 5 },
      { path: 'b.ts', commits: 5 },
    ]);
  });

  it('deserializeCochangeState copies each row rather than aliasing the snapshot\'s own objects — mutating the reloaded state leaves the snapshot untouched', () => {
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    feedSharedPair(state, 'a.ts', 'b.ts', 3);
    const snapshot = serializeCochangeState(state);
    const snapshotSupportBefore = snapshot.pairs[0].support;
    const snapshotCommitsBefore = snapshot.fileCommits[0].commits;

    const reloaded = deserializeCochangeState(snapshot, DEFAULT_THRESHOLDS);
    feedSharedPair(reloaded, 'a.ts', 'b.ts', 2); // mutates the RELOADED state's row objects in place

    expect(snapshot.pairs[0].support).toBe(snapshotSupportBefore);
    expect(snapshot.fileCommits[0].commits).toBe(snapshotCommitsBefore);
  });

  it('a reloaded state does not re-guard against a commit sha the loaded half already applied — a resume never re-feeds an already-indexed commit, so nothing needs to', () => {
    const state = createCochangeState(DEFAULT_THRESHOLDS);
    const commit = mkCommit('shared-sha', ['a.ts', 'b.ts']);
    accumulateCochange(state, commit);
    const reloaded = deserializeCochangeState(serializeCochangeState(state), DEFAULT_THRESHOLDS);

    // Feeding the SAME sha again after a reload is a caller contract violation (a resume should
    // never do this), and it is deliberately NOT protected against — `processedShas` starts empty
    // on reload (this module's own documented rule) precisely because a real resume never needs it
    // to. Demonstrating the consequence pins the rule rather than leaving it unobserved.
    accumulateCochange(reloaded, commit);
    expect([...reloaded.pairSupport.values()][0].support).toBe(2);
  });
});
