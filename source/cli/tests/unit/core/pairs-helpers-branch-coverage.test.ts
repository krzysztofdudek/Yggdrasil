import { describe, it, expect } from 'vitest';
import { getChildMappingExclusions, computeNodeMappedFiles } from '../../../src/core/pairs.js';
import type { Graph } from '../../../src/model/graph.js';

/**
 * Branch-coverage tests for the child-mapping-exclusion and node-mapped-files helpers'
 * early-return guards and the child-wins carve-out selection: a node with no mapping, a
 * missing node path, and a child whose mapping is nested under (or equal to) the parent's.
 */

function mkGraph(nodes: Map<string, unknown>): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes,
    aspects: [],
    flows: [],
    rootPath: '/tmp/does-not-matter/.yggdrasil',
  } as unknown as Graph;
}

function node(nodePath: string, mapping?: string[]): [string, unknown] {
  return [nodePath, { path: nodePath, meta: { name: nodePath, type: 'service', mapping }, children: [], parent: null }];
}

describe('getChildMappingExclusions', () => {
  it('returns the child mappings nested under (or equal to) the parent mapping', () => {
    const g = mkGraph(
      new Map([
        node('parent', ['src/mod']),
        node('parent/child', ['src/mod/sub']), // nested → excluded
        node('parent/twin', ['src/mod']), // exact match → excluded
        node('other', ['src/elsewhere']), // not a descendant → ignored
      ] as [string, unknown][]),
    );
    const exclusions = getChildMappingExclusions(g, 'parent');
    expect(exclusions).toContain('src/mod/sub');
    expect(exclusions).toContain('src/mod');
    expect(exclusions).not.toContain('src/elsewhere');
  });

  it('returns [] for a parent node with no mapping', () => {
    const g = mkGraph(new Map([node('parent', undefined)] as [string, unknown][]));
    expect(getChildMappingExclusions(g, 'parent')).toEqual([]);
  });

  it('returns [] for a node path that is not in the graph', () => {
    const g = mkGraph(new Map());
    expect(getChildMappingExclusions(g, 'ghost')).toEqual([]);
  });
});

describe('computeNodeMappedFiles', () => {
  it('returns [] for a node path that is not in the graph', async () => {
    const g = mkGraph(new Map());
    await expect(computeNodeMappedFiles(g, 'ghost')).resolves.toEqual([]);
  });

  it('returns [] for a node that maps nothing', async () => {
    const g = mkGraph(new Map([node('empty', undefined)] as [string, unknown][]));
    await expect(computeNodeMappedFiles(g, 'empty')).resolves.toEqual([]);
  });
});
