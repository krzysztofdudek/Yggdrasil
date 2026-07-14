import { describe, it, expect } from 'vitest';
import type { Graph, AspectDef, GraphNode } from '../../../src/model/graph.js';
import {
  computeAspectUsage,
  formatAspectsOutput,
  computeAspectHealth,
  formatAspectsHealthOutput,
  renderRefusedCell,
  renderRuleAge,
  resolveRuleAges,
} from '../../../src/cli/aspects.js';
import type { VerifiedPair, PairState } from '../../../src/core/verify-lock.js';
import type { SuppressionsReport } from '../../../src/portal/api/suppress-scan.js';
import { nodeUnit } from '../../../src/model/lock.js';
import type {
  AspectHealthSignal,
  AspectFalsePositiveSignal,
  DrillStatus,
} from '../../../src/core/aspect-health-signals.js';

function signal(over: Partial<AspectHealthSignal>): AspectHealthSignal {
  return {
    catch: 0,
    exposure: 0,
    pointEstimate: 0,
    uncertaintyWide: false,
    label: 'quiet',
    demotionCorroborated: false,
    ...over,
  };
}

function fpSignal(over: Partial<AspectFalsePositiveSignal>): AspectFalsePositiveSignal {
  return {
    fp: 0,
    blocks: 0,
    suppressed: 0,
    overturned: 0,
    shrunkRate: 0,
    thinData: false,
    ...over,
  };
}

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

  it('renders the TRUE kind for an aggregate bundle even when reviewer.type mis-declares llm', () => {
    // An implies-only bundle ships neither content.md nor check.mjs. Even if its
    // yaml copy-pasted `reviewer:\n  type: llm`, the health kind must read
    // 'aggregate' — kind is derived from rule-source presence, not the declared
    // field, so a content-less bundle can never masquerade as an LLM reviewer.
    const graph = makeGraph([
      makeAspect('agg', { reviewer: 'llm', implies: ['child'], artifacts: [] }),
      makeAspect('child', { reviewer: 'deterministic' }),
    ]);
    const { rows } = computeAspectHealth(graph, [], report());
    expect(rows.find((r) => r.aspectId === 'agg')!.kind).toBe('aggregate');
  });

  it('derives kind from rule-source presence: content.md → llm, check.mjs → deterministic', () => {
    const graph = makeGraph([
      makeAspect('llm-x', { reviewer: 'llm', artifacts: [{ filename: 'content.md', content: 'rule' }] }),
      makeAspect('det-x', {
        reviewer: 'deterministic',
        artifacts: [{ filename: 'check.mjs', content: 'export function check() { return []; }' }],
      }),
    ]);
    const { rows } = computeAspectHealth(graph, [], report());
    expect(rows.find((r) => r.aspectId === 'llm-x')!.kind).toBe('llm');
    expect(rows.find((r) => r.aspectId === 'det-x')!.kind).toBe('deterministic');
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
      'aspect', 'kind', 'status', 'nodes', 'pairs', 'refused', 'suppresses', 'errs', 'age',
      'catch', 'exposure', 'signal', 'fp',
    ]);
  });

  it('adds a wildcard summary line when wildcard markers exist (singular conjugation)', () => {
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
    // Singular: noun, verb, and copula all agree — "1 marker applies … and is not counted".
    expect(out).toContain('1 wildcard suppress marker applies to every aspect and is not counted');
    expect(out).not.toContain('marker apply'); // guard against the un-conjugated verb regressing
  });

  it('pluralizes the wildcard summary line when multiple wildcard markers exist', () => {
    const graph = makeGraph([makeAspect('a1')]);
    const rep = report([
      {
        file: 'src/x.ts',
        markers: [{ line: 1, aspectId: '*', kind: 'single', wildcard: true, reason: '' }],
      },
      {
        file: 'src/y.ts',
        markers: [{ line: 2, aspectId: '*', kind: 'single', wildcard: true, reason: '' }],
      },
    ]);
    const out = formatAspectsHealthOutput(computeAspectHealth(graph, [], rep));
    // Plural: noun, verb, and copula all agree — "2 markers apply … and are not counted".
    expect(out).toContain('2 wildcard suppress markers apply to every aspect and are not counted');
  });

  it('omits the wildcard line and the unverified note when neither applies', () => {
    const graph = makeGraph([makeAspect('a1', { reviewer: 'deterministic' })]);
    const pairs = [vp('a1', 'n', { kind: 'verified' })];
    const out = formatAspectsHealthOutput(computeAspectHealth(graph, pairs, report()));
    expect(out).not.toContain('wildcard');
    expect(out).not.toContain('not yet checked');
  });

  it('renders the rule age in its column when supplied (age is column index 8)', () => {
    const graph = makeGraph([makeAspect('a1', { reviewer: 'deterministic' })]);
    const ages = new Map([['a1', '3mo']]);
    const health = computeAspectHealth(graph, [], report(), ages);
    const out = formatAspectsHealthOutput(health);
    const dataRow = out.split('\n').find((l) => l.trim().split(/\s{2,}/)[0] === 'a1')!;
    const cells = dataRow.trim().split(/\s{2,}/);
    // age holds its fixed position; the catch/exposure/signal/fp columns follow it,
    // reading em-dash for a rule with no recorded telemetry.
    expect(cells[8]).toBe('3mo');
    expect(cells.slice(9)).toEqual(['—', '—', '—', '—']);
  });
});

// ── catch / exposure + anti-Goodhart signal (C3 slice 3) ──────────────────

describe('computeAspectHealth — catch/exposure cells + signal notes', () => {
  it('fills catch/exposure/signal cells from the signal, em-dash when never exposed', () => {
    const graph = makeGraph([
      makeAspect('active-x', { reviewer: 'deterministic' }),
      makeAspect('dormant-x', { reviewer: 'deterministic' }),
    ]);
    const signals = new Map<string, AspectHealthSignal>([
      ['active-x', signal({ catch: 4, exposure: 12, label: 'active' })],
      ['dormant-x', signal({ catch: 0, exposure: 0, label: 'quiet' })],
    ]);
    const { rows } = computeAspectHealth(graph, [], report(), new Map(), signals);
    const active = rows.find((r) => r.aspectId === 'active-x')!;
    expect(active.catchCell).toBe('4');
    expect(active.exposureCell).toBe('12');
    expect(active.signalCell).toBe('active');
    const dormant = rows.find((r) => r.aspectId === 'dormant-x')!;
    expect(dormant.catchCell).toBe('—');
    expect(dormant.exposureCell).toBe('—');
    expect(dormant.signalCell).toBe('—');
  });

  it('emits the anti-Goodhart covenant note for a decorative? rule whose drills pass', () => {
    const graph = makeGraph([makeAspect('never-hit', { reviewer: 'deterministic' })]);
    const signals = new Map<string, AspectHealthSignal>([
      ['never-hit', signal({ catch: 0, exposure: 30, label: 'decorative?', pointEstimate: 0.03 })],
    ]);
    const drillStatuses = new Map<string, DrillStatus>([['never-hit', 'proves-catch']]);
    const { signalNotes } = computeAspectHealth(graph, [], report(), new Map(), signals, drillStatuses);
    expect(signalNotes.some((n) => n.includes('enforceable but never violated — may be deterring violations'))).toBe(true);
    const out = formatAspectsHealthOutput(computeAspectHealth(graph, [], report(), new Map(), signals, drillStatuses));
    expect(out).toContain('enforceable but never violated — may be deterring violations');
    expect(out).not.toContain('beta-binomial'); // method names never leak into CLI text
    expect(out).not.toContain('Wilson');
  });

  it('emits a plain-words "few observations" note for a thin sample', () => {
    const graph = makeGraph([makeAspect('thin-x', { reviewer: 'deterministic' })]);
    const signals = new Map<string, AspectHealthSignal>([
      ['thin-x', signal({ catch: 1, exposure: 3, label: 'active', uncertaintyWide: true, pointEstimate: 0.25 })],
    ]);
    const out = formatAspectsHealthOutput(computeAspectHealth(graph, [], report(), new Map(), signals));
    expect(out).toContain('uncertainty range is wide (few observations)');
  });
});

describe('computeAspectHealth — false-block (fp) cell + notes', () => {
  const emptyDrills = new Map<string, DrillStatus>();
  const noSignals = new Map<string, AspectHealthSignal>();

  it('renders the fp cell as a thin-data-labelled count, em-dash when no block is on record', () => {
    const graph = makeGraph([
      makeAspect('waived-x', { reviewer: 'deterministic' }),
      makeAspect('clean-x', { reviewer: 'deterministic' }),
    ]);
    const fpSignals = new Map<string, AspectFalsePositiveSignal>([
      ['waived-x', fpSignal({ fp: 1, blocks: 2, suppressed: 1, thinData: true, shrunkRate: 0.4 })],
      ['clean-x', fpSignal({ blocks: 0 })],
    ]);
    const { rows } = computeAspectHealth(graph, [], report(), new Map(), noSignals, emptyDrills, fpSignals);
    expect(rows.find((r) => r.aspectId === 'waived-x')!.fpCellValue).toBe('1 (thin data)');
    // No recorded block → em-dash, never a `0` that reads as "checked and clean".
    expect(rows.find((r) => r.aspectId === 'clean-x')!.fpCellValue).toBe('—');
  });

  it('renders a bare count (no thin-data label) once the block sample is large', () => {
    const graph = makeGraph([makeAspect('busy-x', { reviewer: 'deterministic' })]);
    const fpSignals = new Map<string, AspectFalsePositiveSignal>([
      ['busy-x', fpSignal({ fp: 3, blocks: 40, suppressed: 3, thinData: false, shrunkRate: 0.075 })],
    ]);
    const { rows } = computeAspectHealth(graph, [], report(), new Map(), noSignals, emptyDrills, fpSignals);
    expect(rows.find((r) => r.aspectId === 'busy-x')!.fpCellValue).toBe('3');
  });

  it('emits the telemetry-since honesty line and a plain-words per-rule detail — never a bare rate', () => {
    const graph = makeGraph([makeAspect('waived-x', { reviewer: 'deterministic' })]);
    const fpSignals = new Map<string, AspectFalsePositiveSignal>([
      ['waived-x', fpSignal({ fp: 1, blocks: 1, suppressed: 1, thinData: true, shrunkRate: 0.4 })],
    ]);
    const out = formatAspectsHealthOutput(
      computeAspectHealth(graph, [], report(), new Map(), noSignals, emptyDrills, fpSignals, '2026-07-01T00:00:00.000Z'),
    );
    expect(out).toContain('never a gate');
    expect(out).toContain('Local telemetry since 2026-07-01T00:00:00.000Z');
    expect(out).toContain('waived-x: 1 of 1 recorded block later waived by a suppress marker');
    expect(out).toContain('few observations');
    expect(out).not.toContain('beta-binomial'); // method names never leak
  });

  it('distinguishes an overturn from a plain waiver in the detail line', () => {
    const graph = makeGraph([makeAspect('flipped-x', { reviewer: 'deterministic' })]);
    const fpSignals = new Map<string, AspectFalsePositiveSignal>([
      ['flipped-x', fpSignal({ fp: 1, blocks: 1, overturned: 1, thinData: true, shrunkRate: 0.4 })],
    ]);
    const out = formatAspectsHealthOutput(
      computeAspectHealth(graph, [], report(), new Map(), noSignals, emptyDrills, fpSignals, '2026-07-01T00:00:00.000Z'),
    );
    expect(out).toContain('overturned after a suppress range changed');
  });

  it('omits the false-block section entirely when no rule has a recorded block', () => {
    const graph = makeGraph([makeAspect('a1', { reviewer: 'deterministic' })]);
    const out = formatAspectsHealthOutput(computeAspectHealth(graph, [], report()));
    expect(out).not.toContain('False-block signal');
    expect(out).not.toContain('Local telemetry since');
  });

  it('appends the committed-stream caveat when teammate events contribute', () => {
    const graph = makeGraph([makeAspect('waived-x', { reviewer: 'deterministic' })]);
    const fpSignals = new Map<string, AspectFalsePositiveSignal>([
      ['waived-x', fpSignal({ fp: 1, blocks: 1, suppressed: 1, thinData: true, shrunkRate: 0.4 })],
    ]);
    const out = formatAspectsHealthOutput(
      computeAspectHealth(
        graph, [], report(), new Map(), noSignals, emptyDrills, fpSignals,
        '2026-07-01T00:00:00.000Z', 'machines on older CLIs do not contribute',
      ),
    );
    expect(out).toContain('Shared LLM events included (machines on older CLIs do not contribute).');
  });
});

// ── rule-age column (C3 slice 2) ──────────────────────────────────────────

describe('renderRuleAge', () => {
  const BASE = 1_000_000_000; // fixed first-add instant (Unix seconds)
  const at = (days: number): string => renderRuleAge(BASE, (BASE + days * 86400) * 1000);

  it('null timestamp → the word "unknown", never a zero (history unavailable)', () => {
    expect(renderRuleAge(null, (BASE + 999 * 86400) * 1000)).toBe('unknown');
    expect(renderRuleAge(null, (BASE + 999 * 86400) * 1000)).not.toBe('0');
  });

  it('same instant / sub-day age → "<1d"', () => {
    expect(at(0)).toBe('<1d');
    expect(at(0.5)).toBe('<1d');
  });

  it('a future first-add (clock skew) clamps to "<1d", never a negative token', () => {
    expect(renderRuleAge(BASE, (BASE - 5000) * 1000)).toBe('<1d');
  });

  it('days bucket below a month', () => {
    expect(at(1)).toBe('1d');
    expect(at(5)).toBe('5d');
    expect(at(29)).toBe('29d');
  });

  it('months bucket below a year', () => {
    expect(at(30)).toBe('1mo');
    expect(at(45)).toBe('1mo');
    expect(at(200)).toBe('6mo');
  });

  it('years bucket at and beyond a year', () => {
    expect(at(365)).toBe('1y');
    expect(at(800)).toBe('2y');
  });

  it('is stable for a fixed injected now (deterministic — the renderer reads no clock)', () => {
    expect(at(90)).toBe('3mo');
    expect(at(90)).toBe(at(90));
  });
});

describe('resolveRuleAges', () => {
  it('an implies-only bundle (no rule source) has no age → em-dash, needing no git', () => {
    const graph = makeGraph([makeAspect('agg', { implies: ['child'], artifacts: [] })]);
    // projectRoot is irrelevant: a bundle with no rule file never consults git.
    const ages = resolveRuleAges(graph, '/nonexistent-yg-resolve-path', 1_700_000_000_000);
    expect(ages.get('agg')).toBe('—');
  });

  it('a rule-bearing aspect with no readable history → "unknown", never a zero', () => {
    const graph = makeGraph([
      makeAspect('llm-x', { artifacts: [{ filename: 'content.md', content: 'rule' }] }),
      makeAspect('det-x', {
        reviewer: 'deterministic',
        artifacts: [{ filename: 'check.mjs', content: 'export function check(){return [];}' }],
      }),
    ]);
    // projectRoot does not exist → the git subprocess fails → an honest "unknown".
    const ages = resolveRuleAges(graph, '/nonexistent-yg-resolve-path', 1_700_000_000_000);
    expect(ages.get('llm-x')).toBe('unknown');
    expect(ages.get('det-x')).toBe('unknown');
    expect(ages.get('llm-x')).not.toBe('0');
  });
});
