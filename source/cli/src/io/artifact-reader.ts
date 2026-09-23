import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
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
