/**
 * source/cli/src/core/fill-closing-phase.ts — steps 7, 7b and 8 of the fill
 * stage (spec §7): what the run records once every fill is done — positive
 * closure, the rule standings, and the garbage collection with its canonical
 * rewrite.
 *
 * Each of them re-reads the POST-FILL lock on purpose: they must see the
 * verdicts this run just wrote, so the pre-fill classification is deliberately
 * not threaded through any of them.
 */

import type { Graph } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { FillEventSink } from '../model/fill-event.js';
import type { TypeCoverageInput } from './pairs.js';
import type { VerdictWriter } from './fill-shared.js';
import type { PruneSummary } from './fill-gc.js';
import { applyPositiveClosure } from './fill-closure.js';
import { garbageCollectAndRewrite } from './fill-gc.js';
import { recordAspectStatuses } from './log/aspect-status.js';

export interface ClosingPhaseParams {
  graph: Graph;
  projectRoot: string;
  lock: LockFile;
  /** The log-gate set: a node whose pairs were skipped can never close over stale verdicts. */
  blockedNodes: Set<string>;
  writer: VerdictWriter;
  typeCoverage: TypeCoverageInput | undefined;
  /** Reviewer pairs this run was told not to buy (see applyPositiveClosure's note on (c)). */
  skippedOutsideLlmPairKeys: Set<string>;
  detAspectIdsOnDisk: Set<string>;
  onlyDeterministic: boolean;
  now: () => number;
  emit: FillEventSink;
}

/** Record closure and rule standings, then GC the lock; returns what GC pruned. */
export async function runClosingPhase(params: ClosingPhaseParams): Promise<PruneSummary> {
  const { graph, projectRoot, lock, blockedNodes, writer, typeCoverage, onlyDeterministic, now, emit } = params;

  // ── Step 7: Positive closure (§7.5). ──────────────────────────────────────
  // A node with a missing/stale fingerprint closes (records source + log
  // baseline) only when ALL its enforced effective pairs are approved.
  // Skipped under --only-deterministic: closure records source + log baseline to the
  // COMMITTED logs file, which a deterministic-only / CI run must never write.
  if (!onlyDeterministic) {
    // The skipped set is what lets closure tell a pair this run was told not to
    // buy from one that is unverified because something went wrong. Without it a
    // scoped run would leave every such component's cycle open forever, and an
    // open cycle lets ONE justification entry answer for every later edit — see
    // applyPositiveClosure's own note on (c).
    await applyPositiveClosure(
      graph, projectRoot, lock, blockedNodes, writer.persistLock, typeCoverage,
      params.skippedOutsideLlmPairKeys,
    );
  }

  // ── Step 7b: Rule standings. ───────────────────────────────────────────────
  // The standing each rule was last seen at is remembered here, and a standing
  // that moved since — a promotion or a demotion made by hand, which is the only
  // way a status changes today — is written into that rule's own log once. The
  // memory is LOCAL — it rides with the gitignored verdict cache — so the
  // ordinary writer persists it in both modes. The log line is NOT local: it is
  // appended to the rule's committed log (`log.md` beside a rule of this
  // repository's own, `yg-aspect.adapt.log.md` beside the adaptation of a rule
  // installed from a package, never a file inside the package's copy). So under
  // --only-deterministic, which writes no committed file, the log line is not
  // written and the memory of that rule is not advanced: the warning keeps
  // standing until a full `--approve` writes the line or somebody records the
  // change with `yg aspects log add`.
  const statuses = await recordAspectStatuses(graph, lock, now(), { writeLogs: !onlyDeterministic });
  if (statuses.changed) await writer.persistLock();
  for (const drift of statuses.recorded) {
    emit({ type: 'rule-status', aspectId: drift.aspectId, from: drift.from, to: drift.to });
  }

  // ── Step 8: GC + canonical rewrite (§3.2). ────────────────────────────────
  // typeCoverage IS threaded (computed once at the top of the run) — this is the
  // anti-prune lever: without it, the first --approve after enabling the feature
  // would prune every file-level result as detached.
  return garbageCollectAndRewrite(graph, lock, writer.persistLock, {
    typeCoverage,
    detAspectIdsOnDisk: params.detAspectIdsOnDisk,
    scope: onlyDeterministic ? 'deterministic' : 'all',
  });
}
