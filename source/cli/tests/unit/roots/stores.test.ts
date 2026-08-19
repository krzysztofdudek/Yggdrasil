import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  rootsStoreDir,
  rootsCacheDir,
  rootsStateDir,
  CACHE_DIRNAME,
  STATE_DIRNAME,
  writeModel,
  readModel,
  readSeeds,
  hashStoreFile,
  ROOTS_VERSION,
  MODEL_FILENAME,
  SEEDS_FILENAME,
  DECISIONS_FILENAME,
  type RootsModelHeader,
} from '../../../src/roots/stores.js';
import { hashString } from '../../../src/io/hash.js';
import type { SeedEntry } from '../../../src/model/graph.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/stores.test.ts — the roots store's model.json header/body
// I/O, the seeds.jsonl reader, and the per-store-file hash helper. Real
// tmp-dir fixtures throughout (mkdtemp under os.tmpdir()), no mocks.
// ---------------------------------------------------------------------------

const dirsToCleanup: string[] = [];
afterEach(async () => {
  for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

async function freshYggRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-stores-'));
  dirsToCleanup.push(dir);
  return dir;
}

function sampleHeader(overrides: Partial<RootsModelHeader> = {}): RootsModelHeader {
  return {
    rootsVersion: ROOTS_VERSION,
    headSha: 'a'.repeat(40),
    lastIndexedSha: null,
    clock: '2026-08-19T00:00:00.000Z',
    bindingHash: 'b'.repeat(64),
    configHash: 'c'.repeat(64),
    seedsHash: hashString(''),
    decisionsHash: hashString(''),
    ledgerHash: hashString(''),
    dirtyHash: hashString(''),
    candidateCountLog2: 0,
    rolesStale: false,
    ...overrides,
  };
}

describe('roots stores — fresh repo reads (absent files) → typed empties', () => {
  it('readModel on a repo with no .yggdrasil/roots/ at all returns undefined', async () => {
    const yggRoot = await freshYggRoot();
    expect(await readModel(yggRoot)).toBeUndefined();
  });

  it('readSeeds on a repo with no seeds.jsonl returns an empty typed array', async () => {
    const yggRoot = await freshYggRoot();
    const seeds = await readSeeds(yggRoot);
    expect(seeds).toEqual([]);
  });

  it('hashStoreFile on an absent file returns the hash of the empty string', async () => {
    const yggRoot = await freshYggRoot();
    const hash = await hashStoreFile(yggRoot, DECISIONS_FILENAME);
    expect(hash).toBe(hashString(''));
  });
});

describe('roots stores — writeModel / readModel round-trip', () => {
  it('round-trips header + body unchanged', async () => {
    const yggRoot = await freshYggRoot();
    const header = sampleHeader();
    const body = { field: { convention: 'x' }, roles: [], zebra: 1, alpha: 2 };

    await writeModel(yggRoot, header, body);
    const read = await readModel(yggRoot);

    expect(read).toBeDefined();
    expect(read?.header).toEqual(header);
    expect(read?.body).toEqual(body);
  });

  it('writes canonically: two writes of the SAME header+body produce byte-identical files', async () => {
    const yggRoot = await freshYggRoot();
    const header = sampleHeader();
    const body = { z: 1, a: 2, nested: { y: 1, x: 2 } };

    await writeModel(yggRoot, header, body);
    const first = await readFile(path.join(rootsStoreDir(yggRoot), MODEL_FILENAME), 'utf-8');

    await writeModel(yggRoot, header, body);
    const second = await readFile(path.join(rootsStoreDir(yggRoot), MODEL_FILENAME), 'utf-8');

    expect(second).toBe(first);
  });

  it('writes canonically: the SAME values built with a DIFFERENT key insertion order produce byte-identical files', async () => {
    const yggRoot = await freshYggRoot();
    const header = sampleHeader();
    const bodyA = { z: 1, a: 2, nested: { y: 1, x: 2 } };
    const bodyB = { nested: { x: 2, y: 1 }, a: 2, z: 1 };

    await writeModel(yggRoot, header, bodyA);
    const first = await readFile(path.join(rootsStoreDir(yggRoot), MODEL_FILENAME), 'utf-8');

    await writeModel(yggRoot, header, bodyB);
    const second = await readFile(path.join(rootsStoreDir(yggRoot), MODEL_FILENAME), 'utf-8');

    expect(second).toBe(first);
  });

  it('is atomic: after a write, no orphaned temp file is left in .yggdrasil/roots/', async () => {
    const yggRoot = await freshYggRoot();
    await writeModel(yggRoot, sampleHeader(), { ok: true });

    const entries = await readdir(rootsStoreDir(yggRoot));
    // Exact-list assertion: a wrong temp-name regex could never pass vacuously.
    expect(entries).toEqual([MODEL_FILENAME]);
  });
});

describe('roots stores — header carries rootsVersion + decisionsHash', () => {
  it('a header round-tripped through writeModel/readModel keeps rootsVersion and a real decisionsHash', async () => {
    const yggRoot = await freshYggRoot();
    await mkdir(rootsStoreDir(yggRoot), { recursive: true });
    const decisionsLine = JSON.stringify({ v: 1, ts: '2026-08-19T00:00:00.000Z', action: 'promote' }) + '\n';
    await writeFile(path.join(rootsStoreDir(yggRoot), DECISIONS_FILENAME), decisionsLine, 'utf-8');

    const decisionsHash = await hashStoreFile(yggRoot, DECISIONS_FILENAME);
    expect(decisionsHash).toBe(hashString(decisionsLine));
    expect(decisionsHash).not.toBe(hashString(''));

    const header = sampleHeader({ decisionsHash });
    await writeModel(yggRoot, header, {});
    const read = await readModel(yggRoot);

    expect(read?.header.rootsVersion).toBe(ROOTS_VERSION);
    expect(read?.header.decisionsHash).toBe(decisionsHash);
  });
});

describe('roots stores — readSeeds', () => {
  it('parses well-formed seed lines, typed as SeedEntry[]', async () => {
    const yggRoot = await freshYggRoot();
    await mkdir(rootsStoreDir(yggRoot), { recursive: true });
    const seed: SeedEntry = {
      seedId: 'deadbeefdeadbeef',
      scopeRef: { path: 'src/handlers/refund.ts', qualifiedName: 'RefundHandler' },
      surfaces: ['call'],
      weight: 8,
      arch: false,
      note: 'target handler shape',
      author: 'maintainer',
      createdAt: '2026-08-19T00:00:00.000Z',
    };
    await writeFile(path.join(rootsStoreDir(yggRoot), SEEDS_FILENAME), `${JSON.stringify(seed)}\n`, 'utf-8');

    const seeds = await readSeeds(yggRoot);
    expect(seeds).toEqual([seed]);
  });

  it('skips a malformed line (non-JSON) without throwing, keeping well-formed lines around it', async () => {
    const yggRoot = await freshYggRoot();
    await mkdir(rootsStoreDir(yggRoot), { recursive: true });
    const seed: SeedEntry = {
      seedId: 'cafebabecafebabe',
      scopeRef: { path: 'src/a.ts', qualifiedName: 'A' },
      surfaces: ['import'],
      weight: 4,
      arch: true,
      author: 'maintainer',
      createdAt: '2026-08-19T00:00:00.000Z',
    };
    const content = `${JSON.stringify(seed)}\nnot json at all\n`;
    await writeFile(path.join(rootsStoreDir(yggRoot), SEEDS_FILENAME), content, 'utf-8');

    const seeds = await readSeeds(yggRoot);
    expect(seeds).toEqual([seed]);
  });

  it('skips a mis-shaped record (missing required field) without throwing', async () => {
    const yggRoot = await freshYggRoot();
    await mkdir(rootsStoreDir(yggRoot), { recursive: true });
    const missingAuthor = { seedId: 'x', scopeRef: { path: 'a', qualifiedName: 'A' }, surfaces: [], weight: 1, arch: false, createdAt: 't' };
    await writeFile(path.join(rootsStoreDir(yggRoot), SEEDS_FILENAME), `${JSON.stringify(missingAuthor)}\n`, 'utf-8');

    const seeds = await readSeeds(yggRoot);
    expect(seeds).toEqual([]);
  });

  it('a note-less seed (note is optional) parses correctly', async () => {
    const yggRoot = await freshYggRoot();
    await mkdir(rootsStoreDir(yggRoot), { recursive: true });
    const seed: SeedEntry = {
      seedId: 'noNoteSeed000000',
      scopeRef: { path: 'src/b.ts', qualifiedName: 'B' },
      surfaces: ['decorator'],
      weight: 2,
      arch: false,
      author: 'maintainer',
      createdAt: '2026-08-19T00:00:00.000Z',
    };
    await writeFile(path.join(rootsStoreDir(yggRoot), SEEDS_FILENAME), `${JSON.stringify(seed)}\n`, 'utf-8');

    const seeds = await readSeeds(yggRoot);
    expect(seeds).toEqual([seed]);
  });
});

describe('roots stores — readModel error handling', () => {
  it('rejects unparseable JSON in model.json rather than silently returning an empty model', async () => {
    const yggRoot = await freshYggRoot();
    await mkdir(rootsStoreDir(yggRoot), { recursive: true });
    await writeFile(path.join(rootsStoreDir(yggRoot), MODEL_FILENAME), 'not json {{{', 'utf-8');

    await expect(readModel(yggRoot)).rejects.toThrow(/unparseable JSON/);
  });

  it('rejects a model.json missing the header/body shape', async () => {
    const yggRoot = await freshYggRoot();
    await mkdir(rootsStoreDir(yggRoot), { recursive: true });
    await writeFile(path.join(rootsStoreDir(yggRoot), MODEL_FILENAME), JSON.stringify({ notHeader: true }), 'utf-8');

    await expect(readModel(yggRoot)).rejects.toThrow(/expected \{ header, body \} shape/);
  });
});

describe('roots stores — rootsStoreDir', () => {
  it('resolves to <yggRoot>/roots', async () => {
    const yggRoot = await freshYggRoot();
    expect(rootsStoreDir(yggRoot)).toBe(path.join(yggRoot, 'roots'));
  });
});

describe('roots stores — layout constants and schema-version guard', () => {
  it('the gitignored derived roots live at .cache/ and .state/ under the store dir', () => {
    expect(rootsCacheDir('/tmp/x/.yggdrasil')).toBe(
      path.join('/tmp/x/.yggdrasil', 'roots', CACHE_DIRNAME),
    );
    expect(rootsStateDir('/tmp/x/.yggdrasil')).toBe(
      path.join('/tmp/x/.yggdrasil', 'roots', STATE_DIRNAME),
    );
    expect(CACHE_DIRNAME).toBe('.cache');
    expect(STATE_DIRNAME).toBe('.state');
  });

  it('readModel refuses a model written by a different roots schema version, naming both', async () => {
    const yggRoot = await freshYggRoot();
    await writeModel(yggRoot, { ...sampleHeader(), rootsVersion: ROOTS_VERSION + 1 }, { ok: true });

    await expect(readModel(yggRoot)).rejects.toThrow(
      new RegExp(`version ${ROOTS_VERSION + 1}.*version ${ROOTS_VERSION}`),
    );
  });
});
