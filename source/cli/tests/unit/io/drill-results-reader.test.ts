import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DRILL_RESULTS_FILENAME } from '../../../src/io/drill-results-store.js';
import { readDrillResults } from '../../../src/io/drill-results-reader.js';

/**
 * Reader tolerance (fail-open telemetry contract, mirroring the verdict-events
 * reader): the reader NEVER throws. A missing sidecar yields an empty result; an
 * unknown line-schema version, a non-JSON line, and a record missing a required
 * field are counted (`skipped`) and dropped. The rotated `.1` sidecar is read
 * BEFORE the current file so the merged stream stays in append (chronological)
 * order, and `firstTs` is the earliest accepted timestamp.
 */
describe('drill-results-reader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-drill-reader-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (name: string, lines: string[]): void => {
    writeFileSync(path.join(tmpDir, name), lines.join('\n') + '\n', 'utf-8');
  };

  const validLine = (ts: string, got = 'satisfied'): string =>
    JSON.stringify({
      v: 1,
      ts,
      aspect: 'requires-audit',
      case: 'violates-x/case',
      expect: 'refused',
      got,
      src: 'dev',
      corpus: 'dev',
      caseHash: 'c'.repeat(64),
      ruleHash: 'r'.repeat(64),
      kind: 'deterministic',
    });

  it('missing sidecar yields an empty, non-throwing result', () => {
    const r = readDrillResults(tmpDir);
    expect(r.results).toEqual([]);
    expect(r.skipped).toBe(0);
    expect(r.firstTs).toBeUndefined();
  });

  it('accepts valid lines and counts+drops unknown-v / non-JSON / mis-shaped', () => {
    const futureVersion = JSON.stringify({ ...JSON.parse(validLine('2026-07-01T00:00:01.000Z')), v: 99 });
    const nonJson = 'not json {';
    const misshaped = JSON.stringify({ v: 1, ts: '2026-07-01T00:00:02.000Z', aspect: 'a' }); // no expect/got/ruleHash
    const badGot = JSON.stringify({ ...JSON.parse(validLine('2026-07-01T00:00:03.000Z')), got: 'weird' });

    write(DRILL_RESULTS_FILENAME, [
      validLine('2026-07-01T00:00:00.000Z'),
      futureVersion,
      nonJson,
      misshaped,
      badGot,
    ]);

    const r = readDrillResults(tmpDir);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].aspect).toBe('requires-audit');
    expect(r.skipped).toBe(4);
    expect(r.firstTs).toBe('2026-07-01T00:00:00.000Z');
  });

  it('drops a line that parses as valid JSON but is not a plain object (array / primitive)', () => {
    // JSON.parse succeeds for these, but the result is not a record — a JSON
    // array or a bare primitive (number/string/bool/null) — so the shape guard
    // must drop it as a mis-shaped line, never crash on `.v` / `.ts` access.
    write(DRILL_RESULTS_FILENAME, [
      validLine('2026-07-01T00:00:00.000Z'),
      '[1, 2, 3]',
      '42',
      '"just a string"',
      'null',
    ]);
    const r = readDrillResults(tmpDir);
    expect(r.results).toHaveLength(1);
    expect(r.skipped).toBe(4);
  });

  it('drops a MISS-shaped line missing `case` (fail-open — counted skipped, never thrown)', () => {
    // A corrupted / partially-written local line: valid JSON, a real MISS (expect
    // refused, got satisfied), but NO `case` field. The nomination engine reads
    // line.case and passes it to quoteData — quoteData(undefined) throws — so the
    // reader must drop this line here, mirroring the rigor it applies to ts /
    // aspect / expect / got / ruleHash, rather than surface an unusable record.
    const noCase = JSON.stringify({
      v: 1,
      ts: '2026-07-01T00:00:05.000Z',
      aspect: 'requires-audit',
      expect: 'refused',
      got: 'satisfied',
      ruleHash: 'r'.repeat(64),
    });
    write(DRILL_RESULTS_FILENAME, [noCase, validLine('2026-07-01T00:00:06.000Z')]);
    const r = readDrillResults(tmpDir);
    // The case-less line is dropped; only the well-formed line survives, and no throw.
    expect(r.results).toHaveLength(1);
    expect(r.results[0].case).toBe('violates-x/case');
    expect(r.skipped).toBe(1);
  });

  it('drops a line whose `case` is present but not a string', () => {
    const nonStringCase = JSON.stringify({
      v: 1,
      ts: '2026-07-01T00:00:07.000Z',
      aspect: 'requires-audit',
      case: 42,
      expect: 'refused',
      got: 'satisfied',
      ruleHash: 'r'.repeat(64),
    });
    write(DRILL_RESULTS_FILENAME, [nonStringCase]);
    const r = readDrillResults(tmpDir);
    expect(r.results).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it('reads the rotated `.1` sidecar BEFORE the current file (chronological order)', () => {
    write(`${DRILL_RESULTS_FILENAME}.1`, [validLine('2026-06-01T00:00:00.000Z')]);
    write(DRILL_RESULTS_FILENAME, [validLine('2026-07-01T00:00:00.000Z')]);
    const r = readDrillResults(tmpDir);
    expect(r.results.map((l) => l.ts)).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ]);
    expect(r.firstTs).toBe('2026-06-01T00:00:00.000Z');
  });

  it('treats an absent `v` as v1 (forward tolerance)', () => {
    const noVersion = JSON.stringify({
      ts: '2026-07-01T00:00:00.000Z',
      aspect: 'a',
      case: 'c',
      expect: 'satisfied',
      got: 'satisfied',
      ruleHash: 'r'.repeat(64),
    });
    write(DRILL_RESULTS_FILENAME, [noVersion]);
    const r = readDrillResults(tmpDir);
    expect(r.results).toHaveLength(1);
    expect(r.skipped).toBe(0);
  });
});
