import type { ArchitectureDef } from '../model/graph.js';
import { allowedRelationTypes } from '../core/allowed-relation-types.js';
import type { TypedEdgeIndex } from './pass.js';

export interface TypeGateFinding {
  fromType: string;
  toType: string;
  edges: Array<{ fromFile: string; toFile: string }>;
}

/**
 * Live type-to-type relation gate over statically-resolved import edges whose
 * endpoints are BOTH classified (an explicit node's declared type, or a
 * type-covered file's matched type). Never evaluated for an edge into an
 * ambiguous or unmatched file — those never appear as a toOwner in
 * TypedEdgeIndex at all, so this function cannot see them and needs no
 * exclusion logic of its own for that case.
 *
 * Runs LIVE on every `yg check` (never cached, never in the lock) — the same
 * posture as the relation-conformance pass's own `relation-undeclared-
 * dependency` check, which this gate is additive to, not a replacement for:
 * that check governs edges between two EXPLICIT nodes with a declared
 * relations list; this gate additionally covers edges reaching a type-covered
 * file, which has no yg-node.yaml of its own to declare a relation in.
 */
export function computeTypeGateFindings(
  architecture: ArchitectureDef,
  typedEdges: TypedEdgeIndex,
  fileOwnerType: Map<string, string>,
): TypeGateFinding[] {
  const byPair = new Map<string, TypeGateFinding>();
  for (const [fromFile, fromType] of fileOwnerType) {
    for (const edge of typedEdges.edgesFrom(fromFile)) {
      const toType = edge.toOwner.type;
      const allowed = allowedRelationTypes(architecture, fromType, toType);
      if (allowed.length > 0) continue; // at least one relation type sanctions this pair
      const key = `${fromType}->${toType}`;
      let finding = byPair.get(key);
      if (!finding) {
        finding = { fromType, toType, edges: [] };
        byPair.set(key, finding);
      }
      finding.edges.push({ fromFile, toFile: edge.toFile });
    }
  }
  return [...byPair.values()];
}
