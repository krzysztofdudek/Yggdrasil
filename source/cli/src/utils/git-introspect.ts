import { execFile, type ExecFileException } from 'node:child_process';
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
 * What a commit-and-path pair resolved to: the file's content there, or the
 * reason it could not be read.
 *
 * Absence and emptiness are told apart deliberately. `git show` returns the same
 * empty string for "no such path at that commit" and "the file is there and is
 * empty", and a caller taking code out of history has to refuse the first
 * (nothing to take) while being able to say something specific about the second
 * (a case with no content measures nothing).
 */
export type FileAtCommit =
  | { kind: 'found'; content: string; commitSha: string; commitDay: string }
  | { kind: 'no-such-commit' }
  | { kind: 'not-at-commit' };

/**
 * Read `filePath` as it stood at `ref`, together with the commit it really
 * resolved to and the day that commit was made.
 *
 * The full sha and the day come back with the content because they are what a
 * caller records as provenance: a short ref or a branch name is ambiguous later,
 * and the day the code existed is the part a reader dates the evidence by.
 */
export async function readFileAtCommit(
  repoCwd: string,
  ref: string,
  filePath: string,
): Promise<FileAtCommit> {
  let commitSha: string;
  let commitDay: string;
  try {
    const { stdout } = await execFilep('git', ['show', '-s', '--format=%H %cs', ref], {
      cwd: repoCwd,
    });
    const [sha, day] = stdout.trim().split(/\s+/);
    if (sha === undefined || day === undefined) return { kind: 'no-such-commit' };
    commitSha = sha;
    commitDay = day;
  } catch {
    return { kind: 'no-such-commit' };
  }

  // Presence is decided STRUCTURALLY, by listing the path in the commit's tree,
  // rather than by classifying `git show`'s failure text — that text is
  // translated, so matching it would break under any non-English locale.
  try {
    const { stdout } = await execFilep('git', ['ls-tree', commitSha, '--', filePath], {
      cwd: repoCwd,
    });
    if (stdout.trim() === '') return { kind: 'not-at-commit' };
  } catch {
    return { kind: 'not-at-commit' };
  }

  try {
    const { stdout } = await execFilep('git', ['show', `${commitSha}:${filePath}`], {
      cwd: repoCwd,
      maxBuffer: 100 * 1024 * 1024,
    });
    return { kind: 'found', content: stdout, commitSha, commitDay };
  } catch {
    return { kind: 'not-at-commit' };
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
 *
 * A COPY (git status code `C` — never produced by the default `-uall`/
 * `--name-status` invocations this module runs, but reachable purely via the
 * non-default `status.renames`/`diff.renames` config value `copies`/`copy`,
 * which an adopter's ambient `~/.gitconfig` can set with no flag on our
 * command line at all) is deliberately NOT a `RenamePair`: unlike a rename,
 * the source path is untouched and still valid — nothing was invalidated.
 * Both the copy's source and destination still land in `files` (either one
 * differing from the merge-base is a legitimate reason to re-gate), just not
 * as a `renames` edge.
 */
export interface ChangedFiles {
  files: Set<string>;
  renames: RenamePair[];
}

/**
 * Returns `tokens[i]`, or throws a descriptive, named error if the NUL-record
 * stream ended (or is otherwise malformed) before a required companion token —
 * e.g. a rename/copy record's from/to path, or an ordinary diff record's path.
 * Without this, the same situation throws deep inside `toPosixPath` as a bare
 * "Cannot read properties of undefined" `TypeError`, which is accurate but
 * tells a reader nothing about which parser or which record shape broke.
 * Both callers still just want ONE outcome either way — thrown, and caught by
 * {@link changedFilesAgainst}'s catch-all, degrading to `null` exactly like
 * any other parse failure — this only makes that failure legible if it is
 * ever hit directly (e.g. in a unit test) rather than through that catch.
 */
function requireToken(tokens: string[], i: number, parserName: string, what: string): string {
  const token = tokens[i];
  if (token === undefined) {
    throw new Error(
      `${parserName}: truncated NUL-record stream — expected ${what} after record ${i - 1}`,
    );
  }
  return token;
}

/**
 * Parse `git status --porcelain=v1 -z -uall` output (NUL-terminated records,
 * no shell quoting/escaping to undo — see the git-status(1) `-z` docs).
 *
 * Record shapes:
 *   - ordinary: `XY <path>` — two status chars, one separator space, then the
 *     path verbatim. `X`/`Y` are the index/worktree status chars (a space
 *     means "no change on that side"); this parser does not need to inspect
 *     them beyond checking position 0 for `R`/`C`.
 *   - rename: `R  <to>` immediately followed by a SEPARATE raw `<from>`
 *     record (no `XY ` prefix on the second one) — the renamed-FROM path packs
 *     AFTER the renamed-TO path here. This is the opposite field order from
 *     {@link parseDiffNameStatusZ}'s rename record, which is exactly why the
 *     two parsers are kept separate rather than sharing rename logic: sharing
 *     code would need a branch per caller anyway, and a shared implementation
 *     is a more tempting place to introduce a from/to mixup than two short,
 *     independently-obvious functions.
 *   - copy: `C  <to>` followed by a SEPARATE raw `<from>` record — the SAME
 *     to-then-from field order as a rename, just a different status letter.
 *     Not reachable via the default command line this module runs, but
 *     reachable via the non-default `status.renames=copies` git config value
 *     with no flag of ours involved at all — see {@link ChangedFiles}'s doc
 *     comment for why it still must consume its companion token (so it
 *     doesn't desync every record after it) while landing only in `files`,
 *     never `renames`.
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
    if (indexStatus === 'R' || indexStatus === 'C') {
      const from = toPosixPath(
        requireToken(tokens, ++i, 'parsePorcelainZ', 'a rename/copy "from" companion record'),
      );
      files.add(from);
      files.add(recordPath);
      if (indexStatus === 'R') renames.push({ from, to: recordPath });
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
 *   - copy: a `C<score>` status record (e.g. `C096`) followed by `<from>`
 *     then `<to>` — the SAME from-then-to order as a rename, just a
 *     different status letter. Not reachable via the default command line
 *     this module runs, but reachable via the non-default
 *     `diff.renames=copies` git config value with no flag of ours involved at
 *     all: WITHOUT special-casing it, its status token falls into the
 *     ordinary branch below, which reads the copy's `<from>` path as if it
 *     were a complete record's `<path>` — silently dropping the real `<to>`
 *     path and leaving the NEXT record's own status token to be misread as a
 *     bogus path, corrupting every record after it, not just this one. See
 *     {@link ChangedFiles}'s doc comment for why a copy still lands only in
 *     `files`, never `renames`.
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
    if (status[0] === 'R' || status[0] === 'C') {
      const from = toPosixPath(
        requireToken(tokens, ++i, 'parseDiffNameStatusZ', 'a rename/copy "from" record'),
      );
      const to = toPosixPath(
        requireToken(tokens, ++i, 'parseDiffNameStatusZ', 'a rename/copy "to" record'),
      );
      files.add(from);
      files.add(to);
      if (status[0] === 'R') renames.push({ from, to });
    } else {
      const recordPath = toPosixPath(
        requireToken(tokens, ++i, 'parseDiffNameStatusZ', "an ordinary record's path"),
      );
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

// =============================================================================
// State probes — small, independent facts a later scoping decision consumes
// alongside {@link changedFilesAgainst}'s touched set: whether a comparison
// between two refs is even meaningful here at all. Every probe below shares
// one contract: return `null` on ANY git failure (missing binary, `repoCwd`
// not a repository, a ref that does not resolve, …) and NEVER throw — exactly
// {@link changedFilesAgainst}'s contract, for the same reason. A caller that
// cannot trust a probe has nothing safer to do with a guessed answer than
// with an honest "I don't know", so `null` is a first-class outcome a caller
// must branch on, never a `false`/empty value in disguise. `isAncestor` in
// particular must not collapse "not an ancestor" and "could not tell" into
// the same falsy result — the whole point of a three-valued probe is that a
// caller downstream can tell those two apart.
// =============================================================================

/**
 * Is `maybeAncestor` an ancestor of (or equal to) `ref`? `git merge-base
 * --is-ancestor` documents its exit codes precisely, so this maps them
 * directly rather than inferring anything from stdout (there is none):
 * 0 → true, 1 → false, anything else (bad ref, not a repository, git
 * missing, …) → null. Ancestry is directional and NOT implied by
 * {@link treesIdentical} — two refs can carry identical content while
 * neither is reachable from the other (e.g. one reverted its own change
 * before the other advanced past it), so a caller needing both facts must
 * call both probes; this one alone cannot stand in for tree equality.
 */
export async function isAncestor(
  repoCwd: string,
  maybeAncestor: string,
  ref: string,
): Promise<boolean | null> {
  try {
    await execFilep('git', ['merge-base', '--is-ancestor', maybeAncestor, ref], { cwd: repoCwd });
    return true;
  } catch (err) {
    return (err as ExecFileException).code === 1 ? false : null;
  }
}

/**
 * Is `repoCwd` a shallow clone (a truncated history from `--depth`)? Extracted
 * from the inline probe in `cli/advise.ts::gatherChurnHistory` (`git
 * rev-parse --is-shallow-repository`), which exists for the same reason a
 * progressive-mode scoping decision needs it: a shallow clone's history
 * window is truncated, so a comparison that assumes full history (an
 * ancestor check, a commit-range diff) can silently look at less than it
 * thinks it does. `advise.ts` keeps its own inline call for now — this is the
 * reusable form a later caller switches to, not a replacement wired in here.
 * Git prints exactly `true` or `false` on success; anything else (a truncated
 * or unexpected stdout, as well as any non-zero exit) is reported as `null`
 * rather than guessed at.
 */
export async function isShallowRepository(repoCwd: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFilep('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: repoCwd,
    });
    const trimmed = stdout.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * The repo's work-tree top level and the caller's prefix beneath it (`git
 * rev-parse --show-toplevel --show-prefix`, one process for both facts). A
 * caller running from a subdirectory of the repo needs both: the toplevel to
 * resolve repo-relative paths (as {@link changedFilesAgainst}'s callers do)
 * and the prefix to know how far below that root it currently sits. An empty
 * prefix (the caller IS the repo root) is a legitimate, common value, not an
 * error — only a git failure (not a repository, git missing) produces `null`.
 * Both fields are normalized with {@link toPosixPath} since they leave this
 * module; `--show-prefix` prints a trailing slash on every non-root value
 * (e.g. `sub/dir/`) which `toPosixPath` strips so the shape matches every
 * other path this module hands back.
 */
export async function getToplevelAndPrefix(
  repoCwd: string,
): Promise<{ toplevel: string; prefix: string } | null> {
  try {
    const { stdout } = await execFilep('git', ['rev-parse', '--show-toplevel', '--show-prefix'], {
      cwd: repoCwd,
    });
    // git prints the toplevel on the first line and the prefix on the
    // second, in that fixed order for these two flags; the prefix line is
    // empty (not absent) when the caller is already at the repo root.
    const lines = stdout.split('\n');
    const toplevelLine = lines[0];
    const prefixLine = lines[1];
    if (!toplevelLine || prefixLine === undefined) return null;
    return { toplevel: toPosixPath(toplevelLine), prefix: toPosixPath(prefixLine) };
  } catch {
    return null;
  }
}

/**
 * Do `refA` and `refB` point at the same tree content — `git rev-parse
 * <ref>^{tree}` resolved and compared for each, NOT the commit SHAs
 * themselves? Comparing commits would report a real difference for a branch
 * that changed a file and then reverted the change back to the exact prior
 * content: the commit SHAs genuinely differ (different history, different
 * parents/timestamps/messages) even though nothing about the tree — and so
 * nothing a content-based gate cares about — actually changed. Resolving to
 * the tree object first is what makes that case honestly report "identical".
 * As with {@link isAncestor}, this says nothing about ancestry: identical
 * trees do not imply either ref is reachable from the other. `null` on any
 * resolution failure for either ref (a ref that does not resolve, `repoCwd`
 * not a repository, …) — never inferred from a partial result.
 */
export async function treesIdentical(
  repoCwd: string,
  refA: string,
  refB: string,
): Promise<boolean | null> {
  try {
    const [treeA, treeB] = await Promise.all([
      execFilep('git', ['rev-parse', `${refA}^{tree}`], { cwd: repoCwd }),
      execFilep('git', ['rev-parse', `${refB}^{tree}`], { cwd: repoCwd }),
    ]);
    return treeA.stdout.trim() === treeB.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Does `filePath` exist at `ref`? `git ls-tree <ref> -- <path>` lists the path
 * when it is there and prints nothing when it is not, exiting zero either way,
 * so presence is read off the OUTPUT rather than the exit code.
 *
 * This exists because {@link getFileAtRef}'s empty string is ambiguous: it comes
 * back both for a path that is absent at the ref AND for a path that is present
 * as a zero-byte (or whitespace-only) blob, since `git show` succeeds on the
 * latter and never reaches the absence fallback. A caller for which those two
 * mean different things — "the file was not there yet" versus "the file was
 * there and had been emptied" — cannot tell them apart from the content alone
 * and asks here instead. Any caller treating an emptied file as an absent one
 * is claiming a proof it does not have.
 *
 * `null` on any git failure (a ref that does not resolve, `repoCwd` not a
 * repository, git missing, …), never a `false` standing in for "could not tell".
 */
export async function pathExistsAtRef(
  repoCwd: string,
  ref: string,
  filePath: string,
): Promise<boolean | null> {
  try {
    const { stdout } = await execFilep('git', ['ls-tree', ref, '--', filePath], { cwd: repoCwd });
    return stdout.trim() !== '';
  } catch {
    return null;
  }
}

/** git's file mode for a submodule gitlink — a pointer to another repository's commit. */
const GITLINK_MODE = '160000';

/**
 * Collect the gitlink paths out of one NUL-record listing into `into`.
 *
 * Shared by both listings this module reads, because their record shapes agree
 * on exactly the two fields that matter here: the mode is everything before the
 * first space, and the path is everything after the first TAB.
 *   - `git ls-files --stage -z` → `<mode> <object> <stage>\t<path>\0`
 *   - `git ls-tree -r -z <ref>` → `<mode> <type> <object>\t<path>\0`
 * With `-z` the path is verbatim (git's usual quoting/escaping of unusual bytes
 * is disabled), so there is nothing to unescape.
 */
function collectGitlinks(stdout: string, into: Set<string>): void {
  for (const record of stdout.split('\0')) {
    if (record.length === 0) continue;
    const space = record.indexOf(' ');
    const tab = record.indexOf('\t');
    if (space < 0 || tab < space) continue;
    if (record.slice(0, space) !== GITLINK_MODE) continue;
    into.add(toPosixPath(record.slice(tab + 1)));
  }
}

/**
 * Every repo-relative POSIX path that is a SUBMODULE GITLINK — at `ref`, or in
 * the current index, or both.
 *
 * A gitlink is not a file: it is a pointer to another repository's commit, so a
 * path-based decision (does this change reach that rule?) has nothing to match
 * it against. A caller that scopes work by path therefore has to know whether
 * one appears among the paths it is about to scope, and this is the set it
 * intersects its own changed paths with.
 *
 * BOTH sides are read on purpose, and each catches a case the other cannot:
 * `git ls-files --stage` sees a submodule that exists now (including one this
 * change ADDED, and one whose own work tree is merely dirty), while
 * `git ls-tree -r <ref>` sees one that existed at the reference and this change
 * REMOVED — an entry the current index no longer mentions at all, even though
 * its removal is precisely the change being judged. Reading only the index
 * would answer "no gitlinks here" for a change whose entire content is the
 * deletion of one.
 *
 * `null` on ANY git failure (a ref that does not resolve, `repoCwd` not a
 * repository, git missing, …) — never a partial or empty set standing in for
 * "could not tell", same three-valued contract as every other probe here.
 */
export async function gitlinkPaths(repoCwd: string, ref: string): Promise<Set<string> | null> {
  try {
    const [indexResult, treeResult] = await Promise.all([
      execFilep('git', ['ls-files', '--stage', '-z'], {
        cwd: repoCwd,
        maxBuffer: 64 * 1024 * 1024,
      }),
      execFilep('git', ['ls-tree', '-r', '-z', ref], {
        cwd: repoCwd,
        maxBuffer: 64 * 1024 * 1024,
      }),
    ]);
    const paths = new Set<string>();
    collectGitlinks(indexResult.stdout, paths);
    collectGitlinks(treeResult.stdout, paths);
    return paths;
  } catch {
    return null;
  }
}

/**
 * Every BLOB path in the tree at `ref`, mapped to the git object id recorded
 * for it there — ONE `git ls-tree -r -z <ref>` process for the whole tree.
 *
 * The single-process shape is the point, not an optimisation. The consumer
 * (`core/progressive-scope.ts`'s byte guard) asks "did this file's content
 * really not move since the reference" about an arbitrary subset of a
 * repository's files, and the naive answer — `git cat-file`/`git rev-parse` per
 * file — costs one process per question, which on a large repository is the
 * difference between a guard that always runs and one nobody can afford to
 * leave on. One listing answers every question at once.
 *
 * Only `blob` entries are kept. `-r` without `-t` already suppresses tree
 * records, so the only other type reachable here is `commit` — a submodule
 * gitlink, whose object id names another repository's commit and can never be
 * compared against any bytes on this side. {@link gitlinkPaths} is the probe for
 * those, and progressive mode refuses outright when one appears in a diff.
 *
 * `null` on ANY git failure (a ref that does not resolve, `repoCwd` not a
 * repository, git missing, …) — never a partial or empty map standing in for
 * "could not tell", the same three-valued contract as every other probe here.
 * A caller must NOT read the empty map out of a failure: "the reference held no
 * files" and "the listing could not be obtained" lead to opposite conclusions
 * for every path it is asked about.
 */
export async function listTreeOids(
  repoCwd: string,
  ref: string,
): Promise<Map<string, string> | null> {
  try {
    const { stdout } = await execFilep('git', ['ls-tree', '-r', '-z', ref], {
      cwd: repoCwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    const oids = new Map<string, string>();
    // `<mode> <type> <object>\t<path>\0` — the same record shape
    // `collectGitlinks` reads, parsed for a different field. With `-z` the path
    // is verbatim (git's usual quoting of unusual bytes is disabled), so there
    // is nothing to unescape.
    for (const record of stdout.split('\0')) {
      if (record.length === 0) continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const fields = record.slice(0, tab).split(' ');
      if (fields.length < 3) continue;
      const [, type, oid] = fields;
      if (type !== 'blob') continue;
      oids.set(toPosixPath(record.slice(tab + 1)), oid);
    }
    return oids;
  } catch {
    return null;
  }
}

/**
 * Is the work tree clean — no staged, unstaged, OR untracked change versus
 * HEAD? Uses the identical `git status --porcelain=v1 -z -uall` invocation
 * {@link changedFilesAgainst} reads for its worktree half, so "clean" here
 * means precisely "that call would have found nothing" in both places — a
 * caller cross-checking this probe against the touched set never has to
 * reconcile two different notions of dirty. `-uall` is what makes an
 * untracked file (not just a modified tracked one) count as dirty; a repo
 * with zero commits and nothing to track is vacuously clean, matching plain
 * `git status`'s own behavior there. `null` on any git failure, same as
 * every other probe in this section.
 */
export async function hasCleanWorktree(repoCwd: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFilep('git', ['status', '--porcelain=v1', '-z', '-uall'], {
      cwd: repoCwd,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
    });
    return stdout.length === 0;
  } catch {
    return null;
  }
}
