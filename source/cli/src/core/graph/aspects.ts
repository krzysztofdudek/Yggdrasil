import type { Graph, GraphNode, AspectStatus, AspectDef, StatusInherit } from '../../model/graph.js';
import { STATUS_ORDER } from '../../model/graph.js';
import type { WhenPredicate } from '../../model/when.js';
import { evaluateWhen } from '../when-evaluator.js';
import { collectAncestors } from './traversal.js';
import { debugWrite } from '../../utils/debug-log.js';

/**
 * Thrown when implies expansion / status propagation encounters a cycle in the
 * aspect implies graph. Recognizable as a distinct class so callers (notably
 * `classifyDrift` in core/check.ts) can skip per-node drift computation on a
 * structurally-invalid graph WITHOUT swallowing unrelated errors. The static
 * validator (`checkImpliesNoCycles`) still produces the user-facing structured
 * `aspect-implies-cycle` issue — this error only signals "stop computing here".
 */
export class ImpliesCycleError extends Error {
  /** The aspect id at which the cycle was detected (best-effort). */
  readonly aspectId: string | undefined;
  constructor(message: string, aspectId?: string) {
    super(message);
    this.name = 'ImpliesCycleError';
    this.aspectId = aspectId;
  }
}

// ============================================================
// iterateAttachments — single source of truth for the channel walk
// ============================================================

/**
 * One aspect attachment reaching a node via one of channels 1–6.
 * Channel 7 (implies) is structural propagation, not an attachment.
 */
interface Attachment {
  channel: 1 | 2 | 3 | 4 | 5 | 6;
  aspectId: string;
  declaredStatus: AspectStatus | undefined;
  attachWhen: WhenPredicate | undefined;
  ancestor?: GraphNode; // channels 2, 4
  flow?: Graph['flows'][number]; // channel 5
  port?: { name: string; target: string }; // channel 6
}

/**
 * Yield every aspect attachment reaching `node` via channels 1–6, in channel
 * order: own → ancestor-node → own-type → ancestor-type → flow → port. This is
 * the ONE place the cascade channel-walk lives; `computeEffectiveAspects`,
 * `computeEffectiveAspectStatuses`, `getAspectSource`, and
 * `getAspectStatusSources` are all reducers over it, each applying its own
 * `when` policy, aggregation, and origin formatting. A flow matches if any of
 * its declared nodes is the node itself or one of its ancestors.
 */
function* iterateAttachments(node: GraphNode, graph: Graph): Generator<Attachment> {
  const ancestors = collectAncestors(node);

  // 1. Own aspects
  for (const id of node.meta.aspects ?? []) {
    yield { channel: 1, aspectId: id, declaredStatus: node.meta.aspectStatus?.[id], attachWhen: node.meta.aspectWhens?.[id] };
  }

  // 2. Ancestor node direct aspects
  for (const ancestor of ancestors) {
    for (const id of ancestor.meta.aspects ?? []) {
      yield { channel: 2, aspectId: id, declaredStatus: ancestor.meta.aspectStatus?.[id], attachWhen: ancestor.meta.aspectWhens?.[id], ancestor };
    }
  }

  // 3. Own architecture type aspects
  const ownType = graph.architecture?.node_types[node.meta.type];
  for (const id of ownType?.aspects ?? []) {
    yield { channel: 3, aspectId: id, declaredStatus: ownType?.aspectStatus?.[id], attachWhen: ownType?.aspectWhens?.[id] };
  }

  // 4. Ancestor architecture type aspects
  if (graph.architecture) {
    for (const ancestor of ancestors) {
      const typeDef = graph.architecture.node_types[ancestor.meta.type];
      for (const id of typeDef?.aspects ?? []) {
        yield { channel: 4, aspectId: id, declaredStatus: typeDef?.aspectStatus?.[id], attachWhen: typeDef?.aspectWhens?.[id], ancestor };
      }
    }
  }

  // 5. Flow aspects (flow matches if any of its nodes is the node or an ancestor)
  const allPaths = new Set<string>([node.path, ...ancestors.map((a) => a.path)]);
  for (const flow of graph.flows) {
    if (!flow.nodes.some((n) => allPaths.has(n))) continue;
    for (const id of flow.aspects ?? []) {
      yield { channel: 5, aspectId: id, declaredStatus: flow.aspectStatus?.[id], attachWhen: flow.aspectWhens?.[id], flow };
    }
  }

  // 6. Port consumption aspects (channel 6)
  for (const relation of node.meta.relations ?? []) {
    const targetNode = graph.nodes.get(relation.target);
    if (!targetNode?.meta.ports || !relation.consumes) continue;
    for (const portName of relation.consumes) {
      const port = targetNode.meta.ports[portName];
      if (!port?.aspects) continue;
      for (const id of port.aspects) {
        yield { channel: 6, aspectId: id, declaredStatus: port.aspectStatus?.[id], attachWhen: port.aspectWhens?.[id], port: { name: portName, target: relation.target } };
      }
    }
  }
}

/** An attachment passes iff both the aspect's global `when` and the attach-site `when` hold. */
function attachmentPasses(att: Attachment, node: GraphNode, graph: Graph): boolean {
  const aspectDef = graph.aspects.find((a) => a.id === att.aspectId);
  if (aspectDef?.when && !evaluateWhen(aspectDef.when, node, graph)) return false;
  if (att.attachWhen && !evaluateWhen(att.attachWhen, node, graph)) return false;
  return true;
}

// ============================================================
// computeEffectiveAspects
// ============================================================

/**
 * Compute the full set of effective aspects for a node from ALL 7 channels,
 * filtered by the 8th mechanism (`when` applicability predicate).
 *
 * Flow per channel:
 *   path_passes = evaluate(aspect.global_when) AND evaluate(attach_site.when)
 *
 * An aspect is effective on the node if AT LEAST ONE channel's path passes.
 * Implies expansion applies aspect.global_when on B and implier.impliesWhens[B]
 * additionally.
 */
export function computeEffectiveAspects(node: GraphNode, graph: Graph): Set<string> {
  const direct = new Set<string>();
  for (const att of iterateAttachments(node, graph)) {
    if (attachmentPasses(att, node, graph)) direct.add(att.aspectId);
  }
  // 7. Expand implies (filter global + per-implies when). A DRAFT (dormant)
  // implier must not propagate its implied aspect — so gate traversal on each
  // implier's effective status, mirroring computeEffectiveAspectStatuses.
  const statuses = computeEffectiveAspectStatuses(node, graph);
  return expandImpliesFiltered(direct, node, graph, statuses);
}

function expandImpliesFiltered(
  directIds: Set<string>,
  node: GraphNode,
  graph: Graph,
  statuses: Map<string, AspectStatus>,
): Set<string> {
  const idToAspect = new Map<string, typeof graph.aspects[number]>();
  for (const a of graph.aspects) idToAspect.set(a.id, a);

  const result = new Set<string>();
  const visited = new Set<string>();
  const stack = new Set<string>();

  const visit = (id: string, implierId: string | null): void => {
    if (stack.has(id)) {
      throw new ImpliesCycleError(`Aspect implies cycle detected involving aspect '${id}'`, id);
    }
    if (visited.has(id)) return;

    const aspectDef = idToAspect.get(id);
    if (aspectDef?.when && !evaluateWhen(aspectDef.when, node, graph)) {
      debugWrite(`[effective-aspects] node '${node.path}' aspect '${id}' filtered: global when=false (implies path)`);
      return;
    }

    if (implierId) {
      const implierDef = idToAspect.get(implierId);
      const perImplies = implierDef?.impliesWhens?.[id];
      if (perImplies && !evaluateWhen(perImplies, node, graph)) {
        debugWrite(`[effective-aspects] node '${node.path}' aspect '${id}' filtered: impliesWhens from '${implierId}' is false`);
        return;
      }
    }

    stack.add(id);
    visited.add(id);
    result.add(id);

    // A draft (dormant) implier does not propagate its implied aspects.
    const implies = aspectDef?.implies;
    if (implies && statuses.get(id) !== 'draft') {
      for (const implied of implies) {
        visit(implied, id);
      }
    }
    stack.delete(id);
  };

  for (const id of directIds) visit(id, null);
  return result;
}

// ============================================================
// getAspectSource — human-readable provenance (first match, ignores `when`)
// ============================================================

/**
 * Determine the source of an aspect for a node. Checks all 7 channels in order
 * and returns the first match (ignoring `when` — informational).
 */
export function getAspectSource(aspectId: string, node: GraphNode, graph: Graph): string {
  for (const att of iterateAttachments(node, graph)) {
    if (att.aspectId !== aspectId) continue;
    return attachmentSourceLabel(att, node);
  }
  // 7. Implied by another aspect
  for (const otherAspect of graph.aspects) {
    if (otherAspect.implies?.includes(aspectId)) {
      return `implied by '${otherAspect.id}'`;
    }
  }
  return 'unknown source';
}

/** Human-readable origin label for an attachment (used by yg context / impact). */
function attachmentSourceLabel(att: Attachment, node: GraphNode): string {
  switch (att.channel) {
    case 1:
      return 'own declaration';
    case 2:
      return `inherited from parent '${att.ancestor!.path}'`;
    case 3:
      return `architecture (type: ${node.meta.type})`;
    case 4:
      return `inherited from parent (type: ${att.ancestor!.meta.type})`;
    case 5: {
      const flow = att.flow!;
      if (flow.nodes.includes(node.path)) return `flow '${flow.path}'`;
      const viaAncestor = collectAncestors(node).find((a) => flow.nodes.includes(a.path));
      if (viaAncestor) return `flow '${flow.path}' (via parent '${viaAncestor.path}')`;
      return `flow '${flow.path}'`;
    }
    case 6:
      return `port '${att.port!.name}' on '${att.port!.target}'`;
  }
}

// ============================================================
// computeEffectiveAspectStatuses — channels 1–6 + implies fix-point
// ============================================================

function maxStatus(a: AspectStatus | undefined, b: AspectStatus): AspectStatus {
  if (a === undefined) return b;
  return STATUS_ORDER[a] >= STATUS_ORDER[b] ? a : b;
}

function aspectDefaultStatus(graph: Graph, aspectId: string): AspectStatus {
  const def = graph.aspects.find(a => a.id === aspectId);
  return def?.status ?? 'enforced';
}

/**
 * Compute effective status per aspect for a node. Covers channels 1–6 plus
 * implies propagation.
 *
 * Returns a Map keyed by aspect id; only contains entries reachable via at
 * least one channel after `when` filtering.
 *
 * NOTE — this fix-point intentionally does NOT throw on an implies cycle. The
 * iteration is monotone (max over a finite 3-level lattice), so on a cyclic
 * graph it SATURATES and returns rather than diverging. It must not abort,
 * because validation-path checks (e.g. aspect-contract checks) call it BEFORE
 * the authoritative cycle detector `checkImpliesNoCycles` runs — a throw here
 * would pre-empt the clean, blocking `aspect-implies-cycle` error. A cyclic
 * graph is rejected by that validator. The parallel computeEffectiveAspects
 * DOES throw ImpliesCycleError (via its DFS in expandImpliesFiltered), but that
 * path is only reached during drift/approve, where callers wrap it. The two
 * functions therefore diverge on a structurally-invalid graph BY DESIGN.
 *
 * @see computeEffectiveAspects for the parallel id-only set
 */
export function computeEffectiveAspectStatuses(node: GraphNode, graph: Graph): Map<string, AspectStatus> {
  const result = new Map<string, AspectStatus>();

  for (const att of iterateAttachments(node, graph)) {
    if (!attachmentPasses(att, node, graph)) continue;
    const effective = att.declaredStatus ?? aspectDefaultStatus(graph, att.aspectId);
    result.set(att.aspectId, maxStatus(result.get(att.aspectId), effective));
  }

  // Implies fix-point. Monotone (max only) over a finite 3-level lattice, so it
  // ALWAYS converges — it saturates rather than diverging on a cyclic graph.
  // Cycle DETECTION is not done here (see the note above); it is the global
  // validator's job. Draft aspects do not propagate.
  const idToAspect = new Map<string, AspectDef>();
  for (const a of graph.aspects) idToAspect.set(a.id, a as AspectDef);

  let changed = true;
  let iterations = 0;
  const maxIterations = graph.aspects.length + 2;
  while (changed) {
    if (++iterations > maxIterations) {
      // Unreachable for a monotone fix-point (it provably converges); a pure
      // defensive backstop against a future bug in the loop body. This is NOT a
      // cycle detector — a cycle saturates and converges; cycles are rejected by
      // the global validator (checkImpliesNoCycles).
      throw new ImpliesCycleError('implies fix-point exceeded its iteration bound (internal invariant violated)');
    }
    changed = false;
    const currentIds = [...result.keys()];
    for (const implierId of currentIds) {
      const implierStatus = result.get(implierId)!;
      if (implierStatus === 'draft') continue;
      const implierDef = idToAspect.get(implierId);
      if (!implierDef?.implies) continue;
      for (const impliedId of implierDef.implies) {
        const impliedDef = idToAspect.get(impliedId);
        const globalWhen = impliedDef?.when;
        if (globalWhen && !evaluateWhen(globalWhen, node, graph)) continue;
        const perEdgeWhen = implierDef.impliesWhens?.[impliedId];
        if (perEdgeWhen && !evaluateWhen(perEdgeWhen, node, graph)) continue;

        const inheritMode: StatusInherit = implierDef.impliesStatusInherit?.[impliedId] ?? 'strictest';
        const impliedDefault: AspectStatus = impliedDef?.status ?? 'enforced';
        const declared: AspectStatus = inheritMode === 'own-default'
          ? impliedDefault
          : (STATUS_ORDER[implierStatus] >= STATUS_ORDER[impliedDefault] ? implierStatus : impliedDefault);

        const prior = result.get(impliedId);
        const next = maxStatus(prior, declared);
        if (prior === undefined || STATUS_ORDER[next] > STATUS_ORDER[prior]) {
          result.set(impliedId, next);
          changed = true;
        }
      }
    }
  }

  return result;
}

// ============================================================
// getAspectStatusSources — per-channel provenance (channels 1–6, `when`-filtered)
// ============================================================

/**
 * Channels 1-6 only. Channel 7 (implies) is structural propagation, not a
 * direct attach declaration, so it never produces an AttachSource entry.
 */
export interface AttachSource {
  channel: 1 | 2 | 3 | 4 | 5 | 6;
  origin: string;
  declared: AspectStatus;
}

/**
 * Return per-channel provenance for an aspect's status on a node. Used by
 * validator (downgrade detection) and display paths (yg context, yg impact).
 */
export function getAspectStatusSources(node: GraphNode, aspectId: string, graph: Graph): AttachSource[] {
  const sources: AttachSource[] = [];
  const defaultStatus = graph.aspects.find((a) => a.id === aspectId)?.status ?? 'enforced';

  for (const att of iterateAttachments(node, graph)) {
    if (att.aspectId !== aspectId) continue;
    if (!attachmentPasses(att, node, graph)) continue;
    sources.push({ channel: att.channel, origin: attachmentMachineOrigin(att, node), declared: att.declaredStatus ?? defaultStatus });
  }

  return sources;
}

/** Machine-readable origin token for an attachment (used by downgrade detection). */
function attachmentMachineOrigin(att: Attachment, node: GraphNode): string {
  switch (att.channel) {
    case 1:
      return `own:${node.path}`;
    case 2:
      return `ancestor:${att.ancestor!.path}`;
    case 3:
      return `type:${node.meta.type}`;
    case 4:
      return `ancestor-type:${att.ancestor!.meta.type}@${att.ancestor!.path}`;
    case 5:
      return `flow:${att.flow!.path}`;
    case 6:
      return `port:${att.port!.name}@${att.port!.target}`;
  }
}

/**
 * Single source of truth for "this node has reviewer work to do".
 */
export function hasNonDraftEffectiveAspects(node: GraphNode, graph: Graph): boolean {
  const statuses = computeEffectiveAspectStatuses(node, graph);
  for (const [aspectId, s] of statuses) {
    if (s === 'draft') continue;
    if (isAggregateAspect(graph, aspectId)) continue;
    return true;
  }
  return false;
}

/**
 * An aggregating aspect (`reviewer.type === 'aggregate'`) is a content-less,
 * check-less bundle that only `implies` other aspects. It is EFFECTIVE on a node
 * (so its implied children expand via channel 7) but has NO own reviewer and NO
 * own verdict. Every verdict-expecting path — buildAspectVerdicts, the
 * newly-active detection in approve, and the per-aspect emission in check — must
 * exclude it; otherwise, being effective + non-draft with no reviewer result, it
 * would be carried forward or flagged as aspect-newly-active and block CI.
 */
export function isAggregateAspect(graph: Graph, aspectId: string): boolean {
  return graph.aspects.find(a => a.id === aspectId)?.reviewer.type === 'aggregate';
}

/**
 * Infer an aspect's TRUE reviewer kind for DISPLAY the way the parser infers it —
 * from rule-source presence, NOT the declared `reviewer.type` field (which a
 * mis-authored yaml can contradict, e.g. an implies-only bundle that copy-pasted
 * `reviewer:\n  type: llm` with no content.md):
 *   - content.md present        → 'llm'
 *   - check.mjs present         → 'deterministic'
 *   - neither, implies declared → 'aggregate'
 *   - none of the above         → the declared reviewer.type (last resort)
 * Rule-source presence is read off the already-loaded `artifacts` (the loader
 * captures every file in the aspect dir except yg-aspect.yaml), so this re-reads
 * nothing from disk. Display/metadata only — NEVER folded into a verdict hash.
 */
export function inferAspectDisplayKind(aspect: AspectDef): 'llm' | 'deterministic' | 'aggregate' {
  const has = (filename: string): boolean => aspect.artifacts.some((a) => a.filename === filename);
  if (has('content.md')) return 'llm';
  if (has('check.mjs')) return 'deterministic';
  if (aspect.implies && aspect.implies.length > 0) return 'aggregate';
  return aspect.reviewer.type;
}
