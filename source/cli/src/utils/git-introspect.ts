import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Argument-vector form (no shell): git args are passed as an array, so a ref or
// file path containing shell metacharacters ($, `, ;, (), …) is treated as a
// literal argument and can never be interpreted by a shell. `filePath` here is
// derived from a caller-supplied node path, so shell interpolation would be a
// command-injection vector — the array form closes it. Mirrors utils/git.ts.
const execFilep = promisify(execFile);

/** Returns true if `ref` resolves to a merge commit (>= 2 parents). */
export async function isMergeCommit(repoCwd: string, ref: string): Promise<boolean> {
  try {
    const { stdout } = await execFilep('git', ['rev-list', '--parents', '-n', '1', ref], {
      cwd: repoCwd,
    });
    const parts = stdout.trim().split(/\s+/);
    return parts.length >= 3;
  } catch {
    return false;
  }
}

/** Returns parent SHAs of the merge commit at `ref`. Throws on non-merge. */
export async function getMergeParents(repoCwd: string, ref: string): Promise<string[]> {
  const { stdout } = await execFilep('git', ['rev-list', '--parents', '-n', '1', ref], {
    cwd: repoCwd,
  });
  const parts = stdout.trim().split(/\s+/);
  if (parts.length < 3) {
    throw new Error(`${ref} is not a merge commit (has ${parts.length - 1} parent(s))`);
  }
  return parts.slice(1);
}

/** Returns the merge-base SHA of two refs. */
export async function getMergeBase(repoCwd: string, refA: string, refB: string): Promise<string> {
  const { stdout } = await execFilep('git', ['merge-base', refA, refB], { cwd: repoCwd });
  return stdout.trim();
}

/**
 * Returns the content of `filePath` at the given `ref`.
 * Returns empty string if the file does not exist at that ref.
 */
export async function getFileAtRef(
  repoCwd: string,
  ref: string,
  filePath: string,
): Promise<string> {
  try {
    const { stdout } = await execFilep('git', ['show', `${ref}:${filePath}`], {
      cwd: repoCwd,
      maxBuffer: 100 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    // `git show` prints a gettext-translated fatal message when the path is
    // absent at the ref, so classifying the failure by matching English stderr
    // text ("does not exist", …) silently breaks under a non-English locale and
    // rethrows what should be the documented empty-string result. Detect the
    // absence structurally instead: `git ls-tree` lists the path at `ref` with a
    // zero exit iff `ref` resolves; empty output means the path does not exist
    // there. A non-empty listing (path present but unreadable) or a failing
    // ls-tree (ref itself invalid) is a genuine error — rethrow the original.
    try {
      const { stdout } = await execFilep('git', ['ls-tree', ref, '--', filePath], {
        cwd: repoCwd,
      });
      if (stdout.trim() === '') return '';
    } catch {
      // ref does not resolve — fall through to rethrow the original error.
    }
    throw err;
  }
}
