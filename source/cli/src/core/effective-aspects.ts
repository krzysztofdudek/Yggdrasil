import type {
  ArchitectureDef,
  AspectDef,
  FlowDef,
  Graph,
  GraphNode,
} from '../model/types.js';

/**
 * Complete set of aspects that a node MUST satisfy.
 * Assembled from architecture constraints, parent inheritance, own extras, flow participation,
 * consumed ports on target nodes, and aspect implies chains.
 */
export interface EffectiveAspects {
  regular: Set<string>;      // All regular aspects node must satisfy
}

/**
 * Compute the full set of effective aspects for a node from ALL sources:
 * - Architecture node type constraints (aspects)
 * - Parent node inherited aspects (recursive)
 * - Flow participations (adds flow aspects to regular set)
 * - Node's own aspects (own extras)
 * - Aspect implies chain (if A implies B, get both)
 *
 * Note: Integration aspects (from consumed ports) are now computed on-demand via
 * computeEffectiveAspectsForConsumer and merged into the caller's effective set.
 *
 * @param params Configuration for effective aspect computation
 * @returns Set of aspect IDs the node must satisfy
 * @throws Error if aspect implies cycle is detected
 */
export function computeEffectiveAspects(params: {
  nodeType: string;
  architecture: ArchitectureDef;
  parentTypes: string[];
  ownAspects: string[];
  flowAspects: string[];
  allAspects: AspectDef[];
  allFlows: FlowDef[];
}): EffectiveAspects {
  const regular = new Set<string>();

  // 1. Add architecture constraints for this node type
  const nodeTypeDef = params.architecture.node_types[params.nodeType];
  if (nodeTypeDef) {
    for (const aspect of nodeTypeDef.aspects ?? []) {
      regular.add(aspect);
    }
  }

  // 2. Add parent inherited aspects (recursive)
  for (const parentType of params.parentTypes) {
    const parentEffective = computeEffectiveAspects({
      nodeType: parentType,
      architecture: params.architecture,
      parentTypes: getParentTypes(parentType, params.architecture),
      ownAspects: [],
      flowAspects: [],
      allAspects: params.allAspects,
      allFlows: params.allFlows,
    });
    for (const aspect of parentEffective.regular) {
      regular.add(aspect);
    }
  }

  // 3. Add own node extras
  for (const aspect of params.ownAspects) {
    regular.add(aspect);
  }

  // 4. Add flow participation aspects
  for (const aspect of params.flowAspects) {
    regular.add(aspect);
  }

  // 5. Traverse implies chain for all regular aspects
  const expandedRegular = expandImplies(regular, params.allAspects);

  return {
    regular: expandedRegular,
  };
}

/**
 * Get parent types for a given node type from architecture definition.
 */
function getParentTypes(nodeType: string, architecture: ArchitectureDef): string[] {
  const nodeDef = architecture.node_types[nodeType];
  return nodeDef?.parents ?? [];
}

/**
 * Expand a set of aspect IDs to include all implied aspects recursively.
 * Detects cycles and throws if found.
 *
 * @param aspectIds Initial set of aspect IDs
 * @param allAspects All available aspect definitions
 * @returns New Set with all aspect IDs including implied ones
 * @throws Error if a cycle is detected in implies chain
 */
function expandImplies(aspectIds: Set<string>, allAspects: AspectDef[]): Set<string> {
  const idToAspect = new Map<string, AspectDef>();
  for (const aspect of allAspects) {
    idToAspect.set(aspect.id, aspect);
  }

  const result = new Set<string>();
  const visited = new Set<string>();
  const stack = new Set<string>();

  function collect(id: string): void {
    if (stack.has(id)) {
      throw new Error(`Aspect implies cycle detected involving aspect '${id}'`);
    }
    if (visited.has(id)) return;

    stack.add(id);
    visited.add(id);
    result.add(id);

    const aspect = idToAspect.get(id);
    if (aspect?.implies) {
      for (const implied of aspect.implies) {
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

/**
 * Compute the set of integration aspects that a node declares (not regular aspects).
 * Assembled from architecture constraints, parent inheritance, and own declaration.
 *
 * @param node The target node
 * @param graph The full graph with architecture and aspects
 * @param cache Optional cache for recursive calls
 * @returns Set of integration aspect IDs
 */
export function computeEffectiveIntegrationAspects(
  node: GraphNode,
  graph: Graph,
  cache?: Map<string, Set<string>>,
): Set<string> {
  if (cache?.has(node.path)) return cache.get(node.path)!;
  const raw = new Set<string>();

  // 1. Architecture type integration_aspects
  const typeConfig = graph.architecture?.node_types[node.meta.type];
  if (typeConfig?.integration_aspects) {
    for (const a of typeConfig.integration_aspects) {
      raw.add(a);
    }
  }

  // 2. Own extras
  if (node.meta.integration_aspects) {
    for (const a of node.meta.integration_aspects) {
      raw.add(a);
    }
  }

  // 3. Parent integration_aspects (recursive — full effective set)
  if (node.parent) {
    const parentIntegration = computeEffectiveIntegrationAspects(node.parent, graph, cache);
    for (const a of parentIntegration) {
      raw.add(a);
    }
  }

  // 4. Expand implies
  const result = expandImpliesToGraphAspects(raw, graph);
  cache?.set(node.path, result);
  return result;
}

/**
 * Expand aspect implies recursively using graph aspects.
 * @param aspectIds Initial set of aspect IDs
 * @param graph The full graph
 * @returns Set with all aspect IDs including implied ones
 */
function expandImpliesToGraphAspects(aspectIds: Set<string>, graph: Graph): Set<string> {
  const result = new Set<string>(aspectIds);
  const visited = new Set<string>();
  const stack = [...aspectIds];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    result.add(current);

    const aspectDef = graph.aspects.find((a) => a.id === current);
    if (aspectDef?.implies) {
      for (const implied of aspectDef.implies) {
        if (!visited.has(implied)) {
          stack.push(implied);
        }
      }
    }
  }

  return result;
}

/**
 * Determine the source of a required aspect (architecture, flow, parent, or own).
 * Used for error messages in E050 validation.
 */
export function getAspectSource(aspectId: string, node: GraphNode, graph: Graph): string {
  const typeConfig = graph.architecture?.node_types[node.meta.type];

  // Check if from architecture type requirement
  if (typeConfig?.aspects?.includes(aspectId)) {
    return `architecture (type '${node.meta.type}' requires [${typeConfig.aspects.join(', ')}])`;
  }

  // Check if from own declaration
  if (node.meta.aspects?.includes(aspectId)) {
    return 'own declaration in yg-node.yaml';
  }

  // Check if from flow participation
  for (const flow of graph.flows) {
    if (flow.aspects?.includes(aspectId) && flow.nodes?.includes(node.path)) {
      return `flow '${flow.path}' (participants must prove [${flow.aspects.join(', ')}])`;
    }
  }

  // Check if from parent inheritance (walk up tree)
  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor.meta.aspects?.includes(aspectId)) {
      return `parent inheritance (${ancestor.path} declares)`;
    }
    const at = graph.architecture.node_types[ancestor.meta.type];
    if (at?.aspects?.includes(aspectId)) {
      return `parent inheritance (${ancestor.path} architecture type: ${ancestor.meta.type})`;
    }
    for (const flow of graph.flows) {
      if (flow.aspects?.includes(aspectId) && flow.nodes?.includes(ancestor.path)) {
        return `flow '${flow.path}' (via parent '${ancestor.path}')`;
      }
    }
    ancestor = ancestor.parent;
  }

  return '(source unknown — aspect not found in any effective set)';
}

/**
 * Determine the source of a required integration aspect.
 * Used for error messages in E053 validation.
 */
export function getIntegrationAspectSource(
  aspectId: string,
  node: GraphNode,
  graph: Graph,
): string {
  const typeConfig = graph.architecture?.node_types[node.meta.type];

  // Check if from architecture type requirement
  if (typeConfig?.integration_aspects?.includes(aspectId)) {
    return `architecture (type: ${node.meta.type})`;
  }

  // Check if from own declaration
  if (node.meta.integration_aspects?.includes(aspectId)) {
    return 'own declaration';
  }

  // Check if from parent inheritance (walk up tree)
  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor.meta.integration_aspects?.includes(aspectId)) {
      return `parent '${ancestor.path}'`;
    }
    const at = graph.architecture.node_types[ancestor.meta.type];
    if (at?.integration_aspects?.includes(aspectId)) {
      return `parent '${ancestor.path}' (architecture type: ${ancestor.meta.type})`;
    }
    ancestor = ancestor.parent;
  }

  return 'implied by another aspect';
}

/**
 * Compute integration aspects for a consumer node based on ports it consumes from target nodes.
 * When node A calls node B and consumes port 'charge' (which requires aspects [correlation-tracking, idempotency]),
 * those aspects become effective integration aspects for node A.
 *
 * @param node The consumer node (has relations with 'consumes' field)
 * @param graph The full graph with all nodes, aspects
 * @returns Set of aspect IDs that the consumer must satisfy from port consumption
 */
export function computeEffectiveAspectsForConsumer(
  node: GraphNode,
  graph: Graph,
): Set<string> {
  const raw = new Set<string>();

  // For each relation on this node
  if (node.meta.relations) {
    for (const relation of node.meta.relations) {
      // Find the target node
      const targetNode = graph.nodes.get(relation.target);
      if (!targetNode) continue;

      // If the relation specifies consumed ports
      if (relation.consumes && targetNode.meta.ports) {
        for (const portName of relation.consumes) {
          const port = targetNode.meta.ports[portName];
          if (port && port.aspects) {
            for (const aspect of port.aspects) {
              raw.add(aspect);
            }
          }
        }
      }
    }
  }

  // Expand implies chain for all collected aspects
  const result = expandImpliesToGraphAspects(raw, graph);
  return result;
}
