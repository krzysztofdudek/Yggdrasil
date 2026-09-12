import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

import type { LockFile } from '../../../src/model/lock.js';
import {
  LOCK_FORMAT_VERSION,
  LOCK_FILE_NAME,
  LOCK_NONDET_FILE_NAME,
  LOCK_LOGS_FILE_NAME,
  LOCK_DET_FILE_NAME,
} from '../../../src/model/lock.js';

import {
  readLock,
  readLegacyLock,
  readDetLockAspectIds,
  writeLock,
  serializeLock,
  LockInvalidError,
} from '../../../src/io/lock-store.js';
import { initDebugLog, _resetForTesting } from '../../../src/utils/debug-log.js';

// The verdict lock is split across a 3-file triad; the in-memory LockFile stays unified.
// writeLock partitions verdicts by aspect KIND (deterministicAspectIds), never by `touched`.
// These helpers keep the legacy single-lock tests readable under the new API.
const EMPTY_DET = new Set<string>();
/** writeLock(scope:'all') with an explicit deterministic-aspect set (default: none → all LLM). */
async function writeAll(dir: string, lock: LockFile, detIds: Set<string> = EMPTY_DET): Promise<void> {
  await writeLock(dir, lock, { scope: 'all', deterministicAspectIds: detIds });
}

afterEach(async () => {
  const entries = await readdir(FIXTURES_DIR).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((e) => e.startsWith('tmp-lock-'))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

describe('lock-store', () => {
  it('readLock returns empty lock when files absent', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-absent');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const result = readLock(tmpDir);
    expect(result).toEqual({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} });
  });

  it('writeLock + readLock roundtrip preserves entries and nodes', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-roundtrip');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'my-aspect': {
          'node:billing/cancel': { verdict: 'approved', hash: 'abc123' },
          'node:billing/notify': {
            verdict: 'refused',
            hash: 'def456',
            reason: 'missing log',
            touched: [['read:src/shared/codes.ts', 'sha-xyz']],
          },
        },
      },
      nodes: {
        'billing/cancel': {
          source: 'fingerprint-abc',
          log: { last_entry_datetime: '2026-06-12T10:00:00.000Z', prefix_hash: 'loghash' },
        },
      },
    };
    await writeAll(tmpDir, lock);
    const result = readLock(tmpDir);
    expect(result).toEqual(lock);
  });

  it('serializeLock emits code-point-sorted keys, one entry per line, trailing newline', () => {
    // 'Z' (0x5A) must sort BEFORE 'a' (0x61) in code-point order.
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'alpha-rule': {
          'node:b-unit': { verdict: 'approved', hash: 'hash-alpha-b' },
        },
        'Zeta-rule': {
          'node:A-unit': { verdict: 'refused', hash: 'hash-zeta-A', reason: 'violation text' },
          'node:b-unit': { verdict: 'approved', hash: 'hash-zeta-b' },
        },
      },
      nodes: {
        'billing/cancel': {
          source: 'fp-billing',
        },
      },
    };

    const expected =
      '{\n' +
      '  "version": 1,\n' +
      '  "verdicts": {\n' +
      '    "Zeta-rule": {\n' +
      '      "node:A-unit": {"hash":"hash-zeta-A","reason":"violation text","verdict":"refused"},\n' +
      '      "node:b-unit": {"hash":"hash-zeta-b","verdict":"approved"}\n' +
      '    },\n' +
      '    "alpha-rule": {\n' +
      '      "node:b-unit": {"hash":"hash-alpha-b","verdict":"approved"}\n' +
      '    }\n' +
      '  },\n' +
      '  "nodes": {\n' +
      '    "billing/cancel": {"source":"fp-billing"}\n' +
      '  }\n' +
      '}\n';

    const result = serializeLock(lock);
    expect(result).toBe(expected);
  });

  it('readLock throws LockInvalidError on unparseable JSON', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-bad-json');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, LOCK_NONDET_FILE_NAME), 'not valid json { {', 'utf-8');
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError on an unsupported future version (3)', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-bad-version');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const badLock = { version: 3, verdicts: {}, nodes: {} };
    await writeFile(path.join(tmpDir, LOCK_NONDET_FILE_NAME), JSON.stringify(badLock), 'utf-8');
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('LockInvalidError for content containing "<<<<<<<" names git conflict markers and its next: includes the take-a-side procedure (git checkout --ours|--theirs, then yg check --approve)', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-conflict');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const conflictContent =
      '<<<<<<< HEAD\n{"version":1,"verdicts":{},"nodes":{}}\n=======\n{"version":1,"verdicts":{},"nodes":{}}\n>>>>>>> branch\n';
    await writeFile(path.join(tmpDir, LOCK_NONDET_FILE_NAME), conflictContent, 'utf-8');
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    const err = thrown as InstanceType<typeof LockInvalidError>;
    const { what, next } = err.messageData;
    expect(what.toLowerCase()).toMatch(/conflict/);
    expect(next).toMatch(/git checkout --ours/);
    expect(next).toMatch(/git checkout --theirs/);
    // The message names the SPECIFIC committed file that conflicted.
    expect(next).toMatch(/\.yggdrasil\/yg-lock\.nondeterministic\.json/);
    expect(next).toMatch(/yg check --approve/);
  });

  it('LockInvalidError next: names both recoveries (restore from git / delete the file and re-fill via yg check --approve) and the re-verification cost', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-both-recoveries');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, LOCK_NONDET_FILE_NAME), '{ invalid json }', 'utf-8');
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    const err = thrown as InstanceType<typeof LockInvalidError>;
    const { next } = err.messageData;
    expect(next).toMatch(/git/);
    expect(next).toMatch(/yg check --approve/);
    expect(next).toMatch(/re.verif/i);
  });

  it('readLock does NOT throw when a reason string contains "<<<<<<< HEAD" inside JSON', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-reason-lt7');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'my-aspect': {
          'node:billing/cancel': {
            verdict: 'refused',
            hash: 'abc123',
            reason: 'reviewer quoted: <<<<<<< HEAD in source',
          },
        },
      },
      nodes: {},
    };
    await writeAll(tmpDir, lock);
    const result = readLock(tmpDir);
    expect(result.verdicts['my-aspect']['node:billing/cancel'].reason).toBe(
      'reviewer quoted: <<<<<<< HEAD in source',
    );
  });

  it('serializer escaping: roundtrip a reason with quotes, newline, and backslash keeps each entry on a single line and returns the exact original string', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-escape');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const tricky = 'has "quotes"\nand newline\t\\backslash';
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'my-aspect': {
          'node:billing/cancel': {
            verdict: 'refused',
            hash: 'abc123',
            reason: tricky,
          },
        },
      },
      nodes: {},
    };
    await writeAll(tmpDir, lock);
    const serialized = serializeLock(lock);
    const entryLines = serialized
      .split('\n')
      .filter((l) => l.includes('"node:billing/cancel"'));
    expect(entryLines).toHaveLength(1);
    const result = readLock(tmpDir);
    expect(result.verdicts['my-aspect']['node:billing/cancel'].reason).toBe(tricky);
  });

  it('unknown-field drop: extra properties on VerdictEntry are not serialized and roundtrip yields only known fields', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-extra-field');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const entryWithExtra = {
      verdict: 'approved' as const,
      hash: 'abc123',
      __extraField: 'should-be-dropped',
    } as unknown as import('../../../src/model/lock.js').VerdictEntry;
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'my-aspect': {
          'node:billing/cancel': entryWithExtra,
        },
      },
      nodes: {},
    };
    const serialized = serializeLock(lock);
    expect(serialized).not.toContain('__extraField');
    expect(serialized).not.toContain('should-be-dropped');
    await writeAll(tmpDir, lock);
    const result = readLock(tmpDir);
    const entry = result.verdicts['my-aspect']['node:billing/cancel'];
    expect(entry).toEqual({ verdict: 'approved', hash: 'abc123' });
    expect(Object.keys(entry)).not.toContain('__extraField');
  });

  it('writeLock writes atomically (temp + rename via the existing atomic write helper — no .tmp left behind)', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-atomic');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const lock: LockFile = { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} };
    await writeAll(tmpDir, lock);
    // No leftover temp file for ANY of the triad files.
    const left = (await readdir(tmpDir)).filter((e) => e.endsWith('.tmp'));
    expect(left).toEqual([]);
    const result = readLock(tmpDir);
    expect(result).toEqual(lock);
  });

  // ── Shape validation — the lock must FAIL CLOSED on a malformed structure. ──

  /** Write a raw (possibly malformed) committed lock file and read it back. */
  async function writeRawLock(name: string, content: string): Promise<string> {
    const tmpDir = path.join(FIXTURES_DIR, name);
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, LOCK_NONDET_FILE_NAME), content, 'utf-8');
    return tmpDir;
  }

  it('readLock throws LockInvalidError when verdicts is an array (fail closed, not coerced to empty)', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-verdicts-array',
      JSON.stringify({ version: LOCK_FORMAT_VERSION, verdicts: [], nodes: {} }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a verdict entry is missing hash', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-entry-no-hash',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: { 'my-aspect': { 'node:billing/cancel': { verdict: 'approved' } } },
        nodes: {},
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a verdict entry has a non-string verdict', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-entry-bad-verdict',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: { 'my-aspect': { 'node:billing/cancel': { verdict: 1, hash: 'abc123' } } },
        nodes: {},
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when nodes is an array (fail closed — log baseline not silently absent)', async () => {
    // The nodes section lives in the logs file; put the malformed nodes there.
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-nodes-array');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, LOCK_LOGS_FILE_NAME),
      JSON.stringify({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: [] }),
      'utf-8',
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a nodes entry has a malformed log', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-node-bad-log');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, LOCK_LOGS_FILE_NAME),
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        nodes: { 'billing/cancel': { source: 'fp', log: 'not-an-object' } },
      }),
      'utf-8',
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock routes a =======/>>>>>>> conflict fragment to the conflict (take-a-side) message', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-conflict-fragment',
      '{"version":1,"verdicts":{},"nodes":{}}\n=======\n{"version":1,"verdicts":{},"nodes":{}}\n>>>>>>> branch\n',
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    const err = thrown as InstanceType<typeof LockInvalidError>;
    const { what, next } = err.messageData;
    expect(what.toLowerCase()).toMatch(/conflict/);
    expect(next).toMatch(/git checkout --ours/);
    expect(next).toMatch(/git checkout --theirs/);
    expect(next).toMatch(/yg check --approve/);
  });

  it('regression: a well-formed lock (refused entry with multi-line reason + touched, node with source+log) round-trips exactly', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-wellformed-roundtrip');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'my-aspect': {
          'node:billing/cancel': { verdict: 'approved', hash: 'abc123' },
          'file:src/billing/x.ts': {
            verdict: 'refused',
            hash: 'def456',
            reason: 'line one\nline two\nline three',
            touched: [
              ['read:src/shared/codes.ts', 'sha-xyz'],
              ['list:src/billing', 'sha-list'],
            ],
          },
        },
      },
      nodes: {
        'billing/cancel': {
          source: 'fingerprint-abc',
          log: { last_entry_datetime: '2026-06-12T10:00:00.000Z', prefix_hash: 'loghash' },
        },
      },
    };
    await writeAll(tmpDir, lock);
    const result = readLock(tmpDir);
    expect(result).toEqual(lock);
  });

  it('regression: absent lock files read back as an empty lock (NOT lock-invalid)', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-absent-not-invalid');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    expect(() => readLock(tmpDir)).not.toThrow();
    const result = readLock(tmpDir);
    expect(result).toEqual({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} });
  });

  it('readLock rethrows a non-ENOENT filesystem error (e.g. EISDIR when a committed lock path is a directory)', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-eisdir');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(path.join(tmpDir, LOCK_NONDET_FILE_NAME), { recursive: true });
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as NodeJS.ErrnoException).code).toBe('EISDIR');
    expect(thrown).not.toBeInstanceOf(LockInvalidError);
  });

  it('readLock throws LockInvalidError when the JSON is null (not an object)', async () => {
    const tmpDir = await writeRawLock('tmp-lock-null', 'null');
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when version is missing (non-numeric)', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-no-version',
      JSON.stringify({ verdicts: {}, nodes: {} }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /numeric version/i,
    );
  });

  it('readLock throws LockInvalidError on an unexpected top-level key', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-extra-top-key',
      JSON.stringify({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {}, extra: 1 }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /unexpected top-level key "extra"/,
    );
  });

  it('readLock throws LockInvalidError when verdicts.<aspectId> is not an object (the unit map)', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-unitmap-not-object',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: { 'my-aspect': 42 },
        nodes: {},
      }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /"verdicts\.my-aspect" must be a JSON object/,
    );
  });

  it('readLock throws LockInvalidError when a verdict entry is null (not a plain object)', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-entry-null',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: { 'my-aspect': { 'node:billing/cancel': null } },
        nodes: {},
      }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(/null/);
  });

  it('readLock throws LockInvalidError when a verdict entry has an unexpected key', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-entry-extra-key',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {
          'my-aspect': { 'node:billing/cancel': { verdict: 'approved', hash: 'h', bogus: 1 } },
        },
        nodes: {},
      }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /unexpected key "bogus"/,
    );
  });

  it('every VerdictEntry field survives a write/read round-trip', () => {
    // serializeEntry is an explicit allow-list, not a pass-through: a field the
    // producer sets but the serializer does not name is dropped on write, with
    // nothing to notice — the value is simply gone the next time it is read.
    // This asserts on the TYPE's own field set, so adding a field to VerdictEntry
    // without teaching the serializer about it fails here rather than in the
    // field's absence months later.
    const entry: Required<import('../../../src/model/lock.js').VerdictEntry> = {
      verdict: 'refused',
      hash: 'abc123',
      reason: 'a violation at src/a.ts:3',
      touched: [['read:src/b.ts', 'deadbeef']],
      promptChars: 4211,
      judge: { name: 'a-verifier', provider: 'external' },
      filledAt: '2026-09-09T00:00:00.000Z',
      filledSha: 'f'.repeat(40),
    };
    const serialized = serializeLock({
      version: LOCK_FORMAT_VERSION,
      verdicts: { asp: { 'node:svc': entry } },
      nodes: {},
    });
    const parsed = JSON.parse(serialized) as { verdicts: Record<string, Record<string, unknown>> };
    expect(parsed.verdicts['asp']['node:svc']).toEqual(entry);
  });

  it('readLock accepts a verdict entry carrying a recorded prompt size, and one without', async () => {
    // The size is written onto LLM entries; a deterministic entry, and any entry
    // written before the field existed, simply has none. Both must read back.
    const tmpDir = await writeRawLock(
      'tmp-lock-entry-prompt-chars',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {
          'my-aspect': {
            'node:with-size': { verdict: 'approved', hash: 'h', promptChars: 4211 },
            'node:without-size': { verdict: 'approved', hash: 'h' },
          },
        },
        nodes: {},
      }),
    );
    const lock = readLock(tmpDir);
    expect(lock.verdicts['my-aspect']['node:with-size'].promptChars).toBe(4211);
    expect(lock.verdicts['my-aspect']['node:without-size'].promptChars).toBeUndefined();
  });

  it('readLock throws LockInvalidError when a recorded prompt size is not a non-negative integer', async () => {
    // A character count that is fractional, negative, or not a number cannot have
    // come from this CLI, and a check that trusted it could gate the wrong way —
    // so the lock fails closed rather than reading it.
    for (const [label, bad] of [['fraction', 12.5], ['negative', -1], ['string', '900']] as const) {
      const tmpDir = await writeRawLock(
        `tmp-lock-entry-prompt-chars-${label}`,
        JSON.stringify({
          version: LOCK_FORMAT_VERSION,
          verdicts: { 'my-aspect': { 'node:x': { verdict: 'approved', hash: 'h', promptChars: bad } } },
          nodes: {},
        }),
      );
      let thrown: unknown;
      try {
        readLock(tmpDir);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, label).toBeInstanceOf(LockInvalidError);
      expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
        /promptChars.*non-negative integer/,
      );
    }
  });

  it('readLock accepts a verdict entry carrying filledAt/filledSha, and one without either', async () => {
    // filledAt/filledSha are written on a real fill; a deterministic entry, and
    // any entry written before the fields existed, simply has neither.
    const tmpDir = await writeRawLock(
      'tmp-lock-entry-filled',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {
          'my-aspect': {
            'node:with-filled': {
              verdict: 'approved', hash: 'h', filledAt: '2026-09-09T00:00:00.000Z', filledSha: 'a'.repeat(40),
            },
            'node:without-filled': { verdict: 'approved', hash: 'h' },
          },
        },
        nodes: {},
      }),
    );
    const lock = readLock(tmpDir);
    expect(lock.verdicts['my-aspect']['node:with-filled'].filledAt).toBe('2026-09-09T00:00:00.000Z');
    expect(lock.verdicts['my-aspect']['node:with-filled'].filledSha).toBe('a'.repeat(40));
    expect(lock.verdicts['my-aspect']['node:without-filled'].filledAt).toBeUndefined();
    expect(lock.verdicts['my-aspect']['node:without-filled'].filledSha).toBeUndefined();
  });

  it('readLock throws LockInvalidError when filledAt or filledSha is not a string', async () => {
    for (const [field, bad] of [['filledAt', 7], ['filledSha', 7]] as const) {
      const tmpDir = await writeRawLock(
        `tmp-lock-entry-${field}-bad-type`,
        JSON.stringify({
          version: LOCK_FORMAT_VERSION,
          verdicts: { 'my-aspect': { 'node:x': { verdict: 'approved', hash: 'h', [field]: bad } } },
          nodes: {},
        }),
      );
      let thrown: unknown;
      try {
        readLock(tmpDir);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, field).toBeInstanceOf(LockInvalidError);
      expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toContain(field);
    }
  });

  it('serializeEntry: an entry without filledAt/filledSha serializes byte-for-byte as before the fields existed', () => {
    // Regression guard for the biggest risk of this change: serializeEntry is
    // an explicit allow-list, and a fresh key added to it must never appear on
    // an entry that never set it. This is the same golden shape the top-level
    // "serializeLock emits code-point-sorted keys" test pins, isolated to one
    // entry so the byte-identity claim cannot hide behind unrelated fields.
    const serialized = serializeLock({
      version: LOCK_FORMAT_VERSION,
      verdicts: { asp: { 'node:svc': { verdict: 'refused', hash: 'h', reason: 'r' } } },
      nodes: {},
    });
    expect(serialized).toContain('"node:svc": {"hash":"h","reason":"r","verdict":"refused"}');
    expect(serialized).not.toContain('filledAt');
    expect(serialized).not.toContain('filledSha');
  });

  it('serializeEntry: an entry WITH filledAt/filledSha orders every key code-point, filledAt/filledSha ahead of hash', () => {
    const entry: import('../../../src/model/lock.js').VerdictEntry = {
      verdict: 'refused',
      hash: 'h',
      reason: 'r',
      touched: [['read:a', 'x']],
      promptChars: 10,
      judge: { name: 'j', provider: 'external' },
      filledAt: '2026-09-09T00:00:00.000Z',
      filledSha: 'a'.repeat(40),
    };
    const serialized = serializeLock({
      version: LOCK_FORMAT_VERSION,
      verdicts: { asp: { 'node:svc': entry } },
      nodes: {},
    });
    const line = serialized.split('\n').find((l) => l.includes('node:svc'))!;
    // Actual code-point order of every key this entry carries. Six-space
    // indent, no trailing comma: this is the only unit of the only aspect.
    expect(line).toBe(
      '      "node:svc": {' +
        '"filledAt":"2026-09-09T00:00:00.000Z",' +
        '"filledSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
        '"hash":"h",' +
        '"judge":{"name":"j","provider":"external"},' +
        '"promptChars":10,' +
        '"reason":"r",' +
        '"touched":[["read:a","x"]],' +
        '"verdict":"refused"' +
        '}',
    );
  });

  it('readLock throws LockInvalidError when a verdict entry reason is a non-string', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-entry-bad-reason',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {
          'my-aspect': {
            'node:billing/cancel': { verdict: 'approved', hash: 'h', reason: 123 },
          },
        },
        nodes: {},
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when touched is present but not an array', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-touched-not-array',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {
          'my-aspect': {
            'node:billing/cancel': { verdict: 'approved', hash: 'h', touched: 'nope' },
          },
        },
        nodes: {},
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a touched element is not a [string, string] pair', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-touched-bad-pair',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {
          'my-aspect': {
            'node:billing/cancel': { verdict: 'approved', hash: 'h', touched: [['only-one']] },
          },
        },
        nodes: {},
      }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /touched\[0\]" must be a \[string, string\] pair/,
    );
  });

  it('readLock throws LockInvalidError when a nodes entry is not a plain object', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-node-not-object');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, LOCK_LOGS_FILE_NAME),
      JSON.stringify({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: { 'billing/cancel': 7 } }),
      'utf-8',
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a nodes entry has an unexpected key', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-node-extra-key');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, LOCK_LOGS_FILE_NAME),
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        nodes: { 'billing/cancel': { source: 'fp', mystery: true } },
      }),
      'utf-8',
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /unexpected key "mystery"/,
    );
  });

  it('readLock throws LockInvalidError when a nodes entry source is a non-string', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-node-bad-source');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, LOCK_LOGS_FILE_NAME),
      JSON.stringify({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: { 'billing/cancel': { source: 99 } } }),
      'utf-8',
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a nodes log has an unexpected key', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-log-extra-key');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, LOCK_LOGS_FILE_NAME),
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        nodes: { 'billing/cancel': { log: { last_entry_datetime: 'x', prefix_hash: 'y', sneaky: 1 } } },
      }),
      'utf-8',
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /log" has unexpected key "sneaky"/,
    );
  });

  it('readLock throws LockInvalidError when a nodes log.last_entry_datetime is a non-string', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-log-bad-datetime');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, LOCK_LOGS_FILE_NAME),
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        nodes: { 'billing/cancel': { log: { last_entry_datetime: 5, prefix_hash: 'y' } } },
      }),
      'utf-8',
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a nodes log.prefix_hash is a non-string', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-log-bad-prefix');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, LOCK_LOGS_FILE_NAME),
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        nodes: { 'billing/cancel': { log: { last_entry_datetime: 'x', prefix_hash: 9 } } },
      }),
      'utf-8',
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('serializeNodeEntry renders an empty node entry (no source, no log) as {}', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-empty-node');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {},
      nodes: { 'billing/cancel': {} },
    };
    const serialized = serializeLock(lock);
    expect(serialized).toContain('"billing/cancel": {}');
    await writeAll(tmpDir, lock);
    const result = readLock(tmpDir);
    expect(result.nodes['billing/cancel']).toEqual({});
  });
});

// ── Triad partition + scopes (5.1.0 split) ────────────────────────────────────
describe('lock-store — triad partition & scopes', () => {
  const TRIAD_LOCK: LockFile = {
    version: LOCK_FORMAT_VERSION,
    verdicts: {
      // deterministic aspect — its verdict carries touched and belongs in the gitignored file.
      'det-aspect': { 'node:a': { verdict: 'approved', hash: 'hd', touched: [['read:x.ts', 'hx']] } },
      // plain LLM aspect.
      'llm-aspect': { 'node:b': { verdict: 'approved', hash: 'hl' } },
      // companion-backed LLM aspect — ALSO carries touched, but is LLM (committed).
      'companion-aspect': { 'node:c': { verdict: 'approved', hash: 'hc', touched: [['read:companion-file.ts', 'hcf']] } },
    },
    nodes: { a: { source: 'fp-a', log: { last_entry_datetime: '2026-06-20T00:00:00.000Z', prefix_hash: 'ph' } } },
  };
  const DET_IDS = new Set(['det-aspect']);

  it('partition by aspect KIND: deterministic → gitignored file; LLM incl. companion-backed (with touched) → committed nondet file; nodes → logs file', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-partition');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeLock(tmpDir, TRIAD_LOCK, { scope: 'all', deterministicAspectIds: DET_IDS });

    const detRaw = readFileSync(path.join(tmpDir, LOCK_DET_FILE_NAME), 'utf-8');
    const nondetRaw = readFileSync(path.join(tmpDir, LOCK_NONDET_FILE_NAME), 'utf-8');
    const logsRaw = readFileSync(path.join(tmpDir, LOCK_LOGS_FILE_NAME), 'utf-8');

    // Gitignored deterministic file: only the deterministic aspect.
    expect(detRaw).toContain('det-aspect');
    expect(detRaw).not.toContain('llm-aspect');
    // R5 GUARANTEE: a companion-backed LLM entry carries `touched` but must NOT be misfiled
    // into the gitignored deterministic file — partition is by KIND, never by `touched`.
    expect(detRaw).not.toContain('companion-aspect');

    // Committed nondeterministic file: both LLM aspects (incl. companion-backed); no det.
    expect(nondetRaw).toContain('llm-aspect');
    expect(nondetRaw).toContain('companion-aspect');
    expect(nondetRaw).not.toContain('det-aspect');

    // Committed logs file: the nodes section; no verdicts.
    expect(logsRaw).toContain('fp-a');
    expect(logsRaw).not.toContain('det-aspect');

    // readLock merges all three back to the unified lock.
    expect(readLock(tmpDir)).toEqual(TRIAD_LOCK);
  });

  it("scope 'deterministic' writes ONLY the gitignored det file — committed files untouched (zero CI churn)", async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-scope-det');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeLock(tmpDir, TRIAD_LOCK, { scope: 'all', deterministicAspectIds: DET_IDS });

    const nondetBefore = readFileSync(path.join(tmpDir, LOCK_NONDET_FILE_NAME), 'utf-8');
    const logsBefore = readFileSync(path.join(tmpDir, LOCK_LOGS_FILE_NAME), 'utf-8');

    // Mutate det + (hypothetically) LLM in memory, then write only the deterministic scope.
    const mutated: LockFile = JSON.parse(JSON.stringify(TRIAD_LOCK));
    mutated.verdicts['det-aspect']['node:a'].hash = 'changed-det';
    mutated.verdicts['llm-aspect']['node:b'].hash = 'changed-llm';
    await writeLock(tmpDir, mutated, { scope: 'deterministic', deterministicAspectIds: DET_IDS });

    // Committed files are byte-identical (LLM change NOT persisted).
    expect(readFileSync(path.join(tmpDir, LOCK_NONDET_FILE_NAME), 'utf-8')).toBe(nondetBefore);
    expect(readFileSync(path.join(tmpDir, LOCK_LOGS_FILE_NAME), 'utf-8')).toBe(logsBefore);
    // Deterministic file updated.
    expect(readFileSync(path.join(tmpDir, LOCK_DET_FILE_NAME), 'utf-8')).toContain('changed-det');
  });

  it("scope 'logs' writes ONLY the logs file and needs no deterministicAspectIds", async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-scope-logs');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeLock(tmpDir, TRIAD_LOCK, { scope: 'logs' });

    expect(readFileSync(path.join(tmpDir, LOCK_LOGS_FILE_NAME), 'utf-8')).toContain('fp-a');
    expect(existsSync(path.join(tmpDir, LOCK_NONDET_FILE_NAME))).toBe(false);
    expect(existsSync(path.join(tmpDir, LOCK_DET_FILE_NAME))).toBe(false);
  });

  it('a verdict scope without deterministicAspectIds throws (programming guard)', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-no-detids');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await expect(writeLock(tmpDir, TRIAD_LOCK, { scope: 'all' })).rejects.toThrow(
      /deterministicAspectIds is required/,
    );
  });

  it('absent gitignored det file (fresh clone): readLock returns committed verdicts + nodes; det verdicts simply absent', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-absent-det');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeLock(tmpDir, TRIAD_LOCK, { scope: 'all', deterministicAspectIds: DET_IDS });
    // Simulate a fresh clone: the gitignored deterministic file is not present.
    await rm(path.join(tmpDir, LOCK_DET_FILE_NAME), { force: true });

    const result = readLock(tmpDir);
    expect(result.verdicts['det-aspect']).toBeUndefined(); // gitignored, gone
    expect(result.verdicts['llm-aspect']).toBeDefined(); // committed, survives
    expect(result.verdicts['companion-aspect']).toBeDefined();
    expect(result.nodes).toEqual(TRIAD_LOCK.nodes);
  });

  it('a garbled GITIGNORED deterministic file is DISCARDED and rebuilt, not refused (it holds no truth to protect)', async () => {
    // Superseded the pre-6.0.0 assertion that this threw with a "rematerialize" recovery.
    // A derived, gitignored, fully rederivable cache must never take the gate down.
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-det-garbled');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, LOCK_DET_FILE_NAME), '{ not json', 'utf-8');

    const result = readLock(tmpDir);
    expect(result).toEqual({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} });
  });
});

// ---------------------------------------------------------------------------
// The committed/derived split — a derived lock never takes the gate down.
//
// `.yg-lock.deterministic.json` is gitignored and rederivable in full from the
// graph plus the committed lock, so a fault in it costs a recomputation and
// nothing else. The committed files are the source of truth, and a fault there
// is still a real, visible refusal. Both directions are asserted here: the
// tolerance must not swallow the alarm that matters.
//
// The live case this fixes: a NEWER `yg` writes a section an OLDER `yg` on the
// far side of a container boundary does not yet allow, and the older one
// refuses to start. Observed twice on 2026-09-11 (a 5.9.0 host wrote `aspects`,
// a 5.8.0 container rejected it as an unexpected top-level key). Simulated here
// with a top-level key no version allows, so the test stays honest as the real
// schema grows.
// ---------------------------------------------------------------------------
describe('lock store — derived locks rebuild, committed locks refuse', () => {
  async function freshDir(name: string): Promise<string> {
    const tmpDir = path.join(FIXTURES_DIR, name);
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    return tmpDir;
  }

  /** A det lock as a NEWER yg would write it: valid today, plus one section this build has never heard of. */
  const FROM_A_NEWER_YG = JSON.stringify({
    version: LOCK_FORMAT_VERSION,
    verdicts: { 'style/naming': { 'node:billing/cancel': { verdict: 'approved', hash: 'h1' } } },
    nodes: {},
    aspects: { 'style/naming': { status: 'enforced' } },
    cohorts: { 'style/naming': { generation: 4 } },
  });

  const DERIVED_FAULTS: ReadonlyArray<readonly [string, string]> = [
    ['an unknown top-level key written by a newer yg (version skew)', FROM_A_NEWER_YG],
    ['completely unparseable JSON', '{"version": 2, "verdicts": {'],
    ['truncated mid-write', '{"version":2,"verdicts":{"style/naming":{"node:a":{"verdict":"appr'],
    ['a JSON array instead of an object', '[1,2,3]'],
    ['a valid object with no version field', JSON.stringify({ verdicts: {}, nodes: {} })],
    ['a version from the future', JSON.stringify({ version: 99, verdicts: {}, nodes: {} })],
    ['a garbled section shape', JSON.stringify({ version: LOCK_FORMAT_VERSION, verdicts: [], nodes: {} })],
    ['a garbled entry inside a section', JSON.stringify({ version: LOCK_FORMAT_VERSION, verdicts: { a: { 'node:b': { verdict: 'maybe' } } }, nodes: {} })],
  ];

  it.each(DERIVED_FAULTS)(
    'the DERIVED det lock with %s → readLock rebuilds from scratch, silently',
    async (label, content) => {
      const tmpDir = await freshDir('tmp-lock-derived-fault');
      await writeFile(path.join(tmpDir, LOCK_DET_FILE_NAME), content, 'utf-8');

      let result: LockFile | undefined;
      expect(() => {
        result = readLock(tmpDir);
      }, label).not.toThrow();
      // Rebuilt from zero: the bad file contributes nothing, and nothing it carried is
      // smuggled through. Empty det verdicts read as UNVERIFIED — still fail-closed.
      expect(result, label).toEqual({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} });
    },
  );

  it.each(DERIVED_FAULTS)(
    'the same fault (%s) in a COMMITTED lock is still a real, visible refusal',
    async (label, content) => {
      const tmpDir = await freshDir('tmp-lock-committed-fault');
      await writeFile(path.join(tmpDir, LOCK_NONDET_FILE_NAME), content, 'utf-8');
      expect(() => readLock(tmpDir), label).toThrow(LockInvalidError);
    },
  );

  it('the LEGACY committed single-file lock still refuses an unknown top-level key (readLegacyLock)', async () => {
    const tmpDir = await freshDir('tmp-lock-legacy-fault');
    await writeFile(path.join(tmpDir, LOCK_FILE_NAME), FROM_A_NEWER_YG, 'utf-8');
    expect(() => readLegacyLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('a broken det lock does not mask the COMMITTED sections read alongside it', async () => {
    const tmpDir = await freshDir('tmp-lock-det-broken-committed-intact');
    await writeFile(
      path.join(tmpDir, LOCK_NONDET_FILE_NAME),
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: { 'llm/prose': { 'node:billing/cancel': { verdict: 'approved', hash: 'h-llm' } } },
        nodes: {},
      }),
      'utf-8',
    );
    await writeFile(
      path.join(tmpDir, LOCK_LOGS_FILE_NAME),
      JSON.stringify({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: { 'billing/cancel': { source: 'fp-billing' } } }),
      'utf-8',
    );
    await writeFile(path.join(tmpDir, LOCK_DET_FILE_NAME), FROM_A_NEWER_YG, 'utf-8');

    const result = readLock(tmpDir);
    expect(result.verdicts['llm/prose']).toBeDefined();
    expect(result.nodes['billing/cancel']).toEqual({ source: 'fp-billing' });
    // The det file's verdicts and its unknown section are both gone, not merged.
    expect(result.verdicts['style/naming']).toBeUndefined();
    expect(result.aspects).toBeUndefined();
  });

  it('readDetLockAspectIds reads a broken det lock as EMPTY rather than throwing', async () => {
    const tmpDir = await freshDir('tmp-lock-det-ids-broken');
    await writeFile(path.join(tmpDir, LOCK_DET_FILE_NAME), FROM_A_NEWER_YG, 'utf-8');
    expect(readDetLockAspectIds(tmpDir)).toEqual(new Set<string>());
  });

  it('the discard is self-healing: the next write replaces the broken det file with a valid one', async () => {
    const tmpDir = await freshDir('tmp-lock-det-selfheal');
    await writeFile(path.join(tmpDir, LOCK_DET_FILE_NAME), FROM_A_NEWER_YG, 'utf-8');

    const rebuilt = readLock(tmpDir);
    rebuilt.verdicts['det/aspect'] = { 'node:billing/cancel': { verdict: 'approved', hash: 'fresh' } };
    await writeLock(tmpDir, rebuilt, {
      scope: 'deterministic',
      deterministicAspectIds: new Set(['det/aspect']),
    });

    const onDisk = readFileSync(path.join(tmpDir, LOCK_DET_FILE_NAME), 'utf-8');
    expect(onDisk).not.toContain('cohorts');
    // And it reads back cleanly, with no throw anywhere in the round trip.
    expect(readLock(tmpDir).verdicts['det/aspect']['node:billing/cancel'].hash).toBe('fresh');
  });

  it('the discard leaves a breadcrumb in the debug log (silent on stdout, not invisible)', async () => {
    const tmpDir = await freshDir('tmp-lock-det-breadcrumb');
    await writeFile(path.join(tmpDir, LOCK_DET_FILE_NAME), FROM_A_NEWER_YG, 'utf-8');

    const lines: string[] = [];
    _resetForTesting();
    initDebugLog(tmpDir, true, (_p, text) => {
      lines.push(text);
    });
    try {
      readLock(tmpDir);
    } finally {
      _resetForTesting();
    }

    const logged = lines.join('');
    expect(logged).toContain(LOCK_DET_FILE_NAME);
    expect(logged).toMatch(/discarded and rebuilt/);
    // The diagnosis itself rides along, so a debug run says WHAT was wrong.
    expect(logged).toMatch(/unexpected top-level key "cohorts"/);
  });

  it('a real I/O failure still propagates from the derived file — only content faults are tolerated', async () => {
    // A directory where the det lock should be: readFileSync fails with EISDIR, not a
    // LockInvalidError. That is an environment fault to fix, not a cache to rebuild.
    const tmpDir = await freshDir('tmp-lock-det-eisdir');
    await mkdir(path.join(tmpDir, LOCK_DET_FILE_NAME), { recursive: true });
    expect(() => readLock(tmpDir)).toThrow();
    expect(() => readLock(tmpDir)).not.toThrow(LockInvalidError);
  });
});

// ---------------------------------------------------------------------------
// The retired 'ports' section — removed in 6.0.0 (port contract baselines are
// gone; a version and a contract test are no longer things a port declares).
// NOT tolerated: a node entry still carrying `ports` is refused exactly like
// any other unexpected key, unconditionally and regardless of its shape — the
// only way past it is the to-6.0.0 migration, which strips the raw key before
// this validator ever runs.
// ---------------------------------------------------------------------------
describe('lock store — the retired ports section is refused, not tolerated', () => {
  it.each([
    ['a well-formed baseline record', '{"ports":{"charge":{"1":{"hash":"h","test":"t"}}}}'],
    ['garbage shaped as a number', '{"ports":3}'],
    ['garbage shaped as an array', '{"ports":[]}'],
    ['garbage shaped as an object with junk inside', '{"ports":{"charge":7}}'],
  ])('refuses a node entry with %s, naming the file and the unexpected key', async (_label, nodeEntry) => {
    const dir = path.join(FIXTURES_DIR, 'tmp-lock-ports-refused');
    const yggRoot = path.join(dir, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    await writeFile(
      path.join(yggRoot, LOCK_LOGS_FILE_NAME),
      `{"version":${LOCK_FORMAT_VERSION},"verdicts":{},"nodes":{"payments/service":${nodeEntry}}}\n`,
    );
    expect(() => readLock(yggRoot)).toThrow(LockInvalidError);
    try {
      readLock(yggRoot);
    } catch (err) {
      const message = (err as LockInvalidError).message;
      expect(message).toContain(LOCK_LOGS_FILE_NAME);
      expect(message).toContain('unexpected key "ports"');
    }
  });

  it('a node entry without ports round-trips unaffected, byte for byte', async () => {
    const dir = path.join(FIXTURES_DIR, 'tmp-lock-no-ports');
    await mkdir(path.join(dir, '.yggdrasil'), { recursive: true });
    const yggRoot = path.join(dir, '.yggdrasil');
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {},
      nodes: { 'payments/service': { source: 'fp', log: { last_entry_datetime: '2026-01-01T00:00:00Z', prefix_hash: 'h' } } },
    };
    await writeLock(yggRoot, lock, { scope: 'logs' });
    const before = readFileSync(path.join(yggRoot, LOCK_LOGS_FILE_NAME), 'utf-8');
    await writeLock(yggRoot, readLock(yggRoot), { scope: 'logs' });
    const after = readFileSync(path.join(yggRoot, LOCK_LOGS_FILE_NAME), 'utf-8');
    expect(after).toBe(before);
  });
});
