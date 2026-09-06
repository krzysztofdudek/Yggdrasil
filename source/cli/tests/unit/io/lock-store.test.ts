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
  LOCK_NONDET_FILE_NAME,
  LOCK_LOGS_FILE_NAME,
  LOCK_DET_FILE_NAME,
} from '../../../src/model/lock.js';

import {
  readLock,
  writeLock,
  serializeLock,
  LockInvalidError,
} from '../../../src/io/lock-store.js';

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

  it('a garbled GITIGNORED deterministic file → lock-invalid with the rematerialize recovery (not a git restore)', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-det-garbled');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, LOCK_DET_FILE_NAME), '{ not json', 'utf-8');
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    const { next } = (thrown as InstanceType<typeof LockInvalidError>).messageData;
    // The gitignored cache recovers by rematerializing, NOT by a git restore.
    expect(next).toMatch(/--only-deterministic/);
    expect(next).not.toMatch(/git checkout/);
  });
});

// ---------------------------------------------------------------------------
// Port contract baselines — the committed record that holds a port's contract
// test to the version it was recorded at. Stored in the `nodes` section beside
// the source fingerprint and the log baseline, and read back strictly: a
// corrupted record must fail loudly rather than read as an absent baseline,
// which would silently un-enforce the contract it held.
// ---------------------------------------------------------------------------
describe('lock store — port contract baselines', () => {
  const withPorts = (): LockFile => ({
    version: LOCK_FORMAT_VERSION,
    verdicts: {},
    nodes: {
      'payments/service': {
        ports: {
          refund: { '1': { test: 'tests/contracts/refund.test.ts', hash: 'b'.repeat(64) } },
          charge: {
            '2': { test: 'tests/contracts/charge.test.ts', hash: 'c'.repeat(64) },
            '1': { test: 'tests/contracts/charge.test.ts', hash: 'a'.repeat(64) },
          },
        },
      },
    },
  });

  it('serializes every level in sorted order, so two runs recording the same facts agree byte for byte', () => {
    const text = serializeLock(withPorts());
    // Port names sorted, and versions sorted within a port — neither follows the
    // insertion order above.
    expect(text).toContain(
      '"payments/service": {"ports":{"charge":{"1":{"hash":"' + 'a'.repeat(64) + '","test":"tests/contracts/charge.test.ts"},' +
        '"2":{"hash":"' + 'c'.repeat(64) + '","test":"tests/contracts/charge.test.ts"}},' +
        '"refund":{"1":{"hash":"' + 'b'.repeat(64) + '","test":"tests/contracts/refund.test.ts"}}}}',
    );
  });

  it('round-trips through the committed logs file', async () => {
    const dir = path.join(FIXTURES_DIR, 'tmp-lock-ports');
    await mkdir(path.join(dir, '.yggdrasil'), { recursive: true });
    const yggRoot = path.join(dir, '.yggdrasil');
    await writeLock(yggRoot, withPorts(), { scope: 'logs' });
    expect(existsSync(path.join(yggRoot, LOCK_LOGS_FILE_NAME))).toBe(true);
    const back = readLock(yggRoot);
    expect(back.nodes['payments/service'].ports).toEqual({
      charge: {
        '1': { test: 'tests/contracts/charge.test.ts', hash: 'a'.repeat(64) },
        '2': { test: 'tests/contracts/charge.test.ts', hash: 'c'.repeat(64) },
      },
      refund: { '1': { test: 'tests/contracts/refund.test.ts', hash: 'b'.repeat(64) } },
    });
  });

  it.each([
    ['a version key that is not a whole number', '{"ports":{"charge":{"1.5":{"hash":"h","test":"t"}}}}', 'not a contract version'],
    ['a record that is not an object', '{"ports":{"charge":{"1":"h"}}}', 'must be a JSON object'],
    ['a record missing its hash', '{"ports":{"charge":{"1":{"test":"t"}}}}', '.hash" must be a string'],
    ['an unexpected key inside a record', '{"ports":{"charge":{"1":{"hash":"h","test":"t","note":"x"}}}}', 'unexpected key "note"'],
    ['ports that is not an object', '{"ports":[]}', '.ports" must be a JSON object when present'],
  ])('refuses %s rather than reading it as no baseline at all', async (_label, nodeEntry, expected) => {
    const dir = path.join(FIXTURES_DIR, 'tmp-lock-ports-bad');
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
      expect((err as LockInvalidError).message).toContain(expected);
    }
  });
});
