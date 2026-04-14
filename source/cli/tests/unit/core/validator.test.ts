import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { validate } from '../../../src/core/validator.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');
const FIXTURE_ORPHAN_DIR = path.join(__dirname, '../../fixtures/sample-project-orphan-dir');
const CLI_ROOT = path.join(__dirname, '../../../..');

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
    aspects: [{ name: 'Valid', id: 'valid-tag', artifacts: [] }],
    flows: [],
    schemas: [],
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
    expect(result.issues[0].message).toContain('Node not found');
    expect(result.nodesScanned).toBe(0);
  });

  it('validate with configError pushes invalid-config issue', async () => {
    const graph = createGraph();
    graph.configError = 'Config parse failed';
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const configIssue = result.issues.find((i) => i.rule === 'invalid-config');
    expect(configIssue).toBeDefined();
    expect(configIssue!.message).toContain('yg-config.yaml failed to parse.');
    expect(configIssue!.message).toContain('Config parse failed');
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
    expect(issues[0].message).toContain('not defined in aspects/');
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
    expect(issues[0].message).toContain('missing-aspect');
    expect(issues[0].message).toContain("port 'api'");
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
    expect(issues[0].message).toContain('undefined-arch-aspect');
    expect(issues[0].message).toContain("architecture type 'service'");
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
    expect(issues[0].message).toContain('missing-flow-aspect');
    expect(issues[0].message).toContain("flow");
    expect(issues[0].message).toContain("missing-flow-aspect");
  });

  it('duplicate-aspect-binding returns error when id bound to multiple aspects', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'Aspect One', id: 'audit', artifacts: [] },
        { name: 'Aspect Two', id: 'audit', artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'duplicate-aspect-binding');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('duplicate-aspect-id');
    expect(issues[0].message).toContain('audit');
    expect(issues[0].message).toContain('Aspect One');
    expect(issues[0].message).toContain('Aspect Two');
  });


  it('invalid-node-yaml reports parse errors from graph loader', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-parse-error');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    const badNodeDir = path.join(modelDir, 'bad-node');

    await mkdir(badNodeDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'yg-config.yaml'),
      'version: "4.0.0"',
    );
    await writeFile(path.join(badNodeDir, 'yg-node.yaml'), 'type: service\n# missing name');

    try {
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'invalid-node-yaml');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('yaml-invalid');
      expect(issues[0].nodePath).toBe('bad-node');
      expect(issues[0].message).toContain('name');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('missing-node-yaml catches orphan directory with content', async () => {
    const graph = await loadGraph(FIXTURE_ORPHAN_DIR);
    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-node-yaml');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('no yg-node.yaml');
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
      'version: "4.0.0"',
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

  it('overlapping-mapping errors for exact duplicate mapping paths', async () => {
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
    const issues = result.issues.filter((i) => i.rule === 'overlapping-mapping');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
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

  it('overlapping-mapping errors for exact duplicate between parent and child nodes', async () => {
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
    const issues = result.issues.filter((i) => i.rule === 'overlapping-mapping');
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
      return i.message.includes('unknown node type') || i.message.includes('unknown relation type');
    });
    expect(typeOrRelationVocabularyIssues).toHaveLength(0);
  });

  it('non-regression: does not require interface.yaml by node type', async () => {
    const graph = createGraph();
    graph.nodes.set('api/no-interface', createNode('api/no-interface', { type: 'api' }));

    const result = await validate(graph);
    const interfaceIssues = result.issues.filter((i) => i.message.includes('interface.yaml'));
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
      return i.message.includes('does not exist');
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
    expect(issues[0].message).not.toContain('did you mean');
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
    expect(issues[0].message).toContain('Did you mean');
    expect(issues[0].message).toContain('orders/order-service');
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
    expect(issues.some((i) => i.message.includes('non-existent node'))).toBe(true);
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
    const issues = result.issues.filter((i) => i.rule === 'dangling-aspect-ref' && i.message.includes('flow'));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("undefined-tag");
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
    const issues = result.issues.filter((i) => i.rule === 'dangling-aspect-ref' && i.message.includes('flow'));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("not defined in aspects");
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
    expect(issues[0].message).toContain('5 direct relations');
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
    expect(issues[0].message).toContain('Circular dependency');
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
        { name: 'Aspect1', id: 'dup-tag', artifacts: [] },
        { name: 'Aspect2', id: 'dup-tag', artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'duplicate-aspect-binding');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('duplicate-aspect-id');
    expect(issues[0].message).toContain('multiple aspects');
  });

  it('implied-aspect-missing returns error when implied id has no aspect', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'HIPAA', id: 'requires-hipaa', implies: ['requires-audit'], artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'implied-aspect-missing');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('implied-aspect-missing');
    expect(issues[0].message).toContain('HIPAA');
    expect(issues[0].message).toContain('requires-audit');
  });

  it('aspect-implies-cycle returns error when implies form cycle', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'A', id: 'tag-a', implies: ['tag-b'], artifacts: [] },
        { name: 'B', id: 'tag-b', implies: ['tag-a'], artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'aspect-implies-cycle');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('aspect-implies-cycle');
    expect(issues[0].message).toContain('cycle');
    expect(issues[0].message).toContain('tag-a');
    expect(issues[0].message).toContain('tag-b');
  });

  it('checkSchemas: missing-schema when required schema is missing', async () => {
    const graph = createGraph();
    graph.schemas = [{ schemaType: 'node' }, { schemaType: 'aspect' }];
    // flow missing

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-schema');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('schema-missing');
    expect(issues[0].message).toContain('flow');
  });

  it('checkSchemas: no missing-schema when all 3 schemas present', async () => {
    const graph = createGraph();
    graph.schemas = [
      { schemaType: 'node' },
      { schemaType: 'aspect' },
      { schemaType: 'flow' },
    ];

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-schema');
    expect(issues).toHaveLength(0);
  });

  it('scoped validate returns parse error instead of "not found" for broken node', async () => {
    const graph = createGraph({
      nodeParseErrors: [
        { nodePath: 'broken/node', message: 'yg-node.yaml at broken/node/yg-node.yaml: file is empty' },
      ],
    });
    // The broken node is NOT in graph.nodes (it failed to parse)
    const result = await validate(graph, 'broken/node');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('yaml-invalid');
    expect(result.issues[0].rule).toBe('invalid-node-yaml');
    expect(result.issues[0].message).toContain('empty');
  });

  it('scoped validate returns parse error for child of broken node', async () => {
    const graph = createGraph({
      nodeParseErrors: [
        { nodePath: 'broken', message: 'yg-node.yaml at broken/yg-node.yaml: file is empty' },
      ],
    });
    const result = await validate(graph, 'broken/child');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('yaml-invalid');
  });

  it('wide-node warns when directory mapping resolves to many files', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-wide-node');
    const srcDir = path.join(tmpDir, 'src', 'wide');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model', 'wide');

    await mkdir(srcDir, { recursive: true });
    await mkdir(modelDir, { recursive: true });
    // Create 12 source files (exceeds default max of 10)
    for (let i = 0; i < 12; i++) {
      await writeFile(path.join(srcDir, `file${i}.ts`), `export const x${i} = ${i};`);
    }
    await writeFile(
      path.join(yggRoot, 'yg-config.yaml'),
      'version: "4.0.0"',
    );
    // Create an aspect so the node has effective aspects (nodes without aspects skip wide-node check)
    const aspDir = path.join(yggRoot, 'aspects', 'testing');
    await mkdir(aspDir, { recursive: true });
    await writeFile(path.join(aspDir, 'yg-aspect.yaml'), 'name: Testing\ndescription: test\n');
    await writeFile(path.join(aspDir, 'content.md'), 'Test rule.\n');
    await writeFile(
      path.join(modelDir, 'yg-node.yaml'),
      'name: Wide\ntype: service\ndescription: x\naspects:\n  - testing\nmapping:\n  - src/wide',
    );
    try {
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'wide-node');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('wide-node');
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].message).toContain('12 source files');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
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
      expect(issues[0].message).toContain('no description');
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
        aspects: [{ name: 'NoDesc', id: 'no-desc-aspect', artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a'));

      const result = await validate(graph);
      const issues = result.issues.filter(
        (i) => i.rule === 'missing-description' && i.message.includes("'no-desc-aspect'"),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('description-missing');
      expect(issues[0].severity).toBe('error');
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
        (i) => i.rule === 'missing-description' && i.message.includes("'checkout-flow'"),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('description-missing');
      expect(issues[0].severity).toBe('error');
    });
  });

  describe('Architecture Constraints', () => {
    it('invalid-relation-target when relation target type not allowed', async () => {
      const graph = createGraph({
        architecture: {
          node_types: {
            service: {
              description: 'A service',
              relations: { calls: ['service', 'module'] }, // can call service or module only
            },
            library: { description: 'A library' },
            module: { description: 'A module' },
          },
        },
      });
      graph.nodes.set('a', createNode('a', {
        type: 'service',
        relations: [{ target: 'b', type: 'calls' }],
      }));
      graph.nodes.set('b', createNode('b', { type: 'library' })); // library not in allowed list

      const result = await validate(graph);
      const relationTargetForbidden = result.issues.find(i => i.code === 'relation-target-forbidden' && i.nodePath === 'a');
      expect(relationTargetForbidden).toBeDefined();
      expect(relationTargetForbidden!.message).toContain('calls');
      expect(relationTargetForbidden!.message).toContain('library');
    });

    it('invalid-relation-target not fired when relation target type is allowed', async () => {
      const graph = createGraph({
        architecture: {
          node_types: {
            service: {
              description: 'A service',
              relations: { calls: ['service', 'module'] },
            },
            module: { description: 'A module' },
          },
        },
      });
      graph.nodes.set('a', createNode('a', {
        type: 'service',
        relations: [{ target: 'b', type: 'calls' }],
      }));
      graph.nodes.set('b', createNode('b', { type: 'module' }));

      const result = await validate(graph);
      const relationTargetForbidden = result.issues.find(i => i.code === 'relation-target-forbidden' && i.nodePath === 'a');
      expect(relationTargetForbidden).toBeUndefined();
    });

    it('invalid-parent-type when parent type not in allowed list', async () => {
      const parentNode = createNode('parent', { type: 'library' });
      const childNode = createNode('parent/child', { type: 'service' });
      childNode.parent = parentNode;

      const graph = createGraph({
        architecture: {
          node_types: {
            service: {
              description: 'A service',
              parents: ['module'], // only 'module' is allowed as parent
            },
            library: { description: 'A library' },
            module: { description: 'A module' },
          },
        },
      });
      graph.nodes.set('parent', parentNode);
      graph.nodes.set('parent/child', childNode);

      const result = await validate(graph);
      const parentTypeForbidden = result.issues.find(i => i.code === 'parent-type-forbidden' && i.nodePath === 'parent/child');
      expect(parentTypeForbidden).toBeDefined();
      expect(parentTypeForbidden!.message).toContain('library');
      expect(parentTypeForbidden!.message).toContain('service');
    });

    it('invalid-parent-type not fired when parent type is in allowed list', async () => {
      const parentNode = createNode('parent', { type: 'module' });
      const childNode = createNode('parent/child', { type: 'service' });
      childNode.parent = parentNode;

      const graph = createGraph({
        architecture: {
          node_types: {
            service: {
              description: 'A service',
              parents: ['module'],
            },
            module: { description: 'A module' },
          },
        },
      });
      graph.nodes.set('parent', parentNode);
      graph.nodes.set('parent/child', childNode);

      const result = await validate(graph);
      const parentTypeForbidden = result.issues.find(i => i.code === 'parent-type-forbidden' && i.nodePath === 'parent/child');
      expect(parentTypeForbidden).toBeUndefined();
    });

    it('integration-aspect-missing when consumer uses a port whose required aspect is not defined', async () => {
      const graph = createGraph({ aspects: [] }); // no aspects defined
      // Target node with a port that requires 'audit-logging'
      graph.nodes.set('target', createNode('target', {
        ports: { 'api': { description: 'API port', aspects: ['audit-logging'] } },
      }));
      // Consumer node with a relation that consumes the port
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'target', type: 'uses', consumes: ['api'] }],
      }));

      const result = await validate(graph);
      const portMissingAspect = result.issues.filter(i => i.code === 'port-missing-aspect' && i.nodePath === 'consumer');
      expect(portMissingAspect).toHaveLength(1);
      expect(portMissingAspect[0].rule).toBe('integration-aspect-missing');
      expect(portMissingAspect[0].message).toContain('audit-logging');
      expect(portMissingAspect[0].message).toContain("port 'api'");
    });

    it('integration-aspect-missing not fired when consumer uses a port whose required aspect exists', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'audit-logging', artifacts: [] }],
      });
      graph.nodes.set('target', createNode('target', {
        ports: { 'api': { description: 'API port', aspects: ['audit-logging'] } },
      }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'target', type: 'uses', consumes: ['api'] }],
      }));

      const result = await validate(graph);
      const portMissingAspect = result.issues.filter(i => i.code === 'port-missing-aspect' && i.nodePath === 'consumer');
      expect(portMissingAspect).toHaveLength(0);
    });

    it('integration-aspect-missing not fired when relation has no consumes field (no port consumption)', async () => {
      const graph = createGraph({ aspects: [] });
      graph.nodes.set('target', createNode('target', {
        ports: { 'api': { description: 'API port', aspects: ['audit-logging'] } },
      }));
      // Relation to target but no consumes — not consuming any port
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'target', type: 'uses' }],
      }));

      const result = await validate(graph);
      const portMissingAspect = result.issues.filter(i => i.code === 'port-missing-aspect' && i.nodePath === 'consumer');
      expect(portMissingAspect).toHaveLength(0);
    });

    it('skips architecture checks when architecture is empty', async () => {
      const graph = createGraph({
        architecture: { node_types: {} }, // empty architecture
      });
      graph.nodes.set('a', createNode('a', {
        type: 'unknown-type',
        relations: [{ target: 'b', type: 'unknown-rel' as any }],
      }));

      const result = await validate(graph);
      const archErrors = result.issues.filter(i => ['aspect-undefined', 'relation-target-forbidden', 'parent-type-forbidden', 'port-missing-aspect'].includes(i.code));
      // Should skip architecture checks when architecture has no node_types (fallback case)
      expect(archErrors.length).toBe(0);
    });
  });

  describe('missing-consumes', () => {
    it('fires when relation target has ports but consumer has no consumes', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', artifacts: [] }],
      });
      graph.nodes.set('provider', createNode('provider', {
        ports: { charge: { description: 'Pay', aspects: ['valid-tag'] } },
      }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls' }],
      }));

      const result = await validate(graph);
      const portMissingConsumes = result.issues.filter(i => i.code === 'port-missing-consumes');
      expect(portMissingConsumes).toContainEqual(expect.objectContaining({
        code: 'port-missing-consumes', rule: 'missing-consumes',
      }));
    });

    it('does not fire when target has empty ports (ports: {})', async () => {
      const graph = createGraph();
      graph.nodes.set('provider', createNode('provider', { ports: {} }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls' }],
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'port-missing-consumes')).toHaveLength(0);
    });

    it('does not fire when target has no ports', async () => {
      const graph = createGraph();
      graph.nodes.set('provider', createNode('provider'));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls' }],
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'port-missing-consumes')).toHaveLength(0);
    });

    it('does not fire when consumer has consumes field', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', artifacts: [] }],
      });
      graph.nodes.set('provider', createNode('provider', {
        ports: { charge: { description: 'Pay', aspects: ['valid-tag'] } },
      }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls', consumes: ['charge'] }],
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'port-missing-consumes')).toHaveLength(0);
    });

    it('does not fire for emits/listens relations even when target has ports', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', artifacts: [] }],
      });
      graph.nodes.set('provider', createNode('provider', {
        ports: { charge: { description: 'Pay', aspects: ['valid-tag'] } },
      }));
      graph.nodes.set('emitter', createNode('emitter', {
        relations: [{ target: 'provider', type: 'emits' }],
      }));
      graph.nodes.set('listener', createNode('listener', {
        relations: [{ target: 'provider', type: 'listens' }],
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'port-missing-consumes')).toHaveLength(0);
    });
  });

  describe('unknown-port', () => {
    it('fires when consumes references non-existent port', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', artifacts: [] }],
      });
      graph.nodes.set('provider', createNode('provider', {
        ports: { charge: { description: 'Pay', aspects: ['valid-tag'] } },
      }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls', consumes: ['nonexistent'] }],
      }));

      const result = await validate(graph);
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: 'port-undefined', rule: 'unknown-port',
      }));
    });

    it('does not fire when consumes references a valid port', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', artifacts: [] }],
      });
      graph.nodes.set('provider', createNode('provider', {
        ports: { charge: { description: 'Pay', aspects: ['valid-tag'] } },
      }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls', consumes: ['charge'] }],
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'port-undefined')).toHaveLength(0);
    });
  });

  describe('consumes-without-ports', () => {
    it('fires when relation has consumes but target has no ports', async () => {
      const graph = createGraph();
      // Provider has NO ports
      graph.nodes.set('provider', createNode('provider'));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls', consumes: ['some-port'] }],
      }));

      const result = await validate(graph);
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: 'consumes-without-ports', rule: 'consumes-without-ports',
      }));
    });

    it('does not fire when relation has consumes and target has ports', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', artifacts: [] }],
      });
      // Provider HAS ports
      graph.nodes.set('provider', createNode('provider', {
        ports: { charge: { description: 'Pay', aspects: ['valid-tag'] } },
      }));
      graph.nodes.set('consumer', createNode('consumer', {
        relations: [{ target: 'provider', type: 'calls', consumes: ['charge'] }],
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'consumes-without-ports')).toHaveLength(0);
    });
  });

  describe('orphaned-aspect', () => {
    it('fires when aspect is not used by any node, architecture, or flow', async () => {
      const graph = createGraph({
        aspects: [
          { name: 'Valid', id: 'valid-tag', description: 'Referenced', artifacts: [] },
          { name: 'Orphan', id: 'orphan-aspect', description: 'Never used', artifacts: [] },
        ],
      });
      graph.nodes.set('a', createNode('a', { aspects: ['valid-tag'] }));

      const result = await validate(graph);
      const w006 = result.issues.filter(i => i.code === 'orphaned-aspect');
      expect(w006).toContainEqual(expect.objectContaining({
        code: 'orphaned-aspect', rule: 'orphaned-aspect',
      }));
      // 'valid-tag' is referenced so should not appear
      expect(w006.every(i => !i.message.includes('valid-tag'))).toBe(true);
    });

    it('does not fire when aspect is referenced by a node', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Used', id: 'valid-tag', description: 'Used', artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a', { aspects: ['valid-tag'] }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'orphaned-aspect')).toHaveLength(0);
    });

    it('does not fire when aspect is referenced by a port', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Used', id: 'valid-tag', description: 'Used', artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a', {
        ports: { api: { description: 'API', aspects: ['valid-tag'] } },
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'orphaned-aspect')).toHaveLength(0);
    });

    it('does not fire when aspect is referenced by a flow', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Used', id: 'valid-tag', description: 'Used', artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a'));
      graph.flows.push({
        path: 'checkout-flow',
        name: 'Checkout',
        nodes: ['a'],
        aspects: ['valid-tag'],
      });

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'orphaned-aspect')).toHaveLength(0);
    });

    it('does not fire for implied aspects when the implying aspect is referenced', async () => {
      const graph = createGraph({
        aspects: [
          { name: 'HIPAA', id: 'hipaa', description: 'Used', implies: ['audit'], artifacts: [] },
          { name: 'Audit', id: 'audit', description: 'Implied', artifacts: [] },
        ],
      });
      graph.nodes.set('a', createNode('a', { aspects: ['hipaa'] }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'orphaned-aspect')).toHaveLength(0);
    });
  });

  describe('CLI exit codes', () => {
    it('exit code 0 when no errors', () => {
      const fixturePath = path.resolve(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
      const binPath = path.resolve(CLI_ROOT, 'dist', 'bin.js');
      const result = spawnSync('node', [binPath, 'validate'], {
        cwd: fixturePath,
        encoding: 'utf-8',
      });

      if (result.error?.message?.includes('ENOENT')) {
        return;
      }

      expect(result.status).toBe(0);
    });

    it('exit code 1 when errors exist', () => {
      const fixturePath = path.resolve(CLI_ROOT, 'tests', 'fixtures', 'sample-project-orphan-dir');
      const binPath = path.resolve(CLI_ROOT, 'dist', 'bin.js');
      const result = spawnSync('node', [binPath, 'validate'], {
        cwd: fixturePath,
        encoding: 'utf-8',
      });

      if (result.error?.message?.includes('ENOENT')) {
        return;
      }

      expect(result.status).toBe(1);
    });
  });
});
