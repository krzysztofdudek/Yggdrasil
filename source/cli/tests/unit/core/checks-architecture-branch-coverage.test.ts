import { describe, it, expect } from 'vitest';
import {
  checkArchitectureParentCycles,
  checkNodeTypesExist,
  checkTypeWithoutWhenWithMapping,
} from '../../../src/core/checks/architecture.js';
import type { Graph } from '../../../src/model/graph.js';

/**
 * Branch-coverage tests for the architecture validators: a parent cycle among defined
 * types leaves every type unable to reach a rootable type (the DFS back-edge + BFS
 * reachability path), a node of an undefined type is flagged, and an organizational
 * type (no `when`) with MORE than three mapping entries renders the truncated preview.
 */

function mkGraph(node_types: Record<string, unknown>, nodes: Map<string, unknown> = new Map()): Graph {
  return {
    config: {},
    architecture: { node_types },
    nodes,
    aspects: [],
    flows: [],
    rootPath: '/tmp/does-not-matter/.yggdrasil',
  } as unknown as Graph;
}

function node(nodePath: string, meta: Record<string, unknown>): [string, unknown] {
  return [nodePath, { path: nodePath, meta: { name: nodePath, type: 'service', ...meta }, children: [], parent: null }];
}

describe('checkArchitectureParentCycles', () => {
  it('flags a two-type parent cycle where no type can reach a rootable type', () => {
    const g = mkGraph({
      a: { description: 'a', parents: ['b'] },
      b: { description: 'b', parents: ['a'] },
    });
    const issues = checkArchitectureParentCycles(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
  });

  it('does not flag a chain that reaches a rootable (parentless) type', () => {
    const g = mkGraph({
      root: { description: 'root' },
      mid: { description: 'mid', parents: ['root'] },
      leaf: { description: 'leaf', parents: ['mid'] },
    });
    expect(checkArchitectureParentCycles(g)).toEqual([]);
  });

  it('defers to the unknown-parent check when a parent is not defined', () => {
    const g = mkGraph({ a: { description: 'a', parents: ['ghost'] } });
    // An unknown parent short-circuits the cycle check (that case is a different rule).
    expect(checkArchitectureParentCycles(g)).toEqual([]);
  });
});

describe('checkNodeTypesExist', () => {
  it('flags a node whose type is not defined in the architecture', () => {
    const g = mkGraph(
      { service: { description: 'svc' } },
      new Map([node('x/y', { type: 'ghost-type' })] as [string, unknown][]),
    );
    const issues = checkNodeTypesExist(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].nodePath === undefined || issues[0].nodePath === 'x/y').toBe(true);
  });

  it('accepts a node whose type is defined', () => {
    const g = mkGraph(
      { service: { description: 'svc' } },
      new Map([node('x/y', { type: 'service' })] as [string, unknown][]),
    );
    expect(checkNodeTypesExist(g)).toEqual([]);
  });
});

describe('checkTypeWithoutWhenWithMapping', () => {
  it('renders a truncated preview for an organizational type with more than three mappings', () => {
    const g = mkGraph(
      { module: { description: 'Grouping only' } }, // no `when` → organizational
      new Map([
        node('foo/bar', { type: 'module', mapping: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] }),
      ] as [string, unknown][]),
    );
    const issues = checkTypeWithoutWhenWithMapping(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('type-without-when-with-mapping');
    // The truncation ellipsis reflects the 2 entries beyond the 3-entry preview.
    const rendered = JSON.stringify(issues[0]);
    expect(rendered).toContain('2 more');
  });
});
