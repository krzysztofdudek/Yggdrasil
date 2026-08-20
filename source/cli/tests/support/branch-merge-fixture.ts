// =============================================================================
// tests/support/branch-merge-fixture.ts — the shared branch-and-merge git
// fixture: base (day 0) -> a side branch's own commit (day 50) -> a
// main-line commit (day 100) -> a merge (day 110, `--no-ff`) -> optionally
// one more main-line commit (day 200). The side branch is dated BEFORE the
// main-line commit it is later merged past — the date dip a full history
// walk delivers in build order regardless of dates, which is the shape a
// resume-range / split-walk test needs, and which `buildGoldenRepo`'s own
// linear-chain builder cannot express.
//
// Built through git-fixture.ts's deterministic primitives ONLY — every date
// comes from `deterministicCommitIndexAt`'s day/seq grid, never a bare ISO
// string through `extraEnv` (see that function's own doc comment for why
// that path silently discards a date). This module imports ONLY Node
// builtins and ./git-fixture.js — never anything from src/**, so an e2e
// suite (which must stay off the CLI's internal surface) can use it freely
// alongside `roots-golden.ts`.
//
// tests/unit/utils/git-history.test.ts pins the SAME topology and date dip
// independently, built locally inside that file (it predates this module
// and an e2e suite may not import a sibling unit-test file) — this module's
// own tests assert the two constructions agree on the dip and the shape,
// two independent proofs of one history rather than one copied into the
// other.
// =============================================================================

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deterministicCommitIndexAt, initDeterministicGitFixture, runDeterministicGitFixture, runGitFixture } from './git-fixture.js';

function writeFile(dir: string, relPath: string, content: string): void {
  const target = path.join(dir, relPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf-8');
}

function runOrThrow(dir: string, args: string[], commitIndex: number, extraEnv: NodeJS.ProcessEnv = {}): void {
  const r = runDeterministicGitFixture(dir, args, commitIndex, { extraEnv });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
  }
}

function runPlainOrThrow(dir: string, args: string[]): void {
  // Deterministic env even for non-committing commands: `checkout` rewrites
  // the whole work tree and runs hooks, so a host `core.hooksPath` or
  // `core.autocrlf` leaking in here breaks the fixture's reproducibility
  // (both were demonstrated live in review). The commit index is irrelevant
  // for a non-committing command; 0 keeps the call shape uniform.
  const r = runDeterministicGitFixture(dir, args, 0);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}${r.stdout}`);
  }
}

function headSha(dir: string): string {
  const r = runGitFixture(dir, ['rev-parse', 'HEAD']);
  if (r.status !== 0) {
    throw new Error(`git rev-parse HEAD failed in ${dir}: ${r.stderr}${r.stdout}`);
  }
  return r.stdout.trim();
}

function currentBranch(dir: string): string {
  const r = runGitFixture(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.status !== 0) {
    throw new Error(`git rev-parse --abbrev-ref HEAD failed in ${dir}: ${r.stderr}${r.stdout}`);
  }
  return r.stdout.trim();
}

/** Deterministic author/committer identity for an author key, matching `roots-golden.ts`'s own convention. */
function authorEnv(author: string): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: `${author}@golden.test`,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: `${author}@golden.test`,
  };
}

/**
 * `base`'s own file — an extracted TypeScript file carrying multiple
 * named-body scopes, at least ~20 lines, so `main1`'s later edit is a small
 * in-place body change rather than a rewrite (never at risk of tripping
 * `-M`'s similarity threshold into an unintended rename).
 */
function baseFileBody(touch = 0): string {
  return [
    'export interface BaseRecord {',
    '  id: string;',
    '  value: number;',
    '}',
    '',
    'export function normalizeBase(record: BaseRecord): BaseRecord {',
    '  return { id: record.id.trim(), value: Math.max(0, record.value) };',
    '}',
    '',
    'export function describeBase(record: BaseRecord): string {',
    `  const touchMarker = ${touch};`,
    '  return `${record.id}=${record.value}#${touchMarker}`;',
    '}',
    '',
    'export function isValidBase(record: BaseRecord): boolean {',
    '  return record.id.length > 0 && Number.isFinite(record.value);',
    '}',
    '',
    'export function mergeBase(a: BaseRecord, b: BaseRecord): BaseRecord {',
    '  return { id: a.id, value: a.value + b.value };',
    '}',
    '',
  ].join('\n');
}

/** `side`'s own file — a SECOND extracted file, born on the side branch, joining no earlier commit. */
function sideFileBody(touch = 0): string {
  return [
    'export interface SideRecord {',
    '  key: string;',
    '  weight: number;',
    '}',
    '',
    'export function normalizeSide(record: SideRecord): SideRecord {',
    '  return { key: record.key.trim(), weight: Math.max(0, record.weight) };',
    '}',
    '',
    'export function describeSide(record: SideRecord): string {',
    `  const touchMarker = ${touch};`,
    '  return `${record.key}~${record.weight}#${touchMarker}`;',
    '}',
    '',
    'export function isValidSide(record: SideRecord): boolean {',
    '  return record.key.length > 0 && Number.isFinite(record.weight);',
    '}',
    '',
    'export function combineSide(a: SideRecord, b: SideRecord): SideRecord {',
    '  return { key: a.key, weight: a.weight + b.weight };',
    '}',
    '',
  ].join('\n');
}

/** Options for {@link buildBranchMergeFixture}. */
export interface BuildBranchMergeFixtureOptions {
  /**
   * Whether to add one more main-line commit after the merge (default
   * `true`). With it, the merge sits *inside* the history and HEAD is that
   * trailing commit (`main2`) — the shape a resume/split-walk case needs.
   * Without it, HEAD *is* the merge commit itself — the shape a "HEAD is a
   * merge" control needs. Both variants share the same topology and the
   * same date dip; only where the history stops differs.
   */
  trailingMainCommit?: boolean;
  /** Author key for every commit this helper writes (default `'roots-golden'`). */
  author?: string;
}

/** What {@link buildBranchMergeFixture} returns. */
export interface BranchMergeFixture {
  /** Absolute path to the built repository. The caller owns cleanup, matching `roots-golden.ts`'s own builder contract. */
  dir: string;
  shas: {
    base: string;
    side: string;
    main1: string;
    merge: string;
    /** Present only when `opts.trailingMainCommit` (default `true`) built it. */
    main2?: string;
  };
}

/**
 * Build the shared branch-and-merge fixture: `base` (day 0) -> `side` (day
 * 50, on a branch cut from `base`) -> `main1` (day 100, back on `main`) ->
 * `merge` (day 110, `--no-ff`, folding `side` back onto `main`) ->
 * optionally `main2` (day 200), when `opts.trailingMainCommit` (default
 * `true`).
 *
 * `side` is dated BEFORE `main1`, the main-line commit it is later merged
 * past — the dip every acceptance against this fixture reads: a full walk
 * in build/parent order delivers `side` before `main1` even though `side`'s
 * OWN date is earlier, because a linear parent chain (and `side`/`main1`
 * are each a single-parent step from `base`) walks in parent-before-child
 * order regardless of what the committer dates say. Every date comes from
 * {@link deterministicCommitIndexAt}'s day/seq grid.
 *
 * CONTENT CONTRACT (not the caller's to improvise — a later increment's
 * lifecycle-replay acceptance reads it): `base` writes an extracted `.ts`
 * file carrying multiple named-body scopes; `side` writes a SECOND such
 * file — a scope born on the side branch, existing in no earlier commit;
 * `main1` edits `base`'s file ONLY (never `side`'s), so the two branches
 * touch disjoint files and the merge is conflict-free; the merge itself
 * writes nothing of its own (a plain `--no-ff` fold, no working-tree change
 * beyond the merge commit); `main2`, when present, edits `side`'s file
 * ONLY, so that file's scope has a strictly later last-touch than its
 * first-seen commit, both derivable from the day offsets above. Every edit
 * is a small in-place body change, never a rewrite, so no commit here can
 * trip `-M`'s similarity threshold.
 */
export function buildBranchMergeFixture(opts: BuildBranchMergeFixtureOptions = {}): BranchMergeFixture {
  const trailingMainCommit = opts.trailingMainCommit ?? true;
  const author = opts.author ?? 'roots-golden';
  const env = authorEnv(author);

  const dir = mkdtempSync(path.join(tmpdir(), 'yg-branch-merge-'));
  const init = initDeterministicGitFixture(dir);
  if (init.status !== 0) {
    throw new Error(`git init failed in ${dir}: ${init.stderr}${init.stdout}`);
  }

  writeFile(dir, 'src/base.ts', baseFileBody());
  runOrThrow(dir, ['add', '-A'], deterministicCommitIndexAt(0), env);
  runOrThrow(dir, ['commit', '-q', '-m', 'base'], deterministicCommitIndexAt(0), env);
  const base = headSha(dir);

  runPlainOrThrow(dir, ['checkout', '-qb', 'side']);
  writeFile(dir, 'src/side.ts', sideFileBody());
  runOrThrow(dir, ['add', '-A'], deterministicCommitIndexAt(50), env);
  runOrThrow(dir, ['commit', '-q', '-m', 'side: introduce side.ts'], deterministicCommitIndexAt(50), env);
  const side = headSha(dir);

  runPlainOrThrow(dir, ['checkout', '-q', 'main']);
  writeFile(dir, 'src/base.ts', baseFileBody(1));
  runOrThrow(dir, ['add', '-A'], deterministicCommitIndexAt(100), env);
  runOrThrow(dir, ['commit', '-q', '-m', 'main1: edit base.ts'], deterministicCommitIndexAt(100), env);
  const main1 = headSha(dir);

  runOrThrow(dir, ['merge', '--no-ff', '-q', '-m', 'merge side into main', 'side'], deterministicCommitIndexAt(110), env);
  const merge = headSha(dir);

  let main2: string | undefined;
  if (trailingMainCommit) {
    writeFile(dir, 'src/side.ts', sideFileBody(1));
    runOrThrow(dir, ['add', '-A'], deterministicCommitIndexAt(200), env);
    runOrThrow(dir, ['commit', '-q', '-m', 'main2: edit side.ts'], deterministicCommitIndexAt(200), env);
    main2 = headSha(dir);
  }

  return { dir, shas: { base, side, main1, merge, main2 } };
}

/** Options for {@link appendMergeOfOlderSideBranch}. */
export interface AppendMergeOfOlderSideBranchOptions {
  /** Commit sha already in `dir`'s history that the older side branch forks from. */
  branchFrom: string;
  /**
   * Day offset for the side branch's own commit — dated OLDER than a
   * commit `dir`'s history already applied ahead of it, the same dip
   * {@link buildBranchMergeFixture} scripts from scratch, appended onto an
   * already-built repository instead.
   */
  sideDayOffset: number;
  /**
   * Day offset for the merge commit that folds the side branch back onto
   * whatever branch is currently checked out in `dir`. Should be later
   * than every day offset already applied in `dir`'s history so the merge
   * genuinely extends it (git does not require this — `--no-ff` always
   * creates a commit — but a merge dated inside the existing history would
   * not be the "extends the tip" shape this helper exists for).
   */
  mergeDayOffset: number;
  /** `seq` slot for `sideDayOffset` (default 0) — disambiguates a same-day commit. */
  sideSeq?: number;
  /** `seq` slot for `mergeDayOffset` (default 0). */
  mergeSeq?: number;
  /** Author key for both new commits (default `'roots-golden'`). */
  author?: string;
  /**
   * Repo-relative path -> content the side-branch commit writes. Defaults
   * to a single new extracted file, so the branch carries genuine content
   * (an empty commit would not exercise the extraction path this fixture
   * exists for) unless the caller needs a specific file set.
   */
  files?: Record<string, string>;
  /** Commit message for the side-branch commit. */
  sideMessage?: string;
  /** Commit message for the merge commit. */
  mergeMessage?: string;
}

/** What {@link appendMergeOfOlderSideBranch} returns. */
export interface AppendMergeOfOlderSideBranchResult {
  sideSha: string;
  mergeSha: string;
}

/**
 * Append a branch-and-merge onto an ALREADY-BUILT repository: fork a new
 * branch from `opts.branchFrom` (a commit already in `dir`'s history),
 * commit onto it at `opts.sideDayOffset` — dated OLDER than history already
 * applied ahead of it — then merge it (`--no-ff`) back onto whatever branch
 * is currently checked out, at `opts.mergeDayOffset`. HEAD afterwards is
 * the merge commit, whose second parent is the side-branch commit.
 */
export function appendMergeOfOlderSideBranch(dir: string, opts: AppendMergeOfOlderSideBranchOptions): AppendMergeOfOlderSideBranchResult {
  const author = opts.author ?? 'roots-golden';
  const env = authorEnv(author);
  const sideSeq = opts.sideSeq ?? 0;
  const mergeSeq = opts.mergeSeq ?? 0;
  const branchName = `append-side-${opts.sideDayOffset}-${sideSeq}`;

  const returnBranch = currentBranch(dir);

  runPlainOrThrow(dir, ['checkout', '-qb', branchName, opts.branchFrom]);
  const files = opts.files ?? { 'src/append-side.ts': sideFileBody() };
  for (const [relPath, content] of Object.entries(files)) writeFile(dir, relPath, content);
  const sideIndex = deterministicCommitIndexAt(opts.sideDayOffset, sideSeq);
  runOrThrow(dir, ['add', '-A'], sideIndex, env);
  runOrThrow(dir, ['commit', '-q', '-m', opts.sideMessage ?? `append: ${branchName}`], sideIndex, env);
  const sideSha = headSha(dir);

  runPlainOrThrow(dir, ['checkout', '-q', returnBranch]);
  const mergeIndex = deterministicCommitIndexAt(opts.mergeDayOffset, mergeSeq);
  runOrThrow(dir, ['merge', '--no-ff', '-q', '-m', opts.mergeMessage ?? `merge ${branchName}`, branchName], mergeIndex, env);
  const mergeSha = headSha(dir);

  return { sideSha, mergeSha };
}
