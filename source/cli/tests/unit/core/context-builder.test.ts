import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildContext,
  buildGlobalLayer,
  buildAspectLayer,
  buildStructuralRelationLayer,
  buildEventRelationLayer,
  collectAncestors,
} from '../../../src/core/context-builder.js';
import { formatContextMarkdown } from '../../../src/formatters/markdown.js';
import { formatContextText } from '../../../src/formatters/context-text.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type {
  Graph,
  GraphNode,
  YggConfig,
  Relation,
  AspectDef,
} from '../../../src/model/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

describe('context-builder', () => {
  describe('buildGlobalLayer', () => {
    it('produces correct markdown from config', () => {
      const config: YggConfig = {
        name: 'Test Project',
        stack: { language: 'TypeScript', runtime: 'Node 22' },
        standards: 'ESLint + Jest',
        node_types: [{ name: 'service' }],
        artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
      };
      const layer = buildGlobalLayer(config);

      expect(layer.type).toBe('global');
      expect(layer.label).toBe('Global Context');
      expect(layer.content).toContain('**Project:** Test Project');
      expect(layer.content).toContain('**Stack:**');
      expect(layer.content).toContain('- language: TypeScript');
      expect(layer.content).toContain('- runtime: Node 22');
      expect(layer.content).toContain('**Standards:**');
      expect(layer.content).toContain('ESLint');
      expect(layer.content).toContain('Jest');
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
  });

  describe('buildStructuralRelationLayer', () => {
    const defaultConfig: YggConfig = {
      name: '',
      stack: {},
      standards: '',
      node_types: [{ name: 'service' }],
      artifacts: {
        'responsibility.md': { required: 'always', description: 'x' },
        'interface.md': { required: 'never', description: 'x', structural_context: true },
        'errors.md': { required: 'never', description: 'x', structural_context: true },
        'description.md': { required: 'never', description: 'x' },
      },
    };

    it('includes consumes and failure when present', () => {
      const target: GraphNode = {
        path: 'dep/svc',
        meta: { name: 'DepSvc', type: 'service' },
        artifacts: [
          { filename: 'interface.md', content: 'api' },
          { filename: 'errors.md', content: 'E001' },
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
      const layer = buildStructuralRelationLayer(target, rel, defaultConfig);
      expect(layer.content).toContain('methodA');
      expect(layer.content).toContain('retry 3x');
      expect(layer.content).toContain('### interface.md');
      expect(layer.content).toContain('### errors.md');
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
      const layer = buildStructuralRelationLayer(target, rel, defaultConfig);
      expect(layer.content).not.toContain('Consumes:');
      expect(layer.content).not.toContain('On failure:');
      expect(layer.content).toContain('### interface.md');
    });

    it('uses structural_context artifacts when configured', () => {
      const configWithStructural = defaultConfig;
      const target: GraphNode = {
        path: 'dep/svc',
        meta: { name: 'DepSvc', type: 'service' },
        artifacts: [
          { filename: 'interface.md', content: 'api' },
          { filename: 'errors.md', content: 'E001' },
        ],
        children: [],
        parent: null,
      };
      const rel: Relation = { target: 'dep/svc', type: 'uses' };
      const layer = buildStructuralRelationLayer(target, rel, configWithStructural);
      expect(layer.content).toContain('### interface.md');
      expect(layer.content).toContain('### errors.md');
      expect(layer.content).toContain('api');
      expect(layer.content).toContain('E001');
    });

    it('falls back to filterArtifactsByConfig when structural_context artifacts not in target', () => {
      const configWithStructural = {
        ...defaultConfig,
        artifacts: {
          ...defaultConfig.artifacts,
          'interface.md': {
            required: 'never' as const,
            description: 'x',
            structural_context: true,
          },
        },
      };
      const target: GraphNode = {
        path: 'dep/svc',
        meta: { name: 'DepSvc', type: 'service' },
        artifacts: [{ filename: 'description.md', content: 'desc' }],
        children: [],
        parent: null,
      };
      const rel: Relation = { target: 'dep/svc', type: 'uses' };
      const layer = buildStructuralRelationLayer(target, rel, configWithStructural);
      expect(layer.content).toContain('### description.md');
      expect(layer.content).toContain('desc');
    });

    it('falls back to config-allowed artifacts when no interface/errors', () => {
      const target: GraphNode = {
        path: 'dep/svc',
        meta: { name: 'DepSvc', type: 'service' },
        artifacts: [{ filename: 'description.md', content: 'desc' }],
        children: [],
        parent: null,
      };
      const rel: Relation = { target: 'dep/svc', type: 'uses' };
      const layer = buildStructuralRelationLayer(target, rel, defaultConfig);
      expect(layer.content).toContain('### description.md');
      expect(layer.content).toContain('desc');
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
          stack: {},
          standards: '',
          node_types: [{ name: 'service' }],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
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
          stack: {},
          standards: '',
          node_types: [{ name: 'service' }],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
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
          stack: {},
          standards: '',
          node_types: [{ name: 'module' }, { name: 'service' }],
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
          stack: {},
          standards: '',
          node_types: [{ name: 'module' }, { name: 'service' }],
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
          stack: {},
          standards: '',
          node_types: [{ name: 'service' }],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
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
          stack: {},
          standards: '',
          node_types: [{ name: 'module' }, { name: 'service' }],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
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
          stack: {},
          standards: '',
          node_types: [{ name: 'service' }],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
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
          stack: {},
          standards: '',
          node_types: [{ name: 'service' }],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
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

    it('own layer includes node.yaml and artifacts', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');

      const ownLayer = pkg.layers.find((l) => l.type === 'own');
      expect(ownLayer).toBeDefined();
      expect(ownLayer?.content).toContain('### node.yaml');
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
          stack: {},
          standards: '',
          node_types: [{ name: 'service' }],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
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
      expect(ownLayer?.content).toContain('### node.yaml');
      expect(ownLayer?.content).toContain('### description.md');

      const relationLayer = pkg.layers.find((l) => l.type === 'relational');
      expect(relationLayer?.content).toContain('### responsibility.md');
      expect(relationLayer?.content).toContain('Auth API');

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
          stack: {},
          standards: '',
          node_types: [{ name: 'module' }, { name: 'service' }],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
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
          stack: {},
          standards: '',
          node_types: [{ name: 'service' }],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
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

    it('own layer includes raw node.yaml from fixture', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'auth');
      const ownLayer = pkg.layers.find((l) => l.type === 'own');
      expect(ownLayer).toBeDefined();
      expect(ownLayer?.content).toContain('### node.yaml');
      expect(ownLayer?.content).toContain('name:');
      expect(ownLayer?.content).toContain('type:');
    });

    it('empty own artifacts produce own layer with empty content', async () => {
      // Node with only node.yaml, no other artifacts
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
          stack: {},
          standards: '',
          node_types: [{ name: 'module' }],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
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
      expect(ownLayer?.content).toContain('### node.yaml');
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
      expect(output).toContain('### node.yaml');
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

  describe('formatContextText', () => {
    it('produces XML-like tags with context-package wrapper', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');
      const output = formatContextText(pkg);

      expect(output).toContain('<context-package ');
      expect(output).toContain('node-path="orders/order-service"');
      expect(output).toContain('node-name="OrderService"');
      expect(output).toContain('</context-package>');
    });

    it('wraps global, hierarchy, own-artifacts, aspect, flow in tags', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');
      const output = formatContextText(pkg);

      expect(output).toContain('<global>');
      expect(output).toContain('</global>');
      expect(output).toContain('<hierarchy');
      expect(output).toContain('<own-artifacts');
      expect(output).toContain('<aspect ');
      expect(output).toContain('<flow ');
    });

    it('flow tag includes aspects when flow has aspects', async () => {
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
          stack: {},
          standards: '',
          node_types: [{ name: 'service' }],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
        },
        nodes: new Map([['orders/order-service', node]]),
        aspects: [
          {
            name: 'Saga',
            id: 'requires-saga',
            artifacts: [{ filename: 'content.md', content: 'Use saga' }],
          },
        ],
        flows: [
          {
            name: 'Checkout',
            nodes: ['orders/order-service'],
            aspects: ['requires-saga'],
            artifacts: [],
          },
        ],
        schemas: [],
        rootPath: '/tmp',
      };
      const pkg = await buildContext(graph, 'orders/order-service');
      const output = formatContextText(pkg);

      expect(output).toContain('aspects="requires-saga"');
      expect(output).toContain('<flow name="Checkout"');
    });

    it('formatContextText includes aspects on hierarchy for ancestor aspects', async () => {
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
          stack: {},
          standards: '',
          node_types: [{ name: 'module' }, { name: 'service' }],
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
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'orders/order-service');
      const output = formatContextText(pkg);
      expect(output).toContain('aspects="requires-audit"');
      expect(output).toContain('<hierarchy path="orders"');
    });
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
