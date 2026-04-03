import type {
  ArchitectureDef,
  AspectDef,
  FlowDef,
} from '../model/types.js';

/**
 * Complete set of aspects (regular and integration) that a node MUST satisfy.
 * Assembled from architecture constraints, parent inheritance, own extras, flow participation,
 * and aspect implies chains.
 */
export interface EffectiveAspects {
  regular: Set<string>;      // All regular aspects node must satisfy
  integration: Set<string>;   // All integration aspects node must satisfy
}

/**
 * Compute the full set of effective aspects for a node from ALL sources:
 * - Architecture node type constraints (aspects + integration_aspects)
 * - Parent node inherited aspects (recursive)
 * - Flow participations (adds flow aspects to regular set)
 * - Node's own aspects (own extras)
 * - Aspect implies chain (if A implies B, get both)
 *
 * @param params Configuration for effective aspect computation
 * @returns Sets of regular and integration aspect IDs
 * @throws Error if aspect implies cycle is detected
 */
export function computeEffectiveAspects(params: {
  nodeType: string;
  architecture: ArchitectureDef;
  parentTypes: string[];
  ownAspects: string[];
  ownIntegrationAspects: string[];
  flowAspects: string[];
  allAspects: AspectDef[];
  allFlows: FlowDef[];
}): EffectiveAspects {
  const regular = new Set<string>();
  const integration = new Set<string>();

  // 1. Add architecture constraints for this node type
  const nodeTypeDef = params.architecture.node_types[params.nodeType];
  if (nodeTypeDef) {
    for (const aspect of nodeTypeDef.aspects ?? []) {
      regular.add(aspect);
    }
    for (const aspect of nodeTypeDef.integration_aspects ?? []) {
      integration.add(aspect);
    }
  }

  // 2. Add parent inherited aspects (recursive)
  for (const parentType of params.parentTypes) {
    const parentEffective = computeEffectiveAspects({
      nodeType: parentType,
      architecture: params.architecture,
      parentTypes: getParentTypes(parentType, params.architecture),
      ownAspects: [],
      ownIntegrationAspects: [],
      flowAspects: [],
      allAspects: params.allAspects,
      allFlows: params.allFlows,
    });
    for (const aspect of parentEffective.regular) {
      regular.add(aspect);
    }
    for (const aspect of parentEffective.integration) {
      integration.add(aspect);
    }
  }

  // 3. Add own node extras
  for (const aspect of params.ownAspects) {
    regular.add(aspect);
  }
  for (const aspect of params.ownIntegrationAspects) {
    integration.add(aspect);
  }

  // 4. Add flow participation aspects (flows contribute to regular, not integration)
  for (const aspect of params.flowAspects) {
    regular.add(aspect);
  }

  // 5. Traverse implies chain for all regular aspects
  const expandedRegular = expandImplies(regular, params.allAspects);
  const expandedIntegration = expandImplies(integration, params.allAspects);

  return {
    regular: expandedRegular,
    integration: expandedIntegration,
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
