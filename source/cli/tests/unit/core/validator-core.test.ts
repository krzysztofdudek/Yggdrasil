import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { validate } from '../../../src/core/validator.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
const msgOf = (i: { messageData: Parameters<typeof buildIssueMessage>[0] }) => buildIssueMessage(i.messageData);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');
const FIXTURE_ORPHAN_DIR = path.join(__dirname, '../../fixtures/sample-project-orphan-dir');

function createNode(nodePath: string, overrides: Partial<GraphNode['meta']> = {}): GraphNode {
  const name = nodePath.split('/').pop() ?? nodePath;
  return {
    path: nodePath,
    meta: {
      name,
      type: 'service',
      ...overrides,
    },
    children: [],
    parent: null,
  };
}

function createGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(),
    aspects: [{ name: 'Valid', id: 'valid-tag', reviewer: { type: 'llm' as const }, artifacts: [] }],
    flows: [],
    rootPath: path.join(FIXTURE_PROJECT, '.yggdrasil'),
    ...overrides,
  };
}

describe('validator', () => {
  it('validate with invalid scope returns error', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const result = await validate(graph, 'nonexistent/node');

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].rule).toBe('invalid-scope');
    expect(msgOf(result.issues[0])).toContain('Node not found');
    expect(result.nodesScanned).toBe(0);
  });

  it('validate with configError pushes invalid-config issue', async () => {
    const graph = createGraph();
    graph.configError = 'Config parse failed';
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const configIssue = result.issues.find((i) => i.rule === 'invalid-config');
    expect(configIssue).toBeDefined();
    expect(msgOf(configIssue!)).toContain('yg-config.yaml failed to parse.');
    expect(msgOf(configIssue!)).toContain('Config parse failed');
  });

  it('returns only expected errors for sample-project', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const result = await validate(graph);

    const errors = result.issues.filter((i) => i.severity === 'error');
    // mapping-path-missing: users/missing-service maps src/users/missing.service.ts which doesn't exist on disk
    // (intentional fixture — used by drift tests to verify "missing" detection)
    const unexpectedErrors = errors.filter(
      (i) => !(i.code === 'mapping-path-missing' && i.nodePath === 'users/missing-service'),
    );
    expect(unexpectedErrors).toHaveLength(0);
    expect(result.nodesScanned).toBe(9);
  }, 10000);

  it('relation-targets-exist returns error for missing relation target', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'a',
      createNode('a', { relations: [{ target: 'missing/target', type: 'uses' }] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-relation');
    expect(issues).toHaveLength(1);
    expect(issues[0].nodePath).toBe('a');
  });

  it('dangling-aspect-ref returns error when node aspect has no aspect def', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { aspects: ['no-aspect-for-this'] }));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'dangling-aspect-ref');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('aspect-undefined');
    expect(msgOf(issues[0])).toContain('not defined in aspects/');
  });

  it('dangling-aspect-ref fires when a port references an undefined aspect', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', {
      ports: { 'api': { description: 'API port', aspects: ['missing-aspect'] } },
    }));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-undefined' && i.nodePath === 'a');
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('dangling-aspect-ref');
    expect(msgOf(issues[0])).toContain('missing-aspect');
    expect(msgOf(issues[0])).toContain("port 'api'");
  });

  it('dangling-aspect-ref fires when architecture node_type references an undefined aspect', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          service: { description: 'A service', aspects: ['undefined-arch-aspect'] },
        },
      },
      aspects: [],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-undefined' && !i.nodePath);
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('dangling-aspect-ref');
    expect(msgOf(issues[0])).toContain('undefined-arch-aspect');
    expect(msgOf(issues[0])).toContain("architecture type 'service'");
  });

  it('dangling-aspect-ref fires when a flow references an undefined aspect', async () => {
    const graph = createGraph({ aspects: [] });
    graph.nodes.set('a', createNode('a'));
    graph.flows.push({
      path: 'checkout-flow',
      name: 'Checkout',
      nodes: ['a'],
      aspects: ['missing-flow-aspect'],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-undefined');
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('dangling-aspect-ref');
    expect(msgOf(issues[0])).toContain('missing-flow-aspect');
    expect(msgOf(issues[0])).toContain("flow");
    expect(msgOf(issues[0])).toContain("missing-flow-aspect");
  });

  it('duplicate-aspect-binding returns error when id bound to multiple aspects', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'Aspect One', id: 'audit', reviewer: { type: 'llm' as const }, artifacts: [] },
        { name: 'Aspect Two', id: 'audit', reviewer: { type: 'llm' as const }, artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'duplicate-aspect-binding');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('duplicate-aspect-id');
    expect(msgOf(issues[0])).toContain('audit');
    expect(msgOf(issues[0])).toContain('Aspect One');
    expect(msgOf(issues[0])).toContain('Aspect Two');
  });


  it('invalid-node-yaml reports parse errors from graph loader', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-parse-error');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    const badNodeDir = path.join(modelDir, 'bad-node');

    await mkdir(badNodeDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'yg-config.yaml'),
      'version: "5.2.0"',
    );
    await writeFile(path.join(badNodeDir, 'yg-node.yaml'), 'type: service\n# missing name');

    try {
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'invalid-node-yaml');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('yaml-invalid');
      expect(issues[0].nodePath).toBe('bad-node');
      expect(msgOf(issues[0])).toContain('name');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('missing-node-yaml catches orphan directory with content', async () => {
    const graph = await loadGraph(FIXTURE_ORPHAN_DIR);
    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-node-yaml');
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain('no yg-node.yaml');
    expect(issues[0].nodePath).toBe('orders/orphan-service');
    expect(issues[0].code).toBe('node-yaml-missing');
  });

  it('directories-have-node-yaml catches orphan directory with content in model', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-orphan');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    const orphanDir = path.join(modelDir, 'orphan-with-content');
    const serviceDir = path.join(modelDir, 'svc');

    await mkdir(orphanDir, { recursive: true });
    await mkdir(serviceDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'yg-config.yaml'),
      'version: "5.2.0"',
    );
    await writeFile(path.join(serviceDir, 'yg-node.yaml'), 'name: Svc\ntype: service\n');
    await writeFile(path.join(orphanDir, 'readme.md'), '# orphan content');

    try {
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'missing-node-yaml');
      expect(issues).toHaveLength(1);
      expect(issues[0].nodePath).toBe('orphan-with-content');
      expect(issues[0].code).toBe('node-yaml-missing');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('file-duplicate-mapping errors for exact duplicate mapping paths', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'svc/a',
      createNode('svc/a', { mapping: ['src/shared/file.ts'] }),
    );
    graph.nodes.set(
      'svc/b',
      createNode('svc/b', { mapping: ['src/shared/file.ts'] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'file-duplicate-mapping');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(result.issues.filter((i) => i.rule === 'overlapping-mapping')).toHaveLength(0);
  });

  it('overlapping-mapping errors for containment overlap between siblings', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'svc/a',
      createNode('svc/a', { mapping: ['src/shared'] }),
    );
    graph.nodes.set(
      'svc/b',
      createNode('svc/b', { mapping: ['src/shared/file.ts'] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'overlapping-mapping');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
  });

  it('overlapping-mapping allows containment overlap between parent and child nodes', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'platform',
      createNode('platform', { mapping: ['src/platform'] }),
    );
    graph.nodes.set(
      'platform/auth',
      createNode('platform/auth', { mapping: ['src/platform/auth'] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'overlapping-mapping');
    expect(issues).toHaveLength(0);
  });

  it('file-duplicate-mapping errors for exact duplicate between parent and child nodes', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'platform',
      createNode('platform', { mapping: ['src/platform'] }),
    );
    graph.nodes.set(
      'platform/auth',
      createNode('platform/auth', { mapping: ['src/platform'] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'file-duplicate-mapping');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
  });

  it('config-populated returns no issues for valid config', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'config-populated');
    expect(issues).toHaveLength(0);
  });

  it('non-regression: does not enforce node/relation vocabulary', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'strange/node',
      createNode('strange/node', {
        type: 'totally-custom-type',
        relations: [{ target: 'strange/target', type: 'uses' }],
      }),
    );
    graph.nodes.set(
      'strange/target',
      createNode('strange/target', { type: 'another-custom-type' }),
    );

    const result = await validate(graph);
    const typeOrRelationVocabularyIssues = result.issues.filter((i) => {
      return msgOf(i).includes('unknown node type') || msgOf(i).includes('unknown relation type');
    });
    expect(typeOrRelationVocabularyIssues).toHaveLength(0);
  });

  it('non-regression: does not require interface.yaml by node type', async () => {
    const graph = createGraph();
    graph.nodes.set('api/no-interface', createNode('api/no-interface', { type: 'api' }));

    const result = await validate(graph);
    const interfaceIssues = result.issues.filter((i) => msgOf(i).includes('interface.yaml'));
    expect(interfaceIssues).toHaveLength(0);
  });

  it('non-regression: check does not validate mapped file existence on disk', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'svc/nonexistent-mapping',
      createNode('svc/nonexistent-mapping', {
        mapping: ['src'],
      }),
    );

    const result = await validate(graph);
    const mappingExistenceIssues = result.issues.filter((i) => {
      return msgOf(i).includes('does not exist');
    });
    expect(mappingExistenceIssues).toHaveLength(0);
  });

  it('flow validation uses FlowDef[] (not nodes)', async () => {
    const graph = createGraph();
    graph.nodes.set('svc/a', createNode('svc/a'));
    const result = await validate(graph);
    const flowRules = result.issues.filter((i) =>
      [
        'flow-type-in-flows-dir',
        'flow-outside-flows-dir',
        'flow-missing-description',
        'flow-bidirectional-relations',
      ].includes(i.rule),
    );
    expect(flowRules).toHaveLength(0);
  });

  it('relation-targets no suggestion when no similar candidates', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { relations: [{ target: 'xyz/unknown', type: 'uses' }] }));
    graph.nodes.set('b', createNode('b'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-relation');
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).not.toContain('did you mean');
  });

  it('relation-targets suggests similar path when target not found', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'a',
      createNode('a', { relations: [{ target: 'orders/ordr-servce', type: 'uses' }] }),
    );
    graph.nodes.set('orders/order-service', createNode('orders/order-service'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-relation');
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain('Did you mean');
    expect(msgOf(issues[0])).toContain('orders/order-service');
  });

  it('broken-flow-ref returns error for non-existent node in flow', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.flows.push({
      path: 'f1',
      name: 'F1',
      nodes: ['a', 'nonexistent/node'],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-flow-ref');
    expect(issues.some((i) => msgOf(i).includes('non-existent node'))).toBe(true);
  });

  it('flow aspect id must have corresponding aspect', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.flows.push({
      path: 'saga-flow',
      name: 'SagaFlow',
      nodes: ['a'],
      aspects: ['undefined-tag'],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'dangling-aspect-ref' && msgOf(i).includes('flow'));
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain("undefined-tag");
  });

  it('flow aspect id without corresponding aspect returns error', async () => {
    const graph = createGraph({ aspects: [] });
    graph.nodes.set('a', createNode('a'));
    graph.flows.push({
      path: 'f2',
      name: 'F2',
      nodes: ['a'],
      aspects: ['valid-tag'],
    });
    // aspects[] is empty — no aspect binds to valid-tag

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'dangling-aspect-ref' && msgOf(i).includes('flow'));
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain("not defined in aspects");
  });

  it('high-fan-out warns when node exceeds max_direct_relations', async () => {
    const graph = createGraph();
    graph.config.quality = {
      max_direct_relations: 2,
    };
    const relations = Array.from({ length: 5 }, (_, i) => ({
      target: `target/${i}`,
      type: 'uses' as const,
    }));
    graph.nodes.set('a', createNode('a', { relations }));
    for (let i = 0; i < 5; i++) {
      graph.nodes.set(`target/${i}`, createNode(`target/${i}`));
    }

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'high-fan-out');
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain('5 direct relations');
  });

  // --- Reviewed-seam per-node max_direct_relations override ---
  // A node that is a deliberate single-responsibility seam may declare its OWN,
  // higher, justified ceiling. The global default stays strict for every other
  // node, and the override never silences a node that exceeds its OWN ceiling.

  function fanOutGraph(
    relationCount: number,
    globalMax: number,
    override?: { limit: number; reason: string },
  ): Graph {
    const graph = createGraph();
    graph.config.quality = { max_direct_relations: globalMax };
    const relations = Array.from({ length: relationCount }, (_, i) => ({
      target: `target/${i}`,
      type: 'uses' as const,
    }));
    graph.nodes.set('seam', createNode('seam', { relations, ...(override && { maxDirectRelations: override }) }));
    for (let i = 0; i < relationCount; i++) {
      graph.nodes.set(`target/${i}`, createNode(`target/${i}`));
    }
    return graph;
  }

  it('high-fan-out: a node WITHOUT an override warns above the strict global default', async () => {
    // 21 relations, global 20, no override → warns (unchanged behavior).
    const result = await validate(fanOutGraph(21, 20));
    const issues = result.issues.filter((i) => i.rule === 'high-fan-out');
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain('21 direct relations (max: 20)');
  });

  it('high-fan-out: a declared override raises ONLY that node\'s ceiling (no warning at the sanctioned count)', async () => {
    // 21 relations, global 20, override limit 21 → no warning.
    const result = await validate(
      fanOutGraph(21, 20, { limit: 21, reason: 'Single reviewed seam.' }),
    );
    const issues = result.issues.filter((i) => i.rule === 'high-fan-out');
    expect(issues).toHaveLength(0);
  });

  it('high-fan-out: an override does NOT silence a node that exceeds its OWN declared ceiling', async () => {
    // 22 relations, global 20, override limit 21 → still warns, against the node's own ceiling.
    const result = await validate(
      fanOutGraph(22, 20, { limit: 21, reason: 'Single reviewed seam.' }),
    );
    const issues = result.issues.filter((i) => i.rule === 'high-fan-out');
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain('22 direct relations (max: 21)');
  });

  it('unpaired-event warns when emits without listens', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'emitter',
      createNode('emitter', { relations: [{ target: 'listener', type: 'emits' }] }),
    );
    graph.nodes.set('listener', createNode('listener'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'unpaired-event');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('unpaired-event warns when listens without emits', async () => {
    const graph = createGraph();
    graph.nodes.set('emitter', createNode('emitter'));
    graph.nodes.set(
      'listener',
      createNode('listener', { relations: [{ target: 'emitter', type: 'listens' }] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'unpaired-event');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('structural-cycle detects circular dependency', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { relations: [{ target: 'b', type: 'uses' }] }));
    graph.nodes.set('b', createNode('b', { relations: [{ target: 'a', type: 'uses' }] }));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'structural-cycle');
    expect(issues).toHaveLength(1);
    expect(msgOf(issues[0])).toContain('Circular dependency');
  });

  it('validate with scope filters issues to that node only', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { relations: [{ target: 'missing', type: 'uses' }] }));
    graph.nodes.set('b', createNode('b'));

    const result = await validate(graph, 'b');
    expect(result.nodesScanned).toBe(1);
    expect(result.issues.filter((i) => i.nodePath === 'a')).toHaveLength(0);
  });

  it('validate with scope all scans all nodes', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.nodes.set('b', createNode('b'));
    const result = await validate(graph, 'all');
    expect(result.nodesScanned).toBe(2);
  });

  it('validate with empty scope uses all nodes', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.nodes.set('b', createNode('b'));
    const result = await validate(graph, '   ');
    expect(result.nodesScanned).toBe(2);
  });

  it('aspect-id-uniqueness returns error when id bound to multiple aspects', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'Aspect1', id: 'dup-tag', reviewer: { type: 'llm' as const }, artifacts: [] },
        { name: 'Aspect2', id: 'dup-tag', reviewer: { type: 'llm' as const }, artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'duplicate-aspect-binding');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('duplicate-aspect-id');
    expect(msgOf(issues[0])).toContain('multiple aspects');
  });

  it('implied-aspect-missing returns error when implied id has no aspect', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'HIPAA', id: 'requires-hipaa', implies: ['requires-audit'], reviewer: { type: 'llm' as const }, artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'implied-aspect-missing');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('implied-aspect-missing');
    expect(msgOf(issues[0])).toContain('HIPAA');
    expect(msgOf(issues[0])).toContain('requires-audit');
  });

  it('aspect-implies-cycle returns error when implies form cycle', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'A', id: 'tag-a', implies: ['tag-b'], reviewer: { type: 'llm' as const }, artifacts: [] },
        { name: 'B', id: 'tag-b', implies: ['tag-a'], reviewer: { type: 'llm' as const }, artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'aspect-implies-cycle');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('aspect-implies-cycle');
    expect(msgOf(issues[0])).toContain('cycle');
    expect(msgOf(issues[0])).toContain('tag-a');
    expect(msgOf(issues[0])).toContain('tag-b');
  });

  it('scoped validate returns parse error instead of "not found" for broken node', async () => {
    const graph = createGraph({
      nodeParseErrors: [
        { nodePath: 'broken/node', messageData: { what: 'yg-node.yaml parse error in broken/node.', why: 'yg-node.yaml at broken/node/yg-node.yaml: file is empty', next: 'Fix the YAML in .yggdrasil/model/broken/node/yg-node.yaml.' } },
      ],
    });
    // The broken node is NOT in graph.nodes (it failed to parse)
    const result = await validate(graph, 'broken/node');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('yaml-invalid');
    expect(result.issues[0].rule).toBe('invalid-node-yaml');
    expect(msgOf(result.issues[0])).toContain('empty');
  });

  it('scoped validate returns parse error for child of broken node', async () => {
    const graph = createGraph({
      nodeParseErrors: [
        { nodePath: 'broken', messageData: { what: 'yg-node.yaml parse error in broken.', why: 'yg-node.yaml at broken/yg-node.yaml: file is empty', next: 'Fix the YAML in .yggdrasil/model/broken/yg-node.yaml.' } },
      ],
    });
    const result = await validate(graph, 'broken/child');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('yaml-invalid');
  });

  describe('missing-description', () => {
    it('missing-description emitted for a node without description', async () => {
      const graph = createGraph();
      graph.nodes.set('svc/no-desc', createNode('svc/no-desc'));

      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'missing-description' && i.nodePath === 'svc/no-desc');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('description-missing');
      expect(issues[0].severity).toBe('error');
      expect(msgOf(issues[0])).toContain('no description');
    });

    it('no missing-description when node has description set', async () => {
      const graph = createGraph();
      graph.nodes.set('svc/with-desc', createNode('svc/with-desc', { description: 'A useful service.' }));

      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'missing-description' && i.nodePath === 'svc/with-desc');
      expect(issues).toHaveLength(0);
    });

    it('missing-description emitted for an aspect without description', async () => {
      const graph = createGraph({
        aspects: [{ name: 'NoDesc', id: 'no-desc-aspect', reviewer: { type: 'llm' as const }, artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a'));

      const result = await validate(graph);
      const issues = result.issues.filter(
        (i) => i.rule === 'missing-description' && msgOf(i).includes("'no-desc-aspect'"),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('description-missing');
      expect(issues[0].severity).toBe('error');
      // Structured identity: the aspect this issue concerns, not just prose.
      expect(issues[0].aspectId).toBe('no-desc-aspect');
    });

    it('missing-description emitted for a flow without description', async () => {
      const graph = createGraph();
      graph.nodes.set('a', createNode('a'));
      graph.flows.push({
        path: 'checkout-flow',
        name: 'checkout-flow',
        nodes: ['a'],
      });

      const result = await validate(graph);
      const issues = result.issues.filter(
        (i) => i.rule === 'missing-description' && msgOf(i).includes("'checkout-flow'"),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('description-missing');
      expect(issues[0].severity).toBe('error');
      // Structured identity: the flow this issue concerns — a flow has no
      // nodePath, so without this there is nothing to match it against.
      expect(issues[0].flowName).toBe('checkout-flow');
    });
  });
});
