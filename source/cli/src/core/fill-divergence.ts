/**
 * source/cli/src/core/fill-divergence.ts — the auto-approve convergence sentinel
 * (C15). A READ-ONLY divergence detector for the fill's final re-check/report
 * boundary. It catches ONLY the exact observed "0-fill" pathology and records
 * evidence; it NEVER changes a fill's outcome (exit codes, verdicts, the lock, or
 * flow).
 *
 * The pathology (from a real dogfood observation under `auto_approve:
 * deterministic`): the pre-fill classification reported ZERO pairs to fill, yet
 * the post-fill report still found `unverified > 0`, with NO verdict written in
 * between — the classifier disagreed with itself over unchanged inputs, and the
 * gap was silent. This sentinel makes that shape observable instead of silent.
 *
 * These functions are PURE (no filesystem, no clock, no randomness): the caller
 * (core/fill.ts) computes the three counts, calls the detector, and — on fire —
 * builds the bounded evidence dump and emits the single notice. The actual file
 * write happens io-side through an injected writer (no core → io coupling here).
 */

import type { LockFile } from '../model/lock.js';
import type { IssueMessage } from '../model/validation.js';
import { outsideTwin } from './check-codes.js';
import { toPosixPath } from '../utils/posix.js';

/** The finding a pair with no valid verdict produces in the report. */
const UNVERIFIED_CODE = 'unverified';

/** Hard cap on the evidence dump — total lines, header included. Bounded so a
 *  pathological run can never write an unbounded file. */
export const DIVERGENCE_LOG_MAX_LINES = 200;

/** The three already-computed counts that describe a fill's convergence state at
 *  the report boundary. */
export interface DivergenceShape {
  /** Pairs the pre-fill classification reported as needing a fill (the fill set). */
  toFill: number;
  /** Pairs the post-fill report still classifies as unverified. */
  postUnverified: number;
  /** Verdict-content writes the fill performed in between (setEntry calls). GC's
   *  canonical re-serialization and closure's fingerprint writes are NOT counted —
   *  only a real verdict write, which is what would legitimately explain a change
   *  in the unverified set. */
  lockWrites: number;
}

/**
 * The ONLY fire condition (v1). True exactly when the fill classified ZERO pairs
 * to fill, the post-fill report still finds unverified pairs, AND no verdict was
 * written in between. That triad is the observed 0-fill convergence pathology and
 * nothing else — if there was work to do, or a write landed, or nothing is
 * unverified after, the classifier and the fill agree and the sentinel stays
 * silent.
 */
export function isZeroFillDivergence(s: DivergenceShape): boolean {
  return s.toFill === 0 && s.postUnverified > 0 && s.lockWrites === 0;
}

/**
 * How many pairs the post-fill report still leaves without a verdict — the
 * `postUnverified` side of the shape above, counted from the report's own
 * findings.
 *
 * BOTH spellings count. A run measured against a change re-codes an unverified
 * pair the change did not reach into its non-blocking twin, and that pair is
 * every bit as unverified as one that kept the plain code: the sentinel is
 * asking whether verification converged, not whose fault the leftovers are.
 * Counting only the plain code would blind it on exactly the runs where the
 * classifier has the most room to disagree with itself.
 *
 * The twin suffix is never spelled here — `outsideTwin` owns it, so a rename
 * cannot leave this counting a code that no longer exists.
 */
export function countPostUnverified(issues: ReadonlyArray<{ code?: string }>): number {
  const twin = outsideTwin(UNVERIFIED_CODE);
  let count = 0;
  for (const issue of issues) {
    if (issue.code === UNVERIFIED_CODE || issue.code === twin) count += 1;
  }
  return count;
}

/**
 * Build the bounded evidence dump for a fired sentinel: a header line carrying the
 * shape counts, an enumeration line, then one line per post-fill unverified pair —
 * its aspect id, POSIX-normalized unit key, and the ALREADY-COMPUTED hash stored
 * in the lock for that pair (`none` when the lock holds no entry). Nothing is
 * re-hashed here; the sentinel only reads state already in hand.
 *
 * The whole dump is capped at DIVERGENCE_LOG_MAX_LINES lines (header included);
 * beyond the cap a single "… and N more" line records the remainder.
 */
export function buildDivergenceDump(
  s: DivergenceShape,
  unverifiedPairs: Array<{ aspectId: string; unitKey: string }>,
  lock: LockFile,
): string {
  const lines: string[] = [];
  lines.push(
    `fill-convergence-divergence: toFill=${s.toFill} postUnverified=${s.postUnverified} lockWrites=${s.lockWrites}`,
  );
  lines.push(`enumerated ${unverifiedPairs.length} unverified pair(s):`);

  // Reserve the header lines already pushed and one line for a possible overflow
  // note, so the total (header + body + overflow) never exceeds the cap.
  const bodyCap = Math.max(0, DIVERGENCE_LOG_MAX_LINES - lines.length - 1);
  const shown = unverifiedPairs.slice(0, bodyCap);
  for (const p of shown) {
    const key = toPosixPath(p.unitKey);
    const storedHash = lock.verdicts[p.aspectId]?.[key]?.hash ?? 'none';
    lines.push(`${p.aspectId}\t${key}\thash=${storedHash}`);
  }
  if (unverifiedPairs.length > shown.length) {
    lines.push(`… and ${unverifiedPairs.length - shown.length} more`);
  }
  return lines.join('\n') + '\n';
}

/**
 * The single structured notice emitted on fire (what/why/next). Returned as
 * structured data — the CLI command layer renders it; this engine module never
 * formats a message itself.
 */
export function divergenceNotice(s: DivergenceShape): IssueMessage {
  return {
    what: `Verification claimed nothing needed checking, yet ${s.postUnverified} rule check(s) are still unverified after the run — and no results were recorded in between.`,
    why: 'The pre-run and post-run tallies disagree with no change between them, so those checks would otherwise be left silently unverified instead of converging. The evidence has been recorded locally so this is observable rather than lost.',
    next: 'Inspect .yggdrasil/.yg-fill-divergence.log for the affected checks and their recorded hashes, then re-run: yg check --approve',
  };
}

/** Injected sinks for the report step. Mirrors the fill's existing injected-writer
 *  pattern: the caller owns the side effects (emit the notice, write the dump) and
 *  the read-only enumeration of the divergent pairs, so this module stays free of
 *  any io or graph-query coupling. */
export interface DivergenceSinks {
  /** Emit the single structured notice (CLI renders it). */
  emitIssue: (msg: IssueMessage) => void;
  /** Best-effort io writer for the evidence dump. Absent ⇒ notice only, no file. */
  divergenceWrite?: (text: string) => void;
  /** Read-only enumeration of the post-fill unverified pairs (a fresh verifyLock
   *  pass in the caller). Only ever invoked on fire, so a healthy run pays nothing. */
  enumerate: () => Promise<Array<{ aspectId: string; unitKey: string }>>;
}

/**
 * The report step: if (and only if) the shape is the 0-fill divergence, emit the
 * single notice, enumerate the divergent pairs, and hand a bounded evidence dump
 * to the injected writer. Returns whether it fired.
 *
 * The notice is emitted BEFORE enumeration so a failure while gathering evidence
 * can never suppress the notice. The caller wraps this in a swallow-all — a
 * sentinel failure must never fail a fill.
 */
export async function reportDivergenceIfDetected(
  shape: DivergenceShape,
  lock: LockFile,
  sinks: DivergenceSinks,
): Promise<boolean> {
  if (!isZeroFillDivergence(shape)) return false;
  sinks.emitIssue(divergenceNotice(shape));
  const divergent = await sinks.enumerate();
  sinks.divergenceWrite?.(buildDivergenceDump(shape, divergent, lock));
  return true;
}
