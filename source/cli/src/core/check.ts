import type {
  Graph,
  DriftCategory,
  DriftFileChange,
  DriftStatus,
  TrackedFileLayer,
  ValidationIssue,
} from '../model/types.js';
import { readDriftState, readNodeDriftState, writeNodeDriftState } from '../io/drift-state-store.js';
import { hashTrackedFiles } from '../utils/hash.js';
import { collectTrackedFiles } from './context-files.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { validate } from './validator.js';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { buildIssueMessage } from '../formatters/message-builder.js';

// ── Types ──────────────────────────────────────────────────

export interface CheckIssue extends Omit<ValidationIssue, 'code'> {
  /** All issues have a code -- override optional from ValidationIssue */
  code: string;
  /** For E020: drift subtype */
  driftSubtype?: DriftStatus;
  /** For E020: changed files that are direct (own/source) */
  directChangedFiles?: DriftFileChange[];
  /** For E021: what caused the cascade */
  cascadeCauses?: CascadeCause[];
  /** For E022: uncovered file paths */
  uncoveredFiles?: string[];
  /** For E022: total count of uncovered files */
  uncoveredCount?: number;
  /** For E021: cached verification label from drift-state (e.g. 'last verified: pass', 'never verified') */
  verificationLabel?: string;
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
  /** Whether an LLM provider is configured (false = aspect verification disabled) */
  llmAvailable: boolean;
}

// ── Drift classification ───────────────────────────────────

/**
 * Classify drift for all mapped nodes as E020 (direct) and/or E021 (cascade).
 * A single node can produce BOTH an E020 and an E021 if it has direct and cascade changes.
 */
export async function classifyDrift(graph: Graph): Promise<CheckIssue[]> {
  const projectRoot = path.dirname(graph.rootPath);
  const issues: CheckIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    if (mappingPaths.length === 0) continue;

    const storedEntry = await readNodeDriftState(graph.rootPath, nodePath);

    // No baseline -> unmaterialized (spec: "mapping exists but files never created / no baseline")
    if (!storedEntry) {
      const allMissing = await allPathsMissing(projectRoot, mappingPaths);
      issues.push({
        severity: 'error',
        code: 'E020',
        rule: 'direct-drift',
        message: allMissing
          ? buildIssueMessage({
              what: `Mapping declared but source files never created:\n${mappingPaths.map(p => '  ' + p).join('\n')}`,
              why: 'Node specifies files that do not exist yet.',
              next: `Implement from the graph specification, then: yg approve --node ${nodePath}`,
            })
          : buildIssueMessage({
              what: `Mapping declared but no baseline recorded:\n${mappingPaths.map(p => '  ' + p).join('\n')}`,
              why: 'Node has never been approved — drift tracking is not active.',
              next: `Verify artifacts match source, then: yg approve --node ${nodePath}`,
            }),
        nodePath,
        driftSubtype: 'unmaterialized',
        directChangedFiles: [],
      });
      continue;
    }

    // Check if all source paths are gone
    const sourceGone = await allPathsMissing(projectRoot, mappingPaths);
    if (sourceGone) {
      issues.push({
        severity: 'error',
        code: 'E020',
        rule: 'direct-drift',
        message: buildIssueMessage({
          what: `Mapped source files not found on disk:\n${mappingPaths.map(p => '  ' + p).join('\n')}`,
          why: 'Mapped files were deleted or moved.',
          next: `Re-create the file, or remove the mapping from yg-node.yaml.`,
        }),
        nodePath,
        driftSubtype: 'missing',
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
      if (!fileLayerMap.has(tf.path)) {
        fileLayerMap.set(tf.path, tf.layer);
      }
      // Track directory prefixes for files expanded from directory mappings
      const normalized = tf.path.replace(/\\/g, '/');
      if (normalized.endsWith('/')) {
        dirPrefixes.push({ prefix: normalized, layer: tf.layer });
      }
    }

    function resolveLayer(filePath: string): TrackedFileLayer | undefined {
      const direct = fileLayerMap.get(filePath);
      if (direct) return direct;
      // Check if the file falls under a tracked directory
      const normalized = filePath.replace(/\\/g, '/');
      for (const { prefix, layer } of dirPrefixes) {
        if (normalized.startsWith(prefix)) return layer;
      }
      return undefined;
    }

    // Find changed files
    const directChanges: DriftFileChange[] = [];
    const cascadeCauses: CascadeCause[] = [];

    // Current files vs stored
    for (const [filePath, hash] of Object.entries(fileHashes)) {
      const storedHash = storedEntry.files[filePath];
      if (storedHash && storedHash === hash) continue;

      const layer = resolveLayer(filePath);
      const category = categorizeFile(filePath, graph.rootPath, projectRoot);

      if (layer === 'own' || layer === 'source') {
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
    for (const storedPath of Object.keys(storedEntry.files)) {
      if (storedPath in fileHashes) continue;
      const layer = resolveLayer(storedPath);
      const category = categorizeFile(storedPath, graph.rootPath, projectRoot);

      if (layer === 'own' || layer === 'source') {
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

    // Emit E020 for direct changes
    if (directChanges.length > 0) {
      const hasSource = directChanges.some(f => f.category === 'source');
      const hasGraph = directChanges.some(f => f.category === 'graph');
      let driftSubtype: DriftStatus;
      if (hasSource && hasGraph) driftSubtype = 'full-drift';
      else if (hasGraph) driftSubtype = 'graph-drift';
      else driftSubtype = 'source-drift';

      const sourceFiles = directChanges.filter(f => f.category === 'source').map(f => f.filePath);
      const graphFiles = directChanges.filter(f => f.category === 'graph').map(f => f.filePath);

      let message: string;
      if (driftSubtype === 'source-drift') {
        message = buildIssueMessage({
          what: `Source files changed since last approve. Graph artifacts unchanged.\nChanged:\n${sourceFiles.map(f => '  ' + f).join('\n')}`,
          why: 'Graph artifacts may no longer describe the actual behavior.',
          next: `Update artifacts to reflect source changes, then: yg approve --node ${nodePath}\nIf change is cosmetic (formatting, comments): yg approve --node ${nodePath} --reviewed "cosmetic"`,
        });
      } else if (driftSubtype === 'graph-drift') {
        message = buildIssueMessage({
          what: `Graph artifacts changed since last approve. Source files unchanged.\nChanged:\n${graphFiles.map(f => '  ' + f).join('\n')}`,
          why: 'Source may not yet implement the updated graph specification.',
          next: `Implement the graph changes in source, then: yg approve --node ${nodePath}\nIf change is cosmetic (typo, clarification): yg approve --node ${nodePath} --reviewed "cosmetic"`,
        });
      } else {
        message = buildIssueMessage({
          what: `Both source files and graph artifacts changed since last approve.\nSource:\n${sourceFiles.map(f => '  ' + f).join('\n')}\nGraph:\n${graphFiles.map(f => '  ' + f).join('\n')}`,
          why: 'Source and graph artifacts must be consistent before approval.',
          next: `Ensure source and artifacts are consistent, then: yg approve --node ${nodePath}`,
        });
      }

      issues.push({
        severity: 'error',
        code: 'E020',
        rule: 'direct-drift',
        message,
        nodePath,
        driftSubtype,
        directChangedFiles: directChanges,
      });
    }

    // Collapse all cascade causes for this node into a single E021
    const nodeE021Causes: CascadeCause[] = [];

    // Group cascade causes by logical cause (aspect ID, dep path, flow name, parent path)
    const causeGroups = new Map<string, CascadeCause[]>();
    for (const cause of cascadeCauses) {
      const key = extractCauseKey(cause);
      const group = causeGroups.get(key) ?? [];
      group.push(cause);
      causeGroups.set(key, group);
    }

    // Push all causes (causeGroups used for count accuracy via .size)
    nodeE021Causes.push(...cascadeCauses);

    if (nodeE021Causes.length > 0) {
      // Build a single collapsed E021 for this node with all causes
      // Use causeGroups.size for the count -- reflects distinct logical upstream sources, not raw file count
      const causeCount = causeGroups.size;
      const causeLines = nodeE021Causes.map((c: CascadeCause) => '  Cause: ' + c.description).join('\n');
      const message = buildIssueMessage({
        what: `Context package changed due to ${causeCount} upstream modification${causeCount === 1 ? '' : 's'}:\n${causeLines}`,
        why: 'Source may no longer satisfy updated aspect requirements.',
        next: `Load context: yg context --node ${nodePath}\nVerify source compliance, update if needed, then: yg approve --node ${nodePath}\nIf source is already compliant: yg approve --node ${nodePath} --reviewed "compliance verified"`,
      });

      issues.push({
        severity: 'error',
        code: 'E021',
        rule: 'cascade-drift',
        message,
        nodePath,
        cascadeCauses: nodeE021Causes,
      });
    }
  }

  // Load all drift states once for verification label lookup and cache invalidation
  const allDriftState = await readDriftState(graph.rootPath);

  // Annotate E021 issues with cached verification label; invalidate LLM cache on any drift
  for (const issue of issues) {
    if (!issue.nodePath) continue;
    const driftState = allDriftState[issue.nodePath];

    // Annotate E021 with verification label BEFORE invalidating cache,
    // so the label reflects the last known state prior to this drift.
    if (issue.code === 'E021') {
      if (driftState?.aspectResults) {
        const allSatisfied = Object.values(driftState.aspectResults)
          .every(r => r.satisfied);
        issue.verificationLabel = allSatisfied ? 'last verified: pass' : 'last verified: fail';
      } else {
        issue.verificationLabel = 'never verified';
      }
    }

    // Invalidate cached LLM results when any drift is detected (E020 or E021)
    if ((issue.code === 'E020' || issue.code === 'E021') &&
        driftState && (driftState.aspectResults || driftState.artifactReview)) {
      delete driftState.aspectResults;
      delete driftState.artifactReview;
      await writeNodeDriftState(graph.rootPath, issue.nodePath, driftState);
    }
  }

  return issues;
}

// ── Coverage scan (E022) ──────────────────────────────────

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
  const yggPrefix = path.relative(projectRoot, graph.rootPath).split(path.sep).join('/');

  const uncovered: string[] = [];

  for (const file of gitTrackedFiles) {
    const normalized = file.replace(/\\/g, '/');

    // Exclude .yggdrasil/ files
    if (normalized.startsWith(yggPrefix + '/') || normalized === yggPrefix) continue;

    // Check if covered by any mapping
    let covered = false;
    for (const rawMp of allMappings) {
      // Normalize: strip trailing slash to avoid double-slash in startsWith check
      const mp = rawMp.replace(/\/+$/, '');
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
 * Build the E022 CheckIssue from uncovered files.
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
      next: `Check ownership candidates: yg context --file <path>\nThen: add to existing node mapping, create a new node, or blackbox.`,
    });
  } else {
    // Large count: guidance BEFORE examples (per CLI messages spec)
    const guidance = coveragePct < 50
      ? 'Establish coverage: create proper nodes for areas you will work on, blackbox the rest.'
      : 'Add to an existing node mapping, create a new node, or blackbox.';
    message = buildIssueMessage({
      what: `${uncoveredFiles.length.toLocaleString()} source files have no graph coverage.\nExamples:\n${sample.map(f => '  ' + f).join('\n')}\n... and ${remaining.toLocaleString()} more`,
      why: 'Files without graph coverage cannot be modified under the protocol.',
      next: `${guidance}\nCheck ownership candidates: yg context --file <path>`,
    });
  }

  return {
    severity: 'error',
    code: 'E022',
    rule: 'unmapped-file',
    message,
    uncoveredFiles,
    uncoveredCount: uncoveredFiles.length,
  };
}

// ── Orphaned drift state (W005) ───────────────────────────

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
 * @param gitTrackedFiles -- pass null to skip E022 (no git available).
 */
export async function runCheck(graph: Graph, gitTrackedFiles: string[] | null): Promise<CheckResult> {
  // 1. Validation (structural + completeness)
  const validation = await validate(graph);
  // Filter out issues without a code -- they are internal (e.g., invalid-scope).
  // All issues have a code. Convert to CheckIssue.
  const validationIssues: CheckIssue[] = validation.issues
    .filter(vi => vi.code)
    .map(vi => ({ ...vi, code: vi.code! }));

  // 2. Drift classification (E020/E021)
  const driftIssues = await classifyDrift(graph);

  // 3. Coverage scan (E022)
  let coverageIssue: CheckIssue | null = null;
  let coveredFiles = 0;
  let totalFiles = 0;
  if (gitTrackedFiles !== null) {
    // Exclude .yggdrasil/ files from total count
    const projectRoot = path.dirname(graph.rootPath);
    const yggPrefix = path.relative(projectRoot, graph.rootPath).split(path.sep).join('/');
    const sourceFiles = gitTrackedFiles.filter(f => !f.startsWith(yggPrefix + '/') && f !== yggPrefix);
    totalFiles = sourceFiles.length;
    const uncovered = scanUncoveredFiles(graph, gitTrackedFiles);
    coveredFiles = totalFiles - uncovered.length;
    coverageIssue = buildCoverageIssue(uncovered, totalFiles);
  }

  // 4. Orphaned drift state (W005)
  const orphanedPaths = await detectOrphanedDriftState(graph);
  const yggRelative = path.relative(path.dirname(graph.rootPath), graph.rootPath).split(path.sep).join('/');
  const orphanWarnings: CheckIssue[] = orphanedPaths.map(p => ({
    severity: 'warning' as const,
    code: 'W005',
    rule: 'orphaned-drift-state',
    message: `Drift state file exists for node that is no longer in the graph:\n     ${yggRelative}/.drift-state/${p}.json\n     Remove the orphaned file or restore the node.`,
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
  const llmAvailable = graph.config.llm !== undefined;

  return {
    projectName: graph.config.name || 'project',
    nodeCount: graph.nodes.size,
    nodeTypeCounts,
    aspectCount: graph.aspects.length,
    flowCount: graph.flows.length,
    coveredFiles,
    totalFiles,
    issues: allIssues,
    suggestedNext,
    llmAvailable,
  };
}

// ── Internal helpers ───────────────────────────────────────

/* v8 ignore start -- duplicated from drift-detector.ts, tested there */
function categorizeFile(filePath: string, rootPath: string, projectRoot: string): DriftCategory {
  const yggPrefix = path.relative(projectRoot, rootPath).split(path.sep).join('/');
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.startsWith(yggPrefix) ? 'graph' : 'source';
}
/* v8 ignore stop */

/**
 * Describe why a cascade fired AND provide the cause-specific review instruction.
 * Each cause type has a distinct message per the CLI messages spec.
 */
function describeCascadeCause(filePath: string, layer: TrackedFileLayer, graph: Graph): string {
  const normalized = filePath.replace(/\\/g, '/');
  const yggPrefix = path.relative(path.dirname(graph.rootPath), graph.rootPath).split(path.sep).join('/');
  const escPrefix = yggPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* v8 ignore start -- regex match fallbacks are defensive; paths are always well-formed */
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
    return `parent node '${ancestorPath}' artifacts changed\n       (${normalized})`;
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
  /* v8 ignore stop */
}

/**
 * Extract a grouping key from a cascade cause so multiple changed files
 * from the same logical cause (e.g., same aspect) produce one E021.
 */
function extractCauseKey(cause: CascadeCause): string {
  // Group by layer + the entity identifier (aspect id, dep path, flow name, parent path)
  // Use the first path segment after the entity type directory
  return `${cause.layer}:${cause.description.split("'")[1] ?? cause.file}`;
}

/**
 * Compute mapping paths owned by descendant nodes (child-wins model).
 * Duplicated from drift-detector.ts -- consider extracting to shared util.
 */
/* v8 ignore start -- duplicated from drift-detector.ts, tested there */
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

/* v8 ignore start -- duplicated from drift-detector.ts, tested there */
async function allPathsMissing(projectRoot: string, mappingPaths: string[]): Promise<boolean> {
  for (const mp of mappingPaths) {
    try {
      await access(path.join(projectRoot, mp));
      return false;
    } catch { /* missing */ }
  }
  return true;
}
/* v8 ignore stop */


/**
 * Group E021 cascade issues by their upstream cause entity.
 * Returns Map<"aspect:id"|"flow:name"|"parent:path", Set<nodePath>>.
 */
function groupCascadeByCause(cascadeErrors: CheckIssue[], graph?: Graph): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  const yggPrefix = graph
    ? path.relative(path.dirname(graph.rootPath), graph.rootPath).split(path.sep).join('/')
    : '.yggdrasil';
  const escPrefix = yggPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const issue of cascadeErrors) {
    if (!issue.nodePath || !issue.cascadeCauses) continue;
    for (const cause of issue.cascadeCauses) {
      const normalized = cause.file.replace(/\\/g, '/');
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

  const driftErrors = errors.filter(i => i.code === 'E020');
  const cascadeErrors = errors.filter(i => i.code === 'E021');
  const structuralErrors = errors.filter(i => i.code >= 'E001' && i.code <= 'E013');
  const coverageErrors = errors.filter(i => i.code === 'E022');
  const completenessErrors = errors.filter(i => i.code >= 'E030' && i.code <= 'E041');

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
      return `yg approve ${flag} ${bestEntity.id} --reviewed "cascade change reviewed"\n  ${bestEntity.count} cascade node${bestEntity.count === 1 ? '' : 's'} from ${bestEntity.type} change${then}`;
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
