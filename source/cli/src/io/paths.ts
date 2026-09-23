import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { normalizeMappingPath } from '../utils/mapping-path.js';
import { toPosixPath } from '../utils/posix.js';

/**
 * Directory containing the CLI package (dist/ when bundled).
 * Uses import.meta.url so it works when installed globally.
 */
export function getPackageRoot(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Find the .yggdrasil/ directory starting from projectRoot.
 * Searches upward through parent directories until found or filesystem root.
 * Returns the absolute path to the .yggdrasil/ directory.
 */
export async function findYggRoot(projectRoot: string): Promise<string> {
  let current = path.resolve(projectRoot);
  const root = path.parse(current).root;

  while (true) {
    const yggPath = path.join(current, '.yggdrasil');
    try {
      const st = await stat(yggPath);
      if (!st.isDirectory()) {
        throw new Error(
          `.yggdrasil exists but is not a directory (${yggPath}). Run 'yg init' in a clean location.`,
        );
      }
      return yggPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (current === root) {
          throw new Error(`No .yggdrasil/ directory found. Run 'yg init' first.`, { cause: err });
        }
        current = path.dirname(current);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Normalize a mapping to always return an array of paths (relative to project root).
 * Each path can be a file or directory — type is detected at runtime by hash/owner.
 * Format: flat string array.
 */
export function normalizeMappingPaths(mapping: string[] | undefined): string[] {
  if (!mapping || !Array.isArray(mapping)) return [];

  const paths: string[] = [];
  for (const item of mapping) {
    if (typeof item === 'string') {
      const normalized = normalizeMappingPath(item);
      if (normalized) {
        paths.push(normalized);
      }
    }
  }
  return paths;
}

/**
 * Normalize a user-provided path to project-relative POSIX form.
 * Throws when the target path points outside the project root.
 */
export function normalizeProjectRelativePath(projectRoot: string, rawPath: string): string {
  const normalizedInput = toPosixPath(rawPath.trim());
  if (normalizedInput.length === 0) {
    throw new Error('Path cannot be empty');
  }

  const absolute = path.resolve(projectRoot, normalizedInput);
  const relative = path.relative(projectRoot, absolute);
  const isOutside = relative.startsWith('..') || path.isAbsolute(relative);
  if (isOutside) {
    throw new Error(`Path is outside project root: ${rawPath}`);
  }

  return toPosixPath(relative);
}

/**
 * Derive the actual project root (repo root) from the graph's .yggdrasil/ path.
 */
export function projectRootFromGraph(yggRootPath: string): string {
  return path.dirname(yggRootPath);
}

export function resolveFileArg(repoRoot: string, rawPath: string): string {
  const absolute = path.resolve(repoRoot, rawPath.trim());
  return toPosixPath(path.relative(repoRoot, absolute));
}
