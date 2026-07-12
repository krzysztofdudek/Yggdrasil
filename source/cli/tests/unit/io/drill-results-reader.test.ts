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
