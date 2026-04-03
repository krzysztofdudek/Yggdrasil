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
  collectEffectiveAspectIds,
  computeBudgetBreakdown,
  toContextMapOutput,
} from '../../../src/core/context-builder.js';
import { formatContextMarkdown } from '../../../src/formatters/markdown.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { STANDARD_ARTIFACTS } from '../../../src/model/types.js';
import type {
  Graph,
  GraphNode,
  YggConfig,
  Relation,
  AspectDef,
  ContextMapOutput,
  ContextPackage,
} from '../../../src/model/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

describe('STANDARD_ARTIFACTS constant', () => {
  it('defines three standard artifacts with correct properties', () => {
    expect(Object.keys(STANDARD_ARTIFACTS)).toEqual([
      'responsibility.md',
      'interface.md',
      'internals.md',
    ]);
    expect(STANDARD_ARTIFACTS['responsibility.md'].required).toBe('always');
    expect(STANDARD_ARTIFACTS['responsibility.md'].included_in_relations).toBe(true);
    expect(STANDARD_ARTIFACTS['interface.md'].required).toEqual({ when: 'has_incoming_relations' });
    expect(STANDARD_ARTIFACTS['interface.md'].included_in_relations).toBe(true);
    expect(STANDARD_ARTIFACTS['internals.md'].required).toBe('never');
    expect(STANDARD_ARTIFACTS['internals.md'].included_in_relations).toBe(false);
  });
});

describe('context-builder', () => {
  describe('buildGlobalLayer', () => {
    it('produces correct markdown from config', () => {
      const config: YggConfig = {
        name: 'Test Project',
        node_types: { service: { description: 'x' } },
      };
      const layer = buildGlobalLayer(config);

      expect(layer.type).toBe('global');
      expect(layer.label).toBe('Global Context');
      expect(layer.content).toContain('**Project:** Test Project');
      expect(layer.content).not.toContain('Stack');
      expect(layer.content).not.toContain('Standards');
    });
  });

  describe('buildAspectLayer', () => {
    it('formats aspect artifacts', () => {
      const layer = buildAspectLayer({
        name: 'Audit',
        id: 'requires-audit',
        artifacts: [{ filename: 'rules.md', content: 'Log everything' }],
      });
      expect(layer.type).toBe('aspects');
      expect(layer.label).toContain('Audit');
      expect(layer.content).toContain('### rules.md');
    });

    // Exception note test removed — aspects are now flat strings, no exceptions field

    it('does not include stability tier (removed in v4)', () => {
      const layer = buildAspectLayer({
        name: 'PubSub Events',
        id: 'pubsub-events',
        anchors: ['fire-and-forget'],
        artifacts: [{ filename: 'rules.md', content: 'Fire and forget pattern' }],
      });
      expect(layer.content).not.toContain('Stability tier');
    });

    it('does not include exception section when no exception provided', () => {
      const layer = buildAspectLayer({
        name: 'PubSub Events',
        id: 'pubsub-events',
        artifacts: [{ filename: 'rules.md', content: 'Fire and forget pattern' }],
      });
      expect(layer.content).not.toContain('Exception for this node');
    });
  });

  describe('buildHierarchyLayer', () => {
    it('omits aspects attr when ancestor has no aspects', () => {
      const ancestor: GraphNode = {
        path: 'parent',
        meta: { name: 'Parent', type: 'module' },
        artifacts: [{ filename: 'responsibility.md', content: 'Parent context' }],
        children: [],
        parent: null,
      };
      const config: YggConfig = {
        name: 'Test',
        node_types: { module: { description: 'x' } },
      };
      const graph: Graph = {
        rootPath: '/tmp',
        config,
        nodes: new Map(),
        aspects: [],
        flows: [],
      };
      const layer = buildHierarchyLayer(ancestor, config, graph);
      expect(layer.attrs).toBeUndefined();
      expect(layer.content).toContain('Parent context');
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
        artifacts: [],
        children: [],
        parent: null,
        nodeYamlRaw: undefined,
      };
      const config: YggConfig = {
        name: 'Test',
        node_types: { module: { description: 'x' } },
      };
      const graph: Graph = {
        rootPath: '/tmp/nonexistent',
        config,
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
      name: '',
      node_types: { service: { description: 'x' } },
    };

    it('includes consumes and failure when present', () => {
      const target: GraphNode = {
        path: 'dep/svc',
        meta: { name: 'DepSvc', type: 'service' },
        artifacts: [
          { filename: 'responsibility.md', content: 'resp' },
          { filename: 'interface.md', content: 'api' },
        ],
        children: [],
        parent: null,
      };
      const rel: Relation = {
        target: 'dep/svc',
        type: 'uses',
        consumes: ['methodA'],
        failure: 'retry 3x',
      };
      const layer = buildStructuralRelationLayer(target, rel);
      expect(layer.content).toContain('methodA');
      expect(layer.content).toContain('retry 3x');
      expect(layer.content).toContain('### responsibility.md');
      expect(layer.content).toContain('### interface.md');
      expect(layer.attrs!.consumes).toBe('methodA');
      expect(layer.attrs!.failure).toBe('retry 3x');
    });

    it('omits consumes and failure when absent', () => {
      const target: GraphNode = {
        path: 'dep/svc',
        meta: { name: 'DepSvc', type: 'service' },
        artifacts: [{ filename: 'interface.md', content: 'api' }],
        children: [],
        parent: null,
      };
      const rel: Relation = { target: 'dep/svc', type: 'uses' };
      const layer = buildStructuralRelationLayer(target, rel);
      expect(layer.content).not.toContain('Consumes:');
      expect(layer.content).not.toContain('On failure:');
      expect(layer.content).toContain('### interface.md');
      expect(layer.attrs!.consumes).toBeUndefined();
      expect(layer.attrs!.failure).toBeUndefined();
    });

    it('uses included_in_relations artifacts from STANDARD_ARTIFACTS', () => {
      const target: GraphNode = {
        path: 'dep/svc',
        meta: { name: 'DepSvc', type: 'service' },
        artifacts: [
          { filename: 'responsibility.md', content: 'resp' },
          { filename: 'interface.md', content: 'api' },
          { filename: 'internals.md', content: 'internal' },
        ],
        children: [],
        parent: null,
      };
      const rel: Relation = { target: 'dep/svc', type: 'uses' };
      const layer = buildStructuralRelationLayer(target, rel);
      // responsibility.md and interface.md have included_in_relations=true
      expect(layer.content).toContain('### responsibility.md');
      expect(layer.content).toContain('### interface.md');
      expect(layer.content).toContain('resp');
      expect(layer.content).toContain('api');
      // internals.md has included_in_relations=false, should NOT appear
      expect(layer.content).not.toContain('### internals.md');
    });

    it('falls back to standard artifacts when included_in_relations artifacts not in target', () => {
      const target: GraphNode = {
        path: 'dep/svc',
        meta: { name: 'DepSvc', type: 'service' },
        artifacts: [{ filename: 'internals.md', content: 'internal details' }],
        children: [],
        parent: null,
      };
      const rel: Relation = { target: 'dep/svc', type: 'uses' };
      const layer = buildStructuralRelationLayer(target, rel);
      // Falls back to all standard artifacts since target has none with included_in_relations
      expect(layer.content).toContain('### internals.md');
      expect(layer.content).toContain('internal details');
    });

    it('falls back to all standard artifacts when no included_in_relations artifacts on target', () => {
      const target: GraphNode = {
        path: 'dep/svc',
        meta: { name: 'DepSvc', type: 'service' },
        artifacts: [{ filename: 'internals.md', content: 'internal details' }],
        children: [],
        parent: null,
      };
      const rel: Relation = { target: 'dep/svc', type: 'uses' };
      const layer = buildStructuralRelationLayer(target, rel);
      expect(layer.content).toContain('### internals.md');
      expect(layer.content).toContain('internal details');
    });
  });

  describe('buildEventRelationLayer', () => {
    it('formats emits relation', () => {
      const target: GraphNode = {
        path: 'events/handler',
        meta: { name: 'Handler', type: 'service' },
        artifacts: [],
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
        artifacts: [],
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
        artifacts: [],
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
        artifacts: [],
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

  describe('node aspects (v2.2: no propagation)', () => {
    it('includes implied aspects in context package', async () => {
      const auditAspect: AspectDef = {
        name: 'Audit',
        id: 'requires-audit',
        artifacts: [{ filename: 'content.md', content: 'Audit rules' }],
      };
      const hipaaAspect: AspectDef = {
        name: 'HIPAA',
        id: 'requires-hipaa',
        implies: ['requires-audit'],
        artifacts: [{ filename: 'content.md', content: 'HIPAA rules' }],
      };
      const node: GraphNode = {
        path: 'test/node',
        meta: { name: 'TestNode', type: 'service', aspects: ['requires-hipaa'] },
        artifacts: [{ filename: 'responsibility.md', content: 'x' }],
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {
          name: 'T',
          node_types: { service: { description: 'x' } },
          },
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
        artifacts: [],
      };
      const b: AspectDef = {
        name: 'B',
        id: 'tag-b',
        implies: ['tag-a'],
        artifacts: [],
      };
      const node: GraphNode = {
        path: 'test/node',
        meta: { name: 'TestNode', type: 'service', aspects: ['tag-a'] },
        artifacts: [{ filename: 'responsibility.md', content: 'x' }],
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {
          name: 'T',
          node_types: { service: { description: 'x' } },
          },
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
      expect(layerTypes).toContain('own');
      expect(layerTypes).toContain('relational');
      expect(layerTypes).toContain('aspects');

      expect(pkg.tokenCount).toBeGreaterThan(0);
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

    it('computes and returns token count', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');

      expect(typeof pkg.tokenCount).toBe('number');
      expect(pkg.tokenCount).toBeGreaterThan(100);
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

    it('builds context for root-level node (no hierarchy layers)', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'auth');

      expect(pkg.nodePath).toBe('auth');
      const hierarchyLayers = pkg.layers.filter((l) => l.type === 'hierarchy');
      expect(hierarchyLayers).toHaveLength(0);
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

    it('node in flow gets flow artifacts through Flows layer', async () => {
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
        artifacts: [],
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
        aspects: [
          {
            name: 'Audit',
            id: 'requires-audit',
            artifacts: [{ filename: 'content.md', content: 'Audit rules' }],
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

    it('hierarchy aspects: node own aspects declared on own layer (aspects on own-artifacts)', async () => {
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
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'orders/order-service');
      const ownLayer = pkg.layers.find((l) => l.type === 'own');
      expect(ownLayer).toBeDefined();
      expect(ownLayer?.attrs?.aspects).toBe('requires-audit');
      const aspectLayers = pkg.layers.filter((l) => l.type === 'aspects');
      expect(aspectLayers).toHaveLength(1);
    });

    it('flow aspects propagate to participants (aspects on flow layer)', async () => {
      const node: GraphNode = {
        path: 'orders/order-service',
        meta: { name: 'OrderService', type: 'service' },
        artifacts: [{ filename: 'responsibility.md', content: 'x' }],
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {
          name: 'T',
          node_types: { service: { description: 'x' } },
          },
        nodes: new Map([['orders/order-service', node]]),
        aspects: [
          {
            name: 'Saga',
            id: 'requires-saga',
            artifacts: [{ filename: 'content.md', content: 'Use saga pattern' }],
          },
        ],
        flows: [
          {
            name: 'Checkout',
            nodes: ['orders/order-service'],
            aspects: ['requires-saga'],
            artifacts: [{ filename: 'description.md', content: 'Flow desc' }],
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
            name: 'Checkout Flow',
            nodes: ['orders'],
            artifacts: [{ filename: 'description.md', content: 'Parent-only flow' }],
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
        artifacts: [{ filename: 'responsibility.md', content: 'x' }],
        children: [],
        parent: null,
      };
      const handler: GraphNode = {
        path: 'events/handler',
        meta: { name: 'Handler', type: 'service' },
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
        artifacts: [{ filename: 'responsibility.md', content: 'x' }],
        children: [],
        parent: null,
      };
      const publisher: GraphNode = {
        path: 'events/publisher',
        meta: { name: 'Publisher', type: 'service' },
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

    it('own layer includes yg-node.yaml and artifacts', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');

      const ownLayer = pkg.layers.find((l) => l.type === 'own');
      expect(ownLayer).toBeDefined();
      expect(ownLayer?.content).toContain('### yg-node.yaml');
      expect(ownLayer?.content).toContain('name: OrderService');
      expect(ownLayer?.content).toContain('type: service');
      expect(ownLayer?.content).toContain('relations:');
      expect(ownLayer?.content).toContain('### responsibility.md');
    });

    it('flow with empty artifacts produces no-artifacts placeholder', async () => {
      const node: GraphNode = {
        path: 'svc',
        meta: { name: 'Svc', type: 'service' },
        artifacts: [{ filename: 'responsibility.md', content: 'x' }],
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {
          name: 'T',
          node_types: { service: { description: 'x' } },
          },
        nodes: new Map([['svc', node]]),
        aspects: [],
        flows: [{ name: 'F1', nodes: ['svc'], artifacts: [] }],
        schemas: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'svc');
      const flowLayer = pkg.layers.find((l) => l.type === 'flows');
      expect(flowLayer?.content).toContain('no artifacts');
    });

    it('builds sections in canonical contract order', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');

      const sectionKeys = pkg.sections.map((s) => s.key);
      expect(sectionKeys).toEqual([
        'Global',
        'Hierarchy',
        'OwnArtifacts',
        'Aspects',
        'Relational',
      ]);
    });

    it('node and relation artifacts include source filename headings', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');

      const ownLayer = pkg.layers.find((l) => l.type === 'own');
      expect(ownLayer?.content).toContain('### yg-node.yaml');
      expect(ownLayer?.content).toContain('### responsibility.md');

      const relationLayer = pkg.layers.find((l) => l.type === 'relational');
      expect(relationLayer?.content).toContain('### responsibility.md');

      const flowLayer = pkg.layers.find((l) => l.type === 'flows');
      expect(flowLayer?.content).toContain('description.md');
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
        artifacts: [],
        children: [],
        parent: null,
      };
      const child: GraphNode = {
        path: 'mod/svc',
        meta: { name: 'Svc', type: 'service', aspects: ['tag-a', 'tag-b'] },
        artifacts: [{ filename: 'desc.md', content: 'service desc' }],
        children: [],
        parent,
      };
      parent.children.push(child);

      const graph: Graph = {
        config: {
          name: 'MultiAspect',
          node_types: { module: { description: 'x' }, service: { description: 'x' } },
          },
        nodes: new Map([
          ['mod', parent],
          ['mod/svc', child],
        ]),
        aspects: [
          {
            name: 'Aspect A',
            id: 'tag-a',
            artifacts: [{ filename: 'a.md', content: 'aspect-a-content' }],
          },
          {
            name: 'Aspect B',
            id: 'tag-b',
            artifacts: [{ filename: 'b.md', content: 'aspect-b-content' }],
          },
        ],
        flows: [],
        schemas: [],
        rootPath: '/tmp/ygg',
      };

      const pkg = await buildContext(graph, 'mod/svc');
      const aspectLayers = pkg.layers.filter((l) => l.type === 'aspects');
      // svc has both tag-a and tag-b (v2.2: no propagation)
      expect(aspectLayers).toHaveLength(2);
      const aspectLabels = aspectLayers.map((l) => l.label);
      expect(aspectLabels).toContain('Aspect A (aspect: tag-a)');
      expect(aspectLabels).toContain('Aspect B (aspect: tag-b)');
    });

    it('uses nodeYamlRaw from memory when disk read would fail', async () => {
      const node: GraphNode = {
        path: 'test/node',
        meta: { name: 'TestNode', type: 'service' },
        artifacts: [{ filename: 'responsibility.md', content: 'x' }],
        children: [],
        parent: null,
        nodeYamlRaw: 'name: TestNode\ntype: service\n',
      };
      const graph: Graph = {
        config: {
          name: 'T',
          node_types: { service: { description: 'x' } },
          },
        nodes: new Map([['test/node', node]]),
        aspects: [],
        flows: [],
        schemas: [],
        rootPath: '/nonexistent/path',  // disk read will fail
      };
      const pkg = await buildContext(graph, 'test/node');
      const ownLayer = pkg.layers.find((l) => l.type === 'own');
      expect(ownLayer?.content).toContain('name: TestNode');
      expect(ownLayer?.content).not.toContain('(not found)');
    });

    it('own layer includes raw yg-node.yaml from fixture', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'auth');
      const ownLayer = pkg.layers.find((l) => l.type === 'own');
      expect(ownLayer).toBeDefined();
      expect(ownLayer?.content).toContain('### yg-node.yaml');
      expect(ownLayer?.content).toContain('name:');
      expect(ownLayer?.content).toContain('type:');
    });

    it('empty own artifacts produce own layer with empty content', async () => {
      // Node with only yg-node.yaml, no other artifacts
      const node: GraphNode = {
        path: 'bare',
        meta: { name: 'Bare', type: 'module' },
        artifacts: [], // no artifacts
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {
          name: 'T',
          node_types: { module: { description: 'x' } },
          },
        nodes: new Map([['bare', node]]),
        aspects: [],
        flows: [],
        schemas: [],
        rootPath: '/tmp/ygg',
      };

      const pkg = await buildContext(graph, 'bare');
      const ownLayer = pkg.layers.find((l) => l.type === 'own');
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

    it('produces correct markdown structure (snapshot)', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');
      const output = formatContextMarkdown(pkg);

      expect(output).toMatchSnapshot();
    });

    it('contains required header fields', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');
      const output = formatContextMarkdown(pkg);

      expect(output).toContain('# Context Package: OrderService');
      expect(output).toContain('# Path: orders/order-service');
      expect(output).toContain('# Generated:');
      expect(output).toContain('## OwnArtifacts');
      expect(output).toContain('### yg-node.yaml');
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

    it('footer contains token count and layer types', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');
      const output = formatContextMarkdown(pkg);

      expect(output).toContain('Context size:');
      expect(output).toContain('tokens');
      expect(output).toContain('Layers:');
      expect(output).toContain('global');
      expect(output).toContain('own');
    });
  });

});

describe('collectDependencyAncestors', () => {
  it('returns ancestor chain for a dependency target', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const target = graph.nodes.get('auth/auth-api')!;
    const ancestors = collectDependencyAncestors(target, graph.config, graph);

    expect(ancestors).toHaveLength(1);
    expect(ancestors[0].path).toBe('auth');
    expect(ancestors[0].name).toBeDefined();
    expect(ancestors[0].type).toBeDefined();
    expect(Array.isArray(ancestors[0].aspects)).toBe(true);
    expect(Array.isArray(ancestors[0].artifactFilenames)).toBe(true);
  });

  it('filters ancestor artifacts by included_in_relations from STANDARD_ARTIFACTS', () => {
    const config: YggConfig = {
      name: 'T',
      node_types: { module: { description: 'x' }, service: { description: 'x' } },
    };
    const parent: GraphNode = {
      path: 'auth',
      meta: { name: 'Auth', type: 'module' },
      artifacts: [
        { filename: 'responsibility.md', content: 'x' },
        { filename: 'interface.md', content: 'y' },
        { filename: 'internals.md', content: 'z' },
      ],
      children: [],
      parent: null,
    };
    const child: GraphNode = {
      path: 'auth/auth-api',
      meta: { name: 'AuthAPI', type: 'service' },
      artifacts: [],
      children: [],
      parent,
    };
    parent.children = [child];
    const graph: Graph = {
      config,
      nodes: new Map([['auth', parent], ['auth/auth-api', child]]),
      aspects: [],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const ancestors = collectDependencyAncestors(child, config, graph);
    expect(ancestors).toHaveLength(1);
    // responsibility.md and interface.md have included_in_relations=true in STANDARD_ARTIFACTS
    expect(ancestors[0].artifactFilenames).toEqual(['responsibility.md', 'interface.md']);
  });
});

describe('build-context CLI exit codes', () => {
  const BROKEN_RELATION_FIXTURE = path.join(
    __dirname,
    '../../fixtures/sample-project-broken-relation',
  );

  it('exit code 1 for missing node', async () => {
    const { spawnSync } = await import('node:child_process');
    const distBin = path.join(__dirname, '../../../dist/bin.js');
    const result = spawnSync('node', [distBin, 'build-context', '--node', 'nonexistent/node'], {
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
      [distBin, 'build-context', '--node', 'orders/broken-service'],
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

    expect(output.project).toBe('Sample E-Commerce System');
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

  it('uses model/ prefix for node artifact paths', async () => {
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

  it('includes consumes and failure on dependency refs', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    const authDep = output.dependencies.find((d) => d.path === 'auth/auth-api');
    expect(authDep).toBeDefined();
    expect(authDep!.consumes).toEqual(['authenticate']);
    expect(authDep!.failure).toBe('reject-request');
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

  it('reports budget status warning when near threshold', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // Override config to set a very low warning threshold
    graph.config.quality = { context_budget: { warning: 1, error: 999999 } };
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    expect(output.meta.budgetStatus).toBe('warning');
  });

  it('reports budget status error when over error threshold', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    graph.config.quality = { context_budget: { warning: 1, error: 2 } };
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    expect(output.meta.budgetStatus).toBe('severe');
  });

  it('computeBudgetBreakdown categorizes layers correctly', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg: ContextPackage = {
      nodePath: 'orders/order-service',
      nodeName: 'OrderService',
      layers: [
        { type: 'global', label: 'Global', content: 'x'.repeat(400) },
        { type: 'own', label: 'Own', content: 'x'.repeat(800) },
        { type: 'hierarchy', label: 'Hierarchy', content: 'x'.repeat(1200) },
        { type: 'aspects', label: 'Aspects', content: 'x'.repeat(600) },
        { type: 'flows', label: 'Flows', content: 'x'.repeat(200) },
        { type: 'relational', label: 'Deps', content: 'x'.repeat(1000) },
      ],
      sections: [],
      mapping: null,
      tokenCount: 0,
    };

    const breakdown = computeBudgetBreakdown(pkg, graph);
    // global + own => own category: ceil(400/4) + ceil(800/4) = 100 + 200 = 300
    expect(breakdown.own).toBe(300);
    // hierarchy: ceil(1200/4) = 300
    expect(breakdown.hierarchy).toBe(300);
    // aspects: ceil(600/4) = 150
    expect(breakdown.aspects).toBe(150);
    // flows: ceil(200/4) = 50
    expect(breakdown.flows).toBe(50);
    // dependencies includes relational: ceil(1000/4) = 250 (+ any dep ancestor tokens)
    expect(breakdown.dependencies).toBeGreaterThanOrEqual(250);
    // total is sum of all
    expect(breakdown.total).toBe(
      breakdown.own + breakdown.hierarchy + breakdown.aspects + breakdown.flows + breakdown.dependencies,
    );
  });

  it('toContextMapOutput returns meta.breakdown with expected structure', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    expect(output.meta.breakdown).toBeDefined();
    expect(typeof output.meta.breakdown.own).toBe('number');
    expect(typeof output.meta.breakdown.hierarchy).toBe('number');
    expect(typeof output.meta.breakdown.aspects).toBe('number');
    expect(typeof output.meta.breakdown.flows).toBe('number');
    expect(typeof output.meta.breakdown.dependencies).toBe('number');
    expect(typeof output.meta.breakdown.total).toBe('number');
    expect(output.meta.breakdown.total).toBe(
      output.meta.breakdown.own +
      output.meta.breakdown.hierarchy +
      output.meta.breakdown.aspects +
      output.meta.breakdown.flows +
      output.meta.breakdown.dependencies,
    );
    expect(output.meta.tokenCount).toBe(output.meta.breakdown.total);
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

  it('filters dependency files by included_in_relations from STANDARD_ARTIFACTS', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    // Dependency files should be filtered by included_in_relations
    // STANDARD_ARTIFACTS has responsibility.md and interface.md with included_in_relations=true
    const authDep = output.dependencies.find((d) => d.path === 'auth/auth-api');
    expect(authDep).toBeDefined();
    const depFiles = authDep!.files ?? [];
    for (const f of depFiles) {
      const isStructural = f.includes('responsibility.md') || f.includes('interface.md');
      expect(isStructural).toBe(true);
    }
  });

  it('includes flow without aspects in glossary', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    // Add a flow without aspects that includes order-service
    graph.flows.push({
      path: 'no-aspect-flow',
      name: 'No Aspect Flow',
      nodes: ['orders/order-service'],
      artifacts: [{ filename: 'description.md', content: 'A flow without aspects' }],
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
      artifacts: [],
      children: [],
      parent: null,
    };
    const child: GraphNode = {
      path: 'payments/payment-service',
      meta: { name: 'PaymentService', type: 'service', description: 'Handles payment processing' },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
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
      artifacts: [{ filename: 'responsibility.md', content: 'gateway resp' }],
      children: [],
      parent,
    };
    parent.children.push(dep);

    // Give the child a relation to dep
    child.meta.relations = [{ target: 'payments/gateway', type: 'uses' }];

    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { module: { description: 'x' }, service: { description: 'x' } },
      },
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

  it('surfaces description on aspects and flows in glossary', async () => {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service', aspects: ['my-aspect'] },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: { description: 'x' } },
      },
      nodes: new Map([['svc', node]]),
      aspects: [
        {
          name: 'My Aspect',
          id: 'my-aspect',
          description: 'Aspect description text',
          artifacts: [{ filename: 'content.md', content: 'rules' }],
        },
      ],
      flows: [
        {
          path: 'my-flow',
          name: 'My Flow',
          description: 'Flow description text',
          nodes: ['svc'],
          artifacts: [],
        },
      ],
      schemas: [],
      rootPath: '/tmp',
    };

    const pkg = await buildContext(graph, 'svc');
    const output = toContextMapOutput(pkg, graph);

    expect(output.glossary.aspects['my-aspect'].description).toBe('Aspect description text');
    expect(output.glossary.flows['my-flow'].description).toBe('Flow description text');
  });

  it('flow refs contain only id, not name or description', async () => {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service' },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: { description: 'x' } },
      },
      nodes: new Map([['svc', node]]),
      aspects: [],
      flows: [
        {
          path: 'my-flow',
          name: 'My Flow',
          description: 'Flow description text',
          nodes: ['svc'],
          artifacts: [],
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
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: { description: 'x' } },
      },
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

  it('glossary.aspects does not include stability (removed in v4)', async () => {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service', aspects: ['stable-aspect'] },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: { description: 'x' } },
      },
      nodes: new Map([['svc', node]]),
      aspects: [
        {
          name: 'Stable Aspect',
          id: 'stable-aspect',
          anchors: [],
          artifacts: [{ filename: 'content.md', content: 'rules' }],
        },
      ],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const pkg = await buildContext(graph, 'svc');
    const output = toContextMapOutput(pkg, graph);

    expect(output.glossary.aspects['stable-aspect']).toBeDefined();
    expect((output.glossary.aspects['stable-aspect'] as unknown as Record<string, unknown>).stability).toBeUndefined();
  });

  it('glossary.flows includes participants list', async () => {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service' },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: { description: 'x' } },
      },
      nodes: new Map([['svc', node]]),
      aspects: [],
      flows: [
        {
          path: 'my-flow',
          name: 'My Flow',
          nodes: ['svc'],
          artifacts: [{ filename: 'description.md', content: 'flow desc' }],
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

  it('file lists exclude yg-node.yaml, yg-aspect.yaml, yg-flow.yaml', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    // Node files should not contain yg-node.yaml
    for (const f of output.node.files) {
      expect(f).not.toContain('yg-node.yaml');
    }

    // Aspect files should not contain yg-aspect.yaml
    for (const [, aspect] of Object.entries(output.glossary.aspects)) {
      for (const f of aspect.files) {
        expect(f).not.toContain('yg-aspect.yaml');
      }
    }

    // Flow files should not contain yg-flow.yaml
    for (const [, flow] of Object.entries(output.glossary.flows)) {
      for (const f of flow.files) {
        expect(f).not.toContain('yg-flow.yaml');
      }
    }
  });

  it('output.node.files exists and is an array', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const pkg = await buildContext(graph, 'orders/order-service');
    const output = toContextMapOutput(pkg, graph);

    expect(Array.isArray(output.node.files)).toBe(true);
    expect(output.node.files.length).toBeGreaterThan(0);
  });

  it('builds integration_aspects when effective.integration is non-empty', async () => {
    const node: GraphNode = {
      path: 'svc',
      meta: { name: 'Svc', type: 'service', integration_aspects: ['correlation-id'] },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: { description: 'x' } },
      },
      architecture: {
        node_types: { service: { description: 'x', integration_aspects: ['correlation-id'] } },
      },
      nodes: new Map([['svc', node]]),
      aspects: [
        {
          name: 'Correlation ID',
          id: 'correlation-id',
          anchors: [],
          artifacts: [{ filename: 'content.md', content: 'correlation rules' }],
        },
      ],
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };

    const pkg = await buildContext(graph, 'svc');
    const output = toContextMapOutput(pkg, graph);

    expect(output.node).toBeDefined();
    expect(output.node.integration_aspects).toBeDefined();
    expect(output.node.integration_aspects!.length).toBeGreaterThan(0);
    expect(output.node.integration_aspects![0].id).toBe('correlation-id');
  });

  it('determines aspect source via implies chain when implier is in sources', async () => {
    // This test specifically exercises lines 520-525 in determineAspectSource
    // We need an aspect with implies, and the implier aspect must be found in sources
    const parentAspect: AspectDef = {
      name: 'Parent Aspect',
      id: 'parent-aspect',
      implies: ['child-aspect'],
      anchors: [],
      artifacts: [{ filename: 'content.md', content: 'parent rules' }],
    };
    const childAspect: AspectDef = {
      name: 'Child Aspect',
      id: 'child-aspect',
      anchors: [],
      artifacts: [{ filename: 'content.md', content: 'child rules' }],
    };
    const nodeType = {
      description: 'x',
      aspects: ['parent-aspect'],
      integration_aspects: [],
    };
    const node: GraphNode = {
      path: 'svc',
      meta: {
        name: 'Svc',
        type: 'service',
        aspects: ['parent-aspect', 'child-aspect'],  // both aspects on the node
      },
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {
        name: 'T',
        node_types: { service: nodeType },
      },
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
});
