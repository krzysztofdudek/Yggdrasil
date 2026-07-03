import { describe, it, expect } from 'vitest';
import { checkMappingEscapesRepo } from '../../../src/core/checks/mapping.js';
import type { Graph } from '../../../src/model/graph.js';

/**
 * Branch-coverage tests for the mapping-escapes-repo validator: a node mapping that is an
 * absolute path, or one that climbs above the repository root with `..`, must be rejected
 * so a node can never claim files outside the project (which would bypass enforcement).
 */

function mkGraph(nodes: Map<string, unknown>): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes,
    aspects: [],
    flows: [],
    rootPath: '/repo/.yggdrasil',
  } as unknown as Graph;
}

function node(nodePath: string, mapping: string[]): [string, unknown] {
  return [nodePath, { path: nodePath, meta: { name: nodePath, type: 'service', mapping }, children: [], parent: null }];
}

describe('checkMappingEscapesRepo', () => {
  it('flags a mapping that climbs above the repository root with ..', () => {
    const g = mkGraph(new Map([node('x/y', ['../outside/secret.ts'])] as [string, unknown][]));
    const issues = checkMappingEscapesRepo(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('mapping-escapes-repo');
    expect(issues[0].nodePath).toBe('x/y');
  });

  it('flags an absolute mapping path', () => {
    const g = mkGraph(new Map([node('x/y', ['/etc/passwd'])] as [string, unknown][]));
    const issues = checkMappingEscapesRepo(g);
    expect(issues.some((i) => i.code === 'mapping-escapes-repo')).toBe(true);
  });

  it('accepts a well-formed repo-relative mapping', () => {
    const g = mkGraph(new Map([node('x/y', ['src/x/y.ts'])] as [string, unknown][]));
    expect(checkMappingEscapesRepo(g)).toEqual([]);
  });
});
