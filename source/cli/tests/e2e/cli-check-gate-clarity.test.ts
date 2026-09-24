// =============================================================================
// CLI E2E — the check gate tells the truth about what blocks it and what to do.
//
// Every scenario here is one an adopter met where the report, the `--json`
// document or the `next:` line pointed at a command that could not help — or
// where the command itself stopped for a reason that did not apply to it:
//
//   1. keyless project + one judgment rule: the free gate still fills the
//      script rules, a preview still previews, and `next:` names the missing
//      reviewer instead of an `--approve` that aborts
//   2. an advisory judgment rule with no reviewer never blocks
//   3. an infrastructure failure (reviewer unreachable, check.mjs that cannot
//      run) is named on the report and in `--json`, and `next:` points at it
//   4. an async check.mjs that throws still reaches the report
//   5. a reason-less yg-suppress marker is warned about before it matters
//   6. a log conflict met mid-merge, mid-rebase or mid-cherry-pick resolves with
//      the command the check names, and the result passes yg check --approve —
//      also after an earlier merge put the log's entries in date order
//   7. the log gate stops before announcing a fill, and its retry keeps flags
//   8. the closing summary never claims "all valid" after filling something
//   9. contradictory / invalid flags are refused with an accurate message
//  10. log_required quietly not measuring is surfaced
//  11. a broken graph file does not produce misattributed follow-on findings
//  12. an unusable family-candidates file is named, not silently dropped
//  13. unverified pairs are grouped by cause (stale / never / local cache)
//  14. non-pair findings are counted as issues, not pairs
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFixtureTree } from '../support/fixture-copy.js';
import { FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

interface Run { stdout: string; stderr: string; status: number | null; all: string }

function run(args: string[], cwd: string): Run {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { stdout, stderr, status: r.status, all: stdout + stderr };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf-8' });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

interface JsonIssue { code: string; severity: string; cause?: string; next: string; what: string; why: string }
interface JsonDoc { issues: JsonIssue[]; suggestedNext: string | null; next: { command: string[] } | null; exit: { code: number } }

function json(r: Run): JsonDoc {
  return JSON.parse(r.stdout) as JsonDoc;
}

/** The lifecycle fixture in a fresh git repository; `keyless` strips the reviewer: section. */
function project(label: string, opts: { keyless?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-gate-clarity-${label}-`));
  copyFixtureTree(FIXTURE, dir);
  if (opts.keyless === true) {
    const cfg = path.join(dir, '.yggdrasil', 'yg-config.yaml');
    writeFileSync(cfg, readFileSync(cfg, 'utf-8').replace(/reviewer:\n(?: {2,}.*\n)*/, ''), 'utf-8');
  }
  git(['init', '-q', '.'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'init'], dir);
  return dir;
}

function edit(dir: string, rel: string, fn: (s: string) => string): void {
  const p = path.join(dir, rel);
  writeFileSync(p, fn(readFileSync(p, 'utf-8')), 'utf-8');
}

/** Drop the judgment rule so a scenario runs on script rules alone. */
function dropJudgmentRule(dir: string): void {
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), FIXTURE_RM_OPTIONS);
  edit(dir, '.yggdrasil/yg-architecture.yaml', (s) => s.split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'));
}

function makeServiceLogRequired(dir: string): void {
  edit(dir, '.yggdrasil/yg-architecture.yaml', (s) =>
    s.replace(/(service:\n {4}description: [^\n]*\n {4})log_required: false/, '$1log_required: true'));
}

const DET_LOCK = (dir: string): string => path.join(dir, '.yggdrasil', '.yg-lock.deterministic.json');

describe.skipIf(!distExists)('CLI E2E — check gate clarity', () => {
  describe('1. keyless project with a judgment rule', () => {
    it('--approve --only-deterministic fills the script rules instead of aborting the run', () => {
      const dir = project('keyless-det', { keyless: true });
      try {
        const r = run(['check', '--approve', '--only-deterministic'], dir);
        expect(r.all).not.toContain('aborted');
        expect(r.all).toContain('no reviewer is configured');
        // The deterministic pairs were filled — the local cache exists.
        expect(existsSync(DET_LOCK(dir))).toBe(true);
        // Still red: the enforced judgment rule has no judge.
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('config-reviewer-missing');
        expect(r.stdout).toMatch(/^error\[unverified\] \d+ pairs? with no reviewer configured to judge them$/m);
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });

    it('--approve --dry-run previews and exits 0, naming the missing reviewer', () => {
      const dir = project('keyless-dry', { keyless: true });
      try {
        const r = run(['check', '--approve', '--dry-run'], dir);
        expect(r.status).toBe(0);
        expect(r.all).not.toContain('aborted');
        expect(r.stdout).toContain('No reviewer is configured');
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });

    it('a full --approve still stops, and its retry and fix name non-interactive commands', () => {
      const dir = project('keyless-full', { keyless: true });
      try {
        const r = run(['check', '--approve'], dir);
        expect(r.status).toBe(1);
        // The abort is reported like any result, on stdout: an ABORTED verdict
        // line over the gating findings.
        expect(r.stdout).toContain('yg check: ABORTED');
        expect(r.stdout).toContain('yg init --provider <name>');
        expect(r.all).not.toContain("pick 'Configure reviewer'");
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });

    it('plain check points Next at the reviewer, not at an --approve that would abort', () => {
      const dir = project('keyless-next', { keyless: true });
      try {
        const doc = json(run(['check', '--json'], dir));
        expect(doc.suggestedNext).toMatch(/^yg init --provider <name>/);
        const llm = doc.issues.filter((i) => i.code === 'unverified' && i.cause === 'reviewer-missing');
        expect(llm.length).toBeGreaterThan(0);
        expect(llm[0].next).toMatch(/^yg init --provider <name>/);
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('2. an advisory judgment rule with no reviewer', () => {
    it('is a warning, not a blocking error', () => {
      const dir = project('keyless-advisory', { keyless: true });
      try {
        edit(dir, '.yggdrasil/aspects/has-doc-comment/yg-aspect.yaml', (s) => s.replace('status: enforced', 'status: advisory'));
        expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);
        const r = run(['check', '--json'], dir);
        expect(r.status).toBe(0);
        const missing = json(r).issues.find((i) => i.code === 'config-reviewer-missing');
        expect(missing?.severity).toBe('warning');
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('3. an infrastructure failure is on the report, not only on stderr', () => {
    it('names reviewer-unreachable and check-failed-to-run, and next: points at a fix', () => {
      const dir = project('infra');
      try {
        edit(dir, '.yggdrasil/yg-config.yaml', (s) => s.replace(/endpoint:.*/, 'endpoint: "http://127.0.0.1:9"'));
        edit(dir, '.yggdrasil/aspects/no-todo-comments/check.mjs', (s) => s.replace('export function check', 'export default function check'));
        const r = run(['check', '--approve', '--json'], dir);
        expect(r.status).toBe(1);
        const doc = json(r);
        const causes = new Set(doc.issues.filter((i) => i.code === 'unverified').map((i) => i.cause));
        expect(causes.has('reviewer-unreachable')).toBe(true);
        expect(causes.has('check-failed-to-run')).toBe(true);
        expect(doc.suggestedNext).not.toBe('yg check --approve');
        // The text report carries the same.
        const text = run(['check', '--approve'], dir);
        expect(text.stdout).toMatch(/^error\[unverified\] \d+ pairs? left unjudged — the reviewer was unreachable this run$/m);
        expect(text.stdout).toMatch(/^error\[unverified\] \d+ pairs? whose check\.mjs failed to run$/m);
        expect(text.stdout).not.toMatch(/^next: yg check --approve\s*$/m);
        expect(text.stdout).toMatch(/^next: \S/m);
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('4. an async check.mjs that throws', () => {
    it('still reaches the report instead of killing the run with a bare Error', () => {
      const dir = project('async');
      try {
        writeFileSync(
          path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs'),
          'export async function check(ctx) { for (const f of ctx.files) { await f.read(); } return []; }\n',
          'utf-8',
        );
        const r = run(['check', '--approve', '--only-deterministic'], dir);
        expect(r.stderr).not.toContain('Error: f.read is not a function');
        expect(r.stdout).toContain('yg check: FAIL');
        expect(r.stdout).toMatch(/^error\[unverified\] \d+ pairs? whose check\.mjs failed to run$/m);
        expect(r.stdout).toContain('  fix:  Refactor check to be synchronous.');
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('5. a yg-suppress marker with no reason', () => {
    it('is warned about by yg suppressions and yg check before any violation lands', () => {
      const dir = project('reasonless');
      try {
        appendFileSync(path.join(dir, 'src', 'services', 'orders.ts'), '// yg-suppress(no-todo-comments)\nexport const x = 1;\n');
        const sup = JSON.parse(run(['suppressions', '--json'], dir).stdout) as { warnings: Array<{ code: string }> };
        expect(sup.warnings.some((w) => w.code === 'missing-reason')).toBe(true);
        const doc = json(run(['check', '--json'], dir));
        const w = doc.issues.find((i) => i.code === 'suppress-marker-missing-reason');
        expect(w?.severity).toBe('warning');
        expect(w?.what).toContain('src/services/orders.ts');
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });

    it('once a violation lands in its range, the report names the marker as the cause', () => {
      const dir = project('reasonless-hit');
      try {
        appendFileSync(path.join(dir, 'src', 'services', 'payments.ts'), '// yg-suppress(no-todo-comments)\n// TODO later\n');
        const doc = json(run(['check', '--approve', '--only-deterministic', '--json'], dir));
        expect(doc.issues.some((i) => i.code === 'unverified' && i.cause === 'suppress-marker-invalid')).toBe(true);
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('6. a log conflict met mid-merge', () => {
    it('resolves with the command the check names, writing the union of both sides', () => {
      const dir = project('merge');
      try {
        dropJudgmentRule(dir);
        makeServiceLogRequired(dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'initial'], dir);
        run(['check', '--approve'], dir);
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'base'], dir);
        const main = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
        git(['checkout', '-qb', 'feat-a'], dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'branch a'], dir);
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'a'], dir);
        git(['checkout', '-q', main], dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'main'], dir);
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'b'], dir);
        git(['merge', 'feat-a'], dir);
        const logPath = path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'log.md');
        expect(readFileSync(logPath, 'utf-8')).toMatch(/^<{7}/m);

        const doc = json(run(['check', '--json'], dir));
        expect(doc.next?.command.join(' ')).toBe('yg log merge-resolve --node services/payments');
    expect(doc.suggestedNext).toMatch(/^yg log merge-resolve --node services\/payments(\s|$)/);

        const r = run(['log', 'merge-resolve', '--node', 'services/payments'], dir);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('wrote the union of both sides');
        const merged = readFileSync(logPath, 'utf-8');
        expect(merged).not.toMatch(/^[<>]{7}/m);
        expect(merged).toContain('branch a');
        expect(merged).toContain('main');
        expect(merged.indexOf('branch a')).toBeLessThan(merged.indexOf('\nmain'));
        expect(run(['check', '--json'], dir).stdout).not.toContain('log-conflict');
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('6b. a log conflict met mid-merge on a branch whose tip is itself a merge', () => {
    it('resolves against the merge in progress, not the merge commit at HEAD', () => {
      const dir = project('merge-on-merge');
      try {
        dropJudgmentRule(dir);
        makeServiceLogRequired(dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'initial'], dir);
        run(['check', '--approve'], dir);
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'base'], dir);
        const main = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
        git(['checkout', '-qb', 'feat-a'], dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'branch a'], dir);
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'a'], dir);
        git(['checkout', '-q', main], dir);
        git(['checkout', '-qb', 'feat-c'], dir);
        writeFileSync(path.join(dir, 'NOTES.txt'), 'side\n');
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'c'], dir);
        git(['checkout', '-q', main], dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'main'], dir);
        git(['add', '-A'], dir);
        git(['commit', '-qm', 'b'], dir);
        git(['merge', '--no-ff', '-q', '-m', 'merge c', 'feat-c'], dir);
        git(['merge', 'feat-a'], dir);
        const logPath = path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'log.md');
        expect(readFileSync(logPath, 'utf-8')).toMatch(/^<{7}/m);

        const r = run(['log', 'merge-resolve', '--node', 'services/payments'], dir);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('wrote the union of both sides');
        const merged = readFileSync(logPath, 'utf-8');
        expect(merged).not.toMatch(/^[<>]{7}/m);
        expect(merged).toContain('branch a');
        expect(merged).toContain('main');
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  // A rebase or a cherry-pick that stops on a conflicted log.md is the same
  // conflict as a merge — the two sides are HEAD (the upstream, or the branch
  // picked onto) and the commit being replayed (REBASE_HEAD / CHERRY_PICK_HEAD).
  // Both lock files and log.md conflict when each side approved its own entry;
  // the lock takes the side being built on, the log gets the union.
  const lockFiles = ['yg-lock.logs.json', 'yg-lock.nondeterministic.json'];

  /** Resolve one stop of a rebase / cherry-pick the way the check says to; returns the merge-resolve output. */
  function resolveStop(dir: string): Run {
    for (const f of lockFiles) {
      const p = path.join(dir, '.yggdrasil', f);
      if (existsSync(p) && /^<{7}/m.test(readFileSync(p, 'utf-8'))) git(['checkout', '--ours', '--', `.yggdrasil/${f}`], dir);
    }
    const doc = json(run(['check', '--json'], dir));
    expect(doc.issues.some((i) => i.code === 'log-conflict')).toBe(true);
    expect(doc.next?.command.join(' ')).toBe('yg log merge-resolve --node services/payments');
    expect(doc.suggestedNext).toMatch(/^yg log merge-resolve --node services\/payments(\s|$)/);
    const r = run(['log', 'merge-resolve', '--node', 'services/payments'], dir);
    git(['add', '-A'], dir);
    return r;
  }

  function continueOp(op: 'rebase' | 'cherry-pick', dir: string): string {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', op, '--continue'], {
      cwd: dir, encoding: 'utf-8', env: { ...process.env, GIT_EDITOR: 'true' },
    });
    return (r.stdout ?? '') + (r.stderr ?? '');
  }

  const inProgress = (dir: string, ref: string): boolean =>
    spawnSync('git', ['rev-parse', '-q', '--verify', ref], { cwd: dir, encoding: 'utf-8' }).status === 0;

  /** base (approved) → branch feat-a with two approved entries → main with one approved entry, written after them. */
  function divergedProject(label: string): { dir: string; main: string } {
    const dir = project(label);
    // A setup step that fails removes its own directory: the caller's
    // try/finally has not started yet, so it could not.
    try {
      return buildDiverged(dir);
    } catch (e) {
      rmSync(dir, FIXTURE_RM_OPTIONS);
      throw e;
    }
  }

  function buildDiverged(dir: string): { dir: string; main: string } {
    dropJudgmentRule(dir);
    makeServiceLogRequired(dir);
    run(['log', 'add', '--node', 'services/payments', '--reason', 'initial'], dir);
    run(['log', 'add', '--node', 'services/orders', '--reason', 'initial'], dir);
    expect(run(['check', '--approve'], dir).stdout).toContain('yg check: PASS');
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'base'], dir);
    const main = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
    git(['checkout', '-qb', 'feat-a'], dir);
    for (const reason of ['branch a1', 'branch a2']) {
      run(['log', 'add', '--node', 'services/payments', '--reason', reason], dir);
      run(['check', '--approve'], dir);
      git(['add', '-A'], dir);
      git(['commit', '-qm', reason], dir);
    }
    git(['checkout', '-q', main], dir);
    run(['log', 'add', '--node', 'services/payments', '--reason', 'main'], dir);
    run(['check', '--approve'], dir);
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'main'], dir);
    return { dir, main };
  }

  const LOG = (dir: string): string => path.join(dir, '.yggdrasil', 'model', 'services', 'payments', 'log.md');

  describe('6c. a log conflict met mid-rebase', () => {
    it('resolves every stop with the command the check names, and the rebased branch passes yg check --approve', () => {
      const { dir, main } = divergedProject('rebase');
      try {
        git(['checkout', '-q', 'feat-a'], dir);
        git(['rebase', main], dir);
        let stops = 0;
        // A finished rebase can leave REBASE_HEAD behind; its state directory is what says it is still going.
        const rebasing = (): boolean => existsSync(path.join(dir, '.git', 'rebase-merge')) || existsSync(path.join(dir, '.git', 'rebase-apply'));
        while (rebasing()) {
          expect(readFileSync(LOG(dir), 'utf-8')).toMatch(/^<{7}/m);
          const r = resolveStop(dir);
          expect(r.all).not.toContain('not a merge commit');
          expect(r.status).toBe(0);
          expect(r.stdout).toContain('wrote the union of both sides');
          expect(r.stdout).toContain('git rebase --continue');
          const merged = readFileSync(LOG(dir), 'utf-8');
          expect(merged).not.toMatch(/^[<>]{7}/m);
          continueOp('rebase', dir);
          stops++;
          expect(stops).toBeLessThan(5);
        }
        // Both branch commits stop: each adds an entry where main added one.
        expect(stops).toBe(2);
        // Every entry, each exactly once, in the order it was written — the
        // branch's two entries keep their original timestamps ahead of main's.
        const final = readFileSync(LOG(dir), 'utf-8');
        const order = ['initial', 'branch a1', 'branch a2', '\nmain'].map((s) => final.indexOf(s));
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(final.split('branch a1').length).toBe(2);
        const headers = [...final.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
        expect([...headers].sort()).toEqual(headers);
        const approve = run(['check', '--approve'], dir);
        expect(approve.stdout).toContain('yg check: PASS');
        expect(approve.status).toBe(0);
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('6d. a log conflict met mid-cherry-pick', () => {
    it('adds only the picked commit\'s entry, and the result passes yg check --approve', () => {
      const { dir } = divergedProject('cherry');
      try {
        // main is checked out; pick only feat-a's SECOND commit.
        git(['cherry-pick', 'feat-a'], dir);
        expect(inProgress(dir, 'CHERRY_PICK_HEAD')).toBe(true);
        expect(readFileSync(LOG(dir), 'utf-8')).toMatch(/^<{7}/m);
        const r = resolveStop(dir);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('wrote the union of both sides');
        expect(r.stdout).toContain('git cherry-pick --continue');
        continueOp('cherry-pick', dir);
        expect(inProgress(dir, 'CHERRY_PICK_HEAD')).toBe(false);
        const final = readFileSync(LOG(dir), 'utf-8');
        expect(final).toContain('branch a2');
        // a1 was never picked, so it is not carried in.
        expect(final).not.toContain('branch a1');
        expect(final.indexOf('branch a2')).toBeLessThan(final.indexOf('\nmain'));
        const approve = run(['check', '--approve'], dir);
        expect(approve.stdout).toContain('yg check: PASS');
        expect(approve.status).toBe(0);
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  // Issue 222: a merge written in date order puts an older entry from the other
  // branch before a newer one of the branch's own, so the branch's log no longer
  // starts with the log at the merge base of any LATER merge. The next merge
  // from a branch cut before that reorder used to be refused ("the two sides do
  // not share the history"); the shared history is what the two logs themselves
  // start with.
  describe('6e. a merge after an earlier merge reordered the log by date', () => {
    /** Commit everything on the current branch, approving first. */
    function approveAndCommit(dir: string, msg: string): void {
      expect(run(['check', '--approve'], dir).stdout).toContain('yg check: PASS');
      git(['add', '-A'], dir);
      git(['commit', '-qm', msg], dir);
    }
    function addEntry(dir: string, reason: string): void {
      expect(run(['log', 'add', '--node', 'services/payments', '--reason', reason], dir).status).toBe(0);
      approveAndCommit(dir, reason);
    }
    /** Merge `branch` in, resolve the lock by our side and the log by merge-resolve, approve, commit. */
    function mergeWithResolve(dir: string, branch: string): Run {
      git(['merge', '--no-ff', '--no-commit', branch], dir);
      // Every merge here conflicts on the log: both sides appended after what they share.
      expect(readFileSync(LOG(dir), 'utf-8')).toMatch(/^<{7}/m);
      for (const f of lockFiles) {
        const p = path.join(dir, '.yggdrasil', f);
        if (existsSync(p) && /^<{7}/m.test(readFileSync(p, 'utf-8'))) git(['checkout', '--ours', '--', `.yggdrasil/${f}`], dir);
      }
      const r = run(['log', 'merge-resolve', '--node', 'services/payments'], dir);
      if (r.status === 0) {
        const approve = run(['check', '--approve'], dir);
        expect(approve.stdout).toContain('yg check: PASS');
        expect(approve.status).toBe(0);
        git(['add', '-A'], dir);
        git(['commit', '-qm', `merge ${branch}`], dir);
      }
      return r;
    }
    function expectDateOrderedOnce(dir: string, reasons: string[]): void {
      const final = readFileSync(LOG(dir), 'utf-8');
      const headers = [...final.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
      expect([...headers].sort()).toEqual(headers);
      expect(new Set(headers).size).toBe(headers.length);
      const order = reasons.map((s) => final.indexOf(`\n${s}\n`));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      for (const s of reasons) expect(final.split(`\n${s}\n`).length).toBe(2);
    }

    /**
     * base → feat-c (entry c1) → main (entry m1, commit M) → feat-d and feat-e cut
     * from M. Entries are written in the order c1, m1, d1, e1, so merging feat-c
     * into main writes [c1, m1]: main's log no longer starts with M's.
     */
    function chainProject(label: string): { dir: string; main: string } {
      const dir = project(label);
      // As divergedProject: a failed setup removes its own directory.
      try {
        return buildChain(dir);
      } catch (e) {
        rmSync(dir, FIXTURE_RM_OPTIONS);
        throw e;
      }
    }

    function buildChain(dir: string): { dir: string; main: string } {
      dropJudgmentRule(dir);
      makeServiceLogRequired(dir);
      run(['log', 'add', '--node', 'services/payments', '--reason', 'initial'], dir);
      run(['log', 'add', '--node', 'services/orders', '--reason', 'initial'], dir);
      approveAndCommit(dir, 'base');
      const main = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
      git(['checkout', '-qb', 'feat-c'], dir);
      addEntry(dir, 'branch c1');
      git(['checkout', '-q', main], dir);
      addEntry(dir, 'main m1');
      git(['checkout', '-qb', 'feat-d'], dir);
      addEntry(dir, 'branch d1');
      git(['checkout', '-q', main], dir);
      git(['checkout', '-qb', 'feat-e'], dir);
      addEntry(dir, 'branch e1');
      git(['checkout', '-q', main], dir);
      return { dir, main };
    }

    it('merges a branch cut before the reorder, and the result passes yg check --approve', () => {
      const { dir } = chainProject('reorder');
      try {
        const first = mergeWithResolve(dir, 'feat-c');
        expect(first.status).toBe(0);
        expectDateOrderedOnce(dir, ['initial', 'branch c1', 'main m1']);
        addEntry(dir, 'main m2');

        const second = mergeWithResolve(dir, 'feat-d');
        expect(second.all).not.toContain('do not share');
        expect(second.status).toBe(0);
        expect(second.stdout).toContain('wrote the union of both sides');
        expectDateOrderedOnce(dir, ['initial', 'branch c1', 'main m1', 'branch d1', 'main m2']);
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });

    it('keeps working down a three-branch chain', () => {
      const { dir } = chainProject('chain');
      try {
        for (const [i, b] of ['feat-c', 'feat-d', 'feat-e'].entries()) {
          const r = mergeWithResolve(dir, b);
          expect(r.all).not.toContain('do not share');
          expect(r.status).toBe(0);
          addEntry(dir, `main after ${i}`);
        }
        expectDateOrderedOnce(dir, ['initial', 'branch c1', 'main m1', 'branch d1', 'branch e1', 'main after 0', 'main after 1', 'main after 2']);
        expect(run(['check'], dir).status).toBe(0);
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });

    it('merges main back into a branch whose log main reordered', () => {
      const { dir, main } = chainProject('back');
      try {
        expect(mergeWithResolve(dir, 'feat-c').status).toBe(0);
        addEntry(dir, 'main m2');
        git(['checkout', '-q', 'feat-d'], dir);
        const r = mergeWithResolve(dir, main);
        expect(r.all).not.toContain('do not share');
        expect(r.status).toBe(0);
        expectDateOrderedOnce(dir, ['initial', 'branch c1', 'main m1', 'branch d1', 'main m2']);
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });

    it('rebases a branch cut before the reorder onto it', () => {
      const { dir, main } = chainProject('rebase-reorder');
      try {
        expect(mergeWithResolve(dir, 'feat-c').status).toBe(0);
        addEntry(dir, 'main m2');
        git(['checkout', '-q', 'feat-d'], dir);
        git(['rebase', main], dir);
        const rebasing = (): boolean => existsSync(path.join(dir, '.git', 'rebase-merge')) || existsSync(path.join(dir, '.git', 'rebase-apply'));
        let stops = 0;
        while (rebasing()) {
          const r = resolveStop(dir);
          expect(r.status).toBe(0);
          continueOp('rebase', dir);
          expect(++stops).toBeLessThan(5);
        }
        expect(stops).toBe(1);
        expectDateOrderedOnce(dir, ['initial', 'branch c1', 'main m1', 'branch d1', 'main m2']);
        expect(run(['check', '--approve'], dir).stdout).toContain('yg check: PASS');
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('7. the log gate', () => {
    it('stops before the fill header, and its retry repeats --only-deterministic', () => {
      const dir = project('loggate');
      try {
        makeServiceLogRequired(dir);
        const r = run(['check', '--approve', '--only-deterministic'], dir);
        expect(r.status).toBe(1);
        expect(r.stderr).not.toMatch(/^fill {2}/m);
        expect(r.stdout).toMatch(/^then: yg check --approve --only-deterministic$/m);
        expect(r.stdout).toContain('Then re-run yg check --approve --only-deterministic.');
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('8. the closing summary', () => {
    it('does not claim every pair is valid after a deterministic refusal', () => {
      const dir = project('summary');
      try {
        appendFileSync(path.join(dir, 'src', 'services', 'orders.ts'), '// TODO refuse\n');
        const r = run(['check', '--approve', '--only-deterministic'], dir);
        expect(r.stderr).not.toContain('all expected pairs hold valid verdicts');
        expect(r.stderr).toMatch(/^fill {2}done in .* — \d+ approved · [1-9]\d* refused · \d+ failed · 0 reviewer calls/m);
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('9. the flag contract', () => {
    it('refuses --approve together with --no-approve, in either order', () => {
      const dir = project('flags');
      try {
        for (const args of [['--approve', '--no-approve'], ['--no-approve', '--approve']]) {
          const r = run(['check', ...args], dir);
          expect(r.status).toBe(1);
          expect(r.stderr).toContain('--approve cannot be combined with --no-approve.');
          expect(existsSync(DET_LOCK(dir))).toBe(false);
        }
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });

    it('says --top wants a positive number, and names the no-write read under auto_approve', () => {
      const dir = project('flags2');
      try {
        expect(run(['check', '--top', '0'], dir).stderr).toContain('--top expects a positive whole number (1 or more); got "0".');
        appendFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'auto_approve: deterministic\n');
        const r = run(['check', '--no-approve', '--dry-run'], dir);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('yg check --no-approve (plain read)');
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });

    it('help says --only-deterministic implies --approve', () => {
      const r = run(['check', '--help'], CLI_ROOT);
      expect(r.stdout.replace(/\s+/g, ' ')).toContain('implies --approve');
    });
  });

  describe('10. log_required that is not measuring changes', () => {
    it('warns when only --only-deterministic runs record, and not after a full --approve', () => {
      const dir = project('cycle');
      try {
        dropJudgmentRule(dir);
        makeServiceLogRequired(dir);
        run(['log', 'add', '--node', 'services/payments', '--reason', 'a'], dir);
        run(['log', 'add', '--node', 'services/orders', '--reason', 'a'], dir);
        run(['check', '--approve', '--only-deterministic'], dir);
        appendFileSync(path.join(dir, 'src', 'services', 'payments.ts'), '// later edit\n');
        const r = run(['check', '--approve', '--only-deterministic', '--json'], dir);
        const open = json(r).issues.filter((i) => i.code === 'log-cycle-open');
        expect(open.length).toBeGreaterThan(0);
        expect(open[0].severity).toBe('warning');
        run(['check', '--approve'], dir);
        expect(run(['check', '--json'], dir).stdout).not.toContain('log-cycle-open');
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('11. a broken graph file', () => {
    it('does not call an in-use aspect orphaned while a node file failed to load', () => {
      const dir = project('broken-node');
      try {
        edit(dir, '.yggdrasil/model/services/orders/yg-node.yaml', (s) => s.replace('mapping:', 'mapping: 5\nx:'));
        const doc = json(run(['check', '--json'], dir));
        expect(doc.issues.some((i) => i.code === 'yaml-invalid')).toBe(true);
        expect(doc.issues.some((i) => i.code === 'orphaned-aspect')).toBe(false);
        const yamlInvalid = doc.issues.find((i) => i.code === 'yaml-invalid');
        expect(yamlInvalid?.next).toContain('yg schemas read node');
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });

    it('does not call a schema error YAML syntax, nor print the no-when banner for an unread architecture', () => {
      const dir = project('broken-arch');
      try {
        edit(dir, '.yggdrasil/yg-architecture.yaml', (s) => s.replace('log_required: false', 'log_requried: false'));
        appendFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), 'coverage:\n  type_level: true\n');
        const r = run(['check'], dir);
        expect(r.stdout).toContain('architecture-invalid');
        expect(r.stdout).not.toContain('Fix the YAML syntax');
        expect(r.stdout).toContain('yg schemas read architecture');
        expect(r.stdout).not.toContain("no type in yg-architecture.yaml declares 'when:'");
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('12. yg advise', () => {
    it('names a family-candidates file it could not use, and cites no absent incidents.md', () => {
      const dir = project('advise');
      try {
        writeFileSync(path.join(dir, '.yggdrasil', '.family-candidates.grain.json'), '{"v":2,"ts":"2026-09-01T00:00:00Z","families":[]}', 'utf-8');
        writeFileSync(path.join(dir, '.yggdrasil', '.family-candidates.other.json'), '{"v":1,', 'utf-8');
        const r = run(['advise'], dir);
        expect(r.stdout).toContain('.family-candidates.grain.json were not read — its format version is 2');
        expect(r.stdout).toContain('.family-candidates.other.json were not read — it is not valid JSON');
        expect(r.stdout).not.toContain('see .yggdrasil/incidents.md');
        expect(r.stdout).toContain('yg incident add');
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('13. unverified pairs, grouped by cause', () => {
    it('separates a local deterministic result not yet run from a stale verdict', () => {
      const dir = project('causes');
      try {
        dropJudgmentRule(dir);
        // Fresh checkout: no local deterministic results at all.
        const fresh = json(run(['check', '--json'], dir));
        const freshCauses = fresh.issues.filter((i) => i.code === 'unverified').map((i) => i.cause);
        expect(freshCauses.every((c) => c === 'deterministic-not-run')).toBe(true);
        expect(fresh.suggestedNext).toBe('yg check --approve --only-deterministic');
        expect(run(['check'], dir).stdout).toMatch(/^error\[unverified\] \d+ pairs? whose script check has not run on this checkout — free to run$/m);
        // Filled, then the code moves: the verdict is stale, not "not yet reviewed".
        run(['check', '--approve', '--only-deterministic'], dir);
        appendFileSync(path.join(dir, 'src', 'services', 'orders.ts'), '// moved\n');
        const text = run(['check'], dir).stdout;
        expect(text).toMatch(/^error\[unverified\] \d+ pairs? whose inputs changed since the verdict$/m);
        expect(json(run(['check', '--json'], dir)).issues.some((i) => i.cause === 'stale')).toBe(true);
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });

  describe('14. non-pair findings', () => {
    it('are counted as issues, not pairs', () => {
      const dir = project('nouns');
      try {
        edit(dir, '.yggdrasil/model/services/orders/yg-node.yaml', (s) => s.replace('mapping:', 'mapping: 5\nx:'));
        const text = run(['check'], dir).stdout;
        // A non-pair finding is one block with no pair count, and counts as one error issue in the verdict line.
        expect(text).toMatch(/^error\[yaml-invalid\] yg-node\.yaml in services\/orders /m);
        expect(text).not.toMatch(/^error\[yaml-invalid\].*\bpairs?\b/m);
        expect(text).toMatch(/^yg check: FAIL {2}5 errors · /m);
      } finally {
        rmSync(dir, FIXTURE_RM_OPTIONS);
      }
    });
  });
});
