import type { Graph } from '../../model/graph.js';
import type { ValidationIssue } from '../../model/validation.js';
import type {
  WhenPredicate,
  AtomicClause,
  RelationClause,
  DescendantsClause,
  NodeClause,
} from '../../model/when.js';
import { issueMsg } from './shared.js';

// --- Rule 2: All aspect references must point to defined aspects (aspect-undefined) ---

export function checkDanglingAspectRefs(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedAspects = new Set(graph.aspects.map((a) => a.id));

  // Check node aspects
  for (const [nodePath, node] of graph.nodes) {
    for (const aspectId of node.meta.aspects ?? []) {
      if (!definedAspects.has(aspectId)) {
        issues.push({
          severity: 'error',
          code: 'aspect-undefined',
          rule: 'dangling-aspect-ref',
          nodePath,
          ...issueMsg({
            what: `Aspect '${aspectId}' is referenced by this node but not defined in aspects/.`,
            why: `Node declares an aspect that does not exist — aspect requirements cannot be verified.`,
            next: `Create the aspects/${aspectId} directory with yg-aspect.yaml and content.md.`,
          }),
        });
      }
    }
    // Check port aspects
    if (node.meta.ports) {
      for (const [portName, port] of Object.entries(node.meta.ports)) {
        for (const aspectId of port.aspects ?? []) {
          if (!definedAspects.has(aspectId)) {
            issues.push({
              severity: 'error',
              code: 'aspect-undefined',
              rule: 'dangling-aspect-ref',
              nodePath,
              ...issueMsg({
                what: `Aspect '${aspectId}' is referenced by port '${portName}' but not defined in aspects/.`,
                why: `Port declares a required aspect that does not exist — port contracts cannot be enforced.`,
                next: `Create the aspects/${aspectId} directory with yg-aspect.yaml and content.md.`,
              }),
            });
          }
        }
      }
    }
  }

  // Check architecture aspects
  for (const [typeId, typeDef] of Object.entries(graph.architecture?.node_types ?? {})) {
    for (const aspectId of typeDef.aspects ?? []) {
      if (!definedAspects.has(aspectId)) {
        issues.push({
          severity: 'error',
          code: 'aspect-undefined',
          rule: 'dangling-aspect-ref',
          ...issueMsg({
            what: `Aspect '${aspectId}' is referenced by architecture type '${typeId}' but not defined in aspects/.`,
            why: `Architecture declares a required aspect that does not exist.`,
            next: `Create the aspects/${aspectId} directory with yg-aspect.yaml and content.md.`,
          }),
        });
      }
    }
  }

  // Check flow aspects
  for (const flow of graph.flows) {
    for (const aspectId of flow.aspects ?? []) {
      if (!definedAspects.has(aspectId)) {
        issues.push({
          severity: 'error',
          code: 'aspect-undefined',
          rule: 'dangling-aspect-ref',
          ...issueMsg({
            what: `Aspect '${aspectId}' is referenced by flow '${flow.name}' but not defined in aspects/.`,
            why: `Flow declares an aspect that does not exist — flow requirements cannot propagate.`,
            next: `Create the aspects/${aspectId} directory with yg-aspect.yaml and content.md.`,
          }),
        });
      }
    }
  }

  return issues;
}

// --- Rule 3: Aspect ids (derived from directory path) — always valid when aspect exists ---

export function checkAspectIds(_graph: Graph): ValidationIssue[] {
  // validAspectIds = graph.aspects.map(a => a.id), so every aspect's id is valid by definition
  return [];
}

export function checkAspectIdUniqueness(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map<string, string[]>();
  for (const aspect of graph.aspects) {
    const names = byId.get(aspect.id) ?? [];
    names.push(aspect.name);
    byId.set(aspect.id, names);
  }
  for (const [id, names] of byId) {
    if (names.length <= 1) continue;
    issues.push({
      severity: 'error',
      code: 'duplicate-aspect-id',
      rule: 'duplicate-aspect-binding',
      ...issueMsg({
        what: `Aspect '${id}' is bound to multiple aspects (${names.join(', ')}).`,
        why: `Aspect ids must be unique — duplicate ids cause ambiguous aspect resolution.`,
        next: `Rename one of the aspect directories to make ids unique.`,
      }),
    });
  }
  return issues;
}

// --- Rule: Implied aspects exist ---

export function checkImpliedAspectsExist(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const idToAspect = new Map<string, { name: string }>();
  for (const a of graph.aspects) {
    idToAspect.set(a.id, { name: a.name });
  }
  for (const aspect of graph.aspects) {
    for (const impliedId of aspect.implies ?? []) {
      if (!idToAspect.has(impliedId)) {
        issues.push({
          severity: 'error',
          code: 'implied-aspect-missing',
          rule: 'implied-aspect-missing',
          ...issueMsg({
            what: `Aspect '${aspect.name}' implies '${impliedId}' but no aspect with that id exists in aspects/.`,
            why: `Implies chain is broken — implied aspect requirements cannot be resolved.`,
            next: `Create the implied aspect or remove it from the implies list.`,
          }),
        });
      }
    }
  }
  return issues;
}

// --- Rule: No cycles in aspect implies graph ---

export function checkImpliesNoCycles(graph: Graph): ValidationIssue[] {
  const idToAspect = new Map<string, { implies?: string[] }>();
  for (const a of graph.aspects) {
    idToAspect.set(a.id, { implies: a.implies });
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of idToAspect.keys()) color.set(id, WHITE);

  const issues: ValidationIssue[] = [];

  function dfs(id: string, pathArr: string[]): boolean {
    color.set(id, GRAY);
    pathArr.push(id);
    const aspect = idToAspect.get(id);
    for (const implied of aspect?.implies ?? []) {
      if (color.get(implied) === GRAY) {
        const cycle = pathArr.slice(pathArr.indexOf(implied)).concat(implied);
        issues.push({
          severity: 'error',
          code: 'aspect-implies-cycle',
          rule: 'aspect-implies-cycle',
          ...issueMsg({
            what: `Aspect implies cycle: ${cycle.join(' → ')}.`,
            why: `Cycles in implies prevent aspect resolution.`,
            next: `Break the cycle by removing one implies edge.`,
          }),
        });
        pathArr.pop();
        color.set(id, BLACK);
        return true;
      }
      if (color.get(implied) === WHITE && dfs(implied, pathArr)) {
        pathArr.pop();
        color.set(id, BLACK);
        return true;
      }
    }
    pathArr.pop();
    color.set(id, BLACK);
    return false;
  }

  for (const id of idToAspect.keys()) {
    if (color.get(id) === WHITE) {
      dfs(id, []);
    }
  }
  return issues;
}

/**
 * orphaned-aspect
 * An aspect defined in aspects/ is not referenced by any node, architecture type, or flow.
 * Implied aspects are exempt when the aspect that implies them is itself referenced.
 */
export function checkOrphanedAspects(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const referenced = new Set<string>();

  // Collect direct references from nodes (aspects field and port aspects)
  for (const [, node] of graph.nodes) {
    for (const a of node.meta.aspects ?? []) referenced.add(a);
    if (node.meta.ports) {
      for (const port of Object.values(node.meta.ports)) {
        for (const a of port.aspects ?? []) referenced.add(a);
      }
    }
  }

  // Collect references from architecture node_types
  for (const typeDef of Object.values(graph.architecture?.node_types ?? {})) {
    for (const a of typeDef.aspects ?? []) referenced.add(a);
  }

  // Collect references from flows
  for (const flow of graph.flows) {
    for (const a of flow.aspects ?? []) referenced.add(a);
  }

  // Propagate: aspects implied by a referenced aspect are also considered referenced
  // (iterate to fixpoint in case of chains)
  let changed = true;
  while (changed) {
    changed = false;
    for (const aspect of graph.aspects) {
      if (referenced.has(aspect.id) && aspect.implies) {
        for (const implied of aspect.implies) {
          if (!referenced.has(implied)) {
            referenced.add(implied);
            changed = true;
          }
        }
      }
    }
  }

  for (const aspect of graph.aspects) {
    if (!referenced.has(aspect.id)) {
      issues.push({
        severity: 'warning',
        code: 'orphaned-aspect',
        rule: 'orphaned-aspect',
        nodePath: `aspects/${aspect.id}`,
        ...issueMsg({
          what: `Aspect '${aspect.id}' is defined but not referenced by any node, architecture type, or flow.`,
          why: `Orphaned aspects add noise to the graph without enforcing any requirements.`,
          next: `Either add it to a node/architecture/flow or remove it.`,
        }),
      });
    }
  }

  return issues;
}

/**
 * when-unknown-type / when-unknown-node / when-unknown-port
 * Validates that every declared `when` predicate references types/nodes/ports
 * that actually exist in the graph.
 */
export function checkWhenReferences(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const knownTypes = new Set(Object.keys(graph.architecture?.node_types ?? {}));

  const visitPredicate = (p: WhenPredicate, ctx: string): void => {
    if ('all_of' in p) { p.all_of.forEach((c, i) => visitPredicate(c, `${ctx}/all_of[${i}]`)); return; }
    if ('any_of' in p) { p.any_of.forEach((c, i) => visitPredicate(c, `${ctx}/any_of[${i}]`)); return; }
    if ('not' in p) { visitPredicate(p.not, `${ctx}/not`); return; }
    visitAtomic(p, ctx);
  };

  const visitAtomic = (a: AtomicClause, ctx: string): void => {
    if (a.relations) visitRelationClause(a.relations, `${ctx}/relations`);
    if (a.descendants) visitDescendantsClause(a.descendants, `${ctx}/descendants`);
    if (a.node) visitNodeClause(a.node, `${ctx}/node`);
  };

  const visitRelationClause = (rc: RelationClause, ctx: string): void => {
    for (const [relType, match] of Object.entries(rc)) {
      if (!match) continue;
      if (match.target_type !== undefined && !knownTypes.has(match.target_type)) {
        issues.push({
          severity: 'error',
          code: 'when-unknown-type',
          rule: 'when-unknown-type',
          ...issueMsg({
            what: `Unknown node type '${match.target_type}' in when at ${ctx}/${relType}.target_type.`,
            why: 'The predicate references a type that is not defined in yg-architecture.yaml; it will never evaluate.',
            next: `Fix the type name or define it in yg-architecture.yaml. Known types: ${Array.from(knownTypes).join(', ')}.`,
          }),
        });
      }
      if (match.target !== undefined && !graph.nodes.has(match.target)) {
        issues.push({
          severity: 'error',
          code: 'when-unknown-node',
          rule: 'when-unknown-node',
          ...issueMsg({
            what: `Referenced node '${match.target}' in when at ${ctx}/${relType}.target does not exist.`,
            why: 'The predicate targets a node that is not in the graph.',
            next: `Fix the node path or add the node under .yggdrasil/model/.`,
          }),
        });
      }
      if (match.consumes_port !== undefined && match.target !== undefined) {
        const tgt = graph.nodes.get(match.target);
        if (tgt && !(tgt.meta.ports && match.consumes_port in tgt.meta.ports)) {
          issues.push({
            severity: 'error',
            code: 'when-unknown-port',
            rule: 'when-unknown-port',
            ...issueMsg({
              what: `Port '${match.consumes_port}' is not declared on node '${match.target}' in when at ${ctx}/${relType}.consumes_port.`,
              why: 'The predicate references a port that does not exist on the target node.',
              next: `Fix the port name or add it to .yggdrasil/model/${match.target}/yg-node.yaml.`,
            }),
          });
        }
      } else if (match.consumes_port !== undefined) {
        // Bare consumes_port (no target) — the documented primary idiom. The spec
        // promises an unknown consumes_port raises when-unknown-port UNCONDITIONALLY,
        // so validate the port name is declared on SOME node; a name no node defines
        // can never match (otherwise a typo is a silent false-negative).
        const port = match.consumes_port;
        const known = [...graph.nodes.values()].some(
          (n) => n.meta.ports !== undefined && port in n.meta.ports,
        );
        if (!known) {
          issues.push({
            severity: 'error',
            code: 'when-unknown-port',
            rule: 'when-unknown-port',
            ...issueMsg({
              what: `Port '${port}' in when at ${ctx}/${relType}.consumes_port is not declared on any node.`,
              why: 'The predicate references a port that no node defines, so it can never match.',
              next: `Fix the port name, or declare it under ports: on the node(s) this relation targets.`,
            }),
          });
        }
      }
    }
  };

  const visitDescendantsClause = (dc: DescendantsClause, ctx: string): void => {
    if (dc.relations) visitRelationClause(dc.relations, `${ctx}/relations`);
    if (dc.type !== undefined && !knownTypes.has(dc.type)) {
      issues.push({
        severity: 'error',
        code: 'when-unknown-type',
        rule: 'when-unknown-type',
        ...issueMsg({
          what: `Unknown node type '${dc.type}' in when at ${ctx}/type.`,
          why: 'The predicate references a type that is not defined in yg-architecture.yaml.',
          next: `Fix the type name or define it in yg-architecture.yaml. Known types: ${Array.from(knownTypes).join(', ')}.`,
        }),
      });
    }
  };

  const visitNodeClause = (nc: NodeClause, ctx: string): void => {
    if (nc.type !== undefined && !knownTypes.has(nc.type)) {
      issues.push({
        severity: 'error',
        code: 'when-unknown-type',
        rule: 'when-unknown-type',
        ...issueMsg({
          what: `Unknown node type '${nc.type}' in when at ${ctx}/type.`,
          why: 'The predicate references a type that is not defined in yg-architecture.yaml.',
          next: `Fix the type name or define it in yg-architecture.yaml. Known types: ${Array.from(knownTypes).join(', ')}.`,
        }),
      });
    }
  };

  // 1. Aspect global and impliesWhens
  for (const aspect of graph.aspects) {
    if (aspect.when) visitPredicate(aspect.when, `aspect '${aspect.id}' when`);
    if (aspect.impliesWhens) {
      for (const [targetId, pred] of Object.entries(aspect.impliesWhens)) {
        visitPredicate(pred, `aspect '${aspect.id}' implies[${targetId}] when`);
      }
    }
  }

  // 2. Architecture type defaults
  if (graph.architecture) {
    for (const [typeName, typeDef] of Object.entries(graph.architecture.node_types)) {
      if (!typeDef.aspectWhens) continue;
      for (const [aspectId, pred] of Object.entries(typeDef.aspectWhens)) {
        visitPredicate(pred, `architecture node_types.${typeName} aspectWhens[${aspectId}]`);
      }
    }
  }

  // 3. Nodes
  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.aspectWhens) {
      for (const [aspectId, pred] of Object.entries(node.meta.aspectWhens)) {
        visitPredicate(pred, `node '${nodePath}' aspectWhens[${aspectId}]`);
      }
    }
    if (node.meta.ports) {
      for (const [portName, portDef] of Object.entries(node.meta.ports)) {
        if (!portDef.aspectWhens) continue;
        for (const [aspectId, pred] of Object.entries(portDef.aspectWhens)) {
          visitPredicate(pred, `node '${nodePath}' ports.${portName} aspectWhens[${aspectId}]`);
        }
      }
    }
  }

  // 4. Flows
  for (const flow of graph.flows) {
    if (!flow.aspectWhens) continue;
    for (const [aspectId, pred] of Object.entries(flow.aspectWhens)) {
      visitPredicate(pred, `flow '${flow.path}' aspectWhens[${aspectId}]`);
    }
  }

  return issues;
}
