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
import type { Graph } from '../../../src/model/graph.js';

/**
 * Branch-coverage tests for the aspect-graph validators. Each exercises a rejection/
 * cascade branch the primary suite leaves uncovered: architecture-level dangling refs,
 * every `when` container/attach-site (all_of / any_of / not, bare consumes_port, aspect
 * impliesWhens, architecture/node/port/flow aspectWhens), and the aspect-contract paths
 * for a missing reviewer, an unknown tier with no tiers configured, an empty references
 * list, and a reference that resolves to a directory.
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
