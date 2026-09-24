import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { toPosixPath } from './posix.js';

const execFileAsync = promisify(execFile);

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

/**
 * Returns the current commit's full SHA (`git rev-parse HEAD`), or undefined
 * when it cannot be resolved — not a git repository, no commits yet, or git
 * missing from PATH. Mirrors getLastCommitTimestamp's fail-soft try/catch: any
 * git error resolves to undefined, never a fabricated value, and never leaks
 * git's own error text (stdio is fully piped, never inherited). The length is
 * whatever the repository's object format produces — 40 hex chars for sha1, 64
 * for sha256 — never checked or assumed here.
 */
export function getHeadSha(projectRoot: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const sha = out.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A digest of a working tree's state under `dir`, or null when `dir` is not in
 * a git repository or git fails: the HEAD commit, every changed or untracked
 * path under `dir` (untracked files one by one, renames as plain changes) with
 * its size and modification time — so a second edit to an already-modified
 * file still moves the digest — and the size and modification time of each of
 * `extraFiles` (absolute paths git does not report, such as gitignored files
 * the caller depends on). Equal digests mean nothing git or those files can
 * show has changed. Asynchronous, because a long-lived caller (the portal
 * server) must not block its event loop on a large working tree; the git calls
 * are argv-only. `stamp` gives a file's size and modification time (or any
 * token that changes when the file does) — supplied by the caller, which owns
 * the file-system access.
 */
export async function worktreeFingerprint(
  dir: string,
  extraFiles: readonly string[],
  stamp: (absPath: string) => Promise<string>,
): Promise<string | null> {
  const run = async (args: string[]): Promise<string> =>
    (await execFileAsync('git', ['-C', dir, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf-8' })).stdout;
  let head: string;
  let top: string;
  let status: string;
  try {
    head = (await run(['rev-parse', 'HEAD'])).trim();
    // Porcelain paths are relative to the repository's top level, which is not
    // `dir` when `dir` is a subdirectory; the pathspec keeps changes elsewhere
    // in that repository out of the digest, and -z keeps odd file names whole.
    top = (await run(['rev-parse', '--show-toplevel'])).trim();
    status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.']);
  } catch {
    return null;
  }
  const h = createHash('sha256');
  h.update(`head\0${head}\0`);
  for (const record of status.split('\0')) {
    if (record.length < 4) continue;
    h.update(`${record}\0${await stamp(path.join(top, record.slice(3)))}\0`);
  }
  for (const file of extraFiles) h.update(`${toPosixPath(file)}\0${await stamp(file)}\0`);
  return h.digest('hex');
}

/**
 * Whether git tracks `relativePath` (relative to `projectRoot`), false when it
 * does not, when `projectRoot` is not in a git repository, or when git fails.
 */
export function isTrackedByGit(projectRoot: string, relativePath: string): boolean {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', toPosixPath(relativePath)], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * A file's bytes as the last commit (HEAD) holds them, as text; null when
 * there is no repository, no commit yet, or HEAD has no such file. For a
 * finding whose truth depends on what is already in history — a credential
 * committed, versus one only typed into the working tree.
 */
export function readHeadFile(projectRoot: string, relativePath: string): string | null {
  try {
    return execFileSync('git', ['show', `HEAD:${toPosixPath(relativePath)}`], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}
