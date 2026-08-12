import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toPosixPath } from './posix.js';

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

/**
 * One rename edge: the old path invalidated and the new path created by it.
 * `from`/`to` are repo-relative POSIX, matching {@link ChangedFiles.files}.
 */
export interface RenamePair {
  from: string;
  to: string;
}

/**
 * The touched set for progressive-mode scoping: every repo-relative POSIX path
 * that differs between a merge-base and the current worktree, from EITHER of
 * two sources — uncommitted worktree/index state, or committed history since
 * the merge-base. `files` includes BOTH sides of every rename (the old path is
 * invalidated, the new path is a new subject — treating either alone would
 * silently under-scope a rename) and includes deleted paths (a caller decides
 * whether "touched but gone" still needs gating, e.g. to catch a rule that
 * used to apply and must be confirmed intentionally dropped). `renames` is the
 * subset of that same information callers need in edge form (old -> new)
 * rather than as an unordered set.
 */
export interface ChangedFiles {
  files: Set<string>;
  renames: RenamePair[];
}

/**
 * Parse `git status --porcelain=v1 -z -uall` output (NUL-terminated records,
 * no shell quoting/escaping to undo — see the git-status(1) `-z` docs).
 *
 * Record shapes:
 *   - ordinary: `XY <path>` — two status chars, one separator space, then the
 *     path verbatim. `X`/`Y` are the index/worktree status chars (a space
 *     means "no change on that side"); this parser does not need to inspect
 *     them beyond checking position 0 for `R`.
 *   - rename: `R  <to>` immediately followed by a SEPARATE raw `<from>`
 *     record (no `XY ` prefix on the second one) — the renamed-FROM path packs
 *     AFTER the renamed-TO path here. This is the opposite field order from
 *     {@link parseDiffNameStatusZ}'s rename record, which is exactly why the
 *     two parsers are kept separate rather than sharing rename logic: sharing
 *     code would need a branch per caller anyway, and a shared implementation
 *     is a more tempting place to introduce a from/to mixup than two short,
 *     independently-obvious functions.
 *
 * Exported standalone (not just via {@link changedFilesAgainst}) so its
 * from/to field order can be pinned by a literal-byte unit test, independent
 * of any real git invocation.
 */
export function parsePorcelainZ(buf: Buffer): ChangedFiles {
  const files = new Set<string>();
  const renames: RenamePair[] = [];
  const tokens = buf.toString('utf8').split('\0').filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i];
    const indexStatus = record[0];
    // Position 3 skips the fixed "XY " prefix (index status, worktree status,
    // one separator space) — the path is verbatim from there, spaces and all.
    const recordPath = toPosixPath(record.slice(3));
    if (indexStatus === 'R') {
      const from = toPosixPath(tokens[++i]);
      files.add(from);
      files.add(recordPath);
      renames.push({ from, to: recordPath });
    } else {
      files.add(recordPath);
    }
  }
  return { files, renames };
}

/**
 * Parse `git diff --name-status -z <mergeBase>..HEAD` output (NUL-terminated
 * records, no shell quoting/escaping to undo — see the git-diff(1) `-z` docs).
 *
 * Record shapes:
 *   - ordinary: a status-code record (`A`, `M`, `D`, …) followed by a
 *     SEPARATE `<path>` record.
 *   - rename: an `R<score>` status record (e.g. `R091`) followed by a
 *     `<from>` record, then a `<to>` record — from BEFORE to, the opposite
 *     order from {@link parsePorcelainZ}'s rename record. See that function's
 *     doc comment for why the two parsers do not share rename logic.
 *
 * Exported standalone (not just via {@link changedFilesAgainst}) so its
 * from/to field order can be pinned by a literal-byte unit test, independent
 * of any real git invocation.
 */
export function parseDiffNameStatusZ(buf: Buffer): ChangedFiles {
  const files = new Set<string>();
  const renames: RenamePair[] = [];
  const tokens = buf.toString('utf8').split('\0').filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (status[0] === 'R') {
      const from = toPosixPath(tokens[++i]);
      const to = toPosixPath(tokens[++i]);
      files.add(from);
      files.add(to);
      renames.push({ from, to });
    } else {
      const recordPath = toPosixPath(tokens[++i]);
      files.add(recordPath);
    }
  }
  return { files, renames };
}

/**
 * The touched set between `mergeBase` and the current worktree: the union of
 * uncommitted changes (`git status --porcelain=v1 -z -uall` — staged,
 * unstaged, AND untracked, with `-uall` so a new file inside a new directory
 * is listed itself rather than collapsed to the directory) and committed
 * changes since the merge-base (`git diff --name-status -z
 * <mergeBase>..HEAD`). Each source is read with its own NUL-delimited parser
 * ({@link parsePorcelainZ}, {@link parseDiffNameStatusZ}) since the two
 * encode a rename in different field orders; this function only unions their
 * already-normalized results.
 *
 * Returns `null` on ANY failure — a non-zero git exit (e.g. `mergeBase` does
 * not resolve, `repoCwd` is not a git repository), a git binary that cannot be
 * spawned, or output that fails to parse. Never throws and never returns a
 * partial set: a caller that cannot trust the touched set has nothing safer
 * to do with half of it than with none of it, so the documented contract is
 * "fall back to the global (whole-repo) gate" on `null`, not "gate on
 * whatever came back."
 *
 * Does NOT translate paths relative to any root other than the git top level
 * (e.g. a graph root nested below it) — a caller with a different root
 * reconciles that itself.
 */
export async function changedFilesAgainst(
  repoCwd: string,
  mergeBase: string,
): Promise<ChangedFiles | null> {
  try {
    const [statusResult, diffResult] = await Promise.all([
      execFilep('git', ['status', '--porcelain=v1', '-z', '-uall'], {
        cwd: repoCwd,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'buffer',
      }),
      execFilep('git', ['diff', '--name-status', '-z', `${mergeBase}..HEAD`], {
        cwd: repoCwd,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'buffer',
      }),
    ]);
    const statusParsed = parsePorcelainZ(statusResult.stdout);
    const diffParsed = parseDiffNameStatusZ(diffResult.stdout);
    const files = new Set<string>([...statusParsed.files, ...diffParsed.files]);
    const renames = [...statusParsed.renames, ...diffParsed.renames];
    return { files, renames };
  } catch {
    return null;
  }
}
