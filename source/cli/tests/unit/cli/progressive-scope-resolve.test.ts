import { describe, it, expect } from 'vitest';
import { resolveSubmoduleGitlinkInDiff } from '../../../src/cli/progressive-scope-resolve.js';
import type { ChangedFiles } from '../../../src/utils/git-introspect.js';

// ---------------------------------------------------------------------------
// The one decision inside the change-scope resolver that can be pinned without
// a repository: collapsing three possible answers about submodule pointers into
// the two the preflight table can act on.
//
// Everything else the module does is a git measurement whose end-to-end
// behaviour is pinned over real repositories in
// tests/e2e/cli-progressive-gate.test.ts, and the classification of individual
// findings is deliberately NOT here at all — that ladder lives in
// core/check-progressive.ts and has exactly one copy.
// ---------------------------------------------------------------------------

describe('resolveSubmoduleGitlinkInDiff', () => {
  const changed = (...files: string[]): ChangedFiles => ({ files: new Set(files), renames: [] });

  it('refuses when the submodule pointers could not be enumerated at all', () => {
    // The load-bearing half. Answering "no submodule here" because the probe
    // failed would be a claim made from not having looked — and a pointer to
    // another repository's commit is precisely what path-based scoping cannot
    // reason about, so the unknown has to land on the blocking side.
    expect(resolveSubmoduleGitlinkInDiff(null, changed('src/a.ts'))).toBe(true);
    expect(resolveSubmoduleGitlinkInDiff(null, changed())).toBe(true);
    expect(resolveSubmoduleGitlinkInDiff(null, null)).toBe(true);
  });

  it('refuses when the changed paths could not be enumerated', () => {
    expect(resolveSubmoduleGitlinkInDiff(new Set(), null)).toBe(true);
  });

  it('is true only when a pointer is actually among the changed paths', () => {
    const pointers = new Set(['vendor/sub']);
    expect(resolveSubmoduleGitlinkInDiff(pointers, changed('vendor/sub'))).toBe(true);
    expect(resolveSubmoduleGitlinkInDiff(pointers, changed('src/a.ts', 'vendor/sub'))).toBe(true);
    expect(resolveSubmoduleGitlinkInDiff(pointers, changed('src/a.ts'))).toBe(false);
  });

  it('is false for a repository that has no submodules and a real change', () => {
    expect(resolveSubmoduleGitlinkInDiff(new Set(), changed('src/a.ts'))).toBe(false);
  });
});
