/**
 * Unit tests for core/fill-divergence.ts — the auto-approve convergence sentinel
 * (C15). These exercise the PURE shape detector and dump builder in isolation on
 * synthetic inputs; no filesystem, no lock, no fill flow.
 *
 * The sentinel fires ONLY on the exact observed 0-fill pathology: the pre-fill
 * classification reported ZERO pairs to fill, yet the post-fill report still
 * finds unverified pairs, and NO verdict was written in between. Anything else
 * (writes happened, or nothing is unverified after) is silent.
 */

import { describe, it, expect } from 'vitest';
import {
  countPostUnverified,
  isZeroFillDivergence,
  buildDivergenceDump,
  divergenceNotice,
  reportDivergenceIfDetected,
  DIVERGENCE_LOG_MAX_LINES,
} from '../../../src/core/fill-divergence.js';
import type { IssueMessage } from '../../../src/model/validation.js';
import type { LockFile } from '../../../src/model/lock.js';

function emptyLock(): LockFile {
  return { version: 1, verdicts: {}, nodes: {} } as unknown as LockFile;
}

describe('isZeroFillDivergence — the exact fire shape', () => {
  it('FIRES when 0 pairs were to fill, unverified remain, and nothing was written', () => {
    expect(isZeroFillDivergence({ toFill: 0, postUnverified: 3, lockWrites: 0 })).toBe(true);
  });

  it('is SILENT when there was work to fill and writes happened', () => {
    expect(isZeroFillDivergence({ toFill: 2, postUnverified: 3, lockWrites: 2 })).toBe(false);
  });

  it('is SILENT when nothing was to fill and nothing is unverified after', () => {
    expect(isZeroFillDivergence({ toFill: 0, postUnverified: 0, lockWrites: 0 })).toBe(false);
  });

  it('is SILENT when verdicts WERE written in between (a real fill, not a converge-nowhere)', () => {
    // toFill=0 but a write landed (e.g. closure/verdict) — not the 0-fill pathology.
    expect(isZeroFillDivergence({ toFill: 0, postUnverified: 3, lockWrites: 1 })).toBe(false);
  });

  it('is SILENT when pairs were filled and none remain unverified (the happy path)', () => {
    expect(isZeroFillDivergence({ toFill: 5, postUnverified: 0, lockWrites: 5 })).toBe(false);
  });
});

// The sentinel is primed with a count of what the report still leaves without a
// verdict. On a run measured against a change, a pair the change did not reach
// keeps its finding under a different code — and it is exactly as unverified as
// one that kept the plain code. Counting only the plain code would blind the
// sentinel on precisely those runs.
describe('countPostUnverified — both spellings of an unverified pair', () => {
  it('counts a finding the change reached', () => {
    expect(countPostUnverified([{ code: 'unverified' }])).toBe(1);
  });

  it('counts one the change did not reach, under its non-blocking code', () => {
    expect(countPostUnverified([{ code: 'unverified-outside' }])).toBe(1);
  });

  it('counts both together, and nothing else in the report', () => {
    expect(
      countPostUnverified([
        { code: 'unverified' },
        { code: 'unverified-outside' },
        { code: 'aspect-violation-enforced' },
        { code: 'aspect-violation-enforced-outside' },
        { code: 'unmapped-files' },
        {},
      ]),
    ).toBe(2);
  });

  it('counts nothing in a report with no unverified pair at all', () => {
    expect(countPostUnverified([])).toBe(0);
    expect(countPostUnverified([{ code: 'rules-digest-stale' }])).toBe(0);
  });
});

describe('buildDivergenceDump — bounded evidence', () => {
  it('emits a header plus one line per divergent pair with its stored (already-computed) hash', () => {
    const lock = emptyLock();
    lock.verdicts = {
      'aspect-a': { 'node:mod/x': { hash: 'abc123', verdict: 'approved' } },
    } as unknown as LockFile['verdicts'];
    const dump = buildDivergenceDump(
      { toFill: 0, postUnverified: 2, lockWrites: 0 },
      [
        { aspectId: 'aspect-a', unitKey: 'node:mod/x' },
        { aspectId: 'aspect-b', unitKey: 'file:src/y.ts' },
      ],
      lock,
    );
    // Header carries the shape counts.
    expect(dump).toContain('toFill=0');
    expect(dump).toContain('postUnverified=2');
    expect(dump).toContain('lockWrites=0');
    // One line per pair, with the stored hash where present, 'none' otherwise.
    expect(dump).toContain('aspect-a\tnode:mod/x\thash=abc123');
    expect(dump).toContain('aspect-b\tfile:src/y.ts\thash=none');
    // Trailing newline so appends stack cleanly.
    expect(dump.endsWith('\n')).toBe(true);
  });

  it('caps the dump at DIVERGENCE_LOG_MAX_LINES and notes the overflow', () => {
    const lock = emptyLock();
    const pairs = Array.from({ length: 500 }, (_, i) => ({
      aspectId: `a${i}`,
      unitKey: `node:n${i}`,
    }));
    const dump = buildDivergenceDump({ toFill: 0, postUnverified: 500, lockWrites: 0 }, pairs, lock);
    const lines = dump.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeLessThanOrEqual(DIVERGENCE_LOG_MAX_LINES);
    expect(dump).toMatch(/and \d+ more/);
  });

  it('normalizes unit keys to POSIX in output', () => {
    const lock = emptyLock();
    const dump = buildDivergenceDump(
      { toFill: 0, postUnverified: 1, lockWrites: 0 },
      [{ aspectId: 'a', unitKey: 'file:src\\win\\z.ts' }],
      lock,
    );
    expect(dump).toContain('file:src/win/z.ts');
    expect(dump).not.toContain('\\');
  });
});

describe('divergenceNotice — the single structured notice', () => {
  it('returns a what/why/next triple pointing at the evidence file', () => {
    const n = divergenceNotice({ toFill: 0, postUnverified: 3, lockWrites: 0 });
    expect(n.what.length).toBeGreaterThan(0);
    expect(n.why.length).toBeGreaterThan(0);
    expect(n.next.length).toBeGreaterThan(0);
    expect(n.next).toContain('.yg-fill-divergence.log');
  });
});

describe('reportDivergenceIfDetected — the report step (via injected sinks)', () => {
  it('on the fire shape: emits exactly ONE notice and writes the dump of enumerated pairs', async () => {
    const notices: IssueMessage[] = [];
    const dumps: string[] = [];
    let enumerated = 0;
    const fired = await reportDivergenceIfDetected(
      { toFill: 0, postUnverified: 2, lockWrites: 0 },
      emptyLock(),
      {
        emitIssue: (m) => notices.push(m),
        divergenceWrite: (t) => dumps.push(t),
        enumerate: async () => {
          enumerated += 1;
          return [
            { aspectId: 'a1', unitKey: 'node:n1' },
            { aspectId: 'a2', unitKey: 'node:n2' },
          ];
        },
      },
    );
    expect(fired).toBe(true);
    expect(notices).toHaveLength(1);
    expect(enumerated).toBe(1);
    expect(dumps).toHaveLength(1);
    expect(dumps[0]).toContain('a1\tnode:n1');
    expect(dumps[0]).toContain('a2\tnode:n2');
  });

  it('on a non-fire shape: emits nothing, writes nothing, never enumerates', async () => {
    const notices: IssueMessage[] = [];
    const dumps: string[] = [];
    let enumerated = 0;
    const fired = await reportDivergenceIfDetected(
      { toFill: 2, postUnverified: 3, lockWrites: 2 },
      emptyLock(),
      {
        emitIssue: (m) => notices.push(m),
        divergenceWrite: (t) => dumps.push(t),
        enumerate: async () => {
          enumerated += 1;
          return [];
        },
      },
    );
    expect(fired).toBe(false);
    expect(notices).toEqual([]);
    expect(dumps).toEqual([]);
    expect(enumerated).toBe(0);
  });

  it('still fires the notice when no writer is injected (notice-only)', async () => {
    const notices: IssueMessage[] = [];
    const fired = await reportDivergenceIfDetected(
      { toFill: 0, postUnverified: 1, lockWrites: 0 },
      emptyLock(),
      {
        emitIssue: (m) => notices.push(m),
        enumerate: async () => [{ aspectId: 'a', unitKey: 'node:n' }],
      },
    );
    expect(fired).toBe(true);
    expect(notices).toHaveLength(1);
  });
});
