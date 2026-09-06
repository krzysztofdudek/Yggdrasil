// =============================================================================
// CLI E2E — `yg drill add`: a real escape becomes a permanent case.
//
// The doctrine under test is "production is the corpus". The most valuable case
// a rule can hold is the code that actually got past it, and the moment worth
// capturing it is the moment somebody finds it — so the command reads the file
// as it stood at a named commit, files it under the corpus's own convention with
// its origin in the name, runs the rule over it, and records what happened in
// the rule's own log.
//
// The scenario that matters most is the uncomfortable one: a rule that does NOT
// catch its own escape is reported as failing AND THE CASE STAYS. A corpus that
// only ever accepts cases the rule already passes could never tell anybody
// anything.
//
//   1. caught     → the rule refuses it: exit 0, case named for its origin, logged
//   2. missed     → the rule lets it through: exit 1, case KEPT, hole logged
//   3. pair       → --violates and --satisfies added together in one act
//   4. refusals   → each says what/why/next and leaves the corpus untouched
//   5. unrunnable → a rule that cannot be exercised keeps nothing at all
//   6. corpus     → what was added is what `yg drill` afterwards runs
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  cpSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

/** The rule the fixture ships that refuses any line carrying the word TODO. */
const RULE = 'no-todo-comments';
const corpusPath = (dir: string, rule = RULE): string =>
  path.join(dir, '.yggdrasil', 'aspects', rule, 'drills');
const logPath = (dir: string, rule = RULE): string =>
  path.join(dir, '.yggdrasil', 'aspects', rule, 'log.md');

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return (r.stdout ?? '').trim();
}

/**
 * A real project on disk with a real history: the fixture graph, plus source
 * files committed one at a time so each has a commit of its own to be read from.
 */
function repoWithHistory(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-drilladd-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'drill@example.test'], dir);
  git(['config', 'user.name', 'Drill Fixture'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'the project as it was'], dir);
  return dir;
}

/** Commit one file and return the commit it landed in. */
function commitFile(dir: string, relPath: string, content: string, message: string): string {
  const abs = path.join(dir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-qm', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

const ESCAPED = 'export function charge(): number {\n  // TODO: refunds are not handled\n  return 1;\n}\n';
const CLEAN = 'export function refundClean(): number {\n  // handled, and no marker left behind\n  return 2;\n}\n';

describe.skipIf(!distExists)('CLI E2E — yg drill add', () => {
  it('1: a rule that catches the escape reports it, names the case for its origin, and logs it', () => {
    const dir = repoWithHistory('caught');
    try {
      const sha = commitFile(dir, 'src/charge.ts', ESCAPED, 'the code that got past the rule');

      const added = run(
        ['drill', 'add', '--aspect', RULE, '--violates', `src/charge.ts@${sha}`, '--why', 'It shipped and nothing stopped it.'],
        dir,
      );
      expect(added.status).toBe(0);
      expect(added.all).toContain('pass');
      expect(added.stdout).toContain('behaves as expected');

      // The case name carries where it came from: the file, the day, the commit.
      const cases = readdirSync(corpusPath(dir));
      expect(cases).toHaveLength(1);
      const label = cases[0];
      expect(label.startsWith('violates-charge-')).toBe(true);
      expect(label.endsWith(sha.slice(0, 7))).toBe(true);
      expect(/violates-charge-\d{8}-[0-9a-f]{7}/.test(label)).toBe(true);

      // And it holds the file exactly as it stood at that commit.
      const stored = readFileSync(path.join(corpusPath(dir), label, 'charge.ts'), 'utf-8');
      expect(stored).toBe(ESCAPED);

      // The rule's own log records the act, the provenance and the reason given.
      const log = readFileSync(logPath(dir), 'utf-8');
      expect(log).toContain('## [');
      expect(log).toContain(sha);
      expect(log).toContain('src/charge.ts');
      expect(log).toContain('It shipped and nothing stopped it.');
      expect(log).toContain('The rule refuses it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: a rule that does NOT catch the escape fails and KEEPS the case', () => {
    const dir = repoWithHistory('missed');
    try {
      // A marker this rule does not look for: real code that got past it.
      const sha = commitFile(
        dir,
        'src/refund.ts',
        'export function refund(): number {\n  // FIXME: this slipped through\n  return 2;\n}\n',
        'the escape the rule has no eye for',
      );

      const added = run(
        ['drill', 'add', '--aspect', RULE, '--violates', `src/refund.ts@${sha}`, '--why', 'A FIXME escaped; the rule only looks for TODO.'],
        dir,
      );
      expect(added.status).toBe(1);
      expect(added.all).toContain('MISS');
      expect(added.stderr).toContain('does not catch');
      expect(added.stderr).toContain('stays there');

      // The point of the whole exercise: the case is in the corpus, red.
      const cases = readdirSync(corpusPath(dir));
      expect(cases).toHaveLength(1);
      expect(cases[0].startsWith('violates-refund-')).toBe(true);

      // And the log says plainly that the rule has a hole, not that all is well.
      const log = readFileSync(logPath(dir), 'utf-8');
      expect(log).toContain('does NOT refuse it');
      expect(log).toContain('A FIXME escaped; the rule only looks for TODO.');

      // Re-running the corpus reports the same failure — the case is now standing.
      const drilled = run(['drill', '--aspect', RULE], dir);
      expect(drilled.status).toBe(1);
      expect(drilled.all).toContain('MISS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: the escape and the fix can be taken in together, and a case with no reason says so', () => {
    const dir = repoWithHistory('pair');
    try {
      const bad = commitFile(dir, 'src/charge.ts', ESCAPED, 'the escape');
      const good = commitFile(dir, 'src/clean.ts', CLEAN, 'the fix');

      const added = run(
        ['drill', 'add', '--aspect', RULE, '--violates', `src/charge.ts@${bad}`, '--satisfies', `src/clean.ts@${good}`],
        dir,
      );
      expect(added.status).toBe(0);

      const cases = readdirSync(corpusPath(dir)).sort();
      expect(cases).toHaveLength(2);
      expect(cases.some((c) => c.startsWith('violates-charge-'))).toBe(true);
      expect(cases.some((c) => c.startsWith('satisfies-clean-'))).toBe(true);

      // No reason was given, and the log says exactly that rather than inventing one.
      const log = readFileSync(logPath(dir), 'utf-8');
      expect(log).toContain('No reason was given when the case was added.');
      expect(log).toContain('The rule passes it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: every refusal says what, why and next, and leaves the corpus untouched', () => {
    const dir = repoWithHistory('refuse');
    try {
      const sha = commitFile(dir, 'src/charge.ts', ESCAPED, 'the escape');
      commitFile(dir, 'src/empty.ts', '', 'an empty file');
      const emptySha = git(['rev-parse', 'HEAD'], dir);

      const unknownRule = run(['drill', 'add', '--aspect', 'no-such-rule', '--violates', `src/charge.ts@${sha}`], dir);
      expect(unknownRule.status).toBe(1);
      expect(unknownRule.stderr).toContain("No rule 'no-such-rule' in this graph");
      expect(unknownRule.stderr).toContain('yg aspects');

      const malformed = run(['drill', 'add', '--aspect', RULE, '--violates', 'src/charge.ts'], dir);
      expect(malformed.status).toBe(1);
      expect(malformed.stderr).toContain('is not a file at a commit');

      const outside = run(['drill', 'add', '--aspect', RULE, '--violates', `../secrets.ts@${sha}`], dir);
      expect(outside.status).toBe(1);
      expect(outside.stderr).toContain('is not inside the repository');

      const absent = run(['drill', 'add', '--aspect', RULE, '--violates', `src/never-existed.ts@${sha}`], dir);
      expect(absent.status).toBe(1);
      expect(absent.stderr).toContain('is not in commit');

      const noCommit = run(['drill', 'add', '--aspect', RULE, '--violates', 'src/charge.ts@0000000'], dir);
      expect(noCommit.status).toBe(1);
      expect(noCommit.stderr).toContain('has no commit');

      const empty = run(['drill', 'add', '--aspect', RULE, '--violates', `src/empty.ts@${emptySha}`], dir);
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain('is empty at commit');

      // Not one of them wrote anything.
      expect(existsSync(corpusPath(dir))).toBe(false);
      expect(existsSync(logPath(dir))).toBe(false);

      // The same content twice is one case, whatever it is called the second time.
      const first = run(['drill', 'add', '--aspect', RULE, '--violates', `src/charge.ts@${sha}`], dir);
      expect(first.status).toBe(0);
      const copySha = commitFile(dir, 'src/charge-copy.ts', ESCAPED, 'the same code under another name');
      const duplicate = run(['drill', 'add', '--aspect', RULE, '--violates', `src/charge-copy.ts@${copySha}`], dir);
      expect(duplicate.status).toBe(1);
      expect(duplicate.stderr).toContain('is already the case');
      expect(readdirSync(corpusPath(dir))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: a rule that cannot be exercised over case files keeps nothing at all', () => {
    const dir = repoWithHistory('unrunnable');
    try {
      // A real rule that needs the whole graph to decide anything. A drill runs a
      // rule over case files alone, so this one can never be measured that way.
      const ruleDir = path.join(dir, '.yggdrasil', 'aspects', 'needs-the-graph');
      mkdirSync(ruleDir, { recursive: true });
      writeFileSync(
        path.join(ruleDir, 'yg-aspect.yaml'),
        'name: NeedsTheGraph\ndescription: Every file must belong to a component that declares at least one relation.\nreviewer:\n  type: deterministic\nstatus: advisory\n',
        'utf-8',
      );
      writeFileSync(
        path.join(ruleDir, 'check.mjs'),
        'export function check(ctx) {\n  const nodes = ctx.graph.nodes;\n  return nodes.length === 0 ? [{ file: ctx.files[0].path, line: 1, column: 0, message: "no components" }] : [];\n}\n',
        'utf-8',
      );
      // An aggregate rule bundles others and ships no rule source of its own.
      const aggDir = path.join(dir, '.yggdrasil', 'aspects', 'the-bundle');
      mkdirSync(aggDir, { recursive: true });
      writeFileSync(
        path.join(aggDir, 'yg-aspect.yaml'),
        `name: TheBundle\ndescription: Bundles the rules that guard everyday source hygiene.\nreviewer:\n  type: aggregate\nimplies:\n  - ${RULE}\n`,
        'utf-8',
      );
      const sha = commitFile(dir, 'src/charge.ts', ESCAPED, 'the escape');

      const aggregate = run(['drill', 'add', '--aspect', 'the-bundle', '--violates', `src/charge.ts@${sha}`], dir);
      expect(aggregate.status).toBe(1);
      expect(aggregate.stderr).toContain('only bundles other rules');
      expect(existsSync(corpusPath(dir, 'the-bundle'))).toBe(false);

      const unrunnable = run(['drill', 'add', '--aspect', 'needs-the-graph', '--violates', `src/charge.ts@${sha}`], dir);
      expect(unrunnable.status).toBe(1);
      expect(unrunnable.stderr).toContain('could not be run over the case');
      expect(unrunnable.stderr).toContain('Nothing was added');
      // Taken back out: an unmeasurable case would sit in the corpus forever.
      expect(readdirSync(corpusPath(dir, 'needs-the-graph'))).toHaveLength(0);
      expect(existsSync(logPath(dir, 'needs-the-graph'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: what was added is what the corpus afterwards runs, and the graph still loads', () => {
    const dir = repoWithHistory('corpus');
    try {
      const sha = commitFile(dir, 'src/charge.ts', ESCAPED, 'the escape');
      const before = run(['aspects'], dir);
      expect(run(['drill', 'add', '--aspect', RULE, '--violates', `src/charge.ts@${sha}`], dir).status).toBe(0);

      const drilled = run(['drill', '--aspect', RULE], dir);
      expect(drilled.status).toBe(0);
      expect(drilled.stdout).toContain('1 pass');

      // The rule's log is prose beside the rule, not part of the graph: the same
      // rules are there afterwards, and nothing new was registered by writing it.
      const after = run(['aspects'], dir);
      expect(after.stdout).toBe(before.stdout);
      expect(run(['check'], dir).all).not.toContain('Failed to load graph');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
