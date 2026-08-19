import { describe, it, expect } from 'vitest';
import { scoreCandidate, indexCostBits, isFireable, surfaceClassOf } from '../../../src/roots/mine-stages.js';
import { mine, type MineInput, type AgeFn } from '../../../src/roots/mine.js';
import type { ScopeUnit } from '../../../src/roots/extract.js';
import type { FeatureBag, DomainMap } from '../../../src/roots/enumerate.js';
import type { PartitionMap } from '../../../src/roots/partitions.js';
import type { RoleAssignment, RoleInfo } from '../../../src/roots/roles.js';
import type { SeedEntry, RootsConfig } from '../../../src/model/graph.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/mine.test.ts — spec §9's MDL acceptance chain:
//   - the low-level Appendix E worked scenarios (E.2 fire-ability, E.3 role
//     acceptance S1-S5, E.4 index-cost), pinned against `scoreCandidate`/
//     `indexCostBits`/`isFireable` directly with UNWEIGHTED (weight=1) counts
//     — the appendix's own numbers are computed that way (E.1's "K-invariance"
//     abstraction has no lifecycle-weight scaling), so this is the exact
//     comparison, not an approximation. Appendix E's own generator script
//     (`tests/fixtures/derive-e.ts`) does not exist in this tree — the
//     appendix's STATED numbers are the source; each expected value's
//     derivation is restated in that test's own comment.
//   - full `mine()` structural/behavioral tests over small, hand-built
//     `MineInput` fixtures (real parsing/300-scope partitioning is Task 7's
//     goldens' concern, not this file's): the ACCEPTANCE-vs-ELIGIBILITY
//     split, the fail-closed default and its AgeFn flip, the §7.3 tautology
//     skip's placement (before `C`), decorative-role demotion, the vacuous
//     filter, §9.4e dedup, §9.4h's factCap, config threading, and Appendix-D
//     shape conformance (counts as canonical decimal strings, `roles[]`
//     carrying no `partitionId`, `stabilityDays` absent from every fact).
// ---------------------------------------------------------------------------

describe('scoreCandidate / indexCostBits / isFireable — Appendix E worked constants', () => {
  it('E.3 S1 flagship: role 30 (all true) in a 600-scope partition (role+30 true elsewhere, 540 false) — bits_saved 82.2, n_r=30 accepts', () => {
    // p̂_all(true) = (60+.5)/(600+1) = 0.10067 ✓ matches "p̂_all=0.1007"
    // p̂_r(true)   = (30+.5)/(30+1)  = 0.98387 ✓ matches "p̂_r=0.9839"
    // data = 30·log2(0.98387/0.10067) = 30·3.289 = 98.7 ✓
    // param = 0.5·log2(30) = 2.4535 ≈ 2.45 ✓
    // idxCost = log2(2^14) = 14.0
    // bits_saved = 98.7 - 2.45 - 14 = 82.2 ✓
    const role = new Map([['true', 30]]);
    const baseline = new Map([
      ['true', 60],
      ['false', 540],
    ]);
    const scored = scoreCandidate(role, ['true', 'false'], 2, false, baseline, 600, 14);
    expect(scored.dataTerm).toBeCloseTo(98.7, 1);
    expect(scored.paramCost).toBeCloseTo(2.45, 2);
    expect(scored.bitsSaved).toBeCloseTo(82.2, 1);
    expect(scored.expected).toBe('true');
  });

  it('E.3 S2 `_all` coin flip: 50/50 at any n — data_term is exactly 0, rejected (B=max(|V|,2) baseline, not uniform-with-escape)', () => {
    const counts = new Map([
      ['true', 50],
      ['false', 50],
    ]);
    const scored = scoreCandidate(counts, ['true', 'false'], 2, true, null, 0, 14);
    expect(scored.dataTerm).toBeCloseTo(0, 10);
    expect(scored.bitsSaved).toBeLessThan(4); // margin never cleared
  });

  it('E.3 S3 `_all` clean boolean (all-true): accepts at exactly n_eff=21 (+0.11), rejects at n_eff=20 (-0.86)', () => {
    // n=21: p̂(true)=(21+.5)/22=0.97727; data=21·log2(1.95455)=20.297; param=0.5·log2(21)=2.196
    //       bits_saved = 20.297-2.196-14 = 4.101 → +0.10 over margin 4 ✓ (appendix: "+0.11")
    const at21 = scoreCandidate(new Map([['true', 21]]), ['true', 'false'], 2, true, null, 0, 14);
    expect(at21.bitsSaved).toBeGreaterThan(4);
    expect(at21.bitsSaved).toBeCloseTo(4.1, 1);
    // n=20: p̂(true)=(20+.5)/21=0.97619; data=20·log2(1.95238)=19.298; param=0.5·log2(20)=2.161
    //       bits_saved = 19.298-2.161-14 = 3.137 → -0.86 under margin 4 ✓ (appendix: "-0.86")
    const at20 = scoreCandidate(new Map([['true', 20]]), ['true', 'false'], 2, true, null, 0, 14);
    expect(at20.bitsSaved).toBeLessThan(4);
    expect(at20.bitsSaved).toBeCloseTo(3.14, 1);
  });

  it('E.3 S4 zero-contrast big role: role 500 (all true) inside a 505-true partition — data ≈ -0.01, rejected (partition-posterior baseline removes the leave-role-out pathology)', () => {
    const role = new Map([['true', 500]]);
    const baseline = new Map([['true', 505]]);
    const scored = scoreCandidate(role, ['true', 'false'], 2, false, baseline, 505, 14);
    expect(scored.dataTerm).toBeCloseTo(-0.01, 1);
    expect(scored.bitsSaved).toBeLessThan(0);
  });

  it('E.3 S5 chaotic role: 18/12 split inside a 50/50 partition — data ≈ 0.87, far below costs, rejected (correct silence on 60/40)', () => {
    // A symmetric baseline (n true = n false) always gives KT posterior
    // exactly 0.5 regardless of n: (n+.5)/(2n+1) = 0.5.
    const role = new Map([
      ['true', 18],
      ['false', 12],
    ]);
    const baseline = new Map([
      ['true', 250],
      ['false', 250],
    ]);
    const scored = scoreCandidate(role, ['true', 'false'], 2, false, baseline, 500, 14);
    expect(scored.dataTerm).toBeCloseTo(0.87, 1);
    expect(scored.bitsSaved).toBeLessThan(0); // 0.87 ≪ param_cost + idxCost
  });

  it('E.4: index_cost = log2(C2) — C rounds up to the next power of two, C=2^14 gives exactly 14.0 bits', () => {
    expect(indexCostBits(16384)).toBe(14);
    expect(indexCostBits(16000)).toBe(14); // rounds UP to 2^14, not down
    expect(indexCostBits(16385)).toBe(15); // crosses into the next power of two
    expect(indexCostBits(0)).toBe(1); // floored at C=2 — a candidate space of 0/1 never asks for a non-positive index
  });

  it('E.2 fire-ability: the 94.8%-share structural-absence case the spec names is correctly rejected at tau=4.5 (2^4.5 ≈ 22.627), while a comfortable presence share (tau=2.5) and a comfortable vocabulary-absence share (tau=3.5) both fire', () => {
    // The spec's own named regression: "a ... directory fact at 94.8% share
    // ... entered the verdict path" at the OLD 3.5 threshold; at 4.5 it is
    // correctly rejected. Scaled to a 100-instance cell: expected=94.8, runner-up=5.2.
    expect(isFireable(94.8, 5.2, 4.5)).toBe(false); // (95.3)/(5.7) = 16.72 < 22.627
    expect(isFireable(98, 2, 4.5)).toBe(true); // (98.5)/(2.5) = 39.4 >= 22.627 — a genuine structural absence still speaks
    expect(isFireable(95, 5, 3.5)).toBe(true); // (95.5)/(5.5) = 17.36 >= 11.314 (2^3.5) — vocabulary absence fires comfortably
    expect(isFireable(85, 15, 3.5)).toBe(false); // (85.5)/(15.5) = 5.52 < 11.314
    expect(isFireable(90, 10, 2.5)).toBe(true); // (90.5)/(10.5) = 8.62 >= 5.657 (2^2.5) — ordinary presence fires
    expect(isFireable(80, 20, 2.5)).toBe(false); // (80.5)/(20.5) = 3.93 < 5.657
    // The n=30 boundary the appendix names ("the gate demands share ≈ 0.861"
    // at n=30, vs the n→∞ asymptote 0.8498): a share just above and just
    // below that finite-n boundary cross in the expected direction.
    expect(isFireable(26, 4, 2.5)).toBe(true); // share 26/30 = 0.867
    expect(isFireable(25, 5, 2.5)).toBe(false); // share 25/30 = 0.833
  });
});

// ---------------------------------------------------------------------------
// Full mine() over small, hand-built fixtures.
// ---------------------------------------------------------------------------

/** A minimal, fully-shaped ScopeUnit (mirrors `roles.test.ts`'s own `unit()`). */
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

function bag(u: ScopeUnit, surfaces: Record<string, string>): FeatureBag {
  return { stableId: u.stableId, skeyR: u.skeyR, kind: u.kind, relPath: u.relPath, surfaces };
}

/** Every listed unit is in-domain for every listed surface — sufficient for these hand-built, single-cell fixtures. */
function domainsFor(surfaceIds: string[], stableIds: string[]): DomainMap {
  const m: DomainMap = new Map();
  for (const s of surfaceIds) m.set(s, new Set(stableIds));
  return m;
}

/** One always-surviving partition covering every relPath given. */
function trivialPartitions(relPaths: string[], partitionId = 'p1'): PartitionMap {
  const partitionOfFile = new Map(relPaths.map((p) => [p, partitionId]));
  const moduleRootDirOfFile = new Map(relPaths.map((p) => [p, '']));
  return {
    partitionOfFile,
    moduleRootDirOfFile,
    packageRoots: [],
    survivingPartitionIds: [partitionId],
    statusOfKey: new Map([[partitionId, 'own-floor']]),
    silent: false,
  };
}

function emptyRoles(): RoleAssignment {
  return { roles: [], assignments: {}, ambiguousRank1: {} };
}

/** `n` method-kind units in partition `p1`, all sharing one bool surface: `trueCount` true, the rest false. */
function boolFixture(surface: string, trueCount: number, falseCount: number): { units: ScopeUnit[]; bags: FeatureBag[]; domains: DomainMap; partitions: PartitionMap } {
  const units: ScopeUnit[] = [];
  const bags: FeatureBag[] = [];
  for (let i = 0; i < trueCount + falseCount; i++) {
    const u = unit({ kind: 'method', relPath: `src/f${i}.ts`, name: `m${i}`, stableId: `s${i}` });
    units.push(u);
    bags.push(bag(u, i < trueCount ? { [surface]: 'true' } : {}));
  }
  const domains = domainsFor([surface], units.map((u) => u.stableId));
  const partitions = trivialPartitions(units.map((u) => u.relPath));
  return { units, bags, domains, partitions };
}

async function lenientConfig(overrides: { acceptMarginBits?: number; factCap?: number } = {}): Promise<RootsConfig> {
  const acceptMarginBits = overrides.acceptMarginBits ?? 0.5;
  const factCap = overrides.factCap ?? 400;
  return defaultRootsConfig(
    `mdl:\n    acceptMarginBits: ${acceptMarginBits}\n    minInstancesRaw: 1\n    minInstancesEff: 0.1\n    factCap: ${factCap}\n    dedupJaccard: 0.9\n    dirContextMinScopes: 25\n`,
  );
}

const constantWeight: MineInput['weightFn'] = () => 0.3;

describe('mine() — acceptance vs. hook eligibility are SEPARATE stages (§9.4a vs §9.4c)', () => {
  it('a fact that clears bits_saved/n_raw/n_eff but fails fire-ability (gate 3) stays ACCEPTED — hookEligible is false, the fact is not dropped', async () => {
    const config = await lenientConfig();
    // 20 true / 80 false, n=100: an ABSENCE fact (expected='false', majority
    // 80/100), tau raised to 3.5 (vocabulary absence, 2^3.5 ≈ 11.314).
    // Weighted (weight 0.3): n_eff=30, p̂(false)=(24+.5)/31=0.790,
    // p̂(true)=(6+.5)/31=0.210 → data=24·log2(1.58)+6·log2(0.419)=15.84-7.53=8.31;
    // param=0.5·log2(30)=2.454; C=1 (only surface/cell pair) ⇒ idxCost=1;
    // bits_saved=8.31-2.454-1=4.86, well clear of this fixture's 0.5 margin.
    // Fire-ability: (24.5)/(6.5)=3.77 < 11.314 (2^3.5) — NOT fireable.
    const { units, bags, domains, partitions } = boolFixture('auto.call:foo', 20, 80);
    // A synthetic AgeFn makes every instance survived, so gate 4 (survived
    // share) passes cleanly — isolating gate 3 as the ONLY failing gate.
    const ageFn: AgeFn = () => 9999;
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config, weightFn: constantWeight, ageFn });
    const fact = result.body.partitions[0].facts.find((f) => f.surface === 'auto.call:foo');
    expect(fact).toBeDefined();
    expect(fact?.expected).toBe('false');
    expect(fact?.absence).toBe(true);
    expect(fact?.hookEligible).toBe(false); // fire-ability gate alone fails
  });
});

describe('mine() — fail-closed survived-raw (§9.4c, AGENTS.md global constraint) and its AgeFn flip', () => {
  it('WITHOUT an AgeFn, every gated fact is hookEligible=false but stays ACCEPTED', async () => {
    const config = await lenientConfig();
    // Comfortable, easily-fireable presence signal (19 true / 1 false),
    // isolating the fail-closed default as the only reason gate 4 fails.
    const { units, bags, domains, partitions } = boolFixture('auto.call:bar', 19, 1);
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config, weightFn: constantWeight }); // no ageFn
    const fact = result.body.partitions[0].facts.find((f) => f.surface === 'auto.call:bar');
    expect(fact).toBeDefined();
    expect(fact?.hookEligible).toBe(false); // fail-closed: zero survived instances without history
    expect(fact?.nTotalRaw).toBe(0);
  });

  it('a synthetic AgeFn flips the SAME fact hookEligible false -> true; acceptance (expected/bitsSaved) is unchanged — an AgeFn only feeds gate 4, never bits_saved or the instance counts', async () => {
    const config = await lenientConfig();
    const { units, bags, domains, partitions } = boolFixture('auto.call:bar', 19, 1);
    const without = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config, weightFn: constantWeight });
    const withAge = mine({
      units,
      bags,
      domains,
      vocab: new Map(),
      partitions,
      roles: emptyRoles(),
      seeds: [],
      config,
      weightFn: constantWeight,
      ageFn: () => 9999,
    });
    const factWithout = without.body.partitions[0].facts.find((f) => f.surface === 'auto.call:bar');
    const factWithAge = withAge.body.partitions[0].facts.find((f) => f.surface === 'auto.call:bar');
    expect(factWithout?.hookEligible).toBe(false);
    expect(factWithAge?.hookEligible).toBe(true);
    expect(factWithAge?.expected).toBe(factWithout?.expected);
    expect(factWithAge?.bitsSaved).toBeCloseTo(factWithout?.bitsSaved as number, 10);
    expect(factWithAge?.share).toBeCloseTo(factWithout?.share as number, 10);
  });
});

describe('mine() — the §7.3 tautology skip is a per-(role,surface) skip', () => {
  it('a role-conditioned candidate whose overlap group is among the role\'s definingFeatureGroups is skipped entirely (never a fact) — a sibling role without that defining group still gets the SAME surface as a real candidate. (The exact repo-wide C/candidateCountLog2 arithmetic — tautological candidates genuinely excluded, minInstancesRaw genuinely applied — is hand-counted in tests/unit/roots/mine-invariants.test.ts; this test only pins fact presence/absence, not a C value.)', async () => {
    const config = await lenientConfig();
    // Two 20-member roles, both extending `Base` for every member, PLUS 360
    // unassigned type scopes that never do — diluting the `_all` baseline so
    // a role's "all true" is a real, non-vacuous contrast (bits_saved > 0),
    // not the zero-contrast S4 case. Role A DEFINES 'supertype' as one of its
    // clustering groups (tautological — its own clustering already used
    // supertype membership, so "extends Base" restates its own identity, not
    // a discovered convention); role B does not.
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    // Role A ALSO gets a second, non-excluded behavior surface
    // (`auto.call:onlyA`) so its role_lift stays POSITIVE (not demoted) —
    // without this, `auto.extends:Base` would be role A's ONLY behavior-class
    // surface, `roleLift`'s own overlap-group exclusion (§8.10, independent
    // of this file's own skip) would zero out its held-out set, and
    // role_lift's resulting 0 would demote role A regardless of whether the
    // tautology skip under test is active — confounding the two mechanisms.
    // `onlyA` is true for only 15 of the 20 members (not all 20, unlike
    // `extends:Base`) so the two surfaces' CONFORM SETS differ enough
    // (Jaccard 15/20 = 0.75 < the 0.9 dedup threshold) that §9.4e's dedup
    // never folds them into one fact — a second confound this fixture must
    // also avoid, since dedup runs regardless of the tautology skip.
    for (let i = 0; i < 20; i++) {
      const u = unit({ kind: 'type', relPath: `src/a${i}.ts`, name: `A${i}`, stableId: `a${i}` });
      units.push(u);
      const surfaces: Record<string, string> = { 'auto.extends:Base': 'true' };
      if (i < 15) surfaces['auto.call:onlyA'] = 'true';
      bags.push(bag(u, surfaces));
    }
    for (let i = 0; i < 20; i++) {
      const u = unit({ kind: 'type', relPath: `src/b${i}.ts`, name: `B${i}`, stableId: `b${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.extends:Base': 'true' }));
    }
    for (let i = 0; i < 360; i++) {
      const u = unit({ kind: 'type', relPath: `src/x${i}.ts`, name: `X${i}`, stableId: `x${i}` });
      units.push(u);
      bags.push(bag(u, {})); // never extends Base, never calls onlyA
    }
    const domains = domainsFor(['auto.extends:Base', 'auto.call:onlyA'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const roleA: RoleInfo = { partitionId: 'p1', roleKey: 'roleA', label: 'a', size: 20, medoidFeatures: [], definingFeatureGroups: ['supertype'], ambiguityRate: 0 };
    const roleB: RoleInfo = { partitionId: 'p1', roleKey: 'roleB', label: 'b', size: 20, medoidFeatures: [], definingFeatureGroups: ['decorator'], ambiguityRate: 0 };
    const assignments: Record<string, string> = {};
    for (const u of units.slice(0, 20)) assignments[u.skeyR] = 'roleA';
    for (const u of units.slice(20, 40)) assignments[u.skeyR] = 'roleB';
    const roles: RoleAssignment = { roles: [roleA, roleB], assignments, ambiguousRank1: {} };

    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles, seeds: [], config, weightFn: constantWeight });
    const facts = result.body.partitions[0].facts;
    expect(facts.some((f) => f.roleKey === 'roleA' && f.surface === 'auto.extends:Base')).toBe(false); // tautological — skipped
    expect(facts.some((f) => f.roleKey === 'roleB' && f.surface === 'auto.extends:Base')).toBe(true); // real candidate for role B
  });
});

describe('mine() — decorative-role demotion (§8.10: role_lift <= 0 ⇒ no role cells, no shadows)', () => {
  it('a role whose ONLY behavior-class surface exactly matches the partition baseline (role_lift == 0) contributes NO role-conditioned facts', async () => {
    const config = await lenientConfig();
    // 30 role members, split 15/15 on a behavior surface — identical to the
    // partition-wide _all split (also 15/15 within this same population,
    // since every unit here IS a role member) ⇒ p̂_r == p̂_all ⇒ data_term ≈ 0
    // ⇒ role_lift ≈ 0 ⇒ decorative.
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 30; i++) {
      const u = unit({ kind: 'method', relPath: `src/m${i}.ts`, name: `m${i}`, stableId: `m${i}` });
      units.push(u);
      bags.push(bag(u, i < 15 ? { 'auto.call:x': 'true' } : {}));
    }
    const domains = domainsFor(['auto.call:x'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const role: RoleInfo = { partitionId: 'p1', roleKey: 'r1', label: 'r', size: 30, medoidFeatures: [], definingFeatureGroups: [], ambiguityRate: 0 };
    const assignments: Record<string, string> = {};
    for (const u of units) assignments[u.skeyR] = 'r1';
    const roles: RoleAssignment = { roles: [role], assignments, ambiguousRank1: {} };

    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles, seeds: [], config, weightFn: constantWeight });
    const partition = result.body.partitions[0];
    expect(partition.facts.some((f) => f.roleKey === 'r1')).toBe(false); // demoted — no role-conditioned facts
    expect(partition.roles[0].roleLift).toBeLessThanOrEqual(0); // the computed value is still RECORDED on roles[]
  });
});

describe('mine() — the §9.4d vacuous filter (a real removal, unlike an eligibility flag)', () => {
  it('an in-domain-everywhere, never-true boolean surface genuinely REACHES scoring (a real candidate — domain-based, not observed-true-based) and is THEN rejected by the vacuous filter itself, not merely absent from the candidate universe', async () => {
    const config = await lenientConfig();
    // `boolFixture`'s `domainsFor` puts every unit in-domain for this surface
    // regardless of trueCount=0 — so the domain-based candidate universe
    // (this file's own fix: a boolean surface is a candidate for a kind
    // whenever its DOMAIN intersects that kind's members, never gated on any
    // bag actually carrying the key true) admits it as a real `_all:method`
    // candidate here, and it is THEN correctly rejected by §9.4d itself
    // (trueRaw across the whole partition is 0). Before that fix this same
    // assertion passed for the WRONG reason: the surface, never true
    // anywhere, was never even a bag key, so it never reached
    // `candidateSurfacesByKind` at all — the vacuous filter itself was dead
    // code for it.
    const { units, bags, domains, partitions } = boolFixture('auto.call:never', 0, 30); // never true, anywhere
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config, weightFn: constantWeight });
    expect(result.body.partitions[0].facts.some((f) => f.surface === 'auto.call:never')).toBe(false);
  });
});

describe('mine() — §9.4e correlation dedup (within the same cell only)', () => {
  it('two accepted surfaces in the SAME cell sharing an identical conform set collapse into one FACT (the lead) with nSurfaces=2', async () => {
    const config = await lenientConfig();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 30; i++) {
      const u = unit({ kind: 'method', relPath: `src/m${i}.ts`, name: `m${i}`, stableId: `m${i}` });
      units.push(u);
      // Surfaces A and B are TRUE for the exact same 27 scopes — identical conform sets.
      const surfaces: Record<string, string> = {};
      if (i < 27) {
        surfaces['auto.call:alpha'] = 'true';
        surfaces['auto.call:beta'] = 'true';
      }
      bags.push(bag(u, surfaces));
    }
    const domains = domainsFor(['auto.call:alpha', 'auto.call:beta'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config, weightFn: constantWeight });
    const facts = result.body.partitions[0].facts.filter((f) => f.surface === 'auto.call:alpha' || f.surface === 'auto.call:beta');
    expect(facts).toHaveLength(1); // one lead FACT — the other folded in
    expect(facts[0].nSurfaces).toBe(2);
  });
});

describe('mine() — §9.4h factCap culls to the top-N by bits-per-instance, per partition', () => {
  it('config.mdl.factCap trims an oversized accepted set', async () => {
    const config = await lenientConfig({ factCap: 3 });
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    const surfaces = ['auto.call:a', 'auto.call:b', 'auto.call:c', 'auto.call:d', 'auto.call:e'];
    for (let i = 0; i < 30; i++) {
      const u = unit({ kind: 'method', relPath: `src/m${i}.ts`, name: `m${i}`, stableId: `m${i}` });
      units.push(u);
      const s: Record<string, string> = {};
      // Each surface true for a DIFFERENT count (25..29) of scopes, so the
      // five candidates never share a conform set (no dedup collapsing) and
      // rank distinctly by bits-per-instance.
      for (let k = 0; k < surfaces.length; k++) if (i < 25 + k) s[surfaces[k]] = 'true';
      bags.push(bag(u, s));
    }
    const domains = domainsFor(surfaces, units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config, weightFn: constantWeight });
    expect(result.body.partitions[0].facts.length).toBeLessThanOrEqual(3);
  });
});

describe('mine() — CONFIG THREADING: every stage-consumed §4.5 key arrives via config, not a hardcoded constant', () => {
  it('changing mdl.acceptMarginBits changes the accepted set', async () => {
    const { units, bags, domains, partitions } = boolFixture('auto.call:threaded', 90, 10);
    const loose = await lenientConfig(); // acceptMarginBits: 0.5
    const strict = await lenientConfig({ acceptMarginBits: 400 }); // unreachable margin
    const looseResult = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: loose, weightFn: constantWeight });
    const strictResult = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: strict, weightFn: constantWeight });
    expect(looseResult.body.partitions[0].facts.some((f) => f.surface === 'auto.call:threaded')).toBe(true);
    expect(strictResult.body.partitions[0].facts.some((f) => f.surface === 'auto.call:threaded')).toBe(false);
  });
});

describe('mine() — seeds cap at seedCapFraction × n_eff_real (§9.2): an empty/thin cell stays thin, seeds cannot conjure a fact alone', () => {
  it('a seed on a scope whose surface has NO real instances in the cell contributes nothing (0.5 × 0 = 0)', async () => {
    const config = await lenientConfig();
    const u = unit({ kind: 'method', relPath: 'src/only.ts', name: 'only', stableId: 'only1' });
    const bags = [bag(u, {})]; // the surface never appears for real
    const domains = domainsFor(['auto.call:seeded'], ['only1']);
    const partitions = trivialPartitions(['src/only.ts']);
    const seeds: SeedEntry[] = [
      { seedId: 'sd1', scopeRef: { path: 'src/only.ts', qualifiedName: 'only' }, surfaces: ['auto.call:seeded'], weight: 8, arch: false, author: 'a', createdAt: '2020-01-01' },
    ];
    const result = mine({ units: [u], bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds, config, weightFn: constantWeight });
    // The seed's surface never appears on its own scope's bag (`value === undefined`), so it never even reaches the cap arithmetic — nothing to score.
    expect(result.body.partitions[0].facts.some((f) => f.surface === 'auto.call:seeded')).toBe(false);
  });
});

describe('mine() — Appendix-D shape conformance', () => {
  it('counts are canonical DECIMAL STRINGS, roles[] carries no partitionId, and stabilityDays/calib/trend/cohorts/exemplars are absent from every fact', async () => {
    const config = await lenientConfig();
    const { units, bags, domains, partitions } = boolFixture('auto.call:shape', 90, 10);
    const role: RoleInfo = { partitionId: 'p1', roleKey: 'rShape', label: 'shape', size: 0, medoidFeatures: [], definingFeatureGroups: [], ambiguityRate: 0 };
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: { roles: [role], assignments: {}, ambiguousRank1: {} }, seeds: [], config, weightFn: constantWeight });
    const partition = result.body.partitions[0];
    const fact = partition.facts.find((f) => f.surface === 'auto.call:shape');
    expect(fact).toBeDefined();
    for (const v of Object.values(fact?.counts as Record<string, string>)) expect(typeof v).toBe('string');
    expect('stabilityDays' in (fact as object)).toBe(false);
    expect('calib' in (fact as object)).toBe(false);
    expect('trend' in (fact as object)).toBe(false);
    expect('cohorts' in (fact as object)).toBe(false);
    expect('exemplars' in (fact as object)).toBe(false);
    expect(fact?.hookShapedConform).toBe(0);
    expect(fact?.denyEligible).toBe(false);
    expect(fact?.suppressedValue).toBeNull();
    expect(partition.coverageRole).toBe(0);
    expect(partition.coverageAll).toBe(0);
    expect(partition.debtBits).toBe(0);
    expect(partition.debtPerInstance).toBe(0);
    expect('partitionId' in partition.roles[0]).toBe(false);
  });
});

describe('surfaceClassOf — the §7.3 identity/behavior class map', () => {
  it('E1, E2, E7, E12 are identity; everything else is behavior', () => {
    expect(surfaceClassOf('auto.nameshape')).toBe('identity');
    expect(surfaceClassOf('auto.filenameshape')).toBe('identity');
    expect(surfaceClassOf('auto.arity')).toBe('identity');
    expect(surfaceClassOf('auto.dir1')).toBe('identity');
    expect(surfaceClassOf('auto.moddirshape')).toBe('identity');
    expect(surfaceClassOf('auto.modsize')).toBe('identity');
    expect(surfaceClassOf('auto.modfileshape')).toBe('identity');
    expect(surfaceClassOf('auto.call:foo')).toBe('behavior');
    expect(surfaceClassOf('auto.deco:@Injectable')).toBe('behavior');
    expect(surfaceClassOf('auto.extends:Base')).toBe('behavior');
    expect(surfaceClassOf('auto.has:if_statement')).toBe('behavior');
    expect(surfaceClassOf('auto.stshape:return_statement()')).toBe('behavior');
    expect(surfaceClassOf('auto.imp:core')).toBe('behavior');
    expect(surfaceClassOf('auto.first1')).toBe('behavior');
    expect(surfaceClassOf('auto.ret')).toBe('behavior');
    expect(surfaceClassOf('auto.varshape')).toBe('behavior');
  });
});
