import { describe, it, expect } from 'vitest';
import { LOCK_FORMAT_VERSION, pairsMissingFromLock, type LockFile } from '../../../src/model/lock.js';

/**
 * Unit tests for `pairsMissingFromLock` — the cheap, O(1)-per-pair "this pair
 * has no entry in the lock at all" check the per-file surfaces (`yg owner
 * --file`, `yg context --file`, `yg tree`, the portal) use instead of a full
 * `core/verify-lock.ts` re-verification, which would re-hash every pair in
 * the whole graph just to answer one file's question.
 */
describe('pairsMissingFromLock', () => {
  const emptyLock: LockFile = { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} };

  it('an empty lock (fresh clone, nothing ever filled) reports every pair as missing', () => {
    const pairs = [
      { aspectId: 'needs-node-context', unitKey: 'file:src/crashy/a.ts' },
      { aspectId: 'own-file-rule', unitKey: 'file:src/leaf/a.ts' },
    ];
    expect(pairsMissingFromLock(emptyLock, pairs)).toEqual(pairs);
  });

  it('a pair with a recorded verdict entry (any verdict — approved or refused) is never reported as missing', () => {
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: { 'own-file-rule': { 'file:src/leaf/a.ts': { verdict: 'approved', hash: 'h' } } },
      nodes: {},
    };
    const pairs = [{ aspectId: 'own-file-rule', unitKey: 'file:src/leaf/a.ts' }];
    expect(pairsMissingFromLock(lock, pairs)).toEqual([]);
  });

  it('a different aspect on the SAME unitKey does not satisfy a pair\'s own missing check', () => {
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: { 'other-rule': { 'file:src/leaf/a.ts': { verdict: 'approved', hash: 'h' } } },
      nodes: {},
    };
    const pairs = [{ aspectId: 'own-file-rule', unitKey: 'file:src/leaf/a.ts' }];
    expect(pairsMissingFromLock(lock, pairs)).toEqual(pairs);
  });

  it('only the genuinely-missing pairs among a mixed set are returned, preserving neither more nor fewer', () => {
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: { 'own-file-rule': { 'file:a.ts': { verdict: 'approved', hash: 'h' } } },
      nodes: {},
    };
    const pairs = [
      { aspectId: 'own-file-rule', unitKey: 'file:a.ts' }, // recorded
      { aspectId: 'own-file-rule', unitKey: 'file:b.ts' }, // missing
    ];
    expect(pairsMissingFromLock(lock, pairs)).toEqual([{ aspectId: 'own-file-rule', unitKey: 'file:b.ts' }]);
  });

  it('a REFUSED verdict entry still counts as recorded — this check never distinguishes verdict outcome, only presence', () => {
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: { 'own-file-rule': { 'file:a.ts': { verdict: 'refused', hash: 'h', reason: 'nope' } } },
      nodes: {},
    };
    const pairs = [{ aspectId: 'own-file-rule', unitKey: 'file:a.ts' }];
    expect(pairsMissingFromLock(lock, pairs)).toEqual([]);
  });
});
