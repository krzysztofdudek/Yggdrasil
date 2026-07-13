/**
 * Unit tests for the feature-field index READER (core/feature-index-read.ts).
 *
 * Pins the "strict contentHash-match-or-omit, tolerant of an absent/garbled index"
 * contract: the reader returns an entry ONLY on an exact content-hash match, and
 * resolves every other case (missing file, bad JSON, unknown version, no entry,
 * hash mismatch, garbled record) to `null` WITHOUT throwing. This is the contract
 * both `yg context --file` and (later) `yg advise` rely on to count live outliers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFeatureFieldEntry } from '../../../src/core/feature-index-read.js';
import { FEATURE_FIELD_FILENAME, FEATURE_FIELD_VERSION } from '../../../src/core/feature-field-schema.js';

let yggRoot: string;

beforeEach(() => {
  yggRoot = mkdtempSync(path.join(tmpdir(), 'yg-ffread-'));
});
afterEach(() => rmSync(yggRoot, { recursive: true, force: true }));

/** Write raw text as the on-disk index at <yggRoot>/.feature-field.json. */
function writeIndexRaw(text: string): void {
  mkdirSync(yggRoot, { recursive: true });
  writeFileSync(path.join(yggRoot, FEATURE_FIELD_FILENAME), text, 'utf-8');
}

const HASH = 'abc123def456';
const PATH = 'src/svc/outlier.ts';
const FAMILY = 'svc\x00typescript';

/** A well-formed index with one entry for PATH at content hash HASH. */
function writeValidIndex(hash = HASH): void {
  writeIndexRaw(
    JSON.stringify({
      v: FEATURE_FIELD_VERSION,
      generatedAt: '2026-01-01T00:00:00.000Z',
      files: {
        [PATH]: { contentHash: hash, family: FAMILY, deviations: [{ dim: 'branch-like', z: 25.6 }] },
      },
    }),
  );
}

describe('readFeatureFieldEntry — match-or-omit', () => {
  it('returns the entry on an exact content-hash match', () => {
    writeValidIndex();
    const entry = readFeatureFieldEntry(yggRoot, PATH, HASH);
    expect(entry).not.toBeNull();
    expect(entry?.family).toBe(FAMILY);
    expect(entry?.deviations).toEqual([{ dim: 'branch-like', z: 25.6 }]);
  });

  it('returns null when the stored hash does not match (stale index never speaks)', () => {
    writeValidIndex('STORED-hash');
    expect(readFeatureFieldEntry(yggRoot, PATH, 'CURRENT-different-hash')).toBeNull();
  });

  it('returns null when there is no entry for the requested path', () => {
    writeValidIndex();
    expect(readFeatureFieldEntry(yggRoot, 'src/svc/other.ts', HASH)).toBeNull();
  });
});

describe('readFeatureFieldEntry — tolerant of an absent/garbled index (never throws)', () => {
  it('returns null when the index file is missing', () => {
    expect(readFeatureFieldEntry(yggRoot, PATH, HASH)).toBeNull();
  });

  it('returns null on non-JSON content', () => {
    writeIndexRaw('this is not json {{{');
    expect(readFeatureFieldEntry(yggRoot, PATH, HASH)).toBeNull();
  });

  it('returns null on an unknown schema version', () => {
    writeIndexRaw(
      JSON.stringify({
        v: FEATURE_FIELD_VERSION + 1,
        generatedAt: 'x',
        files: { [PATH]: { contentHash: HASH, family: FAMILY, deviations: [] } },
      }),
    );
    expect(readFeatureFieldEntry(yggRoot, PATH, HASH)).toBeNull();
  });

  it('returns null when the top-level JSON is not an object (array / null / scalar)', () => {
    for (const raw of ['[]', 'null', '42', '"a string"']) {
      writeIndexRaw(raw);
      expect(readFeatureFieldEntry(yggRoot, PATH, HASH)).toBeNull();
    }
  });

  it('returns null when files is missing or not an object', () => {
    writeIndexRaw(JSON.stringify({ v: FEATURE_FIELD_VERSION, generatedAt: 'x' }));
    expect(readFeatureFieldEntry(yggRoot, PATH, HASH)).toBeNull();
    writeIndexRaw(JSON.stringify({ v: FEATURE_FIELD_VERSION, generatedAt: 'x', files: 'nope' }));
    expect(readFeatureFieldEntry(yggRoot, PATH, HASH)).toBeNull();
  });

  it('returns null on a garbled record (family not a string / deviations not an array), even on a hash match', () => {
    writeIndexRaw(
      JSON.stringify({
        v: FEATURE_FIELD_VERSION,
        generatedAt: 'x',
        files: { [PATH]: { contentHash: HASH, family: 42, deviations: 'nope' } },
      }),
    );
    expect(readFeatureFieldEntry(yggRoot, PATH, HASH)).toBeNull();
  });
});
