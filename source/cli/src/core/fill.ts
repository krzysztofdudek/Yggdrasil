// yg-suppress-disable(deterministic) the fill stage exists to invoke the configured LLM reviewer; non-determinism is inherent to its purpose, and every verdict it records is content-addressed so reproducibility is enforced at the lock layer instead
/**
 * source/cli/src/core/fill.ts — the `yg check --approve` fill stage (spec §7).
 *
 * Plain `yg check` is a pure read; `--approve` fills every UNVERIFIED pair, then
 * re-runs the read and reports. Fill is the ONLY place a deterministic check.mjs
 * or an LLM reviewer executes.
 *
 * Order (spec §7):
 *   1. Structural gate — validate(graph); a gating code (tier/reviewer config
 *      broken) aborts the whole fill (no fills, no LLM calls).
 *   2. Classify pairs through the SAME engine plain check uses (verifyLock) —
 *      one implementation, so a verdict fill writes here verifies there.
 *      prompt-too-large pairs are SKIPPED (gate precedence, §4).
 *   3. Pre-dispatch header: counts.
 *   4. Log gate (§9), ALL-OR-NOTHING: if ANY log_required node's source
 *      fingerprint drifted with no fresh entry, the run fills NOTHING (throws
 *      FillGatingError before any deterministic or LLM fill) and stays red.
 *   5. Deterministic fills FIRST (free) → deterministic gate (a node with an
 *      enforced det refusal skips its LLM fills this run).
 *   6. LLM fills (grouped by tier; one provider per tier; run-scoped caches).
 *   7. Positive closure (§7.5): a node with all enforced pairs approved records
 *      its source fingerprint + log baseline.
 *   8. GC + canonical rewrite (§3.2).
 *   9. Re-run the read (runCheck) and return its result.
 *
 * Fail-closed (§3.2): an entry is written only on a REAL verdict. Every infra
 * disposition (provider unreachable, no reviewer, tier-resolution failure,
 * reference-load failure, unparseable response, check.mjs runtime error /
 * taint) writes NOTHING — the prior baseline stays intact, the pair stays
 * unverified, and the run ends red.
 *
 * Interruption-safety: the lock is mutated in memory and re-serialized through a
 * single serialized promise chain after EACH completed pair, so a killed run
 * keeps every finished pair and the next run resumes.
 *
 * This module is the orchestrator + public surface. The cohesive stages live in
 * sibling files and are wired in here:
 *   - fill-shared.ts   — shared outcome types + readBytesOrEmpty
 *   - fill-log-gate.ts — the per-node mandatory-log gate (§9)
 *   - fill-det.ts      — the deterministic-pair filler (step 5)
 *   - fill-llm.ts      — the LLM-pair filler (step 6)
 *   - fill-pool.ts     — the bounded worker pool (step 6)
 *   - fill-closure.ts  — positive closure (step 7 / §7.5)
 *   - fill-gc.ts       — GC + canonical rewrite (step 8 / §3.2)
 */

import path from 'node:path';

import type { Graph, AspectDef, LlmConfig } from '../model/graph.js';
import type { VerdictEntry } from '../model/lock.js';
import type { CheckResult, RunCheckOptions } from './check.js';
import { runCheck, scanUncoveredFiles } from './check.js';
import { readLock, writeLock, readDetLockAspectIds } from '../io/lock-store.js';
import type { ExpectedPair, TypeCoverageInput } from './pairs.js';
import { verifyLock } from './verify-lock.js';
import { computeTypeCoverageCached } from './type-coverage.js';
import type { TypeCoverageResult } from './type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { DEFAULT_COVERAGE } from '../io/config-parser.js';
import { selectTierForAspect } from './tier-selection.js';
import { createLlmProvider } from '../llm/index.js';
import { validate } from './validator.js';
import { APPROVE_GATING_CODES } from './check-codes.js';
import type { IssueMessage } from '../model/validation.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import { fillDetPair } from './fill-det.js';
import { fillLlmPair } from './fill-llm.js';
import { runPairPool } from './fill-pool.js';
import { DetWorkerPool } from '../structure/det-worker-pool.js';
import { StructureRunnerError, runStructureAspect } from '../structure/runner.js';
import type { RunStructureAspectParams, RunStructureAspectResult } from '../structure/runner.js';
import { logGateBlocks } from './fill-log-gate.js';
import { applyPositiveClosure } from './fill-closure.js';
import { garbageCollectAndRewrite } from './fill-gc.js';
import type { PruneSummary } from './fill-gc.js';
import { reportDivergenceIfDetected } from './fill-divergence.js';
import { ProgressTracker } from './fill-progress.js';
import { appendVerdictEvent, type VerdictEvent } from '../io/events-store.js';
import { PROMPT_FORMAT_REV } from '../llm/prompt.js';

// Minimum deterministic pairs a worker must handle before parallelizing is worth
// its one-time tree-sitter/WASM warmup. Below this many pairs per worker, a
// single in-process (warmed) parser beats spawning threads — spawning a pool for
// a 2-pair fill is strictly slower AND can blow a tight subprocess test budget.
// The pool engages only when floor(activePairs / this) >= 2.
const MIN_DET_PAIRS_PER_WORKER = 8;

// ============================================================
// Internal helpers
// ============================================================

/**
 * The resolved LLM judge's identity (provider + model) for a tier config, as
 * recorded on an LLM verdict-events line (io/events-store.ts, `judge`).
 * Telemetry ONLY — NEVER a hash ingredient (pair-hash.ts is deliberately
 * untouched). `model` is stringified defensively: a tier's model is already a
 * string, but the sidecar contract pins the field's type. Only ever passed on
 * LLM event sites where the tier actually resolved; deterministic lines and
 * unresolved-tier LLM lines carry no judge (regime unknown).
 */
function judgeIdentity(tier: LlmConfig): { provider: string; model: string } {
  return { provider: tier.provider, model: String(tier.model) };
}

/**
 * Print the garbage collector's own prune summary — this exact wording is a
 * contract another CLI-driven end-to-end test asserts against, so a later
 * change here is a coordinated edit across both, never a local cosmetic one.
 * Printed by BOTH `--approve` (after the real prune) and `--dry-run` (a preview,
 * computed over a disposable clone of the lock — see the dry-run call site).
 * Prints NOTHING when nothing was pruned. An entry whose reviewer kind could
 * not be determined (see PruneSummary's own doc) adds a third ", U unknown"
 * clause rather than silently folding into billed or free; omitted entirely
 * when there are none, so the common case's wording is unchanged.
 */
function writePruneSummary(summary: PruneSummary, write: (s: string) => void): void {
  if (summary.entries.length === 0) return;
  const unknownClause = summary.unknownCount > 0 ? `, ${summary.unknownCount} unknown` : '';
  write(
    `Pruned ${summary.entries.length} stale verdict(s) — ${summary.billedCount} billed, ${summary.freeCount} free${unknownClause}:\n`,
  );
  for (const e of summary.entries) {
    write(`  [${e.kind}] ${e.aspectId} on ${toPosixPath(e.unitKey)} — ${e.reason}\n`);
  }
}

/**
 * Emit infrastructure diagnostics grouped by aspectId — one message per aspect
 * instead of one per pair.  When only one unit is affected the original per-pair
 * messageData is emitted unchanged (preserving the existing message text and
 * any actionable detail). When multiple units share the same aspect the grouped
 * form lists up to `cap` unit keys and appends " … and N more" for the rest.
 *
 * `kind` controls the summary tokens injected into the grouped `what:`:
 *   'det'                → aspect-check-runtime-error token
 *   'companion'          → aspect-companion-runtime-error token
 *   'malformed-suppress' → malformed-suppress-marker token (NOT a check fault)
 *   'pool-infra'         → generic unverified summary
 */
function emitGroupedDiagnostics(
  items: Array<{ aspectId: string; unitKey: string; messageData: IssueMessage }>,
  kind: 'det' | 'companion' | 'malformed-suppress' | 'pool-infra',
  emitIssue: (msg: IssueMessage) => void,
): void {
  if (items.length === 0) return;

  // Group by composite key (aspectId + why + next) so pairs with identical
  // why+next collapse into ONE message, while pairs with distinct reasons under
  // the same aspect form SEPARATE messages — each carries its own correct why/next
  // and its own unit list (lossless grouping).
  const byAspect = new Map<string, { aspectId: string; unitKeys: string[]; first: IssueMessage }>();
  for (const item of items) {
    const posix = toPosixPath(item.unitKey);
    const md = item.messageData;
    const groupKey = `${item.aspectId} ${md.why} ${md.next}`;
    const existing = byAspect.get(groupKey);
    if (existing) {
      existing.unitKeys.push(posix);
    } else {
      byAspect.set(groupKey, { aspectId: item.aspectId, unitKeys: [posix], first: md });
    }
  }

  const cap = 5;
  for (const { aspectId, unitKeys, first } of byAspect.values()) {
    if (unitKeys.length === 1) {
      // Single unit — emit the original message unchanged (preserves exact text
      // and any actionable detail, keeps existing test assertions green).
      emitIssue(first);
    } else {
      // Multiple units with the same aspect + identical why/next — emit one grouped message.
      const listed = unitKeys.slice(0, cap).join(', ');
      const overflow = unitKeys.length > cap ? ` … and ${unitKeys.length - cap} more` : '';
      let what: string;
      if (kind === 'det') {
        what = `Deterministic check '${aspectId}' failed to run on ${unitKeys.length} units — left unverified (aspect-check-runtime-error): ${listed}${overflow}`;
      } else if (kind === 'companion') {
        what = `Companion resolution for '${aspectId}' failed to run on ${unitKeys.length} units — left unverified (aspect-companion-runtime-error): ${listed}${overflow}`;
      } else if (kind === 'malformed-suppress') {
        what = `A malformed yg-suppress marker left aspect '${aspectId}' unverified on ${unitKeys.length} units (malformed-suppress-marker): ${listed}${overflow}`;
      } else {
        what = `Reviewer could not verify aspect '${aspectId}' on ${unitKeys.length} units — left unverified: ${listed}${overflow}`;
      }
      emitIssue({ what, why: first.why, next: first.next });
    }
  }
}

// ============================================================
// Public surface
// ============================================================

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
}

/** Abort sentinel — the structural gate failed; no fills ran. */
export class FillGatingError extends Error {
  constructor(public readonly issues: Array<{ code: string; what: string; why: string; next: string }>) {
    super('fill aborted — structural gating errors block tier resolution');
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

// ============================================================
// runFill
// ============================================================

export async function runFill(graph: Graph, opts: RunFillOptions): Promise<RunFillResult> {
  const write = opts.write ?? ((s: string) => { process.stdout.write(s); });
  const emitIssue = opts.emitIssue ?? ((): void => {});
  const projectRoot = path.dirname(graph.rootPath);
  const onlyDeterministic = opts.onlyDeterministic ?? false;
  const dryRun = opts.dryRun ?? false;
  const isTTY = opts.isTTY ?? (process.stderr.isTTY ?? false);
  const now = opts.now ?? Date.now.bind(Date);
  // Deterministic-phase thread budget (injected; engine reads no system state).
  // 1 → sequential in-process; >1 → a worker-thread pool bounded by this value.
  const detConcurrency = Math.max(1, Math.floor(opts.detConcurrency ?? 1));
  // Committed-events opt-in (RZ-14). Read from the resolved config once and passed
  // to the appender per event: when ON, LLM verification-fill events graduate to
  // the committed shared stream; every other event stays in the local sidecar.
  // Never folds into any verdict hash.
  const committedLlm = graph.config.events?.committed_llm === true;

  // ── Verdict-events telemetry sidecar (write-only; nothing in the engine ever
  // reads it back). One line per (aspect, unit) disposition — a real verdict
  // (approved/refused) or a no-write infra/runtime outcome — appended to a local,
  // gitignored file under .yggdrasil/. `now` is the SAME injected clock the rest
  // of the fill uses (never Date.now() directly — engine files must not touch
  // runtime state directly, see no-nondeterminism-direct); the `Date` constructor
  // called WITH an argument is deterministic (it only formats a value someone
  // else produced), so this does not trip that rule. Closes over graph.rootPath
  // (the sidecar's location), now (the clock), and onlyDeterministic (this run's
  // scope — under --only-deterministic, llmPairs is empty so no LLM disposition
  // is ever emitted here, but the flag is part of the fill's identity this
  // closure is built for).
  const emitEvent = (
    aspectId: string,
    unitKey: string,
    kind: 'llm' | 'deterministic',
    disposition: VerdictEvent['disposition'],
    extra?: {
      hash?: string;
      reason?: string;
      tier?: string;
      votes?: { satisfied: number; total: number };
      judge?: { provider: string; model: string };
    },
  ): void => {
    const event: VerdictEvent = {
      v: 1,
      ts: new Date(now()).toISOString(),
      source: 'fill',
      aspectId,
      unitKey: toPosixPath(unitKey),
      kind,
      disposition,
    };
    if (extra?.hash !== undefined) event.hash = extra.hash;
    if (extra?.reason !== undefined) event.reason = extra.reason;
    if (extra?.tier !== undefined) {
      event.tier = extra.tier;
      event.promptRev = PROMPT_FORMAT_REV;
    }
    if (extra?.votes !== undefined) event.votes = extra.votes;
    // LLM only — the resolved judge identity, recorded wherever a tier resolved
    // (verdict site + LLM infra sites). Absent on deterministic lines and on the
    // no-reviewer / tier-unresolvable site (no judge ever resolved there).
    if (extra?.judge !== undefined) event.judge = extra.judge;
    // Single-home switch (RZ-14): the resolved committed-events opt-in is passed
    // via the injected-config pattern (io never reads core config). When ON, the
    // appender routes an LLM-fill event to the COMMITTED shared stream (reason
    // stripped) instead of the local sidecar; deterministic events stay local.
    appendVerdictEvent(graph.rootPath, event, { committedLlm });
  };

  // The type-level classification lattice (coverage.type_level), computed ONCE
  // for this whole fill run and threaded into every downstream consumer below:
  // the structural gate's own reviewer-presence check (validate →
  // checkReviewerPresence), pair classification (verifyLock — critically, the
  // one thing that keeps a nodeless pair from being pruned as detached), GC
  // (garbageCollectAndRewrite), and both of this run's own runCheck calls below
  // (as precomputedTypeCoverage — otherwise runCheck would classify a second
  // time from scratch, reading every uncovered file's bytes twice). Undefined
  // at flag-off or when no file walk ran this call (opts.coverageVisibleFiles
  // === null) — every consumer already treats that as "nothing to do."
  // computeTypeCoverageCached constructs its own persistent
  // .yggdrasil/.type-class-cache/ instance, so `yg check --approve` reads and
  // writes it exactly like a plain `yg check` does, instead of the
  // classification-cache bypass that shipped before.
  const coverage = graph.config.coverage ?? DEFAULT_COVERAGE;
  let typeCoverageInput: TypeCoverageInput | undefined;
  let typeCoverageResult: TypeCoverageResult | undefined;
  if (opts.coverageVisibleFiles !== null && coverage.typeLevel) {
    const uncoveredForGate = scanUncoveredFiles(graph, opts.coverageVisibleFiles);
    typeCoverageResult = await computeTypeCoverageCached(graph, uncoveredForGate, new FileContentCache());
    typeCoverageInput = {
      covered: typeCoverageResult.covered,
      ambiguousPaths: typeCoverageResult.ambiguous.map((a) => a.file),
    };
  }

  // ── Step 1: Structural gate. A gating code aborts the whole fill. ──────────
  const validation = await validate(graph, 'all', undefined, typeCoverageInput);
  const gating = validation.issues.filter(
    (i) => i.code !== undefined && APPROVE_GATING_CODES.has(i.code),
  );
  if (gating.length > 0) {
    emitIssue({
      what: 'yg check --approve aborted — configuration errors block tier resolution.',
      why: 'One or more configuration errors must be resolved before any reviewer tier can be selected; the offending errors are listed below.',
      next: 'Fix the errors below, then re-run: yg check --approve',
    });
    for (const i of gating) emitIssue(i.messageData);
    throw new FillGatingError(
      gating.map((i) => ({ code: i.code!, what: i.messageData.what, why: i.messageData.why, next: i.messageData.next })),
    );
  }

  // ── Step 2: Classify pairs through the SAME engine plain check uses. ───────
  // verifyLock recomputes every pair's validity (det re-observation included)
  // and applies the prompt-size gate. Unverified pairs are the fill set;
  // prompt-too-large pairs are skipped (gate precedence). Valid (verified or
  // refused) pairs are already final and never re-run.
  const lock = readLock(graph.rootPath);
  const verification = await verifyLock(graph, lock, typeCoverageInput);

  const unverifiedPairs: ExpectedPair[] = [];
  for (const vp of verification.pairs) {
    if (vp.state.kind === 'unverified') unverifiedPairs.push(vp.pair);
    // verified / refused / prompt-too-large → not filled.
  }

  const detPairs = unverifiedPairs.filter((p) => p.kind === 'deterministic');
  // --only-deterministic: no LLM fills this run. An empty set naturally skips the
  // reviewer-call budget, the deterministic gate, and the whole step-6 LLM loop.
  const llmPairs = onlyDeterministic ? [] : unverifiedPairs.filter((p) => p.kind === 'llm');
  // Under --only-deterministic the LLM pairs are intentionally NOT filled (no
  // reviewer this run). Count them so the pre-dispatch header and the closing
  // summary can say so honestly, instead of implying the run reviewed or
  // verified them. Zero outside --only-deterministic (they land in llmPairs).
  const skippedLlmPairs = onlyDeterministic
    ? unverifiedPairs.filter((p) => p.kind === 'llm').length
    : 0;

  // Index aspect defs and resolve consensus for the header's call count.
  const aspectById = new Map<string, AspectDef>();
  for (const a of graph.aspects) aspectById.set(a.id, a);

  // Partition key for the split lock: verdicts of these aspects go to the gitignored
  // deterministic file; all others (LLM, incl. companion-backed) to the committed file.
  const deterministicAspectIds = new Set(
    graph.aspects.filter((a) => a.reviewer.type === 'deterministic').map((a) => a.id),
  );
  // The SAME partition, read back from disk rather than derived from the
  // current graph — fed to GC so a pruned entry whose aspect no longer exists
  // in the graph at all (deleted, not just detached) can still be classified
  // billed vs free from where its verdicts actually live, instead of
  // defaulting to a guess.
  const detAspectIdsOnDisk = readDetLockAspectIds(graph.rootPath);

  // ── Step 3: Pre-dispatch header (EXACT). ──────────────────────────────────
  // nodeSet counts only DEFINED owners — a nodeless (file-level) pair would
  // otherwise inflate it by one phantom component. fileSet counts distinct
  // type-covered files separately (several aspects can share one file's unit
  // key, so it must be deduped by unitKey, not by pair count).
  const nodeSet = new Set<string>();
  const fileSet = new Set<string>();
  for (const p of unverifiedPairs) {
    if (p.nodePath !== undefined) nodeSet.add(p.nodePath);
    else fileSet.add(p.unitKey);
  }
  let reviewerCallBudget = 0;
  for (const p of llmPairs) {
    const aspect = aspectById.get(p.aspectId);
    const reviewer = graph.config.reviewer;
    const tier = aspect && reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
    reviewerCallBudget += tier?.ok ? tier.tier.consensus : 1;
  }
  // Byte-identical to the plain node-only header when no nodeless pair exists
  // this run (this repo's own flag stays OFF, so `fileSet.size` is always 0
  // here) — only a repo with type-covered files sees the combined "components
  // and files" wording; no phantom nodes rendered either way.
  const acrossLabel = fileSet.size > 0
    ? `${nodeSet.size} components and ${fileSet.size} files`
    : `${nodeSet.size} nodes`;
  write(
    `Filling ${unverifiedPairs.length} unverified pairs across ${acrossLabel} — ` +
      `${detPairs.length} deterministic (no cost), ${reviewerCallBudget} reviewer calls (consensus included)\n`,
  );
  // Deterministic-only mode fills the free deterministic pairs but leaves every
  // unverified LLM pair untouched. Say so up front — otherwise the header reads
  // as if all N unverified pairs are being handled this run.
  if (skippedLlmPairs > 0) {
    write(
      `  Deterministic-only mode — ${skippedLlmPairs} LLM pair${skippedLlmPairs === 1 ? '' : 's'} will NOT be reviewed this run; ` +
        `run \`yg check --approve\` to review ${skippedLlmPairs === 1 ? 'it' : 'them'}.\n`,
    );
  }

  // ── Dry-run: cost preview, no writes. ──────────────────────────────────────
  // Placed AFTER the step-3 budget header and BEFORE the serialized writer is
  // constructed, so the no-write guarantee is STRUCTURAL — there is no writer to
  // invoke and no fill loop is reached. This INTENTIONALLY bypasses the step-4
  // log gate below (a cost preview must not require a fresh log entry); only the
  // step-1 structural/config gate, which already ran above, can abort a preview.
  // The breakdown is plain progress text (the engine never formats diagnostics).
  if (dryRun) {
    // Group the fill set by node, then split each node's pairs by reviewer kind.
    // Within the LLM group, resolve each pair's consensus exactly as step 3 did
    // so the per-aspect numbers reconcile with the header budget. Nodeless
    // (file-level) pairs are collected separately and rendered AFTER every
    // component section, in their own "Files enforced by their type" section —
    // never inside byNode (no phantom component line).
    const byNode = new Map<string, ExpectedPair[]>();
    const filePairs: ExpectedPair[] = [];
    for (const p of unverifiedPairs) {
      if (p.nodePath === undefined) { filePairs.push(p); continue; }
      const list = byNode.get(p.nodePath) ?? [];
      list.push(p);
      byNode.set(p.nodePath, list);
    }
    for (const nodePath of [...byNode.keys()].sort()) {
      const nodePairs = byNode.get(nodePath)!;
      write(`  ${toPosixPath(nodePath)}\n`);
      const det = nodePairs.filter((p) => p.kind === 'deterministic');
      const llm = onlyDeterministic ? [] : nodePairs.filter((p) => p.kind === 'llm');
      for (const p of [...det].sort((a, b) => a.aspectId.localeCompare(b.aspectId, 'en'))) {
        write(`    [det] ${p.aspectId} on ${toPosixPath(p.unitKey)} — free\n`);
      }
      for (const p of [...llm].sort((a, b) => a.aspectId.localeCompare(b.aspectId, 'en'))) {
        const aspect = aspectById.get(p.aspectId);
        const reviewer = graph.config.reviewer;
        const tier = aspect && reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
        const calls = tier?.ok ? tier.tier.consensus : 1;
        write(`    [llm] ${p.aspectId} on ${toPosixPath(p.unitKey)} — ${calls} reviewer call(s)\n`);
      }
    }
    if (filePairs.length > 0) {
      write(`  Files enforced by their type\n`);
      const sortByAspectThenFile = (a: ExpectedPair, b: ExpectedPair): number =>
        a.aspectId.localeCompare(b.aspectId, 'en') ||
        toPosixPath(a.subjectFiles[0]).localeCompare(toPosixPath(b.subjectFiles[0]), 'en');
      const det = filePairs.filter((p) => p.kind === 'deterministic').sort(sortByAspectThenFile);
      const llm = onlyDeterministic ? [] : filePairs.filter((p) => p.kind === 'llm').sort(sortByAspectThenFile);
      for (const p of det) {
        write(`    [det] ${p.aspectId} on ${toPosixPath(p.subjectFiles[0])} — free\n`);
      }
      for (const p of llm) {
        const aspect = aspectById.get(p.aspectId);
        const reviewer = graph.config.reviewer;
        const tier = aspect && reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
        const calls = tier?.ok ? tier.tier.consensus : 1;
        write(`    [llm] ${p.aspectId} on ${toPosixPath(p.subjectFiles[0])} — ${calls} reviewer call(s)\n`);
      }
    }
    write(
      `${reviewerCallBudget} reviewer call(s) is an UPPER BOUND — a node with an enforced ` +
        `deterministic refusal has its LLM fills skipped this run, and a fresh refusal or ` +
        `infra disposition can leave a pair unfilled. Nothing was written; run yg check --approve to fill.\n`,
    );
    // Prune-summary PREVIEW: the same GC analysis a real --approve would run,
    // over a disposable deep clone of the lock so the preview mutates and
    // persists NOTHING (the no-write guarantee for --dry-run stays structural).
    const previewLock = structuredClone(lock);
    const prunePreview = await garbageCollectAndRewrite(graph, previewLock, async () => {}, {
      typeCoverage: typeCoverageInput,
      detAspectIdsOnDisk,
      scope: onlyDeterministic ? 'deterministic' : 'all',
    });
    writePruneSummary(prunePreview, write);
    const checkResult = await runCheck(graph, opts.coverageVisibleFiles, {
      nowUtc: opts.reviewNowUtc,
      rulesArtifacts: opts.rulesArtifacts,
      trackedFiles: opts.trackedFiles,
      precomputedTypeCoverage: typeCoverageResult,
    });
    return { checkResult, reviewerCallsMade: 0, infraFailures: 0, runtimeErrors: 0, companionRuntimeErrors: 0, malformedSuppressErrors: 0 };
  }

  // Count of verdict-content writes performed this run (one per setEntry). Read
  // ONLY by the convergence sentinel at the report boundary — GC's canonical
  // re-serialization and closure's fingerprint writes are deliberately NOT
  // counted, since only a real verdict write would legitimately explain a change
  // in the unverified set between the pre-fill and post-fill classifications.
  let lockWrites = 0;

  // ── Serialized lock writer (interruption-safe, §7). ───────────────────────
  // --only-deterministic writes ONLY the gitignored det file; a full run writes all three.
  const writeScope = onlyDeterministic ? 'deterministic' : 'all';
  let writeChain: Promise<void> = Promise.resolve();
  const persistLock = (): Promise<void> => {
    writeChain = writeChain.then(() => writeLock(graph.rootPath, lock, { scope: writeScope, deterministicAspectIds }));
    return writeChain;
  };
  const setEntry = async (
    pair: ExpectedPair,
    entry: VerdictEntry,
    tierName?: string,
    votes?: { satisfied: number; total: number },
    judge?: { provider: string; model: string },
  ): Promise<void> => {
    // Normalize the storage key to POSIX — the committed lock is shared across
    // platforms, and every read/compare/display of a unitKey already normalizes,
    // so a raw OS-native key (backslashes on Windows) would be stored under a key
    // no normalized lookup could find. A no-op on POSIX.
    (lock.verdicts[pair.aspectId] ??= {})[toPosixPath(pair.unitKey)] = entry;
    lockWrites += 1;
    await persistLock();
    // Verdict-persisted-BEFORE-event: the lock write above is the source of truth
    // and has already resolved; the telemetry event below is a strictly-AFTER
    // side effect on the write-only sidecar (never read back by any engine path).
    emitEvent(pair.aspectId, pair.unitKey, pair.kind, entry.verdict, {
      hash: entry.hash,
      reason: entry.reason,
      tier: tierName,
      votes,
      judge,
    });
  };

  // ── Step 4: Log gate per node (§9). A node owning unverified pairs whose
  // log_required type drifted (or first verification) with no fresh entry needs
  // a justification entry first. The gate is all-or-nothing: if ANY node needs an
  // entry, --approve approves NOTHING this run and stops (no fill, no report) —
  // the per-node messages tell the user which entries to add, then re-run.
  const blockedNodes = new Set<string>();
  for (const nodePath of nodeSet) {
    const node = graph.nodes.get(nodePath);
    if (!node) continue;
    const blocked = await logGateBlocks(graph, projectRoot, node, lock, emitIssue);
    if (blocked) blockedNodes.add(nodePath);
  }
  if (blockedNodes.size > 0) {
    throw new FillGatingError([{
      code: 'log-entry-required',
      what: `${blockedNodes.size} node(s) need a fresh log entry before --approve.`,
      why: 'Source changed on log_required nodes without a justification entry; nothing was approved this run.',
      next: 'Add the log entries listed above (yg log add), then re-run: yg check --approve',
    }]);
  }

  let reviewerCallsMade = 0;
  let infraFailures = 0;
  let runtimeErrors = 0;
  let companionRuntimeErrors = 0;
  let malformedSuppressErrors = 0;

  // Collectors for grouped infra diagnostics (emitted AFTER each phase loop so
  // multiple units of the same aspect produce ONE message instead of N near-identical ones).
  const detRuntimeItems: Array<{ aspectId: string; unitKey: string; messageData: IssueMessage }> = [];
  const malformedSuppressItems: Array<{ aspectId: string; unitKey: string; messageData: IssueMessage }> = [];
  const companionRuntimeItems: Array<{ aspectId: string; unitKey: string; messageData: IssueMessage }> = [];
  const poolInfraItems: Array<{ aspectId: string; unitKey: string; messageData: IssueMessage }> = [];

  // ── Progress tracker — covers all fill pairs (det + LLM). ─────────────────
  // The tracker is created here (after pair counts are known) so it can
  // initialise the milestone interval from the total pair count.
  // It is NOT responsible for setting up real timers — that is done below so
  // that tests can drive the tracker directly via onTick() with a fake clock.
  const totalPairs = detPairs.length + llmPairs.length;
  const tracker = new ProgressTracker(totalPairs, {
    isTTY,
    now,
    milestoneInterval: opts.milestoneInterval,
    stillWorkingIntervalMs: opts.stillWorkingIntervalMs,
  });

  // Set up a real timer for heartbeat ticks (TTY rewrite or still-working check).
  // The interval matches the stillWorkingIntervalMs default / configured value so
  // we tick often enough to detect a stall. We use a short interval (5s) for
  // the TTY rewrite so the elapsed-seconds counter stays current.
  const tickIntervalMs = isTTY ? 5000 : (opts.stillWorkingIntervalMs ?? 30000);
  const tickInterval = setInterval(() => { tracker.onTick(write); }, tickIntervalMs);
  tickInterval.unref?.(); // don't keep the process alive if everything else finishes

  // ── Step 5: Deterministic fills FIRST (free). ─────────────────────────────
  // A node with an enforced det refusal (fresh OR cached-valid) skips its LLM
  // fills this run. Track which GATE KEYS (detGateKey, above) carry such a
  // refusal across BOTH sources.
  // A pair's component is blocked by the log gate — explicit, not implicit via
  // `Set.has(undefined)`: a nodeless pair has no log obligation, so it can never
  // be blocked by it.
  const nodeBlocked = (pair: ExpectedPair): boolean =>
    pair.nodePath !== undefined && blockedNodes.has(pair.nodePath);
  const detEnforcedRefusedNodes = new Set<string>();

  // Seed from CACHED-valid enforced det refusals (verifyLock already classified
  // the lock; a valid refused det pair on an enforced status blocks LLM fills).
  for (const vp of verification.pairs) {
    if (vp.pair.kind !== 'deterministic') continue;
    if (vp.state.kind === 'refused' && vp.pair.status === 'enforced') {
      detEnforcedRefusedNodes.add(detGateKey(vp.pair));
    }
  }

  // Active deterministic pairs this run: NOT log-gate-blocked and with a known
  // aspect def — the exact set the sequential loop's inline skips produced.
  const activeDetPairs: Array<{ pair: ExpectedPair; aspect: AspectDef }> = [];
  for (const pair of detPairs) {
    if (nodeBlocked(pair)) continue;
    const aspect = aspectById.get(pair.aspectId);
    if (!aspect) continue;
    activeDetPairs.push({ pair, aspect });
  }

  // Per-pair outcome handling — identical for the sequential and parallel paths.
  // Applies the LIVE side effects (setEntry, counters, tracker) and RETURNS a
  // diagnostic to collect (or null). The caller owns collection order, so grouped
  // output stays deterministic regardless of completion order.
  type DetDiagItem = { aspectId: string; unitKey: string; messageData: IssueMessage };
  type DetDiag = { kind: 'runtime' | 'suppress'; item: DetDiagItem } | null;
  const applyDetOutcome = async (
    pair: ExpectedPair,
    outcome: Awaited<ReturnType<typeof fillDetPair>>,
  ): Promise<DetDiag> => {
    if (outcome.kind === 'runtime-error') {
      runtimeErrors += 1;
      // No write — pair stays unverified, reported as aspect-check-runtime-error.
      emitEvent(pair.aspectId, pair.unitKey, 'deterministic', 'runtime-error');
      tracker.onPairComplete('det', pair.aspectId, toPosixPath(pair.unitKey), 'infra', write);
      return { kind: 'runtime', item: { aspectId: pair.aspectId, unitKey: pair.unitKey, messageData: outcome.messageData } };
    }
    if (outcome.kind === 'malformed-suppress') {
      malformedSuppressErrors += 1;
      // No write — a fault in the source file's marker, not check.mjs; a DISTINCT
      // disposition never reported as aspect-check-runtime-error.
      emitEvent(pair.aspectId, pair.unitKey, 'deterministic', 'malformed-suppress');
      tracker.onPairComplete('det', pair.aspectId, toPosixPath(pair.unitKey), 'infra', write);
      return { kind: 'suppress', item: { aspectId: pair.aspectId, unitKey: pair.unitKey, messageData: outcome.messageData } };
    }
    // Real verdict — write the entry (setEntry emits the verdict telemetry event).
    await setEntry(pair, outcome.entry);
    tracker.onPairComplete('det', pair.aspectId, toPosixPath(pair.unitKey), outcome.entry.verdict, write);
    if (outcome.entry.verdict === 'refused' && pair.status === 'enforced') {
      detEnforcedRefusedNodes.add(detGateKey(pair));
    }
    return null;
  };
  const collectDetDiag = (diag: DetDiag): void => {
    if (!diag) return;
    if (diag.kind === 'runtime') detRuntimeItems.push(diag.item);
    else malformedSuppressItems.push(diag.item);
  };

  // The architecture-reach cache for nodeless (component-free) pairs — shared
  // across EVERY fillDetPair call AND every fillLlmPair companion resolution
  // this run (both the pooled and the in-process det branches below dispatch
  // from the same activeDetPairs list; the LLM tier loop further down shares
  // this SAME map), computed once per matched type rather than once per pair:
  // recomputing it per pair over a repo with thousands of files would
  // dominate the run. companion-resolve.ts computes the identical quantity
  // under the identical cache contract (fromType -> Set<string>), so sharing
  // one Map here costs nothing extra to wire and means a run reviewing both a
  // det and an LLM aspect on the same type pays the reach computation once,
  // not twice.
  const reachCache = new Map<string, Set<string>>();

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
    const runViaPool = async (params: RunStructureAspectParams): Promise<RunStructureAspectResult> => {
      const reply = await pool.run({
        aspectDir: params.aspectDir,
        aspectId: params.aspectId,
        unit: params.unit,
        subjectScope: params.subjectScope,
      });
      if (reply.ok) return reply.result;
      if (reply.error.code !== undefined && reply.error.messageData !== undefined) {
        throw new StructureRunnerError(reply.error.code, reply.error.messageData);
      }
      throw new Error(reply.error.message);
    };
    try {
      // Dispatch every pair; the pool bounds concurrency to its worker count. Live
      // side effects apply as each completes; diagnostics land in index-keyed slots
      // flattened in pair order below, so grouped output is completion-order-independent.
      const diagSlots: DetDiag[] = new Array<DetDiag>(activeDetPairs.length);
      await Promise.all(
        activeDetPairs.map(async ({ pair, aspect }, i) => {
          tracker.onPairStart('det', pair.aspectId, toPosixPath(pair.unitKey), write);
          const outcome = await fillDetPair(graph, projectRoot, pair, aspect, runViaPool, typeCoverageInput, reachCache);
          diagSlots[i] = await applyDetOutcome(pair, outcome);
        }),
      );
      for (const diag of diagSlots) collectDetDiag(diag);
    } finally {
      await pool.destroy();
    }
  } else {
    for (const { pair, aspect } of activeDetPairs) {
      tracker.onPairStart('det', pair.aspectId, toPosixPath(pair.unitKey), write);
      const outcome = await fillDetPair(graph, projectRoot, pair, aspect, runStructureAspect, typeCoverageInput, reachCache);
      collectDetDiag(await applyDetOutcome(pair, outcome));
    }
  }

  // ── Emit grouped det runtime-error diagnostics (one message per aspect). ────
  emitGroupedDiagnostics(detRuntimeItems, 'det', emitIssue);
  // ── Emit grouped malformed-suppress-marker diagnostics — distinct from a check
  //    runtime error so a marker-parse fault is never blamed on check.mjs. ──────
  emitGroupedDiagnostics(malformedSuppressItems, 'malformed-suppress', emitIssue);

  // ── Deterministic gate: report units whose LLM fills are skipped. ──────────
  // Keyed on detGateKey — one refusing FILE must skip only that file's
  // paid review, never every other type-covered file's (the cross-contamination
  // this gate must never reproduce).
  const llmSkippedByDetGate = new Set<string>();
  for (const pair of llmPairs) {
    if (detEnforcedRefusedNodes.has(detGateKey(pair))) {
      llmSkippedByDetGate.add(detGateKey(pair));
    }
  }
  for (const key of llmSkippedByDetGate) {
    // A gate key is either a real component path or a `file:<path>` unit key
    // (never both) — the message names whichever it actually is, so the file
    // case never claims a component that does not exist.
    const isFile = key.startsWith('file:');
    const posixSubject = toPosixPath(isFile ? key.slice('file:'.length) : key);
    const subject = isFile ? `file '${posixSubject}'` : `node '${posixSubject}'`;
    emitIssue({
      what: `LLM fills for ${subject} skipped — an enforced deterministic check already refused it.`,
      why: 'A free deterministic check rejects this unit, so paying the reviewer to read the same code would be wasted. Fix the deterministic violations first.',
      next: `Fix the deterministic violations on '${posixSubject}', then re-run: yg check --approve`,
    });
  }

  // ── Step 6: LLM fills — grouped by resolved tier; one provider per tier. ───
  // Tier config already reflects the yg-secrets overlay (deep-merged at config
  // parse time), so no per-provider secret merge happens here.
  // Reference bytes are cached as RAW disk Buffers (null = missing/unreadable) so
  // the producer hashes and prompts the SAME bytes the verifier re-reads through
  // readFileBytes — a BOM or non-UTF-8 reference can never desync the two sides
  // (spec §3.1; Bug 1).
  const referencesCache = new Map<string, Buffer | null>();

  // Resolve each fillable LLM pair to its tier; an unresolvable tier is an infra
  // disposition (no write). Group resolvable pairs by tier name.
  interface ResolvedLlmPair { pair: ExpectedPair; aspect: AspectDef; tier: LlmConfig; tierName: string }
  const byTier = new Map<string, ResolvedLlmPair[]>();
  const infraReport: Array<{ provider?: string; tier?: string }> = [];

  for (const pair of llmPairs) {
    if (nodeBlocked(pair) || llmSkippedByDetGate.has(detGateKey(pair))) continue;
    const aspect = aspectById.get(pair.aspectId);
    if (!aspect) continue;
    const reviewer = graph.config.reviewer;
    const tierResult = reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
    if (!tierResult || !tierResult.ok) {
      // No reviewer configured OR tier resolution failed — infra disposition.
      // Collect for grouped emission after the tier loop.
      infraFailures += 1;
      infraReport.push({ tier: aspect.reviewer.tier });
      poolInfraItems.push({
        aspectId: pair.aspectId,
        unitKey: pair.unitKey,
        messageData: {
          what: `Cannot resolve a reviewer tier for aspect '${pair.aspectId}' on ${toPosixPath(pair.unitKey)} — left unverified.`,
          why: tierResult && !tierResult.ok ? tierResult.error.why : 'No reviewer is configured for an effective non-draft LLM aspect.',
          next: tierResult && !tierResult.ok ? tierResult.error.next : 'Add a reviewer tier in .yggdrasil/yg-config.yaml, or set the aspect to status: draft.',
        },
      });
      emitEvent(pair.aspectId, pair.unitKey, 'llm', 'infra', { tier: aspect.reviewer.tier });
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
      infraFailures += group.length;
      infraReport.push({ provider: baseTier.provider, tier: tierName });
      for (const item of group) {
        emitEvent(item.pair.aspectId, item.pair.unitKey, 'llm', 'infra', { tier: tierName, judge: judgeIdentity(baseTier) });
      }
      emitIssue({
        what: `Reviewer provider '${baseTier.provider}' (tier '${tierName}') is unreachable — ${group.length} pair(s) left unverified.`,
        why: 'The configured reviewer endpoint did not respond (availability check failed) — an infrastructure problem, not a code violation. No verdict was written.',
        next: `Check the provider endpoint, network, and credentials, then re-run: yg check --approve`,
      });
      continue;
    }

    // Worker pool bounded by parallel; consensus runs sequentially in-slot.
    const outcomes = await runPairPool(group, parallel, async (item) => {
      tracker.onPairStart('llm', item.pair.aspectId, toPosixPath(item.pair.unitKey), write);
      const outcome = await fillLlmPair(graph, projectRoot, item.pair, item.aspect, item.tier, item.tierName, baseTier, provider, referencesCache, typeCoverageInput, reachCache);
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
        await setEntry(item.pair, outcome.entry, item.tierName, votes, judgeIdentity(item.tier));
        tracker.onPairComplete('llm', item.pair.aspectId, toPosixPath(item.pair.unitKey), outcome.entry.verdict, write);
      } else if (outcome.kind === 'infra' || outcome.kind === 'companion-runtime-error') {
        tracker.onPairComplete('llm', item.pair.aspectId, toPosixPath(item.pair.unitKey), 'infra', write);
      }
      return outcome;
    });

    // Tally counters and collect infra dispositions for grouped emission (no
    // persistence here — the verdicts were already written inside the pool).
    for (let i = 0; i < group.length; i++) {
      const item = group[i];
      const outcome = outcomes[i];
      reviewerCallsMade += outcome.callsMade;
      if (outcome.kind === 'companion-runtime-error') {
        // Companion hook/resolution failure — counted separately, collected for
        // grouped emission after the tier loop. No infra counter increment —
        // these are NOT provider/config failures.
        companionRuntimeErrors += 1;
        companionRuntimeItems.push({ aspectId: item.pair.aspectId, unitKey: item.pair.unitKey, messageData: outcome.messageData });
        // Emitted here (not inside the pool callback above) so this single site
        // covers BOTH a normal companion-runtime-error outcome AND the pool's own
        // synthetic infra conversion of a worker throw (fill-pool.ts) — every
        // no-write disposition for this tier group passes through this loop.
        emitEvent(item.pair.aspectId, item.pair.unitKey, 'llm', 'companion-runtime-error', { tier: item.tierName, judge: judgeIdentity(baseTier) });
      } else if (outcome.kind === 'infra') {
        infraFailures += 1;
        infraReport.push({ provider: baseTier.provider, tier: tierName });
        // Prefer the outcome's self-describing messageData when present; build a
        // fallback for a bare `why`. Collect for grouped emission after the tier loop.
        const messageData: IssueMessage = outcome.messageData ?? {
          what: `Reviewer could not verify aspect '${item.pair.aspectId}' on ${toPosixPath(item.pair.unitKey)} — left unverified.`,
          why: outcome.why,
          next: `Resolve the provider/config problem, then re-run: yg check --approve`,
        };
        poolInfraItems.push({ aspectId: item.pair.aspectId, unitKey: item.pair.unitKey, messageData });
        emitEvent(item.pair.aspectId, item.pair.unitKey, 'llm', 'infra', { tier: item.tierName, judge: judgeIdentity(baseTier) });
      }
    }
  }

  // ── Emit grouped companion and pool-infra diagnostics. ────────────────────
  emitGroupedDiagnostics(companionRuntimeItems, 'companion', emitIssue);
  emitGroupedDiagnostics(poolInfraItems, 'pool-infra', emitIssue);

  // ── Step 7: Positive closure (§7.5). ──────────────────────────────────────
  // Re-classify against the POST-FILL lock so closure sees the verdicts just
  // written. A node with a missing/stale fingerprint closes (records source +
  // log baseline) only when ALL its enforced effective pairs are approved.
  // Deliberate post-fill re-classification: must see freshly-written verdicts —
  // do not thread step-2 (pre-fill verifyLock) results through. blockedNodes
  // (the step-4 log-gate set) is threaded so a node whose pairs were skipped this
  // run can never close over its stale verdicts.
  // Skipped under --only-deterministic: closure records source + log baseline to the
  // COMMITTED logs file, which a deterministic-only / CI run must never write.
  if (!onlyDeterministic) {
    await applyPositiveClosure(graph, projectRoot, lock, blockedNodes, persistLock, typeCoverageInput);
  }

  // ── Step 8: GC + canonical rewrite (§3.2). ────────────────────────────────
  // Deliberate post-fill re-classification: must see freshly-written verdicts —
  // do not thread step-2 (pre-fill verifyLock) results through. typeCoverageInput
  // IS threaded (computed once at the top of this run) — this is the anti-prune
  // lever: without it, the first --approve after enabling the feature would
  // prune every file-level result as detached.
  const pruneSummary = await garbageCollectAndRewrite(graph, lock, persistLock, {
    typeCoverage: typeCoverageInput,
    detAspectIdsOnDisk,
    scope: onlyDeterministic ? 'deterministic' : 'all',
  });

  // ── Step 9: Summaries + re-run the read. ──────────────────────────────────
  writePruneSummary(pruneSummary, write);
  if (
    reviewerCallsMade === 0 &&
    infraFailures === 0 &&
    runtimeErrors === 0 &&
    companionRuntimeErrors === 0 &&
    malformedSuppressErrors === 0
  ) {
    if (skippedLlmPairs > 0) {
      // --only-deterministic made no reviewer calls BY DESIGN, but LLM pairs were
      // left unverified — do NOT claim every pair holds a valid verdict.
      write(
        `0 reviewer calls made — deterministic-only mode; ${skippedLlmPairs} LLM pair${skippedLlmPairs === 1 ? '' : 's'} left unverified. ` +
          `Run \`yg check --approve\` to review ${skippedLlmPairs === 1 ? 'it' : 'them'}.\n`,
      );
    } else {
      write('0 reviewer calls made — all expected pairs hold valid verdicts\n');
    }
  }
  if (infraFailures > 0) {
    const providers = [...new Set(infraReport.map((r) => r.provider).filter(Boolean))].join(', ');
    const tiers = [...new Set(infraReport.map((r) => r.tier).filter(Boolean))].join(', ');
    const ids = [providers, tiers].filter((s) => s.length > 0).join(' / ');
    emitIssue({
      what: `${infraFailures} pairs failed on provider/config errors — re-running will not help until the connection/config is fixed${ids ? ` (${ids})` : ''}.`,
      why: 'These pairs hit an infrastructure disposition (provider unreachable, tier unresolved, reference unreadable, an unparseable response, or a prompt-too-large gate). No verdict was written; the pairs stay unverified and the run ends red.',
      next: 'Fix the reviewer connection/configuration, then re-run: yg check --approve. To unblock CI without a reviewer, set the affected aspect(s) to status: draft.',
    });
  }
  if (runtimeErrors > 0) {
    emitIssue({
      what: `${runtimeErrors} deterministic check(s) failed to run at fill time — left unverified (aspect-check-runtime-error).`,
      why: 'A check.mjs crashed, returned an invalid result, or observed a file that changed mid-run. No verdict was written.',
      next: 'Fix the failing check.mjs, then re-run: yg check --approve.',
    });
  }
  if (malformedSuppressErrors > 0) {
    emitIssue({
      what: `${malformedSuppressErrors} pair(s) left unverified by a malformed yg-suppress marker (malformed-suppress-marker).`,
      why: 'A yg-suppress marker in a mapped source file is missing its required reason. This is a fault in the marker itself, not in the aspect being checked; no verdict was written.',
      next: 'Add a reason to the marker (or remove it), then re-run: yg check --approve.',
    });
  }
  if (companionRuntimeErrors > 0) {
    emitIssue({
      what: `${companionRuntimeErrors} companion resolution(s) failed to run at fill time — left unverified (aspect-companion-runtime-error).`,
      why: 'A companion.mjs crashed, returned an invalid result, or its observations changed mid-run. No verdict was written.',
      next: 'Fix the failing companion.mjs, then re-run: yg check --approve.',
    });
  }

  // Drain all queued progress writes first, then stop the timer and clear the TTY line.
  await writeChain;
  clearInterval(tickInterval);
  tracker.clearLine(write);

  // The `yg check --approve` combiner prints this report after filling. This IS the
  // reporting path for `--approve`, so it maintains the silent feature-field index when the
  // CLI asks (best-effort, byproduct-free elsewhere). The dry-run re-check above returns
  // before reaching here, so a cost preview never writes it regardless of the flag.
  const checkResult = await runCheck(graph, opts.coverageVisibleFiles, {
    writeFeatureIndex: opts.writeFeatureIndex,
    now: opts.featureIndexNow,
    nowUtc: opts.reviewNowUtc,
    rulesArtifacts: opts.rulesArtifacts,
    trackedFiles: opts.trackedFiles,
    precomputedTypeCoverage: typeCoverageResult,
  });

  // ── Convergence sentinel (C15) — READ-ONLY over the fill's own state. ──────
  // Detect the exact 0-fill divergence: the pre-fill classification reported ZERO
  // pairs to fill, yet the post-fill report finds unverified pairs, with NO
  // verdict written in between. That triad is a genuine convergence gap (the
  // classifier disagreed with itself over unchanged inputs) that would otherwise
  // be silent. On fire: emit ONE notice and record a bounded evidence dump via
  // the injected io writer. This NEVER alters exit codes, verdicts, the lock, or
  // fill flow, and is wrapped in a swallow-all — a sentinel failure must never
  // fail a fill.
  try {
    const postUnverified = checkResult.issues.filter((i) => i.code === 'unverified').length;
    const shape = { toFill: unverifiedPairs.length, postUnverified, lockWrites };
    await reportDivergenceIfDetected(shape, lock, {
      emitIssue,
      divergenceWrite: opts.divergenceWrite,
      // Read-only enumeration (only invoked on fire): a fresh verifyLock pass
      // names the divergent pairs; buildDivergenceDump attaches each pair's
      // already-stored lock hash — nothing is re-hashed and nothing is written.
      enumerate: async () => {
        const postVerification = await verifyLock(graph, lock, typeCoverageInput);
        return postVerification.pairs
          .filter((vp) => vp.state.kind === 'unverified')
          .map((vp) => ({ aspectId: vp.pair.aspectId, unitKey: vp.pair.unitKey }));
      },
    });
  } catch (e) {
    debugWrite(`[fill] convergence sentinel failed (swallowed): ${e instanceof Error ? e.message : String(e)}`);
  }

  return { checkResult, reviewerCallsMade, infraFailures, runtimeErrors, companionRuntimeErrors, malformedSuppressErrors };
}
