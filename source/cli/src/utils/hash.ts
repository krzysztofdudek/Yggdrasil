import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { type Ignore, type Options as IgnoreOptions } from 'ignore';
import type { TrackedFile } from '../core/context-files.js';

const require = createRequire(import.meta.url);
const ignoreFactory = require('ignore') as (options?: IgnoreOptions) => Ignore;

type HashPathOptions = {
  projectRoot?: string;
};

type GitignoreEntry = { basePath: string; matcher: Ignore };

export async function hashFile(filePath: string): Promise<string> {
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
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((entry) => `${entry.path}:${entry.hash}`)
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

function isIgnoredByStack(candidatePath: string, stack: GitignoreEntry[]): boolean {
  for (const { basePath, matcher } of stack) {
    const relativePath = path.relative(basePath, candidatePath);
    if (relativePath === '' || relativePath.startsWith('..')) continue;
    if (matcher.ignores(relativePath) || matcher.ignores(relativePath + '/')) return true;
  }
  return false;
}

export function hashString(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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
      result.push({ path: p, hash: await hashFile(absPath) });
    } else if (st.isDirectory()) {
      const hashes = await collectDirectoryFileHashes(absPath, absPath, {
        projectRoot: root,
        gitignoreStack,
      });
      for (const h of hashes) {
        result.push({
          path: path.join(p, h.path).split(path.sep).join('/'),
          hash: h.hash,
        });
      }
    }
  }

  return result;
}

/** Compute drift hash for a node mapping. Returns hex. */
export async function hashForMapping(
  projectRoot: string,
  mapping: { paths?: string[] },
): Promise<string> {
  const root = path.resolve(projectRoot);
  const paths = mapping.paths ?? [];
  if (paths.length === 0) throw new Error('Invalid mapping for hash: no paths');

  const pairs: Array<{ path: string; hash: string }> = [];

  for (const p of paths) {
    const absPath = path.join(root, p);
    const st = await stat(absPath);
    if (st.isFile()) {
      pairs.push({ path: p, hash: await hashFile(absPath) });
    } else if (st.isDirectory()) {
      const dirHash = await hashPath(absPath, { projectRoot: root });
      pairs.push({ path: p, hash: dirHash });
    }
  }

  const digestInput = pairs
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => `${e.path}:${e.hash}`)
    .join('\n');
  return createHash('sha256').update(digestInput).digest('hex');
}

/** Stored file data for mtime-based drift optimization. */
export interface StoredFileData {
  hashes: Record<string, string>;
  mtimes: Record<string, number>;
}

/**
 * Hash all tracked files (source + graph) for bidirectional drift detection.
 * Directories in the tracked list are expanded to their contained files.
 * Returns a canonical hash (sorted path:hash digest), per-file hashes, and mtimes.
 *
 * When `storedFileData` is provided, files whose mtime has not changed since
 * the last sync will reuse the stored hash instead of re-reading and hashing.
 * This makes the common case (no changes) nearly instant even for large mappings.
 */
export async function hashTrackedFiles(
  projectRoot: string,
  trackedFiles: TrackedFile[],
  storedFileData?: StoredFileData,
  excludePrefixes?: string[],
): Promise<{ canonicalHash: string; fileHashes: Record<string, string>; fileMtimes: Record<string, number> }> {
  const fileHashes: Record<string, string> = {};
  const fileMtimes: Record<string, number> = {};
  const gitignoreStack = await loadRootGitignoreStack(projectRoot);

  // Collect all file entries (expanding directories) with their metadata
  type FileEntry = { relPath: string; absPath: string; mtimeMs: number };
  const allFiles: FileEntry[] = [];

  for (const tf of trackedFiles) {
    const absPath = path.join(projectRoot, tf.path);
    try {
      const st = await stat(absPath);
      if (st.isDirectory()) {
        const dirEntries = await collectDirectoryFilePaths(absPath, absPath, {
          projectRoot,
          gitignoreStack,
        });
        for (const entry of dirEntries) {
          allFiles.push({
            relPath: path.join(tf.path, entry.relPath).replace(/\\/g, '/'),
            absPath: entry.absPath,
            mtimeMs: entry.mtimeMs,
          });
        }
      } else {
        allFiles.push({ relPath: tf.path, absPath, mtimeMs: st.mtimeMs });
      }
    } catch {
      continue;
    }
  }

  // Exclude files owned by descendant nodes (child-wins model)
  const filtered = excludePrefixes?.length
    ? allFiles.filter((entry) =>
        !excludePrefixes.some((prefix) =>
          entry.relPath === prefix || entry.relPath.startsWith(prefix + '/')))
    : allFiles;

  // Separate files into cached (mtime match) and dirty (need hashing)
  const dirty: FileEntry[] = [];
  for (const entry of filtered) {
    const storedMtime = storedFileData?.mtimes[entry.relPath];
    const storedHash = storedFileData?.hashes[entry.relPath];
    if (storedMtime !== undefined && storedHash !== undefined && entry.mtimeMs === storedMtime) {
      fileHashes[entry.relPath] = storedHash;
    } else {
      dirty.push(entry);
    }
    fileMtimes[entry.relPath] = entry.mtimeMs;
  }

  // Hash dirty files in parallel batches to avoid overwhelming file descriptors
  const BATCH_SIZE = 256;
  for (let i = 0; i < dirty.length; i += BATCH_SIZE) {
    const batch = dirty.slice(i, i + BATCH_SIZE);
    const hashes = await Promise.all(batch.map((e) => hashFile(e.absPath)));
    for (let j = 0; j < batch.length; j++) {
      fileHashes[batch[j].relPath] = hashes[j];
    }
  }

  // Canonical hash: sorted path:hash pairs
  const sorted = Object.entries(fileHashes).sort(([a], [b]) => a.localeCompare(b));
  const digest = sorted.map(([p, h]) => `${p}:${h}`).join('\n');
  const canonicalHash = hashString(digest);

  return { canonicalHash, fileHashes, fileMtimes };
}

/**
 * Collect file paths and mtimes from a directory without hashing.
 * Used by hashTrackedFiles to separate discovery from hashing,
 * enabling mtime-based optimization.
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
    const absoluteChildPath = path.join(directoryPath, entry.name);
    if (isIgnoredByStack(absoluteChildPath, stack)) continue;
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
        relPath: path.relative(rootDirectoryPath, f),
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
