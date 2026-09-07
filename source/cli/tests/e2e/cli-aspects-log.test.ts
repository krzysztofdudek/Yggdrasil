// =============================================================================
// CLI E2E — a rule's own history: `yg aspects log add | read`, and a standing
// that moved.
//
// A component has always had a log beside it saying why it is the way it is. A
// rule had nothing — so its history lived in commit messages, or was smeared
// across the logs of every component it happened to reach. These scenarios pin
// the thing that makes a rule's log worth having: it holds the WHOLE history,
// and it never claims something that did not happen.
//
//   1. add/read   → an entry lands, reads back, and the same guards apply
//   2. standing   → a change is recorded with from / to / who / evidence
//   3. refusals   → a standing the rule does not carry, or with no evidence
//   4. noticed    → a change made by hand is reported, then written down ONCE
//   5. no repeat  → a change the caller already recorded is not said twice
//   6. document   → the inventory carries the last entry and what it said
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

/** The fixture's advisory rule — the one with somewhere to move in both directions. */
const RULE = 'requires-named-export';

const logPath = (dir: string, rule = RULE): string =>
  path.join(dir, '.yggdrasil', 'aspects', rule, 'log.md');
const rulePath = (dir: string, rule = RULE): string =>
  path.join(dir, '.yggdrasil', 'aspects', rule, 'yg-aspect.yaml');

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** A real project on disk: the fixture graph, copied whole. */
function project(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-aspectslog-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Edit a rule's standing the way a person does — in the rule's own file. */
function setStatus(dir: string, status: string, rule = RULE): void {
  const file = rulePath(dir, rule);
  const yaml = readFileSync(file, 'utf-8');
  writeFileSync(file, yaml.replace(/^status: .*$/m, `status: ${status}`), 'utf-8');
}

/** The free, keyless approving run — the one allowed to write. */
function approve(dir: string): { stdout: string; stderr: string; status: number | null; all: string } {
  return run(['check', '--approve', '--only-deterministic'], dir);
}

interface LogDoc {
  schema: string;
  aspect: string;
  status: string;
  entries: Array<{ at: string; body: string; status?: { from: string; to: string } }>;
}

describe.skipIf(!distExists)('CLI E2E — a rule keeps its own history', () => {
  it('1: an entry lands and reads back, and the guards a component log has hold here too', () => {
    const dir = project('add');
    try {
      const added = run(
        ['aspects', 'log', 'add', '--aspect', RULE, '--reason', 'This rule exists because an unexported helper was copied into three files before anybody noticed.'],
        dir,
      );
      expect(added.status).toBe(0);
      expect(added.stdout).toContain(`Added a log entry to rule '${RULE}'`);

      const read = run(['aspects', 'log', 'read', '--aspect', RULE], dir);
      expect(read.status).toBe(0);
      expect(read.stdout).toContain('copied into three files');
      expect(read.stdout).toContain('stands at advisory');

      // An entry with nothing in it records that something happened and hides what.
      const empty = run(['aspects', 'log', 'add', '--aspect', RULE, '--reason', '   '], dir);
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain('Reason cannot be empty');

      // Text that would swallow every later entry for anything parsing the file.
      const header = run(['aspects', 'log', 'add', '--aspect', RULE, '--reason', '## [not an entry header]'], dir);
      expect(header.status).toBe(1);
      expect(header.stderr).toContain('level-2 header');

      // A rule nobody has such a command for.
      const unknown = run(['aspects', 'log', 'read', '--aspect', 'no-such-rule'], dir);
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain("No rule 'no-such-rule' in this graph");

      // A rule nothing has been said about yet is not an error.
      const quiet = run(['aspects', 'log', 'read', '--aspect', 'no-todo-comments'], dir);
      expect(quiet.status).toBe(0);
      expect(quiet.stdout).toContain('no history recorded yet');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: a change of standing is recorded with where it moved from, to, who decided and on what', () => {
    const dir = project('standing');
    try {
      // Where a rule moved FROM is only knowable once the tool has seen it: on a
      // graph it has never looked at, the entry says so rather than assuming the
      // default and writing a standing that may never have been true.
      setStatus(dir, 'enforced');
      const unseen = run(
        ['aspects', 'log', 'add', '--aspect', RULE, '--status', 'enforced', '--evidence', 'e', '--reason', 'r'],
        dir,
      );
      expect(unseen.status).toBe(0);
      expect(readFileSync(logPath(dir), 'utf-8')).toContain('Status: an unrecorded standing → enforced');
      rmSync(logPath(dir));

      // From here on the tool has a memory of where every rule stood.
      setStatus(dir, 'advisory');
      approve(dir);
      setStatus(dir, 'enforced');
      const recorded = run(
        [
          'aspects', 'log', 'add', '--aspect', RULE,
          '--status', 'enforced',
          '--evidence', 'two waves clean, no new violations',
          '--by', 'the architect',
          '--reason', 'Promoted after it ran advisory for a month without a false alarm.',
        ],
        dir,
      );
      expect(recorded.status).toBe(0);

      const doc = JSON.parse(run(['aspects', 'log', 'read', '--aspect', RULE, '--json'], dir).stdout) as LogDoc;
      expect(doc.schema).toBe('yg-aspect-log/1');
      expect(doc.status).toBe('enforced');
      expect(doc.entries[0].status).toEqual({ from: 'advisory', to: 'enforced' });
      expect(doc.entries[0].body).toContain('decided by the architect');
      expect(doc.entries[0].body).toContain('two waves clean, no new violations');
      expect(doc.entries[0].body).toContain('Promoted after it ran advisory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: recording a standing the rule does not carry, or one with no evidence, is refused', () => {
    const dir = project('refuse');
    try {
      // The rule still stands at advisory: this record would be a claim about a
      // change nobody made.
      const notThere = run(
        ['aspects', 'log', 'add', '--aspect', RULE, '--status', 'enforced', '--evidence', 'x', '--reason', 'y'],
        dir,
      );
      expect(notThere.status).toBe(1);
      expect(notThere.stderr).toContain('stands at advisory, not enforced');
      expect(notThere.stderr).toContain('records a change; it does not make one');

      // The standing is right, but what justified it is the part nobody can
      // reconstruct later.
      const noEvidence = run(
        ['aspects', 'log', 'add', '--aspect', RULE, '--status', 'advisory', '--reason', 'y'],
        dir,
      );
      expect(noEvidence.status).toBe(1);
      expect(noEvidence.stderr).toContain('no evidence');

      const notAStanding = run(
        ['aspects', 'log', 'add', '--aspect', RULE, '--status', 'important', '--evidence', 'x', '--reason', 'y'],
        dir,
      );
      expect(notAStanding.status).toBe(1);
      expect(notAStanding.stderr).toContain('not a standing a rule can have');

      // Not one of them wrote anything.
      expect(existsSync(logPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: a standing changed by hand is reported, then written into the rule\'s history exactly once', () => {
    const dir = project('noticed');
    try {
      // The first approving run only remembers where every rule stands; there is
      // no change to narrate, so nothing is written to any rule's log.
      expect(approve(dir).all).not.toContain('written into its own log');
      expect(existsSync(logPath(dir))).toBe(false);

      setStatus(dir, 'enforced');

      // A read-only run says so and writes nothing — the promise plain `yg check`
      // makes is that it changes nothing at all.
      const noticed = run(['check'], dir);
      expect(noticed.all).toContain('aspect-status-changed-outside-cli');
      expect(noticed.all).toContain('now stands at enforced');
      expect(existsSync(logPath(dir))).toBe(false);

      // The approving run records it, in the rule's own log.
      const recorded = approve(dir);
      expect(recorded.all).toContain(`Rule '${RULE}' now stands at enforced (was advisory)`);
      const log = readFileSync(logPath(dir), 'utf-8');
      expect(log).toContain('Status: advisory → enforced, changed outside the CLI');

      // And never again: not in the log, not in the report.
      expect(approve(dir).all).not.toContain('written into its own log');
      expect(readFileSync(logPath(dir), 'utf-8').match(/^## \[/gm)).toHaveLength(1);
      expect(run(['check'], dir).all).not.toContain('aspect-status-changed-outside-cli');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: a change the caller recorded themselves is not written down a second time', () => {
    const dir = project('norepeat');
    try {
      approve(dir);
      setStatus(dir, 'draft');
      run(
        ['aspects', 'log', 'add', '--aspect', RULE, '--status', 'draft', '--evidence', 'it is being rewritten', '--reason', 'Parked while the rule is rewritten.'],
        dir,
      );

      const after = approve(dir);
      expect(after.all).not.toContain('written into its own log');
      expect(readFileSync(logPath(dir), 'utf-8').match(/^## \[/gm)).toHaveLength(1);
      expect(readFileSync(logPath(dir), 'utf-8')).not.toContain('changed outside the CLI');
      // And the report is clear: the standing and the record agree.
      expect(run(['check'], dir).all).not.toContain('aspect-status-changed-outside-cli');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: the rule inventory carries the last entry and what it said, so a reader opens no files', () => {
    const dir = project('document');
    try {
      approve(dir);
      setStatus(dir, 'enforced');
      run(
        ['aspects', 'log', 'add', '--aspect', RULE, '--status', 'enforced', '--evidence', 'a month advisory, no false alarms', '--reason', 'Promoted.'],
        dir,
      );

      const doc = JSON.parse(run(['aspects', '--json'], dir).stdout) as {
        aspects: Array<{ id: string; status: string; log: { at: string | null; statusChange: { from: string; to: string } | null } }>;
      };
      const promoted = doc.aspects.find((a) => a.id === RULE);
      expect(promoted?.status).toBe('enforced');
      expect(promoted?.log.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(promoted?.log.statusChange).toEqual({ from: 'advisory', to: 'enforced' });

      // A rule nothing has been recorded about says exactly that, rather than
      // borrowing another rule's history.
      const untouched = doc.aspects.find((a) => a.id === 'no-todo-comments');
      expect(untouched?.log).toEqual({ at: null, statusChange: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
