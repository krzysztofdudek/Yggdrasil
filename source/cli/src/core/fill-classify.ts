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
 * That scope is WIDENED by the byte guard first, exactly as the report's is. It
 * has to be: the guard re-admits a rule check whose subject files differ from
 * the reference although git reported them unchanged, and the report then blocks
 * on it. If this stage went on reading the unwidened scope it would decline to
 * review the very pair the report is blocking over — and the command that report
 * advises is this one, so the run would be unfixable by the step it points at,
 * forever, at a measured cost of zero reviewer calls. One widened scope, read by
 * both, is the only shape in which the advice a run gives is advice that works.
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

import path from 'node:path';

import type { Graph, AspectDef } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { BurnSet } from './progressive-scope.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import type { LockVerification } from './verify-lock.js';
import { verifyLock } from './verify-lock.js';
import { knownPairKeys, pairIsInScope } from './check-progressive.js';
import { forceInScopeOnByteMismatch, progressivePairKey } from './progressive-scope.js';
import { collectPairByteGuardCandidates, type ByteGuardScope } from './check-byte-guard.js';
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
  /** The pair keys of exactly those pairs — what positive closure needs to tell
   *  "unverified because we were told not to buy it" from "unverified because
   *  something went wrong", which are the same state and must not close alike. */
  skippedOutsideLlmPairKeys: Set<string>;
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
 * `changeScope` is the measurement the caller made against the reference, plus
 * the reference's own file listing, or undefined for a run answering for the
 * whole project. Supplying it narrows the PAID half of the fill set and nothing
 * else — see this module's header.
 */
export async function classifyFillPairs(
  graph: Graph,
  lock: LockFile,
  typeCoverage: TypeCoverageInput | undefined,
  onlyDeterministic: boolean,
  changeScope?: ByteGuardScope,
): Promise<FillPairSets> {
  const projectRoot = path.dirname(graph.rootPath);
  // The byte cache this verification fills is handed to the guard below, so the
  // content it compares is the content the re-hash just read — one pass over
  // those files, and no window in which the two could see different bytes.
  const byteCache = new Map<string, Buffer | null>();
  const verification = await verifyLock(graph, lock, typeCoverage, byteCache);

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
  // Widen the measurement by the byte guard before anything is decided against
  // it — see this module's header for why buying and blocking must read the
  // SAME widened answer.
  const guardedBurn: BurnSet | undefined =
    changeScope === undefined
      ? undefined
      : forceInScopeOnByteMismatch(
          changeScope,
          (await collectPairByteGuardCandidates(changeScope, verification.pairs, projectRoot, byteCache))
            .candidates,
        );
  const inScope = (p: ExpectedPair): boolean =>
    guardedBurn === undefined || pairIsInScope(guardedBurn, p.aspectId, p.unitKey, known);
  // --only-deterministic: no LLM fills this run. An empty set naturally skips the
  // reviewer-call budget, the deterministic gate, and the whole step-6 LLM loop.
  const llmPairs = onlyDeterministic ? [] : unverifiedLlmPairs.filter(inScope);
  const skippedLlmPairs = onlyDeterministic ? unverifiedLlmPairs.length : 0;
  const filledLlmKeys = new Set(llmPairs.map((p) => progressivePairKey(p.aspectId, p.unitKey)));
  const skippedOutsideLlmPairKeys = new Set(
    onlyDeterministic
      ? []
      : unverifiedLlmPairs
        .map((p) => progressivePairKey(p.aspectId, p.unitKey))
        .filter((key) => !filledLlmKeys.has(key)),
  );
  const skippedOutsideLlmPairs = skippedOutsideLlmPairKeys.size;

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
    skippedOutsideLlmPairKeys,
    aspectById,
    deterministicAspectIds,
    detAspectIdsOnDisk,
    nodeSet,
    reportNodeSet,
    reportFileSet,
    reviewerCallBudget,
  };
}
