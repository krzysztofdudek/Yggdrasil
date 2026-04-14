import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Graph, GraphNode, FlowDef } from '../model/graph.js';
import type { DriftCategory, TrackedFileLayer } from '../model/drift.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { collectAncestors } from './context-builder.js';
import { computeEffectiveAspects } from './effective-aspects.js';

export interface TrackedFile {
  path: string;           // relative to project root
  category: DriftCategory;  // 'source' or 'graph'
  layer: TrackedFileLayer;  // which context layer brought this file into tracking
  syntheticHash?: string; // when present, use this hash instead of reading from disk
}

const STRUCTURAL_RELATION_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);

/**
 * Collect all files tracked by a node's context package.
 * Mirrors the traversal of build-context but returns file paths
 * instead of rendered content. This is the core function for
 * bidirectional drift detection.
 *
 * Synchronous — no I/O needed; all data comes from the loaded Graph.
 */
export function collectTrackedFiles(node: GraphNode, graph: Graph): TrackedFile[] {
  const seen = new Set<string>();
  const result: TrackedFile[] = [];

  // Compute the .yggdrasil prefix relative to project root.
  // graph.rootPath is absolute path to .yggdrasil/; project root is its parent.
  const projectRoot = path.dirname(graph.rootPath);
  const yggPrefix = path.relative(projectRoot, graph.rootPath);
  // Normalize to forward slashes for consistency
  const yggPrefixNormalized = yggPrefix.replace(/\\/g, '/').replace(/\/+$/, '');

  function addFile(filePath: string, category: DriftCategory, layer: TrackedFileLayer): void {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    result.push({ path: filePath, category, layer });
  }

  function addSyntheticHash(
    key: string,
    content: string,
    category: DriftCategory,
    layer: TrackedFileLayer,
  ): void {
    if (seen.has(key)) return;
    seen.add(key);
    const hash = createHash('sha256').update(content).digest('hex');
    result.push({ path: key, category, layer, syntheticHash: hash });
  }

  function graphPath(...segments: string[]): string {
    return [yggPrefixNormalized, ...segments].join('/');
  }

  // 1. OWN — synthetic hash of aspect-relevant yg-node.yaml subset (type, aspects, relations, ports)
  // Only the subset is tracked — description-only changes do NOT trigger upstream drift.
  const ownSubset = {
    type: node.meta.type,
    aspects: node.meta.aspects,
    relations: node.meta.relations,
    ports: node.meta.ports,
  };
  addSyntheticHash(
    `own-subset:${node.path}`,
    JSON.stringify(ownSubset),
    'graph',
    'hierarchy',
  );

  // 2. HIERARCHICAL — ancestors from root to parent (yg-node.yaml only)
  const ancestors = collectAncestors(node);
  for (const ancestor of ancestors) {
    addFile(graphPath('model', ancestor.path, 'yg-node.yaml'), 'graph', 'hierarchy');
  }

  // 3. ASPECTS — use computeEffectiveAspects for ALL aspects from all 7 channels
  const participatingFlows = collectParticipatingFlows(graph, node, ancestors);
  const allAspectIds = computeEffectiveAspects(node, graph);

  for (const aspectId of allAspectIds) {
    const aspect = graph.aspects.find(a => a.id === aspectId);
    if (!aspect) continue;
    addFile(graphPath('aspects', aspect.id, 'yg-aspect.yaml'), 'graph', 'aspects');
    for (const art of aspect.artifacts) {
      addFile(graphPath('aspects', aspect.id, art.filename), 'graph', 'aspects');
    }
  }

  // 4. RELATIONAL-DEPS — structural relations (uses/calls/extends/implements)
  for (const relation of node.meta.relations ?? []) {
    if (!STRUCTURAL_RELATION_TYPES.has(relation.type)) continue;
    const target = graph.nodes.get(relation.target);
    if (!target) continue;

    // Track dependency yg-node.yaml only
    addFile(graphPath('model', target.path, 'yg-node.yaml'), 'graph', 'relational');

    // Track ports hash only (not full yg-node.yaml) — scoped cascade
    // This ensures only port aspect changes cascade to dependents,
    // not unrelated target metadata changes (description, relations, mapping)
    if (target.meta.ports && Object.keys(target.meta.ports).length > 0) {
      const portsJson = JSON.stringify(target.meta.ports);
      addSyntheticHash(
        `port-aspects:${target.path}`,
        portsJson,
        'graph',
        'relational',
      );
    }

    // Track dependency ancestor yg-node.yaml files
    const depAncestors = collectAncestors(target);
    for (const ancestor of depAncestors) {
      addFile(graphPath('model', ancestor.path, 'yg-node.yaml'), 'graph', 'relational');
    }
  }

  // 4b. EVENT RELATIONS — emits/listens targets + their ancestors
  for (const relation of node.meta.relations ?? []) {
    if (relation.type !== 'emits' && relation.type !== 'listens') continue;
    const target = graph.nodes.get(relation.target);
    if (!target) continue;

    // Track dependency yg-node.yaml only
    addFile(graphPath('model', target.path, 'yg-node.yaml'), 'graph', 'relational');

    // Include target's ancestors (yg-node.yaml only)
    const eventAncestors = collectAncestors(target);
    for (const ancestor of eventAncestors) {
      addFile(graphPath('model', ancestor.path, 'yg-node.yaml'), 'graph', 'relational');
    }
  }

  // 5. RELATIONAL-FLOWS — yg-flow.yaml only for participating flows
  for (const flow of participatingFlows) {
    addFile(graphPath('flows', flow.path, 'yg-flow.yaml'), 'graph', 'flows');
  }

  // 6. SOURCE — files from mapping.paths
  const mappingPaths = normalizeMappingPaths(node.meta.mapping);
  for (const p of mappingPaths) {
    addFile(p, 'source', 'source');
  }

  return result;
}

/**
 * Find all flows where the node or any of its ancestors is a participant.
 * Same logic as collectParticipatingFlows in context-builder.ts.
 */
function collectParticipatingFlows(
  graph: Graph,
  node: GraphNode,
  ancestors: GraphNode[],
): FlowDef[] {
  const paths = new Set<string>([node.path, ...ancestors.map((a) => a.path)]);
  return graph.flows.filter((f) => f.nodes.some((n) => paths.has(n)));
}
