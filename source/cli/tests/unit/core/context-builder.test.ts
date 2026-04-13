import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGlobalLayer,
  buildAspectLayer,
  buildHierarchyLayer,
  buildOwnLayer,
  buildStructuralRelationLayer,
  buildEventRelationLayer,
  collectAncestors,
  collectDependencyAncestors,
  collectEffectiveAspectIds,
  expandAspects,
  determineAspectSource,
  buildNodeContextData,
  buildFileContextData,
} from '../../../src/core/context-builder.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type {
  Graph,
  GraphNode,
  YggConfig,
  Relation,
  AspectDef,
} from '../../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

describe('context-builder', () => {
  describe('buildGlobalLayer', () => {
    it('produces correct markdown from config', () => {
      const layer = buildGlobalLayer('/fake/project/.yggdrasil');

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

  describe('node aspects (expandAspects)', () => {
    it('throws when aspect implies cycle detected', () => {
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
      expect(() => expandAspects(['tag-a'], [a, b])).toThrow(
        "Aspect implies cycle detected involving aspect 'tag-a'",
      );
    });
  });
});

// Dead buildContext / toContextMapOutput / formatContextMarkdown tests removed.
// Those functions were deleted as dead code.


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

