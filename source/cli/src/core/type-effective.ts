import type { AspectStatus, Graph, GraphNode, Relation, RelationType } from '../model/graph.js';
import type { WhenEvalOverrides } from './when-evaluator.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses, ImpliesCycleError } from './graph/aspects.js';
import type { TypedEdgeIndex } from '../relations/pass.js';
import { debugWrite } from '../utils/debug-log.js';

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
 * The subset of `computeTypeEffectiveAspects`'s result that could actually
 * produce a pair for a file enforced by its type alone: a `per: node`
 * (whole-unit) aspect is excluded, since there is no component for it to run
 * on for a nodeless file — it is cascade-effective (attached, `when`
 * satisfied) but structurally unreachable there, forever.
 *
 * The dead-law linters (`checkAspectEffectiveNowhere`,
 * `checkArchitectureDefaultAspectUnreachable`) union THIS set in for their
 * type-covered files, not the raw cascade-effective set: unioning the raw set
 * would count a whole-unit rule reachable only through type coverage as live,
 * even though it can never produce a verdict there — "dead law that looks
 * enforced" would silently stop being reported the moment a single file
 * matched the type. `scope.files` / binary-subject exclusions are NOT applied
 * here (unlike `pairs.ts`'s own nodeless enumeration): those depend on this
 * one file's content, and a DIFFERENT file of the same type might satisfy
 * them, so they must not disqualify the aspect from ever counting as reachable
 * for the type as a whole — only the file-invariant `per: node` gate does.
 */
/**
 * Whether `aspectId`'s cascade-effective outcome could still produce a pair
 * for a nodeless (type-covered) subject — the one predicate
 * `computeTypeReachableAspects` filters its raw list by. Extracted so a
 * caller that already holds the raw `computeTypeEffectiveAspects` list in
 * hand (for example to also tell "excluded because whole-unit" apart from
 * "never cascade-effective at all") applies the SAME rule without forcing a
 * second cascade run just to get it from `computeTypeReachableAspects` itself.
 *
 * false for an aspect id with no matching definition (aspect-undefined is a
 * separate error, never a reachability route), true unconditionally for an
 * aggregate (never itself a review subject, so scope never applies), else
 * true only for `scope.per === 'file'` — a whole-unit (`per: node`, the
 * default) rule has no component to run on for a nodeless file.
 */
export function isReachableForTypeCoveredFile(graph: Graph, aspectId: string): boolean {
  const aspectDef = graph.aspects.find((a) => a.id === aspectId);
  if (!aspectDef) return false;
  if (aspectDef.reviewer.type === 'aggregate') return true;
  return (aspectDef.scope?.per ?? 'node') === 'file';
}

export function computeTypeReachableAspects(
  graph: Graph,
  file: string,
  typeId: string,
  edges?: TypedEdgeIndex,
): TypeEffectiveAspect[] {
  return computeTypeEffectiveAspects(graph, file, typeId, edges).filter((e) =>
    isReachableForTypeCoveredFile(graph, e.aspectId),
  );
}

/**
 * One cascade pass producing both halves: what enforces, and what was
 * attached but does not. Callers that need both must use this — running the
 * two public halves separately pays the cascade twice.
 *
 * Exception contract: an aspect `implies` cycle (`ImpliesCycleError`) is
 * absorbed, yielding an empty `effective`/`drops` for this one file — the
 * static validator already reports the cycle on its own path (`yg check`'s
 * blocking `aspect-implies-cycle`), and re-throwing would abort a caller
 * iterating over many type-covered files over one bad aspect definition. The
 * absorbed cycle is NOT hidden entirely, though: it is also returned as
 * `cycle`, so a caller that answers about ONE specific file (`yg context
 * --file`'s type-covered path) can say plainly that this type's rules could
 * not be worked out, instead of reading the empty `effective` as "nothing
 * applies" — a caller that iterates many files and already has its own
 * cycle-reporting path (`computeExpectedPairs`) is free to ignore it. Any
 * OTHER failure is NOT swallowed: it is a genuine bug in this cascade or its
 * inputs, so it is recorded to the debug log and rethrown rather than hidden
 * forever behind a silent empty result. Callers that iterate many files
 * (`computeExpectedPairs`) wrap this call in their OWN per-file catch,
 * mirroring the same containment their per-node loop already uses for a real
 * component.
 */

/** An aspect `implies` cycle absorbed by `computeTypeAspectCascade` — see its exception contract above. */
export interface TypeCascadeCycle {
  /** The aspect id at which the cycle was detected (best-effort — the underlying `ImpliesCycleError`'s own field; absent for the rare iteration-bound-exceeded variant). */
  aspectId: string | undefined;
}

/**
 * The `why` clause for an absorbed cascade cycle, shared VERBATIM by every
 * surface that reports one — `yg owner --file`, `yg context --file`, and `yg
 * check`'s per-type block/zero-enforcement rollup — so the wording can never
 * drift between them. Each surface still writes its own `what`/`next` around
 * this, since those differ (a single-file error vs. a repo-wide summary).
 */
export function describeCascadeCycle(cycle: TypeCascadeCycle): string {
  return `The aspect graph has an implies cycle${cycle.aspectId ? ` at '${cycle.aspectId}'` : ''} — the cascade cannot tell which of the type's rules apply until that cycle is broken.`;
}
/**
 * Why the implicit parent-chain walk (below) stopped where it did, computed
 * once per type — independent of any one file. `candidates` names the parent
 * ids at a fork (sorted, code-point order), the single type the walk cannot
 * revisit at a cycle, or the type the chain ends AT for the other two reasons.
 */
export interface ChainTermination {
  reason: 'fork' | 'no-parents' | 'empty-parents' | 'cycle';
  candidates: string[];
}

export interface ChainWalkResult {
  /** Nearest-parent-first reachable prefix — exactly what the cascade below walks. */
  chainTypeIds: string[];
  termination: ChainTermination;
}

/**
 * Walk the implicit parent chain: from `typeId`, follow `parents` while the
 * entry names exactly one type that exists, stopping at a fork (2+ entries),
 * at absent/empty `parents`, or on revisiting a type already on the chain
 * (cycle). Extracted from `computeTypeAspectCascade` so a caller that needs to
 * report WHERE and WHY the chain stops (not just the reachable prefix, which
 * is all the cascade itself consumes) does not re-derive this walk.
 */
export function walkTypeParentChain(graph: Graph, typeId: string): ChainWalkResult {
  const chainTypeIds: string[] = [];
  const onChain = new Set<string>([typeId]);
  let cur = typeId;
  for (;;) {
    const parents = graph.architecture.node_types[cur]?.parents;
    if (!parents) return { chainTypeIds, termination: { reason: 'no-parents', candidates: [cur] } };
    if (parents.length === 0) return { chainTypeIds, termination: { reason: 'empty-parents', candidates: [cur] } };
    if (parents.length >= 2) return { chainTypeIds, termination: { reason: 'fork', candidates: [...parents].sort() } };
    const [parentId] = parents;
    // A dangling parent reference is validated away elsewhere (checkTypeUnknownParent) —
    // a graph that passed validation can never take this branch. Defensive only, so it
    // is folded into 'no-parents' rather than given its own public reason.
    if (!graph.architecture.node_types[parentId]) return { chainTypeIds, termination: { reason: 'no-parents', candidates: [cur] } };
    if (onChain.has(parentId)) return { chainTypeIds, termination: { reason: 'cycle', candidates: [parentId] } };
    onChain.add(parentId);
    chainTypeIds.push(parentId);
    cur = parentId;
  }
}

/**
 * The full set of aspect ids reachable from `typeId` and its chain by
 * declared attachment (`aspects:`) closed under `implies` — no `when`, no
 * status, no channel logic, so it is an enumeration of declared attachment,
 * not a second cascade. Extracted from `computeTypeAspectCascade` so a caller
 * that needs "what could this type ever enforce" (before `when` narrows it)
 * does not re-derive the walk.
 */
export function computeDeclaredAttachedAspects(graph: Graph, typeId: string, chainTypeIds: string[]): Set<string> {
  const declaredAttached = new Set<string>();
  const idToAspect = new Map(graph.aspects.map((a) => [a.id, a] as const));
  const seedTypeIds = [typeId, ...chainTypeIds];
  const stack = seedTypeIds.flatMap((t) => graph.architecture.node_types[t]?.aspects ?? []);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (declaredAttached.has(id)) continue;
    declaredAttached.add(id);
    for (const implied of idToAspect.get(id)?.implies ?? []) stack.push(implied);
  }
  return declaredAttached;
}

export function computeTypeAspectCascade(
  graph: Graph,
  file: string,
  typeId: string,
  edges?: TypedEdgeIndex,
): { effective: TypeEffectiveAspect[]; drops: TypeAspectDrop[]; cycle?: TypeCascadeCycle } {
  const matchedType = graph.architecture.node_types[typeId];
  if (!matchedType) return { effective: [], drops: [] };

  // 1. Walk the implicit parent chain (nearest-parent-first reachable prefix) —
  // see walkTypeParentChain's own doc for the stop conditions.
  const { chainTypeIds } = walkTypeParentChain(graph, typeId);

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
  // ever carries `consumes`, so port matching would starve either way).
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
  } catch (e) {
    // A cycle in the aspect `implies` graph (ImpliesCycleError) is a
    // structural fault the static validator (checkImpliesNoCycles) already
    // reports on its own path; re-throwing here would abort a caller
    // iterating over many type-covered files over one bad aspect definition,
    // so it is the ONE failure this cascade absorbs, yielding an empty result
    // for this one file rather than aborting the run.
    //
    // Narrowed (not a blanket catch-all): an unexpected failure that is NOT
    // ImpliesCycleError is a genuine bug in this cascade or its inputs, and
    // swallowing it silently would hide that bug from every caller forever —
    // debugWrite records it (so it is visible with debug logging on) and
    // rethrows, so the caller's own containment (mirroring the node-loop's
    // per-node catch in computeExpectedPairs) decides whether to skip just
    // this one file or fail the run.
    if (e instanceof ImpliesCycleError) {
      return { effective: [], drops: [], cycle: { aspectId: e.aspectId } };
    }
    debugWrite(`[type-effective] unexpected failure computing the cascade for '${file}' (type '${typeId}'): ${e instanceof Error ? e.message : String(e)}`);
    throw e;
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
  const declaredAttached = computeDeclaredAttachedAspects(graph, typeId, chainTypeIds);

  const drops: TypeAspectDrop[] = [];
  for (const id of declaredAttached) {
    if (!effectiveIds.has(id)) drops.push({ aspectId: id, reason: 'when-not-satisfied' });
  }
  for (const id of effectiveIds) {
    if (statuses.get(id) === 'draft') drops.push({ aspectId: id, reason: 'draft' });
  }
  // Code-point order (never locale): a caller now RENDERS this list, so its
  // ordering must be stable and identical on every platform/locale.
  drops.sort((a, b) => (a.aspectId !== b.aspectId ? (a.aspectId < b.aspectId ? -1 : 1) : (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)));

  return { effective, drops };
}
