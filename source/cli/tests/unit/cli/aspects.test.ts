import { describe, it, expect } from 'vitest';
import type { Graph, AspectDef, GraphNode } from '../../../src/model/graph.js';
import {
  computeAspectUsage,
  formatAspectsOutput,
  computeAspectHealth,
  formatAspectsHealthOutput,
  renderRefusedCell,
} from '../../../src/cli/aspects.js';
import type { VerifiedPair, PairState } from '../../../src/core/verify-lock.js';
import type { SuppressionsReport } from '../../../src/portal/api/suppress-scan.js';
import { nodeUnit } from '../../../src/model/lock.js';

function makeAspect(id: string, overrides: Partial<Omit<AspectDef, 'reviewer'>> & { reviewer?: string | AspectDef['reviewer'] } = {}): AspectDef {
  const { reviewer: rev, ...rest } = overrides;
  const reviewerSpec: AspectDef['reviewer'] =
    rev === undefined ? { type: 'llm' } :
    typeof rev === 'string' ? { type: rev as 'llm' | 'deterministic' } :
    rev;
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    description: `Description of ${id}`,
    reviewer: reviewerSpec,
    artifacts: [],
    ...rest,
  };
}

function makeNode(
  path: string,
  aspects: string[] = [],
  type: string = 'module',
): GraphNode {
  return {
    path,
    meta: {
      name: path.split('/').pop() || path,
      type,
      aspects,
    },
    children: [],
    parent: null,
  };
}

function makeGraph(aspects: AspectDef[], nodes: GraphNode[] = []): Graph {
  const nodesMap = new Map<string, GraphNode>();
  for (const node of nodes) {
    nodesMap.set(node.path, node);
  }

  return {
    rootPath: '/fake',
    config: { version: '1' },
    architecture: {
      node_types: {
        module: { description: 'Module', aspects: [] },
      },
    },
    nodes: nodesMap,
    aspects,
    flows: [],
  } as Graph;
}

describe('computeAspectUsage', () => {
  it('counts zero usage for orphaned aspect', () => {
    const graph = makeGraph([makeAspect('deterministic')]);
    const usage = computeAspectUsage(graph);
    expect(usage.get('deterministic')?.total).toBe(0);
  });

  it('counts own declaration usage', () => {
    const nodes = [makeNode('cli/core', ['deterministic'])];
    const graph = makeGraph([makeAspect('deterministic')], nodes);
    const usage = computeAspectUsage(graph);
    expect(usage.get('deterministic')?.total).toBe(1);
    expect(usage.get('deterministic')?.own).toBe(1);
  });

  it('counts multiple nodes using same aspect', () => {
    const nodes = [
      makeNode('cli/core', ['deterministic']),
      makeNode('cli/commands', ['deterministic']),
    ];
    const graph = makeGraph([makeAspect('deterministic')], nodes);
    const usage = computeAspectUsage(graph);
    expect(usage.get('deterministic')?.total).toBe(2);
    expect(usage.get('deterministic')?.own).toBe(2);
  });

  it('counts multiple aspect sources separately', () => {
    const nodes = [
      makeNode('cli/own', ['own-aspect']),
      makeNode('cli/flow', []),
    ];
    const graph = makeGraph(
      [makeAspect('own-aspect'), makeAspect('flow-aspect')],
      nodes,
    );
    graph.flows = [
      {
        path: 'test-flow',
        name: 'Test Flow',
        nodes: ['cli/flow'],
        aspects: ['flow-aspect'],
      },
    ];
    const usage = computeAspectUsage(graph);
    expect(usage.get('own-aspect')?.own).toBe(1);
    expect(usage.get('flow-aspect')?.flow).toBe(1);
  });

});

describe('formatAspectsOutput', () => {
  it('shows usage stats per aspect', () => {
    const aspects = [makeAspect('deterministic')];
    const nodes = [makeNode('cli/core', ['deterministic'])];
    const graph = makeGraph(aspects, nodes);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('deterministic');
    expect(output).toContain('Used by:');
  });

  it('shows orphaned label for unused aspect', () => {
    const aspects = [makeAspect('unused-aspect')];
    const graph = makeGraph(aspects);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('orphaned');
  });

  it('shows implies when present', () => {
    const aspects = [makeAspect('parent-aspect', { implies: ['child-aspect'] })];
    const graph = makeGraph(aspects);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('Implies: child-aspect');
  });

  it('handles aspect with no description', () => {
    const aspects = [makeAspect('bare', { description: undefined })];
    const graph = makeGraph(aspects);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('bare');
    expect(output).not.toContain('undefined');
  });

  it('shows multiple nodes count', () => {
    const aspects = [makeAspect('shared')];
    const nodes = [
      makeNode('cli/core', ['shared']),
      makeNode('cli/commands', ['shared']),
      makeNode('cli/utils', ['shared']),
    ];
    const graph = makeGraph(aspects, nodes);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('Used by: 3 nodes');
  });

  it('shows single node count correctly', () => {
    const aspects = [makeAspect('single')];
    const nodes = [makeNode('cli/core', ['single'])];
    const graph = makeGraph(aspects, nodes);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('Used by: 1 node');
  });

  it('shows Reviewer: deterministic for deterministic aspects', () => {
    const aspects = [makeAspect('async-fs', { reviewer: 'deterministic' })];
    const graph = makeGraph(aspects);
    const output = formatAspectsOutput(graph);
    expect(output).toMatch(/Reviewer:\s*deterministic/);
  });

  it('shows Reviewer: llm for aspects without explicit reviewer', () => {
    const aspects = [makeAspect('posix-paths')];
    const graph = makeGraph(aspects);
    const output = formatAspectsOutput(graph);
    expect(output).toMatch(/Reviewer:\s*llm/);
  });

  it('shows Reviewer: llm for aspects with explicit reviewer: llm', () => {
    const aspects = [makeAspect('explicit-llm', { reviewer: 'llm' })];
    const graph = makeGraph(aspects);
    const output = formatAspectsOutput(graph);
    expect(output).toMatch(/Reviewer:\s*llm/);
  });

  it('shows [enforced] tag when aspect has no explicit status', () => {
    const aspects = [makeAspect('default-status')];
    const graph = makeGraph(aspects);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('default-status [enforced]');
  });

  it('shows declared status tag from aspect definition', () => {
    const aspects = [
      makeAspect('draft-aspect', { status: 'draft' }),
      makeAspect('advisory-aspect', { status: 'advisory' }),
    ];
    const graph = makeGraph(aspects);
    const output = formatAspectsOutput(graph);
    expect(output).toContain('advisory-aspect [advisory]');
    expect(output).toContain('draft-aspect [draft]');
  });
});

// ── --health projection (C3 slice 1) ──────────────────────────────────────

function vp(
  aspectId: string,
  nodePath: string,
  state: PairState,
  kind: 'llm' | 'deterministic' = 'deterministic',
): VerifiedPair {
  return {
    pair: {
      aspectId,
      kind,
      unitKey: nodeUnit(nodePath),
      nodePath,
      status: 'enforced',
      subjectFiles: [`${nodePath}.ts`],
    },
    state,
  };
}

function report(
  entries: Array<{ file: string; markers: SuppressionsReport['fileEntries'][number]['markers'] }> = [],
): SuppressionsReport {
  const totalMarkers = entries.reduce((n, e) => n + e.markers.length, 0);
  return { fileEntries: entries, totalMarkers, warnings: [] };
}

describe('renderRefusedCell', () => {
  it('no pairs → em-dash (dormant aspect)', () => {
    expect(renderRefusedCell(0, 0, 0)).toBe('—');
  });
  it('all pairs known → integer count (zero is honest here)', () => {
    expect(renderRefusedCell(2, 0, 0)).toBe('0');
    expect(renderRefusedCell(3, 2, 0)).toBe('2');
  });
  it('unknown pairs with zero refusals → the word "unverified", never 0', () => {
    expect(renderRefusedCell(2, 0, 2)).toBe('unverified');
    expect(renderRefusedCell(2, 0, 1)).toBe('unverified'); // 1 verified, 1 unknown
    expect(renderRefusedCell(2, 0, 1)).not.toBe('0');
  });
  it('mixed refusals + unknowns → both facts stated', () => {
    expect(renderRefusedCell(5, 2, 3)).toBe('2 (+3 unverified)');
  });
});

describe('computeAspectHealth', () => {
  it('aggregates pairs, distinct nodes, and hash-valid refusals per aspect', () => {
    const graph = makeGraph([makeAspect('det', { reviewer: 'deterministic', errs: 'over' })]);
    const pairs: VerifiedPair[] = [
      vp('det', 'a', { kind: 'refused', reason: 'boom' }),
      vp('det', 'b', { kind: 'verified' }),
    ];
    const { rows } = computeAspectHealth(graph, pairs, report());
    const row = rows.find((r) => r.aspectId === 'det')!;
    expect(row.kind).toBe('deterministic');
    expect(row.nodes).toBe(2);
    expect(row.pairs).toBe(2);
    expect(row.refused).toBe('1');
    expect(row.errs).toBe('over');
  });

  it('an absent verdict counts as unknown, never as a refusal (unverified ≠ zero)', () => {
    const graph = makeGraph([makeAspect('llm', { reviewer: 'llm' })]);
    const pairs: VerifiedPair[] = [
      vp('llm', 'a', { kind: 'unverified' }, 'llm'),
      vp('llm', 'b', { kind: 'unverified' }, 'llm'),
    ];
    const { rows, hasUnverified } = computeAspectHealth(graph, pairs, report());
    const row = rows.find((r) => r.aspectId === 'llm')!;
    expect(row.refused).toBe('unverified');
    expect(row.refused).not.toBe('0');
    expect(hasUnverified).toBe(true);
  });

  it('a dormant aspect (no pairs) shows em-dash and zero nodes', () => {
    const graph = makeGraph([makeAspect('draft-x', { status: 'draft' })]);
    const { rows } = computeAspectHealth(graph, [], report());
    const row = rows.find((r) => r.aspectId === 'draft-x')!;
    expect(row.pairs).toBe(0);
    expect(row.nodes).toBe(0);
    expect(row.refused).toBe('—');
    expect(row.errs).toBe('—');
  });

  it('counts single/disable suppress markers per aspect; excludes enable terminators', () => {
    const graph = makeGraph([makeAspect('a1'), makeAspect('a2')]);
    const rep = report([
      {
        file: 'src/x.ts',
        markers: [
          { line: 1, aspectId: 'a1', kind: 'single', wildcard: false, reason: 'debt' },
          { line: 5, aspectId: 'a1', kind: 'disable', wildcard: false, reason: '' },
          { line: 9, aspectId: 'a1', kind: 'enable', wildcard: false, reason: '' },
          { line: 3, aspectId: 'a2', kind: 'single', wildcard: false, reason: 'x' },
        ],
      },
    ]);
    const { rows } = computeAspectHealth(graph, [], rep);
    expect(rows.find((r) => r.aspectId === 'a1')!.suppresses).toBe(2); // single + disable, not enable
    expect(rows.find((r) => r.aspectId === 'a2')!.suppresses).toBe(1);
  });

  it('wildcard markers are summarized separately, never attributed per-aspect', () => {
    const graph = makeGraph([makeAspect('a1')]);
    const rep = report([
      {
        file: 'src/x.ts',
        markers: [{ line: 1, aspectId: '*', kind: 'single', wildcard: true, reason: '' }],
      },
    ]);
    const { rows, wildcardMarkers } = computeAspectHealth(graph, [], rep);
    expect(wildcardMarkers).toBe(1);
    expect(rows.find((r) => r.aspectId === 'a1')!.suppresses).toBe(0);
  });

  it('rows are sorted by aspect id', () => {
    const graph = makeGraph([makeAspect('zebra'), makeAspect('alpha'), makeAspect('mid')]);
    const { rows } = computeAspectHealth(graph, [], report());
    expect(rows.map((r) => r.aspectId)).toEqual(['alpha', 'mid', 'zebra']);
  });
});

describe('formatAspectsHealthOutput', () => {
  it('renders the mandated column order in the header', () => {
    const graph = makeGraph([makeAspect('a1')]);
    const out = formatAspectsHealthOutput(computeAspectHealth(graph, [], report()));
    const header = out.split('\n')[0].trim().split(/\s{2,}/);
    expect(header).toEqual([
      'aspect', 'kind', 'status', 'nodes', 'pairs', 'refused', 'suppresses', 'errs',
    ]);
  });

  it('adds a wildcard summary line when wildcard markers exist', () => {
    const graph = makeGraph([makeAspect('a1')]);
    const rep = report([
      {
        file: 'src/x.ts',
        markers: [{ line: 1, aspectId: '*', kind: 'single', wildcard: true, reason: '' }],
      },
    ]);
    const out = formatAspectsHealthOutput(computeAspectHealth(graph, [], rep));
    expect(out).toContain('1 wildcard suppress marker');
    expect(out).toContain('not counted per-aspect');
  });

  it('omits the wildcard line and the unverified note when neither applies', () => {
    const graph = makeGraph([makeAspect('a1', { reviewer: 'deterministic' })]);
    const pairs = [vp('a1', 'n', { kind: 'verified' })];
    const out = formatAspectsHealthOutput(computeAspectHealth(graph, pairs, report()));
    expect(out).not.toContain('wildcard');
    expect(out).not.toContain('not yet checked');
  });
});
