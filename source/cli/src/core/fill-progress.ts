/**
 * source/cli/src/core/fill-progress.ts — progress tracking for `yg check --approve`.
 *
 * Handles two modes:
 *   - Non-TTY: milestone lines at thresholds + "still working" lines if no completion occurs
 *     for a configurable interval.
 *   - TTY: single line rewritten with \r on each event or timer tick.
 *
 * The tracker decides WHEN something is said and emits it as a FillEvent; the
 * words (and the terminal control sequences of the in-place line) belong to the
 * renderer in formatters/fill-text.ts, which the command layer applies.
 *
 * All dependencies on the environment (clock, TTY flag) are injectable for testability.
 * The caller (fill.ts) is responsible for setting up real timers and calling onTick().
 * Tests drive the tracker directly via onTick() with a fake clock — no real timers needed.
 */

import type { FillEventSink, FillLane } from '../model/fill-event.js';
import type { PairProgress } from './fill-shared.js';

// ============================================================
// Public types
// ============================================================

export interface ProgressOptions {
  isTTY: boolean;
  now: () => number;
  /**
   * Terminal width in columns, for the single rewritten TTY line. A status line
   * longer than this WRAPS, and `\r` only returns to the start of the last
   * visual row — so every redraw leaves the wrapped rows behind and a line that
   * was meant to update in place scrolls the screen instead. Truncating to the
   * width is what keeps it one line. Injected (never read off the process here)
   * so the engine stays free of environment reads; defaults to a conservative
   * 80 when the caller has no width to give. Carried on each status event for
   * the renderer, which does the truncating.
   */
  columns?: number;
  /** Milestone threshold: emit a milestone line every N completed pairs (non-TTY mode).
   *  Default: 25% of total, minimum 1. */
  milestoneInterval?: number;
  /** Still-working interval in milliseconds (non-TTY). If this many ms pass with no
   *  completion, emit a "still working" line. Default: 30000 (30s). */
  stillWorkingIntervalMs?: number;
}

export interface ProgressState {
  total: number;
  completed: number;
  approved: number;
  refused: number;
  infra: number;
  /** The aspect+unit of the most recently started (or in-progress) pair. */
  currentPair: string;
  lastCompletionTime: number;
}

// ============================================================
// ProgressTracker
// ============================================================

export class ProgressTracker implements PairProgress {
  private readonly isTTY: boolean;
  private readonly now: () => number;
  private readonly milestoneInterval: number;
  private readonly stillWorkingIntervalMs: number;
  private readonly startTime: number;
  private readonly columns: number;

  readonly state: ProgressState;

  constructor(total: number, opts: ProgressOptions) {
    this.isTTY = opts.isTTY;
    this.now = opts.now;
    this.stillWorkingIntervalMs = opts.stillWorkingIntervalMs ?? 30000;
    // A width of 0 (some non-interactive sinks report that) would truncate the
    // line to nothing, so treat anything implausible as "unknown" and fall back.
    this.columns = opts.columns !== undefined && opts.columns >= 20 ? opts.columns : 80;
    const startTime = opts.now();
    this.startTime = startTime;

    // milestoneInterval defaults to 25% of total, minimum 1
    this.milestoneInterval = opts.milestoneInterval ?? Math.max(1, Math.floor(total * 0.25));

    this.state = {
      total,
      completed: 0,
      approved: 0,
      refused: 0,
      infra: 0,
      currentPair: '',
      lastCompletionTime: startTime,
    };
  }

  /**
   * Called just before a pair starts filling. Updates currentPair and refreshes TTY display.
   */
  onPairStart(kind: FillLane, aspectId: string, unitKey: string, emit: FillEventSink): void {
    this.state.currentPair = `${aspectId} on ${unitKey}`;
    if (this.isTTY) {
      this._emitStatus(emit);
    }
  }

  /**
   * Called after a pair completes. Handles refused/approved/infra outcomes.
   * For refused/infra: emits an immediate line (these are actionable events, rare).
   * For approved: silently increments counter, checks milestone threshold (non-TTY).
   */
  onPairComplete(
    kind: FillLane,
    aspectId: string,
    unitKey: string,
    verdict: string,
    emit: FillEventSink,
    /** A consensus review's split (verdict votes only). When it is not
     *  unanimous the pair gets its own line even on an approval — a 2-of-3
     *  approval is exactly what a reader must be able to see. */
    votes?: { satisfied: number; total: number },
  ): void {
    this.state.completed += 1;
    this.state.lastCompletionTime = this.now();

    if (verdict === 'approved') {
      this.state.approved += 1;
    } else if (verdict === 'infra') {
      this.state.infra += 1;
    } else {
      // 'refused' or any unexpected verdict
      this.state.refused += 1;
    }

    const split = votes !== undefined && votes.total > 1 && votes.satisfied > 0 && votes.satisfied < votes.total;
    const outcome = {
      type: 'pair-outcome' as const, lane: kind, aspectId, unitKey, verdict,
      ...(votes !== undefined && votes.total > 1 ? { votes } : {}),
    };
    if (this.isTTY) {
      // For refused/infra (and a split consensus) in TTY mode: clear the TTY line first, then emit the permanent line
      if (verdict !== 'approved' || split) {
        emit({ type: 'clear-line' });
        emit(outcome);
      }
      this._emitStatus(emit);
    } else {
      // Non-TTY mode
      if (verdict !== 'approved' || split) {
        // Refused/infra (or an approval a consensus split on): immediate permanent line
        emit(outcome);
      }
      // Milestone fires on every Nth completion regardless of verdict —
      // it shows overall progress (K/T filled + breakdown). A refused/infra
      // pair already got its own immediate line above, but the milestone
      // provides the aggregate view and is not a duplicate.
      if (this.state.completed % this.milestoneInterval === 0 && this.state.completed > 0) {
        emit({ type: 'milestone', counts: this._counts() });
      }
    }
  }

  /**
   * Called periodically (by a setInterval in fill.ts, or directly in tests).
   * TTY mode: rewrites the status line.
   * Non-TTY mode: checks if still-working line should be emitted.
   */
  onTick(emit: FillEventSink): void {
    if (this.isTTY) {
      this._emitStatus(emit);
    } else {
      this.isStillWorking(emit);
    }
  }

  /**
   * For TTY mode: clears the rewritable progress line before the final report.
   * No-op in non-TTY mode.
   */
  clearLine(emit: FillEventSink): void {
    if (this.isTTY) {
      emit({ type: 'clear-line' });
    }
  }

  /**
   * For non-TTY mode: checks if a "still working" line should be emitted.
   * Emits if `now() - lastCompletionTime > stillWorkingIntervalMs`.
   * Returns true if emitted.
   */
  isStillWorking(emit: FillEventSink): boolean {
    if (this.isTTY) return false;
    const elapsed = this.now() - this.state.lastCompletionTime;
    if (elapsed > this.stillWorkingIntervalMs) {
      const { completed, total, currentPair } = this.state;
      emit({ type: 'still-working', completed, total, currentPair });
      // Reset lastCompletionTime to avoid repeated still-working lines every tick
      this.state.lastCompletionTime = this.now();
      return true;
    }
    return false;
  }

  // ============================================================
  // Private helpers
  // ============================================================

  /**
   * Emit the single in-place status line's data. The renderer clears the line
   * before rewriting it (a shorter line would leave the tail of the previous
   * one on screen) and truncates it to `columns` (a wrapped line scrolls
   * instead of updating in place, because `\r` returns only to the start of the
   * LAST visual row).
   */
  private _emitStatus(emit: FillEventSink): void {
    const elapsedSeconds = Math.floor((this.now() - this.startTime) / 1000);
    emit({ type: 'status', counts: this._counts(), elapsedSeconds, currentPair: this.state.currentPair, columns: this.columns });
  }

  /** How the pairs finished so far ended — the closing line's counts. */
  counts(): { completed: number; total: number; approved: number; refused: number; infra: number } {
    return this._counts();
  }

  private _counts(): { completed: number; total: number; approved: number; refused: number; infra: number } {
    const { completed, total, approved, refused, infra } = this.state;
    return { completed, total, approved, refused, infra };
  }
}
