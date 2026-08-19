import { describe, it, expect } from 'vitest';
import { isFireable, tauFor, formatCanonicalDecimal } from '../../../src/roots/mine-stages.js';
import { mine, type MineInput, type AgeFn } from '../../../src/roots/mine.js';
import { isDecorativeRole } from '../../../src/roots/roles.js';
import type { ScopeUnit } from '../../../src/roots/extract.js';
import type { FeatureBag, DomainMap } from '../../../src/roots/enumerate.js';
import type { PartitionMap } from '../../../src/roots/partitions.js';
import type { RoleAssignment, RoleInfo } from '../../../src/roots/roles.js';
import type { SeedEntry, RootsConfig } from '../../../src/model/graph.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/mine-invariants.test.ts — a SIBLING of mine.test.ts (that
// file is close to the reviewer-prompt ceiling; this REWORK's new coverage
// lands here, mapped to the same model node). Fix-verification tests for the
// REWORK findings (H1-H3, L1-L3, AMB) plus dedicated mutation-kill tests for
// the reviewer's named surviving mutants. Every helper below mirrors
// mine.test.ts's own local helpers (kept file-local by this repo's existing
// convention — see roles.test.ts/mine.test.ts, neither shares helpers either).
// ---------------------------------------------------------------------------

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

function domainsFor(surfaceIds: string[], stableIds: string[]): DomainMap {
  const m: DomainMap = new Map();
  for (const s of surfaceIds) m.set(s, new Set(stableIds));
  return m;
}

/** Like `domainsFor`, but a distinct stableId list PER surface — for fixtures where a surface's own domain is a strict subset of the partition's members (M34). */
function domainsForEach(bySurface: Record<string, string[]>): DomainMap {
  const m: DomainMap = new Map();
  for (const [s, ids] of Object.entries(bySurface)) m.set(s, new Set(ids));
  return m;
}

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

async function config(overrides: { acceptMarginBits?: number; minInstancesRaw?: number; minInstancesEff?: number; factCap?: number; dirContextMinScopes?: number } = {}): Promise<RootsConfig> {
  const mdl = {
    acceptMarginBits: overrides.acceptMarginBits ?? 0.5,
    minInstancesRaw: overrides.minInstancesRaw ?? 1,
    minInstancesEff: overrides.minInstancesEff ?? 0.1,
    factCap: overrides.factCap ?? 400,
    dedupJaccard: 0.9,
    dirContextMinScopes: overrides.dirContextMinScopes ?? 25,
  };
  const lines = Object.entries(mdl)
    .map(([k, v]) => `    ${k}: ${v}`)
    .join('\n');
  return defaultRootsConfig(`mdl:\n${lines}\n`);
}

const w1: MineInput['weightFn'] = () => 1;

// ===========================================================================
// H1 — alphabets.set(surface, …) OVERWRITES per kind; must UNION.
// ===========================================================================

describe('H1 FIX — a categorical surface spanning multiple kinds unions its alphabet across kinds (never last-kind-wins)', () => {
  it('disjoint method (aU) and type (Ua) nameshapes: BOTH values appear in partition.alphabets, and BOTH kinds\' facts mine (the reviewer\'s probe shape)', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 30; i++) {
      const u = unit({ kind: 'method', relPath: `src/m${i}.ts`, name: `m${i}`, stableId: `m${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.nameshape': 'aU' }));
    }
    for (let i = 0; i < 30; i++) {
      const u = unit({ kind: 'type', relPath: `src/t${i}.ts`, name: `T${i}`, stableId: `t${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.nameshape': 'Ua' }));
    }
    const domains = domainsFor(['auto.nameshape'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1 });

    const partition = result.body.partitions[0];
    // Both values present — a last-kind-wins `.set()` would have discarded
    // whichever kind CELL_KINDS visits first ('method', losing to 'type').
    expect(partition.alphabets['auto.nameshape'].slice().sort()).toEqual(['Ua', 'aU']);

    const facts = partition.facts;
    const methodFact = facts.find((f) => f.appliesKind === 'method' && f.surface === 'auto.nameshape');
    const typeFact = facts.find((f) => f.appliesKind === 'type' && f.surface === 'auto.nameshape');
    // The bug's own failure mode: the LOSING kind's alphabet lookup returns
    // only the winning kind's values, so `nEff` sums to 0 over an alphabet
    // that never matches this kind's own weighted counts — annihilating the
    // fact entirely.
    expect(methodFact).toBeDefined();
    expect(typeFact).toBeDefined();
    expect(methodFact?.expected).toBe('aU');
    expect(typeFact?.expected).toBe('Ua');
  });
});

// ===========================================================================
// H2 — deviantsN must be RAW (not survived-only) non-conformers.
// ===========================================================================

describe('H2 FIX — deviantsN is the RAW non-conforming population (Appendix D\'s own worked record: nConformRaw:10,nTotalRaw:10,deviantsN:1 is NOT nTotalRaw-nConformRaw)', () => {
  it('a cell with real raw non-conformers and NO AgeFn: deviantsN > 0 while nTotalRaw (survived) = 0', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 25; i++) {
      const u = unit({ kind: 'method', relPath: `src/t${i}.ts`, name: `m${i}`, stableId: `t${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:h2': 'true' }));
    }
    for (let i = 0; i < 5; i++) {
      const u = unit({ kind: 'method', relPath: `src/f${i}.ts`, name: `m${i}`, stableId: `f${i}` });
      units.push(u);
      bags.push(bag(u, {})); // false — a real, raw deviant
    }
    const domains = domainsFor(['auto.call:h2'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    // NO ageFn — fail-closed: nTotalRaw (survived) must read 0.
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1 });
    const fact = result.body.partitions[0].facts.find((f) => f.surface === 'auto.call:h2');
    expect(fact).toBeDefined();
    expect(fact?.expected).toBe('true');
    expect(fact?.nTotalRaw).toBe(0); // survived population — fail-closed
    expect(fact?.nConformRaw).toBe(0);
    expect(fact?.deviantsN).toBe(5); // RAW: 30 total - 25 raw-conforming = 5, NOT nTotalRaw(0) - nConformRaw(0) = 0
  });
});

// ===========================================================================
// H3 — candidate universe from DOMAINS for booleans (Probe-C) + the vacuous
// filter's partition-wide (not kind-scoped) true-raw population.
// ===========================================================================

describe('H3 FIX — Probe-C: a cross-kind boolean true on one kind, in-domain-false on another, mines the OTHER kind\'s absence fact', () => {
  it('auto.deco:@X true on every TYPE, in-domain-false on every METHOD -> the METHOD absence fact mines (was unminable: never a bag key for method kind, so never a candidate at all)', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 30; i++) {
      const u = unit({ kind: 'method', relPath: `src/m${i}.ts`, name: `m${i}`, stableId: `m${i}` });
      units.push(u);
      bags.push(bag(u, {})); // never true on any method — sparse-true storage: absent key
    }
    for (let i = 0; i < 30; i++) {
      const u = unit({ kind: 'type', relPath: `src/t${i}.ts`, name: `T${i}`, stableId: `t${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.deco:@X': 'true' }));
    }
    const domains = domainsFor(['auto.deco:@X'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1 });

    const methodFact = result.body.partitions[0].facts.find((f) => f.appliesKind === 'method' && f.surface === 'auto.deco:@X');
    const typeFact = result.body.partitions[0].facts.find((f) => f.appliesKind === 'type' && f.surface === 'auto.deco:@X');
    expect(methodFact).toBeDefined(); // the probe: this used to be unminable
    expect(methodFact?.expected).toBe('false');
    expect(typeFact).toBeDefined();
    expect(typeFact?.expected).toBe('true');
  });

  it('M34 (domain arithmetic): domain ⊊ members — n_false is |domain ∩ members| − n_true, never |cell| − n_true', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    const inDomainTrueIds: string[] = [];
    const inDomainFalseIds: string[] = [];
    for (let i = 0; i < 18; i++) {
      const u = unit({ kind: 'method', relPath: `src/it${i}.ts`, name: `m${i}`, stableId: `it${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:dom': 'true' }));
      inDomainTrueIds.push(u.stableId);
    }
    for (let i = 0; i < 2; i++) {
      const u = unit({ kind: 'method', relPath: `src/if${i}.ts`, name: `m${i}`, stableId: `if${i}` });
      units.push(u);
      bags.push(bag(u, {}));
      inDomainFalseIds.push(u.stableId);
    }
    // 10 units OUT of `auto.call:dom`'s domain entirely — a naive
    // `|cell| - n_true` would wrongly count these as false too (30-18=12,
    // instead of the correct in-domain-only 2).
    for (let i = 0; i < 10; i++) {
      const u = unit({ kind: 'method', relPath: `src/od${i}.ts`, name: `m${i}`, stableId: `od${i}` });
      units.push(u);
      bags.push(bag(u, {}));
    }
    const domains = domainsForEach({ 'auto.call:dom': [...inDomainTrueIds, ...inDomainFalseIds] });
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1 });
    const fact = result.body.partitions[0].facts.find((f) => f.surface === 'auto.call:dom');
    expect(fact).toBeDefined();
    expect(fact?.counts.true).toBe('18');
    expect(fact?.counts.false).toBe('2'); // NOT 12 (30 - 18)
    expect(fact?.deviantsN).toBe(2); // confirms via the H2 field too
  });
});

// ===========================================================================
// AMB — the deviation ruling: ambiguous members join their rank-1 role's
// cell at half weight; nEff(r) for role_lift sums w_base over ALL rank-1
// members (confident + ambiguous).
// ===========================================================================

describe('AMB FIX — §8.5 half-weight role cells + §8.10 nEff(r) including ambiguous members (via roles.ts\'s ambiguousRank1)', () => {
  it('12 confident + 12 ambiguous rank-1 members: bitsSaved lands at the hand-derived half-weight value, nTotalRaw counts ALL 24 (raw, unweighted), and roles[].size is consistent with the fixture', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    const assignments: Record<string, string> = {};
    const ambiguousRank1: Record<string, string> = {};

    for (let i = 0; i < 12; i++) {
      const u = unit({ kind: 'method', relPath: `src/role/c${i}.ts`, name: `c${i}`, stableId: `c${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:x': 'true' }));
      assignments[u.skeyR] = 'r1';
    }
    for (let i = 0; i < 12; i++) {
      const u = unit({ kind: 'method', relPath: `src/role/a${i}.ts`, name: `a${i}`, stableId: `a${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:x': 'true' }));
      assignments[u.skeyR] = '-1';
      ambiguousRank1[u.skeyR] = 'r1';
    }
    for (let i = 0; i < 200; i++) {
      const u = unit({ kind: 'method', relPath: `bg${i}/f.ts`, name: `bg${i}`, stableId: `bg${i}` });
      units.push(u);
      bags.push(bag(u, {})); // never true — dilutes the `_all` baseline
    }
    const role: RoleInfo = { partitionId: 'p1', roleKey: 'r1', label: 'r', size: 24, medoidFeatures: [], definingFeatureGroups: [], ambiguityRate: 0.5 };
    const roles: RoleAssignment = { roles: [role], assignments, ambiguousRank1 };
    const domains = domainsFor(['auto.call:x'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    // A synthetic AgeFn — everyone survives, so nTotalRaw reads the REAL
    // (unweighted-raw) population, including ambiguous members at raw=1
    // each (the half-weight discount applies to `weighted` only, never `raw`).
    const ageFn: AgeFn = () => 9999;
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles, seeds: [], config: cfg, weightFn: w1, ageFn });

    const partition = result.body.partitions[0];
    const roleFact = partition.facts.find((f) => f.roleKey === 'r1' && f.surface === 'auto.call:x');
    expect(roleFact).toBeDefined();
    // nTotalRaw (survived raw) = 24: 12 confident + 12 ambiguous, EACH raw=1
    // (never 12 — that would mean ambiguous members were excluded from the
    // role cell entirely, the pre-REWORK deviation) and never 6 (that would
    // mean the HALF-weight discount wrongly reached the raw/survived count
    // instead of the weighted one).
    expect(roleFact?.nTotalRaw).toBe(24);
    expect(roleFact?.nConformRaw).toBe(24);
    // bitsSaved, hand-derived: role cell weighted n(true) = 12*1 + 12*0.5 = 18
    // (nEff=18); baseline `_all` weighted = {true:24 (both groups count FULL
    // weight in `_all` — §8.5's own "`_all` counts use w(s,q)`, no discount),
    // false:200}, baselineNEff=224. K=2.
    //   p_r(true)   = (18+.5)/(18+1) = 18.5/19     = 0.973684
    //   p_all(true) = (24+.5)/(224+1)= 24.5/225    = 0.108889
    //   data = 18 * log2(0.973684/0.108889) = 18 * log2(8.9412) ≈ 56.891
    //   paramCost = 0.5*(2-1)*log2(max(18,2)) = 0.5*log2(18) ≈ 2.0850
    //   C = 2 (the `_all:method` candidate + the `r1:method` candidate) -> idxCost = ceil(log2(2)) = 1
    //   bitsSaved ≈ 56.891 - 2.085 - 1 = 53.806
    expect(roleFact?.bitsSaved).toBeCloseTo(53.81, 1);

    // roles[].size (input, pass-through) is internally consistent with the
    // actual population that landed in the role's own fact (24 == 24).
    expect(partition.roles[0].size).toBe(24);
    expect(partition.roles[0].size).toBe(roleFact?.nTotalRaw);

    // §8.10 role_lift's nEff(r) = Σ w_base over ALL rank-1 members (24, full
    // weight, no ambiguous discount — a DIFFERENT quantity from the role
    // cell's own half-weighted 18): data(56.891) / 24 ≈ 2.3704.
    expect(partition.roles[0].roleLift).toBeCloseTo(2.37, 2);
  });
});

// ===========================================================================
// L1 — countsRecord bracket-assignment drops a '__proto__'-named value.
// ===========================================================================

describe('L1 FIX — a mined value literally named \'__proto__\' survives as an OWN property of the serialized counts (never silently dropped by a plain-object bracket write)', () => {
  it('a categorical surface whose only observed value is \'__proto__\'', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 30; i++) {
      const u = unit({ kind: 'method', relPath: `src/p${i}.ts`, name: `m${i}`, stableId: `p${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.ret': '__proto__' }));
    }
    const domains = domainsFor(['auto.ret'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1 });
    const fact = result.body.partitions[0].facts.find((f) => f.surface === 'auto.ret');
    expect(fact).toBeDefined();
    expect(fact?.expected).toBe('__proto__');
    expect(Object.prototype.hasOwnProperty.call(fact?.counts as object, '__proto__')).toBe(true);
    expect((fact?.counts as Record<string, string>)['__proto__']).toBe('30');
  });
});

// ===========================================================================
// L2 — bag.surfaces[surface] with a seed-supplied 'constructor' surface is
// an unguarded prototype read.
// ===========================================================================

describe('L2 FIX — a seed naming the surface \'constructor\' never reads Object.prototype.constructor off a target scope that lacks the key', () => {
  it('the target scope\'s bag has no OWN \'constructor\' key -> the seed contributes nothing (fact.seeded stays false), even though ANOTHER real scope legitimately gives the cell nonzero weighted mass for that surface name', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 10; i++) {
      const u = unit({ kind: 'method', relPath: `src/real${i}.ts`, name: `real${i}`, stableId: `real${i}` });
      units.push(u);
      bags.push(bag(u, { constructor: 'valA' })); // a REAL own-property value, legitimately named 'constructor'
    }
    const target = unit({ kind: 'method', relPath: 'src/target.ts', name: 'target', stableId: 'ctorTarget' });
    units.push(target);
    bags.push(bag(target, {})); // NO own 'constructor' key — an unguarded read falls through to Object.prototype.constructor
    // The target is deliberately OUT of `constructor`'s own domain — real
    // instance counting (`countRealInstancesIntoCell`, a SEPARATE code path
    // this test does not target) never touches it, isolating the guard
    // under test to `injectSeeds`' own read alone (`injectSeeds` reads a
    // seed's target scope directly, unconditioned by domain membership).
    const domains = domainsFor(['constructor'], units.slice(0, 10).map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const seeds: SeedEntry[] = [
      { seedId: 'sd1', scopeRef: { path: 'src/target.ts', qualifiedName: 'target' }, surfaces: ['constructor'], weight: 100, arch: false, author: 'a', createdAt: '2020-01-01' },
    ];
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds, config: cfg, weightFn: w1 });
    const fact = result.body.partitions[0].facts.find((f) => f.surface === 'constructor');
    expect(fact).toBeDefined();
    expect(fact?.seeded).toBe(false); // the guard: no legitimate value on the target scope -> nothing to nudge
  });
});

// ===========================================================================
// L3 — moduleOfFile now derives from finalizeUnits' own minted `module`
// units (no independent, possibly-divergent re-walk).
// ===========================================================================

describe('L3 FIX — moduleOfFile is derived from the ALREADY-MINTED `module`-kind units, guaranteed consistent with them', () => {
  it('every file\'s moduleOfFile entry names a directory that is ACTUALLY one of this partition\'s own minted module units', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    const moduleUnit = unit({ kind: 'module', relPath: 'src/app', name: 'app', stableId: 'mod-src-app' });
    units.push(moduleUnit);
    bags.push(bag(moduleUnit, {}));
    // Files live TWO levels below the minted module dir (`src/app/sub/`, not
    // `src/app/` directly) — this is what requires a genuine ANCESTOR WALK
    // (rather than trivially matching a file's own immediate containing
    // dir), the mutation this test discriminates against: a version that
    // skips the walk and just uses `dirnameOf(file)` directly would wrongly
    // report `src/app/sub` (a directory with NO minted module unit at all)
    // instead of `src/app`.
    for (let i = 0; i < 5; i++) {
      const u = unit({ kind: 'file', relPath: `src/app/sub/f${i}.ts`, name: `f${i}.ts`, stableId: `file${i}` });
      units.push(u);
      bags.push(bag(u, {}));
    }
    const domains: DomainMap = new Map();
    const partitions = trivialPartitions(units.filter((u) => u.kind === 'file').map((u) => u.relPath));
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1 });
    const moduleOfFile = result.body.partitions[0].moduleOfFile;
    for (let i = 0; i < 5; i++) {
      expect(moduleOfFile[`src/app/sub/f${i}.ts`]).toBe('src/app'); // matches the minted module unit's own relPath exactly — never the file's own immediate dir
    }
  });
});

// ===========================================================================
// MUTATION-KILL — low-level scoring primitives.
// ===========================================================================

describe('M35 (mutation-kill): isFireable\'s ±½ finite-n correction is load-bearing at the n=0 boundary', () => {
  it('isFireable(0,0,0) is TRUE (0.5/0.5=1 >= 2^0=1) — WITHOUT the +0.5 correction this would be 0/0=NaN, always false', () => {
    expect(isFireable(0, 0, 0)).toBe(true);
  });
  it('isFireable(0,0,1) is FALSE (0.5/0.5=1 < 2^1=2)', () => {
    expect(isFireable(0, 0, 1)).toBe(false);
  });
});

describe('M3 (mutation-kill): tauFor selects the CORRECT tier — vocabulary (3.5) vs structural (4.5) vs presence (2.5)', () => {
  const thresholds = { preferenceGapBits: 2.5, absenceGapBits: 3.5, absenceGapBitsStructural: 4.5 };
  it('a vocabulary-absence boolean (auto.call:) uses absenceGapBits', () => {
    expect(tauFor('auto.call:x', true, 'false', thresholds)).toEqual({ tau: 3.5, absence: true });
  });
  it('a structural-absence boolean (auto.has:) uses absenceGapBitsStructural', () => {
    expect(tauFor('auto.has:if_statement', true, 'false', thresholds)).toEqual({ tau: 4.5, absence: true });
  });
  it('a structural-absence boolean (auto.stshape:) ALSO uses absenceGapBitsStructural', () => {
    expect(tauFor('auto.stshape:x', true, 'false', thresholds)).toEqual({ tau: 4.5, absence: true });
  });
  it('a presence boolean (expected=true) uses preferenceGapBits, absence=false', () => {
    expect(tauFor('auto.call:x', true, 'true', thresholds)).toEqual({ tau: 2.5, absence: false });
  });
  it('a categorical surface (never absence, regardless of expected) uses preferenceGapBits', () => {
    expect(tauFor('auto.ret', false, 'other', thresholds)).toEqual({ tau: 2.5, absence: false });
  });
});

describe('M23 (mutation-kill): formatCanonicalDecimal pins an exact decimal string', () => {
  it('42.3 formats to exactly "42.3" (not "42.300000", not "42.3000")', () => {
    expect(formatCanonicalDecimal(42.3)).toBe('42.3');
  });
  it('an exact integer never pads with a decimal point', () => {
    expect(formatCanonicalDecimal(24)).toBe('24');
  });
});

describe('M20-ish (mutation-kill, cheap): isDecorativeRole\'s <= 0 boundary is inclusive of exactly 0', () => {
  it('role_lift exactly 0 is decorative; a hair above is not; comfortably negative is', () => {
    expect(isDecorativeRole(0)).toBe(true);
    expect(isDecorativeRole(0.0001)).toBe(false);
    expect(isDecorativeRole(-5)).toBe(true);
  });
});

// ===========================================================================
// MUTATION-KILL — acceptance conjuncts (M1/M2), C (M12/M13), factCap (M5),
// dedup cell-scoping (M7).
// ===========================================================================

describe('M1/M2 (mutation-kill): each §9.4a acceptance conjunct gates INDIVIDUALLY', () => {
  it('M1: nRaw below minInstancesRaw rejects even with comfortable bitsSaved/nEff', async () => {
    const strict = await config({ minInstancesRaw: 50 });
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 30; i++) {
      const u = unit({ kind: 'method', relPath: `src/m${i}.ts`, name: `m${i}`, stableId: `m${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:m1': 'true' }));
    }
    const domains = domainsFor(['auto.call:m1'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const rejected = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: strict, weightFn: w1 });
    expect(rejected.body.partitions[0].facts.some((f) => f.surface === 'auto.call:m1')).toBe(false); // nRaw=30 < 50

    const lenientCfg = await config({ minInstancesRaw: 10 });
    const accepted = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: lenientCfg, weightFn: w1 });
    expect(accepted.body.partitions[0].facts.some((f) => f.surface === 'auto.call:m1')).toBe(true); // same fixture, lenient floor
  });

  it('M2: nEff below minInstancesEff rejects even with comfortable bitsSaved/nRaw', async () => {
    const strict = await config({ minInstancesEff: 50 });
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 30; i++) {
      const u = unit({ kind: 'method', relPath: `src/m${i}.ts`, name: `m${i}`, stableId: `m${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:m2': 'true' }));
    }
    const domains = domainsFor(['auto.call:m2'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    // nRaw=30 (well above minInstancesRaw=1) but nEff=30 (weight=1) < 50.
    const rejected = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: strict, weightFn: w1 });
    expect(rejected.body.partitions[0].facts.some((f) => f.surface === 'auto.call:m2')).toBe(false);

    const lenientCfg = await config({ minInstancesEff: 10 });
    const accepted = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: lenientCfg, weightFn: w1 });
    expect(accepted.body.partitions[0].facts.some((f) => f.surface === 'auto.call:m2')).toBe(true);
  });
});

describe('M12/M13 (mutation-kill): C/candidateCountLog2 is exact on a hand-counted fixture — tautological role candidates excluded, minInstancesRaw applied', () => {
  it('candidateCountLog2 is exactly 2 (C=4), hand-counted: `_all:type` extends:Base(1) + 3 background-only call surfaces(3) = 4; the role\'s OWN extends:Base is tautological (excluded); a domain-1 surface never clears minInstancesRaw (excluded)', async () => {
    const cfg = await config({ minInstancesRaw: 2 });
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    const roleIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const u = unit({ kind: 'type', relPath: `src/role/t${i}.ts`, name: `T${i}`, stableId: `role${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.extends:Base': 'true' }));
      roleIds.push(u.stableId);
    }
    const bgIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const u = unit({ kind: 'type', relPath: `src/bg/b${i}.ts`, name: `B${i}`, stableId: `bg${i}` });
      units.push(u);
      const s: Record<string, string> = {};
      if (i < 3) s['auto.call:bgOnly1'] = 'true';
      if (i < 2) s['auto.call:bgOnly2'] = 'true';
      if (i < 4) s['auto.call:bgOnly3'] = 'true';
      bags.push(bag(u, s));
      bgIds.push(u.stableId);
    }
    const tiny = unit({ kind: 'type', relPath: 'src/tiny/x.ts', name: 'X', stableId: 'tiny1' });
    units.push(tiny);
    bags.push(bag(tiny, {}));

    const domains = domainsForEach({
      'auto.extends:Base': roleIds,
      'auto.call:bgOnly1': bgIds,
      'auto.call:bgOnly2': bgIds,
      'auto.call:bgOnly3': bgIds,
      'auto.extends:Tiny': ['tiny1'], // domain of size 1 — raw=1 < minInstancesRaw(2), everywhere
    });
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const role: RoleInfo = { partitionId: 'p1', roleKey: 'r1', label: 'r', size: 10, medoidFeatures: [], definingFeatureGroups: ['supertype'], ambiguityRate: 0 };
    const assignments: Record<string, string> = {};
    for (const u of units) if (roleIds.includes(u.stableId)) assignments[u.skeyR] = 'r1';
    const roles: RoleAssignment = { roles: [role], assignments, ambiguousRank1: {} };

    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles, seeds: [], config: cfg, weightFn: w1 });
    expect(result.candidateCountLog2).toBe(2); // ceil(log2(4))

    // Corroborating structural checks:
    expect(result.body.partitions[0].facts.some((f) => f.roleKey === 'r1' && f.surface === 'auto.extends:Base')).toBe(false); // tautological — skipped
    expect(result.body.partitions[0].facts.some((f) => f.surface === 'auto.extends:Tiny')).toBe(false); // never clears minInstancesRaw anywhere
  });
});

describe('M5 (mutation-kill): factCap keeps the BEST N by bits-per-instance (not an arbitrary/unsorted N)', () => {
  it('5 candidates with strictly increasing bits-per-instance; factCap=3 keeps EXACTLY the top 3 (highest true-share), drops the bottom 2', async () => {
    const cfg = await config({ factCap: 3 });
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    const surfaces = ['auto.call:a', 'auto.call:b', 'auto.call:c', 'auto.call:d', 'auto.call:e'];
    // true-counts 70,78,85,90,95 out of 100 — each surface's OWN true-set is
    // a distinct rotating window (offset `k*17 mod 100`), not a nested
    // subset of the next (a naive `i < threshold` construction, as an
    // earlier draft of this fixture used, makes every pair near-identical
    // conform sets — Jaccard >= 0.9 between adjacent surfaces — and §9.4e
    // dedup correctly folds them together before factCap ever runs,
    // collapsing this fixture's own signal). Hand-verified (script, not
    // shown): pairwise Jaccard tops out at 0.85 here (< the 0.9 dedup
    // threshold), all 5 individually clear acceptance, and bits-per-instance
    // is strictly increasing a<b<c<d<e.
    const counts = [70, 78, 85, 90, 95];
    for (let i = 0; i < 100; i++) {
      const u = unit({ kind: 'method', relPath: `src/m${i}.ts`, name: `m${i}`, stableId: `m${i}` });
      units.push(u);
      const s: Record<string, string> = {};
      for (let k = 0; k < surfaces.length; k++) if ((i + k * 17) % 100 < counts[k]) s[surfaces[k]] = 'true';
      bags.push(bag(u, s));
    }
    const domains = domainsFor(surfaces, units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1 });
    const kept = result.body.partitions[0].facts.map((f) => f.surface).sort();
    // Higher true-share -> higher bits-per-instance -> e,d,c survive; a,b are culled.
    expect(kept).toEqual(['auto.call:c', 'auto.call:d', 'auto.call:e']);
  });
});

describe('M7 (mutation-kill): §9.4e dedup is scoped WITHIN one cell only — never across cells, even for an identical conform set', () => {
  it('a role cell\'s surface X and the `_all` cell\'s surface Y share the EXACT same 100-stableId conform set, yet remain TWO separate facts (one per cell)', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    const roleIds: string[] = [];
    // 100 role members (large enough that the role's OWN candidate clears
    // acceptance against a `_all` baseline that is ITSELF skewed enough to
    // independently clear its own uniform-B=2 test — hand-verified via
    // script: role.bitsSaved ≈ 1.65, all.bitsSaved ≈ 70.6, both comfortably
    // above this fixture's 0.5 margin) plus a small false population (5).
    for (let i = 0; i < 100; i++) {
      const u = unit({ kind: 'method', relPath: `src/role/r${i}.ts`, name: `r${i}`, stableId: `role${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:x': 'true', 'auto.call:y': 'true' }));
      roleIds.push(u.stableId);
    }
    for (let i = 0; i < 5; i++) {
      const u = unit({ kind: 'method', relPath: `src/bg${i}.ts`, name: `bg${i}`, stableId: `bg${i}` });
      units.push(u);
      bags.push(bag(u, {})); // false for both X and Y
    }
    const domains = domainsFor(['auto.call:x', 'auto.call:y'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const role: RoleInfo = { partitionId: 'p1', roleKey: 'r1', label: 'r', size: 100, medoidFeatures: [], definingFeatureGroups: [], ambiguityRate: 0 };
    const assignments: Record<string, string> = {};
    for (const u of units) if (roleIds.includes(u.stableId)) assignments[u.skeyR] = 'r1';
    const roles: RoleAssignment = { roles: [role], assignments, ambiguousRank1: {} };

    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles, seeds: [], config: cfg, weightFn: w1 });
    const facts = result.body.partitions[0].facts;
    // Within EACH cell, X and Y (identical conform sets there too) correctly
    // dedup to ONE lead fact (surface asc tie-break -> 'auto.call:x' wins,
    // nSurfaces=2) — but the `_all` cell's lead and the `r1` cell's lead must
    // NOT merge with each other, despite an IDENTICAL 100-id conform set.
    const xFacts = facts.filter((f) => f.surface === 'auto.call:x');
    expect(xFacts).toHaveLength(2); // one in `_all`, one in `r1` — never collapsed into 1
    expect(xFacts.map((f) => f.roleKey).sort()).toEqual(['_all', 'r1']);
    for (const f of xFacts) expect(f.nSurfaces).toBe(2);
    expect(facts.some((f) => f.surface === 'auto.call:y')).toBe(false); // folded into its own cell's lead in both cells
  });
});

// ===========================================================================
// M8/M9 (mutation-kill): directory-context creation — dirContextMinScopes
// floor AND strictly-fewer-than-kindTotal.
// ===========================================================================

describe('M8/M9 (mutation-kill): directory contexts require >= dirContextMinScopes AND strictly fewer than the whole partition\'s kind population', () => {
  it('M8: a dir with dirContextMinScopes-1 members never becomes a context, even with a real convention and plenty of other members elsewhere', async () => {
    const cfg = await config({ dirContextMinScopes: 5 });
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 4; i++) {
      const u = unit({ kind: 'method', relPath: `src/dirA/x${i}.ts`, name: `x${i}`, stableId: `a${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:z': 'true' }));
    }
    for (let i = 0; i < 10; i++) {
      const u = unit({ kind: 'method', relPath: `src/o${i}/f.ts`, name: `o${i}`, stableId: `o${i}` });
      units.push(u);
      bags.push(bag(u, {}));
    }
    const domains = domainsFor(['auto.call:z'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1 });
    expect(result.body.partitions[0].facts.some((f) => f.roleKey === 'd[src/dirA]')).toBe(false);
  });

  it('M9: a dir holding ALL of the kind\'s members (count == kindTotal) never becomes a context — strictly-fewer-than-whole is the second half of the test', async () => {
    const cfg = await config({ dirContextMinScopes: 5 });
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    // TWO surfaces, both real on every member — a whole-partition directory
    // is data-IDENTICAL to `_all` for both, so it can never independently
    // clear ACCEPTANCE (no genuine local contrast exists to observe via a
    // fact) regardless of whether the creation gate lets it through. `C`
    // (repo-wide candidate count, computed BEFORE acceptance) is the
    // discriminator that survives that confound: a wrongly-created
    // whole-partition dir cell still contributes MORE (cell,surface)
    // candidates toward `C` (one per surface it holds), and live-verified
    // (mutation round-trip) that this crosses `idxCost`'s power-of-two
    // rounding boundary — 1 with the gate intact, 2 with only the
    // dirContextMinScopes floor active and the strictly-fewer-than-whole
    // half removed.
    for (let i = 0; i < 5; i++) {
      const u = unit({ kind: 'method', relPath: `src/dirB/x${i}.ts`, name: `x${i}`, stableId: `b${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:z': 'true', 'auto.call:w': 'true' }));
    }
    const domains = domainsFor(['auto.call:z', 'auto.call:w'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1 });
    expect(result.body.partitions[0].facts.some((f) => f.roleKey.startsWith('d['))).toBe(false);
    expect(result.candidateCountLog2).toBe(1); // ceil(log2(2)) — NOT ceil(log2(4))=2, which a wrongly-created whole-partition dir cell would produce
  });

  it('positive control: >= dirContextMinScopes AND < kindTotal DOES create a directory-context fact', async () => {
    const cfg = await config({ dirContextMinScopes: 5 });
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 5; i++) {
      const u = unit({ kind: 'method', relPath: `src/dirC/x${i}.ts`, name: `x${i}`, stableId: `c${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:z': 'true' }));
    }
    for (let i = 0; i < 10; i++) {
      const u = unit({ kind: 'method', relPath: `src/oc${i}/f.ts`, name: `oc${i}`, stableId: `oc${i}` });
      units.push(u);
      bags.push(bag(u, {}));
    }
    const domains = domainsFor(['auto.call:z'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1 });
    const fact = result.body.partitions[0].facts.find((f) => f.roleKey === 'd[src/dirC]' && f.surface === 'auto.call:z');
    expect(fact).toBeDefined();
    expect(fact?.expected).toBe('true');
  });
});

// ===========================================================================
// M10/M11/M30 (mutation-kill): eligibility gates 1/2/4 — direction pinned
// directly, isolated from each other.
// ===========================================================================

describe('M10/M11/M30 (mutation-kill): hook-eligibility gates 1 (fallback), 2 (placement group-only), 4 (real-but-insufficient survived share) each force hookEligible=false WITHOUT dropping the fact', () => {
  it('M10 gate1: a fallback-bucket value ("other") as the majority/expected value is never hook-eligible, though the FACT still exists', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    // 27/3 split (not 25/5): fire-ability needs (27.5)/(3.5) ≈ 7.86 >=
    // 2^2.5 (≈5.657) to CLEAR gate3 comfortably, isolating gate1 as the sole
    // failing gate — a milder split (e.g. 25/5, (25.5)/(5.5)≈4.6) fails
    // fire-ability TOO, confounding the two gates (an earlier draft of this
    // fixture made exactly that mistake: hookEligible read false for the
    // wrong reason, and a mutation disabling gate1 alone left it
    // undetected).
    for (let i = 0; i < 27; i++) {
      const u = unit({ kind: 'method', relPath: `src/o${i}.ts`, name: `o${i}`, stableId: `o${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.ret': 'other' }));
    }
    for (let i = 0; i < 3; i++) {
      const u = unit({ kind: 'method', relPath: `src/r${i}.ts`, name: `r${i}`, stableId: `r${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.ret': 'realvalue' }));
    }
    const domains = domainsFor(['auto.ret'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const ageFn: AgeFn = () => 9999; // survives cleanly — isolates gate1
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1, ageFn });
    const fact = result.body.partitions[0].facts.find((f) => f.surface === 'auto.ret');
    expect(fact).toBeDefined();
    expect(fact?.expected).toBe('other');
    expect(fact?.hookEligible).toBe(false);
  });

  it('M11 gate2: auto.dir1 (E7 placement) on the `_all` cell is never hook-eligible, even with a comfortable, fireable, survived majority', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 27; i++) {
      const u = unit({ kind: 'file', relPath: `utils/f${i}.ts`, name: `f${i}.ts`, stableId: `u${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.dir1': 'utils' }));
    }
    for (let i = 0; i < 3; i++) {
      const u = unit({ kind: 'file', relPath: `shared/g${i}.ts`, name: `g${i}.ts`, stableId: `s${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.dir1': 'shared' }));
    }
    const domains = domainsFor(['auto.dir1'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const ageFn: AgeFn = () => 9999; // gate4 passes cleanly
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1, ageFn });
    const fact = result.body.partitions[0].facts.find((f) => f.roleKey === '_all' && f.surface === 'auto.dir1');
    expect(fact).toBeDefined();
    expect(fact?.expected).toBe('utils'); // gate1 passes (not a fallback value)
    expect(fact?.hookEligible).toBe(false); // gate2: E7 placement is role-cell-only, never `_all`
  });

  it('M30 gate4: a REAL (not fail-closed-absent) but insufficient survived share forces hookEligible=false — distinct from the total-absence case', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    const survivedIds = new Set<string>();
    for (let i = 0; i < 27; i++) {
      const u = unit({ kind: 'method', relPath: `src/t${i}.ts`, name: `t${i}`, stableId: `t${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:g4': 'true' }));
      if (i < 5) survivedIds.add(u.stableId); // only 5 of the 27 true instances survive
    }
    for (let i = 0; i < 3; i++) {
      const u = unit({ kind: 'method', relPath: `src/f${i}.ts`, name: `f${i}`, stableId: `f${i}` });
      units.push(u);
      bags.push(bag(u, {}));
      survivedIds.add(u.stableId); // all 3 false instances survive
    }
    const domains = domainsFor(['auto.call:g4'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const ageFn: AgeFn = (u) => (survivedIds.has(u.stableId) ? 9999 : 0);
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1, ageFn });
    const fact = result.body.partitions[0].facts.find((f) => f.surface === 'auto.call:g4');
    expect(fact).toBeDefined();
    expect(fact?.expected).toBe('true'); // gate1 passes
    // Overall unweighted fire-ability: (27.5)/(3.5) ≈ 7.86 >= 2^2.5 (≈5.657) — gate3 passes.
    // Survived share: nConformRaw=5, nTotalRaw=8 -> 5/8=0.625 < eligibilityMinRawShare (2/3) — gate4 fails.
    expect(fact?.nTotalRaw).toBe(8);
    expect(fact?.nConformRaw).toBe(5);
    expect(fact?.hookEligible).toBe(false);
  });
});

// ===========================================================================
// M14/M15 (mutation-kill): seed cap fraction, and seeds excluded from raw/survived.
// ===========================================================================

describe('M14/M15 (mutation-kill): a seed is capped at seedCapFraction × n_eff_real (not the raw seed weight), and never counts toward nRaw/survived populations', () => {
  it('a seed weight of 100 against 20 real true instances (n_eff_real=20, cap=0.5×20=10) lands the weighted count at 30 (20+10), while nTotalRaw/nConformRaw stay at the REAL 20', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 20; i++) {
      const u = unit({ kind: 'method', relPath: `src/s${i}.ts`, name: `s${i}`, stableId: `s${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:seeded2': 'true' }));
    }
    const domains = domainsFor(['auto.call:seeded2'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const seeds: SeedEntry[] = [
      { seedId: 'sd1', scopeRef: { path: 'src/s0.ts', qualifiedName: 's0' }, surfaces: ['auto.call:seeded2'], weight: 100, arch: false, author: 'a', createdAt: '2020-01-01' },
    ];
    const ageFn: AgeFn = () => 9999;
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds, config: cfg, weightFn: w1, ageFn });
    const fact = result.body.partitions[0].facts.find((f) => f.surface === 'auto.call:seeded2');
    expect(fact).toBeDefined();
    expect(fact?.seeded).toBe(true);
    expect(fact?.counts.true).toBe('30'); // 20 real + capped 10 (never the raw seed weight 100)
    expect(fact?.nTotalRaw).toBe(20); // seeds excluded from the survived/raw population entirely
    expect(fact?.nConformRaw).toBe(20);
  });
});

// ===========================================================================
// M25 (mutation-kill): role_lift's held-out set is BEHAVIOR-class surfaces
// only — an identity surface (auto.nameshape, itself a clustering feature)
// must never leak in and artificially inflate the metric.
// ===========================================================================

describe('M25 (mutation-kill): a role whose ONLY surface is an IDENTITY one (auto.nameshape) has role_lift EXACTLY 0 — the identity surface never enters the held-out set', () => {
  it('30 role members sharing one nameshape value, no real behavior surface at all: role_lift is exactly 0 (decorative), not inflated by identity leakage', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    const roleIds: string[] = [];
    for (let i = 0; i < 30; i++) {
      const u = unit({ kind: 'method', relPath: `src/role/r${i}.ts`, name: `r${i}`, stableId: `role${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.nameshape': 'Ua' }));
      roleIds.push(u.stableId);
    }
    // 20 background members with a DIFFERENT nameshape each, diluting `_all`
    // away from 'Ua' — if `auto.nameshape` wrongly entered role_lift's
    // held-out set, the role's 100%-'Ua' population vs this diluted
    // baseline would produce a strongly POSITIVE (non-zero) data_term.
    for (let i = 0; i < 20; i++) {
      const u = unit({ kind: 'method', relPath: `src/bg${i}.ts`, name: `bg${i}`, stableId: `bg${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.nameshape': `shape${i}` }));
    }
    const domains = domainsFor(['auto.nameshape'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const role: RoleInfo = { partitionId: 'p1', roleKey: 'r1', label: 'r', size: 30, medoidFeatures: [], definingFeatureGroups: [], ambiguityRate: 0 };
    const assignments: Record<string, string> = {};
    for (const u of units) if (roleIds.includes(u.stableId)) assignments[u.skeyR] = 'r1';
    const roles: RoleAssignment = { roles: [role], assignments, ambiguousRank1: {} };
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles, seeds: [], config: cfg, weightFn: w1 });
    expect(result.body.partitions[0].roles[0].roleLift).toBe(0);
  });
});

// ===========================================================================
// M27 (mutation-kill, best-effort): alphabets are computed from RAW, PRE-SEED
// counts — seed injection never changes the partition-observed alphabet.
// ===========================================================================

describe('M27 (mutation-kill): partition.alphabets is identical with or without a seed on an existing value — seed injection can never expand/alter the RAW-derived alphabet', () => {
  it('a heavily-weighted seed on an already-observed value leaves partition.alphabets[surface] byte-identical to the no-seed run', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    for (let i = 0; i < 20; i++) {
      const u = unit({ kind: 'method', relPath: `src/a${i}.ts`, name: `a${i}`, stableId: `a${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.ret': 'shapeA' }));
    }
    for (let i = 0; i < 10; i++) {
      const u = unit({ kind: 'method', relPath: `src/b${i}.ts`, name: `b${i}`, stableId: `b${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.ret': 'shapeB' }));
    }
    const domains = domainsFor(['auto.ret'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const withoutSeeds = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1 });
    const seeds: SeedEntry[] = [
      { seedId: 'sd1', scopeRef: { path: 'src/a0.ts', qualifiedName: 'a0' }, surfaces: ['auto.ret'], weight: 1000, arch: false, author: 'a', createdAt: '2020-01-01' },
    ];
    const withSeeds = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds, config: cfg, weightFn: w1 });
    expect(withSeeds.body.partitions[0].alphabets['auto.ret']).toEqual(withoutSeeds.body.partitions[0].alphabets['auto.ret']);
    expect(withSeeds.body.partitions[0].alphabets['auto.ret']).toEqual(['shapeA', 'shapeB']);
  });
});

// ===========================================================================
// M29 (mutation-kill): survived-raw boundary is age_days >= freshPenaltyDays
// (inclusive), with a SYNTHETIC (present) AgeFn — not the fail-closed-absent case.
// ===========================================================================

describe('M29 (mutation-kill): survivedOf\'s boundary is age_days >= freshPenaltyDays (inclusive) with a REAL AgeFn present', () => {
  it('age exactly == freshPenaltyDays (14, default) survives; age one day younger does not', async () => {
    const cfg = await config();
    const units: ScopeUnit[] = [];
    const bags: FeatureBag[] = [];
    const atBoundaryIds = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const u = unit({ kind: 'method', relPath: `src/at${i}.ts`, name: `at${i}`, stableId: `at${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:g29': 'true' }));
      atBoundaryIds.add(u.stableId);
    }
    for (let i = 0; i < 10; i++) {
      const u = unit({ kind: 'method', relPath: `src/be${i}.ts`, name: `be${i}`, stableId: `be${i}` });
      units.push(u);
      bags.push(bag(u, { 'auto.call:g29': 'true' }));
    }
    const domains = domainsFor(['auto.call:g29'], units.map((u) => u.stableId));
    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const ageFn: AgeFn = (u) => (atBoundaryIds.has(u.stableId) ? 14 : 13);
    const result = mine({ units, bags, domains, vocab: new Map(), partitions, roles: emptyRoles(), seeds: [], config: cfg, weightFn: w1, ageFn });
    const fact = result.body.partitions[0].facts.find((f) => f.surface === 'auto.call:g29');
    expect(fact).toBeDefined();
    expect(fact?.nTotalRaw).toBe(10); // exactly the age===14 group — `>=`, not `>`
  });
});
