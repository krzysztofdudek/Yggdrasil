import type { Graph } from '../../model/graph.js';
import { computeNodeMappedFiles } from '../../core/pairs.js';
import type { SourceFileCountMarkerInput } from '../contract.js';

/**
 * portal/api/source-file-counts — the panel's real per-node file count, behind
 * the portal facade.
 *
 * Compute per-node source FILE COUNT — the number the panel shows next to
 * `mappingEntryCount` so an adopter can see both what a node DECLARES (entries) and
 * what it actually OWNS (files) at a glance. Reuses `computeNodeMappedFiles`, the
 * SAME exclusion-aware, child-carve-out-aware expansion the node's own source
 * fingerprint is built from: a file excluded from graph coverage is never counted,
 * and a file a more specific descendant node also maps is counted only for that
 * descendant. A mapping-less node's expansion is empty, so it reads 0 — never a
 * fabricated "some files somewhere."
 *
 * Read-only; reuses the engine's own mapped-file expansion so the portal's count
 * can never diverge from what the node's fingerprint / subject set actually cover.
 */
export async function computePortalSourceFileCounts(graph: Graph): Promise<SourceFileCountMarkerInput[]> {
  const out: SourceFileCountMarkerInput[] = [];
  for (const nodePath of graph.nodes.keys()) {
    const files = await computeNodeMappedFiles(graph, nodePath);
    out.push({ nodePath, sourceFileCount: files.length });
  }
  return out;
}
