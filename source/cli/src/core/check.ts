import type {
  Graph,
  DriftCategory,
  DriftFileChange,
  DriftStatus,
  TrackedFileLayer,
  ValidationIssue,
} from '../model/types.js';
import { readDriftState, readNodeDriftState } from '../io/drift-state-store.js';
import { hashTrackedFiles } from '../utils/hash.js';
import { collectTrackedFiles } from './context-files.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { validate, expandMappingToFiles } from './validator.js';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

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
  /** For E021: whether all anchor patterns still match source on this node */
  anchorsPassing?: boolean;
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
  healthScore: number;
  issues: CheckIssue[];
  /** Suggested next command based on highest-priority error */
  suggestedNext: string | null;
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
          ? `Mapping declared but source files never created:\n${mappingPaths.map(p => '       ' + p).join('\n')}\n     Implement from the graph specification, then approve.`
          : `Mapping declared but no baseline recorded:\n${mappingPaths.map(p => '       ' + p).join('\n')}\n     Verify artifacts match source, then approve.`,
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
        message: `Mapped source files not found on disk:\n${mappingPaths.map(p => '       ' + p).join('\n')}\n     Re-create the file, or remove the mapping from yg-node.yaml.`,
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
        message = `Source files changed since last approve. Graph artifacts unchanged.\nChanged:\n${sourceFiles.map(f => '  ' + f).join('\n')}\nUpdate artifacts to reflect source changes, then approve.\nIf change is cosmetic (formatting, comments): approve --acknowledge.`;
      } else if (driftSubtype === 'graph-drift') {
        message = `Graph artifacts changed since last approve. Source files unchanged.\nChanged:\n${graphFiles.map(f => '  ' + f).join('\n')}\nImplement the graph changes in source, then approve.\nIf change is cosmetic (typo, clarification): approve --acknowledge.`;
      } else {
        message = `Both source files and graph artifacts changed since last approve.\nSource:\n${sourceFiles.map(f => '  ' + f).join('\n')}\nGraph:\n${graphFiles.map(f => '  ' + f).join('\n')}\nEnsure source and artifacts are consistent, then approve.`;
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

    // Group cascade causes by logical cause (aspect ID, dep path, flow name, parent path)
    // Then emit one E021 per logical cause, listing all changed files for that cause
    const causeGroups = new Map<string, CascadeCause[]>();
    for (const cause of cascadeCauses) {
      const key = extractCauseKey(cause);
      const group = causeGroups.get(key) ?? [];
      group.push(cause);
      causeGroups.set(key, group);
    }

    for (const [, groupCauses] of causeGroups) {
      const primaryCause = groupCauses[0];

      // Check if this is an integration_aspects cascade (dependency yg-node.yaml change
      // on a target that has integration_aspects, OR synthetic integration-anchors: entry)
      const isIntegrationAnchorsCascade = primaryCause.layer === 'relational'
        && (groupCauses.some(c => c.file.startsWith('integration-anchors:'))
          || (groupCauses.some(c => c.file.endsWith('yg-node.yaml'))
            && (() => {
              // Extract target path from cause description
              const match = primaryCause.description.match(/dependency '([^']+)'/);
              if (!match) return false;
              const target = graph.nodes.get(match[1]);
              return (target?.meta.integration_aspects?.length ?? 0) > 0;
            })()));

      let message: string;
      const causeLines = groupCauses.map(c => '     Cause: ' + c.description).join('\n');

      if (isIntegrationAnchorsCascade) {
        message = `Context package changed due to upstream modification.\n${causeLines}\n     New integration anchors may be required. Run yg check for E040 errors.\n     Review and approve --acknowledge, or realize new anchors first.`;
      } else {
        const reviewTarget = primaryCause.layer === 'aspects' ? 'updated context'
          : primaryCause.layer === 'relational' ? 'updated dependency interface'
          : primaryCause.layer === 'flows' ? 'updated flow'
          : primaryCause.layer === 'hierarchy' ? 'updated parent context'
          : 'updated context';

        message = `Context package changed due to upstream modification.\n${causeLines}\n     Review source compliance with ${reviewTarget}, then:\n       - If source needs changes: update source + artifacts, approve.\n       - If source is already compliant: approve --acknowledge.`;
      }

      issues.push({
        severity: 'error',
        code: 'E021',
        rule: 'cascade-drift',
        message,
        nodePath,
        cascadeCauses: groupCauses,
      });
    }
  }

  // Annotate E021 issues with anchor-pass status
  for (const issue of issues) {
    if (issue.code !== 'E021' || !issue.nodePath) continue;
    const node = graph.nodes.get(issue.nodePath);
    if (!node || node.meta.blackbox) {
      issue.anchorsPassing = undefined;
      continue;
    }
    issue.anchorsPassing = await checkNodeAnchorsPass(graph, issue.nodePath);
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
    message = `${uncoveredFiles.length.toLocaleString()} source file${uncoveredFiles.length === 1 ? '' : 's'} not covered by any node\n${sample.map(f => '     ' + f).join('\n')}`;
    message += `\n     Add to an existing node's mapping, create a new node, or blackbox the area.`;
  } else {
    // Large count: guidance BEFORE examples (per CLI messages spec)
    message = `${uncoveredFiles.length.toLocaleString()} source files have no graph coverage`;
    if (coveragePct < 50) {
      message += `\n     Establish coverage: create proper nodes for areas you will work on,\n     blackbox areas you won't touch. Start with the area relevant to your\n     current task, blackbox the rest.`;
    } else {
      message += `\n     Add to an existing node's mapping, create a new node, or blackbox the area.`;
    }
    message += `\n     Examples of uncovered files:\n${sample.map(f => '       ' + f).join('\n')}\n       ... and ${remaining.toLocaleString()} more`;
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

// ── Health score ──────────────────────────────────────────

/**
 * Compute health score (0-100). Start at 100, deduct per issue.
 * Weights: E020/E021 = -5, other errors = -3, warnings = -1.
 * E022 counts as one error regardless of file count.
 */
export function computeHealthScore(issues: CheckIssue[]): number {
  let score = 100;
  for (const issue of issues) {
    if (issue.severity === 'warning') {
      score -= 1;
    } else if (issue.code === 'E020' || issue.code === 'E021') {
      score -= 5;
    } else {
      score -= 3;
    }
  }
  return Math.max(0, score);
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

  const healthScore = computeHealthScore(allIssues);
  const suggestedNext = computeSuggestedNext(allIssues);

  return {
    projectName: graph.config.name || 'project',
    nodeCount: graph.nodes.size,
    nodeTypeCounts,
    aspectCount: graph.aspects.length,
    flowCount: graph.flows.length,
    coveredFiles,
    totalFiles,
    healthScore,
    issues: allIssues,
    suggestedNext,
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
    // Handle synthetic integration-anchors: entries (no disk path)
    const syntheticMatch = filePath.match(/^integration-anchors:(.+)$/);
    if (syntheticMatch) {
      const depPath = syntheticMatch[1];
      return `dependency '${depPath}' integration anchors changed\n       (${filePath})`;
    }
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
 * Check whether all realized anchor regex patterns still match source for a node.
 * Returns true if all pass, false if any fail, undefined if no realized anchors exist.
 *
 * Note: With the v4 redesign, aspects and relations no longer carry anchor realizations.
 * Anchor realizations are now in mapping groups only. This function checks mapping group anchors.
 */
async function checkNodeAnchorsPass(graph: Graph, nodePath: string): Promise<boolean | undefined> {
  const node = graph.nodes.get(nodePath);
  if (!node) return undefined;
  const mappingPaths = normalizeMappingPaths(node.meta.mapping);
  if (mappingPaths.length === 0) return undefined;

  const projectRoot = path.dirname(graph.rootPath);
  const sourceFiles = await expandMappingToFiles(projectRoot, mappingPaths);
  const fileContents: string[] = [];
  for (const fp of sourceFiles) {
    try { fileContents.push(await readFile(fp, 'utf-8')); } catch { /* skip */ }
  }

  let hasAnyRealizedAnchors = false;

  // Check mapping group anchors
  for (const group of node.meta.mapping ?? []) {
    for (const aspectGroup of group.aspects ?? []) {
      for (const anchor of Object.values(aspectGroup.anchors ?? {})) {
        if (!anchor.regex) continue;
        hasAnyRealizedAnchors = true;
        try {
          const regex = new RegExp(anchor.regex);
          if (!fileContents.some(c => regex.test(c))) return false;
        } catch { return false; }
      }
    }
  }

  return hasAnyRealizedAnchors ? true : undefined;
}

/**
 * Suggest the next command to run based on highest-priority error.
 * Priority: drift > cascade > structural > coverage > completeness.
 */
function computeSuggestedNext(issues: CheckIssue[]): string | null {
  const errors = issues.filter(i => i.severity === 'error');
  /* v8 ignore next -- tested by clean-check test, but v8 sometimes marks it uncovered */
  if (errors.length === 0) return null;

  // Drift first
  const drift = errors.find(i => i.code === 'E020');
  if (drift && drift.nodePath) {
    return `yg context --node ${drift.nodePath}\n      (Load context for drifted node, update artifacts, then approve)`;
  }

  // Cascade
  const cascade = errors.find(i => i.code === 'E021');
  if (cascade && cascade.nodePath) {
    return `yg context --node ${cascade.nodePath}\n      (Review source compliance with updated upstream context)`;
  }

  // Structural
  const structural = errors.find(i => i.code && i.code >= 'E001' && i.code <= 'E013');
  if (structural) {
    return `Fix ${structural.code} in ${structural.nodePath ?? '.yggdrasil/'}\n      (Resolve structural error before other work)`;
  }

  // Coverage
  const coverage = errors.find(i => i.code === 'E022');
  if (coverage) {
    return `Create nodes or blackbox for uncovered files\n      (Establish graph coverage for your active work area)`;
  }

  // Completeness
  const completeness = errors.find(i => i.code && i.code >= 'E030');
  if (completeness && completeness.nodePath) {
    return `Fix ${completeness.code} for ${completeness.nodePath}\n      (${completeness.rule}: add missing content)`;
  }

  return null;
}
