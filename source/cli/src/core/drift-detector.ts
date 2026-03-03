import type {
  Graph,
  DriftReport,
  DriftEntry,
  DriftStatus,
  DriftFileChange,
  DriftCategory,
} from '../model/types.js';
import {
  readDriftState,
  writeDriftState,
} from '../io/drift-state-store.js';
import { hashTrackedFiles } from '../utils/hash.js';
import { collectTrackedFiles } from './context-files.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { access } from 'node:fs/promises';
import path from 'node:path';

/**
 * Compute mapping paths owned by descendant nodes that overlap with a node's own
 * mapping paths. Used to exclude child-owned files from parent drift hashing
 * ("child wins" model).
 */
function getChildMappingExclusions(graph: Graph, nodePath: string): string[] {
  const node = graph.nodes.get(nodePath);
  if (!node) return [];
  const parentMappings = normalizeMappingPaths(node.meta.mapping);
  if (parentMappings.length === 0) return [];

  const exclusions: string[] = [];
  for (const [childPath, childNode] of graph.nodes) {
    if (childPath === nodePath) continue;
    if (!childPath.startsWith(nodePath + '/')) continue; // not a descendant
    const childMappings = normalizeMappingPaths(childNode.meta.mapping);
    for (const cm of childMappings) {
      for (const pm of parentMappings) {
        if (cm === pm || cm.startsWith(pm + '/')) {
          exclusions.push(cm);
        }
      }
    }
  }
  return exclusions;
}

export async function detectDrift(graph: Graph, filterNodePath?: string): Promise<DriftReport> {
  const projectRoot = path.dirname(graph.rootPath);
  const driftState = await readDriftState(graph.rootPath);
  const entries: DriftEntry[] = [];

  for (const [nodePath, node] of graph.nodes) {
    if (filterNodePath && nodePath !== filterNodePath && !nodePath.startsWith(filterNodePath + '/')) continue;
    const mapping = node.meta.mapping;
    if (!mapping) continue;

    const mappingPaths = normalizeMappingPaths(mapping);
    if (mappingPaths.length === 0) continue;

    const storedEntry = driftState[nodePath];

    if (!storedEntry) {
      const allMissing = await allPathsMissing(projectRoot, mappingPaths);
      entries.push({
        nodePath,
        status: allMissing ? 'unmaterialized' : 'source-drift',
        details: allMissing
          ? 'No drift state recorded, files do not exist'
          : 'No drift state recorded, files exist (run drift-sync after materialization)',
      });
      continue;
    }

    // Check if source files are entirely missing (all mapping paths gone)
    // This must happen BEFORE hash comparison — a node whose source files
    // are all gone is 'missing' regardless of whether graph-only hashes match.
    const sourceFilesMissing = await allPathsMissing(projectRoot, mappingPaths);
    if (sourceFilesMissing) {
      entries.push({
        nodePath,
        status: 'missing',
        details: 'All source mapping paths are missing',
      });
      continue;
    }

    // Collect all tracked files (source + graph) for this node
    const trackedFiles = collectTrackedFiles(node, graph);
    // Exclude files owned by descendant nodes (child-wins model)
    const excludePrefixes = getChildMappingExclusions(graph, nodePath);
    // Pass stored file data for mtime-based optimization: skip hashing files whose
    // modification time has not changed since the last drift-sync.
    const storedFileData = storedEntry.files
      ? { hashes: storedEntry.files, mtimes: storedEntry.mtimes ?? {} }
      : undefined;
    const { canonicalHash, fileHashes } = await hashTrackedFiles(projectRoot, trackedFiles, storedFileData, excludePrefixes);

    if (canonicalHash === storedEntry.hash) {
      entries.push({ nodePath, status: 'ok' });
      continue;
    }

    // Something changed — determine what
    const changedFiles: DriftFileChange[] = [];
    const storedFiles = storedEntry.files;

    // Check current files against stored
    for (const [filePath, hash] of Object.entries(fileHashes)) {
      const storedHash = storedFiles[filePath];
      if (!storedHash || storedHash !== hash) {
        changedFiles.push({
          filePath,
          category: categorizeFile(filePath, graph.rootPath, projectRoot),
        });
      }
    }

    // Check for deleted files (in stored but not in current)
    for (const storedPath of Object.keys(storedFiles)) {
      if (!(storedPath in fileHashes)) {
        changedFiles.push({
          filePath: `${storedPath} (deleted)`,
          category: categorizeFile(storedPath, graph.rootPath, projectRoot),
        });
      }
    }

    // Determine drift status from changed file categories
    const hasSourceChanges = changedFiles.some((f) => f.category === 'source');
    const hasGraphChanges = changedFiles.some((f) => f.category === 'graph');

    let status: DriftStatus;
    if (hasSourceChanges && hasGraphChanges) {
      status = 'full-drift';
    } else if (hasGraphChanges) {
      status = 'graph-drift';
    } else if (hasSourceChanges) {
      status = 'source-drift';
    } else {
      // Hash changed but no individual file identified — fallback
      status = 'source-drift';
    }

    const details =
      changedFiles.length > 0
        ? `Changed files: ${changedFiles.map((f) => f.filePath).join(', ')}`
        : 'File(s) modified since last sync';

    entries.push({ nodePath, status, details, changedFiles });
  }

  return {
    entries,
    totalChecked: entries.length,
    okCount: entries.filter((e) => e.status === 'ok').length,
    sourceDriftCount: entries.filter((e) => e.status === 'source-drift').length,
    graphDriftCount: entries.filter((e) => e.status === 'graph-drift').length,
    fullDriftCount: entries.filter((e) => e.status === 'full-drift').length,
    missingCount: entries.filter((e) => e.status === 'missing').length,
    unmaterializedCount: entries.filter((e) => e.status === 'unmaterialized').length,
  };
}

/**
 * Categorize a file path as 'source' or 'graph' based on whether it lives
 * under the .yggdrasil/ directory.
 */
function categorizeFile(filePath: string, _rootPath: string, projectRoot: string): DriftCategory {
  const yggPrefix = path.relative(projectRoot, _rootPath);
  const normalizedPrefix = yggPrefix.split(path.sep).join('/');
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  return normalizedFilePath.startsWith(normalizedPrefix) ? 'graph' : 'source';
}

async function allPathsMissing(projectRoot: string, mappingPaths: string[]): Promise<boolean> {
  for (const mp of mappingPaths) {
    const absPath = path.join(projectRoot, mp);
    try {
      await access(absPath);
      return false;
    } catch {
      // path missing
    }
  }
  return true;
}

export async function syncDriftState(
  graph: Graph,
  nodePath: string,
): Promise<{ previousHash?: string; currentHash: string }> {
  const projectRoot = path.dirname(graph.rootPath);
  const node = graph.nodes.get(nodePath);
  if (!node) throw new Error(`Node not found: ${nodePath}`);
  if (!node.meta.mapping) throw new Error(`Node has no mapping: ${nodePath}`);

  const trackedFiles = collectTrackedFiles(node, graph);
  // Exclude files owned by descendant nodes (child-wins model)
  const excludePrefixes = getChildMappingExclusions(graph, nodePath);
  // For sync, pass stored data so unchanged files can reuse cached hashes.
  const existingState = await readDriftState(graph.rootPath);
  const existingEntry = existingState[nodePath];
  const storedFileData = existingEntry?.files
    ? { hashes: existingEntry.files, mtimes: existingEntry.mtimes ?? {} }
    : undefined;
  const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(projectRoot, trackedFiles, storedFileData, excludePrefixes);

  const previousHash = existingEntry?.hash;

  existingState[nodePath] = { hash: canonicalHash, files: fileHashes, mtimes: fileMtimes };

  // Garbage collection: remove orphaned entries for nodes that no longer exist
  for (const key of Object.keys(existingState)) {
    if (!graph.nodes.has(key)) {
      delete existingState[key];
    }
  }

  await writeDriftState(graph.rootPath, existingState);

  return { previousHash, currentHash: canonicalHash };
}
