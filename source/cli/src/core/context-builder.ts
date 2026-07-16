import type { Graph } from '../model/graph.js';
import type { NodeContextData } from '../formatters/context-node.js';
import type { FileContextData } from '../formatters/context-file.js';
import { normalizeMappingPaths } from '../io/paths.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses, getAspectSource } from './graph/aspects.js';
import { toPosixPath } from '../utils/posix.js';
import {
  collectAncestors,
  collectParticipatingFlows,
  collectDependencyAncestors,
  type DependencyAncestorInfo,
} from './graph/index.js';

// Re-export shim — preserves the public import path for legacy callers.
// Folded into direct imports in a later cleanup sweep.
export { collectAncestors, collectDependencyAncestors, type DependencyAncestorInfo };

const STRUCTURAL_RELATION_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);
const EVENT_RELATION_TYPES = new Set(['emits', 'listens']);

/** Normalize a path for output: replace backslashes with forward slashes and strip trailing slashes. */
function normPath(p: string): string {
  return toPosixPath(p);
}


/**
 * Compute how many nodes have a structural relation targeting nodePath.
 */
function countDependents(graph: Graph, nodePath: string): { count: number; paths: string[] } {
  const paths: string[] = [];
  for (const [path, node] of graph.nodes) {
    const hasRelation = (node.meta.relations ?? []).some(
      r => r.target === nodePath && (STRUCTURAL_RELATION_TYPES.has(r.type) || EVENT_RELATION_TYPES.has(r.type)),
    );
    if (hasRelation) paths.push(path);
  }
  return { count: paths.length, paths };
}

export function buildNodeContextData(graph: Graph, nodePath: string): NodeContextData {
  const normalizedNodePath = toPosixPath(nodePath);
  const node = graph.nodes.get(nodePath);
  if (!node) throw new Error(`Node not found: ${nodePath}`);

  const ancestors = collectAncestors(node);
  const participatingFlows = collectParticipatingFlows(graph, node);

  const effectiveAspectIds = computeEffectiveAspects(node, graph);
  const effectiveStatuses = computeEffectiveAspectStatuses(node, graph);

  const aspects = Array.from(effectiveAspectIds).map(aspectId => {
    const aspectDef = graph.aspects.find(a => a.id === aspectId);
    const source = getAspectSource(aspectId, node, graph);
    const refs = aspectDef?.reviewer?.type === 'llm' && aspectDef.references && aspectDef.references.length > 0
      ? aspectDef.references.map(r => ({ path: toPosixPath(r.path), description: r.description }))
      : undefined;
    const status = effectiveStatuses.get(aspectId) ?? aspectDef?.status ?? 'enforced';
    const companionReadPath = aspectDef?.reviewer?.type === 'llm' && aspectDef.hasCompanion
      ? `.yggdrasil/aspects/${aspectId}/companion.mjs`
      : undefined;
    return {
      id: aspectId,
      name: aspectDef?.name ?? aspectId,
      description: aspectDef?.description ?? '',
      source,
      verifiedAgainst: aspectDef?.reviewer?.type === 'deterministic'
        ? `.yggdrasil/aspects/${aspectId}/check.mjs`
        : aspectDef?.reviewer?.type === 'aggregate'
          ? `.yggdrasil/aspects/${aspectId}/yg-aspect.yaml`
          : `.yggdrasil/aspects/${aspectId}/content.md`,
      implies: aspectDef?.implies,
      status,
      ...(refs && { references: refs }),
      ...(companionReadPath && { companionReadPath }),
    };
  });

  const flows = participatingFlows.map(f => ({
    id: normPath(f.path),
    name: f.name,
    description: f.description ?? '',
    readPath: `flows/${normPath(f.path)}/yg-flow.yaml`,
  }));

  const ancestorPaths = new Set(ancestors.map(a => a.path));
  const dependencies = (node.meta.relations ?? [])
    .filter(r => !ancestorPaths.has(r.target) && (STRUCTURAL_RELATION_TYPES.has(r.type) || EVENT_RELATION_TYPES.has(r.type)))
    .map(r => {
      const target = graph.nodes.get(r.target);
      return {
        path: normPath(r.target),
        relation: r.type,
        description: target?.meta.description,
        readPath: `model/${normPath(r.target)}/yg-node.yaml`,
        consumes: r.consumes,
      };
    });

  const { count: dependentCount, paths: dependentPaths } = countDependents(graph, nodePath);

  const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : undefined;

  const sourceFiles = normalizeMappingPaths(node.meta.mapping);

  return {
    path: normalizedNodePath,
    name: node.meta.name,
    type: node.meta.type,
    description: node.meta.description,
    sourceFiles,
    aspects,
    flows,
    dependencies,
    dependentCount,
    dependentPaths: dependentCount <= 5 ? dependentPaths?.map(p => normPath(p)) : undefined,
    parentPath: parent ? normPath(parent.path) : undefined,
    parentType: parent?.meta.type,
    parentReadPath: parent ? `model/${normPath(parent.path)}/yg-node.yaml` : undefined,
    ...(node.meta.maxDirectRelations && { maxDirectRelations: node.meta.maxDirectRelations }),
  };
}

export function buildFileContextData(graph: Graph, filePath: string, ownerPath: string): FileContextData {
  const node = graph.nodes.get(ownerPath);
  if (!node) throw new Error(`Node not found: ${ownerPath}`);

  const normalizedFilePath = toPosixPath(filePath);
  const normalizedOwnerPath = toPosixPath(ownerPath);
  const ancestors = collectAncestors(node);

  const effectiveAspectIds = computeEffectiveAspects(node, graph);
  const effectiveStatuses = computeEffectiveAspectStatuses(node, graph);

  const aspects = Array.from(effectiveAspectIds).map(aspectId => {
    const aspectDef = graph.aspects.find(a => a.id === aspectId);
    const refs = aspectDef?.reviewer?.type === 'llm' && aspectDef.references && aspectDef.references.length > 0
      ? aspectDef.references.map(r => ({ path: toPosixPath(r.path), description: r.description }))
      : undefined;
    const status = effectiveStatuses.get(aspectId) ?? aspectDef?.status ?? 'enforced';
    const companionReadPath = aspectDef?.reviewer?.type === 'llm' && aspectDef.hasCompanion
      ? `.yggdrasil/aspects/${aspectId}/companion.mjs`
      : undefined;
    return {
      aspectId,
      aspectDescription: aspectDef?.description ?? aspectDef?.name ?? aspectId,
      verifiedAgainst: aspectDef?.reviewer?.type === 'deterministic'
        ? `.yggdrasil/aspects/${aspectId}/check.mjs`
        : aspectDef?.reviewer?.type === 'aggregate'
          ? `.yggdrasil/aspects/${aspectId}/yg-aspect.yaml`
          : `.yggdrasil/aspects/${aspectId}/content.md`,
      status,
      ...(refs && { references: refs }),
      ...(companionReadPath && { companionReadPath }),
    };
  });

  const ancestorPathsSet = new Set(ancestors.map(a => a.path));
  const dependencies = (node.meta.relations ?? [])
    .filter(r => !ancestorPathsSet.has(r.target) && STRUCTURAL_RELATION_TYPES.has(r.type))
    .map(r => ({
      path: normPath(r.target),
      consumed: r.consumes ?? [],
    }));

  const { count: dependentCount } = countDependents(graph, ownerPath);

  return {
    filePath: normalizedFilePath,
    ownerPath: normalizedOwnerPath,
    ownerType: node.meta.type,
    aspects,
    dependencies,
    dependentCount,
  };
}
