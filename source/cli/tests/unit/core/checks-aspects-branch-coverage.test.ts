import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkDanglingAspectRefs,
  checkWhenReferences,
  checkOrphanedAspects,
} from '../../../src/core/checks/aspects.js';
import {
  checkReviewerPresence,
  checkAspectTierReferences,
  checkAspectReferences,
} from '../../../src/core/checks/aspect-contracts.js';
import { evaluateWhen } from '../../../src/core/when-evaluator.js';
import { STRUCTURAL_CODES } from '../../../src/core/check-codes.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

/**
 * Branch-coverage tests for the aspect-graph validators. Each exercises a rejection/
 * cascade branch the primary suite leaves uncovered: architecture-level dangling refs,
 * every `when` container/attach-site (all_of / any_of / not, bare consumes_port, aspect
 * impliesWhens, architecture/node/port/flow aspectWhens), and the aspect-contract paths
 * for a missing reviewer, an unknown tier with no tiers configured, an empty references
 * list, and a reference that resolves to a directory. Also the two port-name rules the
 * `when` validator applies asymmetrically: `consumes_port: default` is exempt (the
 * reserved port exists on every node, so it is never an unknown reference), while an
 * unmatchable `has_port` only warns (naming a port nothing declares is a legal idiom).
 */

/** Minimal Graph literal; callers override only the fields the validator under test reads. */
function mkGraph(overrides: Partial<Graph>): Graph {
  return {
    config: {},
    architecture: { node_types: { service: { description: 'svc' } } },
    nodes: new Map(),
    aspects: [],
    flows: [],
    rootPath: '/tmp/does-not-matter/.yggdrasil',
    ...overrides,
  } as unknown as Graph;
}

/** A GraphNode literal for the nodes Map. */
function node(nodePath: string, meta: Record<string, unknown>): [string, unknown] {
  return [nodePath, { path: nodePath, meta: { name: nodePath, type: 'service', ...meta }, children: [], parent: null }];
}

describe('checkDanglingAspectRefs — architecture-level reference', () => {
  it('flags an architecture node_type that references an undefined aspect', () => {
    const g = mkGraph({
      architecture: { node_types: { service: { description: 'svc', aspects: ['ghost'] } } },
      aspects: [],
    });
    const issues = checkDanglingAspectRefs(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('aspect-undefined');
    // Architecture-origin dangling refs carry no nodePath (they are not node-scoped).
    expect(issues[0].nodePath).toBeUndefined();
  });
});

describe('checkWhenReferences — predicate containers and unknown references', () => {
  const aspectWithWhen = (when: unknown): Partial<Graph> => ({
    aspects: [{ id: 'a', name: 'a', reviewer: { type: 'llm' }, artifacts: [], when }] as unknown as Graph['aspects'],
  });

  it('descends an `all_of` container to an unknown node type', () => {
    const issues = checkWhenReferences(mkGraph(aspectWithWhen({ all_of: [{ node: { type: 'ghost' } }] })));
    expect(issues.some((i) => i.code === 'when-unknown-type')).toBe(true);
  });

  it('descends an `any_of` container to an unknown node type', () => {
    const issues = checkWhenReferences(mkGraph(aspectWithWhen({ any_of: [{ node: { type: 'ghost' } }] })));
    expect(issues.some((i) => i.code === 'when-unknown-type')).toBe(true);
  });

  it('descends a `not` container to an unknown node type', () => {
    const issues = checkWhenReferences(mkGraph(aspectWithWhen({ not: { node: { type: 'ghost' } } })));
    expect(issues.some((i) => i.code === 'when-unknown-type')).toBe(true);
  });

  it('flags a bare `consumes_port` (no target) that no node declares', () => {
    const issues = checkWhenReferences(mkGraph(aspectWithWhen({ relations: { uses: { consumes_port: 'ghost-port' } } })));
    expect(issues.some((i) => i.code === 'when-unknown-port')).toBe(true);
  });

  it('flags a `consumes_port` on a named target whose port is absent', () => {
    const g = mkGraph({
      ...aspectWithWhen({ relations: { uses: { target: 'x/y', consumes_port: 'ghost-port' } } }),
      nodes: new Map([node('x/y', { ports: {} })] as [string, unknown][]) as unknown as Graph['nodes'],
    });
    const issues = checkWhenReferences(g);
    expect(issues.some((i) => i.code === 'when-unknown-port')).toBe(true);
  });

  it('flags an unknown relation `target_type`', () => {
    const issues = checkWhenReferences(mkGraph(aspectWithWhen({ relations: { uses: { target_type: 'ghost' } } })));
    expect(issues.some((i) => i.code === 'when-unknown-type')).toBe(true);
  });

  it('flags an unknown relation `target` node', () => {
    const issues = checkWhenReferences(mkGraph(aspectWithWhen({ relations: { uses: { target: 'no/such/node' } } })));
    expect(issues.some((i) => i.code === 'when-unknown-node')).toBe(true);
  });

  it('descends a `descendants` clause to an unknown type', () => {
    const issues = checkWhenReferences(mkGraph(aspectWithWhen({ descendants: { type: 'ghost' } })));
    expect(issues.some((i) => i.code === 'when-unknown-type')).toBe(true);
  });

  it('validates an aspect `impliesWhens` predicate', () => {
    const g = mkGraph({
      aspects: [
        { id: 'a', name: 'a', reviewer: { type: 'llm' }, artifacts: [], implies: ['b'], impliesWhens: { b: { node: { type: 'ghost' } } } },
        { id: 'b', name: 'b', reviewer: { type: 'llm' }, artifacts: [] },
      ] as unknown as Graph['aspects'],
    });
    const issues = checkWhenReferences(g);
    expect(issues.some((i) => i.code === 'when-unknown-type')).toBe(true);
  });

  it('validates architecture type `aspectWhens`', () => {
    const g = mkGraph({
      architecture: { node_types: { service: { description: 'svc', aspectWhens: { a: { node: { type: 'ghost' } } } } } } as unknown as Graph['architecture'],
    });
    const issues = checkWhenReferences(g);
    expect(issues.some((i) => i.code === 'when-unknown-type')).toBe(true);
  });

  it('validates node `aspectWhens`', () => {
    const g = mkGraph({
      nodes: new Map([node('x/y', { aspectWhens: { a: { node: { type: 'ghost' } } } })] as [string, unknown][]) as unknown as Graph['nodes'],
    });
    const issues = checkWhenReferences(g);
    expect(issues.some((i) => i.code === 'when-unknown-type')).toBe(true);
  });

  it('validates port `aspectWhens`', () => {
    const g = mkGraph({
      nodes: new Map([
        node('x/y', { ports: { charge: { description: 'd', aspects: [], aspectWhens: { a: { node: { type: 'ghost' } } } } } }),
      ] as [string, unknown][]) as unknown as Graph['nodes'],
    });
    const issues = checkWhenReferences(g);
    expect(issues.some((i) => i.code === 'when-unknown-type')).toBe(true);
  });

  it('validates flow `aspectWhens`', () => {
    const g = mkGraph({
      flows: [{ path: 'f', name: 'f', nodes: [], aspectWhens: { a: { node: { type: 'ghost' } } } }] as unknown as Graph['flows'],
    });
    const issues = checkWhenReferences(g);
    expect(issues.some((i) => i.code === 'when-unknown-type')).toBe(true);
  });

  it('treats every node type as unknown when the architecture is absent', () => {
    const g = mkGraph({ architecture: undefined, ...aspectWithWhen({ node: { type: 'service' } }) } as Partial<Graph>);
    const issues = checkWhenReferences(g);
    expect(issues.some((i) => i.code === 'when-unknown-type')).toBe(true);
  });

  it('flags a `node.id` unknown to the graph, with the aspect when in the message', () => {
    const issues = checkWhenReferences(mkGraph(aspectWithWhen({ node: { id: 'nie/ma' } })));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('when-unknown-node');
    expect(issues[0].messageData.what).toMatch(/aspect 'a' when/);
    expect(issues[0].messageData.what).toContain('nie/ma');
  });

  it('flags an unknown `node.id` inside `implies[...] when`, with implies in the message', () => {
    const g = mkGraph({
      aspects: [
        { id: 'a', name: 'a', reviewer: { type: 'llm' }, artifacts: [], implies: ['b'], impliesWhens: { b: { node: { id: 'nie/ma' } } } },
        { id: 'b', name: 'b', reviewer: { type: 'llm' }, artifacts: [] },
      ] as unknown as Graph['aspects'],
    });
    const issues = checkWhenReferences(g);
    expect(issues.some((i) => i.code === 'when-unknown-node')).toBe(true);
    expect(issues.find((i) => i.code === 'when-unknown-node')!.messageData.what).toMatch(/implies/);
  });

  it('flags an unknown `node.id` inside a node `aspectWhens`, naming the node path', () => {
    const g = mkGraph({
      nodes: new Map([node('x/y', { aspectWhens: { a: { node: { id: 'nie/ma' } } } })] as [string, unknown][]) as unknown as Graph['nodes'],
    });
    const issues = checkWhenReferences(g);
    expect(issues.some((i) => i.code === 'when-unknown-node')).toBe(true);
    expect(issues.find((i) => i.code === 'when-unknown-node')!.messageData.what).toContain('x/y');
  });

  it('flags an unknown `node.id` inside a port `aspectWhens`, naming the port', () => {
    const g = mkGraph({
      nodes: new Map([
        node('x/y', { ports: { charge: { description: 'd', aspects: [], aspectWhens: { a: { node: { id: 'nie/ma' } } } } } }),
      ] as [string, unknown][]) as unknown as Graph['nodes'],
    });
    const issues = checkWhenReferences(g);
    expect(issues.some((i) => i.code === 'when-unknown-node')).toBe(true);
    expect(issues.find((i) => i.code === 'when-unknown-node')!.messageData.what).toContain('charge');
  });

  it('flags an unknown `node.id` inside a flow `aspectWhens`, naming the flow', () => {
    const g = mkGraph({
      flows: [{ path: 'f', name: 'f', nodes: [], aspectWhens: { a: { node: { id: 'nie/ma' } } } }] as unknown as Graph['flows'],
    });
    const issues = checkWhenReferences(g);
    expect(issues.some((i) => i.code === 'when-unknown-node')).toBe(true);
    expect(issues.find((i) => i.code === 'when-unknown-node')!.messageData.what).toContain('f');
  });

  it('flags an unknown `node.id` inside `node_types.<t>.aspectWhens`, naming the type', () => {
    const g = mkGraph({
      architecture: { node_types: { service: { description: 'svc', aspectWhens: { a: { node: { id: 'nie/ma' } } } } } } as unknown as Graph['architecture'],
    });
    const issues = checkWhenReferences(g);
    expect(issues.some((i) => i.code === 'when-unknown-node')).toBe(true);
    expect(issues.find((i) => i.code === 'when-unknown-node')!.messageData.what).toContain('service');
  });

  it('flags one issue per unknown entry in a `node.id` list, and none for the known one', () => {
    const g = mkGraph({
      nodes: new Map([node('x/y', {})] as [string, unknown][]) as unknown as Graph['nodes'],
      ...aspectWithWhen({ node: { id: ['x/y', 'nie/ma1', 'nie/ma2'] } }),
    });
    const issues = checkWhenReferences(g);
    const nodeIssues = issues.filter((i) => i.code === 'when-unknown-node');
    expect(nodeIssues).toHaveLength(2);
    expect(nodeIssues.some((i) => i.messageData.what.includes('nie/ma1'))).toBe(true);
    expect(nodeIssues.some((i) => i.messageData.what.includes('nie/ma2'))).toBe(true);
  });

  it('raises no issue when `node.id` names a node that exists in the graph', () => {
    const g = mkGraph({
      nodes: new Map([node('x/y', {})] as [string, unknown][]) as unknown as Graph['nodes'],
      ...aspectWithWhen({ node: { id: 'x/y' } }),
    });
    const issues = checkWhenReferences(g);
    expect(issues).toHaveLength(0);
  });

  it('validates an unknown `node.id` even under `not:`', () => {
    const issues = checkWhenReferences(mkGraph(aspectWithWhen({ not: { node: { id: 'nie/ma' } } })));
    expect(issues.some((i) => i.code === 'when-unknown-node')).toBe(true);
  });

  // --- consumes_port: default — the reserved port is never an unknown reference ---

  it('raises nothing for a bare `consumes_port: default`, even though no node declares the port', () => {
    const g = mkGraph({
      nodes: new Map([node('x/y', { ports: { charge: { description: 'd', aspects: [] } } })] as [string, unknown][]) as unknown as Graph['nodes'],
      ...aspectWithWhen({ relations: { uses: { consumes_port: 'default' } } }),
    });
    expect(checkWhenReferences(g)).toHaveLength(0);
  });

  it('raises nothing for a `target`-qualified `consumes_port: default` on a target that declares no ports at all', () => {
    const g = mkGraph({
      nodes: new Map([node('x/y', { ports: {} })] as [string, unknown][]) as unknown as Graph['nodes'],
      ...aspectWithWhen({ relations: { uses: { target: 'x/y', consumes_port: 'default' } } }),
    });
    expect(checkWhenReferences(g)).toHaveLength(0);
  });

  it('exempts only `default` — every other undeclared port name still raises when-unknown-port, bare or targeted', () => {
    const nodes = new Map([node('x/y', { ports: {} })] as [string, unknown][]) as unknown as Graph['nodes'];
    const bare = checkWhenReferences(mkGraph({ nodes, ...aspectWithWhen({ relations: { uses: { consumes_port: 'ghost-port' } } }) }));
    const targeted = checkWhenReferences(mkGraph({ nodes, ...aspectWithWhen({ relations: { uses: { target: 'x/y', consumes_port: 'ghost-port' } } }) }));
    expect(bare.map((i) => i.code)).toEqual(['when-unknown-port']);
    expect(targeted.map((i) => i.code)).toEqual(['when-unknown-port']);
  });

  it('the same graph that validates clean also MATCHES: `consumes_port: default` is true for a relation that named no port', () => {
    const caller = {
      path: 'x/caller',
      meta: { name: 'x/caller', type: 'service', relations: [{ target: 'x/y', type: 'uses', portNames: ['default'] }] },
      children: [],
      parent: null,
    };
    const g = mkGraph({
      nodes: new Map([node('x/y', { ports: {} }), ['x/caller', caller]] as [string, unknown][]) as unknown as Graph['nodes'],
      ...aspectWithWhen({ relations: { uses: { consumes_port: 'default' } } }),
    });
    expect(checkWhenReferences(g)).toHaveLength(0);
    expect(evaluateWhen({ relations: { uses: { consumes_port: 'default' } } }, caller as unknown as GraphNode, g)).toBe(true);
  });

  // --- has_port — advisory only, because an unmatchable port is a legal idiom ---

  it('warns (never errors) on a `node.has_port` no node in the graph declares', () => {
    const g = mkGraph({
      nodes: new Map([node('x/y', { ports: { charge: { description: 'd', aspects: [] } } })] as [string, unknown][]) as unknown as Graph['nodes'],
      ...aspectWithWhen({ node: { has_port: 'charrge' } }),
    });
    const issues = checkWhenReferences(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('when-unmatched-port');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].messageData.what).toContain('charrge');
    expect(issues[0].messageData.what).toMatch(/aspect 'a' when/);
  });

  it('warns the same way on a `descendants.has_port`', () => {
    const g = mkGraph({
      nodes: new Map([node('x/y', { ports: { charge: { description: 'd', aspects: [] } } })] as [string, unknown][]) as unknown as Graph['nodes'],
      ...aspectWithWhen({ descendants: { has_port: 'charrge' } }),
    });
    const issues = checkWhenReferences(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('when-unmatched-port');
    expect(issues[0].severity).toBe('warning');
  });

  it('raises nothing when `has_port` names a port SOME node declares — it need not be the node the clause will match', () => {
    const g = mkGraph({
      nodes: new Map([
        node('x/y', { ports: { charge: { description: 'd', aspects: [] } } }),
        node('x/z', {}),
      ] as [string, unknown][]) as unknown as Graph['nodes'],
      ...aspectWithWhen({ node: { has_port: 'charge' } }),
    });
    expect(checkWhenReferences(g)).toHaveLength(0);
  });

  it('descends `not:` and the boolean containers to reach a `has_port`', () => {
    const g = mkGraph(aspectWithWhen({ not: { node: { has_port: 'charrge' } } }));
    expect(checkWhenReferences(g).map((i) => i.code)).toEqual(['when-unmatched-port']);
    const anyOf = mkGraph(aspectWithWhen({ any_of: [{ descendants: { has_port: 'charrge' } }] }));
    expect(checkWhenReferences(anyOf).map((i) => i.code)).toEqual(['when-unmatched-port']);
  });

  it('when-unmatched-port is deliberately OUTSIDE the structural set, so it can never block yg check', () => {
    expect(STRUCTURAL_CODES.has('when-unmatched-port')).toBe(false);
    // Its blocking sibling stays in, so the two are not confused for each other.
    expect(STRUCTURAL_CODES.has('when-unknown-port')).toBe(true);
  });
});

describe('checkOrphanedAspects', () => {
  it('treats an architecture-referenced aspect as used and flags only the unreferenced one', () => {
    const g = mkGraph({
      architecture: { node_types: { service: { description: 'svc', aspects: ['used'] } } } as unknown as Graph['architecture'],
      aspects: [
        { id: 'used', name: 'used', reviewer: { type: 'llm' }, artifacts: [] },
        { id: 'lonely', name: 'lonely', reviewer: { type: 'llm' }, artifacts: [] },
      ] as unknown as Graph['aspects'],
    });
    const issues = checkOrphanedAspects(g);
    expect(issues.some((i) => i.nodePath === 'aspects/lonely')).toBe(true);
    expect(issues.some((i) => i.nodePath === 'aspects/used')).toBe(false);
  });

  it('propagates referenced-ness through an implies chain', () => {
    const g = mkGraph({
      architecture: { node_types: { service: { description: 'svc', aspects: ['parent'] } } } as unknown as Graph['architecture'],
      aspects: [
        { id: 'parent', name: 'parent', reviewer: { type: 'aggregate' }, artifacts: [], implies: ['child'] },
        { id: 'child', name: 'child', reviewer: { type: 'llm' }, artifacts: [] },
      ] as unknown as Graph['aspects'],
    });
    // `child` is implied by the referenced `parent`, so it must NOT be reported as orphaned.
    expect(checkOrphanedAspects(g).some((i) => i.nodePath === 'aspects/child')).toBe(false);
  });
});

describe('port aspects — optional field branch coverage', () => {
  it('a port missing aspects, one with [], and one with a real list — no exceptions, only the real one can dangle', () => {
    const g = mkGraph({
      nodes: new Map([
        node('x/y', {
          ports: {
            noKey: { description: 'd' },
            empty: { description: 'd', aspects: [] },
            real: { description: 'd', aspects: ['ghost'] },
          },
        }),
      ] as [string, unknown][]) as unknown as Graph['nodes'],
    });

    expect(() => checkDanglingAspectRefs(g)).not.toThrow();
    const dangling = checkDanglingAspectRefs(g);
    expect(dangling).toHaveLength(1);
    expect(dangling[0].code).toBe('aspect-undefined');
    expect(dangling[0].messageData.what).toContain("'ghost'");
    expect(dangling[0].messageData.what).toContain("'real'");

    // graph.aspects is empty here, so there is nothing for checkOrphanedAspects
    // to report either way — the point is that it does not throw on the same
    // missing/empty ports that dangling-ref just walked.
    expect(() => checkOrphanedAspects(g)).not.toThrow();
    expect(checkOrphanedAspects(g)).toEqual([]);
  });
});

describe('aspect-contract validators', () => {
  it('checkReviewerPresence short-circuits when the config failed to parse', async () => {
    expect(await checkReviewerPresence(mkGraph({ configError: 'boom' } as Partial<Graph>))).toEqual([]);
  });

  it('checkReviewerPresence is silent when no LLM pair is effective (deterministic-only / empty graph)', async () => {
    // mkGraph builds an empty node/aspect set → computeExpectedPairs yields no LLM pair.
    const issues = await checkReviewerPresence(mkGraph({ config: {} as Graph['config'] }));
    expect(issues).toEqual([]);
  });

  it('checkAspectTierReferences short-circuits on a config error', () => {
    const g = mkGraph({
      configError: 'boom',
      aspects: [{ id: 'a', name: 'a', reviewer: { type: 'llm', tier: 'gold' }, artifacts: [] }] as unknown as Graph['aspects'],
    } as Partial<Graph>);
    expect(checkAspectTierReferences(g)).toEqual([]);
  });

  it('checkAspectTierReferences flags an unknown tier when NO tiers are configured', () => {
    const g = mkGraph({
      config: {} as Graph['config'],
      aspects: [{ id: 'a', name: 'a', reviewer: { type: 'llm', tier: 'gold' }, artifacts: [] }] as unknown as Graph['aspects'],
    });
    const issues = checkAspectTierReferences(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('aspect-tier-unknown');
  });

  it('checkAspectReferences warns on an empty references list', async () => {
    const g = mkGraph({
      aspects: [{ id: 'a', name: 'a', reviewer: { type: 'llm' }, artifacts: [], references: [] }] as unknown as Graph['aspects'],
    });
    const issues = await checkAspectReferences(g);
    expect(issues.some((i) => i.code === 'aspect-references-empty-array')).toBe(true);
  });
});

describe('checkAspectReferences — a reference resolving to a directory', () => {
  let projectRoot: string | undefined;

  afterEach(async () => {
    if (projectRoot) {
      await rm(projectRoot, { recursive: true, force: true });
      projectRoot = undefined;
    }
  });

  it('flags a reference path that resolves to a directory, not a file', async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'yg-ref-dir-'));
    await mkdir(path.join(projectRoot, 'refs-as-dir'), { recursive: true });
    const g = mkGraph({
      rootPath: path.join(projectRoot, '.yggdrasil'),
      aspects: [
        { id: 'a', name: 'a', reviewer: { type: 'llm' }, artifacts: [], references: [{ path: 'refs-as-dir' }] },
      ] as unknown as Graph['aspects'],
    });
    const issues = await checkAspectReferences(g);
    expect(issues.some((i) => i.code === 'aspect-reference-broken')).toBe(true);
  });
});
