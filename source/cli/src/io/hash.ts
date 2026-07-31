import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { type Ignore, type Options as IgnoreOptions } from 'ignore';
import { toPosix, toPosixPath } from '../utils/posix.js';
import { isGlobPattern, globMatch } from '../utils/mapping-path.js';
import { findNestedProjectRoots, filterOutsideNestedProjectRoots } from '../io/repo-scanner.js';

export { loadRootGitignoreStack, isIgnoredByStack, walkRepoFiles } from '../io/repo-scanner.js';
export type { GitignoreEntry } from '../io/repo-scanner.js';

const require = createRequire(import.meta.url);
const ignoreFactory = require('ignore') as (options?: IgnoreOptions) => Ignore;

type HashPathOptions = {
  projectRoot?: string;
};

type GitignoreEntry = { basePath: string; matcher: Ignore };

const CR = 0x0d;
const LF = 0x0a;

/**
 * Normalize line endings so the STYLE of line break never affects a content
 * hash: every CRLF (`\r\n`) and every lone CR (`\r`) becomes a single LF (`\n`).
 * The same source checked out with CRLF on Windows and LF on Linux therefore
 * hashes identically — a verdict survives a line-ending change and no spurious
 * re-verification or log-gate prompt is triggered.
 *
 * Operates on raw bytes (CR/LF are ASCII, so this is UTF-8 safe). A buffer with
 * no CR is returned unchanged (byte-identical, same reference). The result is
 * never longer than the input — only used as a hash input, never written back as
 * file content. Binary mapped files are normalized too (a deliberate, harmless
 * trade-off for a single uniform chokepoint — see CHANGELOG 5.0.2).
 */
export function normalizeLineEndings(bytes: Buffer): Buffer {
  if (!bytes.includes(CR)) return bytes;
  const out = Buffer.allocUnsafe(bytes.length);
  let w = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === CR) {
      out[w++] = LF;
      if (bytes[i + 1] === LF) i++; // collapse a CRLF pair into the single LF just written
    } else {
      out[w++] = bytes[i];
    }
  }
  return out.subarray(0, w);
}

/** sha256 hex of a file's content, with line endings normalized (see {@link normalizeLineEndings}). */
export async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return hashBytes(content);
}

export async function hashPath(targetPath: string, options: HashPathOptions = {}): Promise<string> {
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : undefined;
  const gitignoreStack = await loadRootGitignoreStack(projectRoot);
  const targetStat = await stat(targetPath);

  if (targetStat.isFile()) {
    // Mapped files are always hashed — gitignore only applies to directory scans.
    return hashFile(targetPath);
  }

  if (targetStat.isDirectory()) {
    const fileHashes = await collectDirectoryFileHashes(targetPath, targetPath, {
      projectRoot,
      gitignoreStack,
    });
    const digestInput = fileHashes
      .map((entry) => `${entry.path}:${entry.hash}`)
      .sort()
      .join('\n');
    return hashString(digestInput);
  }

  throw new Error(`Unsupported mapping path type: ${targetPath}`);
}

async function collectDirectoryFileHashes(
  directoryPath: string,
  rootDirectoryPath: string,
  options: { projectRoot?: string; gitignoreStack?: GitignoreEntry[] },
): Promise<Array<{ path: string; hash: string }>> {
  const filePaths = await collectDirectoryFilePaths(directoryPath, rootDirectoryPath, options);
  const result: Array<{ path: string; hash: string }> = [];
  for (const entry of filePaths) {
    result.push({ path: entry.relPath, hash: await hashFile(entry.absPath) });
  }
  return result;
}

async function loadRootGitignoreStack(projectRoot?: string): Promise<GitignoreEntry[]> {
  if (!projectRoot) return [];
  try {
    const content = await readFile(path.join(projectRoot, '.gitignore'), 'utf-8');
    const matcher = ignoreFactory();
    matcher.add(content);
    return [{ basePath: projectRoot, matcher }];
  } catch {
    return [];
  }
}

function isIgnoredByStack(
  candidatePath: string,
  stack: GitignoreEntry[],
  isDirectory = false,
): boolean {
  for (const { basePath, matcher } of stack) {
    const relativePath = toPosix(path.relative(basePath, candidatePath));
    if (relativePath === '' || relativePath.startsWith('..')) continue;
    // Query the bare path always, and the directory form (trailing slash) ONLY
    // when the candidate is actually a directory. A directory-only .gitignore
    // pattern (e.g. `build/`) matches git-side only against directories, so
    // querying `relativePath + '/'` for a FILE would wrongly drop a tracked file
    // whose name collides with such a pattern (e.g. a file `scripts/build` under
    // a `build/` rule) — excluding it from the node's hashed subject set and
    // producing a false green. Real directories are still pruned: the
    // isDirectory form runs the trailing-slash query for them. Mirrors the C-27
    // fix in io/repo-scanner.ts's isIgnoredByStack.
    if (matcher.ignores(relativePath) || (isDirectory && matcher.ignores(relativePath + '/'))) return true;
  }
  return false;
}

/**
 * Defense-in-depth containment guard: true iff `relPath` resolved against
 * `root` stays inside `root`. The node-parser rejects escaping mappings at parse
 * time (they never reach a loaded graph), so this is belt-and-suspenders — if an
 * escaping mapping ever reaches expansion another way, its out-of-repo path must
 * not be surfaced to a caller (e.g. the reviewer-prompt subject assembler).
 */
function isWithinRoot(root: string, relPath: string): boolean {
  const rel = path.relative(root, path.resolve(root, relPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function hashString(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** sha256 hex of bytes, with line endings normalized (see {@link normalizeLineEndings}). */
export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(normalizeLineEndings(bytes)).digest('hex');
}

/** Compute per-file hashes for a mapping. Used for diagnostics (which files changed). */
export async function perFileHashes(
  projectRoot: string,
  mapping: { paths?: string[] },
): Promise<Array<{ path: string; hash: string }>> {
  const root = path.resolve(projectRoot);
  const paths = mapping.paths ?? [];
  if (paths.length === 0) return [];

  const result: Array<{ path: string; hash: string }> = [];
  const gitignoreStack = await loadRootGitignoreStack(root);

  for (const p of paths) {
    const absPath = path.join(root, p);
    const st = await stat(absPath);
    if (st.isFile()) {
      result.push({ path: toPosixPath(p), hash: await hashFile(absPath) });
    } else if (st.isDirectory()) {
      const hashes = await collectDirectoryFileHashes(absPath, absPath, {
        projectRoot: root,
        gitignoreStack,
      });
      for (const h of hashes) {
        result.push({
          path: toPosixPath(path.join(p, h.path)),
          hash: h.hash,
        });
      }
    }
  }

  return result;
}

/**
 * Collect file paths and mtimes from a directory without hashing.
 * Used by expandMappingPaths and pairs/fingerprint computation.
 *
 * Directory recursion and file stat() calls are parallelized for performance.
 */
async function collectDirectoryFilePaths(
  directoryPath: string,
  rootDirectoryPath: string,
  options: { projectRoot?: string; gitignoreStack?: GitignoreEntry[] },
): Promise<Array<{ relPath: string; absPath: string; mtimeMs: number }>> {
  let stack = options.gitignoreStack ?? [];
  try {
    const localContent = await readFile(path.join(directoryPath, '.gitignore'), 'utf-8');
    const localMatcher = ignoreFactory();
    localMatcher.add(localContent);
    stack = [...stack, { basePath: directoryPath, matcher: localMatcher }];
  } catch {
    // No local .gitignore
  }

  const entries = await readdir(directoryPath, { withFileTypes: true });
  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    // `.git` is never a mappable source, in either form: the directory (a
    // checkout's own git metadata) or the pointer FILE `gitdir: ...` (a
    // submodule/worktree checkout). Mirrors repo-scanner.ts's `collectFiles`
    // skip, so a directory/glob mapping that happens to cover the project
    // root (or any directory carrying its own `.git`) never hashes or
    // reviews git's internal object store as though it were source.
    if (entry.name === '.git') continue;
    const absoluteChildPath = path.join(directoryPath, entry.name);
    if (isIgnoredByStack(absoluteChildPath, stack, entry.isDirectory())) continue;
    if (entry.isDirectory()) dirs.push(absoluteChildPath);
    else if (entry.isFile()) files.push(absoluteChildPath);
  }

  // Parallel: recurse into directories AND stat files concurrently
  const [dirResults, fileStats] = await Promise.all([
    Promise.all(dirs.map((d) => collectDirectoryFilePaths(d, rootDirectoryPath, {
      projectRoot: options.projectRoot,
      gitignoreStack: stack,
    }))),
    Promise.all(files.map(async (f) => {
      const fileStat = await stat(f);
      return {
        relPath: toPosixPath(path.relative(rootDirectoryPath, f)),
        absPath: f,
        mtimeMs: fileStat.mtimeMs,
      };
    })),
  ]);

  const result: Array<{ relPath: string; absPath: string; mtimeMs: number }> = [];
  for (const nested of dirResults) result.push(...nested);
  result.push(...fileStats);
  return result;
}

/**
 * Expand a single glob mapping entry into the concrete files it matches.
 *
 * Walks from the glob's base directory — the leading path segments BEFORE the
 * first segment containing a glob metachar (if the first segment is already a
 * glob, the base is projectRoot) — and keeps the entries matching the full
 * pattern (minimatch, { dot: true }, segment-aware). Honors .gitignore via the
 * supplied stack. Returns { relPath (POSIX, relative to projectRoot), absPath,
 * mtimeMs } so callers can both display paths and reuse the mtime without an
 * extra stat. A missing base directory yields an empty list (silent skip).
 *
 * Single source of truth for glob expansion, shared by expandMappingPaths
 * (display/validation) and pairs/fingerprint computation.
 */
async function expandGlobEntry(
  projectRoot: string,
  glob: string,
  gitignoreStack: GitignoreEntry[],
): Promise<Array<{ relPath: string; absPath: string; mtimeMs: number }>> {
  const segments = glob.split('/');
  const firstGlobIdx = segments.findIndex((s) => isGlobPattern(s));
  const baseSegments = firstGlobIdx > 0 ? segments.slice(0, firstGlobIdx) : [];
  const baseDir = baseSegments.length > 0 ? path.join(projectRoot, ...baseSegments) : projectRoot;
  try {
    const dirEntries = await collectDirectoryFilePaths(baseDir, projectRoot, {
      projectRoot,
      gitignoreStack,
    });
    return dirEntries
      .filter((entry) => globMatch(entry.relPath, glob))
      .map((entry) => ({
        relPath: toPosixPath(entry.relPath),
        absPath: entry.absPath,
        mtimeMs: entry.mtimeMs,
      }));
  } catch {
    // Base dir missing — skip
    return [];
  }
}

/**
 * Expand mapping paths to individual file paths.
 * Directories are recursively expanded (respecting .gitignore).
 * Files are returned as-is. Missing paths are silently skipped.
 * Glob entries (containing * ? [ ] { }) are expanded via minimatch against
 * files under the glob's base directory.
 *
 * Returns relative paths (forward-slash normalized) suitable for display.
 */
export async function expandMappingPaths(
  projectRoot: string,
  mappingPaths: string[],
): Promise<string[]> {
  const root = path.resolve(projectRoot);
  const gitignoreStack = await loadRootGitignoreStack(projectRoot);
  const result: string[] = [];

  // Every returned path is funneled through the containment guard, so a resolved
  // path that escapes the repo root is never surfaced (see isWithinRoot).
  const pushContained = (relPath: string): void => {
    if (isWithinRoot(root, relPath)) result.push(relPath);
  };

  for (const mp of mappingPaths) {
    if (isGlobPattern(mp)) {
      const entries = await expandGlobEntry(projectRoot, mp, gitignoreStack);
      for (const entry of entries) pushContained(entry.relPath);
    } else {
      // Guard the mapping entry itself before touching the filesystem — an
      // escaping entry must not even be stat()'d as an in-repo path.
      if (!isWithinRoot(root, mp)) continue;
      const absPath = path.join(projectRoot, mp);
      try {
        const st = await stat(absPath);
        if (st.isDirectory()) {
          const dirEntries = await collectDirectoryFilePaths(absPath, absPath, {
            projectRoot,
            gitignoreStack,
          });
          for (const entry of dirEntries) {
            pushContained(toPosixPath(path.join(mp, entry.relPath)));
          }
        } else {
          pushContained(toPosixPath(mp));
        }
      } catch {
        // Missing path — skip
        continue;
      }
    }
  }

  return result;
}

/**
 * Expand mapping paths to individual files, then drop every file under a
 * SEPARATE project's own boundary — a directory (below the mapping) that
 * carries its own `.yggdrasil/` graph, or its own `.git` (a nested checkout,
 * submodule, or linked worktree), is governed by its own project, and its
 * files must never be attributed to the graph doing the expanding (not
 * counted as its pairs, not fed into its fingerprints, not exposed as its
 * review content, not folded into its read-allowances).
 *
 * The boundary is read off the real FILESYSTEM (`findNestedProjectRoots`),
 * independently of `mappingPaths` — so it gives the same answer whether the
 * mapping is a directory or a glob (a glob's own extension filter can strip
 * every path that would otherwise reveal a nested marker) and regardless of
 * whether a `.gitignore` line hides the marker itself. It is also the SAME
 * root set every other caller in one run computes for the same `projectRoot`
 * (cached — see repo-scanner.ts), so two different mappings — even a whole
 * graph's worth expanded together, as the suppression-scan audit does — can
 * never draw the boundary in two different places.
 *
 * This is the ONE place that guard is applied for every caller that turns a
 * mapping into "the files this graph actually owns" — `expandMappingPaths`
 * itself stays a neutral, nested-project-unaware primitive (plenty of callers
 * — mapping validation, the type-when evaluator, the relation-conformance
 * pass — resolve a mapping for a purpose that has nothing to do with THIS
 * graph's own enforcement boundary, and must not have that boundary imposed
 * on them by the shared primitive). Callers that DO mean "the files this
 * graph enforces / reviews / hashes" should call this instead of composing
 * `expandMappingPaths` with the boundary filter themselves.
 */
export async function expandMappingPathsWithinOwnGraph(
  projectRoot: string,
  mappingPaths: string[],
): Promise<string[]> {
  const [expanded, nestedRoots] = await Promise.all([
    expandMappingPaths(projectRoot, mappingPaths),
    findNestedProjectRoots(projectRoot),
  ]);
  return filterOutsideNestedProjectRoots(expanded, nestedRoots);
}
