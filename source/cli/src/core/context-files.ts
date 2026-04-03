import path from 'node:path';
import { createHash } from 'node:crypto';
import { STANDARD_ARTIFACTS } from '../model/types.js';
import type { Graph, GraphNode, DriftCategory, FlowDef, TrackedFileLayer } from '../model/types.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { collectAncestors, resolveAspects } from './context-builder.js';

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
  const yggPrefixNormalized = yggPrefix.split(path.sep).join('/');

  const configArtifactKeys = new Set(Object.keys(STANDARD_ARTIFACTS));

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

  function addNodeFilesWithLayer(n: GraphNode, layer: TrackedFileLayer): void {
    // yg-node.yaml
    addFile(graphPath('model', n.path, 'yg-node.yaml'), 'graph', layer);
    // artifacts filtered by config
    for (const art of n.artifacts) {
      if (configArtifactKeys.has(art.filename)) {
        addFile(graphPath('model', n.path, art.filename), 'graph', layer);
      }
    }
  }

  // 1. OWN — yg-node.yaml + config-filtered artifacts
  addNodeFilesWithLayer(node, 'own');

  // 2. HIERARCHICAL — ancestors from root to parent
  const ancestors = collectAncestors(node);
  for (const ancestor of ancestors) {
    addNodeFilesWithLayer(ancestor, 'hierarchy');
  }

  // 3. ASPECTS — resolve all aspects from own + ancestors + flows (with recursive implies)
  // First, collect all aspect ids from own node and ancestors
  const allAspectIds = new Set<string>();

  for (const entry of node.meta.aspects ?? []) {
    allAspectIds.add(entry.aspect);
  }
  for (const ancestor of ancestors) {
    for (const entry of ancestor.meta.aspects ?? []) {
      allAspectIds.add(entry.aspect);
    }
  }

  // Collect participating flows (same logic as build-context)
  const participatingFlows = collectParticipatingFlows(graph, node, ancestors);

  // Add flow-propagated aspects
  for (const flow of participatingFlows) {
    for (const id of flow.aspects ?? []) {
      allAspectIds.add(id);
    }
  }

  // Resolve with recursive implies
  const resolvedAspects = resolveAspects(allAspectIds, graph.aspects);
  for (const aspect of resolvedAspects) {
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

    // Determine which artifacts to include from the target
    const structuralFilenames = Object.entries(STANDARD_ARTIFACTS)
      .filter(([, c]) => c.included_in_relations)
      .map(([filename]) => filename);

    // Check if the target actually has any of the included_in_relations artifacts
    const structuralArts = structuralFilenames.filter((filename) =>
      target.artifacts.some((a) => a.filename === filename),
    );

    if (structuralArts.length > 0) {
      // Use only included_in_relations artifacts that exist on target
      for (const filename of structuralArts) {
        addFile(graphPath('model', target.path, filename), 'graph', 'relational');
      }
    } else {
      // Fallback: all config-allowed artifacts
      for (const art of target.artifacts) {
        if (configArtifactKeys.has(art.filename)) {
          addFile(graphPath('model', target.path, art.filename), 'graph', 'relational');
        }
      }
    }

    // Track integration_aspects hash only (not full yg-node.yaml) — scoped cascade
    // This ensures only integration_aspects changes cascade to dependents,
    // not unrelated target metadata changes (description, relations, mapping)
    if (target.meta.integration_aspects && target.meta.integration_aspects.length > 0) {
      const anchorsJson = JSON.stringify(target.meta.integration_aspects.sort());
      addSyntheticHash(
        `integration-anchors:${target.path}`,
        anchorsJson,
        'graph',
        'relational',
      );
    }

    // Track dependency ancestors — always runs, independent of structuralArts check above
    const depAncestors = collectAncestors(target);
    for (const ancestor of depAncestors) {
      // Use included_in_relations artifacts if available, else fall back to all config artifacts
      const filterFilenames = structuralFilenames.length > 0 ? structuralFilenames : [...configArtifactKeys];
      for (const filename of filterFilenames) {
        if (ancestor.artifacts.some((a) => a.filename === filename)) {
          addFile(graphPath('model', ancestor.path, filename), 'graph', 'relational');
        }
      }
    }
  }

  // 4b. EVENT RELATIONS — emits/listens targets + their ancestors
  for (const relation of node.meta.relations ?? []) {
    if (relation.type !== 'emits' && relation.type !== 'listens') continue;
    const target = graph.nodes.get(relation.target);
    if (!target) continue;

    const structuralFilenames = Object.entries(STANDARD_ARTIFACTS)
      .filter(([, c]) => c.included_in_relations)
      .map(([filename]) => filename);
    const filterFilenames = structuralFilenames.length > 0 ? structuralFilenames : [...configArtifactKeys];

    // Include target's artifacts
    for (const filename of filterFilenames) {
      if (target.artifacts.some((a) => a.filename === filename)) {
        addFile(graphPath('model', target.path, filename), 'graph', 'relational');
      }
    }

    // Include target's ancestors (same filter)
    const eventAncestors = collectAncestors(target);
    for (const ancestor of eventAncestors) {
      for (const filename of filterFilenames) {
        if (ancestor.artifacts.some((a) => a.filename === filename)) {
          addFile(graphPath('model', ancestor.path, filename), 'graph', 'relational');
        }
      }
    }
  }

  // 5. RELATIONAL-FLOWS — yg-flow.yaml + flow artifacts for participating flows
  for (const flow of participatingFlows) {
    addFile(graphPath('flows', flow.path, 'yg-flow.yaml'), 'graph', 'flows');
    for (const art of flow.artifacts) {
      addFile(graphPath('flows', flow.path, art.filename), 'graph', 'flows');
    }
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
