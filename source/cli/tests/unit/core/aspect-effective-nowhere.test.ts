import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  checkAspectEffectiveNowhere,
  checkArchitectureDefaultAspectUnreachable,
} from '../../../src/core/checks/aspect-contracts.js';
import type { Graph, AspectDef, GraphNode, ArchitectureDef } from '../../../src/model/graph.js';
import type { WhenPredicate } from '../../../src/model/when.js';
import type { TypeCoverageInput } from '../../../src/core/pairs.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { walkRepoFiles } from '../../../src/io/repo-scanner.js';
import { scanUncoveredFiles } from '../../../src/core/check.js';
import { computeTypeCoverage } from '../../../src/core/type-coverage.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';
import { FIXTURE_TYPE_ONLY } from '../../fixtures/type-level-engine/variants/index.js';

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const BASE_FIXTURE = path.join(__dirname2, '..', '..', 'fixtures', 'type-level-engine');

/** Real classification pipeline (walkRepoFiles + scanUncoveredFiles + computeTypeCoverage) — never a hand-built map. */
async function classify(graph: Graph): Promise<TypeCoverageInput> {
  const projectRoot = path.dirname(graph.rootPath);
  const files = await walkRepoFiles(projectRoot);
  const uncovered = scanUncoveredFiles(graph, files);
  const result = await computeTypeCoverage(graph, uncovered, new FileContentCache());
  return { covered: result.covered, ambiguousPaths: result.ambiguous.map((a) => a.file) };
}

/**
 * Copy the base type-level-engine fixture, overlay variants/type-only (a
 * README only — no architecture override needed, per its own doc), then
 * empty .yggdrasil/model/'s children so the resulting project has ZERO
 * explicit components — only src/leaf/a.ts, enforced purely by its type.
 */
function buildTypeOnlyProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-type-only-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  cpSync(FIXTURE_TYPE_ONLY, dir, { recursive: true });
  const modelDir = path.join(dir, '.yggdrasil', 'model');
  for (const child of readdirSync(modelDir)) {
    rmSync(path.join(modelDir, child), { recursive: true, force: true });
  }
  return dir;
}

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

describe('type-coverage tier-awareness (Step 5)', () => {
  const typeOnlyDirs: string[] = [];
  afterEach(() => {
    for (const d of typeOnlyDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // FIXTURE_TYPE_ONLY: zero explicit components anywhere in the graph — only
  // src/leaf/a.ts, enforced purely by its 'leaf' architecture type. The base
  // fixture attaches own-file-rule to 'leaf' and nowhere else, so this is the
  // MOST extreme case: a rule live only on files, no component anywhere.
  it('does not call a rule dead when it applies only to files that have no component', async () => {
    const dir = buildTypeOnlyProject();
    typeOnlyDirs.push(dir);
    const graph = await loadGraph(dir);
    const typeCoverage = await classify(graph);
    expect(typeCoverage.covered.get('src/leaf/a.ts')).toBe('leaf');

    const on = checkAspectEffectiveNowhere(graph, typeCoverage);
    expect(on.map((i) => i.messageData.what.match(/'([^']+)'/)?.[1])).not.toContain('own-file-rule');
  });

  // The brief's own illustrative twin re-used this SAME zero-node fixture for
  // the flag-off case; that cannot hold: the bootstrap carve-out (silent while
  // the model tree has zero nodes) already existed before this task and is
  // UNCONDITIONAL for a one-argument call — "absent -> today's behavior
  // exactly" pins that this genuinely-nodeless graph stays silent, one-arg,
  // regardless of what a SECOND argument would have revealed. Verified real:
  // reverting the two-argument threading, the two-argument call in the test
  // above fails (own-file-rule reported dead) while THIS one-arg call is
  // unaffected either way — proving the carve-out, not the new union, is what
  // this test pins. The MEANINGFUL flag-off/flag-on twin (a non-bootstrap
  // graph where the distinction is not vacuous) follows below.
  it('the bootstrap carve-out still applies one-arg on a genuinely nodeless graph', async () => {
    const dir = buildTypeOnlyProject();
    typeOnlyDirs.push(dir);
    const graph = await loadGraph(dir);
    expect(checkAspectEffectiveNowhere(graph)).toHaveLength(0);
  });

  // The brief's own illustrative snippet expected toHaveLength(0) here — FALSE
  // against this fixture, confirmed by running it: 'leaf' declares two aspects
  // (gated-on-descendants, never-here) whose own doc comments state they must
  // ALWAYS read when-not-satisfied for a file-level unit (a file can never own
  // a port or have descendants) — genuinely unreachable BY DESIGN, the same
  // way they are already unreachable today for the fixture's real 'owned' node
  // (verified: checkArchitectureDefaultAspectUnreachable(loadGraph(BASE_FIXTURE))
  // one-arg already reports these same two, with zero Task-8 code in play).
  // "Has instances" is proven precisely by these two findings REAPPEARING for
  // a type with zero real components once its only instance is a type-covered
  // file — not by the type going silent.
  it('treats a type with matching files as having instances (checkArchitectureDefaultAspectUnreachable)', async () => {
    const dir = buildTypeOnlyProject();
    typeOnlyDirs.push(dir);
    const graph = await loadGraph(dir);
    // Scoped to 'leaf' alone (not the fixture's full classification) so the
    // assertion is not entangled with 'consumer's relation-gated aspects,
    // which read false for an unrelated reason (no edge index supplied here).
    const typeCoverage: TypeCoverageInput = { covered: new Map([['src/leaf/a.ts', 'leaf']]), ambiguousPaths: [] };
    const issues = checkArchitectureDefaultAspectUnreachable(graph, typeCoverage);
    expect(issues.map((i) => i.messageData.what.match(/'([^']+)'/)?.[1]).sort()).toEqual([
      'gated-on-descendants', 'never-here',
    ]);
    // Confirms these are not new false positives Task 8 introduced: the SAME
    // two findings already fire for the real 'owned' node (type leaf) in the
    // ordinary, fully-populated fixture, one-arg, with no typeCoverage at all.
    const baseGraph = await loadGraph(BASE_FIXTURE);
    const baseline = checkArchitectureDefaultAspectUnreachable(baseGraph);
    expect(baseline.map((i) => i.messageData.what.match(/'([^']+)'/)?.[1]).sort()).toEqual([
      'gated-on-descendants', 'never-here',
    ]);
  });

  it('the bootstrap carve-out still applies one-arg on a genuinely nodeless graph (checkArchitectureDefaultAspectUnreachable)', async () => {
    const dir = buildTypeOnlyProject();
    typeOnlyDirs.push(dir);
    const graph = await loadGraph(dir);
    expect(checkArchitectureDefaultAspectUnreachable(graph)).toHaveLength(0);
  });

  // A non-bootstrap twin: ONE real node (of a DIFFERENT type) keeps
  // graph.nodes.size > 0, so the carve-out never applies either way — the
  // only thing that can make 'own-rule' live is the type-coverage union
  // itself, discriminating flag-on from flag-off for real. `own-rule` is
  // file-level (scope: { per: 'file' }): a per:node (whole-unit) rule has no
  // component to run on for a nodeless file, so it could never be genuinely
  // "live" there — see the dedicated whole-unit twin below for that direction.
  function typeOnlyTwinGraph(rootPath: string): { graph: Graph; typeCoverage: TypeCoverageInput } {
    const arch: ArchitectureDef = {
      node_types: {
        module: { description: 'A module', aspects: [] },
        leafy: { description: 'Classifies src/leafy/**', aspects: ['own-rule'], when: { path: 'src/leafy/**' } },
      },
    };
    const ownRule = detAspect('own-rule', { scope: { per: 'file' } });
    const otherNode = moduleNode('other', []);
    const graph: Graph = { config: {}, architecture: arch, nodes: new Map([['other', otherNode]]), aspects: [ownRule], flows: [], rootPath };
    const typeCoverage: TypeCoverageInput = { covered: new Map([['src/leafy/f.ts', 'leafy']]), ambiguousPaths: [] };
    return { graph, typeCoverage };
  }

  it('flag-on: a file-level rule live only on a type-covered file (real node exists for another type) is not dead', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'own-rule', 'check.mjs');
    const { graph, typeCoverage } = typeOnlyTwinGraph(rootPath);
    const issues = checkAspectEffectiveNowhere(graph, typeCoverage);
    expect(issues.some((i) => i.messageData.what.includes("'own-rule'"))).toBe(false);
  });

  it('flag-off: the SAME rule, one-arg, is still reported dead — byte-identical to before the tier existed', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'own-rule', 'check.mjs');
    const { graph } = typeOnlyTwinGraph(rootPath);
    const issues = checkAspectEffectiveNowhere(graph);
    expect(issues.some((i) => i.messageData.what.includes("'own-rule'"))).toBe(true);
  });

  // The other direction of the dead-law relaxation (fix round 1): a
  // WHOLE-UNIT (per: node) rule reachable ONLY through a type-covered file
  // must STILL be reported dead — it can never produce a pair there (no
  // component to run it on), so counting the file as making it "live" would
  // hide a rule that genuinely never verifies anything.
  function typeOnlyWholeUnitTwinGraph(rootPath: string): { graph: Graph; typeCoverage: TypeCoverageInput } {
    const arch: ArchitectureDef = {
      node_types: {
        module: { description: 'A module', aspects: [] },
        leafy: { description: 'Classifies src/leafy/**', aspects: ['whole-unit-only-rule'], when: { path: 'src/leafy/**' } },
      },
    };
    const wholeUnitRule = detAspect('whole-unit-only-rule'); // no scope -> per: node (whole-unit) default
    const otherNode = moduleNode('other', []);
    const graph: Graph = { config: {}, architecture: arch, nodes: new Map([['other', otherNode]]), aspects: [wholeUnitRule], flows: [], rootPath };
    const typeCoverage: TypeCoverageInput = { covered: new Map([['src/leafy/f.ts', 'leafy']]), ambiguousPaths: [] };
    return { graph, typeCoverage };
  }

  it('flag-on: a whole-unit rule reachable only through a type-covered file is still reported dead — it can never produce a pair there', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'whole-unit-only-rule', 'check.mjs');
    const { graph, typeCoverage } = typeOnlyWholeUnitTwinGraph(rootPath);
    const issues = checkAspectEffectiveNowhere(graph, typeCoverage);
    expect(issues.some((i) => i.messageData.what.includes("'whole-unit-only-rule'"))).toBe(true);
  });

  // Same non-bootstrap discrimination for checkArchitectureDefaultAspectUnreachable:
  // ONE real node (a different type) keeps graph.nodes.size > 0 throughout, so
  // whether 'leafy' is reported as having an unreachable default hinges ENTIRELY
  // on typeCoverage granting it an instance, never on the bootstrap carve-out.
  function unreachableDefaultTwinGraph(rootPath: string): { graph: Graph; typeCoverage: TypeCoverageInput } {
    const arch: ArchitectureDef = {
      node_types: {
        module: { description: 'A module', aspects: [] },
        leafy: { description: 'Classifies src/leafy/**', aspects: ['dead-default'], when: { path: 'src/leafy/**' } },
      },
    };
    const deadDefault = detAspect('dead-default', { when: NEVER_MATCHES });
    const otherNode = moduleNode('other', []);
    const graph: Graph = { config: {}, architecture: arch, nodes: new Map([['other', otherNode]]), aspects: [deadDefault], flows: [], rootPath };
    const typeCoverage: TypeCoverageInput = { covered: new Map([['src/leafy/f.ts', 'leafy']]), ambiguousPaths: [] };
    return { graph, typeCoverage };
  }

  it('flag-on: a type with zero components but one type-covered file is checked for reachability', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'dead-default', 'check.mjs');
    const { graph, typeCoverage } = unreachableDefaultTwinGraph(rootPath);
    const issues = checkArchitectureDefaultAspectUnreachable(graph, typeCoverage);
    expect(issues).toHaveLength(1);
    expect(issues[0].messageData.what).toContain("'dead-default'");
    expect(issues[0].messageData.what).toContain("'leafy'");
  });

  it('flag-off: the SAME type, one-arg, has no known instance so nothing is checked — byte-identical to before the tier existed', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'dead-default', 'check.mjs');
    const { graph } = unreachableDefaultTwinGraph(rootPath);
    expect(checkArchitectureDefaultAspectUnreachable(graph)).toHaveLength(0);
  });

  // The dead-law relaxation, pinned directly on checkArchitectureDefaultAspectUnreachable
  // (fix round 1): a file-level default reachable only through a type-covered
  // file is genuinely reachable there and must NOT be reported unreachable.
  function reachableFileDefaultTwinGraph(rootPath: string): { graph: Graph; typeCoverage: TypeCoverageInput } {
    const arch: ArchitectureDef = {
      node_types: {
        module: { description: 'A module', aspects: [] },
        leafy: { description: 'Classifies src/leafy/**', aspects: ['file-level-default'], when: { path: 'src/leafy/**' } },
      },
    };
    const fileLevelDefault = detAspect('file-level-default', { scope: { per: 'file' } }); // no when -> always cascade-effective
    const otherNode = moduleNode('other', []);
    const graph: Graph = { config: {}, architecture: arch, nodes: new Map([['other', otherNode]]), aspects: [fileLevelDefault], flows: [], rootPath };
    const typeCoverage: TypeCoverageInput = { covered: new Map([['src/leafy/f.ts', 'leafy']]), ambiguousPaths: [] };
    return { graph, typeCoverage };
  }

  it('flag-on: a file-level default reachable through a type-covered file is not reported unreachable', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'file-level-default', 'check.mjs');
    const { graph, typeCoverage } = reachableFileDefaultTwinGraph(rootPath);
    const issues = checkArchitectureDefaultAspectUnreachable(graph, typeCoverage);
    expect(issues.some((i) => i.messageData.what.includes("'file-level-default'"))).toBe(false);
  });

  // The other direction: a WHOLE-UNIT (per: node) default, with no `when` at
  // all restricting it, is still reported unreachable when its only instance
  // is a type-covered file — it can never produce a pair there regardless of
  // `when`, so counting the file as an instance for it would hide a rule that
  // genuinely never verifies anything for this type.
  function wholeUnitDefaultTwinGraph(rootPath: string): { graph: Graph; typeCoverage: TypeCoverageInput } {
    const arch: ArchitectureDef = {
      node_types: {
        module: { description: 'A module', aspects: [] },
        leafy: { description: 'Classifies src/leafy/**', aspects: ['whole-unit-default'], when: { path: 'src/leafy/**' } },
      },
    };
    const wholeUnitDefault = detAspect('whole-unit-default'); // no scope -> per: node; no when -> would be cascade-effective everywhere
    const otherNode = moduleNode('other', []);
    const graph: Graph = { config: {}, architecture: arch, nodes: new Map([['other', otherNode]]), aspects: [wholeUnitDefault], flows: [], rootPath };
    const typeCoverage: TypeCoverageInput = { covered: new Map([['src/leafy/f.ts', 'leafy']]), ambiguousPaths: [] };
    return { graph, typeCoverage };
  }

  it('flag-on: a whole-unit default reachable only through a type-covered file is still reported unreachable — it can never produce a pair there', async () => {
    const rootPath = await createTempYggdrasil();
    await createRuleSource(rootPath, 'whole-unit-default', 'check.mjs');
    const { graph, typeCoverage } = wholeUnitDefaultTwinGraph(rootPath);
    const issues = checkArchitectureDefaultAspectUnreachable(graph, typeCoverage);
    expect(issues.some((i) => i.messageData.what.includes("'whole-unit-default'"))).toBe(true);
  });
});
