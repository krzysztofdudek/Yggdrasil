import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLastCommitTimestamp, getFirstCommitTimestamp } from '../../../src/utils/git.js';

// `execFile` is stubbed alongside `execFileSync` even though no test here
// calls it directly: git.ts now imports `parsePorcelainZ` from the sibling
// git-introspect.ts module (both live in the same utility node), which
// module-level `promisify(execFile)`s at import time — leaving `execFile`
// unmocked would throw before any test in this file ran.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '../../fixtures/sample-project');

describe('git', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  describe('getLastCommitTimestamp', () => {
    it('returns timestamp when git log succeeds with valid output', () => {
      vi.mocked(execFileSync).mockReturnValue('1730000000\n');
      const result = getLastCommitTimestamp(FIXTURE_ROOT, '.yggdrasil/yg-config.yaml');
      expect(result).toBe(1730000000);
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['log', '-1', '--format=%ct']),
        expect.any(Object),
      );
    });

    it('returns null when git log returns non-numeric output', () => {
      vi.mocked(execFileSync).mockReturnValue('');
      const result = getLastCommitTimestamp(FIXTURE_ROOT, 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns null when parseInt produces NaN', () => {
      vi.mocked(execFileSync).mockReturnValue('not-a-number');
      const result = getLastCommitTimestamp(FIXTURE_ROOT, 'some/path');
      expect(result).toBeNull();
    });

    it('returns null when execFileSync throws (not a git repo or path has no commits)', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('fatal: not a git repository');
      });
      const result = getLastCommitTimestamp('/tmp/not-a-repo', 'any/path');
      expect(result).toBeNull();
    });

    it('normalizes Windows-style paths to forward slashes', () => {
      vi.mocked(execFileSync).mockReturnValue('1730000000\n');
      getLastCommitTimestamp(FIXTURE_ROOT, 'path\\with\\backslashes');
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['path/with/backslashes']),
        expect.any(Object),
      );
    });
  });

  describe('getFirstCommitTimestamp', () => {
    it('uses --follow --diff-filter=A --format=%ct to trace adds through renames', () => {
      vi.mocked(execFileSync).mockReturnValue('1730000000\n');
      getFirstCommitTimestamp(FIXTURE_ROOT, '.yggdrasil/aspects/x/content.md');
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['log', '--follow', '--diff-filter=A', '--format=%ct']),
        expect.any(Object),
      );
    });

    it('returns the LAST (oldest) line — the original creation — from newest-first output', () => {
      // git log prints newest-first; with --diff-filter=A a re-added path yields
      // several ADD commits. The FIRST creation is the final line.
      vi.mocked(execFileSync).mockReturnValue('1780000000\n1750000000\n1730000000\n');
      expect(getFirstCommitTimestamp(FIXTURE_ROOT, 'a/b.md')).toBe(1730000000);
    });

    it('returns the single value when the path was added exactly once', () => {
      vi.mocked(execFileSync).mockReturnValue('1730000000\n');
      expect(getFirstCommitTimestamp(FIXTURE_ROOT, 'a/b.md')).toBe(1730000000);
    });

    it('returns null on empty output (untracked / no add on record)', () => {
      vi.mocked(execFileSync).mockReturnValue('');
      expect(getFirstCommitTimestamp(FIXTURE_ROOT, 'nonexistent')).toBeNull();
    });

    it('returns null when the last line is non-numeric', () => {
      vi.mocked(execFileSync).mockReturnValue('not-a-number\n');
      expect(getFirstCommitTimestamp(FIXTURE_ROOT, 'a/b.md')).toBeNull();
    });

    it('returns null when execFileSync throws (no repo, or shallow clone lacking the add)', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('fatal: not a git repository');
      });
      expect(getFirstCommitTimestamp('/tmp/not-a-repo', 'any/path')).toBeNull();
    });

    it('normalizes Windows-style paths to forward slashes', () => {
      vi.mocked(execFileSync).mockReturnValue('1730000000\n');
      getFirstCommitTimestamp(FIXTURE_ROOT, 'path\\with\\backslashes');
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['path/with/backslashes']),
        expect.any(Object),
      );
    });
  });
});
