import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../../support/tmpdir.js';
import type {
  Graph, GraphNode, AspectDef, FlowDef, YggConfig, ArchitectureDef,
  ArchitectureNodeType, AspectStatus, StatusInherit, AspectReviewerSpec,
} from '../../../src/model/graph.js';

// Tracks tmpdirs created by buildTestGraph so a test suite can remove them early
// via cleanupTestGraphs() in afterEach. They are made through makeTempDir, so the
// ones a suite does not remove itself go when its test file finishes.
const createdTmpRoots: string[] = [];

export function cleanupTestGraphs(): void {
  while (createdTmpRoots.length > 0) {
    const dir = createdTmpRoots.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export interface TestAspectInput {
  id: string;
  status?: AspectStatus;
  implies?: string[];
  impliesStatusInherit?: Record<string, StatusInherit>;
  /** Override the reviewer spec. Defaults to { type: 'llm' }. Use { type: 'aggregate' } for bundle aspects. */
  reviewer?: AspectReviewerSpec;
}
export interface TestNodeInput {
  path: string;
  type: string;
  aspects?: string[];
  aspectStatus?: Record<string, AspectStatus>;
  parent?: string;
}
export interface TestFlowInput {
  path: string;
  nodes: string[];
  aspects?: string[];
  aspectStatus?: Record<string, AspectStatus>;
}
export interface TestTypeInput {
  id: string;
  description?: string;
  aspects?: string[];
  aspectStatus?: Record<string, AspectStatus>;
}

const EMPTY_CONFIG: YggConfig = {
  version: '5.0.0',
  reviewer: { tiers: { default: { provider: 'ollama', model: 'test', temperature: 0, consensus: 1 } }, default: 'default' },
};

export function buildTestGraph(input: {
  aspects?: TestAspectInput[];
  nodes?: TestNodeInput[];
  flows?: TestFlowInput[];
  types?: TestTypeInput[];
  config?: YggConfig;
  rootPath?: string;
}): Graph {
  const aspects: AspectDef[] = (input.aspects ?? []).map(a => {
    const reviewer: AspectReviewerSpec = a.reviewer ?? { type: 'llm' };
    // Aggregate aspects ship neither content.md nor check.mjs.
    const artifacts = reviewer.type === 'aggregate'
      ? []
      : [{ filename: 'content.md', content: 'rule' }];
    return {
      id: a.id, name: a.id, reviewer,
      artifacts,
      status: a.status, implies: a.implies, impliesStatusInherit: a.impliesStatusInherit,
    } as AspectDef;
  });

  const nodeByPath = new Map<string, GraphNode>();
  for (const n of input.nodes ?? []) {
    nodeByPath.set(n.path, {
      path: n.path,
      meta: { name: n.path, type: n.type, aspects: n.aspects, aspectStatus: n.aspectStatus },
      children: [], parent: null,
    } as GraphNode);
  }
  for (const n of input.nodes ?? []) {
    if (n.parent) {
      const child = nodeByPath.get(n.path)!;
      const parent = nodeByPath.get(n.parent)!;
      child.parent = parent;
      parent.children.push(child);
    }
  }

  const flows: FlowDef[] = (input.flows ?? []).map(f => ({
    path: f.path, name: f.path, nodes: f.nodes, aspects: f.aspects, aspectStatus: f.aspectStatus,
  } as FlowDef));

  const node_types: Record<string, ArchitectureNodeType> = {};
  node_types.service = { description: 'test service type' };
  node_types.module = { description: 'test module type' };
  for (const t of input.types ?? []) {
    node_types[t.id] = {
      description: t.description ?? `test ${t.id}`,
      aspects: t.aspects, aspectStatus: t.aspectStatus,
    };
  }
  const architecture: ArchitectureDef = { node_types };

  // Default to an isolated tmpdir so validator FS scans stay bounded.
  // path.dirname(rootPath) becomes the project root walkRepoFiles iterates.
  // Created tmpdirs are tracked for cleanup via cleanupTestGraphs().
  let rootPath = input.rootPath;
  if (!rootPath) {
    const projectRoot = makeTempDir('yg-test-graph-');
    createdTmpRoots.push(projectRoot);
    rootPath = path.join(projectRoot, '.yggdrasil');
    try { mkdirSync(rootPath); } catch { /* ignore */ }
  }

  return {
    config: input.config ?? EMPTY_CONFIG,
    architecture,
    nodes: nodeByPath,
    flows,
    aspects,
    rootPath,
  } as unknown as Graph;
}
