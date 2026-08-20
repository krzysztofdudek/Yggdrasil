import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDebugLog, _resetForTesting } from '../../../src/utils/debug-log.js';
import { writeBlobRecord, readBlobRecord } from '../../../src/io/roots-blob-cache.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/blob-cache.test.ts — the sharded, content-addressed
// historical-blob cache (D14). Real tmp dirs, no mocks. Per-record tolerant:
// a corrupt shard is a miss, never a throw.
// ---------------------------------------------------------------------------

const dirsToCleanup: string[] = [];
afterEach(async () => {
  for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  _resetForTesting();
});

async function freshCacheDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-blob-cache-'));
  dirsToCleanup.push(dir);
  return dir;
}

const KEY = 'ab12'.padEnd(64, '0'); // a well-formed 64-hex-char key, shard prefix "ab"

describe('roots-blob-cache — round-trip', () => {
  it('writes and reads back an arbitrary JSON-representable record unchanged', async () => {
    const cacheDir = await freshCacheDir();
    const record = { bytes: 512, skipped: false, scopes: [{ kind: 'function', qualifiedName: 'f' }] };
    await writeBlobRecord(cacheDir, KEY, record);
    const read = await readBlobRecord(cacheDir, KEY);
    expect(read).toEqual(record);
  });

  it('two writes of the same record produce byte-identical shard files', async () => {
    const cacheDir = await freshCacheDir();
    const record = { b: 2, a: 1 }; // deliberately out-of-order keys — canonical form must sort them
    await writeBlobRecord(cacheDir, KEY, record);
    const first = await readFile(path.join(cacheDir, KEY.slice(0, 2), `${KEY}.json`), 'utf-8');
    await writeBlobRecord(cacheDir, KEY, record);
    const second = await readFile(path.join(cacheDir, KEY.slice(0, 2), `${KEY}.json`), 'utf-8');
    expect(second).toBe(first);
    expect(first).toBe('{"a":1,"b":2}'); // canonical: sorted keys, no whitespace
  });
});

describe('roots-blob-cache — D14 shard layout', () => {
  it('writeBlobRecord creates exactly <dir>/<prefix>/<key>.json, one directory per 2-hex prefix', async () => {
    const cacheDir = await freshCacheDir();
    await writeBlobRecord(cacheDir, KEY, { bytes: 1, skipped: true, reason: 'oversize' });
    const expectedPath = path.join(cacheDir, KEY.slice(0, 2), `${KEY}.json`);
    expect(existsSync(expectedPath)).toBe(true);
    // Never an aggregate <dir>/<prefix>.json.
    expect(existsSync(path.join(cacheDir, `${KEY.slice(0, 2)}.json`))).toBe(false);
  });

  it('two different keys sharing a 2-hex prefix land in the same shard directory as sibling files', async () => {
    const cacheDir = await freshCacheDir();
    const keyA = 'ab'.padEnd(64, '1');
    const keyB = 'ab'.padEnd(64, '2');
    await writeBlobRecord(cacheDir, keyA, { v: 'a' });
    await writeBlobRecord(cacheDir, keyB, { v: 'b' });
    expect(existsSync(path.join(cacheDir, 'ab', `${keyA}.json`))).toBe(true);
    expect(existsSync(path.join(cacheDir, 'ab', `${keyB}.json`))).toBe(true);
    expect(await readBlobRecord(cacheDir, keyA)).toEqual({ v: 'a' });
    expect(await readBlobRecord(cacheDir, keyB)).toEqual({ v: 'b' });
  });
});

describe('roots-blob-cache — canonical JSON drops undefined-valued fields (F8)', () => {
  it('a record carrying an undefined-valued field serializes without that key, never the bare `undefined` token', async () => {
    const cacheDir = await freshCacheDir();
    // JSON.stringify(undefined) is the JS value `undefined`; naively templated in it renders as
    // the bare token `undefined`, producing syntactically invalid JSON on disk. Deleting the
    // filter would make this write `{"a":1,"c":undefined}` verbatim.
    const record = { a: 1, b: undefined, c: 3 };
    await writeBlobRecord(cacheDir, KEY, record);
    const bytes = await readFile(path.join(cacheDir, KEY.slice(0, 2), `${KEY}.json`), 'utf-8');
    expect(bytes).toBe('{"a":1,"c":3}');
    expect(bytes).not.toContain('undefined');
  });
});

describe('roots-blob-cache — write-failure degrade (R4-I10)', () => {
  it('a write failure is one debugWrite and the caller continues — never a throw', async () => {
    const cacheDir = await freshCacheDir();

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-blob-cache-debug2-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    const failingWrite = async (): Promise<void> => {
      throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
    };

    await expect(writeBlobRecord(cacheDir, KEY, { fine: true }, { write: failingWrite })).resolves.toBeUndefined();
    expect(appended.some((t) => t.includes('write failed'))).toBe(true);
    // The run continues: the shard was never actually written, but a subsequent write with the
    // real writer still succeeds — the failure didn't poison the cache directory.
    await writeBlobRecord(cacheDir, KEY, { fine: true });
    expect(await readBlobRecord(cacheDir, KEY)).toEqual({ fine: true });
  });
});

describe('roots-blob-cache — per-record tolerance (R4-I10)', () => {
  it('a missing shard reads as undefined (a miss), never a throw', async () => {
    const cacheDir = await freshCacheDir();
    const read = await readBlobRecord(cacheDir, KEY);
    expect(read).toBeUndefined();
  });

  it('a shard path occupied by a directory (not a file) reads as a miss, never a throw, and logs one debugWrite line', async () => {
    const cacheDir = await freshCacheDir();
    const shardDir = path.join(cacheDir, KEY.slice(0, 2));
    await mkdir(path.join(shardDir, `${KEY}.json`), { recursive: true }); // a directory where a file is expected

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-blob-cache-debug3-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    const read = await readBlobRecord(cacheDir, KEY);
    expect(read).toBeUndefined();
    expect(appended.some((t) => t.includes('unreadable shard'))).toBe(true);
  });

  it('a corrupt shard file reads as a miss (undefined), never a throw, and logs one debugWrite line', async () => {
    const cacheDir = await freshCacheDir();
    const shardDir = path.join(cacheDir, KEY.slice(0, 2));
    await mkdir(shardDir, { recursive: true });
    await writeFile(path.join(shardDir, `${KEY}.json`), 'not json at all {{{', 'utf-8');

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-blob-cache-debug-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    const read = await readBlobRecord(cacheDir, KEY);
    expect(read).toBeUndefined();
    expect(appended.some((t) => t.includes('corrupt shard'))).toBe(true);
  });

  it('a corrupt shard does not poison any other key\'s shard', async () => {
    const cacheDir = await freshCacheDir();
    const shardDir = path.join(cacheDir, KEY.slice(0, 2));
    await mkdir(shardDir, { recursive: true });
    await writeFile(path.join(shardDir, `${KEY}.json`), 'garbage', 'utf-8');

    const okKey = 'ab'.padEnd(64, '9');
    await writeBlobRecord(cacheDir, okKey, { fine: true });

    expect(await readBlobRecord(cacheDir, KEY)).toBeUndefined();
    expect(await readBlobRecord(cacheDir, okKey)).toEqual({ fine: true });
  });
});

describe('roots-blob-cache — a thrown non-Error value still formats a debugWrite message (coverage)', () => {
  it('a write failure that throws a bare string (not an Error instance) is still one debugWrite, never a throw', async () => {
    const cacheDir = await freshCacheDir();

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-blob-cache-debug4-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    // A caller-supplied `write` is not contractually bound to throw Error instances — a
    // rejected promise's reason can be any value. errMsg's fallback (`String(e)`) exists for
    // exactly this shape.
    const throwsBareString = async (): Promise<void> => {
      throw 'a bare string rejection reason';
    };

    await expect(writeBlobRecord(cacheDir, KEY, { fine: true }, { write: throwsBareString })).resolves.toBeUndefined();
    expect(appended.some((t) => t.includes('write failed') && t.includes('a bare string rejection reason'))).toBe(true);
  });
});
