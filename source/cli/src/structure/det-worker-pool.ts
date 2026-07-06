/**
 * source/cli/src/structure/det-worker-pool.ts — a persistent pool of
 * worker_threads that run deterministic `check.mjs` verifications across CPU
 * cores. It exists because `check.mjs` is dominated by SYNCHRONOUS tree-sitter
 * parsing: an async pool in a single Node thread would only overlap I/O, so real
 * cores require real threads.
 *
 * PERSISTENT by design. Each worker warms up tree-sitter/WASM independently
 * (those caches are per-thread), so the pool spawns its workers ONCE, hands each
 * the run-constant graph + projectRoot via `workerData`, and reuses them across
 * every task — a worker-per-task pool would repay the WASM warmup on every check
 * and erase the gain.
 *
 * DETERMINISM. The pool changes only SPEED, never verdicts. Every task runs the
 * exact same `runStructureAspect` it would run in-process; the worker COUNT and
 * the ORDER tasks complete do not enter any verdict. The caller re-establishes a
 * deterministic emission order (see fill.ts) from the replies. The pool reads no
 * system state — its size is injected from the CLI layer (see check.ts), keeping
 * the engine deterministic per `no-nondeterminism-direct`.
 *
 * FAIL-CLOSED. A worker that crashes mid-task resolves that task as an `ok:false`
 * reply (never a silent drop); the caller lowers it to a runtime-error
 * disposition that writes nothing. The pool respawns a replacement so the
 * remaining queue keeps its parallelism.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

import { debugWrite } from '../utils/debug-log.js';
import type { Graph } from '../model/graph.js';
import type { DetTaskRequest, DetTaskReply } from './det-worker-core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Resolve the built worker entry. In production the bundle sits flat in dist/
 *  (dist/bin.js, dist/det-worker.js …), so `./det-worker.js` beside __dirname
 *  wins. In dev/tests the caller runs the src module, whose sibling has no built
 *  worker — fall back to the separately-built dist entry (repo-check builds
 *  before it tests). Mirrors ast/loader-hook.ts's impl-path resolution. */
function resolveWorkerPath(): string {
  const local = path.resolve(__dirname, './det-worker.js');
  /* v8 ignore next 4 — dev/test fallback: exercised only when running from src
     (no built worker beside the module); the built dist entry is used instead. */
  if (!existsSync(local)) {
    const pkgRoot = path.resolve(__dirname, '../../');
    return path.resolve(pkgRoot, 'dist/det-worker.js');
  }
  return local;
}

/** A deterministic task minus its correlation id (the pool assigns the id). */
export type DetPoolTask = Omit<DetTaskRequest, 'id'>;

interface PendingEntry {
  req: DetTaskRequest;
  resolve: (reply: DetTaskReply) => void;
}

/**
 * A fixed-size pool of persistent deterministic worker threads. `run` returns a
 * reply for exactly one task; `destroy` terminates every worker. Each worker
 * processes one task at a time — concurrency equals the worker count.
 */
export class DetWorkerPool {
  private readonly workerPath = resolveWorkerPath();
  private readonly workers = new Set<Worker>();
  private readonly idle: Worker[] = [];
  private readonly queue: PendingEntry[] = [];
  private readonly pending = new Map<Worker, PendingEntry>();
  private nextId = 1;
  private destroyed = false;

  constructor(
    private readonly graph: Graph,
    private readonly projectRoot: string,
    size: number,
  ) {
    const count = Math.max(1, Math.floor(size));
    for (let i = 0; i < count; i++) this.spawn();
  }

  /** Number of live workers — used by tests and callers to confirm capacity. */
  get workerCount(): number {
    return this.workers.size;
  }

  private spawn(): void {
    const worker = new Worker(this.workerPath, {
      workerData: { graph: this.graph, projectRoot: this.projectRoot },
    });
    worker.on('message', (reply: DetTaskReply) => this.onMessage(worker, reply));
    worker.on('error', (err: Error) => {
      // 'error' is always followed by 'exit'; log here, resolve/respawn in onExit
      // so a crashing worker's in-flight task is handled exactly once.
      debugWrite(`[det-pool] worker error: ${err.message}`);
    });
    worker.on('exit', (code: number) => this.onExit(worker, code));
    this.workers.add(worker);
    this.idle.push(worker);
    this.pump();
  }

  private onMessage(worker: Worker, reply: DetTaskReply): void {
    const entry = this.pending.get(worker);
    if (!entry) return; // stray message (e.g. after failure resolution) — ignore
    this.pending.delete(worker);
    entry.resolve(reply);
    if (!this.destroyed) {
      this.idle.push(worker);
      this.pump();
    }
  }

  private onExit(worker: Worker, code: number): void {
    this.workers.delete(worker);
    const idleIdx = this.idle.indexOf(worker);
    if (idleIdx !== -1) this.idle.splice(idleIdx, 1);
    const entry = this.pending.get(worker);
    if (entry) {
      this.pending.delete(worker);
      debugWrite(`[det-pool] worker exited (code ${code}) mid-task ${entry.req.aspectId} on ${entry.req.nodePath}`);
      // Fail closed: surface the crash as an error reply the caller lowers to a
      // no-write runtime-error disposition — never a silent drop.
      entry.resolve({
        id: entry.req.id,
        ok: false,
        error: { message: `deterministic worker exited unexpectedly (code ${code})` },
      });
    }
    // Keep capacity for any remaining/future work unless we are tearing down.
    if (!this.destroyed) {
      this.spawn();
    }
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.shift()!;
      const entry = this.queue.shift()!;
      this.pending.set(worker, entry);
      worker.postMessage(entry.req);
    }
  }

  /**
   * Run one deterministic task. Resolves with the worker's reply, or — if the
   * pool is already destroyed — an immediate error reply. Never rejects, so the
   * caller always has a value to lower.
   */
  run(task: DetPoolTask): Promise<DetTaskReply> {
    const id = this.nextId++;
    const req: DetTaskRequest = { id, ...task };
    if (this.destroyed) {
      return Promise.resolve({ id, ok: false, error: { message: 'deterministic worker pool already destroyed' } });
    }
    return new Promise<DetTaskReply>((resolve) => {
      this.queue.push({ req, resolve });
      this.pump();
    });
  }

  /** Terminate every worker. Idempotent. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const workers = [...this.workers];
    this.workers.clear();
    this.idle.length = 0;
    await Promise.all(workers.map((w) => w.terminate()));
  }
}
