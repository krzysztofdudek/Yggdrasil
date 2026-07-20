import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { type Ignore, type Options as IgnoreOptions } from 'ignore';
import { debugWrite } from '../utils/debug-log.js';

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
    // pointer FILE `gitdir: ...` (git worktree / submodule checkout).
    if (entry.name === '.git') continue;
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === YGGDRASIL_DIRNAME && dir === projectRoot) continue;
      if (isIgnoredByStack(absPath, localStack, true)) continue;
      results.push(...(await collectFiles(absPath, projectRoot, localStack)));
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
  if (nestedRoots.size === 0) return relPaths;
  return relPaths.filter((p) => {
    for (const root of nestedRoots) {
      if (p === root || p.startsWith(root + '/')) return false;
    }
    return true;
  });
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
 * Walk all files in the repo, returning repo-relative POSIX paths.
 * Excludes `.yggdrasil/`, `.git` (directory or worktree/submodule pointer file),
 * symlinks, and gitignore-matched files.
 * Excludes subtrees that contain their own nested `.yggdrasil/` directory.
 */
export async function walkRepoFiles(projectRoot: string): Promise<string[]> {
  const stack = await loadRootGitignoreStack(projectRoot);
  const files = await collectFiles(projectRoot, projectRoot, stack);
  return excludeNestedGraphSubtrees(files);
}
