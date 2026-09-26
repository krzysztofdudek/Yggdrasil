/**
 * source/cli/src/core/fill-dry-run.ts — the `yg check --approve --dry-run` cost
 * preview (spec §7).
 *
 * A preview answers one question: what WOULD this run do, and what would it
 * cost? It therefore writes nothing at all — no reviewer calls, no deterministic
 * checks, no lock writes. The orchestrator returns before its serialized writer
 * even exists, so the no-write guarantee is structural rather than a promise
 * kept by the code below; what lives here is the preview's own sequence (the
 * header, the breakdown as data, the prune analysis run over a disposable clone
 * of the lock, and the read it reports under) — none of which writes.
 */

import type { Graph, AspectDef } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import type { PruneSummary } from './fill-gc.js';
import type { FillEvent, FillEventSink, DryRunPair, FillDispatchCounts } from '../model/fill-event.js';
import type { FillPairSets } from './fill-classify.js';
import type { FillCoverage } from './fill-coverage-phase.js';
import type { RunFillOptions, RunFillResult } from './fill-contract.js';
import { runCheck } from './check.js';
import { garbageCollectAndRewrite } from './fill-gc.js';
import { reviewerCallsForPair } from './fill-classify.js';
import { emitDispatchHeader, emitNoReviewerNote } from './fill-report.js';
import { toPosixPath } from '../utils/posix.js';

/**
 * The --dry-run branch of the fill stage: the budget header, the per-subject
 * breakdown, what a missing reviewer means for it, the prune preview, then the
 * read the preview reports under — and nothing written. The orchestrator calls
 * it BEFORE its serialized writer is constructed, so there is no writer to
 * invoke and no fill loop is reached. It INTENTIONALLY bypasses the log gate (a
 * cost preview must not require a fresh log entry); only the structural/config
 * gate, which already ran, can abort a preview.
 */
export async function runDryRunPreview(
  graph: Graph,
  params: {
    opts: RunFillOptions;
    lock: LockFile;
    classification: FillPairSets;
    coverage: FillCoverage;
    /** The header counts, exactly as a real run would announce them. */
    headerCounts: Required<FillDispatchCounts>;
    onlyDeterministic: boolean;
    emit: FillEventSink;
  },
): Promise<RunFillResult> {
  const { opts, lock, classification, coverage, headerCounts, onlyDeterministic, emit } = params;
  const { verification, detPairs, llmPairs, aspectById, detAspectIdsOnDisk, reportNodeSet, reportFileSet, reviewerCallBudget } = classification;
  // The priced pairs first, then what a missing reviewer means for them, so
  // the preview ends on its own caveat rather than on a list.
  emitDispatchHeader(emit, headerCounts, false);
  emit({ ...dryRunBreakdown(graph, { detPairs, llmPairs, aspectById, reviewerCallBudget }), reviewerConfigured: headerCounts.reviewerConfigured });
  emitNoReviewerNote(emit, llmPairs.length, headerCounts.reviewerConfigured, true);
  const prunePreview = await previewPruneSummary(graph, lock, {
    typeCoverage: coverage.typeCoverageInput,
    detAspectIdsOnDisk,
    onlyDeterministic,
  });
  emit({ type: 'prune', ...prunePreview });
  const checkResult = await runCheck(graph, opts.coverageVisibleFiles, {
    // A preview executes no repository code; its verification (above) ran none.
    runCompanionHooks: false,
    nowUtc: opts.reviewNowUtc,
    rulesArtifacts: opts.rulesArtifacts,
    reasonlessSuppressMarkers: opts.reasonlessSuppressMarkers,
    trackedFiles: opts.trackedFiles,
    precomputedTypeCoverage: coverage.typeCoverageResult,
    // A preview writes nothing — it returns before the verdict writer is even
    // constructed — so both of these still describe exactly what this call
    // classified moments ago. Handing them over is what makes a cost preview
    // cost like the read it is, instead of re-hashing every pair and
    // re-parsing every mapped source file to rediscover what is already here.
    precomputedRelationPass: coverage.relPassResult,
    precomputedVerification: verification,
    // The same measurement the preview priced against, so the report under a
    // budget describes the same run that budget is for: a preview that priced
    // only the change's obligations must not then print a wall of findings
    // the change is not accountable for as though the fill would clear them.
    changeScope: opts.changeScope,
  });
  const dryRunBudget = { pairs: detPairs.length + llmPairs.length, nodes: reportNodeSet.size, files: reportFileSet.size, deterministic: detPairs.length, reviewerCalls: reviewerCallBudget };
  return { checkResult, dryRunBudget, reviewerCallsMade: 0, infraFailures: 0, runtimeErrors: 0, companionRuntimeErrors: 0, malformedSuppressErrors: 0, runtimeDispositions: [] };
}

/**
 * The per-subject cost breakdown a preview prints, as one `dry-run` event (the
 * words, and the upper-bound caveat after them, are formatters/fill-text.ts's).
 *
 * A preview prices the run it previews, so it is handed the SAME two fill sets
 * the run would dispatch — never the raw unverified set. Anything the run has
 * already decided not to fill (an LLM pair under --only-deterministic, or one
 * the current change is not accountable for) is absent from both sets and is
 * therefore absent from the bill; the header emitted just before says how many
 * were left out and why, so the shorter breakdown never reads as the whole
 * outstanding backlog.
 *
 * The fill set is grouped by node (sorted), and each node's pairs split by
 * reviewer kind (script pairs first, each half sorted by aspect). Within the LLM
 * group, each pair's consensus resolves exactly as the header budget resolved
 * it, so the per-aspect numbers reconcile with that total. Nodeless (file-level)
 * pairs are collected separately, sorted by aspect then file, and carried in
 * their own list — never inside the node grouping (no phantom component).
 */
function dryRunBreakdown(
  graph: Graph,
  params: {
    /** The free half this run would fill — always the whole project. */
    detPairs: ExpectedPair[];
    /** The paid half this run would fill — narrowed to the change, when measured. */
    llmPairs: ExpectedPair[];
    aspectById: Map<string, AspectDef>;
    reviewerCallBudget: number;
  },
): Extract<FillEvent, { type: 'dry-run' }> {
  const { detPairs, llmPairs, aspectById, reviewerCallBudget } = params;
  const byNode = new Map<string, ExpectedPair[]>();
  const filePairs: ExpectedPair[] = [];
  for (const p of [...detPairs, ...llmPairs]) {
    if (p.nodePath === undefined) { filePairs.push(p); continue; }
    const list = byNode.get(p.nodePath) ?? [];
    list.push(p);
    byNode.set(p.nodePath, list);
  }
  const priced = (p: ExpectedPair, unit: string): DryRunPair =>
    p.kind === 'deterministic'
      ? { lane: 'det', aspectId: p.aspectId, unit: toPosixPath(unit) }
      : { lane: 'llm', aspectId: p.aspectId, unit: toPosixPath(unit), reviewerCalls: reviewerCallsForPair(graph, aspectById, p) };
  const byAspect = (a: ExpectedPair, b: ExpectedPair): number => a.aspectId.localeCompare(b.aspectId, 'en');
  const nodes = [...byNode.keys()].sort().map((nodePath) => {
    const nodePairs = byNode.get(nodePath)!;
    const det = nodePairs.filter((p) => p.kind === 'deterministic').sort(byAspect);
    const llm = nodePairs.filter((p) => p.kind === 'llm').sort(byAspect);
    return { nodePath: toPosixPath(nodePath), pairs: [...det, ...llm].map((p) => priced(p, p.unitKey)) };
  });
  const sortByAspectThenFile = (a: ExpectedPair, b: ExpectedPair): number =>
    a.aspectId.localeCompare(b.aspectId, 'en') ||
    toPosixPath(a.subjectFiles[0]).localeCompare(toPosixPath(b.subjectFiles[0]), 'en');
  const fileDet = filePairs.filter((p) => p.kind === 'deterministic').sort(sortByAspectThenFile);
  const fileLlm = filePairs.filter((p) => p.kind === 'llm').sort(sortByAspectThenFile);
  const files = [...fileDet, ...fileLlm].map((p) => priced(p, p.subjectFiles[0]));
  return { type: 'dry-run', nodes, files, reviewerCallBudget };
}

/**
 * Prune-summary PREVIEW: the same GC analysis a real --approve would run, over a
 * disposable deep clone of the lock so the preview mutates and persists NOTHING
 * (the no-write guarantee for --dry-run stays structural). The no-op persist
 * callback is what keeps the clone off disk.
 */
async function previewPruneSummary(
  graph: Graph,
  lock: LockFile,
  opts: { typeCoverage: TypeCoverageInput | undefined; detAspectIdsOnDisk: Set<string>; onlyDeterministic: boolean },
): Promise<PruneSummary> {
  const previewLock = structuredClone(lock);
  return garbageCollectAndRewrite(graph, previewLock, async () => {}, {
    typeCoverage: opts.typeCoverage,
    detAspectIdsOnDisk: opts.detAspectIdsOnDisk,
    scope: opts.onlyDeterministic ? 'deterministic' : 'all',
  });
}
