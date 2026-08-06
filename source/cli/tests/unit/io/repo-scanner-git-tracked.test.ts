import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
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

  it('excludes a tracked symlink (not a regular file — lstat never follows it)', () => {
    // The disk walk (walkRepoFiles) skips a symlink outright (readdir's dirent is
    // neither isDirectory() nor isFile()). A symlink is not a gitignore anomaly —
    // it is structurally invisible to the walk for a completely different reason —
    // so it must never surface as tracked-file-gitignored. Regression pin for the
    // bug where "tracked but absent from the walk" alone was treated as proof of a
    // gitignore match: a symlink is absent from the walk too, but is never gitignored.
    const dir = freshDir('symlink');
    writeFileSync(path.join(dir, 'real.txt'), 'target\n');
    symlinkSync('real.txt', path.join(dir, 'link.txt'));
    expect(runGitFixture(dir, ['init', '-q', '-b', 'main']).status).toBe(0);
    expect(runGitFixture(dir, ['add', '-A'], { extraEnv: IDENTITY }).status).toBe(0);

    const files = listGitTrackedFiles(dir);
    expect(files).toContain('real.txt');
    expect(files).not.toContain('link.txt');
  });

  it('excludes a submodule gitlink entry (a checked-out directory, not a file)', () => {
    // A gitlink (index mode 160000) names a submodule commit; when checked out,
    // its path is a DIRECTORY on disk, never a regular file. Fabricated cheaply
    // via update-index --cacheinfo — no real submodule/nested repo needed, and no
    // separate remote to point at. `git rm --cached` on this path would drop the
    // submodule reference from the index, which would be destructive advice for
    // something that was never a plain file — must never be flagged as one.
    const dir = freshDir('gitlink');
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    expect(runGitFixture(dir, ['init', '-q', '-b', 'main']).status).toBe(0);
    expect(runGitFixture(dir, ['add', 'a.txt'], { extraEnv: IDENTITY }).status).toBe(0);
    const fakeSha = 'a'.repeat(40);
    expect(
      runGitFixture(dir, ['update-index', '--add', '--cacheinfo', `160000,${fakeSha},vendor/lib`]).status,
    ).toBe(0);
    mkdirSync(path.join(dir, 'vendor', 'lib'), { recursive: true }); // checked-out submodule root: a directory

    const files = listGitTrackedFiles(dir);
    expect(files).toContain('a.txt');
    expect(files).not.toContain('vendor/lib');
  });
});
