/**
 * Tests for core/fill-prompt-size-backfill.ts — recording the assembled
 * prompt's size onto verdicts written before that field existed.
 *
 * The point of the step is that it is the ONLY thing that ever writes a size
 * onto an already-valid verdict. `--approve` fills unverified pairs, so a
 * repository whose verdicts all hold — precisely the one the recorded size
 * speeds up — would otherwise never record a single one and would keep paying
 * the full prompt-assembly cost on every check, forever.
 */
import { describe, it, expect } from 'vitest';

import type { LockFile } from '../../../src/model/lock.js';
import { LOCK_FORMAT_VERSION, nodeUnit, fileUnit } from '../../../src/model/lock.js';
import type { VerifiedPair } from '../../../src/core/verify-lock.js';
import type { ExpectedPair } from '../../../src/core/pairs.js';
import { backfillPromptSizes } from '../../../src/core/fill-prompt-size-backfill.js';

function lockWith(entries: Array<[string, string, { hash: string; promptChars?: number }]>): LockFile {
  const lock: LockFile = { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} };
  for (const [aspectId, unitKey, e] of entries) {
    (lock.verdicts[aspectId] ??= {})[unitKey] = { verdict: 'approved', ...e };
  }
  return lock;
}

function pair(aspectId: string, unitKey: string, backfillPromptChars?: number): VerifiedPair {
  return {
    pair: { aspectId, unitKey, kind: 'llm', subjectFiles: [], status: 'enforced' } as unknown as ExpectedPair,
    state: { kind: 'verified' },
    ...(backfillPromptChars !== undefined ? { backfillPromptChars } : {}),
  };
}

/** A persistLock stand-in that counts how many times the caller asked to write. */
function countingPersist(): { persist: () => Promise<void>; calls: () => number } {
  let calls = 0;
  return { persist: async () => { calls += 1; }, calls: () => calls };
}

describe('backfillPromptSizes', () => {
  it('records the live-computed size on a valid entry that has none, and persists once', async () => {
    const lock = lockWith([
      ['asp', nodeUnit('svc'), { hash: 'h1' }],
      ['asp', fileUnit('src/a.ts'), { hash: 'h2' }],
    ]);
    const { persist, calls } = countingPersist();

    const updated = await backfillPromptSizes(
      lock,
      [pair('asp', nodeUnit('svc'), 1234), pair('asp', fileUnit('src/a.ts'), 99)],
      persist,
    );

    expect(updated).toBe(2);
    expect(lock.verdicts['asp'][nodeUnit('svc')].promptChars).toBe(1234);
    expect(lock.verdicts['asp'][fileUnit('src/a.ts')].promptChars).toBe(99);
    // ONE write for the whole batch, not one per entry.
    expect(calls()).toBe(1);
  });

  it('leaves the verdict and its hash untouched — the size is a record, never an input', async () => {
    const lock = lockWith([['asp', nodeUnit('svc'), { hash: 'the-stored-hash' }]]);
    const before = { ...lock.verdicts['asp'][nodeUnit('svc')] };
    const { persist } = countingPersist();

    await backfillPromptSizes(lock, [pair('asp', nodeUnit('svc'), 500)], persist);

    const after = lock.verdicts['asp'][nodeUnit('svc')];
    expect(after.hash).toBe(before.hash);
    expect(after.verdict).toBe(before.verdict);
  });

  it('is a no-op once every entry carries a size — the steady state after the first run', async () => {
    const lock = lockWith([['asp', nodeUnit('svc'), { hash: 'h1', promptChars: 42 }]]);
    const { persist, calls } = countingPersist();

    // Verification hands nothing up for a pair it answered from the lock.
    const updated = await backfillPromptSizes(lock, [pair('asp', nodeUnit('svc'))], persist);

    expect(updated).toBe(0);
    expect(lock.verdicts['asp'][nodeUnit('svc')].promptChars).toBe(42);
    // Nothing to write ⇒ no lock write at all, so a green run stays a pure read.
    expect(calls()).toBe(0);
  });

  it('never overwrites a size already recorded', async () => {
    const lock = lockWith([['asp', nodeUnit('svc'), { hash: 'h1', promptChars: 42 }]]);
    const { persist } = countingPersist();

    await backfillPromptSizes(lock, [pair('asp', nodeUnit('svc'), 999)], persist);

    expect(lock.verdicts['asp'][nodeUnit('svc')].promptChars).toBe(42);
  });

  it('skips a pair whose entry is absent rather than inventing one', async () => {
    const lock = lockWith([]);
    const { persist, calls } = countingPersist();

    const updated = await backfillPromptSizes(lock, [pair('asp', nodeUnit('gone'), 500)], persist);

    expect(updated).toBe(0);
    expect(lock.verdicts['asp']).toBeUndefined();
    expect(calls()).toBe(0);
  });
});
