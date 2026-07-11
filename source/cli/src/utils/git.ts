import { execFileSync } from 'node:child_process';
import { toPosixPath } from './posix.js';

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
