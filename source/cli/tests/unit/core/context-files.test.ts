import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTrackedFiles } from '../../../src/core/context-files.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode } from '../../../src/model/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

describe('collectTrackedFiles', () => {
  it('includes own yg-node.yaml and artifacts', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/model/orders/order-service/yg-node.yaml');
    // order-service has responsibility.md, description.md artifacts (config-allowed)
    expect(paths).toContain('.yggdrasil/model/orders/order-service/responsibility.md');
    expect(paths).toContain('.yggdrasil/model/orders/order-service/description.md');
  });

  it('includes parent yg-node.yaml and artifacts', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/model/orders/yg-node.yaml');
    expect(paths).toContain('.yggdrasil/model/orders/responsibility.md');
    expect(paths).toContain('.yggdrasil/model/orders/description.md');
  });

  it('includes aspect files', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // orders/order-service has requires-audit aspect
    expect(paths).toContain('.yggdrasil/aspects/requires-audit/yg-aspect.yaml');
    expect(paths).toContain('.yggdrasil/aspects/requires-audit/content.md');
  });

  it('includes flow files', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // orders/order-service participates in checkout-flow
    expect(paths).toContain('.yggdrasil/flows/checkout-flow/yg-flow.yaml');
    expect(paths).toContain('.yggdrasil/flows/checkout-flow/description.md');
  });

  it('includes source files from mapping', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('src/orders/order.service.ts');
  });

  it('categorizes files as source or graph', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);

    const sourceFiles = files.filter((f) => f.category === 'source');
    const graphFiles = files.filter((f) => f.category === 'graph');

    // Source files should not start with .yggdrasil/
    for (const f of sourceFiles) {
      expect(f.path).not.toMatch(/^\.yggdrasil\//);
    }

    // Graph files should start with .yggdrasil/
    for (const f of graphFiles) {
      expect(f.path).toMatch(/^\.yggdrasil\//);
    }

    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(graphFiles.length).toBeGreaterThan(0);
  });

  it('no duplicate paths', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    expect(new Set(paths).size).toBe(paths.length);
  });

  it('returns empty source files for nodes without mapping', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // 'orders' is a module node with no mapping
    const node = graph.nodes.get('orders')!;
    const files = collectTrackedFiles(node, graph);

    const sourceFiles = files.filter((f) => f.category === 'source');
    const graphFiles = files.filter((f) => f.category === 'graph');

    expect(sourceFiles).toHaveLength(0);
    expect(graphFiles.length).toBeGreaterThan(0);

    // Should still have its own yg-node.yaml and artifacts
    const paths = files.map((f) => f.path);
    expect(paths).toContain('.yggdrasil/model/orders/yg-node.yaml');
  });

  it('includes relational dependency artifacts', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // order-service uses auth/auth-api and users/user-repo
    // Since the fixture config has no included_in_relations artifacts,
    // it falls back to all config-allowed artifacts on the target
    expect(paths).toContain('.yggdrasil/model/auth/auth-api/responsibility.md');
    expect(paths).toContain('.yggdrasil/model/users/user-repo/responsibility.md');
  });

  it('uses included_in_relations artifacts when configured', () => {
    // Build a synthetic graph where config has included_in_relations
    const target: GraphNode = {
      path: 'dep/svc',
      meta: { name: 'DepSvc', type: 'service' },
      artifacts: [
        { filename: 'responsibility.md', content: 'resp' },
        { filename: 'interface.md', content: 'api' },
        { filename: 'description.md', content: 'desc' },
      ],
      children: [],
      parent: null,
    };
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'dep/svc', type: 'uses' }],
      },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: { description: 'x' } },
        artifacts: {
          'responsibility.md': { required: 'always', description: 'x' },
          'interface.md': { required: 'never', description: 'x', included_in_relations: true },
          'description.md': { required: 'never', description: 'x' },
        },
      },
      nodes: new Map([
        ['my/svc', node],
        ['dep/svc', target],
      ]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // Should include only the included_in_relations artifact from dep
    expect(paths).toContain('.yggdrasil/model/dep/svc/interface.md');
    // Should NOT include non-structural artifacts from the dep
    expect(paths).not.toContain('.yggdrasil/model/dep/svc/responsibility.md');
    expect(paths).not.toContain('.yggdrasil/model/dep/svc/description.md');
  });

  it('flow participation checks ancestor paths', () => {
    const parent: GraphNode = {
      path: 'orders',
      meta: { name: 'Orders', type: 'module' },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const child: GraphNode = {
      path: 'orders/order-service',
      meta: { name: 'OrderService', type: 'service' },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent,
    };
    parent.children = [child];

    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { module: { description: 'x' }, service: { description: 'x' } },
        artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
      },
      nodes: new Map([
        ['orders', parent],
        ['orders/order-service', child],
      ]),
      aspects: [],
      flows: [
        {
          path: 'parent-flow',
          name: 'Parent Flow',
          nodes: ['orders'],  // only the parent is listed
          artifacts: [{ filename: 'description.md', content: 'Flow desc' }],
        },
      ],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    // Child node should still pick up the flow through ancestor
    const files = collectTrackedFiles(child, graph);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/flows/parent-flow/yg-flow.yaml');
    expect(paths).toContain('.yggdrasil/flows/parent-flow/description.md');
  });

  it('handles nodes without aspects', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // 'users' module has no aspects
    const node = graph.nodes.get('users')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // Should still have node files
    expect(paths).toContain('.yggdrasil/model/users/yg-node.yaml');
    // Should not have aspect files
    const aspectPaths = paths.filter((p) => p.includes('/aspects/'));
    expect(aspectPaths).toHaveLength(0);
  });

  it('handles nodes without relations', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // 'users' module has no relations
    const node = graph.nodes.get('users')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // Should have own files but no dep artifacts from other nodes
    expect(paths).toContain('.yggdrasil/model/users/yg-node.yaml');
    // Should not have auth or order node files (those are only via relations)
    const otherModelPaths = paths.filter(
      (p) => p.startsWith('.yggdrasil/model/') && !p.startsWith('.yggdrasil/model/users'),
    );
    expect(otherModelPaths).toHaveLength(0);
  });

  it('skips event relation types (emits/listens)', () => {
    const target: GraphNode = {
      path: 'events/bus',
      meta: { name: 'EventBus', type: 'service' },
      artifacts: [{ filename: 'responsibility.md', content: 'events' }],
      children: [],
      parent: null,
    };
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'events/bus', type: 'emits' }],
      },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: { description: 'x' } },
        artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
      },
      nodes: new Map([
        ['my/svc', node],
        ['events/bus', target],
      ]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // Event relations should NOT include target artifacts
    expect(paths).not.toContain('.yggdrasil/model/events/bus/responsibility.md');
  });

  it('skips relations with missing targets', () => {
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'nonexistent/svc', type: 'calls' }],
      },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: { description: 'x' } },
        artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
      },
      nodes: new Map([['my/svc', node]]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    // Should not throw, just skip the broken relation
    const files = collectTrackedFiles(node, graph);
    expect(files.length).toBeGreaterThan(0);
  });

  it('deduplicates aspect files inherited from both own and ancestor', () => {
    const parent: GraphNode = {
      path: 'orders',
      meta: { name: 'Orders', type: 'module', aspects: [{ aspect: 'requires-audit' }] },
      artifacts: [],
      children: [],
      parent: null,
    };
    const child: GraphNode = {
      path: 'orders/order-service',
      meta: { name: 'OrderService', type: 'service', aspects: [{ aspect: 'requires-audit' }] },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent,
    };
    parent.children = [child];

    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { module: { description: 'x' }, service: { description: 'x' } },
        artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
      },
      nodes: new Map([
        ['orders', parent],
        ['orders/order-service', child],
      ]),
      aspects: [
        {
          name: 'Audit',
          id: 'requires-audit',
          artifacts: [{ filename: 'content.md', content: 'Audit rules' }],
        },
      ],
      flows: [],
      schemas: [],
      rootPath: '/project/.yggdrasil',
    };

    const files = collectTrackedFiles(child, graph);
    const paths = files.map((f) => f.path);

    // requires-audit appears in both parent and child aspects,
    // but aspect files should only appear once
    const auditPaths = paths.filter((p) => p.includes('requires-audit'));
    expect(auditPaths).toHaveLength(2); // yg-aspect.yaml + content.md
    expect(new Set(paths).size).toBe(paths.length);
  });
});
