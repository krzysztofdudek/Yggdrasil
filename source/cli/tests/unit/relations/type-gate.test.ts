/**
 * Pure unit tests for computeTypeGateFindings — the live type-to-type relation gate's
 * decision function. No fixture, no runCheck, no file I/O: a hand-built TypedEdgeIndex
 * and fileOwnerType map are enough since the function is a pure decision over those two
 * inputs plus the architecture's allow-list (allowedRelationTypes).
 */
import { describe, it, expect } from 'vitest';
import { computeTypeGateFindings } from '../../../src/relations/type-gate.js';
import type { TypedEdgeIndex } from '../../../src/relations/pass.js';
import type { ArchitectureDef } from '../../../src/model/graph.js';

// NOTE: relationDefault is a field SIBLING to relations (ArchitectureNodeType), not a
// 'default' key nested inside the relations map — that nested spelling is a YAML-only
// convenience the real parser (parseRelations) translates into this top-level field;
// a hand-built ArchitectureDef must set it directly, which is what these helpers do.
function arch(
  overrides: Record<string, { relations?: { calls?: string[] }; relationDefault?: 'allow' | 'deny' }> = {},
): ArchitectureDef {
  return {
    node_types: {
      svc: { description: 'svc', relations: { calls: [] }, relationDefault: 'deny' },
      util: { description: 'util' }, // no relations table -> vacuous allow
      owner: { description: 'owner type' },
      ...overrides,
    },
  } as unknown as ArchitectureDef;
}

function indexOf(
  edges: Record<
    string,
    Array<{ toFile: string; toOwner: { kind: 'node'; path: string; type: string } | { kind: 'type-covered'; type: string } }>
  >,
): TypedEdgeIndex {
  return { edgesFrom: (file) => edges[file] ?? [] };
}

describe('computeTypeGateFindings — pure gate decision', () => {
  it('blocks an edge whose (fromType, toType) pair has no allowed relation type', () => {
    const typedEdges = indexOf({
      'src/a.ts': [{ toFile: 'src/b.ts', toOwner: { kind: 'node', path: 'owner', type: 'owner' } }],
    });
    const findings = computeTypeGateFindings(arch(), typedEdges, new Map([['src/a.ts', 'svc']]));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ fromType: 'svc', toType: 'owner' });
    expect(findings[0].edges).toEqual([{ fromFile: 'src/a.ts', toFile: 'src/b.ts' }]);
  });

  it('allows an edge when the source type has NO relations table at all (vacuous allow)', () => {
    const typedEdges = indexOf({
      'src/a.ts': [{ toFile: 'src/b.ts', toOwner: { kind: 'type-covered', type: 'owner' } }],
    });
    const findings = computeTypeGateFindings(arch(), typedEdges, new Map([['src/a.ts', 'util']]));
    expect(findings).toEqual([]);
  });

  it("allows an edge explicitly listed in the source type's relations table", () => {
    const a = arch({ svc: { description: 'svc', relations: { calls: ['util'] }, relationDefault: 'deny' } } as any);
    const typedEdges = indexOf({
      'src/a.ts': [{ toFile: 'src/b.ts', toOwner: { kind: 'type-covered', type: 'util' } }],
    });
    const findings = computeTypeGateFindings(a, typedEdges, new Map([['src/a.ts', 'svc']]));
    expect(findings).toEqual([]);
  });

  it('aggregates multiple edges of the SAME (fromType, toType) pair into one finding', () => {
    const typedEdges = indexOf({
      'src/a.ts': [
        { toFile: 'src/b.ts', toOwner: { kind: 'node', path: 'owner', type: 'owner' } },
        { toFile: 'src/c.ts', toOwner: { kind: 'node', path: 'owner', type: 'owner' } },
      ],
    });
    const findings = computeTypeGateFindings(arch(), typedEdges, new Map([['src/a.ts', 'svc']]));
    expect(findings).toHaveLength(1);
    expect(findings[0].edges).toHaveLength(2);
  });

  it('a file absent from fileOwnerType (ambiguous/unmatched source) contributes no findings', () => {
    const typedEdges = indexOf({
      'src/ambiguous.ts': [{ toFile: 'src/b.ts', toOwner: { kind: 'node', path: 'owner', type: 'owner' } }],
    });
    const findings = computeTypeGateFindings(arch(), typedEdges, new Map()); // nothing resolves a fromType
    expect(findings).toEqual([]);
  });
});
