import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import {
  checkAspectEffectiveNowhere,
  checkArchitectureDefaultAspectUnreachable,
} from '../../../src/core/checks/aspect-contracts.js';
import type { Graph, AspectDef, GraphNode, ArchitectureDef } from '../../../src/model/graph.js';
import type { WhenPredicate } from '../../../src/model/when.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempYggdrasil(): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'yg-den-'));
  tempDirs.push(base);
  const yggDir = path.join(base, '.yggdrasil');
  await mkdir(yggDir, { recursive: true });
  return yggDir;
}

/** Write a real rule source on disk so the "rule source present" gate sees it. */
async function createRuleSource(
  rootPath: string,
  aspectId: string,
  file: 'content.md' | 'check.mjs',
): Promise<void> {
  const aspectDir = path.join(rootPath, 'aspects', aspectId);
  await mkdir(aspectDir, { recursive: true });
  await writeFile(path.join(aspectDir, file), `// ${file} placeholder`);
}

// A `when` that matches no node in these fixtures — the only node is type
// 'module'; 'ghost' is a declared-but-unused type.
const NEVER_MATCHES: WhenPredicate = { node: { type: 'ghost' } };

function detAspect(id: string, extra: Partial<AspectDef> = {}): AspectDef {
  return {
    name: id,
    id,
    description: `Deterministic aspect ${id}`,
    artifacts: [],
    reviewer: { type: 'deterministic' },
    ...extra,
  };
}

function aggregateAspect(id: string, implies: string[], extra: Partial<AspectDef> = {}): AspectDef {
  return {
    name: id,
    id,
    description: `Aggregate aspect ${id}`,
    artifacts: [],
    reviewer: { type: 'aggregate' },
    implies,
    ...extra,
  };
}

function moduleNode(nodePath: string, aspects: string[]): GraphNode {
  return {
    path: nodePath,
    meta: { name: nodePath, type: 'module', aspects, mapping: [`src/${nodePath}.ts`] },
    children: [],
    parent: null,
  };
}

const ARCH: ArchitectureDef = {
  node_types: {
    module: { description: 'A module', aspects: [] },
    // A declared-but-unused type: the never-matching `when` targets it, but no
    // fixture node is of this type, so the gated aspect is effective nowhere.
    ghost: { description: 'A type no node uses', aspects: [] },
  },
};

function makeGraph(rootPath: string, aspects: AspectDef[], nodes: Map<string, GraphNode>): Graph {
  return {
    config: {},
    architecture: ARCH,
    nodes,
    aspects,
    flows: [],
    rootPath,
  };
}

describe('checkAspectEffectiveNowhere (C4 dead-attach linter)', () => {
  it('(a) warns for an enforced deterministic aspect attached via a never-matching when', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'dead-rule', 'check.mjs');
    const aspect = detAspect('dead-rule', { when: NEVER_MATCHES });
    const graph = makeGraph(rootPath, [aspect], new Map([['svc', moduleNode('svc', ['dead-rule'])]]));

    const issues = checkAspectEffectiveNowhere(graph);

    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('aspect-effective-nowhere');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].messageData.what).toBe(
      "Aspect 'dead-rule' has a rule source but is effective on zero nodes.",
    );
    expect(issues[0].messageData.why).toBe(
      "Its attach sites plus 'when' predicates match nothing, so the rule is never verified anywhere — dead law that looks enforced.",
    );
    expect(issues[0].messageData.next).toBe(
      "Check the attach sites and 'when' predicate (yg impact --aspect dead-rule). While authoring graph-before-code this is expected: create the node/type it targets, or set status: draft until the code lands.",
    );
  });

  it('(b) stays silent when the same aspect is draft', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'dead-rule', 'check.mjs');
    const aspect = detAspect('dead-rule', { when: NEVER_MATCHES, status: 'draft' });
    const graph = makeGraph(rootPath, [aspect], new Map([['svc', moduleNode('svc', ['dead-rule'])]]));

    expect(checkAspectEffectiveNowhere(graph)).toHaveLength(0);
  });

  it('(c) stays silent while the model tree has zero nodes (bootstrap carve-out)', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'dead-rule', 'check.mjs');
    const aspect = detAspect('dead-rule', { when: NEVER_MATCHES });
    const graph = makeGraph(rootPath, [aspect], new Map());

    expect(checkAspectEffectiveNowhere(graph)).toHaveLength(0);
  });

  it('(d) stays silent for an aggregate aspect (no rule source) whose effective set is empty', async () => {
    const rootPath = await createTempYggdrasil();
    // The aggregate ships NO content.md / check.mjs. Its implied child does ship
    // one and is effective on the node, so the child never warns either.
    await createRuleSource(rootPath, 'child-rule', 'check.mjs');
    const bundle = aggregateAspect('bundle', ['child-rule'], { when: NEVER_MATCHES });
    const child = detAspect('child-rule');
    const node = moduleNode('svc', ['bundle', 'child-rule']);
    const graph = makeGraph(rootPath, [bundle, child], new Map([['svc', node]]));

    const issues = checkAspectEffectiveNowhere(graph);
    expect(issues).toHaveLength(0);
    expect(issues.some((i) => i.messageData.what.includes("'bundle'"))).toBe(false);
  });

  it('does not warn when an LLM aspect (content.md) is genuinely effective on a node', async () => {
    const rootPath = await createTempYggdrasil();
    // content.md rule source exercises the other half of the rule-source gate.
    await createRuleSource(rootPath, 'live-rule', 'content.md');
    const aspect: AspectDef = {
      name: 'live-rule',
      id: 'live-rule',
      description: 'LLM aspect live-rule',
      artifacts: [],
      reviewer: { type: 'llm' },
    }; // no when → effective on svc
    const graph = makeGraph(rootPath, [aspect], new Map([['svc', moduleNode('svc', ['live-rule'])]]));

    expect(checkAspectEffectiveNowhere(graph)).toHaveLength(0);
  });

  it('skips a node whose effectiveness throws (implies cycle) without crashing, and still flags a dead rule elsewhere', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'dead-rule', 'check.mjs');
    // Two aggregates in an implies cycle — computeEffectiveAspects throws on the
    // node that attaches them; the check must catch and continue (mirrors
    // computeExpectedPairs). The cycle members ship no rule source, so they never
    // warn; the independent dead-rule still does.
    const cycleA = aggregateAspect('cycle-a', ['cycle-b']);
    const cycleB = aggregateAspect('cycle-b', ['cycle-a']);
    const dead = detAspect('dead-rule', { when: NEVER_MATCHES });
    const node = moduleNode('svc', ['cycle-a', 'dead-rule']);
    const graph = makeGraph(rootPath, [cycleA, cycleB, dead], new Map([['svc', node]]));

    const issues = checkAspectEffectiveNowhere(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0].messageData.what).toContain("'dead-rule'");
  });

  it('does not warn for a non-aggregate aspect that is missing its rule source (a separate error)', async () => {
    const rootPath = await createTempYggdrasil();
    // No check.mjs / content.md written — reviewer.type is deterministic but the
    // source is absent (aspect-missing-rule-source covers that). This linter must
    // not pile a second warning on top.
    const aspect = detAspect('sourceless', { when: NEVER_MATCHES });
    const graph = makeGraph(rootPath, [aspect], new Map([['svc', moduleNode('svc', ['sourceless'])]]));

    expect(checkAspectEffectiveNowhere(graph)).toHaveLength(0);
  });
});

describe('checkArchitectureDefaultAspectUnreachable (per-type dead-attach linter)', () => {
  // Architecture attaches `pinned` as a default of type 'module', but the aspect's
  // own when targets a different type ('ghost'), so it is filtered off every module
  // node — the class where a rule's when cancels its architecture attachment.
  const ARCH_PINNED: ArchitectureDef = {
    node_types: {
      module: { description: 'A module', aspects: ['pinned'] },
      ghost: { description: 'A type no node uses', aspects: [] },
    },
  };

  function graphWith(rootPath: string, aspects: AspectDef[], nodes: Map<string, GraphNode>, arch: ArchitectureDef): Graph {
    return { config: {}, architecture: arch, nodes, aspects, flows: [], rootPath };
  }

  it('warns when an architecture type default is filtered off every node of that type', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'pinned', 'check.mjs');
    // The aspect is a module default in the architecture, but its when targets 'ghost'.
    const pinned = detAspect('pinned', { when: NEVER_MATCHES });
    const graph = graphWith(rootPath, [pinned], new Map([['svc', moduleNode('svc', [])]]), ARCH_PINNED);

    const issues = checkArchitectureDefaultAspectUnreachable(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('architecture-default-aspect-unreachable');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].messageData.what).toContain("'pinned'");
    expect(issues[0].messageData.what).toContain("'module'");
  });

  it('stays silent when the default aspect is effective on at least one node of the type', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'pinned', 'check.mjs');
    // No when — the default reaches every module node.
    const pinned = detAspect('pinned');
    const graph = graphWith(rootPath, [pinned], new Map([['svc', moduleNode('svc', [])]]), ARCH_PINNED);

    expect(checkArchitectureDefaultAspectUnreachable(graph)).toHaveLength(0);
  });

  it('stays silent for a type with no nodes (nothing to reach)', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'pinned', 'check.mjs');
    const pinned = detAspect('pinned', { when: NEVER_MATCHES });
    // Only a 'ghost'-typed node exists; type 'module' has no instances.
    const ghostNode: GraphNode = {
      path: 'g',
      meta: { name: 'g', type: 'ghost', aspects: [], mapping: ['src/g.ts'] },
      children: [],
      parent: null,
    };
    const graph = graphWith(rootPath, [pinned], new Map([['g', ghostNode]]), ARCH_PINNED);

    expect(checkArchitectureDefaultAspectUnreachable(graph)).toHaveLength(0);
  });
});
