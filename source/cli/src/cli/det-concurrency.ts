/**
 * source/cli/src/cli/det-concurrency.ts — how many worker threads the
 * deterministic fill may spawn on THIS machine.
 *
 * The engine deliberately cannot answer this. `structure/det-worker-pool.ts`
 * reads no system state so its verdicts stay independent of the hardware they
 * run on; the pool's size is injected from the command layer instead, and this
 * is where that number is worked out.
 *
 * ── Why core count alone is the wrong answer ────────────────────────────────
 * Every worker is a full Node isolate that receives its own structured-clone
 * copy of the graph (rule bodies and all) and then builds its own tree-sitter
 * ASTs for whatever unit it is checking. That footprint is per worker and does
 * not shrink as the pool grows, so sizing purely on cores means a big machine
 * with a big repository multiplies a large number by a large number. Past a
 * point the run does not get faster, it gets killed: a repository whose fill is
 * comfortably free on paper cannot rebuild its deterministic verdicts at all,
 * and it fails at the exact moment it matters — the keyless gate that CI and
 * the pre-commit hook run.
 *
 * ── What this measures instead ──────────────────────────────────────────────
 * A worker's cost is estimated from THIS process, which has already done the
 * same work a worker will do (loaded the runtime, the bundle, and the graph).
 * Its resident size is a real measurement of one copy of that, not a guess, and
 * it scales with the repository the way a worker's own footprint does — a bigger
 * graph raises the estimate on its own, with nothing to tune. A headroom
 * multiplier covers what a worker adds on top: the ASTs for one unit.
 *
 * The budget it is spent against is a fraction of the machine's total memory,
 * not its free memory — free memory swings with whatever else is running and
 * would make the same repository size its pool differently between two runs a
 * moment apart. Total memory is a stable property of the machine.
 *
 * Sizing never enters a verdict: it changes how many threads run, never what any
 * of them decides.
 */

import { availableParallelism, totalmem } from 'node:os';

/**
 * Share of total system memory the deterministic fill may plan to occupy. The
 * rest is left for the operating system, the parent process, and whatever else
 * the machine is doing — including, on a developer's box, the editor and browser
 * this is running underneath.
 */
const MEMORY_BUDGET_FRACTION = 0.5;

/**
 * How much more than the parent's current resident size one worker is assumed to
 * need. The parent has paid for the runtime, the bundle, and the graph; a worker
 * pays all of that again and then holds one unit's parsed trees on top, which is
 * the part this multiplier stands in for.
 */
const WORKER_FOOTPRINT_HEADROOM = 1.5;

/**
 * Floor for the per-worker estimate, in bytes. Guards the degenerate case where
 * the parent's resident size reads implausibly small (a platform that reports
 * RSS oddly, or a measurement taken before the graph is loaded) and would
 * otherwise license an unbounded pool.
 */
const MIN_WORKER_FOOTPRINT_BYTES = 128 * 1024 * 1024;

/** Injected system facts, so this is testable without a machine to match. */
export interface DetConcurrencyInputs {
  /** Logical cores available to this process. */
  cores: number;
  /** Total physical memory on the machine, in bytes. */
  totalMemoryBytes: number;
  /** Resident size of THIS process right now, in bytes. */
  processRssBytes: number;
}

/**
 * Resolve the deterministic worker-thread ceiling from measured inputs.
 *
 * Returns at least 1 — one worker is always allowed, since below two the fill
 * runs in-process anyway (see `MIN_DET_PAIRS_PER_WORKER` in
 * core/fill-det-phase.ts, which independently keeps a small fill single-threaded
 * regardless of what this permits).
 */
export function resolveDetConcurrency(inputs: DetConcurrencyInputs): number {
  const byCores = Math.max(1, inputs.cores - 1);
  const perWorker = Math.max(
    MIN_WORKER_FOOTPRINT_BYTES,
    Math.ceil(inputs.processRssBytes * WORKER_FOOTPRINT_HEADROOM),
  );
  const budget = inputs.totalMemoryBytes * MEMORY_BUDGET_FRACTION;
  const byMemory = Math.floor(budget / perWorker);
  return Math.max(1, Math.min(byCores, byMemory));
}

/**
 * Measure this machine and this process, then resolve the ceiling. Call at the
 * point the fill is about to start, so the resident size reflects a loaded graph
 * rather than a bare startup.
 */
export function detConcurrencyForThisMachine(): number {
  return resolveDetConcurrency({
    cores: availableParallelism(),
    totalMemoryBytes: totalmem(),
    processRssBytes: process.memoryUsage().rss,
  });
}
