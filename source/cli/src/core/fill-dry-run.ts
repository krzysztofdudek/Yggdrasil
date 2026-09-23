/**
 * source/cli/src/core/fill-dry-run.ts — the `yg check --approve --dry-run` cost
 * preview (spec §7).
 *
 * A preview answers one question: what WOULD this run do, and what would it
 * cost? It therefore writes nothing at all — no reviewer calls, no deterministic
 * checks, no lock writes. The orchestrator returns before its serialized writer
 * even exists, so the no-write guarantee is structural rather than a promise
 * kept by the code below; what lives here is only the breakdown (as data) and a
 * prune analysis run over a disposable clone of the lock.
 */

import type { Graph, AspectDef } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import type { PruneSummary } from './fill-gc.js';
import type { FillEvent, DryRunPair } from '../model/fill-event.js';
import { garbageCollectAndRewrite } from './fill-gc.js';
import { reviewerCallsForPair } from './fill-classify.js';
import { toPosixPath } from '../utils/posix.js';

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
export function dryRunBreakdown(
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
export async function previewPruneSummary(
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
