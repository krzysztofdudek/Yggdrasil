// =============================================================================
// CLI E2E — what a log entry is owed for, and what a missing one stops.
//
// The contract: a log entry comments on a change to a component's OWN source,
// and only that. Editing a rule, declaring a relation, or losing the verdicts
// re-opens a component's pairs and owes no entry. A recording run stops before
// it records anything when a component it would fill a pair of changed its own
// source with no entry; a changed component it fills nothing of does not stop
// it, and stays red on the plain read until its entry exists.
//
// Each case starts from a recorded baseline on the lifecycle fixture (script
// rules only, the `service` type opting into the log requirement, a `lib` type
// with no rules at all) and changes one thing. Hermetic: no reviewer is called,
// except in the last case, where a reviewer rule exists but the only run is the
// free one that never calls it.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture, FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';
import { errorCodes, expectIssue, parseJson, textNext } from '../support/assert-output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const LIFECYCLE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k];
  for (const k of ['FORCE_COLOR', 'CI', 'GITHUB_ACTIONS']) delete e[k];
  return e;
}

interface Run { status: number | null; stdout: string; stderr: string; all: string }

function yg(dir: string, args: string[]): Run {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8', timeout: 90_000, env: env() });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
}

const write = (dir: string, rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};

/**
 * The lifecycle fixture with the service type owing log entries, plus a `lib`
 * component of a rule-less type that owes them too — each with an entry and a
 * baseline recorded by a full recording run. `keepReviewerRule` keeps the
 * fixture's reviewer rule on the service type (never called here).
 */
function baseline(label: string, keepReviewerRule = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-log-scope-${label}-`));
  cpSync(LIFECYCLE, dir, { recursive: true });
  const archRel = path.join('.yggdrasil', 'yg-architecture.yaml');
  let arch = readFileSync(path.join(dir, archRel), 'utf-8');
  if (!keepReviewerRule) {
    arch = arch.split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n');
    rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), FIXTURE_RM_OPTIONS);
  }
  const at = arch.indexOf('log_required: false', arch.indexOf('  service:'));
  arch = `${arch.slice(0, at)}log_required: true${arch.slice(at + 'log_required: false'.length)}`;
  arch += `\n  lib:\n    description: 'A library file with no rules of its own.'\n    log_required: true\n    when:\n      path: "src/lib/**"\n    parents: [module]\n`;
  write(dir, archRel, arch);
  write(dir, 'src/lib/util.ts', 'export const util = 1;\n');
  write(dir, '.yggdrasil/model/services/lib/yg-node.yaml', 'name: Lib\ndescription: Shared helpers.\ntype: lib\nmapping:\n  - src/lib/util.ts\n');
  runGitFixture(dir, ['init', '-q', '-b', 'main']);
  if (!keepReviewerRule) {
    for (const node of ['services/orders', 'services/payments', 'services/lib']) {
      expect(yg(dir, ['log', 'add', '--node', node, '--reason', 'The first entry, before anything moved.']).status).toBe(0);
    }
    const recorded = yg(dir, ['check', '--approve']);
    expect(recorded.status, recorded.all).toBe(0);
  }
  runGitFixture(dir, ['add', '-A']);
  runGitFixture(dir, ['commit', '-q', '-m', 'baseline']);
  return dir;
}

const owes = (out: Run, node: string): boolean => new RegExp(`^error\\[log-entry-missing\\][^\\n]*\\n {2}at: {3}${node}$`, 'm').test(out.stdout);

describe.skipIf(!distExists)('CLI E2E — a log entry is owed for a change to the component’s own source, and only that', () => {
  it('editing a rule re-opens the pairs and owes no entry; the fill records them', () => {
    const dir = baseline('rule-edit');
    try {
      appendFileSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs'), '\n// sharpened\n');
      const plain = yg(dir, ['check']);
      expect(plain.stdout).toContain('error[unverified]');
      expect(plain.all).not.toContain('log-entry-missing');
      const fill = yg(dir, ['check', '--approve']);
      expect(fill.status, fill.all).toBe(0);
      expect(fill.stderr).toMatch(/^fill {2}2 pairs/m);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);

  it('declaring a relation owes no entry', () => {
    const dir = baseline('relation');
    try {
      appendFileSync(path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml'), 'relations:\n  - target: services/payments\n    type: uses\n');
      expect(yg(dir, ['check']).all).not.toContain('log-entry-missing');
      const fill = yg(dir, ['check', '--approve']);
      expect(fill.status, fill.all).toBe(0);
      expect(fill.all).not.toContain('log-entry-missing');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);

  it('losing the recorded verdicts owes no entry; the fill records them again', () => {
    const dir = baseline('verdicts');
    try {
      rmSync(path.join(dir, '.yggdrasil', '.yg-lock.deterministic.json'));
      const plain = yg(dir, ['check']);
      expect(plain.stdout).toContain('error[unverified]');
      expect(plain.all).not.toContain('log-entry-missing');
      const fill = yg(dir, ['check', '--approve', '--only-deterministic']);
      expect(fill.status, fill.all).toBe(0);
      expect(fill.stderr).toMatch(/^fill {2}4 pairs/m);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);

  it('a change to the component’s own source owes an entry, and the fill stops before recording anything', () => {
    const dir = baseline('source-edit');
    try {
      appendFileSync(path.join(dir, 'src', 'services', 'orders.ts'), '\nexport const later = 2;\n');
      expect(owes(yg(dir, ['check']), 'services/orders')).toBe(true);
      const fill = yg(dir, ['check', '--approve']);
      expect(fill.status).toBe(1);
      expect(fill.stdout).toContain('yg check: ABORTED  nothing recorded — 1 node needs a log entry first');
      expect(fill.stderr).not.toMatch(/^fill {2}/m);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);

  it('a changed component the fill fills nothing of stays red but does not stop the fill', () => {
    const dir = baseline('unrelated');
    try {
      // lib has no rules, so no pair of it is ever filled; a rule edit re-opens
      // the services' pairs, which the fill does record.
      appendFileSync(path.join(dir, 'src', 'lib', 'util.ts'), 'export const more = 2;\n');
      appendFileSync(path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs'), '\n// sharpened\n');
      expect(owes(yg(dir, ['check']), 'services/lib')).toBe(true);
      const fill = yg(dir, ['check', '--approve']);
      expect(fill.stdout).not.toContain('ABORTED');
      expect(fill.stderr).toMatch(/^fill {2}2 pairs .*\n(?:.*\n)*fill {2}done in .* — 2 passed/m);
      // Recorded for the services; lib is still owed its entry.
      expect(owes(fill, 'services/lib')).toBe(true);
      expect(fill.status).toBe(1);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);

  it('switching a type to log_required owes no entry; the first real source change after it does', () => {
    // Two components of a type that does not ask for entries, recorded by a full fill.
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-log-scope-switch-'));
    try {
      cpSync(LIFECYCLE, dir, { recursive: true });
      const archRel = path.join('.yggdrasil', 'yg-architecture.yaml');
      write(dir, archRel, readFileSync(path.join(dir, archRel), 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'));
      rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), FIXTURE_RM_OPTIONS);
      runGitFixture(dir, ['init', '-q', '-b', 'main']);
      const recorded = yg(dir, ['check', '--approve']);
      expect(recorded.status, recorded.all).toBe(0);
      runGitFixture(dir, ['add', '-A']);
      runGitFixture(dir, ['commit', '-q', '-m', 'recorded']);
      // The type opts in; no file of either component changes.
      const arch = readFileSync(path.join(dir, archRel), 'utf-8');
      const at = arch.indexOf('log_required: false', arch.indexOf('  service:'));
      write(dir, archRel, `${arch.slice(0, at)}log_required: true${arch.slice(at + 'log_required: false'.length)}`);
      const switched = yg(dir, ['check']);
      expect(switched.all).not.toContain('log-entry-missing');
      expect(switched.status, switched.all).toBe(0);
      // The first real change to one component's source owes that component an entry, and only it.
      appendFileSync(path.join(dir, 'src', 'services', 'orders.ts'), '\nexport const later = 2;\n');
      const edited = yg(dir, ['check']);
      expect(owes(edited, 'services/orders')).toBe(true);
      expect(edited.stdout).not.toContain('services/payments');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);

  it('the free run is not stopped by a changed component whose only pending pairs are reviewer pairs it leaves alone', () => {
    const dir = baseline('reviewer-only', true);
    try {
      // A component whose only rule is a reviewer rule, owing its first entry.
      const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
      appendFileSync(arch, `  doc:\n    description: 'A documented file.'\n    log_required: true\n    when:\n      path: "src/doc/**"\n    parents: [module]\n    aspects:\n      - has-doc-comment\n`);
      write(dir, 'src/doc/readme.ts', '// Documented.\nexport const doc = 1;\n');
      write(dir, '.yggdrasil/model/services/doc/yg-node.yaml', 'name: Doc\ndescription: A documented file.\ntype: doc\nmapping:\n  - src/doc/readme.ts\n');
      // The services' own entries exist, so the only component owing one is doc.
      for (const node of ['services/orders', 'services/payments', 'services/lib']) {
        yg(dir, ['log', 'add', '--node', node, '--reason', 'The first entry, before anything moved.']);
      }
      expect(owes(yg(dir, ['check']), 'services/doc')).toBe(true);
      const free = yg(dir, ['check', '--approve', '--only-deterministic']);
      expect(free.stdout).not.toContain('ABORTED');
      expect(free.stderr).toMatch(/^fill {2}4 pairs · 4 script \(free\)/m);
      expect(owes(free, 'services/doc')).toBe(true);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);
  // Every "then re-run" line of a fill names the command as it was invoked, so
  // a free run never sends its reader to the paid one: the owed entry the
  // report names, and the fill that finds another one already holding the lock.
  it('the re-run a fill names is the command as it was invoked, flags kept', () => {
    const dir = baseline('retry');
    const rerun = (next: string): string | undefined => /re-run:? (yg check[a-z -]*?)(?=[.\n]|$)/.exec(next)?.[1];
    try {
      write(dir, 'src/lib/util.ts', 'export const util = 2;\n');
      for (const flags of [['--only-deterministic'], ['--dry-run'], ['--only-deterministic', '--full']]) {
        const run = yg(dir, ['check', '--approve', ...flags, '--json']);
        const issue = expectIssue(parseJson(run.stdout), { code: 'log-entry-missing', node: 'services/lib' });
        expect(rerun(String(issue.next))).toBe(['yg check --approve', ...flags].join(' '));
      }
      writeFileSync(path.join(dir, '.yggdrasil', '.yg-approve.lock'), JSON.stringify({ pid: 1, host: 'elsewhere', command: 'yg check --approve', startedAt: new Date().toISOString() }));
      const held = yg(dir, ['check', '--approve', '--only-deterministic', '--json']);
      const error = parseJson(held.stdout);
      expect(error.code).toBe('lock-environment');
      expect(rerun(error.next?.text ?? '')).toBe('yg check --approve --only-deterministic');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);
  // After a merge the documented recipe ends green: a merge that combined both
  // sides' code in a component owes the merge's own entry, and merge-resolve
  // names it as the next step; a merge that changed only the log owes nothing.
  it.each([
    { label: 'code', bChangesCode: true },
    { label: 'log-only', bChangesCode: false },
  ])('the merge recipe ends green — $label', ({ label, bChangesCode }) => {
    const dir = baseline(`merge-${label}`);
    const git = (args: string[]): void => { runGitFixture(dir, args); };
    try {
      write(dir, 'src/lib/util.ts', 'export const util = 1;\n\n\n\nexport const tail = 1;\n');
      yg(dir, ['log', 'add', '--node', 'services/lib', '--reason', 'Two exports.']);
      expect(yg(dir, ['check', '--approve']).status).toBe(0);
      git(['add', '-A']); git(['commit', '-q', '-m', 'two exports']);
      git(['checkout', '-q', '-b', 'b']);
      if (bChangesCode) write(dir, 'src/lib/util.ts', 'export const util = 1;\n\n\n\nexport const tail = 2;\n');
      yg(dir, ['log', 'add', '--node', 'services/lib', '--reason', 'Side b.']);
      expect(yg(dir, ['check', '--approve']).status).toBe(0);
      git(['add', '-A']); git(['commit', '-q', '-m', 'b']);
      git(['checkout', '-q', 'main']);
      write(dir, 'src/lib/util.ts', 'export const util = 2;\n\n\n\nexport const tail = 1;\n');
      yg(dir, ['log', 'add', '--node', 'services/lib', '--reason', 'Side a.']);
      expect(yg(dir, ['check', '--approve']).status).toBe(0);
      git(['add', '-A']); git(['commit', '-q', '-m', 'a']);
      spawnSync('git', ['merge', 'b'], { cwd: dir, env: env() });
      spawnSync('git', ['checkout', '--ours', '--', '.yggdrasil/yg-lock.logs.json'], { cwd: dir, env: env() });
      const resolved = yg(dir, ['log', 'merge-resolve', '--node', 'services/lib']);
      expect(resolved.status, resolved.all).toBe(0);
      const step = textNext(resolved.stdout) ?? '';
      expect(step.startsWith('yg log add --node services/lib')).toBe(bChangesCode);
      if (bChangesCode) yg(dir, ['log', 'add', '--node', 'services/lib', '--reason', 'Both sides merged.']);
      git(['add', '-A']); git(['commit', '-q', '--no-edit']);
      const after = yg(dir, ['check', '--approve']);
      expect(after.status, after.all).toBe(0);
      expect(errorCodes(after.stdout)).not.toContain('log-entry-missing');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);
});
