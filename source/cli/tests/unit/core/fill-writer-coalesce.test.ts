/**
 * The fill's lock writer coalesces writes instead of rewriting the whole lock
 * once per verdict, recovers from a failed write instead of poisoning every
 * later one, and still emits each verdict's telemetry line only after the write
 * that carries that verdict.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LockFile, VerdictEntry } from '../../../src/model/lock.js';

// ── A recording stand-in for the lock-store's writer ─────────────────────────
const state = {
  writes: [] as Array<{ partitions: unknown }>,
  persisted: new Set<string>(),
  failNext: 0,
  failAlways: false,
};
vi.mock('../../../src/io/lock-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/io/lock-store.js')>();
  return {
    ...orig,
    writeLock: vi.fn(async (_root: string, lock: LockFile, opts?: { partitions?: unknown }) => {
      await new Promise((r) => setImmediate(r));
      if (state.failAlways || state.failNext > 0) {
        state.failNext = Math.max(0, state.failNext - 1);
        const e = new Error('EACCES: permission denied, rename') as NodeJS.ErrnoException;
        e.code = 'EACCES';
        throw e;
      }
      state.writes.push({ partitions: opts?.partitions });
      for (const [aspectId, units] of Object.entries(lock.verdicts)) {
        for (const unit of Object.keys(units)) state.persisted.add(`${aspectId}|${unit}`);
      }
    }),
    writeLockSync: vi.fn(),
  };
});

const emitted: Array<{ key: string; persistedWhenEmitted: boolean }> = [];
vi.mock('../../../src/io/events-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/io/events-store.js')>();
  return {
    ...orig,
    appendVerdictEvent: vi.fn((_root: string, ev: { aspectId: string; unitKey: string }) => {
      const key = `${ev.aspectId}|${ev.unitKey}`;
      emitted.push({ key, persistedWhenEmitted: state.persisted.has(key) });
    }),
  };
});

const { createVerdictWriter } = await import('../../../src/core/fill-writer.js');
type WriterParams = Parameters<typeof createVerdictWriter>[0];
type Writer = ReturnType<typeof createVerdictWriter>;
type ExpectedPair = Parameters<Writer['setEntry']>[0];
const { LockEnvironmentError } = await import('../../../src/io/lock-store.js');

function makeWriter() {
  const lock: LockFile = { version: 1, verdicts: {}, nodes: {} } as unknown as LockFile;
  const graph = { rootPath: '/nonexistent/.yggdrasil' } as unknown as WriterParams['graph'];
  const writer = createVerdictWriter({
    graph,
    lock,
    now: () => 0,
    onlyDeterministic: false,
    committedLlm: false,
    deterministicAspectIds: new Set(['det-a']),
  });
  return { writer, lock };
}

function pair(aspectId: string, i: number, kind: 'deterministic' | 'llm'): ExpectedPair {
  return { aspectId, kind, unitKey: `node:n${i}`, status: 'enforced', subjectFiles: [] } as unknown as ExpectedPair;
}
const entry = (): VerdictEntry => ({ verdict: 'approved', hash: 'h' }) as VerdictEntry;

beforeEach(() => {
  state.writes = [];
  state.persisted = new Set();
  state.failNext = 0;
  state.failAlways = false;
  emitted.length = 0;
});

describe('fill verdict writer — coalesced lock writes', () => {
  it('writes the lock in batches, not once per deterministic verdict, and only the partition that changed', async () => {
    const { writer } = makeWriter();
    for (let i = 0; i < 1000; i++) await writer.setEntry(pair('det-a', i, 'deterministic'), entry());
    await writer.drain();
    await writer.close();
    // One write per verdict was the quadratic path: 1000 full rewrites of a growing lock.
    expect(state.writes.length).toBeLessThanOrEqual(10);
    expect(state.persisted.size).toBe(1000);
    // A deterministic verdict never rewrites the committed files.
    for (const w of state.writes) expect(w.partitions).toEqual({ nondet: false, logs: false, det: true });
  });

  it('holds a paid (LLM) verdict until it is on disk', async () => {
    const { writer } = makeWriter();
    await writer.setEntry(pair('llm-a', 1, 'llm'), entry());
    expect(state.persisted.has('llm-a|node:n1')).toBe(true);
    await writer.close();
  });

  it('emits every verdict event only after the write that carries the verdict', async () => {
    const { writer } = makeWriter();
    for (let i = 0; i < 300; i++) await writer.setEntry(pair('det-a', i, 'deterministic'), entry());
    await writer.setEntry(pair('llm-a', 1, 'llm'), entry());
    await writer.drain();
    await writer.close();
    expect(emitted).toHaveLength(301);
    expect(emitted.every((e) => e.persistedWhenEmitted)).toBe(true);
  });
});

describe('fill verdict writer — a failed write poisons nothing', () => {
  it('keeps the verdicts of a failed write and saves them with the next one', async () => {
    const { writer } = makeWriter();
    state.failNext = 1;
    // The first paid verdict's write fails; the pair does NOT fail with it.
    await expect(writer.setEntry(pair('llm-a', 1, 'llm'), entry())).resolves.toBeUndefined();
    for (let i = 2; i <= 5; i++) await writer.setEntry(pair('llm-a', i, 'llm'), entry());
    await writer.drain();
    await writer.close();
    for (let i = 1; i <= 5; i++) expect(state.persisted.has(`llm-a|node:n${i}`)).toBe(true);
    // Every verdict got exactly one event, each after it was persisted.
    expect(emitted.map((e) => e.key).sort()).toEqual([1, 2, 3, 4, 5].map((i) => `llm-a|node:n${i}`).sort());
    expect(emitted.every((e) => e.persistedWhenEmitted)).toBe(true);
  });

  it('a write that keeps failing surfaces from drain as an environment error, not a bug', async () => {
    const { writer } = makeWriter();
    state.failAlways = true;
    await writer.setEntry(pair('llm-a', 1, 'llm'), entry());
    const err = await writer.drain().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LockEnvironmentError);
    expect((err as InstanceType<typeof LockEnvironmentError>).code).toBe('lock-write-failed');
    expect((err as InstanceType<typeof LockEnvironmentError>).messageData.what).toMatch(/1 verdict\(s\) from this run were not saved/);
    expect(emitted).toHaveLength(0);
    await writer.close();
  });
});
