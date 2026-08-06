/**
 * Compute, for a (fromType → toType) node-type pair, which relation types the
 * architecture's allow-list permits between them.
 *
 * This reuses the SAME source of truth the `relation-target-forbidden` validator
 * reads (`checkArchitectureRelations` in core/checks/architecture.ts): the
 * per-type `relations:` table in yg-architecture.yaml, modelled as
 * `ArchitectureNodeType.relations` — a `Partial<Record<RelationType, string[]>>`
 * mapping each relation type to the node types it may target, and
 * `ArchitectureNodeType.relationDefault` — the policy for relation types NOT
 * listed in `relations`.
 *
 * Semantics mirror the validator exactly:
 *   - A relation type ABSENT from the `relations:` map is governed by
 *     `relationDefault` (undefined ⇒ 'allow'): 'allow' means any target is
 *     permitted; 'deny' means no target is permitted.
 *   - A relation type PRESENT in the map is allowed when `toType` is listed OR
 *     the list contains the wildcard `'*'` (any target). An empty list `[]`
 *     means no target is permitted for that relation type.
 *
 * When the `fromType` has no `relations:` table at all and no `relationDefault`,
 * every relation type is unconstrained (allow-all), so all six are returned.
 */
import type { ArchitectureDef, RelationType } from '../model/graph.js';

/** Canonical relation-type order for stable, deterministic message output. */
export const RELATION_TYPES: readonly RelationType[] = [
  'uses',
  'calls',
  'extends',
  'implements',
  'emits',
  'listens',
];

/**
 * Allowed relation types from `fromType` to `toType` under the architecture's
 * allow-list and default policy. Returns them in canonical `RELATION_TYPES`
 * order. An empty array means a dead-end: no relation type may connect those
 * two node types.
 *
 * Unknown node types (not declared in the architecture) yield an empty array —
 * there is no allow-list to consult, so nothing can be sanctioned.
 */
export function allowedRelationTypes(
  architecture: ArchitectureDef,
  fromType: string,
  toType: string,
): RelationType[] {
  const fromConfig = architecture.node_types[fromType];
  if (!fromConfig) return [];
  const lists = fromConfig.relations;
  const def = fromConfig.relationDefault ?? 'allow';

  const out: RelationType[] = [];
  for (const rt of RELATION_TYPES) {
    const allowedTargets = lists?.[rt];
    if (allowedTargets === undefined) {
      // Unlisted relation type → governed by the default policy.
      if (def === 'allow') out.push(rt);
      continue;
    }
    // Explicit list (including []). '*' matches any target type.
    if (allowedTargets.includes('*') || allowedTargets.includes(toType)) out.push(rt);
  }
  return out;
}
