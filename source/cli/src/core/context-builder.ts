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
  ContextPackage,
  ContextLayer,
  ContextSection,
  ContextMapOutput,
  Glossary,
  GlossaryAspectEntry,
  GlossaryFlowEntry,
  NodeAspectRef,
  RequiredAspectRef,
  FlowRef,
  AncestorRef,
  DependencyRef,
} from '../model/context.js';
import type { NodeContextData } from '../formatters/context-node.js';
import type { FileContextData } from '../formatters/context-file.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { computeEffectiveAspects, computeEffectiveAspectsForConsumer } from './effective-aspects.js';

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

  // 4. Relational (structural + event, with consumes)
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
    layers.push(buildAspectLayer(aspect));
  }

  const mapping = normalizeMappingPaths(node.meta.mapping);
  const sections = buildSections(layers, mapping.length > 0 ? mapping : null);

  return {
    nodePath,
    nodeName: node.meta.name,
    layers,
    sections,
    mapping: mapping.length > 0 ? mapping : null,
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
  const nodeAspects = node.meta.aspects ?? [];
  const expanded = expandAspects(nodeAspects, graph.aspects);
  const attrs: Record<string, string> | undefined =
    expanded.length > 0 ? { aspects: expanded.join(',') } : undefined;
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

function buildFlowLayer(flow: FlowDef, graph: Graph): ContextLayer {
  const content = flow.description ?? '';
  const flowAspects = flow.aspects ?? [];
  const expanded = expandAspects(flowAspects, graph.aspects);
  const attrs: Record<string, string> | undefined =
    expanded.length > 0 ? { aspects: expanded.join(',') } : undefined;
  return {
    type: 'flows',
    label: `Flow: ${flow.name}`,
    content: content || '(no description)',
    attrs,
  };
}

function buildSections(layers: ContextLayer[], mapping: string[] | null): ContextSection[] {
  const hierarchyLayers = layers.filter((l) => l.type === 'hierarchy');
  if (mapping && mapping.length > 0) {
    hierarchyLayers.push({
      type: 'hierarchy',
      label: 'Materialization Target',
      content: mapping.join(', '),
    });
  }

  return [
    { key: 'Global', layers: layers.filter((l) => l.type === 'global') },
    { key: 'Hierarchy', layers: hierarchyLayers },
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
}

export function collectDependencyAncestors(
  target: GraphNode,
  _config: YggConfig,
  graph: Graph,
): DependencyAncestorInfo[] {
  const ancestors = collectAncestors(target);

  return ancestors.map((ancestor) => {
    const nodeAspects = ancestor.meta.aspects ?? [];
    const expanded = expandAspects(nodeAspects, graph.aspects);
    return {
      path: ancestor.path,
      name: ancestor.meta.name,
      type: ancestor.meta.type,
      aspects: expanded,
    };
  });
}


/**
 * Determine the source(s) of an aspect for a node.
 * Returns a descriptive source string indicating where the aspect comes from.
 */
export function determineAspectSource(
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
  const architectureAspects = nodeType?.aspects ?? [];
  if (architectureAspects.includes(aspectId)) {
    sources.push(`architecture (type: ${node.meta.type})`);
  }

  // Check if from own declaration
  const ownAspectIds = node.meta.aspects ?? [];
  if (ownAspectIds.includes(aspectId)) {
    sources.push('own declaration');
  }

  // Check if from port consumption
  if (isIntegration && node.meta.relations) {
    for (const relation of node.meta.relations) {
      const target = graph.nodes.get(relation.target);
      if (!target?.meta.ports || !relation.consumes) continue;
      for (const portName of relation.consumes) {
        const port = target.meta.ports[portName];
        if (port?.aspects?.includes(aspectId)) {
          sources.push(`port '${portName}' on '${relation.target}'`);
        }
      }
    }
  }

  // Check if from parent inheritance
  let ancestor = node.parent;
  while (ancestor) {
    const ancestorType = architecture.node_types[ancestor.meta.type];
    const ancestorAspects = ancestorType?.aspects ?? [];
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

function determineFallbackAspectSource(aspectId: string, node: GraphNode, graph: Graph): string {
  const sources: string[] = [];

  if ((node.meta.aspects ?? []).includes(aspectId)) {
    sources.push('own declaration');
  }

  let ancestor = node.parent;
  while (ancestor) {
    if ((ancestor.meta.aspects ?? []).includes(aspectId)) {
      sources.push(`inherited from parent (${ancestor.path})`);
      break;
    }
    ancestor = ancestor.parent;
  }

  const ancestorPaths = new Set([node.path, ...collectAncestors(node).map((a) => a.path)]);
  for (const flow of graph.flows) {
    if (flow.nodes.some((n) => ancestorPaths.has(n)) && flow.aspects?.includes(aspectId)) {
      sources.push(`flow '${flow.path}'`);
    }
  }

  if (sources.length === 0) {
    for (const otherAspect of graph.aspects) {
      if (otherAspect.implies?.includes(aspectId)) {
        sources.push(`implied by '${otherAspect.id}'`);
        break;
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

  // Node aspects
  const nodeAspects: NodeAspectRef[] = (node.meta.aspects ?? []).map((aspectId) => {
    return { id: aspectId };
  });

  // Node flows
  const participatingFlows = collectParticipatingFlows(graph, node);
  const flowRefs: FlowRef[] = participatingFlows.map((f) => {
    return { id: f.path };
  });

  // Hierarchy ancestors
  const ancestors = collectAncestors(node);
  const hierarchyRefs: AncestorRef[] = ancestors.map((a) => {
    const nodeAspectIds = a.meta.aspects ?? [];
    const expanded = expandAspects(nodeAspectIds, graph.aspects);
    return { path: a.path, name: a.meta.name, type: a.meta.type, description: a.meta.description, aspects: expanded, files: [`model/${a.path}/yg-node.yaml`] };
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
      const ids = a.meta.aspects ?? [];
      const expanded = expandAspects(ids, graph.aspects);
      return { path: a.path, name: a.meta.name, type: a.meta.type, description: a.meta.description, aspects: expanded, files: [`model/${a.path}/yg-node.yaml`] };
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
      files: [`model/${target.path}/yg-node.yaml`],
    };
    if (relation.consumes?.length) ref.consumes = relation.consumes;
    if (relation.event_name) ref['event-name'] = relation.event_name;
    depRefs.push(ref);
  }

  // Glossary
  const glossary = buildGlossary(node, depRefs, graph);

  // Compute effective aspects from architecture, hierarchy, own, and flows
  const requiredAspects: RequiredAspectRef[] = [];

  if (graph.architecture) {
    const parentTypes = ancestors.map((a) => a.meta.type);
    const ownAspectIds = node.meta.aspects ?? [];
    const flowAspects = participatingFlows.flatMap((f) => f.aspects ?? []);

    const effective = computeEffectiveAspects({
      nodeType: node.meta.type,
      architecture: graph.architecture,
      parentTypes,
      ownAspects: ownAspectIds,
      flowAspects,
      allAspects: graph.aspects,
      allFlows: graph.flows,
    });

    // Build required_aspects with source information
    for (const aspectId of effective.regular) {
      const source = determineAspectSource(aspectId, node, graph, graph.flows, false);
      requiredAspects.push({ id: aspectId, source });
    }
  } else {
    // Fallback: use simple approach when architecture is not available
    const effectiveIds = collectEffectiveAspectIds(graph, node.path);
    for (const aspectId of effectiveIds) {
      requiredAspects.push({ id: aspectId, source: 'collected from node and flows' });
    }
  }

  return {
    project: graph.config.name,
    node: {
      path: pkg.nodePath,
      name: pkg.nodeName,
      type: node.meta.type,
      description: node.meta.description,
      mappings: normalizeMappingPaths(node.meta.mapping),
      aspects: nodeAspects,
      required_aspects: requiredAspects,
      flows: flowRefs,
      files: [`model/${pkg.nodePath}/yg-node.yaml`],
    },
    hierarchy: hierarchyRefs,
    dependencies: depRefs,
    glossary,
  };
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
    const entry: GlossaryFlowEntry = {
      name: flow.name,
      participants: flow.nodes,
    };
    if (flow.description) entry.description = flow.description;
    if (flow.aspects?.length) entry.aspects = flow.aspects;
    flows[flow.path] = entry;
  }

  return { aspects, flows };
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
  const parentTypes = ancestors.map(a => a.meta.type);
  const ownAspectIds = node.meta.aspects ?? [];
  const participatingFlows = collectParticipatingFlows(graph, node);
  const flowAspects = participatingFlows.flatMap(f => f.aspects ?? []);

  // Compute effective aspects
  let effective: { regular: Set<string> };
  if (graph.architecture) {
    effective = computeEffectiveAspects({
      nodeType: node.meta.type,
      architecture: graph.architecture,
      parentTypes,
      ownAspects: ownAspectIds,
      flowAspects,
      allAspects: graph.aspects,
      allFlows: graph.flows,
    });
  } else {
    effective = { regular: collectEffectiveAspectIds(graph, nodePath) };
  }

  const aspects = Array.from(effective.regular).map(aspectId => {
    const aspectDef = graph.aspects.find(a => a.id === aspectId);
    const source = graph.architecture
      ? determineAspectSource(aspectId, node, graph, graph.flows, false)
      : determineFallbackAspectSource(aspectId, node, graph);
    return {
      id: aspectId,
      name: aspectDef?.name ?? aspectId,
      description: aspectDef?.description ?? '',
      source,
      verifiedAgainst: `aspects/${aspectId}/content.md`,
      implies: aspectDef?.implies,
    };
  });

  const flows = participatingFlows.map(f => ({
    id: f.path,
    name: f.name,
    description: f.description ?? '',
    readPath: `flows/${f.path}/description.md`,
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
  const parentTypes = ancestors.map(a => a.meta.type);
  const ownAspectIds = node.meta.aspects ?? [];
  const participatingFlows = collectParticipatingFlows(graph, node);
  const flowAspects = participatingFlows.flatMap(f => f.aspects ?? []);

  let effective: { regular: Set<string> };
  if (graph.architecture) {
    effective = computeEffectiveAspects({
      nodeType: node.meta.type,
      architecture: graph.architecture,
      parentTypes,
      ownAspects: ownAspectIds,
      flowAspects,
      allAspects: graph.aspects,
      allFlows: graph.flows,
    });
  } else {
    effective = { regular: collectEffectiveAspectIds(graph, ownerPath) };
  }

  const aspects = Array.from(effective.regular).map(aspectId => {
    const aspectDef = graph.aspects.find(a => a.id === aspectId);
    return {
      aspectId,
      aspectDescription: aspectDef?.description ?? aspectDef?.name ?? aspectId,
      verifiedAgainst: `aspects/${aspectId}/content.md`,
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

/** Compute effective aspect ids for a node: own + hierarchy + flow + implies expanded. */
export function collectEffectiveAspectIds(graph: Graph, nodePath: string): Set<string> {
  const node = graph.nodes.get(nodePath);
  if (!node) return new Set();

  const raw = new Set<string>(node.meta.aspects ?? []);

  // Hierarchy aspects
  let ancestor = node.parent;
  while (ancestor) {
    for (const aspectId of ancestor.meta.aspects ?? []) raw.add(aspectId);
    ancestor = ancestor.parent;
  }

  // Flow aspects (flows where node or ancestor participates)
  const ancestorPaths = new Set([nodePath, ...collectAncestors(node).map((a) => a.path)]);
  for (const flow of graph.flows) {
    if (flow.nodes.some((n) => ancestorPaths.has(n))) {
      for (const id of flow.aspects ?? []) raw.add(id);
    }
  }

  // Architecture type aspects
  if (graph.architecture) {
    const typeDef = graph.architecture.node_types[node.meta.type];
    for (const id of typeDef?.aspects ?? []) raw.add(id);
  }

  // Expand implies
  return new Set(expandAspects([...raw], graph.aspects));
}
