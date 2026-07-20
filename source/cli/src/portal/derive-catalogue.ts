import type { Graph, AspectDef, FlowDef } from '../model/graph.js';
import {
  collectDescendants,
  computeEffectiveAspects,
  type VerifiedPair,
} from './engine-api.js';
import { displayPairState } from './derive-nodes.js';
import type {
  PortalAspect,
  PortalAspectTally,
  PortalFlow,
  PortalFlowState,
  PortalType,
  PortalPairState,
} from './contract.js';

/**
 * derive-catalogue — the aspect catalogue, flow catalogue, and architecture
 * type model.
 *
 * Pure over the graph + the already-verified pairs (VerifiedPair states). Three
 * HONEST renderings are preserved throughout: an aggregating aspect "judges
 * nothing"; a rule-bearing aspect with zero expected pairs "verifies nothing"; a
 * flow whose participants are all no-rule is "nothing-checked", never green. No
 * re-hash, no lock write, no LLM call.
 */

// ── Aspect catalogue ────────────────────────────────────────────────────────

/** Build the aspect catalogue. `pairs` are the verified pairs (states attached). */
export function buildAspects(graph: Graph, pairs: VerifiedPair[]): PortalAspect[] {
  // Group verified-pair states by aspect id for the V/R/U tally and unit count.
  const byAspect = new Map<string, PortalPairState[]>();
  for (const vp of pairs) {
    const list = byAspect.get(vp.pair.aspectId) ?? [];
    list.push(collapsePairState(vp));
    byAspect.set(vp.pair.aspectId, list);
  }

  return graph.aspects
    .map((def) => buildAspect(def, graph, byAspect.get(def.id) ?? []))
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

function collapsePairState(vp: VerifiedPair): PortalPairState {
  // Status-adjusted: an advisory refusal reads `warning` in the tally, never a blocking `refused`.
  return displayPairState(vp.state.kind, vp.pair.status);
}

function buildAspect(def: AspectDef, graph: Graph, states: PortalPairState[]): PortalAspect {
  const kind = def.reviewer.type;
  const status = def.status ?? 'enforced';
  const scope: 'node' | 'file' = def.scope?.per === 'file' ? 'file' : 'node';
  const ruleProse = def.artifacts.find((a) => a.filename === 'content.md')?.content;
  const checkSource = def.artifacts.find((a) => a.filename === 'check.mjs')?.content;

  return {
    id: def.id,
    name: def.name,
    kind,
    status,
    scope,
    hasWhen: def.when !== undefined,
    implies: def.implies ?? [],
    // Optional content fields assigned directly — an undefined value is omitted by the
    // JSON.stringify embed, so no conditional spread is needed (and none is left half-covered).
    description: def.description,
    ruleProse,
    checkSource,
    tally: buildTally(def, graph, status, states),
  };
}

/**
 * The three honest renderings:
 *   - aggregate  → "judges nothing" (a content-less bundle: no own reviewer/verdict).
 *   - vacuous    → "verifies nothing" with a resolved reason (draft, no effective
 *                  node, or scope/when excludes every subject) — zero expected pairs.
 *   - normal     → V/R/W/U over the aspect's expected pairs (W = advisory refusals, shown as
 *                  non-blocking warnings, never folded into the blocking `refused` count).
 */
function buildTally(
  def: AspectDef,
  graph: Graph,
  status: AspectDef['status'],
  states: PortalPairState[],
): PortalAspectTally {
  if (def.reviewer.type === 'aggregate') {
    return { render: 'aggregate' };
  }
  if (states.length === 0) {
    return { render: 'vacuous', reason: vacuousReason(def, graph, status) };
  }
  let verified = 0;
  let refused = 0;
  let warning = 0;
  let unverified = 0;
  for (const s of states) {
    if (s === 'verified') verified += 1;
    else if (s === 'refused') refused += 1;
    else if (s === 'warning') warning += 1;
    else unverified += 1;
  }
  return { render: 'normal', verified, refused, warning, unverified, units: states.length };
}

/** Explain WHY a rule-bearing aspect resolves to zero expected pairs. */
function vacuousReason(def: AspectDef, graph: Graph, status: AspectDef['status']): string {
  if ((status ?? 'enforced') === 'draft') {
    return 'draft — produces no expected pairs (parked, not yet enforced)';
  }
  // Effective on at least one node? (the cascade reaches a node)
  const reachesANode = [...graph.nodes.values()].some((n) =>
    computeEffectiveAspects(n, graph).has(def.id),
  );
  if (!reachesANode) {
    return 'not effective on any node — no attach channel reaches a node';
  }
  // Reaches a node but still no pairs: the subject set is empty (scope.files /
  // when excludes every subject, or the owning nodes map no readable source).
  return 'effective on a node but every subject set is empty (scope/when excludes all files, or no mapped source)';
}

// ── Flow catalogue ──────────────────────────────────────────────────────────

/**
 * Build the flow catalogue. Participants = declared `flow.nodes` PLUS every
 * descendant of each declared participant (engine semantics: adding a parent
 * covers its children). The flow state is honest: 'nothing-checked' when no
 * participant carries a rule, 'attention' when any participant pair is
 * refused/unverified, else 'verified'.
 */
export function buildFlows(
  graph: Graph,
  nodeStateOf: (path: string) => PortalPairState[] | undefined,
): PortalFlow[] {
  return graph.flows
    .map((flow) => buildFlow(flow, graph, nodeStateOf))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function buildFlow(
  flow: FlowDef,
  graph: Graph,
  nodeStateOf: (path: string) => PortalPairState[] | undefined,
): PortalFlow {
  const participants = expandParticipants(flow, graph);
  const state = computeFlowState(participants, graph, nodeStateOf);
  return {
    name: flow.name,
    ...(flow.description ? { description: flow.description } : {}),
    participants,
    aspects: flow.aspects ?? [],
    state,
  };
}

/** Declared participants plus their auto-expanded descendants (deduped, sorted). */
function expandParticipants(flow: FlowDef, graph: Graph): string[] {
  const out = new Set<string>();
  for (const path of flow.nodes) {
    out.add(path);
    const node = graph.nodes.get(path);
    if (node) {
      for (const d of collectDescendants(node)) out.add(d.path);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'en'));
}

function computeFlowState(
  participants: string[],
  graph: Graph,
  nodeStateOf: (path: string) => PortalPairState[] | undefined,
): PortalFlowState {
  let anyChecked = false;
  let anyAttention = false;
  for (const path of participants) {
    const node = graph.nodes.get(path);
    if (!node) continue;
    // `checked` is driven by the presence of a REAL verdict-bearing pair, not by mere
    // aspect effectiveness. A participant with a non-draft effective aspect but zero
    // expected pairs (empty mapping, all-vacuous subject set) produces no pair state and
    // contributes nothing checked — seeding a flow green off it would fabricate a green
    // over a node nothing actually checks. Mirrors derive-nodes.ts's `checked` computation.
    const states = nodeStateOf(path) ?? [];
    if (states.length === 0) continue;
    anyChecked = true;
    if (states.some((s) => s === 'refused' || s === 'unverified')) anyAttention = true;
  }
  if (!anyChecked) return 'nothing-checked';
  return anyAttention ? 'attention' : 'verified';
}

// ── Architecture type model ─────────────────────────────────────────────────

/**
 * Build the architecture type model: per type the description, allowed parents,
 * the allowed-relations matrix, default aspects, strict/log flags, and a live
 * node-count over the graph.
 */
export function buildTypes(graph: Graph): PortalType[] {
  // Live node count per type.
  const countByType = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    countByType.set(node.meta.type, (countByType.get(node.meta.type) ?? 0) + 1);
  }

  const types: PortalType[] = [];
  for (const [id, def] of Object.entries(graph.architecture?.node_types ?? {})) {
    const allowedRelations: Record<string, string[]> = {};
    for (const [relType, targets] of Object.entries(def.relations ?? {})) {
      allowedRelations[relType] = [...(targets ?? [])];
    }
    types.push({
      id,
      ...(def.description ? { description: def.description } : {}),
      parents: def.parents ?? [],
      allowedRelations,
      defaultAspects: def.aspects ?? [],
      strict: def.enforce === 'strict',
      logRequired: def.log_required === true,
      nodeCount: countByType.get(id) ?? 0,
    });
  }
  return types.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}
