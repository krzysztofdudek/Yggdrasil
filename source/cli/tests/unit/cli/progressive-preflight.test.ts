/**
 * Tests for cli/progressive-preflight.ts — the pure state machine that turns
 * the progressive-mode probe results (`utils/git-introspect.ts`'s
 * `isAncestor`/`isShallowRepository`/`getToplevelAndPrefix`/
 * `treesIdentical`/`hasCleanWorktree`, plus `changedFilesAgainst`'s touched
 * set) into one verdict: gate everything, gate only the touched set, stay
 * quiet, or fall back.
 *
 * The whole reason this module exists is to close a silent-green hole: a
 * probe that could not prove anything (a `null`, an empty touched set nobody
 * can vouch for) must never be mistaken for proof that nothing changed. Every
 * case below exercises one row of that decision table directly against the
 * PURE function, independent of any git repository or file on disk.
 */
import { describe, it, expect } from 'vitest';

import {
  resolveProgressiveState,
  type PreflightProbes,
  type ProgressiveState,
} from '../../../src/cli/progressive-preflight.js';
import type { ChangedFiles } from '../../../src/utils/git-introspect.js';

/** An empty, but SUCCESSFULLY enumerated, touched set (Δ = ∅). */
const emptyTouched: ChangedFiles = { files: new Set(), renames: [] };

/** A touched set with `n` distinct paths — never empty, never `null`. */
function touchedWith(n: number): ChangedFiles {
  return { files: new Set(Array.from({ length: n }, (_, i) => `src/file${i}.ts`)), renames: [] };
}

/**
 * An ordinary, fully-resolved "feature branch with real changes" baseline:
 * every probe answered, nothing looks clean, nothing looks broken. Every
 * test below overrides only the fields its scenario cares about, so a
 * reader sees the ONE thing that changed rather than re-deriving the whole
 * object each time.
 */
const base: PreflightProbes = {
  configReference: 'origin/main',
  fullFlag: false,
  mergeBase: 'deadbeef',
  isAncestorHeadRef: false,
  worktreeClean: true,
  treesIdenticalHeadMb: false,
  touched: touchedWith(2),
  toplevelMatchesProjectRoot: true,
  shallow: false,
  submoduleGitlinkInDiff: false,
};

describe('resolveProgressiveState — off (no config reference)', () => {
  it('is off when no reference is configured, even with an otherwise pristine state', () => {
    expect(resolveProgressiveState({ ...base, configReference: undefined })).toEqual<ProgressiveState>({
      mode: 'off',
    });
  });

  it('is reachable with every probe at its zero value — "never asked" needs no successful probe', () => {
    const allZero: PreflightProbes = {
      configReference: undefined,
      fullFlag: false,
      mergeBase: null,
      isAncestorHeadRef: null,
      worktreeClean: null,
      treesIdenticalHeadMb: null,
      touched: null,
      toplevelMatchesProjectRoot: null,
      shallow: null,
      submoduleGitlinkInDiff: false,
    };
    expect(resolveProgressiveState(allZero).mode).toBe('off');
  });
});

describe('resolveProgressiveState — full (--full wins over everything)', () => {
  it('is full when --full is passed on an otherwise ordinary scoped state', () => {
    expect(resolveProgressiveState({ ...base, fullFlag: true })).toEqual<ProgressiveState>({ mode: 'full' });
  });

  it('is full even with no config reference at all', () => {
    expect(resolveProgressiveState({ ...base, fullFlag: true, configReference: undefined }).mode).toBe('full');
  });

  it('is full even when every other probe is broken (null) or actively hostile', () => {
    expect(
      resolveProgressiveState({
        configReference: 'origin/main',
        fullFlag: true,
        mergeBase: null,
        isAncestorHeadRef: null,
        worktreeClean: null,
        treesIdenticalHeadMb: null,
        touched: null,
        toplevelMatchesProjectRoot: null,
        shallow: null,
        submoduleGitlinkInDiff: true,
      }).mode,
    ).toBe('full');
  });
});

describe('resolveProgressiveState — honest-empty (the only quiet-green outcome)', () => {
  it('shape (a): HEAD is an ancestor of the reference and the worktree is clean', () => {
    expect(
      resolveProgressiveState({
        ...base,
        isAncestorHeadRef: true,
        worktreeClean: true,
        touched: emptyTouched,
      }),
    ).toEqual<ProgressiveState>({ mode: 'honest-empty' });
  });

  it('shape (b): commit-then-revert — mergeBase ≠ HEAD, Δ = ∅, but HEAD^{tree} == mb^{tree}', () => {
    expect(
      resolveProgressiveState({
        ...base,
        isAncestorHeadRef: false,
        treesIdenticalHeadMb: true,
        worktreeClean: true,
        touched: emptyTouched,
      }),
    ).toEqual<ProgressiveState>({ mode: 'honest-empty' });
  });

  it('shape (a) alone is not proof without a clean worktree', () => {
    expect(
      resolveProgressiveState({
        ...base,
        isAncestorHeadRef: true,
        worktreeClean: false,
        touched: touchedWith(1),
      }).mode,
    ).not.toBe('honest-empty');
  });

  it('shape (b) alone is not proof without a clean worktree', () => {
    expect(
      resolveProgressiveState({
        ...base,
        treesIdenticalHeadMb: true,
        worktreeClean: false,
        touched: touchedWith(1),
      }).mode,
    ).not.toBe('honest-empty');
  });

  it('a null ancestor/identity probe is never treated as proof', () => {
    expect(
      resolveProgressiveState({
        ...base,
        isAncestorHeadRef: null,
        treesIdenticalHeadMb: null,
        worktreeClean: true,
        touched: emptyTouched,
      }).mode,
    ).not.toBe('honest-empty');
  });
});

describe('resolveProgressiveState — global-fallback: enumeration failure', () => {
  it('mergeBase ≠ HEAD, Δ = ∅, but trees differ — an empty diff nobody can vouch for', () => {
    const result = resolveProgressiveState({
      ...base,
      isAncestorHeadRef: false,
      treesIdenticalHeadMb: false,
      worktreeClean: true,
      touched: emptyTouched,
    });
    expect(result.mode).toBe('global-fallback');
    expect(result.reason).toBeTruthy();
    expect(result.reason).toMatch(/enumeration|empty/i);
  });

  it('is never mistaken for scoped-with-nothing-to-do either', () => {
    const result = resolveProgressiveState({
      ...base,
      isAncestorHeadRef: false,
      treesIdenticalHeadMb: false,
      worktreeClean: true,
      touched: emptyTouched,
    });
    expect(result.mode).not.toBe('scoped');
  });
});

describe('resolveProgressiveState — global-fallback: touched set unreadable', () => {
  it('touched === null falls back, with a reason naming enumeration', () => {
    const result = resolveProgressiveState({ ...base, touched: null });
    expect(result.mode).toBe('global-fallback');
    expect(result.reason).toBeTruthy();
  });
});

describe('resolveProgressiveState — global-fallback: merge-base unresolved', () => {
  it('names a shallow clone as the cause when shallow is true', () => {
    const result = resolveProgressiveState({ ...base, mergeBase: null, shallow: true });
    expect(result.mode).toBe('global-fallback');
    expect(result.reason).toMatch(/shallow/i);
  });

  it('names an unavailable git as the cause when shallow itself is unknown (null)', () => {
    const result = resolveProgressiveState({ ...base, mergeBase: null, shallow: null });
    expect(result.mode).toBe('global-fallback');
    expect(result.reason).toBeTruthy();
    expect(result.reason).toMatch(/git itself|missing git|not a git repository|broader git failure/i);
  });

  it('names the reference itself as the cause when the clone is full (shallow: false)', () => {
    const result = resolveProgressiveState({ ...base, mergeBase: null, shallow: false });
    expect(result.mode).toBe('global-fallback');
    expect(result.reason).toBeTruthy();
  });

  it('produces three DISTINCT reasons for the three shallow states — never one generic string', () => {
    const shallowTrue = resolveProgressiveState({ ...base, mergeBase: null, shallow: true }).reason;
    const shallowNull = resolveProgressiveState({ ...base, mergeBase: null, shallow: null }).reason;
    const shallowFalse = resolveProgressiveState({ ...base, mergeBase: null, shallow: false }).reason;
    const reasons = new Set([shallowTrue, shallowNull, shallowFalse]);
    expect(reasons.size).toBe(3);
  });
});

describe('resolveProgressiveState — global-fallback: nested graph root', () => {
  it('refuses to scope when the work-tree top level does not match the project root', () => {
    const result = resolveProgressiveState({ ...base, toplevelMatchesProjectRoot: false });
    expect(result.mode).toBe('global-fallback');
    expect(result.reason).toBeTruthy();
  });

  it('a null toplevel probe is treated the same as a known mismatch — "not proven true" is not "true"', () => {
    const result = resolveProgressiveState({ ...base, toplevelMatchesProjectRoot: null });
    expect(result.mode).toBe('global-fallback');
  });
});

describe('resolveProgressiveState — global-fallback: submodule gitlink', () => {
  it('refuses to scope when a gitlink appears in the diff', () => {
    const result = resolveProgressiveState({ ...base, submoduleGitlinkInDiff: true });
    expect(result.mode).toBe('global-fallback');
    expect(result.reason).toBeTruthy();
  });
});

describe('resolveProgressiveState — scoped', () => {
  it('an ordinary branch with a non-empty touched set and a resolved merge-base', () => {
    expect(resolveProgressiveState(base)).toEqual<ProgressiveState>({ mode: 'scoped' });
  });

  it('a dirty tree sitting on the reference branch still scopes over the uncommitted changes', () => {
    expect(
      resolveProgressiveState({
        ...base,
        isAncestorHeadRef: true,
        worktreeClean: false,
        touched: touchedWith(1),
      }),
    ).toEqual<ProgressiveState>({ mode: 'scoped' });
  });

  it('a scoped result never carries a reason — reason is reserved for fallback causes', () => {
    expect(resolveProgressiveState(base).reason).toBeUndefined();
  });
});

describe('resolveProgressiveState — ordering: the earliest-listed fallback cause wins', () => {
  it('an unresolved merge-base wins over a simultaneously unreadable touched set', () => {
    // These two ALWAYS fire together in practice — the changed-file set is
    // enumerated against the merge base, so a run with no merge base has no
    // diff to report either. Reporting the diff first meant every
    // unresolvable-reference run was explained as a failing `git status/diff`,
    // which names no fix; the merge-base row names a different concrete one for
    // each of its three shallow states. The upstream cause has to win.
    const result = resolveProgressiveState({ ...base, touched: null, mergeBase: null, shallow: true });
    expect(result.mode).toBe('global-fallback');
    expect(result.reason).toMatch(/shallow/i);
  });

  it('still blames the diff itself when the merge base DID resolve', () => {
    // The other side of that correction: with a merge base in hand, a missing
    // touched set really is the diff having failed, and must still say so.
    const result = resolveProgressiveState({ ...base, touched: null });
    expect(result.mode).toBe('global-fallback');
    expect(result.reason).toMatch(/diff/i);
    expect(result.reason).not.toMatch(/merge-base/i);
  });

  it('an unresolved merge-base wins over a simultaneous toplevel mismatch', () => {
    const result = resolveProgressiveState({
      ...base,
      mergeBase: null,
      shallow: false,
      toplevelMatchesProjectRoot: false,
    });
    expect(result.mode).toBe('global-fallback');
    expect(result.reason).not.toMatch(/toplevel|top level|top-level|nested/i);
  });

  it('a toplevel mismatch wins over a simultaneous gitlink', () => {
    const result = resolveProgressiveState({
      ...base,
      toplevelMatchesProjectRoot: false,
      submoduleGitlinkInDiff: true,
    });
    expect(result.mode).toBe('global-fallback');
    expect(result.reason).not.toMatch(/gitlink/i);
  });
});

describe('resolveProgressiveState — the explicit negative: touched === null never yields honest-empty', () => {
  // Every combination below "looks clean" on every OTHER probe — exactly the
  // shape that would trip a naive implementation into treating a `null`
  // touched set as though it were an empty, honestly-enumerated one. None of
  // them may resolve to honest-empty, or to scoped (there is nothing to
  // scope from a `null` touched set) — only global-fallback is safe.
  const cleanLookingCombos: Array<Partial<PreflightProbes>> = [
    { isAncestorHeadRef: true, worktreeClean: true, treesIdenticalHeadMb: true },
    { isAncestorHeadRef: true, worktreeClean: true, treesIdenticalHeadMb: false },
    { isAncestorHeadRef: false, worktreeClean: true, treesIdenticalHeadMb: true },
    { isAncestorHeadRef: null, worktreeClean: true, treesIdenticalHeadMb: null },
    { isAncestorHeadRef: true, worktreeClean: null, treesIdenticalHeadMb: true },
    { isAncestorHeadRef: null, worktreeClean: null, treesIdenticalHeadMb: null },
  ];

  it.each(cleanLookingCombos)('touched: null, %o => global-fallback, never honest-empty or scoped', (overrides) => {
    const result = resolveProgressiveState({ ...base, ...overrides, touched: null });
    expect(result.mode).toBe('global-fallback');
    expect(result.mode).not.toBe('honest-empty');
    expect(result.mode).not.toBe('scoped');
    expect(result.reason).toBeTruthy();
  });

  it('holds even with --full absent and no other reason to distrust the run', () => {
    const result = resolveProgressiveState({
      configReference: 'origin/main',
      fullFlag: false,
      mergeBase: 'deadbeef',
      isAncestorHeadRef: true,
      worktreeClean: true,
      treesIdenticalHeadMb: true,
      touched: null,
      toplevelMatchesProjectRoot: true,
      shallow: false,
      submoduleGitlinkInDiff: false,
    });
    expect(result.mode).toBe('global-fallback');
  });
});

// ── Every fallback owes a remedy, not just a diagnosis ───────────────────────

/**
 * A cause with no next step is half a message: the person is told their run
 * answered for the whole project and left to work out what to do about it. Two
 * of these causes are permanent properties of a repository — a graph that does
 * not sit at the git root, a change that moves a submodule pointer — and a
 * monorepo told "fix the cause and re-run" on every single run would be chasing
 * something it cannot change, so those owe an explicit "nothing to fix" instead.
 */
describe('resolveProgressiveState — every fallback carries its own next step', () => {
  const everyFallback: Array<[string, Partial<PreflightProbes>]> = [
    ['unresolved merge-base, shallow clone', { mergeBase: null, shallow: true }],
    ['unresolved merge-base, git unavailable', { mergeBase: null, shallow: null }],
    ['unresolved merge-base, full clone', { mergeBase: null, shallow: false }],
    ['unreadable diff', { touched: null }],
    ['nested graph root', { toplevelMatchesProjectRoot: false }],
    ['submodule gitlink in the diff', { submoduleGitlinkInDiff: true }],
    ['empty touched set nothing corroborates', { touched: emptyTouched }],
  ];

  it.each(everyFallback)('%s states both a cause and a next step', (_label, overrides) => {
    const result = resolveProgressiveState({ ...base, ...overrides });
    expect(result.mode).toBe('global-fallback');
    expect(result.reason).toBeTruthy();
    expect(result.nextStep).toBeTruthy();
  });

  it('produces a DISTINCT next step per cause — never one sentence shared around', () => {
    const steps = everyFallback.map(([, o]) => resolveProgressiveState({ ...base, ...o }).nextStep);
    expect(new Set(steps).size).toBe(everyFallback.length);
  });

  it('says plainly that nothing needs fixing where nothing can be', () => {
    for (const overrides of [{ toplevelMatchesProjectRoot: false }, { submoduleGitlinkInDiff: true }]) {
      const result = resolveProgressiveState({ ...base, ...overrides } as PreflightProbes);
      expect(result.nextStep).toMatch(/nothing to fix/i);
    }
  });

  it('never attaches a next step to a mode that is not a fallback', () => {
    for (const state of [
      resolveProgressiveState(base),
      resolveProgressiveState({ ...base, fullFlag: true }),
      resolveProgressiveState({ ...base, configReference: undefined }),
      resolveProgressiveState({ ...base, isAncestorHeadRef: true, touched: emptyTouched }),
    ]) {
      if (state.mode === 'global-fallback') continue;
      expect(state.nextStep).toBeUndefined();
    }
  });
});
