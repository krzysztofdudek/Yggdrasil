import type { AspectDef, Graph, GraphNode } from '../model/graph.js';
import type { NodeContextData } from '../formatters/context-node.js';
import type { FileContextData } from '../formatters/context-file.js';
import type {
  ContextJsonAspect,
  ContextJsonChainLink,
  ContextJsonChannel,
  ContextJsonChannelKind,
  ContextJsonDocument,
} from '../formatters/context-json.js';
import { CONTEXT_JSON_SCHEMA } from '../formatters/context-json.js';
import { normalizeMappingPaths } from '../io/paths.js';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  getAspectSource,
  getAspectStatusSources,
  inferAspectDisplayKind,
} from './graph/aspects.js';
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

// ============================================================
// Machine-readable context (`yg context --json`)
// ============================================================

/**
 * The rule-source home for one aspect, by the reviewer kind INFERRED from the
 * files it ships (`inferAspectDisplayKind`) rather than the declared
 * `reviewer.type` a mis-authored yaml can contradict. Same three conventions
 * the text view already prints as its first `read:` line.
 */
function ruleSourcePath(aspectId: string, kind: 'llm' | 'deterministic' | 'aggregate'): string {
  return kind === 'deterministic'
    ? `.yggdrasil/aspects/${aspectId}/check.mjs`
    : kind === 'aggregate'
      ? `.yggdrasil/aspects/${aspectId}/yg-aspect.yaml`
      : `.yggdrasil/aspects/${aspectId}/content.md`;
}

/**
 * Every file an agent must read before editing under one aspect — the same set
 * the text view lists as `read:` lines, in the same order: the rule source, then
 * each declared reference, then the companion resolver when the aspect ships one.
 */
export function aspectReadPaths(aspectId: string, def: AspectDef | undefined): string[] {
  const kind = def ? inferAspectDisplayKind(def) : 'llm';
  const paths = [ruleSourcePath(aspectId, kind)];
  if (kind === 'llm' && def?.references) {
    for (const ref of def.references) paths.push(toPosixPath(ref.path));
  }
  if (kind === 'llm' && def?.hasCompanion) {
    paths.push(`.yggdrasil/aspects/${aspectId}/companion.mjs`);
  }
  return paths;
}

/** Channel number → the vocabulary a consumer branches on. Index 0 is unused (channels are 1-based). */
const CHANNEL_KINDS: readonly ContextJsonChannelKind[] = [
  'own',
  'own',
  'ancestor-node',
  'own-type',
  'ancestor-type',
  'flow',
  'port',
  'implies',
];

/**
 * The aspects on this node that imply `aspectId` AND are themselves effective
 * here — channel 7. Restricted to effective impliers on purpose: an aspect
 * declared elsewhere in the graph that happens to imply this one did not put it
 * on THIS subject, and naming it would credit an attachment that never happened.
 */
function effectiveImpliers(graph: Graph, aspectId: string, effective: ReadonlySet<string>): string[] {
  return graph.aspects
    .filter((a) => effective.has(a.id) && a.id !== aspectId && (a.implies ?? []).includes(aspectId))
    .map((a) => a.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * One effective aspect on one node, in the machine form: the effective status,
 * the inferred reviewer kind, the rule's own words, every channel it arrived
 * through, and the files to read. Channels 1–6 come from the SAME per-channel
 * provenance the validator's downgrade detection reads, so the machine view and
 * the status the reviewer enforces can never be derived two different ways.
 */
function toJsonAspect(
  graph: Graph,
  node: GraphNode,
  aspectId: string,
  status: import('../model/graph.js').AspectStatus,
  effective: ReadonlySet<string>,
): ContextJsonAspect {
  const channels: ContextJsonChannel[] = getAspectStatusSources(node, aspectId, graph).map((s) => ({
    number: s.channel,
    kind: CHANNEL_KINDS[s.channel],
    origin: s.origin,
    declaredStatus: s.declared,
  }));
  const impliedBy = effectiveImpliers(graph, aspectId, effective);
  if (impliedBy.length > 0) {
    channels.push({ number: 7, kind: 'implies', origin: `implies:${impliedBy.join(',')}` });
  }
  return {
    ...jsonAspectFrom(graph, aspectId, status, channels),
    ...(impliedBy.length > 0 && { impliedBy }),
  };
}

/**
 * One effective rule in the machine form, for a caller that already worked out
 * WHICH channels it arrived by. The rule's own words, its inferred reviewer
 * kind, and the files to read are resolved here rather than at each call site,
 * so a component's rules and a type-governed file's rules are described by one
 * definition instead of two that can drift.
 */
export function jsonAspectFrom(
  graph: Graph,
  aspectId: string,
  status: import('../model/graph.js').AspectStatus,
  channels: ContextJsonChannel[],
): ContextJsonAspect {
  const def = graph.aspects.find((a) => a.id === aspectId);
  return {
    id: aspectId,
    status,
    kind: def ? inferAspectDisplayKind(def) : 'llm',
    name: def?.name ?? aspectId,
    description: def?.description ?? '',
    channels,
    read: aspectReadPaths(aspectId, def),
  };
}

/** The node's own link plus every ancestor's, nearest first — what the subject inherits along. */
function nodeChain(node: GraphNode): ContextJsonChainLink[] {
  const ancestors = collectAncestors(node);
  return [
    { node: toPosixPath(node.path), type: node.meta.type },
    ...ancestors
      .slice()
      .reverse()
      .map((a) => ({ node: toPosixPath(a.path), type: a.meta.type })),
  ];
}

/**
 * Every effective aspect on `node`, sorted by id so two runs over the same graph
 * produce byte-identical documents.
 */
function nodeJsonAspects(graph: Graph, node: GraphNode): ContextJsonAspect[] {
  const effective = computeEffectiveAspects(node, graph);
  const statuses = computeEffectiveAspectStatuses(node, graph);
  return Array.from(effective)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id) =>
      toJsonAspect(
        graph,
        node,
        id,
        statuses.get(id) ?? graph.aspects.find((a) => a.id === id)?.status ?? 'enforced',
        effective,
      ),
    );
}

/** The machine-readable context document for one component. */
export function buildNodeContextJson(graph: Graph, nodePath: string): ContextJsonDocument {
  const node = graph.nodes.get(nodePath);
  if (!node) throw new Error(`Node not found: ${nodePath}`);
  return {
    schema: CONTEXT_JSON_SCHEMA,
    target: { kind: 'node', path: toPosixPath(nodePath) },
    owner: { kind: 'node', path: toPosixPath(nodePath), type: node.meta.type },
    chain: nodeChain(node),
    aspects: nodeJsonAspects(graph, node),
  };
}

/**
 * The machine-readable context document for one file that a component owns. The
 * rules are the OWNER's rules — the same set the text view prints under "Must
 * satisfy" — because that is what the reviewer checks the file against.
 */
export function buildFileContextJson(graph: Graph, filePath: string, ownerPath: string): ContextJsonDocument {
  const node = graph.nodes.get(ownerPath);
  if (!node) throw new Error(`Node not found: ${ownerPath}`);
  return {
    schema: CONTEXT_JSON_SCHEMA,
    target: { kind: 'file', path: toPosixPath(filePath) },
    owner: { kind: 'node', path: toPosixPath(ownerPath), type: node.meta.type },
    chain: nodeChain(node),
    aspects: nodeJsonAspects(graph, node),
  };
}
