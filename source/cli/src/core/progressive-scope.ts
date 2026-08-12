import type { Graph } from '../model/graph.js';
import { collectDescendants } from './graph/traversal.js';

/**
 * Pure burn-set helpers for the progressive-mode scope engine: given a graph
 * and a starting point (an aspect id, or a flow name), answer "which other
 * graph elements does this reach" with no I/O, no `when` evaluation, and no
 * node binding. Composing these into "which rules does this change reach"
 * is a separate concern with no caller in this repository yet.
 */

// ============================================================
// impliesClosure — unconditional structural closure over `implies`
// ============================================================

/**
 * Every aspect id reachable from `aspectId` by following `AspectDef.implies`
 * edges, INCLUDING `aspectId` itself. Terminates on a cycle (a visited set,
 * not recursion depth, bounds the walk).
 *
 * This is deliberately NOT `expandImpliesFiltered` (core/graph/aspects.ts).
 * That function is node-bound and `when`-filtered: it takes a `GraphNode` and
 * a `Graph`, evaluates each aspect's global `when` and each implier's
 * per-implies `when` against that specific node, and stops an implier with
 * `draft` effective status from propagating — because it answers "which
 * aspects apply to THIS node". `impliesClosure` answers a different, purely
 * structural question with no node in scope at all: "if this aspect's rule
 * text changed, which aspects' verdicts are implicated, everywhere, in
 * principle" — a graph-shape fact, not a per-node applicability fact. Folding
 * in `when`/status filtering here would silently make the closure depend on
 * a node that was never given to it.
 */
export function impliesClosure(aspectId: string, graph: Graph): Set<string> {
  const idToAspect = new Map(graph.aspects.map((a) => [a.id, a]));
  const visited = new Set<string>();
  const queue: string[] = [aspectId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const implied of idToAspect.get(id)?.implies ?? []) {
      if (!visited.has(implied)) queue.push(implied);
    }
  }
  return visited;
}

// ============================================================
// buildReverseTargetIndex — target nodePath -> every node relating to it
// ============================================================

/**
 * Reverse index of `meta.relations`: for every node path, the list of node
 * paths that declare ANY relation targeting it — not only port-consuming
 * relations (`consumes:`), but every plain structural relation too (`uses`,
 * `calls`, `extends`, `implements`, `emits`, `listens`). A narrower,
 * consumes-only index would miss the case where a node's TYPE changes and
 * that alone flips another node's rule attachment through a plain relation,
 * with no port involved at all.
 *
 * One pass over `graph.nodes x meta.relations`. Each source node path
 * appears at most once per target, sorted for determinism (iteration order
 * of `graph.nodes` is a Map insertion order, not a semantic guarantee here).
 */
export function buildReverseTargetIndex(graph: Graph): Map<string, string[]> {
  const index = new Map<string, Set<string>>();
  for (const [nodePath, node] of graph.nodes) {
    for (const relation of node.meta.relations ?? []) {
      let sources = index.get(relation.target);
      if (!sources) {
        sources = new Set<string>();
        index.set(relation.target, sources);
      }
      sources.add(nodePath);
    }
  }
  const result = new Map<string, string[]>();
  for (const [target, sources] of index) {
    result.set(target, [...sources].sort());
  }
  return result;
}

// ============================================================
// collectFlowParticipants — declared participants + their descendants
// ============================================================

/**
 * Every node path participating in the named flow: each declared node
 * (matched by `FlowDef.name` or `FlowDef.path`, the same either-or match
 * `handleFlowImpact` uses) that still exists in the graph, plus every one of
 * its descendants. A dangling declared path (no longer a real node) is
 * silently skipped, matching the graph's general node-existence tolerance
 * elsewhere. Returns an empty set when no flow matches `flowName`.
 *
 * Lifted from the inline participant-collection block in
 * `cli/impact-handlers.ts::handleFlowImpact`, which stays exactly as it was
 * and may later delegate to this function instead of recomputing the set
 * inline — that refactor is out of scope here.
 */
export function collectFlowParticipants(graph: Graph, flowName: string): Set<string> {
  const flow = graph.flows.find((f) => f.name === flowName || f.path === flowName);
  if (!flow) return new Set();

  const participants = new Set<string>();
  for (const nodePath of flow.nodes) {
    const node = graph.nodes.get(nodePath);
    if (!node) continue;
    participants.add(nodePath);
    for (const desc of collectDescendants(node)) {
      participants.add(desc.path);
    }
  }
  return participants;
}
