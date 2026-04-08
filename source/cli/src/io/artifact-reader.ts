import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Artifact } from '../model/graph.js';
import { debugWrite } from '../utils/debug-log.js';

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
