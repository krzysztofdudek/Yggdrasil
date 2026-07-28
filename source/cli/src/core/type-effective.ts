import type { AspectStatus, Graph, GraphNode, Relation, RelationType } from '../model/graph.js';
import type { WhenEvalOverrides } from './when-evaluator.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from './graph/aspects.js';
import type { TypedEdgeIndex } from '../relations/pass.js';

/**
 * Rules that apply to a source file enforced by its architecture type alone,
 * with no component of its own.
 *
 * The file is represented as a throwaway subject view built for one call and
 * discarded: it is never added to the model, never handed to a check, and
 * never recorded anywhere. Building it this way means the ordinary rule
 * cascade — inheritance, bundles, status strength, applicability filters —
 * runs unchanged; there is exactly one cascade in this codebase
 * (`core/graph/aspects.ts`) and this module is not a second one.
 *
 * The subject's `parent` is the head of a synthesized chain of one throwaway
 * view per implicit ancestor type, so `collectAncestors` (already used by the
 * real cascade for channel 4, ancestor architecture-type aspects) walks it
 * exactly as it would a real node's real ancestors. The cascade itself runs
 * against a shallow `{ ...graph, flows: [] }` view: `nodes`, `aspects`, and
 * `architecture` are shared by reference (nothing virtual ever enters
 * `graph.nodes`), and `flows` is blanked so channel 5 (flow membership)
 * delivers nothing STRUCTURALLY rather than by relying on a path string never
 * colliding with a real flow participant id. If `Graph` ever gains a field the
 * cascade reads, this shallow copy carries it across correctly by
 * construction — but a future field holding a mutable index shared with the
 * caller would be aliased by a shallow copy; this view must stay a shallow
 * copy that is never mutated, never a deep clone.
 *
 * Never, by construction — nothing here ever reads or returns any of these:
 * description, log / log_required, flows, ports, the subject's own aspects
 * (it has none), an ancestor COMPONENT's own aspects (channel 2 — the
 * synthesized ancestor views carry no `meta.aspects`), or
 * `max_direct_relations`.
 */
export interface TypeEffectiveAspect {
  aspectId: string;
  status: AspectStatus;
  via: 'type' | 'parent-chain' | 'implies';
}

/** Why an aspect the architecture attaches to this file's type does not enforce on it. */
export type TypeAspectDropReason = 'when-not-satisfied' | 'draft';

export interface TypeAspectDrop {
  aspectId: string;
  reason: TypeAspectDropReason;
}

/** Ranks `via` for the stable (rank, id) ordering `computeTypeEffectiveAspects` returns. */
const VIA_RANK: Record<TypeEffectiveAspect['via'], number> = { type: 0, 'parent-chain': 1, implies: 2 };

/**
 * The only relation kinds derived import resolution can ever produce evidence
 * for. `emits` / `listens` are deliberately excluded — a resolved import is
 * never evidence of an event, so a derived relation of either kind would be a
 * fabrication; leaving them out of this list is what makes a `relations:
 * { emits: ... }` / `{ listens: ... }` predicate read false by construction,
 * with no separate branch needed.
 */
const DERIVED_RELATION_TYPES: readonly RelationType[] = ['uses', 'calls', 'extends', 'implements'];

/**
 * Effective aspects for one type-covered file, ordered: the matched type's own
 * defaults first, then each implicit ancestor type's defaults in chain order,
 * then aspects reached only by implication. Ties inside a rank break by aspect
 * id in code-point order, so the list is stable across runs and platforms.
 *
 * `edges` supplies the statically-resolved import edges leaving `file`. Omit
 * it and every structural relation atom in a `when:` predicate reads false —
 * the conservative reading, used by callers that have no edge index (unit
 * tests, and any caller running before the relation pass).
 */
export function computeTypeEffectiveAspects(
  graph: Graph,
  file: string,
  typeId: string,
  edges?: TypedEdgeIndex,
): TypeEffectiveAspect[] {
  return computeTypeAspectCascade(graph, file, typeId, edges).effective;
}

/**
 * One cascade pass producing both halves: what enforces, and what was
 * attached but does not. Callers that need both must use this — running the
 * two public halves separately pays the cascade twice.
 */
export function computeTypeAspectCascade(
  graph: Graph,
  file: string,
  typeId: string,
  edges?: TypedEdgeIndex,
): { effective: TypeEffectiveAspect[]; drops: TypeAspectDrop[] } {
  const matchedType = graph.architecture.node_types[typeId];
  if (!matchedType) return { effective: [], drops: [] };

  // 1. Walk the implicit parent chain: from the matched type, follow `parents`
  // while the entry names exactly one type that exists, stopping at a fork
  // (2+ entries), at absent/empty `parents`, or on revisiting a type already
  // on the chain (cycle). `chainTypeIds` is ordered nearest-parent-first.
  const chainTypeIds: string[] = [];
  {
    const onChain = new Set<string>([typeId]);
    let cur = typeId;
    for (;;) {
      const parents = graph.architecture.node_types[cur]?.parents;
      if (!parents || parents.length !== 1) break; // fork, or absent/empty parents
      const [parentId] = parents;
      if (!graph.architecture.node_types[parentId]) break; // dangling reference — never a real ancestor
      if (onChain.has(parentId)) break; // cycle — stop; the reachable prefix built so far stands
      onChain.add(parentId);
      chainTypeIds.push(parentId);
      cur = parentId;
    }
  }

  // 2. Build the ancestor views deepest-first, linking each to the next via
  // `parent`, so `collectAncestors(subject)` (channel 4's own traversal)
  // walks this chain exactly as it walks a real node's real ancestors.
  let ancestorView: GraphNode | null = null;
  for (let i = chainTypeIds.length - 1; i >= 0; i--) {
    const ancestorTypeId = chainTypeIds[i];
    ancestorView = {
      path: `#type:${ancestorTypeId}`,
      meta: { name: ancestorTypeId, type: ancestorTypeId },
      children: [],
      parent: ancestorView,
    };
  }

  // 3. Derived relations from `edges` (structural kinds only — type-blind: one
  // resolved import is evidence for every structural kind alike). A
  // node-owned target carries its real path, so the ordinary graph-lookup
  // fallback in `matchesRelation` already resolves both `target:` and
  // `target_type:` for it. A type-covered target has no node to name, so its
  // relation carries an empty `target:` (never equal to an author-written
  // one — the node-path validator rejects an empty path) and its type rides
  // in `targetTypeByRelation`, keyed by object identity since the shared
  // empty target string cannot distinguish one relation from another.
  const relations: Relation[] = [];
  const targetTypeByRelation = new Map<Relation, string>();
  for (const edge of edges?.edgesFrom(file) ?? []) {
    for (const kind of DERIVED_RELATION_TYPES) {
      if (edge.toOwner.kind === 'node') {
        relations.push({ target: edge.toOwner.path, type: kind });
      } else {
        const relation: Relation = { target: '', type: kind };
        targetTypeByRelation.set(relation, edge.toOwner.type);
        relations.push(relation);
      }
    }
  }

  // 4. The transient subject view. `meta.mapping = [file]` makes
  // `node.has_mapping` read true; the absence of `meta.ports` makes
  // `node.has_port` read false and starves channel 6 (no derived relation
  // ever carries `consumes`, so port matching would starve either way — K4).
  // `children: []` makes `descendants:` read false. `meta.aspects` /
  // `aspectWhens` / `aspectStatus` are absent, so channel 1 delivers nothing.
  const subject: GraphNode = {
    path: file,
    meta: { name: file, type: typeId, mapping: [file], relations },
    children: [],
    parent: ancestorView,
  };

  // 5. The transient graph view — see the module comment: shallow, never
  // mutated, `flows` blanked.
  const view: Graph = { ...graph, flows: [] };

  // 6. The one resolution override this cascade needs: a type-covered
  // relation's target type comes from the identity map built in step 3;
  // everything else (including every node-owned relation above) falls back
  // to the ordinary graph lookup, unchanged.
  const overrides: WhenEvalOverrides = {
    relationTargetType: (relation, g) =>
      targetTypeByRelation.get(relation) ?? g.nodes.get(relation.target)?.meta.type,
  };

  let effectiveIds: Set<string>;
  let statuses: Map<string, AspectStatus>;
  try {
    effectiveIds = computeEffectiveAspects(subject, view, overrides);
    statuses = computeEffectiveAspectStatuses(subject, view, overrides);
  } catch {
    // A cycle in the aspect `implies` graph (ImpliesCycleError) is a
    // structural fault the static validator (checkImpliesNoCycles) already
    // reports on its own path; re-throwing here would abort a caller
    // iterating over many type-covered files over one bad aspect definition.
    // This engine's contract is total — never throw, never drop the caller's
    // run — so ANY unexpected failure is absorbed the same way, yielding an
    // empty result for this one file rather than aborting the run.
    return { effective: [], drops: [] };
  }

  // `via` is decided declaratively, without a second cascade run: 'type' if
  // the id is declared directly on the matched type, else 'parent-chain' if
  // it is declared on any chain ancestor, else it was reached only by
  // implication.
  const viaOf = (id: string): TypeEffectiveAspect['via'] => {
    if (matchedType.aspects?.includes(id)) return 'type';
    if (chainTypeIds.some((t) => graph.architecture.node_types[t]?.aspects?.includes(id))) return 'parent-chain';
    return 'implies';
  };

  const effective: TypeEffectiveAspect[] = [...effectiveIds]
    .map((aspectId) => ({
      aspectId,
      // computeEffectiveAspects and computeEffectiveAspectStatuses are two
      // reducers over the identical (subject, view, overrides) input, so every
      // id the first yields always has an entry in the second; the fallback
      // only guards against that invariant ever slipping (never throw).
      status: statuses.get(aspectId) ?? 'enforced',
      via: viaOf(aspectId),
    }))
    .sort((a, b) => VIA_RANK[a.via] - VIA_RANK[b.via] || (a.aspectId < b.aspectId ? -1 : a.aspectId > b.aspectId ? 1 : 0));

  // `drops`: declaredAttached \ effective (reason: when-not-satisfied), plus
  // every effective id whose status is 'draft' (reason: draft).
  // `declaredAttached` is a plain reachability walk over `aspects:` (matched
  // type + its implicit ancestor chain) closed under `implies` — no `when`,
  // no status, no channel logic, so it is an enumeration of declared
  // attachment, not a second cascade.
  const declaredAttached = new Set<string>();
  {
    const idToAspect = new Map(graph.aspects.map((a) => [a.id, a] as const));
    const seedTypeIds = [typeId, ...chainTypeIds];
    const stack = seedTypeIds.flatMap((t) => graph.architecture.node_types[t]?.aspects ?? []);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (declaredAttached.has(id)) continue;
      declaredAttached.add(id);
      for (const implied of idToAspect.get(id)?.implies ?? []) stack.push(implied);
    }
  }

  const drops: TypeAspectDrop[] = [];
  for (const id of declaredAttached) {
    if (!effectiveIds.has(id)) drops.push({ aspectId: id, reason: 'when-not-satisfied' });
  }
  for (const id of effectiveIds) {
    if (statuses.get(id) === 'draft') drops.push({ aspectId: id, reason: 'draft' });
  }
  drops.sort((a, b) => (a.aspectId === b.aspectId ? a.reason.localeCompare(b.reason) : a.aspectId.localeCompare(b.aspectId)));

  return { effective, drops };
}
