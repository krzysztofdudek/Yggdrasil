import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Graph,
  GraphNode,
  YggConfig,
  AspectDef,
  FlowDef,
  Relation,
} from '../model/graph.js';
import type {
  ContextLayer,
} from '../model/context.js';
import type { NodeContextData } from '../formatters/context-node.js';
import type { FileContextData } from '../formatters/context-file.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { computeEffectiveAspects, getAspectSource } from './effective-aspects.js';

const STRUCTURAL_RELATION_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);
const EVENT_RELATION_TYPES = new Set(['emits', 'listens']);

function collectParticipatingFlows(graph: Graph, node: GraphNode): FlowDef[] {
  const paths = new Set<string>([node.path, ...collectAncestors(node).map((a) => a.path)]);
  return graph.flows.filter((f) => f.nodes.some((n) => paths.has(n)));
}


// --- Layer builders (exported for testing) ---

export function buildGlobalLayer(rootPath: string): ContextLayer {
  const projectName = path.basename(path.dirname(rootPath));
  const content = `**Project:** ${projectName}\n`;
  return { type: 'global', label: 'Global Context', content };
}

export function buildHierarchyLayer(
  ancestor: GraphNode,
  _config: YggConfig,
  graph: Graph,
): ContextLayer {
  const parts: string[] = [];
  if (ancestor.nodeYamlRaw) {
    parts.push(`### yg-node.yaml\n${ancestor.nodeYamlRaw.trim()}`);
  }
  const content = parts.join('\n\n');
  const effectiveIds = computeEffectiveAspects(ancestor, graph);
  const attrs: Record<string, string> | undefined =
    effectiveIds.size > 0 ? { aspects: [...effectiveIds].join(',') } : undefined;
  return {
    type: 'hierarchy',
    label: `Module Context (${ancestor.path}/)`,
    content,
    attrs,
  };
}

export async function buildOwnLayer(
  node: GraphNode,
  _config: YggConfig,
  graphRootPath: string,
  graph: Graph,
): Promise<ContextLayer> {
  const parts: string[] = [];

  if (node.nodeYamlRaw) {
    parts.push(`### yg-node.yaml\n${node.nodeYamlRaw.trim()}`);
  } else {
    const nodeYamlPath = path.join(graphRootPath, 'model', node.path, 'yg-node.yaml');
    try {
      const nodeYamlContent = await readFile(nodeYamlPath, 'utf-8');
      parts.push(`### yg-node.yaml\n${nodeYamlContent.trim()}`);
    } catch {
      parts.push(`### yg-node.yaml\n(not found)`);
    }
  }

  const content = parts.join('\n\n');
  const effectiveIds = computeEffectiveAspects(node, graph);
  const attrs: Record<string, string> | undefined =
    effectiveIds.size > 0 ? { aspects: [...effectiveIds].join(',') } : undefined;
  return {
    type: 'hierarchy',
    label: `Node: ${node.meta.name}`,
    content,
    attrs,
  };
}

export function buildStructuralRelationLayer(
  target: GraphNode,
  relation: Relation,
): ContextLayer {
  let content = '';
  if (relation.consumes?.length) {
    content += `Consumes: ${relation.consumes.join(', ')}\n\n`;
  }

  if (target.meta.description) {
    content += target.meta.description;
  }

  const attrs: Record<string, string> = {
    target: target.path,
    type: relation.type,
  };
  if (relation.consumes?.length) attrs.consumes = relation.consumes.join(', ');

  return {
    type: 'relational',
    label: `Dependency: ${target.meta.name} (${relation.type}) — ${target.path}`,
    content: content.trim(),
    attrs,
  };
}

export function buildEventRelationLayer(target: GraphNode, relation: Relation): ContextLayer {
  const eventName = relation.event_name ?? target.meta.name;
  const isEmit = relation.type === 'emits';
  let content = isEmit
    ? `Target: ${target.path}\nYou publish ${eventName}.`
    : `Source: ${target.path}\nYou listen for ${eventName}.`;
  if (relation.consumes?.length) {
    content += `\nConsumes: ${relation.consumes.join(', ')}`;
  }
  const attrs: Record<string, string> = {
    target: target.path,
    type: relation.type,
    'event-name': eventName,
  };
  if (relation.consumes?.length) attrs.consumes = relation.consumes.join(', ');

  return {
    type: 'relational',
    label: `Event: ${eventName} [${relation.type}]`,
    content,
    attrs,
  };
}

export function buildAspectLayer(aspect: AspectDef): ContextLayer {
  const content = aspect.artifacts.map((a) => `### ${a.filename}\n${a.content}`).join('\n\n');
  return {
    type: 'aspects',
    label: `${aspect.name} (aspect: ${aspect.id})`,
    content,
  };
}

// --- Helpers (exported for testing) ---

export function collectAncestors(node: GraphNode): GraphNode[] {
  const ancestors: GraphNode[] = [];
  let current = node.parent;
  while (current) {
    ancestors.unshift(current);
    current = current.parent;
  }
  return ancestors;
}

export interface DependencyAncestorInfo {
  path: string;
  name: string;
  type: string;
  aspects: string[];
}

export function collectDependencyAncestors(
  target: GraphNode,
  _config: YggConfig,
  graph: Graph,
): DependencyAncestorInfo[] {
  const ancestors = collectAncestors(target);

  return ancestors.map((ancestor) => {
    const effectiveIds = computeEffectiveAspects(ancestor, graph);
    return {
      path: ancestor.path,
      name: ancestor.meta.name,
      type: ancestor.meta.type,
      aspects: [...effectiveIds],
    };
  });
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
  const node = graph.nodes.get(nodePath);
  if (!node) throw new Error(`Node not found: ${nodePath}`);

  const ancestors = collectAncestors(node);
  const participatingFlows = collectParticipatingFlows(graph, node);

  const effectiveAspectIds = computeEffectiveAspects(node, graph);

  const aspects = Array.from(effectiveAspectIds).map(aspectId => {
    const aspectDef = graph.aspects.find(a => a.id === aspectId);
    const source = getAspectSource(aspectId, node, graph);
    return {
      id: aspectId,
      name: aspectDef?.name ?? aspectId,
      description: aspectDef?.description ?? '',
      source,
      verifiedAgainst: `.yggdrasil/aspects/${aspectId}/content.md`,
      implies: aspectDef?.implies,
    };
  });

  const flows = participatingFlows.map(f => ({
    id: f.path,
    name: f.name,
    description: f.description ?? '',
    readPath: `flows/${f.path}/yg-flow.yaml`,
  }));

  const ancestorPaths = new Set(ancestors.map(a => a.path));
  const dependencies = (node.meta.relations ?? [])
    .filter(r => !ancestorPaths.has(r.target) && (STRUCTURAL_RELATION_TYPES.has(r.type) || EVENT_RELATION_TYPES.has(r.type)))
    .map(r => {
      const target = graph.nodes.get(r.target);
      return {
        path: r.target,
        relation: r.type,
        description: target?.meta.description,
        readPath: `model/${r.target}/yg-node.yaml`,
        consumes: r.consumes,
      };
    });

  const { count: dependentCount, paths: dependentPaths } = countDependents(graph, nodePath);

  const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : undefined;

  const sourceFiles = normalizeMappingPaths(node.meta.mapping);

  return {
    path: nodePath,
    name: node.meta.name,
    type: node.meta.type,
    description: node.meta.description,
    sourceFiles,
    aspects,
    flows,
    dependencies,
    dependentCount,
    dependentPaths: dependentCount <= 5 ? dependentPaths : undefined,
    parentPath: parent?.path,
    parentType: parent?.meta.type,
    parentReadPath: parent ? `model/${parent.path}/yg-node.yaml` : undefined,
  };
}

export function buildFileContextData(graph: Graph, filePath: string, ownerPath: string): FileContextData {
  const node = graph.nodes.get(ownerPath);
  if (!node) throw new Error(`Node not found: ${ownerPath}`);

  const ancestors = collectAncestors(node);

  const effectiveAspectIds = computeEffectiveAspects(node, graph);

  const aspects = Array.from(effectiveAspectIds).map(aspectId => {
    const aspectDef = graph.aspects.find(a => a.id === aspectId);
    return {
      aspectId,
      aspectDescription: aspectDef?.description ?? aspectDef?.name ?? aspectId,
      verifiedAgainst: `.yggdrasil/aspects/${aspectId}/content.md`,
    };
  });

  const ancestorPathsSet = new Set(ancestors.map(a => a.path));
  const dependencies = (node.meta.relations ?? [])
    .filter(r => !ancestorPathsSet.has(r.target) && STRUCTURAL_RELATION_TYPES.has(r.type))
    .map(r => ({
      path: r.target,
      consumed: r.consumes ?? [],
    }));

  const { count: dependentCount } = countDependents(graph, ownerPath);

  return {
    filePath,
    ownerPath,
    ownerType: node.meta.type,
    aspects,
    dependencies,
    dependentCount,
  };
}
