// =============================================================================
// Unit — reading a proposal document another tool produced.
//
// The layering rule these cases exist to keep: a higher layer's conclusions must
// never arrive disguised as this graph's own. So a document is accepted only
// when it names a schema this build understands, only its documented fields are
// read, and the producer's evidence is kept VERBATIM. Everything else is refused
// with a message that says what is wrong with the DOCUMENT — the producing tool
// is what needs fixing, and a reader who cannot tell which item was malformed
// has no way to fix it.
//
// The second half is idempotence: handing the same document over twice must add
// nothing, while the same proposal measured again at a later commit is a new
// one, because the evidence behind it was taken again over code that has moved.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  parseGrainAdvice,
  partitionNewImports,
  importKey,
  GRAIN_ADVICE_SCHEMA,
  GRAIN_SOURCE,
} from '../../../src/core/advise-import.js';
import type { ImportedAdvice } from '../../../src/io/advise-imported-store.js';

const NOW = '2026-09-08T09:00:00.000Z';
const AT = 'f1e2d3c4b5a6978877665544332211000ffeeddc';

/** One well-formed item, with any field replaced to make a case. */
function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'relation',
    nodes: ['services/orders', 'services/payments'],
    evidence: { coChangeRatio: 0.82, commits: 41 },
    text: 'orders and payments change together in most commits',
    ...overrides,
  };
}

function doc(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: GRAIN_ADVICE_SCHEMA, at: AT, items: [item()], ...overrides });
}

/** The parse's records, or a failure if it refused — the happy path in one call. */
function records(text: string): ImportedAdvice[] {
  const outcome = parseGrainAdvice(text, NOW);
  if (!outcome.ok) throw new Error(`expected an accepted document, got: ${outcome.error.what}`);
  return outcome.records;
}

/** The refusal message, or a failure if the document was accepted. */
function refusal(text: string): { what: string; why: string; next: string } {
  const outcome = parseGrainAdvice(text, NOW);
  if (outcome.ok) throw new Error('expected the document to be refused');
  return outcome.error;
}

describe('reading a proposal document — what it accepts', () => {
  it('turns each item into a record under the producer name and the schema it arrived under', () => {
    const [record] = records(doc());

    expect(record.source).toBe(GRAIN_SOURCE);
    expect(record.schema).toBe(GRAIN_ADVICE_SCHEMA);
    expect(record.at).toBe(AT);
    expect(record.kind).toBe('relation');
    expect(record.nodes).toEqual(['services/orders', 'services/payments']);
    expect(record.text).toBe('orders and payments change together in most commits');
    // The importing command's own clock, injected — this module keeps none.
    expect(record.ts).toBe(NOW);
    expect(record.v).toBe(1);
  });

  it('keeps the producer’s evidence object verbatim, never re-derived or summarized', () => {
    const evidence = { sample: { files: ['a.ts', 'b.ts'] }, ratio: 0.5, note: 'measured over 200 commits' };
    const [record] = records(doc({ items: [item({ evidence })] }));
    expect(record.evidence).toEqual(evidence);
  });

  it('records an empty evidence object for an item that gave none, rather than a claim', () => {
    for (const evidence of [undefined, 'plenty', ['a'], null]) {
      const [record] = records(doc({ items: [item({ evidence })] }));
      expect(record.evidence).toEqual({});
    }
  });

  it('takes the two optional fields only when the producer really gave them', () => {
    const [full] = records(
      doc({ items: [item({ kind: 'split', nodes: ['services/orders'], candidates: ['a'], confidence: 0.7 })] }),
    );
    expect(full.candidates).toEqual(['a']);
    expect(full.confidence).toBe(0.7);

    // A candidate list that is not a list of names, and a confidence that is
    // not a finite number, are not fields — they are noise, and storing them
    // would put a value in the feed the producer never stated.
    const [bare] = records(
      doc({ items: [item({ candidates: 'a', confidence: Number.NaN })] }),
    );
    expect('candidates' in bare).toBe(false);
    expect('confidence' in bare).toBe(false);

    const [mixed] = records(doc({ items: [item({ candidates: ['a', 2] })] }));
    expect('candidates' in mixed).toBe(false);
  });

  it('accepts a document that measured at no commit, and one that names none at all', () => {
    for (const at of [null, '', undefined, 12]) {
      const [record] = records(doc({ at }));
      expect(record.at).toBeNull();
    }
  });

  it('accepts a run that found nothing, because an empty run still emits a document', () => {
    expect(records(doc({ items: [] }))).toEqual([]);
  });
});

describe('reading a proposal document — what it refuses, and how it says so', () => {
  it('refuses text that is not JSON, quoting the parse failure', () => {
    const error = refusal('{ not json');
    expect(error.what).toContain('not valid JSON');
    expect(error.next).toContain('--json');
  });

  it('refuses a top level that names neither a schema nor items', () => {
    for (const body of ['[]', '"a string"', '42', 'null']) {
      expect(refusal(body).what).toContain('not a JSON object');
    }
  });

  it('names the schema the document actually carried, and says which one it reads', () => {
    const named = refusal(doc({ schema: 'grain-advice/2' }));
    expect(named.what).toContain(`'grain-advice/2'`);
    expect(named.what).toContain(GRAIN_ADVICE_SCHEMA);

    // A document naming no schema at all says so in words rather than quoting
    // an empty string back at the reader.
    expect(refusal(doc({ schema: undefined })).what).toContain('nothing');
    expect(refusal(doc({ schema: 7 })).what).toContain('nothing');
  });

  it('refuses a document with no items list, and says an empty run still emits one', () => {
    const error = refusal(doc({ items: undefined }));
    expect(error.what).toContain(`no 'items' list`);
    expect(error.next).toContain('"items": []');
    expect(refusal(doc({ items: { first: item() } })).what).toContain(`no 'items' list`);
  });

  it('names the position of the malformed item, so the producing tool can be fixed', () => {
    // The index is the only handle a reader has on which item is wrong.
    expect(refusal(doc({ items: [item(), 'a string'] })).what).toContain('Item 1');
    expect(refusal(doc({ items: [item(), item(), null] })).what).toContain('Item 2');
  });

  it('refuses a kind the graph has no vocabulary for, and lists the ones it has', () => {
    const error = refusal(doc({ items: [item({ kind: 'wisdom' })] }));
    expect(error.what).toContain(`'wisdom'`);
    expect(error.next).toContain('relation, split, port, rule');

    // A kind that is not even a word is described as none rather than quoted.
    expect(refusal(doc({ items: [item({ kind: 9 })] })).what).toContain('has kind none');
  });

  it('refuses an item that names no components, because there is nothing to act on', () => {
    for (const nodes of [[], undefined, 'services/orders', ['services/orders', 4]]) {
      expect(refusal(doc({ items: [item({ nodes })] })).what).toContain('names no components');
    }
  });

  it('refuses an item with no sentence of its own, rather than writing one for the producer', () => {
    // Writing one here would blur what was measured with what was concluded.
    for (const text of [undefined, '', '   ', 5]) {
      const error = refusal(doc({ items: [item({ text })] }));
      expect(error.what).toContain('carries no text');
      expect(error.why).toContain('does not write one');
    }
  });
});

describe('importing the same proposal twice', () => {
  it('keys a proposal by its kind, its components and the commit it was measured at', () => {
    const key = importKey('relation', ['a', 'b'], AT);
    expect(importKey('relation', ['a', 'b'], AT)).toBe(key);
    expect(importKey('split', ['a', 'b'], AT)).not.toBe(key);
    expect(importKey('relation', ['b', 'a'], AT)).not.toBe(key);
    // Measured again at a LATER commit, the evidence was taken again over code
    // that has moved — so it is a new proposal, not the same one.
    expect(importKey('relation', ['a', 'b'], 'deadbeef')).not.toBe(key);
    // Naming no commit is one state, not several.
    expect(importKey('relation', ['a', 'b'], null)).toBe(importKey('relation', ['a', 'b'], null));
  });

  it('gives the same document the same keys however many times it is handed over', () => {
    expect(records(doc())[0].key).toBe(records(doc())[0].key);
  });

  it('holds back everything the register already has, and keeps the rest', () => {
    const held = records(doc());
    const incoming = records(doc({ items: [item(), item({ kind: 'port', nodes: ['services/payments'] })] }));

    const { fresh, alreadyHeld } = partitionNewImports(incoming, held);
    expect(alreadyHeld.map((r) => r.kind)).toEqual(['relation']);
    expect(fresh.map((r) => r.kind)).toEqual(['port']);
  });

  it('takes a proposal a document names twice exactly once', () => {
    // The second copy is already held the moment the first is taken.
    const incoming = records(doc({ items: [item(), item()] }));
    const { fresh, alreadyHeld } = partitionNewImports(incoming, []);
    expect(fresh).toHaveLength(1);
    expect(alreadyHeld).toHaveLength(1);
  });
});
