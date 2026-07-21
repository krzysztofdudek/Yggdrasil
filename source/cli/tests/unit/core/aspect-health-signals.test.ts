import { describe, it, expect } from 'vitest';
import type { Graph, AspectDef } from '../../../src/model/graph.js';
import type { VerdictEvent } from '../../../src/io/events-store.js';
import type { DrillResultLine } from '../../../src/io/drill-results-store.js';
import {
  computeAspectHealthSignals,
  computeAspectFalsePositiveSignals,
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

  it('an aggregate aspect (no own reviewer) is excluded from kind pooling but still gets its own raw signal', () => {
    const events = [
      fill('A', 'node:a', 'refused', 'h1'), // llm
      fill('AGG', 'node:agg', 'refused', 'h2'), // aggregate — must not join the llm pool
    ];
    const signals = computeAspectHealthSignals(
      graphOf(aspect('A', 'llm'), aspect('AGG', 'aggregate')),
      inputs({ verdictEvents: events }),
    );
    const agg = signals.get('AGG')!;
    // The aggregate's own raw counts are still tallied (kindStratum only governs
    // pooling, not per-aspect counting) ...
    expect(agg.catch).toBe(1);
    expect(agg.exposure).toBe(1);
    // ... but its point estimate is shrunk toward a base rate of 0 (never pooled
    // with any kind stratum), unlike a real llm/deterministic aspect.
    expect(agg.pointEstimate).toBeCloseTo(betaBinomialShrink(1, 1, 0), 10);
  });

  it('falls back to an empty-string hash when a fill event carries none (still one distinct triple)', () => {
    const events: VerdictEvent[] = [
      { v: 1, ts: '2026-07-01T00:00:00.000Z', source: 'fill', aspectId: 'A', unitKey: 'node:u1', kind: 'llm', disposition: 'refused' },
    ];
    const sig = computeAspectHealthSignals(graphOf(aspect('A')), inputs({ verdictEvents: events })).get('A')!;
    expect(sig.catch).toBe(1);
    expect(sig.exposure).toBe(1);
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

  it('ignores a different-aspect event and a non-fill-source event while scanning for a shrunk unit (still corroborates)', () => {
    const decoys: VerdictEvent[] = [
      fill('OTHER', 'node:zzz', 'approved', 'hz1'), // a different aspect — must be skipped
      { ...fill('A', 'node:detached', 'refused', 'ha-drill'), source: 'drill' }, // non-fill source — must be skipped
    ];
    const sig = computeAspectHealthSignals(
      graphOf(aspect('A'), aspect('OTHER')),
      inputs({ verdictEvents: [...decoys, ...decorativeEvents], currentUnitsByAspect: currentLive }),
    ).get('A')!;
    expect(sig.label).toBe('decorative?');
    expect(sig.demotionCorroborated).toBe(true);
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

  it('keeps the newest duplicate outcome even when it is NOT the last array element', () => {
    const newer: DrillResultLine = { ...passingDrill('A'), got: 'satisfied', ts: '2026-07-05T00:00:00.000Z' }; // MISS
    const olderPass: DrillResultLine = { ...passingDrill('A'), got: 'refused', ts: '2026-07-01T00:00:00.000Z' }; // pass, but OLDER
    // Array order: newer FIRST, older duplicate SECOND — array order must not
    // override recency by ts (the newer, still-a-MISS outcome wins).
    expect(computeDrillStatus('A', [newer, olderPass])).toBe('miss');
  });

  it('ignores a case whose expect is not "refused" (a satisfies-* case carries no deterrence evidence)', () => {
    const satisfiesCase: DrillResultLine = { ...passingDrill('A'), expect: 'satisfied', case: 'satisfies-x/ok' };
    expect(computeDrillStatus('A', [satisfiesCase])).toBe('none');
  });

  it('a refusal-expecting case that has not run yet contributes no deterrence evidence (neither miss nor proves-catch)', () => {
    const unrun: DrillResultLine = { ...passingDrill('A'), got: 'unrun' };
    expect(computeDrillStatus('A', [unrun])).toBe('none');
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

describe('computeAspectFalsePositiveSignals (fp — refusals later waived or overturned)', () => {
  /** A live-suppress coverage map: aspectId → covered unit keys. */
  function covered(entries: Record<string, string[]>): Map<string, Set<string>> {
    return new Map(Object.entries(entries).map(([id, units]) => [id, new Set(units)]));
  }

  it('(a) a refusal covered by a live suppress marker counts as a suppressed false block', () => {
    const events = [fill('A', 'node:u1', 'refused', 'h1', 'deterministic')];
    const sig = computeAspectFalsePositiveSignals(graphOf(aspect('A', 'deterministic')), {
      verdictEvents: events,
      suppressedUnitsByAspect: covered({ A: ['node:u1'] }),
    }).get('A')!;
    expect(sig.blocks).toBe(1);
    expect(sig.fp).toBe(1);
    expect(sig.suppressed).toBe(1);
    expect(sig.overturned).toBe(0);
  });

  it('(b) a refused→approved flip with a covering marker counts as an overturned false block', () => {
    const events = [
      fill('A', 'node:u1', 'refused', 'h1', 'deterministic', '2026-07-01T00:00:00.000Z'),
      fill('A', 'node:u1', 'approved', 'h2', 'deterministic', '2026-07-02T00:00:00.000Z'),
    ];
    const sig = computeAspectFalsePositiveSignals(graphOf(aspect('A', 'deterministic')), {
      verdictEvents: events,
      suppressedUnitsByAspect: covered({ A: ['node:u1'] }),
    }).get('A')!;
    expect(sig.blocks).toBe(1);
    expect(sig.fp).toBe(1);
    expect(sig.overturned).toBe(1);
    expect(sig.suppressed).toBe(0);
  });

  it('(c) a refusal that stays refused with NO covering marker is a block but not a false block', () => {
    const events = [fill('A', 'node:u1', 'refused', 'h1', 'deterministic')];
    const sig = computeAspectFalsePositiveSignals(graphOf(aspect('A', 'deterministic')), {
      verdictEvents: events,
      suppressedUnitsByAspect: new Map(),
    }).get('A')!;
    expect(sig.blocks).toBe(1);
    expect(sig.fp).toBe(0);
  });

  it('a refused→approved flip with NO covering marker is a genuine code fix, never a false block', () => {
    // The rule blocked, the code was fixed, the rule then passed — the rule working,
    // not a false block. Requiring the live marker is what excludes this.
    const events = [
      fill('A', 'node:u1', 'refused', 'h1', 'deterministic', '2026-07-01T00:00:00.000Z'),
      fill('A', 'node:u1', 'approved', 'h2', 'deterministic', '2026-07-02T00:00:00.000Z'),
    ];
    const sig = computeAspectFalsePositiveSignals(graphOf(aspect('A', 'deterministic')), {
      verdictEvents: events,
      suppressedUnitsByAspect: new Map(),
    }).get('A')!;
    expect(sig.blocks).toBe(1);
    expect(sig.fp).toBe(0);
    expect(sig.overturned).toBe(0);
  });

  it('an aspect that only ever approved has no block and an empty (blocks: 0) signal', () => {
    const events = [fill('A', 'node:u1', 'approved', 'h1', 'deterministic')];
    const sig = computeAspectFalsePositiveSignals(graphOf(aspect('A', 'deterministic')), {
      verdictEvents: events,
      suppressedUnitsByAspect: covered({ A: ['node:u1'] }),
    }).get('A')!;
    expect(sig.blocks).toBe(0);
    expect(sig.fp).toBe(0);
  });

  it('drill and diag events never count toward blocks (only source:fill)', () => {
    const events: VerdictEvent[] = [
      { v: 1, ts: '2026-07-01T00:00:00.000Z', source: 'drill', aspectId: 'A', unitKey: 'drill:A/case', kind: 'deterministic', disposition: 'refused', hash: 'h1' },
      { v: 1, ts: '2026-07-01T00:00:00.000Z', source: 'diag', aspectId: 'A', unitKey: 'node:u1', kind: 'deterministic', disposition: 'refused', hash: 'h2' },
    ];
    const sig = computeAspectFalsePositiveSignals(graphOf(aspect('A', 'deterministic')), {
      verdictEvents: events,
      suppressedUnitsByAspect: covered({ A: ['node:u1', 'drill:A/case'] }),
    }).get('A')!;
    expect(sig.blocks).toBe(0);
    expect(sig.fp).toBe(0);
  });

  it('the false-block rate is beta-binomial shrunk WITHIN kind — deterministic and LLM never pool', () => {
    // Deterministic stratum: aspect D blocks 10×, all 10 waived (raw rate 1.0).
    // LLM stratum: aspect L blocks once, waived once — its shrunk rate must be pulled
    // toward the LLM base rate (1.0 within its own kind here), NOT the det stratum.
    const detEvents = Array.from({ length: 10 }, (_, i) =>
      fill('D', `node:d${i}`, 'refused', `hd${i}`, 'deterministic'),
    );
    const llmEvents = [fill('L', 'node:l1', 'refused', 'hl1', 'llm')];
    const detCovered: Record<string, string[]> = { D: detEvents.map((_, i) => `node:d${i}`) };
    const graph = graphOf(aspect('D', 'deterministic'), aspect('L', 'llm'));
    const sigs = computeAspectFalsePositiveSignals(graph, {
      verdictEvents: [...detEvents, ...llmEvents],
      suppressedUnitsByAspect: covered({ ...detCovered, L: ['node:l1'] }),
    });
    const d = sigs.get('D')!;
    const l = sigs.get('L')!;
    // Det base rate = 10/10 = 1.0 → shrink(10,10,1.0) = (10+5)/(10+5) = 1.0.
    expect(d.shrunkRate).toBeCloseTo(betaBinomialShrink(10, 10, 1.0), 10);
    // LLM base rate = 1/1 = 1.0 (its OWN stratum) → shrink(1,1,1.0) = (1+5)/(1+5) = 1.0.
    expect(l.shrunkRate).toBeCloseTo(betaBinomialShrink(1, 1, 1.0), 10);
    // Thin-data flag keys on the block sample, not exposure.
    expect(l.thinData).toBe(true);
    expect(d.thinData).toBe(true); // 10 blocks < THIN_DATA_EXPOSURE (20)
  });

  it('the within-kind base rate does not leak across strata (a clean LLM rule stays near 0)', () => {
    // Deterministic rule D: 4 blocks, all waived (det base rate 1.0).
    // LLM rule L: 4 blocks, NONE waived → its shrunk rate must stay near 0 (pulled to
    // the LLM base rate of 0), proving the det stratum's 1.0 never bleeds in.
    const detEvents = Array.from({ length: 4 }, (_, i) => fill('D', `node:d${i}`, 'refused', `hd${i}`, 'deterministic'));
    const llmEvents = Array.from({ length: 4 }, (_, i) => fill('L', `node:l${i}`, 'refused', `hl${i}`, 'llm'));
    const sigs = computeAspectFalsePositiveSignals(graphOf(aspect('D', 'deterministic'), aspect('L', 'llm')), {
      verdictEvents: [...detEvents, ...llmEvents],
      suppressedUnitsByAspect: covered({ D: detEvents.map((_, i) => `node:d${i}`) }),
    });
    expect(sigs.get('L')!.fp).toBe(0);
    expect(sigs.get('L')!.shrunkRate).toBeCloseTo(0, 10); // shrink(0,4,0) = 0
  });

  it('a wildcard/whole-aspect marker is resolved by the boundary — the engine trusts the coverage map', () => {
    // The engine only sees the resolved coverage set; a pair absent from it is not a
    // false block even with a refusal on record.
    const events = [fill('A', 'node:u1', 'refused', 'h1', 'deterministic')];
    const sig = computeAspectFalsePositiveSignals(graphOf(aspect('A', 'deterministic')), {
      verdictEvents: events,
      suppressedUnitsByAspect: covered({ A: ['node:OTHER'] }),
    }).get('A')!;
    expect(sig.fp).toBe(0);
  });

  it('excludes an infra-class disposition from block/fp counting entirely', () => {
    const events: VerdictEvent[] = [
      fill('A', 'node:u1', 'refused', 'h1', 'deterministic'),
      { v: 1, ts: '2026-07-01T00:00:00.000Z', source: 'fill', aspectId: 'A', unitKey: 'node:u2', kind: 'deterministic', disposition: 'infra' },
    ];
    const sig = computeAspectFalsePositiveSignals(graphOf(aspect('A', 'deterministic')), {
      verdictEvents: events,
      suppressedUnitsByAspect: covered({ A: ['node:u1', 'node:u2'] }),
    }).get('A')!;
    expect(sig.blocks).toBe(1); // only the real refusal counts as a block
  });

  it('keeps the EARLIEST refusal timestamp when a later-processed refusal is not actually earlier', () => {
    const events = [
      fill('A', 'node:u1', 'refused', 'h1', 'deterministic', '2026-07-01T00:00:00.000Z'),
      fill('A', 'node:u1', 'refused', 'h2', 'deterministic', '2026-07-03T00:00:00.000Z'), // later — must not overwrite the earliest
      fill('A', 'node:u1', 'approved', 'h3', 'deterministic', '2026-07-02T00:00:00.000Z'), // between the two refusals
    ];
    const sig = computeAspectFalsePositiveSignals(graphOf(aspect('A', 'deterministic')), {
      verdictEvents: events,
      suppressedUnitsByAspect: covered({ A: ['node:u1'] }),
    }).get('A')!;
    expect(sig.blocks).toBe(1);
    // Overturned iff the TRUE earliest refusal (07-01) precedes the approval
    // (07-02). If the later refusal (07-03) had wrongly overwritten it, this
    // would misclassify as "suppressed" instead (07-03 does not precede 07-02).
    expect(sig.overturned).toBe(1);
    expect(sig.suppressed).toBe(0);
  });

  it('keeps the LATEST approval timestamp when a later-processed approval is not actually later', () => {
    const events = [
      fill('B', 'node:u2', 'approved', 'h1', 'deterministic', '2026-07-03T00:00:00.000Z'),
      fill('B', 'node:u2', 'approved', 'h2', 'deterministic', '2026-07-01T00:00:00.000Z'), // earlier — must not overwrite the latest
      fill('B', 'node:u2', 'refused', 'h3', 'deterministic', '2026-07-02T00:00:00.000Z'), // between the two approvals
    ];
    const sig = computeAspectFalsePositiveSignals(graphOf(aspect('B', 'deterministic')), {
      verdictEvents: events,
      suppressedUnitsByAspect: covered({ B: ['node:u2'] }),
    }).get('B')!;
    expect(sig.blocks).toBe(1);
    // Overturned iff the refusal (07-02) precedes the TRUE latest approval
    // (07-03). If the earlier approval (07-01) had wrongly become "latest", this
    // would misclassify as "suppressed" instead (07-02 does not precede 07-01).
    expect(sig.overturned).toBe(1);
    expect(sig.suppressed).toBe(0);
  });

  it('pools blocks across multiple aspects of the same kind (the second aspect reuses the pooled entry)', () => {
    const events = [
      fill('D1', 'node:d1', 'refused', 'h1', 'deterministic'),
      fill('D2', 'node:d2', 'refused', 'h2', 'deterministic'),
    ];
    const sigs = computeAspectFalsePositiveSignals(
      graphOf(aspect('D1', 'deterministic'), aspect('D2', 'deterministic')),
      {
        verdictEvents: events,
        suppressedUnitsByAspect: covered({ D1: ['node:d1'], D2: ['node:d2'] }),
      },
    );
    expect(sigs.get('D1')!.blocks).toBe(1);
    expect(sigs.get('D2')!.blocks).toBe(1);
    // Both are waived (fp) — pooled fp=2, blocks=2 → the shared det-stratum base
    // rate is 1.0, so both aspects' shrunk rates agree despite being different aspects.
    expect(sigs.get('D1')!.shrunkRate).toBeCloseTo(sigs.get('D2')!.shrunkRate, 10);
    expect(sigs.get('D1')!.shrunkRate).toBeCloseTo(betaBinomialShrink(1, 1, 1.0), 10);
  });

  it('an aggregate aspect is excluded from fp kind pooling but still gets its own raw signal', () => {
    const events = [fill('AGG', 'node:agg', 'refused', 'h1', 'deterministic')];
    const sig = computeAspectFalsePositiveSignals(graphOf(aspect('AGG', 'aggregate')), {
      verdictEvents: events,
      suppressedUnitsByAspect: covered({ AGG: ['node:agg'] }),
    }).get('AGG')!;
    expect(sig.blocks).toBe(1);
    expect(sig.fp).toBe(1);
    // Never pooled (base rate 0), unlike a real llm/deterministic aspect.
    expect(sig.shrunkRate).toBeCloseTo(betaBinomialShrink(1, 1, 0), 10);
  });
});
