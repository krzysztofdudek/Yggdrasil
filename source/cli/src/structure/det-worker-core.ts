/**
 * source/cli/src/structure/det-worker-core.ts — the pure, thread-agnostic body of
 * a deterministic worker task. It runs ONE `runStructureAspect` invocation and
 * lowers its result (or thrown error) to a plain-data reply that survives a
 * worker_threads `postMessage` (structured clone).
 *
 * The point of the lowering is the error boundary: `runStructureAspect`
 * throws `StructureRunnerError` (a class instance) on a malformed suppress marker
 * or any other structural failure. `postMessage` strips the prototype, so an
 * `instanceof` check on the far side would break. We transport `{ code,
 * messageData }` as plain data instead; the parent reconstructs the class (see
 * det-worker-pool's pooled runner) so `fill-det`'s `instanceof` branch and its
 * taint re-run stay byte-for-byte unchanged.
 *
 * This module runs identically in-process (unit-tested directly) and inside a
 * worker thread (via det-worker.ts). It reads NO system state and holds NO
 * mutable module state — the verdict it produces depends only on (req, graph,
 * projectRoot), never on how many workers exist or the order tasks arrive.
 */

import { runStructureAspect, StructureRunnerError } from './runner.js';
import type { RunStructureAspectResult, StructureUnit } from './runner.js';
import type { Graph } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import type { ParseCache } from '../ast/parse-cache.js';
import { destroyParseCache } from '../ast/parse-cache.js';

/** One unit of deterministic work dispatched to a worker. `id` correlates the
 *  reply back to the awaiting caller; the rest mirror the non-graph inputs of
 *  `RunStructureAspectParams` (the graph + projectRoot are worker-constant).
 *  `unit` carries `allowedReads` as a plain `string[]` (not a `Set`) so a
 *  `unit.kind === 'file'` request survives the worker's structured clone. */
export interface DetTaskRequest {
  id: number;
  aspectDir: string;
  aspectId: string;
  unit: StructureUnit;
  subjectScope?: string[];
  /**
   * The (aspect, node/unit) parse-cache bucket this request belongs to — the SAME
   * key `core/parse-cache-buckets.ts` groups the in-process path by. A worker keeps
   * the parsed trees for ONE bucket at a time and reuses them across every
   * consecutive task carrying the same key, which is what makes a `per: file`
   * rule stop re-parsing its node's whole unit once per subject.
   *
   * Purely a wall-clock hint: a run that never sets it, or a dispatcher whose
   * affinity misses, produces byte-identical verdicts and simply parses more.
   */
  bucketKey?: string;
}

/** Plain-data reply — every field survives structured clone. A structural throw
 *  carries its `code` (so the parent can rebuild `StructureRunnerError` and keep
 *  the malformed-suppress branch working) and `messageData`; a non-structural
 *  throw carries only `message`. */
export type DetTaskReply =
  | { id: number; ok: true; result: RunStructureAspectResult }
  | { id: number; ok: false; error: { code?: string; messageData?: IssueMessage; message: string } };

/**
 * One worker thread's parse-cache slot: the trees for the bucket it is
 * currently serving, and that bucket's key.
 *
 * Exactly ONE bucket is held at a time. A task for a different bucket destroys
 * the previous cache before starting a new one, so a worker's tree footprint is
 * bounded by its single largest unit no matter how many buckets pass through it
 * — the same bound `core/parse-cache-buckets.ts` gives the in-process path, and the
 * reason this can be added to a thread pool without multiplying peak memory by
 * the worker count.
 *
 * Held per worker (module state inside a worker isolate, one isolate per
 * thread), never shared: a `ParseCache` holds native WASM Trees belonging to
 * that thread's own tree-sitter instance and could not cross a thread boundary
 * even if we wanted it to.
 */
export interface DetWorkerCacheSlot {
  bucketKey: string | undefined;
  cache: ParseCache | undefined;
}

/** A fresh, empty slot. One per worker thread. */
export function createDetWorkerCacheSlot(): DetWorkerCacheSlot {
  return { bucketKey: undefined, cache: undefined };
}

/** Release whatever the slot holds — called when a worker shuts down. */
export function releaseDetWorkerCacheSlot(slot: DetWorkerCacheSlot): void {
  if (slot.cache !== undefined) destroyParseCache(slot.cache);
  slot.cache = undefined;
  slot.bucketKey = undefined;
}

/**
 * Resolve the parse cache a request should use, rotating the slot when the
 * request belongs to a different bucket than the one currently held. A task with no
 * `bucketKey` gets no shared cache at all (the runner then builds and destroys
 * its own, exactly as before this existed).
 */
function cacheForTask(slot: DetWorkerCacheSlot, bucketKey: string | undefined): ParseCache | undefined {
  if (bucketKey === undefined) return undefined;
  if (slot.bucketKey === bucketKey && slot.cache !== undefined) return slot.cache;
  releaseDetWorkerCacheSlot(slot);
  slot.bucketKey = bucketKey;
  slot.cache = new Map();
  return slot.cache;
}

/**
 * Run one deterministic task to completion and lower it to a `DetTaskReply`.
 * Never throws — a thrown `StructureRunnerError` or any other error becomes an
 * `ok: false` reply, so the transport layer always has a value to post back.
 *
 * `slot`, when given, lets consecutive tasks from the same bucket share parsed
 * trees. It changes only how much parsing happens: `runStructureAspect` receives
 * the same inputs and returns the same result either way, and the cache is
 * content-gated (`prewarmupAstCache` compares content, never mere presence), so
 * a file edited between two tasks is still re-parsed with its current bytes.
 */
export async function runDetTask(
  req: DetTaskRequest,
  graph: Graph,
  projectRoot: string,
  slot?: DetWorkerCacheSlot,
): Promise<DetTaskReply> {
  try {
    const result = await runStructureAspect({
      aspectDir: req.aspectDir,
      aspectId: req.aspectId,
      unit: req.unit,
      graph,
      projectRoot,
      subjectScope: req.subjectScope,
      parseCache: slot !== undefined ? cacheForTask(slot, req.bucketKey) : undefined,
    });
    return { id: req.id, ok: true, result };
  } catch (e) {
    if (e instanceof StructureRunnerError) {
      return { id: req.id, ok: false, error: { code: e.code, messageData: e.messageData, message: e.message } };
    }
    // Defensive fallback: runStructureAspect wraps every failure it can produce as
    // a StructureRunnerError, so no real input reaches here — this only catches an
    // unexpected internal throw, kept so such a throw still fails closed with a
    // usable message rather than crashing the worker.
    /* v8 ignore next 1 */
    return { id: req.id, ok: false, error: { message: e instanceof Error ? e.message : String(e) } };
  }
}
