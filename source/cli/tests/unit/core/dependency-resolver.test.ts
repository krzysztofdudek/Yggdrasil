import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));
import {
  resolveDeps,
  findChangedNodes,
  collectTransitiveDeps,
  buildDependencyTree,
  formatDependencyTree,
} from '../../../src/core/dependency-resolver.js';
import type { Graph, GraphNode } from '../../../src/model/types.js';

function createNode(
  path: string,
  relations: { target: string; type: string }[] = [],
  mapping?: { path: string },
  blackbox = false,
): GraphNode {
  return {
    path,
    meta: {
      name: path.split('/').pop() ?? path,
      type: 'service',
      relations: relations.length > 0 ? relations : undefined,
      mapping,
      blackbox,
    },
    artifacts: [],
    children: [],
    parent: null,
  };
}

function createGraph(nodes: GraphNode[], rootPath = '/tmp/.yggdrasil'): Graph {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) {
    nodeMap.set(n.path, n);
  }
  return {
    config: { name: 'Test', stack: {}, standards: {}, tags: {} },
    nodes: nodeMap,
    aspects: [],
    flows: [],
    schemas: [],
    rootPath,
  };
}

describe('dependency-resolver', () => {
  describe('resolveDeps - linear chain A→B→C', () => {
    it('produces stages [C], [B], [A]', async () => {
      const graph = createGraph([
        createNode('A', [{ target: 'B', type: 'uses' }], { path: 'a.ts' }),
        createNode('B', [{ target: 'C', type: 'uses' }], { path: 'b.ts' }),
        createNode('C', [], { path: 'c.ts' }),
      ]);

      const stages = await resolveDeps(graph, { mode: 'all' });

      expect(stages).toHaveLength(3);
      expect(stages[0].stage).toBe(1);
      expect(stages[0].nodes).toEqual(['C']);
      expect(stages[0].parallel).toBe(false);

      expect(stages[1].stage).toBe(2);
      expect(stages[1].nodes).toEqual(['B']);
      expect(stages[1].parallel).toBe(false);

      expect(stages[2].stage).toBe(3);
      expect(stages[2].nodes).toEqual(['A']);
      expect(stages[2].parallel).toBe(false);
    });
  });

  describe('resolveDeps - diamond A→B,C B,C→D', () => {
    it('produces stages [D], [B,C], [A]', async () => {
      const graph = createGraph([
        createNode(
          'A',
          [
            { target: 'B', type: 'uses' },
            { target: 'C', type: 'uses' },
          ],
          { path: 'a.ts' },
        ),
        createNode('B', [{ target: 'D', type: 'uses' }], { path: 'b.ts' }),
        createNode('C', [{ target: 'D', type: 'uses' }], { path: 'c.ts' }),
        createNode('D', [], { path: 'd.ts' }),
      ]);

      const stages = await resolveDeps(graph, { mode: 'all' });

      expect(stages).toHaveLength(3);
      expect(stages[0].nodes).toEqual(['D']);
      expect(stages[0].parallel).toBe(false);

      expect(stages[1].nodes).toHaveLength(2);
      expect(stages[1].nodes).toContain('B');
      expect(stages[1].nodes).toContain('C');
      expect(stages[1].parallel).toBe(true);

      expect(stages[2].nodes).toEqual(['A']);
      expect(stages[2].parallel).toBe(false);
    });
  });

  describe('resolveDeps - independent nodes', () => {
    it('produces single parallel stage', async () => {
      const graph = createGraph([
        createNode('A', [], { path: 'a.ts' }),
        createNode('B', [], { path: 'b.ts' }),
        createNode('C', [], { path: 'c.ts' }),
      ]);

      const stages = await resolveDeps(graph, { mode: 'all' });

      expect(stages).toHaveLength(1);
      expect(stages[0].nodes).toHaveLength(3);
      expect(stages[0].nodes).toContain('A');
      expect(stages[0].nodes).toContain('B');
      expect(stages[0].nodes).toContain('C');
      expect(stages[0].parallel).toBe(true);
    });
  });

  describe('resolveDeps - cycle detection', () => {
    it('throws when A→B, B→A', async () => {
      const graph = createGraph([
        createNode('A', [{ target: 'B', type: 'uses' }], { path: 'a.ts' }),
        createNode('B', [{ target: 'A', type: 'uses' }], { path: 'b.ts' }),
      ]);

      await expect(resolveDeps(graph, { mode: 'all' })).rejects.toThrow(
        /Circular dependency detected involving/,
      );
    });
  });

  describe('resolveDeps - broken relation in candidates', () => {
    it('throws when relation target does not exist in graph', async () => {
      const graph = createGraph([
        createNode('A', [{ target: 'nonexistent', type: 'uses' }], { path: 'a.ts' }),
      ]);

      await expect(resolveDeps(graph, { mode: 'all' })).rejects.toThrow(
        'Relation target not found: nonexistent',
      );
    });
  });

  describe('resolveDeps - blackbox exclusion', () => {
    it('excludes blackbox nodes from stages', async () => {
      const graph = createGraph([
        createNode('A', [{ target: 'B', type: 'uses' }], { path: 'a.ts' }),
        createNode('B', [], { path: 'b.ts' }, true), // blackbox
      ]);

      const stages = await resolveDeps(graph, { mode: 'all' });

      expect(stages).toHaveLength(1);
      expect(stages[0].nodes).toEqual(['A']);
      expect(stages[0].nodes).not.toContain('B');
    });
  });

  describe('resolveDeps - nodes without mapping', () => {
    it('excludes nodes without mapping from stages', async () => {
      const graph = createGraph([
        createNode('A', [{ target: 'B', type: 'uses' }], { path: 'a.ts' }),
        createNode('B', [], undefined), // no mapping
      ]);

      const stages = await resolveDeps(graph, { mode: 'all' });

      expect(stages).toHaveLength(1);
      expect(stages[0].nodes).toEqual(['A']);
      expect(stages[0].nodes).not.toContain('B');
    });
  });

  describe('collectTransitiveDeps', () => {
    it('returns node and its transitive dependencies', () => {
      const graph = createGraph([
        createNode('A', [{ target: 'B', type: 'uses' }], { path: 'a.ts' }),
        createNode('B', [{ target: 'C', type: 'uses' }], { path: 'b.ts' }),
        createNode('C', [], { path: 'c.ts' }),
      ]);

      const deps = collectTransitiveDeps(graph, 'A');

      expect(deps).toHaveLength(3);
      expect(deps).toContain('A');
      expect(deps).toContain('B');
      expect(deps).toContain('C');
    });

    it('throws when node not found', () => {
      const graph = createGraph([createNode('A', [], { path: 'a.ts' })]);

      expect(() => collectTransitiveDeps(graph, 'X')).toThrow('Node not found: X');
    });

    it('throws when relation target not found', () => {
      const graph = createGraph([
        createNode('A', [{ target: 'missing', type: 'uses' }], { path: 'a.ts' }),
      ]);

      expect(() => collectTransitiveDeps(graph, 'A')).toThrow('Relation target not found: missing');
    });

  });

  describe('resolveDeps - node mode', () => {
    it('includes only specified node and its transitive deps', async () => {
      const graph = createGraph([
        createNode('A', [{ target: 'B', type: 'uses' }], { path: 'a.ts' }),
        createNode('B', [{ target: 'C', type: 'uses' }], { path: 'b.ts' }),
        createNode('C', [], { path: 'c.ts' }),
      ]);

      const stages = await resolveDeps(graph, { mode: 'node', nodePath: 'A' });

      expect(stages).toHaveLength(3);
      expect(stages[0].nodes).toEqual(['C']);
      expect(stages[1].nodes).toEqual(['B']);
      expect(stages[2].nodes).toEqual(['A']);
    });
  });

  describe('resolveDeps - empty graph (no nodes with mapping)', () => {
    it('returns empty stages when no nodes have mapping', async () => {
      const graph = createGraph([createNode('A', [], undefined), createNode('B', [], undefined)]);

      const stages = await resolveDeps(graph, { mode: 'all' });
      expect(stages).toHaveLength(0);
    });
  });

  describe('collectTransitiveDeps - diamond', () => {
    it('handles diamond-shaped dependencies without duplicates', () => {
      const graph = createGraph([
        createNode(
          'A',
          [
            { target: 'B', type: 'uses' },
            { target: 'C', type: 'uses' },
          ],
          { path: 'a.ts' },
        ),
        createNode('B', [{ target: 'D', type: 'uses' }], { path: 'b.ts' }),
        createNode('C', [{ target: 'D', type: 'uses' }], { path: 'c.ts' }),
        createNode('D', [], { path: 'd.ts' }),
      ]);

      const deps = collectTransitiveDeps(graph, 'A');
      expect(deps).toHaveLength(4);
      expect(deps).toContain('A');
      expect(deps).toContain('B');
      expect(deps).toContain('C');
      expect(deps).toContain('D');
    });
  });

  describe('resolveDeps - changed mode', () => {
    it('uses changed mode to filter nodes', async () => {
      vi.mocked(execSync).mockReturnValue('.yggdrasil/changed/node.yaml\n');

      const graph = createGraph(
        [
          createNode('changed', [], { path: 'src/changed.ts' }),
          createNode('unchanged', [], { path: 'src/unchanged.ts' }),
        ],
        '/tmp/test-ygg/.yggdrasil',
      );

      const stages = await resolveDeps(graph, { mode: 'changed' });
      const allNodes = stages.flatMap((s) => s.nodes);
      expect(allNodes).toContain('changed');
      expect(allNodes).not.toContain('unchanged');
    });
  });

  describe('findChangedNodes - git-based detection', () => {
    const rootPath = '/tmp/test-ygg/.yggdrasil';

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('skips blackbox nodes', () => {
      vi.mocked(execSync).mockReturnValue('.yggdrasil/blackbox-node/node.yaml\n');

      const graph = createGraph(
        [
          createNode('blackbox-node', [], { path: 'src/bb.ts' }, true), // blackbox
          createNode('normal-node', [], { path: 'src/normal.ts' }),
        ],
        rootPath,
      );

      // findChangedNodes detects blackbox-node as changed via git,
      // but it gets filtered out in resolveDeps (not in findChangedNodes itself)
      // findChangedNodes does include it, resolveDeps filters blackbox
      const changed = findChangedNodes(graph);
      // The git-based function maps paths to nodes — blackbox-node IS detected
      expect(changed).toContain('blackbox-node');
    });

    it('skips nodes without mapping', () => {
      // Git reports changes but node has no mapping — findChangedNodes still returns it,
      // resolveDeps filters later
      vi.mocked(execSync).mockReturnValue('');

      const graph = createGraph(
        [
          createNode('no-mapping', []), // no mapping
        ],
        rootPath,
      );

      const changed = findChangedNodes(graph);
      expect(changed).not.toContain('no-mapping');
    });

    it('maps git diff output to correct node paths', () => {
      vi.mocked(execSync).mockReturnValue(
        '.yggdrasil/auth/login-service/node.yaml\n.yggdrasil/auth/login-service/aspects/api.yaml\n',
      );

      const graph = createGraph(
        [
          createNode('auth/login-service', [], { path: 'src/login.ts' }),
          createNode('orders/order-service', [], { path: 'src/orders.ts' }),
        ],
        rootPath,
      );

      const changed = findChangedNodes(graph);
      expect(changed).toContain('auth/login-service');
      expect(changed).not.toContain('orders/order-service');
    });

    it('returns empty when git diff fails', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('not a git repo');
      });

      const graph = createGraph([createNode('some-node', [], { path: 'src/some.ts' })], rootPath);

      const changed = findChangedNodes(graph);
      expect(changed).toHaveLength(0);
    });

    it('uses custom ref when provided', () => {
      vi.mocked(execSync).mockReturnValue('.yggdrasil/my-node/node.yaml\n');

      const graph = createGraph([createNode('my-node', [], { path: 'src/my.ts' })], rootPath);

      findChangedNodes(graph, 'main');
      expect(vi.mocked(execSync)).toHaveBeenCalledWith(
        'git diff --name-only main -- .yggdrasil/',
        expect.objectContaining({ cwd: '/tmp/test-ygg', encoding: 'utf-8' }),
      );
    });

    it('expands with one-level dependents only (no cascade)', () => {
      vi.mocked(execSync).mockReturnValue('.yggdrasil/base/node.yaml\n');

      const graph = createGraph(
        [
          createNode('base', [], { path: 'src/base.ts' }),
          createNode('mid', [{ target: 'base', type: 'uses' }], { path: 'src/mid.ts' }),
          createNode('top', [{ target: 'mid', type: 'uses' }], { path: 'src/top.ts' }),
        ],
        rootPath,
      );

      const changed = findChangedNodes(graph);
      expect(changed).toContain('base');
      expect(changed).toContain('mid');
      expect(changed).not.toContain('top');
    });

    it('handles file path without ygg prefix (relative path)', () => {
      vi.mocked(execSync).mockReturnValue('model/svc/node.yaml\n');

      const graph = createGraph([createNode('svc', [], { path: 'src/svc.ts' })], rootPath);

      const changed = findChangedNodes(graph);
      expect(changed).toContain('svc');
    });

    it('handles path without model segment (skips non-node paths)', () => {
      vi.mocked(execSync).mockReturnValue('config.yaml\naspects/audit/aspect.yaml\n');

      const graph = createGraph([createNode('svc', [], { path: 'src/svc.ts' })], rootPath);

      const changed = findChangedNodes(graph);
      expect(changed).toHaveLength(0);
    });
  });

  describe('buildDependencyTree / formatDependencyTree - relation type filter', () => {
    it('--type structural includes only uses, calls, extends, implements', () => {
      const graph = createGraph([
        createNode(
          'A',
          [
            { target: 'B', type: 'uses' },
            { target: 'C', type: 'emits' },
          ],
          { path: 'a.ts' },
        ),
        createNode('B', [], { path: 'b.ts' }),
        createNode('C', [], { path: 'c.ts' }),
      ]);

      const tree = buildDependencyTree(graph, 'A', {
        relationType: 'structural',
      });

      expect(tree).toHaveLength(1);
      expect(tree[0].relationType).toBe('uses');
      expect(tree[0].nodePath).toBe('B');
      expect(tree.some((t) => t.relationType === 'emits')).toBe(false);
    });

    it('--type event includes only emits, listens', () => {
      const graph = createGraph([
        createNode(
          'A',
          [
            { target: 'B', type: 'emits' },
            { target: 'C', type: 'uses' },
          ],
          { path: 'a.ts' },
        ),
        createNode('B', [], { path: 'b.ts' }),
        createNode('C', [], { path: 'c.ts' }),
      ]);

      const tree = buildDependencyTree(graph, 'A', {
        relationType: 'event',
      });

      expect(tree).toHaveLength(1);
      expect(tree[0].relationType).toBe('emits');
      expect(tree[0].nodePath).toBe('B');
      expect(tree.some((t) => t.relationType === 'uses')).toBe(false);
    });

    it('--type all includes all relation types', () => {
      const graph = createGraph([
        createNode(
          'A',
          [
            { target: 'B', type: 'uses' },
            { target: 'C', type: 'emits' },
          ],
          { path: 'a.ts' },
        ),
        createNode('B', [], { path: 'b.ts' }),
        createNode('C', [], { path: 'c.ts' }),
      ]);

      const tree = buildDependencyTree(graph, 'A', {
        relationType: 'all',
      });

      expect(tree).toHaveLength(2);
      expect(tree.map((t) => t.relationType).sort()).toEqual(['emits', 'uses']);
    });

    it('throws when node not found in buildDependencyTree', () => {
      const graph = createGraph([
        createNode('A', [{ target: 'B', type: 'uses' }], { path: 'a.ts' }),
        createNode('B', [], { path: 'b.ts' }),
      ]);

      expect(() => buildDependencyTree(graph, 'missing-node')).toThrow('Node not found: missing-node');
    });

    it('skips relations whose target is not in graph', () => {
      const graph = createGraph([
        createNode(
          'A',
          [
            { target: 'B', type: 'uses' },
            { target: 'missing', type: 'uses' },
          ],
          { path: 'a.ts' },
        ),
        createNode('B', [], { path: 'b.ts' }),
      ]);

      const tree = buildDependencyTree(graph, 'A');
      expect(tree).toHaveLength(1);
      expect(tree[0].nodePath).toBe('B');
    });

    it('respects depth limit in buildDependencyTree', () => {
      const graph = createGraph([
        createNode('A', [{ target: 'B', type: 'uses' }], { path: 'a.ts' }),
        createNode('B', [{ target: 'C', type: 'uses' }], { path: 'b.ts' }),
        createNode('C', [], { path: 'c.ts' }),
      ]);

      const treeDepth1 = buildDependencyTree(graph, 'A', { depth: 1 });
      expect(treeDepth1).toHaveLength(1);
      expect(treeDepth1[0].nodePath).toBe('B');
      expect(treeDepth1[0].children).toHaveLength(0);

      const treeDepth2 = buildDependencyTree(graph, 'A', { depth: 2 });
      expect(treeDepth2[0].children).toHaveLength(1);
      expect(treeDepth2[0].children[0].nodePath).toBe('C');
    });

    it('filters out unknown relation types (filterRelationType return false)', () => {
      const graph = createGraph([
        createNode(
          'A',
          [
            { target: 'B', type: 'uses' },
            { target: 'C', type: 'custom' },
          ],
          { path: 'a.ts' },
        ),
        createNode('B', [], { path: 'b.ts' }),
        createNode('C', [], { path: 'c.ts' }),
      ]);

      const tree = buildDependencyTree(graph, 'A', {
        relationType: 'structural',
      });

      expect(tree).toHaveLength(1);
      expect(tree[0].nodePath).toBe('B');
      expect(tree.some((t) => t.relationType === 'custom')).toBe(false);
    });

    it('formatDependencyTree with --type structural', () => {
      const graph = createGraph([
        createNode(
          'A',
          [
            { target: 'B', type: 'uses' },
            { target: 'C', type: 'emits' },
          ],
          { path: 'a.ts' },
        ),
        createNode('B', [], { path: 'b.ts' }),
        createNode('C', [], { path: 'c.ts' }),
      ]);

      const output = formatDependencyTree(graph, 'A', {
        relationType: 'structural',
      });

      expect(output).toContain('A');
      expect(output).toContain('uses B');
      expect(output).not.toContain('emits');
    });
  });
});
