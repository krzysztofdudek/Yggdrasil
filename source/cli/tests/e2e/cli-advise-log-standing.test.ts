// =============================================================================
// CLI E2E — `yg advise` on the decisions the logs hold in force.
//
// Two attention items, both about decisions that are in force but should not be
// left as they are, and both advice only (advise exits 0, and yg check is not
// touched by either):
//
//   1. competing   → an entry replaced by two entries that are both in force —
//                    in a type's log after a real two-branch merge, and in a
//                    node's and a rule's log — is a log-supersedes-conflict item
//                    naming the settling command; one entry superseding both
//                    successors makes it go away
//   2. count       → a type whose nodes read more than 7 decisions in force
//                    (its own and the types above it) is a type-decision-budget
//                    item; 7 short ones are not, and a replaced decision does
//                    not count
//   3. tokens      → two decisions long enough to pass ~2,000 tokens are an item
//                    although the count is low
//   4. one report  → a type with no decisions of its own is not reported again
//                    for what it reads from the type above it
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture, FIXTURE_RM_OPTIONS } from '../support/git-fixture.js';
import { parseJson } from '../support/assert-output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const TYPE = 'service';
const PARENT = 'module';

interface Run { stdout: string; stderr: string; status: number | null; all: string }

function yg(dir: string, args: string[]): Run {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** The fixture with its one reviewer rule removed, so nothing here ever needs a reviewer. */
function project(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-advise-logs-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  writeFileSync(arch, readFileSync(arch, 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'), 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), FIXTURE_RM_OPTIONS);
  return dir;
}

interface AdviseItem { id: string; what: string; why: string; next: string }

function advise(dir: string): AdviseItem[] {
  const run = yg(dir, ['advise', '--json']);
  expect(run.status, run.all).toBe(0);
  return parseJson<{ items: AdviseItem[] }>(run.stdout).items;
}

const ofClass = (items: AdviseItem[], cls: string): AdviseItem[] => items.filter((i) => i.id.startsWith(`${cls}:`));

/** Add one decision to a type's log beside those in force (or replacing one). */
function addType(dir: string, typeId: string, reason: string, supersedes?: string): void {
  const run = yg(dir, ['log', 'add', '--type', typeId, '--reason', reason, ...(supersedes !== undefined ? ['--supersedes', supersedes] : ['--adds'])]);
  expect(run.status, run.all).toBe(0);
}

function typeEntries(dir: string, typeId: string): Array<{ datetime: string }> {
  return parseJson<{ entries: Array<{ datetime: string }> }>(yg(dir, ['log', 'read', '--type', typeId, '--json']).stdout).entries;
}

/**
 * Append an entry by hand that replaces `target` — what the other branch of a
 * merge leaves behind. `yg log add` itself refuses to replace an entry twice.
 */
function appendRival(file: string, datetime: string, target: string, text: string): void {
  appendFileSync(file, `## [${datetime}]\n### Supersedes: ${target}\n\n${text}\n`, 'utf-8');
}

/** The datetime of the last `## [...]` header in a log file. */
function lastDatetime(file: string): string {
  const all = [...readFileSync(file, 'utf-8').matchAll(/^## \[([^\]]+)\]$/gm)];
  return all[all.length - 1][1];
}

describe.skipIf(!distExists)('CLI E2E — yg advise on the decisions the logs hold in force', () => {
  it('1a: two branches superseding one type decision stay an advise item after the merge, until one entry settles it', () => {
    const dir = project('merge');
    const git = (args: string[]): void => { runGitFixture(dir, args); };
    try {
      git(['init', '-q', '-b', 'main']);
      addType(dir, TYPE, 'Services talk over HTTP.');
      const [base] = typeEntries(dir, TYPE);
      git(['add', '-A']); git(['commit', '-q', '-m', 'base']);
      git(['checkout', '-q', '-b', 'b']);
      addType(dir, TYPE, 'Side b: services talk over the queue.', base.datetime);
      git(['add', '-A']); git(['commit', '-q', '-m', 'b']);
      git(['checkout', '-q', 'main']);
      addType(dir, TYPE, 'Side a: services talk over gRPC.', base.datetime);
      git(['add', '-A']); git(['commit', '-q', '-m', 'a']);
      runGitFixture(dir, ['merge', 'b']);
      runGitFixture(dir, ['checkout', '--ours', '--', '.yggdrasil/yg-lock.types.json']);

      const resolved = yg(dir, ['log', 'merge-resolve', '--type', TYPE]);
      expect(resolved.status).toBe(1);
      expect(resolved.all).toContain('log-merge-supersedes-conflict');
      git(['add', '-A']); git(['commit', '-q', '--no-edit']);

      // The merge is committed and merge-resolve said its piece once; the feed keeps saying it.
      const [item, ...rest] = ofClass(advise(dir), 'log-supersedes-conflict');
      expect(rest).toEqual([]);
      expect(item.id).toBe(`log-supersedes-conflict:.yggdrasil/types/${TYPE}/log.md@${base.datetime}`);
      expect(item.what).toContain(base.datetime);
      const successors = typeEntries(dir, TYPE).map((e) => e.datetime);
      expect(successors).toHaveLength(2);
      for (const s of successors) expect(item.next).toContain(`--supersedes ${s}`);
      expect(item.next).toContain(`yg log add --type ${TYPE}`);

      // --adds is not a settlement: both successors are still in force.
      addType(dir, TYPE, 'Every service owns its own table.');
      expect(ofClass(advise(dir), 'log-supersedes-conflict')).toHaveLength(1);
      const settled = yg(dir, ['log', 'add', '--type', TYPE, '--reason', 'The queue holds; gRPC was an experiment.', ...successors.flatMap((s) => ['--supersedes', s])]);
      expect(settled.status, settled.all).toBe(0);
      expect(ofClass(advise(dir), 'log-supersedes-conflict')).toEqual([]);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60_000);

  it("1b: the same clash in a node's log and in a rule's log is reported, each with its own settling command", () => {
    const dir = project('node-rule');
    try {
      const nodeLog = path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'log.md');
      expect(yg(dir, ['log', 'add', '--node', 'services/orders', '--reason', 'Orders are kept for seven years.']).status).toBe(0);
      const nodeBase = lastDatetime(nodeLog);
      expect(yg(dir, ['log', 'add', '--node', 'services/orders', '--reason', 'Orders are kept for ten years.', '--supersedes', nodeBase]).status).toBe(0);
      appendRival(nodeLog, '2099-01-01T00:00:00.000Z', nodeBase, 'Orders are kept for five years.');

      const ruleLog = path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'log.md');
      expect(yg(dir, ['log', 'add', '--aspect', 'no-todo-comments', '--reason', 'TODO markers are refused everywhere.']).status).toBe(0);
      const ruleBase = lastDatetime(ruleLog);
      expect(yg(dir, ['log', 'add', '--aspect', 'no-todo-comments', '--reason', 'Tests may keep TODO markers.', '--supersedes', ruleBase]).status).toBe(0);
      appendRival(ruleLog, '2099-01-01T00:00:00.000Z', ruleBase, 'Scripts may keep TODO markers.');

      const items = ofClass(advise(dir), 'log-supersedes-conflict');
      expect(items.map((i) => i.id).sort()).toEqual([
        `log-supersedes-conflict:.yggdrasil/aspects/no-todo-comments/log.md@${ruleBase}`,
        `log-supersedes-conflict:.yggdrasil/model/services/orders/log.md@${nodeBase}`,
      ]);
      expect(items.find((i) => i.id.includes('/model/'))?.next).toContain('yg log add --node services/orders');
      expect(items.find((i) => i.id.includes('/aspects/'))?.next).toContain('yg log add --aspect no-todo-comments');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60_000);

  it('2: more than 7 decisions in force for a type\'s nodes is an item; 7 is not, and a replaced one does not count', () => {
    const dir = project('count');
    try {
      addType(dir, PARENT, 'Modules own their data.');
      for (let i = 1; i <= 6; i++) addType(dir, TYPE, `Service decision number ${i}.`);
      // 1 on the module + 6 on the service = 7: at the line, not past it.
      expect(ofClass(advise(dir), 'type-decision-budget')).toEqual([]);

      addType(dir, TYPE, 'Service decision number 7.');
      const [item, ...rest] = ofClass(advise(dir), 'type-decision-budget');
      expect(rest).toEqual([]);
      expect(item.id).toBe(`type-decision-budget:${TYPE}`);
      expect(item.what).toContain('reads 8 decisions in force');
      expect(item.why).toContain(`'${TYPE}' 7`);
      expect(item.why).toContain(`'${PARENT}' 1`);
      expect(item.why).toContain('more than 7 decisions');
      expect(item.next).toContain(`yg log read --type ${TYPE}`);

      // Folding two decisions into one takes the count back to 7.
      const [d1, d2] = typeEntries(dir, TYPE);
      const folded = yg(dir, ['log', 'add', '--type', TYPE, '--reason', 'Service decisions 1 and 2, as one.', '--supersedes', d1.datetime, '--supersedes', d2.datetime]);
      expect(folded.status, folded.all).toBe(0);
      expect(ofClass(advise(dir), 'type-decision-budget')).toEqual([]);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 120_000);

  it('3: a short list of long decisions past ~2,000 tokens is an item', () => {
    const dir = project('tokens');
    try {
      const long = (n: number): string => `Decision ${n}: ${'Every service keeps its retry policy beside its client, not in shared code. '.repeat(55)}`;
      addType(dir, TYPE, long(1));
      expect(ofClass(advise(dir), 'type-decision-budget')).toEqual([]);
      addType(dir, TYPE, long(2));
      const [item] = ofClass(advise(dir), 'type-decision-budget');
      expect(item?.what).toContain('reads 2 decisions in force');
      expect(item.why).toContain('more than ~2000 tokens');
      expect(item.why).not.toContain('more than 7 decisions');
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60_000);

  it('4: a type with no decisions of its own is not reported again for what it reads from above', () => {
    const dir = project('one-report');
    try {
      for (let i = 1; i <= 8; i++) addType(dir, PARENT, `Module decision number ${i}.`);
      const items = ofClass(advise(dir), 'type-decision-budget');
      expect(items.map((i) => i.id)).toEqual([`type-decision-budget:${PARENT}`]);
    } finally {
      rmSync(dir, FIXTURE_RM_OPTIONS);
    }
  }, 60_000);
});
