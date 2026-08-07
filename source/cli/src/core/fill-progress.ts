/**
 * source/cli/src/core/fill-progress.ts — progress tracking for `yg check --approve`.
 *
 * Handles two modes:
 *   - Non-TTY: milestone lines at thresholds + "still working" lines if no completion occurs
 *     for a configurable interval.
 *   - TTY: single line rewritten with \r on each event or timer tick.
 *
 * All dependencies on the environment (clock, TTY flag) are injectable for testability.
 * The caller (fill.ts) is responsible for setting up real timers and calling onTick().
 * Tests drive the tracker directly via onTick() with a fake clock — no real timers needed.
 */

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
   * 80 when the caller has no width to give.
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

/**
 * Cut `text` to at most `width` columns, marking the cut with a single ellipsis
 * so it reads as shortened rather than as a path that mysteriously ends early.
 * Plain text only — the status line carries no colour codes, so counting
 * characters is counting columns.
 */
function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

// ============================================================
// ProgressTracker
// ============================================================

export class ProgressTracker {
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
  onPairStart(kind: 'det' | 'llm', aspectId: string, unitKey: string, write: (s: string) => void): void {
    this.state.currentPair = `${aspectId} on ${unitKey}`;
    if (this.isTTY) {
      this._writeTTYLine(write);
    }
  }

  /**
   * Called after a pair completes. Handles refused/approved/infra outcomes.
   * For refused/infra: emits an immediate line (these are actionable events, rare).
   * For approved: silently increments counter, checks milestone threshold (non-TTY).
   */
  onPairComplete(
    kind: 'det' | 'llm',
    aspectId: string,
    unitKey: string,
    verdict: string,
    write: (s: string) => void,
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

    if (this.isTTY) {
      // For refused/infra in TTY mode: clear the TTY line first, then emit the permanent line
      if (verdict !== 'approved') {
        write(`\r\x1b[2K`);
        write(`  [${kind}] ${aspectId} on ${unitKey} — ${verdict}\n`);
      }
      this._writeTTYLine(write);
    } else {
      // Non-TTY mode
      if (verdict !== 'approved') {
        // Refused/infra: immediate permanent line
        write(`  [${kind}] ${aspectId} on ${unitKey} — ${verdict}\n`);
      }
      // Milestone fires on every Nth completion regardless of verdict —
      // it shows overall progress (K/T filled + breakdown). A refused/infra
      // pair already got its own immediate line above, but the milestone
      // provides the aggregate view and is not a duplicate.
      if (this.state.completed % this.milestoneInterval === 0 && this.state.completed > 0) {
        this._writeMilestoneLine(write);
      }
    }
  }

  /**
   * Called periodically (by a setInterval in fill.ts, or directly in tests).
   * TTY mode: rewrites the status line.
   * Non-TTY mode: checks if still-working line should be emitted.
   */
  onTick(write: (s: string) => void): void {
    if (this.isTTY) {
      this._writeTTYLine(write);
    } else {
      this.isStillWorking(write);
    }
  }

  /**
   * For TTY mode: clears the rewritable progress line before the final report.
   * No-op in non-TTY mode.
   */
  clearLine(write: (s: string) => void): void {
    if (this.isTTY) {
      write(`\r\x1b[2K`);
    }
  }

  /**
   * For non-TTY mode: checks if a "still working" line should be emitted.
   * Emits if `now() - lastCompletionTime > stillWorkingIntervalMs`.
   * Returns true if emitted.
   */
  isStillWorking(write: (s: string) => void): boolean {
    if (this.isTTY) return false;
    const elapsed = this.now() - this.state.lastCompletionTime;
    if (elapsed > this.stillWorkingIntervalMs) {
      const { completed, total, currentPair } = this.state;
      write(`... still working (${completed}/${total}, waiting on ${currentPair})\n`);
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
   * Rewrite the single in-place status line.
   *
   * Two things keep it to ONE line rather than a scrolling log:
   *
   *  - The line is CLEARED (`\x1b[2K`) before it is rewritten. Returning the
   *    cursor with `\r` alone overwrites only as many characters as the new
   *    line has, so a shorter line left the tail of the previous, longer one on
   *    screen — a component path from a moment ago trailing behind the current
   *    one.
   *  - It is TRUNCATED to the terminal width. This is the one that actually
   *    made it scroll: unit keys are full repository paths, so the line
   *    routinely ran past the width and wrapped, and `\r` returns only to the
   *    start of the LAST visual row. Every redraw then left its wrapped rows
   *    behind, turning an update-in-place line into several new lines every
   *    tick.
   *
   * The counts come first and the pair name last, so what gets cut on a narrow
   * terminal is the part that changes constantly rather than the progress.
   */
  private _writeTTYLine(write: (s: string) => void): void {
    const { completed, total, approved, refused, currentPair } = this.state;
    const elapsedSeconds = Math.floor((this.now() - this.startTime) / 1000);
    const head = `filling ${completed}/${total} · ok ${approved} · refused ${refused} · ${elapsedSeconds}s`;
    const full = currentPair === '' ? head : `${head} · ${currentPair}`;
    // Leave one column spare: a line filling the very last column makes some
    // terminals wrap to the next row on their own.
    write(`\r\x1b[2K${truncateToWidth(full, this.columns - 1)}\r`);
  }

  private _writeMilestoneLine(write: (s: string) => void): void {
    const { completed, total, approved, refused, infra } = this.state;
    const parts = [`${approved} ok`];
    if (refused > 0) parts.push(`${refused} refused`);
    if (infra > 0) parts.push(`${infra} infra`);
    write(`... ${completed}/${total} filled (${parts.join(', ')})\n`);
  }
}
