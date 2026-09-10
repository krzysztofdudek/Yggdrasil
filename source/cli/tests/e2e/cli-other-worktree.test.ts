// =============================================================================
// CLI E2E — reading a graph from another worktree.
//
// Every command loads the graph from `process.cwd()` alone (loadGraphOrAbort,
// cli/preamble.ts). There is no `--root` or `-C` flag to point a command at a
// different commit — the documented way (docs/concurrency.md) is a detached
// `git worktree add`, with the child process's `cwd` set to it, which is
// exactly how a tool that spawns `yg` (Horde included) already runs it today.
// These scenarios prove that path is real and, above all, that it is LEAK-PROOF:
// a command run inside a temporary worktree must never read from or write to
// the tree it was cut from — that guarantee is what a later `land` gate stands
// on entire.
//
//   1.  yg aspects --json       → worktree at an older commit sees fewer aspects
//                                  than the main tree at the newer commit
//   2.  yg context --file --json → the aspect list differs by exactly the one
//                                  aspect; owner and chain are identical
//   3.  yg check --json         → project.aspects and pairs differ by the same
//                                  one aspect
//   4.  --approve --only-deterministic in the worktree writes ONLY the
//       worktree's own deterministic cache; the main tree's copy is untouched
//   5.  the same in reverse: approving in the main tree never touches the
//       worktree
//   6.  the events sidecar (.yg-events.jsonl) after --approve in the worktree
//       exists only in the worktree
//   7.  LEAK-PROOFING — after every read (and after --approve) run with cwd in
//       the worktree, a full recursive (path, size, sha256) snapshot of the
//       main tree is byte-for-byte unchanged. This is the assertion the whole
//       Horde `land` gate rests on, asserted here explicitly.
//   8.  a worktree checked out before `.yggdrasil/` ever existed refuses with
//       the no-graph message, exit 1, and never names the main tree's path
//   9.  a worktree whose graph declares a different schema version refuses
//       naming the version, exit 1, with no side effect in the main tree
//  10.  a worktree path containing a space and a unicode character still works
//       for scenarios 1-3
//  11.  a worktree directory deleted from disk (no `git worktree remove`) does
//       not break a later command run with cwd in the main tree
//  12.  two worktrees, two `yg check --json` runs in parallel — both exit 0,
//       both parse, neither blocks the other
//  13.  a shallow clone: `git worktree add --detach` succeeds on the one commit
//       it has, and is refused on a commit outside its shallow history
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runGitFixture } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const IDENTITY = {
  GIT_AUTHOR_NAME: 'yg-test',
  GIT_AUTHOR_EMAIL: 'yg-test@fixture.test',
  GIT_COMMITTER_NAME: 'yg-test',
  GIT_COMMITTER_EMAIL: 'yg-test@fixture.test',
};

/** The schema version this CLI build actually supports (mirrors CLI_SUPPORTED_SCHEMA). */
const SUPPORTED_SCHEMA = '5.2.0';

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** Run the built CLI (the public surface under test) — never through runGitFixture, which is for git only. */
function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

/** Async form of {@link run}, for scenario 12's genuinely-parallel invocations. */
function runAsync(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('node', [BIN_PATH, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ stdout, stderr, status: code }));
  });
}

const PASS_CHECK_MJS = `export function check(ctx) {\n  return [];\n}\n`;

function configYaml(version: string): string {
  return `version: "${version}"\n`;
}

const ARCHITECTURE_YAML = `node_types:
  component:
    description: 'A single mapped component.'
    log_required: false
    when:
      path: "src/**"
`;

function aspectYaml(name: string, description: string): string {
  return `name: ${name}\ndescription: ${description}\nreviewer:\n  type: deterministic\nstatus: enforced\n`;
}

function nodeYaml(aspectIds: string[]): string {
  const aspectsBlock = aspectIds.map((id) => `  - ${id}`).join('\n');
  return `name: Thing\ndescription: A single mapped component.\ntype: component\naspects:\n${aspectsBlock}\nmapping:\n  - src/thing.ts\n`;
}

const SOURCE_FILE = `export function thing(): number {\n  return 1;\n}\n`;

/** Write a working one-aspect graph ("aspect-one" only) plus its source file. */
function writeBaseGraph(dir: string, version = SUPPORTED_SCHEMA): void {
  writeFile(dir, 'src/thing.ts', SOURCE_FILE);
  writeFile(dir, '.yggdrasil/yg-config.yaml', configYaml(version));
  writeFile(dir, '.yggdrasil/yg-architecture.yaml', ARCHITECTURE_YAML);
  writeFile(dir, '.yggdrasil/aspects/aspect-one/yg-aspect.yaml', aspectYaml('AspectOne', 'First deterministic rule.'));
  writeFile(dir, '.yggdrasil/aspects/aspect-one/check.mjs', PASS_CHECK_MJS);
  writeFile(dir, '.yggdrasil/model/thing/yg-node.yaml', nodeYaml(['aspect-one']));
}

/** Add the second aspect ("aspect-two") on top of {@link writeBaseGraph}. */
function addSecondAspect(dir: string): void {
  writeFile(dir, '.yggdrasil/aspects/aspect-two/yg-aspect.yaml', aspectYaml('AspectTwo', 'Second deterministic rule.'));
  writeFile(dir, '.yggdrasil/aspects/aspect-two/check.mjs', PASS_CHECK_MJS);
  writeFile(dir, '.yggdrasil/model/thing/yg-node.yaml', nodeYaml(['aspect-one', 'aspect-two']));
}

function commit(dir: string, message: string): void {
  expect(runGitFixture(dir, ['add', '-A'], { extraEnv: IDENTITY }).status).toBe(0);
  expect(runGitFixture(dir, ['commit', '-qm', message], { extraEnv: IDENTITY }).status).toBe(0);
}

function headSha(dir: string): string {
  const r = runGitFixture(dir, ['rev-parse', 'HEAD']);
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

/**
 * Build the shared two-commit fixture: commit "a" carries one aspect, commit
 * "b" (HEAD) adds the second. Returns the repo dir and both commit shas — `shaA`
 * is read as `HEAD~1` from `b`, per the ticket's own fixture recipe, rather than
 * captured in between the two commits.
 */
function buildTwoCommitRepo(label: string): { dir: string; shaA: string; shaB: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-worktree-${label}-`));
  writeBaseGraph(dir);
  expect(runGitFixture(dir, ['init', '-q', '-b', 'main']).status).toBe(0);
  commit(dir, 'a: one aspect');
  addSecondAspect(dir);
  commit(dir, 'b: second aspect');
  const shaB = headSha(dir);
  const shaA = runGitFixture(dir, ['rev-parse', 'HEAD~1']).stdout.trim();
  return { dir, shaA, shaB };
}

/** `git worktree add --detach <worktreeDir> <sha>`, pinned to `repoDir` via runGitFixture. */
function addWorktree(repoDir: string, worktreeDir: string, sha: string) {
  return runGitFixture(repoDir, ['worktree', 'add', '--detach', worktreeDir, sha]);
}

function freshWorktreeDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `yg-worktree-${label}-wt-`));
}

function cleanup(...dirs: string[]): void {
  // `git worktree add` leaves an entry under <repo>/.git/worktrees/ that
  // `git worktree remove` would normally clear — removing the whole repo
  // directory (itself a throwaway mkdtemp tree) makes that moot, so plain
  // rmSync of every directory involved is sufficient cleanup here.
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

interface FileFact {
  size: number;
  sha: string;
}

/** Recursive (relative path -> {size, sha256}) snapshot of `root`, excluding `.git/`. */
function snapshotTree(root: string): Map<string, FileFact> {
  const out = new Map<string, FileFact>();
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const buf = readFileSync(abs);
      out.set(path.relative(root, abs), { size: buf.length, sha: createHash('sha256').update(buf).digest('hex') });
    }
  }
  walk(root);
  return out;
}

/** Assert two snapshots are identical, naming every added/removed/changed path on failure. */
function assertUnchanged(before: Map<string, FileFact>, after: Map<string, FileFact>, context: string): void {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [p, b] of before) {
    const a = after.get(p);
    if (!a) {
      removed.push(p);
      continue;
    }
    if (a.size !== b.size || a.sha !== b.sha) changed.push(p);
  }
  for (const p of after.keys()) if (!before.has(p)) added.push(p);
  const problems = { added, removed, changed };
  const clean = added.length === 0 && removed.length === 0 && changed.length === 0;
  expect(clean, `${context} — main tree was touched: ${JSON.stringify(problems)}`).toBe(true);
}

interface AspectsDoc {
  schema: string;
  aspects: Array<{ id: string }>;
}
interface ContextDoc {
  schema: string;
  owner: Record<string, string>;
  chain: Array<{ node: string | null; type: string }>;
  aspects: Array<{ id: string }>;
}
interface CheckDoc {
  schema: string;
  project: { name: string; nodes: number; aspects: number; flows: number };
  exit: { code: number; status: string; reason: string };
  pairs: Array<{ aspect: string; node: string | null }>;
}

describe.skipIf(!distExists)('CLI E2E — reading a graph from another worktree', () => {
  it('1: yg aspects --json — the worktree at the older commit sees one fewer aspect', () => {
    const { dir, shaA } = buildTwoCommitRepo('s1');
    const wt = freshWorktreeDir('s1');
    try {
      expect(addWorktree(dir, wt, shaA).status).toBe(0);

      const mainDoc = JSON.parse(run(['aspects', '--json'], dir).stdout) as AspectsDoc;
      const wtDoc = JSON.parse(run(['aspects', '--json'], wt).stdout) as AspectsDoc;

      expect(mainDoc.aspects.map((a) => a.id).sort()).toEqual(['aspect-one', 'aspect-two']);
      expect(wtDoc.aspects.map((a) => a.id)).toEqual(['aspect-one']);
    } finally {
      cleanup(wt, dir);
    }
  });

  it('2: yg context --file --json — aspects differ by exactly one; owner and chain match', () => {
    const { dir, shaA } = buildTwoCommitRepo('s2');
    const wt = freshWorktreeDir('s2');
    try {
      expect(addWorktree(dir, wt, shaA).status).toBe(0);

      const mainDoc = JSON.parse(run(['context', '--file', 'src/thing.ts', '--json'], dir).stdout) as ContextDoc;
      const wtDoc = JSON.parse(run(['context', '--file', 'src/thing.ts', '--json'], wt).stdout) as ContextDoc;

      expect(mainDoc.owner).toEqual(wtDoc.owner);
      expect(mainDoc.chain).toEqual(wtDoc.chain);
      const mainIds = mainDoc.aspects.map((a) => a.id);
      const wtIds = wtDoc.aspects.map((a) => a.id);
      expect(mainIds.filter((id) => !wtIds.includes(id))).toEqual(['aspect-two']);
      expect(wtIds.filter((id) => !mainIds.includes(id))).toEqual([]);
    } finally {
      cleanup(wt, dir);
    }
  });

  it('3: yg check --json — project.aspects and pairs both differ by exactly one', () => {
    const { dir, shaA } = buildTwoCommitRepo('s3');
    const wt = freshWorktreeDir('s3');
    try {
      expect(addWorktree(dir, wt, shaA).status).toBe(0);

      const mainDoc = JSON.parse(run(['check', '--json'], dir).stdout) as CheckDoc;
      const wtDoc = JSON.parse(run(['check', '--json'], wt).stdout) as CheckDoc;

      expect(mainDoc.project.aspects - wtDoc.project.aspects).toBe(1);
      expect(mainDoc.pairs.length - wtDoc.pairs.length).toBe(1);
    } finally {
      cleanup(wt, dir);
    }
  });

  it('4: --approve --only-deterministic in the worktree writes only its own cache', () => {
    const { dir, shaA } = buildTwoCommitRepo('s4');
    const wt = freshWorktreeDir('s4');
    try {
      expect(addWorktree(dir, wt, shaA).status).toBe(0);
      const mainLockPath = path.join(dir, '.yggdrasil', '.yg-lock.deterministic.json');
      const wtLockPath = path.join(wt, '.yggdrasil', '.yg-lock.deterministic.json');
      expect(existsSync(mainLockPath)).toBe(false);
      expect(existsSync(wtLockPath)).toBe(false);

      const result = run(['check', '--approve', '--only-deterministic'], wt);
      expect(result.status).toBe(0);

      expect(existsSync(wtLockPath)).toBe(true);
      expect(existsSync(mainLockPath), 'the main tree must never gain a deterministic cache from a worktree approve').toBe(false);
    } finally {
      cleanup(wt, dir);
    }
  });

  it('5: the reverse — --approve --only-deterministic in the main tree never touches the worktree', () => {
    const { dir, shaA } = buildTwoCommitRepo('s5');
    const wt = freshWorktreeDir('s5');
    try {
      expect(addWorktree(dir, wt, shaA).status).toBe(0);
      const mainLockPath = path.join(dir, '.yggdrasil', '.yg-lock.deterministic.json');
      const wtLockPath = path.join(wt, '.yggdrasil', '.yg-lock.deterministic.json');

      const result = run(['check', '--approve', '--only-deterministic'], dir);
      expect(result.status).toBe(0);

      expect(existsSync(mainLockPath)).toBe(true);
      expect(existsSync(wtLockPath), 'the worktree must never gain a deterministic cache from a main-tree approve').toBe(false);
    } finally {
      cleanup(wt, dir);
    }
  });

  it('6: the events sidecar after --approve in the worktree exists only in the worktree', () => {
    const { dir, shaA } = buildTwoCommitRepo('s6');
    const wt = freshWorktreeDir('s6');
    try {
      expect(addWorktree(dir, wt, shaA).status).toBe(0);
      const mainEventsPath = path.join(dir, '.yggdrasil', '.yg-events.jsonl');
      const wtEventsPath = path.join(wt, '.yggdrasil', '.yg-events.jsonl');

      const result = run(['check', '--approve', '--only-deterministic'], wt);
      expect(result.status).toBe(0);

      expect(existsSync(wtEventsPath)).toBe(true);
      expect(existsSync(mainEventsPath), 'the main tree must never gain an events sidecar from a worktree approve').toBe(false);
    } finally {
      cleanup(wt, dir);
    }
  });

  it('7: LEAK-PROOFING — no read, and no --approve --only-deterministic, in the worktree touches a single byte of the main tree', () => {
    const { dir, shaA } = buildTwoCommitRepo('s7');
    const wt = freshWorktreeDir('s7');
    try {
      expect(addWorktree(dir, wt, shaA).status).toBe(0);

      let before = snapshotTree(dir);
      expect(run(['aspects', '--json'], wt).status).toBe(0);
      let after = snapshotTree(dir);
      assertUnchanged(before, after, 'after `yg aspects --json` in the worktree');

      before = snapshotTree(dir);
      expect(run(['context', '--file', 'src/thing.ts', '--json'], wt).status).toBe(0);
      after = snapshotTree(dir);
      assertUnchanged(before, after, 'after `yg context --file --json` in the worktree');

      before = snapshotTree(dir);
      expect(run(['check', '--json'], wt).status).not.toBeNull();
      after = snapshotTree(dir);
      assertUnchanged(before, after, 'after `yg check --json` in the worktree');

      // The one command that WRITES — --approve --only-deterministic — is the
      // strongest form of this claim: even a write in the worktree must leave
      // the main tree's own copy of .yggdrasil/ byte-for-byte as it was.
      before = snapshotTree(dir);
      expect(run(['check', '--approve', '--only-deterministic'], wt).status).toBe(0);
      after = snapshotTree(dir);
      assertUnchanged(before, after, 'after `yg check --approve --only-deterministic` in the worktree');
    } finally {
      cleanup(wt, dir);
    }
  });

  it('8: a worktree checked out before .yggdrasil/ existed refuses without naming the main tree', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-worktree-s8-'));
    const wt = freshWorktreeDir('s8');
    try {
      writeFile(dir, 'src/thing.ts', SOURCE_FILE);
      expect(runGitFixture(dir, ['init', '-q', '-b', 'main']).status).toBe(0);
      commit(dir, 'source only, no graph yet');
      const shaNoGraph = headSha(dir);

      writeBaseGraph(dir);
      commit(dir, 'add the graph');

      expect(addWorktree(dir, wt, shaNoGraph).status).toBe(0);

      const result = run(['aspects', '--json'], wt);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No .yggdrasil/ directory found in the current project.');
      expect(result.stderr).not.toContain(dir);
    } finally {
      cleanup(wt, dir);
    }
  });

  it('9: a worktree whose graph declares a different schema version refuses, naming the version, with no side effect in the main tree', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-worktree-s9-'));
    const wt = freshWorktreeDir('s9');
    try {
      const outdatedVersion = '5.1.0';
      writeBaseGraph(dir, outdatedVersion);
      expect(runGitFixture(dir, ['init', '-q', '-b', 'main']).status).toBe(0);
      commit(dir, 'graph at an outdated schema version');
      const shaOutdated = headSha(dir);

      writeBaseGraph(dir, SUPPORTED_SCHEMA);
      commit(dir, 'graph migrated to the current schema version');

      expect(addWorktree(dir, wt, shaOutdated).status).toBe(0);

      const before = snapshotTree(dir);
      const result = run(['aspects', '--json'], wt);
      const after = snapshotTree(dir);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(outdatedVersion);
      assertUnchanged(before, after, 'after the version-refused command in the worktree');
    } finally {
      cleanup(wt, dir);
    }
  });

  it('10: a worktree path with a space and a unicode character still works for scenarios 1-3', () => {
    const { dir, shaA } = buildTwoCommitRepo('s10');
    // mkdtempSync cannot itself produce a space/unicode suffix, so mint a unique
    // base with it, then free the name and append the special characters —
    // still guaranteed unique, never colliding with another test's directory.
    const base = mkdtempSync(path.join(tmpdir(), 'yg-worktree-s10-wt-'));
    rmSync(base, { recursive: true, force: true });
    const wt = `${base} spacé 世界`;
    try {
      expect(addWorktree(dir, wt, shaA).status).toBe(0);

      const aspectsDoc = JSON.parse(run(['aspects', '--json'], wt).stdout) as AspectsDoc;
      expect(aspectsDoc.aspects.map((a) => a.id)).toEqual(['aspect-one']);

      const contextDoc = JSON.parse(run(['context', '--file', 'src/thing.ts', '--json'], wt).stdout) as ContextDoc;
      expect(contextDoc.aspects.map((a) => a.id)).toEqual(['aspect-one']);

      const checkDoc = JSON.parse(run(['check', '--json'], wt).stdout) as CheckDoc;
      expect(checkDoc.project.aspects).toBe(1);
    } finally {
      cleanup(wt, dir);
    }
  });

  it('11: a worktree directory deleted from disk (no `git worktree remove`) does not break the main tree', () => {
    const { dir, shaA } = buildTwoCommitRepo('s11');
    const wt = freshWorktreeDir('s11');
    try {
      expect(addWorktree(dir, wt, shaA).status).toBe(0);

      const before = run(['check', '--json'], dir);

      // Delete the worktree the crude way — never `git worktree remove` — so
      // `.git/worktrees/<name>` in the main repo now points at nothing.
      rmSync(wt, { recursive: true, force: true });

      const after = run(['check', '--json'], dir);
      expect(after.status).toBe(before.status);
      expect(() => JSON.parse(after.stdout)).not.toThrow();
    } finally {
      cleanup(dir);
    }
  });

  it('12: two worktrees, two parallel `yg check --json` runs — both exit 0, neither blocks the other', async () => {
    const { dir, shaA, shaB } = buildTwoCommitRepo('s12');
    const wtA = freshWorktreeDir('s12a');
    const wtB = freshWorktreeDir('s12b');
    try {
      expect(addWorktree(dir, wtA, shaA).status).toBe(0);
      expect(addWorktree(dir, wtB, shaB).status).toBe(0);

      // Pre-approve both so the parallel runs below land on a clean exit 0,
      // per the scenario's own acceptance ("both end 0") rather than an
      // incidental "unverified" failure that would prove nothing about
      // concurrency.
      expect(run(['check', '--approve', '--only-deterministic'], wtA).status).toBe(0);
      expect(run(['check', '--approve', '--only-deterministic'], wtB).status).toBe(0);

      const [resultA, resultB] = await Promise.all([
        runAsync(['check', '--json'], wtA),
        runAsync(['check', '--json'], wtB),
      ]);

      expect(resultA.status).toBe(0);
      expect(resultB.status).toBe(0);
      const docA = JSON.parse(resultA.stdout) as CheckDoc;
      const docB = JSON.parse(resultB.stdout) as CheckDoc;
      expect(docA.project.aspects).toBe(1);
      expect(docB.project.aspects).toBe(2);
    } finally {
      cleanup(wtA, wtB, dir);
    }
  });

  it('13: a shallow clone — worktree add succeeds on the available commit, refuses on one outside its history', () => {
    const { dir, shaA, shaB } = buildTwoCommitRepo('s13-origin');
    // A distinct initial branch name for the shallow clone matters: `git init`
    // with no `-b` picks up the machine's `init.defaultBranch` (commonly
    // "main"), and fetching a remote branch ALSO named "main" into a repo whose
    // unborn HEAD already symbolically points at refs/heads/main is refused by
    // git ("refusing to fetch into branch ... checked out") even though no
    // commit exists yet on that branch. Naming the scratch branch something
    // that can never collide with the fetched name sidesteps that safety
    // check entirely, independent of the host's git config.
    const shallow = mkdtempSync(path.join(tmpdir(), 'yg-worktree-s13-shallow-'));
    const wt = freshWorktreeDir('s13');
    try {
      expect(runGitFixture(shallow, ['init', '-q', '-b', '__scratch_unused__']).status).toBe(0);
      expect(runGitFixture(shallow, ['remote', 'add', 'origin', `file://${dir}`]).status).toBe(0);
      const fetch = runGitFixture(shallow, ['-c', 'protocol.file.allow=always', 'fetch', '-q', '--depth', '1', 'origin', 'main:main']);
      expect(fetch.status, fetch.stderr).toBe(0);
      expect(runGitFixture(shallow, ['checkout', '-q', 'main']).status).toBe(0);
      expect(runGitFixture(shallow, ['rev-parse', '--is-shallow-repository']).stdout.trim()).toBe('true');
      expect(headSha(shallow)).toBe(shaB);

      const available = addWorktree(shallow, wt, shaB);
      expect(available.status, available.stderr).toBe(0);
      rmSync(wt, { recursive: true, force: true });

      const unavailable = addWorktree(shallow, wt, shaA);
      expect(unavailable.status).not.toBe(0);
      expect(unavailable.stderr).toContain('invalid reference');
    } finally {
      cleanup(wt, shallow, dir);
    }
  });
});
