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
  for (const relation of node.meta.relations ?? []) {
    const target = graph.nodes.get(relation.target);
    if (!target) {
      throw new Error(`Broken relation: ${nodePath} -> ${relation.target} (target not found)`);
    }
    if (STRUCTURAL_RELATION_TYPES.has(relation.type)) {
      layers.push(buildStructuralRelationLayer(target, relation, graph.config));
    } else if (EVENT_RELATION_TYPES.has(relation.type)) {
      layers.push(buildEventRelationLayer(target, relation));
    }
  }

  // 5. Flows (node + all ancestors) — built before aspects so we can collect flow tags
  for (const flow of collectParticipatingFlows(graph, node)) {
    layers.push(buildFlowLayer(flow, graph));
  }

  // 6. Aspects: union of tags from hierarchy + own + flow layers
  const allTags = new Set<string>();
  for (const l of layers) {
    const aspects = l.attrs?.aspects;
    if (aspects) {
      for (const tag of aspects.split(',').map((t) => t.trim()).filter(Boolean)) {
        allTags.add(tag);
      }
    }
  }
  const aspectsToInclude = expandAspectsForTags(allTags, graph.aspects);
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

/** Expand tags to include implied tags recursively. Returns unique list. */
export function expandTags(tags: string[], aspects: AspectDef[]): string[] {
  const tagToAspect = new Map<string, AspectDef>();
  for (const a of aspects) {
    tagToAspect.set(a.tag, a);
  }
  const result: string[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function collect(tag: string): void {
    if (stack.has(tag)) {
      throw new Error(`Aspect implies cycle detected involving tag '${tag}'`);
    }
    if (visited.has(tag)) return;
    stack.add(tag);
    visited.add(tag);
    result.push(tag);
    const aspect = tagToAspect.get(tag);
    if (aspect) {
      for (const implied of aspect.implies ?? []) {
        collect(implied);
      }
    }
    stack.delete(tag);
  }

  for (const tag of tags) {
    collect(tag);
  }
  return result;
}

/** Expand tags to aspects including implied (recursive, with cycle detection). */
export function expandAspectsForTags(
  tags: Iterable<string>,
  aspects: AspectDef[],
): AspectDef[] {
  const tagToAspect = new Map<string, AspectDef>();
  for (const a of aspects) {
    tagToAspect.set(a.tag, a);
  }
  const expandedTags = expandTags([...tags], aspects);
  return expandedTags
    .map((tag) => tagToAspect.get(tag))
    .filter((a): a is AspectDef => a !== undefined);
}

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
  const tags = ancestor.meta.tags ?? [];
  const expanded = expandTags(tags, graph.aspects);
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

  const nodeYamlPath = path.join(graphRootPath, 'model', node.path, 'node.yaml');
  try {
    const nodeYamlContent = await readFile(nodeYamlPath, 'utf-8');
    parts.push(`### node.yaml\n${nodeYamlContent.trim()}`);
  } catch {
    parts.push(`### node.yaml\n(not found)`);
  }

  const filtered = filterArtifactsByConfig(node.artifacts, config);
  for (const a of filtered) {
    parts.push(`### ${a.filename}\n${a.content}`);
  }

  const content = parts.join('\n\n');
  const tags = node.meta.tags ?? [];
  const expanded = expandTags(tags, graph.aspects);
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
    label: `${aspect.name} (tag: ${aspect.tag})`,
    content,
  };
}

function buildFlowLayer(flow: FlowDef, graph: Graph): ContextLayer {
  const content = flow.artifacts.map((a) => `### ${a.filename}\n${a.content}`).join('\n\n');
  const tags = flow.aspects ?? [];
  const expanded = expandTags(tags, graph.aspects);
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
