import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listGitTrackedFiles } from '../../../src/io/repo-scanner.js';
import { runGitFixture } from '../../support/git-fixture.js';

/**
 * `listGitTrackedFiles` is the ONE remaining git consumer in the coverage
 * surface (the tracked∩gitignored anomaly check, core/check.ts's
 * `scanTrackedButIgnored`): `git ls-files` sees the index, which does not
 * respect `.gitignore` for an already-tracked (e.g. force-added) path, unlike
 * the disk-based `walkRepoFiles` walk that feeds every other coverage check.
 * Best-effort: git absent or failing must degrade to `null`, never throw.
 *
 * Every fixture repo is a fresh mkdtemp dir, initialized and populated through
 * the shared `runGitFixture` helper (pins GIT_DIR/GIT_WORK_TREE to the fixture
 * and scrubs inherited discovery vars) so a throwaway `git init`/`add` here can
 * never reach or mutate this repository's own `.git`.
 */

const IDENTITY = {
  GIT_AUTHOR_NAME: 'yg-test',
  GIT_AUTHOR_EMAIL: 'yg-test@fixture.test',
  GIT_COMMITTER_NAME: 'yg-test',
  GIT_COMMITTER_EMAIL: 'yg-test@fixture.test',
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(label: string): string {
  const d = mkdtempSync(path.join(tmpdir(), `yg-listgit-${label}-`));
  dirs.push(d);
  return d;
}

describe('listGitTrackedFiles', () => {
  it('returns the git-tracked files as repo-relative POSIX paths', () => {
    const dir = freshDir('basic');
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
    expect(runGitFixture(dir, ['init', '-q', '-b', 'main']).status).toBe(0);
    expect(runGitFixture(dir, ['add', '-A'], { extraEnv: IDENTITY }).status).toBe(0);

    const files = listGitTrackedFiles(dir);
    expect(files).not.toBeNull();
    expect([...files!].sort()).toEqual(['a.txt', 'src/b.ts']);
  });

  it('includes a force-tracked file that a .gitignore rule would otherwise exclude (git add -f)', () => {
    // This is the exact anomaly scanTrackedButIgnored looks for: `git ls-files`
    // (the INDEX) still lists a force-added, gitignored file — unlike the disk
    // walk, which skips it outright.
    const dir = freshDir('forced');
    writeFileSync(path.join(dir, '.gitignore'), 'ignored.ts\n');
    writeFileSync(path.join(dir, 'ignored.ts'), 'export const k = 1;\n');
    writeFileSync(path.join(dir, 'kept.ts'), 'export const j = 1;\n');
    expect(runGitFixture(dir, ['init', '-q', '-b', 'main']).status).toBe(0);
    expect(runGitFixture(dir, ['add', 'kept.ts', '.gitignore'], { extraEnv: IDENTITY }).status).toBe(0);
    expect(runGitFixture(dir, ['add', '-f', 'ignored.ts'], { extraEnv: IDENTITY }).status).toBe(0);

    const files = listGitTrackedFiles(dir);
    expect(files).toContain('ignored.ts');
    expect(files).toContain('kept.ts');
  });

  it('returns null when the directory is not a git repository', () => {
    const dir = freshDir('nogit');
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    expect(listGitTrackedFiles(dir)).toBeNull();
  });

  it('returns an empty array (not null) for a real, empty repo with no commits or adds', () => {
    const dir = freshDir('empty');
    expect(runGitFixture(dir, ['init', '-q', '-b', 'main']).status).toBe(0);
    expect(listGitTrackedFiles(dir)).toEqual([]);
  });
});
