import { execFileSync } from 'node:child_process';
import { toPosixPath } from './posix.js';
import { parsePorcelainZ } from './git-introspect.js';

/**
 * Returns Unix timestamp (seconds) of the last commit touching the given path,
 * or null if not a git repo or path has no commits.
 * Path is relative to projectRoot.
 */
export function getLastCommitTimestamp(projectRoot: string, relativePath: string): number | null {
  const normalized = toPosixPath(relativePath.trim());
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', normalized], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const ts = parseInt(out.trim(), 10);
    return Number.isNaN(ts) ? null : ts;
  } catch {
    return null;
  }
}

/**
 * Returns Unix timestamp (seconds) of the FIRST commit that ADDED the given path
 * (its creation time in version-control history), following renames, or null when
 * the timestamp cannot be established — not a git repo, a shallow clone that lacks
 * the creating commit, or a path with no add on record.
 * Path is relative to projectRoot.
 *
 * `git log --follow --diff-filter=A --format=%ct` lists every ADD of the path,
 * newest-first; the LAST line is therefore the ORIGINAL creation. Mirrors
 * getLastCommitTimestamp's fail-soft try/catch — any git error resolves to null,
 * never a fabricated value, so callers can render an honest "unknown".
 */
export function getFirstCommitTimestamp(projectRoot: string, relativePath: string): number | null {
  const normalized = toPosixPath(relativePath.trim());
  try {
    const out = execFileSync(
      'git',
      ['log', '--follow', '--diff-filter=A', '--format=%ct', '--', normalized],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const lines = out
      .trim()
      .split('\n')
      .filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;
    const ts = parseInt(lines[lines.length - 1].trim(), 10);
    return Number.isNaN(ts) ? null : ts;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// The roots model header's git trio (design `integration-design.md:140-142`,
// spec `v6-spec.md:80`): HEAD's own sha and committer timestamp, plus the list
// of paths the working tree currently differs on. Every helper below shares
// the same fail-soft contract as {@link getLastCommitTimestamp} above — `null`
// on ANY git failure (missing binary, `projectRoot` not a repository, no
// commits yet, …), never a thrown error. A repo with no git history at all
// still mines under R1-R3 (design's explicit non-git decision): the roots
// model header simply records these fields as `null`, an honest fact rather
// than a build failure.
// -----------------------------------------------------------------------------

/**
 * HEAD's full commit sha (`git rev-parse HEAD`), or `null` when it cannot be
 * determined. `git rev-parse HEAD` never SUCCEEDS with empty output — a
 * repository with no commits yet fails the command outright ("ambiguous
 * argument 'HEAD'"), which the `catch` below already turns into `null` — so
 * a successful call's trimmed output is trusted directly, with no redundant
 * empty-string re-check.
 */
export function getHeadSha(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * HEAD's committer timestamp, strict ISO-8601 (`git log -1 --format=%cI`) —
 * spec §20.2's `clock`: the HEAD committer timestamp, read once, NEVER
 * `max(last_modified)` over any replay and never wall-clock time. `null` when
 * it cannot be determined (no git, no commits yet).
 */
export function getHeadCommitterTimestamp(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Every repo-relative POSIX path the working tree currently differs on versus
 * HEAD — staged, unstaged, AND untracked (`git status --porcelain=v1 -z
 * -uall`), sorted. A rename/copy contributes BOTH its old and new path, same
 * as {@link parsePorcelainZ}'s own contract. Returns `null` (never an empty
 * array standing in for "could not tell") on any git failure — `projectRoot`
 * not a repository, git missing, or a status probe that fails for any other
 * reason. The roots model header's `dirtyHash` field folds this list's file
 * CONTENTS (excluding `.yggdrasil/roots/**`, which `index` itself writes) —
 * that hashing is the command layer's job, via the io helpers it legally
 * calls; this function only enumerates the paths.
 */
export function getDirtyFiles(projectRoot: string): string[] | null {
  try {
    const out = execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall'], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    // `posix-paths-output`: every path this public function returns is
    // routed through the node's canonical normalization helper before it
    // leaves — git's own porcelain output is already forward-slashed on a
    // POSIX host, but this function's CONTRACT (a public return value) does
    // not get to assume the host, matching getLastCommitTimestamp/
    // getFirstCommitTimestamp's own use of toPosixPath at this node.
    return [...parsePorcelainZ(out).files].map(toPosixPath).sort();
  } catch {
    return null;
  }
}
