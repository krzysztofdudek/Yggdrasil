/**
 * source/cli/src/core/fill-report-phase.ts — step 9 of the fill stage (spec §7):
 * the closing summaries and the read the run reports.
 *
 * Summaries first (the prune summary and the closing totals), then the progress
 * output is drained and stopped, then the read is re-run over the post-fill
 * lock, every pair this run could not fill is given its cause on that report,
 * and the convergence sentinel looks for the one divergence the report alone
 * would hide.
 */

import type { Graph } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { IssueMessage } from '../model/validation.js';
import type { FillEventSink } from '../model/fill-event.js';
import type { CheckResult } from './check.js';
import type { TypeCoverageInput } from './pairs.js';
import type { RunFillOptions } from './fill-contract.js';
import type { FillPairSets } from './fill-classify.js';
import type { FillCoverage } from './fill-coverage-phase.js';
import type { DetPhaseResult } from './fill-det-phase.js';
import type { LlmPhaseResult } from './fill-llm-phase.js';
import type { PruneSummary } from './fill-gc.js';
import type { VerdictWriter } from './fill-shared.js';
import type { ProgressTracker } from './fill-progress.js';
import { runCheck } from './check.js';
import { verifyLock } from './verify-lock.js';
import { annotateFillCauses, reportFillTotals } from './fill-report.js';
import { countPostUnverified, reportDivergenceIfDetected } from './fill-divergence.js';
import { debugWrite } from '../utils/debug-log.js';

export interface ReportPhaseParams {
  graph: Graph;
  opts: RunFillOptions;
  lock: LockFile;
  classification: FillPairSets;
  coverage: FillCoverage;
  det: DetPhaseResult;
  llm: LlmPhaseResult;
  pruneSummary: PruneSummary;
  /** How many units the deterministic gate kept from paid review this run. */
  skippedByDetGate: number;
  reviewerConfigured: boolean;
  onlyDeterministic: boolean;
  retry: string;
  /** The injected clock reading the run started at, for the closing line's wall time. */
  startedAt: number;
  writer: VerdictWriter;
  tracker: ProgressTracker;
  /** Stops the progress heartbeat; called once every queued write has drained. */
  stopTicking: () => void;
  emit: FillEventSink;
  emitIssue: (msg: IssueMessage) => void;
}

/** Summarise the run, re-run the read, and return the report it prints. */
export async function runReportPhase(params: ReportPhaseParams): Promise<CheckResult> {
  const { graph, opts, lock, classification, coverage, det, llm, reviewerConfigured, retry, writer, tracker, emit, emitIssue } = params;
  emit({ type: 'prune', ...params.pruneSummary });
  reportFillTotals({
    reviewerCallsMade: llm.reviewerCallsMade,
    infraFailures: llm.infraFailures,
    runtimeErrors: det.runtimeErrors,
    companionRuntimeErrors: llm.companionRuntimeErrors,
    malformedSuppressErrors: det.malformedSuppressErrors,
    skippedLlmPairs: classification.skippedLlmPairs,
    skippedOutsideLlmPairs: classification.skippedOutsideLlmPairs,
    infraReport: llm.infraReport,
    detApproved: det.approved,
    detRefused: det.refused,
    skippedByDetGate: params.skippedByDetGate,
    reviewerConfigured,
    retry,
    // Refusals the lock already held for unchanged inputs: they stand after
    // this run, so its closing line must not claim every pair is valid.
    cachedRefusals: classification.verification.pairs.filter((vp) => vp.state.kind === 'refused').length,
    elapsedMs: Math.max(0, opts.now() - params.startedAt),
    usage: llm.usage,
    outcomes: tracker.counts(),
  }, emit, emitIssue);

  // Drain all queued progress writes first, then stop the timer and clear the TTY line.
  await writer.drain();
  params.stopTicking();
  tracker.clearLine(emit);

  // The `yg check --approve` combiner prints this report after filling. This IS the
  // reporting path for `--approve`, so it maintains the silent feature-field index when the
  // CLI asks (best-effort, byproduct-free elsewhere). The dry-run re-check returns before
  // this phase is reached, so a cost preview never writes it regardless of the flag.
  const checkResult = await runCheck(graph, opts.coverageVisibleFiles, {
    // A real fill already ran the repository's rule code; its report sizes a
    // stale companion pair with the companions resolved, as the fill itself did.
    // Under --only-deterministic no companion ran, and the report runs none
    // either: it sizes such a pair exactly as a plain `yg check` does.
    runCompanionHooks: !params.onlyDeterministic,
    writeFeatureIndex: opts.writeFeatureIndex,
    now: opts.featureIndexNow,
    nowUtc: opts.reviewNowUtc,
    rulesArtifacts: opts.rulesArtifacts,
    reasonlessSuppressMarkers: opts.reasonlessSuppressMarkers,
    trackedFiles: opts.trackedFiles,
    precomputedTypeCoverage: coverage.typeCoverageResult,
    // Same pass, reused: a fill writes lock and log files, never source, so what
    // it resolved before the fill it would resolve identically now. Deliberately
    // NOT accompanied by precomputedVerification — this run DID write verdicts,
    // so the lock must be re-verified for the report to describe it.
    precomputedRelationPass: coverage.relPassResult,
    // The in-process fill→check handoff (core/type-visibility.ts's own module
    // comment names this the missing piece): THIS run's own runtimeDispositions,
    // so the report it is about to build can name a component-free disposition
    // by reason instead of a bare "unverified" caveat. A run that never fills
    // (plain `yg check`, or a later separate invocation) passes nothing here and
    // gets runCheck's own empty-array default — the qualified fallback wording.
    runtimeDispositions: det.runtimeDispositions,
    // This run's own measurement, so a recording run and a plain read of the
    // same working tree agree about the build. Without it the two disagreed by
    // construction: a project could pass `yg check` and fail `yg check
    // --approve` on findings the change never reached, and the command the
    // failing report pointed at was the one that answered for everything.
    changeScope: opts.changeScope,
  });

  // The report above is rebuilt from the lock, which records verdicts and never
  // failures — so every pair this run could not fill would read as merely "not
  // yet reviewed", pointing back at the command that just failed on it. Name
  // each one's cause and its real fix on the report (and so in --json) instead.
  annotateFillCauses(checkResult, [
    ...det.runtimeItems.map((item) => ({ ...item, cause: 'check-failed-to-run' as const })),
    ...det.malformedSuppressItems.map((item) => ({ ...item, cause: 'suppress-marker-invalid' as const })),
    ...llm.unreachableItems.map((item) => ({ ...item, cause: 'reviewer-unreachable' as const })),
    ...llm.poolInfraItems.map((item) => ({
      ...item,
      cause: reviewerConfigured ? 'reviewer-failed' as const : 'reviewer-missing' as const,
    })),
  ], retry);

  await runConvergenceSentinel({
    graph, lock, checkResult, typeCoverage: coverage.typeCoverageInput,
    toFill: classification.unverifiedPairs.length, lockWrites: writer.lockWrites,
    emitIssue, divergenceWrite: opts.divergenceWrite,
  });
  return checkResult;
}

/**
 * Convergence sentinel (C15) — READ-ONLY over the fill's own state.
 *
 * Detect the exact 0-fill divergence: the pre-fill classification reported ZERO
 * pairs to fill, yet the post-fill report finds unverified pairs, with NO
 * verdict written in between. That triad is a genuine convergence gap (the
 * classifier disagreed with itself over unchanged inputs) that would otherwise
 * be silent. On fire: emit ONE notice and record a bounded evidence dump via
 * the injected io writer. This NEVER alters exit codes, verdicts, the lock, or
 * fill flow, and is wrapped in a swallow-all — a sentinel failure must never
 * fail a fill.
 */
async function runConvergenceSentinel(params: {
  graph: Graph;
  lock: LockFile;
  checkResult: CheckResult;
  typeCoverage: TypeCoverageInput | undefined;
  /**
   * Deliberately the UNFILTERED classification count, not the fill set: the
   * pathology is "the classifier found nothing to do, yet pairs are still
   * unverified afterwards". A run that found work and then narrowed it away
   * has an obvious, honest reason for the leftovers, and priming the sentinel
   * with the narrowed number would fire it on every scoped run.
   */
  toFill: number;
  lockWrites: number;
  emitIssue: (msg: IssueMessage) => void;
  divergenceWrite: RunFillOptions['divergenceWrite'];
}): Promise<void> {
  const { graph, lock, typeCoverage } = params;
  try {
    // Both spellings of the same finding — see countPostUnverified.
    const postUnverified = countPostUnverified(params.checkResult.issues);
    const shape = { toFill: params.toFill, postUnverified, lockWrites: params.lockWrites };
    await reportDivergenceIfDetected(shape, lock, {
      emitIssue: params.emitIssue,
      divergenceWrite: params.divergenceWrite,
      // Read-only enumeration (only invoked on fire): a fresh verifyLock pass
      // names the divergent pairs; buildDivergenceDump attaches each pair's
      // already-stored lock hash — nothing is re-hashed and nothing is written.
      enumerate: async () => {
        const postVerification = await verifyLock(graph, lock, typeCoverage);
        return postVerification.pairs
          .filter((vp) => vp.state.kind === 'unverified')
          .map((vp) => ({ aspectId: vp.pair.aspectId, unitKey: vp.pair.unitKey }));
      },
    });
  } catch (e) {
    debugWrite(`[fill] convergence sentinel failed (swallowed): ${e instanceof Error ? e.message : String(e)}`);
  }
}
