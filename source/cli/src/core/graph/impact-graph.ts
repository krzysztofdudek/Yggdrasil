import path from 'node:path';
import { collectAllowedReadsForAspect } from '../../structure/allowed-reads.js';
import { isPathInMapping } from '../../structure/expand-mapping-sync.js';
import type { Graph } from '../../model/graph.js';
import type { LockFile } from '../../model/lock.js';
import type { ExpectedPair } from '../pairs.js';
import { toPosix } from '../../utils/posix.js';
import { isBetterMappingOwner } from '../../utils/mapping-path.js';

/**
 * Pure graph blast-radius / reverse-dependency algorithms for `yg impact`.
 *
 * These helpers take a loaded Graph and return derived data with no presentation
 * or argument-parsing concerns — the CLI command handler in cli/impact.ts owns
 * output formatting. Channel/iteration order is preserved so the hashed and
 * rendered outputs stay byte-stable.
 */

const STRUCTURAL_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);

/**
 * Node paths that currently hold a `refused` verdict for `aspectId` in the lock.
 *
 * Scans `lock.verdicts[aspectId]` unit keys (spec §8 refused-verdict annotation):
 *   - node:<path>  → the node path directly.
 *   - file:<repoRelPosix> → the owning node, resolved through the graph mapping
 *     (no per-node file IO — the lock + graph are enough).
 *
 * Returns a Set of model-relative node paths. Entries whose file maps to no node
 * (stale lock line, pruned by the next fill GC) are skipped.
 */
export function nodesWithRefusedVerdict(graph: Graph, lock: LockFile, aspectId: string): Set<string> {
  const refused = new Set<string>();
  const unitMap = lock.verdicts[aspectId];
  if (!unitMap) return refused;

  for (const unitKey of Object.keys(unitMap)) {
    if (unitMap[unitKey].verdict !== 'refused') continue;
    if (unitKey.startsWith('node:')) {
      refused.add(unitKey.slice('node:'.length));
      continue;
    }
    if (unitKey.startsWith('file:')) {
      const f = toPosix(unitKey.slice('file:'.length));
      const owner = ownerNodeForFile(graph, f);
      if (owner) refused.add(owner);
    }
  }
  return refused;
}

/**
 * Owning node path for a repo-relative POSIX file, resolved from the graph's node
 * mappings (longest-mapping wins, mirroring findOwner without the cli dependency).
 */
function ownerNodeForFile(graph: Graph, file: string): string | null {
  let best: { nodePath: string; len: number } | null = null;
  for (const [nodePath, node] of graph.nodes) {
    for (const m of (node.meta.mapping ?? []).map(toPosix)) {
      if (
        isPathInMapping(file, [m]) &&
        (!best || isBetterMappingOwner({ nodePath, mappingLen: m.length }, { nodePath: best.nodePath, mappingLen: best.len }))
      ) {
        best = { nodePath, len: m.length };
      }
    }
  }
  return best ? best.nodePath : null;
}

export function collectReverseDependents(
  graph: Graph,
  targetNode: string,
): {
  direct: string[];
  allDependents: string[];
  reverse: Map<string, Set<string>>;
  relationFrom: Map<string, { type: string; consumes?: string[] }>;
} {
  const reverse = new Map<string, Set<string>>();
  const relationFrom = new Map<string, { type: string; consumes?: string[] }>();
  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (!STRUCTURAL_TYPES.has(rel.type)) continue;
      const deps = reverse.get(rel.target) ?? new Set<string>();
      deps.add(nodePath);
      reverse.set(rel.target, deps);
      relationFrom.set(`${nodePath}->${rel.target}`, {
        type: rel.type,
        consumes: rel.consumes,
      });
    }
  }

  const direct = [...(reverse.get(targetNode) ?? [])].sort();
  const seen = new Set<string>(direct);
  const queue = [...direct];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of reverse.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  return {
    direct,
    allDependents: [...seen].sort(),
    reverse,
    relationFrom,
  };
}

export function buildTransitiveChains(
  targetNode: string,
  direct: string[],
  allDependents: string[],
  reverse: Map<string, Set<string>>,
): string[] {
  const directSet = new Set(direct);
  const transitiveOnly = allDependents.filter((t) => !directSet.has(t));
  if (transitiveOnly.length === 0) return [];

  const parent = new Map<string, string>();
  const queue: string[] = [targetNode];
  const visited = new Set<string>([targetNode]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of reverse.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, current);
      queue.push(next);
    }
  }

  const chains: string[] = [];
  for (const node of transitiveOnly) {
    const path: string[] = [];
    let current: string | undefined = node;
    while (current) {
      path.unshift(current);
      current = parent.get(current);
    }
    if (path.length >= 3) {
      chains.push(path.slice(1).map((p) => `<- ${p}`).join(' '));
    }
  }
  return chains.sort();
}

export function collectIndirectDependents(
  graph: Graph,
  directlyAffected: string[],
): { indirectPaths: string[]; chains: string[] } {
  const directSet = new Set(directlyAffected);

  // Build reverse adjacency map once (structural + event relations)
  const reverse = new Map<string, Set<string>>();
  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (!STRUCTURAL_TYPES.has(rel.type) && rel.type !== 'emits' && rel.type !== 'listens') continue;
      const deps = reverse.get(rel.target) ?? new Set<string>();
      deps.add(nodePath);
      reverse.set(rel.target, deps);
    }
  }

  // For each affected node, BFS to find reverse dependents and build chains
  const bestChain = new Map<string, { chain: string; depth: number }>();

  for (const affected of directlyAffected) {
    const parent = new Map<string, string>();
    const queue = [affected];
    const visited = new Set([affected]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of reverse.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        parent.set(next, current);
        queue.push(next);
      }
    }

    for (const [node] of parent) {
      if (directSet.has(node)) continue;

      // Trace path from node back to affected
      const path: string[] = [node];
      let current = node;
      while (parent.has(current)) {
        current = parent.get(current)!;
        path.push(current);
      }

      const chain = path.map((p) => `<- ${p}`).join(' ');
      const depth = path.length;

      const existing = bestChain.get(node);
      if (!existing || depth < existing.depth) {
        bestChain.set(node, { chain, depth });
      }
    }
  }

  const indirectPaths = [...bestChain.keys()].sort();
  const chains = indirectPaths.map((p) => bestChain.get(p)!.chain);
  return { indirectPaths, chains };
}

/**
 * Does a deterministic (or companion-LLM) entry's stored observation key reference
 * `repoRelative`?
 *
 * The lock records each cross-subject observation a deterministic check (or a
 * companion-backed LLM reviewer) made as a `[observationKey, hash]` pair under the
 * entry's `touched` array (spec §3.1). An edit to `repoRelative` invalidates a
 * verdict whose observation set contained:
 *   - read:<p>   / exists:<p>     → p === repoRelative (the bytes / existence probed)
 *   - list:<dir>                  → dir === dirname(repoRelative) (the file would
 *                                    appear in that directory listing, so adding /
 *                                    removing / renaming it changes the listing hash)
 *   - graph:<node>                → repoRelative IS that node's yg-node.yaml (any
 *                                    ctx.graph access folds the node's yaml bytes)
 *   - graph-children:<parentNode> → repoRelative IS that parent node's yg-node.yaml
 *                                    (editing a node's yaml may change its children
 *                                    membership observed via ctx.graph.children())
 *   - graph-flow:<flowName>       → repoRelative IS that flow's yg-flow.yaml (editing
 *                                    the flow file may change participant membership
 *                                    observed via ctx.graph.flow())
 *
 * NOTE: `graph-bytype:<type>` is intentionally NOT file-matchable here — the set of
 * nodes of a given type is determined by architecture and node metadata across the
 * whole repo, not by a single file path.
 *
 * Paths are compared in POSIX form. `repoRelative` is already repo-relative POSIX
 * (the impact command resolves it through `resolveFileArg`).
 */
export function touchedReferencesFile(
  touched: Array<[string, string]> | undefined,
  repoRelative: string,
): boolean {
  if (!touched || touched.length === 0) return false;
  const fileDir = toPosix(path.posix.dirname(repoRelative));
  for (const [key] of touched) {
    const sep = key.indexOf(':');
    if (sep < 0) continue;
    const kind = key.slice(0, sep);
    const target = key.slice(sep + 1);
    switch (kind) {
      case 'read':
      case 'exists':
        if (target === repoRelative) return true;
        break;
      case 'list':
        if (target === fileDir) return true;
        break;
      case 'graph': {
        // graph:<modelRelNodePath> → the file is that node's yg-node.yaml.
        const ygNodeRel = toPosix(path.posix.join('.yggdrasil', 'model', target, 'yg-node.yaml'));
        if (ygNodeRel === repoRelative) return true;
        break;
      }
      case 'graph-children': {
        // graph-children:<parentNodePath> → the parent node's yg-node.yaml.
        // Editing a node's yaml may change its children membership recorded by
        // ctx.graph.children(). Maps to the same file as graph:<parentNodePath>.
        const ygNodeRel = toPosix(path.posix.join('.yggdrasil', 'model', target, 'yg-node.yaml'));
        if (ygNodeRel === repoRelative) return true;
        break;
      }
      case 'graph-flow': {
        // graph-flow:<flowName> → .yggdrasil/flows/<flowName>/yg-flow.yaml.
        // Editing a flow file changes participant membership recorded by
        // ctx.graph.flow(). The target is the flow's name (directory name under flows/).
        const ygFlowRel = toPosix(path.posix.join('.yggdrasil', 'flows', target, 'yg-flow.yaml'));
        if (ygFlowRel === repoRelative) return true;
        break;
      }
      // graph-bytype:<type> is intentionally NOT file-matchable (no single file path
      // corresponds to the set of all nodes of a type).
      default:
        break;
    }
  }
  return false;
}

// ============================================================
// classifyInvalidations — synchronous invalidation buckets
// ============================================================

export type ImpactReason =
  | 'own'                           // F is in the pair's subject set
  | 'reference'                     // an LLM aspect references F (hashed into every pair of the aspect)
  | 'observe-companion'             // companion-LLM observation references F (warm lock OR cold-resolved)
  | 'observe-deterministic'         // deterministic check observation references F (warm lock)
  | 'cold-potential-deterministic'; // deterministic, no lock entry, F in allowed-reads (free, upper bound)

export interface InvalidatedPair {
  aspectId: string;
  unitKey: string;
  nodePath: string;
  kind: 'llm' | 'deterministic';
  reasons: ImpactReason[];
  mode: 'precise' | 'potential';
}

export interface UnresolvedUnit { aspectId: string; unitKey: string; nodePath: string; why: string }

export interface ImpactSet { pairs: InvalidatedPair[]; unresolved: UnresolvedUnit[] }

/**
 * Sync classification. Returns admitted pairs + the cold companion-LLM pairs that need
 * async resolution (a later task). A pair is a cold candidate ONLY if nothing else already
 * admitted it (no point running the resolver for a pair already known invalidated).
 */
export function classifyInvalidations(
  pairs: ExpectedPair[],
  graph: Graph,
  repoRelative: string,
  lock: LockFile,
): { pairs: InvalidatedPair[]; coldCompanionCandidates: ExpectedPair[] } {
  const admitted: InvalidatedPair[] = [];
  const coldCompanionCandidates: ExpectedPair[] = [];
  for (const p of pairs) {
    const aspect = graph.aspects.find((a) => a.id === p.aspectId);
    if (!aspect) continue;
    const reasons: ImpactReason[] = [];
    let mode: 'precise' | 'potential' = 'precise';

    if (p.subjectFiles.includes(repoRelative)) reasons.push('own');
    if (p.kind === 'llm' && aspect.references?.some((r) => r.path === repoRelative)) reasons.push('reference');

    const entry = lock.verdicts[p.aspectId]?.[p.unitKey];
    if (entry) {
      if (touchedReferencesFile(entry.touched, repoRelative)) {
        reasons.push(p.kind === 'llm' ? 'observe-companion' : 'observe-deterministic');
      }
    } else if (reasons.length === 0) {
      // cold (no lock entry) and not yet admitted by subject/reference
      if (p.kind === 'deterministic') {
        const allowed = collectAllowedReadsForAspect(p.nodePath, graph);
        if (isPathInMapping(repoRelative, [...allowed])) { reasons.push('cold-potential-deterministic'); mode = 'potential'; }
      } else if (p.kind === 'llm' && aspect.hasCompanion === true) {
        const allowed = collectAllowedReadsForAspect(p.nodePath, graph);
        if (isPathInMapping(repoRelative, [...allowed])) coldCompanionCandidates.push(p);
      }
    }

    if (reasons.length > 0) {
      admitted.push({ aspectId: p.aspectId, unitKey: p.unitKey, nodePath: p.nodePath, kind: p.kind, reasons, mode });
    }
  }
  return { pairs: admitted, coldCompanionCandidates };
}

