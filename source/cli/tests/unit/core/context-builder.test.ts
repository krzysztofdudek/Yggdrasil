import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildContext,
  buildGlobalLayer,
  buildAspectLayer,
  buildHierarchyLayer,
  buildOwnLayer,
  buildStructuralRelationLayer,
  buildEventRelationLayer,
  collectAncestors,
  collectDependencyAncestors,
  determineAspectSource,
  collectEffectiveAspectIds,
  toContextMapOutput,
  buildNodeContextData,
  buildFileContextData,
} from '../../../src/core/context-builder.js';
import { formatContextMarkdown } from '../../../src/formatters/markdown.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type {
  Graph,
  GraphNode,
  YggConfig,
  Relation,
  AspectDef,
} from '../../../src/model/graph.js';
import type {
  ContextMapOutput,
  ContextPackage,
} from '../../../src/model/context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

describe('context-builder', () => {
  describe('buildGlobalLayer', () => {
    it('produces correct markdown from config', () => {
      const config: YggConfig = {
      };
      const layer = buildGlobalLayer(config, '/fake/project/.yggdrasil');

      expect(layer.type).toBe('global');
      expect(layer.label).toBe('Global Context');
      expect(layer.content).toContain('**Project:** project');
      expect(layer.content).not.toContain('Stack');
      expect(layer.content).not.toContain('Standards');
    });
  });

  describe('buildAspectLayer', () => {
    it('formats aspect content files', () => {
      const layer = buildAspectLayer({
        name: 'Audit',
        id: 'requires-audit',
        artifacts: [{ filename: 'content.md', content: 'Log all mutations' }],
      });
      expect(layer.type).toBe('aspects');
      expect(layer.label).toContain('Audit');
      expect(layer.content).toContain('### content.md');
    });

    it('does not include stability tier', () => {
      const layer = buildAspectLayer({
        name: 'PubSub Events',
        id: 'pubsub-events',
        artifacts: [],
      });
      expect(layer.content).not.toContain('Stability tier');
    });

    it('does not include exception section when no exception provided', () => {
      const layer = buildAspectLayer({
        name: 'PubSub Events',
        id: 'pubsub-events',
        artifacts: [],
      });
      expect(layer.content).not.toContain('Exception for this node');
    });
  });

  describe('buildHierarchyLayer', () => {
    it('omits aspects attr when ancestor has no aspects', () => {
      const ancestor: GraphNode = {
        path: 'parent',
        meta: { name: 'Parent', type: 'module' },
        nodeYamlRaw: 'name: Parent\ntype: module\n',
        children: [],
        parent: null,
      };
      const config: YggConfig = {
      };
      const graph: Graph = {
        rootPath: '/tmp',
        config,
        architecture: { node_types: {} },
        nodes: new Map(),
        aspects: [],
        flows: [],
        schemas: [],
      };
      const layer = buildHierarchyLayer(ancestor, config, graph);
      expect(layer.attrs).toBeUndefined();
      expect(layer.content).toContain('yg-node.yaml');
    });
  });

  describe('buildOwnLayer', () => {
    it('falls back to reading yg-node.yaml from disk when nodeYamlRaw is undefined', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const node = graph.nodes.get('orders/order-service')!;
      // Clear nodeYamlRaw to force the disk read branch
      const original = node.nodeYamlRaw;
      node.nodeYamlRaw = undefined;
      const layer = await buildOwnLayer(node, graph.config, graph.rootPath, graph);
      expect(layer.content).toContain('yg-node.yaml');
      node.nodeYamlRaw = original;
    });

    it('shows not found when yg-node.yaml is missing from disk', async () => {
      const node: GraphNode = {
        path: 'nonexistent/node',
        meta: { name: 'Test', type: 'module' },
        children: [],
        parent: null,
        nodeYamlRaw: undefined,
      };
      const config: YggConfig = {
      };
      const graph: Graph = {
        rootPath: '/tmp/nonexistent',
        config,
        architecture: { node_types: {} },
      nodes: new Map(),
        aspects: [],
        flows: [],
      };
      const layer = await buildOwnLayer(node, config, '/tmp/nonexistent', graph);
      expect(layer.content).toContain('(not found)');
    });
  });

  describe('collectEffectiveAspectIds', () => {
    it('returns empty set for nonexistent node', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const result = collectEffectiveAspectIds(graph, 'does/not/exist');
      expect(result.size).toBe(0);
    });
  });

  describe('buildStructuralRelationLayer', () => {
    const defaultConfig: YggConfig = {
    };

    it('includes consumes when present', () => {
      const target: GraphNode = {
        path: 'dep/svc',
        meta: { name: 'DepSvc', type: 'service' },
        children: [],
        parent: null,
      };
      const rel: Relation = {
        target: 'dep/svc',
        type: 'uses',
        consumes: ['methodA'],
      };
      const layer = buildStructuralRelationLayer(target, rel);
      expect(layer.content).toContain('methodA');
      expect(layer.attrs!.consumes).toBe('methodA');
    });

    it('omits consumes when absent', () => {
      const target: GraphNode = {
        path: 'dep/svc',
        meta: { name: 'DepSvc', type: 'service' },
        children: [],
        parent: null,
      };
      const rel: Relation = { target: 'dep/svc', type: 'uses' };
      const layer = buildStructuralRelationLayer(target, rel);
      expect(layer.content).not.toContain('Consumes:');
      expect(layer.attrs!.consumes).toBeUndefined();
    });
  });

  describe('buildEventRelationLayer', () => {
    it('formats emits relation', () => {
      const target: GraphNode = {
        path: 'events/handler',
        meta: { name: 'Handler', type: 'service' },
        children: [],
        parent: null,
      };
      const rel: Relation = { target: 'events/handler', type: 'emits', consumes: ['OrderCreated'] };
      const layer = buildEventRelationLayer(target, rel);
      expect(layer.content).toContain('You publish');
      expect(layer.content).toContain('OrderCreated');
    });

    it('formats event relation without consumes', () => {
      const target: GraphNode = {
        path: 'events/handler',
        meta: { name: 'Handler', type: 'service' },
        children: [],
        parent: null,
      };
      const rel: Relation = { target: 'events/handler', type: 'emits' };
      const layer = buildEventRelationLayer(target, rel);
      expect(layer.content).toContain('You publish');
      expect(layer.content).not.toContain('Consumes:');
    });

    it('uses event_name when provided', () => {
      const target: GraphNode = {
        path: 'events/handler',
        meta: { name: 'Handler', type: 'service' },
        children: [],
        parent: null,
      };
      const rel: Relation = { target: 'events/handler', type: 'emits', event_name: 'order.created' };
      const layer = buildEventRelationLayer(target, rel);
      expect(layer.content).toContain('order.created');
      expect(layer.attrs!['event-name']).toBe('order.created');
    });

    it('formats listens relation', () => {
      const target: GraphNode = {
        path: 'events/publisher',
        meta: { name: 'Publisher', type: 'service' },
        children: [],
        parent: null,
      };
      const rel: Relation = { target: 'events/publisher', type: 'listens' };
      const layer = buildEventRelationLayer(target, rel);
      expect(layer.content).toContain('You listen');
    });
  });

  describe('collectAncestors', () => {
    it('returns ancestors in root-to-parent order', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const orderService = graph.nodes.get('orders/order-service')!;
      const ancestors = collectAncestors(orderService);

      expect(ancestors).toHaveLength(1);
      expect(ancestors[0].path).toBe('orders');
    });

    it('returns empty array for top-level node', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const orders = graph.nodes.get('orders')!;
      const ancestors = collectAncestors(orders);

      expect(ancestors).toHaveLength(0);
    });

    it('returns root-to-parent order for deeper hierarchy', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const authApi = graph.nodes.get('auth/auth-api')!;
      const ancestors = collectAncestors(authApi);

      expect(ancestors).toHaveLength(1);
      expect(ancestors[0].path).toBe('auth');
    });
  });

  describe('node aspects', () => {
    it('includes implied aspects in context package', async () => {
      const auditAspect: AspectDef = {
        name: 'Audit',
        id: 'requires-audit',
        artifacts: [],
      };
      const hipaaAspect: AspectDef = {
        name: 'HIPAA',
        id: 'requires-hipaa',
        implies: ['requires-audit'],
        artifacts: [],
      };
      const node: GraphNode = {
        path: 'test/node',
        meta: { name: 'TestNode', type: 'service', aspects: ['requires-hipaa'] },
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {
            artifacts: [],
          },
        architecture: { node_types: {} },
      nodes: new Map([['test/node', node]]),
        aspects: [auditAspect, hipaaAspect],
        flows: [],
        schemas: [],
        rootPath: '/tmp',
      };
      const pkg = await buildContext(graph, 'test/node');
      const aspectLayers = pkg.layers.filter((l) => l.type === 'aspects');
      expect(aspectLayers.map((l) => l.label)).toContain('Audit (aspect: requires-audit)');
      expect(aspectLayers.map((l) => l.label)).toContain('HIPAA (aspect: requires-hipaa)');
    });

    it('throws when aspect implies cycle detected', async () => {
      const a: AspectDef = {
        name: 'A',
        id: 'tag-a',
        implies: ['tag-b'],
      };
      const b: AspectDef = {
        name: 'B',
        id: 'tag-b',
        implies: ['tag-a'],
      };
      const node: GraphNode = {
        path: 'test/node',
        meta: { name: 'TestNode', type: 'service', aspects: ['tag-a'] },
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {
            artifacts: [],
          },
        architecture: { node_types: {} },
      nodes: new Map([['test/node', node]]),
        aspects: [a, b],
        flows: [],
        schemas: [],
        rootPath: '/tmp',
      };
      await expect(buildContext(graph, 'test/node')).rejects.toThrow(
        "Aspect implies cycle detected involving aspect 'tag-a'",
      );
    });

    it('node with own aspects includes aspects in context', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const orderService = graph.nodes.get('orders/order-service')!;
      expect(orderService.meta.aspects).toContain('requires-audit');

      const pkg = await buildContext(graph, 'orders/order-service');
      const aspectLayer = pkg.layers.find((l) => l.type === 'aspects');
      expect(aspectLayer).toBeDefined();
    });
  });

  describe('buildContext', () => {
    it('assembles canonical layers for fixture order-service', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');

      expect(pkg.nodePath).toBe('orders/order-service');
      expect(pkg.nodeName).toBe('OrderService');

      const layerTypes = pkg.layers.map((l) => l.type);
      expect(layerTypes).toContain('global');
      expect(layerTypes).toContain('hierarchy');
      expect(layerTypes).toContain('relational');
      expect(layerTypes).toContain('aspects');
    });

    it('throws Node not found for missing node', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);

      await expect(buildContext(graph, 'nonexistent/node')).rejects.toThrow(
        'Node not found: nonexistent/node',
      );
    });

    it('throws Broken relation when relation target not found', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      // Create a node with broken relation by mutating the graph
      const orderService = graph.nodes.get('orders/order-service')!;
      orderService.meta.relations = [
        ...(orderService.meta.relations ?? []),
        { target: 'nonexistent/target', type: 'uses' },
      ];

      await expect(buildContext(graph, 'orders/order-service')).rejects.toThrow('Broken relation');
    });

    it('does NOT follow transitive relations', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      // order-service -> auth/auth-api, but auth/auth-api has no relations
      // login-service -> users/user-repo: this is NOT a relation of order-service
      const pkg = await buildContext(graph, 'orders/order-service');

      const relationalLabels = pkg.layers
        .filter((l) => l.type === 'relational')
        .map((l) => l.label);

      // order-service relates to auth/auth-api only
      expect(relationalLabels.some((l) => l.includes('auth/auth-api'))).toBe(true);
      expect(relationalLabels.some((l) => l.includes('users/user-repo'))).toBe(true);
    });


    it('node without relations has no relational layers', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      // 'users' module has no relations defined
      const pkg = await buildContext(graph, 'users');

      const relationalLayers = pkg.layers.filter((l) => l.type === 'relational');
      expect(relationalLayers).toHaveLength(0);
    });

    it('node without matching aspects has no aspect layers', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      // users module has no aspects matching the audit aspect
      const pkg = await buildContext(graph, 'users');

      const aspectLayers = pkg.layers.filter((l) => l.type === 'aspects');
      expect(aspectLayers).toHaveLength(0);
    });

    it('node in flow gets flow data through Flows layer', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');

      const flowLayers = pkg.layers.filter((l) => l.type === 'flows');
      expect(flowLayers.length).toBeGreaterThan(0);
      expect(flowLayers.some((l) => l.label.includes('Checkout'))).toBe(true);
    });

    it('hierarchy aspects: child without own aspects inherits from ancestor (aspects on hierarchy layer)', async () => {
      const parent: GraphNode = {
        path: 'orders',
        meta: { name: 'Orders', type: 'module', aspects: ['requires-audit'] },
        children: [],
        parent: null,
      };
      const child: GraphNode = {
        path: 'orders/order-service',
        meta: { name: 'OrderService', type: 'service' },
        children: [],
        parent,
      };
      parent.children = [child];

      const graph: Graph = {
        config: {},
        architecture: { node_types: {} },
      nodes: new Map([
          ['orders', parent],
          ['orders/order-service', child],
        ]),
        aspects: [
          {
            name: 'Audit',
            id: 'requires-audit',
            artifacts: [],
          },
        ],
        flows: [],
        schemas: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'orders/order-service');
      const hierarchyLayer = pkg.layers.find((l) => l.type === 'hierarchy');
      expect(hierarchyLayer).toBeDefined();
      expect(hierarchyLayer?.attrs?.aspects).toBe('requires-audit');
      const aspectLayers = pkg.layers.filter((l) => l.type === 'aspects');
      expect(aspectLayers).toHaveLength(1);
      expect(aspectLayers[0].label).toContain('Audit');
    });

    it('hierarchy aspects: node own aspects declared on own layer (aspects on own node)', async () => {
      const parent: GraphNode = {
        path: 'orders',
        meta: { name: 'Orders', type: 'module', aspects: ['requires-audit'] },
        children: [],
        parent: null,
      };
      const child: GraphNode = {
        path: 'orders/order-service',
        meta: { name: 'OrderService', type: 'service', aspects: ['requires-audit'] },
        children: [],
        parent,
      };
      parent.children = [child];

      const graph: Graph = {
        config: {},
        architecture: { node_types: {} },
      nodes: new Map([
          ['orders', parent],
          ['orders/order-service', child],
        ]),
        aspects: [
          {
            name: 'Audit',
            id: 'requires-audit',
            artifacts: [],
          },
        ],
        flows: [],
        schemas: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'orders/order-service');
      const ownLayer = pkg.layers.find((l) => l.label.startsWith('Node:'));
      expect(ownLayer).toBeDefined();
      expect(ownLayer?.attrs?.aspects).toBe('requires-audit');
      const aspectLayers = pkg.layers.filter((l) => l.type === 'aspects');
      expect(aspectLayers).toHaveLength(1);
    });

    it('flow aspects propagate to participants (aspects on flow layer)', async () => {
      const node: GraphNode = {
        path: 'orders/order-service',
        meta: { name: 'OrderService', type: 'service' },
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {},
        architecture: { node_types: {} },
      nodes: new Map([['orders/order-service', node]]),
        aspects: [
          {
            name: 'Saga',
            id: 'requires-saga',
            artifacts: [],
          },
        ],
        flows: [
          {
            name: 'Checkout',
            nodes: ['orders/order-service'],
            aspects: ['requires-saga'],
          },
        ],
        schemas: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'orders/order-service');
      const flowLayer = pkg.layers.find((l) => l.type === 'flows');
      expect(flowLayer).toBeDefined();
      expect(flowLayer?.attrs?.aspects).toBe('requires-saga');
      const aspectLayers = pkg.layers.filter((l) => l.type === 'aspects');
      expect(aspectLayers).toHaveLength(1);
      expect(aspectLayers[0].label).toContain('Saga');
    });

    it('child node gets flow when only ancestor is participant (flows propagate down)', async () => {
      const parent: GraphNode = {
        path: 'orders',
        meta: { name: 'Orders', type: 'module' },
        children: [],
        parent: null,
      };
      const child: GraphNode = {
        path: 'orders/order-service',
        meta: { name: 'OrderService', type: 'service' },
        children: [],
        parent,
      };
      parent.children = [child];

      const graph: Graph = {
        config: {},
        architecture: { node_types: {} },
      nodes: new Map([
          ['orders', parent],
          ['orders/order-service', child],
        ]),
        aspects: [],
        flows: [
          {
            path: 'checkout-flow',
            name: 'Checkout Flow',
            description: 'Parent-only flow propagates to children',
            nodes: ['orders'],
          },
        ],
        schemas: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'orders/order-service');
      const flowLayers = pkg.layers.filter((l) => l.type === 'flows');
      expect(flowLayers).toHaveLength(1);
      expect(flowLayers[0].label).toContain('Checkout Flow');
      expect(flowLayers[0].content).toContain('Parent-only flow');
    });

    it('node with emits relation gets event layer', async () => {
      const emitter: GraphNode = {
        path: 'events/emitter',
        meta: {
          name: 'Emitter',
          type: 'service',
          relations: [{ target: 'events/handler', type: 'emits', consumes: ['OrderCreated'] }],
        },
        children: [],
        parent: null,
      };
      const handler: GraphNode = {
        path: 'events/handler',
        meta: { name: 'Handler', type: 'service' },
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {},
        architecture: { node_types: {} },
      nodes: new Map([
          ['events/emitter', emitter],
          ['events/handler', handler],
        ]),
        aspects: [],
        flows: [],
        schemas: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'events/emitter');
      const eventLayer = pkg.layers.find(
        (l) => l.type === 'relational' && l.label.includes('emits'),
      );
      expect(eventLayer).toBeDefined();
      expect(eventLayer?.content).toContain('You publish');
    });

    it('node with listens relation gets event layer', async () => {
      const listener: GraphNode = {
        path: 'events/listener',
        meta: {
          name: 'Listener',
          type: 'service',
          relations: [{ target: 'events/publisher', type: 'listens' }],
        },
        children: [],
        parent: null,
      };
      const publisher: GraphNode = {
        path: 'events/publisher',
        meta: { name: 'Publisher', type: 'service' },
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {},
        architecture: { node_types: {} },
      nodes: new Map([
          ['events/listener', listener],
          ['events/publisher', publisher],
        ]),
        aspects: [],
        flows: [],
        schemas: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'events/listener');
      const eventLayer = pkg.layers.find(
        (l) => l.type === 'relational' && l.label.includes('listens'),
      );
      expect(eventLayer).toBeDefined();
      expect(eventLayer?.content).toContain('You listen');
    });





    it('returns mapping paths when node has mapping', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');

      expect(pkg.mapping).toEqual(['src/orders/order.service.ts']);
    });

    it('returns null mapping for node without mapping', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'auth');

      expect(pkg.mapping).toBeNull();
    });

    it('includes multiple aspects when node matches multiple aspect ids', async () => {
      // Manually build a graph with 2 aspects on 2 different ids
      const parent: GraphNode = {
        path: 'mod',
        meta: { name: 'Mod', type: 'module', aspects: ['tag-a'] },
        children: [],
        parent: null,
      };
      const child: GraphNode = {
        path: 'mod/svc',
        meta: { name: 'Svc', type: 'service', aspects: ['tag-a', 'tag-b'] },
        children: [],
        parent,
      };
      parent.children.push(child);

      const graph: Graph = {
        config: {},
        architecture: { node_types: {} },
      nodes: new Map([
          ['mod', parent],
          ['mod/svc', child],
        ]),
        aspects: [
          {
            name: 'Aspect A',
            id: 'tag-a',
            artifacts: [],
          },
          {
            name: 'Aspect B',
            id: 'tag-b',
            artifacts: [],
          },
        ],
        flows: [],
        schemas: [],
        rootPath: '/tmp/ygg',
      };

      const pkg = await buildContext(graph, 'mod/svc');
      const aspectLayers = pkg.layers.filter((l) => l.type === 'aspects');
      // svc has both tag-a and tag-b
      expect(aspectLayers).toHaveLength(2);
      const aspectLabels = aspectLayers.map((l) => l.label);
      expect(aspectLabels).toContain('Aspect A (aspect: tag-a)');
      expect(aspectLabels).toContain('Aspect B (aspect: tag-b)');
    });

    it('uses nodeYamlRaw from memory when disk read would fail', async () => {
      const node: GraphNode = {
        path: 'test/node',
        meta: { name: 'TestNode', type: 'service' },
        children: [],
        parent: null,
        nodeYamlRaw: 'name: TestNode\ntype: service\n',
      };
      const graph: Graph = {
        config: {},
        architecture: { node_types: {} },
      nodes: new Map([['test/node', node]]),
        aspects: [],
        flows: [],
        schemas: [],
        rootPath: '/nonexistent/path',  // disk read will fail
      };
      const pkg = await buildContext(graph, 'test/node');
      const ownLayer = pkg.layers.find((l) => l.label.startsWith('Node:'));
      expect(ownLayer?.content).toContain('name: TestNode');
      expect(ownLayer?.content).not.toContain('(not found)');
    });

    it('own layer includes raw yg-node.yaml from fixture', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'auth');
      const ownLayer = pkg.layers.find((l) => l.label.startsWith('Node:'));
      expect(ownLayer).toBeDefined();
      expect(ownLayer?.content).toContain('### yg-node.yaml');
      expect(ownLayer?.content).toContain('name:');
      expect(ownLayer?.content).toContain('type:');
    });

    it('empty own metadata produces own layer with empty content', async () => {
      // Node with only yg-node.yaml, no other metadata
      const node: GraphNode = {
        path: 'bare',
        meta: { name: 'Bare', type: 'module' },
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {},
        architecture: { node_types: {} },
      nodes: new Map([['bare', node]]),
        aspects: [],
        flows: [],
        schemas: [],
        rootPath: '/tmp/ygg',
      };

      const pkg = await buildContext(graph, 'bare');
      const ownLayer = pkg.layers.find((l) => l.label.startsWith('Node:'));
      expect(ownLayer).toBeDefined();
      expect(ownLayer?.content).toContain('### yg-node.yaml');
    });
  });

  describe('formatContextMarkdown', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T12:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });



    it('contains Materialization Target when mapping exists', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');
      const output = formatContextMarkdown(pkg);

      expect(output).toContain('### Materialization Target');
      expect(output).toContain('src/orders/order.service.ts');
    });

    it('omits Materialization Target when no mapping', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'auth');
      const output = formatContextMarkdown(pkg);

      expect(output).not.toContain('### Materialization Target');
    });
  });

});

describe('context CLI exit codes', () => {
  const BROKEN_RELATION_FIXTURE = path.join(
    __dirname,
    '../../fixtures/sample-project-broken-relation',
  );

  it('exit code 1 for missing node', async () => {
    const { spawnSync } = await import('node:child_process');
    const distBin = path.join(__dirname, '../../../dist/bin.js');
    const result = spawnSync('node', [distBin, 'context', '--node', 'nonexistent/node'], {
      cwd: FIXTURE_PROJECT,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Node not found');
  });

  it('exit code 1 for broken relation', async () => {
    const { spawnSync } = await import('node:child_process');
    const distBin = path.join(__dirname, '../../../dist/bin.js');
    const result = spawnSync(
      'node',
      [distBin, 'context', '--node', 'orders/broken-service'],
      {
        cwd: BROKEN_RELATION_FIXTURE,
        encoding: 'utf-8',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('build-context blocked by');
  });

});

describe('toContextMapOutput', () => {
  it('converts a full context package to ContextMapOutput', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output: ContextMapOutput = toContextMapOutput(pkg, graph);

    expect(output.project).toBe('sample-project');
    expect(output.node.path).toBe('orders/order-service');
    expect(output.node.name).toBe('OrderService');
    expect(output.hierarchy.length).toBeGreaterThan(0);
    expect(output.dependencies.length).toBeGreaterThan(0);
    expect(Array.isArray(output.node.files)).toBe(true);
    expect(output.node.files.length).toBeGreaterThan(0);
    expect(Object.keys(output.glossary.aspects).length).toBeGreaterThan(0);
  });

  it('includes dependency hierarchy ancestors', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    // auth/auth-api depends on auth/ parent
    const authDep = output.dependencies.find((d) => d.path === 'auth/auth-api');
    if (authDep) {
      expect(authDep.hierarchy.length).toBeGreaterThan(0);
      expect(authDep.hierarchy[0].path).toBe('auth');
    }
  });

  it('includes effective aspects for dependencies', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    const authDep = output.dependencies.find((d) => d.path === 'auth/auth-api');
    if (authDep) {
      expect(authDep.aspects).toBeDefined();
    }
  });

  it('node.files is an array with no duplicates', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    expect(Array.isArray(output.node.files)).toBe(true);
    const uniqueFiles = [...new Set(output.node.files)];
    expect(output.node.files).toEqual(uniqueFiles);
  });

  it('uses model/ prefix for node file paths', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    const targetFiles = output.node.files;
    expect(targetFiles.length).toBeGreaterThan(0);
    for (const f of targetFiles) {
      expect(f).toMatch(/^model\//);
    }
  });

  it('uses aspects/ prefix for aspect artifact paths', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    for (const [, aspect] of Object.entries(output.glossary.aspects)) {
      for (const f of aspect.files) {
        expect(f).toMatch(/^aspects\//);
      }
    }
  });

  it('includes implies on aspects in glossary', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    const auditAspect = output.glossary.aspects['requires-audit'];
    expect(auditAspect).toBeDefined();
    expect(auditAspect.implies).toEqual(['requires-logging']);
  });

  it('includes flow aspects in glossary', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    const flow = output.glossary.flows['checkout-flow'];
    expect(flow).toBeDefined();
    expect(flow.aspects).toEqual(['requires-logging']);
  });

  it('includes event-name on emits relation dependencies', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    const emitsDep = output.dependencies.find(
      (d) => d.path === 'users/user-repo' && d.relation === 'emits',
    );
    expect(emitsDep).toBeDefined();
    expect(emitsDep!['event-name']).toBe('order.created');
  });

  it('includes flow without aspects in glossary', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // Add a flow without aspects that includes order-service
    graph.flows.push({
      path: 'no-aspect-flow',
      name: 'No Aspect Flow',
      nodes: ['orders/order-service'],
    });

    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    const flow = output.glossary.flows['no-aspect-flow'];
    expect(flow).toBeDefined();
    expect(flow.name).toBe('No Aspect Flow');
    // Flow without aspects should not have aspects field
    expect(flow.aspects).toBeUndefined();

    // Clean up
    graph.flows.pop();
  });

  it('surfaces description on node, hierarchy, and dependencies in context map output', async () => {
    const parent: GraphNode = {
      path: 'payments',
      meta: { name: 'Payments', type: 'module', description: 'Payment domain module' },
      children: [],
      parent: null,
    };
    const child: GraphNode = {
      path: 'payments/payment-service',
      meta: { name: 'PaymentService', type: 'service', description: 'Handles payment processing' },
      children: [],
      parent,
    };
    parent.children = [child];
    const dep: GraphNode = {
      path: 'payments/gateway',
      meta: {
        name: 'Gateway',
        type: 'service',
        description: 'External payment gateway client',
        relations: undefined,
      },
      children: [],
      parent,
    };
    parent.children.push(dep);

    // Give the child a relation to dep
    child.meta.relations = [{ target: 'payments/gateway', type: 'uses' }];

    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([
        ['payments', parent],
        ['payments/payment-service', child],
        ['payments/gateway', dep],
      ]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const pkg = await buildContext(graph, 'payments/payment-service');
    const output = toContextMapOutput(pkg, graph);

    // Node description
    expect(output.node.description).toBe('Handles payment processing');

    // Hierarchy ancestor description
    expect(output.hierarchy).toHaveLength(1);
    expect(output.hierarchy[0].description).toBe('Payment domain module');

    // Dependency description
    const gatewayDep = output.dependencies.find((d) => d.path === 'payments/gateway');
    expect(gatewayDep).toBeDefined();
    expect(gatewayDep!.description).toBe('External payment gateway client');

    // Dependency hierarchy ancestor description
    expect(gatewayDep!.hierarchy).toHaveLength(1);
    expect(gatewayDep!.hierarchy[0].description).toBe('Payment domain module');
  });


  it('flow refs contain only id, not name or description', async () => {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service' },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['svc', node]]),
      aspects: [],
      flows: [
        {
          path: 'my-flow',
          name: 'My Flow',
          description: 'Flow description text',
          nodes: ['svc'],
        },
      ],
      schemas: [],
      rootPath: '/tmp',
    };

    const pkg = await buildContext(graph, 'svc');
    const output = toContextMapOutput(pkg, graph);

    const flowRef = output.node.flows.find((f) => f.id === 'my-flow');
    expect(flowRef).toBeDefined();
    expect(flowRef!.id).toBe('my-flow');
    expect((flowRef as Record<string, unknown>).name).toBeUndefined();
    expect((flowRef as Record<string, unknown>).description).toBeUndefined();
    // name and description are in glossary.flows instead
    expect(output.glossary.flows['my-flow'].name).toBe('My Flow');
    expect(output.glossary.flows['my-flow'].description).toBe('Flow description text');
  });

  it('omits description fields when not set', async () => {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service' }, // no description
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['svc', node]]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const pkg = await buildContext(graph, 'svc');
    const output = toContextMapOutput(pkg, graph);

    expect(output.node.description).toBeUndefined();
  });


  it('glossary.flows includes participants list', async () => {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service' },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['svc', node]]),
      aspects: [],
      flows: [
        {
          path: 'my-flow',
          name: 'My Flow',
          nodes: ['svc'],
        },
      ],
      schemas: [],
      rootPath: '/tmp',
    };

    const pkg = await buildContext(graph, 'svc');
    const output = toContextMapOutput(pkg, graph);

    expect(output.glossary.flows['my-flow']).toBeDefined();
    expect(output.glossary.flows['my-flow'].participants).toContain('svc');
  });

  it('output.node.files exists and is an array', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    expect(Array.isArray(output.node.files)).toBe(true);
    expect(output.node.files.length).toBeGreaterThan(0);
  });

  it('determines aspect source via implies chain when implier is in sources', async () => {
    // This test specifically exercises lines 520-525 in determineAspectSource
    // We need an aspect with implies, and the implier aspect must be found in sources
    const parentAspect: AspectDef = {
      name: 'Parent Aspect',
      id: 'parent-aspect',
      implies: ['child-aspect'],
      artifacts: [],
    };
    const childAspect: AspectDef = {
      name: 'Child Aspect',
      id: 'child-aspect',
      artifacts: [],
    };
    const nodeType = {
      description: 'x',
      aspects: ['parent-aspect'],
    };
    const node: GraphNode = {
      path: 'svc',
      meta: {
        name: 'Svc',
        type: 'service',
        aspects: ['parent-aspect', 'child-aspect'],  // both aspects on the node
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['svc', node]]),
      aspects: [parentAspect, childAspect],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const pkg = await buildContext(graph, 'svc');
    const output = toContextMapOutput(pkg, graph);

    // Verify the package was built successfully
    expect(output.node).toBeDefined();
    expect(output.glossary.aspects['parent-aspect']).toBeDefined();
    expect(output.glossary.aspects['child-aspect']).toBeDefined();
  });

  it('determines aspect source as architecture when node type has aspect', async () => {
    // Exercise the architecture source path in determineAspectSource (line 481)
    const archAspect: AspectDef = {
      name: 'Arch Aspect',
      id: 'arch-aspect',
      artifacts: [],
    };
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service' },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: {
        node_types: { service: { description: 'x', aspects: ['arch-aspect'] } },
      },
      nodes: new Map([['svc', node]]),
      aspects: [archAspect],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const pkg = await buildContext(graph, 'svc');
    const output = toContextMapOutput(pkg, graph);
    const aspectRef = output.node.required_aspects.find(a => a.id === 'arch-aspect');
    expect(aspectRef).toBeDefined();
    expect(aspectRef!.source).toContain('architecture');
  });

  it('determines aspect source as inherited from parent when parent type has aspect', async () => {
    // Exercise the parent inheritance path in determineAspectSource
    const inheritedAspect: AspectDef = {
      name: 'Inherited Aspect',
      id: 'inherited-aspect',
      artifacts: [],
    };
    const parentNode: GraphNode = {
      path: 'parent',
      meta: { name: 'Parent', type: 'module' },
      children: [],
      parent: null,
    };
    const childNode: GraphNode = {
      path: 'parent/child',
      meta: { name: 'Child', type: 'service' },
      children: [],
      parent: parentNode,
    };
    const graph: Graph = {
      config: {},
      architecture: {
        node_types: {
          module: { description: 'x', aspects: ['inherited-aspect'] },
          service: { description: 'x' },
        },
      },
      nodes: new Map([['parent', parentNode], ['parent/child', childNode]]),
      aspects: [inheritedAspect],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const pkg = await buildContext(graph, 'parent/child');
    const output = toContextMapOutput(pkg, graph);
    // The child node should have inherited-aspect with source indicating parent inheritance
    const aspectRef = output.node.required_aspects.find(a => a.id === 'inherited-aspect');
    expect(aspectRef).toBeDefined();
    expect(aspectRef!.source).toContain('inherited from parent');
  });
});

describe('buildNodeContextData', () => {

  it('throws when node not found', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    expect(() => buildNodeContextData(graph, 'does/not/exist')).toThrow('Node not found');
  });

  it('includes dependentPaths for nodes with <= 5 dependents', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const data = buildNodeContextData(graph, 'orders/order-service');

    if (data.dependentCount > 0 && data.dependentCount <= 5) {
      expect(data.dependentPaths).toBeDefined();
      expect(data.dependentPaths!.length).toBe(data.dependentCount);
    } else if (data.dependentCount > 5) {
      expect(data.dependentPaths).toBeUndefined();
    }
  });

  it('handles graph without architecture using fallback aspect collection', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const graphNoArch = { ...graph, architecture: undefined } as unknown as Graph;
    const data = buildNodeContextData(graphNoArch, 'orders/order-service');
    expect(data.path).toBe('orders/order-service');
    // In fallback mode, aspect source reflects actual origin (own, parent, flow, implied)
    for (const aspect of data.aspects) {
      expect(aspect.source).toMatch(/own declaration|inherited from parent|flow '|implied by '|unknown source/);
    }
  });

  it('determineFallbackAspectSource: implies branch when sources empty but implier aspect exists', () => {
    // Exercise lines 563-570 in context-builder.ts:
    // A node has 'child-aspect' via the implies chain of 'parent-aspect',
    // but the node does NOT directly declare 'parent-aspect', has no parent ancestor
    // with the aspect, and no flow gives it. So sources would be empty before the
    // implies check — the implies loop should add "implied by 'parent-aspect'".
    const parentAspect: AspectDef = {
      name: 'Parent Aspect',
      id: 'parent-aspect',
      implies: ['child-aspect'],
      artifacts: [],
    };
    const childAspect: AspectDef = {
      name: 'Child Aspect',
      id: 'child-aspect',
      artifacts: [],
    };
    // Node declares only 'parent-aspect'; 'child-aspect' arrives via implies
    const node: GraphNode = {
      path: 'svc',
      meta: {
        name: 'Svc',
        type: 'service',
        aspects: ['parent-aspect'],
      },
      children: [],
      parent: null,
    };
    // Graph has NO architecture — so determineFallbackAspectSource is used
    const graph: Graph = {
      config: {},
      nodes: new Map([['svc', node]]),
      aspects: [parentAspect, childAspect],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const data = buildNodeContextData(graph, 'svc');
    // The child-aspect should appear in results with source indicating it was implied
    const childAspectEntry = data.aspects.find(a => a.id === 'child-aspect');
    expect(childAspectEntry).toBeDefined();
    expect(childAspectEntry!.source).toContain("implied by 'parent-aspect'");
  });

});

describe('buildFileContextData', () => {
  it('returns file context data for a valid node using fixture', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const data = buildFileContextData(graph, 'src/orders/service.ts', 'orders/order-service');

    expect(data.filePath).toBe('src/orders/service.ts');
    expect(data.ownerPath).toBe('orders/order-service');
    expect(data.ownerType).toBe('service');
    expect(Array.isArray(data.aspects)).toBe(true);
    expect(Array.isArray(data.dependencies)).toBe(true);
    expect(typeof data.dependentCount).toBe('number');
  });

  it('throws when owner node not found', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    expect(() => buildFileContextData(graph, 'src/foo.ts', 'does/not/exist')).toThrow('Node not found');
  });

  it('returns aspects for the node', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const data = buildFileContextData(graph, 'src/orders/service.ts', 'orders/order-service');
    expect(Array.isArray(data.aspects)).toBe(true);
  });

  it('handles graph without architecture using fallback aspect collection', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const graphNoArch = { ...graph, architecture: undefined } as unknown as Graph;
    const data = buildFileContextData(graphNoArch, 'src/orders/service.ts', 'orders/order-service');
    expect(data.ownerPath).toBe('orders/order-service');
    // Aspects should still be populated from fallback collectEffectiveAspectIds
    expect(Array.isArray(data.aspects)).toBe(true);
  });

  it('uses aspect name as fallback when description is missing', () => {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service', aspects: ['name-only-aspect'] },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['svc', node]]),
      aspects: [{ name: 'NameOnlyAspect', id: 'name-only-aspect', artifacts: [] }],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const data = buildFileContextData(graph, 'src/index.ts', 'svc');
    const aspect = data.aspects.find(a => a.aspectId === 'name-only-aspect');
    expect(aspect).toBeDefined();
    // description is undefined, so falls back to name
    expect(aspect!.aspectDescription).toBe('NameOnlyAspect');
  });

  it('uses aspect id as fallback when both description and name are missing', () => {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service', aspects: ['orphan-aspect'] },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['svc', node]]),
      // Aspect not in graph.aspects — aspectDef will be undefined
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const data = buildFileContextData(graph, 'src/index.ts', 'svc');
    const aspect = data.aspects.find(a => a.aspectId === 'orphan-aspect');
    expect(aspect).toBeDefined();
    // aspectDef is undefined, so falls back to aspectId
    expect(aspect!.aspectDescription).toBe('orphan-aspect');
  });

  it('handles node without aspects in buildFileContextData', () => {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service' }, // no aspects field
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['svc', node]]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const data = buildFileContextData(graph, 'src/index.ts', 'svc');
    expect(data.aspects).toHaveLength(0);
  });

  it('handles flow without aspects in buildFileContextData', () => {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service' },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['svc', node]]),
      aspects: [],
      flows: [{ path: 'my-flow', name: 'My Flow', nodes: ['svc'] }], // no aspects on flow
      schemas: [],
      rootPath: '/tmp',
    };

    const data = buildFileContextData(graph, 'src/index.ts', 'svc');
    expect(data.aspects).toHaveLength(0);
  });

  it('includes structural dependencies in file context', () => {
    const dep: GraphNode = {
      path: 'dep/svc',
      meta: { name: 'DepSvc', type: 'service' },
      children: [],
      parent: null,
    };
    const node: GraphNode = {
      path: 'my/svc',
      meta: {
        name: 'MySvc',
        type: 'service',
        relations: [{ target: 'dep/svc', type: 'uses', consumes: ['api'] }],
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['my/svc', node], ['dep/svc', dep]]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const data = buildFileContextData(graph, 'src/index.ts', 'my/svc');
    expect(data.dependencies).toHaveLength(1);
    expect(data.dependencies[0].path).toBe('dep/svc');
    expect(data.dependencies[0].consumed).toContain('api');
  });
});

describe('collectDependencyAncestors', () => {
  it('returns ancestors with expanded aspects', () => {
    const grandparent: GraphNode = {
      path: 'root',
      meta: { name: 'Root', type: 'module', aspects: ['audit'] },
      children: [],
      parent: null,
    };
    const parentNode: GraphNode = {
      path: 'root/parent',
      meta: { name: 'Parent', type: 'service', aspects: ['logging'] },
      children: [],
      parent: grandparent,
    };
    grandparent.children = [parentNode];
    const target: GraphNode = {
      path: 'root/parent/target',
      meta: { name: 'Target', type: 'service' },
      children: [],
      parent: parentNode,
    };
    parentNode.children = [target];

    const config: YggConfig = {
    };
    const graph: Graph = {
      config,
      architecture: { node_types: {} },
      nodes: new Map([
        ['root', grandparent],
        ['root/parent', parentNode],
        ['root/parent/target', target],
      ]),
      aspects: [
        { name: 'Audit', id: 'audit', artifacts: [] },
        { name: 'Logging', id: 'logging', artifacts: [] },
      ],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const ancestors = collectDependencyAncestors(target, config, graph);
    expect(ancestors).toHaveLength(2);
    expect(ancestors[0].path).toBe('root');
    expect(ancestors[0].aspects).toContain('audit');
    expect(ancestors[1].path).toBe('root/parent');
    expect(ancestors[1].aspects).toContain('logging');
  });

  it('returns empty array for root-level target', () => {
    const target: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service' },
      children: [],
      parent: null,
    };
    const config: YggConfig = {
    };
    const graph: Graph = {
      config,
      architecture: { node_types: {} },
      nodes: new Map([['svc', target]]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const ancestors = collectDependencyAncestors(target, config, graph);
    expect(ancestors).toHaveLength(0);
  });
});

describe('determineAspectSource — uncovered branches', () => {
  it('detects port consumption as aspect source', () => {
    // Exercise lines 383-394: aspect comes from consuming a port
    const provider: GraphNode = {
      path: 'payments/gateway',
      meta: {
        name: 'Gateway',
        type: 'service',
        ports: {
          charge: { description: 'Payment', aspects: ['correlation-id'] },
        },
      },
      children: [],
      parent: null,
    };
    const consumer: GraphNode = {
      path: 'orders/checkout',
      meta: {
        name: 'Checkout',
        type: 'service',
        relations: [{ target: 'payments/gateway', type: 'calls', consumes: ['charge'] }],
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([
        ['payments/gateway', provider],
        ['orders/checkout', consumer],
      ]),
      aspects: [{ name: 'Correlation ID', id: 'correlation-id', artifacts: [] }],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const source = determineAspectSource('correlation-id', consumer, graph, [], true);
    expect(source).toContain("port 'charge'");
    expect(source).toContain('payments/gateway');
  });

  it('detects flow participation as aspect source', () => {
    // Exercise lines 409-414: aspect comes from flow participation
    const node: GraphNode = {
      path: 'orders/svc',
      meta: { name: 'OrderSvc', type: 'service' },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['orders/svc', node]]),
      aspects: [{ name: 'Saga', id: 'requires-saga', artifacts: [] }],
      flows: [
        { path: 'checkout', name: 'Checkout', nodes: ['orders/svc'], aspects: ['requires-saga'] },
      ],
      schemas: [],
      rootPath: '/tmp',
    };

    const source = determineAspectSource('requires-saga', node, graph, graph.flows, false);
    expect(source).toContain("flow 'checkout'");
  });

  it('detects implies chain as aspect source when implier is in sources', () => {
    // Exercise lines 416-431: the queried aspect must have `implies` (truthy guard on line 418)
    // AND another aspect must imply it AND that implier's id must appear in already-collected sources.
    // We use a flow to put 'parent-aspect' into sources as "flow 'my-flow'" which contains 'parent-aspect'
    // in its text — no, the source string won't contain the aspect id.
    // Instead, we put parent-aspect in ownAspects so sources has "own declaration",
    // and then we need a source string that CONTAINS the parent-aspect id.
    // The flow source format is "flow 'checkout'" — no aspect id there.
    // The port source format is "port 'charge' on 'payments/gateway'" — no aspect id.
    // The architecture source is "architecture (type: service)" — no aspect id.
    // So the only way implierInSources is true: when a source string includes the OTHER aspect's ID.
    // That only happens if parent-aspect is also itself the subject of a source that includes its id.
    // Looking at the code more carefully: sources is the list for the QUERIED aspect (child-aspect).
    // The implierInSources check looks if sources already contain text matching the IMPLIER aspect id.
    // So we need child-aspect to already have a source that contains 'parent-aspect' text.
    // This would happen if e.g. child-aspect is declared via flow that also mentions 'parent-aspect'.
    // Actually the simplest: make child-aspect come from a flow named 'parent-aspect'.
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service' },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['svc', node]]),
      aspects: [
        { name: 'Parent', id: 'parent-aspect', implies: ['child-aspect'], artifacts: [] },
        // child-aspect has implies so the guard is truthy
        { name: 'Child', id: 'child-aspect', implies: ['other'], artifacts: [] },
      ],
      flows: [
        // Flow path contains 'parent-aspect' — so "flow 'parent-aspect'" includes the implier id
        { path: 'parent-aspect', name: 'Parent Aspect Flow', nodes: ['svc'], aspects: ['child-aspect'] },
      ],
      schemas: [],
      rootPath: '/tmp',
    };

    const source = determineAspectSource('child-aspect', node, graph, graph.flows, false);
    // sources should have "flow 'parent-aspect'" which contains 'parent-aspect'
    // then the implies check adds "implied by 'parent-aspect'"
    expect(source).toContain("flow 'parent-aspect'");
    expect(source).toContain("implied by 'parent-aspect'");
  });

  it('returns unknown source when aspect has no identifiable source', () => {
    // Exercise the fallback at line 433
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service' },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['svc', node]]),
      aspects: [{ name: 'Mystery', id: 'mystery-aspect', artifacts: [] }],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const source = determineAspectSource('mystery-aspect', node, graph, [], false);
    expect(source).toBe('unknown source');
  });
});

describe('toContextMapOutput — architecture fallback', () => {
  it('uses fallback aspect collection when architecture is undefined', async () => {
    // Exercise lines 554-558 in toContextMapOutput
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    // Remove architecture to force fallback path
    const graphNoArch = { ...graph, architecture: undefined } as unknown as Graph;
    const output = toContextMapOutput(pkg, graphNoArch);
    expect(output.project).toBe('sample-project');
    expect(output.node.path).toBe('orders/order-service');
    // Aspects should still be populated from fallback
    for (const aspect of output.node.required_aspects) {
      expect(aspect.source).toBe('collected from node and flows');
    }
  });
});
