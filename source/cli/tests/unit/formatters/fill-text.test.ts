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
  it('dispatch: counts nodes, or components and files when a nodeless pair exists, and names skipped paid work', () => {
    expect(renderFillEvent({ type: 'dispatch', counts: { fillPairs: 3, nodeCount: 2, fileCount: 0, detPairs: 3, reviewerCallBudget: 0, skippedLlmPairs: 0, skippedOutsideLlmPairs: 0 } }))
      .toBe('Filling 3 unverified pairs across 2 nodes — 3 deterministic (no cost), 0 reviewer calls (consensus included)\n');
    const withFiles = renderFillEvent({ type: 'dispatch', counts: { fillPairs: 4, nodeCount: 1, fileCount: 2, detPairs: 4, reviewerCallBudget: 0, skippedLlmPairs: 1, skippedOutsideLlmPairs: 0 } });
    expect(withFiles).toContain('across 1 components and 2 files');
    expect(withFiles).toContain('Deterministic-only mode — 1 LLM pair will NOT be reviewed this run; run `yg check --approve` to review it.');
  });

  it('pair outcome, milestone and still-working lines', () => {
    expect(renderFillEvent({ type: 'pair-outcome', lane: 'det', aspectId: 'no-todo', unitKey: 'node:app', verdict: 'refused' }))
      .toBe('  [det] no-todo on node:app — refused\n');
    expect(renderFillEvent({ type: 'milestone', counts: { completed: 4, total: 8, approved: 3, refused: 1, infra: 0 } }))
      .toBe('... 4/8 filled (3 ok, 1 refused)\n');
    expect(renderFillEvent({ type: 'still-working', completed: 1, total: 2, currentPair: 'x on node:y' }))
      .toBe('... still working (1/2, waiting on x on node:y)\n');
  });

  it('status: clears, truncates to the width with one column spare, returns the cursor', () => {
    const line = renderFillEvent({ type: 'status', counts: { completed: 1, total: 2, approved: 1, refused: 0, infra: 0 }, elapsedSeconds: 3, currentPair: 'a-very-long-aspect on node:a/very/long/path', columns: 30 });
    expect(line.startsWith('\r\u001b[2K')).toBe(true);
    expect(line.endsWith('\r')).toBe(true);
    const visible = line.slice('\r\u001b[2K'.length, -1);
    expect(visible.length).toBe(29);
    expect(visible.endsWith('…')).toBe(true);
  });

  it('totals: says what was done, and claims every pair valid only when nothing was filled or skipped', () => {
    expect(renderFillEvent({ type: 'totals', totals: zeroTotals })).toBe('0 reviewer calls made — all expected pairs hold valid verdicts\n');
    expect(renderFillEvent({ type: 'totals', totals: { ...zeroTotals, detApproved: 2, detRefused: 1 } }))
      .toBe('0 reviewer calls made — 3 deterministic pairs filled (2 approved, 1 refused).\n');
  });

  // Issue 210 (m11): a run that called the reviewer used to end with no line at
  // all — no time, no tokens, no cost. It now ends with all three, as far as the
  // provider reported them.
  it('totals of a paid run: the calls, the elapsed time, and the reported tokens and cost', () => {
    expect(renderFillEvent({ type: 'totals', totals: { ...zeroTotals, reviewerCallsMade: 4 } })).toBe('4 reviewer calls made\n');
    expect(renderFillEvent({ type: 'totals', totals: { ...zeroTotals, reviewerCallsMade: 13, elapsedMs: 226_400 } }))
      .toBe('13 reviewer calls made in 3m46s\n');
    expect(renderFillEvent({
      type: 'totals',
      totals: { ...zeroTotals, reviewerCallsMade: 2, elapsedMs: 41_000, usage: { reportedCalls: 2, inputTokens: 74_190, outputTokens: 912, costUsd: 0.0814 } },
    })).toBe('2 reviewer calls made in 41s · 74,190 input / 912 output tokens, ~$0.08 at list price\n');
    // Not every call reported usage: the line says which ones it covers.
    expect(renderFillEvent({
      type: 'totals',
      totals: { ...zeroTotals, reviewerCallsMade: 3, elapsedMs: 3_700_000, usage: { reportedCalls: 1, inputTokens: 10, outputTokens: 2 } },
    })).toBe('3 reviewer calls made in 1h01m · 10 input / 2 output tokens (reported by 1 of 3 calls)\n');
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
    expect(line).toBe('\r\u001b[2KInterrupted — 3 of 8 pairs have a verdict saved from this run.\n  A signal stopped the run.\n  Re-run: yg check --approve\n');
  });

  // Issue 209 (m13): a consensus split is visible where the pair is reported.
  it('pair-outcome carries a consensus split when the tier cast more than one vote', () => {
    expect(renderFillEvent({ type: 'pair-outcome', lane: 'llm', aspectId: 'a', unitKey: 'node:x', verdict: 'approved', votes: { satisfied: 2, total: 3 } }))
      .toBe('  [llm] a on node:x — approved (consensus 2/3 satisfied)\n');
    expect(renderFillEvent({ type: 'pair-outcome', lane: 'llm', aspectId: 'a', unitKey: 'node:x', verdict: 'refused' }))
      .toBe('  [llm] a on node:x — refused\n');
  });

  it('dry run: headed as a preview, lists only what costs something, counts the free pairs', () => {
    const header = renderFillEvent({ type: 'dispatch', counts: { fillPairs: 2, nodeCount: 1, fileCount: 0, detPairs: 1, reviewerCallBudget: 2, skippedLlmPairs: 0, skippedOutsideLlmPairs: 0, preview: true } });
    expect(header.split('\n')[0]).toBe('Dry run — a cost preview: nothing below is filled or written.');
    // The budget sentence keeps the shape a budget parser reads.
    expect(header).toContain('Filling 2 unverified pairs across 1 nodes — 1 deterministic (no cost), 2 reviewer calls (consensus included)');
    const dry = renderFillEvent({
      type: 'dry-run',
      nodes: [
        { nodePath: 'app', pairs: [{ lane: 'det', aspectId: 'a', unit: 'node:app' }, { lane: 'llm', aspectId: 'b', unit: 'node:app', reviewerCalls: 2 }] },
        { nodePath: 'lib', pairs: [{ lane: 'det', aspectId: 'a', unit: 'node:lib' }] },
      ],
      files: [],
      reviewerCallBudget: 2,
    });
    expect(dry).toContain('  app\n    [llm] b on node:app — 2 reviewer calls\n');
    expect(dry).not.toContain('[det]');
    expect(dry).not.toContain('  lib\n');
    expect(dry).toContain('  2 deterministic pairs — free, not listed\n');
    expect(dry).toContain('This budget of 2 reviewer calls is an UPPER BOUND');
  });

  it('a preview with nothing to price still says it is a preview, over the zero budget', () => {
    expect(renderFillEvent({ type: 'dispatch', counts: { fillPairs: 0, nodeCount: 0, fileCount: 0, detPairs: 0, reviewerCallBudget: 0, skippedLlmPairs: 0, skippedOutsideLlmPairs: 0, preview: true } }))
      .toBe('Dry run — a cost preview: nothing below is filled or written.\nFilling 0 unverified pairs across 0 nodes — 0 deterministic (no cost), 0 reviewer calls (consensus included)\n');
  });

  it('the closing line never claims every pair valid while a recorded refusal still stands', () => {
    expect(renderFillEvent({ type: 'totals', totals: { ...zeroTotals, cachedRefusals: 1 } }))
      .toBe('0 reviewer calls made — nothing to fill; 1 recorded refusal still stands.\n');
    expect(renderFillEvent({ type: 'totals', totals: { ...zeroTotals, cachedRefusals: 3 } }))
      .toBe('0 reviewer calls made — nothing to fill; 3 recorded refusals still stand.\n');
  });

  it('prune: nothing when nothing was pruned, the noun agreeing with the count otherwise', () => {
    expect(renderFillEvent({ type: 'prune', entries: [], billedCount: 0, freeCount: 0, unknownCount: 0 })).toBe('');
    expect(renderFillEvent({ type: 'prune', entries: [{ aspectId: 'a', unitKey: 'node:x', kind: 'llm', reason: 'detached' }], billedCount: 1, freeCount: 0, unknownCount: 0 }))
      .toBe('Pruned 1 stale verdict — 1 billed, 0 free:\n  [llm] a on node:x — detached\n');
  });

  it('textFillSink writes nothing for an event that reads as nothing', () => {
    const out: string[] = [];
    const sink = textFillSink((s) => { out.push(s); });
    sink({ type: 'prune', entries: [], billedCount: 0, freeCount: 0, unknownCount: 0 });
    sink({ type: 'clear-line' });
    expect(out).toEqual(['\r\u001b[2K']);
  });
});
