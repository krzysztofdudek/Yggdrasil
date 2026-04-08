import { readFile, writeFile, stat, readdir, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';
import type { DriftState, DriftNodeState } from '../model/drift.js';

const DRIFT_STATE_DIR = '.drift-state';

/** Convert node path to per-node state file path under .drift-state/ */
function nodeStatePath(yggRoot: string, nodePath: string): string {
  return path.join(yggRoot, DRIFT_STATE_DIR, `${nodePath}.json`);
}

/**
 * Recursively scan a directory for .json files.
 * Returns array of paths relative to baseDir (without .json extension).
 */
async function scanJsonFiles(dir: string, baseDir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await scanJsonFiles(fullPath, baseDir);
      results.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      const relPath = path.relative(baseDir, fullPath);
      // Remove .json extension and normalize to posix
      const nodePath = relPath.replace(/\\/g, '/').replace(/\.json$/, '');
      results.push(nodePath);
    }
  }
  return results;
}

/**
 * Remove empty directories walking up from filePath to (but not including) stopDir.
 */
async function removeEmptyParents(filePath: string, stopDir: string): Promise<void> {
  let dir = path.dirname(filePath);
  while (dir !== stopDir && dir.startsWith(stopDir)) {
    try {
      const entries = await readdir(dir);
      if (entries.length === 0) {
        await rm(dir, { recursive: true });
        dir = path.dirname(dir);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/** Read a single node's drift state from .drift-state/<nodePath>.json */
export async function readNodeDriftState(
  yggRoot: string,
  nodePath: string,
): Promise<DriftNodeState | undefined> {
  try {
    const filePath = nodeStatePath(yggRoot, nodePath);
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as DriftNodeState;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Write a single node's drift state to .drift-state/<nodePath>.json */
export async function writeNodeDriftState(
  yggRoot: string,
  nodePath: string,
  nodeState: DriftNodeState,
): Promise<void> {
  const filePath = nodeStatePath(yggRoot, nodePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = JSON.stringify(nodeState, null, 2) + '\n';
  await writeFile(filePath, content, 'utf-8');
}

/**
 * Garbage-collect drift state: remove .json files for node paths NOT in validNodePaths.
 * Cleans up empty parent directories after removal.
 * Returns sorted list of removed node paths.
 */
export async function garbageCollectDriftState(
  yggRoot: string,
  validNodePaths: Set<string>,
): Promise<string[]> {
  const driftDir = path.join(yggRoot, DRIFT_STATE_DIR);
  const allNodePaths = await scanJsonFiles(driftDir, driftDir);
  const removed: string[] = [];

  for (const nodePath of allNodePaths) {
    if (!validNodePaths.has(nodePath)) {
      const filePath = nodeStatePath(yggRoot, nodePath);
      await rm(filePath);
      await removeEmptyParents(filePath, driftDir);
      removed.push(nodePath);
    }
  }

  return removed.sort();
}

/**
 * Read full drift state.
 * - If .drift-state is a directory: scan for per-node .json files.
 * - If .drift-state is a file (legacy): parse it, migrate to per-node files, delete old file.
 * - If .drift-state doesn't exist: return {}.
 */
export async function readDriftState(yggRoot: string): Promise<DriftState> {
  const driftPath = path.join(yggRoot, DRIFT_STATE_DIR);

  let driftStat;
  try {
    driftStat = await stat(driftPath);
  } catch {
    return {};
  }

  // Legacy single-file format: migrate to per-node files
  if (driftStat.isFile()) {
    const content = await readFile(driftPath, 'utf-8');
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      raw = yamlParse(content);
    }

    if (!raw || typeof raw !== 'object') return {};

    const state: DriftState = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'object' && value !== null && 'hash' in value) {
        state[key] = value as DriftNodeState;
      }
      // Skip legacy string entries silently
    }

    // Migrate: delete old file, write per-node files
    await rm(driftPath);
    for (const [nodePath, nodeState] of Object.entries(state)) {
      await writeNodeDriftState(yggRoot, nodePath, nodeState);
    }

    return state;
  }

  // Directory format: scan for per-node .json files
  const nodePaths = await scanJsonFiles(driftPath, driftPath);
  const state: DriftState = {};
  for (const nodePath of nodePaths) {
    const nodeState = await readNodeDriftState(yggRoot, nodePath);
    if (nodeState) {
      state[nodePath] = nodeState;
    }
  }
  return state;
}

/**
 * Write full drift state as per-node files.
 * Each entry is written as a separate .json file under .drift-state/.
 */
export async function writeDriftState(yggRoot: string, state: DriftState): Promise<void> {
  for (const [nodePath, nodeState] of Object.entries(state)) {
    await writeNodeDriftState(yggRoot, nodePath, nodeState);
  }
}
