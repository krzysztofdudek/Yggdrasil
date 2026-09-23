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
 * Default committer/author identity for every fixture git operation.
 *
 * WHY THIS IS A DEFAULT AND NOT A PER-CALL ARGUMENT: git needs an identity to
 * write a commit, and with none configured it tries to guess one from the user
 * and hostname — which it then REFUSES on a machine whose hostname carries no
 * domain, failing with `fatal: unable to auto-detect email address` and exit
 * 128. A developer's box almost always has a global identity, so a fixture that
 * relies on finding one passes locally and fails on a CI runner, which has
 * none. That is not a hermetic fixture, and hermeticity is this module's whole
 * job — the same reason it pins GIT_DIR rather than trusting discovery.
 *
 * It bites hardest where the commit is implicit. A caller writing `git commit`
 * tends to remember the identity; a caller writing `git merge` does not think
 * of itself as committing at all, right up until the merge is a real one and
 * needs a commit for it.
 *
 * Supplied as env rather than config so it applies without touching the
 * fixture's `.git/config`, and merged before `extraEnv` so a caller that wants a
 * specific identity (or a fixed author date) still wins.
 */
const FIXTURE_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'yg-test',
  GIT_AUTHOR_EMAIL: 'yg-test@fixture.test',
  GIT_COMMITTER_NAME: 'yg-test',
  GIT_COMMITTER_EMAIL: 'yg-test@fixture.test',
};

/**
 * Git configuration that keeps a fixture repository QUIET after each command.
 *
 * WHY: every `git commit` (and merge, rebase, am, ...) ends by spawning
 * `git maintenance run --auto --detach`, a background process that outlives the
 * command. When its thresholds trip it repacks, and a repack rewrites files
 * under `.git/objects/` and `.git/info/refs` (via update-server-info). The test
 * has moved on by then; its cleanup `rm -r` lists a directory, the detached
 * child drops a new file into it, and the final rmdir fails with ENOTEMPTY —
 * a test that passed reported as failed. CI saw exactly that on
 * `.git/info` and `.git/objects` of a gitlink fixture. A fixture never
 * needs housekeeping, so it is switched off at the source instead of raced.
 *
 * Supplied through GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n,
 * which git reads as command-line config for the process AND its children,
 * without touching the fixture's `.git/config` (tests that inspect it see only
 * what they wrote).
 */
export const QUIET_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['maintenance.auto', 'false'],
  ['gc.auto', '0'],
];

/**
 * Add {@link QUIET_GIT_CONFIG} to `env` in place, appending after any
 * GIT_CONFIG_COUNT entries already present (a caller's own pairs survive) and
 * skipping a key that is already set, so calling it twice is harmless.
 */
export function applyQuietGitConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  let count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const present = new Set<string>();
  for (let i = 0; i < count; i++) {
    const key = env[`GIT_CONFIG_KEY_${i}`];
    if (key) present.add(key.toLowerCase());
  }
  for (const [key, value] of QUIET_GIT_CONFIG) {
    if (present.has(key.toLowerCase())) continue;
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count}`] = value;
    count++;
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
}

/**
 * Options for removing a fixture directory in a test's cleanup.
 *
 * `maxRetries` makes `rm` retry the whole removal on ENOTEMPTY / EBUSY / EPERM,
 * re-listing the directory each time, with a linearly growing `retryDelay`
 * (50 ms, 100 ms, ... about 1.8 s in total at most). It is the second line of
 * defence behind {@link QUIET_GIT_CONFIG}: a process the test did not start
 * itself (an OS indexer, a straggling child of the CLI under test) can still
 * drop a file into a directory mid-removal. A real leak stays visible: a
 * directory that keeps refilling still fails after the last retry.
 */
export const FIXTURE_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 8,
  retryDelay: 50,
} as const;

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
  const env: NodeJS.ProcessEnv = { ...process.env, ...FIXTURE_IDENTITY, ...extraEnv };
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
  // No detached background housekeeping writing into the fixture after the
  // command returns (see QUIET_GIT_CONFIG).
  applyQuietGitConfig(env);
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
