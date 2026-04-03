import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  STANDARD_ARTIFACTS,
} from '../model/types.js';
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
  ContextMapOutput,
  Glossary,
  GlossaryAspectEntry,
  GlossaryFlowEntry,
  NodeAspectRef,
  RequiredAspectRef,
  FlowRef,
  AncestorRef,
  DependencyRef,
  BudgetBreakdown,
} from '../model/types.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { estimateTokens } from '../utils/tokens.js';
import { computeEffectiveAspects } from './effective-aspects.js';

const STRUCTURAL_RELATION_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);
const EVENT_RELATION_TYPES = new Set(['emits', 'listens']);
const YG_YAML_FILES = new Set(['yg-node.yaml', 'yg-aspect.yaml', 'yg-flow.yaml']);

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

  // 3. Own (yg-node.yaml + configured artifacts)
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
      layers.push(buildStructuralRelationLayer(target, relation));
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
    const entry = node.meta.aspects?.find(a => a.aspect === aspect.id);
    const exceptionNote = entry?.exceptions?.join('; ');
    layers.push(buildAspectLayer(aspect, exceptionNote));
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
  const content = `**Project:** ${config.name}\n`;
  return { type: 'global', label: 'Global Context', content };
}

function filterByStandardArtifacts(
  artifacts: Array<{ filename: string; content: string }>,
): Array<{ filename: string; content: string }> {
  const allowed = new Set(Object.keys(STANDARD_ARTIFACTS));
  return artifacts.filter((a) => allowed.has(a.filename));
}

export function buildHierarchyLayer(
  ancestor: GraphNode,
  config: YggConfig,
  graph: Graph,
): ContextLayer {
  const filtered = filterByStandardArtifacts(ancestor.artifacts);
  const content = filtered.map((a) => `### ${a.filename}\n${a.content}`).join('\n\n');
  const nodeAspects = (ancestor.meta.aspects ?? []).map(a => a.aspect);
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

  const filtered = filterByStandardArtifacts(node.artifacts);
  for (const a of filtered) {
    parts.push(`### ${a.filename}\n${a.content}`);
  }

  const content = parts.join('\n\n');
  const nodeAspects = (node.meta.aspects ?? []).map(a => a.aspect);
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
): ContextLayer {
  let content = '';
  if (relation.consumes?.length) {
    content += `Consumes: ${relation.consumes.join(', ')}\n\n`;
  }
  if (relation.failure) {
    content += `On failure: ${relation.failure}\n\n`;
  }

  const structuralArtifactFilenames = Object.entries(STANDARD_ARTIFACTS)
    .filter(([, c]) => c.included_in_relations)
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
    const filtered = filterByStandardArtifacts(target.artifacts);
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

export function buildAspectLayer(aspect: AspectDef, exceptionNote?: string): ContextLayer {
  let content = aspect.artifacts.map((a) => `### ${a.filename}\n${a.content}`).join('\n\n');
  if (exceptionNote) {
    content += `\n\n⚠ **Exception for this node:** ${exceptionNote}`;
  }
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

export interface DependencyAncestorInfo {
  path: string;
  name: string;
  type: string;
  aspects: string[];
  artifactFilenames: string[];
}

export function collectDependencyAncestors(
  target: GraphNode,
  config: YggConfig,
  graph: Graph,
): DependencyAncestorInfo[] {
  const ancestors = collectAncestors(target);
  const structuralFilenames = Object.entries(STANDARD_ARTIFACTS)
    .filter(([, c]) => c.included_in_relations)
    .map(([filename]) => filename);
  const configArtifactKeys = [...Object.keys(STANDARD_ARTIFACTS)];

  return ancestors.map((ancestor) => {
    const nodeAspects = (ancestor.meta.aspects ?? []).map(a => a.aspect);
    const expanded = expandAspects(nodeAspects, graph.aspects);

    // Use included_in_relations artifacts if any exist, else fall back to all config artifacts
    const filterFilenames = structuralFilenames.length > 0 ? structuralFilenames : configArtifactKeys;
    const availableFiles = filterFilenames.filter((f) =>
      ancestor.artifacts.some((a) => a.filename === f),
    );
    return {
      path: ancestor.path,
      name: ancestor.meta.name,
      type: ancestor.meta.type,
      aspects: expanded,
      artifactFilenames: availableFiles,
    };
  });
}

export function computeBudgetBreakdown(
  pkg: ContextPackage,
  graph: Graph,
): BudgetBreakdown {
  let own = 0;
  let hierarchy = 0;
  let aspects = 0;
  let flows = 0;
  let relational = 0;

  for (const layer of pkg.layers) {
    const tokens = estimateTokens(layer.content);
    switch (layer.type) {
      case 'global':
      case 'own':
        own += tokens;
        break;
      case 'hierarchy':
        hierarchy += tokens;
        break;
      case 'aspects':
        aspects += tokens;
        break;
      case 'flows':
        flows += tokens;
        break;
      case 'relational':
        relational += tokens;
        break;
    }
  }

  // Add dependency ancestor artifact costs (not in raw layers)
  let depAncestorTokens = 0;
  const node = graph.nodes.get(pkg.nodePath);
  if (node) {
    const ancestorPaths = new Set(collectAncestors(node).map((a) => a.path));
    for (const relation of node.meta.relations ?? []) {
      const target = graph.nodes.get(relation.target);
      if (!target || ancestorPaths.has(relation.target)) continue;
      const depAncestors = collectDependencyAncestors(target, graph.config, graph);
      for (const anc of depAncestors) {
        const ancNode = graph.nodes.get(anc.path);
        if (!ancNode) continue;
        for (const filename of anc.artifactFilenames) {
          const art = ancNode.artifacts.find((a) => a.filename === filename);
          if (art) {
            depAncestorTokens += estimateTokens(art.content);
          }
        }
      }
    }
  }

  const dependencies = relational + depAncestorTokens;
  const total = own + hierarchy + aspects + flows + dependencies;

  return { own, hierarchy, aspects, flows, dependencies, total };
}

/**
 * Determine the source(s) of an aspect for a node.
 * Returns a descriptive source string indicating where the aspect comes from.
 */
function determineAspectSource(
  aspectId: string,
  node: GraphNode,
  graph: Graph,
  allFlows: FlowDef[],
  isIntegration: boolean,
): string {
  const sources: string[] = [];
  const architecture = graph.architecture;

  // Check if from architecture (node type constraints)
  const nodeType = architecture.node_types[node.meta.type];
  const architectureAspects = isIntegration
    ? nodeType?.integration_aspects ?? []
    : nodeType?.aspects ?? [];
  if (architectureAspects.includes(aspectId)) {
    sources.push(`architecture (type: ${node.meta.type})`);
  }

  // Check if from own declaration
  const ownAspectIds = isIntegration
    ? node.meta.integration_aspects ?? []
    : (node.meta.aspects ?? []).map((a) => a.aspect);
  if (ownAspectIds.includes(aspectId)) {
    sources.push('own declaration');
  }

  // Check if from parent inheritance
  let ancestor = node.parent;
  while (ancestor) {
    const ancestorType = architecture.node_types[ancestor.meta.type];
    const ancestorAspects = isIntegration
      ? ancestorType?.integration_aspects ?? []
      : ancestorType?.aspects ?? [];
    if (ancestorAspects.includes(aspectId)) {
      sources.push(`inherited from parent (type: ${ancestor.meta.type})`);
      break;
    }
    ancestor = ancestor.parent;
  }

  // Check if from flow participation
  const ancestorPaths = new Set([node.path, ...collectAncestors(node).map((a) => a.path)]);
  for (const flow of allFlows) {
    if (flow.nodes.some((n) => ancestorPaths.has(n)) && flow.aspects?.includes(aspectId)) {
      sources.push(`flow '${flow.path}'`);
    }
  }

  // Check if from aspect implies chain
  const aspect = graph.aspects.find((a) => a.id === aspectId);
  if (aspect?.implies) {
    // Try to find which aspect implies this one
    for (const otherAspect of graph.aspects) {
      if (otherAspect.implies?.includes(aspectId)) {
        const implierInSources = sources.some((s) =>
          s.includes(otherAspect.id) || s.includes(`'${otherAspect.id}'`),
        );
        if (implierInSources) {
          sources.push(`implied by '${otherAspect.id}'`);
          break;
        }
      }
    }
  }

  return sources.length > 0 ? sources.join('; ') : 'unknown source';
}

export function toContextMapOutput(
  pkg: ContextPackage,
  graph: Graph,
): ContextMapOutput {
  const node = graph.nodes.get(pkg.nodePath)!;
  const config = graph.config;

  // Node aspects with anchors/exceptions
  const nodeAspects: NodeAspectRef[] = (node.meta.aspects ?? []).map((entry) => {
    const ref: NodeAspectRef = { id: entry.aspect };
    if (entry.anchors && Object.keys(entry.anchors).length > 0) ref.anchors = entry.anchors;
    if (entry.exceptions?.length) ref.exceptions = entry.exceptions;
    return ref;
  });

  // Node flows
  const participatingFlows = collectParticipatingFlows(graph, node);
  const flowRefs: FlowRef[] = participatingFlows.map((f) => {
    const ref: FlowRef = { id: f.path, path: f.path };
    if (f.aspects?.length) ref.aspects = f.aspects;
    return ref;
  });

  // Hierarchy ancestors
  const ancestors = collectAncestors(node);
  const hierarchyRefs: AncestorRef[] = ancestors.map((a) => {
    const nodeAspectIds = (a.meta.aspects ?? []).map((e) => e.aspect);
    const expanded = expandAspects(nodeAspectIds, graph.aspects);
    return { path: a.path, name: a.meta.name, type: a.meta.type, description: a.meta.description, aspects: expanded, files: buildNodeFiles(a, config, `model/${a.path}`) };
  });

  // Dependencies — structural + event
  const depRefs: DependencyRef[] = [];
  const ancestorPaths = new Set(ancestors.map((a) => a.path));
  for (const relation of node.meta.relations ?? []) {
    const target = graph.nodes.get(relation.target);
    if (!target) continue;
    if (ancestorPaths.has(relation.target)) continue;

    const depAncestors = collectAncestors(target);
    const depHierarchy: AncestorRef[] = depAncestors.map((a) => {
      const ids = (a.meta.aspects ?? []).map((e) => e.aspect);
      const expanded = expandAspects(ids, graph.aspects);
      const ancestorNode = graph.nodes.get(a.path);
      return { path: a.path, name: a.meta.name, type: a.meta.type, description: a.meta.description, aspects: expanded, files: ancestorNode ? buildDepNodeFiles(ancestorNode, config, `model/${a.path}`) : [] };
    });

    const depEffectiveAspects = [...collectEffectiveAspectIds(graph, target.path)];

    const ref: DependencyRef = {
      path: target.path,
      name: target.meta.name,
      type: target.meta.type,
      description: target.meta.description,
      relation: relation.type,
      aspects: depEffectiveAspects,
      hierarchy: depHierarchy,
      files: buildDepNodeFiles(target, config, `model/${target.path}`),
    };
    if (relation.consumes?.length) ref.consumes = relation.consumes;
    if (relation.failure) ref.failure = relation.failure;
    if (relation.event_name) ref['event-name'] = relation.event_name;
    depRefs.push(ref);
  }

  // Glossary
  const glossary = buildGlossary(node, depRefs, graph);

  // Budget
  const breakdown = computeBudgetBreakdown(pkg, graph);
  const warningThreshold = config.quality?.context_budget?.warning ?? 10000;
  const errorThreshold = config.quality?.context_budget?.error ?? 20000;
  const budgetStatus: 'ok' | 'warning' | 'severe' =
    breakdown.total >= errorThreshold ? 'severe'
      : breakdown.total >= warningThreshold ? 'warning'
        : 'ok';

  // Compute effective aspects from architecture, hierarchy, own, and flows
  let requiredAspects: RequiredAspectRef[] = [];
  let integrationAspects: RequiredAspectRef[] | undefined;

  if (graph.architecture) {
    const parentTypes = ancestors.map((a) => a.meta.type);
    const ownAspectIds = (node.meta.aspects ?? []).map((a) => a.aspect);
    const ownIntegrationAspectIds = node.meta.integration_aspects ?? [];
    const flowAspects = participatingFlows.flatMap((f) => f.aspects ?? []);

    const effective = computeEffectiveAspects({
      nodeType: node.meta.type,
      architecture: graph.architecture,
      parentTypes,
      ownAspects: ownAspectIds,
      ownIntegrationAspects: ownIntegrationAspectIds,
      flowAspects,
      allAspects: graph.aspects,
      allFlows: graph.flows,
    });

    // Build required_aspects with source information
    for (const aspectId of effective.regular) {
      const source = determineAspectSource(aspectId, node, graph, graph.flows, false);
      requiredAspects.push({ id: aspectId, source });
    }

    // Build integration_aspects with source information
    if (effective.integration.size > 0) {
      integrationAspects = Array.from(effective.integration).map((aspectId) => {
        const source = determineAspectSource(aspectId, node, graph, graph.flows, true);
        return { id: aspectId, source };
      });
    }
  } else {
    // Fallback: use simple approach when architecture is not available
    // This maintains backward compatibility with tests that don't load full architecture
    const effectiveIds = collectEffectiveAspectIds(graph, node.path);
    for (const aspectId of effectiveIds) {
      requiredAspects.push({ id: aspectId, source: 'collected from node and flows' });
    }
  }

  return {
    meta: { tokenCount: breakdown.total, budgetStatus, breakdown },
    project: config.name,
    node: {
      path: pkg.nodePath,
      name: pkg.nodeName,
      type: node.meta.type,
      description: node.meta.description,
      mappings: normalizeMappingPaths(node.meta.mapping),
      aspects: nodeAspects,
      required_aspects: requiredAspects,
      integration_aspects: integrationAspects,
      flows: flowRefs,
      files: buildNodeFiles(node, config, `model/${pkg.nodePath}`),
    },
    hierarchy: hierarchyRefs,
    dependencies: depRefs,
    glossary,
  };
}

function buildNodeFiles(node: GraphNode, _config: YggConfig, prefix: string): string[] {
  const configKeys = Object.keys(STANDARD_ARTIFACTS);
  return configKeys
    .filter(f => !YG_YAML_FILES.has(f) && node.artifacts.some(a => a.filename === f))
    .map(f => `${prefix}/${f}`);
}

function buildDepNodeFiles(node: GraphNode, _config: YggConfig, prefix: string): string[] {
  const structural = Object.entries(STANDARD_ARTIFACTS)
    .filter(([, c]) => c.included_in_relations)
    .map(([f]) => f);
  const filenames = structural.length > 0 ? structural : Object.keys(STANDARD_ARTIFACTS);
  return filenames
    .filter(f => !YG_YAML_FILES.has(f) && node.artifacts.some(a => a.filename === f))
    .map(f => `${prefix}/${f}`);
}

function buildGlossary(
  node: GraphNode,
  dependencies: DependencyRef[],
  graph: Graph,
): Glossary {
  const aspects: Record<string, GlossaryAspectEntry> = {};
  const flows: Record<string, GlossaryFlowEntry> = {};

  // Aspects — collect all effective aspects + dependency aspects
  const allAspectIds = collectEffectiveAspectIds(graph, node.path);
  for (const dep of dependencies) {
    for (const id of dep.aspects) {
      allAspectIds.add(id);
    }
  }
  const resolvedAspects = resolveAspects(allAspectIds, graph.aspects);
  for (const aspect of resolvedAspects) {
    const files = aspect.artifacts
      .filter(a => !YG_YAML_FILES.has(a.filename))
      .map(a => `aspects/${aspect.id}/${a.filename}`);
    const entry: GlossaryAspectEntry = {
      name: aspect.name,
      files,
    };
    if (aspect.description) entry.description = aspect.description;
    if (aspect.implies?.length) entry.implies = aspect.implies;
    aspects[aspect.id] = entry;
  }

  // Flows
  const participatingFlows = collectParticipatingFlows(graph, node);
  for (const flow of participatingFlows) {
    const files = flow.artifacts
      .filter(a => !YG_YAML_FILES.has(a.filename))
      .map(a => `flows/${flow.path}/${a.filename}`);
    const entry: GlossaryFlowEntry = {
      name: flow.name,
      participants: flow.nodes,
      files,
    };
    if (flow.description) entry.description = flow.description;
    if (flow.aspects?.length) entry.aspects = flow.aspects;
    flows[flow.path] = entry;
  }

  return { aspects, flows };
}

/** Compute effective aspect ids for a node: own + hierarchy + flow + implies expanded. */
export function collectEffectiveAspectIds(graph: Graph, nodePath: string): Set<string> {
  const node = graph.nodes.get(nodePath);
  if (!node) return new Set();

  const raw = new Set<string>((node.meta.aspects ?? []).map(a => a.aspect));

  // Hierarchy aspects
  let ancestor = node.parent;
  while (ancestor) {
    for (const entry of ancestor.meta.aspects ?? []) raw.add(entry.aspect);
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
