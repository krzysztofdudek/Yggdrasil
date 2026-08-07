/**
 * source/cli/src/core/fill-llm-phase.ts — step 6 of the fill stage (spec §7):
 * review every remaining unverified LLM pair.
 *
 * Pairs are grouped by RESOLVED TIER, and each tier is dispatched behind one
 * provider instance: availability is probed once per tier rather than once per
 * pair, and a tier whose provider is unreachable disposes of its whole group at
 * once. Within a tier, a bounded pool runs pairs concurrently while consensus
 * votes for a single pair run sequentially in-slot.
 *
 * Tier config already reflects the yg-secrets overlay (deep-merged at config
 * parse time), so no per-provider secret merge happens here.
 *
 * Fail-closed (§3.2): every infra disposition — no reviewer, tier unresolvable,
 * provider unreachable, reference unreadable, unparseable response, companion
 * resolution failure — writes NOTHING. The verdicts that ARE produced are
 * persisted the moment their pair completes, so an interrupted run keeps them.
 */

import type { Graph, AspectDef, LlmConfig } from '../model/graph.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import type { IssueMessage } from '../model/validation.js';
import type { LlmFillOutcome } from './fill-shared.js';
import type { ProgressTracker } from './fill-progress.js';
import type { VerdictWriter } from './fill-writer.js';
import type { InfraDiagnosticItem } from './fill-report.js';
import { detGateKey, isNodeBlocked } from './fill-contract.js';
import { fillLlmPair } from './fill-llm.js';
import { runPairPool } from './fill-pool.js';
import {
  buildParseCacheBuckets,
  destroyRemainingParseCaches,
  parseCacheBucketKey,
  releaseParseCacheBucket,
} from './parse-cache-buckets.js';
import { selectTierForAspect } from './tier-selection.js';
import { createLlmProvider } from '../llm/index.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';

/**
 * The resolved LLM judge's identity (provider + model) for a tier config, as
 * recorded on an LLM verdict-events line (io/events-store.ts, `judge`).
 * Telemetry ONLY — NEVER a hash ingredient (pair-hash.ts is deliberately
 * untouched). `model` is stringified defensively: a tier's model is already a
 * string, but the sidecar contract pins the field's type. It lives beside the
 * reviewer call sites because those are the only places a judge is ever
 * resolved: deterministic lines and unresolved-tier LLM lines carry no judge
 * (regime unknown), so no other module has one to record.
 */
export function judgeIdentity(tier: LlmConfig): { provider: string; model: string } {
  return { provider: tier.provider, model: String(tier.model) };
}

export interface LlmPhaseResult {
  /** Number of reviewer calls actually dispatched (consensus-inclusive). */
  reviewerCallsMade: number;
  /** Pairs that hit an infra disposition (no write). */
  infraFailures: number;
  /** LLM pairs whose companion.mjs failed to resolve/run (no write). */
  companionRuntimeErrors: number;
  /** Provider/tier identities behind the infra dispositions, for the closing summary. */
  infraReport: Array<{ provider?: string; tier?: string }>;
  /** Companion-failure notices, in dispatch order, for grouped emission by the caller. */
  companionRuntimeItems: InfraDiagnosticItem[];
  /** Infra notices (tier-unresolvable + per-tier pool failures), in dispatch
   *  order, for grouped emission by the caller. */
  poolInfraItems: InfraDiagnosticItem[];
}

export interface LlmPhaseParams {
  graph: Graph;
  projectRoot: string;
  /** Every unverified LLM pair; log-gate-blocked and det-gate-skipped ones are
   *  filtered out here. Empty under --only-deterministic. */
  llmPairs: ExpectedPair[];
  aspectById: Map<string, AspectDef>;
  /** Components the step-4 log gate blocked this run. */
  blockedNodes: Set<string>;
  /** Gate keys whose paid review the deterministic phase already ruled out. */
  llmSkippedByDetGate: Set<string>;
  typeCoverage: TypeCoverageInput | undefined;
  /** The architecture-reach cache shared with the deterministic phase — see
   *  runFill's own doc for why one map serves both. */
  reachCache: Map<string, Set<string>>;
  writer: VerdictWriter;
  tracker: ProgressTracker;
  write: (s: string) => void;
  emitIssue: (msg: IssueMessage) => void;
}

export async function runLlmPhase({
  graph, projectRoot, llmPairs, aspectById, blockedNodes, llmSkippedByDetGate,
  typeCoverage, reachCache, writer, tracker, write, emitIssue,
}: LlmPhaseParams): Promise<LlmPhaseResult> {
  const result: LlmPhaseResult = {
    reviewerCallsMade: 0,
    infraFailures: 0,
    companionRuntimeErrors: 0,
    infraReport: [],
    companionRuntimeItems: [],
    poolInfraItems: [],
  };

  // Reference bytes are cached as RAW disk Buffers (null = missing/unreadable) so
  // the producer hashes and prompts the SAME bytes the verifier re-reads through
  // readFileBytes — a BOM or non-UTF-8 reference can never desync the two sides
  // (spec §3.1; Bug 1).
  const referencesCache = new Map<string, Buffer | null>();

  // Resolve each fillable LLM pair to its tier; an unresolvable tier is an infra
  // disposition (no write). Group resolvable pairs by tier name.
  interface ResolvedLlmPair { pair: ExpectedPair; aspect: AspectDef; tier: LlmConfig; tierName: string }
  const byTier = new Map<string, ResolvedLlmPair[]>();

  for (const pair of llmPairs) {
    if (isNodeBlocked(pair, blockedNodes) || llmSkippedByDetGate.has(detGateKey(pair))) continue;
    const aspect = aspectById.get(pair.aspectId);
    if (!aspect) continue;
    const reviewer = graph.config.reviewer;
    const tierResult = reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
    if (!tierResult || !tierResult.ok) {
      // No reviewer configured OR tier resolution failed — infra disposition.
      // Collect for grouped emission after the tier loop.
      result.infraFailures += 1;
      result.infraReport.push({ tier: aspect.reviewer.tier });
      result.poolInfraItems.push({
        aspectId: pair.aspectId,
        unitKey: toPosixPath(pair.unitKey),
        messageData: {
          what: `Cannot resolve a reviewer tier for aspect '${pair.aspectId}' on ${toPosixPath(pair.unitKey)} — left unverified.`,
          why: tierResult && !tierResult.ok ? tierResult.error.why : 'No reviewer is configured for an effective non-draft LLM aspect.',
          next: tierResult && !tierResult.ok ? tierResult.error.next : 'Add a reviewer tier in .yggdrasil/yg-config.yaml, or set the aspect to status: draft.',
        },
      });
      writer.emitEvent(pair.aspectId, toPosixPath(pair.unitKey), 'llm', 'infra', { tier: aspect.reviewer.tier });
      continue;
    }
    const list = byTier.get(tierResult.tierName) ?? [];
    list.push({ pair, aspect, tier: tierResult.tier, tierName: tierResult.tierName });
    byTier.set(tierResult.tierName, list);
  }

  const parallel = Math.max(1, graph.config.parallel ?? 1);

  for (const [tierName, group] of byTier) {
    // Tier config already includes the yg-secrets overlay (applied at parse time).
    const baseTier = group[0].tier;
    const provider = createLlmProvider(baseTier);

    // Availability is an infra gate — if the provider is unreachable, every
    // pair in this tier is an infra disposition (no write).
    let available: boolean;
    try {
      available = await provider.isAvailable();
    } catch (e) {
      debugWrite(`[fill] provider.isAvailable threw for tier ${tierName}: ${e instanceof Error ? e.message : String(e)}`);
      available = false;
    }
    if (!available) {
      result.infraFailures += group.length;
      result.infraReport.push({ provider: baseTier.provider, tier: tierName });
      for (const item of group) {
        writer.emitEvent(item.pair.aspectId, toPosixPath(item.pair.unitKey), 'llm', 'infra', { tier: tierName, judge: judgeIdentity(baseTier) });
      }
      emitIssue({
        what: `Reviewer provider '${baseTier.provider}' (tier '${tierName}') is unreachable — ${group.length} pair(s) left unverified.`,
        why: 'The configured reviewer endpoint did not respond (availability check failed) — an infrastructure problem, not a code violation. No verdict was written.',
        next: `Check the provider endpoint, network, and credentials, then re-run: yg check --approve`,
      });
      continue;
    }

    // Worker pool bounded by parallel; consensus runs sequentially in-slot.
    // One shared parse cache per (aspectId, node/unit) bucket within this tier's
    // group — a `per: file` companion rule with N subjects on one node shares
    // ONE cache across all N instead of building/discarding one per pair. Bucket
    // members may run CONCURRENTLY with each other (the pool bounds concurrency
    // to `parallel`, not to one bucket at a time) — see buildParseCacheBuckets'
    // own doc for why a shared Map is safe under that. Only a companion aspect
    // (hasCompanion) ever reads its cache (fillLlmPair threads it into
    // resolveCompanionsForPair only when hasCompanion is true); a plain LLM pair
    // still gets a bucket entry, it is just never touched — harmless.
    const parseCacheBuckets = buildParseCacheBuckets(group.map((g) => g.pair));
    let outcomes: LlmFillOutcome[];
    try {
      outcomes = await runPairPool(group, parallel, async (item) => {
        tracker.onPairStart('llm', item.pair.aspectId, toPosixPath(item.pair.unitKey), write);
        const bucket = parseCacheBuckets.get(parseCacheBucketKey(item.pair));
        try {
          const outcome = await fillLlmPair(graph, projectRoot, item.pair, item.aspect, item.tier, item.tierName, baseTier, provider, referencesCache, typeCoverage, reachCache, bucket?.cache);
          // Persist each verdict the moment its pair completes — like the deterministic
          // loop — so interrupting the run (Ctrl+C) keeps every finished verdict and the
          // next run resumes only the rest (§7). Infra dispositions write nothing.
          // setEntry's mutation is synchronous and persistLock serializes the disk
          // writes, so concurrent pool workers cannot corrupt the lock.
          if (outcome.kind === 'verdict') {
            const votes = {
              satisfied: outcome.votes.filter((v) => v.satisfied).length,
              total: outcome.votes.length,
            };
            await writer.setEntry(item.pair, outcome.entry, item.tierName, votes, judgeIdentity(item.tier));
            tracker.onPairComplete('llm', item.pair.aspectId, toPosixPath(item.pair.unitKey), outcome.entry.verdict, write);
          } else if (outcome.kind === 'infra' || outcome.kind === 'companion-runtime-error') {
            tracker.onPairComplete('llm', item.pair.aspectId, toPosixPath(item.pair.unitKey), 'infra', write);
          }
          return outcome;
        } finally {
          releaseParseCacheBucket(parseCacheBuckets, item.pair);
        }
      });
    } finally {
      // Backstop only — fill-pool.ts always awaits `fn`, so its own try/finally
      // has already run before a worker throw reaches the pool's catch. Guards
      // against a bucket left behind by an item the pool never reached (e.g. the
      // pool was itself interrupted).
      destroyRemainingParseCaches(parseCacheBuckets);
    }

    // Tally counters and collect infra dispositions for grouped emission (no
    // persistence here — the verdicts were already written inside the pool).
    for (let i = 0; i < group.length; i++) {
      const item = group[i];
      const outcome = outcomes[i];
      result.reviewerCallsMade += outcome.callsMade;
      if (outcome.kind === 'companion-runtime-error') {
        // Companion hook/resolution failure — counted separately, collected for
        // grouped emission after the tier loop. No infra counter increment —
        // these are NOT provider/config failures.
        result.companionRuntimeErrors += 1;
        result.companionRuntimeItems.push({ aspectId: item.pair.aspectId, unitKey: toPosixPath(item.pair.unitKey), messageData: outcome.messageData });
        // Emitted here (not inside the pool callback above) so this single site
        // covers BOTH a normal companion-runtime-error outcome AND the pool's own
        // synthetic infra conversion of a worker throw (fill-pool.ts) — every
        // no-write disposition for this tier group passes through this loop.
        writer.emitEvent(item.pair.aspectId, toPosixPath(item.pair.unitKey), 'llm', 'companion-runtime-error', { tier: item.tierName, judge: judgeIdentity(baseTier) });
      } else if (outcome.kind === 'infra') {
        result.infraFailures += 1;
        result.infraReport.push({ provider: baseTier.provider, tier: tierName });
        // Prefer the outcome's self-describing messageData when present; build a
        // fallback for a bare `why`. Collect for grouped emission after the tier loop.
        const messageData: IssueMessage = outcome.messageData ?? {
          what: `Reviewer could not verify aspect '${item.pair.aspectId}' on ${toPosixPath(item.pair.unitKey)} — left unverified.`,
          why: outcome.why,
          next: `Resolve the provider/config problem, then re-run: yg check --approve`,
        };
        result.poolInfraItems.push({ aspectId: item.pair.aspectId, unitKey: toPosixPath(item.pair.unitKey), messageData });
        writer.emitEvent(item.pair.aspectId, toPosixPath(item.pair.unitKey), 'llm', 'infra', { tier: item.tierName, judge: judgeIdentity(baseTier) });
      }
    }
  }

  return result;
}
