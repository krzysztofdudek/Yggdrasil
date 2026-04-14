import type {
  Graph,
  GraphNode,
} from '../model/graph.js';

/**
 * Compute the full set of effective aspects for a node from ALL 7 channels:
 * 1. Own — node.meta.aspects
 * 2. Ancestor nodes — walk parent chain, collect each ancestor.meta.aspects
 * 3. Own architecture type — graph.architecture.node_types[node.meta.type].aspects
 * 4. Ancestor architecture types — for each ancestor, architecture type aspects
 * 5. Flows — flows where this node OR any ancestor participates
 * 6. Ports — consumed port aspects from relations
 * 7. Implies — recursive expansion through aspect.implies chains
 *
 * @returns Flat Set<string> of all effective aspect IDs
 * @throws Error if aspect implies cycle is detected
 */
export function computeEffectiveAspects(node: GraphNode, graph: Graph): Set<string> {
  const raw = new Set<string>();

  // 1. Own aspects
  for (const id of node.meta.aspects ?? []) {
    raw.add(id);
  }

  // 2. Ancestor node direct aspects
  const ancestors = collectAncestors(node);
  for (const ancestor of ancestors) {
    for (const id of ancestor.meta.aspects ?? []) {
      raw.add(id);
    }
  }

  // 3. Own architecture type aspects
  if (graph.architecture) {
    const typeDef = graph.architecture.node_types[node.meta.type];
    for (const id of typeDef?.aspects ?? []) {
      raw.add(id);
    }
  }

  // 4. Ancestor architecture type aspects
  if (graph.architecture) {
    for (const ancestor of ancestors) {
      const typeDef = graph.architecture.node_types[ancestor.meta.type];
      for (const id of typeDef?.aspects ?? []) {
        raw.add(id);
      }
    }
  }

  // 5. Flow aspects (flows where node or any ancestor participates)
  const allPaths = new Set<string>([node.path, ...ancestors.map(a => a.path)]);
  for (const flow of graph.flows) {
    if (flow.nodes.some(n => allPaths.has(n))) {
      for (const id of flow.aspects ?? []) {
        raw.add(id);
      }
    }
  }

  // 6. Port consumption aspects
  if (node.meta.relations) {
    for (const relation of node.meta.relations) {
      const targetNode = graph.nodes.get(relation.target);
      if (!targetNode) continue;
      if (relation.consumes && targetNode.meta.ports) {
        for (const portName of relation.consumes) {
          const port = targetNode.meta.ports[portName];
          if (port?.aspects) {
            for (const id of port.aspects) {
              raw.add(id);
            }
          }
        }
      }
    }
  }

  // 7. Expand implies chains
  return expandImplies(raw, graph);
}

/**
 * Determine the source of an aspect for a node. Checks all 7 channels in order
 * and returns the first match.
 */
export function getAspectSource(aspectId: string, node: GraphNode, graph: Graph): string {
  // 1. Own declaration
  if (node.meta.aspects?.includes(aspectId)) {
    return 'own declaration';
  }

  // 2. Ancestor node direct aspects
  const ancestors = collectAncestors(node);
  for (const ancestor of ancestors) {
    if (ancestor.meta.aspects?.includes(aspectId)) {
      return `inherited from parent '${ancestor.path}'`;
    }
  }

  // 3. Architecture type (own)
  if (graph.architecture) {
    const typeDef = graph.architecture.node_types[node.meta.type];
    if (typeDef?.aspects?.includes(aspectId)) {
      return `architecture (type: ${node.meta.type})`;
    }
  }

  // 4. Architecture type (ancestor)
  if (graph.architecture) {
    for (const ancestor of ancestors) {
      const typeDef = graph.architecture.node_types[ancestor.meta.type];
      if (typeDef?.aspects?.includes(aspectId)) {
        return `inherited from parent (type: ${ancestor.meta.type})`;
      }
    }
  }

  // 5. Flow participation (direct or via ancestor)
  const allPaths = new Set<string>([node.path, ...ancestors.map(a => a.path)]);
  for (const flow of graph.flows) {
    if (flow.aspects?.includes(aspectId) && flow.nodes.some(n => allPaths.has(n))) {
      // Check if it's via an ancestor
      if (flow.nodes.includes(node.path)) {
        return `flow '${flow.path}'`;
      }
      const viaAncestor = ancestors.find(a => flow.nodes.includes(a.path));
      if (viaAncestor) {
        return `flow '${flow.path}' (via parent '${viaAncestor.path}')`;
      }
      return `flow '${flow.path}'`;
    }
  }

  // 6. Port consumption
  if (node.meta.relations) {
    for (const relation of node.meta.relations) {
      const targetNode = graph.nodes.get(relation.target);
      if (!targetNode?.meta.ports || !relation.consumes) continue;
      for (const portName of relation.consumes) {
        const port = targetNode.meta.ports[portName];
        if (port?.aspects?.includes(aspectId)) {
          return `port '${portName}' on '${relation.target}'`;
        }
      }
    }
  }

  // 7. Implied by another aspect
  for (const otherAspect of graph.aspects) {
    if (otherAspect.implies?.includes(aspectId)) {
      return `implied by '${otherAspect.id}'`;
    }
  }

  return 'unknown source';
}

// --- Internal helpers ---

function collectAncestors(node: GraphNode): GraphNode[] {
  const ancestors: GraphNode[] = [];
  let current = node.parent;
  while (current) {
    ancestors.push(current);
    current = current.parent;
  }
  return ancestors;
}

/**
 * Expand a set of aspect IDs to include all implied aspects recursively.
 * Detects cycles and throws if found.
 */
function expandImplies(aspectIds: Set<string>, graph: Graph): Set<string> {
  const idToImplies = new Map<string, string[]>();
  for (const aspect of graph.aspects) {
    if (aspect.implies) {
      idToImplies.set(aspect.id, aspect.implies);
    }
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

    const implies = idToImplies.get(id);
    if (implies) {
      for (const implied of implies) {
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
