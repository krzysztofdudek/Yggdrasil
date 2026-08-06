/**
 * source/cli/src/core/fill-classify.ts — step 2 of the fill stage (spec §7):
 * decide WHICH pairs this run fills, and what filling them would cost.
 *
 * Classification runs through the SAME engine plain check uses (verifyLock), so
 * a verdict the fill writes here verifies there — one implementation, never two
 * that can drift. Unverified pairs are the fill set; prompt-too-large pairs are
 * skipped (gate precedence, §4); valid (verified or refused) pairs are already
 * final and never re-run.
 *
 * Nothing here writes, dispatches, or judges anything: it reads the lock's
 * classification and counts, and every number it produces is what the
 * pre-dispatch header and the dry-run cost preview then report.
 */

import type { Graph, AspectDef } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import type { LockVerification } from './verify-lock.js';
import { verifyLock } from './verify-lock.js';
import { readDetLockAspectIds } from '../io/lock-store.js';
import { selectTierForAspect } from './tier-selection.js';

export interface FillPairSets {
  /** The full per-pair classification — also the seed for the deterministic
   *  gate's CACHED-valid refusals, which is why the raw verification is kept. */
  verification: LockVerification;
  /** Every pair this run would fill (deterministic + LLM). */
  unverifiedPairs: ExpectedPair[];
  detPairs: ExpectedPair[];
  /** Empty under --only-deterministic: no LLM fills happen that run. */
  llmPairs: ExpectedPair[];
  /** Unverified LLM pairs --only-deterministic is intentionally NOT filling.
   *  Counted so the header and closing summary can say so honestly instead of
   *  implying the run reviewed or verified them. Zero outside that mode. */
  skippedLlmPairs: number;
  /** Aspect defs indexed by id, for every downstream phase that resolves one. */
  aspectById: Map<string, AspectDef>;
  /** Partition key for the split lock: verdicts of these aspects go to the
   *  gitignored deterministic file; all others (LLM, incl. companion-backed) to
   *  the committed file. */
  deterministicAspectIds: Set<string>;
  /** The SAME partition, read back from disk rather than derived from the
   *  current graph — fed to GC so a pruned entry whose aspect no longer exists
   *  in the graph at all (deleted, not just detached) can still be classified
   *  billed vs free from where its verdicts actually live, instead of
   *  defaulting to a guess. */
  detAspectIdsOnDisk: Set<string>;
  /** Distinct components owning at least one pair in the fill set. */
  nodeSet: Set<string>;
  /** Distinct type-covered files owning at least one nodeless pair. Several
   *  aspects can share one file's unit key, so it is deduped by unitKey. */
  fileSet: Set<string>;
  /** Upper-bound reviewer calls for the fill set, consensus included. */
  reviewerCallBudget: number;
}

/**
 * Resolve how many reviewer calls one LLM pair would cost: its tier's consensus
 * when the tier resolves, else 1. Shared by the pre-dispatch budget and the
 * dry-run breakdown so the per-aspect numbers always reconcile with the header.
 */
export function reviewerCallsForPair(graph: Graph, aspectById: Map<string, AspectDef>, pair: ExpectedPair): number {
  const aspect = aspectById.get(pair.aspectId);
  const reviewer = graph.config.reviewer;
  const tier = aspect && reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
  return tier?.ok ? tier.tier.consensus : 1;
}

/**
 * Classify every expected pair against `lock` and derive this run's fill set,
 * subject counts, and reviewer-call budget.
 */
export async function classifyFillPairs(
  graph: Graph,
  lock: LockFile,
  typeCoverage: TypeCoverageInput | undefined,
  onlyDeterministic: boolean,
): Promise<FillPairSets> {
  const verification = await verifyLock(graph, lock, typeCoverage);

  const unverifiedPairs: ExpectedPair[] = [];
  for (const vp of verification.pairs) {
    if (vp.state.kind === 'unverified') unverifiedPairs.push(vp.pair);
    // verified / refused / prompt-too-large → not filled.
  }

  const detPairs = unverifiedPairs.filter((p) => p.kind === 'deterministic');
  // --only-deterministic: no LLM fills this run. An empty set naturally skips the
  // reviewer-call budget, the deterministic gate, and the whole step-6 LLM loop.
  const llmPairs = onlyDeterministic ? [] : unverifiedPairs.filter((p) => p.kind === 'llm');
  const skippedLlmPairs = onlyDeterministic
    ? unverifiedPairs.filter((p) => p.kind === 'llm').length
    : 0;

  // Index aspect defs and resolve consensus for the header's call count.
  const aspectById = new Map<string, AspectDef>();
  for (const a of graph.aspects) aspectById.set(a.id, a);

  const deterministicAspectIds = new Set(
    graph.aspects.filter((a) => a.reviewer.type === 'deterministic').map((a) => a.id),
  );
  const detAspectIdsOnDisk = readDetLockAspectIds(graph.rootPath);

  const nodeSet = new Set<string>();
  const fileSet = new Set<string>();
  for (const p of unverifiedPairs) {
    if (p.nodePath !== undefined) nodeSet.add(p.nodePath);
    else fileSet.add(p.unitKey);
  }
  let reviewerCallBudget = 0;
  for (const p of llmPairs) reviewerCallBudget += reviewerCallsForPair(graph, aspectById, p);

  return {
    verification,
    unverifiedPairs,
    detPairs,
    llmPairs,
    skippedLlmPairs,
    aspectById,
    deterministicAspectIds,
    detAspectIdsOnDisk,
    nodeSet,
    fileSet,
    reviewerCallBudget,
  };
}
