// =============================================================================
// CLI E2E — a node type's decision log: `yg log add|read|merge-resolve --type`.
//
// A type keeps a log of its own for explicit decisions about every node of the
// type. It is held to what a node's log is held to, and these scenarios pin it:
//
//   1. add/read   → the entry lands in .yggdrasil/types/<type>/log.md, its
//                   baseline in the committed yg-lock.types.json, and reads back as a
//                   yg-type-log/1 document
//   2. in force   → a replaced decision leaves the default read; --all shows it,
//                   marked
//   3. refusals   → an unknown type, and a command naming no log or two
//   4. integrity  → a rewritten history is reported by yg check with the log
//                   file as its identity, and a further add is refused
//   5. format     → a log that does not parse is reported
//   6. orphaned   → a log whose type the architecture no longer defines is a
//                   warning
//   7. merge      → two branches' decisions conflict in git; merge-resolve
//                   writes the union and yg check is clean
//   8. no verdict → adding a type or a node log entry changes no pair hash: a
//                   recorded project stays fully verified
//  10. competing  → two branches superseding the same decision is reported by
//                   merge-resolve as a conflict, and one entry settles it
//  11. all at once → a merge where two decisions were each superseded on both
//                   sides names both clashes in one report, each with its own
//                   settling command
//   9. the guard  → with decisions in force on the type or a type above it, an
//                   add that says neither --supersedes nor --adds is refused,
//                   and the decisions in force are listed for the writer
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture, FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';
import { errorCodes, expectErrorCode, expectIssue, expectNoIssue, parseJson, type OutputIssue } from '../support/assert-output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const TYPE = 'service';
const LOG_REL = `.yggdrasil/types/${TYPE}/log.md`;
const UNIT = `file:${LOG_REL}`;

interface Run { stdout: string; stderr: string; status: number | null; all: string }

function yg(dir: string, args: string[]): Run {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/**
 * The fixture with its one reviewer rule removed, so every pair is a script
 * pair: a recording run is free and needs no reviewer.
 */
function project(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-typelog-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  writeFileSync(arch, readFileSync(arch, 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'), 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), FIXTURE_RM_OPTIONS);
  return dir;
}

interface TypeLogDoc {
  schema: string;
  type: string;
  inForceOnly: boolean;
  entries: Array<{ datetime: string; body: string; supersedes?: string[]; supersededBy?: string }>;
}

function readType(dir: string, all = false): TypeLogDoc {
  return parseJson<TypeLogDoc>(yg(dir, ['log', 'read', '--type', TYPE, '--json', ...(all ? ['--all'] : [])]).stdout);
}

/** A type decision that says what it does to those in force: replaces one, or (by default) adds beside them. */
function addType(dir: string, reason: string, supersedes?: string): Run {
  return yg(dir, ['log', 'add', '--type', TYPE, '--reason', reason, ...(supersedes !== undefined ? ['--supersedes', supersedes] : ['--adds'])]);
}

function checkDoc(dir: string): { issues: OutputIssue[] } {
  return parseJson<{ issues: OutputIssue[] }>(yg(dir, ['check', '--json']).stdout);
}

const logsLock = (dir: string): { types?: Record<string, { log?: { last_entry_datetime: string } }> } =>
  JSON.parse(readFileSync(path.join(dir, '.yggdrasil', 'yg-lock.types.json'), 'utf-8'));

describe.skipIf(!distExists)('CLI E2E — a node type keeps a decision log', () => {
  it('1: an entry lands beside the type, its baseline in the logs lock, and reads back as yg-type-log/1', () => {
    const dir = project('add');
    try {
      const added = addType(dir, 'Every service validates its input at the boundary, not in the handler.');
      expect(added.status, added.all).toBe(0);
      expect(existsSync(path.join(dir, LOG_REL))).toBe(true);

      const doc = readType(dir);
      expect(doc.schema).toBe('yg-type-log/1');
      expect(doc.type).toBe(TYPE);
      expect(doc.inForceOnly).toBe(true);
      expect(doc.entries).toHaveLength(1);
      expect(logsLock(dir).types?.[TYPE]?.log?.last_entry_datetime).toBe(doc.entries[0].datetime);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('2: a replaced decision leaves the default read; --all shows it, marked', () => {
    const dir = project('in-force');
    try {
      expect(addType(dir, 'Services talk to each other over HTTP.').status).toBe(0);
      const [first] = readType(dir).entries;
      expect(addType(dir, 'Services talk to each other over the queue.', first.datetime).status).toBe(0);
      expect(addType(dir, 'Every service owns its own table.').status).toBe(0);

      const inForce = readType(dir);
      expect(inForce.entries).toHaveLength(2);
      expect(inForce.entries.map((e) => e.datetime)).not.toContain(first.datetime);

      const all = readType(dir, true);
      expect(all.inForceOnly).toBe(false);
      expect(all.entries).toHaveLength(3);
      const replaced = all.entries.find((e) => e.datetime === first.datetime);
      expect(replaced?.supersededBy).toBe(all.entries[1].datetime);

      const refused = addType(dir, 'Again.', first.datetime);
      expectErrorCode(refused.all, 'log-supersedes-superseded');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('3: an unknown type, and a command naming no log or two, are refused by code', () => {
    const dir = project('refusals');
    try {
      const unknown = yg(dir, ['log', 'add', '--type', 'no-such-type', '--reason', 'x']);
      expect(unknown.status).toBe(1);
      expectErrorCode(unknown.all, 'type-not-found');
      expectErrorCode(yg(dir, ['log', 'read', '--type', 'no-such-type']).all, 'type-not-found');
      expectErrorCode(yg(dir, ['log', 'add', '--reason', 'x']).all, 'usage');
      expectErrorCode(yg(dir, ['log', 'read', '--node', 'services/orders', '--type', TYPE]).all, 'usage');
      expectErrorCode(yg(dir, ['log', 'read', '--type', TYPE, '--with-verdicts']).all, 'usage');
      expect(existsSync(path.join(dir, '.yggdrasil', 'types'))).toBe(false);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('4: a rewritten history is reported with the log as its identity, and a further add is refused', () => {
    const dir = project('integrity');
    try {
      expect(addType(dir, 'Retries are the caller\'s job.').status).toBe(0);
      expect(addType(dir, 'Timeouts are 5 s.').status).toBe(0);
      expectNoIssue(checkDoc(dir), { code: 'log-integrity' });

      const file = path.join(dir, LOG_REL);
      writeFileSync(file, readFileSync(file, 'utf-8').replace('5 s', '50 s'), 'utf-8');

      expectIssue(checkDoc(dir), { code: 'log-integrity', unit: UNIT });
      const refused = addType(dir, 'A third decision.');
      expect(refused.status).toBe(1);
      expectErrorCode(refused.all, 'log-integrity');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('5: a type log that does not parse is reported as log-format', () => {
    const dir = project('format');
    try {
      mkdirSync(path.join(dir, '.yggdrasil', 'types', TYPE), { recursive: true });
      writeFileSync(path.join(dir, LOG_REL), 'no header here\n', 'utf-8');
      expectIssue(checkDoc(dir), { code: 'log-format', unit: UNIT });
      expectErrorCode(yg(dir, ['log', 'read', '--type', TYPE]).all, 'log-format');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('6: a log whose type the architecture no longer defines is an orphaned-log warning', () => {
    const dir = project('orphan');
    try {
      mkdirSync(path.join(dir, '.yggdrasil', 'types', 'ghost'), { recursive: true });
      writeFileSync(path.join(dir, '.yggdrasil', 'types', 'ghost', 'log.md'), '## [2026-01-01T00:00:00.000Z]\nA decision about a type that was renamed.\n', 'utf-8');
      const issue = expectIssue(checkDoc(dir), { code: 'type-log-orphaned', unit: 'file:.yggdrasil/types/ghost/log.md' });
      expect(issue.severity).toBe('warning');
      // A type log of a type that exists is not orphaned.
      expect(addType(dir, 'A live decision.').status).toBe(0);
      expectNoIssue(checkDoc(dir), { code: 'type-log-orphaned', unit: UNIT });
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('7: two branches\' decisions conflict in git; merge-resolve --type writes the union and the check is clean', () => {
    const dir = project('merge');
    const git = (args: string[]): void => { runGitFixture(dir, args); };
    try {
      git(['init', '-q', '-b', 'main']);
      expect(addType(dir, 'The shared decision.').status).toBe(0);
      git(['add', '-A']); git(['commit', '-q', '-m', 'base']);
      git(['checkout', '-q', '-b', 'b']);
      expect(addType(dir, 'Side b decided this.').status).toBe(0);
      git(['add', '-A']); git(['commit', '-q', '-m', 'b']);
      git(['checkout', '-q', 'main']);
      expect(addType(dir, 'Side a decided that.').status).toBe(0);
      git(['add', '-A']); git(['commit', '-q', '-m', 'a']);

      runGitFixture(dir, ['merge', 'b']);
      expect(readFileSync(path.join(dir, LOG_REL), 'utf-8')).toMatch(/^<<<<<<< /m);
      runGitFixture(dir, ['checkout', '--ours', '--', '.yggdrasil/yg-lock.types.json']);
      expectIssue(checkDoc(dir), { code: 'log-conflict', unit: UNIT });

      const resolved = yg(dir, ['log', 'merge-resolve', '--type', TYPE]);
      expect(resolved.status, resolved.all).toBe(0);
      // The step names the file a type's baseline is written to, not the node logs file.
      expect(resolved.all).toContain('.yggdrasil/yg-lock.types.json');
      expect(resolved.all).not.toContain('yg-lock.logs.json');
      const entries = readType(dir).entries;
      expect(entries).toHaveLength(3);
      expect(errorCodes(yg(dir, ['check']).stdout)).not.toContain('log-conflict');
      const doc = checkDoc(dir);
      expectNoIssue(doc, { code: 'log-integrity' });
      expectNoIssue(doc, { code: 'log-conflict' });
      expect(logsLock(dir).types?.[TYPE]?.log?.last_entry_datetime).toBe(entries[0].datetime);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60_000);

  it('8: a type or a node log entry changes no pair hash — a recorded project stays fully verified', () => {
    const dir = project('no-verdict');
    try {
      const recorded = yg(dir, ['check', '--approve', '--only-deterministic']);
      expect(recorded.status, recorded.all).toBe(0);
      const lockFiles = ['yg-lock.nondeterministic.json', '.yg-lock.deterministic.json'].map((f) => path.join(dir, '.yggdrasil', f));
      const before = lockFiles.map((f) => (existsSync(f) ? readFileSync(f, 'utf-8') : ''));
      expect(yg(dir, ['check']).status).toBe(0);

      expect(addType(dir, 'A decision about every service.').status).toBe(0);
      expect(yg(dir, ['log', 'add', '--node', 'services/orders', '--reason', 'Why orders is the way it is.']).status).toBe(0);

      const after = yg(dir, ['check']);
      expect(after.status, after.all).toBe(0);
      expectNoIssue(checkDoc(dir), { code: 'unverified' });
      // A recording run afterwards has nothing to fill and rewrites no verdict.
      expect(yg(dir, ['check', '--approve', '--only-deterministic']).status).toBe(0);
      expect(lockFiles.map((f) => (existsSync(f) ? readFileSync(f, 'utf-8') : ''))).toEqual(before);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60_000);

  it('9: with decisions in force, an add that neither replaces nor adds is refused and the decisions are listed', () => {
    const dir = project('guard');
    try {
      expect(yg(dir, ['log', 'add', '--type', TYPE, '--reason', 'The first decision needs no choice.']).status).toBe(0);
      const [first] = readType(dir).entries;
      const before = readFileSync(path.join(dir, LOG_REL), 'utf-8');

      const refused = yg(dir, ['log', 'add', '--type', TYPE, '--reason', 'A second decision, written blind.']);
      expect(refused.status).toBe(1);
      expectErrorCode(refused.all, 'type-log-choice-missing');
      expect(refused.stdout).toContain(`[${first.datetime}]`);
      expect(readFileSync(path.join(dir, LOG_REL), 'utf-8')).toBe(before);

      // A decision on a type above counts too: the service type sits under module.
      expect(yg(dir, ['log', 'add', '--type', 'module', '--reason', 'Modules decide for their services.']).status).toBe(0);
      const moduleOnly = project('guard-ancestor');
      try {
        expect(yg(moduleOnly, ['log', 'add', '--type', 'module', '--reason', 'A module-wide decision.']).status).toBe(0);
        expectErrorCode(yg(moduleOnly, ['log', 'add', '--type', TYPE, '--reason', 'Blind to the module.']).all, 'type-log-choice-missing');
        expect(yg(moduleOnly, ['log', 'add', '--type', TYPE, '--reason', 'Adds beside it.', '--adds']).status).toBe(0);
      } finally {
        rmSync(moduleOnly, FIXTURE_RM_OPTIONS);
      }

      expectErrorCode(yg(dir, ['log', 'add', '--type', TYPE, '--reason', 'x', '--adds', '--supersedes', first.datetime]).all, 'usage');
      expectErrorCode(yg(dir, ['log', 'add', '--node', 'services/orders', '--reason', 'x', '--adds']).all, 'usage');
      const replaced = yg(dir, ['log', 'add', '--type', TYPE, '--reason', 'Replaces the first.', '--supersedes', first.datetime]);
      expect(replaced.status, replaced.all).toBe(0);
      expect(replaced.stdout).toContain(`[${first.datetime}]`);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  });

  it('10: two branches superseding the same decision is a conflict merge-resolve reports; one entry superseding both settles it', () => {
    const dir = project('merge-supersede');
    const git = (args: string[]): void => { runGitFixture(dir, args); };
    try {
      git(['init', '-q', '-b', 'main']);
      expect(addType(dir, 'Services talk over HTTP.').status).toBe(0);
      const [base] = readType(dir).entries;
      git(['add', '-A']); git(['commit', '-q', '-m', 'base']);
      git(['checkout', '-q', '-b', 'b']);
      expect(addType(dir, 'Side b: services talk over the queue.', base.datetime).status).toBe(0);
      git(['add', '-A']); git(['commit', '-q', '-m', 'b']);
      git(['checkout', '-q', 'main']);
      expect(addType(dir, 'Side a: services talk over gRPC.', base.datetime).status).toBe(0);
      git(['add', '-A']); git(['commit', '-q', '-m', 'a']);
      runGitFixture(dir, ['merge', 'b']);
      runGitFixture(dir, ['checkout', '--ours', '--', '.yggdrasil/yg-lock.types.json']);

      const resolved = yg(dir, ['log', 'merge-resolve', '--type', TYPE]);
      expect(resolved.status).toBe(1);
      expectErrorCode(resolved.all, 'log-merge-supersedes-conflict');
      // Nothing was dropped: both successors are in the merged log, and the log verifies.
      const all = readType(dir, true).entries;
      expect(all).toHaveLength(3);
      const successors = all.filter((e) => e.supersedes?.includes(base.datetime)).map((e) => e.datetime);
      expect(successors).toHaveLength(2);
      expectNoIssue(checkDoc(dir), { code: 'log-integrity' });

      git(['add', '-A']); git(['commit', '-q', '--no-edit']);
      const settled = yg(dir, ['log', 'add', '--type', TYPE, '--reason', 'The queue holds; gRPC was an experiment.', ...successors.flatMap((s) => ['--supersedes', s])]);
      expect(settled.status, settled.all).toBe(0);
      expect(readType(dir).entries).toHaveLength(1);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60_000);
  it('11: a merge that clashes on two decisions names both at once, each with its own settling command', () => {
    const dir = project('merge-supersede-two');
    const git = (args: string[]): void => { runGitFixture(dir, args); };
    try {
      git(['init', '-q', '-b', 'main']);
      expect(addType(dir, 'Services talk over HTTP.').status).toBe(0);
      expect(addType(dir, 'Services log in plain text.').status).toBe(0);
      const [talk, logs] = readType(dir).entries;
      git(['add', '-A']); git(['commit', '-q', '-m', 'base']);
      git(['checkout', '-q', '-b', 'b']);
      expect(addType(dir, 'Side b: services talk over the queue.', talk.datetime).status).toBe(0);
      expect(addType(dir, 'Side b: services log JSON.', logs.datetime).status).toBe(0);
      git(['add', '-A']); git(['commit', '-q', '-m', 'b']);
      git(['checkout', '-q', 'main']);
      expect(addType(dir, 'Side a: services talk over gRPC.', talk.datetime).status).toBe(0);
      expect(addType(dir, 'Side a: services log through OpenTelemetry.', logs.datetime).status).toBe(0);
      git(['add', '-A']); git(['commit', '-q', '-m', 'a']);
      runGitFixture(dir, ['merge', 'b']);
      runGitFixture(dir, ['checkout', '--ours', '--', '.yggdrasil/yg-lock.types.json']);

      const resolved = yg(dir, ['log', 'merge-resolve', '--type', TYPE]);
      expect(resolved.status).toBe(1);
      expectErrorCode(resolved.all, 'log-merge-supersedes-conflict');
      // Both clashes in one report: each replaced entry is named, and each gets its own settling command.
      expect(resolved.all).toContain(talk.datetime);
      expect(resolved.all).toContain(logs.datetime);
      expect(resolved.all.match(/yg log add --type service/g)).toHaveLength(2);
      expect(resolved.all.match(/--supersedes /g)).toHaveLength(4);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60_000);
});
