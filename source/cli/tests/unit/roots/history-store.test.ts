import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, unlink, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDebugLog, _resetForTesting } from '../../../src/utils/debug-log.js';
import { atomicWriteFile } from '../../../src/io/atomic-write.js';
import {
  readHistoryState,
  writeHistoryState,
  HISTORY_LIFECYCLE_FILENAME,
  HISTORY_EVENTS_FILENAME,
  HISTORY_ALIASES_FILENAME,
  HISTORY_COCHANGE_RAW_FILENAME,
  HISTORY_COCHANGE_FILENAME,
  HISTORY_META_FILENAME,
  type HistoryState,
} from '../../../src/io/roots-history-store.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/history-store.test.ts — the D1 six-file replay-state
// store. Real tmp dirs, no mocks. All-or-nothing on damage (D15) — the
// deliberately OPPOSITE tolerance from blob-cache.test.ts's per-record miss.
// ---------------------------------------------------------------------------

const dirsToCleanup: string[] = [];
afterEach(async () => {
  for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  _resetForTesting();
});

async function freshStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-'));
  dirsToCleanup.push(dir);
  return dir;
}

function sampleState(epoch = 'epoch-1'): HistoryState {
  return {
    meta: {
      stateSchemaVersion: 1,
      stateEpoch: epoch,
      lastIndexedSha: 'a'.repeat(40),
      inputsHash: 'b'.repeat(64),
      blobsSeen: ['c'.repeat(40)],
    },
    lifecycle: [
      { key: 'src/a.ts', level: 'file', modifications: 1 },
      { key: 'src/a.ts#function#f', level: 'scope', modifications: 1 },
    ],
    events: [{ ts: 100, key: 'src/a.ts#function#f', kind: 'introduction', sha: 'd'.repeat(40) }],
    aliases: [{ ts: 50, sha: 'e'.repeat(40), from: 'src/old.ts', to: 'src/new.ts' }],
    cochangeRaw: [{ a: 'src/a.ts', b: 'src/b.ts', support: 3 }],
    cochange: [{ a: 'src/a.ts', b: 'src/b.ts', sup: 3, conf: 0.5 }],
  };
}

const SIX_FILENAMES = [
  HISTORY_LIFECYCLE_FILENAME,
  HISTORY_EVENTS_FILENAME,
  HISTORY_ALIASES_FILENAME,
  HISTORY_COCHANGE_RAW_FILENAME,
  HISTORY_COCHANGE_FILENAME,
  HISTORY_META_FILENAME,
];

describe('roots-history-store — absence', () => {
  it('an absent state directory returns undefined — "no state", never an empty-history state, and never throws', async () => {
    const dir = await freshStateDir();
    const stateDir = path.join(dir, 'does-not-exist');
    const state = await readHistoryState(stateDir);
    expect(state).toBeUndefined();
  });
});

describe('roots-history-store — write order is fixed (D15, F2)', () => {
  it('writeHistoryState emits the five accumulators before meta.json, never the reverse', async () => {
    const dir = await freshStateDir();
    const writeOrder: string[] = [];
    const recordingWrite = async (filePath: string, content: string): Promise<void> => {
      writeOrder.push(filePath);
      await atomicWriteFile(filePath, content);
    };

    await writeHistoryState(dir, sampleState(), { write: recordingWrite });

    expect(writeOrder).toHaveLength(6);
    const metaIndex = writeOrder.indexOf(path.join(dir, HISTORY_META_FILENAME));
    expect(metaIndex).toBe(5); // meta.json is the LAST of the six calls, unconditionally
    const accumulatorPaths = new Set([
      HISTORY_LIFECYCLE_FILENAME,
      HISTORY_EVENTS_FILENAME,
      HISTORY_ALIASES_FILENAME,
      HISTORY_COCHANGE_RAW_FILENAME,
      HISTORY_COCHANGE_FILENAME,
    ]);
    for (const p of writeOrder.slice(0, 5)) {
      expect(accumulatorPaths.has(path.basename(p))).toBe(true);
    }
  });
});

describe('roots-history-store — write-failure degrade (R4-I10, F3)', () => {
  it('a failure writing one accumulator is one debugWrite; the other files are still attempted and land', async () => {
    const dir = await freshStateDir();
    const state = sampleState();
    const failingChannelPath = path.join(dir, HISTORY_EVENTS_FILENAME);
    const write = async (filePath: string, content: string): Promise<void> => {
      if (filePath === failingChannelPath) throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      await atomicWriteFile(filePath, content);
    };

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-debug4-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    await writeHistoryState(dir, state, { write });

    expect(appended.some((t) => t.includes('write failed') && t.includes(HISTORY_EVENTS_FILENAME))).toBe(true);
    // The run continued: every OTHER file still landed (R4-I10 — a failed write degrades, never aborts).
    expect(existsSync(path.join(dir, HISTORY_LIFECYCLE_FILENAME))).toBe(true);
    expect(existsSync(path.join(dir, HISTORY_META_FILENAME))).toBe(true);
    expect(existsSync(failingChannelPath)).toBe(false);
    // The directory as a whole is exactly D15's "one missing while the rest exist" shape, and
    // reads back as no usable state at all — proven separately below, not re-asserted here.
  });

  it('a failure writing meta.json specifically is its own one debugWrite (not folded into the channel-loop message)', async () => {
    const dir = await freshStateDir();
    const state = sampleState();
    const metaPath = path.join(dir, HISTORY_META_FILENAME);
    const write = async (filePath: string, content: string): Promise<void> => {
      if (filePath === metaPath) throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
      await atomicWriteFile(filePath, content);
    };

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-debug5-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    await expect(writeHistoryState(dir, state, { write })).resolves.toBeUndefined();
    expect(appended.some((t) => t.includes('write failed') && t.includes(HISTORY_META_FILENAME))).toBe(true);
    expect(existsSync(path.join(dir, HISTORY_LIFECYCLE_FILENAME))).toBe(true);
    expect(existsSync(metaPath)).toBe(false);
  });
});

describe('roots-history-store — canonical JSON drops undefined-valued fields (F8)', () => {
  it('a meta.json field carrying an undefined value serializes without that key, never the bare `undefined` token', async () => {
    const dir = await freshStateDir();
    const state = sampleState();
    (state.meta as Record<string, unknown>).optionalField = undefined;
    await writeHistoryState(dir, state);
    const bytes = await readFile(path.join(dir, HISTORY_META_FILENAME), 'utf-8');
    expect(bytes).not.toContain('undefined');
    expect(bytes).not.toContain('optionalField');
  });
});

describe('roots-history-store — round-trip', () => {
  it('writes and reads back all six files, byte-identical content on each of two writes', async () => {
    const dir = await freshStateDir();
    const state = sampleState();
    await writeHistoryState(dir, state);

    const contentsFirst = await Promise.all(SIX_FILENAMES.map((f) => readFile(path.join(dir, f), 'utf-8')));
    await writeHistoryState(dir, state);
    const contentsSecond = await Promise.all(SIX_FILENAMES.map((f) => readFile(path.join(dir, f), 'utf-8')));
    expect(contentsSecond).toEqual(contentsFirst);
  });

  it('a directory holding a clean state that describes an empty history returns that state (never undefined)', async () => {
    const dir = await freshStateDir();
    const empty: HistoryState = {
      meta: { stateSchemaVersion: 1, stateEpoch: 'empty-epoch' },
      lifecycle: [],
      events: [],
      aliases: [],
      cochangeRaw: [],
      cochange: [],
    };
    await writeHistoryState(dir, empty);
    const read = await readHistoryState(dir);
    expect(read).toBeDefined();
    expect(read?.lifecycle).toEqual([]);
    expect(read?.meta.stateEpoch).toBe('empty-epoch');
  });

  it('readHistoryState returns the same records the state was written with', async () => {
    const dir = await freshStateDir();
    const state = sampleState();
    await writeHistoryState(dir, state);
    const read = await readHistoryState(dir);
    expect(read).toBeDefined();
    expect(read?.lifecycle).toEqual(state.lifecycle);
    expect(read?.events).toEqual(state.events);
    expect(read?.aliases).toEqual(state.aliases);
    expect(read?.cochangeRaw).toEqual(state.cochangeRaw);
    expect(read?.cochange).toEqual(state.cochange);
    expect(read?.meta).toEqual(state.meta);
  });
});

describe('roots-history-store — all-or-nothing on damage (D15)', () => {
  it('a directory holding only five of the six files loads as undefined, never a resume from whatever survived', async () => {
    const dir = await freshStateDir();
    await writeHistoryState(dir, sampleState());
    await unlink(path.join(dir, HISTORY_ALIASES_FILENAME));

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-debug-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    const read = await readHistoryState(dir);
    expect(read).toBeUndefined();
    expect(appended.some((t) => t.includes('missing state file'))).toBe(true);
  });

  it('a malformed line anywhere in any of the six files makes the whole directory read as no usable state', async () => {
    const dir = await freshStateDir();
    await writeHistoryState(dir, sampleState());
    const lifecyclePath = path.join(dir, HISTORY_LIFECYCLE_FILENAME);
    const original = await readFile(lifecyclePath, 'utf-8');
    await writeFile(lifecyclePath, `${original}not valid json\n`, 'utf-8');

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-debug2-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    const read = await readHistoryState(dir);
    expect(read).toBeUndefined();
    expect(appended.some((t) => t.includes('malformed'))).toBe(true);
  });

  it('an unparseable meta.json makes the whole directory read as no usable state', async () => {
    const dir = await freshStateDir();
    await writeHistoryState(dir, sampleState());
    await writeFile(path.join(dir, HISTORY_META_FILENAME), 'not json {{{', 'utf-8');

    const read = await readHistoryState(dir);
    expect(read).toBeUndefined();
  });

  it('a meta.json carrying a different stateEpoch than its accumulators (torn write) loads as no state at all', async () => {
    const dir = await freshStateDir();
    // Write two full, independently valid states with different epochs, then
    // hand-assemble a torn set: state A's five accumulators beside state B's
    // meta.json — exactly the shape a process killed between writes leaves.
    const stateA = sampleState('epoch-A');
    const stateB = sampleState('epoch-B');
    await writeHistoryState(dir, stateA);
    const otherDir = await freshStateDir();
    await writeHistoryState(otherDir, stateB);
    const tornMeta = await readFile(path.join(otherDir, HISTORY_META_FILENAME), 'utf-8');
    await writeFile(path.join(dir, HISTORY_META_FILENAME), tornMeta, 'utf-8');

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-debug3-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    const read = await readHistoryState(dir);
    expect(read).toBeUndefined();
    expect(appended.some((t) => t.includes('epoch disagreement'))).toBe(true);
  });

  // F6 — D15 requires rejection on a `stateEpoch` OR
  // schema-version disagreement across the six stored copies; the code checks both
  // (`:287` — `h.stateEpoch === first.stateEpoch && h.stateSchemaVersion === first.stateSchemaVersion`).
  // A mutation reducing the predicate to the epoch half alone survived all 366 tests (the
  // reviewer's RM-B) because nothing constructed six files whose `stateEpoch`s agree but whose
  // `stateSchemaVersion`s do not. This test does exactly that.
  it('a stateSchemaVersion disagreement across the six stored files, with every stateEpoch still agreeing, makes the whole directory read as no usable state (F6)', async () => {
    const dir = await freshStateDir();
    await writeHistoryState(dir, sampleState());

    const lifecyclePath = path.join(dir, HISTORY_LIFECYCLE_FILENAME);
    const lines = (await readFile(lifecyclePath, 'utf-8')).split('\n');
    const header = JSON.parse(lines[0]) as { stateEpoch: string; stateSchemaVersion: number };
    lines[0] = JSON.stringify({ ...header, stateSchemaVersion: header.stateSchemaVersion + 1 }); // same epoch, different schema version
    await writeFile(lifecyclePath, lines.join('\n'), 'utf-8');

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-debug6-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    const read = await readHistoryState(dir);
    expect(read).toBeUndefined();
    expect(appended.some((t) => t.includes('epoch disagreement'))).toBe(true);
  });
});

describe('roots-history-store — damage-detail coverage (each malformation path, real behavior)', () => {
  it('an empty (zero-byte) channel file has no epoch-header line and reads as no usable state', async () => {
    const dir = await freshStateDir();
    await writeHistoryState(dir, sampleState());
    await writeFile(path.join(dir, HISTORY_EVENTS_FILENAME), '', 'utf-8');

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-debug7-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    const read = await readHistoryState(dir);
    expect(read).toBeUndefined();
    expect(appended.some((t) => t.includes('no epoch-header line'))).toBe(true);
  });

  it('an unparseable header line (line 1) reads as no usable state, distinct from a malformed data line', async () => {
    const dir = await freshStateDir();
    await writeHistoryState(dir, sampleState());
    await writeFile(path.join(dir, HISTORY_ALIASES_FILENAME), 'not json at all\nmore\n', 'utf-8');

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-debug8-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    const read = await readHistoryState(dir);
    expect(read).toBeUndefined();
    expect(appended.some((t) => t.includes('epoch header) is unparseable'))).toBe(true);
  });

  it('a header line that is valid JSON but not a valid epoch header reads as no usable state', async () => {
    const dir = await freshStateDir();
    await writeHistoryState(dir, sampleState());
    await writeFile(path.join(dir, HISTORY_COCHANGE_RAW_FILENAME), '{"notAnEpoch":true}\n', 'utf-8');

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-debug9-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    const read = await readHistoryState(dir);
    expect(read).toBeUndefined();
    expect(appended.some((t) => t.includes('line 1 is not a valid epoch header'))).toBe(true);
  });

  it('a meta.json that is valid JSON but not a valid epoch header reads as no usable state', async () => {
    const dir = await freshStateDir();
    await writeHistoryState(dir, sampleState());
    await writeFile(path.join(dir, HISTORY_META_FILENAME), '{"notAnEpoch":true}', 'utf-8');

    const read = await readHistoryState(dir);
    expect(read).toBeUndefined();
  });

  it('a channel path occupied by a directory (not a file) reads as no usable state via the same "unreadable" path as a permission failure', async () => {
    const dir = await freshStateDir();
    await writeHistoryState(dir, sampleState());
    await unlink(path.join(dir, HISTORY_EVENTS_FILENAME));
    await mkdir(path.join(dir, HISTORY_EVENTS_FILENAME), { recursive: true }); // still "exists" per existsSync, but unreadable as a file

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-debug10-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    const read = await readHistoryState(dir);
    expect(read).toBeUndefined();
    expect(appended.some((t) => t.includes('unreadable') && t.includes(HISTORY_EVENTS_FILENAME))).toBe(true);
  });

  it('meta.json occupied by a directory (not a file) reads as no usable state via meta.json\'s own "unreadable" path', async () => {
    const dir = await freshStateDir();
    await writeHistoryState(dir, sampleState());
    await unlink(path.join(dir, HISTORY_META_FILENAME));
    await mkdir(path.join(dir, HISTORY_META_FILENAME), { recursive: true });

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-debug11-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    const read = await readHistoryState(dir);
    expect(read).toBeUndefined();
    expect(appended.some((t) => t.includes(`unreadable ${HISTORY_META_FILENAME}`))).toBe(true);
  });

  it('a channel file with no trailing newline still parses correctly (the trailing-empty-line trim is optional, not required)', async () => {
    const dir = await freshStateDir();
    await writeHistoryState(dir, sampleState());
    // writeJsonlChannel always terminates with `\n`; hand-write one channel WITHOUT that
    // trailing newline to exercise the branch where there is no bogus empty final element to
    // trim.
    const aliasesPath = path.join(dir, HISTORY_ALIASES_FILENAME);
    const withoutTrailingNewline = (await readFile(aliasesPath, 'utf-8')).replace(/\n$/, '');
    await writeFile(aliasesPath, withoutTrailingNewline, 'utf-8');

    const read = await readHistoryState(dir);
    expect(read).toBeDefined();
    expect(read?.aliases).toEqual(sampleState().aliases);
  });
});

describe('roots-history-store — a thrown non-Error value still formats a debugWrite message (coverage)', () => {
  it('a write failure that throws a bare string (not an Error instance) is still one debugWrite, never a throw', async () => {
    const dir = await freshStateDir();

    const debugRoot = await mkdtemp(path.join(tmpdir(), 'yg-roots-history-store-debug12-'));
    dirsToCleanup.push(debugRoot);
    const appended: string[] = [];
    initDebugLog(debugRoot, true, (_p, text) => appended.push(text));

    // A caller-supplied `write` is not contractually bound to throw Error instances — a
    // rejected promise's reason can be any value. errMsg's fallback (`String(e)`) exists for
    // exactly this shape.
    const throwsBareString = async (): Promise<void> => {
      throw 'a bare string rejection reason';
    };

    await expect(writeHistoryState(dir, sampleState(), { write: throwsBareString })).resolves.toBeUndefined();
    expect(appended.some((t) => t.includes('write failed') && t.includes('a bare string rejection reason'))).toBe(true);
  });
});
