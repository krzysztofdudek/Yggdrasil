import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { type Ignore, type Options as IgnoreOptions } from 'ignore';
import { toPosix, toPosixPath } from '../utils/posix.js';
import { isGlobPattern, globMatch, normalizeMappingPath } from '../utils/mapping-path.js';
import { findNestedProjectRoots, filterExcludedFromGraph } from '../io/repo-scanner.js';
import type { CoverageConfig } from '../model/graph.js';

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

/**
 * sha256 hex of a file's RAW bytes — no line-ending normalization, unlike
 * {@link hashFile}. Used wherever the hash must track byte-for-byte identity
 * because a downstream consumer reads the file's raw, un-normalized bytes:
 * the type-classification cache key (io/type-class-cache.ts), whose
 * `content:` predicates are evaluated by io/file-content-cache.ts's
 * `buf.toString('utf8')` — a raw read that never collapses CRLF/CR to LF.
 * Keying on the normalized hash there would let a CRLF file and its LF twin
 * (different bytes, different predicate results) share one cache entry.
 * `hashFile`'s own normalization stays correct and unchanged for its actual
 * callers (verdict/fingerprint hashing in core/pairs.ts, mapping hashing),
 * where "the same source, checked out with different line endings" SHOULD
 * hash identically — that is a different identity question than this one.
 */
export async function hashFileRaw(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
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
 * Expand mapping paths to individual files, then drop every file the graph
 * excludes globally — the one supreme filter (`io/repo-scanner.ts`'s
 * `isExcludedFromGraph`), which combines two sources: a SEPARATE project's own
 * boundary (a directory below the mapping carrying its own `.yggdrasil/`
 * graph, or its own `.git` — a nested checkout, submodule, or linked
 * worktree; a DEFAULT member of the excluded set, present with or without any
 * adopter config) and the adopter's own `coverage.excluded` roots (the other
 * source of members). A file matched by either is governed outside this
 * graph, and must never be attributed to the graph doing the expanding (not
 * counted as its pairs, not fed into its fingerprints, not exposed as its
 * review content, not folded into its read-allowances) — regardless of
 * whether a mapping entry named it exactly, swept it in via a directory, or
 * matched it via a glob: exclusion cuts everything it matches, with no
 * carve-out for an explicit claim.
 *
 * The nested-project half is read off the real FILESYSTEM
 * (`findNestedProjectRoots`), independently of `mappingPaths` — so it gives
 * the same answer whether the mapping is a directory or a glob (a glob's own
 * extension filter can strip every path that would otherwise reveal a nested
 * marker) and regardless of whether a `.gitignore` line hides the marker
 * itself. It is also the SAME root set every other caller in one run computes
 * for the same `projectRoot` (cached — see repo-scanner.ts), so two different
 * mappings — even a whole graph's worth expanded together, as the
 * suppression-scan audit does — can never draw the boundary in two different
 * places. `coverage` is the caller's own `graph.config.coverage` (or an
 * equivalent with an empty `excluded` list when the caller has none), so the
 * adopter-configured half agrees with every other consumer of the same config
 * for the same reason.
 *
 * This is the ONE place this guard is applied for every caller that turns a
 * mapping into "the files this graph actually owns" — `expandMappingPaths`
 * itself stays a neutral, exclusion-unaware primitive (plenty of callers —
 * mapping validation, the type-when evaluator, the relation-conformance pass
 * — resolve a mapping for a purpose that has nothing to do with THIS graph's
 * own enforcement boundary, and must not have that boundary imposed on them
 * by the shared primitive). Callers that DO mean "the files this graph
 * enforces / reviews / hashes" should call this instead of composing
 * `expandMappingPaths` with the exclusion filter themselves.
 */
export async function expandMappingPathsWithinOwnGraph(
  projectRoot: string,
  mappingPaths: string[],
  coverage: CoverageConfig,
): Promise<string[]> {
  const [expanded, nestedRoots] = await Promise.all([
    expandMappingPaths(projectRoot, mappingPaths),
    findNestedProjectRoots(projectRoot),
  ]);
  return filterExcludedFromGraph(expanded, { nestedRoots, coverage });
}

/**
 * Per-run cache of a NODE's mapping expansion (`expandMappingPathsWithinOwnGraph`
 * above), keyed by resolved projectRoot then node path. That function walks the
 * real directory tree and re-evaluates the whole `.gitignore` stack on every call
 * with no memoisation of its own; `buildUnitCtx` (structure/hook-loader.ts) calls
 * it — via `enumerateNodeMappedFilesCached` below, directly or through
 * `buildOwnFiles` — for the current node's own mapping AND for every relation
 * target's mapping on EVERY invocation. A `per: file` rule with N subjects on one
 * node, whose relation target maps M files, was re-walking that target's M files
 * N times over — an identical (mapping, root, coverage) triple each time, since
 * `projectRoot`/`coverage` are constant for a run and a node's `mapping:` array
 * is immutable in-memory graph data for the life of the `Graph` object that
 * loaded it.
 *
 * Lives here, immediately alongside the function it memoises, rather than in
 * structure/hook-loader.ts (its only caller): from there, wiring the reset into
 * the portal's per-refresh re-extraction would have needed a new
 * cli/portal/engine-api → cli/structure relation just to reach a cache the
 * portal never otherwise has reason to know lives three layers up in the
 * structure runtime. Co-located with `expandMappingPathsWithinOwnGraph` instead,
 * the reset rides the SAME cli/io/stores relation engine-api already declares
 * for every other io-layer read it re-exports — no new relation, no fan-out cost.
 *
 * Keyed by node path NESTED under resolved projectRoot, not by node path alone:
 * node path is unique only WITHIN one root, and the caller (`buildUnitCtx`) takes
 * `projectRoot` as an explicit parameter rather than assuming a single fixed root
 * for the process — a test process (many mkdtemp fixture roots in one worker,
 * commonly reusing short node names like "svc" or "A" across fixtures) or a
 * future multi-root caller would otherwise serve one root's file list to a
 * same-named node in a different root. Scoping under the resolved root first
 * costs one extra Map hop and closes that hole for free.
 *
 * Mirrors `findNestedProjectRoots` (this file's sibling io module,
 * repo-scanner.ts, imported above): a per-run cache of in-flight Promises in a
 * module-level Map (so concurrent callers awaiting the SAME node collapse onto
 * one disk walk instead of racing separate ones), with an explicit reset for the
 * one long-lived process (`yg portal`) — see `resetMappedFilesCache` below.
 */
let mappedFilesCache = new Map<string, Map<string, Promise<string[]>>>();

/**
 * Drop the mapping-expansion cache above. Call this everywhere
 * `resetNestedProjectRootsCache` is already called for the same reason: today
 * that is only the portal server's per-refresh re-extraction (portal/extract.ts)
 * — a one-shot CLI command's cache starts empty and the process exits before it
 * could ever go stale. A refresh reloads the graph from disk, and a node's
 * mapped directory can gain or lose files between refreshes, so this cache must
 * not outlive the extraction that populated it.
 */
export function resetMappedFilesCache(): void {
  mappedFilesCache = new Map();
}

/**
 * Normalize a node's raw mapping entries and expand them through
 * `expandMappingPathsWithinOwnGraph` above — the uncached primitive
 * `enumerateNodeMappedFilesCached` memoises. Not exported: every caller reaches
 * this through the cache below, never directly.
 */
async function enumerateMappedFilesAsync(mappingPaths: string[], projectRoot: string, coverage: CoverageConfig): Promise<string[]> {
  const normalized = mappingPaths
    .map(normalizeMappingPath)
    .filter((p): p is string => p !== '');
  return expandMappingPathsWithinOwnGraph(projectRoot, normalized, coverage);
}

/**
 * Cached wrapper around `enumerateMappedFilesAsync`, keyed by (resolved
 * projectRoot, nodePath) — see `mappedFilesCache` above. Every `buildUnitCtx`
 * call site that expands a NAMED node's mapping (as opposed to an ad hoc path
 * list with no owning node) goes through this, not `enumerateMappedFilesAsync`
 * directly, so repeated expansions of the same node's mapping — across the
 * ctx.graph pre-expansion loop, the AST prewarm loop, and repeated
 * `buildUnitCtx` calls for different subjects of the same rule — share one disk
 * walk instead of repeating it.
 *
 * Only the DIRECTORY WALK is cached. Every caller still reads each file's bytes
 * fresh from disk on every use — this cache never stores content, so an edit to
 * a file already in a cached path list is picked up the next time anything reads
 * that file, with no reset required. A reset is only needed to see a file being
 * ADDED to or REMOVED from a mapped directory after the first expansion (see
 * `resetMappedFilesCache` above).
 */
export async function enumerateNodeMappedFilesCached(
  nodePath: string,
  mapping: string[] | undefined,
  projectRoot: string,
  coverage: CoverageConfig,
): Promise<string[]> {
  const rootKey = path.resolve(projectRoot);
  let byNode = mappedFilesCache.get(rootKey);
  if (!byNode) {
    byNode = new Map();
    mappedFilesCache.set(rootKey, byNode);
  }
  let cached = byNode.get(nodePath);
  if (!cached) {
    cached = enumerateMappedFilesAsync(mapping ?? [], projectRoot, coverage);
    byNode.set(nodePath, cached);
  }
  return cached;
}
