import { lstatSync, readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { toPosixPath } from '../utils/posix.js';
import type { Artifact } from '../model/graph.js';
import { debugWrite } from '../utils/debug-log.js';
import { hashFile } from './hash.js';

export async function readArtifacts(
  dirPath: string,
  excludeFiles: string[] = ['yg-node.yaml'],
  includeFiles?: string[],
): Promise<Artifact[]> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    debugWrite(`[artifact-reader] readdir: ${(err as Error).message}`);
    return [];
  }
  const artifacts: Artifact[] = [];
  const includeSet = includeFiles && includeFiles.length > 0 ? new Set(includeFiles) : null;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (excludeFiles.includes(entry.name)) continue;
    if (includeSet && !includeSet.has(entry.name)) continue;

    const filePath = path.join(dirPath, entry.name);
    const content = await readFile(filePath, 'utf-8');
    artifacts.push({ filename: entry.name, content });
  }

  // Sort by filename for deterministic output
  artifacts.sort((a, b) => a.filename.localeCompare(b.filename));
  return artifacts;
}

/**
 * Every file in a rule's directory that the rule's code can reach besides its
 * own rule files, as `[posix path relative to the directory, sha256]`, sorted.
 *
 * A `check.mjs` (or a `companion.mjs`) may import a helper module beside it, or
 * read a table shipped with it. Those bytes decide the verdict exactly as the
 * rule file's own do, so they are verdict inputs too: without them, an update
 * that changed only a helper kept a stale pass on every warm cache.
 *
 * What is NOT the rule: files at the top of the directory that describe or tune
 * it rather than run (`exclude` — the rule definition, the rule files already
 * hashed on their own, an adaptation, a log, a generator's provenance record),
 * the `drills/` corpus it is measured against, dot-prefixed entries, and any
 * subdirectory holding a `yg-aspect.yaml` of its own — that is a nested rule,
 * with its own verdicts.
 *
 * A directory that cannot be read yields nothing — the rule then has no support
 * files, which is the ordinary case.
 */
export async function readSupportFileHashes(
  dirPath: string,
  exclude: readonly string[],
): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];

  async function walk(dirAbs: string, relPrefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      debugWrite(`[artifact-reader] support files of ${dirAbs}: ${(err as Error).message}`);
      return;
    }
    if (relPrefix !== '' && entries.some((e) => e.isFile() && e.name === 'yg-aspect.yaml')) return;
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (relPrefix === '' && entry.name === 'drills') continue;
        await walk(path.join(dirAbs, entry.name), rel);
      } else if (entry.isFile()) {
        if (relPrefix === '' && exclude.includes(entry.name)) continue;
        out.push([rel, await hashFile(path.join(dirAbs, entry.name))]);
      }
    }
  }

  await walk(dirPath, '');
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Symbolic links in the files a rule is made of are refused, not followed.
 *
 * A rule's text and code are verdict inputs: what a reviewer is shown, what a
 * check runs, and what the verdict hash folds must be the same bytes. A symlink
 * breaks that in two ways. Readers disagree about it — one follows the link and
 * another skips it as "not a regular file" — so a rule ran its target while
 * hashing as nothing, or was reviewed as an empty rule while listed as
 * enforced. And a link can point outside the repository, so a clone, a CI
 * runner and a developer machine would each see different content under one
 * committed path, or a host file would reach a third-party reviewer.
 *
 * The same policy covers rule sources and the reference files a rule shows the
 * reviewer, and it matches the one mapped source files already follow: a path
 * that runs through a symlink is an error naming the link. A monorepo that
 * shares a rule copies it, or installs it as a package.
 */

/**
 * The first component of `rel` (a repository-relative path) that is a symbolic
 * link, as a repository-relative POSIX path, or null when none is. Components
 * that do not exist end the walk: a missing path is some other check's error.
 * Only components below `root` are examined — whatever the repository itself
 * sits under is not the repository's to answer for.
 */
export function symlinkOnPath(root: string, rel: string): string | null {
  const parts = toPosixPath(rel).split('/').filter((p) => p !== '' && p !== '.');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return parts.slice(0, i + 1).join('/');
  }
  return null;
}

/**
 * Every symbolic link among the files a rule directory contributes to its rule,
 * as POSIX paths relative to the directory, sorted: the top-level files
 * (yg-aspect.yaml, content.md, check.mjs, companion.mjs, an adaptation) and the
 * support files its code can reach, walked exactly as the verdict's support-file
 * hash walks them — dot-prefixed entries, `node_modules`, the top-level
 * `drills/` corpus and nested rule directories are not part of this rule and
 * are not examined. A directory that cannot be read yields nothing.
 */
export function ruleDirSymlinks(aspectDir: string): string[] {
  const found: string[] = [];
  const walk = (dirAbs: string, relPrefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch (err) {
      debugWrite(`[artifact-reader] ${dirAbs}: ${(err as Error).message}`);
      return;
    }
    if (relPrefix !== '' && entries.some((e) => e.isFile() && e.name === 'yg-aspect.yaml')) return;
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        found.push(rel);
      } else if (entry.isDirectory()) {
        if (relPrefix === '' && entry.name === 'drills') continue;
        walk(path.join(dirAbs, entry.name), rel);
      }
    }
  };
  walk(aspectDir, '');
  return found.sort();
}
