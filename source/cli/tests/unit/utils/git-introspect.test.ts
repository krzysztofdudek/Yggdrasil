import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  getMergeParents,
  getMergeBase,
  getFileAtRef,
  isMergeCommit,
} from '../../../src/utils/git-introspect.js';
import { gitFixtureEnv } from '../../support/git-fixture.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setupRepoWithMerge(): Promise<{ repo: string; mergeSha: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'yg-git-'));
  dirs.push(repo);
  const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
  r('git init -q -b main');
  r('git config user.email t@t.test');
  r('git config user.name Test');
  await writeFile(path.join(repo, 'log.md'), 'base\n');
  r('git add -A && git commit -qm base');
  r('git checkout -qb feat1');
  await writeFile(path.join(repo, 'log.md'), 'base\nfeat1 line\n');
  r('git add -A && git commit -qm feat1');
  r('git checkout -q main && git checkout -qb feat2 main');
  await writeFile(path.join(repo, 'log.md'), 'base\nfeat2 line\n');
  r('git add -A && git commit -qm feat2');
  r('git checkout -q main && git merge --no-commit --no-ff -X ours feat1 -q');
  r('git commit -qm "merge feat1"');
  r('git merge --no-commit --no-ff -X ours feat2 -q || true');
  r('git commit -qm "merge feat2 over feat1" || true');
  const mergeSha = execSync('git rev-parse HEAD', { cwd: repo, env: gitFixtureEnv(repo) })
    .toString()
    .trim();
  return { repo, mergeSha };
}

describe('git-introspect', () => {
  it('isMergeCommit detects merge commit', async () => {
    const { repo } = await setupRepoWithMerge();
    expect(await isMergeCommit(repo, 'HEAD')).toBe(true);
  });

  it('getMergeParents returns two parent SHAs', async () => {
    const { repo } = await setupRepoWithMerge();
    const parents = await getMergeParents(repo, 'HEAD');
    expect(parents).toHaveLength(2);
  });

  it('getMergeBase returns ancestor', async () => {
    const { repo } = await setupRepoWithMerge();
    const parents = await getMergeParents(repo, 'HEAD');
    const base = await getMergeBase(repo, parents[0], parents[1]);
    expect(base.length).toBeGreaterThan(0);
  });

  it('getFileAtRef returns file content', async () => {
    const { repo } = await setupRepoWithMerge();
    const content = await getFileAtRef(repo, 'HEAD', 'log.md');
    expect(content).toBeTypeOf('string');
  });

  it('getFileAtRef returns empty string when file missing at ref', async () => {
    const { repo } = await setupRepoWithMerge();
    const content = await getFileAtRef(repo, 'HEAD', 'nonexistent.txt');
    expect(content).toBe('');
  });
});
