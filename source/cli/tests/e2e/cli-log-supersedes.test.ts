// =============================================================================
// CLI E2E — `yg log add --supersedes`: an entry that replaces an earlier one.
//
// A log is append-only, so a decision that no longer holds cannot be edited
// out. An entry can instead name the earlier entry it replaces. These scenarios
// pin what that promises:
//
//   1. both entries stay in the file; the new one names the old, and the old
//      reads as replaced — in --json and in the text view;
//   2. a reference to an entry the log does not hold is refused, and nothing is
//      written;
//   3. an entry already replaced cannot be replaced again — the error names the
//      entry that replaced it;
//   4. an entry written by hand in the documented `### Supersedes:` shape reads
//      exactly like one the flag wrote.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectErrorCode, parseJson } from '../support/assert-output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const NODE = 'services/orders';

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

function project(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-supersedes-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

interface LogDoc {
  schema: string;
  node: string;
  entries: Array<{ datetime: string; body: string; supersedes?: string[]; supersededBy?: string }>;
}

function readDoc(dir: string): LogDoc {
  return parseJson<LogDoc>(run(['log', 'read', '--node', NODE, '--all', '--json'], dir).stdout);
}

function add(dir: string, reason: string, supersedes: string[] = []): ReturnType<typeof run> {
  return run(['log', 'add', '--node', NODE, '--reason', reason, ...supersedes.flatMap((s) => ['--supersedes', s])], dir);
}

const logFile = (dir: string): string => path.join(dir, '.yggdrasil', 'model', NODE, 'log.md');

describe.skipIf(!distExists)('CLI E2E — yg log add --supersedes', () => {
  it('1: both entries stay; the new one names the old, the old reads as replaced', () => {
    const dir = project('replace');
    try {
      expect(add(dir, 'Orders are kept for 30 days.').status).toBe(0);
      const [first] = readDoc(dir).entries;

      const replaced = add(dir, 'Orders are kept for 90 days: the auditors asked for a quarter.', [first.datetime]);
      expect(replaced.status, replaced.all).toBe(0);

      const doc = readDoc(dir);
      expect(doc.schema).toBe('yg-log/1');
      expect(doc.entries).toHaveLength(2);
      const [newest, oldest] = doc.entries;
      expect(newest.supersedes).toEqual([first.datetime]);
      expect(newest.supersededBy).toBeUndefined();
      expect(oldest.datetime).toBe(first.datetime);
      expect(oldest.supersededBy).toBe(newest.datetime);
      expect(oldest.supersedes).toBeUndefined();

      // The reference lives in the entry's own text, so the file alone says it.
      expect(newest.body.split('\n')[0]).toBe(`### Supersedes: ${first.datetime}`);
      expect(readFileSync(logFile(dir), 'utf-8').match(/^## \[/gm)).toHaveLength(2);

      const text = run(['log', 'read', '--node', NODE, '--all'], dir);
      expect(text.stdout).toContain(`## [${first.datetime}] — superseded by ${newest.datetime}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: a reference to an entry the log does not hold is refused and nothing is written', () => {
    const dir = project('unknown');
    try {
      expect(add(dir, 'The only entry.').status).toBe(0);
      const before = readFileSync(logFile(dir), 'utf-8');

      const refused = add(dir, 'Replaces nothing real.', ['2001-01-01T00:00:00.000Z']);
      expect(refused.status).toBe(1);
      expectErrorCode(refused.all, 'log-supersedes-unknown');
      expect(readFileSync(logFile(dir), 'utf-8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: an entry already replaced cannot be replaced again; the error names its successor', () => {
    const dir = project('twice');
    try {
      expect(add(dir, 'First decision.').status).toBe(0);
      const [first] = readDoc(dir).entries;
      expect(add(dir, 'Second decision.', [first.datetime]).status).toBe(0);
      const [second] = readDoc(dir).entries;
      const before = readFileSync(logFile(dir), 'utf-8');

      const refused = add(dir, 'Third decision.', [first.datetime]);
      expect(refused.status).toBe(1);
      expectErrorCode(refused.all, 'log-supersedes-superseded');
      expect(refused.all).toContain(`--supersedes ${second.datetime}`);
      expect(readFileSync(logFile(dir), 'utf-8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: an entry written in the documented `### Supersedes:` shape reads like one the flag wrote', () => {
    const dir = project('by-hand');
    try {
      expect(add(dir, 'The original decision.').status).toBe(0);
      const [first] = readDoc(dir).entries;
      expect(add(dir, `### Supersedes: ${first.datetime}\nThe earlier decision no longer holds.`).status).toBe(0);

      const [newest, oldest] = readDoc(dir).entries;
      expect(newest.supersedes).toEqual([first.datetime]);
      expect(oldest.supersededBy).toBe(newest.datetime);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
