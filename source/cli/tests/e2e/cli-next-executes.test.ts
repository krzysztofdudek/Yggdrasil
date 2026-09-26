// =============================================================================
// CLI E2E — every step a report hands over is one the CLI accepts, and none
// costs more than the command that printed it.
//
// A corpus of broken states, each reached the way a person reaches it, each
// reported by the mode a person would run: a file no node owns, a check.mjs that
// crashes under the free recording run, an edited copy of an installed package,
// a misspelled configuration key, a log left conflicted by a real `git merge`,
// and a source change with no log entry. For each one the test reads the
// report's `next` object (`yg-check/1`), then:
//
//   - EXECUTES `next.command` when it is one — or, for a command that waits on
//     words only a person supplies (`<why this change was made>`, for which
//     `next.command` is null by contract), the step's own text with those words
//     filled in — and asserts the CLI did not refuse it as a usage error or a
//     command error: a step the tool itself rejects is not a step;
//   - otherwise asserts the step names the file it is about;
//   - asserts neither the step nor its `then:` escalates cost beyond the mode
//     that was run: a recording run that could not call the reviewer is never
//     followed by one that can, unless the step states the reviewer's price
//     (an agent may run a paid fill — its cost is always stated).
//
// Hermetic: local fixtures copied into temp dirs, git pinned to each fixture,
// no network (the fixture's reviewer tier is never called: no mode run here
// fills a reviewer pair).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture, FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURES = path.join(CLI_ROOT, 'tests', 'fixtures');
const LIFECYCLE = path.join(FIXTURES, 'e2e-lifecycle');
const CONSUMER = path.join(FIXTURES, 'pack-consumer');
const MARKET = path.join(FIXTURES, 'marketplace-demo');
const distExists = existsSync(BIN_PATH);

/** The environment a person's shell gives the CLI: no colour, no CI, no leaked git plumbing. */
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

interface NextStep {
  command: string[] | null;
  text: string;
  target: { node?: string; file?: string };
  cost: { free: number; reviewerPairs: number; reviewerCalls: number };
  requiresUser: boolean;
  then: string | null;
}

/** The report's `next` object for the mode `args` runs (`--json` added). */
function nextOf(dir: string, args: string[]): NextStep {
  const out = yg(dir, [...args, '--json']);
  const doc = JSON.parse(out.stdout) as { schema: string; next: NextStep | null };
  expect(doc.schema).toBe('yg-check/1');
  expect(doc.next, `${args.join(' ')} names a step`).not.toBeNull();
  return doc.next!;
}

/** Whether a command is a recording run that can bill the reviewer. */
const paidFill = (words: readonly string[]): boolean =>
  words.includes('check') && words.includes('--approve') && !words.includes('--only-deterministic') && !words.includes('--dry-run');

/**
 * The step and its `then:` stay within the cost of the mode that was run, or
 * state the reviewer's price where they go beyond it.
 */
function expectNoSilentEscalation(invoked: string[], step: NextStep): void {
  if (paidFill(invoked)) return;
  if (step.command !== null && paidFill(step.command)) {
    expect(step.cost.reviewerPairs, `${step.text} bills the reviewer, so it states the price`).toBeGreaterThan(0);
    expect(step.text).not.toContain('ask the user to approve it first');
  }
  if (step.then !== null && paidFill(step.then.split(/\s+/))) {
    expect(step.then, 'a paid then: states its price').toMatch(/· paid\)/);
  }
}

/**
 * Run the step as a person would, their own words in a `<placeholder>`, and
 * require the CLI to have taken it: no usage refusal, no command error.
 */
function executes(dir: string, command: string[]): Run {
  expect(command[0]).toBe('yg');
  const argv = command.slice(1).map((t) => (/^<[^>]+>$/.test(t) ? 'Recorded by the corpus test.' : t));
  const out = yg(dir, argv);
  expect(out.all, `${command.join(' ')} was refused`).not.toMatch(/error\[(?:usage|command-error)\]/);
  expect(out.all).not.toMatch(/unknown option|unknown command|missing required argument/i);
  return out;
}

/**
 * The command a step runs: `next.command`, or — when that is null because a
 * person has to supply some words — the step's text read as a shell reads it.
 */
function runnable(step: NextStep): string[] | null {
  if (step.command !== null) return step.command;
  if (!step.text.startsWith('yg ')) return null;
  return (step.text.match(/'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^'(.*)'$/, '$1'));
}

/** The lifecycle fixture with only script rules, committed — a clean, free-to-fill base. */
function lifecycle(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-next-exec-${label}-`));
  cpSync(LIFECYCLE, dir, { recursive: true });
  const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  writeFileSync(arch, readFileSync(arch, 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'));
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), FIXTURE_RM_OPTIONS);
  runGitFixture(dir, ['init', '-q', '-b', 'main']);
  commit(dir, 'base');
  return dir;
}

function commit(dir: string, message: string): void {
  runGitFixture(dir, ['add', '-A']);
  runGitFixture(dir, ['commit', '-q', '-m', message]);
}

/** Turn the service type's log requirement on. */
function requireLogs(dir: string): void {
  const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const text = readFileSync(arch, 'utf-8');
  const at = text.indexOf('log_required: false', text.indexOf('  service:'));
  writeFileSync(arch, `${text.slice(0, at)}log_required: true${text.slice(at + 'log_required: false'.length)}`);
}

describe.skipIf(!distExists)('CLI E2E — every next.command runs, and none escalates cost', () => {
  it('a file no node owns: the step names its owners and answers', () => {
    const dir = lifecycle('unmapped');
    try {
      const config = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      writeFileSync(config, readFileSync(config, 'utf-8').replace('quality:', 'coverage:\n  required:\n    - src/\nquality:'));
      mkdirSync(path.join(dir, 'src', 'extra'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'extra', 'orphan.ts'), 'export const orphan = 1;\n');
      const step = nextOf(dir, ['check']);
      expect(step.command).toEqual(['yg', 'owner', '--file', 'src/extra/orphan.ts']);
      expect(executes(dir, step.command!).status).toBe(0);
      expectNoSilentEscalation(['check'], step);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);

  it('a check.mjs that crashes under the free run: fix the script, then the free run again — never the paid one', () => {
    const dir = lifecycle('crash');
    try {
      const script = path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs');
      writeFileSync(script, readFileSync(script, 'utf-8').replace('const violations = [];', "const violations = []; throw new Error('boom');"));
      const invoked = ['check', '--approve', '--only-deterministic'];
      const step = nextOf(dir, invoked);
      expect(step.command).toBeNull();
      expect(step.target.file).toBe('.yggdrasil/aspects/no-todo-comments/check.mjs');
      expect(step.text).toBe('edit .yggdrasil/aspects/no-todo-comments/check.mjs');
      expect(step.then).toBe('yg check --approve --only-deterministic');
      expectNoSilentEscalation(invoked, step);
      // The text report says the same, in the same two lines.
      const text = yg(dir, invoked);
      expect(text.stdout).toMatch(/^next: edit \.yggdrasil\/aspects\/no-todo-comments\/check\.mjs$/m);
      expect(text.stdout).toMatch(/^then: yg check --approve --only-deterministic$/m);
      // And the then: step, once the script is fixed, is one the CLI takes.
      writeFileSync(script, readFileSync(script, 'utf-8').replace(" throw new Error('boom');", ''));
      expect(executes(dir, step.then!.split(' ')).status).toBe(0);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);

  it('an edited copy of an installed package: the step names the package, and the reinstall runs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-next-exec-pack-'));
    try {
      cpSync(CONSUMER, dir, { recursive: true });
      expect(yg(dir, ['pack', 'add', `${MARKET}#demo`, '--as', 'acme/law']).status).toBe(0);
      appendFileSync(path.join(dir, '.yggdrasil', 'aspects', 'packages', 'acme', 'law', 'demo', 'rule-a', 'check.mjs'), '\n// mine\n');
      const step = nextOf(dir, ['check']);
      expect(step.command).toEqual(['yg', 'pack', 'update', 'demo', '--reinstall']);
      expect(executes(dir, step.command!).status).toBe(0);
      expectNoSilentEscalation(['check'], step);
      expect(yg(dir, ['check']).all).not.toContain('package-file-modified');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);

  it('a misspelled configuration key: the step is the configuration file', () => {
    const dir = lifecycle('config-typo');
    try {
      appendFileSync(path.join(dir, '.yggdrasil', 'yg-config.yaml'), '\nparalel: 4\n');
      const step = nextOf(dir, ['check']);
      expect(step.command).toBeNull();
      expect(step.target.file).toBe('.yggdrasil/yg-config.yaml');
      expect(step.text).toBe("rename 'paralel' to 'parallel' in .yggdrasil/yg-config.yaml");
      expectNoSilentEscalation(['check'], step);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);

  it('a log left conflicted by a real merge: the step is the reconciling command, and it runs mid-merge', () => {
    const dir = lifecycle('log-conflict');
    try {
      requireLogs(dir);
      yg(dir, ['log', 'add', '--node', 'services/orders', '--reason', 'The shared first entry.']);
      yg(dir, ['check', '--approve']);
      commit(dir, 'baseline');
      runGitFixture(dir, ['checkout', '-q', '-b', 'other']);
      yg(dir, ['log', 'add', '--node', 'services/orders', '--reason', 'An entry made on the other branch.']);
      commit(dir, 'other entry');
      runGitFixture(dir, ['checkout', '-q', 'main']);
      yg(dir, ['log', 'add', '--node', 'services/orders', '--reason', 'An entry made on main.']);
      commit(dir, 'main entry');
      const merge = runGitFixture(dir, ['merge', '-q', 'other']);
      expect(merge.status).not.toBe(0);
      const step = nextOf(dir, ['check']);
      expect(step.command).toEqual(['yg', 'log', 'merge-resolve', '--node', 'services/orders']);
      expect(executes(dir, step.command!).status).toBe(0);
      expectNoSilentEscalation(['check'], step);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);

  it('a source change with no log entry: the step records the reason, and it runs', () => {
    const dir = lifecycle('log-missing');
    try {
      requireLogs(dir);
      yg(dir, ['log', 'add', '--node', 'services/orders', '--reason', 'First entry.']);
      yg(dir, ['log', 'add', '--node', 'services/payments', '--reason', 'First entry.']);
      yg(dir, ['check', '--approve']);
      commit(dir, 'baseline');
      appendFileSync(path.join(dir, 'src', 'services', 'orders.ts'), '\nexport const later = 2;\n');
      for (const invoked of [['check'], ['check', '--approve', '--only-deterministic']]) {
        const step = nextOf(dir, invoked);
        expect(runnable(step)?.slice(0, 5)).toEqual(['yg', 'log', 'add', '--node', 'services/orders']);
        expectNoSilentEscalation(invoked, step);
      }
      const step = nextOf(dir, ['check']);
      expect(executes(dir, runnable(step)!).status).toBe(0);
      expect(yg(dir, ['check']).all).not.toContain('log-entry-missing');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);
});
