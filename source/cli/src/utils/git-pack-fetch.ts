import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * source/cli/src/utils/git-pack-fetch.ts — the git half of installing a package
 * from someone else's repository: clone a source into a directory the caller
 * already made, read a local checkout's origin, and list a source's published
 * package tags.
 *
 * This module runs git and NOTHING else. It writes no file and creates no
 * directory of its own — the caller supplies `destDir`, and the copy/lock writing
 * lives in the persistence layer. That split is not tidiness: a helper here may
 * not touch the filesystem at all, and one module doing both would have to live
 * somewhere that permits neither cleanly.
 *
 * Every invocation passes git an ARGUMENT ARRAY through `execFile` — never a
 * concatenated command string and never a shell. A package URL and a tag are
 * attacker-chosen text, so a shell would make `$(…)`, backticks, and `;` in
 * either one a command-execution surface. The argument form closes it, and every
 * call additionally puts `--` before the first caller-supplied value so a source
 * beginning with `-` can never be read as a git option.
 */

const execFilep = promisify(execFile);

/** How long any single git invocation may run before it is killed. */
const GIT_TIMEOUT_MS = 60_000;

export type GitFetchResult =
  | { ok: true }
  | { ok: false; reason: 'unreachable' | 'ref-missing' | 'failed'; detail: string };

/**
 * Reduce git's stderr to ONE short line, suitable to quote as context inside a
 * message the CLI composes.
 *
 * Never the whole stream and never a stack: git prints progress, advice blocks
 * and sometimes a URL with credentials in it, and an agent reading a wall of that
 * cannot tell what to do next. The caller wraps this in its own what/why/next, so
 * the quoted line is context for a sentence the CLI wrote, not the message itself.
 */
function gitDetail(err: unknown): string {
  const stderr = typeof (err as { stderr?: unknown })?.stderr === 'string' ? (err as { stderr: string }).stderr : '';
  const stdout = typeof (err as { stdout?: unknown })?.stdout === 'string' ? (err as { stdout: string }).stdout : '';
  const raw = (stderr || stdout || (err instanceof Error ? err.message : String(err))).trim();
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('Cloning into') && !line.startsWith('remote:'));
  // The FATAL line first, wherever it sits. git routinely prints advisory noise
  // before the real cause — cloning a path on the same disk emits a `warning:`
  // about --depth being ignored, and taking the first line would report that
  // warning as the reason a missing tag failed.
  const fatal = lines.find((line) => line.startsWith('fatal:') || line.startsWith('error:'));
  const substantive = fatal ?? lines.find((line) => !line.startsWith('warning:')) ?? lines[0] ?? '';
  return substantive.length > 200 ? `${substantive.slice(0, 200)}…` : substantive;
}

/** True when git's failure reads as "could not reach the other end" rather than "the ref is not there". */
function classify(detail: string): 'unreachable' | 'ref-missing' | 'failed' {
  const lower = detail.toLowerCase();
  if (
    lower.includes('could not resolve host') ||
    lower.includes('connection refused') ||
    lower.includes('failed to connect') ||
    lower.includes('could not read from remote repository') ||
    lower.includes('timed out') ||
    lower.includes('network is unreachable') ||
    lower.includes('repository not found') ||
    // git's wording for a local path that is not a repository. From the caller's
    // side that is the same fact as a URL that did not answer: there is nothing
    // to fetch there. The command layer is what turns it into the right sentence,
    // because only it knows whether the source was a path on this machine.
    lower.includes('does not exist') ||
    lower.includes("does not appear to be a git repository")
  ) {
    return 'unreachable';
  }
  if (lower.includes('remote branch') || lower.includes('not found in upstream') || lower.includes('unknown revision')) {
    return 'ref-missing';
  }
  return 'failed';
}

/**
 * Shallow-clone `source` into `destDir`, optionally at `ref`.
 *
 * `--depth 1` because a package install needs one tree, never the history behind
 * it, and a marketplace's history can be arbitrarily large. Failure is returned,
 * never thrown: the caller has to clean up the directory it created either way,
 * and a rejected promise would make the cleanup path the exceptional one.
 */
export async function clonePackageSource(
  source: string,
  destDir: string,
  ref?: string,
): Promise<GitFetchResult> {
  const args = ['clone', '--depth', '1', '--no-tags', '--quiet'];
  if (ref !== undefined && ref !== '') args.push('--branch', ref);
  args.push('--', source, destDir);
  try {
    await execFilep('git', args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true };
  } catch (err) {
    const detail = gitDetail(err);
    return { ok: false, reason: classify(detail), detail };
  }
}

/**
 * The `origin` URL of the git checkout at `dir`, or null when there is none.
 *
 * This is how a package installed from a LOCAL directory gets an identity: the
 * directory itself says which repository it is a working copy of. A directory
 * that is not a checkout, or one with no origin, returns null — and the caller
 * then has to be told to name the identity explicitly rather than inventing one.
 */
export async function readOriginUrl(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFilep('git', ['remote', 'get-url', 'origin'], {
      cwd: dir,
      timeout: GIT_TIMEOUT_MS,
    });
    const url = stdout.trim();
    return url === '' ? null : url;
  } catch {
    return null;
  }
}

/**
 * Every version tag `source` publishes for the package `packageName`, as bare
 * semver strings, newest LAST (caller sorts if it needs otherwise).
 *
 * A source that cannot be reached returns null — DISTINCT from an empty array,
 * which means "reachable, publishes no tag for this package". The attention feed
 * relies on that difference: an unreachable source must produce silence, never an
 * item claiming there is no newer version.
 */
export async function listPackageVersionTags(
  source: string,
  packageName: string,
): Promise<string[] | null> {
  try {
    const { stdout } = await execFilep('git', ['ls-remote', '--tags', '--refs', '--', source], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    const prefix = `refs/tags/pack/${packageName}@`;
    const versions: string[] = [];
    for (const line of stdout.split('\n')) {
      const tabIndex = line.indexOf('\t');
      if (tabIndex < 0) continue;
      const ref = line.slice(tabIndex + 1).trim();
      if (ref.startsWith(prefix)) versions.push(ref.slice(prefix.length));
    }
    return versions;
  } catch {
    return null;
  }
}

/** The tag a marketplace publishes for one version of one package. */
export function packageVersionTag(packageName: string, version: string): string {
  return `pack/${packageName}@${version}`;
}
