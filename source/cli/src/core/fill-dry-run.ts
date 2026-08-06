/**
 * source/cli/src/core/fill-dry-run.ts — the `yg check --approve --dry-run` cost
 * preview (spec §7).
 *
 * A preview answers one question: what WOULD this run do, and what would it
 * cost? It therefore writes nothing at all — no reviewer calls, no deterministic
 * checks, no lock writes. The orchestrator returns before its serialized writer
 * even exists, so the no-write guarantee is structural rather than a promise
 * kept by the code below; what lives here is only the breakdown text and a
 * prune analysis run over a disposable clone of the lock.
 */

import type { Graph, AspectDef } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import type { PruneSummary } from './fill-gc.js';
import { garbageCollectAndRewrite } from './fill-gc.js';
import { reviewerCallsForPair } from './fill-classify.js';
import { toPosixPath } from '../utils/posix.js';

/**
 * Write the per-subject cost breakdown, then the upper-bound caveat.
 *
 * The fill set is grouped by node, and each node's pairs split by reviewer kind.
 * Within the LLM group, each pair's consensus resolves exactly as the header
 * budget resolved it, so the per-aspect numbers reconcile with that total.
 * Nodeless (file-level) pairs are collected separately and rendered AFTER every
 * component section, in their own "Files enforced by their type" section — never
 * inside the node grouping (no phantom component line).
 *
 * This is plain progress text: the engine never formats diagnostics.
 */
export function writeDryRunBreakdown(
  graph: Graph,
  params: {
    unverifiedPairs: ExpectedPair[];
    aspectById: Map<string, AspectDef>;
    onlyDeterministic: boolean;
    reviewerCallBudget: number;
  },
  write: (s: string) => void,
): void {
  const { unverifiedPairs, aspectById, onlyDeterministic, reviewerCallBudget } = params;
  const byNode = new Map<string, ExpectedPair[]>();
  const filePairs: ExpectedPair[] = [];
  for (const p of unverifiedPairs) {
    if (p.nodePath === undefined) { filePairs.push(p); continue; }
    const list = byNode.get(p.nodePath) ?? [];
    list.push(p);
    byNode.set(p.nodePath, list);
  }
  for (const nodePath of [...byNode.keys()].sort()) {
    const nodePairs = byNode.get(nodePath)!;
    write(`  ${toPosixPath(nodePath)}\n`);
    const det = nodePairs.filter((p) => p.kind === 'deterministic');
    const llm = onlyDeterministic ? [] : nodePairs.filter((p) => p.kind === 'llm');
    for (const p of [...det].sort((a, b) => a.aspectId.localeCompare(b.aspectId, 'en'))) {
      write(`    [det] ${p.aspectId} on ${toPosixPath(p.unitKey)} — free\n`);
    }
    for (const p of [...llm].sort((a, b) => a.aspectId.localeCompare(b.aspectId, 'en'))) {
      write(`    [llm] ${p.aspectId} on ${toPosixPath(p.unitKey)} — ${reviewerCallsForPair(graph, aspectById, p)} reviewer call(s)\n`);
    }
  }
  if (filePairs.length > 0) {
    write(`  Files enforced by their type\n`);
    const sortByAspectThenFile = (a: ExpectedPair, b: ExpectedPair): number =>
      a.aspectId.localeCompare(b.aspectId, 'en') ||
      toPosixPath(a.subjectFiles[0]).localeCompare(toPosixPath(b.subjectFiles[0]), 'en');
    const det = filePairs.filter((p) => p.kind === 'deterministic').sort(sortByAspectThenFile);
    const llm = onlyDeterministic ? [] : filePairs.filter((p) => p.kind === 'llm').sort(sortByAspectThenFile);
    for (const p of det) {
      write(`    [det] ${p.aspectId} on ${toPosixPath(p.subjectFiles[0])} — free\n`);
    }
    for (const p of llm) {
      write(`    [llm] ${p.aspectId} on ${toPosixPath(p.subjectFiles[0])} — ${reviewerCallsForPair(graph, aspectById, p)} reviewer call(s)\n`);
    }
  }
  write(
    `${reviewerCallBudget} reviewer call(s) is an UPPER BOUND — a node with an enforced ` +
      `deterministic refusal has its LLM fills skipped this run, and a fresh refusal or ` +
      `infra disposition can leave a pair unfilled. Nothing was written; run yg check --approve to fill.\n`,
  );
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
