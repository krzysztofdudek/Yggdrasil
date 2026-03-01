import { describe, it, expect } from 'vitest';
import type { Graph, GraphNode } from '../../../src/model/types.js';
import { findOwner } from '../../../src/cli/owner.js';

function createNode(nodePath: string, mapping: { paths: string[] }): GraphNode {
  return {
    path: nodePath,
    meta: {
      name: nodePath,
      type: 'service',
      mapping,
    },
    artifacts: [{ filename: 'responsibility.md', content: 'x' }],
    children: [],
    parent: null,
  };
}

function createGraph(nodes: Array<[string, GraphNode]>): Graph {
  return {
    config: {
      name: 'Test',
      stack: {},
      standards: '',
      tags: [],
      node_types: [{ name: 'service' }],
      artifacts: { responsibility: { required: 'always', description: 'x' } },
    },
    nodes: new Map(nodes),
    aspects: [],
    flows: [],
    schemas: [],
    rootPath: '/workspace/project/.yggdrasil',
  };
}

describe('owner command (findOwner)', () => {
  it('returns exact match when query equals mapping path', () => {
    const graph = createGraph([
      [
        'svc/validator',
        createNode('svc/validator', { paths: ['src/core/validator.ts'] }),
      ],
    ]);

    const result = findOwner(graph, '/workspace/project', 'src/core/validator.ts');

    expect(result.file).toBe('src/core/validator.ts');
    expect(result.nodePath).toBe('svc/validator');
    expect(result.mappingPath).toBe('src/core/validator.ts');
  });

  it('returns contained match when query is inside mapped directory', () => {
    const graph = createGraph([
      ['svc/core', createNode('svc/core', { paths: ['src/core'] })],
    ]);

    const result = findOwner(graph, '/workspace/project', 'src/core/validator.ts');

    expect(result.nodePath).toBe('svc/core');
    expect(result.mappingPath).toBe('src/core');
  });

  it('returns no match when mapping is missing', () => {
    const graph = createGraph([
      ['svc/other', createNode('svc/other', { paths: ['src/other/file.ts'] })],
    ]);

    const result = findOwner(graph, '/workspace/project', 'src/core/validator.ts');

    expect(result.nodePath).toBeNull();
  });

  it('throws for paths outside project root', () => {
    const graph = createGraph([
      [
        'svc/validator',
        createNode('svc/validator', { paths: ['src/core/validator.ts'] }),
      ],
    ]);

    expect(() => findOwner(graph, '/workspace/project', '../outside.ts')).toThrow(
      'outside project root',
    );
  });
});
