/**
 * Unit tests for fill-progress.ts — the scale-aware, anti-"looks-hung" progress
 * tracker for `yg check --approve`.
 *
 * All dependencies on the environment (clock, TTY flag) are injected so tests
 * can drive the tracker deterministically without real timers or process state.
 */

import { describe, it, expect } from 'vitest';
import { ProgressTracker } from '../../../src/core/fill-progress.js';
import { runPairPool } from '../../../src/core/fill-pool.js';
import type { LlmFillOutcome } from '../../../src/core/fill-shared.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Collect all strings written via a mock write sink into an array. */
function collectLines(): { write: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { write: (s: string) => { lines.push(s); }, lines };
}

/** Returns a fake clock that starts at the given base time and can be advanced
 *  manually via the returned `advance(ms)` function. */
function fakeClock(base = 0): { now: () => number; advance: (ms: number) => void } {
  const state = { t: base };
  return {
    now: () => state.t,
    advance: (ms: number) => { state.t += ms; },
  };
}

// ─── Non-TTY mode tests ────────────────────────────────────────────────────────

describe('ProgressTracker — non-TTY mode', () => {
  it('approved pairs produce NO permanent line', () => {
    const clk = fakeClock(1000);
    const tracker = new ProgressTracker(4, { isTTY: false, now: clk.now, milestoneInterval: 10 });
    const { write, lines } = collectLines();

    tracker.onPairStart('det', 'aspect-a', 'node:svc', write);
    tracker.onPairComplete('det', 'aspect-a', 'node:svc', 'approved', write);
    tracker.onPairStart('det', 'aspect-b', 'node:svc', write);
    tracker.onPairComplete('det', 'aspect-b', 'node:svc', 'approved', write);

    // No approved lines should have been emitted (milestone interval is 10, so
    // no milestone fires at 1 or 2).
    expect(lines.length).toBe(0);
  });

  it('refused verdict emits an immediate permanent line', () => {
    const clk = fakeClock(1000);
    // milestoneInterval: 100 so no milestone fires in this small test
    const tracker = new ProgressTracker(5, { isTTY: false, now: clk.now, milestoneInterval: 100 });
    const { write, lines } = collectLines();

    tracker.onPairStart('det', 'no-todo', 'node:orders', write);
    tracker.onPairComplete('det', 'no-todo', 'node:orders', 'refused', write);

    // 1 refused immediate line (no milestone at completion 1 with interval 100)
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('[det] no-todo on node:orders — refused');
    expect(lines[0]).toMatch(/\n$/);
  });

  it('infra outcome emits an immediate permanent line', () => {
    const clk = fakeClock(1000);
    // milestoneInterval: 100 so no milestone fires in this small test
    const tracker = new ProgressTracker(3, { isTTY: false, now: clk.now, milestoneInterval: 100 });
    const { write, lines } = collectLines();

    tracker.onPairStart('llm', 'doc-check', 'node:svc', write);
    tracker.onPairComplete('llm', 'doc-check', 'node:svc', 'infra', write);

    // 1 infra immediate line (no milestone at completion 1 with interval 100)
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('[llm] doc-check on node:svc — infra');
  });

  it('milestone line emitted when completed % milestoneInterval === 0', () => {
    const clk = fakeClock(0);
    // milestoneInterval of 2 → milestone at 2, 4, 6...
    const tracker = new ProgressTracker(8, { isTTY: false, now: clk.now, milestoneInterval: 2 });
    const { write, lines } = collectLines();

    // Complete 1 approved pair — no milestone (1 % 2 !== 0)
    tracker.onPairStart('det', 'a', 'node:x', write);
    tracker.onPairComplete('det', 'a', 'node:x', 'approved', write);
    expect(lines.length).toBe(0);

    // Complete 2nd approved pair — milestone fires (2 % 2 === 0)
    tracker.onPairStart('det', 'b', 'node:x', write);
    tracker.onPairComplete('det', 'b', 'node:x', 'approved', write);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/\.\.\. 2\/8 filled \(2 ok\)/);
    expect(lines[0]).toMatch(/\n$/);
  });

  it('milestone line includes refused and infra counts when non-zero', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(4, { isTTY: false, now: clk.now, milestoneInterval: 4 });
    const { write, lines } = collectLines();

    tracker.onPairStart('det', 'a', 'node:x', write);
    tracker.onPairComplete('det', 'a', 'node:x', 'approved', write);
    tracker.onPairStart('det', 'b', 'node:x', write);
    tracker.onPairComplete('det', 'b', 'node:x', 'refused', write); // immediate line + counts
    tracker.onPairStart('llm', 'c', 'node:x', write);
    tracker.onPairComplete('llm', 'c', 'node:x', 'infra', write);  // immediate line + counts
    tracker.onPairStart('det', 'd', 'node:x', write);
    tracker.onPairComplete('det', 'd', 'node:x', 'approved', write); // milestone at 4

    // 2 immediate lines (refused + infra) + 1 milestone
    // Immediate lines start with "  [" (pair prefix); milestone lines start with "..."
    const immediateLines = lines.filter(l => l.startsWith('  ['));
    const milestoneLines = lines.filter(l => l.includes('filled'));
    expect(immediateLines.length).toBe(2);
    expect(milestoneLines.length).toBe(1);
    expect(milestoneLines[0]).toContain('1 refused');
    expect(milestoneLines[0]).toContain('1 infra');
    expect(milestoneLines[0]).toContain('2 ok');
  });

  it('default milestoneInterval is 25% of total (min 1)', () => {
    const clk = fakeClock(0);
    // 8 total → 25% = 2 → interval of 2
    const tracker = new ProgressTracker(8, { isTTY: false, now: clk.now });
    const { write, lines } = collectLines();

    for (let i = 0; i < 8; i++) {
      tracker.onPairStart('det', `a${i}`, 'node:x', write);
      tracker.onPairComplete('det', `a${i}`, 'node:x', 'approved', write);
    }

    // Should have emitted at 2, 4, 6, 8 → 4 milestone lines
    const milestoneLines = lines.filter(l => l.includes('filled'));
    expect(milestoneLines.length).toBe(4);
  });

  it('still-working line emitted via onTick when no completion for > stillWorkingIntervalMs', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(5, { isTTY: false, now: clk.now, stillWorkingIntervalMs: 1000 });
    const { write, lines } = collectLines();

    // Start a pair but don't complete it
    tracker.onPairStart('llm', 'slow-aspect', 'node:svc', write);

    // Advance clock past the still-working threshold
    clk.advance(1001);

    // onTick triggers still-working check
    tracker.onTick(write);

    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/\.\.\. still working \(0\/5, waiting on slow-aspect on node:svc\)/);
    expect(lines[0]).toMatch(/\n$/);
  });

  it('still-working line not emitted if within interval', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(5, { isTTY: false, now: clk.now, stillWorkingIntervalMs: 1000 });
    const { write, lines } = collectLines();

    tracker.onPairStart('llm', 'slow-aspect', 'node:svc', write);
    clk.advance(500); // not past the threshold
    tracker.onTick(write);

    expect(lines.length).toBe(0);
  });

  it('still-working line resets lastCompletionTime to avoid repeated emissions on next tick', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(5, { isTTY: false, now: clk.now, stillWorkingIntervalMs: 1000 });
    const { write, lines } = collectLines();

    tracker.onPairStart('llm', 'slow-aspect', 'node:svc', write);
    clk.advance(1500);
    tracker.onTick(write); // emits still-working
    tracker.onTick(write); // should NOT re-emit (interval reset after first emission)

    const stillWorkingLines = lines.filter(l => l.includes('still working'));
    expect(stillWorkingLines.length).toBe(1);
  });

  it('still-working not emitted immediately after a completion (lastCompletionTime reset)', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(5, { isTTY: false, now: clk.now, stillWorkingIntervalMs: 1000 });
    const { write, lines } = collectLines();

    tracker.onPairStart('det', 'a', 'node:x', write);
    clk.advance(500);
    tracker.onPairComplete('det', 'a', 'node:x', 'approved', write); // lastCompletionTime = 500

    tracker.onPairStart('llm', 'slow-aspect', 'node:svc', write);
    clk.advance(600); // total 1100ms, but only 600ms since last completion
    tracker.onTick(write);

    const stillWorkingLines = lines.filter(l => l.includes('still working'));
    expect(stillWorkingLines.length).toBe(0);
  });

  it('non-TTY: clearLine is a no-op', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(3, { isTTY: false, now: clk.now });
    const { write, lines } = collectLines();
    tracker.clearLine(write);
    expect(lines.length).toBe(0);
  });

  it('5 pairs (1 refused), no per-approval lines, refused gets immediate line, milestone present', () => {
    const clk = fakeClock(0);
    // Use milestoneInterval=5 so milestone fires only at the 5th completion
    const tracker = new ProgressTracker(5, { isTTY: false, now: clk.now, milestoneInterval: 5 });
    const { write, lines } = collectLines();

    // 4 approved pairs (completions 1-4, no milestone yet)
    for (let i = 0; i < 4; i++) {
      tracker.onPairStart('det', `aspect-${i}`, `node:svc${i}`, write);
      tracker.onPairComplete('det', `aspect-${i}`, `node:svc${i}`, 'approved', write);
    }
    expect(lines.length).toBe(0); // no output yet

    // 1 refused pair (completion 5 → milestone fires after the refused immediate line)
    tracker.onPairStart('det', 'no-todo', 'node:orders', write);
    tracker.onPairComplete('det', 'no-todo', 'node:orders', 'refused', write);

    // Should have: 1 immediate refused line + 1 milestone at completion 5
    const refusedLines = lines.filter(l => l.includes('refused') && l.includes('[det]'));
    const milestoneLines = lines.filter(l => l.includes('filled'));
    expect(refusedLines.length).toBe(1);
    expect(refusedLines[0]).toContain('[det] no-todo on node:orders — refused');
    expect(milestoneLines.length).toBe(1);
    expect(milestoneLines[0]).toContain('4 ok');
    expect(milestoneLines[0]).toContain('1 refused');
  });
});

// ─── TTY mode tests ────────────────────────────────────────────────────────────

describe('ProgressTracker — TTY mode', () => {
  it('writes a \\r-terminated line on pair start', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(3, { isTTY: true, now: clk.now });
    const { write, lines } = collectLines();

    tracker.onPairStart('det', 'aspect-a', 'node:svc', write);

    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/\r$/);
    expect(lines[0]).not.toMatch(/\n/);
  });

  it('TTY line contains filling... with counters and current pair', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(5, { isTTY: true, now: clk.now });
    const { write, lines } = collectLines();

    tracker.onPairStart('det', 'aspect-a', 'node:svc', write);

    const line = lines[lines.length - 1];
    expect(line).toContain('filling...');
    expect(line).toContain('0/5');
    expect(line).toContain('aspect-a on node:svc');
    expect(line).toMatch(/\r$/);
  });

  it('approved pair in TTY mode: NO permanent line, updates the TTY line', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(3, { isTTY: true, now: clk.now });
    const { write, lines } = collectLines();

    tracker.onPairStart('det', 'aspect-a', 'node:svc', write);
    tracker.onPairComplete('det', 'aspect-a', 'node:svc', 'approved', write);

    // All lines should be \r-terminated (rewrite lines), no \n-terminated permanent lines
    const permanentLines = lines.filter(l => l.endsWith('\n'));
    expect(permanentLines.length).toBe(0);
  });

  it('refused pair in TTY mode: clears line, emits permanent line, then rewrites TTY line', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(3, { isTTY: true, now: clk.now });
    const { write, lines } = collectLines();

    tracker.onPairStart('det', 'no-todo', 'node:orders', write);
    tracker.onPairComplete('det', 'no-todo', 'node:orders', 'refused', write);

    // Should have: [start TTY line] [clear line] [refused permanent line] [new TTY line]
    const permanentLines = lines.filter(l => l.endsWith('\n'));
    const ttyLines = lines.filter(l => l.endsWith('\r') && !l.match(/^\r\s+\r$/));

    expect(permanentLines.length).toBe(1);
    expect(permanentLines[0]).toContain('[det] no-todo on node:orders — refused');
    expect(ttyLines.length).toBeGreaterThanOrEqual(1);
  });

  it('onTick in TTY mode rewrites the line (shows elapsed time)', () => {
    const clk = fakeClock(10000); // start at 10s
    const tracker = new ProgressTracker(3, { isTTY: true, now: clk.now });
    const { write, lines } = collectLines();

    tracker.onPairStart('det', 'aspect-a', 'node:svc', write);
    lines.length = 0; // clear start lines

    clk.advance(5000); // advance 5s
    tracker.onTick(write);

    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line).toMatch(/\r$/);
    expect(line).toContain('5s'); // elapsed seconds since start
  });

  it('clearLine in TTY mode writes a clear sequence starting with \\r', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(3, { isTTY: true, now: clk.now });
    const { write, lines } = collectLines();

    tracker.clearLine(write);

    expect(lines.length).toBe(1);
    // Should be the ANSI clear-to-EOL sequence: \r\x1b[2K
    expect(lines[0]).toBe('\r\x1b[2K');
  });

  it('onTick in TTY mode does NOT emit still-working lines', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(3, { isTTY: true, now: clk.now, stillWorkingIntervalMs: 100 });
    const { write, lines } = collectLines();

    tracker.onPairStart('llm', 'slow', 'node:svc', write);
    lines.length = 0;

    clk.advance(5000); // way past interval
    tracker.onTick(write);

    // Only one TTY rewrite line — no still-working line
    const stillWorkingLines = lines.filter(l => l.includes('still working'));
    expect(stillWorkingLines.length).toBe(0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/\r$/);
  });
});

// ─── State tracking tests ──────────────────────────────────────────────────────

describe('ProgressTracker — state tracking', () => {
  it('tracks approved, refused, infra counts correctly', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(6, { isTTY: false, now: clk.now, milestoneInterval: 100 });
    const { write } = collectLines();

    tracker.onPairStart('det', 'a', 'node:x', write);
    tracker.onPairComplete('det', 'a', 'node:x', 'approved', write);
    tracker.onPairStart('det', 'b', 'node:x', write);
    tracker.onPairComplete('det', 'b', 'node:x', 'refused', write);
    tracker.onPairStart('llm', 'c', 'node:x', write);
    tracker.onPairComplete('llm', 'c', 'node:x', 'infra', write);
    tracker.onPairStart('det', 'd', 'node:x', write);
    tracker.onPairComplete('det', 'd', 'node:x', 'approved', write);

    expect(tracker.state.approved).toBe(2);
    expect(tracker.state.refused).toBe(1);
    expect(tracker.state.infra).toBe(1);
    expect(tracker.state.completed).toBe(4);
  });

  it('currentPair updates on onPairStart', () => {
    const clk = fakeClock(0);
    const tracker = new ProgressTracker(3, { isTTY: false, now: clk.now });
    const { write } = collectLines();

    tracker.onPairStart('det', 'aspect-a', 'node:svc', write);
    expect(tracker.state.currentPair).toBe('aspect-a on node:svc');

    tracker.onPairStart('llm', 'aspect-b', 'node:orders', write);
    expect(tracker.state.currentPair).toBe('aspect-b on node:orders');
  });

  it('total is set from constructor', () => {
    const tracker = new ProgressTracker(42, { isTTY: false, now: Date.now });
    expect(tracker.state.total).toBe(42);
  });
});

// =============================================================================
// runPairPool — the bounded-concurrency worker pool that runs LLM pair fills
// with per-item throw isolation (core/fill-pool.ts, spec §7). Colocated here
// because both modules are shared fill-orchestration infra consumed by the
// same fill machinery this file already covers.
// =============================================================================

const okOutcome = (n: number): LlmFillOutcome => ({
  kind: 'verdict',
  entry: { hash: `h${n}` } as unknown as LlmFillOutcome extends { entry: infer E } ? E : never,
  callsMade: 1,
  votes: [],
});

describe('runPairPool', () => {
  it('runs every item and preserves input order in the results', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runPairPool(items, 2, async (n) => okOutcome(n));
    expect(results).toHaveLength(5);
    results.forEach((r, i) => {
      expect(r.kind).toBe('verdict');
      if (r.kind === 'verdict') expect((r.entry as unknown as { hash: string }).hash).toBe(`h${items[i]}`);
    });
  });

  it('converts a thrown Error into an infra outcome, isolated from siblings', async () => {
    const items = [1, 2, 3];
    const results = await runPairPool(items, 3, async (n) => {
      if (n === 2) throw new Error('boom');
      return okOutcome(n);
    });
    expect(results[0].kind).toBe('verdict');
    expect(results[1].kind).toBe('infra');
    expect(results[2].kind).toBe('verdict');
    if (results[1].kind === 'infra') {
      expect(results[1].why).toContain('boom');
      expect(results[1].callsMade).toBe(0);
      expect(results[1].messageData?.what).toContain('boom');
    }
  });

  it('converts a thrown non-Error value into an infra outcome via String(e)', async () => {
    const results = await runPairPool([1], 1, async () => {
      throw 'plain-string-boom';
    });
    expect(results[0].kind).toBe('infra');
    if (results[0].kind === 'infra') {
      expect(results[0].why).toContain('plain-string-boom');
    }
  });

  it('never runs more than `concurrency` items at once', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 6 }, (_, i) => i);
    await runPairPool(items, 2, async (n) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return okOutcome(n);
    });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(0);
  });

  it('clamps concurrency to at least 1 (a zero/negative concurrency still makes progress)', async () => {
    const results = await runPairPool([1, 2], 0, async (n) => okOutcome(n));
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.kind === 'verdict')).toBe(true);
  });

  it('returns an empty array for an empty item list (no division by zero on worker count)', async () => {
    const results = await runPairPool([], 4, async (n: never) => okOutcome(n));
    expect(results).toEqual([]);
  });
});
