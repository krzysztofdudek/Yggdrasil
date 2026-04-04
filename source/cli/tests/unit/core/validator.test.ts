import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { validate } from '../../../src/core/validator.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode } from '../../../src/model/types.js';

vi.mock('../../../src/core/context-builder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/context-builder.js')>();
  return {
    ...actual,
    buildContext: vi.fn().mockResolvedValue({
      nodePath: 'x',
      nodeName: 'X',
      layers: [],
      mapping: null,
      tokenCount: 100,
    }),
  };
});

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
    artifacts: [{ filename: 'responsibility.md', content: 'x'.repeat(60) }],
    children: [],
    parent: null,
  };
}

function createGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    config: {
      name: 'Test',
      node_types: { service: { description: 'x' } },
    },
    nodes: new Map(),
    aspects: [{ name: 'Valid', id: 'valid-tag', anchors: [{ id: 'proof-point', claim: 'Has a proof point' }], artifacts: [] }],
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
    expect(configIssue!.message).toBe('Config parse failed');
  });

  it('returns only expected errors for sample-project', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const result = await validate(graph);

    const errors = result.issues.filter((i) => i.severity === 'error');
    // E036: users/missing-service maps src/users/missing.service.ts which doesn't exist on disk
    // (intentional fixture — used by drift tests to verify "missing" detection)
    const unexpectedErrors = errors.filter(
      (i) => !(i.code === 'E036' && i.nodePath === 'users/missing-service'),
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

  it('unknown-aspect (E003) returns error when node aspect has no aspect def', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { aspects: ['no-aspect-for-this'] }));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'unknown-aspect');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('E003');
    expect(issues[0].message).toContain('no corresponding directory');
  });

  it('duplicate-aspect-binding returns E010 when id bound to multiple aspects', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'Aspect One', id: 'audit', anchors: [{ id: 'proof', claim: 'Proof provided' }], artifacts: [] },
        { name: 'Aspect Two', id: 'audit', anchors: [{ id: 'proof', claim: 'Proof provided' }], artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'duplicate-aspect-binding');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('E010');
    expect(issues[0].message).toContain('audit');
    expect(issues[0].message).toContain('Aspect One');
    expect(issues[0].message).toContain('Aspect Two');
  });


  it('infrastructure is accepted as valid node type', async () => {
    const graph = createGraph({
      config: {
        name: 'Test',
        node_types: { service: { description: 'x' }, infrastructure: { description: 'x' } },
      },
    });
    graph.nodes.set('guard', createNode('guard', { type: 'infrastructure' }));

    const result = await validate(graph);
    const typeErrors = result.issues.filter((i) => i.rule === 'unknown-node-type');
    expect(typeErrors).toHaveLength(0);
  });

  it('invalid-node-yaml reports parse errors from graph loader', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-parse-error');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    const badNodeDir = path.join(modelDir, 'bad-node');

    await mkdir(badNodeDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'yg-config.yaml'),
      'name: V\nnode_types:\n  service:\n    description: x',
    );
    await writeFile(path.join(badNodeDir, 'yg-node.yaml'), 'type: service\n# missing name');

    try {
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'invalid-node-yaml');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('E001');
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
    expect(issues[0].code).toBe('E011');
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
      'name: V\nnode_types:\n  service:\n    description: x',
    );
    await writeFile(path.join(serviceDir, 'yg-node.yaml'), 'name: Svc\ntype: service\n');
    await writeFile(path.join(orphanDir, 'readme.md'), '# orphan content');

    try {
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'missing-node-yaml');
      expect(issues).toHaveLength(1);
      expect(issues[0].nodePath).toBe('orphan-with-content');
      expect(issues[0].code).toBe('E011');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // W013 (directory-without-node) removed — subsumed by E022

  it('missing-artifact errors when non-blackbox node lacks required artifact', async () => {
    const graph = createGraph();
    graph.nodes.set('a/no-responsibility', {
      ...createNode('a/no-responsibility', { blackbox: false }),
      artifacts: [],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-artifact');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('responsibility');
  });

  it('missing-artifact does not warn when required is never (internals.md)', async () => {
    const graph = createGraph();
    graph.nodes.set('a', {
      ...createNode('a'),
      artifacts: [{ filename: 'responsibility.md', content: 'x'.repeat(60) }],
    });

    const result = await validate(graph);
    // internals.md has required: 'never' in STANDARD_ARTIFACTS, so no warning for it
    const issues = result.issues.filter(
      (i) => i.rule === 'missing-artifact' && i.message.includes('internals.md'),
    );
    expect(issues).toHaveLength(0);
  });

  it('missing-artifact does not warn for blackbox nodes', async () => {
    const graph = createGraph();
    graph.nodes.set('a/blackbox-no-description', {
      ...createNode('a/blackbox-no-description', { blackbox: true }),
      artifacts: [],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-artifact');
    expect(issues).toHaveLength(0);
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

  it('config-populated is empty (v2.2: replaced by E012)', async () => {
    const graph = createGraph({
      config: {
        name: 'Test',
        node_types: { service: { description: 'x' } },
      },
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'config-populated');
    expect(issues).toHaveLength(0);
  });

  it('non-regression: does not enforce node/relation vocabulary', async () => {
    const graph = createGraph();
    graph.config.node_types = {
      'totally-custom-type': { description: 'x' },
      'another-custom-type': { description: 'x' },
    };
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
    graph.config.node_types = { service: { description: 'x' }, api: { description: 'x' } };
    graph.nodes.set('api/no-interface', {
      ...createNode('api/no-interface', { type: 'api' }),
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
    });

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

  it('v2.2: flow rules removed (flows are FlowDef[], not nodes)', async () => {
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

  it('budget-warning returns warning when over warning threshold with breakdown', async () => {
    const { buildContext } = await import('../../../src/core/context-builder.js');
    // 12000 tokens = 48000 chars of content in layers
    vi.mocked(buildContext).mockResolvedValue({
      nodePath: 'a',
      nodeName: 'A',
      layers: [
        { type: 'own', label: 'Own', content: 'x'.repeat(20000) },
        { type: 'hierarchy', label: 'Hierarchy', content: 'x'.repeat(12000) },
        { type: 'aspects', label: 'Aspects', content: 'x'.repeat(8000) },
        { type: 'flows', label: 'Flows', content: 'x'.repeat(4000) },
        { type: 'relational', label: 'Deps', content: 'x'.repeat(4000) },
      ],
      mapping: null,
      tokenCount: 12000,
    } as Awaited<ReturnType<typeof buildContext>>);

    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'budget-warning');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].code).toBe('W001');
    // Verify breakdown components in message
    expect(issues[0].message).toContain('own:');
    expect(issues[0].message).toContain('hierarchy:');
    expect(issues[0].message).toContain('aspects:');
    expect(issues[0].message).toContain('flows:');
    expect(issues[0].message).toContain('dependencies:');
  });

  it('budget-exceeded returns error when over error threshold with breakdown', async () => {
    const { buildContext } = await import('../../../src/core/context-builder.js');
    vi.mocked(buildContext).mockResolvedValue({
      nodePath: 'a',
      nodeName: 'A',
      layers: [
        { type: 'own', label: 'Own', content: 'x'.repeat(80000) },
        { type: 'hierarchy', label: 'Hierarchy', content: 'x'.repeat(12000) },
        { type: 'aspects', label: 'Aspects', content: 'x'.repeat(4000) },
        { type: 'flows', label: 'Flows', content: 'x'.repeat(2000) },
        { type: 'relational', label: 'Deps', content: 'x'.repeat(2000) },
      ],
      mapping: null,
      tokenCount: 25000,
    } as Awaited<ReturnType<typeof buildContext>>);

    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'budget-exceeded');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('E032');
    expect(issues[0].severity).toBe('error');
    // Verify breakdown components in message
    expect(issues[0].message).toContain('own:');
    expect(issues[0].message).toContain('hierarchy:');
    expect(issues[0].message).toContain('aspects:');
    expect(issues[0].message).toContain('flows:');
    expect(issues[0].message).toContain('dependencies:');
    // Should NOT contain "blocks materialization"
    expect(issues[0].message).not.toContain('blocks materialization');
  });

  it('W002 own-budget-warning fires when own artifacts exceed own_warning threshold', async () => {
    const { buildContext } = await import('../../../src/core/context-builder.js');
    // own layer needs >= 5000 tokens => 20000 chars
    vi.mocked(buildContext).mockResolvedValue({
      nodePath: 'a',
      nodeName: 'A',
      layers: [
        { type: 'own', label: 'Own', content: 'x'.repeat(24000) },
      ],
      mapping: null,
      tokenCount: 6000,
    } as Awaited<ReturnType<typeof buildContext>>);

    const graph = createGraph();
    graph.config.quality = {
      min_artifact_length: 50,
      max_direct_relations: 10,
      context_budget: { warning: 10000, error: 20000, own_warning: 5000 },
    };
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'own-budget-warning');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('W002');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].nodePath).toBe('a');
  });

  it('W002 not emitted when own_warning absent from config', async () => {
    const { buildContext } = await import('../../../src/core/context-builder.js');
    vi.mocked(buildContext).mockResolvedValue({
      nodePath: 'a',
      nodeName: 'A',
      layers: [
        { type: 'own', label: 'Own', content: 'x'.repeat(24000) },
      ],
      mapping: null,
      tokenCount: 6000,
    } as Awaited<ReturnType<typeof buildContext>>);

    const graph = createGraph();
    graph.config.quality = {
      min_artifact_length: 50,
      max_direct_relations: 10,
      context_budget: { warning: 10000, error: 20000 },
    };
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'own-budget-warning');
    expect(issues).toHaveLength(0);
  });

  it('context-budget catches buildContext errors and continues', async () => {
    const { buildContext } = await import('../../../src/core/context-builder.js');
    vi.mocked(buildContext).mockRejectedValueOnce(new Error('Context build failed'));

    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    expect(result.issues.filter((i) => i.rule === 'budget-warning')).toHaveLength(0);
    expect(result.issues.filter((i) => i.rule === 'budget-exceeded')).toHaveLength(0);
  });

  it('context-budget skips blackbox nodes', async () => {
    const { buildContext } = await import('../../../src/core/context-builder.js');
    vi.mocked(buildContext).mockClear();

    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { blackbox: true }));

    await validate(graph);
    expect(buildContext).not.toHaveBeenCalled();
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
      name: 'F1',
      nodes: ['a', 'nonexistent/node'],
      artifacts: [{ filename: 'desc.md', content: 'x' }],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-flow-ref');
    expect(issues.some((i) => i.message.includes('non-existent node'))).toBe(true);
  });

  it('flow aspect id must have corresponding aspect', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.flows.push({
      name: 'SagaFlow',
      nodes: ['a'],
      aspects: ['undefined-tag'],
      artifacts: [{ filename: 'desc.md', content: 'x' }],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-aspect-ref');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("Flow 'SagaFlow'");
    expect(issues[0].message).toContain("undefined-tag");
  });

  it('flow aspect id without corresponding aspect returns error', async () => {
    const graph = createGraph({ aspects: [] });
    graph.nodes.set('a', createNode('a'));
    graph.flows.push({
      name: 'F2',
      nodes: ['a'],
      aspects: ['valid-tag'],
      artifacts: [{ filename: 'desc.md', content: 'x' }],
    });
    // aspects[] is empty — no aspect binds to valid-tag

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-aspect-ref');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("no aspect with that id exists");
  });

  it('shallow-artifact errors when artifact below min_artifact_length', async () => {
    const graph = createGraph();
    graph.config.quality = {
      min_artifact_length: 100,
      max_direct_relations: 10,
      context_budget: { warning: 5000, error: 10000 },
    };
    graph.nodes.set('a', {
      ...createNode('a'),
      artifacts: [{ filename: 'responsibility.md', content: 'short' }],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'shallow-artifact');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('below minimum length');
  });

  it('high-fan-out warns when node exceeds max_direct_relations', async () => {
    const graph = createGraph();
    graph.config.quality = {
      min_artifact_length: 50,
      max_direct_relations: 2,
      context_budget: { warning: 5000, error: 10000 },
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

  it('structural-cycle tolerates cycle when blackbox node is in cycle', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { relations: [{ target: 'b', type: 'uses' }] }));
    graph.nodes.set(
      'b',
      createNode('b', { blackbox: true, relations: [{ target: 'a', type: 'uses' }] }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'structural-cycle');
    expect(issues).toHaveLength(0);
  });

  it('missing-artifact errors for interface.md when node has incoming relations', async () => {
    const graph = createGraph();
    graph.nodes.set('dep', createNode('dep', { relations: [{ target: 'svc', type: 'uses' }] }));
    graph.nodes.set('svc', {
      ...createNode('svc'),
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
    });

    const result = await validate(graph);
    const issues = result.issues.filter(
      (i) => i.rule === 'missing-artifact' && i.nodePath === 'svc',
    );
    // interface.md has required: { when: 'has_incoming_relations' } in STANDARD_ARTIFACTS
    expect(issues.some((i) => i.message.includes('interface.md'))).toBe(true);
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
        { name: 'Aspect1', id: 'dup-tag', anchors: [{ id: 'proof', claim: 'Proof provided' }], artifacts: [] },
        { name: 'Aspect2', id: 'dup-tag', anchors: [{ id: 'proof', claim: 'Proof provided' }], artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'duplicate-aspect-binding');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('E010');
    expect(issues[0].message).toContain('multiple aspects');
  });

  it('implied-aspect-missing returns error when implied id has no aspect', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'HIPAA', id: 'requires-hipaa', anchors: [{ id: 'proof', claim: 'Proof provided' }], implies: ['requires-audit'], artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'implied-aspect-missing');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('E012');
    expect(issues[0].message).toContain('HIPAA');
    expect(issues[0].message).toContain('requires-audit');
  });

  it('aspect-implies-cycle returns error when implies form cycle', async () => {
    const graph = createGraph({
      aspects: [
        { name: 'A', id: 'tag-a', anchors: [{ id: 'proof', claim: 'Proof provided' }], implies: ['tag-b'], artifacts: [] },
        { name: 'B', id: 'tag-b', anchors: [{ id: 'proof', claim: 'Proof provided' }], implies: ['tag-a'], artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'aspect-implies-cycle');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('E013');
    expect(issues[0].message).toContain('cycle');
    expect(issues[0].message).toContain('tag-a');
    expect(issues[0].message).toContain('tag-b');
  });

  // E035 tests removed — replaced by E051 in architecture enforcement

  it('unknown-node-type returns error for node type not in config', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { type: 'unknown-type' }));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'unknown-node-type');
    expect(issues).toHaveLength(1);
  });

  it('checkSchemas: E034 when required schema is missing', async () => {
    const graph = createGraph();
    graph.schemas = [{ schemaType: 'node' }, { schemaType: 'aspect' }];
    // flow missing

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-schema');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('E034');
    expect(issues[0].message).toContain('flow');
  });

  it('checkSchemas: no E034 when all 3 schemas present', async () => {
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
    expect(result.issues[0].code).toBe('E001');
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
    expect(result.issues[0].code).toBe('E001');
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
      'name: V\nnode_types:\n  service:\n    description: x',
    );
    await writeFile(
      path.join(modelDir, 'yg-node.yaml'),
      'name: Wide\ntype: service\ndescription: x\nmapping:\n  - src/wide',
    );
    await writeFile(
      path.join(modelDir, 'responsibility.md'),
      'Wide node responsibility — maps many source files for testing purposes.',
    );

    try {
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'wide-node');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('W003');
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].message).toContain('12 source files');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe('E038 missing-description', () => {
    it('E038 emitted for a node without description', async () => {
      const graph = createGraph();
      graph.nodes.set('svc/no-desc', createNode('svc/no-desc'));

      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'missing-description' && i.nodePath === 'svc/no-desc');
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('E038');
      expect(issues[0].severity).toBe('error');
      expect(issues[0].message).toContain('no description');
    });

    it('no E038 when node has description set', async () => {
      const graph = createGraph();
      graph.nodes.set('svc/with-desc', createNode('svc/with-desc', { description: 'A useful service.' }));

      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'missing-description' && i.nodePath === 'svc/with-desc');
      expect(issues).toHaveLength(0);
    });

    it('E038 emitted for an aspect without description', async () => {
      const graph = createGraph({
        aspects: [{ name: 'NoDesc', id: 'no-desc-aspect', anchors: [{ id: 'proof', claim: 'Proof provided' }], artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a'));

      const result = await validate(graph);
      const issues = result.issues.filter(
        (i) => i.rule === 'missing-description' && i.message.includes("'no-desc-aspect'"),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('E038');
      expect(issues[0].severity).toBe('error');
    });

    it('E038 emitted for a flow without description', async () => {
      const graph = createGraph();
      graph.nodes.set('a', createNode('a'));
      graph.flows.push({
        name: 'checkout-flow',
        nodes: ['a'],
        artifacts: [{ filename: 'description.md', content: 'x'.repeat(60) }],
      });

      const result = await validate(graph);
      const issues = result.issues.filter(
        (i) => i.rule === 'missing-description' && i.message.includes("'checkout-flow'"),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe('E038');
      expect(issues[0].severity).toBe('error');
    });
  });

  describe('E039 aspect-missing-anchors', () => {
    it('E039: aspect with empty anchors array', async () => {
      const graph = createGraph({
        aspects: [{ name: 'EmptyAnchors', id: 'empty-anchors', anchors: [], artifacts: [] }],
      });
      const result = await validate(graph);
      const e039 = result.issues.find(i => i.code === 'E039');
      expect(e039).toBeDefined();
      expect(e039!.rule).toBe('aspect-missing-anchors');
      expect(e039!.message).toContain('at least one anchor');
      expect(e039!.nodePath).toBe('aspects/empty-anchors');
    });

    it('no E039 for aspect with anchors', async () => {
      const graph = createGraph({
        aspects: [{ name: 'HasAnchors', id: 'has-anchors', anchors: [{ id: 'proof-point', claim: 'Proof point claimed' }], artifacts: [] }],
      });
      const result = await validate(graph);
      const e039 = result.issues.filter(i => i.code === 'E039');
      expect(e039).toHaveLength(0);
    });
  });

  describe('E040 anchor-not-realized', () => {

    it('no E040 when mapping group anchors have all required fields', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Logging', id: 'logging', anchors: [{ id: 'audit-entry', claim: 'Audit entry logged' }], artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a', {
        mapping: [{
          paths: ['src/a/'],
          aspects: [
            {
              aspect: 'logging',
              anchors: {
                'audit-entry': { regex: 'createAuditLog', rationale: 'Needed for compliance' },
              },
            },
          ],
        }],
      }));
      const result = await validate(graph);
      const e040 = result.issues.filter(i => i.code === 'E040');
      expect(e040).toHaveLength(0);
    });

    it('no E040 for blackbox nodes (exempt from anchor validation)', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Logging', id: 'logging', anchors: [{ id: 'audit-entry', claim: 'Audit entry logged' }], artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a', {
        blackbox: true,
        mapping: {
          paths: ['src/a/'],
          aspects: [
            {
              aspect: 'logging',
              anchors: {
                'audit-entry': { regex: '', rationale: '' }, // missing fields, but blackbox exempts
              },
            },
          ],
        },
      }));
      const result = await validate(graph);
      const e040 = result.issues.filter(i => i.code === 'E040' && i.nodePath === 'a');
      expect(e040).toHaveLength(0);
    });

    it('no E040 for event relations (emits/listens) even if target has integration_anchors', async () => {
      const graph = createGraph();
      graph.nodes.set('target', createNode('target', {
        mapping: ['src/target/'],
      }));
      graph.nodes.set('listener', createNode('listener', {
        relations: [{ target: 'target', type: 'listens' }], // event relation, not structural
        mapping: ['src/listener/'],
      }));
      const result = await validate(graph);
      const e040 = result.issues.filter(i => i.code === 'E040' && i.nodePath === 'listener');
      expect(e040).toHaveLength(0);
    });

    // E040 and E041 tests removed: relation.anchors field no longer exists
    // Integration anchors are now defined in mapping groups, not on relations
  });

  describe('E037 anchor-not-found', () => {
    async function createTmpProjectForAnchors(name: string, opts: {
      nodeYaml: string;
      sourceFiles?: Record<string, string>;
      aspects?: Array<{ id: string; yaml: string }>;
      extraNodes?: Array<{ path: string; yaml: string }>;
    }): Promise<{ tmpDir: string }> {
      const tmpDir = path.join(__dirname, `../../fixtures/tmp-validator-${name}`);
      const yggRoot = path.join(tmpDir, '.yggdrasil');
      const modelDir = path.join(yggRoot, 'model', 'svc');

      await mkdir(modelDir, { recursive: true });
      await writeFile(
        path.join(yggRoot, 'yg-config.yaml'),
        'name: V\nnode_types:\n  service:\n    description: x',
      );
      await writeFile(path.join(modelDir, 'yg-node.yaml'), opts.nodeYaml);
      await writeFile(path.join(modelDir, 'responsibility.md'), 'x'.repeat(60));

      // Create source files
      for (const [filePath, content] of Object.entries(opts.sourceFiles ?? {})) {
        const absPath = path.join(tmpDir, filePath);
        await mkdir(path.dirname(absPath), { recursive: true });
        await writeFile(absPath, content);
      }

      // Create aspects
      for (const aspect of opts.aspects ?? []) {
        const aspectDir = path.join(yggRoot, 'aspects', aspect.id);
        await mkdir(aspectDir, { recursive: true });
        await writeFile(path.join(aspectDir, 'yg-aspect.yaml'), aspect.yaml);
      }

      // Create extra nodes
      for (const extra of opts.extraNodes ?? []) {
        const nodeDir = path.join(yggRoot, 'model', extra.path);
        await mkdir(nodeDir, { recursive: true });
        await writeFile(path.join(nodeDir, 'yg-node.yaml'), extra.yaml);
        await writeFile(path.join(nodeDir, 'responsibility.md'), 'x'.repeat(60));
      }

      // Create required schemas
      const schemasDir = path.join(yggRoot, 'schemas');
      await mkdir(schemasDir, { recursive: true });
      await writeFile(path.join(schemasDir, 'yg-node.yaml'), '# node schema');
      await writeFile(path.join(schemasDir, 'yg-aspect.yaml'), '# aspect schema');
      await writeFile(path.join(schemasDir, 'yg-flow.yaml'), '# flow schema');

      return { tmpDir };
    }

    it.skip('E037: mapping group regex pattern not found in source files', async () => {
      const { tmpDir } = await createTmpProjectForAnchors('e037', {
        nodeYaml: `name: Svc\ntype: service\ndescription: test\nmapping:\n  - paths:\n      - src/\n    aspects:\n      - aspect: logging\n        anchors:\n          audit-entry:\n            regex: "NONEXISTENT_PATTERN"\n            rationale: "Test rationale"\n`,
        sourceFiles: { 'src/index.ts': 'export function hello() { return 42; }\n' },
        aspects: [{ id: 'logging', yaml: 'name: Logging\ndescription: test\nanchors:\n  - audit-entry\n' }],
      });
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const e037 = result.issues.find(i => i.code === 'E037');
      expect(e037).toBeDefined();
      expect(e037!.message).toContain('NONEXISTENT_PATTERN');
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('no E037 when mapping group regex matches source', async () => {
      const { tmpDir } = await createTmpProjectForAnchors('e037-match', {
        nodeYaml: `name: Svc\ntype: service\ndescription: test\nmapping:\n  - paths:\n      - src/\n    aspects:\n      - aspect: logging\n        anchors:\n          audit-entry:\n            regex: "hello"\n            rationale: "Test rationale"\n`,
        sourceFiles: { 'src/index.ts': 'export function hello() { return 42; }\n' },
        aspects: [{ id: 'logging', yaml: 'name: Logging\ndescription: test\nanchors:\n  - audit-entry\n' }],
      });
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const e037 = result.issues.filter(i => i.code === 'E037');
      expect(e037).toHaveLength(0);
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('E037: blackbox exempt from anchor-not-found', async () => {
      const { tmpDir } = await createTmpProjectForAnchors('e037-blackbox', {
        nodeYaml: `name: Legacy\ntype: service\ndescription: test\nblackbox: true\nmapping:\n  - paths:\n      - src/\n    aspects:\n      - aspect: logging\n        anchors:\n          audit-entry:\n            regex: "NONEXISTENT"\n            rationale: "Test rationale"\n`,
        sourceFiles: { 'src/index.ts': 'nothing here\n' },
        aspects: [{ id: 'logging', yaml: 'name: Logging\ndescription: test\nanchors:\n  - audit-entry\n' }],
      });
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const e037 = result.issues.filter(i => i.code === 'E037');
      expect(e037).toHaveLength(0);
      await rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('Architecture Constraints (E050-E054)', () => {
    // E050, E053, E054 checks disabled — will be replaced by LLM claim verification in Plan 2
    // These tests are kept for reference but skipped since mapping groups no longer carry aspects

    it.skip('E050: missing-required-aspect when mapping group lacks required aspect', async () => {
      const graph = createGraph({
        architecture: {
          node_types: {
            service: {
              description: 'A service',
              aspects: ['audit-logging'],
            },
          },
        },
        aspects: [{ name: 'Audit', id: 'audit-logging', anchors: [{ id: 'proof', claim: 'Proof provided' }], artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a', {
        type: 'service',
        mapping: ['src/service.ts'], // No aspects declared in group
      }));

      const result = await validate(graph);
      const e050 = result.issues.find(i => i.code === 'E050' && i.nodePath === 'a');
      expect(e050).toBeDefined();
      expect(e050!.message).toContain('audit-logging');
      expect(e050!.message).toContain('architecture');
    });

    it.skip('E050: not fired when mapping group declares required aspect', async () => {
      const graph = createGraph({
        architecture: {
          node_types: {
            service: {
              description: 'A service',
              aspects: ['audit-logging'],
            },
          },
        },
        aspects: [{ name: 'Audit', id: 'audit-logging', anchors: [{ id: 'proof', claim: 'Proof provided' }], artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a', {
        type: 'service',
        mapping: ['src/service.ts'],
      }));

      const result = await validate(graph);
      const e050 = result.issues.find(i => i.code === 'E050' && i.nodePath === 'a');
      expect(e050).toBeUndefined();
    });

    it('E051: invalid-relation-target when relation target type not allowed', async () => {
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
      const e051 = result.issues.find(i => i.code === 'E051' && i.nodePath === 'a');
      expect(e051).toBeDefined();
      expect(e051!.message).toContain('calls');
      expect(e051!.message).toContain('library');
    });

    it('E051: not fired when relation target type is allowed', async () => {
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
      const e051 = result.issues.find(i => i.code === 'E051' && i.nodePath === 'a');
      expect(e051).toBeUndefined();
    });

    it('E052: invalid-parent-type when parent type not in allowed list', async () => {
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
      const e052 = result.issues.find(i => i.code === 'E052' && i.nodePath === 'parent/child');
      expect(e052).toBeDefined();
      expect(e052!.message).toContain('library');
      expect(e052!.message).toContain('service');
    });

    it('E052: not fired when parent type is in allowed list', async () => {
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
      const e052 = result.issues.find(i => i.code === 'E052' && i.nodePath === 'parent/child');
      expect(e052).toBeUndefined();
    });

    it.skip('E054: unexpected-aspect when mapping group declares aspect outside allowed set', async () => {
      // Skipped — E054 checks removed with mapping group aspects
    });

    it.skip('E054: not fired when all declared aspects are in allowed set', async () => {
      // Skipped — E054 checks removed with mapping group aspects
    });

    it.skip('E050: message includes flow source when aspect comes from flow', async () => {
      // Skipped — E050 checks removed
    });

    it.skip('E050: message includes parent source when aspect comes from parent inheritance', async () => {
      // Skipped — E050 checks removed
    });

    it.skip('E053: integration-aspect-missing when consumer lacks target integration aspect', async () => {
      // Skipped — E053 checks removed with mapping group aspects
    });

    it.skip('E053: not fired when consumer declares required integration aspect', async () => {
      // Skipped — E053 checks removed with mapping group aspects
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
      const archErrors = result.issues.filter(i => ['E050', 'E051', 'E052', 'E053', 'E054'].includes(i.code));
      // Should skip architecture checks when architecture has no node_types (fallback case)
      expect(archErrors.length).toBe(0);
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
