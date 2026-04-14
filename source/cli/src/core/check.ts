import type { Graph } from '../model/graph.js';
import type {
  DriftCategory,
  DriftFileChange,
  NodeLifecycleState,
  TrackedFileLayer,
} from '../model/drift.js';
import type { ValidationIssue } from '../model/validation.js';
import { readDriftState, readNodeDriftState } from '../io/drift-state-store.js';
import { hashTrackedFiles } from '../utils/hash.js';
import { collectTrackedFiles } from './context-files.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { validate } from './validator.js';
import { computeEffectiveAspects } from './effective-aspects.js';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { buildIssueMessage } from '../formatters/message-builder.js';

// ── Types ──────────────────────────────────────────────────

export interface CheckIssue extends Omit<ValidationIssue, 'code'> {
  /** All issues have a code -- override optional from ValidationIssue */
  code: string;
  /** For source-drift: lifecycle state */
  lifecycleState?: NodeLifecycleState;
  /** For source-drift: changed files that are direct (source) */
  directChangedFiles?: DriftFileChange[];
  /** For upstream-drift: what caused the cascade */
  cascadeCauses?: CascadeCause[];
  /** For unmapped-files: uncovered file paths */
  uncoveredFiles?: string[];
  /** For unmapped-files: total count of uncovered files */
  uncoveredCount?: number;
}

export interface CascadeCause {
  /** Changed file path */
  file: string;
  /** Which layer the changed file belongs to */
  layer: TrackedFileLayer;
  /** Human-readable description, e.g. "aspect 'audit-logging' rules changed" */
  description: string;
}

export interface CheckResult {
  projectName: string;
  nodeCount: number;
  nodeTypeCounts: Map<string, number>;
  aspectCount: number;
  flowCount: number;
  coveredFiles: number;
  totalFiles: number;
  issues: CheckIssue[];
  /** Suggested next command based on highest-priority error */
  suggestedNext: string | null;
}

// ── Drift classification ───────────────────────────────────

/**
 * Classify drift for all mapped nodes as source-drift (direct) and/or upstream-drift (cascade).
 * A single node can produce BOTH a source-drift and an upstream-drift if it has direct and cascade changes.
 */
export async function classifyDrift(graph: Graph): Promise<CheckIssue[]> {
  const projectRoot = path.dirname(graph.rootPath);
  const issues: CheckIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    if (mappingPaths.length === 0) continue;

    // Nodes without effective aspects auto-approve — skip drift detection
    const effectiveAspects = computeEffectiveAspects(node, graph);
    if (effectiveAspects.size === 0) continue;

    const storedEntry = await readNodeDriftState(graph.rootPath, nodePath);

    // No baseline -> unapproved (node exists but was never approved)
    if (!storedEntry) {
      const allMissing = await allPathsMissing(projectRoot, mappingPaths);
      issues.push({
        severity: 'error',
        code: allMissing ? 'source-drift' : 'unapproved',
        rule: allMissing ? 'source-drift' : 'unapproved',
        message: allMissing
          ? buildIssueMessage({
              what: `Mapping declared but source files never created:\n${mappingPaths.map(p => '  ' + p).join('\n')}`,
              why: 'Node specifies files that do not exist yet.',
              next: `Implement from the graph specification, then: yg approve --node ${nodePath}`,
            })
          : buildIssueMessage({
              what: `Node has never been approved (no baseline):\n${mappingPaths.map(p => '  ' + p).join('\n')}`,
              why: 'Drift tracking is not active until the first approve.',
              next: `Verify source, then: yg approve --node ${nodePath}`,
            }),
        nodePath,
        lifecycleState: 'unapproved',
        directChangedFiles: [],
      });
      continue;
    }

    // Check if all source paths are gone
    const sourceGone = await allPathsMissing(projectRoot, mappingPaths);
    if (sourceGone) {
      issues.push({
        severity: 'error',
        code: 'source-drift',
        rule: 'source-drift',
        message: buildIssueMessage({
          what: `Mapped source files not found on disk:\n${mappingPaths.map(p => '  ' + p).join('\n')}`,
          why: 'Mapped files were deleted or moved.',
          next: `Re-create the file, or remove the mapping from yg-node.yaml.`,
        }),
        nodePath,
        lifecycleState: 'missing',
        directChangedFiles: mappingPaths.map(p => ({ filePath: p, category: 'source' as DriftCategory })),
      });
      continue;
    }

    // Collect tracked files WITH layer info
    const trackedFiles = collectTrackedFiles(node, graph);

    // Compute child mapping exclusions (child-wins model)
    const excludePrefixes = getChildMappingExclusions(graph, nodePath);

    // Hash and compare
    const storedFileData = storedEntry.files
      ? { hashes: storedEntry.files, mtimes: storedEntry.mtimes ?? {} }
      : /* v8 ignore next */ undefined;
    const { canonicalHash, fileHashes } = await hashTrackedFiles(
      projectRoot, trackedFiles, storedFileData, excludePrefixes,
    );

    if (canonicalHash === storedEntry.hash) continue; // No drift

    // Build a map: filePath -> layer
    // trackedFiles may contain directory paths (e.g. 'src/svc/') that hashTrackedFiles
    // expands into individual files (e.g. 'src/svc/index.ts'). We need to handle both
    // exact matches and directory-prefix matches.
    const fileLayerMap = new Map<string, TrackedFileLayer>();
    const dirPrefixes: Array<{ prefix: string; layer: TrackedFileLayer }> = [];
    for (const tf of trackedFiles) {
      const tfNormalized = tf.path.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!fileLayerMap.has(tfNormalized)) {
        fileLayerMap.set(tfNormalized, tf.layer);
      }
      // Track directory prefixes for files expanded from directory mappings.
      const normalized = tfNormalized;
      dirPrefixes.push({ prefix: normalized + '/', layer: tf.layer });
    }

    function resolveLayer(filePath: string): TrackedFileLayer | undefined {
      const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
      const direct = fileLayerMap.get(normalized);
      if (direct) return direct;
      for (const { prefix, layer } of dirPrefixes) {
        if (normalized.startsWith(prefix)) return layer;
      }
      return undefined;
    }

    // Find changed files
    const directChanges: DriftFileChange[] = [];
    const cascadeCauses: CascadeCause[] = [];

    // Current files vs stored
    for (const [rawFilePath, hash] of Object.entries(fileHashes)) {
      const filePath = rawFilePath.replace(/\\/g, '/').replace(/\/+$/, '');
      const storedHash = storedEntry.files[rawFilePath] ?? storedEntry.files[filePath];
      if (storedHash && storedHash === hash) continue;

      const layer = resolveLayer(filePath);
      const category = categorizeFile(filePath, graph.rootPath, projectRoot);

      if (layer === 'source') {
        directChanges.push({ filePath, category });
      } else if (layer) {
        cascadeCauses.push({
          file: filePath,
          layer,
          description: describeCascadeCause(filePath, layer, graph),
        });
      }
    }

    // Deleted files (in stored but not in current)
    const normalizedFileHashes = new Set(Object.keys(fileHashes).map(p => p.replace(/\\/g, '/').replace(/\/+$/, '')));
    for (const storedPath of Object.keys(storedEntry.files)) {
      const normalizedStored = storedPath.replace(/\\/g, '/').replace(/\/+$/, '');
      if (normalizedStored in fileHashes || normalizedFileHashes.has(normalizedStored)) continue;
      const layer = resolveLayer(storedPath);
      const category = categorizeFile(storedPath, graph.rootPath, projectRoot);

      if (layer === 'source') {
        directChanges.push({ filePath: `${storedPath} (deleted)`, category });
      } else if (layer) {
        cascadeCauses.push({
          file: storedPath,
          layer,
          description: describeCascadeCause(storedPath, layer, graph),
        });
      } else {
        // File was in baseline but not in current tracked files -- layer unknown
        // Classify by path: .yggdrasil/ = graph, else source
        if (category === 'source') {
          directChanges.push({ filePath: `${storedPath} (deleted)`, category });
        } else {
          // Could be upstream file that was removed -- treat as cascade
          cascadeCauses.push({
            file: storedPath,
            layer: 'relational',
            description: `Tracked file removed: ${storedPath}`,
          });
        }
      }
    }

    // Emit source-drift for direct changes (source files changed)
    if (directChanges.length > 0) {
      const sourceFiles = directChanges.filter(f => f.category === 'source').map(f => f.filePath);

      const message = buildIssueMessage({
        what: `Source files changed since last approve.\nChanged:\n${sourceFiles.map(f => '  ' + f).join('\n')}`,
        why: 'Node needs re-approval after source changes.',
        next: `yg approve --node ${nodePath}`,
      });

      issues.push({
        severity: 'error',
        code: 'source-drift',
        rule: 'source-drift',
        message,
        nodePath,
        lifecycleState: 'ok',
        directChangedFiles: directChanges,
      });
    }

    // Collapse all cascade causes for this node into a single upstream-drift
    const nodeUpstreamCauses: CascadeCause[] = [];

    // Group cascade causes by logical cause (aspect ID, dep path, flow name, parent path)
    const causeGroups = new Map<string, CascadeCause[]>();
    for (const cause of cascadeCauses) {
      const key = extractCauseKey(cause);
      const group = causeGroups.get(key) ?? [];
      group.push(cause);
      causeGroups.set(key, group);
    }

    // Push all causes (causeGroups used for count accuracy via .size)
    nodeUpstreamCauses.push(...cascadeCauses);

    if (nodeUpstreamCauses.length > 0) {
      // Build a single collapsed upstream-drift for this node with all causes
      // Use causeGroups.size for the count -- reflects distinct logical upstream sources, not raw file count
      const causeCount = causeGroups.size;
      const causeLines = nodeUpstreamCauses.map((c: CascadeCause) => '  Cause: ' + c.description).join('\n');
      const message = buildIssueMessage({
        what: `Context package changed due to ${causeCount} upstream modification${causeCount === 1 ? '' : 's'}:\n${causeLines}`,
        why: 'Source may no longer satisfy updated aspect requirements.',
        next: `Load context: yg context --node ${nodePath}\nVerify source compliance, update if needed, then: yg approve --node ${nodePath}`,
      });

      issues.push({
        severity: 'error',
        code: 'upstream-drift',
        rule: 'cascade-drift',
        message,
        nodePath,
        cascadeCauses: nodeUpstreamCauses,
      });
    }
  }

  return issues;
}

// ── Coverage scan (unmapped-files) ────────────────────────

/**
 * Find git-tracked files not covered by any node mapping.
 * Accepts gitTrackedFiles as parameter for testability (CLI layer calls `git ls-files`).
 * Excludes files under .yggdrasil/.
 */
export function scanUncoveredFiles(graph: Graph, gitTrackedFiles: string[]): string[] {
  // Build list of all mapping paths (normalized)
  const allMappings: string[] = [];
  for (const node of graph.nodes.values()) {
    const paths = normalizeMappingPaths(node.meta.mapping);
    allMappings.push(...paths);
  }

  // Determine .yggdrasil prefix relative to project root
  const projectRoot = path.dirname(graph.rootPath);
  const yggPrefix = path.relative(projectRoot, graph.rootPath).replace(/\\/g, '/').replace(/\/+$/, '');

  const uncovered: string[] = [];

  for (const file of gitTrackedFiles) {
    const normalized = file.trim().replace(/\\/g, '/').replace(/\/+$/, '');

    // Exclude .yggdrasil/ files
    if (normalized.startsWith(yggPrefix + '/') || normalized === yggPrefix) continue;

    // Check if covered by any mapping
    let covered = false;
    for (const rawMp of allMappings) {
      // Normalize: strip trailing slash to avoid double-slash in startsWith check
      const mp = rawMp.replace(/\\/g, '/').replace(/\/+$/, '');
      if (normalized === mp || normalized.startsWith(mp + '/')) {
        covered = true;
        break;
      }
    }

    if (!covered) {
      uncovered.push(normalized);
    }
  }

  return uncovered.sort();
}

/**
 * Build the unmapped-files CheckIssue from uncovered files.
 * Aggregates into one error with count + sample.
 */
export function buildCoverageIssue(uncoveredFiles: string[], totalGitFiles: number): CheckIssue | null {
  if (uncoveredFiles.length === 0) return null;

  const sampleSize = 5;
  const sample = uncoveredFiles.slice(0, sampleSize);
  const remaining = uncoveredFiles.length - sample.length;

  let message: string;
  // Learning tip for cold start
  const coveragePct = totalGitFiles > 0
    ? ((totalGitFiles - uncoveredFiles.length) / totalGitFiles) * 100
    : 100;

  if (uncoveredFiles.length <= sampleSize) {
    // Small count: files listed directly, guidance after
    message = buildIssueMessage({
      what: `${uncoveredFiles.length.toLocaleString()} source file${uncoveredFiles.length === 1 ? '' : 's'} not covered by any node.\n${sample.map(f => '  ' + f).join('\n')}`,
      why: 'Files without graph coverage cannot be modified under the protocol.',
      next: `Check ownership candidates: yg context --file <path>\nThen: add to existing node mapping, or create a new node.`,
    });
  } else {
    // Large count: guidance BEFORE examples (per CLI messages spec)
    const guidance = coveragePct < 50
      ? 'Establish coverage: create nodes for active areas first, expand coverage incrementally.'
      : 'Add to an existing node mapping, or create a new node.';
    message = buildIssueMessage({
      what: `${uncoveredFiles.length.toLocaleString()} source files have no graph coverage.\nExamples:\n${sample.map(f => '  ' + f).join('\n')}\n... and ${remaining.toLocaleString()} more`,
      why: 'Files without graph coverage cannot be modified under the protocol.',
      next: `${guidance}\nCheck ownership candidates: yg context --file <path>`,
    });
  }

  return {
    severity: 'error',
    code: 'unmapped-files',
    rule: 'unmapped-file',
    message,
    uncoveredFiles,
    uncoveredCount: uncoveredFiles.length,
  };
}

// ── Orphaned drift state ──────────────────────────────────

/**
 * Find drift state entries for nodes that no longer exist in the graph.
 * Returns sorted list of orphaned node paths.
 */
export async function detectOrphanedDriftState(graph: Graph): Promise<string[]> {
  const driftState = await readDriftState(graph.rootPath);
  const validNodePaths = new Set(graph.nodes.keys());
  return Object.keys(driftState)
    .filter(p => !validNodePaths.has(p))
    .sort();
}

// ── Check orchestrator ────────────────────────────────────

/**
 * Run the full check: validation + drift + coverage + orphaned state.
 * @param gitTrackedFiles -- pass null to skip unmapped-files check (no git available).
 */
export async function runCheck(graph: Graph, gitTrackedFiles: string[] | null): Promise<CheckResult> {
  // 1. Validation (structural + completeness)
  const validation = await validate(graph);
  // Filter out issues without a code -- they are internal (e.g., invalid-scope).
  // All issues have a code. Convert to CheckIssue.
  const validationIssues: CheckIssue[] = validation.issues
    .filter(vi => vi.code)
    .map(vi => ({ ...vi, code: vi.code! }));

  // 2. Drift classification (source-drift/upstream-drift)
  const driftIssues = await classifyDrift(graph);

  // 3. Coverage scan (unmapped-files)
  let coverageIssue: CheckIssue | null = null;
  let coveredFiles = 0;
  let totalFiles = 0;
  if (gitTrackedFiles !== null) {
    // Exclude .yggdrasil/ files from total count
    const projectRoot = path.dirname(graph.rootPath);
    const yggPrefix = path.relative(projectRoot, graph.rootPath).replace(/\\/g, '/').replace(/\/+$/, '');
    const sourceFiles = gitTrackedFiles.filter(f => {
      const normalized = f.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      return !normalized.startsWith(yggPrefix + '/') && normalized !== yggPrefix;
    });
    totalFiles = sourceFiles.length;
    const uncovered = scanUncoveredFiles(graph, gitTrackedFiles);
    coveredFiles = totalFiles - uncovered.length;
    coverageIssue = buildCoverageIssue(uncovered, totalFiles);
  }

  // 4. Orphaned drift state
  const orphanedPaths = await detectOrphanedDriftState(graph);
  const yggRelative = path.relative(path.dirname(graph.rootPath), graph.rootPath).replace(/\\/g, '/').replace(/\/+$/, '');
  const orphanWarnings: CheckIssue[] = orphanedPaths.map(p => ({
    severity: 'warning' as const,
    code: 'orphaned-drift-state',
    rule: 'orphaned-drift-state',
    message: buildIssueMessage({
      what: `Drift state file exists for '${p}' but node is no longer in the graph.`,
      why: `Orphaned file: ${yggRelative}/.drift-state/${p}.json`,
      next: `Remove the orphaned file or restore the node.`,
    }),
    nodePath: p,
  }));

  // Combine all issues
  const allIssues: CheckIssue[] = [
    ...driftIssues,
    ...validationIssues,
    ...(coverageIssue ? [coverageIssue] : []),
    ...orphanWarnings,
  ];

  // Node type counts
  const nodeTypeCounts = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    const t = node.meta.type;
    nodeTypeCounts.set(t, (nodeTypeCounts.get(t) ?? 0) + 1);
  }

  const suggestedNext = computeSuggestedNext(allIssues, graph);

  return {
    projectName: path.basename(path.dirname(graph.rootPath)),
    nodeCount: graph.nodes.size,
    nodeTypeCounts,
    aspectCount: graph.aspects.length,
    flowCount: graph.flows.length,
    coveredFiles,
    totalFiles,
    issues: allIssues,
    suggestedNext,
  };
}

// ── Internal helpers ───────────────────────────────────────

function categorizeFile(filePath: string, rootPath: string, projectRoot: string): DriftCategory {
  const yggPrefix = path.relative(projectRoot, rootPath).replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.startsWith(yggPrefix) ? 'graph' : 'source';
}

/**
 * Describe why a cascade fired AND provide the cause-specific review instruction.
 * Each cause type has a distinct message per the CLI messages spec.
 */
function describeCascadeCause(filePath: string, layer: TrackedFileLayer, graph: Graph): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const yggPrefix = path.relative(path.dirname(graph.rootPath), graph.rootPath).replace(/\\/g, '/').replace(/\/+$/, '');
  const escPrefix = yggPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (layer === 'aspects') {
    const match = normalized.match(new RegExp(`${escPrefix}/aspects/([^/]+(?:/[^/]+)*)/`));
    const aspectId = match ? match[1] : 'unknown';
    const filename = normalized.split('/').pop() ?? '';
    const label = filename === 'yg-aspect.yaml' ? '' : filename.replace('.md', '') + ' ';
    return `aspect '${aspectId}' ${label}changed\n       (${normalized})`;
  }

  if (layer === 'hierarchy') {
    const match = normalized.match(new RegExp(`${escPrefix}/model/(.+)/[^/]+$`));
    const ancestorPath = match ? match[1] : 'unknown';
    return `parent node '${ancestorPath}' metadata changed\n       (${normalized})`;
  }

  if (layer === 'relational') {
    const match = normalized.match(new RegExp(`${escPrefix}/model/(.+)/([^/]+)$`));
    const depPath = match ? match[1] : 'unknown';
    const filename = match ? match[2] : '';
    const artifactLabel = filename === 'yg-node.yaml' ? 'metadata'
      : filename.replace('.md', '');
    return `dependency '${depPath}' ${artifactLabel} changed\n       (${normalized})`;
  }

  if (layer === 'flows') {
    const match = normalized.match(new RegExp(`${escPrefix}/flows/([^/]+)/`));
    const flowName = match ? match[1] : 'unknown';
    return `flow '${flowName}' description changed\n       (${normalized})`;
  }

  return `tracked file changed\n       (${normalized})`;
}

/**
 * Extract a grouping key from a cascade cause so multiple changed files
 * from the same logical cause (e.g., same aspect) produce one upstream-drift issue.
 */
function extractCauseKey(cause: CascadeCause): string {
  // Group by layer + the entity identifier (aspect id, dep path, flow name, parent path)
  // Use the first path segment after the entity type directory
  return `${cause.layer}:${cause.description.split("'")[1] ?? cause.file}`;
}

/**
 * Compute mapping paths owned by descendant nodes (child-wins model).
 */
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

async function allPathsMissing(projectRoot: string, mappingPaths: string[]): Promise<boolean> {
  for (const mp of mappingPaths) {
    try {
      await access(path.join(projectRoot, mp));
      return false;
    } catch { /* missing */ }
  }
  return true;
}


/**
 * Group upstream-drift cascade issues by their upstream cause entity.
 * Returns Map<"aspect:id"|"flow:name"|"parent:path", Set<nodePath>>.
 */
function groupCascadeByCause(cascadeErrors: CheckIssue[], graph?: Graph): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  const yggPrefix = graph
    ? path.relative(path.dirname(graph.rootPath), graph.rootPath).replace(/\\/g, '/').replace(/\/+$/, '')
    : '.yggdrasil';
  const escPrefix = yggPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const issue of cascadeErrors) {
    if (!issue.nodePath || !issue.cascadeCauses) continue;
    for (const cause of issue.cascadeCauses) {
      const normalized = cause.file.replace(/\\/g, '/').replace(/\/+$/, '');
      let key: string | null = null;

      const aspectMatch = normalized.match(new RegExp(`^${escPrefix}/aspects/([^/]+(?:/[^/]+)*)/`));
      if (aspectMatch) {
        key = `aspect:${aspectMatch[1]}`;
      }

      if (!key) {
        const flowMatch = normalized.match(new RegExp(`^${escPrefix}/flows/([^/]+)/`));
        if (flowMatch) {
          key = `flow:${flowMatch[1]}`;
        }
      }

      if (!key) {
        const modelMatch = normalized.match(new RegExp(`^${escPrefix}/model/(.+)/[^/]+$`));
        if (modelMatch) {
          key = `parent:${modelMatch[1]}`;
        }
      }

      if (key) {
        const nodes = groups.get(key) ?? new Set<string>();
        nodes.add(issue.nodePath);
        groups.set(key, nodes);
      }
    }
  }

  return groups;
}

/**
 * Suggest the next command to run based on highest-priority error.
 * Priority: drift > cascade > structural > coverage > completeness.
 */
function computeSuggestedNext(issues: CheckIssue[], graph?: Graph): string | null {
  const errors = issues.filter(i => i.severity === 'error');
  /* v8 ignore next -- tested by clean-check test, but v8 sometimes marks it uncovered */
  if (errors.length === 0) return null;

  const STRUCTURAL_CODES = new Set(['yaml-invalid', 'type-invalid', 'relation-broken', 'flow-node-broken', 'aspect-undefined', 'overlapping-mapping', 'structural-cycle', 'config-invalid', 'duplicate-aspect-id', 'node-yaml-missing', 'implied-aspect-missing', 'aspect-implies-cycle', 'event-unpaired', 'schema-missing']);
  const COMPLETENESS_CODES = new Set(['description-missing']);

  const driftErrors = errors.filter(i => i.code === 'source-drift' || i.code === 'unapproved');
  const cascadeErrors = errors.filter(i => i.code === 'upstream-drift');
  const structuralErrors = errors.filter(i => STRUCTURAL_CODES.has(i.code));
  const coverageErrors = errors.filter(i => i.code === 'unmapped-files');
  const completenessErrors = errors.filter(i => COMPLETENESS_CODES.has(i.code));

  const remaining: string[] = [];
  const addRemaining = (count: number, label: string) => { if (count > 0) remaining.push(`${count} ${label}`); };

  if (driftErrors.length > 0) {
    const node = driftErrors[0].nodePath!;
    addRemaining(cascadeErrors.length, 'cascade reviews');
    addRemaining(coverageErrors.length > 0 ? (coverageErrors[0].uncoveredCount ?? 0) : 0, 'files need coverage');
    const then = remaining.length > 0 ? `\n  Then: ${remaining.join(', ')}` : '';
    return `yg context --node ${node}\n  1 of ${driftErrors.length} drifted node${driftErrors.length === 1 ? '' : 's'} — post-modify workflow${then}`;
  }

  if (cascadeErrors.length > 0) {
    const entityGroups = groupCascadeByCause(cascadeErrors, graph);

    // Find the largest group with >=2 nodes
    let bestEntity: { type: string; id: string; count: number } | null = null;
    for (const [key, nodes] of entityGroups) {
      if (nodes.size >= 2 && (!bestEntity || nodes.size > bestEntity.count)) {
        const [type, id] = key.split(':', 2);
        bestEntity = { type, id, count: nodes.size };
      }
    }

    if (bestEntity) {
      const flagMap: Record<string, string> = {
        aspect: '--aspect',
        flow: '--flow',
        parent: '--node',
      };
      const flag = flagMap[bestEntity.type] ?? '--aspect';
      addRemaining(coverageErrors.length > 0 ? (coverageErrors[0].uncoveredCount ?? 0) : 0, 'files need coverage');
      const then = remaining.length > 0 ? `\n  Then: ${remaining.join(', ')}` : '';
      return `yg approve ${flag} ${bestEntity.id}\n  ${bestEntity.count} cascade node${bestEntity.count === 1 ? '' : 's'} from ${bestEntity.type} change${then}`;
    }

    // Single cascade node — fall through to original behavior
    const node = cascadeErrors[0].nodePath!;
    addRemaining(coverageErrors.length > 0 ? (coverageErrors[0].uncoveredCount ?? 0) : 0, 'files need coverage');
    const then = remaining.length > 0 ? `\n  Then: ${remaining.join(', ')}` : '';
    return `yg context --node ${node}\n  1 of ${cascadeErrors.length} cascade node${cascadeErrors.length === 1 ? '' : 's'} — cascade review${then}`;
  }

  if (structuralErrors.length > 0) {
    const first = structuralErrors[0];
    addRemaining(coverageErrors.length > 0 ? (coverageErrors[0].uncoveredCount ?? 0) : 0, 'files need coverage');
    const then = remaining.length > 0 ? `\n  Then: ${remaining.join(', ')}` : '';
    return `Fix ${first.code} in ${first.nodePath ?? '.yggdrasil/'}\n  1 of ${structuralErrors.length} structural error${structuralErrors.length === 1 ? '' : 's'}${then}`;
  }

  if (coverageErrors.length > 0) {
    const count = coverageErrors[0].uncoveredCount ?? 0;
    return `yg context --file <uncovered-path>\n  ${count} file${count === 1 ? '' : 's'} need coverage — bootstrap workflow`;
  }

  if (completenessErrors.length > 0) {
    const first = completenessErrors[0];
    return `Fix ${first.code} for ${first.nodePath}\n  1 of ${completenessErrors.length} completeness error${completenessErrors.length === 1 ? '' : 's'} — post-modify workflow`;
  }

  return null;
}
