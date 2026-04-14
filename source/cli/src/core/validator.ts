import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Graph } from '../model/graph.js';
import type { ValidationResult, ValidationIssue } from '../model/validation.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { computeEffectiveAspects } from './effective-aspects.js';

export async function validate(graph: Graph, scope: string = 'all'): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];

  if (graph.configError) {
    issues.push({
      severity: 'error',
      code: 'config-invalid',
      rule: 'invalid-config',
      message: buildIssueMessage({
        what: 'yg-config.yaml failed to parse.',
        why: graph.configError,
        next: 'Fix the syntax error in .yggdrasil/yg-config.yaml.',
      }),
    });
  }

  for (const { nodePath, message } of graph.nodeParseErrors ?? []) {
    issues.push({
      severity: 'error',
      code: 'yaml-invalid',
      rule: 'invalid-node-yaml',
      message: buildIssueMessage({
        what: `yg-node.yaml parse error in ${nodePath}.`,
        why: message,
        next: `Fix the YAML in .yggdrasil/model/${nodePath}/yg-node.yaml.`,
      }),
      nodePath,
    });
  }

  if (!graph.configError) {
    // Node type validation uses architecture file (yg-architecture.yaml), not config
    issues.push(...checkDanglingAspectRefs(graph));
    issues.push(...checkAspectIds(graph));
    issues.push(...checkAspectIdUniqueness(graph));
    issues.push(...checkImpliedAspectsExist(graph));
    issues.push(...checkImpliesNoCycles(graph));
    issues.push(...checkHighFanOut(graph));
    issues.push(...checkMissingDescriptions(graph));
  }

  issues.push(...checkSchemas(graph));
  issues.push(...checkRelationTargets(graph));
  issues.push(...checkNoCycles(graph));
  issues.push(...checkMappingOverlap(graph));
  issues.push(...(await checkMappingPathsExist(graph)));
  issues.push(...checkBrokenFlowRefs(graph));
  issues.push(...(await checkDirectoriesHaveNodeYaml(graph)));
  issues.push(...(await checkWideNodes(graph)));
  issues.push(...checkUnpairedEvents(graph));
  issues.push(...checkArchitectureConstraints(graph));
  issues.push(...checkPortAspectsDefined(graph));
  issues.push(...checkPortConsumes(graph));
  issues.push(...checkOrphanedAspects(graph));

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
            code: 'yaml-invalid',
            rule: 'invalid-node-yaml',
            message: parseError.message,
            nodePath: parseError.nodePath,
          }],
          nodesScanned: 0,
        };
      }
      return {
        issues: [{ severity: 'error', rule: 'invalid-scope', message: buildIssueMessage({ what: `Node not found: ${scope}`, why: 'Validation scope references a node that does not exist in the graph.', next: 'Check the node path and try again.' }) }],
        nodesScanned: 0,
      };
    }
    const scopePrefix = scope + '/';
    filtered = issues.filter((i) => !i.nodePath || i.nodePath === scope || i.nodePath.startsWith(scopePrefix));
    nodesScanned = [...graph.nodes.keys()].filter((p) => p === scope || p.startsWith(scopePrefix)).length;
  }

  return { issues: filtered, nodesScanned };
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
          code: 'relation-broken',
          rule: 'broken-relation',
          message: buildIssueMessage({
            what: `Relation target '${rel.target}' does not exist.`,
            why: `This node declares a dependency that cannot be resolved.${existingLine}`,
            next: `Fix the target path in yg-node.yaml relations.${hint}`,
          }),
          nodePath,
        });
      }
    }
  }
  return issues;
}

// --- Rule 2: All aspect references must point to defined aspects (aspect-undefined) ---

function checkDanglingAspectRefs(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedAspects = new Set(graph.aspects.map((a) => a.id));

  // Check node aspects
  for (const [nodePath, node] of graph.nodes) {
    for (const aspectId of node.meta.aspects ?? []) {
      if (!definedAspects.has(aspectId)) {
        issues.push({
          severity: 'error',
          code: 'aspect-undefined',
          rule: 'dangling-aspect-ref',
          nodePath,
          message: buildIssueMessage({
            what: `Aspect '${aspectId}' is referenced by this node but not defined in aspects/.`,
            why: `Node declares an aspect that does not exist — aspect requirements cannot be verified.`,
            next: `Create aspects/${aspectId}/ with yg-aspect.yaml and content.md.`,
          }),
        });
      }
    }
    // Check port aspects
    if (node.meta.ports) {
      for (const [portName, port] of Object.entries(node.meta.ports)) {
        for (const aspectId of port.aspects) {
          if (!definedAspects.has(aspectId)) {
            issues.push({
              severity: 'error',
              code: 'aspect-undefined',
              rule: 'dangling-aspect-ref',
              nodePath,
              message: buildIssueMessage({
                what: `Aspect '${aspectId}' is referenced by port '${portName}' but not defined in aspects/.`,
                why: `Port declares a required aspect that does not exist — port contracts cannot be enforced.`,
                next: `Create aspects/${aspectId}/ with yg-aspect.yaml and content.md.`,
              }),
            });
          }
        }
      }
    }
  }

  // Check architecture aspects
  for (const [typeId, typeDef] of Object.entries(graph.architecture?.node_types ?? {})) {
    for (const aspectId of typeDef.aspects ?? []) {
      if (!definedAspects.has(aspectId)) {
        issues.push({
          severity: 'error',
          code: 'aspect-undefined',
          rule: 'dangling-aspect-ref',
          message: buildIssueMessage({
            what: `Aspect '${aspectId}' is referenced by architecture type '${typeId}' but not defined in aspects/.`,
            why: `Architecture declares a required aspect that does not exist.`,
            next: `Create aspects/${aspectId}/ with yg-aspect.yaml and content.md.`,
          }),
        });
      }
    }
  }

  // Check flow aspects
  for (const flow of graph.flows) {
    for (const aspectId of flow.aspects ?? []) {
      if (!definedAspects.has(aspectId)) {
        issues.push({
          severity: 'error',
          code: 'aspect-undefined',
          rule: 'dangling-aspect-ref',
          message: buildIssueMessage({
            what: `Aspect '${aspectId}' is referenced by flow '${flow.name}' but not defined in aspects/.`,
            why: `Flow declares an aspect that does not exist — flow requirements cannot propagate.`,
            next: `Create aspects/${aspectId}/ with yg-aspect.yaml and content.md.`,
          }),
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
      code: 'duplicate-aspect-id',
      rule: 'duplicate-aspect-binding',
      message: buildIssueMessage({
        what: `Aspect '${id}' is bound to multiple aspects (${names.join(', ')}).`,
        why: `Aspect ids must be unique — duplicate ids cause ambiguous aspect resolution.`,
        next: `Rename one of the aspect directories to make ids unique.`,
      }),
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
          code: 'implied-aspect-missing',
          rule: 'implied-aspect-missing',
          message: buildIssueMessage({
            what: `Aspect '${aspect.name}' implies '${impliedId}' but no aspect with that id exists in aspects/.`,
            why: `Implies chain is broken — implied aspect requirements cannot be resolved.`,
            next: `Create the implied aspect or remove it from the implies list.`,
          }),
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
          code: 'aspect-implies-cycle',
          rule: 'aspect-implies-cycle',
          message: buildIssueMessage({
            what: `Aspect implies cycle: ${cycle.join(' → ')}.`,
            why: `Cycles in implies prevent aspect resolution.`,
            next: `Break the cycle by removing one implies edge.`,
          }),
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

// --- Rule 4: No circular dependencies ---

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
        issues.push({
          severity: 'error',
          code: 'structural-cycle',
          rule: 'structural-cycle',
          message: buildIssueMessage({
            what: `Circular dependency: ${cyclePath.join(' -> ')}.`,
            why: `Cycles prevent deterministic context assembly and cascade tracking.`,
            next: `Break the cycle: extract a shared interface, invert a dependency, or merge nodes.`,
          }),
        });
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
  return mappingPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
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
        code: 'overlapping-mapping',
        rule: 'overlapping-mapping',
        message: buildIssueMessage({
          what: `Mapping paths '${current.mappingPath}' (${current.nodePath}) and '${candidate.mappingPath}' (${candidate.nodePath}) overlap.`,
          why: `Each source file must have exactly one owner node.`,
          next: `Keep one owner mapping and model other concerns via relations.`,
        }),
        nodePath: candidate.nodePath,
      });
    }
  }

  return issues;
}

// --- Rule: Mapping paths should exist on disk (mapping-path-missing) ---

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
          code: 'mapping-path-missing',
          rule: 'mapping-path-missing',
          message: buildIssueMessage({
            what: `Mapping path '${mp}' does not exist on disk.`,
            why: `Node maps a file that was deleted or moved.`,
            next: `Update mapping in yg-node.yaml: fix the path or remove the entry.`,
          }),
          nodePath,
        });
      }
    }
  }
  return issues;
}


// --- flow-node-broken: Broken flow refs (flow.nodes) ---

function checkBrokenFlowRefs(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodePaths = new Set(graph.nodes.keys());
  for (const flow of graph.flows) {
    for (const n of flow.nodes) {
      if (!nodePaths.has(n)) {
        issues.push({
          severity: 'error',
          code: 'flow-node-broken',
          rule: 'broken-flow-ref',
          message: buildIssueMessage({
            what: `Flow '${flow.name}' references non-existent node '${n}'.`,
            why: `Flow participants must exist in the graph.`,
            next: `Fix the nodes list in yg-flow.yaml or create the missing node.`,
          }),
        });
      }
    }
  }
  return issues;
}

// --- wide-node: Maps too many source files ---

async function checkWideNodes(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const maxFiles = graph.config.quality?.max_mapping_source_files ?? 10;
  const projectRoot = path.dirname(graph.rootPath);

  for (const [nodePath, node] of graph.nodes) {
    const effectiveAspects = computeEffectiveAspects(node, graph);
    if (effectiveAspects.size === 0) continue;
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    if (mappingPaths.length === 0) continue;

    const sourceFiles = await expandMappingToFiles(projectRoot, mappingPaths);
    if (sourceFiles.length <= maxFiles) continue;

    issues.push({
      severity: 'warning',
      code: 'wide-node',
      rule: 'wide-node',
      message: buildIssueMessage({
        what: `Node maps ${sourceFiles.length} source files (max: ${maxFiles}).`,
        why: `Wide nodes degrade reviewer accuracy — the reviewer verifies aspects against all source files at once. Too many files dilute focus and cause false rejections.`,
        next: `Split into child nodes with 2-5 source files each. Each child should map only the files relevant to its aspects.`,
      }),
      nodePath,
    });
  }
  return issues;
}

// --- high-fan-out: Exceeds max_direct_relations ---

function checkHighFanOut(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const maxRel = graph.config.quality?.max_direct_relations ?? 10;
  for (const [nodePath, node] of graph.nodes) {
    const count = node.meta.relations?.length ?? 0;
    if (count > maxRel) {
      issues.push({
        severity: 'warning',
        code: 'high-fan-out',
        rule: 'high-fan-out',
        message: buildIssueMessage({
          what: `Node has ${count} direct relations (max: ${maxRel}).`,
          why: `High fan-out makes context packages large and suggests unclear separation of concerns.`,
          next: `Consider splitting responsibilities or introducing an intermediary node.`,
        }),
        nodePath,
      });
    }
  }
  return issues;
}

// --- unpaired-event: Unpaired event relations (emits without listens or vice versa) ---

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
          code: 'event-unpaired',
          rule: 'unpaired-event',
          message: buildIssueMessage({
            what: `Node '${emitter}' emits to '${target}' but '${target}' has no listens from '${emitter}'.`,
            why: `Events need paired emits/listens for flow tracking.`,
            next: `Add the complementary event relation.`,
          }),
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
          code: 'event-unpaired',
          rule: 'unpaired-event',
          message: buildIssueMessage({
            what: `Node '${listener}' listens from '${source}' but '${source}' has no emits to '${listener}'.`,
            why: `Events need paired emits/listens for flow tracking.`,
            next: `Add the complementary event relation.`,
          }),
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
        code: 'schema-missing',
        rule: 'missing-schema',
        message: buildIssueMessage({
          what: `Schema 'yg-${required}.yaml' missing from .yggdrasil/schemas/.`,
          why: `Schemas validate graph elements — missing schemas allow invalid ${required} definitions.`,
          next: `Run yg init to restore missing schemas.`,
        }),
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
    const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    const hasNodeYaml = entries.some((e) => e.isFile() && e.name === 'yg-node.yaml');

    const hasFiles = entries.some((e) => e.isFile());
    const graphPath = segments.join('/');

    if (!hasNodeYaml && graphPath !== '') {
      if (hasFiles) {
        issues.push({
          severity: 'error',
          code: 'node-yaml-missing',
          rule: 'missing-node-yaml',
          message: buildIssueMessage({
            what: `Directory '${graphPath}' has files but no yg-node.yaml.`,
            why: `Every directory in model/ must have a node definition.`,
            next: `Create yg-node.yaml in ${graphPath}/ or move files to an existing node directory.`,
          }),
          nodePath: graphPath,
        });
      }
      // directory-without-node covered by unmapped-files check
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      await scanDir(path.join(dirPath, entry.name), [...segments, entry.name]);
    }
  }

  try {
    const rootEntries = (await readdir(modelDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
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

// --- Mapping expansion utility ---

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

// --- missing-description: Missing description on nodes, aspects, and flows ---

function checkMissingDescriptions(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Nodes
  for (const [nodePath, node] of graph.nodes) {
    if (!node.meta.description?.trim()) {
      issues.push({
        severity: 'error',
        code: 'description-missing',
        rule: 'missing-description',
        message: buildIssueMessage({
          what: `Node has no description.`,
          why: `Description is used in context output — agents need it for orientation.`,
          next: `Add a description field to yg-node.yaml.`,
        }),
        nodePath,
      });
    }
  }

  // Aspects
  for (const aspect of graph.aspects) {
    if (!aspect.description?.trim()) {
      issues.push({
        severity: 'error',
        code: 'description-missing',
        rule: 'missing-description',
        message: buildIssueMessage({
          what: `Aspect '${aspect.id}' has no description.`,
          why: `Description is used in context output — agents need it for orientation.`,
          next: `Add a description field to yg-aspect.yaml.`,
        }),
      });
    }
  }

  // Flows
  for (const flow of graph.flows) {
    if (!flow.description?.trim()) {
      issues.push({
        severity: 'error',
        code: 'description-missing',
        rule: 'missing-description',
        message: buildIssueMessage({
          what: `Flow '${flow.name}' has no description.`,
          why: `Description is used in context output — agents need it for orientation.`,
          next: `Add a description field to yg-flow.yaml.`,
        }),
      });
    }
  }

  return issues;
}

// --- Architecture Constraints (invalid-relation-target, invalid-parent-type) ---
// Note: aspect-undefined (dangling-aspect-ref) is generated by checkDanglingAspectRefs above (line ~184).

function checkArchitectureConstraints(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // invalid-relation-target and invalid-parent-type require architecture to be defined and loaded
  // Only validate if architecture has node_types entries
  if (!graph.architecture || Object.keys(graph.architecture.node_types).length === 0) {
    return issues;
  }

  // type-undefined: node uses a type not defined in architecture
  issues.push(...checkNodeTypesExist(graph));

  // invalid-relation-target (sync, no I/O)
  issues.push(...checkArchitectureRelations(graph));

  // invalid-parent-type (sync, no I/O)
  issues.push(...checkArchitectureParents(graph));

  return issues;
}

function checkNodeTypesExist(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allowedTypes = new Set(Object.keys(graph.architecture!.node_types));

  for (const [nodePath, node] of graph.nodes) {
    if (!allowedTypes.has(node.meta.type)) {
      issues.push({
        severity: 'error',
        code: 'type-undefined',
        rule: 'unknown-node-type',
        message: buildIssueMessage({
          what: `Node type '${node.meta.type}' is not defined in yg-architecture.yaml.`,
          why: `Allowed types: ${[...allowedTypes].join(', ')}.`,
          next: `Add '${node.meta.type}' to yg-architecture.yaml or change the node type.`,
        }),
        nodePath,
      });
    }
  }
  return issues;
}

/**
 * integration-aspect-missing
 * When a node consumes a port, that port's required aspects must be defined in aspects/.
 */
function checkPortAspectsDefined(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definedAspects = new Set(graph.aspects.map((a) => a.id));

  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      const target = graph.nodes.get(rel.target);
      if (!target?.meta.ports) continue;

      for (const portName of rel.consumes ?? []) {
        const port = target.meta.ports[portName];
        if (!port) continue; // unknown-port catches this
        for (const aspectId of port.aspects) {
          if (!definedAspects.has(aspectId)) {
            issues.push({
              severity: 'error',
              code: 'port-missing-aspect',
              rule: 'integration-aspect-missing',
              nodePath,
              message: buildIssueMessage({
                what: `Relation: ${rel.type} -> ${rel.target}, port '${portName}'`,
                why: `Port requires aspect '${aspectId}' but it is not defined in aspects/ — port contracts are broken.`,
                next: `Create aspects/${aspectId}/ with yg-aspect.yaml and content.md.`,
              }),
            });
          }
        }
      }
    }
  }

  return issues;
}

/**
 * invalid-relation-target
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
      if (!target) continue; // relation-target-missing catches this

      if (!allowedTypes.includes(target.meta.type)) {
        issues.push({
          severity: 'error',
          code: 'relation-target-forbidden',
          rule: 'invalid-relation-target',
          nodePath,
          message: buildIssueMessage({
            what: `Relation: ${rel.type} -> ${rel.target} (type: ${target.meta.type})`,
            why: `Architecture does not allow type '${node.meta.type}' to '${rel.type}' type '${target.meta.type}'. Allowed targets for '${rel.type}': [${allowedTypes.join(', ')}]`,
            next: `Either change the relation type, change the target node's type, or update yg-architecture.yaml to allow this relation.`,
          }),
        });
      }
    }
  }

  return issues;
}

/**
 * invalid-parent-type
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
        code: 'parent-type-forbidden',
        rule: 'invalid-parent-type',
        nodePath,
        message: buildIssueMessage({
          what: `Parent: ${node.parent.path} (type: ${node.parent.meta.type})`,
          why: `Architecture does not allow type '${node.meta.type}' under parent type '${node.parent.meta.type}'. Allowed parents: [${typeConfig.parents.join(', ')}]`,
          next: `Either move this node under an allowed parent type, change this node's type, or update yg-architecture.yaml to allow this parent.`,
        }),
      });
    }
  }

  return issues;
}

/**
 * missing-consumes
 * When a relation target has non-empty ports, the consumer must declare which port(s) it consumes.
 *
 * unknown-port
 * When a consumer's consumes list references a port name that does not exist on the target.
 */
function checkPortConsumes(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      // Skip event relations — they don't consume ports
      if (rel.type === 'emits' || rel.type === 'listens') continue;

      const target = graph.nodes.get(rel.target);
      const hasPorts = target?.meta.ports && Object.keys(target.meta.ports).length > 0;

      // consumes-without-ports: consumes on a relation to a target without ports
      if (!hasPorts && rel.consumes && rel.consumes.length > 0) {
        issues.push({
          severity: 'error',
          code: 'consumes-without-ports',
          rule: 'consumes-without-ports',
          nodePath,
          message: buildIssueMessage({
            what: `Relation: ${rel.type} -> ${rel.target} declares consumes: [${rel.consumes.join(', ')}]`,
            why: `Target has no ports. consumes is only meaningful when the target declares ports with required aspects.`,
            next: `Remove consumes from this relation in yg-node.yaml.`,
          }),
        });
        continue;
      }

      if (!hasPorts) continue;
      const ports = target!.meta.ports!;

      // missing-consumes: target has ports but consumer has no consumes
      if (!rel.consumes || rel.consumes.length === 0) {
        const portNames = Object.keys(ports);
        issues.push({
          severity: 'error',
          code: 'port-missing-consumes',
          rule: 'missing-consumes',
          nodePath,
          message: buildIssueMessage({
            what: `Relation: ${rel.type} -> ${rel.target}`,
            why: `Target has ports: [${portNames.join(', ')}] — port-required aspects won't be verified without a consumes declaration.`,
            next: `Add consumes: [<port-names>] to this relation in yg-node.yaml.`,
          }),
        });
        continue;
      }

      // unknown-port: consumes references non-existent port
      for (const portName of rel.consumes) {
        if (!(portName in ports)) {
          const available = Object.keys(ports);
          issues.push({
            severity: 'error',
            code: 'port-undefined',
            rule: 'unknown-port',
            nodePath,
            message: buildIssueMessage({
              what: `Relation: ${rel.type} -> ${rel.target}, port '${portName}' not found.`,
              why: `Port contract cannot be enforced for an undefined port. Available ports: [${available.join(', ')}]`,
              next: `Fix the port name in consumes, or add the port definition to the target node.`,
            }),
          });
        }
      }
    }
  }

  return issues;
}

/**
 * orphaned-aspect
 * An aspect defined in aspects/ is not referenced by any node, architecture type, or flow.
 * Implied aspects are exempt when the aspect that implies them is itself referenced.
 */
function checkOrphanedAspects(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const referenced = new Set<string>();

  // Collect direct references from nodes (aspects field and port aspects)
  for (const [, node] of graph.nodes) {
    for (const a of node.meta.aspects ?? []) referenced.add(a);
    if (node.meta.ports) {
      for (const port of Object.values(node.meta.ports)) {
        for (const a of port.aspects) referenced.add(a);
      }
    }
  }

  // Collect references from architecture node_types
  for (const typeDef of Object.values(graph.architecture?.node_types ?? {})) {
    for (const a of typeDef.aspects ?? []) referenced.add(a);
  }

  // Collect references from flows
  for (const flow of graph.flows) {
    for (const a of flow.aspects ?? []) referenced.add(a);
  }

  // Propagate: aspects implied by a referenced aspect are also considered referenced
  // (iterate to fixpoint in case of chains)
  let changed = true;
  while (changed) {
    changed = false;
    for (const aspect of graph.aspects) {
      if (referenced.has(aspect.id) && aspect.implies) {
        for (const implied of aspect.implies) {
          if (!referenced.has(implied)) {
            referenced.add(implied);
            changed = true;
          }
        }
      }
    }
  }

  for (const aspect of graph.aspects) {
    if (!referenced.has(aspect.id)) {
      issues.push({
        severity: 'warning',
        code: 'orphaned-aspect',
        rule: 'orphaned-aspect',
        nodePath: `aspects/${aspect.id}`,
        message: buildIssueMessage({
          what: `Aspect '${aspect.id}' is defined but not referenced by any node, architecture type, or flow.`,
          why: `Orphaned aspects add noise to the graph without enforcing any requirements.`,
          next: `Either add it to a node/architecture/flow or remove it.`,
        }),
      });
    }
  }

  return issues;
}
