import { describe, it, expect } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitFixtureEnv } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// NOTE on hermeticity: every scenario in this file is LLM-independent. The
// mandatory-log and fill-pass cases run on `deterministicFixture` (the LLM
// aspect `has-doc-comment` is stripped, so `yg check --approve` records only
// deterministic verdicts and never contacts a reviewer endpoint). The heading,
// read, and merge-resolve cases never invoke the reviewer at all. No network
// host or port is contacted by any test here, so no dead-endpoint override is
// required.
//
// MODEL — `yg approve` / `.drift-state/` are GONE. Verification happens via
// `yg check --approve` (fill); state lives in `.yggdrasil/yg-lock.json`. The
// mandatory-log gate now fires at fill time (code `log-entry-missing`, written
// to stdout): a node whose type has `log_required: true` and whose source
// fingerprint changed but has no fresh log entry has its pairs skipped and the
// run stays red. Append-only integrity (`log-integrity`) and format
// (`log-format`) surface at plain `yg check` time (pure reads, unchanged).

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-logint-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Copy the fixture and strip the LLM aspect (`has-doc-comment`) so the node's
 * effective aspects are purely deterministic. This makes the fill lifecycle
 * hermetic: no network, no LLM verdict, fully reproducible.
 */
function deterministicFixture(label: string): string {
  const dir = copyFixture(label);
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const arch = readFileSync(archPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '- has-doc-comment')
    .join('\n');
  writeFileSync(archPath, arch, 'utf-8');
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), {
    recursive: true,
    force: true,
  });
  return dir;
}

/**
 * Flip the `service` node type's `log_required` from false (fixture default) to
 * true, so the mandatory-log gate engages on a source change. Only the service
 * block carries `log_required: false` after its description line; the module
 * block's flag is left untouched.
 */
function enableServiceLogRequired(dir: string): void {
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  const lines = readFileSync(archPath, 'utf-8').split('\n');
  let inService = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('  service:')) {
      inService = true;
      continue;
    }
    // A new top-level node-type block (two-space indent, ends with ':') closes
    // the service block.
    if (inService && /^ {2}\S.*:\s*$/.test(lines[i]) && !lines[i].startsWith('  service:')) {
      inService = false;
    }
    if (inService && lines[i].trim() === 'log_required: false') {
      lines[i] = lines[i].replace('false', 'true');
      inService = false;
    }
  }
  writeFileSync(archPath, lines.join('\n'), 'utf-8');
}

const ordersFile = (dir: string) => path.join(dir, 'src', 'services', 'orders.ts');

const ordersLogPath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'log.md');

// ---------------------------------------------------------------------------
// merge-resolve git-repo builder. Drives the REAL binary against a copy of the
// e2e-lifecycle graph so the CLI's graph load succeeds. The node services/orders
// is reused as the merge target; its log.md is the only file touched on each
// branch. git stderr is piped (not inherited) so conflict notices do not leak
// into test output; a conflicting `git merge` returns non-zero, which we
// tolerate (the conflict is then hand-resolved).
// ---------------------------------------------------------------------------

const ANCESTOR_LOG = '## [2026-05-11T10:00:00.000Z]\nbase.\n';
const P1_NEW = '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
const P2_NEW = '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
const UNION_LOG = ANCESTOR_LOG + P1_NEW + P2_NEW;

/** Run a git command in the repo with stdio piped (silent). */
function git(repo: string, cmd: string): void {
  execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe', env: gitFixtureEnv(repo) });
}

/**
 * Build a throwaway git repo in mkdtemp seeded with the e2e-lifecycle graph,
 * an ancestor log entry on services/orders, then two divergent branches each
 * adding one entry, merged with a conflict left for the caller to resolve by
 * writing `resolvedLog` into log.md and committing the merge.
 */
function buildMergeRepo(label: string, resolvedLog: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), `yg-logmr-${label}-`));
  cpSync(FIXTURE, repo, { recursive: true });
  const logPath = ordersLogPath(repo);
  mkdirSync(path.dirname(logPath), { recursive: true });

  git(repo, 'init -q -b main');
  git(repo, 'config user.email t@t.test');
  git(repo, 'config user.name Test');

  writeFileSync(logPath, ANCESTOR_LOG, 'utf-8');
  git(repo, 'add -A');
  git(repo, 'commit -qm ancestor');

  git(repo, 'checkout -qb feat1');
  writeFileSync(logPath, ANCESTOR_LOG + P1_NEW, 'utf-8');
  git(repo, 'add -A');
  git(repo, 'commit -qm feat1');

  git(repo, 'checkout -q main');
  git(repo, 'checkout -qb feat2 main');
  writeFileSync(logPath, ANCESTOR_LOG + P2_NEW, 'utf-8');
  git(repo, 'add -A');
  git(repo, 'commit -qm feat2');

  // Merge feat1 into feat2 — conflicts on log.md. Tolerate the non-zero exit.
  try {
    git(repo, 'merge --no-commit --no-ff feat1 -q');
  } catch {
    /* expected conflict — resolved by hand below */
  }
  writeFileSync(logPath, resolvedLog, 'utf-8');
  git(repo, 'add -A');
  git(repo, 'commit -qm "merge feat1 into feat2"');

  return repo;
}

// ---------------------------------------------------------------------------
// Log mechanics through the real binary. Hermetic — no LLM, no network.
// ---------------------------------------------------------------------------

describe.skipIf(!distExists)('CLI E2E — log integrity (mandatory gate, headings, read, merge-resolve)', () => {
  // --- 1. Mandatory-log gate skips the node's fill when no fresh entry exists ---

  it('1: fill emits log-entry-missing when log_required and no entry (exit 1)', () => {
    const dir = deterministicFixture('mandatory');
    try {
      enableServiceLogRequired(dir);
      // A source edit is present, but the node has no log entry at all.
      writeFileSync(
        ordersFile(dir),
        readFileSync(ordersFile(dir), 'utf-8') + '\nexport const flag = true;\n',
        'utf-8',
      );
      const { status, all } = run(['check', '--approve'], dir);
      expect(status).toBe(1);
      // what/why/next of the mandatory-log gate (code log-entry-missing).
      expect(all).toContain("No fresh log entry for node 'services/orders' — mandatory before --approve when source changed.");
      expect(all).toContain('log_required: true');
      expect(all).toContain('yg log add --node services/orders');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 2. A fresh log entry satisfies the gate; fill then passes ---

  it('2: log add then check --approve fills the node (exit 0)', () => {
    const dir = deterministicFixture('gate-pass');
    try {
      enableServiceLogRequired(dir);
      writeFileSync(
        ordersFile(dir),
        readFileSync(ordersFile(dir), 'utf-8') + '\nexport const flag = true;\n',
        'utf-8',
      );
      // payments also needs an entry on a cold fill (log_required:true treats the
      // first source fingerprint as a change).
      expect(run(['log', 'add', '--node', 'services/payments', '--reason', 'init'], dir).status).toBe(0);
      const add = run(['log', 'add', '--node', 'services/orders', '--reason', 'fix'], dir);
      expect(add.status).toBe(0);
      expect(add.stdout).toContain('Added log entry');

      const fill = run(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.stdout).toContain('yg check: PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 3. Level-2 markdown heading in a reason is rejected; level-3 is fine ---

  it('3: a reason with an embedded level-2 heading is rejected (exit 1)', () => {
    const dir = copyFixture('h2-reject');
    try {
      const reason = 'intro line\n## A level-two heading\nmore detail';
      const { status, all } = run(
        ['log', 'add', '--node', 'services/orders', '--reason', reason],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('level-2 header');
      // Nothing should have been written for the rejected entry.
      expect(existsSync(ordersLogPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3 (control): a reason with a level-3 sub-heading is accepted (exit 0)', () => {
    const dir = copyFixture('h3-accept');
    try {
      const reason = 'intro line\n### A level-three heading\nmore detail';
      const { status, stdout } = run(
        ['log', 'add', '--node', 'services/orders', '--reason', reason],
        dir,
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Added log entry');
      expect(readFileSync(ordersLogPath(dir), 'utf-8')).toContain('### A level-three heading');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4. log read --top: bounded newest-first; non-positive is rejected ---

  it('4: read --top 2 returns the two newest entries (exit 0)', () => {
    const dir = copyFixture('read-top');
    try {
      // Three entries; monotonic timestamps guarantee deterministic ordering.
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'one'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'two'], dir).status).toBe(0);
      expect(run(['log', 'add', '--node', 'services/orders', '--reason', 'three'], dir).status).toBe(0);

      const { status, stdout } = run(
        ['log', 'read', '--node', 'services/orders', '--top', '2'],
        dir,
      );
      expect(status).toBe(0);
      // Newest first: 'three' then 'two'; the oldest 'one' is excluded.
      expect(stdout).toContain('three');
      expect(stdout).toContain('two');
      expect(stdout).not.toContain('one\n');
      // Exactly two entry headers (## [...]) rendered.
      const headerCount = stdout.split('\n').filter((l) => l.startsWith('## [')).length;
      expect(headerCount).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4 (guard): read --top 0 is rejected as non-positive (exit 1)', () => {
    const dir = copyFixture('read-top0');
    try {
      run(['log', 'add', '--node', 'services/orders', '--reason', 'one'], dir);
      const { status, all } = run(
        ['log', 'read', '--node', 'services/orders', '--top', '0'],
        dir,
      );
      expect(status).toBe(1);
      expect(all).toContain('Invalid --top value: 0');
      expect(all).toContain('positive integer');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 5. merge-resolve happy path: ancestor preserved + union of new ---

  it('5: merge-resolve accepts a byte-exact ancestor + A+B+C union (exit 0)', () => {
    const repo = buildMergeRepo('happy', UNION_LOG);
    try {
      const { status, stdout } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
      expect(status).toBe(0);
      expect(stdout).toContain('Merge-resolve verified');
      expect(stdout).toContain('Log baseline updated');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // --- 6. merge-resolve failures ---

  it('6a: merge-resolve on a non-merge HEAD is rejected (exit 1)', () => {
    // Fresh repo with a single ordinary commit — HEAD has one parent.
    const repo = mkdtempSync(path.join(tmpdir(), 'yg-logmr-nomerge-'));
    try {
      cpSync(FIXTURE, repo, { recursive: true });
      const logPath = ordersLogPath(repo);
      mkdirSync(path.dirname(logPath), { recursive: true });
      git(repo, 'init -q -b main');
      git(repo, 'config user.email t@t.test');
      git(repo, 'config user.name Test');
      writeFileSync(logPath, ANCESTOR_LOG, 'utf-8');
      git(repo, 'add -A');
      git(repo, 'commit -qm only');

      const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
      expect(status).toBe(1);
      expect(all).toContain('not a merge commit');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('6b: merge-resolve rejects a tampered ancestor prefix (exit 1)', () => {
    // Same merge topology, but the resolved log mutates the ancestor entry body.
    const tampered =
      '## [2026-05-11T10:00:00.000Z]\nTAMPERED.\n' + P1_NEW + P2_NEW;
    const repo = buildMergeRepo('tampered', tampered);
    try {
      const { status, all } = run(['log', 'merge-resolve', '--node', 'services/orders'], repo);
      expect(status).toBe(1);
      expect(all).toContain('ancestor prefix');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
