// =============================================================================
// Shared git-fixture isolation helper.
//
// WHY THIS EXISTS
//   Many test suites spawn a throwaway `git init` / `git add` / `git commit`
//   fixture (via execSync / execFileSync / spawnSync) to exercise code that reads
//   the git index. If any such child `git` process can DISCOVER or is POINTED AT
//   this repository's REAL `.git`, a write op (init/add/commit/reset/checkout) can
//   reset the real index — and when the test suite runs inside the pre-commit gate
//   (`scripts/repo-check.sh`), that reset lands BETWEEN the hook starting and git
//   finalizing the commit, so a "green" gate can silently capture a PARTIAL staged
//   set (a "green build that lies"). Two vectors reach the real repo:
//     (1) INHERITED ENV — a leaked GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE (git
//         sets these while running a hook) auto-points the child at the real repo.
//     (2) DISCOVERY VIA CWD — a git op whose cwd is inside the repo tree walks UP
//         and finds the real `.git`.
//
// THE GUARANTEE
//   `gitFixtureEnv` PINS every git op to the fixture with an explicit, absolute
//   GIT_DIR (= <fixtureDir>/.git). With GIT_DIR set explicitly, git performs ZERO
//   repository discovery — the operation physically cannot reach any other repo,
//   regardless of cwd or any inherited GIT_* env. It ALSO scrubs the inherited
//   discovery vars from the child env and sets GIT_CEILING_DIRECTORIES to the
//   fixture as belt-and-suspenders. The fixture's `.git` is created at the normal
//   `<fixtureDir>/.git` location, so a SEPARATE CLI-under-test subprocess (spawned
//   with normal cwd-based discovery, not this env) still discovers it as usual.
//
//   This module imports ONLY Node builtins — never anything under src/** — so e2e
//   suites (which must stay off the CLI's internal surface) can use it freely.
// =============================================================================

import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import path from 'node:path';

/**
 * Inherited GIT_* variables that let a child `git` auto-discover a DIFFERENT
 * repository than the fixture. Scrubbed from every fixture git env. (GIT_DIR and
 * GIT_WORK_TREE are not listed here because they are re-set explicitly below to
 * the fixture, which overrides any inherited value.)
 */
const INHERITED_DISCOVERY_VARS = [
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
] as const;

/**
 * Build a scrubbed, fixture-pinned environment for a git command that must act on
 * `fixtureDir` and ONLY `fixtureDir`.
 *
 * @param fixtureDir absolute or relative path to the fixture repo's work tree.
 * @param extraEnv   caller-supplied overrides (identity, author dates, …) merged
 *                   BEFORE the pins are applied, so the pins always win.
 */
export function gitFixtureEnv(
  fixtureDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const abs = path.resolve(fixtureDir);
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  // Remove any inherited discovery vars so the child cannot auto-locate the real
  // repo through a leaked env.
  for (const v of INHERITED_DISCOVERY_VARS) delete env[v];
  // PIN the operation to the fixture. An explicit absolute GIT_DIR disables all
  // repository discovery — the write physically cannot escape the fixture.
  env.GIT_DIR = path.join(abs, '.git');
  env.GIT_WORK_TREE = abs;
  // Belt-and-suspenders: even if something ignored GIT_DIR, forbid any upward walk
  // from crossing the fixture boundary.
  env.GIT_CEILING_DIRECTORIES = abs;
  return env;
}

/** Options for {@link runGitFixture}: any spawnSync option plus `extraEnv`. */
export type RunGitFixtureOptions = Partial<
  Omit<SpawnSyncOptionsWithStringEncoding, 'cwd' | 'env'>
> & {
  /** Extra env (identity, dates, …) merged before the fixture pins are applied. */
  extraEnv?: NodeJS.ProcessEnv;
};

/**
 * Run `git <args>` pinned to `fixtureDir` — cwd is the fixture and the env is the
 * scrubbed, fixture-pinned env from {@link gitFixtureEnv}. Non-throwing: returns
 * the raw spawnSync result so callers keep their own status/stdout handling.
 */
export function runGitFixture(
  fixtureDir: string,
  args: string[],
  opts: RunGitFixtureOptions = {},
): SpawnSyncReturns<string> {
  const { extraEnv, ...spawnOpts } = opts;
  return spawnSync('git', args, {
    cwd: path.resolve(fixtureDir),
    encoding: 'utf-8',
    ...spawnOpts,
    env: gitFixtureEnv(fixtureDir, extraEnv),
  });
}
