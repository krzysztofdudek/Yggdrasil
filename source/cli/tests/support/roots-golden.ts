// =============================================================================
// Golden git repositories for the roots convention-mining engine: a data
// shape describing a scripted commit history (a "golden spec"), a builder
// that replays it through the deterministic git-fixture, and an equivalence
// check that a committed `git bundle` snapshot still matches what the spec
// produces.
//
// WHY BUNDLES, NOT DIRECTORIES
//   A working git repository cannot be committed as a plain directory tree —
//   its own `.git` would become a gitlink (a submodule-style reference)
//   inside this repository, not a real nested history. Goldens instead ship
//   as TWO artifacts under tests/fixtures/roots/golden/<name>/: the builder
//   spec (this module's GoldenRepoSpec, serialized as JSON) and a
//   `git bundle` — a single file holding the packed history plus the refs it
//   points at, which `git init` + `git fetch <bundle> <refspec>` turns back
//   into a real repository. Spec and bundle are two independent
//   representations of the same history; assertGoldenBundleEquivalence below
//   is what proves they never drift apart from one another (spec §20.2,
//   design §13.2).
//
// This module imports ONLY Node builtins and tests/support/git-fixture.ts —
// never anything from src/** — the same rule git-fixture.ts itself follows,
// so e2e suites (which must stay on the CLI's public surface) can use it
// freely.
// =============================================================================

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deterministicCommitIndexAt, initDeterministicGitFixture, runDeterministicGitFixture, runGitFixture } from './git-fixture.js';

/** One commit in a golden repository's scripted history. */
export interface GoldenCommit {
  /**
   * Short author key (e.g. "alice") — mapped to a deterministic synthetic
   * identity (`<author>@golden.test`), never a real name or address, so the
   * commit author varies without depending on who happens to build it.
   */
  author: string;
  /**
   * Repo-relative path → full file content, for every file this commit
   * writes or overwrites. A path not listed here keeps whatever content the
   * previous commit left it with — a golden spec only ever adds, rewrites,
   * renames or deletes files (the last two via {@link GoldenCommit.renames}
   * and {@link GoldenCommit.deletes} below), which is all the mining
   * engine's goldens need.
   */
  files: Record<string, string>;
  /** The commit message. */
  message: string;
  /**
   * Day offset (from git-fixture.ts's fixed epoch) this commit is dated at.
   * Absent = this commit's own position in the `commits` array IS its
   * commit index — the existing fixed-epoch, 60-second-per-index spacing
   * every landed golden spec already depends on — so a spec that never sets
   * this field keeps its exact current commit SHAs. Set it to script real
   * time depth into a golden's history: `buildGoldenRepo` converts it to a
   * commit index via `deterministicCommitIndexAt` (git-fixture.ts), never
   * through `extraEnv` (see that function's own warning on why that path
   * silently discards a date).
   */
  dayOffset?: number;
  /**
   * Repo-relative paths this commit removes — via `rmSync` followed by
   * `git add -A`, so the removal reaches the walk as a real deletion record,
   * not merely an emptied file. Applied after `files` are written, before
   * the commit.
   */
  deletes?: string[];
  /**
   * Path renames this commit performs, each executed as `git mv <from>
   * <to>` BEFORE this commit's `files` are written — so a rename and a
   * content change landing on the (post-rename) path can share one commit.
   * `from`/`to` may each name a single file or a whole directory (`git mv`
   * handles both the same way the real command line does).
   */
  renames?: { from: string; to: string }[];
}

/** A golden repository's whole scripted history, in commit order. */
export interface GoldenRepoSpec {
  /**
   * Short identifying name — also the directory name under
   * tests/fixtures/roots/golden/ once a golden built from this spec is
   * committed.
   */
  name: string;
  commits: GoldenCommit[];
}

/** Deterministic author/committer identity for a golden commit's `author` key. */
function authorEnv(author: string): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: `${author}@golden.test`,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: `${author}@golden.test`,
  };
}

/** Run one deterministic git-fixture command, throwing with the real stderr/stdout on failure. */
function runOrThrow(fixtureDir: string, args: string[], commitIndex: number, extraEnv: NodeJS.ProcessEnv = {}): void {
  const r = runDeterministicGitFixture(fixtureDir, args, commitIndex, { extraEnv });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${fixtureDir}: ${r.stderr}${r.stdout}`);
  }
}

/**
 * The commit index a spec's commit N resolves to: its own `dayOffset`
 * (converted via `deterministicCommitIndexAt`) when set, otherwise N itself
 * — the existing fixed-epoch, 60-second-per-index spacing. This is the
 * single conversion {@link buildGoldenRepo} and
 * {@link assertAscendingDayOffsets} both read from, so the guard checks
 * exactly the ordering the build will actually produce.
 */
function resolvedCommitIndex(commit: GoldenCommit, arrayIndex: number): number {
  return commit.dayOffset !== undefined ? deterministicCommitIndexAt(commit.dayOffset) : arrayIndex;
}

/**
 * Commit-index units per day, derived from {@link deterministicCommitIndexAt}
 * itself (never a re-typed literal) — used only to render a resolved commit
 * index back into a "day" figure for this guard's own error message.
 */
const COMMITS_PER_DAY = deterministicCommitIndexAt(1) - deterministicCommitIndexAt(0);

/**
 * `buildGoldenRepo` commits a spec's `commits` array in order, each dated
 * from {@link resolvedCommitIndex}. That only produces a history whose
 * every derived quantity (`stable_days`, `churnEarlyDays` windows, …) is
 * hand-derivable from the day offsets written on the spec's own page when
 * the resolved sequence never dips — a dip does not break the WALK (a
 * linear chain's parent-before-child order is unaffected by its dates, and
 * the replay is a function of the commit set regardless), it breaks the
 * READER's ability to check the spec's own arithmetic by hand. This throws
 * BEFORE any repository is created, naming the golden, the offending commit
 * index, and the two day figures that dipped.
 */
function assertAscendingDayOffsets(spec: GoldenRepoSpec): void {
  let prevResolved = -Infinity;
  let prevDay: number | undefined;
  spec.commits.forEach((commit, index) => {
    const resolved = resolvedCommitIndex(commit, index);
    const day = resolved / COMMITS_PER_DAY;
    if (resolved < prevResolved) {
      throw new Error(
        `golden "${spec.name}": dayOffset sequence dips at commit index ${index} — resolved day ${day} is earlier than the previous commit's resolved day ${prevDay}. Every commit's dayOffset (or its index-derived day, when absent) must be >= the previous commit's.`,
      );
    }
    prevResolved = resolved;
    prevDay = day;
  });
}

/**
 * Replay a golden spec through the deterministic git-fixture into a fresh
 * temp directory: `git init` with the pinned default branch, then one commit
 * per {@link GoldenCommit}, each dated from {@link resolvedCommitIndex} — so
 * the same spec always produces the same history, the same commit SHAs, on
 * every machine (proven directly by
 * tests/unit/roots/git-fixture-determinism.test.ts for the underlying
 * primitives, and by {@link assertGoldenBundleEquivalence} below for any one
 * committed golden). Throws {@link assertAscendingDayOffsets}'s error, before
 * creating anything, when a spec's resolved day sequence dips.
 *
 * Returns the absolute path to the built repository. The caller owns
 * cleanup (`rmSync(dir, { recursive: true, force: true })`) — this function
 * does not track or remove what it builds, the same division of labor
 * `git-fixture.ts` and `progressive-fixture.ts` already use between builder
 * and caller.
 */
export function buildGoldenRepo(spec: GoldenRepoSpec): string {
  assertAscendingDayOffsets(spec);
  const dir = mkdtempSync(path.join(tmpdir(), `yg-golden-${spec.name}-`));
  const init = initDeterministicGitFixture(dir);
  if (init.status !== 0) {
    throw new Error(`git init failed in ${dir}: ${init.stderr}${init.stdout}`);
  }
  spec.commits.forEach((commit, index) => {
    const commitIndex = resolvedCommitIndex(commit, index);
    for (const rename of commit.renames ?? []) {
      const target = path.join(dir, rename.to);
      mkdirSync(path.dirname(target), { recursive: true });
      const mv = runDeterministicGitFixture(dir, ['mv', rename.from, rename.to], commitIndex);
      if (mv.status !== 0) {
        throw new Error(`git mv ${rename.from} ${rename.to} failed in ${dir}: ${mv.stderr}${mv.stdout}`);
      }
    }
    for (const [relPath, content] of Object.entries(commit.files)) {
      const target = path.join(dir, relPath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf-8');
    }
    for (const relPath of commit.deletes ?? []) {
      rmSync(path.join(dir, relPath), { force: true });
    }
    runOrThrow(dir, ['add', '-A'], commitIndex);
    runOrThrow(dir, ['commit', '-q', '-m', commit.message], commitIndex, authorEnv(commit.author));
  });
  return dir;
}

/** `git rev-parse HEAD` in `dir`, throwing with the real stderr/stdout on failure. */
function headSha(dir: string): string {
  const r = runGitFixture(dir, ['rev-parse', 'HEAD']);
  if (r.status !== 0) {
    throw new Error(`git rev-parse HEAD failed in ${dir}: ${r.stderr}${r.stdout}`);
  }
  return r.stdout.trim();
}

/** Every path `git` tracks in `dir`, sorted — the working tree's real content list, `.git` excluded by construction. */
function listTrackedFiles(dir: string): string[] {
  const r = runGitFixture(dir, ['ls-files']);
  if (r.status !== 0) {
    throw new Error(`git ls-files failed in ${dir}: ${r.stderr}${r.stdout}`);
  }
  return r.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .sort();
}

/**
 * Clone a committed golden bundle into a fresh temp directory: `git init`
 * (pinned default branch) then `git fetch` every ref the bundle carries —
 * NOT `git clone` directly, because `git clone`'s own repository-discovery
 * step is the one git operation this fixture toolkit cannot pin ahead of
 * time (the target directory does not exist yet, so there is nothing to set
 * `GIT_DIR` to before the command runs).
 *
 * The fetch lands in `refs/remotes/bundle/*`, NOT `refs/heads/*` — fetching
 * directly into `refs/heads/*` collides with the branch `init` just checked
 * out (`main`, pinned by {@link initDeterministicGitFixture}): a non-bare
 * repository's `HEAD` is already on `refs/heads/main`, and git refuses to
 * fetch INTO the branch checked out in a non-bare work tree ("refusing to
 * fetch into branch ... checked out"). `progressive-fixture.ts`'s
 * `shallowCheckout` looks similar but does NOT hit this: it fetches exactly
 * one named branch straight into `refs/heads/<branch>`, and that branch name
 * is never the fresh repo's own (unpinned, unborn) default branch — so there
 * is no name collision for it to run into. This function has no such luxury:
 * it must pull EVERY ref the bundle carries via a wildcard, one of which
 * (`main`) is guaranteed to collide with what `init` already checked out.
 * The fix is to fetch into a differently-named remote-tracking namespace,
 * then move `main` onto it explicitly with `checkout -B`, which IS allowed
 * to update the checked-out branch.
 */
function cloneGoldenBundle(bundlePath: string, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-golden-clone-${label}-`));
  const init = initDeterministicGitFixture(dir);
  if (init.status !== 0) {
    throw new Error(`git init failed in ${dir}: ${init.stderr}${init.stdout}`);
  }
  const fetch = runGitFixture(dir, ['fetch', '-q', bundlePath, 'refs/heads/*:refs/remotes/bundle/*']);
  if (fetch.status !== 0) {
    throw new Error(`git fetch ${bundlePath} failed in ${dir}: ${fetch.stderr}${fetch.stdout}`);
  }
  const checkout = runGitFixture(dir, ['checkout', '-q', '-B', 'main', 'refs/remotes/bundle/main']);
  if (checkout.status !== 0) {
    throw new Error(`git checkout main failed in ${dir}: ${checkout.stderr}${checkout.stdout}`);
  }
  return dir;
}

/**
 * Assert that a committed golden bundle still matches what `spec` produces:
 * rebuild the spec into a fresh repository, clone the bundle into another,
 * and compare HEAD SHA plus every tracked file's content between the two.
 * Throws a descriptive `Error` naming exactly what diverged on any mismatch;
 * returns silently when the two are equivalent. Both temp repositories are
 * removed before returning or throwing.
 *
 * This is the check that keeps a golden's two committed representations —
 * the builder spec and the `git bundle` — from drifting apart: an edit to
 * one without the other fails here rather than surfacing as a silent
 * difference between what a test reads and what the bundle actually
 * contains.
 */
export function assertGoldenBundleEquivalence(spec: GoldenRepoSpec, bundlePath: string): void {
  const rebuilt = buildGoldenRepo(spec);
  const cloned = cloneGoldenBundle(bundlePath, spec.name);
  try {
    const rebuiltSha = headSha(rebuilt);
    const clonedSha = headSha(cloned);
    if (rebuiltSha !== clonedSha) {
      throw new Error(
        `golden "${spec.name}": HEAD sha mismatch — rebuilt from spec = ${rebuiltSha}, committed bundle ${bundlePath} = ${clonedSha}. The bundle is stale: rebuild it from the current spec.`,
      );
    }

    const rebuiltFiles = listTrackedFiles(rebuilt);
    const clonedFiles = listTrackedFiles(cloned);
    const sameFileList =
      rebuiltFiles.length === clonedFiles.length && rebuiltFiles.every((f, i) => f === clonedFiles[i]);
    if (!sameFileList) {
      throw new Error(
        `golden "${spec.name}": tracked file list mismatch — rebuilt = [${rebuiltFiles.join(', ')}], bundle = [${clonedFiles.join(', ')}].`,
      );
    }

    for (const relPath of rebuiltFiles) {
      const rebuiltContent = readFileSync(path.join(rebuilt, relPath), 'utf-8');
      const clonedContent = readFileSync(path.join(cloned, relPath), 'utf-8');
      if (rebuiltContent !== clonedContent) {
        throw new Error(
          `golden "${spec.name}": file content mismatch at ${relPath} between the rebuilt spec and the committed bundle.`,
        );
      }
    }
  } finally {
    rmSync(rebuilt, { recursive: true, force: true });
    rmSync(cloned, { recursive: true, force: true });
  }
}
