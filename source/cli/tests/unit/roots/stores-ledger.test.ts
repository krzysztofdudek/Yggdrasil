import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  rootsStoreDir,
  rootsCacheDir,
  rootsBlobCacheDir,
  rootsHistoryStateDir,
  rootsBuildLockPath,
  readLedger,
  LEDGER_FILENAME,
} from '../../../src/roots/stores.js';
import type { LedgerEntry } from '../../../src/model/graph.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/stores-ledger.test.ts — a new sibling file (never grows
// stores.test.ts): the readLedger reader (a sibling addition mirroring
// readSeeds's tolerance exactly) and the three new derived-cache path
// helpers (rootsBlobCacheDir, rootsHistoryStateDir, rootsBuildLockPath).
// ---------------------------------------------------------------------------

const dirsToCleanup: string[] = [];
afterEach(async () => {
  for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

async function freshYggRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-stores-ledger-'));
  dirsToCleanup.push(dir);
  return dir;
}

describe('roots stores — readLedger', () => {
  it('on a repo with no ledger.jsonl returns an empty typed array', async () => {
    const yggRoot = await freshYggRoot();
    const entries = await readLedger(yggRoot);
    expect(entries).toEqual([]);
  });

  it('parses well-formed ledger lines, typed as LedgerEntry[]', async () => {
    const yggRoot = await freshYggRoot();
    await mkdir(rootsStoreDir(yggRoot), { recursive: true });
    const entry: LedgerEntry = { stableId: 'sha1:deadbeef', surface: 'call', date: '2026-08-19T00:00:00.000Z' };
    await writeFile(path.join(rootsStoreDir(yggRoot), LEDGER_FILENAME), `${JSON.stringify(entry)}\n`, 'utf-8');

    const entries = await readLedger(yggRoot);
    expect(entries).toEqual([entry]);
  });

  it('skips a malformed line (non-JSON) without throwing, keeping well-formed lines around it', async () => {
    const yggRoot = await freshYggRoot();
    await mkdir(rootsStoreDir(yggRoot), { recursive: true });
    const entry: LedgerEntry = { stableId: 'sha1:cafebabe', surface: 'import', date: '2026-08-19T00:00:00.000Z' };
    const content = `${JSON.stringify(entry)}\nnot json at all\n`;
    await writeFile(path.join(rootsStoreDir(yggRoot), LEDGER_FILENAME), content, 'utf-8');

    const entries = await readLedger(yggRoot);
    expect(entries).toEqual([entry]);
  });

  it('skips a mis-shaped record (missing required field) without throwing', async () => {
    const yggRoot = await freshYggRoot();
    await mkdir(rootsStoreDir(yggRoot), { recursive: true });
    const missingDate = { stableId: 'sha1:x', surface: 'call' };
    await writeFile(path.join(rootsStoreDir(yggRoot), LEDGER_FILENAME), `${JSON.stringify(missingDate)}\n`, 'utf-8');

    const entries = await readLedger(yggRoot);
    expect(entries).toEqual([]);
  });
});

describe('roots stores — derived-cache path helpers (D14, D1)', () => {
  it('rootsBlobCacheDir is <rootsCacheDir>/blobs', async () => {
    const yggRoot = await freshYggRoot();
    expect(rootsBlobCacheDir(yggRoot)).toBe(path.join(rootsCacheDir(yggRoot), 'blobs'));
  });

  it('rootsHistoryStateDir is <rootsCacheDir>/history', async () => {
    const yggRoot = await freshYggRoot();
    expect(rootsHistoryStateDir(yggRoot)).toBe(path.join(rootsCacheDir(yggRoot), 'history'));
  });

  it('rootsBuildLockPath is <rootsCacheDir>/.build.lock', async () => {
    const yggRoot = await freshYggRoot();
    expect(rootsBuildLockPath(yggRoot)).toBe(path.join(rootsCacheDir(yggRoot), '.build.lock'));
  });

  it('all three nest under the same .cache/ root as the existing rootsCacheDir helper', async () => {
    const yggRoot = await freshYggRoot();
    const cacheDir = rootsCacheDir(yggRoot);
    expect(rootsBlobCacheDir(yggRoot).startsWith(cacheDir + path.sep)).toBe(true);
    expect(rootsHistoryStateDir(yggRoot).startsWith(cacheDir + path.sep)).toBe(true);
    expect(rootsBuildLockPath(yggRoot).startsWith(cacheDir + path.sep)).toBe(true);
  });
});
