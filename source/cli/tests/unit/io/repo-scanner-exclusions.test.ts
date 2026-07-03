import { describe, it, expect } from 'vitest';
import { isCoverageExcludedPath } from '../../../src/io/repo-scanner.js';

describe('isCoverageExcludedPath', () => {
  it('returns false for an empty or dot path (both guard branches)', () => {
    expect(isCoverageExcludedPath('')).toBe(false);
    expect(isCoverageExcludedPath('.')).toBe(false);
    expect(isCoverageExcludedPath('./')).toBe(false);
  });

  it('excludes a `.git` path in every form (segment match)', () => {
    expect(isCoverageExcludedPath('.git')).toBe(true); // worktree pointer FILE or dir
    expect(isCoverageExcludedPath('.git/config')).toBe(true);
    expect(isCoverageExcludedPath('.git/')).toBe(true); // trailing-slash strip branch
    expect(isCoverageExcludedPath('sub/.git/HEAD')).toBe(true); // nested segment
    expect(isCoverageExcludedPath('sub\\.git\\HEAD')).toBe(true); // backslash-normalize branch
    expect(isCoverageExcludedPath('./.git')).toBe(true); // leading ./ strip branch
  });

  it('excludes the graph directory itself and everything inside it', () => {
    expect(isCoverageExcludedPath('.yggdrasil')).toBe(true); // exact-match branch
    expect(isCoverageExcludedPath('.yggdrasil/')).toBe(true);
    expect(isCoverageExcludedPath('.yggdrasil/yg-lock.nondeterministic.json')).toBe(true); // startsWith branch
    expect(isCoverageExcludedPath('.yggdrasil/model/cli/yg-node.yaml')).toBe(true);
  });

  it('does NOT exclude ordinary source paths, nor look-alikes', () => {
    expect(isCoverageExcludedPath('src/index.ts')).toBe(false);
    expect(isCoverageExcludedPath('README.md')).toBe(false);
    expect(isCoverageExcludedPath('git')).toBe(false); // not `.git`
    expect(isCoverageExcludedPath('src/.gitkeep')).toBe(false); // segment is `.gitkeep`, not `.git`
    expect(isCoverageExcludedPath('.yggdrasil-notes/x.md')).toBe(false); // prefix, not the dir
  });
});
