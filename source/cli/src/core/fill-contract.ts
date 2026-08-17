/**
 * source/cli/src/core/fill-contract.ts — the fill stage's public contract
 * (spec §7): what a caller passes in (RunFillOptions), what it gets back
 * (RunFillResult), the sentinel thrown when nothing ran (FillGatingError), and
 * the pure per-pair gate predicates both fill phases decide with.
 *
 * It lives beside the orchestrator rather than inside it so the surface a
 * caller programs against can be read on its own, and so the stages the
 * orchestrator wires together (the dry-run preview, the deterministic and LLM
 * phases, the reporter) can name the same shapes without importing the
 * orchestrator back.
 */

import type { CheckResult, RunCheckOptions } from './check.js';
import type { ExpectedPair } from './pairs.js';
import type { IssueMessage } from '../model/validation.js';

export interface RunFillOptions {
  /** Coverage-visible files (the `walkRepoFiles` disk walk, gitignore-aware/
   *  git-independent) for the final coverage scan (mirrors plain check). Pass
   *  null to skip the unmapped-files check (no file walk ran this call). */
  coverageVisibleFiles: string[] | null;
  /** Real `git ls-files` output for the tracked∩gitignored anomaly check, threaded
   *  into both the dry-run cost-preview report and the final post-fill report
   *  runCheck — mirrors reviewNowUtc/rulesArtifacts below, so `yg check --approve`
   *  surfaces the same anomaly the plain `yg check` path does. Absent or null (git
   *  absent, or the CLI's git probe having failed) skips that one check only;
   *  every other coverage check is unaffected. */
  trackedFiles?: string[] | null;
  /** Sink for agent-facing fill PROGRESS (plain status lines). Defaults to
   *  process.stdout.write. */
  write?: (s: string) => void;
  /** Sink for structured DIAGNOSTICS ({ what, why, next }). The CLI command
   *  layer supplies the renderer — it owns formatting; this engine module only
   *  emits structured data and never formats it. Defaults to a no-op, so a
   *  caller that wants diagnostics surfaced must provide a sink. */
  emitIssue?: (msg: IssueMessage) => void;
  /** Fill ONLY deterministic pairs (skip LLM fills + positive closure) and write
   *  ONLY the gitignored deterministic file — the committed locks are never touched.
   *  Keyless and free; powers `yg check --approve --only-deterministic` and the CI pipeline. */
  onlyDeterministic?: boolean;
  /** Cost preview only: run the structural gate + pair classification + budget
   *  computation, emit a per-node/per-aspect breakdown, then return WITHOUT
   *  filling anything. No reviewer calls, no deterministic checks, no lock writes
   *  — the early-return precedes the serialized writer's construction, so the
   *  no-write guarantee is structural. Powers `yg check --approve --dry-run`. */
  dryRun?: boolean;
  /** When true, maintain the silent feature-field deviation index on the REAL post-fill
   *  report — the reporting path of `yg check --approve`. Threaded ONLY to the final report
   *  runCheck; the dry-run re-check (which returns before that report) and every other caller
   *  stay byproduct-free. Best-effort and gitignored, so it never affects the fill outcome or
   *  exit code. Default false. */
  writeFeatureIndex?: boolean;
  /** INJECTED clock for the feature-field index's `generatedAt` stamp — distinct from `now`
   *  below, which is the progress/heartbeat clock returning epoch ms. Passed through to the
   *  final report runCheck; defaults inside it to `() => new Date()` when the index is written. */
  featureIndexNow?: () => Date;
  /** INJECTED clock for the review-cadence check (spec RZ-18), threaded into both the dry-run
   *  cost-preview report and the final post-fill report runCheck — mirrors cli/check.ts's
   *  plain-check nowUtc so `yg check --approve` surfaces the same aspect-review-overdue warnings
   *  plain `yg check` does. Absent ⇒ the review-overdue check is skipped on this path too (core
   *  purity: no fabricated Date.now). Read-only — never writes the lock or gates the fill. */
  reviewNowUtc?: () => Date;
  /** INJECTED snapshot of the committed rules-distribution artifacts for the committed-digest
   *  staleness gate, threaded into both the dry-run cost-preview report and the final post-fill
   *  report runCheck — exactly as `reviewNowUtc` above is. Without it the identical repo printed
   *  one fewer warning under `--approve` than under plain `yg check`, because the fill's own
   *  report never received the snapshot. Absent ⇒ the gate is skipped on this path too (core
   *  purity: core reads no files). Read-only — never writes the lock or gates the fill.
   *  Typed off RunCheckOptions so the field cannot drift from the option it forwards. */
  rulesArtifacts?: RunCheckOptions['rulesArtifacts'];
  /** Whether the write sink is an interactive TTY. Defaults to process.stderr.isTTY ?? false.
   *  When true, the progress tracker rewrites a single line with \r instead of emitting
   *  milestone lines. */
  isTTY?: boolean;
  /** Terminal width for that single rewritten line. Without it the line wraps and
   *  each redraw leaves its wrapped rows on screen, so an in-place status turns
   *  into a scrolling log. Injected by the CLI (process.stderr.columns); absent ⇒
   *  a conservative 80. Ignored when isTTY is false. */
  columns?: number;
  /** Clock function for progress/heartbeat (injectable for tests). Defaults to Date.now. */
  now?: () => number;
  /** Milestone threshold for non-TTY progress (emit every N pairs). Default: 25% of total, min 1. */
  milestoneInterval?: number;
  /** Still-working interval in ms for non-TTY (emit if no completion for this long). Default: 30000. */
  stillWorkingIntervalMs?: number;
  /** Max deterministic checks to run concurrently across worker threads. The
   *  deterministic phase is CPU-bound (tree-sitter parsing), so it parallelizes
   *  over real threads (NOT the `parallel` config, which governs only the LLM
   *  fill phase). Injected from the CLI layer (os.availableParallelism) so the
   *  engine reads no system state; defaults to 1 (in-process, sequential) — the
   *  degenerate case that keeps every existing verdict path byte-identical.
   *  Never affects verdicts, only speed. */
  detConcurrency?: number;
  /** INJECTED change scope: which of this run's obligations the current change is
   *  accountable for, resolved by the CLI boundary from git output it read itself
   *  (core reads no git here, exactly as on the read path). Typed off
   *  RunCheckOptions so the two can never describe different shapes.
   *
   *  It narrows exactly one thing: the PAID fill set. Deterministic fills cost
   *  nothing and their recorded observations are what a later scope computation
   *  reads, so the free half stays whole-project; the mandatory-log gate stays
   *  all-or-nothing over every component owning an unverified pair. It is also
   *  forwarded to this stage's own report, so a recording run gates on exactly
   *  what a plain read of the same working tree gates on.
   *
   *  Absent ⇒ the run answers for the whole project, which is what `--full` and
   *  a project that never named a reference both mean. */
  changeScope?: RunCheckOptions['changeScope'];
  /** Best-effort, io-side sink for the convergence sentinel's evidence dump
   *  (core/fill-divergence.ts). Injected from the CLI boundary so this engine
   *  module takes no core → io dependency; when absent the sentinel still emits
   *  its notice but records no file. The writer must never throw — a sentinel
   *  failure must never fail a fill. */
  divergenceWrite?: (text: string) => void;
}

export interface RunFillResult {
  /** The final check report after fills (exit semantics: any error ⇒ nonzero).
   *  Printed by the `yg check --approve` combiner. */
  checkResult: CheckResult;
  /** Number of reviewer calls actually dispatched (consensus-inclusive). */
  reviewerCallsMade: number;
  /** Pairs that hit an infra disposition (no write). */
  infraFailures: number;
  /** Deterministic pairs whose check.mjs failed to run / tainted (no write). */
  runtimeErrors: number;
  /** LLM pairs whose companion.mjs failed to resolve/run (no write). */
  companionRuntimeErrors: number;
  /** Deterministic pairs left unverified by a malformed yg-suppress marker (no write). */
  malformedSuppressErrors: number;
  /**
   * Component-free (nodeless) deterministic pairs whose check.mjs THIS run
   * watched fail with a StructureRunnerError — `(file, aspectId, code)`, raw
   * and untranslated: the fill stage names no `TypeVisibilityReason`
   * itself (that vocabulary, and the translator over it, belong to
   * core/type-visibility.ts, which the stage does not import — see
   * `checkResult.typeVisibility` below for the translated result). A
   * component-owned pair's own disposition is never collected here — there is
   * no type-covered "file" in core/type-visibility.ts's sense to attribute it
   * to. Exposed for callers that want the raw facts; `checkResult` already
   * carries the translated, rendered form.
   */
  runtimeDispositions: Array<{ file: string; aspectId: string; code: string }>;
}

/** Abort sentinel — the structural gate failed; no fills ran. */
export class FillGatingError extends Error {
  constructor(public readonly issues: Array<{ code: string; what: string; why: string; next: string }>) {
    super('fill aborted before running anything — see the listed problems');
    this.name = 'FillGatingError';
  }
}

/**
 * The deterministic gate's key for a pair: the owning component's path when
 * the pair has one, or the pair's own unit key when it does not — always
 * `file:<path>` for a pair with no component, so it can never collide with a
 * real component path. Used to key `detEnforcedRefusedNodes` /
 * `llmSkippedByDetGate` so a refusal on one unit skips paid review for that
 * unit alone.
 *
 * Keying on `pair.nodePath` alone would make `undefined` a single shared
 * bucket across every unit with no component: ONE refusing file would
 * silently suppress paid review for every OTHER such file in the repo. A pure
 * function of the pair — exported so its per-pair behavior is pinned directly,
 * independent of a full fill run.
 */
export const detGateKey = (pair: ExpectedPair): string => pair.nodePath ?? pair.unitKey;

/**
 * Whether a pair's component was blocked by the mandatory-log gate (§9).
 * Explicit, not implicit via `Set.has(undefined)`: a nodeless pair has no log
 * obligation, so it can never be blocked by it.
 */
export const isNodeBlocked = (pair: ExpectedPair, blockedNodes: Set<string>): boolean =>
  pair.nodePath !== undefined && blockedNodes.has(pair.nodePath);
