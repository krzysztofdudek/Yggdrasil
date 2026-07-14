import type { Graph } from '../model/graph.js';
import {
  edgeUniverse,
  tunnelSpans,
  quotientAtDepth,
  changeReach,
  depthOfPath,
  lcaDepthOfPaths,
  ancestorAtDepth,
  TOP_TUNNELS,
  type DeclaredRelation,
  type StructEdge,
} from './engine-api.js';
import type { PortalStructure, PortalStructureTunnel, PortalStructureLayer } from './contract.js';

/**
 * derive-metrics — the pipeline's structure-panel derivation. It computes the SAME analysis
 * `yg structure` reports (dependency tunnels, module groups, change reach) as a JSON-flat
 * `PortalStructure`, reusing the wave-2 pure metrics core (`edgeUniverse` / `tunnelSpans` /
 * `quotientAtDepth` / `changeReach`) via the single facade re-export.
 *
 * Pure: no I/O, no graph mutation, no lock access, no YAML writer. It consumes plain data only —
 * the graph model (read for declared relations + node ids) and the ALREADY-FLATTENED detected-edge
 * set surfaced on the boundary seam. It reconstructs a `Map<string, Set<string>>` internally for
 * the metrics core, but the RETURNED shape is plain arrays/objects, so nothing that fails to
 * survive `JSON.stringify` (a Map serialises to `{}`) ever reaches `PortalData`. In particular,
 * `changeReach`'s per-node Map is dropped — only its scalar `mean` is carried.
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

/** The widest-spanning tunnels, ranked span-desc then (from, to), capped at TOP_TUNNELS. */
function topTunnels(edges: StructEdge[]): PortalStructureTunnel[] {
  const spanned = tunnelSpans(edges, depthOfPath, lcaDepthOfPaths);
  const ranked = [...spanned].sort((a, b) => {
    if (b.span !== a.span) return b.span - a.span;
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    return 0;
  });
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
 * Derive the JSON-flat structure panel. `detectedEdgesByNode` is the already-flattened detected-edge
 * set from the boundary seam; `null` means the relation parse could not run → UNKNOWN.
 */
export function deriveStructure(
  graph: Graph,
  detectedEdgesByNode: Array<{ from: string; targets: string[] }> | null,
): PortalStructure {
  // Null detected half → the parse threw → structure is unknown. Never fabricate a graph from the
  // declared relations alone: without the detected half the universe is incomplete, so the honest
  // answer is "unknown", mirroring the boundary's own unknown state.
  if (detectedEdgesByNode === null) {
    return { unknown: true, edgeCount: 0, nodeCount: 0, tunnels: [], layers: [], reachMean: 0, smallGraph: false };
  }

  const declared = collectDeclaredRelations(graph);
  // Reconstruct the Map the metrics core consumes from the flat seam shape. This Map is INTERNAL —
  // it never enters PortalData.
  const detected = new Map<string, Set<string>>();
  for (const e of detectedEdgesByNode) detected.set(e.from, new Set(e.targets));

  const edges = edgeUniverse(declared, detected);
  const nodeIds = [...graph.nodes.keys()];

  return {
    unknown: false,
    edgeCount: edges.length,
    nodeCount: nodeIds.length,
    tunnels: topTunnels(edges),
    layers: moduleLayers(edges),
    // Only the scalar mean is carried — changeReach's per-node Map is deliberately dropped at the
    // JSON seam (a Map would serialise to `{}`).
    reachMean: changeReach(edges, nodeIds).mean,
    smallGraph: nodeIds.length < REACH_CAPTION_MIN_NODES,
  };
}
