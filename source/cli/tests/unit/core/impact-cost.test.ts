/**
 * Unit tests for core/impact-cost.ts — the facts `yg impact` answers with,
 * computed over a real on-disk project written for the test: a strict type with
 * a component, a misplaced file and an orphan; a classifying type whose files
 * have no component (type-covered); a script rule, a reviewer rule, a per-file
 * reviewer rule, a bundle, a flow rule and a three-vote reviewer tier, so every
 * cost branch has a real pair behind it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { makeTempDir, cleanupTempDirs } from '../../support/tmpdir.js';
import {
  aspectImpactOf,
  collectInvalidatedPairs,
  computeGraduationPreview,
  computeNodeFillCost,
  computeTypeVerdictImpact,
  descendantPaths,
  flowImpactOf,
  nodesOfType,
  strictCoverageGapOf,
  summarizeImpact,
  typeCoveredFilesOf,
} from '../../../src/core/impact-cost.js';
import type { Graph } from '../../../src/model/graph.js';
import type { LockFile } from '../../../src/model/lock.js';

let root: string;
let graph: Graph;

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const emptyLock = (): LockFile => ({ version: 1, verdicts: {}, nodes: {} }) as unknown as LockFile;

beforeAll(async () => {
  root = makeTempDir('ygg-impact-cost-');
  write('.yggdrasil/yg-config.yaml', [
    'version: "6.0.0"',
    'coverage:',
    '  type_level: true',
    'reviewer:',
    '  tiers:',
    '    standard:',
    '      provider: ollama',
    '      consensus: 3',
    '      config:',
    '        model: test',
    '        endpoint: http://127.0.0.1:1',
    '',
  ].join('\n'));
  write('.yggdrasil/yg-architecture.yaml', [
    'node_types:',
    '  module:',
    '    description: grouping',
    '  svc:',
    '    description: services',
    '    enforce: strict',
    '    when:',
    '      path: "src/svc/**"',
    '    aspects: [det-rule]',
    '  other:',
    '    description: something else',
    '  lib:',
    '    description: libraries',
    '    when:',
    '      path: "src/lib/**"',
    '    aspects: [file-rule, det-rule]',
    '',
  ].join('\n'));
  write('.yggdrasil/aspects/det-rule/yg-aspect.yaml', 'name: Det\ndescription: a script rule\nreviewer:\n  type: deterministic\nscope:\n  per: file\n');
  write('.yggdrasil/aspects/det-rule/check.mjs', 'export function check() { return []; }\n');
  write('.yggdrasil/aspects/llm-rule/yg-aspect.yaml', 'name: Llm\ndescription: a reviewer rule\nreviewer:\n  type: llm\n');
  write('.yggdrasil/aspects/llm-rule/content.md', '# Llm\nBe good.\n');
  write('.yggdrasil/aspects/file-rule/yg-aspect.yaml', 'name: File\ndescription: a per-file reviewer rule\nreviewer:\n  type: llm\nscope:\n  per: file\n');
  write('.yggdrasil/aspects/file-rule/content.md', '# File\nBe good per file.\n');
  write('.yggdrasil/aspects/flow-rule/yg-aspect.yaml', 'name: Flow\ndescription: a flow rule\nreviewer:\n  type: llm\n');
  write('.yggdrasil/aspects/flow-rule/content.md', '# Flow\nBe good in the flow.\n');
  write('.yggdrasil/aspects/bundle-rule/yg-aspect.yaml', 'name: Bundle\ndescription: a bundle\nimplies:\n  - flow-rule\n');
  write('.yggdrasil/model/app/yg-node.yaml', 'name: App\ndescription: x\ntype: module\naspects:\n  - llm-rule\n');
  write('.yggdrasil/model/app/a/yg-node.yaml', 'name: A\ndescription: x\ntype: svc\nmapping:\n  - src/svc/a.ts\naspects:\n  - bundle-rule\n');
  write('.yggdrasil/model/app/b/yg-node.yaml', 'name: B\ndescription: x\ntype: other\nmapping:\n  - src/svc/b.ts\n');
  write('.yggdrasil/model/app/c/yg-node.yaml', 'name: C\ndescription: x\ntype: svc\nmapping:\n  - src/svc/c.ts\nrelations:\n  - target: app/a\n    type: uses\n');
  write('.yggdrasil/model/app/c/d/yg-node.yaml', 'name: D\ndescription: x\ntype: svc\nmapping:\n  - src/svc/d/d.ts\n');
  write('.yggdrasil/flows/pay/yg-flow.yaml', 'name: Pay\ndescription: x\nnodes:\n  - app/c\n  - app/missing\naspects:\n  - flow-rule\n');
  write('src/svc/a.ts', 'export const a = 1;\n');
  write('src/svc/b.ts', 'export const b = 1;\n');
  write('src/svc/c.ts', "import { a } from './a.js';\nexport const c = a;\n");
  write('src/svc/d/d.ts', 'export const d = 1;\n');
  write('src/svc/orphan.ts', 'export const o = 1;\n');
  write('src/lib/x.ts', 'export const x = 1;\n');
  write('src/lib/y.ts', 'export const y = 1;\n');
  graph = await loadGraph(root);
});

afterAll(() => {
  cleanupTempDirs();
});

describe('descendantPaths', () => {
  it('lists every descendant sorted, and nothing for a leaf or an unknown path', () => {
    expect(descendantPaths(graph, 'app')).toEqual(['app/a', 'app/b', 'app/c', 'app/c/d']);
    expect(descendantPaths(graph, 'app/a')).toEqual([]);
    expect(descendantPaths(graph, 'no/such')).toEqual([]);
  });
});

describe('aspectImpactOf', () => {
  it('names the channel each component is reached through, and prices a reviewer rule by its consensus', async () => {
    const aspect = graph.aspects.find((a) => a.id === 'llm-rule')!;
    const impact = await aspectImpactOf(graph, aspect, emptyLock(), root);
    const sources = Object.fromEntries(impact.affected.map((r) => [r.path, r.source]));
    expect(sources['app']).toBe('own');
    expect(sources['app/a']).toBe('hierarchy from app');
    expect(sources['app/c/d']).toBe('hierarchy from app');
    expect(impact.cost.kind).toBe('llm');
    expect(impact.cost.reviewerCalls).toBe(impact.cost.units * 3);
    expect(impact.affected.every((r) => r.refused === false)).toBe(true);
  });

  it('reports a rule reached through a flow, and one reached only by implication', async () => {
    const flowRule = graph.aspects.find((a) => a.id === 'flow-rule')!;
    const impact = await aspectImpactOf(graph, flowRule, emptyLock(), root);
    const sources = Object.fromEntries(impact.affected.map((r) => [r.path, r.source]));
    expect(sources['app/c']).toBe('flow: Pay');
    expect(sources['app/c/d']).toBe('flow: Pay');
    expect(sources['app/a']).toBe('implied');
    expect(impact.propagatingFlows).toEqual(['Pay']);
    expect(impact.impliedBy).toEqual(['bundle-rule']);
  });

  it('prices a script rule as free, counting its type-covered files, and a bundle as neither', async () => {
    const det = await aspectImpactOf(graph, graph.aspects.find((a) => a.id === 'det-rule')!, emptyLock(), root);
    expect(det.cost.kind).toBe('deterministic');
    expect(det.cost.reviewerCalls).toBe(0);
    expect(det.cost.fileUnits).toBe(2); // src/lib/x.ts and src/lib/y.ts, covered by their type alone
    const bundle = await aspectImpactOf(graph, graph.aspects.find((a) => a.id === 'bundle-rule')!, emptyLock(), root);
    expect(bundle.cost.kind).toBe('unknown');
    expect(bundle.implies).toEqual(['flow-rule']);
  });

  it('marks a component holding a refused verdict for the rule', async () => {
    const lock = emptyLock();
    (lock.verdicts as Record<string, Record<string, unknown>>)['llm-rule'] = { 'node:app/a': { verdict: 'refused' } };
    const impact = await aspectImpactOf(graph, graph.aspects.find((a) => a.id === 'llm-rule')!, lock, root);
    expect(impact.affected.find((r) => r.path === 'app/a')?.refused).toBe(true);
  });
});

describe('flowImpactOf', () => {
  it('lists declared participants and their descendants, skipping one the graph does not hold', () => {
    const flow = graph.flows.find((f) => f.name === 'Pay')!;
    const impact = flowImpactOf(graph, flow);
    expect(impact.participants).toEqual([
      { path: 'app/c', declared: true },
      { path: 'app/c/d', declared: false },
    ]);
    expect(impact.flowAspects).toEqual(['flow-rule']);
  });
});

describe('a type', () => {
  it('lists its components, the files it covers alone and through them, and what is at stake', async () => {
    expect(nodesOfType(graph, 'svc')).toEqual(['app/a', 'app/c', 'app/c/d']);
    const svc = await typeCoveredFilesOf(graph, 'svc', nodesOfType(graph, 'svc'));
    expect(svc.files.map((f) => f.label)).toContain('in app/a');
    const lib = await typeCoveredFilesOf(graph, 'lib', nodesOfType(graph, 'lib'));
    expect(lib.typeCoveredPaths).toEqual(['src/lib/x.ts', 'src/lib/y.ts']);
    expect(lib.files.every((f) => f.label === 'type-covered, no component')).toBe(true);
    const lock = emptyLock();
    (lock.verdicts as Record<string, Record<string, unknown>>)['det-rule'] = { 'file:src/lib/x.ts': { verdict: 'approved' } };
    const stake = await computeTypeVerdictImpact(graph, 'lib', lib.typeCoverage!, lock);
    expect(stake.typeCoveredFiles).toBe(2);
    expect(stake.detPairs).toBe(2);
    expect(stake.llmPairs).toBe(2);
    expect(stake.reviewerCalls).toBe(6);
    expect(stake.greensAtStake).toBe(1);
  });

  it('finds the strict type\'s orphans and misplaced files', async () => {
    const gap = await strictCoverageGapOf(graph, 'svc');
    expect(gap.preview).toBe(false);
    expect(gap.orphans).toEqual(['src/svc/orphan.ts']);
    expect(gap.misplaced).toEqual([{ file: 'src/svc/b.ts', owner: 'app/b', ownerType: 'other' }]);
    expect(gap.conflicts).toEqual([]);
  });

  it('previews the gap of a type that is not strict yet', async () => {
    const gap = await strictCoverageGapOf(graph, 'lib');
    expect(gap.preview).toBe(true);
    expect(gap.orphans).toEqual(['src/lib/x.ts', 'src/lib/y.ts']);
    expect(gap.misplaced).toEqual([]);
  });
});

describe('a file, a component, a type-covered file', () => {
  it('collects the pairs an edit invalidates and sums them per component and in total', async () => {
    const lock = emptyLock();
    (lock.verdicts as Record<string, Record<string, unknown>>)['llm-rule'] = { 'node:app/a': { verdict: 'approved' } };
    const set = await collectInvalidatedPairs(graph, 'src/svc/a.ts', lock, root);
    expect(set.pairs.length).toBeGreaterThan(0);
    const summary = summarizeImpact(set, graph, lock);
    const row = summary.byNode.find((r) => r.nodePath === 'app/a')!;
    expect(row.llmPairs).toBeGreaterThan(0);
    expect(row.reviewerCalls).toBe(row.llmPairs * 3);
    expect(row.detPairs).toBe(1);
    expect(summary.greensReRolled).toBe(1);
    expect(summary.fileLevelPairs).toBe(0);

    const fileSet = await collectInvalidatedPairs(graph, 'src/lib/x.ts', lock, root);
    const fileSummary = summarizeImpact(fileSet, graph, lock);
    expect(fileSummary.fileLevelPairs).toBe(2);
    expect(fileSummary.byNode).toEqual([]);
    expect(fileSummary.billedReviewerCalls).toBe(3);
    expect(fileSummary.freeDeterministic).toBe(1);
  });

  it('prices a component, and one file of it', async () => {
    const lock = emptyLock();
    (lock.verdicts as Record<string, Record<string, unknown>>)['det-rule'] = { 'file:src/svc/a.ts': { verdict: 'approved' } };
    const node = await computeNodeFillCost(graph, 'app/a', lock);
    expect(node.detPairs).toBe(1);
    expect(node.reviewerCalls).toBe(node.llmPairs * 3);
    expect(node.greensReRolled).toBe(1);
    const file = await computeNodeFillCost(graph, 'app/a', lock, 'src/lib/x.ts');
    expect(file).toEqual({ llmPairs: 0, detPairs: 0, reviewerCalls: 0, greensReRolled: 0 });
  });

  it('prices giving a type-covered file a component of its own', async () => {
    const lib = await typeCoveredFilesOf(graph, 'lib', []);
    const preview = await computeGraduationPreview(graph, 'src/lib/x.ts', lib.typeCoverage!);
    expect(preview).toEqual({ file: 'src/lib/x.ts', currentType: 'lib', llmPairsReVerified: 1, reviewerCalls: 3, detPairsReVerified: 1 });
    const none = await computeGraduationPreview(graph, 'src/svc/a.ts', lib.typeCoverage!, []);
    expect(none.currentType).toBe('');
    expect(none.llmPairsReVerified + none.detPairsReVerified).toBe(0);
  });
});
