import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validate } from '../../../src/core/validator.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
const msgOf = (i: { messageData: Parameters<typeof buildIssueMessage>[0] }) => buildIssueMessage(i.messageData);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');
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
    aspects: [{ name: 'Valid', id: 'valid-tag', reviewer: { type: 'llm' as const }, artifacts: [] }],
    flows: [],
    rootPath: path.join(FIXTURE_PROJECT, '.yggdrasil'),
    ...overrides,
  };
}

describe('validator', () => {

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
      expect(msgOf(relationTargetForbidden!)).toContain('calls');
      expect(msgOf(relationTargetForbidden!)).toContain('library');
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

    it('relation-target-type-unknown when an allow-list names an undefined target type', async () => {
      const graph = createGraph({
        architecture: {
          node_types: {
            service: {
              description: 'A service',
              relations: { calls: ['modul'] }, // typo of 'module'
            },
            module: { description: 'A module' },
          },
        },
      });

      const result = await validate(graph);
      const dangling = result.issues.find(i => i.code === 'relation-target-type-unknown');
      expect(dangling).toBeDefined();
      expect(dangling!.severity).toBe('error');
      expect(msgOf(dangling!)).toContain('modul');
      expect(msgOf(dangling!)).toContain('calls');
    });

    it('relation-target-type-unknown not fired for a defined type or the * wildcard', async () => {
      const graph = createGraph({
        architecture: {
          node_types: {
            service: {
              description: 'A service',
              relations: { calls: ['module'], uses: ['*'] },
            },
            module: { description: 'A module' },
          },
        },
      });

      const result = await validate(graph);
      const dangling = result.issues.find(i => i.code === 'relation-target-type-unknown');
      expect(dangling).toBeUndefined();
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
      expect(msgOf(parentTypeForbidden!)).toContain('library');
      expect(msgOf(parentTypeForbidden!)).toContain('service');
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
      expect(msgOf(portMissingAspect[0])).toContain('audit-logging');
      expect(msgOf(portMissingAspect[0])).toContain("Port 'api'");
    });

    it('integration-aspect-missing not fired when consumer uses a port whose required aspect exists', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'audit-logging', reviewer: { type: 'llm' as const }, artifacts: [] }],
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
      const archErrors = result.issues.filter(i => i.code !== undefined && ['aspect-undefined', 'relation-target-forbidden', 'parent-type-forbidden', 'port-missing-aspect'].includes(i.code));
      // Should skip architecture checks when architecture has no node_types (fallback case)
      expect(archErrors.length).toBe(0);
    });
  });

  describe('missing-consumes', () => {
    it('fires when relation target has ports but consumer has no consumes', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', reviewer: { type: 'llm' as const }, artifacts: [] }],
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
        aspects: [{ name: 'Audit', id: 'valid-tag', reviewer: { type: 'llm' as const }, artifacts: [] }],
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

    it('fires for emits/listens relations to a port-bearing target without consumes (ports apply to every relation type)', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', reviewer: { type: 'llm' as const }, artifacts: [] }],
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
      const missing = result.issues.filter(i => i.code === 'port-missing-consumes');
      expect(missing.map(i => i.nodePath).sort()).toEqual(['emitter', 'listener']);
    });
  });

  describe('unknown-port', () => {
    it('fires when consumes references non-existent port', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Audit', id: 'valid-tag', reviewer: { type: 'llm' as const }, artifacts: [] }],
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
        aspects: [{ name: 'Audit', id: 'valid-tag', reviewer: { type: 'llm' as const }, artifacts: [] }],
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
        aspects: [{ name: 'Audit', id: 'valid-tag', reviewer: { type: 'llm' as const }, artifacts: [] }],
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
          { name: 'Valid', id: 'valid-tag', description: 'Referenced', reviewer: { type: 'llm' as const }, artifacts: [] },
          { name: 'Orphan', id: 'orphan-aspect', description: 'Never used', reviewer: { type: 'llm' as const }, artifacts: [] },
        ],
      });
      graph.nodes.set('a', createNode('a', { aspects: ['valid-tag'] }));

      const result = await validate(graph);
      const w006 = result.issues.filter(i => i.code === 'orphaned-aspect');
      expect(w006).toContainEqual(expect.objectContaining({
        code: 'orphaned-aspect', rule: 'orphaned-aspect',
      }));
      // 'valid-tag' is referenced so should not appear
      expect(w006.every(i => !msgOf(i).includes('valid-tag'))).toBe(true);
    });

    it('does not fire when aspect is referenced by a node', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Used', id: 'valid-tag', description: 'Used', reviewer: { type: 'llm' as const }, artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a', { aspects: ['valid-tag'] }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'orphaned-aspect')).toHaveLength(0);
    });

    it('does not fire when aspect is referenced by a port', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Used', id: 'valid-tag', description: 'Used', reviewer: { type: 'llm' as const }, artifacts: [] }],
      });
      graph.nodes.set('a', createNode('a', {
        ports: { api: { description: 'API', aspects: ['valid-tag'] } },
      }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'orphaned-aspect')).toHaveLength(0);
    });

    it('does not fire when aspect is referenced by a flow', async () => {
      const graph = createGraph({
        aspects: [{ name: 'Used', id: 'valid-tag', description: 'Used', reviewer: { type: 'llm' as const }, artifacts: [] }],
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
          { name: 'HIPAA', id: 'hipaa', description: 'Used', implies: ['audit'], reviewer: { type: 'llm' as const }, artifacts: [] },
          { name: 'Audit', id: 'audit', description: 'Implied', reviewer: { type: 'llm' as const }, artifacts: [] },
        ],
      });
      graph.nodes.set('a', createNode('a', { aspects: ['hipaa'] }));

      const result = await validate(graph);
      expect(result.issues.filter(i => i.code === 'orphaned-aspect')).toHaveLength(0);
    });
  });

  describe('validator — when schema checks', () => {
    it('reports unknown target_type in global when', async () => {
      const graph = createGraph({
        architecture: { node_types: { command: { description: 'cmd' } } },
        aspects: [{
          name: 'X', id: 'x', reviewer: { type: 'llm' as const }, artifacts: [],
          when: { relations: { calls: { target_type: 'srvc-client' } } },
        }],
      });
      const result = await validate(graph);
      expect(result.issues.some(i =>
        i.code === 'when-unknown-type' && /srvc-client/.test(msgOf(i))
      )).toBe(true);
    });

    it('reports unknown target node path in when', async () => {
      const node = createNode('svc', { type: 'command' });
      const graph = createGraph({
        nodes: new Map([['svc', node]]),
        architecture: { node_types: { command: { description: 'cmd' } } },
        aspects: [{
          name: 'X', id: 'x', reviewer: { type: 'llm' as const }, artifacts: [],
          when: { relations: { calls: { target: 'ghost/node' } } },
        }],
      });
      const result = await validate(graph);
      expect(result.issues.some(i =>
        i.code === 'when-unknown-node' && /ghost\/node/.test(msgOf(i))
      )).toBe(true);
    });

    it('reports unknown consumes_port on referenced target', async () => {
      const target = createNode('pay', {
        type: 'service',
        ports: { charge: { description: 'c', aspects: [] } },
      });
      const graph = createGraph({
        nodes: new Map([['pay', target]]),
        architecture: {
          node_types: { command: { description: 'cmd' }, service: { description: 'svc' } },
        },
        aspects: [{
          name: 'X', id: 'x', reviewer: { type: 'llm' as const }, artifacts: [],
          when: { relations: { calls: { target: 'pay', consumes_port: 'refund' } } },
        }],
      });
      const result = await validate(graph);
      expect(result.issues.some(i =>
        i.code === 'when-unknown-port' && /refund/.test(msgOf(i))
      )).toBe(true);
    });

    it('allows when referencing a target_type when type exists', async () => {
      const graph = createGraph({
        architecture: {
          node_types: {
            command: { description: 'cmd' },
            'service-client': { description: 'svc-client' },
          },
        },
        aspects: [{
          name: 'X', id: 'x', reviewer: { type: 'llm' as const }, artifacts: [],
          when: { relations: { calls: { target_type: 'service-client' } } },
        }],
      });
      const result = await validate(graph);
      expect(result.issues.some(i => i.code?.startsWith('when-'))).toBe(false);
    });

    it('validates when predicate inside flow aspectWhens', async () => {
      const graph = createGraph({
        architecture: { node_types: { command: { description: 'cmd' } } },
        aspects: [{ name: 'X', id: 'x', reviewer: { type: 'llm' as const }, artifacts: [] }],
        flows: [{
          path: 'checkout',
          name: 'Checkout',
          description: 'flow',
          nodes: [],
          aspects: [],
          aspectWhens: { x: { relations: { calls: { target_type: 'ghost-type' } } } },
        }],
      });
      const result = await validate(graph);
      expect(result.issues.some(i =>
        i.code === 'when-unknown-type' && /ghost-type/.test(msgOf(i))
      )).toBe(true);
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
