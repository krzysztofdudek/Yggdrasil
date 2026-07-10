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
        reviewer: { type: 'llm' as const }, artifacts: [{ filename: 'content.md', content: 'Log all mutations' }],
      });
      expect(layer.type).toBe('aspects');
      expect(layer.label).toContain('Audit');
      expect(layer.content).toContain('### content.md');
    });

    it('does not include stability tier', () => {
      const layer = buildAspectLayer({
        name: 'PubSub Events',
        id: 'pubsub-events',
        reviewer: { type: 'llm' as const }, artifacts: [],
      });
      expect(layer.content).not.toContain('Stability tier');
    });

    it('does not include exception section when no exception provided', () => {
      const layer = buildAspectLayer({
        name: 'PubSub Events',
        id: 'pubsub-events',
        reviewer: { type: 'llm' as const }, artifacts: [],
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

  describe('buildStructuralRelationLayer', () => {
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
    expect(result.stderr).toContain("Node 'nonexistent/node' does not exist in the graph.");
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
      expect(aspect.source).toMatch(/own declaration|inherited from parent|architecture|flow '|port '|implied by '|unknown source/);
    }
  });

  it('getAspectSource: implies branch when aspect arrives via implies chain', () => {
    // Exercise lines 563-570 in context-builder.ts:
    // A node has 'child-aspect' via the implies chain of 'parent-aspect',
    // but the node does NOT directly declare 'parent-aspect', has no parent ancestor
    // with the aspect, and no flow gives it. So sources would be empty before the
    // implies check — the implies loop should add "implied by 'parent-aspect'".
    const parentAspect: AspectDef = {
      name: 'Parent Aspect',
      id: 'parent-aspect',
      implies: ['child-aspect'],
      reviewer: { type: 'llm' as const }, artifacts: [],
    };
    const childAspect: AspectDef = {
      name: 'Child Aspect',
      id: 'child-aspect',
      reviewer: { type: 'llm' as const }, artifacts: [],
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
      architecture: { node_types: {} },
      nodes: new Map([['svc', node]]),
      aspects: [parentAspect, childAspect],
      flows: [],
      rootPath: '/tmp',
    };

    const data = buildNodeContextData(graph, 'svc');
    // The child-aspect should appear in results with source indicating it was implied
    const childAspectEntry = data.aspects.find(a => a.id === 'child-aspect');
    expect(childAspectEntry).toBeDefined();
    expect(childAspectEntry!.source).toContain("implied by 'parent-aspect'");
  });

  it('carries a declared reviewed-seam max_direct_relations override into the context data', () => {
    const seam: GraphNode = {
      path: 'seam',
      meta: {
        name: 'Seam',
        type: 'service',
        maxDirectRelations: { limit: 21, reason: 'Single auditable gateway; splitting defeats the seam.' },
      },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['seam', seam]]),
      aspects: [],
      flows: [],
      rootPath: '/tmp',
    };

    const data = buildNodeContextData(graph, 'seam');
    expect(data.maxDirectRelations).toEqual({
      limit: 21,
      reason: 'Single auditable gateway; splitting defeats the seam.',
    });
  });

  it('omits max_direct_relations from context data when the node declares none', () => {
    const plain: GraphNode = {
      path: 'plain',
      meta: { name: 'Plain', type: 'service' },
      children: [],
      parent: null,
    };
    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['plain', plain]]),
      aspects: [],
      flows: [],
      rootPath: '/tmp',
    };

    const data = buildNodeContextData(graph, 'plain');
    expect(data.maxDirectRelations).toBeUndefined();
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
      aspects: [{ name: 'NameOnlyAspect', id: 'name-only-aspect', reviewer: { type: 'llm' as const }, artifacts: [] }],
      flows: [],
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
        { name: 'Audit', id: 'audit', reviewer: { type: 'llm' as const }, artifacts: [] },
        { name: 'Logging', id: 'logging', reviewer: { type: 'llm' as const }, artifacts: [] },
      ],
      flows: [],
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
      rootPath: '/tmp',
    };

    const ancestors = collectDependencyAncestors(target, config, graph);
    expect(ancestors).toHaveLength(0);
  });
});

describe('verifiedAgainst path (Task 31)', () => {
  const llmAspect: AspectDef = {
    name: 'LLM Aspect',
    id: 'llm-aspect',
    reviewer: { type: 'llm' as const }, artifacts: [{ filename: 'content.md', content: 'rule text' }],
  };
  const astAspect: AspectDef = {
    name: 'AST Aspect',
    id: 'ast-aspect',
    reviewer: { type: 'deterministic' as const },
    artifacts: [{ filename: 'check.mjs', content: 'export function check(ctx) { return []; }' }],
  };
  const svcNode: GraphNode = {
    path: 'svc',
    meta: {
      name: 'Svc',
      type: 'service',
      aspects: ['llm-aspect', 'ast-aspect'],
      mapping: ['src/svc.ts'],
    },
    children: [],
    parent: null,
  };
  const graph: Graph = {
    config: {},
    architecture: { node_types: { service: { description: 'svc' } } },
    nodes: new Map([['svc', svcNode]]),
    aspects: [llmAspect, astAspect],
    flows: [],
    rootPath: '/fake/.yggdrasil',
  };

  it('buildNodeContextData: LLM aspect uses content.md in verifiedAgainst', () => {
    const data = buildNodeContextData(graph, 'svc');
    const llm = data.aspects.find((a) => a.id === 'llm-aspect');
    expect(llm).toBeDefined();
    expect(llm!.verifiedAgainst).toBe('.yggdrasil/aspects/llm-aspect/content.md');
  });

  it('buildNodeContextData: AST aspect uses check.mjs in verifiedAgainst', () => {
    const data = buildNodeContextData(graph, 'svc');
    const ast = data.aspects.find((a) => a.id === 'ast-aspect');
    expect(ast).toBeDefined();
    expect(ast!.verifiedAgainst).toBe('.yggdrasil/aspects/ast-aspect/check.mjs');
  });

  it('buildFileContextData: LLM aspect uses content.md in verifiedAgainst', () => {
    const data = buildFileContextData(graph, 'src/svc.ts', 'svc');
    const llm = data.aspects.find((a) => a.aspectId === 'llm-aspect');
    expect(llm).toBeDefined();
    expect(llm!.verifiedAgainst).toBe('.yggdrasil/aspects/llm-aspect/content.md');
  });

  it('buildFileContextData: AST aspect uses check.mjs in verifiedAgainst', () => {
    const data = buildFileContextData(graph, 'src/svc.ts', 'svc');
    const ast = data.aspects.find((a) => a.aspectId === 'ast-aspect');
    expect(ast).toBeDefined();
    expect(ast!.verifiedAgainst).toBe('.yggdrasil/aspects/ast-aspect/check.mjs');
  });

  // An AGGREGATE aspect (no own rule source) verifies against its yg-aspect.yaml,
  // and an LLM aspect WITH references surfaces those references in the context.
  const aggregateAspect: AspectDef = {
    name: 'Bundle', id: 'bundle',
    reviewer: { type: 'aggregate' as const }, artifacts: [],
    implies: ['llm-aspect'],
  } as unknown as AspectDef;
  const refAspect: AspectDef = {
    name: 'Ref Aspect', id: 'ref-aspect',
    reviewer: { type: 'llm' as const },
    artifacts: [{ filename: 'content.md', content: 'rule' }],
    references: [{ path: 'docs/table.md', description: 'lookup table' }],
  } as unknown as AspectDef;
  const richNode: GraphNode = {
    path: 'rich',
    meta: { name: 'Rich', type: 'service', aspects: ['bundle', 'ref-aspect'], mapping: ['src/rich.ts'] },
    children: [], parent: null,
  };
  const richGraph: Graph = {
    config: {},
    architecture: { node_types: { service: { description: 'svc' } } },
    nodes: new Map([['rich', richNode]]),
    aspects: [aggregateAspect, refAspect, llmAspect],
    flows: [], rootPath: '/fake/.yggdrasil',
  };

  it('buildNodeContextData: aggregate aspect verifies against yg-aspect.yaml; references surface', () => {
    const data = buildNodeContextData(richGraph, 'rich');
    const agg = data.aspects.find((a) => a.id === 'bundle');
    expect(agg!.verifiedAgainst).toBe('.yggdrasil/aspects/bundle/yg-aspect.yaml');
    const ref = data.aspects.find((a) => a.id === 'ref-aspect');
    expect(ref!.references).toEqual([{ path: 'docs/table.md', description: 'lookup table' }]);
  });

  it('buildFileContextData: aggregate verifies against yg-aspect.yaml; references surface', () => {
    const data = buildFileContextData(richGraph, 'src/rich.ts', 'rich');
    const agg = data.aspects.find((a) => a.aspectId === 'bundle');
    expect(agg!.verifiedAgainst).toBe('.yggdrasil/aspects/bundle/yg-aspect.yaml');
    const ref = data.aspects.find((a) => a.aspectId === 'ref-aspect');
    expect(ref!.references).toEqual([{ path: 'docs/table.md', description: 'lookup table' }]);
  });
});

describe('companionReadPath (Task 7)', () => {
  const llmAspectWithCompanion: AspectDef = {
    name: 'LLM With Companion',
    id: 'llm-companion-aspect',
    reviewer: { type: 'llm' as const },
    artifacts: [{ filename: 'content.md', content: 'rule text' }],
    hasCompanion: true,
  };
  const llmAspectNoCompanion: AspectDef = {
    name: 'LLM No Companion',
    id: 'llm-plain-aspect',
    reviewer: { type: 'llm' as const },
    artifacts: [{ filename: 'content.md', content: 'rule text' }],
  };
  const detAspect: AspectDef = {
    name: 'Deterministic',
    id: 'det-aspect',
    reviewer: { type: 'deterministic' as const },
    artifacts: [{ filename: 'check.mjs', content: 'export function check(ctx){return [];}' }],
  };
  const aggAspect: AspectDef = {
    name: 'Aggregate',
    id: 'agg-aspect',
    reviewer: { type: 'aggregate' as const },
    artifacts: [],
    implies: ['llm-plain-aspect'],
  } as unknown as AspectDef;

  const companionNode: GraphNode = {
    path: 'svc',
    meta: {
      name: 'Svc',
      type: 'service',
      aspects: ['llm-companion-aspect', 'llm-plain-aspect', 'det-aspect', 'agg-aspect'],
      mapping: ['src/svc.ts'],
    },
    children: [],
    parent: null,
  };
  const companionGraph: Graph = {
    config: {},
    architecture: { node_types: { service: { description: 'svc' } } },
    nodes: new Map([['svc', companionNode]]),
    aspects: [llmAspectWithCompanion, llmAspectNoCompanion, detAspect, aggAspect],
    flows: [],
    rootPath: '/fake/.yggdrasil',
  };

  it('buildNodeContextData: LLM aspect with hasCompanion emits companionReadPath', () => {
    const data = buildNodeContextData(companionGraph, 'svc');
    const aspect = data.aspects.find((a) => a.id === 'llm-companion-aspect');
    expect(aspect).toBeDefined();
    expect((aspect as any).companionReadPath).toBe('.yggdrasil/aspects/llm-companion-aspect/companion.mjs');
  });

  it('buildNodeContextData: plain LLM aspect (no companion) has no companionReadPath', () => {
    const data = buildNodeContextData(companionGraph, 'svc');
    const aspect = data.aspects.find((a) => a.id === 'llm-plain-aspect');
    expect(aspect).toBeDefined();
    expect((aspect as any).companionReadPath).toBeUndefined();
  });

  it('buildNodeContextData: deterministic aspect never gets companionReadPath', () => {
    const data = buildNodeContextData(companionGraph, 'svc');
    const aspect = data.aspects.find((a) => a.id === 'det-aspect');
    expect(aspect).toBeDefined();
    expect((aspect as any).companionReadPath).toBeUndefined();
  });

  it('buildNodeContextData: aggregate aspect never gets companionReadPath', () => {
    const data = buildNodeContextData(companionGraph, 'svc');
    const aspect = data.aspects.find((a) => a.id === 'agg-aspect');
    expect(aspect).toBeDefined();
    expect((aspect as any).companionReadPath).toBeUndefined();
  });

  it('buildFileContextData: LLM aspect with hasCompanion emits companionReadPath', () => {
    const data = buildFileContextData(companionGraph, 'src/svc.ts', 'svc');
    const aspect = data.aspects.find((a) => a.aspectId === 'llm-companion-aspect');
    expect(aspect).toBeDefined();
    expect((aspect as any).companionReadPath).toBe('.yggdrasil/aspects/llm-companion-aspect/companion.mjs');
  });

  it('buildFileContextData: plain LLM aspect (no companion) has no companionReadPath', () => {
    const data = buildFileContextData(companionGraph, 'src/svc.ts', 'svc');
    const aspect = data.aspects.find((a) => a.aspectId === 'llm-plain-aspect');
    expect(aspect).toBeDefined();
    expect((aspect as any).companionReadPath).toBeUndefined();
  });

  it('buildFileContextData: deterministic aspect never gets companionReadPath', () => {
    const data = buildFileContextData(companionGraph, 'src/svc.ts', 'svc');
    const aspect = data.aspects.find((a) => a.aspectId === 'det-aspect');
    expect(aspect).toBeDefined();
    expect((aspect as any).companionReadPath).toBeUndefined();
  });

  it('buildFileContextData: aggregate aspect never gets companionReadPath', () => {
    const data = buildFileContextData(companionGraph, 'src/svc.ts', 'svc');
    const aspect = data.aspects.find((a) => a.aspectId === 'agg-aspect');
    expect(aspect).toBeDefined();
    expect((aspect as any).companionReadPath).toBeUndefined();
  });
});


