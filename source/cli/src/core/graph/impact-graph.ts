import path from 'node:path';
import { collectAllowedReadsForAspect } from '../../structure/allowed-reads.js';
import { isPathInMapping } from '../../structure/expand-mapping-sync.js';
import type { Graph } from '../../model/graph.js';
import type { LockFile } from '../../model/lock.js';
import type { ExpectedPair } from '../pairs.js';
import { toPosix } from '../../utils/posix.js';
import { buildOwnerIndex, guardOwnerIndex } from '../../relations/owner-index.js';
// Type-only: repo-scanner's GraphExclusionSet is a value the caller (cli/impact-handlers.ts,
// which already declares a relation to cli/io/stores) resolves; spelling its TYPE here
// creates no code edge for the relation-conformance pass to see, so this module needs no
// new relation just to name it.
import type { GraphExclusionSet } from '../../io/repo-scanner.js';

/**
 * Pure graph blast-radius / reverse-dependency algorithms for `yg impact`.
 *
 * These helpers take a loaded Graph and return derived data with no presentation
 * or argument-parsing concerns — the CLI command handler in cli/impact.ts owns
 * output formatting. Channel/iteration order is preserved so the hashed and
 * rendered outputs stay byte-stable.
 */

const STRUCTURAL_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);

/** No exclusion in effect — the default `nodesWithRefusedVerdict` uses when a caller
 *  passes none, so every existing call site keeps today's raw-lookup behavior
 *  byte-for-byte. Spelled as a literal (not imported) so this module never needs a
 *  value dependency on repo-scanner.ts just to name the empty case. */
const NO_EXCLUSION: GraphExclusionSet = { nestedRoots: new Set(), coverage: { required: [], excluded: [], typeLevel: false } };

/**
 * Node paths that currently hold a `refused` verdict for `aspectId` in the lock.
 *
 * Scans `lock.verdicts[aspectId]` unit keys (spec §8 refused-verdict annotation):
 *   - node:<path>  → the node path directly.
 *   - file:<repoRelPosix> → the owning node, resolved through the graph mapping
 *     (no per-node file IO — the lock + graph are enough).
 *
 * Returns a Set of model-relative node paths. Entries whose file maps to no node
 * (stale lock line, pruned by the next fill GC) are skipped — and so is an entry
 * whose file the graph now EXCLUDES (a nested project's own boundary, or a
 * `coverage.excluded` root added after the verdict was recorded): `exclusion`,
 * when supplied, guards the lookup the same way every other ownership answer in
 * the graph does, so a stale refused verdict on a now-excluded file can never be
 * shown here as a live refusal `yg owner --file` calls excluded on the same run.
 * Defaults to no exclusion (this module stays a pure graph algorithm; the caller
 * resolves the exclusion set — a filesystem walk — and hands it in).
 */
export function nodesWithRefusedVerdict(
  graph: Graph,
  lock: LockFile,
  aspectId: string,
  exclusion: GraphExclusionSet = NO_EXCLUSION,
): Set<string> {
  const refused = new Set<string>();
  const unitMap = lock.verdicts[aspectId];
  if (!unitMap) return refused;

  // The canonical hierarchy-first file→owner resolver, guarded against `exclusion`,
  // built once for this scan.
  const ownerOf = guardOwnerIndex(buildOwnerIndex(graph.nodes), exclusion).ownerOf;

  for (const unitKey of Object.keys(unitMap)) {
    if (unitMap[unitKey].verdict !== 'refused') continue;
    if (unitKey.startsWith('node:')) {
      refused.add(unitKey.slice('node:'.length));
      continue;
    }
    if (unitKey.startsWith('file:')) {
      const f = toPosix(unitKey.slice('file:'.length));
      const owner = ownerOf(f);
      if (owner) refused.add(owner);
    }
  }
  return refused;
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

/** One indirect dependent and the components the dependency travels through. */
export interface TransitivePath {
  /** The indirect dependent. */
  node: string;
  /**
   * Intermediate components on the shortest reverse path, subject-first —
   * never the subject itself and never `node`.
   */
  via: string[];
}

/**
 * The indirect dependents of `targetNode`, each with the components the
 * dependency travels through.
 *
 * One BFS over the reverse edges, shortest path wins. A dependent reached with
 * no intermediary at all is a DIRECT dependent by another name and is left out
 * here (`direct` already lists it) — so every entry has a non-empty `via`.
 *
 * This is the single computation behind both the text chains and the machine
 * document: `buildTransitiveChains` renders these same paths as `<- a <- b`
 * strings, so the two views can never disagree about who is reached through
 * whom.
 */
export function buildTransitivePaths(
  targetNode: string,
  direct: string[],
  allDependents: string[],
  reverse: Map<string, Set<string>>,
): TransitivePath[] {
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

  const paths: TransitivePath[] = [];
  for (const node of transitiveOnly) {
    const path: string[] = [];
    let current: string | undefined = node;
    while (current) {
      path.unshift(current);
      current = parent.get(current);
    }
    // [targetNode, ...intermediaries, node] — a length below 3 means no
    // intermediary, i.e. not actually transitive.
    if (path.length >= 3) {
      paths.push({ node, via: path.slice(1, -1) });
    }
  }
  return paths;
}

export function buildTransitiveChains(
  targetNode: string,
  direct: string[],
  allDependents: string[],
  reverse: Map<string, Set<string>>,
): string[] {
  return buildTransitivePaths(targetNode, direct, allDependents, reverse)
    .map(({ node, via }) => [...via, node].map((p) => `<- ${p}`).join(' '))
    .sort();
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
 *   - graph-children:<parentNode> → repoRelative IS that parent node's yg-node.yaml,
 *                                    OR the yg-node.yaml of one of its DIRECT children
 *                                    (editing the parent's yaml may change its children
 *                                    membership observed via ctx.graph.children(); adding
 *                                    or deleting a child's yaml moves that membership
 *                                    outright, and the observing unit need not be the
 *                                    parent — any unit may call children() on a relation
 *                                    target)
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
        // ...AND a DIRECT CHILD's own yg-node.yaml. A directory becomes a node
        // exactly when it gains a yg-node.yaml, and the loader stops descending
        // at a directory that has none — so a node's direct children are
        // precisely the one-segment subdirectories under it that carry that
        // file, and adding or deleting one is what MOVES the membership
        // ctx.graph.children(target) recorded. Matching only the parent's own
        // yaml (as this did) misses that case entirely whenever the observing
        // unit is not the parent itself — e.g. a check on node A that called
        // children(B) for a relation target B. Deeper paths are deliberately
        // NOT matched: a node two levels down cannot exist unless the level
        // between it is a node too, so it changes THAT node's children, not
        // this one's.
        const childPrefix = `${toPosix(path.posix.join('.yggdrasil', 'model', target))}/`;
        const CHILD_YAML_SUFFIX = '/yg-node.yaml';
        if (repoRelative.startsWith(childPrefix) && repoRelative.endsWith(CHILD_YAML_SUFFIX)) {
          const between = repoRelative.slice(
            childPrefix.length,
            repoRelative.length - CHILD_YAML_SUFFIX.length,
          );
          if (between !== '' && !between.includes('/')) return true;
        }
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
  /** Absent for a nodeless (type-covered-file) pair — follows ExpectedPair's optionality. */
  nodePath?: string;
  kind: 'llm' | 'deterministic';
  reasons: ImpactReason[];
  mode: 'precise' | 'potential';
}

export interface UnresolvedUnit { aspectId: string; unitKey: string; nodePath?: string; why: string }

export interface ImpactSet { pairs: InvalidatedPair[]; unresolved: UnresolvedUnit[] }

/**
 * Sync classification. Returns admitted pairs + the cold companion-LLM pairs that still need
 * async companion resolution — the caller (`collectInvalidatedPairs`, cli/impact-handlers.ts)
 * resolves each one and folds a hit back into admitted pairs. A pair is a cold candidate ONLY
 * if nothing else already admitted it (no point running the resolver for a pair already known
 * invalidated).
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
    } else if (reasons.length === 0 && p.nodePath !== undefined) {
      // cold (no lock entry) and not yet admitted by subject/reference. Skipped
      // entirely for a nodeless pair: there is no component whose allowed-reads
      // apply (collectAllowedReadsForAspect would return ∅ for an absent path —
      // the safe reading — but this makes the skip explicit rather than relying
      // on that fall-through). A nodeless pair can still be admitted above
      // (own/reference/observe), just never through this cold-start estimate.
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

