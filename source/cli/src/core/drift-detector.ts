import type { Graph } from '../model/graph.js';
import type {
  DriftReport,
  DriftEntry,
  DriftStatus,
  DriftFileChange,
  DriftCategory,
} from '../model/drift.js';
import {
  readDriftState,
  readNodeDriftState,
  writeNodeDriftState,
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
  const normalizedFilter = filterNodePath?.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const driftState = await readDriftState(graph.rootPath);
  const entries: DriftEntry[] = [];

  for (const [nodePath, node] of graph.nodes) {
    if (normalizedFilter && nodePath !== normalizedFilter && !nodePath.startsWith(normalizedFilter + '/')) continue;
    if (node.meta.blackbox) continue;
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
    for (const [rawFilePath, hash] of Object.entries(fileHashes)) {
      const filePath = rawFilePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      const storedHash = storedFiles[rawFilePath] ?? storedFiles[filePath];
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
  const yggPrefix = path.relative(projectRoot, _rootPath).trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedFilePath = filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedFilePath.startsWith(yggPrefix) ? 'graph' : 'source';
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

export interface SyncResult {
  previousHash?: string;
  currentHash: string;
  /** True when source files changed but no graph artifacts changed since last sync */
  sourceOnlyChange: boolean;
}

export async function syncDriftState(
  graph: Graph,
  nodePath: string,
): Promise<SyncResult> {
  const projectRoot = path.dirname(graph.rootPath);
  const normalizedNodePath = nodePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const node = graph.nodes.get(normalizedNodePath);
  if (!node) throw new Error(`Node not found: ${normalizedNodePath}`);
  if (!node.meta.mapping) throw new Error(`Node has no mapping: ${normalizedNodePath}`);
  if (node.meta.blackbox) throw new Error(`Cannot sync blackbox node: ${normalizedNodePath}`);

  const trackedFiles = collectTrackedFiles(node, graph);
  const excludePrefixes = getChildMappingExclusions(graph, normalizedNodePath);
  // For sync, pass stored data so unchanged files can reuse cached hashes.
  const existingEntry = await readNodeDriftState(graph.rootPath, normalizedNodePath);
  const storedFileData = existingEntry?.files
    ? { hashes: existingEntry.files, mtimes: existingEntry.mtimes ?? {} }
    : undefined;
  const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(projectRoot, trackedFiles, storedFileData, excludePrefixes);

  const previousHash = existingEntry?.hash;

  // Detect source-only change pattern: source files changed, graph artifacts didn't
  let sourceOnlyChange = false;
  if (previousHash && previousHash !== canonicalHash && existingEntry?.files) {
    let hasSourceChange = false;
    let hasGraphChange = false;
    const yggPrefix = path.relative(projectRoot, graph.rootPath).trim().replace(/\\/g, '/').replace(/\/+$/, '');
    for (const [filePath, hash] of Object.entries(fileHashes)) {
      const storedHash = existingEntry.files[filePath];
      if (storedHash && storedHash === hash) continue;
      if (!storedHash || storedHash !== hash) {
        if (filePath.startsWith(yggPrefix)) {
          hasGraphChange = true;
        } else {
          hasSourceChange = true;
        }
      }
    }
    // Check deleted files
    for (const storedPath of Object.keys(existingEntry.files)) {
      if (!(storedPath in fileHashes)) {
        if (storedPath.startsWith(yggPrefix)) {
          hasGraphChange = true;
        } else {
          hasSourceChange = true;
        }
      }
    }
    sourceOnlyChange = hasSourceChange && !hasGraphChange;
  }

  await writeNodeDriftState(graph.rootPath, normalizedNodePath, {
    hash: canonicalHash,
    files: fileHashes,
    mtimes: fileMtimes,
  });

  return { previousHash, currentHash: canonicalHash, sourceOnlyChange };
}
