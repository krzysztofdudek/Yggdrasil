import { describe, it, expect } from 'vitest';
import {
  induceRoles,
  buildRoleFeatureBag,
  roleJaccard,
  classifyAgainstMedoids,
  agglomerativeClusterCut,
  sampleRepresentatives,
  labelOf,
  compareRoles,
  roleLift,
  isDecorativeRole,
  type RoleMedoid,
  type RoleFeatureBag,
  type RoleInfo,
  type RoleLiftSurfaceInput,
} from '../../../src/roots/roles.js';
import type { ScopeUnit } from '../../../src/roots/extract.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/roles.test.ts — spec §8 role induction: the §8.1 feature
// bag, §8.2 Jaccard, §8.3's per-partition bucket-weighted clustering + MDL
// cut, §8.4/8.5's classifier + clone-aware ambiguity, §8.6's assignments-map
// persistence, §8.8's role identity (role_key/label/definingFeatureGroups),
// §8.9(b)'s file-role plurality, and §8.10's pure role_lift formula.
// ---------------------------------------------------------------------------

/** A minimal, fully-shaped ScopeUnit — every roles.ts-irrelevant field defaulted, only the fields a given fixture cares about overridden. */
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
    supertypes: overrides.supertypes ?? [],
    decorators: overrides.decorators ?? [],
    grammarHasDecoratorTypes: false,
    grammarHasHeritageCandidacy: false,
    grammarNodeTypeVocabulary: [],
    fileImports: overrides.fileImports ?? [],
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

/** N method-kind ScopeUnits sharing one exact feature bag (name + supertypes + decorators), stable ids `${idPrefix}${i}` (zero-padded), files `${relPrefix}${i}.ts` — one member per file so §8.9(b) file-role tests can reuse the same population. */
function typedGroup(
  n: number,
  idPrefix: string,
  relPrefix: string,
  name: string,
  supertypes: string[] = [],
  decorators: string[] = [],
  partitionId = 'p1',
): ScopeUnit[] {
  return Array.from({ length: n }, (_, i) => {
    const idx = String(i + 1).padStart(4, '0');
    const relPath = `${relPrefix}${i + 1}.ts`;
    return unit({
      kind: 'method',
      relPath,
      name,
      supertypes,
      decorators,
      stableId: `${idPrefix}${idx}`,
      partitionId,
    });
  });
}

async function config(overridesYaml = '') {
  return defaultRootsConfig(overridesYaml);
}

describe('buildRoleFeatureBag — spec §8.1', () => {
  it('tok: casing-boundary tokens (length >= 2), sup:/dec: raw (case preserved), imp: up to 5 distinct package specifiers by last segment', async () => {
    const u = unit({
      kind: 'type',
      relPath: 'src/AuthGuard.ts',
      name: 'AuthGuard',
      stableId: 's1',
      supertypes: ['CanActivate'],
      decorators: ['Injectable'],
      fileImports: ['@nestjs/common', '@nestjs/core', './local-thing', '../also-local', '@scope/pkg/deep/path', '@scope/pkg/deep/path', '@sixth/pkg'],
    });
    const bag = buildRoleFeatureBag(u);
    // tok: "AuthGuard" -> camel-boundary split "Auth Guard" -> lowercase -> ['auth','guard'] (both length >= 2)
    expect(bag.ordered).toEqual([
      'tok:auth',
      'tok:guard',
      'sup:CanActivate',
      'dec:Injectable',
      'imp:common', // @nestjs/common
      'imp:core', // @nestjs/core
      'imp:path', // @scope/pkg/deep/path (deduped second occurrence dropped, by LAST SEGMENT — the repeated specifier's segment "path" was already seen)
      'imp:pkg', // @sixth/pkg — the 4th and last distinct segment this fixture produces (see count below); the 5-cap never binds here
    ]);
    // Only 4 DISTINCT package specifiers appear before the cap in this fixture
    // (common, core, path, pkg) — the two relative imports never contribute
    // (§8.1's own "relative imports excluded" clause), so the 5-cap never
    // actually binds here; own feature count = |tok ∪ sup ∪ dec| = 2+1+1 = 4 (imp: excluded from the gate).
    expect(bag.ownFeatureCount).toBe(4);
  });


  it('a bare package specifier with no "/" at all contributes its own full text as the segment', () => {
    const u = unit({ kind: 'method', relPath: 'src/y.ts', name: 'y', stableId: 's-bare', fileImports: ['lodash'] });
    const bag = buildRoleFeatureBag(u);
    expect(bag.ordered).toContain('imp:lodash');
  });

  it('the 5-distinct-import cap actually stops accumulation (a 6th distinct package specifier never appears)', () => {
    const u = unit({
      kind: 'method',
      relPath: 'src/z.ts',
      name: 'z',
      stableId: 's-cap',
      fileImports: ['pkg1', 'pkg2', 'pkg3', 'pkg4', 'pkg5', 'pkg6'],
    });
    const bag = buildRoleFeatureBag(u);
    const impFeatures = bag.ordered.filter((f) => f.startsWith('imp:'));
    expect(impFeatures).toEqual(['imp:pkg1', 'imp:pkg2', 'imp:pkg3', 'imp:pkg4', 'imp:pkg5']);
    expect(impFeatures).not.toContain('imp:pkg6');
  });
});

describe('roleJaccard — spec §8.2', () => {
  it('disjoint sets -> 0, identical sets -> 1, partial overlap computed exactly', () => {
    expect(roleJaccard(new Set(['a', 'b']), new Set(['c', 'd']))).toBe(0);
    expect(roleJaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    // {a,b,c} vs {a,b,d}: intersection 2, union 4 -> 0.5
    expect(roleJaccard(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'd']))).toBe(0.5);
  });

  it('both empty -> 0 (no shared signal to report, not division by zero)', () => {
    expect(roleJaccard(new Set(), new Set())).toBe(0);
  });
});

describe('classifyAgainstMedoids — spec §8.4/§8.5 (own-features-only nearest medoid, clone-aware ambiguity)', () => {
  const guard: RoleMedoid = { set: new Set(['tok:guard', 'sup:CanActivate']), ordered: ['tok:guard', 'sup:CanActivate'] };
  const service: RoleMedoid = { set: new Set(['tok:service', 'sup:Injectable']), ordered: ['tok:service', 'sup:Injectable'] };

  it('exact match to one medoid, far from the other -> confident, non-ambiguous', () => {
    const result = classifyAgainstMedoids(new Set(['tok:guard', 'sup:CanActivate']), [guard, service], 0.6, 0.15, 0.35);
    // m1 = jaccard(bag, guard) = 1; m2 = jaccard(bag, service) = 0 (disjoint) -> gap 1 >= 0.15, m1 >= 0.35
    expect(result).toEqual({ roleIndex: 0, ambiguous: false });
  });

  it('best membership 0 (no overlap with any medoid) -> no role at all (roleIndex -1)', () => {
    const result = classifyAgainstMedoids(new Set(['tok:unrelated']), [guard, service], 0.6, 0.15, 0.35);
    expect(result.roleIndex).toBe(-1);
  });

  it('no medoids at all -> no role', () => {
    expect(classifyAgainstMedoids(new Set(['tok:guard']), [], 0.6, 0.15, 0.35).roleIndex).toBe(-1);
  });

  it('ambiguity gap: a scope symmetrically placed between two genuinely different (non-clone) medoids is ambiguous purely by the gap rule', () => {
    // Two medoids sharing 7 "c" tokens plus one unique token each (guard3's
    // own tok:guard, service3's own tok:service) -- mutual jaccard 7/9 ≈
    // 0.778, kept BELOW this call's own cloneMedoidJaccard (0.99) so the
    // clone guard never engages here (that mechanism has its own dedicated
    // describe block below) -- this isolates the plain gap rule.
    const cTokens = Array.from({ length: 7 }, (_, i) => `tok:c${i}`);
    const guard3: RoleMedoid = { set: new Set([...cTokens, 'tok:guard']), ordered: [] };
    const service3: RoleMedoid = { set: new Set([...cTokens, 'tok:service']), ordered: [] };
    // A scope carrying exactly the 7 shared tokens and NEITHER unique one:
    // jaccard(bag, guard3) = jaccard(bag, service3) = 7/8 = 0.875 (intersection 7, union 8) -- perfectly symmetric.
    const bag = new Set(cTokens);
    const result = classifyAgainstMedoids(bag, [guard3, service3], 0.99, 0.15, 0.35);
    // m1 = m2 = 0.875 (guard3 scanned first, wins the m1 slot on the initial `>` comparison) -> gap 0 < 0.15.
    // m1 = 0.875 is comfortably >= roleMinMembership (0.35), so this is ambiguous via the GAP rule alone, not the floor.
    expect(result.roleIndex).toBe(0);
    expect(result.ambiguous).toBe(true);
  });

  it('roleMinMembership floor: a confident-gap match below roleMinMembership is still ambiguous', () => {
    // bag shares only 1 of 5 medoid features with `guard`, nothing with `service` -> m1 = 1/6 (< 0.35), m2 = 0. gap 1/6 >= 0.15 but m1 < roleMinMembership.
    const wideGuard: RoleMedoid = { set: new Set(['tok:guard', 'sup:A', 'sup:B', 'sup:C', 'sup:D']), ordered: [] };
    const result = classifyAgainstMedoids(new Set(['tok:guard', 'tok:zzz']), [wideGuard, service], 0.6, 0.15, 0.35);
    expect(result.roleIndex).toBe(0);
    expect(result.ambiguous).toBe(true);
  });

  it('MUTATION-RESISTANCE: the m2 search keeps the BEST rival across 3+ candidates, not just the last scanned', () => {
    // 3 medoids: A (winner, exact match), B (second-best rival), C (a
    // WORSE rival scanned AFTER B) — B's jaccard must beat C's so the
    // scan's "does this candidate improve m2" comparison is exercised on
    // BOTH a true (B improves over the initial -1) and a false (C does NOT
    // improve over B) outcome. cloneMedoidJaccard is set to 0.99 so neither
    // B nor C's similarity to A (both well under it) is ever skipped as a clone.
    const a: RoleMedoid = { set: new Set(['f1', 'f2', 'f3']), ordered: [] };
    const b: RoleMedoid = { set: new Set(['f1', 'f2']), ordered: [] }; // jaccard(bag,b) = 2/3
    const c: RoleMedoid = { set: new Set(['f1']), ordered: [] }; // jaccard(bag,c) = 1/3 -- WORSE than b, must not overwrite m2
    const bag = new Set(['f1', 'f2', 'f3']); // exact match to `a`
    const result = classifyAgainstMedoids(bag, [a, b, c], 0.99, 0.15, 0.35);
    // m1 = 1 (a); m2 = 2/3 (b, the best rival — c never overwrites it) -> gap = 1/3 >= 0.15, m1 >= 0.35 -> confident.
    expect(result).toEqual({ roleIndex: 0, ambiguous: false });
  });

  describe('the clone-aware runner-up (§8.5, MUTATION-RESISTANCE target)', () => {
    // Two near-clone medoids sharing 12 of 13 features each (one own token
    // apiece): intersection 12, union 14 -> jaccard(clone1, clone2) = 12/14 ≈ 0.857.
    // >= cloneMedoidJaccard (0.6): the clone guard MUST skip clone2 when
    // computing m2 for a scope that matches clone1 exactly.
    const shared = Array.from({ length: 12 }, (_, i) => `tok:shared${i}`);
    const clone1: RoleMedoid = { set: new Set([...shared, 'tok:only1']), ordered: [] };
    const clone2: RoleMedoid = { set: new Set([...shared, 'tok:only2']), ordered: [] };
    const bag = new Set([...shared, 'tok:only1']); // == clone1 exactly

    it('WITH the clone guard: clone2 is skipped for m2 -> non-ambiguous (no genuinely different rival)', () => {
      const result = classifyAgainstMedoids(bag, [clone1, clone2], 0.6, 0.15, 0.35);
      // m1 = 1 (exact match to clone1); m2 stays -1 (clone2 skipped, no other candidate) -> gap = 1-(-1) = 2 >= 0.15.
      expect(result).toEqual({ roleIndex: 0, ambiguous: false });
    });

    it('WITHOUT the clone guard (cloneMedoidJaccard set above the actual clone similarity): the near-clone manufactures ambiguity', () => {
      // jaccard(clone1,clone2) ≈ 0.857 — a threshold of 0.99 makes the guard
      // never trigger, reproducing the pre-guard mutation exactly (this is
      // the live mutation-round-trip target: deleting/weakening the guard's
      // `>=` skip condition has the same observable effect as this raised
      // threshold).
      const result = classifyAgainstMedoids(bag, [clone1, clone2], 0.99, 0.15, 0.35);
      // m2 = jaccard(bag, clone2) = 12/14 ≈ 0.857 -> gap = 1 - 0.857 ≈ 0.143 < 0.15 -> ambiguous.
      expect(result.roleIndex).toBe(0);
      expect(result.ambiguous).toBe(true);
    });
  });
});

/** A `RoleFeatureBag`-shaped literal for `agglomerativeClusterCut`'s own direct tests — only `.set` is read by that function, but the full shape is supplied so the value type-checks. */
function bag(features: string[]): RoleFeatureBag {
  return { ordered: features, set: new Set(features), ownFeatureCount: features.length };
}

describe('agglomerativeClusterCut — spec §8.3 incremental-DL MDL cut (direct, independently verified)', () => {
  it('MUTATION-RESISTANCE: a merge that improves the running cut DL is adopted, not just the initial split', () => {
    // 8 representatives, weight 1 each: two NEAR-DUPLICATES sharing 19 of 20
    // features (intersection 19, union 21 -> jaccard ≈ 0.905, the closest
    // pair by construction) plus 6 mutually-disjoint 2-feature "outlier"
    // bags. Independently verified (a small standalone script mirroring
    // this exact algorithm): the initial 8-singleton split has DL 50.000;
    // merging the closest (near-duplicate) pair FIRST drops DL to 41.500
    // (redundant shared features, each costing 0.5 bits per singleton
    // copy, now cost 0.5 bits ONCE in the merged pair, more than repaying
    // the two features unique to one side) — every SUBSEQUENT merge then
    // makes DL worse (104.6, 139.5, ... up to 236.7 at k=1), so the winning
    // cut is exactly 7 clusters: the merged near-duplicate pair plus the 6
    // untouched outlier singletons. If the "does this merge improve the
    // running best" comparison were deleted (always keeping only the
    // INITIAL split, or always keeping the LAST state), the result would
    // be 8 singletons or 1 giant cluster respectively — neither matches.
    const shared = Array.from({ length: 19 }, (_, i) => `s${i}`);
    const dup1 = bag([...shared, 'u1']);
    const dup2 = bag([...shared, 'u2']);
    const outliers = Array.from({ length: 6 }, (_, k) => bag([`o${k}a`, `o${k}b`]));
    const clusters = agglomerativeClusterCut([dup1, dup2, ...outliers], [1, 1, 1, 1, 1, 1, 1, 1]);

    expect(clusters).toHaveLength(7);
    const mergedPair = clusters.find((c) => c.length === 2);
    expect(mergedPair?.slice().sort()).toEqual([0, 1]); // dup1, dup2 — the two near-duplicates, indices 0 and 1
    expect(clusters.filter((c) => c.length === 1)).toHaveLength(6);
  });

  it('MUTATION-RESISTANCE (§8.3 weighted Lance-Williams, binding): unequal bucket weights change which representative a growing cluster next absorbs', () => {
    // 4 representatives over a 9-feature universe {u1..u9}, each "leave-one-out":
    //   p0 = universe \ {u6}   p1 = universe \ {u8}   p2 = p3 = universe \ {u2}  (p2, p3 IDENTICAL)
    // p2/p3 merge first (distance 0, the closest pair by construction, weight-independent).
    // Independently verified (a script mirroring this exact algorithm) with
    // weights [1, 1, 6, 1] (p2's own bucket weight 6 -- e.g. 6 scopes sharing
    // that exact bag, vs 1 each for p0/p1/p3):
    //   initial 4-singleton split:                                DL = 30.339850002884624
    //   merge(p2,p3):                                              DL = 25.229419688230420 (adopted -- new best)
    //   weighted Lance-Williams then absorbs p0 INTO {p2,p3}:      DL = 30.197031091193544 (REJECTED, worse than 25.229 -- best STAYS [[p0],[p1],[p2,p3]])
    //   the remaining merge:                                       DL = 32.201153091029610 (also rejected)
    // -> weighted best = [[p0],[p1],[p2,p3]] (3 clusters), bestDL 25.2294...
    //
    // The Lance-Williams weighted-average update for the {p2,p3} cluster's
    // distance to p0 is `(6*d(p2,p0) + 1*d(p3,p0)) / 7`. Since p2 and p3
    // share the IDENTICAL bag, d(p2,p0) == d(p3,p0) == 2/9 exactly, so this
    // MUST equal 2/9 in exact arithmetic -- but IEEE754 division by 7 rounds
    // the result ONE ULP BELOW the untouched d(p0,p1) (also exactly 2/9),
    // a fully reproducible float result (same bit pattern on any IEEE754
    // engine, not test flakiness) that makes p0 STRICTLY closer to {p2,p3}
    // than to p1. Strip the WEIGHTING from that same update (a plain 2-way
    // average, `(d(p2,p0)+d(p3,p0))/2`) and the division is EXACT (doubling
    // then halving loses no bits), reproducing d(p0,p1) EXACTLY -- a genuine
    // tie the unweighted computation resolves by scan order instead, picking
    // (p0,p1) over (p0,{p2,p3}):
    //   merge(p0,p1) [SKIPPING {p2,p3} entirely]:                  DL = 23.729419688230420 (LOWER -- new best)
    //   final merge:                                               DL = 32.201153091029610 (rejected)
    // -> unweighted-Lance-Williams best = [[p0,p1],[p2,p3]] (2 clusters), bestDL 23.7294...
    //
    // Real weighted and unweighted Lance-Williams therefore pick a DIFFERENT
    // SECOND MERGE PARTNER for p0 (the {p2,p3} cluster vs p1) and arrive at
    // a DIFFERENT final cut -- the observable this test pins.
    const universe = Array.from({ length: 9 }, (_, i) => `u${i + 1}`);
    const withoutFeature = (idx: number) => bag(universe.filter((_, i) => i !== idx));
    const p0 = withoutFeature(5); // universe minus u6
    const p1 = withoutFeature(7); // universe minus u8
    const p2 = withoutFeature(1); // universe minus u2
    const p3 = withoutFeature(1); // universe minus u2 -- IDENTICAL to p2

    const clusters = agglomerativeClusterCut([p0, p1, p2, p3], [1, 1, 6, 1]);

    const sorted = clusters.map((c) => [...c].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
    expect(sorted).toEqual([[0], [1], [2, 3]]);
  });

  it('a single representative never merges (the loop never runs) and the lone cluster is returned', () => {
    expect(agglomerativeClusterCut([bag(['a', 'b'])], [5])).toEqual([[0]]);
  });

  it('no representatives at all -> no clusters', () => {
    expect(agglomerativeClusterCut([], [])).toEqual([]);
  });

  describe('MUTATION-RESISTANCE (the k·log2(N) model-complexity term, binding, both sites)', () => {
    // Both fixtures below hold 4 representatives (N=4, so log2(N)=2) — one
    // near-duplicate pair (A,B, weight 1 each) plus two mutually-disjoint
    // 2-feature "outlier" singletons (C,D, weight 1 each, never merge with
    // anything or each other). Only the SHARED-vs-UNIQUE feature count of
    // the A,B pair (K shared, 1 unique each) differs between the two.
    //
    // DL formula per singleton (weight w, f features, all p=1): f·0.5·log2(max(w,2)).
    // DL of the merged {A,B} pair (weight 2 -> nc=2): K shared features at
    // p=1 cost K·0.5·log2(2) = 0.5K; the 2 unique features (a1 only in A,
    // count 1; b1 only in B, count 1) each cost nc·H(0.5) + 0.5·log2(nc) =
    // 2·1 + 0.5·1 = 2.5 -> 5 total. DL(merged) = 0.5K + 5.
    // DL(A)+DL(B) unmerged = 2·(K+1)·0.5·log2(2) = K+1.
    // DATA delta from merging = (0.5K+5) - (K+1) = 4 - 0.5K.

    it('K=2 (DATA delta = +3, model reward log2(4)=2 too small to cover it): the model term correctly keeps the split — its ABSENCE at the loop-body comparison site would wrongly merge', () => {
      // DATA delta = 4 - 0.5*2 = +3 (unfavorable) > log2(4)=2, so merging
      // must lose on TOTAL DL too — a MORE-clusters (4 singleton) result.
      // Independently verified (a script mirroring this exact algorithm):
      //   init (4 singletons, WITH model term):        DL = 5(data) + 4*log2(4)=8  = 13.0000
      //   merge(A,B) (3 clusters, WITH model term):     DL = 8(data) + 3*log2(4)=6  = 14.0000  (REJECTED, 14 > 13 -- best stays split)
      // If the model term were deleted ONLY at the per-merge comparison site
      // (the `total = sum + active.size * Math.log2(N)` inside the loop),
      // the merge state would report its BARE data DL (8) against the
      // STILL-correct initial bestDL (13): 8 < 13 -- WRONGLY ADOPTED. This
      // fixture's expectation (4 singletons) fails under that mutant.
      const shared = Array.from({ length: 2 }, (_, i) => `s${i}`);
      const A = bag([...shared, 'a1']);
      const B = bag([...shared, 'b1']);
      const C = bag(['c1', 'c2']);
      const D = bag(['d1', 'd2']);
      const clusters = agglomerativeClusterCut([A, B, C, D], [1, 1, 1, 1]);
      const sorted = clusters.map((c) => [...c].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
      expect(sorted).toEqual([[0], [1], [2], [3]]); // more clusters wins -- the model term's absence at merge-time would flip this
    });

    it('K=6 (DATA delta = +1, model reward log2(4)=2 covers it): the model term correctly adopts the merge — its ABSENCE at the initial-split site would wrongly reject it', () => {
      // DATA delta = 4 - 0.5*6 = +1 (unfavorable on data terms ALONE, "more
      // clusters win on data terms") but < log2(4)=2, so the model term's
      // reward for going from 4 to 3 clusters flips the TOTAL in favor of
      // merging. Independently verified (a script mirroring this exact
      // algorithm):
      //   init (4 singletons, WITH model term):     DL = 9(data) + 4*log2(4)=8 = 17.0000
      //   merge(A,B) (3 clusters, WITH model term):  DL = 10(data) + 3*log2(4)=6 = 16.0000  (ADOPTED, 16 < 17 -- best merges)
      // If the model term were deleted ONLY at the initial bestDL site
      // (`let bestDL = sum + active.size * Math.log2(N)` before the loop),
      // the initial state would report its BARE data DL (9) against the
      // STILL-correct merge total (16): 16 < 9 is false -- WRONGLY REJECTED,
      // reverting to 4 singletons. This fixture's expectation (A,B merged)
      // fails under that mutant.
      const shared = Array.from({ length: 6 }, (_, i) => `s${i}`);
      const A = bag([...shared, 'a1']);
      const B = bag([...shared, 'b1']);
      const C = bag(['c1', 'c2']);
      const D = bag(['d1', 'd2']);
      const clusters = agglomerativeClusterCut([A, B, C, D], [1, 1, 1, 1]);
      const mergedPair = clusters.find((c) => c.length === 2);
      expect(mergedPair?.slice().sort()).toEqual([0, 1]); // A,B merged -- the model term's absence at the initial split would flip this
      expect(clusters).toHaveLength(3);
    });
  });
});

describe('sampleRepresentatives — spec §8.3 deterministic stride sample', () => {
  it('under the cap: every representative passes through unchanged', () => {
    expect(sampleRepresentatives(['a', 'b', 'c'], 5)).toEqual(['a', 'b', 'c']);
  });

  it('MUTATION-RESISTANCE: over the cap, a deterministic stride sample selects exactly `cap` representatives', () => {
    const reps = Array.from({ length: 10 }, (_, i) => i);
    // stride = 10/4 = 2.5; k=0..3 -> floor(0*2.5)=0, floor(2.5)=2, floor(5)=5, floor(7.5)=7.
    expect(sampleRepresentatives(reps, 4)).toEqual([0, 2, 5, 7]);
  });

  it('is a pure function of its input length and cap — repeated calls agree (determinism)', () => {
    const reps = Array.from({ length: 23 }, (_, i) => `bag${i}`);
    expect(sampleRepresentatives(reps, 5)).toEqual(sampleRepresentatives(reps, 5));
    expect(sampleRepresentatives(reps, 5)).toHaveLength(5);
  });
});

describe('labelOf — spec §8.8 display label', () => {
  it('first 3 tok:/sup:/dec: features, tag-prefix stripped, joined with "+" — imp: never contributes', () => {
    expect(labelOf(['tok:guard', 'sup:CanActivate', 'dec:Injectable', 'imp:common'])).toBe('guard+CanActivate+Injectable');
  });

  it('more than 3 candidates: only the first 3 (construction order) are used', () => {
    expect(labelOf(['tok:a', 'sup:B', 'dec:C', 'tok:d'])).toBe('a+B+C');
  });

  it('the "group" fallback (§8.8: "else group") for a bag with no tok:/sup:/dec: candidates — unreachable through the real pipeline (the `_untyped` gate already requires >= 2 of exactly those features), tested directly per this function\'s own contract', () => {
    expect(labelOf(['imp:common', 'imp:core'])).toBe('group');
    expect(labelOf([])).toBe('group');
  });
});

describe('compareRoles — induceRoles\' final ordering rule (spec: partitionId asc, roleKey asc)', () => {
  const role = (partitionId: string, roleKey: string): RoleInfo => ({
    partitionId,
    roleKey,
    label: 'x',
    size: 1,
    medoidFeatures: [],
    definingFeatureGroups: [],
    ambiguityRate: 0,
  });

  it('MUTATION-RESISTANCE: different partitions sort by partitionId ascending, in EITHER input order', () => {
    const a = role('p1', 'zzz');
    const b = role('p2', 'aaa');
    expect(compareRoles(a, b)).toBeLessThan(0); // a's partition sorts first even though its roleKey is lexicographically LARGER
    expect(compareRoles(b, a)).toBeGreaterThan(0);
  });

  it('same partition: roleKey ascending', () => {
    const a = role('p1', 'aaa');
    const b = role('p1', 'zzz');
    expect(compareRoles(a, b)).toBeLessThan(0);
    expect(compareRoles(b, a)).toBeGreaterThan(0);
  });
});

describe('induceRoles — end-to-end per-partition clustering (spec §8.3, hand-derived)', () => {
  // Two feature-bag types, 4 identical-bag members each, one partition:
  //   type A ("guard"): tok:guard, sup:CanActivate    (bucket weight 4)
  //   type B ("service"): tok:service, sup:Injectable (bucket weight 4)
  // jaccard(A,B) = 0 (disjoint) -> distance 1.
  //
  // DL AT THE INITIAL (2-cluster, one per bucket) SPLIT:
  //   each singleton cluster: nc=4, 2 features each at p_f = 4/4 = 1 -> H(1)=0.
  //   dl(cluster) = 2 features * [4*0 + 0.5*log2(max(4,2))] = 2 * [0 + 0.5*2] = 2 * 1 = 2.
  //   sum = 2+2 = 4; bestDL = sum + k(2)*log2(N=2) = 4 + 2*1 = 6.
  //
  // DL AFTER THE ONLY POSSIBLE MERGE (1 cluster, all 8 instances):
  //   nc=8; 4 distinct features, each present in exactly 4/8 members -> p_f=0.5, H(0.5)=1.
  //   dl = 4 features * [8*1 + 0.5*log2(8)] = 4 * [8 + 1.5] = 4*9.5 = 38.
  //   total = 38 + k(1)*log2(N=2) = 38 + 1 = 39.
  //
  // 6 < 39 -> the cut STOPS at the initial 2-cluster split; both clusters
  // clear minClusterSize (3, default) as their own 4-weight totals -> two roles survive.
  it('two disjoint feature-bag types with 4 members each yield two roles, sized and keyed correctly', async () => {
    const cfg = await config();
    const units = [...typedGroup(4, 'aid', 'src/a', 'guard', ['CanActivate']), ...typedGroup(4, 'bid', 'src/b', 'service', ['Injectable'])];
    const result = induceRoles(units, () => 1, cfg);

    expect(result.roles).toHaveLength(2);
    const byLabel = new Map(result.roles.map((r) => [r.label, r]));
    expect([...byLabel.keys()].sort()).toEqual(['guard+CanActivate', 'service+Injectable']);

    const guardRole = byLabel.get('guard+CanActivate') as (typeof result.roles)[number];
    const serviceRole = byLabel.get('service+Injectable') as (typeof result.roles)[number];
    expect(guardRole.size).toBe(4);
    expect(serviceRole.size).toBe(4);
    expect(guardRole.ambiguityRate).toBe(0);
    expect(serviceRole.ambiguityRate).toBe(0);
    expect(guardRole.medoidFeatures).toEqual(['tok:guard', 'sup:CanActivate']);
    expect(guardRole.partitionId).toBe('p1');

    // role_key = sha256(sorted 4 member stable_ids joined by \n).slice(0,12) — computed independently and pinned.
    // Member stable ids: guard = aid0001..aid0004, service = bid0001..bid0004 (typedGroup's own id scheme).
    expect(guardRole.roleKey).toBe('b29f26206d99');
    expect(serviceRole.roleKey).toBe('63f394fa2424');

    // assignments map: every member keyed by its skeyR, valued its role's roleKey (non-ambiguous — confident 1.0 match, 0 to the other role).
    for (let i = 1; i <= 4; i++) {
      expect(result.assignments[`src/a${i}.ts#method#guard`]).toBe(guardRole.roleKey);
      expect(result.assignments[`src/b${i}.ts#method#service`]).toBe(serviceRole.roleKey);
    }
  });

  it('MUTATION-RESISTANCE: minClusterSize floor drops an under-weight cluster entirely — members get no role', async () => {
    const cfg = await config();
    // Only 2 members of a distinct type ("worker") — bucket weight 2 < minClusterSize (3, default).
    // Alone in its own partition, this is the ONLY bucket: N=1 rep, the initial (and only) cut is
    // the single all-members cluster, weight 2 -- below the floor -> dropped whole.
    const units = typedGroup(2, 'wid', 'src/w', 'worker', ['Runnable']);
    const result = induceRoles(units, () => 1, cfg);
    expect(result.roles).toHaveLength(0);
    expect(result.assignments['src/w1.ts#method#worker']).toBeUndefined();
    expect(result.assignments['src/w2.ts#method#worker']).toBeUndefined();
  });

  it('MUTATION-RESISTANCE: per-partition isolation — identical feature bags in two different partitions never cluster together', async () => {
    const cfg = await config();
    const p1 = typedGroup(4, 'p1id', 'src/one/a', 'guard', ['CanActivate'], [], 'p1');
    const p2 = typedGroup(4, 'p2id', 'src/two/a', 'guard', ['CanActivate'], [], 'p2');
    const result = induceRoles([...p1, ...p2], () => 1, cfg);

    // If clustering ever ran flat across partitions, these 8 identical-bag
    // scopes would form ONE role of size 8. Per-partition isolation must
    // instead produce TWO roles, one per partition, each sized to its own
    // partition's 4 members only.
    expect(result.roles).toHaveLength(2);
    const byPartition = new Map(result.roles.map((r) => [r.partitionId, r]));
    expect(byPartition.get('p1')?.size).toBe(4);
    expect(byPartition.get('p2')?.size).toBe(4);
    expect(byPartition.get('p1')?.roleKey).not.toBe(byPartition.get('p2')?.roleKey);
  });

  it('MUTATION-RESISTANCE: the weighted-medoid tie-break (equal weighted-sum distance) is decided by ascending stable_id', async () => {
    // Two near-duplicate SINGLE scopes (weight 1 each, `name: 'a'` so
    // tokenizeName contributes NOTHING — every own feature comes from
    // `supertypes`, giving exact control over the bag): 19 supertypes
    // shared, 1 unique each ("U1"/"U2"). Independently verified (a small
    // standalone script mirroring `agglomerativeClusterCut` exactly, same
    // structure as this file's own direct clustering test above): this
    // near-duplicate pair merges FIRST (closest pair) and that merge
    // improves the running cut DL, so they end up in ONE surviving
    // 2-member cluster — `roles.minClusterSize` is lowered to 2 here
    // (default 3) purely so that weight-2 cluster survives to the medoid
    // selection step at all; every "outlier" bucket around it stays
    // weight-1, well under even the lowered floor, so only this ONE role
    // can ever form. Within that cluster, BOTH members have EQUAL weight
    // (1) and a SYMMETRIC pairwise distance, so the weighted-summed
    // distance is IDENTICAL whichever one is tried as medoid — a genuine
    // tie, broken by ascending `stable_id`. `dup1`'s stable_id
    // ('zzz-dup1') is deliberately LARGER than `dup2`'s ('aaa-dup2') even
    // though `dup1` is scanned FIRST (its bucket's signature sorts first,
    // "U1" < "U2"): if the tie-break's `tieId < bestTieId` clause were
    // deleted, the first-scanned `dup1` would incorrectly stay medoid
    // despite losing the tie.
    const shared = Array.from({ length: 19 }, (_, i) => `S${String(i).padStart(2, '0')}`);
    const dup1 = unit({ kind: 'method', relPath: 'src/dup1.ts', name: 'a', supertypes: [...shared, 'U1'], stableId: 'zzz-dup1' });
    const dup2 = unit({ kind: 'method', relPath: 'src/dup2.ts', name: 'a', supertypes: [...shared, 'U2'], stableId: 'aaa-dup2' });
    const outliers = Array.from({ length: 6 }, (_, k) =>
      unit({ kind: 'method', relPath: `src/outlier${k}.ts`, name: 'a', supertypes: [`O${k}a`, `O${k}b`], stableId: `outlier-${k}` }),
    );
    const cfg = await config('roles:\n    minClusterSize: 2\n');
    const result = induceRoles([dup1, dup2, ...outliers], () => 1, cfg);

    expect(result.roles).toHaveLength(1);
    const role = result.roles[0];
    expect(role.size).toBe(2); // exactly dup1 + dup2 -- no outlier ever clears even the lowered floor on its own
    expect(role.medoidFeatures).toContain('sup:U2'); // dup2 won the tie (smaller stable_id)
    expect(role.medoidFeatures).not.toContain('sup:U1'); // dup1 (scanned first, larger stable_id) did NOT win
  });

  it('§8.4 zero-membership rule: a scope with no feature overlap with any medoid gets no role, independent of the minOwnFeatures gate', async () => {
    // NOTE: this pins §8.4's "best membership 0 ⇒ no role" rule, NOT §8.1's
    // minOwnFeatures gate — 'run''s bag ({tok:run}) is DISJOINT from the guard
    // medoid ({tok:guard,sup:CanActivate}), so it would still classify to
    // roleIndex -1 even if the gate below were bypassed entirely (the gate's
    // own dedicated MUTATION-RESISTANCE test is below).
    const cfg = await config();
    const typed = typedGroup(3, 'tid', 'src/t', 'guard', ['CanActivate']);
    const untyped = unit({ kind: 'method', relPath: 'src/u1.ts', name: 'run', stableId: 'untyped-1' }); // tok:run only -> 1 own feature
    const result = induceRoles([...typed, untyped], () => 1, cfg);
    expect(result.assignments['src/u1.ts#method#run']).toBeUndefined();
  });

  it('MUTATION-RESISTANCE: the minOwnFeatures gate excludes low-signal scopes from clustering and assignments entirely — a bypassed gate would manufacture a spurious role', async () => {
    // 4 typed 'guard' scopes (bag {tok:guard,sup:CanActivate}, ownFeatureCount
    // 2, clears the gate) + 4 scopes carrying ONLY sup:CanActivate (name 'z',
    // length 1 -> tokenizeName drops it -> bag {sup:CanActivate},
    // ownFeatureCount 1, BELOW the floor) but with NON-ZERO jaccard against
    // the guard medoid (intersection {sup:CanActivate}=1, union=2 -> 0.5).
    // If the gate were bypassed (`if (false)` in place of the ownFeatureCount
    // check), these 4 scopes would form their OWN weight-4 bucket, and the
    // MDL cut keeps the two buckets split (hand-derived: initial 2-cluster DL
    // = 2(guard)+1(only-CanActivate) + 2*log2(2) = 5 < merging to 1 cluster,
    // DL = 9.5+1.5 + 1*log2(2) = 12) — surviving weight 4 >= minClusterSize
    // (3), manufacturing a SECOND, spurious role labeled bare "CanActivate"
    // from scopes that never should have reached clustering at all.
    const cfg = await config();
    const guards = typedGroup(4, 'gid', 'src/g', 'guard', ['CanActivate']);
    const untypedOnly = Array.from({ length: 4 }, (_, i) =>
      unit({ kind: 'method', relPath: `src/only${i + 1}.ts`, name: 'z', supertypes: ['CanActivate'], stableId: `only${String(i + 1).padStart(4, '0')}` }),
    );
    const result = induceRoles([...guards, ...untypedOnly], () => 1, cfg);

    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].label).toBe('guard+CanActivate');
    expect(result.roles.every((r) => r.label !== 'CanActivate')).toBe(true);
    for (let i = 1; i <= 4; i++) {
      expect(Object.prototype.hasOwnProperty.call(result.assignments, `src/only${i}.ts#method#z`)).toBe(false);
    }
  });

  it('assignments-map keys carry the #k occurrence ordinal (§6.4), and an ambiguous method gets the "-1" marker', async () => {
    const cfg = await config();
    const guardMembers = typedGroup(4, 'gid', 'src/g', 'guard', ['CanActivate']);
    const serviceMembers = typedGroup(4, 'sid', 'src/s', 'service', ['Injectable']);
    // A same-named-overload pair in one file: ordinal 0 (elided) and ordinal 1 (#1). The
    // ordinal-0 scope's bag EXACTLY matches the guard role's own medoid bag (tok:guard,
    // sup:CanActivate) -> m1=1, confident, non-ambiguous. The ordinal-1 scope is a
    // DIFFERENT (kind, name) pair from ordinal-0 in production (`#k` only applies within
    // one (kind,name) group, §6.4) — here it shares the SAME name "guard" with ordinal 0
    // (deliberately, to exercise the `#1` suffix) but carries a bag deliberately EQUIDISTANT
    // between both roles: {tok:x, sup:CanActivate, sup:Injectable} (own name "x" contributes
    // no overlap with either medoid; one supertype shared with each role).
    //   vs guard medoid {tok:guard,sup:CanActivate}:   intersection 1 (sup:CanActivate), union 4 -> jaccard 0.25
    //   vs service medoid {tok:service,sup:Injectable}: intersection 1 (sup:Injectable),  union 4 -> jaccard 0.25
    // m1 = m2 = 0.25: gap 0 < roleAmbiguityGap (0.15) AND m1 < roleMinMembership (0.35) -> ambiguous either way.
    const clean = unit({ kind: 'method', relPath: 'src/h.ts', name: 'guard', stableId: 'h-clean', supertypes: ['CanActivate'] });
    const ambiguousFinal = unit({
      kind: 'method',
      relPath: 'src/h.ts',
      name: 'x',
      ordinal: 1,
      qualifiedName: 'guard#1', // production would derive this from the (kind,name) occurrence index; set directly here since this test hand-supplies ScopeUnits
      stableId: 'h-ambiguous',
      supertypes: ['CanActivate', 'Injectable'],
    });

    const result = induceRoles([...guardMembers, ...serviceMembers, clean, ambiguousFinal], () => 1, cfg);

    expect(result.assignments['src/h.ts#method#guard']).toBeDefined();
    expect(result.assignments['src/h.ts#method#guard']).not.toBe('-1');
    // The #1 ordinal key must be distinct from the #0 key, per §6.4, and carry its own value.
    expect(Object.prototype.hasOwnProperty.call(result.assignments, 'src/h.ts#method#guard#1')).toBe(true);
    expect(result.assignments['src/h.ts#method#guard#1']).toBe('-1');
  });

  it('MUTATION-RESISTANCE: the kind filter admits only method/type scopes into clustering — file scopes never become role members', async () => {
    const cfg = await config();
    const guardMembers = typedGroup(4, 'gid', 'src/g', 'guard', ['CanActivate']);
    // 4 file-kind scopes, each in its OWN file with NO method/type sibling,
    // all named 'index.ts' -> tok:index + tok:ts, a rich, shared 2-feature
    // bag that clears BOTH the minOwnFeatures gate (2 >= 2) and
    // minClusterSize (bucket weight 4 >= 3) if the kind filter (`unit.kind
    // !== 'method' && unit.kind !== 'type'`) were ever bypassed (`if
    // (false)`) — proving this test isolates the KIND filter specifically,
    // not some other exclusion.
    const fileScopes = Array.from({ length: 4 }, (_, i) => unit({ kind: 'file', relPath: `src/idx${i + 1}.ts`, name: 'index.ts', stableId: `idxfile${i + 1}` }));
    const result = induceRoles([...guardMembers, ...fileScopes], () => 1, cfg);

    // Only the guard method-cluster role — no manufactured "index+ts" file-cluster role.
    expect(result.roles).toHaveLength(1);
    expect(result.roles.every((r) => r.label !== 'index+ts')).toBe(true);
    for (let i = 1; i <= 4; i++) {
      // No method/type siblings in their own file -> §8.9(b) plurality casts
      // no vote (no assignment); and — were the kind filter bypassed — no
      // DIRECT self-clustered assignment either (both must be absent).
      expect(Object.prototype.hasOwnProperty.call(result.assignments, `src/idx${i}.ts#file#index.ts`)).toBe(false);
    }
  });
});

/**
 * One (kind='method') scope in `relPath`, sharing the SAME §8.1 feature bag
 * as every other scope built with the same `name`/`supertypes` pair (all
 * `typedGroup`-produced units too) — bag IDENTITY across files is what lets
 * the pre-bucketing step (§8.3) combine them into one weighted cluster
 * regardless of which file each instance lives in, so a §8.9(b) fixture can
 * pad a role's TOTAL weight past `minClusterSize` from OTHER files without
 * disturbing which role a given FILE's own members vote for.
 */
function bagMember(relPath: string, name: string, supertypes: string[], ordinal: number, stableId: string): ScopeUnit {
  return unit({
    kind: 'method',
    relPath,
    name,
    ordinal,
    qualifiedName: ordinal > 0 ? `${name}#${ordinal}` : name,
    supertypes,
    stableId,
  });
}

describe('§8.3 weighted medoid selection (binding rule, MUTATION-RESISTANCE)', () => {
  it('an unequal-weight cluster: the weight-summed argmin differs from what an unweighted argmin would pick', async () => {
    // 3 bucket types share a 40-supertype spine (keeping all 3 close enough
    // to merge into ONE cluster) plus a 1-feature "extra" block E1 shared
    // ONLY by B and C (making B,C the naturally closer pair) and one unique
    // feature each (A1/B1/C1). Bucket weights are REAL scope counts: 5
    // A-type scopes, 3 B-type, 3 C-type. Independently verified (a script
    // mirroring this exact weighted-medoid formula, weightedSum(x) = sum
    // over the OTHER two candidates of their bucket weight times distance
    // to x):
    //   weightedSum(A) = 3·d(A,B) + 3·d(A,C) = 0.4186  <- weighted argmin (A wins)
    //   weightedSum(B) = 5·d(B,A) + 3·d(B,C) = 0.4884
    //   weightedSum(C) = 5·d(C,A) + 3·d(C,B) = 0.4884
    // An UNWEIGHTED sum (every candidate's distance counted at weight 1,
    // ignoring real bucket cardinality) gives the OPPOSITE answer:
    //   unweightedSum(A) = d(A,B) + d(A,C)  = 0.1395
    //   unweightedSum(B) = d(B,A) + d(B,C)  = 0.1163  <- unweighted argmin (B, tied with C)
    //   unweightedSum(C) = d(C,A) + d(C,B)  = 0.1163
    // B/C's own weighted sums are pulled UP by A's now-heavier weight (5 vs
    // 3), flipping the medoid winner from B (unweighted) to A (weighted).
    const cfg = await config();
    const spine = Array.from({ length: 40 }, (_, i) => `S${i}`);
    const aType = typedGroup(5, 'atype', 'src/a', 'a', [...spine, 'A1']);
    const bType = typedGroup(3, 'btype', 'src/b', 'a', [...spine, 'E1', 'B1']);
    const cType = typedGroup(3, 'ctype', 'src/c', 'a', [...spine, 'E1', 'C1']);
    const result = induceRoles([...aType, ...bType, ...cType], () => 1, cfg);

    expect(result.roles).toHaveLength(1); // all 3 bucket types merge into ONE cluster
    const medoidFeatures = result.roles[0].medoidFeatures;
    expect(medoidFeatures).toContain('sup:A1'); // the weighted medoid winner is the A-type representative
    expect(medoidFeatures).not.toContain('sup:B1');
    expect(medoidFeatures).not.toContain('sup:C1');
  });
});

describe('ambiguityRate — spec §8.5, a role with genuinely ambiguous (non-clone) members', () => {
  it('MUTATION-RESISTANCE: a role with 1 genuinely ambiguous member (runner-up within roleAmbiguityGap) out of 5 reports the exact non-zero rate', async () => {
    const cfg = await config();
    const guardMembers = typedGroup(4, 'gid', 'src/g', 'guard', ['CanActivate']);
    const serviceMembers = typedGroup(4, 'sid', 'src/s', 'service', ['Injectable']);
    // A 5th guard-partition member whose bag is DELIBERATELY equidistant
    // between the guard and service medoids -- {tok:x,sup:CanActivate,sup:Injectable}:
    // own name "x" contributes no overlap with either medoid; one supertype
    // shared with each role.
    //   vs guard medoid {tok:guard,sup:CanActivate}:    intersection 1, union 4 -> jaccard 0.25
    //   vs service medoid {tok:service,sup:Injectable}: intersection 1, union 4 -> jaccard 0.25
    // m1 = m2 = 0.25 (guard scanned first, wins the m1 slot) -> gap 0 < roleAmbiguityGap (0.15),
    // AND m1 < roleMinMembership (0.35) -- ambiguous by both rules, not a clone
    // (jaccard(guard medoid, service medoid) = 0, nowhere near cloneMedoidJaccard).
    const ambiguousMember = unit({ kind: 'method', relPath: 'src/amb.ts', name: 'x', stableId: 'amb-1', supertypes: ['CanActivate', 'Injectable'] });
    const result = induceRoles([...guardMembers, ambiguousMember, ...serviceMembers], () => 1, cfg);

    const guardRole = result.roles.find((r) => r.label === 'guard+CanActivate') as (typeof result.roles)[number];
    // 5 members total (4 confident + 1 ambiguous), 1 ambiguous -> rate = 1/5 = 0.2, hand-derived and exact.
    expect(guardRole.size).toBe(5);
    expect(guardRole.ambiguityRate).toBe(1 / 5);
    expect(guardRole.ambiguityRate).toBeCloseTo(0.2, 10);
  });
});

describe('§8.9(b) file-role plurality — derived fresh from the spec text', () => {
  it('a file scope role = the plurality (weighted) role of its method/type members', async () => {
    const cfg = await config();
    // File f.ts: 3 "guard"-bag members (own weight already clears minClusterSize=3
    // on its own) and 1 "service"-bag member (padded to weight 3 by 2 more
    // service-bag members in OTHER files, so the service role survives too).
    const guards = [
      bagMember('src/f.ts', 'guard', ['CanActivate'], 0, 'fg1'),
      bagMember('src/f.ts', 'guard', ['CanActivate'], 1, 'fg2'),
      bagMember('src/f.ts', 'guard', ['CanActivate'], 2, 'fg3'),
    ];
    const oneService = bagMember('src/f.ts', 'service', ['Injectable'], 0, 'fs1');
    const servicePad = [bagMember('src/pad-s1.ts', 'service', ['Injectable'], 0, 'xs1'), bagMember('src/pad-s2.ts', 'service', ['Injectable'], 0, 'xs2')];
    const fileScope = unit({ kind: 'file', relPath: 'src/f.ts', name: 'f.ts', stableId: 'ffile' });

    const units = [...guards, oneService, fileScope, ...servicePad];
    const result = induceRoles(units, () => 1, cfg);

    const guardRoleKey = result.assignments['src/f.ts#method#guard'];
    const serviceRoleKey = result.assignments['src/f.ts#method#service'];
    expect(guardRoleKey).toBeDefined();
    expect(serviceRoleKey).toBeDefined();
    expect(guardRoleKey).not.toBe(serviceRoleKey);

    // Plurality: 3 guard votes vs 1 service vote (equal w_base=1 each) -> guard wins.
    expect(result.assignments['src/f.ts#file#f.ts']).toBe(guardRoleKey);
  });

  it('no method/type members with a role ⇒ no role for the file scope (never "-1" — files are never ambiguous)', async () => {
    const cfg = await config();
    const fileScope = unit({ kind: 'file', relPath: 'src/empty.ts', name: 'empty.ts', stableId: 'efile' });
    const result = induceRoles([fileScope], () => 1, cfg);
    expect(result.assignments['src/empty.ts#file#empty.ts']).toBeUndefined();
  });

  it('a file with NO method/type members, in a partition where OTHER files DO have roled members, still gets no role', async () => {
    const cfg = await config();
    // Same partition as a real, surviving role (so `eligible.length > 0` and
    // `deriveFileRoleAssignments` actually runs) — but `src/lonely.ts`'s own
    // file scope has no method/type sibling at all, so `votesByFile` has no
    // entry for it (as opposed to the single-file-partition case above,
    // where `inducePartitionRoles` returns before this function ever runs).
    const guards = typedGroup(3, 'lg', 'src/l', 'guard', ['CanActivate']);
    const lonelyFile = unit({ kind: 'file', relPath: 'src/lonely.ts', name: 'lonely.ts', stableId: 'lonely-file' });
    const result = induceRoles([...guards, lonelyFile], () => 1, cfg);
    expect(result.assignments['src/lonely.ts#file#lonely.ts']).toBeUndefined();
  });

  it('MUTATION-RESISTANCE: a tied plurality is broken by ascending lexicographic role_key', async () => {
    const cfg = await config();
    // File t.ts: exactly 1 guard member and 1 service member (equal w_base=1 each -> tied tally).
    // Both roles padded to weight 3 total from OTHER files so both survive minClusterSize.
    const oneGuard = bagMember('src/t.ts', 'guard', ['CanActivate'], 0, 'tg1');
    const oneService = bagMember('src/t.ts', 'service', ['Injectable'], 0, 'ts1');
    const fileScope = unit({ kind: 'file', relPath: 'src/t.ts', name: 't.ts', stableId: 'tfile' });
    const guardPad = [bagMember('src/pad-tg1.ts', 'guard', ['CanActivate'], 0, 'ptg1'), bagMember('src/pad-tg2.ts', 'guard', ['CanActivate'], 0, 'ptg2')];
    const servicePad = [bagMember('src/pad-ts1.ts', 'service', ['Injectable'], 0, 'pts1'), bagMember('src/pad-ts2.ts', 'service', ['Injectable'], 0, 'pts2')];

    const units = [oneGuard, oneService, fileScope, ...guardPad, ...servicePad];
    const result = induceRoles(units, () => 1, cfg);

    const guardRoleKey = result.assignments['src/t.ts#method#guard'];
    const serviceRoleKey = result.assignments['src/t.ts#method#service'];
    expect(guardRoleKey).not.toBe(serviceRoleKey); // otherwise this fixture is not actually exercising a tie between two roles
    const expectedWinner = [guardRoleKey, serviceRoleKey].sort()[0];
    expect(result.assignments['src/t.ts#file#t.ts']).toBe(expectedWinner);
  });

  it('w_base weighting: a heavier-weighted single member outvotes a larger but lightly-weighted group', async () => {
    const cfg = await config();
    const guards3x = [
      bagMember('src/w.ts', 'guard', ['CanActivate'], 0, 'wg1'),
      bagMember('src/w.ts', 'guard', ['CanActivate'], 1, 'wg2'),
      bagMember('src/w.ts', 'guard', ['CanActivate'], 2, 'wg3'),
    ];
    const oneHeavyService = bagMember('src/w.ts', 'service', ['Injectable'], 0, 'ws1');
    const fileScope = unit({ kind: 'file', relPath: 'src/w.ts', name: 'w.ts', stableId: 'wfile' });
    const servicePad = [bagMember('src/pad-ws1.ts', 'service', ['Injectable'], 0, 'pws1'), bagMember('src/pad-ws2.ts', 'service', ['Injectable'], 0, 'pws2')];

    const units = [...guards3x, oneHeavyService, fileScope, ...servicePad];
    // Weight function: the service member gets weight 10 (heavier than 3 guards at weight 1 each = 3 total).
    const weightFn = (u: ScopeUnit) => (u.stableId === 'ws1' ? 10 : 1);
    const result = induceRoles(units, weightFn, cfg);

    const serviceRoleKey = result.assignments['src/w.ts#method#service'];
    expect(result.assignments['src/w.ts#file#w.ts']).toBe(serviceRoleKey);
  });
});

describe('§8.8 definingFeatureGroups — top-3-lift feature groups of the cluster (fresh implementation, hand-derived)', () => {
  it('a role whose members universally carry a supertype absent from the rest of the partition surfaces "supertype" as a defining group', async () => {
    const cfg = await config();
    // Role A ("guard"): every member carries sup:CanActivate — a feature NO
    // other partition member has at all. Role B ("service") shares nothing
    // with A. supertype should dominate name-tokens here since "guard"'s
    // own tok:guard is EQUALLY exclusive to the cluster (also 0 elsewhere),
    // so both groups actually score similarly — the real point of this test
    // is that 'supertype' is INCLUDED (score > 0, cluster-exclusive feature).
    const units = [...typedGroup(4, 'a', 'src/a', 'guard', ['CanActivate']), ...typedGroup(4, 'b', 'src/b', 'service', ['Injectable'])];
    const result = induceRoles(units, () => 1, cfg);
    const guardRole = result.roles.find((r) => r.label === 'guard+CanActivate');
    expect(guardRole?.definingFeatureGroups).toContain('supertype');
    expect(guardRole?.definingFeatureGroups).toContain('name-tokens');
    expect(guardRole?.definingFeatureGroups.length).toBeLessThanOrEqual(3);
  });

  it('a role whose members universally carry a decorator absent elsewhere surfaces "decorator" as a defining group', async () => {
    const cfg = await config();
    const units = [
      ...typedGroup(4, 'a', 'src/a', 'guard', ['CanActivate'], ['GuardMark']),
      ...typedGroup(4, 'b', 'src/b', 'service', ['Injectable']),
    ];
    const result = induceRoles(units, () => 1, cfg);
    const guardRole = result.roles.find((r) => r.label === 'guard+CanActivate+GuardMark');
    expect(guardRole?.definingFeatureGroups).toContain('decorator');
  });

  it('a role whose members universally carry a package import absent elsewhere surfaces "import-segments" as a defining group', async () => {
    const cfg = await config();
    // 4 "guard" members, each in its OWN file, but every one of those files
    // imports the SAME package specifier — imp:common only ever appears on
    // guard-role members repo-wide (service members import nothing).
    const guardUnits = Array.from({ length: 4 }, (_, i) =>
      unit({
        kind: 'method',
        relPath: `src/gi${i + 1}.ts`,
        name: 'guard',
        supertypes: ['CanActivate'],
        fileImports: ['@nestjs/common'],
        stableId: `impg${String(i + 1).padStart(4, '0')}`,
      }),
    );
    const serviceUnits = typedGroup(4, 'imps', 'src/is', 'service', ['Injectable']);
    const result = induceRoles([...guardUnits, ...serviceUnits], () => 1, cfg);
    const guardRole = result.roles.find((r) => r.label === 'guard+CanActivate');
    expect(guardRole?.definingFeatureGroups).toContain('import-segments');
  });
});

describe('induceRoles determinism — spec F5/F6, five internal sorts (MUTATION-RESISTANCE)', () => {
  /** A rich, multi-partition, multi-role population: two roles in partition
   * 'aaa' (guard, service — one with a file scope voting §8.9(b)), one role
   * in partition 'zzz' sorting AFTER 'aaa' alphabetically. Returned as a
   * function (not a module-level constant) so each call produces fresh
   * object identities — this test cares only about `units`' ARRAY ORDER
   * varying, not any shared mutable state between calls. */
  function buildUnits(): ScopeUnit[] {
    const guardMembers = typedGroup(4, 'gid', 'src/g', 'guard', ['CanActivate'], [], 'aaa');
    const serviceMembers = typedGroup(4, 'sid', 'src/s', 'service', ['Injectable'], [], 'aaa');
    const guardFileScope = unit({ kind: 'file', relPath: 'src/g1.ts', name: 'g1.ts', stableId: 'g1file', partitionId: 'aaa' });
    const workerMembers = typedGroup(4, 'wid', 'src/w', 'worker', ['Runnable'], [], 'zzz');
    return [...guardMembers, ...serviceMembers, guardFileScope, ...workerMembers];
  }

  it('MUTATION-RESISTANCE: induceRoles output is byte-identical across 3+ input orderings, including a REVERSE stable-id order', async () => {
    const cfg = await config();
    const original = buildUnits();
    const reversed = [...original].reverse();
    // A third, non-trivial shuffle: interleave the four groups round-robin
    // rather than either forward or reverse block order.
    const groups = [
      original.slice(0, 4), // guard
      original.slice(4, 8), // service
      [original[8]], // file scope
      original.slice(9, 13), // worker
    ];
    const interleaved: ScopeUnit[] = [];
    for (let i = 0; i < 4; i++) for (const g of groups) if (g[i]) interleaved.push(g[i]);

    const r1 = JSON.stringify(induceRoles(original, () => 1, cfg));
    const r2 = JSON.stringify(induceRoles(reversed, () => 1, cfg));
    const r3 = JSON.stringify(induceRoles(interleaved, () => 1, cfg));

    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
  });

  it('MUTATION-RESISTANCE: clusterSampleCap wiring — the same units produce a provably SMALLER sampled/surviving role set once the config value is lowered', async () => {
    // 6 mutually-disjoint bucket types, weight 3 each (clears minClusterSize
    // independently) -- SAME `units` fed to `induceRoles` twice, differing
    // ONLY in `roles.clusterSampleCap`. If `inducePartitionRoles` ever
    // stopped reading `rolesCfg.clusterSampleCap` (e.g. hardcoded the
    // default 700, or Infinity, at the `sampleRepresentatives(buckets,
    // rolesCfg.clusterSampleCap)` call site), the lowered config would have
    // NO observable effect and both runs would produce all 6 roles.
    const types = Array.from({ length: 6 }, (_, i) => typedGroup(3, `c${i}id`, `src/c${i}`, `capname${i}`, [`CapMarker${i}`]));
    const units = types.flat();
    const defaultCfg = await config();
    const loweredCfg = await config('roles:\n    clusterSampleCap: 3\n');

    const defaultRun = induceRoles(units, () => 1, defaultCfg);
    const loweredRun = induceRoles(units, () => 1, loweredCfg);

    expect(defaultRun.roles).toHaveLength(6); // default cap (700) admits every distinct bag
    expect(loweredRun.roles).toHaveLength(3); // config-driven cap actually reaches the sampling call
    expect(loweredRun.roles.length).toBeLessThan(defaultRun.roles.length);
  });

  it('MUTATION-RESISTANCE: which buckets survive a low clusterSampleCap is independent of `units`\' own input order', async () => {
    // 6 mutually-disjoint bucket TYPES (own supertype "MarkerN", weight 3
    // each -- clears minClusterSize on its own, so each type would survive
    // as its OWN role if sampled). `clusterSampleCap` lowered to 3 -- the
    // deterministic stride sample can only ever admit 3 of these 6 distinct
    // bags into clustering.
    const cfg = await config('roles:\n    clusterSampleCap: 3\n');
    const types = Array.from({ length: 6 }, (_, i) => typedGroup(3, `t${i}id`, `src/t${i}`, `name${i}`, [`Marker${i}`]));
    const original = types.flat();
    const reversed = [...types].reverse().flat();
    const interleaved: ScopeUnit[] = [];
    for (let i = 0; i < 3; i++) for (const t of types) interleaved.push(t[i]);

    const survivors = (units: ScopeUnit[]) =>
      induceRoles(units, () => 1, cfg)
        .roles.map((r) => r.label)
        .sort();

    const s1 = survivors(original);
    const s2 = survivors(reversed);
    const s3 = survivors(interleaved);

    expect(s1).toHaveLength(3); // the cap, not the full population of 6 types
    expect(s2).toEqual(s1);
    expect(s3).toEqual(s1);
  });

  it('MUTATION-RESISTANCE: bucket sampling order is the bags\' own SIGNATURE order, not their members\' stable_id order', async () => {
    // `eligible.sort()` already normalizes scan order to ascending stable_id
    // BEFORE bucketing runs, so `units`' own input order can never expose a
    // bucket-order bug on its own (the test above pins that fact) -- this
    // one instead DELIBERATELY INVERTS stable_id order relative to bag-
    // signature order, so the two candidate bucket orderings select a
    // COMPLETELY DIFFERENT 3-of-6 survivor set:
    //   SIGNATURE order (bag content "sup:MarkerN tok:nameN", N ascending 0..5,
    //   the canonical order §8.3's own bucket sort produces): stride
    //   (6/3=2, k=0,1,2 -> floor(0),floor(2),floor(4)) selects N = 0, 2, 4.
    //   STABLE_ID order (each type's stable_id prefix assigned in REVERSE --
    //   type N gets prefix `t${5-N}id`, so type 5 sorts FIRST, type 0 LAST --
    //   the order bucketing would fall back to if its own signature sort
    //   were removed, since Map insertion then just tracks stable_id-sorted
    //   `eligible` scan order): the SAME stride positions instead select
    //   type 5, type 3, type 1 (N = 5, 3, 1) -- the OPPOSITE parity.
    const cfg = await config('roles:\n    clusterSampleCap: 3\n');
    const types = Array.from({ length: 6 }, (_, i) => typedGroup(3, `t${5 - i}id`, `src/n${i}`, `name${i}`, [`Marker${i}`]));
    const result = induceRoles(types.flat(), () => 1, cfg);
    const survivingLabels = result.roles.map((r) => r.label).sort();

    expect(survivingLabels).toEqual(['name0+Marker0', 'name2+Marker2', 'name4+Marker4']);
  });

  it('MUTATION-RESISTANCE: result.roles is returned partitionId-asc, roleKey-asc regardless of which partition is visited first in `units`', async () => {
    const cfg = await config();
    // 'zzz' sorts AFTER 'aaa' -- feed 'zzz' units FIRST in the array so a
    // missing/deleted final `.sort(compareRoles)` (or a missing
    // `[...byPartition.keys()].sort()`) would surface as 'zzz' appearing
    // BEFORE 'aaa' in the returned roles array.
    const zzzFirst = [...buildUnits()].reverse();
    const result = induceRoles(zzzFirst, () => 1, cfg);

    expect(result.roles.length).toBeGreaterThanOrEqual(3);
    const partitionOrder = result.roles.map((r) => r.partitionId);
    const sortedOrder = [...partitionOrder].sort();
    expect(partitionOrder).toEqual(sortedOrder);
    expect(partitionOrder[0]).toBe('aaa');
    expect(partitionOrder[partitionOrder.length - 1]).toBe('zzz');

    // Partition 'aaa' carries TWO roles (guard, service) -- a same-partition
    // pair the CROSS-partition checks above cannot distinguish (both share
    // partitionId 'aaa', so any WITHIN-partition order looks "sorted" to
    // them trivially). guard's bucket signature ("sup:CanActivate...")
    // sorts BEFORE service's ("sup:Injectable...") alphabetically, so
    // guard's role is PUSHED first during formation -- but guard's roleKey
    // ('f381ca6423a6') is lexicographically LARGER than service's
    // ('ee337e8900e4'), so the correct roleKey-ascending order is
    // [service, guard], the OPPOSITE of push order. A missing final
    // `roles.sort(compareRoles)` would leave push order (guard, service)
    // standing instead.
    const aaaRoles = result.roles.filter((r) => r.partitionId === 'aaa');
    expect(aaaRoles.map((r) => r.label)).toEqual(['service+Injectable', 'guard+CanActivate']);
    expect(aaaRoles.map((r) => r.roleKey)).toEqual([...aaaRoles.map((r) => r.roleKey)].sort());
  });
});

describe('roleLift — spec §8.10, a pure function over hand-supplied counts', () => {
  // Surface "auto.deco:@Injectable" (boolean, K=2): role members ALL carry it (4/4);
  // partition-wide only 4 of 20 do.
  //   p_role(true)  = (4+0.5)/(4+1)   = 4.5/5   = 0.9
  //   p_partition(true) = (4+0.5)/(20+1) = 4.5/21  ≈ 0.214286
  //   data_term = 4 * log2(0.9 / 0.214286) = 4 * log2(4.2) ≈ 4 * 2.070389 ≈ 8.281556
  //   (false contributes 0 -- n_v(role,false)=0)
  // role_lift = data_term / n_eff(r) = 8.281556 / 4 ≈ 2.070389
  it('a genuinely discriminative held-out surface produces a positive lift, computed exactly', () => {
    const surfaces: RoleLiftSurfaceInput[] = [
      {
        surface: 'auto.deco:@Injectable',
        overlapGroup: 'decorator',
        isBoolean: true,
        alphabet: [],
        roleCounts: { true: 4 },
        partitionCounts: { true: 4, false: 16 },
      },
    ];
    const value = roleLift(surfaces, [], 4);
    const expected = (4 * Math.log2((4.5 / 5) / (4.5 / 21))) / 4;
    expect(value).toBeCloseTo(expected, 10);
    expect(value).toBeGreaterThan(0);
    expect(isDecorativeRole(value)).toBe(false);
  });

  it('MUTATION-RESISTANCE: the overlap-group exclusion removes a surface whose group is a defining feature group of the role', () => {
    const discriminative: RoleLiftSurfaceInput = {
      surface: 'auto.deco:@Injectable',
      overlapGroup: 'decorator',
      isBoolean: true,
      alphabet: [],
      roleCounts: { true: 4 },
      partitionCounts: { true: 4, false: 16 },
    };
    const withExclusion = roleLift([discriminative], ['decorator'], 4); // decorator IS a defining group -> excluded -> sum stays 0
    const withoutExclusion = roleLift([discriminative], [], 4); // no defining groups supplied -> included
    expect(withExclusion).toBe(0);
    expect(withoutExclusion).toBeGreaterThan(0);
    expect(withExclusion).not.toBe(withoutExclusion);
  });

  it('a categorical value the role carries but the partition NEVER observed at all (missing key, not zero-count) reads as n_x=0 for the partition posterior', () => {
    // roleCounts has value "c" (weight 3); partitionCounts has NO "c" key whatsoever (§9.3's
    // own-property-guarded KT read must treat this as n_x=0, not throw or read `undefined`).
    //   K = |{a,b,c}|+1 = 4; roleN=3, partN=10
    //   p_role(c) = (3+0.5)/(3+2) = 3.5/5 = 0.7
    //   p_partition(c) = (0+0.5)/(10+2) = 0.5/12
    //   term = 3 * log2(0.7 / (0.5/12)); role_lift = term / 3
    const surfaces: RoleLiftSurfaceInput[] = [
      {
        surface: 'auto.someCat',
        overlapGroup: undefined,
        isBoolean: false,
        alphabet: ['a', 'b', 'c'],
        roleCounts: { c: 3 },
        partitionCounts: { a: 5, b: 5 },
      },
    ];
    const value = roleLift(surfaces, [], 3);
    const term = 3 * Math.log2(0.7 / (0.5 / 12));
    expect(value).toBeCloseTo(term / 3, 10);
    expect(value).toBeGreaterThan(0);
  });

  it('a role that behaves identically to its partition baseline (same raw share, smaller n) is decorative (role_lift <= 0)', () => {
    // Role's own raw share matches the partition's exactly (2/4 = 8/16 = 0.5
    // for BOTH values 'a' and 'b') -- but role_lift is NOT exactly 0, because
    // §9.3's KT smoothing uses a DIFFERENT effective n on each side
    // (n_eff=4 role vs n_eff=16 partition; K = |{a,b}|+1 = 3 for this
    // categorical surface): the smaller role sample's posterior is pulled
    // further toward 1/K than the partition's, so an identical raw share
    // still yields a small NEGATIVE data_term. This is the honest, correct
    // behavior of a finite-sample KT estimator, not a fixture error --
    // exact value computed independently by the same formula below.
    //   p_role(a)  = (2+0.5)/(4+1.5)  = 2.5/5.5  = 5/11
    //   p_part(a)  = (8+0.5)/(16+1.5) = 8.5/17.5 = 17/35
    //   term(a) = 2 * log2((5/11)/(17/35)) = 2 * log2(175/187)
    //   term(b) is identical by symmetry (b: 2 role / 8 partition, same as a)
    //   role_lift = 2*term(a) / n_eff(r)=4 = term(a) / 2
    const surfaces: RoleLiftSurfaceInput[] = [
      {
        surface: 'auto.ret',
        overlapGroup: undefined,
        isBoolean: false,
        alphabet: ['a', 'b'],
        roleCounts: { a: 2, b: 2 },
        partitionCounts: { a: 8, b: 8 },
      },
    ];
    const value = roleLift(surfaces, [], 4);
    const termA = 2 * Math.log2((5 / 11) / (17 / 35));
    const expected = (2 * termA) / 4;
    expect(value).toBeCloseTo(expected, 10);
    expect(value).toBeLessThan(0); // the finite-sample KT pull, not exactly 0
    expect(isDecorativeRole(value)).toBe(true);
  });

  it('a role that INVERTS the partition default on a held-out surface still produces a positive lift — the metric rewards any strong local regularity, aligned or not', () => {
    // Role members are ALL "false" where the partition is 90% "true" -- role disagrees with itself vs the wider population, a bad local model.
    const surfaces: RoleLiftSurfaceInput[] = [
      {
        surface: 'auto.has:x',
        overlapGroup: undefined,
        isBoolean: true,
        alphabet: [],
        roleCounts: { false: 4 },
        partitionCounts: { true: 18, false: 2 },
      },
    ];
    const value = roleLift(surfaces, [], 4);
    // p_role(false) = 4.5/5 = 0.9; p_partition(false) = 2.5/21 ≈ 0.119048 -> log2(0.9/0.119048) is POSITIVE (false is now the role's own strong signal vs the rare partition value)...
    // this deliberately demonstrates the metric rewards ANY strong local regularity, aligned or not with the partition's own default — a role_lift of 0 or below needs the role to
    // carry NO discriminative signal at all (the next case), not merely a "wrong-direction" one.
    expect(value).toBeGreaterThan(0);
  });

  it('nEff <= 0 returns 0 (no instances to normalize by, never Infinity/NaN)', () => {
    expect(roleLift([{ surface: 'x', isBoolean: true, alphabet: [], roleCounts: { true: 1 }, partitionCounts: { true: 1 } }], [], 0)).toBe(0);
    expect(roleLift([], [], -1)).toBe(0);
  });

  it('isDecorativeRole is the single <=0 test', () => {
    expect(isDecorativeRole(0)).toBe(true);
    expect(isDecorativeRole(-0.001)).toBe(true);
    expect(isDecorativeRole(0.001)).toBe(false);
  });
});
