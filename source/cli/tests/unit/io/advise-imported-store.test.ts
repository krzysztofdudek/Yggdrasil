// =============================================================================
// Unit — the committed register of proposals another tool handed this graph.
//
// It is the direct sibling of the decisions register beside it and keeps the
// same two promises. The WRITER is not best-effort: a caller that believes it
// recorded a proposal and did not would show a feed that silently loses what
// another tool measured. The READER is tolerant: a line this build cannot
// understand is counted and dropped, never thrown, so one hand-edited line or
// one written by a later version never blocks the whole feed.
//
// The third promise is what makes the register worth committing at all — every
// line keeps its producer, the schema it arrived under, the commit it was
// measured at, and the producer's evidence VERBATIM, so a reader can always
// tell what was measured from what this graph concluded.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  appendImported,
  readImported,
  importedPath,
  ADVISE_IMPORTED_FILENAME,
  IMPORTED_ADVICE_KINDS,
  type ImportedAdvice,
} from '../../../src/io/advise-imported-store.js';

/** A well-formed line, with any one field replaced to make a case. */
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
    evidence: { coChangeRatio: 0.82, commits: 41 },
    text: 'orders and payments change together in most commits',
    ...overrides,
  };
}

describe('the imported-proposals register — writing', () => {
  let yggRoot: string;
  beforeEach(() => {
    yggRoot = mkdtempSync(path.join(os.tmpdir(), 'yg-imported-store-'));
  });
  afterEach(() => {
    rmSync(yggRoot, { recursive: true, force: true });
  });

  it('appends one newline-terminated JSON line per proposal, in the order they arrived', async () => {
    const first = record();
    const second = record({ key: 'b'.repeat(64), kind: 'split', nodes: ['services/orders'] });
    await appendImported(yggRoot, first);
    await appendImported(yggRoot, second);

    const file = path.join(yggRoot, ADVISE_IMPORTED_FILENAME);
    expect(importedPath(yggRoot)).toBe(file);
    expect(existsSync(file)).toBe(true);

    const content = readFileSync(file, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
    const lines = content.split('\n').filter((l) => l !== '');
    expect(lines.map((l) => JSON.parse(l))).toEqual([first, second]);
  });

  it('keeps the producer, its schema, the commit and its evidence exactly as they arrived', async () => {
    // Nothing is re-derived here: that is what lets a reader tell what another
    // tool measured from what this graph concluded.
    const nested = record({ evidence: { sample: { files: ['a.ts', 'b.ts'] }, ratio: 0.5 } });
    await appendImported(yggRoot, nested);
    expect(readImported(yggRoot).imported[0].evidence).toEqual(nested.evidence);
  });

  it('reads a register that was never written as an empty one, not an error', () => {
    expect(readImported(yggRoot)).toEqual({ imported: [], skipped: 0 });
  });
});

describe('the imported-proposals register — reading tolerantly', () => {
  let yggRoot: string;
  beforeEach(() => {
    yggRoot = mkdtempSync(path.join(os.tmpdir(), 'yg-imported-read-'));
  });
  afterEach(() => {
    rmSync(yggRoot, { recursive: true, force: true });
  });

  function write(...lines: string[]): void {
    appendFileSync(importedPath(yggRoot), lines.map((l) => `${l}\n`).join(''), 'utf-8');
  }

  it('reads an absent `v` as the first line schema, and drops one a later build wrote', () => {
    const legacy = record();
    delete (legacy as Partial<ImportedAdvice>).v;
    write(JSON.stringify(legacy), JSON.stringify({ ...record(), v: 2 }));

    const result = readImported(yggRoot);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].v).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('drops a line that is not JSON, and one that is JSON but not an object', () => {
    write('not json at all', '[1,2,3]', '"a bare string"', JSON.stringify(record()));

    const result = readImported(yggRoot);
    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toBe(3);
  });

  it('ignores blank lines entirely rather than counting them as damage', () => {
    write('', JSON.stringify(record()), '   ');
    expect(readImported(yggRoot)).toMatchObject({ skipped: 0 });
    expect(readImported(yggRoot).imported).toHaveLength(1);
  });

  it('drops a record missing any field the feed renders from', () => {
    // Each of these would render as `undefined` somewhere in the feed, which is
    // worse than the line not being there at all.
    const damaged = [
      { ts: 1 },
      { key: null },
      { source: 42 },
      { schema: false },
      { text: undefined },
      { kind: 'wisdom' },
      { kind: 7 },
      { nodes: 'services/orders' },
      { nodes: ['services/orders', 3] },
      { evidence: ['a'] },
      { evidence: null },
      { at: 17 },
    ];
    write(...damaged.map((patch) => JSON.stringify({ ...record(), ...patch })));

    const result = readImported(yggRoot);
    expect(result.imported).toEqual([]);
    expect(result.skipped).toBe(damaged.length);
  });

  it('accepts every kind the graph has a vocabulary for, and a proposal measured at no commit', () => {
    for (const kind of IMPORTED_ADVICE_KINDS) write(JSON.stringify(record({ kind, at: null })));

    const result = readImported(yggRoot);
    expect(result.imported.map((r) => r.kind)).toEqual([...IMPORTED_ADVICE_KINDS]);
    expect(result.imported.every((r) => r.at === null)).toBe(true);
    expect(result.skipped).toBe(0);
  });

  it('keeps the two optional fields only when the producer really gave them', () => {
    write(
      JSON.stringify(record({ candidates: ['services/orders/pricing'], confidence: 0.7 })),
      // A confidence that is not a finite number is no confidence at all, and a
      // candidate list that is not a list of names is not a candidate list.
      JSON.stringify({ ...record(), candidates: 'services/orders/pricing', confidence: 'high' }),
      JSON.stringify({ ...record(), confidence: Number.POSITIVE_INFINITY }),
    );

    const [full, bare, infinite] = readImported(yggRoot).imported;
    expect(full.candidates).toEqual(['services/orders/pricing']);
    expect(full.confidence).toBe(0.7);
    expect('candidates' in bare).toBe(false);
    expect('confidence' in bare).toBe(false);
    expect('confidence' in infinite).toBe(false);
  });
});
