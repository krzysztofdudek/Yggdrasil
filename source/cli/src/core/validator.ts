import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { STANDARD_ARTIFACTS } from '../model/types.js';
import type { Graph, ValidationResult, ValidationIssue, ArtifactConfig, NodeAspectEntry } from '../model/types.js';
import { buildContext, computeBudgetBreakdown, resolveAspects } from './context-builder.js';
import { normalizeMappingPaths } from '../utils/paths.js';

/** Extract flat aspect id list from unified aspect entries */
function getAspectIds(aspects: NodeAspectEntry[] | undefined): string[] {
  return (aspects ?? []).map(a => a.aspect);
}

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
    issues.push(...checkRequiredAspectsCoverage(graph));
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
  const issues: ValidationIssue[] = [];
  const allowedTypes = new Set(Object.keys(graph.config.node_types ?? {}));
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
    for (const aspectId of getAspectIds(node.meta.aspects)) {
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

// --- Rule: Required aspects coverage per node type ---

function checkRequiredAspectsCoverage(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const typeConfig = new Map(
    Object.entries(graph.config.node_types ?? {}).map(([name, cfg]) => [name, cfg.required_aspects ?? []]),
  );
  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.blackbox) continue;
    const requiredAspects = typeConfig.get(node.meta.type);
    if (!requiredAspects || requiredAspects.length === 0) continue;

    const nodeAspectIds = getAspectIds(node.meta.aspects);
    let effectiveAspects;
    try {
      effectiveAspects = resolveAspects(nodeAspectIds, graph.aspects);
    } catch {
      continue;
    }
    const effectiveAspectIds = new Set(effectiveAspects.map((a) => a.id));

    for (const required of requiredAspects) {
      if (!effectiveAspectIds.has(required)) {
        issues.push({
          severity: 'error',
          code: 'E035',
          rule: 'missing-required-aspect',
          message: `Node '${nodePath}' (type: ${node.meta.type}) missing required aspect coverage for '${required}'`,
          nodePath,
        });
      }
    }
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
    meta: { relations?: Array<{ target: string }>; aspects?: NodeAspectEntry[]; blackbox?: boolean };
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

/** Structural relation types — used by anchor validation */
const STRUCTURAL_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);

// E040 + E041: Nodes must realize all anchor IDs with valid typed objects
function checkAnchorRealizations(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const aspectMap = new Map(graph.aspects.map(a => [a.id, a]));

  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.blackbox) continue;

    // Check aspect anchor realizations
    for (const entry of node.meta.aspects ?? []) {
      const aspect = aspectMap.get(entry.aspect);
      if (!aspect?.anchors || aspect.anchors.length === 0) continue;

      for (const anchorId of aspect.anchors) {
        const realization = entry.anchors?.[anchorId];
        if (!realization) {
          issues.push({
            severity: 'error',
            code: 'E040',
            rule: 'anchor-not-realized',
            message: `Aspect '${entry.aspect}' requires anchor '${anchorId}' but node has no realization for it.\nAdd an anchors map to the aspect entry in yg-node.yaml:\n  aspects:\n    - aspect: ${entry.aspect}\n      anchors:\n        ${anchorId}:\n          regex: "<pattern>"`,
            nodePath,
          });
          continue;
        }
        // E041: check realization type — must be exactly one known type property
        const typeKeys = Object.keys(realization).filter(k => k !== '__proto__');
        if (typeKeys.length !== 1 || typeKeys[0] !== 'regex') {
          const unknownTypes = typeKeys.filter(k => k !== 'regex');
          const unknownType = unknownTypes[0] ?? (typeKeys.length === 0 ? 'empty' : typeKeys.join('+'));
          issues.push({
            severity: 'error',
            code: 'E041',
            rule: 'unknown-anchor-type',
            message: `Anchor '${anchorId}' uses type '${unknownType}' which is not supported.\nSupported types: regex.\nUpgrade CLI or change to a supported type.`,
            nodePath,
          });
        }
      }
    }

    // Check integration anchor realizations on relations
    for (const rel of node.meta.relations ?? []) {
      if (!STRUCTURAL_TYPES.has(rel.type)) continue;
      const target = graph.nodes.get(rel.target);
      if (!target?.meta.integration_aspects) continue;

      for (const anchorId of target.meta.integration_aspects) {
        const realization = rel.anchors?.[anchorId];
        if (!realization) {
          issues.push({
            severity: 'error',
            code: 'E040',
            rule: 'integration-anchor-not-realized',
            message: `Dependency '${rel.target}' requires anchor '${anchorId}' but relation has no realization for it.\nAdd an anchors map to the relation entry in yg-node.yaml:\n  relations:\n    - target: ${rel.target}\n      anchors:\n        ${anchorId}:\n          regex: "<pattern>"`,
            nodePath,
          });
          continue;
        }
        const typeKeys = Object.keys(realization).filter(k => k !== '__proto__');
        if (typeKeys.length !== 1 || typeKeys[0] !== 'regex') {
          const unknownTypes = typeKeys.filter(k => k !== 'regex');
          const unknownType = unknownTypes[0] ?? (typeKeys.length === 0 ? 'empty' : typeKeys.join('+'));
          issues.push({
            severity: 'error',
            code: 'E041',
            rule: 'unknown-anchor-type',
            message: `Anchor '${anchorId}' uses type '${unknownType}' which is not supported.\nSupported types: regex.\nUpgrade CLI or change to a supported type.`,
            nodePath,
          });
        }
      }
    }
  }
  return issues;
}

// E037: Realized regex patterns must be found in source files
async function checkAnchorPatterns(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);
  const aspectMap = new Map(graph.aspects.map(a => [a.id, a]));

  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.blackbox) continue;
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    if (mappingPaths.length === 0) continue;

    const sourceFiles = await expandMappingToFiles(projectRoot, mappingPaths);
    if (sourceFiles.length === 0) continue;

    // Read all source file contents once
    const fileContents: Array<{ path: string; content: string }> = [];
    for (const filePath of sourceFiles) {
      try {
        const content = await readFile(filePath, 'utf-8');
        fileContents.push({ path: filePath, content });
      } catch { /* skip unreadable */ }
    }

    // Check aspect anchor patterns
    for (const entry of node.meta.aspects ?? []) {
      const aspect = aspectMap.get(entry.aspect);
      if (!aspect?.anchors || !entry.anchors) continue;

      for (const anchorId of aspect.anchors) {
        const realization = entry.anchors[anchorId];
        if (!realization?.regex) continue;

        try {
          const regex = new RegExp(realization.regex);
          const found = fileContents.some(f => regex.test(f.content));
          if (!found) {
            const mappedFiles = sourceFiles.map(f => path.relative(projectRoot, f));
            issues.push({
              severity: 'error',
              code: 'E037',
              rule: 'anchor-not-found',
              message: `Aspect '${entry.aspect}' expects anchor '${anchorId}' with pattern\n'${realization.regex}' in source.\nPattern not found in mapped files:\n${mappedFiles.map(f => '  ' + f).join('\n')}\nImplement the aspect pattern, or update the anchor realization\nin yg-node.yaml if the pattern has changed.`,
              nodePath,
            });
          }
        } catch {
          // Invalid regex — reported as E037 with pattern info
          issues.push({
            severity: 'error',
            code: 'E037',
            rule: 'anchor-not-found',
            message: `Aspect '${entry.aspect}' anchor '${anchorId}' has invalid regex pattern '${realization.regex}'.`,
            nodePath,
          });
        }
      }
    }

    // Check integration anchor patterns on relations
    for (const rel of node.meta.relations ?? []) {
      if (!STRUCTURAL_TYPES.has(rel.type)) continue;
      if (!rel.anchors) continue;
      const target = graph.nodes.get(rel.target);
      if (!target?.meta.integration_aspects) continue;

      for (const anchorId of target.meta.integration_aspects) {
        const realization = rel.anchors[anchorId];
        if (!realization?.regex) continue;

        try {
          const regex = new RegExp(realization.regex);
          const found = fileContents.some(f => regex.test(f.content));
          if (!found) {
            const mappedFiles = sourceFiles.map(f => path.relative(projectRoot, f));
            issues.push({
              severity: 'error',
              code: 'E037',
              rule: 'integration-anchor-not-found',
              message: `Dependency '${rel.target}' expects anchor '${anchorId}' with pattern\n'${realization.regex}' in source.\nPattern not found in mapped files:\n${mappedFiles.map(f => '  ' + f).join('\n')}\nImplement the integration requirement, or update the anchor realization\nin the relation entry in yg-node.yaml.`,
              nodePath,
            });
          }
        } catch {
          issues.push({
            severity: 'error',
            code: 'E037',
            rule: 'integration-anchor-not-found',
            message: `Dependency '${rel.target}' anchor '${anchorId}' has invalid regex pattern '${realization.regex}'.`,
            nodePath,
          });
        }
      }
    }
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
