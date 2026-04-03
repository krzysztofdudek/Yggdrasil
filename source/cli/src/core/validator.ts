import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { STANDARD_ARTIFACTS } from '../model/types.js';
import type { Graph, ValidationResult, ValidationIssue, ArtifactConfig, GraphNode } from '../model/types.js';
import { buildContext, computeBudgetBreakdown } from './context-builder.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import {
  computeEffectiveAspects,
  computeEffectiveIntegrationAspects,
  getIntegrationAspectSource,
} from './effective-aspects.js';

/** Reserved directories that are NOT nodes (within model/) */
const RESERVED_DIRS = new Set<string>();

export async function validate(graph: Graph, scope: string = 'all'): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];

  if (graph.configError) {
    issues.push({
      severity: 'error',
      code: 'E009',
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
    issues.push(...checkAspectsDefined(graph));
    issues.push(...checkAspectIds(graph));
    issues.push(...checkAspectIdUniqueness(graph));
    issues.push(...checkImpliedAspectsExist(graph));
    issues.push(...checkImpliesNoCycles(graph));
    // E035 removed — replaced by E051 (architecture enforcement)
    issues.push(...checkAspectAnchors(graph));
    issues.push(...checkAnchorRealizations(graph));
    issues.push(...(await checkAnchorPatterns(graph)));
    issues.push(...checkRequiredArtifacts(graph));
    // invalid-artifact-condition removed — standard artifacts don't use has_aspect: conditions
    issues.push(...(await checkContextBudget(graph)));
    issues.push(...checkHighFanOut(graph));
    issues.push(...checkMissingDescriptions(graph));
  }

  issues.push(...checkSchemas(graph));
  issues.push(...checkRelationTargets(graph));
  issues.push(...checkNoCycles(graph));
  issues.push(...checkMappingOverlap(graph));
  issues.push(...(await checkMappingPathsExist(graph)));
  issues.push(...checkBrokenFlowRefs(graph));
  issues.push(...checkFlowAspectIds(graph));
  issues.push(...(await checkDirectoriesHaveNodeYaml(graph)));
  issues.push(...(await checkShallowArtifacts(graph)));
  issues.push(...(await checkWideNodes(graph)));
  issues.push(...checkUnpairedEvents(graph));
  issues.push(...checkArchitectureConstraints(graph));
  issues.push(...(await checkIntegrationAspects(graph)));

  let filtered = issues;
  let nodesScanned = graph.nodes.size;
  if (scope !== 'all' && scope.trim()) {
    if (!graph.nodes.has(scope)) {
      // Check if the node exists but has a parse error
      const parseError = (graph.nodeParseErrors ?? []).find(
        (e) => e.nodePath === scope || scope.startsWith(e.nodePath + '/'),
      );
      if (parseError) {
        return {
          issues: [{
            severity: 'error',
            code: 'E001',
            rule: 'invalid-node-yaml',
            message: parseError.message,
            nodePath: parseError.nodePath,
          }],
          nodesScanned: 0,
        };
      }
      return {
        issues: [{ severity: 'error', rule: 'invalid-scope', message: `Node not found: ${scope}` }],
        nodesScanned: 0,
      };
    }
    const scopePrefix = scope + '/';
    filtered = issues.filter((i) => !i.nodePath || i.nodePath === scope || i.nodePath.startsWith(scopePrefix));
    nodesScanned = [...graph.nodes.keys()].filter((p) => p === scope || p.startsWith(scopePrefix)).length;
  }

  return { issues: filtered, nodesScanned };
}

// --- Rule 0: Node types from config ---

function checkNodeTypes(graph: Graph): ValidationIssue[] {
  // node_types have moved to yg-architecture.yaml; this check is skipped when config.node_types is undefined
  if (!graph.config.node_types) {
    return [];
  }
  const issues: ValidationIssue[] = [];
  const allowedTypes = new Set(Object.keys(graph.config.node_types));
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

// --- Rule 2: Node aspects must reference a defined aspect ---

function checkAspectsDefined(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const validAspectIds = new Set(graph.aspects.map((a) => a.id));
  for (const [nodePath, node] of graph.nodes) {
    for (const aspectId of node.meta.aspects ?? []) {
      if (!validAspectIds.has(aspectId)) {
        issues.push({
          severity: 'error',
          code: 'E003',
          rule: 'unknown-aspect',
          message: `Aspect '${aspectId}' has no corresponding directory in aspects/`,
          nodePath,
        });
      }
    }
  }
  return issues;
}

// --- Rule 3: Aspect ids (derived from directory path) — always valid when aspect exists ---

function checkAspectIds(_graph: Graph): ValidationIssue[] {
  // validAspectIds = graph.aspects.map(a => a.id), so every aspect's id is valid by definition
  return [];
}

function checkAspectIdUniqueness(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map<string, string[]>();
  for (const aspect of graph.aspects) {
    const names = byId.get(aspect.id) ?? [];
    names.push(aspect.name);
    byId.set(aspect.id, names);
  }
  for (const [id, names] of byId) {
    if (names.length <= 1) continue;
    issues.push({
      severity: 'error',
      code: 'E010',
      rule: 'duplicate-aspect-binding',
      message: `Aspect '${id}' is bound to multiple aspects (${names.join(', ')})`,
    });
  }
  return issues;
}

// --- Rule: Implied aspects exist ---

function checkImpliedAspectsExist(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const idToAspect = new Map<string, { name: string }>();
  for (const a of graph.aspects) {
    idToAspect.set(a.id, { name: a.name });
  }
  for (const aspect of graph.aspects) {
    for (const impliedId of aspect.implies ?? []) {
      if (!idToAspect.has(impliedId)) {
        issues.push({
          severity: 'error',
          code: 'E012',
          rule: 'implied-aspect-missing',
          message: `Aspect '${aspect.name}' implies '${impliedId}' but no aspect with that id exists in aspects/`,
        });
      }
    }
  }
  return issues;
}

// --- Rule: No cycles in aspect implies graph ---

function checkImpliesNoCycles(graph: Graph): ValidationIssue[] {
  const idToAspect = new Map<string, { implies?: string[] }>();
  for (const a of graph.aspects) {
    idToAspect.set(a.id, { implies: a.implies });
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of idToAspect.keys()) color.set(id, WHITE);

  const issues: ValidationIssue[] = [];

  function dfs(id: string, pathArr: string[]): boolean {
    color.set(id, GRAY);
    pathArr.push(id);
    const aspect = idToAspect.get(id);
    for (const implied of aspect?.implies ?? []) {
      if (color.get(implied) === GRAY) {
        const cycle = pathArr.slice(pathArr.indexOf(implied)).concat(implied);
        issues.push({
          severity: 'error',
          code: 'E013',
          rule: 'aspect-implies-cycle',
          message: `Aspect implies cycle: ${cycle.join(' → ')}`,
        });
        pathArr.pop();
        color.set(id, BLACK);
        return true;
      }
      if (color.get(implied) === WHITE && dfs(implied, pathArr)) {
        pathArr.pop();
        color.set(id, BLACK);
        return true;
      }
    }
    pathArr.pop();
    color.set(id, BLACK);
    return false;
  }

  for (const id of idToAspect.keys()) {
    if (color.get(id) === WHITE) {
      dfs(id, []);
    }
  }
  return issues;
}

// E035 (checkRequiredAspectsCoverage) removed — replaced by E051 in checkArchitectureConstraints

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
            code: 'E008',
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

function isAncestorNode(possibleAncestor: string, possibleDescendant: string): boolean {
  return possibleDescendant.startsWith(possibleAncestor + '/');
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

      // Allow containment overlaps between ancestor-descendant nodes ("child wins" model).
      // Exact duplicates (same path) are always errors regardless of hierarchy.
      const isContainment = current.mappingPath !== candidate.mappingPath;
      const isHierarchical =
        isAncestorNode(current.nodePath, candidate.nodePath) ||
        isAncestorNode(candidate.nodePath, current.nodePath);

      if (isContainment && isHierarchical) continue;

      issues.push({
        severity: 'error',
        code: 'E007',
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

// --- Rule: Mapping paths should exist on disk (E036) ---

async function checkMappingPathsExist(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);
  const { access } = await import('node:fs/promises');

  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    for (const mp of mappingPaths) {
      const absPath = path.join(projectRoot, mp);
      try {
        await access(absPath);
      } catch {
        issues.push({
          severity: 'error',
          code: 'E036',
          rule: 'mapping-path-missing',
          message: `Mapping path '${mp}' does not exist on disk`,
          nodePath,
        });
      }
    }
  }
  return issues;
}

// --- Rule 6: Required artifacts per STANDARD_ARTIFACTS (E030) ---

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
    meta: { relations?: Array<{ target: string }>; aspects?: string[]; blackbox?: boolean };
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
  // has_outgoing_relations and has_aspect: conditions removed — standard artifacts don't use them
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
  const artifacts = STANDARD_ARTIFACTS;

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
          severity: 'error',
          code: 'E030',
          rule: 'missing-artifact',
          message: msg.trim(),
          nodePath,
        });
      }
    }
  }

  return issues;
}

// --- E005: Broken flow refs (flow.nodes) ---

function checkBrokenFlowRefs(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodePaths = new Set(graph.nodes.keys());
  for (const flow of graph.flows) {
    for (const n of flow.nodes) {
      if (!nodePaths.has(n)) {
        issues.push({
          severity: 'error',
          code: 'E005',
          rule: 'broken-flow-ref',
          message: `Flow '${flow.name}' references non-existent node '${n}'`,
        });
      }
    }
  }
  return issues;
}

// --- E006: Flow aspect ids must have corresponding aspect ---

function checkFlowAspectIds(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const validAspectIds = new Set(graph.aspects.map((a) => a.id));

  for (const flow of graph.flows) {
    for (const aspectId of flow.aspects ?? []) {
      if (!validAspectIds.has(aspectId)) {
        issues.push({
          severity: 'error',
          code: 'E006',
          rule: 'broken-aspect-ref',
          message: `Flow '${flow.name}' references aspect '${aspectId}' but no aspect with that id exists in aspects/`,
        });
      }
    }
  }
  return issues;
}

// invalid-artifact-condition removed — standard artifacts don't use has_aspect: conditions

// --- E031: Shallow artifacts (below min_artifact_length) ---

async function checkShallowArtifacts(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const minLen = graph.config.quality?.min_artifact_length ?? 50;
  for (const [nodePath, node] of graph.nodes) {
    for (const art of node.artifacts) {
      if (art.content.trim().length < minLen) {
        issues.push({
          severity: 'error',
          code: 'E031',
          rule: 'shallow-artifact',
          message: `Artifact '${art.filename}' is below minimum length (${art.content.trim().length} < ${minLen})`,
          nodePath,
        });
      }
    }
  }
  return issues;
}

// --- W003: Wide node (maps too many source files) ---

async function checkWideNodes(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const maxFiles = graph.config.quality?.max_mapping_source_files ?? 10;
  const projectRoot = path.dirname(graph.rootPath);

  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.blackbox) continue;
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    if (mappingPaths.length === 0) continue;

    const sourceFiles = await expandMappingToFiles(projectRoot, mappingPaths);
    if (sourceFiles.length <= maxFiles) continue;

    const filledArtifacts = node.artifacts.filter(
      (a) => a.content.trim().length >= (graph.config.quality?.min_artifact_length ?? 50),
    ).length;

    issues.push({
      severity: 'warning',
      code: 'W003',
      rule: 'wide-node',
      message: `Node maps ${sourceFiles.length} source files (max: ${maxFiles}) with ${filledArtifacts} artifact(s). Consider splitting into child nodes with focused responsibilities.`,
      nodePath,
    });
  }
  return issues;
}

// --- W004: High fan-out (exceeds max_direct_relations) ---

function checkHighFanOut(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const maxRel = graph.config.quality?.max_direct_relations ?? 10;
  for (const [nodePath, node] of graph.nodes) {
    const count = node.meta.relations?.length ?? 0;
    if (count > maxRel) {
      issues.push({
        severity: 'warning',
        code: 'W004',
        rule: 'high-fan-out',
        message: `Node has ${count} direct relations (max: ${maxRel})`,
        nodePath,
      });
    }
  }
  return issues;
}

// --- E033: Unpaired event relations (emits without listens or vice versa) ---

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
          severity: 'error',
          code: 'E033',
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
          severity: 'error',
          code: 'E033',
          rule: 'unpaired-event',
          message: `Node '${listener}' listens from '${source}' but '${source}' has no emits to '${listener}'`,
          nodePath: listener,
        });
      }
    }
  }
  return issues;
}

// --- Schema validation (required graph-layer schemas present in schemas/) ---

const REQUIRED_SCHEMAS = ['node', 'aspect', 'flow'] as const;

function checkSchemas(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const present = new Set(graph.schemas.map((s) => s.schemaType));

  for (const required of REQUIRED_SCHEMAS) {
    if (!present.has(required)) {
      issues.push({
        severity: 'error',
        code: 'E034',
        rule: 'missing-schema',
        message: `Schema 'yg-${required}.yaml' missing from .yggdrasil/schemas/`,
      });
    }
  }

  return issues;
}

// --- Directories have yg-node.yaml ---

async function checkDirectoriesHaveNodeYaml(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const modelDir = path.join(graph.rootPath, 'model');

  async function scanDir(dirPath: string, segments: string[]): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const hasNodeYaml = entries.some((e) => e.isFile() && e.name === 'yg-node.yaml');
    const dirName = path.basename(dirPath);

    if (RESERVED_DIRS.has(dirName)) return;

    const hasFiles = entries.some((e) => e.isFile());
    const graphPath = segments.join('/');

    if (!hasNodeYaml && graphPath !== '') {
      if (hasFiles) {
        issues.push({
          severity: 'error',
          code: 'E011',
          rule: 'missing-node-yaml',
          message: `Directory '${graphPath}' has files but no yg-node.yaml`,
          nodePath: graphPath,
        });
      }
      // W013 (directory-without-node) covered by E022
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

// --- Anchor validation (E039, E040, E041, E037) ---

export async function expandMappingToFiles(projectRoot: string, mappingPaths: string[]): Promise<string[]> {
  const files: string[] = [];

  async function collectFiles(absPath: string): Promise<void> {
    try {
      const s = await stat(absPath);
      if (s.isFile()) {
        files.push(absPath);
      } else if (s.isDirectory()) {
        const entries = await readdir(absPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const entryPath = path.join(absPath, entry.name);
          if (entry.isFile()) {
            files.push(entryPath);
          } else if (entry.isDirectory()) {
            await collectFiles(entryPath);
          }
        }
      }
    } catch {
      // Skip inaccessible paths
    }
  }

  for (const mp of mappingPaths) {
    await collectFiles(path.join(projectRoot, mp));
  }
  return files;
}

// E039: Every aspect must have anchors
function checkAspectAnchors(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const aspect of graph.aspects) {
    if (!aspect.anchors || aspect.anchors.length === 0) {
      issues.push({
        severity: 'error',
        code: 'E039',
        rule: 'aspect-missing-anchors',
        message: `Every aspect must define at least one anchor in yg-aspect.yaml.\nAdd an anchors list with abstract proof point IDs:\n  anchors:\n    - <proof-point-id>`,
        nodePath: `aspects/${aspect.id}`,
      });
    }
  }
  return issues;
}

// E040: Mapping group anchors must have required fields (regex + rationale)
function checkAnchorRealizations(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.blackbox) continue;

    // Check mapping group aspect anchors (E040)
    const mappingGroups = node.meta.mapping;
    if (mappingGroups) {
      for (const mappingGroup of mappingGroups) {
        if (mappingGroup?.aspects) {
          for (const aspectEntry of mappingGroup.aspects) {
            for (const [anchorId, anchor] of Object.entries(aspectEntry.anchors ?? {})) {
              // E040: Check that anchor has required fields
              if (!anchor.regex || anchor.regex.trim() === '') {
                issues.push({
                  severity: 'error',
                  code: 'E040',
                  rule: 'anchor-not-realized',
                  message: `Mapping group anchor '${anchorId}' in aspect '${aspectEntry.aspect}' is missing or empty 'regex' field.\nAdd regex pattern to the anchor in yg-node.yaml:\n  mapping:\n    - aspects:\n      - aspect: ${aspectEntry.aspect}\n        anchors:\n          ${anchorId}:\n            regex: "<pattern>"`,
                  nodePath,
                });
              }
              if (!anchor.rationale || anchor.rationale.trim() === '') {
                issues.push({
                  severity: 'error',
                  code: 'E040',
                  rule: 'anchor-not-realized',
                  message: `Mapping group anchor '${anchorId}' in aspect '${aspectEntry.aspect}' is missing or empty 'rationale' field.\nAdd rationale to the anchor in yg-node.yaml:\n  mapping:\n    - aspects:\n      - aspect: ${aspectEntry.aspect}\n        anchors:\n          ${anchorId}:\n            rationale: "<why this anchor matters>"`,
                  nodePath,
                });
              }
            }
          }
        }
      }
    }

    // Note: integration anchor checking has been removed from relation level.
    // Integration aspects are now just string IDs. Anchor realizations (if needed)
    // are in mapping groups, not in the relation object.
  }
  return issues;
}

// E037: Mapping group anchor regex patterns must be found in source files
async function checkAnchorPatterns(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);

  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.blackbox) continue;

    // Check mapping group aspect anchor patterns (E037)
    const mappingGroupsE037 = node.meta.mapping;
    if (mappingGroupsE037) {
      for (const mappingGroup of mappingGroupsE037) {
        if (mappingGroup?.aspects && mappingGroup.paths.length > 0) {
          // Read source files for this mapping group
          const sourceFiles = await expandMappingToFiles(projectRoot, mappingGroup.paths);
          if (sourceFiles.length === 0) continue;

          const fileContents: Array<{ path: string; content: string }> = [];
          for (const filePath of sourceFiles) {
            try {
              const content = await readFile(filePath, 'utf-8');
              fileContents.push({ path: filePath, content });
            } catch { /* skip unreadable */ }
          }

          for (const aspectEntry of mappingGroup.aspects) {
            for (const [anchorId, anchor] of Object.entries(aspectEntry.anchors ?? {})) {
              if (!anchor.regex) continue;

              try {
                const regex = new RegExp(anchor.regex);
                const found = fileContents.some(f => regex.test(f.content));
                if (!found) {
                  const mappedFiles = sourceFiles.map(f => path.relative(projectRoot, f));
                  issues.push({
                    severity: 'error',
                    code: 'E037',
                    rule: 'anchor-not-found',
                    message: `Mapping group anchor '${anchorId}' in aspect '${aspectEntry.aspect}' with pattern\n'${anchor.regex}' not found in mapped files:\n${mappedFiles.map(f => '  ' + f).join('\n')}\nImplement the anchor pattern or update the regex if the pattern has changed.`,
                    nodePath,
                  });
                }
              } catch {
                // Invalid regex — reported as E037 with pattern info
                issues.push({
                  severity: 'error',
                  code: 'E037',
                  rule: 'anchor-not-found',
                  message: `Mapping group anchor '${anchorId}' in aspect '${aspectEntry.aspect}' has invalid regex pattern '${anchor.regex}'.`,
                  nodePath,
                });
              }
            }
          }
        }
      }
    }

    // Note: integration anchor pattern checking on relations has been removed.
    // Integration anchors are now checked via mapping groups (in checkAnchorPatterns above).
  }
  return issues;
}

// --- Context budget (W001 warning, E032 exceeded, W002 own-budget) ---

async function checkContextBudget(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const budget = graph.config.quality?.context_budget ?? { warning: 10000, error: 20000 };
  const warningThreshold = budget.warning;
  const errorThreshold = budget.error;
  const ownWarningThreshold = budget.own_warning;

  for (const [nodePath] of graph.nodes) {
    const node = graph.nodes.get(nodePath)!;
    if (node.meta.blackbox) continue;
    try {
      const pkg = await buildContext(graph, nodePath);
      const breakdown = computeBudgetBreakdown(pkg, graph);
      const breakdownLine =
        `own: ${breakdown.own.toLocaleString()} (${pct(breakdown.own, breakdown.total)}) | ` +
        `hierarchy: ${breakdown.hierarchy.toLocaleString()} (${pct(breakdown.hierarchy, breakdown.total)}) | ` +
        `aspects: ${breakdown.aspects.toLocaleString()} (${pct(breakdown.aspects, breakdown.total)}) | ` +
        `flows: ${breakdown.flows.toLocaleString()} (${pct(breakdown.flows, breakdown.total)}) | ` +
        `dependencies: ${breakdown.dependencies.toLocaleString()} (${pct(breakdown.dependencies, breakdown.total)})`;

      if (breakdown.total >= errorThreshold) {
        issues.push({
          severity: 'error',
          code: 'E032',
          rule: 'budget-exceeded',
          message: `Context is ${breakdown.total.toLocaleString()} tokens (error threshold: ${errorThreshold.toLocaleString()}).\n     ${breakdownLine}`,
          nodePath,
        });
      } else if (breakdown.total >= warningThreshold) {
        issues.push({
          severity: 'warning',
          code: 'W001',
          rule: 'budget-warning',
          message: `Context is ${breakdown.total.toLocaleString()} tokens (warning threshold: ${warningThreshold.toLocaleString()}).\n     ${breakdownLine}`,
          nodePath,
        });
      }

      if (ownWarningThreshold !== undefined && breakdown.own >= ownWarningThreshold) {
        issues.push({
          severity: 'warning',
          code: 'W002',
          rule: 'own-budget-warning',
          message: `Own artifacts: ${breakdown.own.toLocaleString()} tokens (threshold: ${ownWarningThreshold.toLocaleString()}). Consider splitting this node's responsibilities into child nodes.`,
          nodePath,
        });
      }
    } catch {
      // buildContext may fail for structurally broken nodes — other rules catch those.
    }
  }
  return issues;
}

function pct(value: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((value / total) * 100)}%`;
}

// --- E038: Missing description on nodes, aspects, and flows ---

function checkMissingDescriptions(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Nodes
  for (const [nodePath, node] of graph.nodes) {
    if (!node.meta.description?.trim()) {
      issues.push({
        severity: 'error',
        code: 'E038',
        rule: 'missing-description',
        message: `Node has no description`,
        nodePath,
      });
    }
  }

  // Aspects
  for (const aspect of graph.aspects) {
    if (!aspect.description?.trim()) {
      issues.push({
        severity: 'error',
        code: 'E038',
        rule: 'missing-description',
        message: `Aspect '${aspect.id}' has no description`,
      });
    }
  }

  // Flows
  for (const flow of graph.flows) {
    if (!flow.description?.trim()) {
      issues.push({
        severity: 'error',
        code: 'E038',
        rule: 'missing-description',
        message: `Flow '${flow.name}' has no description`,
      });
    }
  }

  return issues;
}

// --- Architecture Constraints (E050-E054) ---

function checkArchitectureConstraints(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // E050-E054 require architecture to be defined and loaded
  // Only validate if architecture has node_types entries
  if (!graph.architecture || Object.keys(graph.architecture.node_types).length === 0) {
    return issues;
  }

  // E050, E053, E054: Per-mapping-group aspect checks (require full context: effective + integration)
  issues.push(...checkMappingGroupAspects(graph));

  // E051: invalid-relation-target (sync, no I/O)
  issues.push(...checkArchitectureRelations(graph));

  // E052: invalid-parent-type (sync, no I/O)
  issues.push(...checkArchitectureParents(graph));

  return issues;
}

/**
 * E050 — missing-required-aspect
 * E054 — unexpected-aspect
 * Per-mapping-group sync checks for aspect declarations.
 * Computes effective aspects (from architecture, parent, flow, own, implies chain)
 * and checks that every mapping group declares all required aspects.
 */
function checkMappingGroupAspects(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    // Skip blackbox and nodes without mapping groups
    if (node.meta.blackbox || !node.meta.mapping || node.meta.mapping.length === 0) {
      continue;
    }

    // Compute effective aspects from all sources
    const effective = computeEffectiveAspects({
      nodeType: node.meta.type,
      architecture: graph.architecture,
      parentTypes: node.parent ? [node.parent.meta.type] : [],
      ownAspects: node.meta.aspects ?? [],
      ownIntegrationAspects: node.meta.integration_aspects ?? [],
      flowAspects: getFlowAspects(node, graph),
      allAspects: graph.aspects,
      allFlows: graph.flows,
    });

    // Compute allowed set: effective aspects + integration aspects from all relation targets
    const allowedAspects = new Set(effective.regular);
    if (node.meta.relations && node.meta.relations.length > 0) {
      for (const rel of node.meta.relations) {
        const target = graph.nodes.get(rel.target);
        if (target) {
          // Get target's integration aspects
          const targetIntegration = computeEffectiveAspects({
            nodeType: target.meta.type,
            architecture: graph.architecture,
            parentTypes: target.parent ? [target.parent.meta.type] : [],
            ownAspects: [],
            ownIntegrationAspects: target.meta.integration_aspects ?? [],
            flowAspects: [],
            allAspects: graph.aspects,
            allFlows: graph.flows,
          });
          for (const ia of targetIntegration.integration) {
            allowedAspects.add(ia);
          }
        }
        // If target not found, E004 fires separately — don't restrict allowed set
      }
    }

    // Check each mapping group
    for (const group of node.meta.mapping) {
      const declaredAspects = new Set((group.aspects ?? []).map((a) => a.aspect));

      // E050: missing-required-aspect — for each aspect in effective set not declared
      for (const required of effective.regular) {
        if (!declaredAspects.has(required)) {
          const source = getAspectSource(required, node, graph);
          issues.push({
            severity: 'error',
            code: 'E050',
            rule: 'missing-required-aspect',
            nodePath,
            message:
              `Files: ${group.paths.join(', ')}\n` +
              `  Missing aspect: ${required}\n` +
              `  Required by: ${source}\n\n` +
              `  This mapping group does not prove '${required}'.\n` +
              `  To fix:\n` +
              `    1. Read .yggdrasil/aspects/${required}/description.md\n` +
              `    2. Find the pattern that proves these files implement '${required}'\n` +
              `    3. Add an anchor with regex + rationale to this mapping group\n` +
              `       in yg-node.yaml`,
          });
        }
      }

      // E054: unexpected-aspect — for each declared aspect not in allowed set
      for (const declared of declaredAspects) {
        if (!allowedAspects.has(declared)) {
          const effectiveList = [...effective.regular].sort().join(', ');
          const integrationList = [...allowedAspects]
            .filter((a) => !effective.regular.has(a))
            .sort()
            .join(', ');
          issues.push({
            severity: 'error',
            code: 'E054',
            rule: 'unexpected-aspect',
            nodePath,
            message:
              `Mapping group containing: ${group.paths.join(', ')}\n` +
              `  Aspect '${declared}' is declared but not in allowed aspects.\n\n` +
              `  Effective aspects:\n` +
              `    [${effectiveList || 'none'}]\n` +
              (integrationList
                ? `  Integration aspects (from relations):\n` +
                  `    [${integrationList}]\n`
                : '') +
              `\n  Either:\n` +
              `    1. Add '${declared}' to this node's aspects list in yg-node.yaml\n` +
              `    2. Remove '${declared}' from this mapping group`,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * E053 — integration-aspect-missing
 * When a node A has a relation to node B, and B declares integration_aspects,
 * then A's mapping groups must declare those integration aspects.
 */
async function checkIntegrationAspects(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  // E053 requires architecture to be defined and loaded
  if (!graph.architecture || Object.keys(graph.architecture.node_types).length === 0) {
    return issues;
  }

  for (const [nodePath, node] of graph.nodes) {
    // Skip blackbox and nodes without mapping groups or relations
    if (node.meta.blackbox || !node.meta.mapping || node.meta.mapping.length === 0) {
      continue;
    }
    if (!node.meta.relations || node.meta.relations.length === 0) {
      continue;
    }

    for (const rel of node.meta.relations) {
      const target = graph.nodes.get(rel.target);
      if (!target) continue; // E004 catches missing targets

      // Get target's integration aspects (from architecture, own, or inherited)
      const requiredIntegration = computeEffectiveIntegrationAspects(target, graph);
      if (requiredIntegration.size === 0) continue;

      for (const group of node.meta.mapping) {
        const declaredAspects = new Set((group.aspects ?? []).map((a) => a.aspect));

        for (const required of requiredIntegration) {
          if (!declaredAspects.has(required)) {
            const intSource = getIntegrationAspectSource(required, target, graph);
            issues.push({
              severity: 'error',
              code: 'E053',
              rule: 'integration-aspect-missing',
              nodePath,
              message:
                `Files: ${group.paths.join(', ')}\n` +
                `  Missing aspect: ${required}\n` +
                `  Required by: relation to '${rel.target}' — integration_aspects\n` +
                `    from ${intSource}\n\n` +
                `  When consuming '${rel.target}', your files must prove '${required}'.\n` +
                `  To fix:\n` +
                `    1. Read .yggdrasil/aspects/${required}/description.md\n` +
                `    2. Add an anchor for '${required}' to this mapping group\n` +
                `       in yg-node.yaml`,
            });
          }
        }
      }
    }
  }

  return issues;
}

/**
 * E051 — invalid-relation-target
 * Relation target type must be in architecture's allowed list for the relation type.
 */
function checkArchitectureRelations(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const typeConfig = graph.architecture.node_types[node.meta.type];
    if (!typeConfig?.relations || !node.meta.relations || node.meta.relations.length === 0) {
      continue;
    }

    for (const rel of node.meta.relations) {
      const allowedTypes = typeConfig.relations[rel.type];
      if (!allowedTypes) continue; // Unconstrained relation type

      const target = graph.nodes.get(rel.target);
      if (!target) continue; // E004 catches missing target

      if (!allowedTypes.includes(target.meta.type)) {
        issues.push({
          severity: 'error',
          code: 'E051',
          rule: 'invalid-relation-target',
          nodePath,
          message:
            `Relation: ${rel.type} -> ${rel.target} (type: ${target.meta.type})\n` +
            `  Architecture does not allow type '${node.meta.type}' to '${rel.type}' type '${target.meta.type}'.\n` +
            `  Allowed targets for '${rel.type}': [${allowedTypes.join(', ')}]\n\n` +
            `  Either:\n` +
            `    1. Change the relation type\n` +
            `    2. Change the target node's type\n` +
            `    3. Update yg-architecture.yaml to allow this relation`,
        });
      }
    }
  }

  return issues;
}

/**
 * E052 — invalid-parent-type
 * Parent type must be in architecture's allowed list for this node type.
 */
function checkArchitectureParents(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const typeConfig = graph.architecture.node_types[node.meta.type];
    if (!typeConfig?.parents || !node.parent) {
      continue;
    }

    if (!typeConfig.parents.includes(node.parent.meta.type)) {
      issues.push({
        severity: 'error',
        code: 'E052',
        rule: 'invalid-parent-type',
        nodePath,
        message:
          `Parent: ${node.parent.path} (type: ${node.parent.meta.type})\n` +
          `  Architecture does not allow type '${node.meta.type}' under parent type '${node.parent.meta.type}'.\n` +
          `  Allowed parents: [${typeConfig.parents.join(', ')}]\n\n` +
          `  Either:\n` +
          `    1. Move this node under an allowed parent type\n` +
          `    2. Change this node's type\n` +
          `    3. Update yg-architecture.yaml to allow this parent`,
      });
    }
  }

  return issues;
}

/**
 * Helper: Get all aspect IDs that this node participates in via flows.
 */
function getFlowAspects(node: GraphNode, graph: Graph): string[] {
  const aspects: string[] = [];
  for (const flow of graph.flows) {
    if (flow.nodes && flow.nodes.includes(node.path)) {
      for (const aspect of flow.aspects ?? []) {
        if (!aspects.includes(aspect)) {
          aspects.push(aspect);
        }
      }
    }
  }
  return aspects;
}

/**
 * Helper: Determine the source of a required aspect (architecture, flow, parent, or own).
 */
function getAspectSource(aspectId: string, node: GraphNode, graph: Graph): string {
  const typeConfig = graph.architecture.node_types[node.meta.type];

  // Check if from architecture type requirement
  if (typeConfig?.aspects?.includes(aspectId)) {
    return `architecture (type '${node.meta.type}' requires [${typeConfig.aspects.join(', ')}])`;
  }

  // Check if from flow participation
  for (const flow of graph.flows) {
    if (flow.nodes?.includes(node.path) && flow.aspects?.includes(aspectId)) {
      return `flow '${flow.path}' (participants must prove [${flow.aspects.join(', ')}])`;
    }
  }

  // Check if from parent inheritance
  if (node.parent) {
    const parentEffective = computeEffectiveAspects({
      nodeType: node.parent.meta.type,
      architecture: graph.architecture,
      parentTypes: node.parent.parent ? [node.parent.parent.meta.type] : [],
      ownAspects: node.parent.meta.aspects ?? [],
      ownIntegrationAspects: [],
      flowAspects: getFlowAspects(node.parent, graph),
      allAspects: graph.aspects,
      allFlows: graph.flows,
    });
    if (parentEffective.regular.has(aspectId)) {
      return `parent inheritance (${node.parent.path} effective aspects)`;
    }
  }

  // Check if from own declaration
  if (node.meta.aspects?.includes(aspectId)) {
    return `own declaration in yg-node.yaml`;
  }

  return `(source unknown — aspect not found in any effective set)`;
}
