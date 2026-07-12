import { describe, it, expect } from 'vitest';
import { applyDecisions } from '../../../src/core/advise-feed.js';
import type { Nomination } from '../../../src/core/advise-nominations.js';
import type { AdviseDecision } from '../../../src/io/advise-decisions-store.js';

/** A live nomination fixture with a known evidence hash. */
function nom(id: string, evidenceHash: string, classRank = 10): Nomination {
  return {
    id,
    classRank,
    what: `what for ${id}`,
    why: `why for ${id}`,
    next: `next for ${id} This requires your approval.`,
    evidenceHash,
    evidenceTs: '2026-07-12T00:00:00.000Z',
  };
}

function decision(partial: Partial<AdviseDecision> & Pick<AdviseDecision, 'id' | 'action' | 'evidenceHash'>): AdviseDecision {
  return {
    v: 1,
    ts: '2026-07-12T00:00:00.000Z',
    reason: 'because',
    ...partial,
  };
}

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const TODAY = new Date('2026-07-12T00:00:00.000Z');

describe('applyDecisions — feed semantics', () => {
  it('a nomination with no decision is visible (returns as new)', () => {
    const noms = [nom('overdue-review-by:x', HASH)];
    const { visible, hidden } = applyDecisions(noms, [], TODAY);
    expect(visible.map((n) => n.id)).toEqual(['overdue-review-by:x']);
    expect(hidden).toEqual([]);
  });

  it('dismiss + same hash → hidden (surfaced only under --all)', () => {
    const noms = [nom('overdue-review-by:x', HASH)];
    const decisions = [decision({ id: 'overdue-review-by:x', action: 'dismiss', evidenceHash: HASH })];
    const { visible, hidden } = applyDecisions(noms, decisions, TODAY);
    expect(visible).toEqual([]);
    expect(hidden.map((n) => n.id)).toEqual(['overdue-review-by:x']);
  });

  it('dismiss with a STALE hash → nomination returns as new (visible)', () => {
    const noms = [nom('overdue-review-by:x', HASH)];
    // The decision was made against evidence that has since changed.
    const decisions = [decision({ id: 'overdue-review-by:x', action: 'dismiss', evidenceHash: OTHER_HASH })];
    const { visible, hidden } = applyDecisions(noms, decisions, TODAY);
    expect(visible.map((n) => n.id)).toEqual(['overdue-review-by:x']);
    expect(hidden).toEqual([]);
  });

  it('defer + same hash, BEFORE `until` → hidden', () => {
    const noms = [nom('orphaned-aspect:y', HASH)];
    const decisions = [
      decision({ id: 'orphaned-aspect:y', action: 'defer', evidenceHash: HASH, until: '2026-08-01' }),
    ];
    const { visible, hidden } = applyDecisions(noms, decisions, TODAY);
    expect(visible).toEqual([]);
    expect(hidden.map((n) => n.id)).toEqual(['orphaned-aspect:y']);
  });

  it('defer + same hash, ON `until` → returns with note "deferral elapsed"', () => {
    const noms = [nom('orphaned-aspect:y', HASH)];
    const decisions = [
      decision({ id: 'orphaned-aspect:y', action: 'defer', evidenceHash: HASH, until: '2026-07-12' }),
    ];
    const { visible, hidden } = applyDecisions(noms, decisions, TODAY);
    expect(hidden).toEqual([]);
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe('orphaned-aspect:y');
    expect(visible[0].note).toBe('deferral elapsed');
  });

  it('defer + same hash, AFTER `until` → returns with note "deferral elapsed"', () => {
    const noms = [nom('orphaned-aspect:y', HASH)];
    const decisions = [
      decision({ id: 'orphaned-aspect:y', action: 'defer', evidenceHash: HASH, until: '2026-01-01' }),
    ];
    const { visible } = applyDecisions(noms, decisions, TODAY);
    expect(visible.map((n) => [n.id, n.note])).toEqual([['orphaned-aspect:y', 'deferral elapsed']]);
  });

  it('done + same hash → hidden permanently', () => {
    const noms = [nom('dead-attach:z', HASH)];
    const decisions = [decision({ id: 'dead-attach:z', action: 'done', evidenceHash: HASH })];
    const { visible, hidden } = applyDecisions(noms, decisions, TODAY);
    expect(visible).toEqual([]);
    expect(hidden.map((n) => n.id)).toEqual(['dead-attach:z']);
  });

  it('the latest applying decision governs (a later dismiss overrides an earlier defer)', () => {
    const noms = [nom('overdue-review-by:x', HASH)];
    const decisions = [
      decision({ id: 'overdue-review-by:x', action: 'defer', evidenceHash: HASH, until: '2026-08-01', ts: '2026-07-01T00:00:00.000Z' }),
      decision({ id: 'overdue-review-by:x', action: 'dismiss', evidenceHash: HASH, ts: '2026-07-10T00:00:00.000Z' }),
    ];
    const { visible, hidden } = applyDecisions(noms, decisions, TODAY);
    expect(visible).toEqual([]);
    expect(hidden.map((n) => n.id)).toEqual(['overdue-review-by:x']);
  });

  it('handles a mixed feed, preserving input order within each bucket', () => {
    const noms = [
      nom('a', HASH, 10),
      nom('b', HASH, 20),
      nom('c', HASH, 30),
    ];
    const decisions = [
      decision({ id: 'a', action: 'dismiss', evidenceHash: HASH }),
      decision({ id: 'c', action: 'defer', evidenceHash: HASH, until: '2026-01-01' }),
    ];
    const { visible, hidden } = applyDecisions(noms, decisions, TODAY);
    // b never decided → visible; c's deferral elapsed → visible with note.
    expect(visible.map((n) => n.id)).toEqual(['b', 'c']);
    expect(visible.find((n) => n.id === 'c')?.note).toBe('deferral elapsed');
    // a dismissed → hidden.
    expect(hidden.map((n) => n.id)).toEqual(['a']);
  });
});
