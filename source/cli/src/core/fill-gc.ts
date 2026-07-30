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
import type { TypeCoverageInput } from './pairs.js';
import { toPosix } from '../utils/posix.js';
import { buildOwnerIndex } from '../relations/owner-index.js';

/**
 * The writer's own report of what it pruned this run — printed by `--approve`
 * and `--dry-run` whenever entries are pruned, split into billed (LLM — a
 * re-verify would cost a reviewer call) vs free (deterministic), with a reason
 * per entry. Empty (all counts 0, empty `entries`) whenever nothing was pruned.
 *
 * A pruned entry's aspect can be gone from the graph entirely (the reason
 * `'aspect removed'`), which means its reviewer kind cannot be read off
 * `graph.aspects` any more. `'unknown'` is that honest third state: an entry
 * neither the graph nor the caller-supplied on-disk lock partition (see
 * `garbageCollectAndRewrite`'s `detAspectIdsOnDisk` option) could classify.
 * It is never folded into `billedCount` or `freeCount` — a caller that cannot
 * prove an entry was free must not report it as free.
 */
export interface PruneSummary {
  entries: Array<{ aspectId: string; unitKey: string; kind: 'llm' | 'deterministic' | 'unknown'; reason: string }>;
  billedCount: number;
  freeCount: number;
  unknownCount: number;
}

/**
 * The owning node path for a verdict entry's unit key. `node:<path>` resolves
 * directly; `file:<path>` resolves through the canonical owner index. Returns
 * null only for a `file:` key whose file maps to no node (genuinely detached).
 *
 * `ownerOf` is the shared hierarchy-first resolver (`buildOwnerIndex().ownerOf`);
 * the caller builds it ONCE per GC run and passes it in, so attribution here
 * matches the subject-set the gate actually verifies. Used only to attribute a
 * `file:` verdict entry to a node during GC's positively-detached proof.
 */
export function owningNodeForUnitKey(
  ownerOf: (repoRelPosix: string) => string | undefined,
  unitKey: string,
): string | null {
  if (unitKey.startsWith('node:')) return unitKey.slice('node:'.length);
  if (unitKey.startsWith('file:')) return ownerOf(toPosix(unitKey.slice('file:'.length))) ?? null;
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
 *
 * A third retain family (R3/K3, Task 6): a file the type-level classification
 * lattice reported AMBIGUOUS this run (`opts.typeCoverage.ambiguousPaths`) — the
 * machine could not decide its type, so nothing about it is positively detached
 * either. Aspect-agnostic and PATH-keyed (unlike the other two families, which
 * are keyed per aspect+unit): every verdict entry under that file's `file:` unit
 * key is retained regardless of which aspect it belongs to, since the ambiguity
 * is a property of the FILE, not of any one rule.
 *
 * `opts.typeCoverage`, threaded straight into `computeExpectedPairs`, is what
 * puts nodeless (`file:`) pairs into the universe at all (R5) — the presence of
 * those keys in `universe`, not `owningNodeForUnitKey`'s attribution (unchanged,
 * still node-domain only), is the anti-prune lever for a file enforced by its
 * architecture type. Returns a `PruneSummary` of every entry actually deleted.
 *
 * `opts.detAspectIdsOnDisk` (optional): the aspectIds whose verdicts live in
 * the gitignored deterministic file, read directly from disk
 * (`readDetLockAspectIds`) rather than off the current graph. Used ONLY to
 * classify a pruned entry whose aspect no longer exists in `graph.aspects` —
 * `reviewer.type` cannot answer for a deleted aspect, but the file its
 * verdicts were last written to still can, and that provenance never changes
 * just because the aspect's definition is gone. Absent (a caller with no
 * on-disk lock to consult, e.g. a pure in-memory test) means such an entry is
 * reported with kind `'unknown'` rather than guessed.
 */
export async function garbageCollectAndRewrite(
  graph: Graph,
  lock: LockFile,
  persistLock: () => Promise<void>,
  opts?: { typeCoverage?: TypeCoverageInput; detAspectIdsOnDisk?: Set<string> },
): Promise<PruneSummary> {
  const emptySummary: PruneSummary = { entries: [], billedCount: 0, freeCount: 0, unknownCount: 0 };

  // A node/aspect that failed to parse hides itself (and, for a node, its whole
  // subtree) from the graph, so its pairs never reach the universe. While the
  // graph is provably incomplete GC cannot prove anything detached — skip pruning
  // and the rewrite entirely, leaving the committed lock byte-for-byte untouched.
  if ((graph.nodeParseErrors?.length ?? 0) > 0 || (graph.aspectParseErrors?.length ?? 0) > 0) {
    return emptySummary;
  }

  const { pairs, unreadable } = await computeExpectedPairs(graph, {
    includeDraft: true,
    typeCoverage: opts?.typeCoverage,
  });
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
  // on the same node still prune normally. A nodeless unreadable subject has no
  // node: unit to retain — only the file: key applies to it.
  const unreadableUnits = new Set<string>(); // `${aspectId}\0${unitKey}`
  for (const u of unreadable) {
    if (u.nodePath !== undefined) unreadableUnits.add(`${u.aspectId}\0${nodeUnit(u.nodePath)}`);
    unreadableUnits.add(`${u.aspectId}\0${fileUnit(u.path)}`);
  }

  // Ambiguous-file retain family (R3/K3): aspect-agnostic, keyed by the file's
  // OWN `file:` unit key — every aspect's entry for that file is retained.
  const ambiguousFileUnits = new Set(
    (opts?.typeCoverage?.ambiguousPaths ?? []).map((p) => fileUnit(p)),
  );

  // Build the canonical file→owner resolver ONCE for the whole prune loop below,
  // outside the per-entry iteration.
  const ownerOf = buildOwnerIndex(graph.nodes).ownerOf;

  // Index aspect defs by id so a pruned entry's reviewer kind (billed vs free) is
  // known for the summary without a per-entry linear scan.
  const aspectKindById = new Map<string, 'llm' | 'deterministic'>();
  for (const a of graph.aspects) {
    if (a.reviewer.type === 'llm' || a.reviewer.type === 'deterministic') {
      aspectKindById.set(a.id, a.reviewer.type);
    }
  }

  const prunedEntries: PruneSummary['entries'] = [];
  let billedCount = 0;
  let freeCount = 0;
  let unknownCount = 0;

  // Prune verdicts ∉ universe, EXCEPT entries owned by an uncomputable node, whose
  // subject was unreadable this run, or whose file was reported ambiguous.
  for (const aspectId of Object.keys(lock.verdicts)) {
    const unitMap = lock.verdicts[aspectId];
    for (const unitKey of Object.keys(unitMap)) {
      if (universe.has(`${aspectId}\0${unitKey}`)) continue;
      if (unreadableUnits.has(`${aspectId}\0${unitKey}`)) continue;
      if (unitKey.startsWith('file:') && ambiguousFileUnits.has(unitKey)) continue;
      const owner = owningNodeForUnitKey(ownerOf, unitKey);
      // Retain only when we can attribute the entry to a node that could not be
      // computed this run. Everything else (deleted node, detached aspect,
      // deleted/unmapped file, re-typed-away file) is positively detached → prune.
      if (owner !== null && uncomputable.has(owner)) continue;

      // The aspect is still in the graph → its CURRENT reviewer.type is the
      // kind, exactly as before. Gone from the graph entirely (the 'aspect
      // removed' reason below) → reviewer.type cannot answer any more; fall
      // back to where its verdicts physically live on disk (billed/free are
      // still knowable — the aspect's definition is gone, not its history),
      // and only report 'unknown' when even that provenance is unavailable.
      // Never default a classification failure to 'deterministic' — that
      // would silently under-report billed (LLM) work as free.
      const kind: 'llm' | 'deterministic' | 'unknown' = aspectKindById.get(aspectId) ??
        (opts?.detAspectIdsOnDisk === undefined
          ? 'unknown'
          : opts.detAspectIdsOnDisk.has(aspectId) ? 'deterministic' : 'llm');
      const reason = unitKey.startsWith('node:') && !graph.nodes.has(unitKey.slice('node:'.length))
        ? 'node deleted'
        : !aspectKindById.has(aspectId)
          ? 'aspect removed'
          : 'no longer in the expected pair set';
      prunedEntries.push({ aspectId, unitKey, kind, reason });
      if (kind === 'llm') billedCount++;
      else if (kind === 'deterministic') freeCount++;
      else unknownCount++;

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

  return { entries: prunedEntries, billedCount, freeCount, unknownCount };
}
