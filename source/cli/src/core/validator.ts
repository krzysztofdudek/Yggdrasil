import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Graph, ValidationResult, ValidationIssue, ArtifactConfig } from '../model/types.js';
import { getLastCommitTimestamp } from '../utils/git.js';
import { buildContext } from './context-builder.js';
import { normalizeMappingPaths } from '../utils/paths.js';

/** Reserved directories that are NOT nodes (within model/) */
const RESERVED_DIRS = new Set<string>();

export async function validate(graph: Graph, scope: string = 'all'): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];

  if (graph.configError) {
    issues.push({
      severity: 'error',
      code: 'E012',
      rule: 'invalid-config',
      message: graph.configError,
    });
  }

  for (const { nodePath, message } of graph.nodeParseErrors ?? []) {
    issues.push({
      severity: 'error',
      code: 'E001',
      rule: 'invalid-node-yaml',
      message,
      nodePath,
    });
  }

  if (!graph.configError) {
    issues.push(...checkNodeTypes(graph));
    issues.push(...checkTagsDefined(graph));
    issues.push(...checkAspectTags(graph));
    issues.push(...checkAspectTagUniqueness(graph));
    issues.push(...checkRequiredArtifacts(graph));
    issues.push(...(await checkUnknownKnowledgeCategories(graph)));
    issues.push(...checkInvalidArtifactConditions(graph));
    issues.push(...checkScopeTagsDefined(graph));
    issues.push(...(await checkMissingPatternExamples(graph)));
    issues.push(...(await checkContextBudget(graph)));
    issues.push(...checkHighFanOut(graph));
    issues.push(...(await checkStaleKnowledge(graph)));
  }

  issues.push(...checkSchemas(graph));
  issues.push(...checkRelationTargets(graph));
  issues.push(...checkNoCycles(graph));
  issues.push(...checkMappingOverlap(graph));
  issues.push(...checkBrokenKnowledgeRefs(graph));
  issues.push(...checkBrokenFlowRefs(graph));
  issues.push(...checkBrokenScopeRefs(graph));
  issues.push(...(await checkDirectoriesHaveNodeYaml(graph)));
  issues.push(...(await checkShallowArtifacts(graph)));
  issues.push(...(await checkUnreachableKnowledge(graph)));
  issues.push(...checkUnpairedEvents(graph));

  let filtered = issues;
  let nodesScanned = graph.nodes.size;
  if (scope !== 'all' && scope.trim()) {
    if (!graph.nodes.has(scope)) {
      return {
        issues: [{ severity: 'error', rule: 'invalid-scope', message: `Node not found: ${scope}` }],
        nodesScanned: 0,
      };
    }
    filtered = issues.filter((i) => !i.nodePath || i.nodePath === scope);
    nodesScanned = 1;
  }

  return { issues: filtered, nodesScanned };
}

// --- Rule 0: Node types from config ---

function checkNodeTypes(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allowedTypes = new Set(graph.config.node_types ?? []);
  for (const [nodePath, node] of graph.nodes) {
    if (!allowedTypes.has(node.meta.type)) {
      issues.push({
        severity: 'error',
        code: 'E002',
        rule: 'unknown-node-type',
        message: `Node type '${node.meta.type}' not in config.node_types (${[...allowedTypes].join(', ')})`,
        nodePath,
      });
    }
  }
  return issues;
}

// --- Rule 1: Relation targets exist ---

function findSimilar(target: string, candidates: string[]): string | null {
  if (candidates.length === 0) return null;

  let best: string | null = null;
  let bestScore = -1;

  for (const c of candidates) {
    if (c === target) return c;
    // Simple similarity: shared path segments
    const targetParts = target.split('/');
    const candParts = c.split('/');
    let score = 0;
    for (let i = 0; i < Math.min(targetParts.length, candParts.length); i++) {
      if (targetParts[i] === candParts[i]) score++;
      else break;
    }
    if (score > bestScore && score > 0) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function checkRelationTargets(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodePaths = [...graph.nodes.keys()];
  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (!graph.nodes.has(rel.target)) {
        const suggestion = findSimilar(rel.target, nodePaths);
        const parts = rel.target.split('/');
        const parentPrefix = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
        const existingInParent = nodePaths
          .filter((p) => p.startsWith(parentPrefix) && p !== rel.target)
          .map((p) => {
            const rest = p.slice(parentPrefix.length);
            return rest.split('/')[0];
          })
          .filter((v, i, a) => a.indexOf(v) === i)
          .sort();
        const existingLine =
          existingInParent.length > 0
            ? `\n     Existing nodes in ${parentPrefix || 'model/'}: ${existingInParent.join(', ')}`
            : '';
        const hint = suggestion ? `\n     Did you mean '${suggestion}'?` : '';
        issues.push({
          severity: 'error',
          code: 'E004',
          rule: 'broken-relation',
          message: `Relation target '${rel.target}' does not exist${existingLine}${hint}`,
          nodePath,
        });
      }
    }
  }
  return issues;
}

// --- Rule 2: Tags defined in config.yaml ---

function checkTagsDefined(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedTags = new Set(graph.config.tags ?? []);
  for (const [nodePath, node] of graph.nodes) {
    for (const tag of node.meta.tags ?? []) {
      if (!definedTags.has(tag)) {
        issues.push({
          severity: 'error',
          code: 'E003',
          rule: 'unknown-tag',
          message: `Tag '${tag}' not defined in config.yaml`,
          nodePath,
        });
      }
    }
  }
  return issues;
}

// --- Rule 3: Aspects reference valid tags ---

function checkAspectTags(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedTags = new Set(graph.config.tags ?? []);
  for (const aspect of graph.aspects) {
    if (!definedTags.has(aspect.tag)) {
      issues.push({
        severity: 'error',
        code: 'E007',
        rule: 'broken-aspect-tag',
        message: `Aspect '${aspect.name}' references undefined tag '${aspect.tag}'`,
      });
    }
  }
  return issues;
}

function checkAspectTagUniqueness(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byTag = new Map<string, string[]>();
  for (const aspect of graph.aspects) {
    const names = byTag.get(aspect.tag) ?? [];
    names.push(aspect.name);
    byTag.set(aspect.tag, names);
  }
  for (const [tag, names] of byTag) {
    if (names.length <= 1) continue;
    issues.push({
      severity: 'error',
      code: 'E014',
      rule: 'duplicate-aspect-binding',
      message: `Tag '${tag}' is bound to multiple aspects (${names.join(', ')})`,
    });
  }
  return issues;
}

// --- Rule 4: No circular dependencies (cycles involving blackbox are tolerated) ---

function checkNoCycles(graph: Graph): ValidationIssue[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const p of graph.nodes.keys()) color.set(p, WHITE);

  const issues: ValidationIssue[] = [];

  function dfs(nodePath: string, pathSegments: string[]): boolean {
    color.set(nodePath, GRAY);
    const node = graph.nodes.get(nodePath)!;
    const structuralTypes = new Set(['uses', 'calls', 'extends', 'implements']);
    for (const rel of node.meta.relations ?? []) {
      const targetNode = graph.nodes.get(rel.target);
      if (!targetNode) continue;
      if (!structuralTypes.has(rel.type)) continue;
      if (color.get(rel.target) === GRAY) {
        const cyclePath = [...pathSegments, nodePath, rel.target];
        const cycleNodes = pathSegments.slice(pathSegments.indexOf(rel.target)).concat(nodePath);
        const hasBlackboxInCycle = cycleNodes.some(
          (p) => graph.nodes.get(p)?.meta.blackbox === true,
        );
        if (!hasBlackboxInCycle) {
          issues.push({
            severity: 'error',
            code: 'E010',
            rule: 'structural-cycle',
            message: `Circular dependency: ${cyclePath.join(' -> ')}`,
          });
        }
        return true;
      }
      if (color.get(rel.target) === WHITE) {
        if (dfs(rel.target, [...pathSegments, nodePath])) return true;
      }
    }
    color.set(nodePath, BLACK);
    return false;
  }

  for (const nodePath of graph.nodes.keys()) {
    if (color.get(nodePath) === WHITE) {
      dfs(nodePath, []);
    }
  }

  return issues;
}

// --- Rule 5: Mapping ownership overlap ---

function normalizePathForCompare(mappingPath: string): string {
  return mappingPath.replace(/\\/g, '/').replace(/\/+$/, '');
}

function arePathsOverlapping(pathA: string, pathB: string): boolean {
  if (pathA === pathB) return true;
  return pathA.startsWith(pathB + '/') || pathB.startsWith(pathA + '/');
}

function checkMappingOverlap(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ownership: Array<{ nodePath: string; mappingPath: string }> = [];

  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping)
      .map(normalizePathForCompare)
      .filter((mappingPath) => mappingPath.length > 0);
    for (const mappingPath of mappingPaths) {
      ownership.push({ nodePath, mappingPath });
    }
  }

  for (let index = 0; index < ownership.length; index++) {
    const current = ownership[index];
    for (let nestedIndex = index + 1; nestedIndex < ownership.length; nestedIndex++) {
      const candidate = ownership[nestedIndex];
      if (current.nodePath === candidate.nodePath) continue;
      if (!arePathsOverlapping(current.mappingPath, candidate.mappingPath)) continue;

      issues.push({
        severity: 'error',
        code: 'E009',
        rule: 'overlapping-mapping',
        message:
          `Mapping paths '${current.mappingPath}' (${current.nodePath}) and ` +
          `'${candidate.mappingPath}' (${candidate.nodePath}) overlap. ` +
          `Keep one owner mapping and model other concerns via relations.`,
        nodePath: candidate.nodePath,
      });
    }
  }

  return issues;
}

// --- Rule 6: Required artifacts per config.artifacts (W001) ---

function getIncomingRelationSources(graph: Graph, nodePath: string): string[] {
  const sources: string[] = [];
  for (const [srcPath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (rel.target === nodePath) sources.push(srcPath);
    }
  }
  return sources;
}

function artifactRequiredReason(
  graph: Graph,
  nodePath: string,
  node: {
    meta: { relations?: Array<{ target: string }>; tags?: string[]; blackbox?: boolean };
    artifacts: Array<{ filename: string }>;
  },
  required: ArtifactConfig['required'],
): string | null {
  if (required === 'never') return null;
  if (required === 'always') {
    return node.meta.blackbox ? null : 'required: always';
  }
  const when = (required as { when: string }).when;
  if (when === 'has_incoming_relations') {
    const sources = getIncomingRelationSources(graph, nodePath);
    return sources.length > 0
      ? `${sources.length} incoming relation(s): ${sources.join(', ')}`
      : null;
  }
  if (when === 'has_outgoing_relations') {
    const count = node.meta.relations?.length ?? 0;
    return count > 0 ? `${count} outgoing relation(s)` : null;
  }
  if (when.startsWith('has_tag:')) {
    const tag = when.slice(8);
    return (node.meta.tags ?? []).includes(tag) ? `node has tag '${tag}'` : null;
  }
  return null;
}

function getIncomingRelations(graph: Graph, nodePath: string): string[] {
  const incoming: string[] = [];
  for (const [fromPath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (rel.target === nodePath) {
        incoming.push(fromPath);
        break;
      }
    }
  }
  return incoming.sort();
}

function checkRequiredArtifacts(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const artifacts = graph.config.artifacts ?? {};

  for (const [nodePath, node] of graph.nodes) {
    for (const [filename, config] of Object.entries(artifacts)) {
      const hasArtifact = node.artifacts.some((a) => a.filename === filename);
      const reason = artifactRequiredReason(graph, nodePath, node, config.required);

      if (reason && !hasArtifact) {
        const action = config.description ?? '';
        const incoming = getIncomingRelations(graph, nodePath);
        const incomingStr =
          incoming.length > 0
            ? ` Node has ${incoming.length} incoming relation(s): ${incoming.slice(0, 5).join(', ')}${incoming.length > 5 ? '...' : ''}.`
            : '';
        const msg = action
          ? `Missing required artifact '${filename}' (${reason}).${incomingStr} ${action}`
          : `Missing required artifact '${filename}' (${reason}).${incomingStr}`;
        issues.push({
          severity: 'warning',
          code: 'W001',
          rule: 'missing-artifact',
          message: msg.trim(),
          nodePath,
        });
      }
    }
  }

  return issues;
}

// --- E005: Broken knowledge refs (node.meta.knowledge) ---

function checkBrokenKnowledgeRefs(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const knowledgePaths = new Set(graph.knowledge.map((k) => k.path));
  for (const [nodePath, node] of graph.nodes) {
    for (const kPath of node.meta.knowledge ?? []) {
      const norm = kPath.replace(/\/$/, '');
      if (!knowledgePaths.has(norm) && !knowledgePaths.has(kPath)) {
        issues.push({
          severity: 'error',
          code: 'E005',
          rule: 'broken-knowledge-ref',
          message: `Knowledge ref '${kPath}' does not resolve to existing knowledge item`,
          nodePath,
        });
      }
    }
  }
  return issues;
}

// --- E006: Broken flow refs (flow.nodes, flow.knowledge) ---

function checkBrokenFlowRefs(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodePaths = new Set(graph.nodes.keys());
  const knowledgePaths = new Set(graph.knowledge.map((k) => k.path));
  for (const flow of graph.flows) {
    for (const n of flow.nodes) {
      if (!nodePaths.has(n)) {
        issues.push({
          severity: 'error',
          code: 'E006',
          rule: 'broken-flow-ref',
          message: `Flow '${flow.name}' references non-existent node '${n}'`,
        });
      }
    }
    for (const kPath of flow.knowledge ?? []) {
      const norm = kPath.replace(/\/$/, '');
      if (!knowledgePaths.has(norm) && !knowledgePaths.has(kPath)) {
        issues.push({
          severity: 'error',
          code: 'E005',
          rule: 'broken-knowledge-ref',
          message: `Flow '${flow.name}' references non-existent knowledge '${kPath}'`,
          nodePath: `flows/${flow.name}`,
        });
      }
    }
  }
  return issues;
}

// --- E008: Broken scope refs (knowledge scope.nodes) ---

function checkBrokenScopeRefs(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodePaths = new Set(graph.nodes.keys());
  for (const k of graph.knowledge) {
    if (typeof k.scope === 'object' && 'nodes' in k.scope) {
      for (const n of k.scope.nodes) {
        if (!nodePaths.has(n)) {
          issues.push({
            severity: 'error',
            code: 'E008',
            rule: 'broken-scope-ref',
            message: `Knowledge '${k.path}' scope references non-existent node '${n}'`,
          });
        }
      }
    }
  }
  return issues;
}

function checkScopeTagsDefined(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedTags = new Set(graph.config.tags ?? []);
  for (const k of graph.knowledge) {
    if (typeof k.scope !== 'object' || !('tags' in k.scope)) continue;
    for (const tag of k.scope.tags) {
      if (definedTags.has(tag)) continue;
      issues.push({
        severity: 'error',
        code: 'E008',
        rule: 'broken-scope-ref',
        message: `Knowledge '${k.path}' scope references undefined tag '${tag}'`,
      });
    }
  }
  return issues;
}

// --- E011: Unknown knowledge categories (dirs under knowledge/ not in config) ---
// --- E017: Missing knowledge category dir (category in config but no knowledge/<cat>/) ---

async function checkUnknownKnowledgeCategories(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const categorySet = new Set((graph.config.knowledge_categories ?? []).map((c) => c.name));
  const knowledgeDir = path.join(graph.rootPath, 'knowledge');
  const existingDirs = new Set<string>();
  try {
    const entries = await readdir(knowledgeDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      existingDirs.add(e.name);
      if (!categorySet.has(e.name)) {
        issues.push({
          severity: 'error',
          code: 'E011',
          rule: 'unknown-knowledge-category',
          message: `Directory knowledge/${e.name}/ does not match any config.knowledge_categories`,
        });
      }
    }
  } catch {
    // knowledge/ may not exist
  }

  for (const cat of graph.config.knowledge_categories ?? []) {
    if (!existingDirs.has(cat.name)) {
      issues.push({
        severity: 'error',
        code: 'E017',
        rule: 'missing-knowledge-category-dir',
        message: `Category '${cat.name}' in config has no knowledge/${cat.name}/ directory`,
      });
    }
  }

  return issues;
}

// --- E013: Invalid artifact condition (has_tag:X where X not in config.tags) ---

function checkInvalidArtifactConditions(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedTags = new Set(graph.config.tags ?? []);
  const artifacts = graph.config.artifacts ?? {};
  for (const [artifactName, config] of Object.entries(artifacts)) {
    const required = config.required;
    if (typeof required === 'object' && required && 'when' in required) {
      const when = (required as { when: string }).when;
      if (when.startsWith('has_tag:')) {
        const tag = when.slice(8);
        if (!definedTags.has(tag)) {
          issues.push({
            severity: 'error',
            code: 'E013',
            rule: 'invalid-artifact-condition',
            message: `Artifact '${artifactName}' condition has_tag:${tag} references undefined tag`,
          });
        }
      }
    }
  }
  return issues;
}

// --- W002: Shallow artifacts (below min_artifact_length) ---

async function checkShallowArtifacts(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const minLen = graph.config.quality?.min_artifact_length ?? 50;
  for (const [nodePath, node] of graph.nodes) {
    for (const art of node.artifacts) {
      if (art.content.trim().length < minLen) {
        issues.push({
          severity: 'warning',
          code: 'W002',
          rule: 'shallow-artifact',
          message: `Artifact '${art.filename}' is below minimum length (${art.content.length} < ${minLen})`,
          nodePath,
        });
      }
    }
  }
  return issues;
}

// --- W003: Unreachable knowledge (does not reach any context package) ---

async function checkUnreachableKnowledge(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const nodePaths = new Set(graph.nodes.keys());
  const nodeTags = new Map<string, Set<string>>();
  for (const [p, n] of graph.nodes) {
    nodeTags.set(p, new Set(n.meta.tags ?? []));
  }
  const knowledgeReachable = new Set<string>();
  for (const k of graph.knowledge) {
    if (k.scope === 'global') {
      knowledgeReachable.add(k.path);
      continue;
    }
    if (typeof k.scope === 'object' && 'tags' in k.scope) {
      for (const [, tags] of nodeTags) {
        if (k.scope.tags.some((t) => tags.has(t))) {
          knowledgeReachable.add(k.path);
          break;
        }
      }
    }
    if (typeof k.scope === 'object' && 'nodes' in k.scope) {
      if (k.scope.nodes.some((n) => nodePaths.has(n))) {
        knowledgeReachable.add(k.path);
      }
    }
  }
  for (const [, node] of graph.nodes) {
    for (const kPath of node.meta.knowledge ?? []) {
      const k = graph.knowledge.find(
        (i) => i.path === kPath || i.path === kPath.replace(/\/$/, ''),
      );
      if (k) knowledgeReachable.add(k.path);
    }
  }
  for (const flow of graph.flows) {
    for (const kPath of flow.knowledge ?? []) {
      const k = graph.knowledge.find(
        (i) => i.path === kPath || i.path === kPath.replace(/\/$/, ''),
      );
      if (k) knowledgeReachable.add(k.path);
    }
  }
  for (const k of graph.knowledge) {
    if (!knowledgeReachable.has(k.path)) {
      issues.push({
        severity: 'warning',
        code: 'W003',
        rule: 'unreachable-knowledge',
        message: `Knowledge '${k.path}' does not reach any context package`,
      });
    }
  }
  return issues;
}

// --- W004: Pattern without example file ---

async function checkMissingPatternExamples(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const hasPatterns = (graph.config.knowledge_categories ?? []).some((c) => c.name === 'patterns');
  if (!hasPatterns) return issues;
  const patternsDir = path.join(graph.rootPath, 'knowledge', 'patterns');
  try {
    const entries = await readdir(patternsDir, { withFileTypes: true });
    const exampleExtensions = new Set([
      '.ts',
      '.js',
      '.tsx',
      '.jsx',
      '.py',
      '.go',
      '.rs',
      '.java',
      '.kt',
    ]);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const itemDir = path.join(patternsDir, e.name);
      const itemEntries = await readdir(itemDir, { withFileTypes: true });
      const hasExample = itemEntries.some(
        (f) =>
          f.isFile() &&
          f.name !== 'knowledge.yaml' &&
          (f.name.startsWith('example') ||
            exampleExtensions.has(path.extname(f.name).toLowerCase())),
      );
      if (!hasExample) {
        issues.push({
          severity: 'warning',
          code: 'W004',
          rule: 'missing-example',
          message: `Pattern 'patterns/${e.name}' has no example file`,
        });
      }
    }
  } catch {
    // patterns/ may not exist
  }
  return issues;
}

// --- W007: High fan-out (exceeds max_direct_relations) ---

function checkHighFanOut(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const maxRel = graph.config.quality?.max_direct_relations ?? 10;
  for (const [nodePath, node] of graph.nodes) {
    const count = node.meta.relations?.length ?? 0;
    if (count > maxRel) {
      issues.push({
        severity: 'warning',
        code: 'W007',
        rule: 'high-fan-out',
        message: `Node has ${count} direct relations (max: ${maxRel})`,
        nodePath,
      });
    }
  }
  return issues;
}

// --- W008: Stale knowledge (Proxy: Git commit timestamps, not file mtime) ---

function getNodesInScope(
  k: { scope: 'global' | { tags?: string[]; nodes?: string[] } },
  graph: Graph,
): string[] {
  if (k.scope === 'global') {
    return [...graph.nodes.keys()];
  }
  if (typeof k.scope === 'object' && 'nodes' in k.scope && k.scope.nodes) {
    return k.scope.nodes.filter((p) => graph.nodes.has(p));
  }
  if (typeof k.scope === 'object' && 'tags' in k.scope && k.scope.tags) {
    const tagSet = new Set(k.scope.tags);
    return [...graph.nodes.keys()].filter((p) => {
      const node = graph.nodes.get(p)!;
      return (node.meta.tags ?? []).some((t) => tagSet.has(t));
    });
  }
  return [];
}

async function checkStaleKnowledge(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const stalenessDays = graph.config.quality?.knowledge_staleness_days ?? 90;
  const projectRoot = path.dirname(graph.rootPath);
  const yggRel = path.relative(projectRoot, graph.rootPath).replace(/\\/g, '/') || '.yggdrasil';

  for (const k of graph.knowledge) {
    const scopeNodes = getNodesInScope(k, graph);
    if (scopeNodes.length === 0) continue;

    const kPath = `${yggRel}/knowledge/${k.path}`;
    const tK = getLastCommitTimestamp(projectRoot, kPath);
    if (tK === null) continue;

    let maxTp = 0;
    let latestNode = '';
    for (const nodePath of scopeNodes) {
      const nodePathRel = `${yggRel}/model/${nodePath}`;
      const tP = getLastCommitTimestamp(projectRoot, nodePathRel);
      if (tP !== null && tP > maxTp) {
        maxTp = tP;
        latestNode = nodePath;
      }
    }
    if (maxTp === 0) continue;

    const diffDays = (maxTp - tK) / (60 * 60 * 24);
    if (diffDays > stalenessDays) {
      issues.push({
        severity: 'warning',
        code: 'W008',
        rule: 'stale-knowledge',
        message: `Knowledge '${k.path}' may be stale: node '${latestNode}' modified ${Math.floor(diffDays)} days later (Git commits)`,
        nodePath: latestNode,
      });
    }
  }
  return issues;
}

// --- W009: Unpaired event relations (emits without listens or vice versa) ---

function checkUnpairedEvents(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const emitsTo = new Map<string, Set<string>>();
  const listensFrom = new Map<string, Set<string>>();
  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (rel.type === 'emits') {
        const set = emitsTo.get(nodePath) ?? new Set();
        set.add(rel.target);
        emitsTo.set(nodePath, set);
      }
      if (rel.type === 'listens') {
        const set = listensFrom.get(nodePath) ?? new Set();
        set.add(rel.target);
        listensFrom.set(nodePath, set);
      }
    }
  }
  for (const [emitter, targets] of emitsTo) {
    for (const target of targets) {
      const listenerSet = listensFrom.get(target);
      if (!listenerSet?.has(emitter)) {
        issues.push({
          severity: 'warning',
          code: 'W009',
          rule: 'unpaired-event',
          message: `Node '${emitter}' emits to '${target}' but '${target}' has no listens from '${emitter}'`,
          nodePath: emitter,
        });
      }
    }
  }
  for (const [listener, sources] of listensFrom) {
    for (const source of sources) {
      const emitterSet = emitsTo.get(source);
      if (!emitterSet?.has(listener)) {
        issues.push({
          severity: 'warning',
          code: 'W009',
          rule: 'unpaired-event',
          message: `Node '${listener}' listens from '${source}' but '${source}' has no emits to '${listener}'`,
          nodePath: listener,
        });
      }
    }
  }
  return issues;
}

// --- Schema validation (required graph-layer schemas present in templates/) ---

const REQUIRED_SCHEMAS = ['node', 'aspect', 'flow', 'knowledge'] as const;

function checkSchemas(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const present = new Set(graph.schemas.map((s) => s.schemaType));

  for (const required of REQUIRED_SCHEMAS) {
    if (!present.has(required)) {
      issues.push({
        severity: 'warning',
        code: 'W010',
        rule: 'missing-schema',
        message: `Schema '${required}.yaml' missing from .yggdrasil/templates/`,
      });
    }
  }

  return issues;
}

// --- Directories have node.yaml ---

async function checkDirectoriesHaveNodeYaml(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const modelDir = path.join(graph.rootPath, 'model');

  async function scanDir(dirPath: string, segments: string[]): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const hasNodeYaml = entries.some((e) => e.isFile() && e.name === 'node.yaml');
    const dirName = path.basename(dirPath);

    if (RESERVED_DIRS.has(dirName)) return;

    const hasContent = entries.some((e) => e.isFile()) || entries.some((e) => e.isDirectory());
    const graphPath = segments.join('/');

    if (hasContent && !hasNodeYaml && graphPath !== '') {
      issues.push({
        severity: 'error',
        code: 'E015',
        rule: 'missing-node-yaml',
        message: `Directory '${graphPath}' has content but no node.yaml`,
        nodePath: graphPath,
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (RESERVED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      await scanDir(path.join(dirPath, entry.name), [...segments, entry.name]);
    }
  }

  try {
    const rootEntries = await readdir(modelDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      await scanDir(path.join(modelDir, entry.name), [entry.name]);
    }
  } catch {
    // model/ may not exist
  }

  return issues;
}

// --- Context budget (W005 warning, W006 error) ---

async function checkContextBudget(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const warningThreshold = graph.config.quality?.context_budget.warning ?? 5000;
  const errorThreshold = graph.config.quality?.context_budget.error ?? 10000;

  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.blackbox) continue;
    try {
      const pkg = await buildContext(graph, nodePath);
      if (pkg.tokenCount >= errorThreshold) {
        issues.push({
          severity: 'warning',
          code: 'W006',
          rule: 'budget-error',
          message: `Context is ${pkg.tokenCount.toLocaleString()} tokens (error threshold: ${errorThreshold.toLocaleString()}) — blocks materialization, node must be split`,
          nodePath,
        });
      } else if (pkg.tokenCount >= warningThreshold) {
        issues.push({
          severity: 'warning',
          code: 'W005',
          rule: 'budget-warning',
          message: `Context is ${pkg.tokenCount.toLocaleString()} tokens (warning threshold: ${warningThreshold.toLocaleString()}). Consider splitting the node or reducing dependencies.`,
          nodePath,
        });
      }
    } catch {
      // If context building fails, other rules will catch it
    }
  }
  return issues;
}
