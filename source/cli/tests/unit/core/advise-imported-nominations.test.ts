// =============================================================================
// Unit — the attention items that came from OUTSIDE this graph.
//
// Every other nomination source derives its signal from the graph itself. This
// one carries somebody else's, and the whole point of keeping it in its own file
// is that a reader can see which is which. These cases pin the three properties
// that keep that separation honest on the feed:
//
//  - RANKED LAST. An outside proposal never pushes one of the graph's own
//    findings down the feed.
//  - QUOTED AS DATA. The producer's sentence, confidence and evidence are shown
//    under its name, never woven into an instruction to the agent reading it.
//  - IMPORTING IS NOT ACCEPTING. Every `next` is an act for the user to approve,
//    written in the graph's own terms rather than the producer's.
//
// The fourth is the evidence binding: an item's identity folds the producer's
// evidence, so a proposal measured again with a different result is a different
// item rather than the same one silently updated.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { importedNominations, importedAction } from '../../../src/core/advise-imported-nominations.js';
import { CLASS_RANK } from '../../../src/core/advise-nominations.js';
import type { ImportedAdvice } from '../../../src/io/advise-imported-store.js';

function record(overrides: Partial<ImportedAdvice> = {}): ImportedAdvice {
  return {
    v: 1,
    ts: '2026-09-02T00:00:00.000Z',
    key: 'a'.repeat(64),
    source: 'grain',
    schema: 'grain-advice/1',
    at: 'f1e2d3c4b5a6978877665544332211000ffeeddc',
    kind: 'relation',
    nodes: ['services/orders', 'services/payments'],
    evidence: { commits: 41 },
    text: 'orders and payments change together in most commits',
    ...overrides,
  };
}

function one(overrides: Partial<ImportedAdvice> = {}) {
  return importedNominations([record(overrides)])[0];
}

describe('an imported proposal on the feed', () => {
  it('ranks below everything this graph derives for itself', () => {
    // A suggestion from outside is something to weigh, never something that
    // pushes the graph's own findings down the list.
    const nomination = one();
    expect(nomination.classRank).toBe(CLASS_RANK.imported);
    for (const [name, rank] of Object.entries(CLASS_RANK)) {
      if (name !== 'imported') expect(rank).toBeLessThan(nomination.classRank);
    }
  });

  it('carries the producer, the commit and the proposal as quoted data under a name', () => {
    const nomination = one();
    expect(nomination.id).toBe(`imported:grain:${'a'.repeat(64)}`);
    expect(nomination.what).toContain('grain proposes (relation)');
    expect(nomination.what).toContain('orders and payments change together in most commits');
    // The commit is shortened for the feed but still identifies the measurement.
    expect(nomination.why).toContain('measured by grain at commit f1e2d3c4b5a6');
    expect(nomination.why).toContain('services/orders, services/payments');
    expect(nomination.why).toContain('not a finding of its own');
    expect(nomination.provenance).toEqual({ source: 'grain', at: record().at });
  });

  it('says outright when the producer named no commit, rather than showing an empty one', () => {
    const nomination = one({ at: null });
    expect(nomination.why).toContain('an unnamed commit');
    expect(nomination.provenance).toEqual({ source: 'grain', at: null });
  });

  it('shows a confidence only when the producer stated one', () => {
    expect(one({ confidence: 0.82 }).why).toContain('confidence 0.82.');
    expect(one().why).not.toContain('confidence');
  });

  it('renders the producer’s evidence as quoted key/value data, and says so when there is none', () => {
    const shown = one({ evidence: { commits: 41, ratio: 0.82 } });
    expect(shown.why).toContain('Its evidence: commits=41, ratio=0.82.');
    expect(one({ evidence: {} }).why).toContain('It gave no evidence.');
  });

  it('shows a nested evidence value as its own content, never as a placeholder word', () => {
    // Rendering a measured object through the language's own stringification
    // would show the reader the word "[object Object]" and nothing else.
    const nomination = one({ evidence: { sample: { b: 2, a: 1, c: [3, null] } } });
    expect(nomination.why).toContain('{"a":1,"b":2,"c":[3,null]}');
    expect(nomination.why).not.toContain('object Object');
  });

  it('stops after the first few evidence keys rather than dumping a whole measurement', () => {
    const evidence = Object.fromEntries(
      ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'].map((k, i) => [k, i]),
    );
    const why = one({ evidence }).why;
    expect(why).toContain('k6=5');
    expect(why).not.toContain('k7=');
  });

  it('ends every next step by noting that acting on it is the user’s own act', () => {
    // Importing was never accepting.
    for (const kind of ['relation', 'split', 'port', 'rule'] as const) {
      expect(one({ kind }).next).toContain('This requires your approval.');
    }
  });
});

describe('the action an imported proposal asks for, in the graph’s own terms', () => {
  it('asks about a dependency in one direction when the proposal names both ends', () => {
    const action = importedAction(record());
    expect(action).toContain('services/orders genuinely depends on services/payments');
    expect(action).toContain('declare the relation');
    // A dependency that carries an obligation is what a port is for.
    expect(action).toContain('port on services/payments');
  });

  it('falls back to asking whether the one named component has an undeclared dependency', () => {
    const action = importedAction(record({ nodes: ['services/orders'] }));
    expect(action).toBe(
      'Decide whether services/orders has an undeclared dependency, and declare the relation if it does.',
    );
  });

  it('names the pieces a split proposes, and asks for the seam to be real either way', () => {
    const named = importedAction(
      record({ kind: 'split', nodes: ['services/orders'], candidates: ['orders/pricing', 'orders/dispatch'] }),
    );
    expect(named).toContain('the proposal names orders/pricing and orders/dispatch');
    expect(named).toContain('split it only if the seam is real');

    for (const candidates of [undefined, []]) {
      const bare = importedAction(record({ kind: 'split', nodes: ['services/orders'], candidates }));
      expect(bare).toBe('Decide whether services/orders is really two things, and split it only if the seam is real.');
    }
  });

  it('asks whether a component publishes an obligation before giving it a port', () => {
    expect(importedAction(record({ kind: 'port', nodes: ['services/payments'] }))).toBe(
      'Decide whether services/payments publishes an obligation its consumers must satisfy, and give it a port if it does.',
    );
  });

  it('asks whether a proposed rule is worth writing, and offers a draft as the way in', () => {
    expect(importedAction(record({ kind: 'rule' }))).toContain('add it as a draft aspect');
  });
});

describe('what an imported item’s identity is bound to', () => {
  it('binds the item to the producer, the proposal and the evidence behind it', () => {
    const base = one();
    expect(one().evidenceHash).toBe(base.evidenceHash);
    expect(one({ evidence: { commits: 42 } }).evidenceHash).not.toBe(base.evidenceHash);
    expect(one({ source: 'other-tool' }).evidenceHash).not.toBe(base.evidenceHash);
    expect(one({ key: 'b'.repeat(64) }).evidenceHash).not.toBe(base.evidenceHash);
  });

  it('folds nested evidence by content, not by the order a producer happened to write it', () => {
    const first = one({ evidence: { outer: { b: 2, a: 1 }, list: [1, 2] } });
    const second = one({ evidence: { list: [1, 2], outer: { a: 1, b: 2 } } });
    expect(second.evidenceHash).toBe(first.evidenceHash);

    // Order within a LIST is content, not presentation.
    expect(one({ evidence: { list: [2, 1] } }).evidenceHash).not.toBe(
      one({ evidence: { list: [1, 2] } }).evidenceHash,
    );
  });

  it('carries the producer’s own timestamp as the item’s recency, not the reader’s clock', () => {
    expect(one({ ts: '2026-08-01T00:00:00.000Z' }).evidenceTs).toBe('2026-08-01T00:00:00.000Z');
  });

  it('nominates one item per proposal, in the order the register holds them', () => {
    const nominations = importedNominations([
      record({ key: 'a'.repeat(64) }),
      record({ key: 'b'.repeat(64), kind: 'rule' }),
    ]);
    expect(nominations.map((n) => n.id)).toEqual([
      `imported:grain:${'a'.repeat(64)}`,
      `imported:grain:${'b'.repeat(64)}`,
    ]);
  });
});
