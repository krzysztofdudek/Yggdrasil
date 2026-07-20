/**
 * source/cli/src/core/fill-gc.ts — garbage collection + canonical lock rewrite for
 * the fill stage (spec §3.2). Prunes verdict entries whose pair left the expected
 * universe and `nodes` entries for vanished node paths, then rewrites the lock
 * canonically. GC may only prune entries it can POSITIVELY prove are detached.
 */

import type { Graph } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import { LOCK_FORMAT_VERSION, nodeUnit, fileUnit } from '../model/lock.js';
import { computeExpectedPairs, computeUncomputableNodes } from './pairs.js';
import { toPosix } from '../utils/posix.js';
import { isBetterMappingOwner } from '../utils/mapping-path.js';
import { isPathInMapping } from '../structure/expand-mapping-sync.js';

/**
 * Owning node path for a repo-relative POSIX file, resolved from the graph's node
 * mappings (longest-mapping wins). Returns null when no node maps the file. Used
 * only to attribute a `file:` verdict entry to a node during GC's
 * positively-detached proof — never for read scoping.
 */
export function ownerNodeForFile(graph: Graph, file: string): string | null {
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

/**
 * The owning node path for a verdict entry's unit key. `node:<path>` resolves
 * directly; `file:<path>` resolves through the node mappings. Returns null only
 * for a `file:` key whose file maps to no node (genuinely detached).
 */
export function owningNodeForUnitKey(graph: Graph, unitKey: string): string | null {
  if (unitKey.startsWith('node:')) return unitKey.slice('node:'.length);
  if (unitKey.startsWith('file:')) return ownerNodeForFile(graph, toPosix(unitKey.slice('file:'.length)));
  /* v8 ignore next -- unit keys are always node:/file: by construction */
  return null;
}

/**
 * Prune verdict entries whose pair is no longer in the expected universe
 * (includeDraft: true — draft pairs keep their entries) and `nodes` entries for
 * node paths absent from the graph, then rewrite canonically.
 *
 * GC may only prune entries it can POSITIVELY prove are detached. A node whose
 * effective-aspect computation THROWS (an implies cycle, etc.) is silently
 * skipped by computeExpectedPairs, so it contributes NO pairs to the universe —
 * its entries would look detached even though they are valid paid verdicts.
 * Such a node's entries are RETAINED untouched (the validator still surfaces the
 * cycle as a blocking error). The universe accounts only for nodes that COULD be
 * computed, so an entry is pruned iff (pair ∉ universe) AND (its owning node was
 * NOT uncomputable this run) AND (its subject was not unreadable this run) — a
 * node that vanished from the graph is not uncomputable (it is not iterated), so
 * its entries remain prunable.
 *
 * Two further incompleteness conditions also block pruning, because under them the
 * graph cannot positively prove ANYTHING detached:
 *   - A yg-node.yaml / yg-aspect.yaml that failed to PARSE this run is absent from
 *     the graph entirely (the loader records it in nodeParseErrors/aspectParseErrors
 *     and never adds it — nor, for a node, any of its descendants — to graph.nodes /
 *     graph.aspects). Its still-valid verdict entries would look detached. While any
 *     parse error is present GC skips pruning AND the canonical rewrite entirely; the
 *     validator surfaces the parse error as a blocking `yaml-invalid`, and a later
 *     clean run resumes GC normally.
 *   - A mapped subject file that was UNREADABLE this run (EACCES, vanished mid-run,
 *     over the scan-size limit) is dropped from its aspect's subject set; when that
 *     empties the set, no pair is emitted and the verdict looks detached even though
 *     the file is still mapped and still exists. Such a pair is RETAINED (the run is
 *     already red from the blocking file-unreadable error). This mirrors the
 *     protection fill-closure applies for the same root cause.
 */
export async function garbageCollectAndRewrite(
  graph: Graph,
  lock: LockFile,
  persistLock: () => Promise<void>,
): Promise<void> {
  // A node/aspect that failed to parse hides itself (and, for a node, its whole
  // subtree) from the graph, so its pairs never reach the universe. While the
  // graph is provably incomplete GC cannot prove anything detached — skip pruning
  // and the rewrite entirely, leaving the committed lock byte-for-byte untouched.
  if ((graph.nodeParseErrors?.length ?? 0) > 0 || (graph.aspectParseErrors?.length ?? 0) > 0) {
    return;
  }

  const { pairs, unreadable } = await computeExpectedPairs(graph, { includeDraft: true });
  const universe = new Set<string>(); // `${aspectId}\0${unitKey}`
  for (const p of pairs) universe.add(`${p.aspectId}\0${p.unitKey}`);

  // Nodes whose effectiveness threw this run — their pairs never reach the
  // universe, so their entries must NOT be treated as detached.
  const uncomputable = computeUncomputableNodes(graph);

  // Pairs whose subject file was unreadable this run — their pair is dropped from
  // the universe (an empty subject set emits no pair), yet the file is still
  // mapped and still exists, so the verdict is NOT positively detached. Retain
  // both the per:node unit and the per:file unit so the guard covers whichever
  // scope the aspect uses, keyed exactly (aspectId + unit) so unrelated verdicts
  // on the same node still prune normally.
  const unreadableUnits = new Set<string>(); // `${aspectId}\0${unitKey}`
  for (const u of unreadable) {
    unreadableUnits.add(`${u.aspectId}\0${nodeUnit(u.nodePath)}`);
    unreadableUnits.add(`${u.aspectId}\0${fileUnit(u.path)}`);
  }

  // Prune verdicts ∉ universe, EXCEPT entries owned by an uncomputable node or
  // whose subject was unreadable this run.
  for (const aspectId of Object.keys(lock.verdicts)) {
    const unitMap = lock.verdicts[aspectId];
    for (const unitKey of Object.keys(unitMap)) {
      if (universe.has(`${aspectId}\0${unitKey}`)) continue;
      if (unreadableUnits.has(`${aspectId}\0${unitKey}`)) continue;
      const owner = owningNodeForUnitKey(graph, unitKey);
      // Retain only when we can attribute the entry to a node that could not be
      // computed this run. Everything else (deleted node, detached aspect,
      // deleted/unmapped file) is positively detached → prune.
      if (owner !== null && uncomputable.has(owner)) continue;
      delete unitMap[unitKey];
    }
    if (Object.keys(unitMap).length === 0) delete lock.verdicts[aspectId];
  }

  // Prune nodes for absent node paths.
  for (const nodePath of Object.keys(lock.nodes)) {
    if (!graph.nodes.has(nodePath)) delete lock.nodes[nodePath];
  }

  lock.version = LOCK_FORMAT_VERSION;
  await persistLock();
}
