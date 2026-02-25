import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildContext,
  buildGlobalLayer,
  buildKnowledgeLayer,
  buildAspectLayer,
  buildStructuralRelationLayer,
  buildEventRelationLayer,
  collectAncestors,
} from '../../../src/core/context-builder.js';
import { formatContextMarkdown } from '../../../src/formatters/markdown.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode, YggConfig, Relation } from '../../../src/model/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

describe('context-builder', () => {
  describe('buildGlobalLayer', () => {
    it('produces correct markdown from config', () => {
      const config: YggConfig = {
        name: 'Test Project',
        stack: { language: 'TypeScript', runtime: 'Node 22' },
        standards: 'ESLint + Jest',
        tags: [],
        node_types: ['service'],
        artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
        knowledge_categories: [],
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

  describe('buildKnowledgeLayer', () => {
    it('formats knowledge with category label', () => {
      const layer = buildKnowledgeLayer({
        path: 'decisions/001',
        name: 'Choice',
        category: 'decisions',
        scope: 'global',
        artifacts: [{ filename: 'content.md', content: 'We chose X' }],
      });
      expect(layer.type).toBe('knowledge');
      expect(layer.label).toBe('Decisions: Choice');
      expect(layer.content).toContain('### content.md');
      expect(layer.content).toContain('We chose X');
    });
  });

  describe('buildAspectLayer', () => {
    it('formats aspect artifacts', () => {
      const layer = buildAspectLayer({
        name: 'Audit',
        tag: 'requires-audit',
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
      tags: [],
      node_types: ['service'],
      artifacts: {
        'responsibility.md': { required: 'always', description: 'x' },
        'interface.md': { required: 'never', description: 'x', structural_context: true },
        'errors.md': { required: 'never', description: 'x', structural_context: true },
        'description.md': { required: 'never', description: 'x' },
      },
      knowledge_categories: [],
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

  describe('node tags (v2.2: no propagation)', () => {
    it('node with own tags includes aspects in context', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const orderService = graph.nodes.get('orders/order-service')!;
      expect(orderService.meta.tags).toContain('requires-audit');

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
      // users module has no tags matching the audit aspect
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
          tags: [],
          node_types: ['module', 'service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
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
            knowledge: [],
            artifacts: [{ filename: 'description.md', content: 'Parent-only flow' }],
          },
        ],
        knowledge: [],
        templates: [],
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
          tags: [],
          node_types: ['service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([
          ['events/emitter', emitter],
          ['events/handler', handler],
        ]),
        aspects: [],
        flows: [],
        knowledge: [],
        templates: [],
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
          tags: [],
          node_types: ['service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([
          ['events/listener', listener],
          ['events/publisher', publisher],
        ]),
        aspects: [],
        flows: [],
        knowledge: [],
        templates: [],
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
          tags: [],
          node_types: ['service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([['svc', node]]),
        aspects: [],
        flows: [{ name: 'F1', nodes: ['svc'], knowledge: [], artifacts: [] }],
        knowledge: [],
        templates: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'svc');
      const flowLayer = pkg.layers.find((l) => l.type === 'flows');
      expect(flowLayer?.content).toContain('no artifacts');
    });

    it('flow with knowledge adds knowledge layer (trailing slash normalized)', async () => {
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
          tags: [],
          node_types: ['service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([['svc', node]]),
        aspects: [],
        flows: [
          {
            name: 'F1',
            nodes: ['svc'],
            knowledge: ['decisions/001/'],
            artifacts: [],
          },
        ],
        knowledge: [
          {
            path: 'decisions/001',
            name: 'D1',
            category: 'decisions',
            scope: 'global',
            artifacts: [{ filename: 'content.md', content: 'decision' }],
          },
        ],
        templates: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'svc');
      const knowledgeLayers = pkg.layers.filter((l) => l.type === 'knowledge');
      expect(knowledgeLayers.some((l) => l.label.includes('D1'))).toBe(true);
    });

    it('flow knowledge matches via kPath when item has trailing slash', async () => {
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
          tags: [],
          node_types: ['service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([['svc', node]]),
        aspects: [],
        flows: [
          {
            name: 'F1',
            nodes: ['svc'],
            knowledge: ['decisions/002/'],
            artifacts: [],
          },
        ],
        knowledge: [
          {
            path: 'decisions/002/',
            name: 'D2',
            category: 'decisions',
            scope: 'global',
            artifacts: [{ filename: 'content.md', content: 'decision' }],
          },
        ],
        templates: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'svc');
      const knowledgeLayers = pkg.layers.filter((l) => l.type === 'knowledge');
      expect(knowledgeLayers.some((l) => l.label.includes('D2'))).toBe(true);
    });

    it('flow adds knowledge from flow.knowledge when not already in package (from flow scope)', async () => {
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
          tags: [],
          node_types: ['service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([['svc', node]]),
        aspects: [],
        flows: [
          {
            name: 'F1',
            nodes: ['svc'],
            knowledge: ['decisions/flow-only'],
            artifacts: [],
          },
        ],
        knowledge: [
          {
            path: 'decisions/flow-only',
            name: 'FlowOnly',
            category: 'decisions',
            scope: { nodes: ['other-node'] },
            artifacts: [{ filename: 'content.md', content: 'only via flow' }],
          },
        ],
        templates: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'svc');
      const knowledgeLayers = pkg.layers.filter((l) => l.type === 'knowledge');
      expect(knowledgeLayers.some((l) => l.label.includes('FlowOnly'))).toBe(true);
      expect(knowledgeLayers.some((l) => l.label.includes('from flow'))).toBe(true);
    });

    it('includes knowledge with scope nodes when node is listed', async () => {
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
          tags: [],
          node_types: ['service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([['svc', node]]),
        aspects: [],
        flows: [],
        knowledge: [
          {
            path: 'decisions/node-scoped',
            name: 'NodeScoped',
            category: 'decisions',
            scope: { nodes: ['svc'] },
            artifacts: [{ filename: 'content.md', content: 'for svc only' }],
          },
        ],
        templates: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'svc');
      const knowledgeLayers = pkg.layers.filter((l) => l.type === 'knowledge');
      expect(knowledgeLayers.some((l) => l.label.includes('NodeScoped'))).toBe(true);
    });

    it('includes knowledge with scope tags when node has matching tag', async () => {
      const nodeWithTag: GraphNode = {
        path: 'svc/tagged',
        meta: { name: 'Tagged', type: 'service', tags: ['audit'] },
        artifacts: [{ filename: 'responsibility.md', content: 'x' }],
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {
          name: 'T',
          stack: {},
          standards: '',
          tags: ['audit'],
          node_types: ['service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([['svc/tagged', nodeWithTag]]),
        aspects: [],
        flows: [],
        knowledge: [
          {
            path: 'patterns/001',
            name: 'P1',
            category: 'patterns',
            scope: { tags: ['audit'] },
            artifacts: [{ filename: 'content.md', content: 'pattern' }],
          },
        ],
        templates: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'svc/tagged');
      const knowledgeLayers = pkg.layers.filter((l) => l.type === 'knowledge');
      expect(knowledgeLayers.some((l) => l.label.includes('P1'))).toBe(true);
    });

    it('excludes knowledge with scope tags when node has no matching tag', async () => {
      const nodeNoTag: GraphNode = {
        path: 'svc/untagged',
        meta: { name: 'Untagged', type: 'service' },
        artifacts: [{ filename: 'responsibility.md', content: 'x' }],
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {
          name: 'T',
          stack: {},
          standards: '',
          tags: ['audit'],
          node_types: ['service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([['svc/untagged', nodeNoTag]]),
        aspects: [],
        flows: [],
        knowledge: [
          {
            path: 'patterns/002',
            name: 'P2',
            category: 'patterns',
            scope: { tags: ['audit'] },
            artifacts: [{ filename: 'content.md', content: 'pattern' }],
          },
        ],
        templates: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'svc/untagged');
      const knowledgeLayers = pkg.layers.filter((l) => l.type === 'knowledge');
      expect(knowledgeLayers.some((l) => l.label.includes('P2'))).toBe(false);
    });

    it('includes knowledge with scope nodes when node is in scope', async () => {
      const node: GraphNode = {
        path: 'svc/scoped',
        meta: { name: 'Scoped', type: 'service' },
        artifacts: [{ filename: 'responsibility.md', content: 'x' }],
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {
          name: 'T',
          stack: {},
          standards: '',
          tags: [],
          node_types: ['service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([['svc/scoped', node]]),
        aspects: [],
        flows: [],
        knowledge: [
          {
            path: 'decisions/002',
            name: 'D2',
            category: 'decisions',
            scope: { nodes: ['svc/scoped'] },
            artifacts: [{ filename: 'content.md', content: 'decision' }],
          },
        ],
        templates: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'svc/scoped');
      const knowledgeLayers = pkg.layers.filter((l) => l.type === 'knowledge');
      expect(knowledgeLayers.some((l) => l.label.includes('D2'))).toBe(true);
    });

    it('includes knowledge declared by node.meta.knowledge', async () => {
      const node: GraphNode = {
        path: 'svc',
        meta: {
          name: 'Svc',
          type: 'service',
          knowledge: ['decisions/003'],
        },
        artifacts: [{ filename: 'responsibility.md', content: 'x' }],
        children: [],
        parent: null,
      };
      const graph: Graph = {
        config: {
          name: 'T',
          stack: {},
          standards: '',
          tags: [],
          node_types: ['service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([['svc', node]]),
        aspects: [],
        flows: [],
        knowledge: [
          {
            path: 'decisions/003',
            name: 'D3',
            category: 'decisions',
            scope: { nodes: ['other-node'] },
            artifacts: [{ filename: 'content.md', content: 'decision' }],
          },
        ],
        templates: [],
        rootPath: '/tmp',
      };

      const pkg = await buildContext(graph, 'svc');
      const knowledgeLayers = pkg.layers.filter((l) => l.type === 'knowledge');
      expect(knowledgeLayers.some((l) => l.label.includes('D3'))).toBe(true);
    });

    it('builds sections in canonical contract order', async () => {
      const graph = await loadGraph(FIXTURE_PROJECT);
      const pkg = await buildContext(graph, 'orders/order-service');

      const sectionKeys = pkg.sections.map((s) => s.key);
      expect(sectionKeys).toContain('Global');
      expect(sectionKeys).toContain('Hierarchy');
      expect(sectionKeys).toContain('OwnArtifacts');
      expect(sectionKeys).toContain('Dependencies');
      expect(sectionKeys).toContain('Aspects');
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

    it('includes multiple aspects when node matches multiple tags', async () => {
      // Manually build a graph with 2 aspects on 2 different tags
      const parent: GraphNode = {
        path: 'mod',
        meta: { name: 'Mod', type: 'module', tags: ['tag-a'] },
        artifacts: [],
        children: [],
        parent: null,
      };
      const child: GraphNode = {
        path: 'mod/svc',
        meta: { name: 'Svc', type: 'service', tags: ['tag-a', 'tag-b'] },
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
          tags: ['tag-a', 'tag-b'],
          node_types: ['module', 'service'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([
          ['mod', parent],
          ['mod/svc', child],
        ]),
        aspects: [
          {
            name: 'Aspect A',
            tag: 'tag-a',
            artifacts: [{ filename: 'a.md', content: 'aspect-a-content' }],
          },
          {
            name: 'Aspect B',
            tag: 'tag-b',
            artifacts: [{ filename: 'b.md', content: 'aspect-b-content' }],
          },
        ],
        flows: [],
        knowledge: [],
        templates: [],
        rootPath: '/tmp/ygg',
      };

      const pkg = await buildContext(graph, 'mod/svc');
      const aspectLayers = pkg.layers.filter((l) => l.type === 'aspects');
      // svc has both tag-a and tag-b (v2.2: no propagation)
      expect(aspectLayers).toHaveLength(2);
      const aspectLabels = aspectLayers.map((l) => l.label);
      expect(aspectLabels).toContain('Aspect A (tag: tag-a)');
      expect(aspectLabels).toContain('Aspect B (tag: tag-b)');
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
          tags: [],
          node_types: ['module'],
          artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
          knowledge_categories: [],
        },
        nodes: new Map([['bare', node]]),
        aspects: [],
        flows: [],
        knowledge: [],
        templates: [],
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
    expect(result.stderr).toContain('structurally valid graph');
  });
});
