import { describe, it, expect } from 'vitest';
import { induceRoles } from '../../../src/roots/roles.js';
import type { ScopeUnit } from '../../../src/roots/extract.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/roles-ambiguous.test.ts — a SIBLING of roles.test.ts (that
// file sits at 660 chars of reviewer-prompt headroom; new role-induction
// coverage lands here instead, mapped to the SAME model node). Spec §8.5/
// §8.6/§8.10's REWORK fix: `RoleAssignment.ambiguousRank1` (skeyR -> rank-1
// roleKey, for every scope `assignments` itself records as the literal
// `'-1'`) is the small, additive companion map that recovers what `'-1'`
// alone discards — see `RoleAssignment.ambiguousRank1`'s own doc in
// `roles.ts` for why `mine.ts`'s §8.5 half-weight role-cell counting needs
// it. This file pins ITS OWN shape/population rules directly; `mine.ts`'s
// consumption of it (half-weight role cells, seed injection, role_lift's
// n_eff) is pinned in `tests/unit/roots/mine-invariants.test.ts`.
// ---------------------------------------------------------------------------

/** A minimal, fully-shaped ScopeUnit — mirrors `roles.test.ts`'s own `unit()` exactly. */
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

/** N method-kind ScopeUnits sharing one exact feature bag — mirrors `roles.test.ts`'s own `typedGroup()`. */
function typedGroup(n: number, idPrefix: string, relPrefix: string, name: string, supertypes: string[] = []): ScopeUnit[] {
  return Array.from({ length: n }, (_, i) => {
    const idx = String(i + 1).padStart(4, '0');
    return unit({ kind: 'method', relPath: `${relPrefix}${i + 1}.ts`, name, supertypes, stableId: `${idPrefix}${idx}` });
  });
}

async function config(overridesYaml = '') {
  return defaultRootsConfig(overridesYaml);
}

describe('induceRoles — RoleAssignment.ambiguousRank1 (REWORK: the skeyR -> rank-1-roleKey companion to assignments\' "-1")', () => {
  it('an ambiguous scope carries a REAL roleKey in ambiguousRank1 (one of the two rival roles\' own keys) while assignments itself still reads "-1"', async () => {
    const cfg = await config();
    const guardMembers = typedGroup(4, 'gid', 'src/g', 'guard', ['CanActivate']);
    const serviceMembers = typedGroup(4, 'sid', 'src/s', 'service', ['Injectable']);
    // Identical construction to roles.test.ts's own "#k ordinal / '-1' marker"
    // fixture: a scope EQUIDISTANT between both roles (m1 = m2 = 0.25 against
    // each medoid) — ambiguous by both the gap rule and the roleMinMembership
    // floor.
    const clean = unit({ kind: 'method', relPath: 'src/h.ts', name: 'guard', stableId: 'h-clean', supertypes: ['CanActivate'] });
    const ambiguousFinal = unit({
      kind: 'method',
      relPath: 'src/h.ts',
      name: 'x',
      ordinal: 1,
      qualifiedName: 'guard#1',
      stableId: 'h-ambiguous',
      supertypes: ['CanActivate', 'Injectable'],
    });

    const result = induceRoles([...guardMembers, ...serviceMembers, clean, ambiguousFinal], () => 1, cfg);
    const roleKeys = new Set(result.roles.map((r) => r.roleKey));
    expect(roleKeys.size).toBe(2);

    const ambiguousKey = 'src/h.ts#method#guard#1';
    expect(result.assignments[ambiguousKey]).toBe('-1'); // assignments' own half is unchanged
    expect(result.ambiguousRank1[ambiguousKey]).toBeDefined();
    expect(result.ambiguousRank1[ambiguousKey]).not.toBe('-1');
    expect(roleKeys.has(result.ambiguousRank1[ambiguousKey])).toBe(true); // it names ONE of the two real roles, not a fabricated value

    // A CONFIDENT member (the non-ambiguous ordinal-0 "guard" scope) carries
    // no `ambiguousRank1` entry at all — the map is populated ONLY for the
    // scopes `assignments` itself marks `'-1'`.
    const confidentKey = 'src/h.ts#method#guard';
    expect(result.assignments[confidentKey]).not.toBe('-1');
    expect(Object.prototype.hasOwnProperty.call(result.ambiguousRank1, confidentKey)).toBe(false);
  });

  it('a scope with NO role at all (best membership below every floor) has no entry in EITHER map', async () => {
    const cfg = await config();
    // A single 2-member "worker" bucket — under minClusterSize (3, default)
    // — dropped whole, exactly like roles.test.ts's own minClusterSize test.
    const units = typedGroup(2, 'wid', 'src/w', 'worker', ['Runnable']);
    const result = induceRoles(units, () => 1, cfg);
    expect(result.roles).toHaveLength(0);
    expect(result.assignments['src/w1.ts#method#worker']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result.ambiguousRank1, 'src/w1.ts#method#worker')).toBe(false);
  });

  it('a fully non-ambiguous induction (two disjoint, confidently-classified roles) produces an EMPTY ambiguousRank1 — the map is never populated when nothing is ambiguous', async () => {
    const cfg = await config();
    const units = [...typedGroup(4, 'aid', 'src/a', 'guard', ['CanActivate']), ...typedGroup(4, 'bid', 'src/b', 'service', ['Injectable'])];
    const result = induceRoles(units, () => 1, cfg);
    expect(result.roles).toHaveLength(2);
    expect(Object.keys(result.ambiguousRank1)).toHaveLength(0);
  });
});
