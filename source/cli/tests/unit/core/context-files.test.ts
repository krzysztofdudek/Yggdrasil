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
    // order-service has responsibility.md, interface.md (STANDARD_ARTIFACTS only)
    expect(paths).toContain('.yggdrasil/model/orders/order-service/responsibility.md');
    expect(paths).toContain('.yggdrasil/model/orders/order-service/interface.md');
  });

  it('includes parent yg-node.yaml and artifacts', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('.yggdrasil/model/orders/yg-node.yaml');
    expect(paths).toContain('.yggdrasil/model/orders/responsibility.md');
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

  it('assigns correct layer to each tracked file', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);

    // Own layer: the node's own yg-node.yaml and artifacts
    const ownNodeYaml = files.find((f) => f.path === '.yggdrasil/model/orders/order-service/yg-node.yaml');
    expect(ownNodeYaml).toBeDefined();
    expect(ownNodeYaml?.layer).toBe('own');

    const ownResp = files.find((f) => f.path === '.yggdrasil/model/orders/order-service/responsibility.md');
    expect(ownResp).toBeDefined();
    expect(ownResp?.layer).toBe('own');

    // Hierarchy layer: parent node files
    const hierarchyNodeYaml = files.find((f) => f.path === '.yggdrasil/model/orders/yg-node.yaml');
    expect(hierarchyNodeYaml).toBeDefined();
    expect(hierarchyNodeYaml?.layer).toBe('hierarchy');

    // Aspects layer: aspect files
    const aspectYaml = files.find((f) => f.path === '.yggdrasil/aspects/requires-audit/yg-aspect.yaml');
    expect(aspectYaml).toBeDefined();
    expect(aspectYaml?.layer).toBe('aspects');

    const aspectContent = files.find((f) => f.path === '.yggdrasil/aspects/requires-audit/content.md');
    expect(aspectContent).toBeDefined();
    expect(aspectContent?.layer).toBe('aspects');

    // Flows layer: flow files
    const flowYaml = files.find((f) => f.path === '.yggdrasil/flows/checkout-flow/yg-flow.yaml');
    expect(flowYaml).toBeDefined();
    expect(flowYaml?.layer).toBe('flows');

    // Source layer: mapped source files
    const sourceFile = files.find((f) => f.path === 'src/orders/order.service.ts');
    expect(sourceFile).toBeDefined();
    expect(sourceFile?.layer).toBe('source');
    expect(sourceFile?.category).toBe('source');

    // Relational layer: dependency artifacts
    const relationalFile = files.find((f) => f.path === '.yggdrasil/model/auth/auth-api/responsibility.md');
    expect(relationalFile).toBeDefined();
    expect(relationalFile?.layer).toBe('relational');
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

    // Should include included_in_relations artifacts from dep (responsibility.md and interface.md)
    expect(paths).toContain('.yggdrasil/model/dep/svc/responsibility.md');
    expect(paths).toContain('.yggdrasil/model/dep/svc/interface.md');
    // description.md is not in STANDARD_ARTIFACTS, so should NOT appear
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

  it('includes event relation target artifacts (emits/listens)', () => {
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

    // Event relations should now include target artifacts
    expect(paths).toContain('.yggdrasil/model/events/bus/responsibility.md');
  });

  it('uses included_in_relations filter for event relation targets', () => {
    const target: GraphNode = {
      path: 'events/bus',
      meta: { name: 'EventBus', type: 'service' },
      artifacts: [
        { filename: 'responsibility.md', content: 'events' },
        { filename: 'interface.md', content: 'api' },
      ],
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

    // With included_in_relations, event relation includes responsibility.md and interface.md
    expect(paths).toContain('.yggdrasil/model/events/bus/responsibility.md');
    expect(paths).toContain('.yggdrasil/model/events/bus/interface.md');
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

  it('tracks target yg-node.yaml when dependency has integration_anchors', () => {
    const target: GraphNode = {
      path: 'dep/svc',
      meta: {
        name: 'DepSvc',
        type: 'service',
        integration_aspects: ['correlation-id'],
      },
      artifacts: [
        { filename: 'responsibility.md', content: 'resp' },
        { filename: 'interface.md', content: 'api' },
      ],
      children: [],
      parent: null,
    };
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'dep/svc', type: 'calls' }],
      },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: { description: 'x' } },
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

    // Target with integration_aspects should have a synthetic hash entry (not full yg-node.yaml)
    expect(paths).toContain('integration-anchors:dep/svc');
    expect(paths).not.toContain('.yggdrasil/model/dep/svc/yg-node.yaml');
    // Its layer should be relational
    const tracked = files.find(f => f.path === 'integration-anchors:dep/svc');
    expect(tracked?.layer).toBe('relational');
    expect(tracked?.syntheticHash).toBeDefined();
  });

  it('does NOT track target yg-node.yaml when dependency has no integration_aspects', () => {
    const target: GraphNode = {
      path: 'dep/svc',
      meta: {
        name: 'DepSvc',
        type: 'service',
        // No integration_aspects
      },
      artifacts: [
        { filename: 'responsibility.md', content: 'resp' },
        { filename: 'interface.md', content: 'api' },
      ],
      children: [],
      parent: null,
    };
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'dep/svc', type: 'calls' }],
      },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: { description: 'x' } },
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

    // Target without integration_anchors should NOT have yg-node.yaml tracked
    expect(paths).not.toContain('.yggdrasil/model/dep/svc/yg-node.yaml');
  });

  it('does NOT track target yg-node.yaml when integration_anchors is empty array', () => {
    const target: GraphNode = {
      path: 'dep/svc',
      meta: {
        name: 'DepSvc',
        type: 'service',
        integration_anchors: [], // empty
      },
      artifacts: [
        { filename: 'responsibility.md', content: 'resp' },
      ],
      children: [],
      parent: null,
    };
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'dep/svc', type: 'calls' }],
      },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: { description: 'x' } },
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

    // Empty integration_anchors should not trigger tracking
    expect(paths).not.toContain('.yggdrasil/model/dep/svc/yg-node.yaml');
  });

  it('deduplicates aspect files inherited from both own and ancestor', () => {
    const parent: GraphNode = {
      path: 'orders',
      meta: { name: 'Orders', type: 'module', aspects: ['requires-audit'] },
      artifacts: [],
      children: [],
      parent: null,
    };
    const child: GraphNode = {
      path: 'orders/order-service',
      meta: { name: 'OrderService', type: 'service', aspects: ['requires-audit'] },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent,
    };
    parent.children = [child];

    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { module: { description: 'x' }, service: { description: 'x' } },
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

  it('includes dependency ancestor files (included_in_relations artifacts)', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // order-service depends on auth/auth-api. auth-api's parent is auth/.
    // auth/ should have its included_in_relations artifacts tracked.
    const authParentFiles = paths.filter((p) => p.includes('model/auth/') && !p.includes('auth-api'));
    expect(authParentFiles.length).toBeGreaterThan(0);
  });

  it('includes event relation target files and ancestors', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const node = graph.nodes.get('orders/order-service')!;
    const originalRelations = node.meta.relations ?? [];
    node.meta.relations = [
      ...originalRelations,
      { type: 'emits', target: 'auth/auth-api', event_name: 'order.created' },
    ];

    const files = collectTrackedFiles(node, graph);
    const paths = files.map((f) => f.path);

    // auth/auth-api's artifacts should be tracked (event relation target)
    const authApiFiles = paths.filter(p => p.includes('model/auth/auth-api/'));
    expect(authApiFiles.length).toBeGreaterThan(0);

    // auth/ ancestor should also be tracked
    const authParentFiles = paths.filter(p =>
      p.includes('model/auth/') && !p.includes('auth-api') && !p.includes('auth-service')
    );
    expect(authParentFiles.length).toBeGreaterThan(0);

    // Restore original relations
    node.meta.relations = originalRelations;
  });

  it('falls back to config-allowed artifacts when no included_in_relations match', () => {
    const target: GraphNode = {
      path: 'dep/svc',
      meta: { name: 'DepSvc', type: 'service' },
      artifacts: [
        // Only internals.md which has included_in_relations=false
        // So structuralArts will be empty, triggering the fallback
        { filename: 'internals.md', content: 'impl' },
        { filename: 'custom.md', content: 'custom' },
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
    const config: YggConfig = {
      name: 'T',
      node_types: { service: { description: 'x' } },
    };
    const graph: Graph = {
      config,
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

    // When target has no included_in_relations artifacts, fallback to all config-allowed
    // internals.md is in STANDARD_ARTIFACTS (config-allowed)
    expect(paths).toContain('.yggdrasil/model/dep/svc/internals.md');
    // custom.md is not in STANDARD_ARTIFACTS, so should not appear
    expect(paths).not.toContain('.yggdrasil/model/dep/svc/custom.md');
  });
});
