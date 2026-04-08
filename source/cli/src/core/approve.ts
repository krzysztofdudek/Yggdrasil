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
import { appendAuditEntry } from '../io/audit-log.js';
import { computeEffectiveAspects, computeEffectiveAspectsForConsumer } from './effective-aspects.js';
import { collectAncestors } from './context-builder.js';
import { readFile } from 'node:fs/promises';
import { debugWrite } from '../utils/debug-log.js';
import path from 'node:path';

export interface ApproveOptions {
  /** Conscious exception — bypasses three-axis gate only. Reviewer still verifies aspects. */
  reviewed?: string;
}

/**
 * Approve a node's current state, recording it as the new baseline.
 * Implements three-axis change detection with blackbox enforcement.
 */
export async function approveNode(
  graph: Graph,
  nodePath: string,
  options: ApproveOptions = {},
): Promise<ApproveResult> {
  const { reviewed } = options;

  // Validate reviewed reason if provided
  if (reviewed !== undefined && reviewed.trim() === '') {
    throw new Error('--reviewed requires a non-empty reason string.');
  }

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

    // Audit log — initial baseline
    await appendAuditEntry(graph.rootPath, {
      ts: new Date().toISOString(),
      node: nodePath,
      action: 'initial',
      prev: null,
      hash: canonicalHash,
      reason: null,
      files: [],
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

  // ── Existing baseline — compute three axes ───────────────
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
    const normalized = tfKey;
    const trimmedPath = tf.path.trim().replace(/\\/g, '/');
    if (trimmedPath.endsWith('/')) {
      dirPrefixes.push({ prefix: normalized + '/', layer: tf.layer });
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

  // Classify changed files into three axes
  const changedOwnArtifacts: string[] = [];
  const changedSource: string[] = [];
  const changedOther: AnnotatedChange[] = [];

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
    if (layer === 'hierarchy') return 'parent artifact';
    if (layer === 'relational') return 'dependency interface';
    return 'upstream content';
  }

  function classifyChangedFile(filePath: string): void {
    const layer = resolveLayer(filePath);
    const isGraph = filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '').startsWith(yggPrefix);

    if (layer === 'source' || (!isGraph && !layer)) {
      changedSource.push(filePath);
    } else if (layer === 'own') {
      // yg-node.yaml is NOT an artifact — only .md files count
      if (filePath.endsWith('.md')) {
        changedOwnArtifacts.push(filePath);
      }
      // yg-node.yaml changes are ignored for three-axis check
    } else if (layer) {
      // hierarchy, aspects, relational, flows = "other tracked"
      changedOther.push({
        filePath,
        annotation: annotateUpstreamChange(filePath, layer),
      });
    } else if (isGraph) {
      /* v8 ignore start -- defensive: deleted file with unknown layer under .yggdrasil/ */
      // check if it was an own artifact (.md in node dir) or upstream
      const nodePrefix = `${yggPrefix}/model/${nodePath}/`;
      if (
        filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '').startsWith(nodePrefix) &&
        filePath.endsWith('.md')
      ) {
        changedOwnArtifacts.push(filePath);
      } else {
        changedOther.push({
          filePath,
          annotation: annotateUpstreamChange(filePath, undefined),
        });
      }
      /* v8 ignore stop */
    }
  }

  const ownChanged = changedOwnArtifacts.length > 0;
  const sourceChanged = changedSource.length > 0;
  const otherChanged = changedOther.length > 0;

  // ── Blackbox enforcement ─────────────────────────────────
  if (isBlackbox && sourceChanged) {
    // GC runs on every invocation per spec ("when approve runs")
    const gcPaths = await runGC(graph);
    return {
      action: 'refused',
      previousHash: storedEntry.hash,
      currentHash: canonicalHash,
      refuseReason: reviewed
        ? 'Cannot use --reviewed for source changes on a blackbox node.'
        : 'Cannot approve source changes on a blackbox node.',
      blackboxBlocked: true,
      reviewedAttempted: !!reviewed,
      isBlackbox: true,
      axes: {
        ownArtifacts: ownChanged ? 'changed' : 'unchanged',
        source: 'changed',
        otherTracked: otherChanged ? 'changed' : 'unchanged',
      },
      changedSource,
      gcPaths,
    };
  }

  // ── Three-axis decision ──────────────────────────────────
  const axes = {
    ownArtifacts: (ownChanged ? 'changed' : 'unchanged') as 'changed' | 'unchanged',
    source: (sourceChanged ? 'changed' : 'unchanged') as 'changed' | 'unchanged',
    otherTracked: (otherChanged ? 'changed' : 'unchanged') as 'changed' | 'unchanged',
  };

  let action: ApproveResult['action'];
  let refuseReason: string | undefined;

  if (!ownChanged && !sourceChanged && !otherChanged) {
    // Row 5: no changes → no-op (still records baseline)
    action = 'no-change';
  } else if (ownChanged && sourceChanged) {
    // Row 1: both changed → accepts
    action = 'approved';
  } else if (ownChanged && !sourceChanged) {
    // Row 2: artifacts changed, source unchanged
    if (reviewed) {
      action = 'reviewed';
    } else {
      action = 'refused';
      refuseReason = 'Artifacts changed but source unchanged.';
    }
  } else if (!ownChanged && sourceChanged) {
    // Row 3: source changed, artifacts unchanged
    if (reviewed) {
      action = 'reviewed';
    } else {
      action = 'refused';
      refuseReason = 'Source changed but artifacts unchanged.';
    }
  } else {
    // Row 4: only other tracked changed (cascade)
    if (reviewed) {
      action = 'reviewed';
    } else {
      action = 'refused';
      refuseReason = 'Context changed but graph artifacts and source unchanged.';
    }
  }

  // Record baseline if accepted — preserve previous reviewedReason for audit trail
  if (action !== 'refused') {
    const stateToWrite = {
      hash: canonicalHash,
      files: fileHashes,
      mtimes: fileMtimes,
      // New reviewed reason replaces old; regular approve preserves existing reason
      reviewedReason: reviewed ?? storedEntry.reviewedReason,
    };
    await writeNodeDriftState(graph.rootPath, nodePath, stateToWrite);

    // Audit log — append-only, never read by CLI
    const changedFiles = [
      ...changedOwnArtifacts,
      ...changedSource,
      ...changedOther.map((c) => c.filePath),
    ];
    await appendAuditEntry(graph.rootPath, {
      ts: new Date().toISOString(),
      node: nodePath,
      action,
      prev: storedEntry.hash,
      hash: canonicalHash,
      reason: reviewed ?? null,
      files: changedFiles,
    });
  }

  // GC orphaned drift state — runs on every invocation per spec ("when approve runs")
  const gcPaths = await runGC(graph);

  // Collect unchanged file names for error messages
  const allArtifactNames = node.artifacts
    .map((a) => a.filename)
    .filter((f) => f.endsWith('.md'));
  const unchangedArtifactNames = ownChanged
    ? allArtifactNames.filter((name) => {
        const fullPath = `${yggPrefix}/model/${nodePath}/${name}`;
        return !changedOwnArtifacts.includes(fullPath);
      })
    : allArtifactNames;

  // Collect actual source file paths (expanded from directory mappings)
  const allSourceFiles = Object.keys(fileHashes).filter((f) => {
    const layer = resolveLayer(f);
    return layer === 'source' || (!f.trim().replace(/\\/g, '/').replace(/\/+$/, '').startsWith(yggPrefix) && !layer);
  });

  return {
    action,
    previousHash: storedEntry.hash,
    currentHash: canonicalHash,
    refuseReason,
    axes,
    changedOwnArtifacts: ownChanged ? changedOwnArtifacts : undefined,
    changedSource: sourceChanged ? changedSource : undefined,
    changedOther: otherChanged ? changedOther : undefined,
    unchangedArtifactNames: !ownChanged && sourceChanged ? unchangedArtifactNames : undefined,
    unchangedSourceFiles: ownChanged && !sourceChanged ? allSourceFiles : undefined,
    blackboxBlocked: false,
    antiLaunderingBlocked: false,
    reviewedAttempted: !!reviewed,
    isBlackbox,
    gcPaths,
  };
}

// ── Helpers ────────────────────────────────────────────────

/* v8 ignore start -- duplicated from check.ts, tested there */
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

/** Resolve aspects with content files for LLM verification */
export function resolveAspects(
  node: GraphNode,
  graph: Graph,
): Array<{ id: string; contentFile: string; contentPath: string }> {
  const ancestors = collectAncestors(node);
  const parentTypes = ancestors.map(a => a.meta.type);
  const flowAspects = graph.flows
    .filter(f => f.nodes?.includes(node.path))
    .flatMap(f => f.aspects ?? []);

  const effective = computeEffectiveAspects({
    nodeType: node.meta.type,
    architecture: graph.architecture,
    parentTypes,
    ownAspects: node.meta.aspects ?? [],
    flowAspects,
    allAspects: graph.aspects,
    allFlows: graph.flows,
  });

  // Add port-consumed aspects
  const portAspects = computeEffectiveAspectsForConsumer(node, graph);
  const allAspectIds = new Set([...effective.regular, ...portAspects]);

  const yggDirName = path.basename(graph.rootPath);
  const result: Array<{ id: string; contentFile: string; contentPath: string }> = [];
  for (const aspectId of allAspectIds) {
    const aspectDef = graph.aspects.find(a => a.id === aspectId);
    if (!aspectDef) continue;
    const contentFiles = aspectDef.artifacts.filter(a => a.filename.endsWith('.md'));
    if (contentFiles.length === 0) continue;
    const contentFile = contentFiles.map(a => a.content).join('\n\n');
    const contentPath = `${yggDirName}/aspects/${aspectId}/${contentFiles[0].filename}`;
    result.push({ id: aspectId, contentFile, contentPath });
  }
  return result;
}
