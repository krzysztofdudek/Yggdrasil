import type { Graph, GraphNode } from '../model/graph.js';
import type {
  ApproveResult,
  AnnotatedChange,
  TrackedFileLayer,
} from '../model/drift.js';
import {
  readDriftState,
  readNodeDriftState,
  writeNodeDriftState,
  garbageCollectDriftState,
} from '../io/drift-state-store.js';
import { hashTrackedFiles } from '../utils/hash.js';
import { collectTrackedFiles } from './context-files.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { computeEffectiveAspects } from './effective-aspects.js';
import { readFile } from 'node:fs/promises';
import { debugWrite } from '../utils/debug-log.js';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ApproveOptions {
}

/**
 * Approve a node's current state, recording it as the new baseline.
 * Binary model: any source or upstream change triggers approval. Blackbox enforcement blocks source changes.
 */
export async function approveNode(
  graph: Graph,
  nodePath: string,
  _options: ApproveOptions = {},
): Promise<ApproveResult> {
  // Validate node exists
  const node = graph.nodes.get(nodePath);
  if (!node) throw new Error(`Node '${nodePath}' does not exist.`);

  // Validate node has mapping
  const mappingPaths = normalizeMappingPaths(node.meta.mapping);
  if (mappingPaths.length === 0) {
    throw new Error(
      `Node '${nodePath}' has no mapping. Only nodes with mapping.paths\n  participate in drift detection and require approval.`,
    );
  }

  const projectRoot = path.dirname(graph.rootPath);
  const isBlackbox = node.meta.blackbox === true;
  const storedEntry = await readNodeDriftState(graph.rootPath, nodePath);

  // ── First approve (no baseline) ──────────────────────────
  if (!storedEntry) {
    // Anti-laundering check: blackbox first-approve blocked if files in other drift state
    if (isBlackbox) {
      const allDriftState = await readDriftState(graph.rootPath);
      const conflictingFiles: Array<{ file: string; trackedBy: string }> = [];
      const seen = new Set<string>();
      // Expand mapping paths to check against other nodes' drift state files
      for (const mp of mappingPaths) {
        const normalized = mp.trim().replace(/\\/g, '/').replace(/\/+$/, '');
        // Check each other node's tracked files
        for (const [otherPath, otherState] of Object.entries(allDriftState)) {
          if (otherPath === nodePath) continue;
          for (const filePath of Object.keys(otherState.files)) {
            if (filePath === normalized || filePath.startsWith(normalized + '/')) {
              const key = `${filePath}::${otherPath}`;
              if (!seen.has(key)) {
                seen.add(key);
                conflictingFiles.push({ file: filePath, trackedBy: otherPath });
              }
            }
          }
        }
      }
      if (conflictingFiles.length > 0) {
        // GC runs on every invocation per spec ("when approve runs")
        const gcPaths = await runGC(graph);
        return {
          action: 'refused',
          currentHash: '',
          refuseReason:
            'Anti-laundering: files in this blackbox appear in drift state of other nodes.',
          antiLaunderingBlocked: true,
          conflictingFiles,
          gcPaths,
        };
      }
    }

    // First approve — record initial baseline
    const trackedFiles = collectTrackedFiles(node, graph);
    const excludePrefixes = getChildMappingExclusions(graph, nodePath);
    const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
      projectRoot,
      trackedFiles,
      undefined,
      excludePrefixes,
    );

    await writeNodeDriftState(graph.rootPath, nodePath, {
      hash: canonicalHash,
      files: fileHashes,
      mtimes: fileMtimes,
    });

    // GC orphaned drift state
    const gcPaths = await runGC(graph);

    return {
      action: 'initial',
      previousHash: undefined,
      currentHash: canonicalHash,
      gcPaths,
    };
  }

  // ── Existing baseline — compute changes ───────────────
  const trackedFiles = collectTrackedFiles(node, graph);
  const excludePrefixes = getChildMappingExclusions(graph, nodePath);
  const storedFileData = storedEntry.files
    ? { hashes: storedEntry.files, mtimes: storedEntry.mtimes ?? {} }
    : undefined;
  const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
    projectRoot,
    trackedFiles,
    storedFileData,
    excludePrefixes,
  );

  // Build layer map (same logic as classifyDrift in check.ts)
  const fileLayerMap = new Map<string, TrackedFileLayer>();
  const dirPrefixes: Array<{ prefix: string; layer: TrackedFileLayer }> = [];
  for (const tf of trackedFiles) {
    const tfKey = tf.path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!fileLayerMap.has(tfKey)) {
      fileLayerMap.set(tfKey, tf.layer);
    }
    const trimmedPath = tf.path.trim().replace(/\\/g, '/');
    if (trimmedPath.endsWith('/')) {
      dirPrefixes.push({ prefix: tfKey + '/', layer: tf.layer });
    }
  }

  function resolveLayer(filePath: string): TrackedFileLayer | undefined {
    const normalized = filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    const direct = fileLayerMap.get(normalized);
    if (direct) return direct;
    for (const { prefix, layer } of dirPrefixes) {
      if (normalized.startsWith(prefix)) return layer;
    }
    return undefined;
  }

  const yggPrefix = path
    .relative(projectRoot, graph.rootPath)
    .split(path.sep)
    .join('/');

  // Classify changed files into two categories
  const changedSource: string[] = [];
  const changedUpstream: AnnotatedChange[] = [];

  // Check current vs stored
  for (const [filePath, hash] of Object.entries(fileHashes)) {
    const storedHash = storedEntry.files[filePath];
    if (storedHash && storedHash === hash) continue;
    classifyChangedFile(filePath);
  }

  // Check deleted files
  for (const storedPath of Object.keys(storedEntry.files)) {
    if (storedPath in fileHashes) continue;
    classifyChangedFile(storedPath);
  }

  function annotateUpstreamChange(
    filePath: string,
    layer: TrackedFileLayer | undefined,
  ): string {
    const normalized = filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (layer === 'aspects' || normalized.includes('/aspects/')) return 'aspect content';
    if (layer === 'flows' || normalized.includes('/flows/')) return 'flow description';
    if (layer === 'hierarchy') return 'parent metadata';
    if (layer === 'relational') return 'dependency metadata';
    return 'upstream content';
  }

  function classifyChangedFile(filePath: string): void {
    const layer = resolveLayer(filePath);
    const isGraph = filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '').startsWith(yggPrefix);

    if (layer === 'source' || (!isGraph && !layer)) {
      changedSource.push(filePath);
    } else if (layer) {
      // hierarchy, aspects, relational, flows = upstream
      changedUpstream.push({
        filePath,
        annotation: annotateUpstreamChange(filePath, layer),
      });
    } else if (isGraph) {
      /* v8 ignore start -- defensive */
      changedUpstream.push({
        filePath,
        annotation: annotateUpstreamChange(filePath, undefined),
      });
      /* v8 ignore stop */
    }
  }

  const sourceChanged = changedSource.length > 0;
  const upstreamChanged = changedUpstream.length > 0;

  // ── Blackbox enforcement ─────────────────────────────────
  if (isBlackbox && sourceChanged) {
    const gcPaths = await runGC(graph);
    return {
      action: 'refused',
      previousHash: storedEntry.hash,
      currentHash: canonicalHash,
      refuseReason: 'Cannot approve source changes on a blackbox node.',
      blackboxBlocked: true,
      isBlackbox: true,
      changedSource,
      gcPaths,
    };
  }

  // ── Blackbox + upstream only → auto-clear baseline ──────
  if (isBlackbox && upstreamChanged && !sourceChanged) {
    await writeNodeDriftState(graph.rootPath, nodePath, {
      hash: canonicalHash,
      files: fileHashes,
      mtimes: fileMtimes,
    });
    const gcPaths = await runGC(graph);
    return {
      action: 'approved',
      previousHash: storedEntry.hash,
      currentHash: canonicalHash,
      changedUpstream,
      isBlackbox: true,
      gcPaths,
    };
  }

  // ── Binary decision ─────────────────────────────────────
  let action: ApproveResult['action'];

  if (!sourceChanged && !upstreamChanged) {
    action = 'no-change';
  } else {
    // Non-blackbox + any changes → approved (LLM verification in CLI layer)
    action = 'approved';
  }

  // Record baseline if approved
  if (action === 'approved') {
    await writeNodeDriftState(graph.rootPath, nodePath, {
      hash: canonicalHash,
      files: fileHashes,
      mtimes: fileMtimes,
    });

  }

  // GC orphaned drift state
  const gcPaths = await runGC(graph);

  return {
    action,
    previousHash: storedEntry.hash,
    currentHash: canonicalHash,
    changedSource: sourceChanged ? changedSource : undefined,
    changedUpstream: upstreamChanged ? changedUpstream : undefined,
    isBlackbox,
    gcPaths,
  };
}

// ── Helpers ────────────────────────────────────────────────

/* v8 ignore start -- tested in check.ts */
/** Compute child mapping exclusions (child-wins model) */
function getChildMappingExclusions(graph: Graph, nodePath: string): string[] {
  const node = graph.nodes.get(nodePath);
  if (!node) return [];
  const parentMappings = normalizeMappingPaths(node.meta.mapping);
  if (parentMappings.length === 0) return [];

  const exclusions: string[] = [];
  for (const [childPath, childNode] of graph.nodes) {
    if (childPath === nodePath || !childPath.startsWith(nodePath + '/')) continue;
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
/* v8 ignore stop */

/** GC orphaned drift state — remove entries for nodes not in graph */
async function runGC(graph: Graph): Promise<string[]> {
  const validPaths = new Set(graph.nodes.keys());
  return garbageCollectDriftState(graph.rootPath, validPaths);
}

/** Load source file contents from disk */
export async function loadSourceFiles(
  filePaths: string[],
  projectRoot: string,
): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];
  for (const filePath of filePaths) {
    try {
      const content = await readFile(path.join(projectRoot, filePath), 'utf-8');
      results.push({ path: filePath, content });
    } catch (err) {
      debugWrite(`[approve] skipped unreadable file ${filePath}: ${(err as Error).message}`);
    }
  }
  return results;
}

/** Resolve aspects with inline content for LLM verification */
export function resolveAspects(
  node: GraphNode,
  graph: Graph,
): Array<{ id: string; description: string; content: string }> {
  const allAspectIds = computeEffectiveAspects(node, graph);

  const result: Array<{ id: string; description: string; content: string }> = [];
  for (const aspectId of allAspectIds) {
    const aspectDef = graph.aspects.find(a => a.id === aspectId);
    if (!aspectDef) continue;
    const contentFiles = aspectDef.artifacts.filter(a => a.filename.endsWith('.md'));
    if (contentFiles.length === 0) continue;
    const content = contentFiles.map(a => a.content).join('\n\n');
    result.push({ id: aspectId, description: aspectDef.description ?? aspectDef.name, content });
  }
  return result;
}
