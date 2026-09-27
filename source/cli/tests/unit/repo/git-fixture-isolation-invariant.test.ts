// =============================================================================
// GUARD 3 — git-fixture isolation invariant.
//
// The bug class this guards: a test that spawns a throwaway `git init`/`add`/
// `commit` fixture can, if the child `git` is able to DISCOVER or is POINTED AT
// this repository's real `.git`, reset the REAL index. Inside the pre-commit gate
// (`scripts/repo-check.sh` runs the whole suite) that reset lands between the hook
// starting and git finalizing the commit, so a "green" gate can silently capture a
// PARTIAL staged set — a green build that lies.
//
// The shared helper (tests/support/git-fixture.ts) makes this structurally
// impossible: every fixture git op is pinned to the fixture with an explicit,
// absolute GIT_DIR (which disables all repository discovery) and the inherited
// GIT_* discovery vars are scrubbed. This guard asserts that guarantee three ways
// and FAILS if a future edit removes the pin or the scrub:
//
//   (1) ENV CONTRACT (pure, deterministic, no git): gitFixtureEnv pins GIT_DIR /
//       GIT_WORK_TREE / GIT_CEILING_DIRECTORIES to the fixture and DELETES every
//       inherited discovery var — even when they are present in process.env.
//   (2) REAL INDEX UNTOUCHED: a full init+add+commit through the helper leaves this
//       repo's own `.git/index` byte-identical (captured immediately around the
//       synchronous helper calls; the helper never touches the real repo).
//   (3) HOSTILE-ENV OVERRIDE: with a DECOY GIT_DIR/GIT_INDEX_FILE planted in
//       process.env (a throwaway repo in os.tmpdir(), NEVER the real repo), the
//       helper still writes to the fixture and leaves the decoy empty — proving the
//       explicit pin overrides an inherited discovery env. If the pin is removed,
//       the write would follow the inherited GIT_DIR and this test fails.
//
// Deterministic and non-mutating of the real repo: fixtures are fresh mkdtemp dirs
// under os.tmpdir(), removed in a finally; the real `.git/index` is only ever READ
// (hashed), never written; commits use a fixed identity + date.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitFixtureEnv, runGitFixture, applyQuietGitConfig, FIXTURE_RM_OPTIONS } from '../../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/unit/repo → repo root is five levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const REAL_INDEX = path.join(REPO_ROOT, '.git', 'index');

const IDENTITY = {
  GIT_AUTHOR_NAME: 'guard',
  GIT_AUTHOR_EMAIL: 'guard@fixture.test',
  GIT_COMMITTER_NAME: 'guard',
  GIT_COMMITTER_EMAIL: 'guard@fixture.test',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, FIXTURE_RM_OPTIONS);
});

function freshDir(label: string): string {
  const d = mkdtempSync(path.join(tmpdir(), `yg-gitiso-${label}-`));
  dirs.push(d);
  return d;
}

/** SHA-256 of the real repo's index file, or null if it is not a plain file. */
function realIndexHash(): string | null {
  if (!existsSync(REAL_INDEX)) return null;
  return createHash('sha256').update(readFileSync(REAL_INDEX)).digest('hex');
}

describe('GUARD: git-fixture isolation — a test git op can never touch the real index', () => {
  it('(1) gitFixtureEnv pins the fixture and scrubs every inherited discovery var', () => {
    const fixture = freshDir('env');
    // Plant a hostile, fully-populated discovery env as if inherited from a hook.
    const hostile: Record<string, string> = {
      GIT_DIR: '/somewhere/else/.git',
      GIT_WORK_TREE: '/somewhere/else',
      GIT_INDEX_FILE: '/somewhere/else/.git/index',
      GIT_OBJECT_DIRECTORY: '/somewhere/else/.git/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/other/objects',
      GIT_COMMON_DIR: '/somewhere/else/.git',
      GIT_PREFIX: 'sub/dir/',
      GIT_NAMESPACE: 'refs/namespaces/x',
    };
    const saved = new Map<string, string | undefined>();
    for (const k of Object.keys(hostile)) {
      saved.set(k, process.env[k]);
      process.env[k] = hostile[k];
    }
    try {
      const env = gitFixtureEnv(fixture);
      // Pinned to the fixture — an absolute GIT_DIR disables all repo discovery.
      expect(env.GIT_DIR).toBe(path.join(path.resolve(fixture), '.git'));
      expect(env.GIT_WORK_TREE).toBe(path.resolve(fixture));
      expect(env.GIT_CEILING_DIRECTORIES).toBe(path.resolve(fixture));
      // Every inherited discovery var that could redirect the child is scrubbed.
      for (const k of [
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_COMMON_DIR',
        'GIT_PREFIX',
        'GIT_NAMESPACE',
      ]) {
        expect(env[k], `${k} must be scrubbed from the fixture env`).toBeUndefined();
      }
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('(2) a full init+add+commit through the helper leaves the real .git/index byte-identical', () => {
    const fixture = freshDir('real');
    writeFileSync(path.join(fixture, 'a.txt'), 'hello\n');

    const before = realIndexHash();
    // The isolated work: everything below is pinned to the fixture.
    expect(runGitFixture(fixture, ['init', '-q', '-b', 'main']).status).toBe(0);
    expect(runGitFixture(fixture, ['add', '-A'], { extraEnv: IDENTITY }).status).toBe(0);
    expect(runGitFixture(fixture, ['commit', '-qm', 'seed'], { extraEnv: IDENTITY }).status).toBe(0);
    const after = realIndexHash();

    // The fixture is a real repo with a commit …
    expect(existsSync(path.join(fixture, '.git'))).toBe(true);
    const head = runGitFixture(fixture, ['rev-parse', 'HEAD']);
    expect(head.status).toBe(0);
    expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    // … and this repo's own index was never touched.
    expect(after, 'fixture git op mutated the real repo index').toBe(before);
  });

  it('(3) an inherited (hostile) GIT_DIR decoy does not capture the write — the pin wins', () => {
    const fixture = freshDir('fix');
    const decoy = freshDir('decoy');
    // Make the decoy a valid, EMPTY repo (its own .git, no commits).
    expect(runGitFixture(decoy, ['init', '-q', '-b', 'main']).status).toBe(0);

    const savedDir = process.env.GIT_DIR;
    const savedIdx = process.env.GIT_INDEX_FILE;
    // Plant the decoy as the inherited discovery env. If the helper did NOT pin
    // GIT_DIR explicitly, the fixture write below would follow THIS into the decoy.
    process.env.GIT_DIR = path.join(path.resolve(decoy), '.git');
    process.env.GIT_INDEX_FILE = path.join(path.resolve(decoy), '.git', 'index');
    try {
      writeFileSync(path.join(fixture, 'b.txt'), 'world\n');
      expect(runGitFixture(fixture, ['init', '-q', '-b', 'main']).status).toBe(0);
      expect(runGitFixture(fixture, ['add', '-A'], { extraEnv: IDENTITY }).status).toBe(0);
      expect(runGitFixture(fixture, ['commit', '-qm', 'seed'], { extraEnv: IDENTITY }).status).toBe(0);

      // The write landed in the FIXTURE …
      const fixtureHead = runGitFixture(fixture, ['rev-parse', 'HEAD']);
      expect(fixtureHead.status).toBe(0);
      expect(fixtureHead.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
      // … and the decoy is still empty (no commit) — the inherited env was overridden.
      const decoyHead = runGitFixture(decoy, ['rev-parse', 'HEAD']);
      expect(decoyHead.status, 'the decoy repo captured the write — the pin was bypassed').not.toBe(0);
    } finally {
      if (savedDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedDir;
      if (savedIdx === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = savedIdx;
    }
  });

  // ---------------------------------------------------------------------------
  // Hermetic identity: a fixture must not depend on the machine's git config.
  // ---------------------------------------------------------------------------

  it('commits without any ambient git identity — the fixture supplies its own', () => {
    // A developer's machine almost always has a global user.name/user.email, so
    // a fixture that relies on finding one passes locally and fails on a CI
    // runner, which has none: git tries to guess an identity from user@hostname
    // and REFUSES when the hostname carries no domain, exiting 128. Pointing
    // git's global and system config at an empty file reproduces that machine
    // here, and the fixture must still be able to commit.
    const fixture = freshDir('identity');
    const noAmbientConfig = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
    writeFileSync(path.join(fixture, 'a.txt'), 'hello\n');

    expect(runGitFixture(fixture, ['init', '-q', '-b', 'main'], { extraEnv: noAmbientConfig }).status).toBe(0);
    expect(runGitFixture(fixture, ['add', '-A'], { extraEnv: noAmbientConfig }).status).toBe(0);
    const commit = runGitFixture(fixture, ['commit', '-qm', 'seed'], { extraEnv: noAmbientConfig });
    expect(commit.status, commit.stderr).toBe(0);
  });

  it('MERGES without any ambient git identity — the case that has no `commit` in it to remind you', () => {
    // A real (non-fast-forward) merge writes a commit, so it needs an identity
    // just as much as `git commit` does — but the caller never typed the word,
    // which is exactly how a fixture ends up committing with whatever the
    // machine happens to have configured.
    const fixture = freshDir('identity-merge');
    const noAmbientConfig = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
    const git = (args: string[]) => runGitFixture(fixture, args, { extraEnv: noAmbientConfig });

    writeFileSync(path.join(fixture, 'base.txt'), 'base\n');
    git(['init', '-q', '-b', 'main']);
    git(['add', '-A']);
    git(['commit', '-qm', 'base']);

    git(['checkout', '-q', '-b', 'branch-a']);
    writeFileSync(path.join(fixture, 'a.txt'), 'a\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'a']);

    git(['checkout', '-q', 'main']);
    git(['checkout', '-q', '-b', 'branch-b']);
    writeFileSync(path.join(fixture, 'b.txt'), 'b\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'b']);

    git(['checkout', '-q', 'branch-a']);
    const merged = git(['merge', '-q', '--no-edit', 'branch-b']);
    expect(merged.status, merged.stderr).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Quiet fixtures: nothing keeps writing into a fixture after its command ends.
// ---------------------------------------------------------------------------
//
// Every `git commit` ends by spawning a detached `git maintenance run --auto`
// that outlives it. When that child repacks, it writes into `.git/objects` and
// `.git/info` while the test's cleanup is already removing the directory, and a
// test that passed fails with ENOTEMPTY (seen in CI on `.git/info` and
// `.git/objects` of a gitlink fixture). The fixture env switches it off.
describe('GUARD: a fixture git command leaves no background maintenance behind', () => {
  /** Run `git commit` in a fresh fixture and return git's own trace of it. */
  function traceOfCommit(label: string, extraEnv: NodeJS.ProcessEnv = {}): string {
    const fixture = freshDir(label);
    const trace = path.join(freshDir(`${label}-trace`), 'trace2.txt');
    writeFileSync(path.join(fixture, 'a.txt'), 'hello\n');
    runGitFixture(fixture, ['init', '-q', '-b', 'main']);
    runGitFixture(fixture, ['add', '-A']);
    const commit = runGitFixture(fixture, ['commit', '-qm', 'seed'], { extraEnv: { ...IDENTITY, ...extraEnv, GIT_TRACE2: trace } });
    expect(commit.status, commit.stderr).toBe(0);
    return readFileSync(trace, 'utf-8');
  }

  it('a commit through the fixture env starts no `git maintenance run --auto`', () => {
    expect(traceOfCommit('quiet')).not.toContain('maintenance run --auto');
  });

  it('the probe above is live: the same commit with auto-maintenance switched back on does start one', () => {
    // A caller's own GIT_CONFIG_* pair wins over the quiet default, which is
    // what lets this control turn maintenance back on. Without the control, a
    // git that never traced the child would make the assertion above vacuous.
    const loud = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'true' };
    expect(traceOfCommit('loud', loud)).toContain('maintenance run --auto');
  });

  it('every git child of a test worker runs quiet, fixture env or not (tests/setup.ts)', () => {
    // Fixtures built without gitFixtureEnv, and git run by the CLI under test,
    // inherit the worker's process.env — the worker-level boundary covers them.
    const cwd = freshDir('worker-env');
    const get = (key: string) =>
      spawnSync('git', ['config', '--get', key], { cwd, encoding: 'utf-8', env: process.env }).stdout.trim();
    expect(get('maintenance.auto')).toBe('false');
    expect(get('gc.auto')).toBe('0');
  });

  it('applyQuietGitConfig appends after a caller\'s pairs, keeps a key the caller set, and is idempotent', () => {
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '42' };
    applyQuietGitConfig(env);
    applyQuietGitConfig(env);
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'gc.auto',
      GIT_CONFIG_VALUE_0: '42',
      GIT_CONFIG_KEY_1: 'maintenance.auto',
      GIT_CONFIG_VALUE_1: 'false',
    });
  });
});

// ---------------------------------------------------------------------------
// Every test git command goes through the helper.
// ---------------------------------------------------------------------------
//
// A bare `spawnSync('git', …)` with the worker's own env runs with whatever
// identity the machine has. A developer's box has a global user.name and
// user.email, so a fixture commit made that way passes locally, and fails on a
// CI runner, which has none: that is how a merge-recipe test broke CI after
// passing the pre-commit gate. The helper gives every fixture git op an
// identity (and the pin above), so the guard below fails on any git process a
// test starts outside tests/support/git-fixture.ts that does not carry the
// helper's env. The gate runs the suite without a global identity too
// (scripts/repo-check.sh), so a miss here also fails locally, as it would in CI.
describe('GUARD: a test runs git only through the fixture helper', () => {
  const TESTS_ROOT = path.resolve(__dirname, '..', '..');

  /**
   * The few git commands a test may still start itself, per file, with the
   * reason. None of them commits: each reads this repository, or asks git a
   * question that involves no repository at all.
   */
  const ALLOWED: Record<string, { count: number; reason: string }> = {
    'unit/repo/git-fixture-isolation-invariant.test.ts': { count: 1, reason: 'reads the worker\'s own git config on purpose, to prove the worker-level quiet config reaches git run outside the helper' },
    'integration/portal-attestation-meta.test.ts': { count: 1, reason: 'reads this repository\'s HEAD, read-only' },
    'unit/core/check-lock.test.ts': { count: 1, reason: 'lists files tracked by this repository, read-only' },
    'unit/repo/false-green-invariant.test.ts': { count: 1, reason: 'lists files tracked by this repository, read-only' },
    'unit/repo/graph-self-governance-invariant.test.ts': { count: 1, reason: 'lists files tracked by this repository, read-only' },
    'e2e/cli-aspects-health.test.ts': { count: 1, reason: 'probes git --version, touching no repository' },
  };

  const GIT_CALL = /\b(spawnSync|spawn|execFileSync|execFile|execSync|exec)\(\s*(['"`])git(?:\2|\s)/g;

  function testSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'fixtures' && entry.name !== 'node_modules') testSources(p, out);
      } else if (/\.(ts|mts|js|mjs)$/.test(entry.name)) out.push(p);
    }
    return out;
  }

  /** The text of the call whose opening parenthesis is at `open`, up to its matching close. */
  function callText(src: string, open: number): string {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
    }
    return src.slice(open);
  }

  /** Git calls in `src` that carry no fixture env: neither gitFixtureEnv(…) nor a variable built from it. */
  function rawGitCalls(src: string): number[] {
    const fromHelper = new Set([...src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=\n;]+)?=\s*gitFixtureEnv\(/g)].map((m) => m[1]));
    const lines: number[] = [];
    for (const m of src.matchAll(GIT_CALL)) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const lead = src.slice(lineStart, m.index).trim();
      if (lead.startsWith('//') || lead.startsWith('*')) continue;
      const text = callText(src, m.index + m[1].length);
      if (text.includes('gitFixtureEnv(')) continue;
      const envName = /\benv:\s*(\w+)\b/.exec(text)?.[1] ?? (/[{,]\s*env\s*[,}]/.test(text) ? 'env' : undefined);
      if (envName !== undefined && fromHelper.has(envName)) continue;
      lines.push(src.slice(0, m.index).split('\n').length);
    }
    return lines;
  }

  it('finds a bare git call, and passes one that carries the helper\'s env', () => {
    // Each sample call is assembled from parts, so this file's own source holds
    // none of them for the scan below to find.
    const call = (fn: string, rest: string): string => `${fn}(${rest}`;
    const bare = [`const r = ${call('spawnSync', "'git', ['commit', '-m', 'x'], { cwd: dir });")}`, call('execSync', "'git init -q', { cwd: dir });")].join('\n');
    expect(rawGitCalls(bare)).toEqual([1, 2]);
    const helper = [
      `const r = ${call('spawnSync', "'git', ['commit'], { cwd: dir, env: gitFixtureEnv(dir) });")}`,
      'const env = gitFixtureEnv(dir);',
      call('execFileSync', "'git', ['add', '-A'], { cwd: dir, env });"),
      `// ${call('spawnSync', "'git', ['a comment'])")}`,
    ].join('\n');
    expect(rawGitCalls(helper)).toEqual([]);
  });

  it('no test starts a git process outside the helper beyond the reasoned exceptions', () => {
    const found: string[] = [];
    for (const file of testSources(TESTS_ROOT)) {
      const rel = path.relative(TESTS_ROOT, file).split(path.sep).join('/');
      if (rel === 'support/git-fixture.ts') continue;
      const lines = rawGitCalls(readFileSync(file, 'utf-8'));
      const allowed = ALLOWED[rel]?.count ?? 0;
      if (lines.length > allowed) found.push(`${rel}:${lines.join(',')}`);
    }
    expect(
      found,
      'A test starts git without the fixture helper, so it runs with whatever git identity the machine has: it passes on a ' +
        'developer box and fails in CI. Use runGitFixture (or gitFixtureEnv) from tests/support/git-fixture.ts, or ' +
        'runGitCreating for a clone or a bare init.',
    ).toEqual([]);
  });
});
