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
 * ── The two halves, and why only one of them narrows ────────────────────────
 * A deterministic pair costs nothing to fill and its recorded observation list
 * is what a later run's scope computation reads, so the FREE half is always the
 * whole project. The PAID half is not: reviewing a pair the current change is
 * not accountable for spends real review on inherited work, which is the exact
 * cost this narrowing exists to prevent. So when the caller supplies a change
 * scope, the LLM fill set is intersected with it — by the same per-pair
 * decision the report gates with (core/check-progressive.ts's `pairIsInScope`),
 * never a second copy of it.
 *
 * ── Two node sets, deliberately ─────────────────────────────────────────────
 * `nodeSet` stays UNFILTERED and feeds the mandatory-log gate, which is
 * all-or-nothing over every component owning an unverified pair. The reported
 * counts come from `reportNodeSet`/`reportFileSet` instead, computed from what
 * this run will ACTUALLY fill. One value cannot serve both purposes: quoting
 * the gate's set would price work the run has no intention of doing, and
 * narrowing the gate's set would let a component's missing justification entry
 * slip through because some other change happened not to reach it.
 *
 * Nothing here writes, dispatches, or judges anything: it reads the lock's
 * classification and counts, and every number it produces is what the
 * pre-dispatch header and the dry-run cost preview then report.
 */

import type { Graph, AspectDef } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { BurnSet } from './progressive-scope.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import type { LockVerification } from './verify-lock.js';
import { verifyLock } from './verify-lock.js';
import { knownPairKeys, pairIsInScope } from './check-progressive.js';
import { readDetLockAspectIds } from '../io/lock-store.js';
import { selectTierForAspect } from './tier-selection.js';

export interface FillPairSets {
  /** The full per-pair classification — also the seed for the deterministic
   *  gate's CACHED-valid refusals, which is why the raw verification is kept. */
  verification: LockVerification;
  /** Every pair this run's classification found unverified (deterministic +
   *  LLM), BEFORE any narrowing. Not the fill set once a change scope is in
   *  force — `detPairs` and `llmPairs` below are what actually gets filled. */
  unverifiedPairs: ExpectedPair[];
  /** The free half: always the whole project, never narrowed. */
  detPairs: ExpectedPair[];
  /** The paid half this run will actually fill. Empty under
   *  --only-deterministic (no LLM fills happen that run); narrowed to the
   *  change's own obligations when a scope is supplied. */
  llmPairs: ExpectedPair[];
  /** Unverified LLM pairs --only-deterministic is intentionally NOT filling.
   *  Counted so the header and closing summary can say so honestly instead of
   *  implying the run reviewed or verified them. Zero outside that mode. */
  skippedLlmPairs: number;
  /** Unverified LLM pairs left alone because the change is not accountable for
   *  them — the same "outside" the report renders as a non-blocking twin.
   *  Counted for exactly the reason above: a run that quietly reviewed fewer
   *  pairs than it named would read as having covered them all. Zero without a
   *  change scope, and zero under --only-deterministic, whose own count above
   *  already covers every unreviewed LLM pair (reporting both would announce
   *  the same pairs twice, once as a subset of the other). */
  skippedOutsideLlmPairs: number;
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
  /** Distinct components owning at least one UNVERIFIED pair — every one of
   *  them, whatever this run intends to fill. This is the mandatory-log gate's
   *  set and only that: the gate is all-or-nothing by design (§9), so narrowing
   *  it would silently excuse a component whose source moved without a
   *  justification entry. Never use it for a count a person reads — see
   *  `reportNodeSet`. */
  nodeSet: Set<string>;
  /** Distinct components owning at least one pair this run will ACTUALLY fill.
   *  The number the pre-dispatch header quotes. */
  reportNodeSet: Set<string>;
  /** Distinct type-covered files owning at least one nodeless pair this run
   *  will actually fill. Several aspects can share one file's unit key, so it
   *  is deduped by unitKey. */
  reportFileSet: Set<string>;
  /** Upper-bound reviewer calls for the pairs this run will actually fill,
   *  consensus included — so the budget quoted is a bill the run can spend. */
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
 *
 * `changeScope` is the burn set the caller measured this change against, or
 * undefined for a run answering for the whole project. Supplying it narrows the
 * PAID half of the fill set and nothing else — see this module's header.
 */
export async function classifyFillPairs(
  graph: Graph,
  lock: LockFile,
  typeCoverage: TypeCoverageInput | undefined,
  onlyDeterministic: boolean,
  changeScope?: BurnSet,
): Promise<FillPairSets> {
  const verification = await verifyLock(graph, lock, typeCoverage);

  const unverifiedPairs: ExpectedPair[] = [];
  for (const vp of verification.pairs) {
    if (vp.state.kind === 'unverified') unverifiedPairs.push(vp.pair);
    // verified / refused / prompt-too-large → not filled.
  }

  const detPairs = unverifiedPairs.filter((p) => p.kind === 'deterministic');
  const unverifiedLlmPairs = unverifiedPairs.filter((p) => p.kind === 'llm');
  // The scope decision reads THIS run's own enumeration, exactly as the report's
  // does: a pair no enumeration produced is unattributable and stays in — the
  // paying direction, matching the report's blocking one.
  const known = knownPairKeys(verification.pairs);
  const inScope = (p: ExpectedPair): boolean =>
    changeScope === undefined || pairIsInScope(changeScope, p.aspectId, p.unitKey, known);
  // --only-deterministic: no LLM fills this run. An empty set naturally skips the
  // reviewer-call budget, the deterministic gate, and the whole step-6 LLM loop.
  const llmPairs = onlyDeterministic ? [] : unverifiedLlmPairs.filter(inScope);
  const skippedLlmPairs = onlyDeterministic ? unverifiedLlmPairs.length : 0;
  const skippedOutsideLlmPairs = onlyDeterministic
    ? 0
    : unverifiedLlmPairs.length - llmPairs.length;

  // Index aspect defs and resolve consensus for the header's call count.
  const aspectById = new Map<string, AspectDef>();
  for (const a of graph.aspects) aspectById.set(a.id, a);

  const deterministicAspectIds = new Set(
    graph.aspects.filter((a) => a.reviewer.type === 'deterministic').map((a) => a.id),
  );
  const detAspectIdsOnDisk = readDetLockAspectIds(graph.rootPath);

  // The log gate's set: every component owning an unverified pair, unfiltered.
  const nodeSet = new Set<string>();
  for (const p of unverifiedPairs) {
    if (p.nodePath !== undefined) nodeSet.add(p.nodePath);
  }
  // The reported sets: the subjects of the pairs this run will actually fill.
  const reportNodeSet = new Set<string>();
  const reportFileSet = new Set<string>();
  for (const p of [...detPairs, ...llmPairs]) {
    if (p.nodePath !== undefined) reportNodeSet.add(p.nodePath);
    else reportFileSet.add(p.unitKey);
  }
  let reviewerCallBudget = 0;
  for (const p of llmPairs) reviewerCallBudget += reviewerCallsForPair(graph, aspectById, p);

  return {
    verification,
    unverifiedPairs,
    detPairs,
    llmPairs,
    skippedLlmPairs,
    skippedOutsideLlmPairs,
    aspectById,
    deterministicAspectIds,
    detAspectIdsOnDisk,
    nodeSet,
    reportNodeSet,
    reportFileSet,
    reviewerCallBudget,
  };
}
