/**
 * Unit tests for the fill-text formatter (src/formatters/fill-text.ts): the
 * words for every fill event the engine emits. The engine's own tests assert
 * WHEN an event fires; these pin what each one reads as.
 */
import { describe, it, expect } from 'vitest';
import { formatElapsed, renderFillEvent, textFillSink } from '../../../src/formatters/fill-text.js';
import type { FillOutcomeTotals } from '../../../src/model/fill-event.js';

const zeroTotals: FillOutcomeTotals = {
  reviewerCallsMade: 0, infraFailures: 0, runtimeErrors: 0, companionRuntimeErrors: 0, malformedSuppressErrors: 0,
  skippedLlmPairs: 0, skippedOutsideLlmPairs: 0, detApproved: 0, detRefused: 0, skippedByDetGate: 0,
};

describe('renderFillEvent', () => {
  it('dispatch: counts the pairs, the free script pairs and the reviewer-call budget, and names skipped paid work', () => {
    expect(renderFillEvent({ type: 'dispatch', counts: { fillPairs: 3, nodeCount: 2, fileCount: 0, detPairs: 3, reviewerCallBudget: 0, skippedLlmPairs: 0, skippedOutsideLlmPairs: 0 } }))
      .toBe('fill  3 pairs · 3 script (free) · 0 reviewer calls\n');
    const withSkipped = renderFillEvent({ type: 'dispatch', counts: { fillPairs: 4, nodeCount: 1, fileCount: 2, detPairs: 4, reviewerCallBudget: 0, skippedLlmPairs: 1, skippedOutsideLlmPairs: 0 } });
    expect(withSkipped).toBe('fill  4 pairs · 4 script (free) · 0 reviewer calls\nfill  1 reviewer pair left alone — script rules only this run\n');
  });

  it('dispatch: a fill with nothing to do says nothing', () => {
    expect(renderFillEvent({ type: 'dispatch', counts: { fillPairs: 0, nodeCount: 0, fileCount: 0, detPairs: 0, reviewerCallBudget: 0, skippedLlmPairs: 0, skippedOutsideLlmPairs: 0 } })).toBe('');
  });

  // A plain refusal gets no line of its own (the report lists it) and milestones
  // are gone; a pair that could not be judged still gets one, and so does a stall.
  it('pair outcome, milestone and still-working lines', () => {
    expect(renderFillEvent({ type: 'pair-outcome', lane: 'det', aspectId: 'no-todo', unitKey: 'node:app', verdict: 'refused' })).toBe('');
    expect(renderFillEvent({ type: 'pair-outcome', lane: 'det', aspectId: 'no-todo', unitKey: 'node:app', verdict: 'infra' }))
      .toBe('fill  not judged  no-todo @ app\n');
    expect(renderFillEvent({ type: 'milestone', counts: { completed: 4, total: 8, approved: 3, refused: 1, infra: 0 } })).toBe('');
    expect(renderFillEvent({ type: 'still-working', completed: 1, total: 2, currentPair: 'x on node:y' }))
      .toBe('fill  still working — 1/2, waiting on x @ y\n');
  });

  it('status: clears, truncates to the width with one column spare, returns the cursor', () => {
    const line = renderFillEvent({ type: 'status', counts: { completed: 1, total: 2, approved: 1, refused: 0, infra: 0 }, elapsedSeconds: 3, currentPair: 'a-very-long-aspect on node:a/very/long/path', columns: 30 });
    expect(line.startsWith('\r\u001b[2K')).toBe(true);
    expect(line.endsWith('\r')).toBe(true);
    const visible = line.slice('\r\u001b[2K'.length, -1);
    expect(visible.length).toBe(29);
    expect(visible.endsWith('…')).toBe(true);
  });

  it('totals: says what was done, and never claims every pair valid (a fill with nothing to do prints nothing)', () => {
    expect(renderFillEvent({ type: 'totals', totals: zeroTotals })).toBe('');
    expect(renderFillEvent({ type: 'totals', totals: { ...zeroTotals, detApproved: 2, detRefused: 1 } }))
      .toBe('fill  done — 2 approved · 1 refused · 0 failed · 0 reviewer calls\n');
    expect(renderFillEvent({ type: 'totals', totals: { ...zeroTotals, detApproved: 1, skippedLlmPairs: 24 } }))
      .toBe('fill  done — 1 approved · 0 refused · 0 failed · 0 reviewer calls · 24 reviewer pairs left alone\nnext: yg check --approve  (reviews the pairs left alone)\n');
  });

  // Issue 210 (m11): a run that called the reviewer used to end with no line at
  // all — no time, no tokens, no cost. It now ends with all three, as far as the
  // provider reported them.
  it('totals of a paid run: the calls, the elapsed time, and the reported tokens and cost', () => {
    // The engine always passes the tracker's outcome counts on a real run.
    const done = (n: number) => ({ completed: n, total: n, approved: n, refused: 0, infra: 0 });
    expect(renderFillEvent({ type: 'totals', totals: { ...zeroTotals, reviewerCallsMade: 4, outcomes: done(4) } }))
      .toBe('fill  done — 4 approved · 0 refused · 0 failed · 4 reviewer calls\n');
    expect(renderFillEvent({ type: 'totals', totals: { ...zeroTotals, reviewerCallsMade: 13, elapsedMs: 226_400, outcomes: done(13) } }))
      .toBe('fill  done in 3m46s — 13 approved · 0 refused · 0 failed · 13 reviewer calls\n');
    expect(renderFillEvent({
      type: 'totals',
      totals: { ...zeroTotals, reviewerCallsMade: 2, elapsedMs: 41_000, outcomes: done(2), usage: { reportedCalls: 2, inputTokens: 74_190, outputTokens: 912, costUsd: 0.0814 } },
    })).toBe('fill  done in 41s — 2 approved · 0 refused · 0 failed · 2 reviewer calls · 74,190 input / 912 output tokens, ~$0.08 at list price\n');
    // Not every call reported usage: the line says which ones it covers.
    expect(renderFillEvent({
      type: 'totals',
      totals: { ...zeroTotals, reviewerCallsMade: 3, elapsedMs: 3_700_000, outcomes: done(3), usage: { reportedCalls: 1, inputTokens: 10, outputTokens: 2 } },
    })).toBe('fill  done in 1h01m — 3 approved · 0 refused · 0 failed · 3 reviewer calls · 10 input / 2 output tokens (reported by 1 of 3 calls)\n');
  });

  it('formats elapsed time as a person reads it', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(59_400)).toBe('59s');
    expect(formatElapsed(60_000)).toBe('1m00s');
    expect(formatElapsed(7_260_000)).toBe('2h01m');
  });

  // Issue 210 (m14): an interrupted fill says what it kept and how to resume.
  it('interrupted: renders the engine\'s what / why / next', () => {
    const line = renderFillEvent({
      type: 'interrupted', saved: 3, total: 8, flushed: true,
      message: { what: 'Interrupted — 3 of 8 pairs have a verdict saved from this run.', why: 'A signal stopped the run.', next: 'Re-run: yg check --approve' },
    });
    expect(line).toBe('\r\u001b[2Kwarning: Interrupted — 3 of 8 pairs have a verdict saved from this run.\n  why:  A signal stopped the run.\nnext: Re-run: yg check --approve\n');
  });

  // Issue 209 (m13): a consensus split is visible where the pair is reported.
  it('pair-outcome carries a consensus split when the tier cast more than one vote', () => {
    expect(renderFillEvent({ type: 'pair-outcome', lane: 'llm', aspectId: 'a', unitKey: 'node:x', verdict: 'approved', votes: { satisfied: 2, total: 3 } }))
      .toBe('fill  approved by 2 of 3 votes  a @ x\n');
    // A unanimous refusal has no line of its own — the report lists it.
    expect(renderFillEvent({ type: 'pair-outcome', lane: 'llm', aspectId: 'a', unitKey: 'node:x', verdict: 'refused' })).toBe('');
  });

  it('dry run: headed as a preview, lists only what costs something, counts the free pairs', () => {
    const header = renderFillEvent({ type: 'dispatch', counts: { fillPairs: 2, nodeCount: 1, fileCount: 0, detPairs: 1, reviewerCallBudget: 2, skippedLlmPairs: 0, skippedOutsideLlmPairs: 0, preview: true } });
    expect(header.split('\n')[0]).toBe('fill  dry run — a cost preview; nothing is filled or written');
    // The budget line keeps the pair count, the free share and the reviewer-call budget.
    expect(header).toContain('fill  2 pairs · 1 script (free) · 2 reviewer calls (consensus included)\n');
    const dry = renderFillEvent({
      type: 'dry-run',
      nodes: [
        { nodePath: 'app', pairs: [{ lane: 'det', aspectId: 'a', unit: 'node:app' }, { lane: 'llm', aspectId: 'b', unit: 'node:app', reviewerCalls: 2 }] },
        { nodePath: 'lib', pairs: [{ lane: 'det', aspectId: 'a', unit: 'node:lib' }] },
      ],
      files: [],
      reviewerCallBudget: 2,
    });
    expect(dry).toContain('  b @ app — 2 reviewer calls\n');
    expect(dry).not.toContain('a @ app');
    expect(dry).not.toContain('lib');
    expect(dry).toContain('  2 script pairs — free, not listed\n');
    expect(dry).toContain('note: 2 reviewer calls is an upper bound');
  });

  it('a preview with nothing to price still says it is a preview, over the zero budget', () => {
    expect(renderFillEvent({ type: 'dispatch', counts: { fillPairs: 0, nodeCount: 0, fileCount: 0, detPairs: 0, reviewerCallBudget: 0, skippedLlmPairs: 0, skippedOutsideLlmPairs: 0, preview: true } }))
      .toBe('fill  dry run — a cost preview; nothing is filled or written\nfill  0 pairs · 0 script (free) · 0 reviewer calls\n');
  });

  // The closing line never claims validity at all now; with nothing filled it
  // prints nothing, and the report below lists the recorded refusal.
  it('the closing line never claims every pair valid while a recorded refusal still stands', () => {
    for (const cachedRefusals of [1, 3]) {
      const line = renderFillEvent({ type: 'totals', totals: { ...zeroTotals, cachedRefusals } });
      expect(line).toBe('');
      expect(line).not.toMatch(/valid/);
    }
  });

  it('prune: nothing when nothing was pruned, the noun agreeing with the count otherwise', () => {
    expect(renderFillEvent({ type: 'prune', entries: [], billedCount: 0, freeCount: 0, unknownCount: 0 })).toBe('');
    expect(renderFillEvent({ type: 'prune', entries: [{ aspectId: 'a', unitKey: 'node:x', kind: 'llm', reason: 'detached' }], billedCount: 1, freeCount: 0, unknownCount: 0 }))
      .toBe('fill  pruned 1 stale verdict (1 reviewer · 0 script)\n  a @ x — detached\n');
    expect(renderFillEvent({ type: 'prune', entries: [{ aspectId: 'a', unitKey: 'node:x', kind: 'deterministic', reason: 'detached' }, { aspectId: 'b', unitKey: 'file:src/y.ts', kind: 'unknown', reason: 'gone' }], billedCount: 0, freeCount: 1, unknownCount: 1 }))
      .toBe('fill  pruned 2 stale verdicts (0 reviewer · 1 script · 1 unknown)\n  a @ x — detached\n  b @ src/y.ts — gone\n');
  });

  it('textFillSink writes nothing for an event that reads as nothing', () => {
    const out: string[] = [];
    const sink = textFillSink((s) => { out.push(s); });
    sink({ type: 'prune', entries: [], billedCount: 0, freeCount: 0, unknownCount: 0 });
    sink({ type: 'clear-line' });
    expect(out).toEqual(['\r\u001b[2K']);
  });
});
