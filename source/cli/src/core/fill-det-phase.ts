/**
 * source/cli/src/core/fill-det-phase.ts — step 5 of the fill stage (spec §7):
 * run every unverified deterministic pair.
 *
 * Deterministic fills come FIRST because they are free. What they decide feeds
 * the gate the LLM phase then obeys: a unit with an enforced deterministic
 * refusal — one recorded in the lock already, or one produced right here — has
 * its paid review skipped this run.
 *
 * Two dispatch paths, one outcome handler. The phase is CPU-bound (tree-sitter
 * parsing), so it CAN spread across worker threads; whether it does is purely a
 * wall-clock decision that never enters a verdict. Both paths apply the same
 * live side effects and produce the same diagnostics in the same order.
 *
 * Fail-closed (§3.2): a check.mjs runtime error, a taint that survived its
 * re-run, or a malformed suppress marker writes NOTHING — the pair stays
 * unverified and the run ends red.
 */

import type { Graph, AspectDef } from '../model/graph.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import type { LockVerification } from './verify-lock.js';
import type { ProgressTracker } from './fill-progress.js';
import type { VerdictWriter } from './fill-writer.js';
import type { InfraDiagnosticItem } from './fill-report.js';
import { detGateKey, isNodeBlocked } from './fill-contract.js';
import { fillDetPair } from './fill-det.js';
import {
  buildParseCacheBuckets,
  destroyRemainingParseCaches,
  parseCacheBucketKey,
  releaseParseCacheBucket,
} from './parse-cache-buckets.js';
import { DetWorkerPool } from '../structure/det-worker-pool.js';
import { StructureRunnerError, runStructureAspect } from '../structure/runner.js';
import type { RunStructureAspectParams, RunStructureAspectResult } from '../structure/runner.js';
import { toPosixPath } from '../utils/posix.js';

// Minimum deterministic pairs a worker must handle before parallelizing is worth
// its one-time tree-sitter/WASM warmup. Below this many pairs per worker, a
// single in-process (warmed) parser beats spawning threads — spawning a pool for
// a 2-pair fill is strictly slower AND can blow a tight subprocess test budget.
// The pool engages only when floor(activePairs / this) >= 2.
const MIN_DET_PAIRS_PER_WORKER = 8;

export interface DetPhaseResult {
  /** Gate keys (detGateKey) carrying an enforced deterministic refusal — seeded
   *  from the lock's cached-valid refusals and extended by every fresh refusal
   *  this run. The LLM phase skips paid review for exactly these units. */
  detEnforcedRefusedNodes: Set<string>;
  /** Deterministic pairs whose check.mjs failed to run / tainted (no write). */
  runtimeErrors: number;
  /** Deterministic pairs left unverified by a malformed yg-suppress marker (no write). */
  malformedSuppressErrors: number;
  /** Component-free pairs whose check.mjs THIS run watched fail with a named
   *  StructureRunnerError — raw `(file, aspectId, code)`, for the post-fill
   *  report to translate. See RunFillResult.runtimeDispositions' own doc. */
  runtimeDispositions: Array<{ file: string; aspectId: string; code: string }>;
  /** Runtime-error notices, in pair order, for grouped emission by the caller. */
  runtimeItems: InfraDiagnosticItem[];
  /** Malformed-suppress notices, in pair order, for grouped emission by the caller. */
  malformedSuppressItems: InfraDiagnosticItem[];
}

export interface DetPhaseParams {
  graph: Graph;
  projectRoot: string;
  /** Every unverified deterministic pair; log-gate-blocked ones are skipped here. */
  detPairs: ExpectedPair[];
  aspectById: Map<string, AspectDef>;
  /** The pre-fill classification — its cached-valid enforced refusals seed the gate. */
  verification: LockVerification;
  /** Components the step-4 log gate blocked this run. */
  blockedNodes: Set<string>;
  /** Deterministic-phase thread budget: 1 → sequential in-process; >1 → a
   *  worker-thread pool bounded by this value. */
  detConcurrency: number;
  typeCoverage: TypeCoverageInput | undefined;
  /** The architecture-reach cache shared with the LLM phase — see runFill's own
   *  doc for why one map serves both. */
  reachCache: Map<string, Set<string>>;
  writer: VerdictWriter;
  tracker: ProgressTracker;
  write: (s: string) => void;
}

export async function runDeterministicPhase({
  graph, projectRoot, detPairs, aspectById, verification, blockedNodes,
  detConcurrency, typeCoverage, reachCache, writer, tracker, write,
}: DetPhaseParams): Promise<DetPhaseResult> {
  const result: DetPhaseResult = {
    detEnforcedRefusedNodes: new Set<string>(),
    runtimeErrors: 0,
    malformedSuppressErrors: 0,
    runtimeDispositions: [],
    runtimeItems: [],
    malformedSuppressItems: [],
  };

  // Seed from CACHED-valid enforced det refusals (verifyLock already classified
  // the lock; a valid refused det pair on an enforced status blocks LLM fills).
  for (const vp of verification.pairs) {
    if (vp.pair.kind !== 'deterministic') continue;
    if (vp.state.kind === 'refused' && vp.pair.status === 'enforced') {
      result.detEnforcedRefusedNodes.add(detGateKey(vp.pair));
    }
  }

  // Active deterministic pairs this run: NOT log-gate-blocked and with a known
  // aspect def — the exact set the sequential loop's inline skips produced.
  const activeDetPairs: Array<{ pair: ExpectedPair; aspect: AspectDef }> = [];
  for (const pair of detPairs) {
    if (isNodeBlocked(pair, blockedNodes)) continue;
    const aspect = aspectById.get(pair.aspectId);
    if (!aspect) continue;
    activeDetPairs.push({ pair, aspect });
  }

  // Per-pair outcome handling — identical for the sequential and parallel paths.
  // Applies the LIVE side effects (setEntry, counters, tracker) and RETURNS a
  // diagnostic to collect (or null). The caller owns collection order, so grouped
  // output stays deterministic regardless of completion order.
  type DetDiag = { kind: 'runtime' | 'suppress'; item: InfraDiagnosticItem } | null;
  const applyDetOutcome = async (
    pair: ExpectedPair,
    outcome: Awaited<ReturnType<typeof fillDetPair>>,
  ): Promise<DetDiag> => {
    if (outcome.kind === 'runtime-error') {
      result.runtimeErrors += 1;
      // No write — pair stays unverified, reported as aspect-check-runtime-error.
      writer.emitEvent(pair.aspectId, toPosixPath(pair.unitKey), 'deterministic', 'runtime-error');
      tracker.onPairComplete('det', pair.aspectId, toPosixPath(pair.unitKey), 'infra', write);
      // A component-free pair is the ONLY case core/type-visibility.ts's report
      // can ever attribute a disposition to (there is no type-covered "file" to
      // name for a component's own pair) — collect the raw code for the
      // post-fill runCheck call to translate, exactly like this run itself just
      // watched happen.
      if (pair.nodePath === undefined && outcome.code !== undefined) {
        result.runtimeDispositions.push({ file: toPosixPath(pair.subjectFiles[0]), aspectId: pair.aspectId, code: outcome.code });
      }
      return { kind: 'runtime', item: { aspectId: pair.aspectId, unitKey: toPosixPath(pair.unitKey), messageData: outcome.messageData } };
    }
    if (outcome.kind === 'malformed-suppress') {
      result.malformedSuppressErrors += 1;
      // No write — a fault in the source file's marker, not check.mjs; a DISTINCT
      // disposition never reported as aspect-check-runtime-error.
      writer.emitEvent(pair.aspectId, toPosixPath(pair.unitKey), 'deterministic', 'malformed-suppress');
      tracker.onPairComplete('det', pair.aspectId, toPosixPath(pair.unitKey), 'infra', write);
      return { kind: 'suppress', item: { aspectId: pair.aspectId, unitKey: toPosixPath(pair.unitKey), messageData: outcome.messageData } };
    }
    // Real verdict — write the entry (setEntry emits the verdict telemetry event).
    await writer.setEntry(pair, outcome.entry);
    tracker.onPairComplete('det', pair.aspectId, toPosixPath(pair.unitKey), outcome.entry.verdict, write);
    if (outcome.entry.verdict === 'refused' && pair.status === 'enforced') {
      result.detEnforcedRefusedNodes.add(detGateKey(pair));
    }
    return null;
  };
  const collectDetDiag = (diag: DetDiag): void => {
    if (!diag) return;
    if (diag.kind === 'runtime') result.runtimeItems.push(diag.item);
    else result.malformedSuppressItems.push(diag.item);
  };

  // The deterministic phase is CPU-bound (tree-sitter parsing), so it CAN run
  // across a persistent worker-thread pool — but each worker pays a one-time
  // tree-sitter/WASM warmup, so parallelism only wins once there is enough work
  // to amortize it. Size the pool so every worker gets at least
  // MIN_DET_PAIRS_PER_WORKER pairs: a small fill set (the common case — most
  // repos, and every fixture) stays in-process, where a single warmed parser is
  // strictly faster than spawning threads. Pool size never enters a verdict — it
  // changes only wall-clock.
  const detPoolSize = Math.min(
    detConcurrency,
    Math.floor(activeDetPairs.length / MIN_DET_PAIRS_PER_WORKER),
  );
  if (detPoolSize > 1) {
    const pool = new DetWorkerPool(graph, projectRoot, detPoolSize);
    // A pool-backed structure runner: execute the check on a worker and
    // RECONSTRUCT StructureRunnerError on this thread so fillDetPair's catch (its
    // malformed-suppress branch + taint re-run) behaves exactly as in-process.
    // `bucketKey` rides along so the worker can reuse one bucket's parsed trees
    // across consecutive tasks (structure/det-worker-core.ts); it never reaches
    // the check itself and never enters a verdict.
    const runViaPool = (bucketKey: string) => async (params: RunStructureAspectParams): Promise<RunStructureAspectResult> => {
      const reply = await pool.run({
        aspectDir: params.aspectDir,
        aspectId: params.aspectId,
        unit: params.unit,
        subjectScope: params.subjectScope,
        bucketKey,
      });
      if (reply.ok) return reply.result;
      if (reply.error.code !== undefined && reply.error.messageData !== undefined) {
        throw new StructureRunnerError(reply.error.code, reply.error.messageData);
      }
      throw new Error(reply.error.message);
    };
    try {
      // Live side effects apply as each pair completes; diagnostics land in
      // index-keyed slots flattened in pair order below, so grouped output stays
      // completion-order-independent.
      const diagSlots: DetDiag[] = new Array<DetDiag>(activeDetPairs.length);
      // Dispatch in BOUNDED waves rather than handing the whole pair list to
      // Promise.all. The pool already bounded how many tasks RUN at once, but a
      // single Promise.all over every pair still materialized every request
      // object, every pending promise, and every closure up front — on a large
      // repository that is tens of thousands of live objects in the parent
      // before the first verdict is written, and it grows with repo size rather
      // than with worker count. A wave of `detPoolSize` keeps exactly as many
      // tasks in flight as there are workers to run them, so the parent's
      // footprint is flat in the number of pairs.
      //
      // Waves are cut along the existing pair order — sorted by (aspectId,
      // unitKey), so one rule's subjects on one node land adjacent — which puts
      // same-bucket tasks in the same or neighbouring waves, where the workers'
      // cache affinity can act on them. Neither the wave boundaries nor the
      // affinity affect any verdict: they decide only how much re-parsing
      // happens, and a miss simply parses again.
      for (let start = 0; start < activeDetPairs.length; start += detPoolSize) {
        const wave = activeDetPairs.slice(start, start + detPoolSize);
        await Promise.all(
          wave.map(async ({ pair, aspect }, offset) => {
            tracker.onPairStart('det', pair.aspectId, toPosixPath(pair.unitKey), write);
            const outcome = await fillDetPair(
              graph, projectRoot, pair, aspect, runViaPool(parseCacheBucketKey(pair)), typeCoverage, reachCache,
            );
            diagSlots[start + offset] = await applyDetOutcome(pair, outcome);
          }),
        );
      }
      for (const diag of diagSlots) collectDetDiag(diag);
    } finally {
      await pool.destroy();
    }
  } else {
    // In-process (sequential) branch. THIS thread's parse-cache buckets: one per
    // (aspectId, node/unit), covering every subject of the same rule on the same
    // node, destroyed as soon as the LAST such pair settles.
    //
    // The pooled branch above cannot use these objects — each worker is a
    // separate isolate with its own WASM instance, so a cache built on this
    // thread cannot cross that boundary — but it is no longer without a cache of
    // its own: it sends the same bucket KEY along with each task and every
    // worker keeps one bucket's trees at a time (structure/det-worker-core.ts).
    // Same grouping, same one-bucket-at-a-time bound, built on the far side.
    const parseCacheBuckets = buildParseCacheBuckets(activeDetPairs.map(({ pair }) => pair));
    try {
      for (const { pair, aspect } of activeDetPairs) {
        tracker.onPairStart('det', pair.aspectId, toPosixPath(pair.unitKey), write);
        const bucket = parseCacheBuckets.get(parseCacheBucketKey(pair));
        try {
          const outcome = await fillDetPair(graph, projectRoot, pair, aspect, runStructureAspect, typeCoverage, reachCache, bucket?.cache);
          collectDetDiag(await applyDetOutcome(pair, outcome));
        } finally {
          releaseParseCacheBucket(parseCacheBuckets, pair);
        }
      }
    } finally {
      // Backstop only — guards against a pair whose bucket was somehow never
      // released (e.g. a throw before the inner try started).
      destroyRemainingParseCaches(parseCacheBuckets);
    }
  }

  return result;
}
