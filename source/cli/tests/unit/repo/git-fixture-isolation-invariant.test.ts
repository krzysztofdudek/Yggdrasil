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
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gitFixtureEnv, runGitFixture } from '../../support/git-fixture.js';

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
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
