/**
 * source/cli/src/structure/det-worker.ts — the worker_threads ENTRY for
 * deterministic checks. It is a thin transport shell: it holds the run-constant
 * graph + projectRoot (delivered once via `workerData`, structured-cloned at
 * spawn) and, for each task message, delegates to the pure `runDetTask` and posts
 * the plain-data reply back. All real work — loading `check.mjs`, building `ctx`,
 * parsing with tree-sitter — happens inside `runDetTask`/`runStructureAspect` on
 * THIS thread, so nothing non-serializable ever crosses the boundary.
 *
 * This file has a tsup entry (`det-worker`) so it is emitted as a standalone
 * `dist/det-worker.js` bundle the pool can spawn by path. It is intentionally
 * excluded from coverage (see vitest.config.ts): it only ever executes inside a
 * spawned thread running the built bundle — never the src module in-process — so
 * v8 cannot attribute its lines. Its logic lives in det-worker-core.ts, which IS
 * unit-tested in-process. Keep this shell trivial.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { runDetTask, type DetTaskRequest } from './det-worker-core.js';
import type { Graph } from '../model/graph.js';

interface DetWorkerData {
  graph: Graph;
  projectRoot: string;
}

/* v8 ignore start — runs only inside a spawned worker thread (built bundle),
   never in-process; exercised via the pool's integration tests. */
if (parentPort) {
  const { graph, projectRoot } = workerData as DetWorkerData;
  const port = parentPort;
  port.on('message', (req: DetTaskRequest) => {
    void runDetTask(req, graph, projectRoot).then((reply) => {
      port.postMessage(reply);
    });
  });
}
/* v8 ignore stop */
