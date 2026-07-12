import { describe, it, expect } from 'vitest';
import type { Graph, AspectDef } from '../../../src/model/graph.js';
import type { VerdictEvent } from '../../../src/io/events-store.js';
import type { DrillResultLine } from '../../../src/io/drill-results-store.js';
import {
  computeAspectHealthSignals,
  betaBinomialShrink,
  computeDrillStatus,
  covenantLine,
  groupUnitsByAspect,
  type AspectHealthSignalInputs,
} from '../../../src/core/aspect-health-signals.js';

// ---------------------------------------------------------------------------
// Pure signal engine — no disk, no clock. Synthetic telemetry is DATA (well-formed
// event / drill records), never a mocked module: exactly the shape the readers
// hand across the CLI boundary.
// ---------------------------------------------------------------------------

function aspect(id: string, kind: 'llm' | 'deterministic' | 'aggregate' = 'llm'): AspectDef {
  return { id, name: id, description: id, reviewer: { type: kind }, artifacts: [] } as AspectDef;
}

function graphOf(...aspects: AspectDef[]): Graph {
  return { aspects } as Graph;
}

function fill(
  aspectId: string,
  unitKey: string,
  disposition: VerdictEvent['disposition'],
  hash: string,
  kind: 'llm' | 'deterministic' = 'llm',
  ts = '2026-07-01T00:00:00.000Z',
): VerdictEvent {
  return { v: 1, ts, source: 'fill', aspectId, unitKey, kind, disposition, hash };
}

/** N fill events on one unit with DISTINCT hashes (N distinct triples): first `refused` refused, rest approved. */
function manyFills(
  aspectId: string,
  unitKey: string,
  refused: number,
  total: number,
  kind: 'llm' | 'deterministic' = 'llm',
): VerdictEvent[] {
  const out: VerdictEvent[] = [];
  for (let i = 0; i < total; i += 1) {
    out.push(fill(aspectId, unitKey, i < refused ? 'refused' : 'approved', `h${aspectId}-${i}`, kind));
  }
  return out;
}

function passingDrill(aspectId: string): DrillResultLine {
  return {
    v: 1,
    ts: '2026-07-01T00:00:00.000Z',
    aspect: aspectId,
    case: 'violates-x/must-catch',
    expect: 'refused',
    got: 'refused',
    src: 'dev',
    corpus: 'dev',
    caseHash: 'c'.repeat(64),
    ruleHash: 'r'.repeat(64),
    kind: 'llm',
  };
}

function inputs(over: Partial<AspectHealthSignalInputs>): AspectHealthSignalInputs {
  return {
    verdictEvents: [],
    drillResults: [],
    currentUnitsByAspect: new Map(),
    suppressCountsByAspect: new Map(),
    ...over,
  };
}

describe('catch / exposure counting', () => {
  it('a refused then (new-hash) approved history for one unit = 1 catch, 2 exposures', () => {
    const events = [
      fill('A', 'node:u1', 'refused', 'h1'),
      fill('A', 'node:u1', 'approved', 'h2'),
    ];
    const sig = computeAspectHealthSignals(graphOf(aspect('A')), inputs({ verdictEvents: events })).get('A')!;
    expect(sig.catch).toBe(1);
    expect(sig.exposure).toBe(2);
  });

  it('a duplicate (aspect, unit, hash) triple — a cached re-render — never double-counts', () => {
    const events = [
      fill('A', 'node:u1', 'refused', 'h1'),
      fill('A', 'node:u1', 'refused', 'h1'), // same triple: no new evidence
    ];
    const sig = computeAspectHealthSignals(graphOf(aspect('A')), inputs({ verdictEvents: events })).get('A')!;
    expect(sig.catch).toBe(1);
    expect(sig.exposure).toBe(1);
  });

  it('an infra-class disposition is excluded from BOTH catch and exposure', () => {
    const events: VerdictEvent[] = [
      fill('A', 'node:u1', 'approved', 'h1'),
      { v: 1, ts: '2026-07-01T00:00:00.000Z', source: 'fill', aspectId: 'A', unitKey: 'node:u2', kind: 'llm', disposition: 'infra' },
    ];
    const sig = computeAspectHealthSignals(graphOf(aspect('A')), inputs({ verdictEvents: events })).get('A')!;
    expect(sig.catch).toBe(0);
    expect(sig.exposure).toBe(1); // only the approved opportunity counts
  });

  it('a drill-source event is excluded (source filter — regimes never mix)', () => {
    const events: VerdictEvent[] = [
      fill('A', 'node:u1', 'approved', 'h1'),
      { v: 1, ts: '2026-07-01T00:00:00.000Z', source: 'drill', aspectId: 'A', unitKey: 'node:u2', kind: 'llm', disposition: 'refused', hash: 'hd' },
    ];
    const sig = computeAspectHealthSignals(graphOf(aspect('A')), inputs({ verdictEvents: events })).get('A')!;
    expect(sig.catch).toBe(0);
    expect(sig.exposure).toBe(1);
  });

  it('kind strata are counted independently: an LLM aspect and a deterministic aspect never pool', () => {
    // Same raw rate (1/2) on each aspect, but the LLM pool and the det pool have
    // DIFFERENT base rates, so the shrunk estimates diverge.
    const graph = graphOf(aspect('A', 'llm'), aspect('C', 'llm'), aspect('B', 'deterministic'), aspect('D', 'deterministic'));
    const events = [
      ...manyFills('A', 'node:a', 1, 2, 'llm'), // llm: 1/2
      ...manyFills('C', 'node:c', 8, 10, 'llm'), // llm: 8/10  → pool llm = 9/12
      ...manyFills('B', 'node:b', 1, 2, 'deterministic'), // det: 1/2
      ...manyFills('D', 'node:d', 0, 10, 'deterministic'), // det: 0/10 → pool det = 1/12
    ];
    const signals = computeAspectHealthSignals(graph, inputs({ verdictEvents: events }));
    const a = signals.get('A')!;
    const b = signals.get('B')!;

    expect(a.catch).toBe(1);
    expect(a.exposure).toBe(2);
    expect(b.catch).toBe(1);
    expect(b.exposure).toBe(2);

    // Each is shrunk toward its OWN kind's pooled base rate — verbatim closed form.
    expect(a.pointEstimate).toBeCloseTo(betaBinomialShrink(1, 2, 9 / 12), 10);
    expect(b.pointEstimate).toBeCloseTo(betaBinomialShrink(1, 2, 1 / 12), 10);

    // Identical raw rate (0.5), different strata ⇒ different estimates; neither is the raw rate.
    expect(a.pointEstimate).not.toBeCloseTo(b.pointEstimate, 6);
    expect(a.pointEstimate).not.toBeCloseTo(0.5, 6);
  });
});

describe('shrinkage + label + covenant', () => {
  it('high exposure + zero catches → label decorative?; passing drills give the verbatim covenant line', () => {
    const events = manyFills('A', 'node:live', 0, 20); // 0/20 — decorative?
    const drills = [passingDrill('A')];
    const sig = computeAspectHealthSignals(
      graphOf(aspect('A')),
      inputs({ verdictEvents: events, drillResults: drills, currentUnitsByAspect: new Map([['A', new Set(['node:live'])]]) }),
    ).get('A')!;

    expect(sig.label).toBe('decorative?');
    expect(sig.uncertaintyWide).toBe(false); // 20 observations is not thin
    // Anti-Goodhart covenant: drills prove it still catches → it may be deterring.
    expect(computeDrillStatus('A', drills)).toBe('proves-catch');
    expect(covenantLine(computeDrillStatus('A', drills))).toBe(
      'enforceable but never violated — may be deterring violations',
    );
    // A rule proven to still catch is NOT a demotion candidate.
    expect(sig.demotionCorroborated).toBe(false);
  });

  it('a thin sample flags uncertaintyWide (plain-words "few observations" range)', () => {
    const events = manyFills('A', 'node:u', 1, 3); // 1/3 — thin
    const sig = computeAspectHealthSignals(graphOf(aspect('A')), inputs({ verdictEvents: events })).get('A')!;
    expect(sig.label).toBe('active');
    expect(sig.exposure).toBe(3);
    expect(sig.uncertaintyWide).toBe(true);
  });

  it('a never-exercised aspect reads quiet with a zero/zero signal', () => {
    const sig = computeAspectHealthSignals(graphOf(aspect('A')), inputs({})).get('A')!;
    expect(sig).toMatchObject({ catch: 0, exposure: 0, label: 'quiet', uncertaintyWide: false, demotionCorroborated: false });
  });
});

describe('demotionCorroborated — true ONLY when all three independent signals agree', () => {
  // A decorative-looking rule (0/20), detached from a unit it once covered, with
  // no drills and no suppress waiver → all three corroborating signals hold.
  const decorativeEvents = manyFills('A', 'node:detached', 0, 20); // history is on a now-detached unit
  const currentLive = new Map([['A', new Set(['node:live'])]]); // still applies, but not on node:detached → shrinking

  it('is true when there are no drills AND the attach set is shrinking AND no suppress history', () => {
    const sig = computeAspectHealthSignals(
      graphOf(aspect('A')),
      inputs({ verdictEvents: decorativeEvents, currentUnitsByAspect: currentLive }),
    ).get('A')!;
    expect(sig.label).toBe('decorative?');
    expect(sig.demotionCorroborated).toBe(true);
  });

  it('is false when a regression drill exists (it deters — do not demote)', () => {
    const sig = computeAspectHealthSignals(
      graphOf(aspect('A')),
      inputs({ verdictEvents: decorativeEvents, currentUnitsByAspect: currentLive, drillResults: [passingDrill('A')] }),
    ).get('A')!;
    expect(sig.demotionCorroborated).toBe(false);
  });

  it('is false when the attach set is stable (no detached unit)', () => {
    const stable = new Map([['A', new Set(['node:detached', 'node:live'])]]); // current covers the historical unit
    const sig = computeAspectHealthSignals(
      graphOf(aspect('A')),
      inputs({ verdictEvents: decorativeEvents, currentUnitsByAspect: stable }),
    ).get('A')!;
    expect(sig.demotionCorroborated).toBe(false);
  });

  it('is false when a suppress waiver is on record (something was worth waiving)', () => {
    const sig = computeAspectHealthSignals(
      graphOf(aspect('A')),
      inputs({ verdictEvents: decorativeEvents, currentUnitsByAspect: currentLive, suppressCountsByAspect: new Map([['A', 1]]) }),
    ).get('A')!;
    expect(sig.demotionCorroborated).toBe(false);
  });

  it('is false for a merely-quiet rule (thin data is not a decorative reading)', () => {
    const thin = manyFills('A', 'node:detached', 0, 3); // 0/3 — quiet, not decorative
    const sig = computeAspectHealthSignals(
      graphOf(aspect('A')),
      inputs({ verdictEvents: thin, currentUnitsByAspect: currentLive }),
    ).get('A')!;
    expect(sig.label).toBe('quiet');
    expect(sig.demotionCorroborated).toBe(false);
  });
});

describe('computeDrillStatus / covenantLine', () => {
  it('a refusal-expecting case that is no longer caught is a MISS (weakening wording)', () => {
    const miss: DrillResultLine = { ...passingDrill('A'), got: 'satisfied' };
    expect(computeDrillStatus('A', [miss])).toBe('miss');
    expect(covenantLine('miss')).toContain('may be weakening');
  });
  it('no informative drill outcome is "none" (value unconfirmed)', () => {
    expect(computeDrillStatus('A', [])).toBe('none');
    expect(covenantLine('none')).toContain('unconfirmed');
  });
  it('keeps only the latest outcome per case (a fixed MISS no longer dominates)', () => {
    const oldMiss: DrillResultLine = { ...passingDrill('A'), got: 'satisfied', ts: '2026-06-01T00:00:00.000Z' };
    const laterPass: DrillResultLine = { ...passingDrill('A'), got: 'refused', ts: '2026-07-02T00:00:00.000Z' };
    expect(computeDrillStatus('A', [oldMiss, laterPass])).toBe('proves-catch');
  });
});

describe('groupUnitsByAspect', () => {
  it('folds pairs into a set of unit keys per aspect', () => {
    const grouped = groupUnitsByAspect([
      { aspectId: 'A', unitKey: 'node:x' },
      { aspectId: 'A', unitKey: 'node:y' },
      { aspectId: 'B', unitKey: 'node:x' },
    ]);
    expect([...grouped.get('A')!].sort()).toEqual(['node:x', 'node:y']);
    expect([...grouped.get('B')!]).toEqual(['node:x']);
  });
});
