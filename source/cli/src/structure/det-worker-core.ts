/**
 * source/cli/src/structure/det-worker-core.ts — the pure, thread-agnostic body of
 * a deterministic worker task. It runs ONE `runStructureAspect` invocation and
 * lowers its result (or thrown error) to a plain-data reply that survives a
 * worker_threads `postMessage` (structured clone).
 *
 * The whole point of the lowering is the error boundary: `runStructureAspect`
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
import type { RunStructureAspectResult } from './runner.js';
import type { Graph } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';

/** One unit of deterministic work dispatched to a worker. `id` correlates the
 *  reply back to the awaiting caller; the rest mirror the non-graph inputs of
 *  `RunStructureAspectParams` (the graph + projectRoot are worker-constant). */
export interface DetTaskRequest {
  id: number;
  aspectDir: string;
  aspectId: string;
  nodePath: string;
  subjectScope?: string[];
}

/** Plain-data reply — every field survives structured clone. A structural throw
 *  carries its `code` (so the parent can rebuild `StructureRunnerError` and keep
 *  the malformed-suppress branch working) and `messageData`; a non-structural
 *  throw carries only `message`. */
export type DetTaskReply =
  | { id: number; ok: true; result: RunStructureAspectResult }
  | { id: number; ok: false; error: { code?: string; messageData?: IssueMessage; message: string } };

/**
 * Run one deterministic task to completion and lower it to a `DetTaskReply`.
 * Never throws — a thrown `StructureRunnerError` or any other error becomes an
 * `ok: false` reply, so the transport layer always has a value to post back.
 */
export async function runDetTask(
  req: DetTaskRequest,
  graph: Graph,
  projectRoot: string,
): Promise<DetTaskReply> {
  try {
    const result = await runStructureAspect({
      aspectDir: req.aspectDir,
      aspectId: req.aspectId,
      nodePath: req.nodePath,
      graph,
      projectRoot,
      subjectScope: req.subjectScope,
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
