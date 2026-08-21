// =============================================================================
// tests/unit/roots/weights.test.ts — §9.1's instance weights
// (`src/roots/weights.ts`), hand-derived at the §4.5 defaults. Every
// arithmetic assertion below carries the derivation in a comment, matching
// the acceptance table's own worked numbers, so a reader can check the test
// against the spec without re-deriving anything from the implementation.
//
// Mutation-kill map (each test doubles as the named killer):
//   MR-19 (cap last, degraded branch)   -> 'no lifecycle row + mark present'
//   MR-20 (fresh-penalty factor)        -> 'row 2'
//   MR-21 (churn factor)                -> 'row 3'
//   MR-22 (release gap conjunct)        -> 'gap 5 < 14 -> NOT released'
//   own (dirty branch)                  -> 'row 7'
//   own (releaseStableDays conjunct)    -> 'stable_days 80 < 90 -> NOT released'
//   own (ledger cap is min, not assign) -> 'min, never assignment'
//   own (isHookShaped stable_id half)   -> 'a mark on a DIFFERENT scope never caps'
//   own (day-helper max(0, …) clamps)   -> 'committer-clock skew'
//   own (lastHumanCommitTs null guard)  -> 'agent-only history'
//   own (base branch order)             -> 'the branch ladder is ordered'
//   own (module-kind flat weight)       -> 'a module-kind unit'
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import { makeWeightFns, releasedMarks, type LifecycleIndex } from '../../../src/roots/weights.js';
import type { LifecycleRow } from '../../../src/roots/history-replay.js';
import type { ScopeUnit } from '../../../src/roots/extract.js';
import type { LedgerEntry, RootsConfig } from '../../../src/model/graph.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';

const DAY = 86400;
// `clockTs` reference for every table row below: 0. Every row's own
// first_seen/last_modified is then stated as a signed day offset from it,
// matching the acceptance table's own "-400 d" notation directly.
const NOW = 0;

/** A minimal `ScopeUnit`, same shape/defaults as the sibling builders in `mine.test.ts`/`mine-invariants.test.ts` — only the fields this module reads (`skeyR`, `relPath`, `stableId`, `kind`) vary per test. */
function unit(overrides: Partial<ScopeUnit> & { stableId: string; relPath: string; kind: ScopeUnit['kind']; name: string }): ScopeUnit {
  const qualifiedName = overrides.qualifiedName ?? overrides.name;
  return {
    kind: overrides.kind,
    relPath: overrides.relPath,
    name: overrides.name,
    qualifiedName,
    ordinal: overrides.ordinal ?? 0,
    arity: 0,
    hasParameterList: false,
    startRow: 0,
    supertypes: [],
    decorators: [],
    grammarHasDecoratorTypes: false,
    grammarHasHeritageCandidacy: false,
    grammarNodeTypeVocabulary: [],
    fileImports: [],
    calleeTexts: [],
    nodeTypesSeen: [],
    statementShapes: [],
    localVarNames: [],
    firstStatementType: undefined,
    lastReturnExprType: undefined,
    hasReturnStatement: false,
    bodyStatementCount: 0,
    partitionId: overrides.partitionId ?? 'p1',
    skeyR: overrides.skeyR ?? `${overrides.relPath}#${overrides.kind}#${qualifiedName}`,
    stableId: overrides.stableId,
  };
}

/** A minimal `LifecycleRow` — every field defaulted to a value that never accidentally trips a branch the caller isn't testing (human authorship, no churn, no second touch). */
function row(overrides: Partial<LifecycleRow> & { key: string; level: 'scope' | 'file' }): LifecycleRow {
  return {
    key: overrides.key,
    level: overrides.level,
    firstSeenTs: overrides.firstSeenTs ?? NOW,
    firstModifiedTs: overrides.firstModifiedTs ?? null,
    lastModifiedTs: overrides.lastModifiedTs ?? (overrides.firstSeenTs ?? NOW),
    modifications: overrides.modifications ?? 0,
    churnedEarly: overrides.churnedEarly ?? false,
    fixTouches: overrides.fixTouches ?? 0,
    authorKind: overrides.authorKind ?? 'human',
    lastTouchSha: overrides.lastTouchSha ?? 'a'.repeat(40),
    lastHumanCommitTs: overrides.lastHumanCommitTs ?? null,
  };
}

/** A `LifecycleIndex` keyed off a plain row list by each row's own `.key` — the two-step (scope, then file) lookup `LifecycleIndex.rowFor`'s own doc describes, and (for `releasedMarks`'s tests) a stand-in for the stable_id-keyed adapter `weights.ts`'s own doc says the real caller builds. */
function indexOf(rows: readonly LifecycleRow[]): LifecycleIndex {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return { rowFor: (skeyR, relPath) => byKey.get(skeyR) ?? byKey.get(relPath) };
}

const EMPTY_INDEX: LifecycleIndex = { rowFor: () => undefined };

let config: RootsConfig;
beforeAll(async () => {
  config = await defaultRootsConfig();
});

// -----------------------------------------------------------------------------
// Acceptance criteria — the arithmetic table, row by row.
// -----------------------------------------------------------------------------

describe('makeWeightFns — the §9.1 weight table at §4.5 defaults', () => {
  it('row 1 — human, first_seen -400d, last_modified -400d, no early churn -> base 1.0', () => {
    const u = unit({ stableId: 's1', relPath: 'src/a.ts', kind: 'method', name: 'a' });
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: -400 * DAY, lastModifiedTs: -400 * DAY });
    const { baseWeight } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    // w_surv = min(1, 400/120) x (age_days=400 >= freshPenaltyDays=14 -> 1) = 1
    // w_prov = 1.0 (human); w_churn = 1.0 (not churned early)
    // base = max(0.05, 1 x 1 x 1) = 1.0
    expect(baseWeight(u)).toBeCloseTo(1.0, 10);
  });

  it('row 2 — human, first_seen -10d, last_modified -10d -> the fresh-penalty factor floors base to 0.05, not 0.083333', () => {
    const u = unit({ stableId: 's2', relPath: 'src/b.ts', kind: 'method', name: 'b' });
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: -10 * DAY, lastModifiedTs: -10 * DAY });
    const { baseWeight } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    // w_surv = min(1, 10/120) x (age_days=10 < freshPenaltyDays=14 -> 0.5) = 0.083333... x 0.5 = 0.041667
    // w_prov = 1.0; w_churn = 1.0
    // base = max(0.05, 0.041667) = 0.05 -- WITHOUT the fresh-penalty factor (MR-20), the un-penalised
    // 0.083333 alone already clears the floor and this row would read 0.083333, not 0.05.
    expect(baseWeight(u)).toBeCloseTo(0.05, 10);
  });

  it('row 3 — human, stable 60d, churned early -> w_surv=0.5, w_churn=0.25, base=0.125', () => {
    const u = unit({ stableId: 's3', relPath: 'src/c.ts', kind: 'method', name: 'c' });
    // firstSeenTs old enough (100d) that age_days=100 >= freshPenaltyDays=14, isolating churn as the
    // only depressed factor.
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: -100 * DAY, lastModifiedTs: -60 * DAY, churnedEarly: true });
    const { baseWeight } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    // w_surv = min(1, 60/120) x 1 = 0.5; w_prov = 1.0 (human); w_churn = 0.25 (churned early)
    // base = max(0.05, 0.5 x 1 x 0.25) = max(0.05, 0.125) = 0.125 -- WITHOUT w_churn (MR-21) this
    // would read max(0.05, 0.5) = 0.5.
    expect(baseWeight(u)).toBeCloseTo(0.125, 10);
  });

  it('row 4 — agent, stable 60d -> w_prov=0.433333, w_surv=0.5, base=0.216667', () => {
    const u = unit({ stableId: 's4', relPath: 'src/d.ts', kind: 'method', name: 'd' });
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: -100 * DAY, lastModifiedTs: -60 * DAY, authorKind: 'agent' });
    const { baseWeight } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    // w_prov = 0.15 + 0.85 x min(1, 60/180) = 0.15 + 0.85 x 0.333333 = 0.433333
    // w_surv = min(1, 60/120) x 1 = 0.5; w_churn = 1.0
    // base = max(0.05, 0.5 x 0.433333 x 1) = 0.216667
    expect(baseWeight(u)).toBeCloseTo(0.216667, 5);
  });

  it('row 5 — agent, stable 200d -> w_prov=1.0, w_surv=1.0, base=1.0', () => {
    const u = unit({ stableId: 's5', relPath: 'src/e.ts', kind: 'method', name: 'e' });
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: -300 * DAY, lastModifiedTs: -200 * DAY, authorKind: 'agent' });
    const { baseWeight } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    // w_prov = 0.15 + 0.85 x min(1, 200/180) = 0.15 + 0.85 x 1 = 1.0 (agentPromoteDays cap)
    // w_surv = min(1, 200/120) x 1 = 1.0 (survivalFullDays cap)
    // base = max(0.05, 1 x 1 x 1) = 1.0
    expect(baseWeight(u)).toBeCloseTo(1.0, 10);
  });

  it('row 6 — no lifecycle row at all -> noLifecycleWeight 0.3', () => {
    const u = unit({ stableId: 's6', relPath: 'src/f.ts', kind: 'method', name: 'f' });
    const { baseWeight } = makeWeightFns({ lifecycle: EMPTY_INDEX, ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    expect(baseWeight(u)).toBeCloseTo(0.3, 10);
  });

  it('row 7 — dirty in the working tree (row present) -> dirtyWeight 0.3, overriding what would otherwise be 1.0', () => {
    const u = unit({ stableId: 's7', relPath: 'src/g.ts', kind: 'method', name: 'g' });
    // Same row as row 1 (base would be 1.0 if the scope were clean) — isolating the dirty branch as
    // the ONLY thing that changes the result. Without it (an own mutation), this would read 1.0.
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: -400 * DAY, lastModifiedTs: -400 * DAY });
    const { baseWeight } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [], dirtyPaths: new Set([u.relPath]), clockTs: NOW, config });
    expect(baseWeight(u)).toBeCloseTo(0.3, 10);
  });

  it('the branch ladder is ordered: a rowless scope that is ALSO dirty reads noLifecycleWeight, not dirtyWeight', () => {
    // The two keys are identical (0.3) at the defaults, so they must be separated to observe the order at all.
    const split: RootsConfig = { ...config, weights: { ...config.weights, dirtyWeight: 0.2 } };
    const u = unit({ stableId: 'ord-1', relPath: 'src/ord.ts', kind: 'method', name: 'ord' });
    const { baseWeight } = makeWeightFns({ lifecycle: EMPTY_INDEX, ledger: [], dirtyPaths: new Set([u.relPath]), clockTs: NOW, config: split });
    expect(baseWeight(u)).toBeCloseTo(0.3, 10); // noLifecycleWeight wins; the swapped order would read 0.2
  });

  it('a module-kind unit (relPath is a DIRECTORY) can never resolve a row: flat noLifecycleWeight, ageDays 0, never survived', () => {
    const u = unit({ stableId: 'mod-1', relPath: 'src/svc', kind: 'module', name: 'svc' });
    // Rows exist for the real FILES under that directory; neither of rowFor's lookups can reach them
    // from a directory-shaped relPath or a directory-shaped skeyR.
    const fileRow = row({ key: 'src/svc/a.ts', level: 'file', firstSeenTs: -400 * DAY, lastModifiedTs: -400 * DAY });
    const { baseWeight, surfaceWeight, ageDays } = makeWeightFns({ lifecycle: indexOf([fileRow]), ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    expect(baseWeight(u)).toBeCloseTo(0.3, 10);
    expect(surfaceWeight(u, 'auto.call:foo')).toBeCloseTo(0.3, 10);
    expect(ageDays(u)).toBe(0);
    expect(ageDays(u) >= config.weights.freshPenaltyDays).toBe(false); // never survived
  });
});

// -----------------------------------------------------------------------------
// The ledger cap on top of `base` — R4-I5, applied last, via `min` not assignment.
// -----------------------------------------------------------------------------

describe('surfaceWeight — the ledger cap, applied LAST', () => {
  it('an unreleased mark caps row 1s 1.0 down to hookShapedWeight 0.15', () => {
    const u = unit({ stableId: 's1', relPath: 'src/a.ts', kind: 'method', name: 'a' });
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: -400 * DAY, lastModifiedTs: -400 * DAY });
    const mark: LedgerEntry = { stableId: u.stableId, surface: 'auto.call:foo', date: '2020-01-01T00:00:00.000Z' };
    const { surfaceWeight } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [mark], dirtyPaths: new Set(), clockTs: NOW, config });
    expect(surfaceWeight(u, 'auto.call:foo')).toBeCloseTo(0.15, 10);
  });

  it('min, never assignment — an unreleased mark on row 2s 0.05 stays 0.05, never RISES to 0.15', () => {
    const u = unit({ stableId: 's2', relPath: 'src/b.ts', kind: 'method', name: 'b' });
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: -10 * DAY, lastModifiedTs: -10 * DAY });
    const mark: LedgerEntry = { stableId: u.stableId, surface: 'auto.call:foo', date: '2020-01-01T00:00:00.000Z' };
    const { surfaceWeight } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [mark], dirtyPaths: new Set(), clockTs: NOW, config });
    // min(0.05, 0.15) = 0.05. If the cap were assignment rather than min, this would read 0.15.
    expect(surfaceWeight(u, 'auto.call:foo')).toBeCloseTo(0.05, 10);
  });

  it('a mark on a DIFFERENT surface never caps this ones weight', () => {
    const u = unit({ stableId: 's1', relPath: 'src/a.ts', kind: 'method', name: 'a' });
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: -400 * DAY, lastModifiedTs: -400 * DAY });
    const mark: LedgerEntry = { stableId: u.stableId, surface: 'auto.deco:Foo', date: '2020-01-01T00:00:00.000Z' };
    const { surfaceWeight } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [mark], dirtyPaths: new Set(), clockTs: NOW, config });
    expect(surfaceWeight(u, 'auto.call:foo')).toBeCloseTo(1.0, 10);
  });

  it('a mark on a DIFFERENT scope never caps this ones weight', () => {
    const u = unit({ stableId: 's1', relPath: 'src/a.ts', kind: 'method', name: 'a' });
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: -400 * DAY, lastModifiedTs: -400 * DAY });
    // Same surface, a different scope's stable_id: the cap keys on (scope, surface), so this must not bite.
    const mark: LedgerEntry = { stableId: 'some-other-scope', surface: 'auto.call:foo', date: '2020-01-01T00:00:00.000Z' };
    const { surfaceWeight, isHookShaped } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [mark], dirtyPaths: new Set(), clockTs: NOW, config });
    expect(isHookShaped(u, 'auto.call:foo')).toBe(false);
    expect(surfaceWeight(u, 'auto.call:foo')).toBeCloseTo(1.0, 10);
  });

  it('MR-19 killer — the DEGRADED branch is capped too: no lifecycle row + a mark present -> min(noLifecycleWeight, hookShapedWeight) = 0.15, never the un-capped 0.3', () => {
    const u = unit({ stableId: 's6', relPath: 'src/none.ts', kind: 'method', name: 'none' });
    const mark: LedgerEntry = { stableId: u.stableId, surface: 'auto.call:foo', date: '2020-01-01T00:00:00.000Z' };
    const { surfaceWeight } = makeWeightFns({ lifecycle: EMPTY_INDEX, ledger: [mark], dirtyPaths: new Set(), clockTs: NOW, config });
    // Cap-inside-the-product would instead compute base()'s own max(baseFloor, ...) branch — never
    // reached for a rowless scope in the first place — and return the un-capped 0.3.
    expect(surfaceWeight(u, 'auto.call:foo')).toBeCloseTo(0.15, 10);
  });
});

// -----------------------------------------------------------------------------
// Criterion 1 — release is predicated on the SCOPEs stable_days, never on the marks own age.
// -----------------------------------------------------------------------------

describe('releasedMarks — §18.3 release rule (criterion 1)', () => {
  const MARK_DATE = new Date(0).toISOString(); // mark at day 0

  it('stable_days 80 < releaseStableDays 90 -> NOT released, still caps (mark at day 0, only human touch at day 20, clock at day 100)', () => {
    const stableId = 'mark-s1';
    const r = row({ key: stableId, level: 'scope', firstSeenTs: 20 * DAY, lastModifiedTs: 20 * DAY, lastHumanCommitTs: 20 * DAY });
    const mark: LedgerEntry = { stableId, surface: 'auto.call:foo', date: MARK_DATE };
    // gap (20 - 0 = 20) already clears releaseMinDaysAfterMark 14 -- the releaseStableDays conjunct
    // (own mutation target) is the ONLY thing keeping this unreleased.
    const released = releasedMarks([mark], indexOf([r]), 100 * DAY, config);
    expect(released.size).toBe(0);
  });

  it('stable_days 110 >= 90 and gap 20 >= 14 -> released (clock at day 130)', () => {
    const stableId = 'mark-s2';
    const r = row({ key: stableId, level: 'scope', firstSeenTs: 20 * DAY, lastModifiedTs: 20 * DAY, lastHumanCommitTs: 20 * DAY });
    const mark: LedgerEntry = { stableId, surface: 'auto.call:foo', date: MARK_DATE };
    const released = releasedMarks([mark], indexOf([r]), 130 * DAY, config);
    expect(released.has(`${mark.stableId}\u0000${mark.surface}\u0000${mark.date}`)).toBe(true);
  });

  it('stable_days 125 >= 90 but gap 5 < 14 -> NOT released (clock at day 130, only touch 5 days after the mark)', () => {
    const stableId = 'mark-s3';
    const r = row({ key: stableId, level: 'scope', firstSeenTs: 5 * DAY, lastModifiedTs: 5 * DAY, lastHumanCommitTs: 5 * DAY });
    const mark: LedgerEntry = { stableId, surface: 'auto.call:foo', date: MARK_DATE };
    // MR-22 killer: delete the releaseMinDaysAfterMark conjunct and this incorrectly releases
    // (stable_days 125 alone clears releaseStableDays 90).
    const released = releasedMarks([mark], indexOf([r]), 130 * DAY, config);
    expect(released.size).toBe(0);
  });

  it('a mark whose scope the walk cannot resolve at all stays capped (conservative)', () => {
    const mark: LedgerEntry = { stableId: 'unresolvable', surface: 'auto.call:foo', date: MARK_DATE };
    const released = releasedMarks([mark], EMPTY_INDEX, 10000 * DAY, config);
    expect(released.size).toBe(0);
  });

  it('a syntactically valid but semantically malformed mark date is treated as unreleased, never thrown', () => {
    const stableId = 'mark-malformed';
    // stable_days clears releaseStableDays comfortably; only the unparseable date stands in the way.
    const r = row({ key: stableId, level: 'scope', firstSeenTs: 0, lastModifiedTs: 0, lastHumanCommitTs: 400 * DAY });
    const mark: LedgerEntry = { stableId, surface: 'auto.call:foo', date: 'not-a-real-date' };
    expect(() => releasedMarks([mark], indexOf([r]), 400 * DAY, config)).not.toThrow();
    const released = releasedMarks([mark], indexOf([r]), 400 * DAY, config);
    expect(released.size).toBe(0);
  });

  it('a released marks own filtered-out ledger no longer caps its surface weight', () => {
    const u = unit({ stableId: 'mark-s2', relPath: 'src/m2.ts', kind: 'method', name: 'm2' });
    const historicalRow = row({ key: u.stableId, level: 'scope', firstSeenTs: 20 * DAY, lastModifiedTs: 20 * DAY, lastHumanCommitTs: 20 * DAY });
    const mark: LedgerEntry = { stableId: u.stableId, surface: 'auto.call:foo', date: MARK_DATE };
    const released = releasedMarks([mark], indexOf([historicalRow]), 130 * DAY, config);
    const unreleasedLedger = [mark].filter((m) => !released.has(`${m.stableId}\u0000${m.surface}\u0000${m.date}`));
    expect(unreleasedLedger).toHaveLength(0);
    // The scope's OWN weight row (keyed by skeyR/relPath, not stable_id) is what drives
    // surfaceWeight; the filtered-empty ledger here is exactly what WeightInputs.ledger's own doc
    // comment ("released marks already filtered out") requires a caller to hand in.
    const clean = unit({ stableId: u.stableId, relPath: u.relPath, kind: 'method', name: 'm2', skeyR: u.skeyR });
    const liveRow = row({ key: clean.skeyR, level: 'scope', firstSeenTs: -400 * DAY, lastModifiedTs: -400 * DAY });
    const { surfaceWeight } = makeWeightFns({ lifecycle: indexOf([liveRow]), ledger: unreleasedLedger, dirtyPaths: new Set(), clockTs: NOW, config });
    expect(surfaceWeight(clean, 'auto.call:foo')).toBeCloseTo(1.0, 10);
  });

  it('a scope with no human touch at all (agent-only history) never releases, however stable', () => {
    const stableId = 'mark-agent-only';
    // stable_days = 400 >> releaseStableDays 90; the only thing withholding release is that no human ever touched it.
    const r = row({ key: stableId, level: 'scope', firstSeenTs: 0, lastModifiedTs: 0, authorKind: 'agent', lastHumanCommitTs: null });
    // A mark dated 30 days BEFORE epoch makes `threshold` negative (markMs/1000 + 14d < 0). A guard
    // rewritten as `(lastHumanCommitTs ?? 0) >= threshold` would then read `0 >= <negative>` as true
    // and incorrectly release — MARK_DATE (epoch 0, threshold > 0) would NOT distinguish this from
    // the correct `!== null` guard, since `0 >= <positive threshold>` is false either way.
    const earlyMarkDate = new Date(-30 * DAY * 1000).toISOString();
    const mark: LedgerEntry = { stableId, surface: 'auto.call:foo', date: earlyMarkDate };
    expect(releasedMarks([mark], indexOf([r]), 400 * DAY, config).size).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Criterion 2 — with NO lifecycle source at all, ageDays is 0 and the survived
// predicate (composed by the caller from ageDays/isHookShaped) is false.
// -----------------------------------------------------------------------------

describe('ageDays / isHookShaped — the fail-closed survived predicate (criterion 2)', () => {
  it('with lifecycle empty, ageDays returns 0 for every scope, so ageDays >= freshPenaltyDays is false unconditionally', () => {
    const u = unit({ stableId: 'empty-1', relPath: 'src/none.ts', kind: 'method', name: 'none' });
    const { ageDays, isHookShaped } = makeWeightFns({ lifecycle: EMPTY_INDEX, ledger: [], dirtyPaths: new Set(), clockTs: 999_999, config });
    expect(ageDays(u)).toBe(0);
    const survived = ageDays(u) >= config.weights.freshPenaltyDays && !isHookShaped(u, 'auto.call:foo');
    expect(survived).toBe(false);
  });

  it('with a resolvable row, ageDays reads age_days = max(0, (now - first_seen_ts)/86400) off it', () => {
    const u = unit({ stableId: 'aged-1', relPath: 'src/aged.ts', kind: 'method', name: 'aged' });
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: -30 * DAY, lastModifiedTs: -5 * DAY });
    const { ageDays } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    expect(ageDays(u)).toBeCloseTo(30, 10);
  });

  it('a row timestamped AFTER the clock (committer-clock skew) clamps to 0, never negative', () => {
    const u = unit({ stableId: 'skew-1', relPath: 'src/skew.ts', kind: 'method', name: 'skew' });
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: 30 * DAY, lastModifiedTs: 30 * DAY }); // clock is NOW = 0
    const { baseWeight, ageDays } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    // stable_days = max(0, (0 - 30d)/86400) = 0 -> w_surv = 0; age_days = 0 (< 14, so x0.5) -> base = floor 0.05
    expect(ageDays(u)).toBe(0);
    expect(baseWeight(u)).toBeCloseTo(0.05, 10);
  });

  it('the SAME clamp on stable_days: a future-dated AGENT row cannot ride a double negative above the floor', () => {
    const u = unit({ stableId: 'skew-2', relPath: 'src/skew2.ts', kind: 'method', name: 'skew2' });
    // clock is NOW = 0; the row sits 100 days in the FUTURE (rebase / cherry-pick / committer-clock skew).
    const r = row({ key: u.skeyR, level: 'scope', firstSeenTs: 100 * DAY, lastModifiedTs: 100 * DAY, authorKind: 'agent' });
    const { baseWeight } = makeWeightFns({ lifecycle: indexOf([r]), ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    // Clamped: stable_days = 0 -> w_surv = 0 x 0.5 = 0; w_prov = 0.15 + 0.85 x 0 = 0.15 -> base = max(0.05, 0) = 0.05.
    // WITHOUT the clamp on stable_days, w_surv = -100/240 = -0.416667 and w_prov = 0.15 - 0.85 x 100/180 =
    // -0.322222, whose product is POSITIVE 0.134259 -- ABOVE the floor, so baseFloor cannot rescue it and
    // the scope would weigh 2.7x what it should. This is why the ageDays-only skew test above is not enough.
    expect(baseWeight(u)).toBeCloseTo(0.05, 10);
  });
});

// -----------------------------------------------------------------------------
// Criterion 3 — scope-level row wins over file-level; file-level is the
// fallback; neither -> noLifecycleWeight.
// -----------------------------------------------------------------------------

describe('LifecycleIndex two-step lookup precedence (criterion 3)', () => {
  it('a scope-level row wins over a file-level row present for the same path', () => {
    const u = unit({ stableId: 'prec-1', relPath: 'src/p.ts', kind: 'method', name: 'p' });
    const scopeRow = row({ key: u.skeyR, level: 'scope', firstSeenTs: -400 * DAY, lastModifiedTs: -400 * DAY }); // -> base 1.0
    const fileRow = row({ key: u.relPath, level: 'file', firstSeenTs: -10 * DAY, lastModifiedTs: -10 * DAY }); // -> base 0.05
    const { baseWeight } = makeWeightFns({ lifecycle: indexOf([scopeRow, fileRow]), ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    expect(baseWeight(u)).toBeCloseTo(1.0, 10);
  });

  it('a scope with no scope-level row falls back to its file-level row', () => {
    const u = unit({ stableId: 'prec-2', relPath: 'src/q.ts', kind: 'method', name: 'q' });
    const fileRow = row({ key: u.relPath, level: 'file', firstSeenTs: -400 * DAY, lastModifiedTs: -400 * DAY });
    const { baseWeight } = makeWeightFns({ lifecycle: indexOf([fileRow]), ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    expect(baseWeight(u)).toBeCloseTo(1.0, 10);
  });

  it('with neither a scope-level nor a file-level row, noLifecycleWeight', () => {
    const u = unit({ stableId: 'prec-3', relPath: 'src/r.ts', kind: 'method', name: 'r' });
    const { baseWeight } = makeWeightFns({ lifecycle: EMPTY_INDEX, ledger: [], dirtyPaths: new Set(), clockTs: NOW, config });
    expect(baseWeight(u)).toBeCloseTo(0.3, 10);
  });
});
