import type { Graph, GraphNode, Relation } from '../model/graph.js';
import type {
  WhenPredicate,
  AtomicClause,
  RelationClause,
  RelationMatch,
  DescendantsClause,
  NodeClause,
} from '../model/when.js';
import { collectDescendants } from './graph/traversal.js';

/**
 * Optional resolution overrides for one `when:` evaluation. Absent ⇒ every
 * lookup uses the graph, which is the only behavior explicit nodes ever see.
 */
export interface WhenEvalOverrides {
  /**
   * The node type a relation points at. Default: the declared target's type in
   * the graph. Supplied when a relation was derived from an import edge whose
   * target is enforced by its type with no node of its own — such a target has
   * no entry in the graph, so the graph lookup could never answer.
   */
  relationTargetType?(relation: Relation, graph: Graph): string | undefined;
}

/**
 * Evaluate a WhenPredicate against a (node, graph) pair.
 * Pure function — reads only graph YAML structure. No I/O, no LLM.
 */
export function evaluateWhen(predicate: WhenPredicate, node: GraphNode, graph: Graph, overrides?: WhenEvalOverrides): boolean {
  // Boolean operators (exclusive — parser rejects mixing)
  if ('all_of' in predicate) {
    return predicate.all_of.every(p => evaluateWhen(p, node, graph, overrides));
  }
  if ('any_of' in predicate) {
    return predicate.any_of.some(p => evaluateWhen(p, node, graph, overrides));
  }
  if ('not' in predicate) {
    return !evaluateWhen(predicate.not, node, graph, overrides);
  }
  return evaluateAtomic(predicate, node, graph, overrides);
}

function evaluateAtomic(clause: AtomicClause, node: GraphNode, graph: Graph, overrides?: WhenEvalOverrides): boolean {
  // Implicit all_of over present atomic keys
  if (clause.relations) {
    if (!evaluateRelationClause(clause.relations, node.meta.relations ?? [], graph, overrides)) return false;
  }
  if (clause.descendants) {
    if (!evaluateDescendantsClause(clause.descendants, node, graph, overrides)) return false;
  }
  if (clause.node) {
    if (!evaluateNodeClause(clause.node, node)) return false;
  }
  return true;
}

function evaluateRelationClause(rc: RelationClause, relations: Relation[], graph: Graph, overrides?: WhenEvalOverrides): boolean {
  // all_of over relation types listed — each relation-type clause must match at least one relation
  for (const [relType, match] of Object.entries(rc)) {
    if (!match) continue;
    const candidates = relations.filter(r => r.type === relType);
    if (!candidates.some(r => matchesRelation(r, match as RelationMatch, graph, overrides))) {
      return false;
    }
  }
  return true;
}

function matchesRelation(r: Relation, match: RelationMatch, graph: Graph, overrides?: WhenEvalOverrides): boolean {
  if (match.target !== undefined && r.target !== match.target) return false;
  if (match.target_type !== undefined) {
    // The target's type: normally the declared target's type in the graph. A caller
    // evaluating a subject whose dependencies were inferred from imports supplies a
    // resolver instead, because a dependency enforced purely by its type has no
    // declared entry to look up.
    const targetType = overrides?.relationTargetType
      ? overrides.relationTargetType(r, graph)
      : graph.nodes.get(r.target)?.meta.type;
    if (targetType !== match.target_type) return false;
  }
  if (match.consumes_port !== undefined) {
    if (!r.consumes || !r.consumes.includes(match.consumes_port)) return false;
  }
  return true;
}

function evaluateDescendantsClause(dc: DescendantsClause, node: GraphNode, graph: Graph, overrides?: WhenEvalOverrides): boolean {
  const descendants = collectDescendants(node);
  if (descendants.length === 0) return false;

  if (dc.type !== undefined) {
    if (!descendants.some(d => d.meta.type === dc.type)) return false;
  }
  if (dc.has_port !== undefined) {
    if (!descendants.some(d => d.meta.ports && Object.prototype.hasOwnProperty.call(d.meta.ports, dc.has_port!))) {
      return false;
    }
  }
  if (dc.relations) {
    // any descendant must satisfy the relation clause
    if (!descendants.some(d => evaluateRelationClause(dc.relations!, d.meta.relations ?? [], graph, overrides))) {
      return false;
    }
  }
  return true;
}

function evaluateNodeClause(nc: NodeClause, node: GraphNode): boolean {
  if (nc.type !== undefined && node.meta.type !== nc.type) return false;
  if (nc.has_port !== undefined) {
    if (!node.meta.ports || !Object.prototype.hasOwnProperty.call(node.meta.ports, nc.has_port)) return false;
  }
  if (nc.has_mapping !== undefined) {
    const has = (node.meta.mapping?.length ?? 0) > 0;
    if (has !== nc.has_mapping) return false;
  }
  return true;
}

