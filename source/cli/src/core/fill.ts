/**
 * source/cli/src/core/fill.ts — the `yg check --approve` fill stage (spec §7).
 *
 * Plain `yg check` is a pure read; `--approve` fills every UNVERIFIED pair, then
 * re-runs the read and reports. Fill is the ONLY place a deterministic check.mjs
 * or an LLM reviewer executes.
 *
 * Order (spec §7):
 *   1. Structural gate — validate(graph); a gating code (tier/reviewer config
 *      broken, an aspect-implies cycle, or an escaping mapping) aborts the
 *      whole fill (no fills, no LLM calls). So does a node log.md that is not
 *      settled — conflict markers, a rewritten history, a body that does not
 *      parse — for every run except --only-deterministic and --dry-run (neither
 *      records a baseline), since closure would
 *      record a baseline over it. One exception: a missing reviewer
 *      does not gate a run that would never call one (--only-deterministic),
 *      a preview (--dry-run), or a project whose judgment rules are all
 *      advisory — the deterministic pairs still fill, and the judgment pairs
 *      stay unverified with the missing reviewer named as the cause.
 *   2. Classify pairs through the SAME engine plain check uses (verifyLock) —
 *      one implementation, so a verdict fill writes here verifies there.
 *      prompt-too-large pairs are SKIPPED (gate precedence, §4). When the caller
 *      supplies a change scope, the PAID half of the fill set is narrowed to the
 *      obligations that change is accountable for; the free deterministic half
 *      is always the whole project.
 *   3. Log gate (§9): if ANY component this run would fill a pair of is a
 *      log_required node whose OWN source changed since its recorded baseline
 *      with no fresh entry, the run fills NOTHING (throws FillGatingError before
 *      any deterministic or LLM fill) and stays red — including for a component
 *      the current change never reached, since a recorded verdict must not rest
 *      on an unexplained edit whoever made it. Only the source counts: a rule,
 *      graph, relation, lock or verdict change re-opens pairs but owes no
 *      entry. A changed component the run fills nothing of does not stop it; the
 *      plain read keeps it red. It runs BEFORE the header, so a run it stops
 *      never announces a fill it is not going to make.
 *   4. Pre-dispatch header: counts — of what will actually be filled, plus what
 *      was deliberately left alone and why. (A --dry-run prints it and its
 *      preview without passing the log gate.)
 *   5. Deterministic fills FIRST (free) → deterministic gate (a node with an
 *      enforced det refusal skips its LLM fills this run).
 *   6. LLM fills (grouped by tier; one provider per tier; run-scoped caches).
 *   7. Positive closure (§7.5): a node with all enforced pairs settled — approved
 *      this run, or deliberately left unbought by a change-scoped run — records
 *      its source fingerprint + log baseline.
 *   8. GC + canonical rewrite (§3.2).
 *   9. Re-run the read (runCheck), name on it the cause of every pair this run
 *      could not fill (annotateFillCauses), and return it.
 *
 * Fail-closed (§3.2): an entry is written only on a REAL verdict. Every infra
 * disposition (provider unreachable, no reviewer, tier-resolution failure,
 * reference-load failure, unparseable response, check.mjs runtime error /
 * taint) writes NOTHING — the prior baseline stays intact, the pair stays
 * unverified, and the run ends red.
 *
 * Interruption-safety: the lock is mutated in memory and written in coalesced
 * flushes (fill-writer.ts), so a killed run keeps every flushed pair — a bounded
 * few free verdicts at most are lost — and the next run resumes. The whole run
 * holds the repository's approval lock, so two approvals never overlap.
 *
 * This module is the orchestrator: it owns the ORDER above and nothing else.
 * The cohesive stages live in sibling files and are wired in here:
 *   - fill-coverage-phase.ts — type-level classification + relation pass
 *                           (computed once, before step 1)
 *   - fill-gate-phase.ts  — the structural gate (step 1)
 *   - fill-classify.ts    — pair classification + cost budget (step 2)
 *   - fill-prompt-size-backfill.ts — records the assembled prompt's size onto
 *                           verdicts written before that field existed
 *   - fill-report.ts      — header, prune summary, grouped diagnostics, summary
 *   - fill-dry-run.ts     — the --dry-run cost preview
 *   - fill-writer.ts      — the serialized lock writer + verdict telemetry
 *   - fill-log-gate.ts    — the per-node mandatory-log gate (step 3 / §9)
 *   - fill-det-phase.ts   — the deterministic phase (step 5)
 *   - fill-det.ts         — the deterministic per-pair filler
 *   - fill-closing-phase.ts — closure, rule standings, GC (steps 7, 7b, 8)
 *   - fill-closure.ts     — positive closure (step 7 / §7.5)
 *   - fill-gc.ts          — GC + canonical rewrite (step 8 / §3.2)
 *   - fill-report-phase.ts — summaries, the re-run read, the convergence
 *                           sentinel (step 9)
 *
 * Beneath all of them sit the stage's phase-agnostic primitives, which belong to
 * no single step and are therefore owned separately from this stage:
 *   - fill-contract.ts    — the public options/result contract + gate predicates
 *   - fill-shared.ts      — shared outcome types + readBytesOrEmpty
 *   - fill-pool.ts        — the bounded worker pool (step 6)
 *   - parse-cache-buckets.ts — per-(aspect, node) shared parse caches
 *
 * Step 6 is the one part that is NOT a sibling of this stage. The code that
 * actually talks to the reviewer — fill-llm-phase.ts (the tier-grouped phase)
 * and fill-llm.ts (the per-pair filler) — is a different kind of code and is
 * architecturally separate: a model's answer to identical input is not
 * guaranteed identical, so it cannot be held to the same-input/same-output rule
 * the rest of this stage is held to. What stands in for that rule there is
 * content-addressing — every verdict it returns is stored under a hash of the
 * inputs that produced it and honored only while those inputs still hash to the
 * recorded value. This orchestrator sequences that phase and owns the
 * fail-closed write chokepoint its verdicts pass through; it makes no reviewer
 * call itself.
 */

import path from 'node:path';

import type { Graph } from '../model/graph.js';
import type { FillDispatchCounts, FillEventSink } from '../model/fill-event.js';
import type { IssueMessage } from '../model/validation.js';
import type { RunFillOptions, RunFillResult } from './fill-contract.js';
import { detGateKey } from './fill-contract.js';
import { prepareFillCoverage } from './fill-coverage-phase.js';
import { runStructuralGate } from './fill-gate-phase.js';
import { classifyFillPairs } from './fill-classify.js';
import type { FillPairSets } from './fill-classify.js';
import { backfillPromptSizes } from './fill-prompt-size-backfill.js';
import { acquireFillExclusion, createVerdictWriter, type FillExclusion } from './fill-writer.js';
import { runDryRunPreview } from './fill-dry-run.js';
import { emitDetGateSkips, emitDispatchHeader, emitGroupedDiagnostics, interruptedEvent } from './fill-report.js';
import { runDeterministicPhase } from './fill-det-phase.js';
import type { DetPhaseResult } from './fill-det-phase.js';
import { runLlmPhase } from './fill-llm-phase.js';
import { runLogGatePhase } from './fill-log-gate.js';
import { runClosingPhase } from './fill-closing-phase.js';
import { runReportPhase } from './fill-report-phase.js';
import { ProgressTracker } from './fill-progress.js';
import { textFillSink } from '../formatters/fill-text.js';

// ============================================================
// Public surface
// ============================================================

export type { RunFillOptions, RunFillResult } from './fill-contract.js';
export { FillGatingError, detGateKey } from './fill-contract.js';

// ============================================================
// runFill
// ============================================================

export async function runFill(graph: Graph, opts: RunFillOptions): Promise<RunFillResult> {
  // A cost preview writes nothing, so it takes no lock and never waits on one.
  if (opts.dryRun === true) return runFillHoldingLock(graph, opts);
  // One approval per repository at a time, from its lock read to its last
  // write — a second one fails fast instead of overwriting this one's verdicts.
  const exclusion = acquireFillExclusion(graph.rootPath, opts.now());
  try {
    return await runFillHoldingLock(graph, opts, exclusion);
  } finally {
    await exclusion.release();
  }
}

/** The per-run settings every step reads, resolved once from the options. */
interface FillRun {
  emit: FillEventSink;
  emitIssue: (msg: IssueMessage) => void;
  startedAt: number;
  projectRoot: string;
  onlyDeterministic: boolean;
  dryRun: boolean;
  /** The command every "then re-run" line names. */
  retry: string;
  reviewerConfigured: boolean;
}

function resolveFillRun(graph: Graph, opts: RunFillOptions): FillRun {
  return {
    // Everything this run says goes out as FillEvent data. A caller that supplies
    // no event sink gets the events worded by the fill-text formatter into its
    // plain-text `write` sink — the engine itself never composes one of those
    // sentences, and writes to no stream of its own.
    emit: opts.onEvent ?? textFillSink(opts.write ?? ((): void => {})),
    emitIssue: opts.emitIssue ?? ((): void => {}),
    startedAt: opts.now(),
    projectRoot: path.dirname(graph.rootPath),
    onlyDeterministic: opts.onlyDeterministic ?? false,
    dryRun: opts.dryRun ?? false,
    // The command every "then re-run" line names — the one the user actually ran,
    // so a retry never silently drops --only-deterministic or --dry-run and turns
    // a free run into a paid one (or into one that aborts).
    retry: opts.retryCommand ?? 'yg check --approve',
    reviewerConfigured: graph.config.reviewer !== undefined,
  };
}

async function runFillHoldingLock(graph: Graph, opts: RunFillOptions, exclusion?: FillExclusion): Promise<RunFillResult> {
  const run = resolveFillRun(graph, opts);
  const { emit, emitIssue, projectRoot, onlyDeterministic, dryRun, retry } = run;

  // Type-level classification + relation pass, once for the whole run.
  const coverage = await prepareFillCoverage(graph, opts.coverageVisibleFiles, projectRoot);
  const typeCoverageInput = coverage.typeCoverageInput;

  // ── Step 1: Structural gate. A gating code aborts the whole fill. ──────────
  // The committed lock it returns is read once for everything this run decides.
  const lock = await runStructuralGate({
    graph, projectRoot, typeCoverage: typeCoverageInput, onlyDeterministic, dryRun, retry,
    gateIssuesOnError: opts.gateIssuesOnError, emitIssue,
  });

  // ── Step 2: Classify pairs through the SAME engine plain check uses. ───────
  // The change scope narrows the PAID half of the fill set and nothing else —
  // see fill-classify.ts. `reportNodeSet` is also the log gate's set — the
  // components this run fills a pair of, the same ones the report counts.
  // companion.mjs runs only where a reviewer pair may be filled: never in a
  // preview, and never under --only-deterministic, whose one piece of
  // repository code is the script rules' check.mjs (the free CI step promises
  // exactly that, and it fills no reviewer pair that a companion could size).
  const classification = await classifyFillPairs(
    graph, lock, typeCoverageInput, onlyDeterministic, opts.changeScope, opts.coverageVisibleFiles,
    !dryRun && !onlyDeterministic,
  );
  const { verification, detPairs, llmPairs, aspectById, reportNodeSet } = classification;
  const headerCounts = dispatchCounts(classification, run);

  // ── Dry-run: cost preview, no writes — returns before the writer exists. ──
  if (dryRun) {
    return runDryRunPreview(graph, { opts, lock, classification, coverage, headerCounts, onlyDeterministic, emit });
  }

  // ── Serialized lock writer (interruption-safe, §7) + verdict telemetry. ────
  // The pair count an interrupt reports against, known once the header is
  // written (0 before that: an interrupt then has nothing of this run to report).
  let interruptTotal = 0;
  const writer = createVerdictWriter({
    graph, lock, now: opts.now, onlyDeterministic,
    // Committed-events opt-in (RZ-14). Read from the resolved config once and passed
    // to the writer: when ON, LLM verification-fill events graduate to the committed
    // shared stream; every other event stays in the local sidecar.
    committedLlm: graph.config.events?.committed_llm === true,
    deterministicAspectIds: classification.deterministicAspectIds, sha: opts.sha, exclusion,
    onInterrupted: (saved, flushed) => {
      if (interruptTotal === 0) return;
      emit(interruptedEvent(saved, interruptTotal, flushed, retry));
    },
  });

  // Record the assembled prompt's size on any still-valid verdict that predates
  // the field. Placed BEFORE the log gate below on purpose: this writes no
  // verdict and re-decides nothing — it only stores a number the classification
  // above already computed — so it must not be withheld from a repository whose
  // real fills are blocked pending a justification entry. Without it a
  // repository with nothing to fill would never record a size at all, and the
  // fast path it unlocks would stay permanently out of reach. Skipped under
  // --only-deterministic, whose writer is scoped to the gitignored deterministic
  // file and could not persist a committed LLM entry anyway.
  if (!onlyDeterministic) {
    await backfillPromptSizes(lock, verification.pairs, writer.persistLock);
  }

  // ── Step 3: Log gate per node (§9) — throws when any node owes an entry. ──
  const blockedNodes = await runLogGatePhase({
    graph, projectRoot, nodePaths: reportNodeSet, lock, retry, gateIssuesOnError: opts.gateIssuesOnError, emitIssue,
  });

  // ── Step 4: Pre-dispatch header (EXACT). ──────────────────────────────────
  emitDispatchHeader(emit, headerCounts);

  const totalPairs = detPairs.length + llmPairs.length;
  interruptTotal = totalPairs;
  const { tracker, stopTicking } = startProgress(totalPairs, opts, emit);

  // The architecture-reach cache for nodeless (component-free) pairs — shared
  // across EVERY fillDetPair call AND every fillLlmPair companion resolution
  // this run (both the pooled and the in-process det branches dispatch from the
  // same active-pair list; the LLM tier loop shares this SAME map), computed
  // once per matched type rather than once per pair: recomputing it per pair
  // over a repo with thousands of files would dominate the run.
  // companion-resolve.ts computes the identical quantity under the identical
  // cache contract (fromType -> Set<string>), so sharing one Map here costs
  // nothing extra to wire and means a run reviewing both a det and an LLM
  // aspect on the same type pays the reach computation once, not twice.
  const reachCache = new Map<string, Set<string>>();

  // ── Step 5: Deterministic fills FIRST (free). ─────────────────────────────
  const det = await runDeterministicPhase({
    graph, projectRoot, detPairs, aspectById, verification, blockedNodes,
    // Deterministic-phase thread budget (injected; engine reads no system state).
    // 1 → sequential in-process; >1 → a worker-thread pool bounded by this value.
    detConcurrency: Math.max(1, Math.floor(opts.detConcurrency ?? 1)),
    detWorkerCeiling: opts.detWorkerCeiling,
    detTaskBudgetMs: Math.max(0, Math.floor(opts.detTaskBudgetMs ?? 0)),
    typeCoverage: typeCoverageInput, reachCache, writer, tracker, emit,
  });

  // ── Emit grouped det runtime-error diagnostics (one message per aspect). ────
  emitGroupedDiagnostics(det.runtimeItems, 'det', emitIssue);
  // ── Emit grouped malformed-suppress-marker diagnostics — distinct from a check
  //    runtime error so a marker-parse fault is never blamed on check.mjs. ──────
  emitGroupedDiagnostics(det.malformedSuppressItems, 'malformed-suppress', emitIssue);

  // ── Deterministic gate: report units whose LLM fills are skipped. ──────────
  const llmSkippedByDetGate = detGateSkips(classification, det);
  emitDetGateSkips(llmSkippedByDetGate, emitIssue, retry);

  // ── Step 6: LLM fills — grouped by resolved tier; one provider per tier. ───
  const llm = await runLlmPhase({
    graph, projectRoot, llmPairs, aspectById, blockedNodes, llmSkippedByDetGate,
    typeCoverage: typeCoverageInput, reachCache, writer, tracker, emit, emitIssue,
  });

  // ── Emit grouped companion and pool-infra diagnostics. ────────────────────
  emitGroupedDiagnostics(llm.companionRuntimeItems, 'companion', emitIssue);
  emitGroupedDiagnostics(llm.poolInfraItems, 'pool-infra', emitIssue);

  // ── Steps 7, 7b, 8: closure, rule standings, GC — over the POST-FILL lock. ──
  const pruneSummary = await runClosingPhase({
    graph, projectRoot, lock, blockedNodes, writer, typeCoverage: typeCoverageInput,
    skippedOutsideLlmPairKeys: classification.skippedOutsideLlmPairKeys,
    detAspectIdsOnDisk: classification.detAspectIdsOnDisk, onlyDeterministic, now: opts.now, emit,
  });

  // ── Step 9: Summaries + re-run the read. ──────────────────────────────────
  const checkResult = await runReportPhase({
    graph, opts, lock, classification, coverage, det, llm, pruneSummary,
    skippedByDetGate: llmSkippedByDetGate.size, reviewerConfigured: run.reviewerConfigured,
    onlyDeterministic, retry, startedAt: run.startedAt, writer, tracker, stopTicking, emit, emitIssue,
  });

  return {
    checkResult,
    reviewerCallsMade: llm.reviewerCallsMade,
    infraFailures: llm.infraFailures,
    runtimeErrors: det.runtimeErrors,
    companionRuntimeErrors: llm.companionRuntimeErrors,
    malformedSuppressErrors: det.malformedSuppressErrors,
    runtimeDispositions: det.runtimeDispositions,
  };
}

/** The pre-dispatch header's counts: what will actually be filled, and what was left alone. */
function dispatchCounts(classification: FillPairSets, run: FillRun): Required<FillDispatchCounts> {
  const { detPairs, llmPairs, reportNodeSet, reportFileSet } = classification;
  return {
    fillPairs: detPairs.length + llmPairs.length,
    nodeCount: reportNodeSet.size,
    fileCount: reportFileSet.size,
    detPairs: detPairs.length,
    reviewerCallBudget: classification.reviewerCallBudget,
    skippedLlmPairs: classification.skippedLlmPairs,
    skippedOutsideLlmPairs: classification.skippedOutsideLlmPairs,
    reviewerConfigured: run.reviewerConfigured,
    preview: run.dryRun,
  };
}

/**
 * The progress tracker over all fill pairs (det + LLM), and the real timer that
 * drives its heartbeat. The tracker is created once the pair counts are known so
 * it can initialise the milestone interval from the total; it sets up no timer
 * of its own, so tests can drive it directly via onTick() with a fake clock.
 */
function startProgress(
  totalPairs: number,
  opts: RunFillOptions,
  emit: FillEventSink,
): { tracker: ProgressTracker; stopTicking: () => void } {
  const tracker = new ProgressTracker(totalPairs, {
    isTTY: opts.isTTY,
    now: opts.now,
    columns: opts.columns,
    milestoneInterval: opts.milestoneInterval,
    stillWorkingIntervalMs: opts.stillWorkingIntervalMs,
  });
  // A real timer for heartbeat ticks (TTY rewrite or still-working check). The
  // interval matches the stillWorkingIntervalMs default / configured value so
  // we tick often enough to detect a stall. We use a short interval (5s) for
  // the TTY rewrite so the elapsed-seconds counter stays current.
  const tickIntervalMs = opts.isTTY ? 5000 : (opts.stillWorkingIntervalMs ?? 30000);
  const tickInterval = setInterval(() => { tracker.onTick(emit); }, tickIntervalMs);
  tickInterval.unref?.(); // don't keep the process alive if everything else finishes
  return { tracker, stopTicking: () => { clearInterval(tickInterval); } };
}

/**
 * The units whose LLM fills the deterministic gate skips this run. Keyed on
 * detGateKey — one refusing FILE must skip only that file's paid review, never
 * every other type-covered file's (the cross-contamination this gate must never
 * reproduce).
 */
function detGateSkips(classification: FillPairSets, det: DetPhaseResult): Set<string> {
  const llmSkippedByDetGate = new Set<string>();
  for (const pair of classification.llmPairs) {
    if (det.detEnforcedRefusedNodes.has(detGateKey(pair))) {
      llmSkippedByDetGate.add(detGateKey(pair));
    }
  }
  return llmSkippedByDetGate;
}
