import type { Graph } from '../../model/graph.js';
import { runRelationPass } from '../../relations/pass.js';
import { extractorForLanguage } from '../../relations/extractors/registry.js';
import { astCacheDir } from '../../relations/facts-cache.js';
import { guardedResolve } from '../../relations/resolve-path.js';
import type { BoundaryInput } from '../contract.js';

/**
 * portal/api/boundary — the FULL live dependency-boundary computation, behind the
 * portal facade. This is the SOLE place the portal reaches the relations layer.
 *
 * It runs the relation pass ONCE (read-only: parse + resolve, no verdict written) and
 * derives all THREE boundary classes by a PURE JOIN over the pass's already-computed
 * outputs and the architecture matrix — it changes no engine logic:
 *
 *   - phantom       — a real code dependency on another mapped node with NO declared
 *                     relation. Surfaced verbatim from the relation pass's own
 *                     undeclared-dependency verdict (`violationsByNode`).
 *   - declared-only — a DECLARED structural relation whose target is never detected as a
 *                     code dependency (DI / HTTP / reflection / events are legitimately
 *                     declared without static backing). Join: declared structural edges
 *                     MINUS the pass's full detected-edge set.
 *   - forbidden-type — a DETECTED code dependency whose target node TYPE is not allowed
 *                     by the architecture matrix for the source node's type under ANY
 *                     structural relation type. Join: detected edges × the matrix.
 *
 * `computePortalBoundary` returns `null` ONLY when the relation parse genuinely throws —
 * the caller maps `null` to `unknown: true` and never fabricates a clean boundary.
 */

/** Structural relation types — the only ones a static code dependency can back. */
const STRUCTURAL_RELATIONS = ['calls', 'uses', 'extends', 'implements'] as const;

/**
 * True iff the architecture matrix permits SOME structural relation from `sourceType`
 * to `targetType`. A detected code dependency is type-forbidden only when NO structural
 * relation type could legally connect the two node types — mirroring the same allow /
 * explicit-list / default-deny logic the architecture validator applies, but asking the
 * weaker "is any structural edge allowed at all?" question (a detected dependency does
 * not name its relation type).
 */
function isAnyStructuralRelationAllowed(graph: Graph, sourceType: string, targetType: string): boolean {
  const typeConfig = graph.architecture?.node_types?.[sourceType];
  // No architecture row for the type ⇒ unconstrained (validator's fast path: default allow).
  if (!typeConfig) return true;
  const lists = typeConfig.relations;
  const def = typeConfig.relationDefault ?? 'allow';

  for (const relType of STRUCTURAL_RELATIONS) {
    const allowed = lists?.[relType];
    if (allowed !== undefined) {
      if (allowed.includes('*') || allowed.includes(targetType)) return true;
    } else if (def === 'allow') {
      // Unlisted relation type under default-allow ⇒ permitted.
      return true;
    }
    // allowed undefined + default deny ⇒ this relation type is forbidden; try the next.
  }
  return false;
}

/** True iff `a` is a strict ancestor of `b`, or vice versa (never an edge between distinct nodes). */
function isLineage(a: string, b: string): boolean {
  return a === b || b.startsWith(a + '/') || a.startsWith(b + '/');
}

/**
 * Compute the FULL live boundary by running the relation pass once and joining its
 * outputs with the architecture matrix. Returns `null` iff the relation pass throws
 * (the only honest "unknown" — never a fabricated clean boundary).
 */
export async function computePortalBoundary(
  graph: Graph,
  projectRoot: string,
): Promise<BoundaryInput | null> {
  let pass;
  try {
    pass = await runRelationPass(graph, projectRoot, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(projectRoot, graph),
      symbolIndexDir: astCacheDir(graph.rootPath),
    });
  } catch {
    return null;
  }

  const phantom: Array<{ source: string; target: string }> = [];
  const declaredOnly: Array<{ source: string; target: string }> = [];
  const forbiddenType: Array<{ source: string; target: string }> = [];

  // ── PHANTOM ── the relation pass's undeclared-dependency verdict, verbatim.
  for (const [nodeId, nv] of pass.violationsByNode) {
    if (nv.verdict !== 'refused') continue;
    const seen = new Set<string>();
    for (const v of nv.violations) {
      if (seen.has(v.ownerNode)) continue;
      seen.add(v.ownerNode);
      phantom.push({ source: nodeId, target: v.ownerNode });
    }
  }

  // ── DECLARED-ONLY & FORBIDDEN-TYPE ── joins over the full detected-edge set.
  const detected = pass.detectedEdgesByNode;
  for (const [nodeId, node] of graph.nodes) {
    const sourceType = node.meta.type;
    const detectedTargets = detected.get(nodeId) ?? new Set<string>();

    // declared-only: a declared STRUCTURAL relation with no matching detected code edge.
    // Event relations (emits / listens) are never code-backed, so they are excluded — a
    // declared event edge is not "declared-only" noise. Lineage edges are never reported.
    for (const rel of node.meta.relations ?? []) {
      if (!STRUCTURAL_RELATIONS.includes(rel.type as (typeof STRUCTURAL_RELATIONS)[number])) continue;
      if (isLineage(nodeId, rel.target)) continue;
      if (!graph.nodes.has(rel.target)) continue; // a broken target is a different validator's job
      if (!detectedTargets.has(rel.target)) {
        declaredOnly.push({ source: nodeId, target: rel.target });
      }
    }

    // forbidden-type: a detected code edge the architecture matrix forbids by type.
    for (const target of detectedTargets) {
      const targetNode = graph.nodes.get(target);
      if (!targetNode) continue;
      if (!isAnyStructuralRelationAllowed(graph, sourceType, targetNode.meta.type)) {
        forbiddenType.push({ source: nodeId, target });
      }
    }
  }

  // Flatten the pass's detected-edge set (a Map<string, Set<string>>) into plain, sorted arrays
  // AT THIS SEAM — before it can enter PortalData, where a Map would serialize to `{}`. This is
  // the SAME `detected` set already used by the joins above (no second pass); the structure panel
  // reconstructs the universe from it, so surfacing it is free.
  const detectedEdgesByNode: Array<{ from: string; targets: string[] }> = [];
  for (const [from, targets] of detected) {
    detectedEdgesByNode.push({ from, targets: [...targets].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) });
  }
  detectedEdgesByNode.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  return { phantom, declaredOnly, forbiddenType, detectedEdgesByNode };
}

/**
 * Additive, READ-ONLY accessor over the relation pass: run it ONCE (parse +
 * resolve, no verdict written, no lock touched) and return the FULL set of
 * statically-detected cross-node code edges — `detectedEdgesByNode` verbatim,
 * keyed by source nodeId → the set of resolved target nodeIds. This is the same
 * call path `computePortalBoundary` uses; it changes no engine logic and writes
 * nothing.
 *
 * Exposed so a command that cannot legally reach the relations layer directly
 * (the architecture denies `command → relations-adapter`) can still obtain the
 * detected-edge half of the structural universe through this facade node.
 *
 * Returns `null` ONLY when the relation parse genuinely throws — the caller may
 * then fall back to the declared-relations-only view rather than fabricate
 * detected edges.
 */
export async function computeDetectedEdges(
  graph: Graph,
  projectRoot: string,
): Promise<Map<string, Set<string>> | null> {
  try {
    const pass = await runRelationPass(graph, projectRoot, {
      extractorFor: extractorForLanguage,
      resolvePathToFile: await guardedResolve(projectRoot, graph),
      symbolIndexDir: astCacheDir(graph.rootPath),
    });
    return pass.detectedEdgesByNode;
  } catch {
    return null;
  }
}
