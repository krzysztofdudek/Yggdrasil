import { readFile, readdir } from 'node:fs/promises';
import { lstatSync, type Dirent } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { type Ignore, type Options as IgnoreOptions } from 'ignore';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';
import { isExcludedByCoverage } from '../utils/coverage-exclusion.js';
import { mappingEntryMatchesFile } from '../utils/mapping-path.js';
import { normalizeMappingPaths } from './paths.js';
import type { CoverageConfig, Graph } from '../model/graph.js';

const require = createRequire(import.meta.url);
const ignoreFactory = require('ignore') as (options?: IgnoreOptions) => Ignore;

export type GitignoreEntry = { dir: string; ig: Ignore };

const YGGDRASIL_DIRNAME = '.yggdrasil';

export async function loadRootGitignoreStack(projectRoot: string): Promise<GitignoreEntry[]> {
  try {
    const content = await readFile(join(projectRoot, '.gitignore'), 'utf-8');
    const ig = ignoreFactory();
    ig.add(content);
    return [{ dir: projectRoot, ig }];
  } catch (err) {
    debugWrite(`[repo-scanner] root .gitignore not readable: ${(err as Error).message}`);
    return [];
  }
}

export function isIgnoredByStack(
  absPath: string,
  stack: GitignoreEntry[],
  isDirectory = false,
): boolean {
  for (const entry of stack) {
    const rel = relative(entry.dir, absPath);
    if (rel === '' || rel.startsWith('..')) continue;
    const normalized = rel.split(sep).join('/');
    // Query the bare path always, and the directory form ONLY when the candidate
    // is actually a directory: a directory-only .gitignore pattern (trailing
    // slash, e.g. `build/`) matches git-side only against directories. Querying
    // `normalized + '/'` for a FILE would wrongly drop a tracked file whose name
    // collides with a directory-only pattern (e.g. a file `scripts/build` under a
    // `build/` rule). Real directories are still pruned: the `isDirectory` form
    // runs the trailing-slash query for them.
    if (entry.ig.ignores(normalized) || (isDirectory && entry.ig.ignores(normalized + '/')))
      return true;
  }
  return false;
}

async function collectFiles(
  dir: string,
  projectRoot: string,
  stack: GitignoreEntry[],
  nestedRoots: ReadonlySet<string>,
): Promise<string[]> {
  let localStack = stack;
  try {
    const content = await readFile(join(dir, '.gitignore'), 'utf-8');
    const ig = ignoreFactory();
    ig.add(content);
    localStack = [...stack, { dir, ig }];
  } catch (err) {
    debugWrite(`[repo-scanner] local .gitignore not readable in ${dir}: ${(err as Error).message}`);
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    debugWrite(`[repo-scanner] readdir failed for ${dir}: ${(err as Error).message}`);
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    // `.git` is skipped in BOTH forms: the directory (normal checkout) and the
    // pointer FILE `gitdir: ...` (git worktree / submodule checkout). This
    // guards the ROOT's own `.git`; a NESTED `.git` (a separate project's own
    // boundary) is excluded wholesale below via `nestedRoots`, computed once
    // per run by `findNestedProjectRoots` — this per-entry check alone cannot
    // see a nested `.git` two levels down before recursing there.
    if (entry.name === '.git') continue;
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === YGGDRASIL_DIRNAME && dir === projectRoot) continue;
      if (isIgnoredByStack(absPath, localStack, true)) continue;
      const relDir = relative(projectRoot, absPath).split(sep).join('/');
      // A directory that is itself a separate project's boundary (its own
      // `.yggdrasil/` graph, or its own `.git` — a nested checkout, submodule,
      // or linked worktree) is governed by that project, not this one: none of
      // its files are ever walked in.
      if (nestedRoots.has(relDir)) continue;
      results.push(...(await collectFiles(absPath, projectRoot, localStack, nestedRoots)));
    } else if (entry.isFile()) {
      if (isIgnoredByStack(absPath, localStack)) continue;
      results.push(relative(projectRoot, absPath).split(sep).join('/'));
    }
  }
  return results;
}

/**
 * Drop every file under a nested-graph subtree — a directory (below the repo root)
 * that contains its own `.yggdrasil/`. Such a subtree is governed by that graph, so
 * the parent graph's checks must ignore it. The top-level `.yggdrasil/` is NOT a
 * nested root (its paths start with `.yggdrasil/`, with no leading-slash segment).
 *
 * LEGACY, list-derived heuristic: it infers a nested root by scanning the
 * CANDIDATE list handed to it for a `/.yggdrasil/` path segment, so it can only
 * ever notice a nested graph whose marker file already survived into that list.
 * A glob filtered by extension, or a `.gitignore` line hiding just the marker
 * directory, never produces such a path — the exact blind spot
 * `findNestedProjectRoots` (below) exists to close by reading the boundary off
 * the filesystem instead. Every caller that decides what belongs to THIS
 * graph's own enforcement surface (`walkRepoFiles`, `expandMappingPathsWithinOwnGraph`,
 * the suppression-scan universe) now uses that filesystem-derived source of
 * truth. This function survives only because `core/check.ts` still calls it as
 * a defense-in-depth re-filter over a list (`walkRepoFiles`'s own output) that
 * has ALREADY had every nested subtree removed — on such a list it is a
 * provable no-op, never a second, weaker guard.
 */
export function excludeNestedGraphSubtrees(relPaths: string[]): string[] {
  // A nested graph always has files under its own `.yggdrasil/`, so a `/.yggdrasil/`
  // segment (with a non-empty prefix — idx > 0) is the complete, correct signal. The
  // top-level `.yggdrasil/` has no leading-slash segment, so it is never a nested root.
  const seg = `/${YGGDRASIL_DIRNAME}/`;
  const nestedRoots = new Set<string>();
  for (const p of relPaths) {
    const idx = p.indexOf(seg);
    if (idx > 0) nestedRoots.add(p.slice(0, idx));
  }
  return filterOutsideNestedProjectRoots(relPaths, nestedRoots);
}

/** True iff `relPath` is `root` itself or lives under it, for any root in `nestedRoots`. */
export function isUnderAnyNestedProjectRoot(relPath: string, nestedRoots: ReadonlySet<string>): boolean {
  for (const root of nestedRoots) {
    if (relPath === root || relPath.startsWith(root + '/')) return true;
  }
  return false;
}

/**
 * Drop every path that lives under (or equals) one of `nestedRoots` — the shared
 * filter half of the nested-project boundary, reused by every caller that already
 * holds both a candidate list and the roots to filter it against.
 */
export function filterOutsideNestedProjectRoots(
  relPaths: string[],
  nestedRoots: ReadonlySet<string>,
): string[] {
  if (nestedRoots.size === 0) return relPaths;
  return relPaths.filter((p) => !isUnderAnyNestedProjectRoot(p, nestedRoots));
}

// ── Filesystem-derived nested-project boundary ──────────────────────────────
//
// A directory mapping (or a repo walk) stops at a SEPARATE PROJECT — a
// directory below the mapping root that is:
//   - its own `.yggdrasil/` graph (a directory named `.yggdrasil` that
//     contains at least one file, anywhere inside it), or
//   - its own git boundary: a `.git` entry directly inside it that git ITSELF
//     would recognize as one, in EITHER form — a directory containing at
//     least one file anywhere inside it (a fully independent nested checkout;
//     a real `git init` always populates HEAD/config/objects/refs, so a
//     directory named `.git` with nothing inside it is not a real one), or a
//     FILE whose content parses as the `gitdir: <path>` pointer a git
//     submodule or a linked `git worktree` leaves behind (git calls anything
//     else — empty, garbage, missing the `gitdir:` prefix — an "invalid
//     gitfile format" and refuses to treat it as a repository). Both forms
//     follow the SAME "must carry real content" rule `.yggdrasil` follows —
//     mere presence of a path segment named `.git` is never enough on its own.
// Nothing else is a boundary: a dependency directory (`node_modules`,
// `vendor`, or any other name) is ordinary — guessing names on an adopter's
// behalf produces surprises the moment real code lives there, and an
// absorbed dependency directory still shows up in the coverage count, so it
// stays visible rather than silently vanishing. Draw the line at a REAL
// separate-project marker, never a naming convention.
//
// This is a real filesystem walk, not derived from any candidate list, so it
// gives the same answer regardless of what filtered a caller's own candidate
// list first (a glob's extension filter, `.gitignore`) — the blind spot
// `excludeNestedGraphSubtrees` above cannot close. A `.gitignore` rule that
// hides the `.git`/`.yggdrasil` marker itself is deliberately NOT honored
// here (that is exactly the second escape this walk exists to close); every
// OTHER directory is still `.gitignore`-pruned during the search, so this
// stays as cheap as the ordinary repo walk — a gitignored `node_modules` is
// still never descended into.

/**
 * Per-run cache of `findNestedProjectRoots` results, keyed by resolved
 * project root. Safe because a `yg` CLI invocation is a fresh process — the
 * cache starts (and, for that invocation, stays) empty, so this is exactly a
 * per-run cache with zero extra plumbing. The one process that outlives a
 * single logical run is `yg portal` (no `--static`): its extraction pipeline
 * (`portal/extract.ts`'s `extractPortalData`, re-run on every refresh) calls
 * {@link resetNestedProjectRootsCache} at the top of every extraction, so a
 * project's disk state is re-read once per refresh, never carried over from
 * an earlier one. Nothing else invalidates it — a `yg` run never writes
 * source, so nothing else legitimately changes which directories are
 * separate projects while one run is in flight.
 */
let nestedProjectRootsCache = new Map<string, Promise<Set<string>>>();

/**
 * Drop the per-run cache described above. Call this at the start of any unit
 * of work that must see the CURRENT filesystem state after a prior call may
 * have cached a stale answer for the same root — today that is only the
 * portal server's per-request re-extraction. A one-shot CLI command never
 * needs this: its cache starts empty and the process exits before it could
 * ever go stale.
 */
export function resetNestedProjectRootsCache(): void {
  nestedProjectRootsCache = new Map();
}

/**
 * Find every separate-project boundary below `root` (see the section header
 * above) — repo-relative POSIX paths, computed by walking the real
 * filesystem. `root` itself is never a boundary of itself: its own top-level
 * `.yggdrasil/` and its own `.git` are the project's own state, not a nested
 * one. Cached per resolved root for the lifetime described above.
 */
export async function findNestedProjectRoots(root: string): Promise<Set<string>> {
  const key = resolve(root);
  let cached = nestedProjectRootsCache.get(key);
  if (!cached) {
    cached = scanNestedProjectRoots(key);
    nestedProjectRootsCache.set(key, cached);
  }
  return cached;
}

async function scanNestedProjectRoots(root: string): Promise<Set<string>> {
  const stack = await loadRootGitignoreStack(root);
  const roots = new Set<string>();
  await walkForNestedProjectRoots(root, root, stack, roots);
  return roots;
}

async function walkForNestedProjectRoots(
  dir: string,
  root: string,
  stack: GitignoreEntry[],
  roots: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    debugWrite(`[repo-scanner] findNestedProjectRoots: readdir failed for ${dir}: ${(err as Error).message}`);
    return;
  }

  if (dir !== root) {
    const yggMarker = entries.find((e) => e.isDirectory() && e.name === YGGDRASIL_DIRNAME);
    const [gitBoundary, yggBoundary] = await Promise.all([
      isGitBoundary(dir, entries),
      yggMarker !== undefined ? directoryHasAnyFile(join(dir, yggMarker.name)) : Promise.resolve(false),
    ]);
    if (gitBoundary || yggBoundary) {
      roots.add(relative(root, dir).split(sep).join('/'));
      return; // the whole subtree belongs to a separate project — nothing deeper matters
    }
  }

  let localStack = stack;
  try {
    const content = await readFile(join(dir, '.gitignore'), 'utf-8');
    const ig = ignoreFactory();
    ig.add(content);
    localStack = [...stack, { dir, ig }];
  } catch (err) {
    debugWrite(`[repo-scanner] findNestedProjectRoots: local .gitignore not readable in ${dir}: ${(err as Error).message}`);
  }

  const subdirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Never descended into: `.git`'s own internals are irrelevant here (a
    // nested `.git` is already caught by the marker check above, at whichever
    // directory hosts it), and a `.yggdrasil` directory is likewise only ever
    // inspected AS a marker at its parent, never searched for a further
    // boundary inside it.
    if (entry.name === '.git' || entry.name === YGGDRASIL_DIRNAME) continue;
    const absPath = join(dir, entry.name);
    if (isIgnoredByStack(absPath, localStack, true)) continue;
    subdirs.push(absPath);
  }
  await Promise.all(subdirs.map((d) => walkForNestedProjectRoots(d, root, localStack, roots)));
}

/**
 * True iff `content` is a valid git "gitfile" pointer — the ONLY form git itself
 * recognizes a `.git` FILE as a repository reference (see git's own
 * `read_gitfile_gently`): a single `gitdir: <path>` line with a non-empty path.
 * Anything else — empty, garbage text, or missing the `gitdir:` prefix — is what
 * git calls an "invalid gitfile format" and never treats as a repository.
 */
function isGitdirPointerContent(content: string): boolean {
  return /^gitdir:\s*\S/.test(content.replace(/[\r\n]+$/, ''));
}

/**
 * True iff `dir` carries a `.git` marker git itself would actually recognize as
 * a repository boundary, in either of the two forms `.git` can take:
 *   - a DIRECTORY containing at least one file anywhere inside it (mirrors
 *     `.yggdrasil`'s own `directoryHasAnyFile` rule — a real `git init` always
 *     populates HEAD/config/objects/refs, so a `.git` directory with nothing
 *     inside it is not a real checkout);
 *   - a FILE whose content parses as the `gitdir: <path>` pointer format (a
 *     submodule or a linked worktree).
 * A symlink (or any other exotic dirent type) named `.git` is neither form and
 * is never a boundary — matching the pre-existing, unrelated fact that a
 * symlinked subtree is never walked into by this scanner in the first place.
 */
async function isGitBoundary(dir: string, entries: Dirent[]): Promise<boolean> {
  const gitEntry = entries.find((e) => e.name === '.git');
  if (!gitEntry) return false;
  const gitPath = join(dir, '.git');
  if (gitEntry.isDirectory()) return directoryHasAnyFile(gitPath);
  if (gitEntry.isFile()) {
    try {
      return isGitdirPointerContent(await readFile(gitPath, 'utf-8'));
    } catch (err) {
      debugWrite(`[repo-scanner] findNestedProjectRoots: .git file unreadable at ${gitPath}: ${(err as Error).message}`);
      return false;
    }
  }
  return false;
}

/** True iff `dirPath` contains at least one regular file, at any depth. Short-circuits on the first hit. */
async function directoryHasAnyFile(dirPath: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory()) subdirs.push(join(dirPath, entry.name));
  }
  for (const d of subdirs) {
    if (await directoryHasAnyFile(d)) return true;
  }
  return false;
}

/**
 * True if a repo-relative POSIX path is UNCONDITIONALLY skipped by the coverage
 * walk (`walkRepoFiles`) for STRUCTURAL reasons — independent of .gitignore and
 * of nested-graph detection. Two cases, mirroring `collectFiles`:
 *   - any path segment is `.git` — the git directory OR the worktree/submodule
 *     pointer FILE, skipped at every recursion level; and
 *   - the path is the top-level `.yggdrasil/` graph directory itself, or lives
 *     inside it (the graph's own internal state — locks, caches, definitions).
 * A path matching this is never enumerated by the coverage scan, so it cannot
 * gain coverage and needs no node mapping. Used by `yg context --file` to answer
 * "excluded by design" instead of the misleading "add it to a node mapping".
 */
export function isCoverageExcludedPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (norm === '' || norm === '.') return false;
  const segments = norm.split('/');
  if (segments.includes('.git')) return true;
  if (norm === YGGDRASIL_DIRNAME || norm.startsWith(YGGDRASIL_DIRNAME + '/')) return true;
  return false;
}

/**
 * Everything a graph excludes globally, for one run: the filesystem-derived
 * nested-project boundary (a nested `.yggdrasil/` graph, or a nested `.git`
 * checkout/submodule/worktree — DEFAULT members of the excluded set, present
 * whether or not an adopter's config says anything) plus the adopter's own
 * `coverage.excluded` roots (the other source of members). One filter, two
 * sources — see {@link isExcludedFromGraph}, the single predicate every
 * caller that decides "does this path belong to this graph at all" asks.
 */
export interface GraphExclusionSet {
  nestedRoots: ReadonlySet<string>;
  coverage: CoverageConfig;
}

/** An exclusion set with no adopter-configured roots — only the (still real) nested-project boundary applies. Used where a caller has no `coverage` block to thread (e.g. a fixture with none configured). */
export const NO_COVERAGE_EXCLUDED: CoverageConfig = { required: [], excluded: [], typeLevel: false };

/**
 * Resolve the full excluded-set membership for one project run: a real
 * filesystem walk for the nested-project boundary (cached per resolved root —
 * see {@link findNestedProjectRoots}) packaged alongside the adopter's
 * `coverage.excluded` config. Callers that already hold `nestedRoots` from a
 * prior `findNestedProjectRoots` call in the same run may build the
 * `GraphExclusionSet` object literal directly instead of calling this again —
 * the cache makes either equally cheap, this is just the one-line form.
 */
export async function resolveGraphExclusionSet(
  projectRoot: string,
  coverage: CoverageConfig,
): Promise<GraphExclusionSet> {
  return { nestedRoots: await findNestedProjectRoots(projectRoot), coverage };
}

/**
 * True iff `relPath` is excluded from the graph for ANY reason the ONE
 * supreme filter recognizes (see the module's own section header above): a
 * path under a nested-project boundary (a default member of the excluded
 * set), or a path an adopter's own `coverage.excluded` config names (the
 * other source of members). Exclusion cuts everything it matches — including
 * a node's own explicit `mapping:` entry naming that exact path, a directory
 * mapping that recurses into it, or a glob that happens to match it. Every
 * caller that decides "does this path belong to this graph's enforcement
 * surface" — coverage counting, pair enumeration, the suppression/audit
 * universe, the relation pass, structure reads and companion resolution, the
 * portal, and every command that reports ownership or cost — asks THIS
 * question, so a path's excluded status can never disagree between them.
 *
 * Deliberately does NOT fold in `isCoverageExcludedPath` (`.git`, the
 * top-level `.yggdrasil/`): that predicate answers a DIFFERENT question — is
 * this path ever a candidate the ordinary coverage WALK enumerates at all —
 * and a node's explicit `mapping:` entry naming a file under `.yggdrasil/` is
 * sanctioned meta-modeling (documented in `checkFileMappingGitignored`),
 * deliberately reviewable despite the walk skipping it structurally. Folding
 * that predicate in here would make the supreme filter cut a mapping an
 * adopter deliberately wrote, which is not what "excluded" means for this
 * filter. A caller that also needs the walk-visibility question (e.g.
 * deciding whether to say "excluded from graph coverage by design" for a path
 * with NO owner at all) asks `isCoverageExcludedPath` alongside this, exactly
 * as it did before this filter existed.
 */
export function isExcludedFromGraph(relPath: string, exclusion: GraphExclusionSet): boolean {
  return (
    isUnderAnyNestedProjectRoot(relPath, exclusion.nestedRoots) ||
    isExcludedByCoverage(relPath, exclusion.coverage)
  );
}

/** {@link isExcludedFromGraph}, applied to a whole list — the shared filter half, reused by every caller that already holds a candidate list and an exclusion set. */
export function filterExcludedFromGraph(relPaths: string[], exclusion: GraphExclusionSet): string[] {
  return relPaths.filter((p) => !isExcludedFromGraph(p, exclusion));
}

/** Which of {@link isExcludedFromGraph}'s two sources a path's exclusion traces to. */
export type ExclusionSource = 'nested-project' | 'coverage-excluded';

/**
 * For a path already known to be excluded (`isExcludedFromGraph(relPath, exclusion)`
 * is true), which of the two independent sources caused it: a nested project's own
 * boundary (a default member of the excluded set, present regardless of config), or
 * an adopter's own `coverage.excluded` root. A diagnostic naming ONE cause instead of
 * making the reader check both against their own config and their own filesystem is
 * the whole reason this exists — `isExcludedFromGraph` itself deliberately stays a
 * single boolean (every caller that only needs "in or out" should not have to unpack
 * a source it never uses). Returns `null` for a path that is not excluded at all —
 * a caller that already branched on `isExcludedFromGraph` never sees that case, but
 * it is still the honest answer to "why", asked of a path with no cause.
 */
export function describeExclusionSource(relPath: string, exclusion: GraphExclusionSet): ExclusionSource | null {
  if (isUnderAnyNestedProjectRoot(relPath, exclusion.nestedRoots)) return 'nested-project';
  if (isExcludedByCoverage(relPath, exclusion.coverage)) return 'coverage-excluded';
  return null;
}

/**
 * Count of coverage-visible files a node mapping textually names — any entry
 * kind, directory, glob, or exact — but the graph's exclusion filter removes
 * from enforcement anyway. `scanUncoveredFiles` (core/check.ts) decides
 * "covered by a mapping" by matching mapping-entry TEXT alone
 * (`mappingEntryMatchesFile` has no notion of exclusion), so a file inside an
 * excluded root that a directory or glob entry sweeps in never lands in its
 * uncovered list — it reads as node-owned even though nothing enforces it: no
 * pair, no fingerprint contribution, no rule ever runs on it. `yg check`'s
 * header corrects its node-owned/excluded split by this count at the CLI
 * boundary (`cli/check.ts`) — moved out of "node-owned" and into "excluded"
 * — so the one number an adopter reads to see how much of a node's mapping
 * actually enforces never reports the opposite of what `yg context --node`
 * and `yg owner --file` already say about the same files.
 */
export async function countMappedButExcludedFiles(
  graph: Graph,
  coverageVisibleFiles: string[],
): Promise<number> {
  const projectRoot = dirname(graph.rootPath);
  const exclusion = await resolveGraphExclusionSet(projectRoot, graph.config.coverage ?? NO_COVERAGE_EXCLUDED);
  // Mirror core/check.ts's own totalFiles universe: the graph's own
  // .yggdrasil/ tree is never a coverage candidate in either direction, so a
  // file under it must not be double-subtracted here.
  const yggPrefix = toPosixPath(relative(projectRoot, graph.rootPath));
  const allMappings: string[] = [];
  for (const node of graph.nodes.values()) {
    allMappings.push(...normalizeMappingPaths(node.meta.mapping));
  }
  let count = 0;
  for (const raw of coverageVisibleFiles) {
    const normalized = toPosixPath(raw.trim());
    if (normalized.startsWith(yggPrefix + '/') || normalized === yggPrefix) continue;
    if (!isExcludedFromGraph(normalized, exclusion)) continue;
    if (allMappings.some((mp) => mappingEntryMatchesFile(mp, normalized))) count++;
  }
  return count;
}

/**
 * Walk all files in the repo, returning repo-relative POSIX paths.
 * Excludes `.yggdrasil/`, `.git` (directory or worktree/submodule pointer file),
 * symlinks, and gitignore-matched files.
 * Excludes every separate-project subtree (its own `.yggdrasil/` graph, or its
 * own `.git` — a nested checkout, submodule, or linked worktree), pruned
 * proactively during the walk against {@link findNestedProjectRoots}'s
 * filesystem-derived boundary set.
 */
export async function walkRepoFiles(projectRoot: string): Promise<string[]> {
  const [stack, nestedRoots] = await Promise.all([
    loadRootGitignoreStack(projectRoot),
    findNestedProjectRoots(projectRoot),
  ]);
  return collectFiles(projectRoot, projectRoot, stack, nestedRoots);
}

/**
 * List every git-TRACKED file that is a REGULAR file still present on disk
 * (repo-relative, POSIX), via `git ls-files` — the INDEX, which does not
 * respect `.gitignore` for a path already tracked (e.g. force-added with
 * `git add -f`, or gitignored only after it was tracked). This is the ONE
 * remaining git consumer in the coverage surface: every other check
 * (coverage, classification, enforcement) is fed by the disk-based
 * `walkRepoFiles` walk above, which is gitignore-aware but git-independent.
 * Comparing this list against that walk's output is the STRUCTURAL half of
 * the tracked∩gitignored anomaly check (`core/check.ts`'s
 * `scanTrackedButIgnored`, which layers a POSITIVE gitignore confirmation on
 * top — the walk skips a path for reasons other than gitignore too, so
 * absence from the walk alone is never proof of a gitignore match).
 *
 * The index also lists entries this check must never treat as an ordinary
 * missing-or-ignored file, because nothing truthful could be said about them:
 *   - a file deleted from disk with `rm` (not `git rm`) — still indexed,
 *     nothing to un-ignore or untrack, it is simply gone;
 *   - a symlink — `lstat` (never followed) reports it as neither a regular
 *     file nor absent, so a bare existence check would wrongly keep it;
 *   - a submodule gitlink (index mode 160000) — a checked-out submodule's
 *     root is a DIRECTORY on disk, and `git rm --cached` on it would drop the
 *     submodule reference from the index, which is destructive advice for
 *     something that was never a plain file to begin with.
 * `lstatSync(...).isFile()` (never following symlinks) excludes all three in
 * one guard, alongside a directory whose own permissions make it unreadable
 * (the lstat throws, caught below) — every failure mode here degrades to
 * "not a candidate" rather than a guess.
 *
 * Best-effort: git absent, the directory not a git repository, or any other
 * failure all degrade to `null` (never throws) — the caller treats `null` as
 * "skip this check", never as "no tracked files". `stdio` explicitly pipes
 * both streams so a failing `git` (e.g. "not a git repository") never leaks
 * its stderr into this process's own — the CLI's `--quiet` contract, and any
 * caller's stderr, must stay exactly as clean as when git is simply absent.
 */
export function listGitTrackedFiles(projectRoot: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: projectRoot,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map(toPosixPath)
      .filter((relPath) => {
        try {
          return lstatSync(join(projectRoot, relPath)).isFile();
        } catch {
          return false;
        }
      });
  } catch (err) {
    debugWrite(`[repo-scanner] listGitTrackedFiles: git ls-files failed: ${(err as Error).message}`);
    return null;
  }
}
