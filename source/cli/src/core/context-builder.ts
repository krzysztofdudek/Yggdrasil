import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Graph,
  GraphNode,
  ContextPackage,
  ContextLayer,
  ContextSection,
  YggConfig,
  AspectDef,
  FlowDef,
  Relation,
} from '../model/types.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { estimateTokens } from '../utils/tokens.js';

const STRUCTURAL_RELATION_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);
const EVENT_RELATION_TYPES = new Set(['emits', 'listens']);

export async function buildContext(graph: Graph, nodePath: string): Promise<ContextPackage> {
  const node = graph.nodes.get(nodePath);
  if (!node) {
    throw new Error(`Node not found: ${nodePath}`);
  }

  const layers: ContextLayer[] = [];

  // 1. Global
  layers.push(buildGlobalLayer(graph.config));

  // 2. Hierarchy (only configured artifacts that exist in ancestor's directory)
  const ancestors = collectAncestors(node);
  for (const ancestor of ancestors) {
    layers.push(buildHierarchyLayer(ancestor, graph.config, graph));
  }

  // 3. Own (node.yaml + configured artifacts)
  layers.push(await buildOwnLayer(node, graph.config, graph.rootPath, graph));

  // 4. Relational (structural + event, with consumes/failure)
  //    Skip relations targeting ancestors — their context is already in hierarchy layers.
  const ancestorPaths = new Set(ancestors.map((a) => a.path));
  for (const relation of node.meta.relations ?? []) {
    const target = graph.nodes.get(relation.target);
    if (!target) {
      throw new Error(`Broken relation: ${nodePath} -> ${relation.target} (target not found)`);
    }
    if (ancestorPaths.has(relation.target)) continue;
    if (STRUCTURAL_RELATION_TYPES.has(relation.type)) {
      layers.push(buildStructuralRelationLayer(target, relation, graph.config));
    } else if (EVENT_RELATION_TYPES.has(relation.type)) {
      layers.push(buildEventRelationLayer(target, relation));
    }
  }

  // 5. Flows (node + all ancestors) — built before aspects so we can collect flow aspect ids
  for (const flow of collectParticipatingFlows(graph, node)) {
    layers.push(buildFlowLayer(flow, graph));
  }

  // 6. Aspects: union of aspect ids from hierarchy + own + flow layers
  const allAspectIds = new Set<string>();
  for (const l of layers) {
    const aspects = l.attrs?.aspects;
    if (aspects) {
      for (const id of aspects.split(',').map((t) => t.trim()).filter(Boolean)) {
        allAspectIds.add(id);
      }
    }
  }
  const aspectsToInclude = resolveAspects(allAspectIds, graph.aspects);
  for (const aspect of aspectsToInclude) {
    layers.push(buildAspectLayer(aspect));
  }

  const fullText = layers.map((l) => l.content).join('\n\n');
  const tokenCount = estimateTokens(fullText);
  const mapping = normalizeMappingPaths(node.meta.mapping);
  const sections = buildSections(layers, mapping.length > 0 ? mapping : null);

  return {
    nodePath,
    nodeName: node.meta.name,
    layers,
    sections,
    mapping: mapping.length > 0 ? mapping : null,
    tokenCount,
  };
}

function collectParticipatingFlows(graph: Graph, node: GraphNode): FlowDef[] {
  const paths = new Set<string>([node.path, ...collectAncestors(node).map((a) => a.path)]);
  return graph.flows.filter((f) => f.nodes.some((n) => paths.has(n)));
}

/** Expand aspect ids to include implied ids recursively. Returns unique list. */
export function expandAspects(aspectIds: string[], aspects: AspectDef[]): string[] {
  const idToAspect = new Map<string, AspectDef>();
  for (const a of aspects) {
    idToAspect.set(a.id, a);
  }
  const result: string[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function collect(id: string): void {
    if (stack.has(id)) {
      throw new Error(`Aspect implies cycle detected involving aspect '${id}'`);
    }
    if (visited.has(id)) return;
    stack.add(id);
    visited.add(id);
    result.push(id);
    const aspect = idToAspect.get(id);
    if (aspect) {
      for (const implied of aspect.implies ?? []) {
        collect(implied);
      }
    }
    stack.delete(id);
  }

  for (const id of aspectIds) {
    collect(id);
  }
  return result;
}

/** Expand aspect ids to AspectDefs including implied (recursive, with cycle detection). */
export function resolveAspects(
  aspectIds: Iterable<string>,
  aspects: AspectDef[],
): AspectDef[] {
  const idToAspect = new Map<string, AspectDef>();
  for (const a of aspects) {
    idToAspect.set(a.id, a);
  }
  const expandedIds = expandAspects([...aspectIds], aspects);
  return expandedIds
    .map((id) => idToAspect.get(id))
    .filter((a): a is AspectDef => a !== undefined);
}

// --- backward-compat aliases (used by tests / external callers) ---
export const expandTags = expandAspects;
export const expandAspectsForTags = resolveAspects;

// --- Layer builders (exported for testing) ---

export function buildGlobalLayer(config: YggConfig): ContextLayer {
  let content = `**Project:** ${config.name}\n\n`;
  content += `**Stack:**\n`;
  for (const [key, value] of Object.entries(config.stack)) {
    content += `- ${key}: ${value}\n`;
  }
  content += `\n**Standards:**\n${config.standards || '(none)'}\n`;
  return { type: 'global', label: 'Global Context', content };
}

function filterArtifactsByConfig(
  artifacts: Array<{ filename: string; content: string }>,
  config: YggConfig,
): Array<{ filename: string; content: string }> {
  const allowed = new Set(Object.keys(config.artifacts ?? {}));
  return artifacts.filter((a) => allowed.has(a.filename));
}

export function buildHierarchyLayer(
  ancestor: GraphNode,
  config: YggConfig,
  graph: Graph,
): ContextLayer {
  const filtered = filterArtifactsByConfig(ancestor.artifacts, config);
  const content = filtered.map((a) => `### ${a.filename}\n${a.content}`).join('\n\n');
  const nodeAspects = ancestor.meta.aspects ?? [];
  const expanded = expandAspects(nodeAspects, graph.aspects);
  const attrs: Record<string, string> | undefined =
    expanded.length > 0 ? { aspects: expanded.join(',') } : undefined;
  return {
    type: 'hierarchy',
    label: `Module Context (${ancestor.path}/)`,
    content,
    attrs,
  };
}

export async function buildOwnLayer(
  node: GraphNode,
  config: YggConfig,
  graphRootPath: string,
  graph: Graph,
): Promise<ContextLayer> {
  const parts: string[] = [];

  if (node.nodeYamlRaw) {
    parts.push(`### node.yaml\n${node.nodeYamlRaw.trim()}`);
  } else {
    const nodeYamlPath = path.join(graphRootPath, 'model', node.path, 'node.yaml');
    try {
      const nodeYamlContent = await readFile(nodeYamlPath, 'utf-8');
      parts.push(`### node.yaml\n${nodeYamlContent.trim()}`);
    } catch {
      parts.push(`### node.yaml\n(not found)`);
    }
  }

  const filtered = filterArtifactsByConfig(node.artifacts, config);
  for (const a of filtered) {
    parts.push(`### ${a.filename}\n${a.content}`);
  }

  const content = parts.join('\n\n');
  const nodeAspects = node.meta.aspects ?? [];
  const expanded = expandAspects(nodeAspects, graph.aspects);
  const attrs: Record<string, string> | undefined =
    expanded.length > 0 ? { aspects: expanded.join(',') } : undefined;
  return {
    type: 'own',
    label: `Node: ${node.meta.name}`,
    content,
    attrs,
  };
}

export function buildStructuralRelationLayer(
  target: GraphNode,
  relation: Relation,
  config: YggConfig,
): ContextLayer {
  let content = '';
  if (relation.consumes?.length) {
    content += `Consumes: ${relation.consumes.join(', ')}\n\n`;
  }
  if (relation.failure) {
    content += `On failure: ${relation.failure}\n\n`;
  }

  const structuralArtifactFilenames = Object.entries(config.artifacts ?? {})
    .filter(([, c]) => c.structural_context)
    .map(([filename]) => filename);

  const structuralArts = structuralArtifactFilenames
    .map((filename) => {
      const art = target.artifacts.find((a) => a.filename === filename);
      return art ? { filename: art.filename, content: art.content } : null;
    })
    .filter((a): a is { filename: string; content: string } => a !== null);

  if (structuralArts.length > 0) {
    content += structuralArts.map((a) => `### ${a.filename}\n${a.content}`).join('\n\n');
  } else {
    const filtered = filterArtifactsByConfig(target.artifacts, config);
    content += filtered.map((a) => `### ${a.filename}\n${a.content}`).join('\n\n');
  }

  const attrs: Record<string, string> = {
    target: target.path,
    type: relation.type,
  };
  if (relation.consumes?.length) attrs.consumes = relation.consumes.join(', ');
  if (relation.failure) attrs.failure = relation.failure;

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

function buildFlowLayer(flow: FlowDef, graph: Graph): ContextLayer {
  const content = flow.artifacts.map((a) => `### ${a.filename}\n${a.content}`).join('\n\n');
  const flowAspects = flow.aspects ?? [];
  const expanded = expandAspects(flowAspects, graph.aspects);
  const attrs: Record<string, string> | undefined =
    expanded.length > 0 ? { aspects: expanded.join(',') } : undefined;
  return {
    type: 'flows',
    label: `Flow: ${flow.name}`,
    content: content || '(no artifacts)',
    attrs,
  };
}

function buildSections(layers: ContextLayer[], mapping: string[] | null): ContextSection[] {
  const ownLayers = layers.filter((layer) => layer.type === 'own');
  if (mapping && mapping.length > 0) {
    ownLayers.push({
      type: 'own',
      label: 'Materialization Target',
      content: mapping.join(', '),
    });
  }

  return [
    { key: 'Global', layers: layers.filter((l) => l.type === 'global') },
    { key: 'Hierarchy', layers: layers.filter((l) => l.type === 'hierarchy') },
    { key: 'OwnArtifacts', layers: ownLayers },
    { key: 'Aspects', layers: layers.filter((l) => l.type === 'aspects') },
    {
      key: 'Relational',
      layers: [
        ...layers.filter((l) => l.type === 'relational'),
        ...layers.filter((l) => l.type === 'flows'),
      ],
    },
  ];
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

/** Compute effective aspect ids for a node: own + hierarchy + flow + implies expanded. */
export function collectEffectiveAspectIds(graph: Graph, nodePath: string): Set<string> {
  const node = graph.nodes.get(nodePath);
  if (!node) return new Set();

  const raw = new Set<string>(node.meta.aspects ?? []);

  // Hierarchy aspects
  let ancestor = node.parent;
  while (ancestor) {
    for (const id of ancestor.meta.aspects ?? []) raw.add(id);
    ancestor = ancestor.parent;
  }

  // Flow aspects (flows where node or ancestor participates)
  const ancestorPaths = new Set([nodePath, ...collectAncestors(node).map((a) => a.path)]);
  for (const flow of graph.flows) {
    if (flow.nodes.some((n) => ancestorPaths.has(n))) {
      for (const id of flow.aspects ?? []) raw.add(id);
    }
  }

  // Expand implies
  return new Set(expandAspects([...raw], graph.aspects));
}
