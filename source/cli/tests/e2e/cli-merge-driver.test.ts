// =============================================================================
// CLI E2E — git merges Yggdrasil's own files through `yg merge-driver`.
//
// `yg init` commits `merge=yg-log` / `merge=yg-lock` attributes and configures
// the two drivers in the clone, with a command that falls back to git's own
// conflict markers when the CLI is gone, plus a post-merge hook that records
// merged logs' baselines (`yg log merge-resolve` with no log named). These
// scenarios pin it against real `git merge` runs:
//
//   1. init       → attributes, the local driver configuration (the running CLI
//                   by absolute path, with the git merge-file fallback) and the
//                   post-merge hook are written; a second run changes nothing
//   2. clean      → two branches' type decisions merge with no conflict: the log
//                   is the union in date order, the lock baseline both sides
//                   moved is recorded again by the hook, and the check is clean
//   3. supersedes → two branches superseding the same decision stop the merge
//                   on the log with markers (merge-driver-refused)
//   4. the three ways a driver loses work silently (git 2.50, fact 13):
//      a. no driver defined for the attribute   → git's own markers
//      b. a driver configured whose CLI is gone → the fallback's markers, not
//                                                 ours alone
//      c. a driver that exits 0 without writing → merge-resolve with no log
//                                                 named reports the lost entry
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture, gitFixtureEnv, FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';
import { expectErrorCode, expectNoIssue, parseJson, type OutputIssue } from '../support/assert-output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const TYPE = 'service';
const LOG_REL = `.yggdrasil/types/${TYPE}/log.md`;

interface Run { stdout: string; stderr: string; status: number | null; all: string }

/** The CLI run in the fixture with git pinned to it: `yg init` runs `git config`, and a GIT_DIR a hook leaked must not reach the real repository. */
function yg(dir: string, args: string[]): Run {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8', env: gitFixtureEnv(dir) });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function git(dir: string, args: string[]): Run {
  const r = runGitFixture(dir, args);
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, status: r.status, all: stdout + stderr };
}

/** The fixture with its one reviewer rule removed (every pair a free script pair), as a git repository. */
function project(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-mdriver-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  writeFileSync(arch, readFileSync(arch, 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'), 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), FIXTURE_RM_OPTIONS);
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

function addType(dir: string, reason: string, supersedes?: string): void {
  const r = yg(dir, ['log', 'add', '--type', TYPE, '--reason', reason, ...(supersedes !== undefined ? ['--supersedes', supersedes] : ['--adds'])]);
  expect(r.status, r.all).toBe(0);
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  const r = git(dir, ['commit', '-q', '-m', message]);
  expect(r.status, r.all).toBe(0);
}

/** A base commit with one type decision, then side b and side main each adding their own on top. */
function twoSides(dir: string, onB: () => void, onMain: () => void): void {
  addType(dir, 'The shared decision.');
  commitAll(dir, 'base');
  git(dir, ['checkout', '-q', '-b', 'b']);
  onB();
  commitAll(dir, 'b');
  git(dir, ['checkout', '-q', 'main']);
  onMain();
  commitAll(dir, 'main');
}

const typeEntries = (dir: string, all = false): Array<{ datetime: string; body: string }> =>
  parseJson<{ entries: Array<{ datetime: string; body: string }> }>(yg(dir, ['log', 'read', '--type', TYPE, '--json', ...(all ? ['--all'] : [])]).stdout).entries;

const checkDoc = (dir: string): { issues: OutputIssue[] } => parseJson<{ issues: OutputIssue[] }>(yg(dir, ['check', '--json']).stdout);

describe.skipIf(!distExists)('CLI E2E — git merges Yggdrasil\'s files through yg merge-driver', () => {
  it('1: init writes the attributes, the local driver configuration with its fallback, and the post-merge hook', () => {
    const dir = project('init');
    try {
      const first = yg(dir, ['init', '--upgrade']);
      expect(first.status, first.all).toBe(0);
      const attrs = readFileSync(path.join(dir, '.gitattributes'), 'utf-8');
      expect(attrs).toContain('/.yggdrasil/**/log.md merge=yg-log');
      expect(attrs).toContain('/.yggdrasil/yg-lock.*.json merge=yg-lock');
      const driver = git(dir, ['config', '--local', '--get', 'merge.yg-log.driver']).stdout.trim();
      // The command's exact shape is pinned by the unit test of mergeDriverCommand; here, that
      // it names the CLI that ran init, and (scenario 4b) that it falls back when that CLI is gone.
      expect(driver).toContain(realpathSync(BIN_PATH));
      expect(git(dir, ['config', '--local', '--get', 'merge.yg-lock.driver']).stdout).toContain('merge-driver lock');
      const hook = readFileSync(path.join(dir, '.git', 'hooks', 'post-merge'), 'utf-8');
      expect(hook).toContain('log merge-resolve');
      const second = yg(dir, ['init', '--upgrade']);
      expect(second.status, second.all).toBe(0);
      expect(second.all).not.toContain('merge.yg-log.driver');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60_000);

  it('2: two branches\' decisions merge with no conflict; the hook records the baseline and the check is clean', () => {
    const dir = project('clean');
    try {
      expect(yg(dir, ['init', '--upgrade']).status).toBe(0);
      twoSides(dir, () => addType(dir, 'Side b decided this.'), () => addType(dir, 'Side main decided that.'));
      const merged = git(dir, ['merge', '--no-edit', 'b']);
      expect(merged.status, merged.all).toBe(0);
      const log = readFileSync(path.join(dir, LOG_REL), 'utf-8');
      expect(log).not.toMatch(/^<<<<<<< /m);
      const entries = typeEntries(dir);
      expect(entries).toHaveLength(3);
      // The hook re-recorded the baseline the lock driver dropped (both sides moved it).
      const lock = JSON.parse(readFileSync(path.join(dir, '.yggdrasil', 'yg-lock.types.json'), 'utf-8')) as { types: Record<string, { log?: { last_entry_datetime: string } }> };
      expect(lock.types[TYPE].log?.last_entry_datetime).toBe(entries[0].datetime);
      const doc = checkDoc(dir);
      expectNoIssue(doc, { code: 'log-integrity' });
      expectNoIssue(doc, { code: 'log-conflict' });
      // Run again by hand it finds nothing new to record.
      const again = yg(dir, ['log', 'merge-resolve']);
      expect(again.status, again.all).toBe(0);
      expect(again.all).toContain(LOG_REL);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 90_000);

  it('3: two branches superseding the same decision stop the merge on the log, with markers', () => {
    const dir = project('supersedes');
    try {
      expect(yg(dir, ['init', '--upgrade']).status).toBe(0);
      let shared = '';
      addType(dir, 'The decision both sides replace.');
      commitAll(dir, 'base');
      shared = typeEntries(dir)[0].datetime;
      git(dir, ['checkout', '-q', '-b', 'b']);
      addType(dir, 'Side b replaces it.', shared);
      commitAll(dir, 'b');
      git(dir, ['checkout', '-q', 'main']);
      addType(dir, 'Side main replaces it.', shared);
      commitAll(dir, 'main');
      const merged = git(dir, ['merge', '--no-edit', 'b']);
      expect(merged.status).not.toBe(0);
      expectErrorCode(merged.all, 'merge-driver-refused');
      const log = readFileSync(path.join(dir, LOG_REL), 'utf-8');
      expect(log).toMatch(/^<<<<<<< ours$/m);
      expect(log).toContain('Side b replaces it.');
      expect(log).toContain('Side main replaces it.');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 90_000);

  it('4a: an attribute naming a driver the clone never defined gives git\'s own markers', () => {
    const dir = project('undefined');
    try {
      writeFileSync(path.join(dir, '.gitattributes'), '/.yggdrasil/**/log.md merge=yg-log\n', 'utf-8');
      twoSides(dir, () => addType(dir, 'Side b decided this.'), () => addType(dir, 'Side main decided that.'));
      const merged = git(dir, ['merge', '--no-edit', 'b']);
      expect(merged.status).not.toBe(0);
      expect(readFileSync(path.join(dir, LOG_REL), 'utf-8')).toMatch(/^<<<<<<< /m);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60_000);

  it('4b: a driver configured whose CLI is gone falls back to markers instead of keeping ours alone', () => {
    const dir = project('missing');
    try {
      expect(yg(dir, ['init', '--upgrade']).status).toBe(0);
      const driver = git(dir, ['config', '--local', '--get', 'merge.yg-log.driver']).stdout.trim();
      git(dir, ['config', '--local', 'merge.yg-log.driver', driver.split(realpathSync(BIN_PATH)).join('/nonexistent/yg/dist/bin.js')]);
      twoSides(dir, () => addType(dir, 'Side b decided this.'), () => addType(dir, 'Side main decided that.'));
      const merged = git(dir, ['merge', '--no-edit', 'b']);
      expect(merged.status).not.toBe(0);
      const log = readFileSync(path.join(dir, LOG_REL), 'utf-8');
      expect(log).toMatch(/^<<<<<<< /m);
      expect(log).toContain('Side b decided this.');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60_000);

  it('4c: a driver that exits 0 without writing is caught by merge-resolve with no log named', () => {
    const dir = project('silent');
    try {
      writeFileSync(path.join(dir, '.gitattributes'), '/.yggdrasil/**/log.md merge=silent\n/.yggdrasil/yg-lock.*.json merge=silent\n', 'utf-8');
      git(dir, ['config', '--local', 'merge.silent.driver', 'true']);
      twoSides(dir, () => addType(dir, 'Side b decided this.'), () => addType(dir, 'Side main decided that.'));
      const merged = git(dir, ['merge', '--no-edit', 'b']);
      expect(merged.status, merged.all).toBe(0);
      expect(readFileSync(path.join(dir, LOG_REL), 'utf-8')).not.toContain('Side b decided this.');
      const resolved = yg(dir, ['log', 'merge-resolve']);
      expect(resolved.status).toBe(1);
      expectErrorCode(resolved.all, 'log-merge-entries-lost');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60_000);
});
