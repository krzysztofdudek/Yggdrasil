import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectByteGuardCandidates } from '../../../src/core/check-byte-guard.js';
import { progressivePairKey, type BurnSet } from '../../../src/core/progressive-scope.js';
import type { VerifiedPair, PairState } from '../../../src/core/verify-lock.js';
import type { ExpectedPair } from '../../../src/core/pairs.js';

// ---------------------------------------------------------------------------
// The GATHERING half of the byte guard: which obligations are worth asking the
// bytes about, and what those bytes are. Every case runs against real files in
// a real throwaway directory — the module's whole job is the one disk read the
// pure comparer must not do, so a stubbed filesystem would test nothing.
// ---------------------------------------------------------------------------

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A project root holding the given repo-relative files with the given content. */
async function projectWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-byteguard-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
  }
  return root;
}

function pairOf(overrides: Partial<ExpectedPair> = {}): ExpectedPair {
  return {
    aspectId: 'a',
    kind: 'deterministic',
    unitKey: 'node:svc',
    nodePath: 'svc',
    status: 'enforced',
    subjectFiles: ['src/svc.ts'],
    ...overrides,
  };
}

function verifiedPair(state: PairState, overrides: Partial<ExpectedPair> = {}): VerifiedPair {
  return { pair: pairOf(overrides), state };
}

function burnOf(overrides: Partial<BurnSet> = {}): BurnSet {
  return {
    global: false,
    pairKeys: new Set(),
    nodePaths: new Set(),
    files: new Set(),
    logOnlyNodePaths: new Set(),
    changedInputCount: 0,
    ...overrides,
  };
}

/** A change scope whose reference listing is present — the guard-enabled shape. */
function scopeOf(burn: BurnSet = burnOf()): {
  burn: BurnSet;
  blobOidByPath: Map<string, string> | null;
} {
  return { burn, blobOidByPath: new Map([['src/svc.ts', 'irrelevant-here']]) };
}

const K = progressivePairKey;

describe('collectByteGuardCandidates — which obligations it asks about', () => {
  it('gathers an out-of-scope enforced pair that is failing, with its bytes from disk', async () => {
    const root = await projectWith({ 'src/svc.ts': 'export const svc = 1;\n' });
    const candidates = await collectByteGuardCandidates(
      scopeOf(),
      [verifiedPair({ kind: 'unverified' })],
      root,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].pairKey).toBe(K('a', 'node:svc'));
    expect(candidates[0].subjects).toHaveLength(1);
    expect(candidates[0].subjects[0].path).toBe('src/svc.ts');
    expect(candidates[0].subjects[0].bytes?.toString('utf-8')).toBe('export const svc = 1;\n');
  });

  it('ignores a pair that is passing — there is no finding to keep', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    expect(
      await collectByteGuardCandidates(scopeOf(), [verifiedPair({ kind: 'verified' })], root),
    ).toEqual([]);
  });

  it('ignores an ADVISORY refusal, which is already a warning nothing downgrades', async () => {
    // The distinction the severity table owns: an advisory pair's refusal never
    // reaches the classifier's downgrade path at all, so guarding it would be
    // pure noise. Asked of the emitter rather than re-derived from the state.
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    expect(
      await collectByteGuardCandidates(
        scopeOf(),
        [verifiedPair({ kind: 'refused', reason: 'no' }, { status: 'advisory' })],
        root,
      ),
    ).toEqual([]);
  });

  it('gathers a pair whose verdict is VALID but whose prompt outgrew its tier', async () => {
    // Same reason, mirrored: the pair's own state is `verified`, yet it still
    // reports a blocking error, so it is exactly the kind of finding that must
    // not be released on a false "untouched".
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const vp: VerifiedPair = {
      pair: pairOf(),
      state: { kind: 'verified' },
      oversized: { chars: 10, limit: 5, tierName: 'standard' },
    };
    const candidates = await collectByteGuardCandidates(scopeOf(), [vp], root);
    expect(candidates.map((c) => c.pairKey)).toEqual([K('a', 'node:svc')]);
  });

  it('ignores a pair the burn table already burned', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const scope = scopeOf(burnOf({ pairKeys: new Set([K('a', 'node:svc')]) }));
    expect(
      await collectByteGuardCandidates(scope, [verifiedPair({ kind: 'unverified' })], root),
    ).toEqual([]);
  });

  it('carries an unreadable subject as null rather than dropping it', async () => {
    // Dropping it would let a pair with no comparable subject look comparable
    // and clean; the decision has to SEE the gap.
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const candidates = await collectByteGuardCandidates(
      scopeOf(),
      [verifiedPair({ kind: 'unverified' }, { subjectFiles: ['src/svc.ts', 'src/vanished.ts'] })],
      root,
    );
    expect(candidates[0].subjects.map((s) => s.path)).toEqual(['src/svc.ts', 'src/vanished.ts']);
    expect(candidates[0].subjects[1].bytes).toBeNull();
  });

  it('reads a file shared by several pairs exactly once', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    const candidates = await collectByteGuardCandidates(
      scopeOf(),
      [
        verifiedPair({ kind: 'unverified' }, { aspectId: 'a' }),
        verifiedPair({ kind: 'unverified' }, { aspectId: 'b' }),
      ],
      root,
    );
    expect(candidates).toHaveLength(2);
    // The same buffer object, not two equal reads.
    expect(candidates[0].subjects[0].bytes).toBe(candidates[1].subjects[0].bytes);
  });
});

describe('collectByteGuardCandidates — when it does nothing at all', () => {
  it('gathers nothing when the run has no change scope', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    expect(
      await collectByteGuardCandidates(undefined, [verifiedPair({ kind: 'unverified' })], root),
    ).toEqual([]);
  });

  it('gathers nothing when the reference listing could not be obtained', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    expect(
      await collectByteGuardCandidates(
        { burn: burnOf(), blobOidByPath: null },
        [verifiedPair({ kind: 'unverified' })],
        root,
      ),
    ).toEqual([]);
  });

  it('gathers nothing under a global scope, which already gates everything', async () => {
    const root = await projectWith({ 'src/svc.ts': 'ok\n' });
    expect(
      await collectByteGuardCandidates(
        scopeOf(burnOf({ global: true })),
        [verifiedPair({ kind: 'unverified' })],
        root,
      ),
    ).toEqual([]);
  });
});
