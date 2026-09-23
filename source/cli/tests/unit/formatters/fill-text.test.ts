/**
 * Unit tests for the fill-text formatter (src/formatters/fill-text.ts): the
 * words for every fill event the engine emits. The engine's own tests assert
 * WHEN an event fires; these pin what each one reads as.
 */
import { describe, it, expect } from 'vitest';
import { renderFillEvent, textFillSink } from '../../../src/formatters/fill-text.js';
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
    expect(renderFillEvent({ type: 'totals', totals: { ...zeroTotals, reviewerCallsMade: 4 } })).toBe('');
  });

  it('dry run and prune', () => {
    const dry = renderFillEvent({
      type: 'dry-run',
      nodes: [{ nodePath: 'app', pairs: [{ lane: 'det', aspectId: 'a', unit: 'node:app' }, { lane: 'llm', aspectId: 'b', unit: 'node:app', reviewerCalls: 2 }] }],
      files: [],
      reviewerCallBudget: 2,
    });
    expect(dry).toContain('  app\n    [det] a on node:app — free\n    [llm] b on node:app — 2 reviewer call(s)\n');
    expect(dry).toContain('2 reviewer call(s) is an UPPER BOUND');
    expect(renderFillEvent({ type: 'prune', entries: [], billedCount: 0, freeCount: 0, unknownCount: 0 })).toBe('');
    expect(renderFillEvent({ type: 'prune', entries: [{ aspectId: 'a', unitKey: 'node:x', kind: 'llm', reason: 'detached' }], billedCount: 1, freeCount: 0, unknownCount: 0 }))
      .toBe('Pruned 1 stale verdict(s) — 1 billed, 0 free:\n  [llm] a on node:x — detached\n');
  });

  it('textFillSink writes nothing for an event that reads as nothing', () => {
    const out: string[] = [];
    const sink = textFillSink((s) => { out.push(s); });
    sink({ type: 'prune', entries: [], billedCount: 0, freeCount: 0, unknownCount: 0 });
    sink({ type: 'clear-line' });
    expect(out).toEqual(['\r\u001b[2K']);
  });
});
