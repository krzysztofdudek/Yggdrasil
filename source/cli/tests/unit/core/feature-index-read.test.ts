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
import { readFeatureFieldEntry, countLiveDeviationFiles } from '../../../src/core/feature-index-read.js';
import { FEATURE_FIELD_FILENAME, FEATURE_FIELD_VERSION } from '../../../src/core/feature-field-schema.js';
import { hashString } from '../../../src/io/hash.js';

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

  it('returns null when EVERY deviation element is malformed (deviations: [1,2,3]), even on a hash match', () => {
    // Element-shape hardening: a corrupted deviations array that yields no well-formed
    // { dim: string, z: number } element can never feed a garbage dim/z to a consumer.
    writeIndexRaw(
      JSON.stringify({
        v: FEATURE_FIELD_VERSION,
        generatedAt: 'x',
        files: { [PATH]: { contentHash: HASH, family: FAMILY, deviations: [1, 2, 3] } },
      }),
    );
    expect(readFeatureFieldEntry(yggRoot, PATH, HASH)).toBeNull();
  });

  it('returns null when contentHash itself is not a string, even structurally otherwise-plausible', () => {
    writeIndexRaw(
      JSON.stringify({
        v: FEATURE_FIELD_VERSION,
        generatedAt: 'x',
        files: { [PATH]: { contentHash: 123, family: FAMILY, deviations: [{ dim: 'branch-like', z: 1 }] } },
      }),
    );
    expect(readFeatureFieldEntry(yggRoot, PATH, HASH)).toBeNull();
  });

  it('drops individual malformed deviation elements but keeps the well-formed ones', () => {
    writeIndexRaw(
      JSON.stringify({
        v: FEATURE_FIELD_VERSION,
        generatedAt: 'x',
        files: {
          [PATH]: {
            contentHash: HASH,
            family: FAMILY,
            // mix: valid, a scalar, missing z, missing dim, null, then valid again.
            deviations: [
              { dim: 'branch-like', z: 25.6 },
              5,
              { dim: 'call-like' },
              { z: 3 },
              null,
              { dim: 'node-count', z: 9.1 },
            ],
          },
        },
      }),
    );
    const entry = readFeatureFieldEntry(yggRoot, PATH, HASH);
    expect(entry).not.toBeNull();
    expect(entry?.deviations).toEqual([
      { dim: 'branch-like', z: 25.6 },
      { dim: 'node-count', z: 9.1 },
    ]);
  });
});

describe('countLiveDeviationFiles — aggregate live-outlier count (the yg advise C8 input)', () => {
  let projectRoot: string;
  let yggRootDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-ffcount-'));
    yggRootDir = path.join(projectRoot, '.yggdrasil');
    mkdirSync(yggRootDir, { recursive: true });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  const DEV = [{ dim: 'branch-like', z: 25.6 }];

  function writeSource(rel: string, content: string): void {
    const abs = path.join(projectRoot, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  function writeCountIndex(files: Record<string, unknown>): void {
    writeFileSync(
      path.join(yggRootDir, FEATURE_FIELD_FILENAME),
      JSON.stringify({ v: FEATURE_FIELD_VERSION, generatedAt: 'x', files }),
      'utf-8',
    );
  }

  it('counts only entries whose stored hash matches the file\'s current bytes (2 live + 1 stale → 2)', () => {
    const a = 'export const a = 1;\n';
    const b = 'export const b = 2;\n';
    const c = 'export const c = 3;\n';
    writeSource('src/a.ts', a);
    writeSource('src/b.ts', b);
    writeSource('src/c.ts', c);
    writeCountIndex({
      'src/a.ts': { contentHash: hashString(a), family: FAMILY, deviations: DEV }, // live
      'src/b.ts': { contentHash: hashString(b), family: FAMILY, deviations: DEV }, // live
      'src/c.ts': { contentHash: 'STALE-does-not-match', family: FAMILY, deviations: DEV }, // stale
    });
    expect(countLiveDeviationFiles(yggRootDir, projectRoot)).toBe(2);
  });

  it('does not count a listed file that no longer exists on disk', () => {
    const a = 'export const a = 1;\n';
    writeSource('src/a.ts', a);
    writeCountIndex({
      'src/a.ts': { contentHash: hashString(a), family: FAMILY, deviations: DEV },
      'src/gone.ts': { contentHash: hashString('whatever'), family: FAMILY, deviations: DEV },
    });
    expect(countLiveDeviationFiles(yggRootDir, projectRoot)).toBe(1);
  });

  it('does not count a structurally-broken entry even on a hash match', () => {
    const a = 'export const a = 1;\n';
    writeSource('src/a.ts', a);
    writeCountIndex({
      'src/a.ts': { contentHash: hashString(a), family: FAMILY, deviations: [1, 2, 3] }, // corrupt
    });
    expect(countLiveDeviationFiles(yggRootDir, projectRoot)).toBe(0);
  });

  it('returns 0 for a missing / garbled / unknown-version index (never throws)', () => {
    expect(countLiveDeviationFiles(yggRootDir, projectRoot)).toBe(0); // missing
    writeFileSync(path.join(yggRootDir, FEATURE_FIELD_FILENAME), 'not json {{{', 'utf-8');
    expect(countLiveDeviationFiles(yggRootDir, projectRoot)).toBe(0); // garbled
    writeFileSync(
      path.join(yggRootDir, FEATURE_FIELD_FILENAME),
      JSON.stringify({ v: FEATURE_FIELD_VERSION + 1, generatedAt: 'x', files: {} }),
      'utf-8',
    );
    expect(countLiveDeviationFiles(yggRootDir, projectRoot)).toBe(0); // unknown version
  });

  it('agrees with readFeatureFieldEntry — a file counts IFF the per-file lookup returns non-null', () => {
    const a = 'export const a = 1;\n';
    writeSource('src/a.ts', a);
    writeCountIndex({ 'src/a.ts': { contentHash: hashString(a), family: FAMILY, deviations: DEV } });

    // Live under the current bytes: both surfaces agree it is present.
    expect(readFeatureFieldEntry(yggRootDir, 'src/a.ts', hashString(a))).not.toBeNull();
    expect(countLiveDeviationFiles(yggRootDir, projectRoot)).toBe(1);

    // Mutate the bytes without rewriting the index: the per-file lookup goes silent
    // AND the count drops to 0 — the count can never disagree with the per-file line.
    const changed = a + '// changed\n';
    writeSource('src/a.ts', changed);
    expect(readFeatureFieldEntry(yggRootDir, 'src/a.ts', hashString(changed))).toBeNull();
    expect(countLiveDeviationFiles(yggRootDir, projectRoot)).toBe(0);
  });
});
