import type { Graph } from '../model/graph.js';
import {
  edgeUniverse,
  quotientAtDepth,
  changeReach,
  depthOfPath,
  ancestorAtDepth,
  widenedTunnelMetrics,
  rankTunnels,
  TOP_TUNNELS,
  type DeclaredRelation,
  type StructEdge,
} from './engine-api.js';
import type { PortalStructure, PortalStructureTunnel, PortalStructureLayer } from './contract.js';

/**
 * The optional type-level widening `deriveStructure` merges in — the SAME shape `yg
 * structure`'s own `StructureTypeWidening` carries (edges touching a type-covered file, plus
 * the files themselves as extra node ids), computed by the pipeline (which alone may reach the
 * facade's classifier + live type-relation gate) and passed in here so this module stays pure.
 */
export interface StructureTypeWidening {
  edges: StructEdge[];
  nodeIds: string[];
}

/**
 * derive-metrics — the pipeline's structure-panel derivation. It computes the SAME analysis
 * `yg structure` reports (dependency tunnels, module groups, change reach) as a JSON-flat
 * `PortalStructure`, reusing the wave-2 pure metrics core (`edgeUniverse` / `tunnelSpans` /
 * `rankTunnels` / `quotientAtDepth` / `changeReach`) via the single facade re-export — including,
 * at `coverage.type_level` on, the SAME type-level widening `yg structure` merges into its own
 * universe (`widened`, above): the panel is never left node-only while the CLI widens.
 *
 * Pure: no I/O, no graph mutation, no lock access, no YAML writer. It consumes plain data only —
 * the graph model (read for declared relations + node ids), the ALREADY-FLATTENED detected-edge
 * set surfaced on the boundary seam, and the already-computed type-level widening (edges + extra
 * node ids) the impure pipeline obtained through the facade. It reconstructs a `Map<string,
 * Set<string>>` internally for the metrics core, but the RETURNED shape is plain arrays/objects,
 * so nothing that fails to survive `JSON.stringify` (a Map serialises to `{}`) ever reaches
 * `PortalData`. In particular, `changeReach`'s per-node Map is dropped — only its scalar `mean`
 * is carried.
 *
 * Honesty: a `null` detected set (the relation parse threw) yields an explicit UNKNOWN structure —
 * never a fabricated empty/zero graph — mirroring `buildBoundary`'s `unknown: true`. Below the
 * node-count floor the "average component" reach caption is not statistically meaningful, so the
 * panel is flagged `smallGraph` and the frontend shows the raw figure WITHOUT that sentence.
 */

/**
 * Node-count floor for the interpretive change-reach caption. Below this many nodes the "average
 * component reaches X% of the system" sentence generalises from too small a population to mean
 * anything, so the panel drops the sentence and shows the raw fraction only (small-N honesty). The
 * value is a deliberate judgement call, kept as a named constant so the floor is one obvious knob.
 */
export const REACH_CAPTION_MIN_NODES = 10;

/** True iff `a` and `b` are the same node or one is an ancestor of the other. */
function isLineage(a: string, b: string): boolean {
  return a === b || b.startsWith(a + '/') || a.startsWith(b + '/');
}

/**
 * Fold the graph's declared relations into the plain-data shape the metrics core consumes. Only
 * relations whose target is a real node and which are NOT a lineage pair (parent/child/self) are
 * kept — mirroring the detected-edge semantics (an edge is always between two distinct, unrelated
 * nodes). Event relations pass through unfiltered here; `edgeUniverse` drops the ones that are
 * neither structural nor a port contract. (Same rule the `yg structure` command applies, so both
 * surfaces report the identical universe.)
 */
function collectDeclaredRelations(graph: Graph): DeclaredRelation[] {
  const out: DeclaredRelation[] = [];
  for (const [nodeId, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (!graph.nodes.has(rel.target)) continue;
      if (isLineage(nodeId, rel.target)) continue;
      out.push({ from: nodeId, to: rel.target, type: rel.type, consumes: rel.consumes ?? [] });
    }
  }
  return out;
}

/**
 * The widest-spanning tunnels, ranked span-desc then (from, to), capped at TOP_TUNNELS.
 * `realNodeIds` is the graph's own node id set — reused (via `widenedTunnelMetrics`, the SAME
 * function `yg structure` calls) so a type-covered file folded into `edges` is measured at its
 * own fixed, shallow depth rather than its incidental on-disk directory nesting: the two
 * surfaces rank tunnels in the identical comparable unit, never one comparing filesystem depth
 * against architecture depth while the other does not.
 */
function topTunnels(edges: StructEdge[], realNodeIds: ReadonlySet<string>): PortalStructureTunnel[] {
  const { depthOf, lcaDepth } = widenedTunnelMetrics(realNodeIds);
  const ranked = rankTunnels(edges, depthOf, lcaDepth);
  return ranked.slice(0, TOP_TUNNELS).map((e) => ({
    from: e.from,
    to: e.to,
    span: e.span,
    viaContract: e.viaContract,
    origin: e.origin,
  }));
}

/**
 * Module-group layers: for each depth of the tree that resolves to 2+ groups, the groups and how
 * they depend on one another. `loopShare` is the fraction of cross-group dependencies that form a
 * loop (1 − the share that flows one way), so a fully one-way level reports 0.
 */
function moduleLayers(edges: StructEdge[]): PortalStructureLayer[] {
  const layers: PortalStructureLayer[] = [];
  if (edges.length === 0) return layers;

  // Beyond the deepest endpoint the quotient stops collapsing, so iterate only up to that depth.
  let maxDepth = 1;
  for (const e of edges) maxDepth = Math.max(maxDepth, depthOfPath(e.from), depthOfPath(e.to));

  for (let depth = 1; depth <= maxDepth; depth++) {
    const q = quotientAtDepth(edges, depth, ancestorAtDepth);
    if (q.blocks.length < 2) continue; // a single group has nothing to depend on — skip the level
    layers.push({
      depth,
      groups: q.blocks,
      crossings: q.interBlockEdges.length,
      loopShare: 1 - q.sccOutsideShare,
    });
  }
  return layers;
}

/**
 * Derive the JSON-flat structure panel — the SAME analysis `yg structure` renders, over the SAME
 * widened universe when the type-level tier is on. `detectedEdgesByNode` is the already-flattened
 * detected-edge set from the boundary seam; `null` means the relation parse could not run →
 * UNKNOWN. `widened` is the OPTIONAL type-level augmentation the pipeline computes through the
 * facade's live type-relation gate (mirroring `yg structure`'s own `computeTypeWidening`) —
 * omitted (or with an empty `nodeIds`), the panel is exactly today's node-only rendering,
 * byte-identical.
 */
export function deriveStructure(
  graph: Graph,
  detectedEdgesByNode: Array<{ from: string; targets: string[] }> | null,
  widened?: StructureTypeWidening,
): PortalStructure {
  // Null detected half → the parse threw → structure is unknown. Never fabricate a graph from the
  // declared relations alone: without the detected half the universe is incomplete, so the honest
  // answer is "unknown", mirroring the boundary's own unknown state.
  if (detectedEdgesByNode === null) {
    return {
      unknown: true,
      edgeCount: 0,
      nodeCount: 0,
      tunnels: [],
      layers: [],
      reachMean: 0,
      smallGraph: false,
      hasTypeCovered: false,
    };
  }

  const declared = collectDeclaredRelations(graph);
  // Reconstruct the Map the metrics core consumes from the flat seam shape. This Map is INTERNAL —
  // it never enters PortalData.
  const detected = new Map<string, Set<string>>();
  for (const e of detectedEdgesByNode) detected.set(e.from, new Set(e.targets));

  const baseEdges = edgeUniverse(declared, detected);
  const baseNodeIds = [...graph.nodes.keys()];
  const hasTypeCovered = !!widened && widened.nodeIds.length > 0;
  const edges = hasTypeCovered ? [...baseEdges, ...(widened as StructureTypeWidening).edges] : baseEdges;
  const nodeIds = hasTypeCovered ? [...baseNodeIds, ...(widened as StructureTypeWidening).nodeIds] : baseNodeIds;

  return {
    unknown: false,
    edgeCount: edges.length,
    nodeCount: nodeIds.length,
    tunnels: topTunnels(edges, new Set(baseNodeIds)),
    layers: moduleLayers(edges),
    // Only the scalar mean is carried — changeReach's per-node Map is deliberately dropped at the
    // JSON seam (a Map would serialise to `{}`).
    reachMean: changeReach(edges, nodeIds).mean,
    smallGraph: nodeIds.length < REACH_CAPTION_MIN_NODES,
    hasTypeCovered,
  };
}
