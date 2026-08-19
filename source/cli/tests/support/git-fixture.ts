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

// =============================================================================
// Deterministic-history extension (spec §20.2 / design §13.2's named
// prerequisite for golden git repositories under
// tests/fixtures/roots/golden/**): scripted histories whose commit SHAs are
// reproducible across machines and runs, so a committed `git bundle` can be
// asserted equal to a fresh replay of its builder spec.
//
// ADDITIVE ONLY. `gitFixtureEnv` and `runGitFixture` above are UNCHANGED —
// every existing caller keeps its current behavior byte-for-byte. `TZ=UTC`
// and the pinned author/committer dates live ONLY in the exports below, never
// in the shared env-building block those two functions share.
// =============================================================================

/**
 * Fixed epoch every deterministic history counts commits from —
 * 2024-01-01T00:00:00Z. The exact instant carries no meaning beyond being the
 * same on every machine that builds the history; it is never compared against
 * a real calendar date.
 */
const DETERMINISTIC_EPOCH_MS = Date.parse('2024-01-01T00:00:00Z');

/**
 * Wall-clock spacing between two consecutive commits in a deterministic
 * history — 60 seconds, comfortably above git's one-second timestamp
 * resolution so two commits scripted in the same history can never collide
 * on the same instant.
 */
const DETERMINISTIC_COMMIT_INTERVAL_MS = 60_000;

/**
 * The ISO-8601 "…Z" timestamp (spec §20.2's required form for
 * `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`) for the commit at `commitIndex`
 * (0-based, in the order a scripted history makes its commits): the fixed
 * epoch plus one interval per prior commit. The same index always yields the
 * same instant, regardless of when or where the history is built.
 */
export function deterministicCommitDate(commitIndex: number): string {
  return new Date(DETERMINISTIC_EPOCH_MS + commitIndex * DETERMINISTIC_COMMIT_INTERVAL_MS).toISOString();
}

/**
 * `gitFixtureEnv`, layered with the remaining knobs a deterministic history's
 * commit operations need (spec §20.2): `TZ=UTC` (so a date with no explicit
 * offset can never be interpreted against the host's local zone),
 * `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` pinned to `commitIndex`'s instant,
 * and `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` both forced to `/dev/null`.
 *
 * The config pin exists because `gitFixtureEnv` alone still lets the child
 * `git` process READ the host's global/system config — nothing scrubs
 * `core.autocrlf`, `commit.gpgsign`, `init.templateDir`, or `core.hooksPath`.
 * `core.autocrlf=true` on the host alone is enough to change every blob (and
 * therefore every tree and commit) SHA a deterministic history produces,
 * which defeats the entire point of this module. Pointing both config search
 * paths at `/dev/null` (git's documented way to disable a config level
 * outright) makes a deterministic history depend only on git's built-in
 * defaults plus what this module itself sets — never on whatever is on the
 * machine building it. This pin is intentionally NOT in `gitFixtureEnv`
 * itself: existing (non-deterministic) fixture callers keep inheriting host
 * config exactly as before, byte-identical to their pre-existing behavior.
 *
 * `extraEnv` is folded into the underlying `gitFixtureEnv` call — meaning it
 * is merged BEFORE that function's own isolation pins (`GIT_DIR` etc.), the
 * same safety order `gitFixtureEnv` documents for its own `extraEnv`
 * parameter — so a caller can vary per-commit identity (author name/email)
 * through it without any risk of weakening the fixture pin. `TZ`/the two
 * dates/the config pins are applied AFTER that, so they always win: a
 * deterministic history's dates and config isolation are never left open to
 * override.
 */
export function deterministicGitFixtureEnv(
  fixtureDir: string,
  commitIndex: number,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const date = deterministicCommitDate(commitIndex);
  return {
    ...gitFixtureEnv(fixtureDir, extraEnv),
    TZ: 'UTC',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

/**
 * `runGitFixture`, using {@link deterministicGitFixtureEnv} in place of
 * {@link gitFixtureEnv} — for any git operation inside a deterministic
 * history that itself creates a commit (or otherwise needs the pinned
 * date/timezone). A deliberately separate function body from
 * `runGitFixture`'s own, rather than a refactor of it, so that function's
 * behavior stays untouched for every existing caller.
 */
export function runDeterministicGitFixture(
  fixtureDir: string,
  args: string[],
  commitIndex: number,
  opts: RunGitFixtureOptions = {},
): SpawnSyncReturns<string> {
  const { extraEnv, ...spawnOpts } = opts;
  return spawnSync('git', args, {
    cwd: path.resolve(fixtureDir),
    encoding: 'utf-8',
    ...spawnOpts,
    env: deterministicGitFixtureEnv(fixtureDir, commitIndex, extraEnv),
  });
}

/**
 * `git init` for a deterministic history: pins the default branch via
 * `-c init.defaultBranch=main` (spec §20.2's third determinism knob), rather
 * than relying on the host's `init.defaultBranch` config or the installed
 * git version's own default — so the branch a fresh clone of the resulting
 * history checks out is the same on every machine.
 *
 * Runs through {@link runDeterministicGitFixture} (not the plain
 * `runGitFixture`), at commit index 0 — `init` never reads
 * `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`, so the index is inert here, but
 * routing through the deterministic runner is what applies `TZ=UTC` and the
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` scrubbing (see
 * {@link deterministicGitFixtureEnv}) at init time too, not just at commit
 * time — `init` itself consults host config (e.g. `init.defaultBranch`, were
 * it not pinned explicitly here) and CAN write hook files from a host
 * `init.templateDir`, so isolating it the same way as every later commit
 * closes that gap rather than leaving init as the one unpinned step in an
 * otherwise fully deterministic history.
 */
export function initDeterministicGitFixture(fixtureDir: string): SpawnSyncReturns<string> {
  return runDeterministicGitFixture(fixtureDir, ['-c', 'init.defaultBranch=main', 'init', '-q'], 0);
}
