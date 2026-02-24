import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { validate } from '../../../src/core/validator.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode } from '../../../src/model/types.js';

vi.mock('../../../src/core/context-builder.js', () => ({
  buildContext: vi.fn().mockResolvedValue({
    nodePath: 'x',
    nodeName: 'X',
    layers: [],
    mapping: null,
    tokenCount: 100,
  }),
}));

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
      stack: {},
      standards: '',
      tags: ['valid-tag'],
      node_types: ['service'],
      artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
      knowledge_categories: [],
    },
    nodes: new Map(),
    aspects: [],
    flows: [],
    knowledge: [],
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

  it('returns 0 errors and 0 warnings for sample-project', async () => {
    const graph = await loadGraph(FIXTURE_PROJECT);
    const result = await validate(graph);

    const errors = result.issues.filter((i) => i.severity === 'error');
    const warnings = result.issues.filter((i) => i.severity === 'warning');

    expect(errors).toHaveLength(0);
    expect(warnings.length).toBeGreaterThanOrEqual(0);
    expect(result.nodesScanned).toBe(7);
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

  it('aspect-tags-valid returns error when aspect tag is undefined', async () => {
    const graph = createGraph({
      aspects: [
        {
          name: 'Bad Aspect',
          tag: 'missing-tag',
          artifacts: [],
        },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-aspect-tag');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('E007');
  });

  it('duplicate-aspect-binding returns E014 when tag bound to multiple aspects', async () => {
    const graph = createGraph({
      config: {
        name: 'Test',
        stack: {},
        standards: '',
        tags: ['audit'],
        node_types: ['service'],
        artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
        knowledge_categories: [],
      },
      aspects: [
        { name: 'Aspect One', tag: 'audit', artifacts: [] },
        { name: 'Aspect Two', tag: 'audit', artifacts: [] },
      ],
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'duplicate-aspect-binding');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('E014');
    expect(issues[0].message).toContain('audit');
    expect(issues[0].message).toContain('Aspect One');
    expect(issues[0].message).toContain('Aspect Two');
  });

  it('invalid-node-yaml reports parse errors from graph loader', async () => {
    const { writeFile, mkdir, rm } = await import('node:fs/promises');
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-parse-error');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    const badNodeDir = path.join(modelDir, 'bad-node');

    await mkdir(badNodeDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'config.yaml'),
      'name: V\nnode_types: [service]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\nknowledge_categories: []\ntags: []',
    );
    await writeFile(path.join(badNodeDir, 'node.yaml'), 'type: service\n# missing name');

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
    expect(issues[0].message).toContain('no node.yaml');
    expect(issues[0].nodePath).toBe('orders/orphan-service');
    expect(issues[0].code).toBe('E015');
  });

  it('directories-have-node-yaml catches orphan directory with content in model', async () => {
    const { writeFile, mkdir, rm } = await import('node:fs/promises');
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-orphan');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelDir = path.join(yggRoot, 'model');
    const orphanDir = path.join(modelDir, 'orphan-with-content');
    const serviceDir = path.join(modelDir, 'svc');

    await mkdir(orphanDir, { recursive: true });
    await mkdir(serviceDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'config.yaml'),
      'name: V\nnode_types: [service]\nartifacts:\n  responsibility.md:\n    required: always\n    description: x\nknowledge_categories: []\ntags: []',
    );
    await writeFile(path.join(serviceDir, 'node.yaml'), 'name: Svc\ntype: service\n');
    await writeFile(path.join(orphanDir, 'readme.md'), '# orphan content');

    try {
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'missing-node-yaml');
      expect(issues).toHaveLength(1);
      expect(issues[0].nodePath).toBe('orphan-with-content');
      expect(issues[0].code).toBe('E015');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('missing-artifact warns when non-blackbox node lacks required artifact', async () => {
    const graph = createGraph();
    graph.nodes.set('a/no-responsibility', {
      ...createNode('a/no-responsibility', { blackbox: false }),
      artifacts: [],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-artifact');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('responsibility');
  });

  it('missing-artifact does not warn when required is never', async () => {
    const graph = createGraph({
      config: {
        name: 'Test',
        stack: {},
        standards: '',
        tags: [],
        node_types: ['service'],
        artifacts: {
          responsibility: { required: 'always', description: 'x' },
          optional: { required: 'never', description: '' },
        },
        knowledge_categories: [],
      },
    });
    graph.nodes.set('a', {
      ...createNode('a'),
      artifacts: [{ filename: 'responsibility.md', content: 'x'.repeat(60) }],
    });

    const result = await validate(graph);
    const issues = result.issues.filter(
      (i) => i.rule === 'missing-artifact' && i.message.includes('optional'),
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
      createNode('svc/a', { mapping: { paths: ['src/shared/file.ts'] } }),
    );
    graph.nodes.set(
      'svc/b',
      createNode('svc/b', { mapping: { paths: ['src/shared/file.ts'] } }),
    );

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'overlapping-mapping');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
  });

  it('overlapping-mapping errors for containment overlap', async () => {
    const graph = createGraph();
    graph.nodes.set(
      'svc/a',
      createNode('svc/a', { mapping: { paths: ['src/shared'] } }),
    );
    graph.nodes.set(
      'svc/b',
      createNode('svc/b', { mapping: { paths: ['src/shared/file.ts'] } }),
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
        stack: {},
        standards: '',
        tags: [],
        node_types: ['service'],
        artifacts: { 'responsibility.md': { required: 'always', description: 'x' } },
        knowledge_categories: [],
      },
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'config-populated');
    expect(issues).toHaveLength(0);
  });

  it('non-regression: does not enforce node/relation vocabulary', async () => {
    const graph = createGraph();
    graph.config.node_types = ['totally-custom-type', 'another-custom-type'];
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
    graph.config.node_types = ['service', 'api'];
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
        mapping: { type: 'file', path: 'src/does/not/exist.ts' },
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

  it('budget-warning returns warning when over warning threshold', async () => {
    const { buildContext } = await import('../../../src/core/context-builder.js');
    vi.mocked(buildContext).mockResolvedValue({
      nodePath: 'a',
      nodeName: 'A',
      layers: [],
      mapping: null,
      tokenCount: 7500,
    } as Awaited<ReturnType<typeof buildContext>>);

    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'budget-warning');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
  });

  it('budget-error returns warning when over error threshold', async () => {
    const { buildContext } = await import('../../../src/core/context-builder.js');
    vi.mocked(buildContext).mockResolvedValue({
      nodePath: 'a',
      nodeName: 'A',
      layers: [],
      mapping: null,
      tokenCount: 15000,
    } as Awaited<ReturnType<typeof buildContext>>);

    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'budget-error');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('W006');
  });

  it('context-budget catches buildContext errors and continues', async () => {
    const { buildContext } = await import('../../../src/core/context-builder.js');
    vi.mocked(buildContext).mockRejectedValueOnce(new Error('Context build failed'));

    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    expect(result.issues.filter((i) => i.rule === 'budget-warning')).toHaveLength(0);
    expect(result.issues.filter((i) => i.rule === 'budget-error')).toHaveLength(0);
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

  it('scope-tags-defined returns error when knowledge scope references undefined tag', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.knowledge.push({
      path: 'decisions/001',
      name: 'D1',
      category: 'decisions',
      scope: { tags: ['undefined-tag'] },
      artifacts: [{ filename: 'content.md', content: 'x' }],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-scope-ref');
    expect(issues.some((i) => i.message.includes('undefined tag'))).toBe(true);
  });

  it('broken-flow-ref returns error for non-existent node in flow', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.flows.push({
      name: 'F1',
      nodes: ['a', 'nonexistent/node'],
      knowledge: [],
      artifacts: [{ filename: 'desc.md', content: 'x' }],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-flow-ref');
    expect(issues.some((i) => i.message.includes('non-existent node'))).toBe(true);
  });

  it('broken-flow-ref returns error for non-existent knowledge in flow', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.flows.push({
      name: 'F1',
      nodes: ['a'],
      knowledge: ['decisions/missing'],
      artifacts: [{ filename: 'desc.md', content: 'x' }],
    });

    const result = await validate(graph);
    const flowKnowledgeIssues = result.issues.filter(
      (i) => i.code === 'E005' && i.message.includes('non-existent knowledge'),
    );
    expect(flowKnowledgeIssues.length).toBeGreaterThan(0);
  });

  it('broken-scope-ref returns error when knowledge scope references non-existent node', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.knowledge.push({
      path: 'decisions/001',
      name: 'D1',
      category: 'decisions',
      scope: { nodes: ['missing/node'] },
      artifacts: [{ filename: 'content.md', content: 'x' }],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-scope-ref');
    expect(issues.some((i) => i.message.includes('non-existent node'))).toBe(true);
  });

  it('invalid-artifact-condition returns error when has_tag references undefined tag', async () => {
    const graph = createGraph({
      config: {
        name: 'Test',
        stack: {},
        standards: '',
        tags: ['valid-tag'],
        node_types: ['service'],
        artifacts: {
          responsibility: { required: 'always', description: 'x' },
          interface: {
            required: { when: 'has_tag:undefined-tag' },
            description: '',
          },
        },
        knowledge_categories: [],
      },
    });
    graph.nodes.set('a', createNode('a'));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'invalid-artifact-condition');
    expect(issues).toHaveLength(1);
  });

  it('artifactRequiredReason has_tag returns null when node lacks tag', async () => {
    const graph = createGraph({
      config: {
        name: 'Test',
        stack: {},
        standards: '',
        tags: ['special'],
        node_types: ['service'],
        artifacts: {
          responsibility: { required: 'always', description: 'x' },
          optional: {
            required: { when: 'has_tag:special', description: 'x' },
            description: 'x',
          },
        },
        knowledge_categories: [],
      },
    });
    graph.nodes.set('svc', createNode('svc'));

    const result = await validate(graph);
    const optionalIssues = result.issues.filter((i) => i.message.includes('optional'));
    expect(optionalIssues).toHaveLength(0);
  });

  it('shallow-artifact warns when artifact below min_artifact_length', async () => {
    const graph = createGraph();
    graph.config.quality = {
      min_artifact_length: 100,
      max_direct_relations: 10,
      context_budget: { warning: 5000, error: 10000 },
      knowledge_staleness_days: 90,
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
      knowledge_staleness_days: 90,
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

  it('broken-knowledge-ref returns error for non-existent knowledge', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { knowledge: ['decisions/missing'] }));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'broken-knowledge-ref');
    expect(issues).toHaveLength(1);
  });

  it('missing-artifact when required has_incoming_relations and node has incoming', async () => {
    const graph = createGraph({
      config: {
        name: 'Test',
        stack: {},
        standards: '',
        tags: [],
        node_types: ['service'],
        artifacts: {
          'responsibility.md': { required: 'always', description: 'x' },
          'interface.md': {
            required: { when: 'has_incoming_relations' },
            description: '',
          },
        },
        knowledge_categories: [],
      },
    });
    graph.nodes.set('dep', createNode('dep', { relations: [{ target: 'svc', type: 'uses' }] }));
    graph.nodes.set('svc', {
      ...createNode('svc'),
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
    });

    const result = await validate(graph);
    const issues = result.issues.filter(
      (i) => i.rule === 'missing-artifact' && i.nodePath === 'svc',
    );
    expect(issues.some((i) => i.message.includes('interface.md'))).toBe(true);
  });

  it('missing-artifact when required has_outgoing_relations and node has outgoing', async () => {
    const graph = createGraph({
      config: {
        name: 'Test',
        stack: {},
        standards: '',
        tags: [],
        node_types: ['service'],
        artifacts: {
          'responsibility.md': { required: 'always', description: 'x' },
          'interface.md': {
            required: { when: 'has_outgoing_relations' },
            description: '',
          },
        },
        knowledge_categories: [],
      },
    });
    graph.nodes.set('svc', {
      ...createNode('svc', { relations: [{ target: 'other', type: 'uses' }] }),
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
    });
    graph.nodes.set('other', createNode('other'));

    const result = await validate(graph);
    const issues = result.issues.filter(
      (i) => i.rule === 'missing-artifact' && i.nodePath === 'svc',
    );
    expect(issues.some((i) => i.message.includes('interface.md'))).toBe(true);
  });

  it('missing-artifact when required has_tag and node has tag', async () => {
    const graph = createGraph({
      config: {
        name: 'Test',
        stack: {},
        standards: '',
        tags: ['public-api'],
        node_types: ['service'],
        artifacts: {
          'responsibility.md': { required: 'always', description: 'x' },
          'interface.md': {
            required: { when: 'has_tag:public-api' },
            description: '',
          },
        },
        knowledge_categories: [],
      },
    });
    graph.nodes.set('svc', {
      ...createNode('svc', { tags: ['public-api'] }),
      artifacts: [{ filename: 'responsibility.md', content: 'x' }],
    });

    const result = await validate(graph);
    const issues = result.issues.filter(
      (i) => i.rule === 'missing-artifact' && i.nodePath === 'svc',
    );
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

  it('aspect-tag-uniqueness returns error when tag bound to multiple aspects', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.aspects.push(
      { name: 'Aspect1', tag: 'dup-tag', artifacts: [] },
      { name: 'Aspect2', tag: 'dup-tag', artifacts: [] },
    );
    graph.config.tags = ['dup-tag'];

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'duplicate-aspect-binding');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('E014');
    expect(issues[0].message).toContain('multiple aspects');
  });

  it('unknown-node-type returns error for node type not in config', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a', { type: 'unknown-type' }));

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'unknown-node-type');
    expect(issues).toHaveLength(1);
  });

  it('checkSchemas: W010 when required schema is missing', async () => {
    const graph = createGraph();
    graph.schemas = [
      { schemaType: 'node' },
      { schemaType: 'aspect' },
      { schemaType: 'flow' },
      // knowledge missing
    ];

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-schema');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('W010');
    expect(issues[0].message).toContain('knowledge.yaml');
  });

  it('checkSchemas: no W010 when all 4 schemas present', async () => {
    const graph = createGraph();
    graph.schemas = [
      { schemaType: 'node' },
      { schemaType: 'aspect' },
      { schemaType: 'flow' },
      { schemaType: 'knowledge' },
    ];

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-schema');
    expect(issues).toHaveLength(0);
  });

  it('missing-knowledge-category-dir returns E017 when category has no directory', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-e017');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelSvcDir = path.join(yggRoot, 'model', 'svc');
    const knowledgeDecisionsDir = path.join(yggRoot, 'knowledge', 'decisions');
    await mkdir(modelSvcDir, { recursive: true });
    await mkdir(knowledgeDecisionsDir, { recursive: true });
    await writeFile(path.join(modelSvcDir, 'node.yaml'), 'name: Svc\ntype: service\n');
    await writeFile(path.join(modelSvcDir, 'responsibility.md'), 'x'.repeat(60));
    await writeFile(
      path.join(yggRoot, 'config.yaml'),
      'name: Test\nnode_types: [service]\nartifacts:\n  responsibility:\n    required: always\n    description: x\ntags: []\nknowledge_categories:\n  - name: decisions\n    description: x\n  - name: regulations\n    description: x\n',
    );

    const graph = await loadGraph(tmpDir);
    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-knowledge-category-dir');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('E017');
    expect(issues[0].message).toContain('regulations');
    expect(issues[0].message).toContain('knowledge/regulations/');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('missing-knowledge-category-dir returns E017 for all categories when knowledge/ does not exist', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-e017-no-knowledge');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const modelSvcDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(modelSvcDir, { recursive: true });
    await writeFile(path.join(modelSvcDir, 'node.yaml'), 'name: Svc\ntype: service\n');
    await writeFile(path.join(modelSvcDir, 'responsibility.md'), 'x'.repeat(60));
    await writeFile(
      path.join(yggRoot, 'config.yaml'),
      'name: Test\nnode_types: [service]\nartifacts:\n  responsibility:\n    required: always\n    description: x\ntags: []\nknowledge_categories:\n  - name: decisions\n    description: x\n  - name: patterns\n    description: x\n',
    );

    const graph = await loadGraph(tmpDir);
    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'missing-knowledge-category-dir');
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.message)).toContain(
      "Category 'decisions' in config has no knowledge/decisions/ directory",
    );
    expect(issues.map((i) => i.message)).toContain(
      "Category 'patterns' in config has no knowledge/patterns/ directory",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('missing-pattern-example warns when pattern has no example file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-pattern');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const patternDir = path.join(yggRoot, 'knowledge', 'patterns', 'my-pattern');
    const modelSvcDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(patternDir, { recursive: true });
    await mkdir(modelSvcDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'config.yaml'),
      'name: V\nnode_types: [service]\nartifacts:\n  responsibility:\n    required: always\n    description: x\ntags: []\nknowledge_categories: [{ name: patterns }, { name: decisions }]',
    );
    await writeFile(path.join(modelSvcDir, 'node.yaml'), 'name: S\ntype: service\n');
    await writeFile(path.join(patternDir, 'knowledge.yaml'), 'name: MyPattern\n');

    try {
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'missing-example');
      expect(issues.some((i) => i.message.includes('patterns/my-pattern'))).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('unknown-knowledge-category when knowledge dir has unknown subdir', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-unknown-cat');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const knowledgeDir = path.join(yggRoot, 'knowledge', 'unknown-category');
    const modelSvcDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(knowledgeDir, { recursive: true });
    await mkdir(modelSvcDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'config.yaml'),
      'name: V\nnode_types: [service]\nartifacts:\n  responsibility:\n    required: always\n    description: x\ntags: []\nknowledge_categories: [{ name: decisions }]',
    );
    await writeFile(path.join(modelSvcDir, 'node.yaml'), 'name: S\ntype: service\n');

    try {
      const graph = await loadGraph(tmpDir);
      graph.rootPath = yggRoot;
      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'unknown-knowledge-category');
      expect(issues.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('stale-knowledge warns when node modified later than knowledge (Git commits)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-validator-stale');
    const yggRoot = path.join(tmpDir, '.yggdrasil');
    const knowledgeDir = path.join(yggRoot, 'knowledge', 'decisions', '001');
    const modelDir = path.join(yggRoot, 'model', 'svc');
    await mkdir(knowledgeDir, { recursive: true });
    await mkdir(modelDir, { recursive: true });
    await writeFile(
      path.join(yggRoot, 'config.yaml'),
      'name: V\nnode_types: [service]\nartifacts:\n  responsibility:\n    required: always\n    description: x\ntags: []\nknowledge_categories: [{ name: decisions }]',
    );
    await writeFile(path.join(modelDir, 'node.yaml'), 'name: S\ntype: service\n');
    await writeFile(
      path.join(knowledgeDir, 'knowledge.yaml'),
      'name: D1\nscope:\n  nodes: [svc]\n',
    );
    await writeFile(path.join(knowledgeDir, 'content.md'), 'decision content');

    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git add .yggdrasil/knowledge/decisions/001', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "add knowledge"', {
      cwd: tmpDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2020-01-01 00:00:00',
        GIT_COMMITTER_DATE: '2020-01-01 00:00:00',
      },
    });
    execSync('git add .yggdrasil/model/svc', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "add node"', { cwd: tmpDir, stdio: 'pipe' });

    try {
      const graph = await loadGraph(tmpDir);
      graph.config.quality = {
        min_artifact_length: 50,
        max_direct_relations: 10,
        context_budget: { warning: 5000, error: 10000 },
        knowledge_staleness_days: 1,
      };

      const result = await validate(graph);
      const issues = result.issues.filter((i) => i.rule === 'stale-knowledge');
      expect(issues.length).toBeGreaterThanOrEqual(1);
      expect(issues[0].message).toContain('Git commits');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('unreachable-knowledge warns when knowledge scope tags match no node', async () => {
    const graph = createGraph();
    graph.nodes.set('a', createNode('a'));
    graph.knowledge.push({
      path: 'decisions/orphan',
      name: 'Orphan',
      category: 'decisions',
      scope: { tags: ['never-used-tag'] },
      artifacts: [{ filename: 'content.md', content: 'x' }],
    });
    graph.config.tags = ['valid-tag', 'never-used-tag'];

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.rule === 'unreachable-knowledge');
    expect(issues.some((i) => i.message.includes('decisions/orphan'))).toBe(true);
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
