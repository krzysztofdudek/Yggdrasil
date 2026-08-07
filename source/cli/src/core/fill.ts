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
 *      whole fill (no fills, no LLM calls).
 *   2. Classify pairs through the SAME engine plain check uses (verifyLock) —
 *      one implementation, so a verdict fill writes here verifies there.
 *      prompt-too-large pairs are SKIPPED (gate precedence, §4).
 *   3. Pre-dispatch header: counts.
 *   4. Log gate (§9), ALL-OR-NOTHING: if ANY log_required node's source
 *      fingerprint drifted with no fresh entry, the run fills NOTHING (throws
 *      FillGatingError before any deterministic or LLM fill) and stays red.
 *   5. Deterministic fills FIRST (free) → deterministic gate (a node with an
 *      enforced det refusal skips its LLM fills this run).
 *   6. LLM fills (grouped by tier; one provider per tier; run-scoped caches).
 *   7. Positive closure (§7.5): a node with all enforced pairs approved records
 *      its source fingerprint + log baseline.
 *   8. GC + canonical rewrite (§3.2).
 *   9. Re-run the read (runCheck) and return its result.
 *
 * Fail-closed (§3.2): an entry is written only on a REAL verdict. Every infra
 * disposition (provider unreachable, no reviewer, tier-resolution failure,
 * reference-load failure, unparseable response, check.mjs runtime error /
 * taint) writes NOTHING — the prior baseline stays intact, the pair stays
 * unverified, and the run ends red.
 *
 * Interruption-safety: the lock is mutated in memory and re-serialized through a
 * single serialized promise chain after EACH completed pair, so a killed run
 * keeps every finished pair and the next run resumes.
 *
 * This module is the orchestrator: it owns the ORDER above and nothing else.
 * The cohesive stages live in sibling files and are wired in here:
 *   - fill-classify.ts    — pair classification + cost budget (step 2)
 *   - fill-prompt-size-backfill.ts — records the assembled prompt's size onto
 *                           verdicts written before that field existed
 *   - fill-report.ts      — header, prune summary, grouped diagnostics, summary
 *   - fill-dry-run.ts     — the --dry-run cost preview
 *   - fill-writer.ts      — the serialized lock writer + verdict telemetry
 *   - fill-log-gate.ts    — the per-node mandatory-log gate (§9)
 *   - fill-det-phase.ts   — the deterministic phase (step 5)
 *   - fill-det.ts         — the deterministic per-pair filler
 *   - fill-closure.ts     — positive closure (step 7 / §7.5)
 *   - fill-gc.ts          — GC + canonical rewrite (step 8 / §3.2)
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
import { runCheck, scanUncoveredFiles } from './check.js';
import { readLock } from '../io/lock-store.js';
import type { TypeCoverageInput } from './pairs.js';
import { verifyLock } from './verify-lock.js';
import { computeTypeCoverageCached } from './type-coverage.js';
import type { TypeCoverageResult } from './type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { DEFAULT_COVERAGE } from '../io/config-parser.js';
import { validate } from './validator.js';
import { APPROVE_GATING_CODES } from './check-codes.js';
import { debugWrite } from '../utils/debug-log.js';
import type { RunFillOptions, RunFillResult } from './fill-contract.js';
import { FillGatingError, detGateKey } from './fill-contract.js';
import { classifyFillPairs } from './fill-classify.js';
import { backfillPromptSizes } from './fill-prompt-size-backfill.js';
import { createVerdictWriter } from './fill-writer.js';
import { previewPruneSummary, writeDryRunBreakdown } from './fill-dry-run.js';
import {
  emitDetGateSkips,
  emitGroupedDiagnostics,
  reportFillTotals,
  writeDispatchHeader,
  writePruneSummary,
} from './fill-report.js';
import { runDeterministicPhase } from './fill-det-phase.js';
import { runLlmPhase } from './fill-llm-phase.js';
import { logGateBlocks } from './fill-log-gate.js';
import { applyPositiveClosure } from './fill-closure.js';
import { garbageCollectAndRewrite } from './fill-gc.js';
import { reportDivergenceIfDetected } from './fill-divergence.js';
import { ProgressTracker } from './fill-progress.js';
// ── Relation pass (parse + resolve) — same index runCheck's own pass builds,
//    so a `relations:` applicability atom is answered identically here. ──
import { runProjectRelationPass } from '../relations/pass.js';
import type { RelationPassResult } from '../relations/pass.js';

// ============================================================
// Public surface
// ============================================================

export type { RunFillOptions, RunFillResult } from './fill-contract.js';
export { FillGatingError, detGateKey } from './fill-contract.js';

// ============================================================
// runFill
// ============================================================

export async function runFill(graph: Graph, opts: RunFillOptions): Promise<RunFillResult> {
  const write = opts.write ?? ((s: string) => { process.stdout.write(s); });
  const emitIssue = opts.emitIssue ?? ((): void => {});
  const projectRoot = path.dirname(graph.rootPath);
  const onlyDeterministic = opts.onlyDeterministic ?? false;
  const dryRun = opts.dryRun ?? false;
  const isTTY = opts.isTTY ?? (process.stderr.isTTY ?? false);
  const now = opts.now ?? Date.now.bind(Date);
  // Deterministic-phase thread budget (injected; engine reads no system state).
  // 1 → sequential in-process; >1 → a worker-thread pool bounded by this value.
  const detConcurrency = Math.max(1, Math.floor(opts.detConcurrency ?? 1));
  // Committed-events opt-in (RZ-14). Read from the resolved config once and passed
  // to the writer: when ON, LLM verification-fill events graduate to the committed
  // shared stream; every other event stays in the local sidecar.
  const committedLlm = graph.config.events?.committed_llm === true;

  // The type-level classification lattice (coverage.type_level), computed ONCE
  // for this whole fill run and threaded into every downstream consumer below:
  // the structural gate's own reviewer-presence check (validate →
  // checkReviewerPresence), pair classification (verifyLock — critically, the
  // one thing that keeps a nodeless pair from being pruned as detached), GC
  // (garbageCollectAndRewrite), and both of this run's own runCheck calls below
  // (as precomputedTypeCoverage — otherwise runCheck would classify a second
  // time from scratch, reading every uncovered file's bytes twice). Undefined
  // at flag-off or when no file walk ran this call (opts.coverageVisibleFiles
  // === null) — every consumer already treats that as "nothing to do."
  // computeTypeCoverageCached constructs its own persistent
  // .yggdrasil/.type-class-cache/ instance, so `yg check --approve` reads and
  // writes it exactly like a plain `yg check` does, instead of the
  // classification-cache bypass that shipped before.
  const coverage = graph.config.coverage ?? DEFAULT_COVERAGE;
  let typeCoverageInput: TypeCoverageInput | undefined;
  let typeCoverageResult: TypeCoverageResult | undefined;
  // The import-resolution pass this call made, if it made one. Held so the
  // report below can be handed it instead of parsing every mapped source file a
  // second time — see runCheck's `precomputedRelationPass`. Stays undefined when
  // type-level coverage is off, in which case this stage never needed the pass
  // and the report runs the run's ONLY one.
  let relPassResult: RelationPassResult | undefined;
  if (opts.coverageVisibleFiles !== null && coverage.typeLevel) {
    const uncoveredForGate = scanUncoveredFiles(graph, opts.coverageVisibleFiles);
    typeCoverageResult = await computeTypeCoverageCached(graph, uncoveredForGate, new FileContentCache());

    // Relation pass (parse + resolve), run ONCE for this fill call — after the
    // type coverage is classified (so its typeCoveredFiles map is available)
    // and BEFORE the structural gate / verifyLock below, so a `relations:`
    // atom in an aspect's `when:` is answered from the SAME edge index
    // runCheck's own pass builds. Without this, this run's own pair
    // computation (which pairs get filled) would silently disagree with a
    // separate `yg check`'s (which pairs are expected) — a positively-gated
    // rule never filled, a negated one always filled.
    relPassResult = await runProjectRelationPass(graph, projectRoot, typeCoverageResult.covered);

    typeCoverageInput = {
      covered: typeCoverageResult.covered,
      ambiguousPaths: typeCoverageResult.ambiguous.map((a) => a.file),
      edges: relPassResult.typedEdges,
    };
  }

  // ── Step 1: Structural gate. A gating code aborts the whole fill. ──────────
  const validation = await validate(graph, 'all', undefined, typeCoverageInput);
  const gating = validation.issues.filter(
    (i) => i.code !== undefined && APPROVE_GATING_CODES.has(i.code),
  );
  if (gating.length > 0) {
    const single = gating.length === 1;
    emitIssue({
      what: `yg check --approve aborted — ${gating.length} ${single ? 'problem' : 'problems'} must be fixed before anything runs.`,
      why: `Approval records verdicts, and ${single ? 'this problem leaves' : 'these problems leave'} it unclear what would be checked, how it would be judged, or whether doing so is safe; nothing ran and nothing was written.`,
      next: 'Fix the errors below, then re-run: yg check --approve',
    });
    for (const i of gating) emitIssue(i.messageData);
    throw new FillGatingError(
      gating.map((i) => ({ code: i.code!, what: i.messageData.what, why: i.messageData.why, next: i.messageData.next })),
    );
  }

  // ── Step 2: Classify pairs through the SAME engine plain check uses. ───────
  const lock = readLock(graph.rootPath);
  const classification = await classifyFillPairs(graph, lock, typeCoverageInput, onlyDeterministic);
  const {
    verification, unverifiedPairs, detPairs, llmPairs, skippedLlmPairs,
    aspectById, deterministicAspectIds, detAspectIdsOnDisk, nodeSet, fileSet, reviewerCallBudget,
  } = classification;

  // ── Step 3: Pre-dispatch header (EXACT). ──────────────────────────────────
  writeDispatchHeader({
    unverifiedPairs: unverifiedPairs.length,
    nodeCount: nodeSet.size,
    fileCount: fileSet.size,
    detPairs: detPairs.length,
    reviewerCallBudget,
    skippedLlmPairs,
  }, write);

  // ── Dry-run: cost preview, no writes. ──────────────────────────────────────
  // Placed AFTER the step-3 budget header and BEFORE the serialized writer is
  // constructed, so the no-write guarantee is STRUCTURAL — there is no writer to
  // invoke and no fill loop is reached. This INTENTIONALLY bypasses the step-4
  // log gate below (a cost preview must not require a fresh log entry); only the
  // step-1 structural/config gate, which already ran above, can abort a preview.
  if (dryRun) {
    writeDryRunBreakdown(graph, { unverifiedPairs, aspectById, onlyDeterministic, reviewerCallBudget }, write);
    const prunePreview = await previewPruneSummary(graph, lock, {
      typeCoverage: typeCoverageInput,
      detAspectIdsOnDisk,
      onlyDeterministic,
    });
    writePruneSummary(prunePreview, write);
    const checkResult = await runCheck(graph, opts.coverageVisibleFiles, {
      nowUtc: opts.reviewNowUtc,
      rulesArtifacts: opts.rulesArtifacts,
      trackedFiles: opts.trackedFiles,
      precomputedTypeCoverage: typeCoverageResult,
      // A preview writes nothing — it returns before the verdict writer is even
      // constructed — so both of these still describe exactly what this call
      // classified moments ago. Handing them over is what makes a cost preview
      // cost like the read it is, instead of re-hashing every pair and
      // re-parsing every mapped source file to rediscover what is already here.
      precomputedRelationPass: relPassResult,
      precomputedVerification: verification,
    });
    return { checkResult, reviewerCallsMade: 0, infraFailures: 0, runtimeErrors: 0, companionRuntimeErrors: 0, malformedSuppressErrors: 0, runtimeDispositions: [] };
  }

  // ── Serialized lock writer (interruption-safe, §7) + verdict telemetry. ────
  const writer = createVerdictWriter({ graph, lock, now, onlyDeterministic, committedLlm, deterministicAspectIds });

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

  // ── Step 4: Log gate per node (§9). A node owning unverified pairs whose
  // log_required type drifted (or first verification) with no fresh entry needs
  // a justification entry first. The gate is all-or-nothing: if ANY node needs an
  // entry, --approve approves NOTHING this run and stops (no fill, no report) —
  // the per-node messages tell the user which entries to add, then re-run.
  const blockedNodes = new Set<string>();
  for (const nodePath of nodeSet) {
    const node = graph.nodes.get(nodePath);
    if (!node) continue;
    const blocked = await logGateBlocks(graph, projectRoot, node, lock, emitIssue);
    if (blocked) blockedNodes.add(nodePath);
  }
  if (blockedNodes.size > 0) {
    throw new FillGatingError([{
      code: 'log-entry-required',
      what: `${blockedNodes.size} node(s) need a fresh log entry before --approve.`,
      why: 'Source changed on log_required nodes without a justification entry; nothing was approved this run.',
      next: 'Add the log entries listed above (yg log add), then re-run: yg check --approve',
    }]);
  }

  // ── Progress tracker — covers all fill pairs (det + LLM). ─────────────────
  // The tracker is created here (after pair counts are known) so it can
  // initialise the milestone interval from the total pair count.
  // It is NOT responsible for setting up real timers — that is done below so
  // that tests can drive the tracker directly via onTick() with a fake clock.
  const totalPairs = detPairs.length + llmPairs.length;
  const tracker = new ProgressTracker(totalPairs, {
    isTTY,
    now,
    columns: opts.columns,
    milestoneInterval: opts.milestoneInterval,
    stillWorkingIntervalMs: opts.stillWorkingIntervalMs,
  });

  // Set up a real timer for heartbeat ticks (TTY rewrite or still-working check).
  // The interval matches the stillWorkingIntervalMs default / configured value so
  // we tick often enough to detect a stall. We use a short interval (5s) for
  // the TTY rewrite so the elapsed-seconds counter stays current.
  const tickIntervalMs = isTTY ? 5000 : (opts.stillWorkingIntervalMs ?? 30000);
  const tickInterval = setInterval(() => { tracker.onTick(write); }, tickIntervalMs);
  tickInterval.unref?.(); // don't keep the process alive if everything else finishes

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
    detConcurrency, typeCoverage: typeCoverageInput, reachCache, writer, tracker, write,
  });

  // ── Emit grouped det runtime-error diagnostics (one message per aspect). ────
  emitGroupedDiagnostics(det.runtimeItems, 'det', emitIssue);
  // ── Emit grouped malformed-suppress-marker diagnostics — distinct from a check
  //    runtime error so a marker-parse fault is never blamed on check.mjs. ──────
  emitGroupedDiagnostics(det.malformedSuppressItems, 'malformed-suppress', emitIssue);

  // ── Deterministic gate: report units whose LLM fills are skipped. ──────────
  // Keyed on detGateKey — one refusing FILE must skip only that file's
  // paid review, never every other type-covered file's (the cross-contamination
  // this gate must never reproduce).
  const llmSkippedByDetGate = new Set<string>();
  for (const pair of llmPairs) {
    if (det.detEnforcedRefusedNodes.has(detGateKey(pair))) {
      llmSkippedByDetGate.add(detGateKey(pair));
    }
  }
  emitDetGateSkips(llmSkippedByDetGate, emitIssue);

  // ── Step 6: LLM fills — grouped by resolved tier; one provider per tier. ───
  const llm = await runLlmPhase({
    graph, projectRoot, llmPairs, aspectById, blockedNodes, llmSkippedByDetGate,
    typeCoverage: typeCoverageInput, reachCache, writer, tracker, write, emitIssue,
  });

  // ── Emit grouped companion and pool-infra diagnostics. ────────────────────
  emitGroupedDiagnostics(llm.companionRuntimeItems, 'companion', emitIssue);
  emitGroupedDiagnostics(llm.poolInfraItems, 'pool-infra', emitIssue);

  // ── Step 7: Positive closure (§7.5). ──────────────────────────────────────
  // Re-classify against the POST-FILL lock so closure sees the verdicts just
  // written. A node with a missing/stale fingerprint closes (records source +
  // log baseline) only when ALL its enforced effective pairs are approved.
  // Deliberate post-fill re-classification: must see freshly-written verdicts —
  // do not thread step-2 (pre-fill verifyLock) results through. blockedNodes
  // (the step-4 log-gate set) is threaded so a node whose pairs were skipped this
  // run can never close over its stale verdicts.
  // Skipped under --only-deterministic: closure records source + log baseline to the
  // COMMITTED logs file, which a deterministic-only / CI run must never write.
  if (!onlyDeterministic) {
    await applyPositiveClosure(graph, projectRoot, lock, blockedNodes, writer.persistLock, typeCoverageInput);
  }

  // ── Step 8: GC + canonical rewrite (§3.2). ────────────────────────────────
  // Deliberate post-fill re-classification: must see freshly-written verdicts —
  // do not thread step-2 (pre-fill verifyLock) results through. typeCoverageInput
  // IS threaded (computed once at the top of this run) — this is the anti-prune
  // lever: without it, the first --approve after enabling the feature would
  // prune every file-level result as detached.
  const pruneSummary = await garbageCollectAndRewrite(graph, lock, writer.persistLock, {
    typeCoverage: typeCoverageInput,
    detAspectIdsOnDisk,
    scope: onlyDeterministic ? 'deterministic' : 'all',
  });

  // ── Step 9: Summaries + re-run the read. ──────────────────────────────────
  writePruneSummary(pruneSummary, write);
  reportFillTotals({
    reviewerCallsMade: llm.reviewerCallsMade,
    infraFailures: llm.infraFailures,
    runtimeErrors: det.runtimeErrors,
    companionRuntimeErrors: llm.companionRuntimeErrors,
    malformedSuppressErrors: det.malformedSuppressErrors,
    skippedLlmPairs,
    infraReport: llm.infraReport,
  }, write, emitIssue);

  // Drain all queued progress writes first, then stop the timer and clear the TTY line.
  await writer.drain();
  clearInterval(tickInterval);
  tracker.clearLine(write);

  // The `yg check --approve` combiner prints this report after filling. This IS the
  // reporting path for `--approve`, so it maintains the silent feature-field index when the
  // CLI asks (best-effort, byproduct-free elsewhere). The dry-run re-check above returns
  // before reaching here, so a cost preview never writes it regardless of the flag.
  const checkResult = await runCheck(graph, opts.coverageVisibleFiles, {
    writeFeatureIndex: opts.writeFeatureIndex,
    now: opts.featureIndexNow,
    nowUtc: opts.reviewNowUtc,
    rulesArtifacts: opts.rulesArtifacts,
    trackedFiles: opts.trackedFiles,
    precomputedTypeCoverage: typeCoverageResult,
    // Same pass, reused: a fill writes lock and log files, never source, so what
    // it resolved before the fill it would resolve identically now. Deliberately
    // NOT accompanied by precomputedVerification — this run DID write verdicts,
    // so the lock must be re-verified for the report to describe it.
    precomputedRelationPass: relPassResult,
    // The in-process fill→check handoff (core/type-visibility.ts's own module
    // comment names this the missing piece): THIS run's own runtimeDispositions,
    // so the report it is about to build can name a component-free disposition
    // by reason instead of a bare "unverified" caveat. A run that never fills
    // (plain `yg check`, or a later separate invocation) passes nothing here and
    // gets runCheck's own empty-array default — the qualified fallback wording.
    runtimeDispositions: det.runtimeDispositions,
  });

  // ── Convergence sentinel (C15) — READ-ONLY over the fill's own state. ──────
  // Detect the exact 0-fill divergence: the pre-fill classification reported ZERO
  // pairs to fill, yet the post-fill report finds unverified pairs, with NO
  // verdict written in between. That triad is a genuine convergence gap (the
  // classifier disagreed with itself over unchanged inputs) that would otherwise
  // be silent. On fire: emit ONE notice and record a bounded evidence dump via
  // the injected io writer. This NEVER alters exit codes, verdicts, the lock, or
  // fill flow, and is wrapped in a swallow-all — a sentinel failure must never
  // fail a fill.
  try {
    const postUnverified = checkResult.issues.filter((i) => i.code === 'unverified').length;
    const shape = { toFill: unverifiedPairs.length, postUnverified, lockWrites: writer.lockWrites };
    await reportDivergenceIfDetected(shape, lock, {
      emitIssue,
      divergenceWrite: opts.divergenceWrite,
      // Read-only enumeration (only invoked on fire): a fresh verifyLock pass
      // names the divergent pairs; buildDivergenceDump attaches each pair's
      // already-stored lock hash — nothing is re-hashed and nothing is written.
      enumerate: async () => {
        const postVerification = await verifyLock(graph, lock, typeCoverageInput);
        return postVerification.pairs
          .filter((vp) => vp.state.kind === 'unverified')
          .map((vp) => ({ aspectId: vp.pair.aspectId, unitKey: vp.pair.unitKey }));
      },
    });
  } catch (e) {
    debugWrite(`[fill] convergence sentinel failed (swallowed): ${e instanceof Error ? e.message : String(e)}`);
  }

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
