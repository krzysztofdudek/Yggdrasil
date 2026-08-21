import { describe, it, expect } from 'vitest';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import { mine, type AgeFn, type MineInput } from '../../../src/roots/mine.js';
import type { FeatureBag, DomainMap } from '../../../src/roots/enumerate.js';
import type { ScopeUnit } from '../../../src/roots/extract.js';
import type { PartitionMap } from '../../../src/roots/partitions.js';
import type { RoleAssignment } from '../../../src/roots/roles.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/mine-roles-fence.test.ts — D7's own fence: `role_lift`'s
// divisor (`computeRoleLiftForPartition`'s `n_eff(r) = Sum w_base(s)`) reads
// the per-SCOPE base weight, never the ledger-capped per-(scope,surface)
// weight `w(s,q)` `surfaceWeightFn` supplies. Kept OUT of `roles.test.ts` —
// that file is a frozen prompt-margin file (`node scripts/prompt-headroom.mjs`
// pins it at 660 chars of margin) — as a sibling, mapped into the graph
// alongside it the same way `history-join.test.ts` and
// `golden-history.test.ts` were mapped for D17's own gate.
//
// The fixture: a partition of 20 method-kind scopes confidently assigned to
// ONE role, PLUS 5 more method-kind scopes of the same kind carrying no role
// at all — so the role's own cell (20 members) genuinely differs from the
// kind's `_all` cell (25 members), which is what makes `role_lift` a real,
// non-zero number rather than the degenerate `total = 0` a role spanning its
// entire kind's population would produce (role cell === `_all` cell would
// leave BOTH the correct code and MR-27's mutant reading 0/anything = 0,
// unable to separate them at all). The ledger mark lands on `MARKED_SURFACE`
// (`auto.nameshape`), an IDENTITY-class surface (E1) — `role_lift`'s own
// held-out set is BEHAVIOR-class only (`surfaceClassOf(surface) !== 'behavior'
// -> continue`, `mine.ts`), so under CORRECT code the mark never touches
// `role_lift`'s bit sum (`total`) at all, and the per-scope divisor
// (`weightFn`, constant 1.0) never reads a mark either (D7) — so `role_lift`
// is IDENTICAL whether or not the mark is present. MR-27's mutant caps the
// marked scope's contribution to the DIVISOR regardless of which surface
// carries the mark (its own "any sf in domains" shape), so the two runs'
// `role_lift` values diverge under the mutant even though this fixture's
// mark never touches a single behavior-class weighted count.
// ---------------------------------------------------------------------------

const ROLE_KEY = 'r1';
const BEHAVIOR_SURFACE = 'auto.call:established'; // behavior-class (E3-E6/E8-E11's own bucket — never matched by mine-stages.ts's IDENTITY_SURFACE_RULES)
const MARKED_SURFACE = 'auto.nameshape'; // identity-class (E1) — excluded from role_lift's own held-out surface set

function unit(overrides: { stableId: string; relPath: string; name: string }): ScopeUnit {
  return {
    kind: 'method',
    relPath: overrides.relPath,
    name: overrides.name,
    qualifiedName: overrides.name,
    ordinal: 0,
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
    partitionId: 'p1',
    skeyR: `${overrides.relPath}#method#${overrides.name}`,
    stableId: overrides.stableId,
  };
}

function trivialPartitions(relPaths: string[]): PartitionMap {
  return {
    partitionOfFile: new Map(relPaths.map((p) => [p, 'p1'])),
    moduleRootDirOfFile: new Map(relPaths.map((p) => [p, ''])),
    packageRoots: [],
    survivingPartitionIds: ['p1'],
    statusOfKey: new Map([['p1', 'own-floor']]),
    silent: false,
  };
}

describe("mine() — D7's role_lift fence: the divisor is w_base, never the ledger-capped per-surface weight (MR-27)", () => {
  it("a mark on ONE member's identity surface leaves partition.roles[0].roleLift byte-identical to the unmarked run", async () => {
    const config = await defaultRootsConfig();

    // 20 role members (m0..m19), skewed 18/20 true on BEHAVIOR_SURFACE.
    const roleUnits: ScopeUnit[] = [];
    for (let i = 0; i < 20; i++) roleUnits.push(unit({ stableId: `m${i}`, relPath: `src/role/m${i}.ts`, name: `m${i}` }));
    // 5 roleless members (x0..x4), all false on BEHAVIOR_SURFACE — present so
    // the role's own cell (20 members) genuinely differs from the kind's
    // `_all` cell (25 members): a role spanning its entire kind would make
    // `role_lift`'s bit sum 0 regardless of the divisor, which could never
    // separate the mutant from correct code (see this file's own header).
    const otherUnits: ScopeUnit[] = [];
    for (let i = 0; i < 5; i++) otherUnits.push(unit({ stableId: `x${i}`, relPath: `src/other/x${i}.ts`, name: `x${i}` }));
    const units = [...roleUnits, ...otherUnits];

    const bags: FeatureBag[] = units.map((u) => {
      const isRoleMember = u.stableId.startsWith('m');
      const idx = Number(u.stableId.slice(1));
      const behaviorTrue = isRoleMember ? idx < 18 : false; // 18/20 true in-role, 0/5 true out-of-role
      const surfaces: Record<string, string> = { [MARKED_SURFACE]: 'a' };
      if (behaviorTrue) surfaces[BEHAVIOR_SURFACE] = 'true';
      return { stableId: u.stableId, skeyR: u.skeyR, kind: u.kind, relPath: u.relPath, surfaces };
    });

    const domains: DomainMap = new Map([
      [BEHAVIOR_SURFACE, new Set(units.map((u) => u.stableId))],
      [MARKED_SURFACE, new Set(units.map((u) => u.stableId))],
    ]);

    const partitions = trivialPartitions(units.map((u) => u.relPath));
    const assignments: Record<string, string> = {};
    for (const u of roleUnits) assignments[u.skeyR] = ROLE_KEY; // otherUnits carry NO entry — roleless
    const roles: RoleAssignment = {
      roles: [{ partitionId: 'p1', roleKey: ROLE_KEY, label: 'Role1', size: 20, medoidFeatures: [], definingFeatureGroups: [], ambiguityRate: 0 }],
      assignments,
      ambiguousRank1: {},
    };

    const weightFn: MineInput['weightFn'] = () => 1.0; // w_base, uniform — the divisor role_lift MUST read regardless of any mark
    const ageFn: AgeFn = () => 9999; // a real AgeFn, matching how a real ledger-joined run is wired

    const markedMemberId = 'm0';
    const hookShapedFn = (u: ScopeUnit, surface: string): boolean => u.stableId === markedMemberId && surface === MARKED_SURFACE;
    const surfaceWeightFn = (u: ScopeUnit, surface: string): number =>
      hookShapedFn(u, surface) ? Math.min(weightFn(u), config.weights.hookShapedWeight) : weightFn(u);

    const withMark = mine({ units, bags, domains, vocab: new Map(), partitions, roles, seeds: [], config, weightFn, ageFn, surfaceWeightFn, hookShapedFn });
    const withoutMark = mine({ units, bags, domains, vocab: new Map(), partitions, roles, seeds: [], config, weightFn, ageFn }); // no surfaceWeightFn/hookShapedFn at all

    const roleWith = withMark.body.partitions.find((p) => p.id === 'p1')?.roles.find((r) => r.roleKey === ROLE_KEY);
    const roleWithout = withoutMark.body.partitions.find((p) => p.id === 'p1')?.roles.find((r) => r.roleKey === ROLE_KEY);
    expect(roleWith).toBeDefined();
    expect(roleWithout).toBeDefined();

    // Non-vacuous: role_lift is a real, meaningfully non-zero number here
    // (the role's own skewed BEHAVIOR_SURFACE distribution against the
    // roleless population's opposite skew) — not merely 0 === 0, which
    // would pass regardless of the divisor and prove nothing about the
    // mutant.
    expect(Math.abs(roleWithout?.roleLift as number)).toBeGreaterThan(0.01);

    // The fence itself: identical whether or not a mark exists, because
    // BOTH the divisor (w_base, per-scope, D7) and the bit sum (identity
    // surfaces excluded from role_lift's own held-out set) are blind to it.
    expect(roleWith?.roleLift).toBeCloseTo(roleWithout?.roleLift as number, 10);
  });
});
