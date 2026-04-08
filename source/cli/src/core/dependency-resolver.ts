import type { Graph, Stage } from '../model/graph.js';
import { execSync } from 'node:child_process';
import path from 'node:path';

export interface ResolveOptions {
  mode: 'all' | 'changed' | 'node';
  nodePath?: string; // required when mode === 'node'
  ref?: string; // git ref for --changed mode (default: HEAD)
  depth?: number; // max depth for tree (when mode === 'node')
  relationType?: 'structural' | 'event' | 'all'; // filter for tree
}

const STRUCTURAL_RELATION_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);
const EVENT_RELATION_TYPES = new Set(['emits', 'listens']);

/** Expand changed set with direct dependents only (one level, no cascade) */
function expandWithDependents(graph: Graph, changed: string[]): string[] {
  const dependents = new Map<string, string[]>();
  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (!STRUCTURAL_RELATION_TYPES.has(rel.type)) continue;
      const deps = dependents.get(rel.target) ?? [];
      deps.push(nodePath);
      dependents.set(rel.target, deps);
    }
  }

  const result = new Set<string>(changed);
  for (const node of changed) {
    for (const dep of dependents.get(node) ?? []) {
      result.add(dep);
    }
  }

  return [...result];
}

/** Find nodes whose graph files have changed according to git */
export function findChangedNodes(graph: Graph, ref?: string): string[] {
  const gitRef = ref ?? 'HEAD';
  const yggDirName = path.basename(graph.rootPath);
  const projectRoot = path.dirname(graph.rootPath);

  let changedFiles: string[];
  try {
    const output = execSync(`git diff --name-only ${gitRef} -- ${yggDirName}/`, {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    changedFiles = output ? output.split('\n') : [];
  } catch {
    // If git diff fails (no commits, not a repo, etc.), fall back to empty
    changedFiles = [];
  }

  // Map changed file paths back to node paths
  const changedNodePaths = new Set<string>();
  for (const filePath of changedFiles) {
    // filePath is like ".yggdrasil/auth/login-service/yg-node.yaml"
    // Strip the yggdrasil dir prefix to get "auth/login-service/yg-node.yaml"
    const relative = filePath.startsWith(yggDirName + '/')
      ? filePath.slice(yggDirName.length + 1)
      : filePath;

    // Walk up directories to find matching node paths (nodes are under model/)
    const parts = relative.split('/');
    const modelIdx = parts.indexOf('model');
    const startIdx = modelIdx >= 0 ? modelIdx + 1 : 0;
    for (let i = parts.length - 1; i >= startIdx + 1; i--) {
      const candidate = parts.slice(startIdx, i).join('/');
      if (graph.nodes.has(candidate)) {
        changedNodePaths.add(candidate);
        break;
      }
    }
  }

  return expandWithDependents(graph, [...changedNodePaths]);
}

/** Collect node and its transitive dependencies (for --node mode) */
export function collectTransitiveDeps(graph: Graph, nodePath: string): string[] {
  return collectTransitiveDepsFiltered(graph, nodePath, undefined, 'structural');
}

/** Filter relation types for inclusion */
function filterRelationType(relType: string, filter: 'structural' | 'event' | 'all'): boolean {
  if (filter === 'all') return true;
  if (filter === 'structural') return STRUCTURAL_RELATION_TYPES.has(relType);
  if (filter === 'event') return EVENT_RELATION_TYPES.has(relType);
  return false;
}

/** Collect transitive deps with depth and type filter */
function collectTransitiveDepsFiltered(
  graph: Graph,
  nodePath: string,
  maxDepth: number | undefined,
  relationType: 'structural' | 'event' | 'all',
): string[] {
  const node = graph.nodes.get(nodePath);
  if (!node) {
    throw new Error(`Node not found: ${nodePath}`);
  }

  const result = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [{ path: nodePath, depth: 0 }];

  while (queue.length > 0) {
    const { path: p, depth } = queue.shift()!;
    if (result.has(p)) continue;
    result.add(p);
    if (maxDepth !== undefined && depth >= maxDepth) continue;

    const n = graph.nodes.get(p)!;
    for (const rel of n.meta.relations ?? []) {
      if (!filterRelationType(rel.type, relationType)) continue;
      if (!graph.nodes.has(rel.target)) {
        throw new Error(`Relation target not found: ${rel.target}`);
      }
      if (!result.has(rel.target)) {
        queue.push({ path: rel.target, depth: depth + 1 });
      }
    }
  }

  return [...result];
}

/** Tree node for dependency tree output */
export interface DepTreeNode {
  nodePath: string;
  relationType: string;
  relationTarget?: string;
  blackbox: boolean;
  children: DepTreeNode[];
}

/** Build dependency tree for a node (spec format) */
export function buildDependencyTree(
  graph: Graph,
  nodePath: string,
  options: { depth?: number; relationType?: 'structural' | 'event' | 'all' } = {},
): DepTreeNode[] {
  const node = graph.nodes.get(nodePath);
  if (!node) {
    throw new Error(`Node not found: ${nodePath}`);
  }

  const maxDepth = options.depth ?? Infinity;
  const typeFilter = options.relationType ?? 'all';

  function buildChildren(
    fromPath: string,
    currentDepth: number,
    branch: Set<string>,
  ): DepTreeNode[] {
    if (currentDepth >= maxDepth) return [];
    const fromNode = graph.nodes.get(fromPath)!;
    const children: DepTreeNode[] = [];
    for (const rel of fromNode.meta.relations ?? []) {
      if (!filterRelationType(rel.type, typeFilter)) continue;
      if (!graph.nodes.has(rel.target)) continue;
      if (branch.has(rel.target)) continue;
      const targetNode = graph.nodes.get(rel.target)!;
      const nextBranch = new Set(branch);
      nextBranch.add(rel.target);
      children.push({
        nodePath: rel.target,
        relationType: rel.type,
        relationTarget: fromPath,
        blackbox: targetNode.meta.blackbox ?? false,
        children: buildChildren(rel.target, currentDepth + 1, nextBranch),
      });
    }
    return children;
  }

  return buildChildren(nodePath, 0, new Set([nodePath]));
}

/** Format tree as text (spec format) */
export function formatDependencyTree(
  graph: Graph,
  nodePath: string,
  options: { depth?: number; relationType?: 'structural' | 'event' | 'all' } = {},
): string {
  const roots = buildDependencyTree(graph, nodePath, options);
  const lines: string[] = [nodePath];

  function formatNode(node: DepTreeNode, prefix: string, isLast: boolean): void {
    const connector = isLast ? '└── ' : '├── ';
    const blackbox = node.blackbox ? ' ■ blackbox' : '';
    lines.push(`${prefix}${connector}${node.relationType} ${node.nodePath}${blackbox}`);
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    const lastIdx = node.children.length - 1;
    node.children.forEach((c, i) => formatNode(c, childPrefix, i === lastIdx));
  }

  roots.forEach((r, i) => formatNode(r, '', i === roots.length - 1));
  return lines.join('\n');
}

export async function resolveDeps(graph: Graph, options: ResolveOptions): Promise<Stage[]> {
  let candidatePaths: string[];

  switch (options.mode) {
    case 'all':
      candidatePaths = [...graph.nodes.keys()];
      break;
    case 'changed':
      candidatePaths = findChangedNodes(graph, options.ref);
      break;
    case 'node':
      candidatePaths = collectTransitiveDeps(graph, options.nodePath!);
      break;
  }

  candidatePaths = candidatePaths.filter((p) => {
    const node = graph.nodes.get(p)!;
    return !node.meta.blackbox && node.meta.mapping;
  });

  if (candidatePaths.length === 0) return [];

  const candidateSet = new Set(candidatePaths);

  // Validate relations: broken relation = target not in graph
  for (const p of candidatePaths) {
    const node = graph.nodes.get(p)!;
    for (const rel of node.meta.relations ?? []) {
      if (!graph.nodes.has(rel.target)) {
        throw new Error(`Relation target not found: ${rel.target}`);
      }
    }
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const p of candidatePaths) {
    inDegree.set(p, 0);
    dependents.set(p, []);
  }

  for (const p of candidatePaths) {
    const node = graph.nodes.get(p)!;
    for (const rel of node.meta.relations ?? []) {
      if (!STRUCTURAL_RELATION_TYPES.has(rel.type)) continue;
      if (candidateSet.has(rel.target)) {
        inDegree.set(p, (inDegree.get(p) ?? 0) + 1);
        dependents.get(rel.target)!.push(p);
      }
    }
  }

  const stages: Stage[] = [];
  let queue = candidatePaths.filter((p) => inDegree.get(p) === 0);
  let stageNum = 1;
  const processed = new Set<string>();

  while (queue.length > 0) {
    stages.push({
      stage: stageNum,
      parallel: queue.length > 1,
      nodes: [...queue],
    });

    const nextQueue: string[] = [];
    for (const nodePath of queue) {
      processed.add(nodePath);
      for (const dep of dependents.get(nodePath) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) - 1);
        if (inDegree.get(dep) === 0) {
          nextQueue.push(dep);
        }
      }
    }

    queue = nextQueue;
    stageNum++;
  }

  if (processed.size < candidatePaths.length) {
    const cycleNodes = candidatePaths.filter((p) => !processed.has(p));
    throw new Error(`Circular dependency detected involving: ${cycleNodes.join(', ')}`);
  }

  return stages;
}
