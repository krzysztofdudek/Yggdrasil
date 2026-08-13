import { describe, it, expect } from 'vitest';
import {
  impliesClosure,
  buildReverseTargetIndex,
  collectFlowParticipants,
  computeBurnSet,
  progressivePairKey,
  extractConfigVocabulary,
  configVocabularyChanged,
  hashGitBlob,
  gitObjectDigest,
  forceInScopeOnByteMismatch,
  type BurnInput,
  type BurnSet,
} from '../../../src/core/progressive-scope.js';
import { touchedReferencesFile } from '../../../src/core/graph/impact-graph.js';
import type { ExpectedPair } from '../../../src/core/pairs.js';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';

// --- Helpers (mirrors tests/unit/core/effective-aspects.test.ts's construction style) ---

function makeNode(
  path: string,
  overrides: Partial<GraphNode> & { meta?: Partial<GraphNode['meta']> } = {},
): GraphNode {
  return {
    path,
    meta: { name: path, type: 'library', ...overrides.meta },
    children: [],
    parent: overrides.parent ?? null,
    ...overrides,
  } as GraphNode;
}

function makeGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(),
    aspects: [],
    flows: [],
    rootPath: '/tmp',
    ...overrides,
  } as Graph;
}

function makeAspect(id: string, overrides: Partial<AspectDef> = {}): AspectDef {
  return { name: id, id, reviewer: { type: 'llm' as const }, artifacts: [], ...overrides };
}

// --- impliesClosure ---

describe('impliesClosure', () => {
  it('walks an implies chain a -> b -> c and contains all three', () => {
    const graph = makeGraph({
      aspects: [
        makeAspect('a', { implies: ['b'] }),
        makeAspect('b', { implies: ['c'] }),
        makeAspect('c'),
      ],
    });
    const result = impliesClosure('a', graph);
    expect(result).toEqual(new Set(['a', 'b', 'c']));
  });

  it('terminates on a cycle instead of looping forever', () => {
    const graph = makeGraph({
      aspects: [
        makeAspect('a', { implies: ['b'] }),
        makeAspect('b', { implies: ['c'] }),
        makeAspect('c', { implies: ['a'] }), // closes the cycle back to a
      ],
    });
    const result = impliesClosure('a', graph);
    expect(result).toEqual(new Set(['a', 'b', 'c']));
  });

  it('is unconditional: ignores when/status entirely (no node/graph filtering applies)', () => {
    // A draft-status implier still propagates for this structural closure —
    // unlike computeEffectiveAspectStatuses/expandImpliesFiltered, which would
    // stop a draft aspect from propagating its implied aspects.
    const graph = makeGraph({
      aspects: [
        makeAspect('a', { implies: ['b'], status: 'draft' }),
        makeAspect('b'),
      ],
    });
    const result = impliesClosure('a', graph);
    expect(result).toEqual(new Set(['a', 'b']));
  });

  it('returns just the seed id when it implies nothing', () => {
    const graph = makeGraph({ aspects: [makeAspect('solo')] });
    expect(impliesClosure('solo', graph)).toEqual(new Set(['solo']));
  });

  it('returns just the seed id when the aspect id is unknown to the graph', () => {
    const graph = makeGraph({ aspects: [] });
    expect(impliesClosure('ghost', graph)).toEqual(new Set(['ghost']));
  });
});

// --- buildReverseTargetIndex ---

describe('buildReverseTargetIndex', () => {
  it('maps a target to every node with ANY relation to it — port-consumer and plain uses alike', () => {
    const target = makeNode('payments', { meta: { name: 'payments', type: 'library' } });
    const consumer = makeNode('orders', {
      meta: {
        name: 'orders',
        type: 'library',
        relations: [{ target: 'payments', type: 'calls', consumes: ['charge'] }],
      },
    });
    const plainUser = makeNode('reports', {
      meta: {
        name: 'reports',
        type: 'library',
        relations: [{ target: 'payments', type: 'uses' }],
      },
    });
    const graph = makeGraph({
      nodes: new Map([
        ['payments', target],
        ['orders', consumer],
        ['reports', plainUser],
      ]),
    });
    const index = buildReverseTargetIndex(graph);
    expect(index.get('payments')).toEqual(['orders', 'reports']);
  });

  it('a node with no relations contributes nothing to the index', () => {
    const lonely = makeNode('lonely');
    const graph = makeGraph({ nodes: new Map([['lonely', lonely]]) });
    const index = buildReverseTargetIndex(graph);
    expect(index.size).toBe(0);
  });

  it('a target with no incoming relations is simply absent from the index', () => {
    const target = makeNode('target');
    const graph = makeGraph({ nodes: new Map([['target', target]]) });
    const index = buildReverseTargetIndex(graph);
    expect(index.has('target')).toBe(false);
  });
});

// --- collectFlowParticipants ---

describe('collectFlowParticipants', () => {
  it('includes a declared participant and its descendants', () => {
    const parent = makeNode('mod', { meta: { name: 'mod', type: 'library' } });
    const child = makeNode('mod/svc', { parent, meta: { name: 'svc', type: 'library' } });
    parent.children = [child];
    const graph = makeGraph({
      nodes: new Map([
        ['mod', parent],
        ['mod/svc', child],
      ]),
      flows: [{ path: 'checkout', name: 'Checkout', nodes: ['mod'] }],
    });
    const result = collectFlowParticipants(graph, 'Checkout');
    expect(result).toEqual(new Set(['mod', 'mod/svc']));
  });

  it('matches a flow by its path when the name does not match', () => {
    const node = makeNode('svc');
    const graph = makeGraph({
      nodes: new Map([['svc', node]]),
      flows: [{ path: 'checkout-flow', name: 'Checkout', nodes: ['svc'] }],
    });
    const result = collectFlowParticipants(graph, 'checkout-flow');
    expect(result).toEqual(new Set(['svc']));
  });

  it('returns an empty set for an unknown flow name', () => {
    const graph = makeGraph({ flows: [] });
    expect(collectFlowParticipants(graph, 'nope')).toEqual(new Set());
  });

  it('skips a declared node path that is not in the graph (dangling reference)', () => {
    const graph = makeGraph({
      nodes: new Map(),
      flows: [{ path: 'checkout', name: 'Checkout', nodes: ['ghost'] }],
    });
    expect(collectFlowParticipants(graph, 'Checkout')).toEqual(new Set());
  });
});

// =============================================================================
// computeBurnSet — the burn table
// =============================================================================

// --- Burn fixture: one small graph exercised by every burn-table row ---
//
//   top            (src/top)                       ancestor of top/mid
//     top/mid      (src/top/mid)                   the node most rows aim at
//       top/mid/leaf (src/top/mid/leaf)            descendant of top/mid
//   other          (src/other)   uses -> top/mid   reverse-relation source
//   globby         (src/globby/**/*.ts)            glob mapping (deleted-file owner)
//   lonely         (src/lonely)                    unrelated to top/mid
//
// aspects: x (implies z), z, y (references docs/table.md)
// flow f: participants [top/mid], aspects [y]

function makeBurnGraph(): Graph {
  const top = makeNode('top', { meta: { name: 'top', type: 'library', mapping: ['src/top'] } });
  const mid = makeNode('top/mid', {
    parent: top,
    meta: { name: 'mid', type: 'library', mapping: ['src/top/mid'] },
  });
  const leaf = makeNode('top/mid/leaf', {
    parent: mid,
    meta: { name: 'leaf', type: 'library', mapping: ['src/top/mid/leaf'] },
  });
  top.children = [mid];
  mid.children = [leaf];
  const other = makeNode('other', {
    meta: {
      name: 'other',
      type: 'library',
      mapping: ['src/other'],
      relations: [{ target: 'top/mid', type: 'uses' }],
    },
  });
  const globby = makeNode('globby', {
    meta: { name: 'globby', type: 'library', mapping: ['src/globby/**/*.ts'] },
  });
  const lonely = makeNode('lonely', {
    meta: { name: 'lonely', type: 'library', mapping: ['src/lonely'] },
  });
  return makeGraph({
    nodes: new Map([
      ['top', top],
      ['top/mid', mid],
      ['top/mid/leaf', leaf],
      ['other', other],
      ['globby', globby],
      ['lonely', lonely],
    ]),
    aspects: [
      makeAspect('x', { implies: ['z'], reviewer: { type: 'deterministic' } }),
      makeAspect('z', { reviewer: { type: 'deterministic' } }),
      makeAspect('y', {
        reviewer: { type: 'deterministic' },
        references: [{ path: 'docs/table.md' }],
      }),
    ],
    flows: [{ path: 'f', name: 'Flow F', nodes: ['top/mid'], aspects: ['y'] }],
  });
}

function makePair(
  aspectId: string,
  nodePath: string,
  subjectFiles: string[],
  overrides: Partial<ExpectedPair> = {},
): ExpectedPair {
  return {
    aspectId,
    kind: 'deterministic',
    unitKey: `node:${nodePath}`,
    nodePath,
    status: 'enforced',
    subjectFiles,
    ...overrides,
  };
}

function makeBurnPairs(): ExpectedPair[] {
  return [
    makePair('x', 'top', ['src/top/f.ts']),
    makePair('x', 'top/mid', ['src/top/mid/f.ts']),
    makePair('x', 'top/mid/leaf', ['src/top/mid/leaf/f.ts']),
    makePair('x', 'other', ['src/other/f.ts']),
    makePair('x', 'globby', ['src/globby/live.ts']),
    makePair('x', 'lonely', ['src/lonely/f.ts']),
    makePair('y', 'top/mid', ['src/top/mid/f.ts']),
    makePair('z', 'lonely', ['src/lonely/f.ts']),
  ];
}

/** Every pair WARM with zero observations — the "stored entry, observed nothing"
 *  encoding, so the cold fail-closed path never fires except where a test wants it. */
function warmAll(
  pairs: ExpectedPair[],
  overrides: Record<string, Array<[string, string]>> = {},
): Map<string, Array<[string, string]>> {
  const m = new Map<string, Array<[string, string]>>();
  for (const p of pairs) {
    const k = progressivePairKey(p.aspectId, p.unitKey);
    m.set(k, overrides[k] ?? []);
  }
  return m;
}

function burn(
  touched: string[],
  opts: {
    graph?: Graph;
    pairs?: ExpectedPair[];
    lists?: Map<string, Array<[string, string]>>;
    baseVerdictPairKeys?: Set<string>;
    configVocabularyChanged?: boolean;
  } = {},
): BurnSet {
  const graph = opts.graph ?? makeBurnGraph();
  const pairs = opts.pairs ?? makeBurnPairs();
  const input: BurnInput = {
    touched: new Set(touched),
    graph,
    pairs,
    touchedListsByPairKey: opts.lists ?? warmAll(pairs),
    baseVerdictPairKeys: opts.baseVerdictPairKeys ?? new Set(),
    configVocabularyChanged: opts.configVocabularyChanged ?? false,
  };
  return computeBurnSet(input);
}

const K = progressivePairKey;

// --- Row: a source file inside a pair's subject set ---

describe('computeBurnSet — source-file row', () => {
  it('burns every pair whose subjectFiles contain the changed file, and marks its owner', () => {
    const result = burn(['src/lonely/f.ts']);
    expect(result.pairKeys).toEqual(new Set([K('x', 'node:lonely'), K('z', 'node:lonely')]));
    expect(result.nodePaths).toEqual(new Set(['lonely']));
    expect(result.files).toEqual(new Set(['src/lonely/f.ts']));
    expect(result.changedInputCount).toBe(1);
    expect(result.global).toBe(false);
    expect(result.logOnlyNodePaths).toEqual(new Set());
  });

  it('resolves a DELETED path through the glob mapping with no filesystem access', () => {
    // src/globby/deep/gone.ts is in NO pair's subjectFiles (it no longer exists),
    // so only the pattern-only owner index can attribute it.
    const result = burn(['src/globby/deep/gone.ts']);
    expect(result.pairKeys).toEqual(new Set([K('x', 'node:globby')]));
    expect(result.nodePaths).toEqual(new Set(['globby']));
  });

  it('a changed file owned by nobody and in no subject set burns nothing pair-wise', () => {
    const result = burn(['src/nowhere/orphan.ts']);
    expect(result.pairKeys).toEqual(new Set());
    expect(result.nodePaths).toEqual(new Set());
    expect(result.files).toEqual(new Set(['src/nowhere/orphan.ts']));
  });

  it('treats both sides of a rename as ordinary changed files', () => {
    const result = burn(['src/lonely/f.ts', 'src/globby/deep/moved.ts']);
    expect(result.pairKeys).toEqual(
      new Set([K('x', 'node:lonely'), K('z', 'node:lonely'), K('x', 'node:globby')]),
    );
    expect(result.changedInputCount).toBe(2);
  });
});

// --- Row: an aspect's own directory ---

describe('computeBurnSet — aspect row', () => {
  it('burns every pair of the aspect PLUS its implies closure', () => {
    const result = burn(['.yggdrasil/aspects/x/content.md']);
    expect(result.pairKeys).toEqual(
      new Set([
        K('x', 'node:top'),
        K('x', 'node:top/mid'),
        K('x', 'node:top/mid/leaf'),
        K('x', 'node:other'),
        K('x', 'node:globby'),
        K('x', 'node:lonely'),
        K('z', 'node:lonely'), // x implies z
      ]),
    );
    // y is untouched by x's closure.
    expect(result.pairKeys.has(K('y', 'node:top/mid'))).toBe(false);
  });

  it('reads the aspect id from the first path segment, so a nested rule file still burns', () => {
    const result = burn(['.yggdrasil/aspects/y/drills/case-1.md']);
    expect(result.pairKeys).toEqual(new Set([K('y', 'node:top/mid')]));
  });

  it('a file in an aspect references: list burns every pair of that aspect', () => {
    const result = burn(['docs/table.md']);
    expect(result.pairKeys).toEqual(new Set([K('y', 'node:top/mid')]));
  });
});

// --- Row: a node's own model directory ---

describe('computeBurnSet — model row', () => {
  it('burns the node, its descendants, its ancestor chain, and every reverse-relation source', () => {
    const result = burn(['.yggdrasil/model/top/mid/yg-node.yaml']);
    expect(result.pairKeys).toEqual(
      new Set([
        K('x', 'node:top/mid'), // the node itself
        K('y', 'node:top/mid'),
        K('x', 'node:top/mid/leaf'), // descendant
        K('x', 'node:top'), // ancestor chain
        K('x', 'node:other'), // reverse-relation source (uses -> top/mid)
      ]),
    );
    expect(result.pairKeys.has(K('x', 'node:lonely'))).toBe(false);
    expect(result.pairKeys.has(K('x', 'node:globby'))).toBe(false);
    // Node-keyed issues reach EXACTLY the same nodes the pairs did. They must:
    // some of what this row reaches produces node-keyed findings and nothing
    // else — editing one node's declaration can make another node's existing
    // import an undeclared cross-node edge, and that finding carries only the
    // second node's path. Burning the pairs while leaving the node out let such
    // a finding be re-coded as inherited debt.
    expect(result.nodePaths).toEqual(new Set(['top/mid', 'top/mid/leaf', 'top', 'other']));
    expect(result.logOnlyNodePaths).toEqual(new Set());
  });

  it('puts a reverse-relation source in the NODE set, not only its pairs (C1)', () => {
    // The reproduced under-burn: only `top/mid`'s declaration is touched, but
    // `other` declares a relation to it, so `other`'s own imports are what a
    // relation-conformance finding would land on. That finding names `other`
    // and nothing else.
    const result = burn(['.yggdrasil/model/top/mid/yg-node.yaml']);
    expect(result.nodePaths.has('other')).toBe(true);
  });

  it('puts a reverse-relation source of a DELETED node directory in the node set too', () => {
    const graph = makeBurnGraph();
    const other = graph.nodes.get('other')!;
    other.meta.relations = [{ target: 'top/mid/gone', type: 'uses' }];
    const result = burn(['.yggdrasil/model/top/mid/gone/yg-node.yaml'], { graph });
    expect(result.nodePaths.has('other')).toBe(true);
  });

  it('resolves a non-node file inside a node directory to the nearest enclosing node', () => {
    const result = burn(['.yggdrasil/model/top/mid/notes/scratch.md']);
    // The nearest enclosing node is `top/mid`, and the row reaches from there
    // exactly as it does for the declaration file itself.
    expect(result.nodePaths).toEqual(new Set(['top/mid', 'top/mid/leaf', 'top', 'other']));
    expect(result.pairKeys.has(K('x', 'node:top/mid'))).toBe(true);
  });

  it('still burns the reverse-relation sources of a node directory that no longer exists', () => {
    // top/mid/gone was deleted; nodes still declaring a relation to it must re-gate.
    const graph = makeBurnGraph();
    const other = graph.nodes.get('other')!;
    other.meta.relations = [{ target: 'top/mid/gone', type: 'uses' }];
    const result = burn(['.yggdrasil/model/top/mid/gone/yg-node.yaml'], { graph });
    expect(result.pairKeys.has(K('x', 'node:other'))).toBe(true);
  });
});

// --- Row: log.md carve-out ---

describe('computeBurnSet — log.md carve-out', () => {
  it('a log.md change burns ONLY the node log channel — no pairs, no descendants, no ancestors', () => {
    const result = burn(['.yggdrasil/model/top/mid/log.md']);
    expect(result.logOnlyNodePaths).toEqual(new Set(['top/mid']));
    expect(result.pairKeys).toEqual(new Set());
    expect(result.nodePaths).toEqual(new Set());
    expect(result.files).toEqual(new Set(['.yggdrasil/model/top/mid/log.md']));
    expect(result.changedInputCount).toBe(1);
  });

  it('the root node log.md does not burn the whole model', () => {
    const result = burn(['.yggdrasil/model/top/log.md']);
    expect(result.logOnlyNodePaths).toEqual(new Set(['top']));
    expect(result.pairKeys).toEqual(new Set());
  });

  it('a log.md whose directory is not a node falls back to the full row (fail closed)', () => {
    const result = burn(['.yggdrasil/model/top/mid/notes/log.md']);
    expect(result.logOnlyNodePaths).toEqual(new Set());
    expect(result.nodePaths).toEqual(new Set(['top/mid', 'top/mid/leaf', 'top', 'other']));
    expect(result.pairKeys.has(K('x', 'node:top/mid'))).toBe(true);
  });

  it('a REAL node log.md still burns no node — the carve-out survives the wider node set', () => {
    // The completeness fix above widens the model row only. A log entry on a
    // shallow node must still re-gate that node's log channel and nothing else,
    // which is the whole reason the carve-out exists.
    const result = burn(['.yggdrasil/model/top/log.md']);
    expect(result.nodePaths).toEqual(new Set());
    expect(result.logOnlyNodePaths).toEqual(new Set(['top']));
  });

  it('a sibling yg-node.yaml change in the same commit still burns the full row', () => {
    const result = burn([
      '.yggdrasil/model/top/mid/log.md',
      '.yggdrasil/model/top/mid/yg-node.yaml',
    ]);
    expect(result.logOnlyNodePaths).toEqual(new Set(['top/mid']));
    expect(result.pairKeys.has(K('x', 'node:top/mid'))).toBe(true);
    expect(result.pairKeys.has(K('x', 'node:top'))).toBe(true);
  });
});

// --- Row: flows ---

describe('computeBurnSet — flow row', () => {
  it("burns the flow's aspects on every participant, descendants included", () => {
    const result = burn(['.yggdrasil/flows/f/yg-flow.yaml']);
    // participants = top/mid + top/mid/leaf; only aspect y is on the flow, and
    // only top/mid carries a y pair.
    expect(result.pairKeys).toEqual(new Set([K('y', 'node:top/mid')]));
    expect(result.pairKeys.has(K('x', 'node:top/mid'))).toBe(false);
  });

  it("follows the implies closure of the flow's aspects", () => {
    const graph = makeBurnGraph();
    graph.flows = [{ path: 'f', name: 'Flow F', nodes: ['top/mid'], aspects: ['x'] }];
    const result = burn(['.yggdrasil/flows/f/yg-flow.yaml'], { graph });
    expect(result.pairKeys).toEqual(
      new Set([K('x', 'node:top/mid'), K('x', 'node:top/mid/leaf')]),
    );
  });

  it('a flow with no aspects burns nothing pair-wise', () => {
    const graph = makeBurnGraph();
    graph.flows = [{ path: 'f', name: 'Flow F', nodes: ['top/mid'] }];
    expect(burn(['.yggdrasil/flows/f/yg-flow.yaml'], { graph }).pairKeys).toEqual(new Set());
  });

  it('an unknown flow directory burns nothing pair-wise', () => {
    expect(burn(['.yggdrasil/flows/ghost/yg-flow.yaml']).pairKeys).toEqual(new Set());
  });
});

// --- Row: architecture and config ---

describe('computeBurnSet — architecture and config rows', () => {
  it('an architecture change is global', () => {
    const result = burn(['.yggdrasil/yg-architecture.yaml']);
    expect(result.global).toBe(true);
  });

  it('a config change is global ONLY when the vocabulary changed', () => {
    expect(burn(['.yggdrasil/yg-config.yaml'], { configVocabularyChanged: true }).global).toBe(true);
    const unchanged = burn(['.yggdrasil/yg-config.yaml'], { configVocabularyChanged: false });
    expect(unchanged.global).toBe(false);
    expect(unchanged.pairKeys).toEqual(new Set());
    expect(unchanged.files).toEqual(new Set(['.yggdrasil/yg-config.yaml']));
  });

  it('configVocabularyChanged never makes an unrelated run global', () => {
    expect(burn(['src/lonely/f.ts'], { configVocabularyChanged: true }).global).toBe(false);
  });
});

// --- Row: lock files are outputs ---

describe('computeBurnSet — lock files', () => {
  it('ignores every lock file entirely — not burned, not counted', () => {
    const result = burn([
      '.yggdrasil/yg-lock.json',
      '.yggdrasil/yg-lock.nondeterministic.json',
      '.yggdrasil/yg-lock.logs.json',
      '.yggdrasil/.yg-lock.deterministic.json',
    ]);
    expect(result.files).toEqual(new Set());
    expect(result.changedInputCount).toBe(0);
    expect(result.pairKeys).toEqual(new Set());
    expect(result.global).toBe(false);
  });
});

// --- Row: stored observation lists ---

describe('computeBurnSet — stored observation row', () => {
  it('burns a pair whose stored list read: the changed file', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs, {
      [K('x', 'node:lonely')]: [['read:src/elsewhere/util.ts', 'h']],
    });
    const result = burn(['src/elsewhere/util.ts'], { pairs, lists });
    expect(result.pairKeys).toEqual(new Set([K('x', 'node:lonely')]));
  });

  it('burns a pair whose stored list exists: the changed file', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs, {
      [K('x', 'node:lonely')]: [['exists:src/elsewhere/util.ts', 'h']],
    });
    expect(burn(['src/elsewhere/util.ts'], { pairs, lists }).pairKeys).toEqual(
      new Set([K('x', 'node:lonely')]),
    );
  });

  it('burns a pair whose stored list listed the changed file’s directory', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs, {
      [K('x', 'node:lonely')]: [['list:src/elsewhere', 'h']],
    });
    expect(burn(['src/elsewhere/added.ts'], { pairs, lists }).pairKeys).toEqual(
      new Set([K('x', 'node:lonely')]),
    );
  });

  it('burns a pair whose stored list observed a node through the graph', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs, {
      [K('x', 'node:lonely')]: [['graph:globby', 'h']],
      [K('z', 'node:lonely')]: [['graph-children:globby', 'h']],
    });
    const result = burn(['.yggdrasil/model/globby/yg-node.yaml'], { pairs, lists });
    expect(result.pairKeys.has(K('x', 'node:lonely'))).toBe(true);
    expect(result.pairKeys.has(K('z', 'node:lonely'))).toBe(true);
  });

  it('burns a pair whose stored list observed a flow', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs, { [K('x', 'node:lonely')]: [['graph-flow:f', 'h']] });
    expect(burn(['.yggdrasil/flows/f/yg-flow.yaml'], { pairs, lists }).pairKeys.has(
      K('x', 'node:lonely'),
    )).toBe(true);
  });

  it('NEVER matches graph-bytype: to a file — the accepted lazy-attribution semantic', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs, { [K('x', 'node:lonely')]: [['graph-bytype:library', 'h']] });
    const result = burn(['.yggdrasil/model/globby/yg-node.yaml'], { pairs, lists });
    expect(result.pairKeys.has(K('x', 'node:lonely'))).toBe(false);
  });

  it('agrees with touchedReferencesFile on every observation-key kind it proposes', () => {
    // The inverted index is the DUAL of the matcher; this pins the two together
    // so an index probe can never admit a key the matcher would reject.
    const cases: Array<[string, string]> = [
      ['read:src/a/b.ts', 'src/a/b.ts'],
      ['exists:src/a/b.ts', 'src/a/b.ts'],
      ['list:src/a', 'src/a/b.ts'],
      ['list:.', 'AGENTS.md'],
      ['graph:top/mid', '.yggdrasil/model/top/mid/yg-node.yaml'],
      ['graph-children:top/mid', '.yggdrasil/model/top/mid/yg-node.yaml'],
      ['graph-flow:f', '.yggdrasil/flows/f/yg-flow.yaml'],
    ];
    for (const [key, file] of cases) {
      expect(touchedReferencesFile([[key, 'h']], file)).toBe(true);
      const pairs = makeBurnPairs();
      const lists = warmAll(pairs, { [K('x', 'node:lonely')]: [[key, 'h']] });
      expect(burn([file], { pairs, lists }).pairKeys.has(K('x', 'node:lonely'))).toBe(true);
    }
  });
});

// --- Row: cold deterministic cache fails closed ---

describe('computeBurnSet — cold pairs fail closed', () => {
  it('burns a cold deterministic pair when a changed file is inside its allowed reads', () => {
    const pairs = makeBurnPairs();
    // No stored entry at all for x@top/mid — a cold deterministic cache.
    const lists = warmAll(pairs);
    lists.delete(K('x', 'node:top/mid'));
    // src/top/mid/leaf/other.ts is in NO subject set, but it IS inside top/mid's
    // allowed reads (a descendant's mapping).
    const result = burn(['src/top/mid/leaf/other.ts'], { pairs, lists });
    expect(result.pairKeys.has(K('x', 'node:top/mid'))).toBe(true);
    // The WARM sibling on the same node, with an empty observation list, is not burned.
    expect(result.pairKeys.has(K('y', 'node:top/mid'))).toBe(false);
  });

  it('does NOT burn a cold pair when no changed file is inside its allowed reads', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs);
    lists.delete(K('x', 'node:top/mid'));
    const result = burn(['src/nowhere/orphan.ts'], { pairs, lists });
    expect(result.pairKeys.has(K('x', 'node:top/mid'))).toBe(false);
  });

  it('treats a stored entry with an EMPTY observation list as warm, never cold', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs); // every key present, every list empty
    const result = burn(['src/top/mid/leaf/other.ts'], { pairs, lists });
    expect(result.pairKeys.has(K('x', 'node:top/mid'))).toBe(false);
  });

  it('applies the cold estimate to a companion-backed LLM pair but not to a plain one', () => {
    const graph = makeBurnGraph();
    graph.aspects = [
      makeAspect('x', { reviewer: { type: 'llm' }, hasCompanion: true }),
      makeAspect('y', { reviewer: { type: 'llm' } }),
      makeAspect('z', { reviewer: { type: 'deterministic' } }),
    ];
    const pairs = [
      makePair('x', 'top/mid', ['src/top/mid/f.ts'], { kind: 'llm' }),
      makePair('y', 'top/mid', ['src/top/mid/f.ts'], { kind: 'llm' }),
    ];
    const lists = new Map<string, Array<[string, string]>>(); // everything cold
    const result = burn(['src/top/mid/leaf/other.ts'], { graph, pairs, lists });
    expect(result.pairKeys.has(K('x', 'node:top/mid'))).toBe(true);
    expect(result.pairKeys.has(K('y', 'node:top/mid'))).toBe(false);
  });

  it('skips the cold estimate for a nodeless (type-covered) pair', () => {
    const pairs = [
      {
        aspectId: 'x',
        kind: 'deterministic' as const,
        unitKey: 'file:src/top/mid/typed.ts',
        status: 'enforced' as const,
        subjectFiles: ['src/top/mid/typed.ts'],
      },
    ];
    const lists = new Map<string, Array<[string, string]>>();
    const result = burn(['src/top/mid/leaf/other.ts'], { pairs, lists });
    expect(result.pairKeys).toEqual(new Set());
  });
});

// --- Row: singletons ---

describe('computeBurnSet — singleton inputs', () => {
  it('counts a repo-root singleton like AGENTS.md without burning any pair', () => {
    const result = burn(['AGENTS.md']);
    expect(result.pairKeys).toEqual(new Set());
    expect(result.nodePaths).toEqual(new Set());
    expect(result.files).toEqual(new Set(['AGENTS.md']));
    expect(result.changedInputCount).toBe(1);
  });

  it('counts a graph singleton like the incident ledger', () => {
    const result = burn(['.yggdrasil/incidents.md']);
    expect(result.pairKeys).toEqual(new Set());
    expect(result.files).toEqual(new Set(['.yggdrasil/incidents.md']));
  });

  it('reports an empty burn for an empty touched set', () => {
    const result = burn([]);
    expect(result).toEqual({
      global: false,
      pairKeys: new Set(),
      nodePaths: new Set(),
      files: new Set(),
      logOnlyNodePaths: new Set(),
      changedInputCount: 0,
    });
  });
});

// --- Performance shape ---
//
// Measured by COUNTING work, never by wall-clock time: an elapsed-time budget
// would be a proxy that varies with machine and CI load, while the property
// that actually matters — "each pair is visited a fixed number of times, no
// matter how many files changed" — is exactly observable and identical on
// every run. A per-file scan over all pairs would multiply both counts below
// by the size of the changed set.

/** Replaces `subjectFiles` with a counting accessor — one tick per read. */
function countingSubjectReads(pairs: ExpectedPair[]): {
  pairs: ExpectedPair[];
  reads: () => number;
} {
  let reads = 0;
  const instrumented = pairs.map((pair) => {
    const subjects = pair.subjectFiles;
    const clone = { ...pair };
    Object.defineProperty(clone, 'subjectFiles', {
      get() {
        reads += 1;
        return subjects;
      },
      enumerable: true,
      configurable: true,
    });
    return clone;
  });
  return { pairs: instrumented, reads: () => reads };
}

/** A real Map that records how many times a node was looked up by path. */
class CountingNodeMap extends Map<string, GraphNode> {
  gets = 0;
  override get(key: string): GraphNode | undefined {
    this.gets += 1;
    return super.get(key);
  }
}

describe('computeBurnSet — performance shape', () => {
  it('visits each pair exactly once regardless of how many files changed', () => {
    const nodes = new Map<string, GraphNode>();
    const raw: ExpectedPair[] = [];
    const lists = new Map<string, Array<[string, string]>>();
    for (let n = 0; n < 400; n++) {
      const nodePath = `mod/n${n}`;
      nodes.set(
        nodePath,
        makeNode(nodePath, {
          meta: { name: `n${n}`, type: 'library', mapping: [`src/n${n}`] },
        }),
      );
      for (let a = 0; a < 100; a++) {
        const p = makePair(`asp${a}`, nodePath, [
          `src/n${n}/a.ts`,
          `src/n${n}/b.ts`,
          `src/n${n}/c.ts`,
        ]);
        raw.push(p);
        lists.set(progressivePairKey(p.aspectId, p.unitKey), [[`read:src/shared/${a}.ts`, 'h']]);
      }
    }
    expect(raw.length).toBe(40_000);
    const { pairs, reads } = countingSubjectReads(raw);
    const graph = makeGraph({ nodes });
    const touched = new Set<string>();
    for (let i = 0; i < 3000; i++) touched.add(`src/n${i % 400}/${i}.ts`);
    touched.add('src/n7/a.ts');

    const result = computeBurnSet({
      touched,
      graph,
      pairs,
      touchedListsByPairKey: lists,
      baseVerdictPairKeys: new Set(),
      configVocabularyChanged: false,
    });

    // One subject-set read per pair — the single index-building pass. A scan of
    // all pairs per changed file would read 40 000 x 3 001 = 120M times.
    expect(reads()).toBe(40_000);
    // Correctness on the same run: 3000 changed files land in 400 owning
    // components, so every pair of every component is accountable.
    expect(result.pairKeys.size).toBe(40_000);
    expect(result.changedInputCount).toBe(3001);
  });

  it('computes the cold allowed-reads estimate once per component, not per pair or per file', () => {
    const nodes = new CountingNodeMap();
    const pairs: ExpectedPair[] = [];
    for (let n = 0; n < 200; n++) {
      const nodePath = `mod/n${n}`;
      nodes.set(
        nodePath,
        makeNode(nodePath, {
          meta: { name: `n${n}`, type: 'library', mapping: [`src/n${n}`] },
        }),
      );
      for (let a = 0; a < 20; a++) pairs.push(makePair(`asp${a}`, nodePath, [`src/n${n}/a.ts`]));
    }
    const graph = makeGraph({ nodes });
    const touched = new Set<string>();
    for (let i = 0; i < 2000; i++) touched.add(`src/unowned/${i}.ts`);

    const result = computeBurnSet({
      touched,
      graph,
      pairs,
      touchedListsByPairKey: new Map(), // every pair cold
      baseVerdictPairKeys: new Set(),
      configVocabularyChanged: false,
    });

    expect(result.pairKeys.size).toBe(0); // nothing changed inside any allowed-reads set
    // The estimate resolves the component once — 200 lookups for 4000 cold pairs
    // and 2000 changed files, not 4000 and not 400 000.
    expect(nodes.gets).toBe(200);
  });
});

// =============================================================================
// extractConfigVocabulary / configVocabularyChanged
// =============================================================================

const BASE_CONFIG = `version: "5"
parallel: 4
debug: false
coverage:
  required:
    - /
  excluded:
    - vendor/
  type_level: true
reviewer:
  default: fast
  tiers:
    fast:
      provider: claude-code
      model: sonnet
      max_prompt_chars: 50000
    deep:
      provider: claude-code
      model: opus
`;

describe('extractConfigVocabulary', () => {
  it('extracts the version, the coverage block, and the sorted tier names', () => {
    const v = extractConfigVocabulary(BASE_CONFIG);
    expect(v.version).toBe('5');
    expect(v.coverage).toEqual({ required: ['/'], excluded: ['vendor/'], type_level: true });
    expect(v.tierNames).toEqual(['deep', 'fast']);
  });

  it('returns an empty vocabulary for a document with none of the three keys', () => {
    const v = extractConfigVocabulary('debug: true\n');
    expect(v.version).toBeUndefined();
    expect(v.coverage).toBeUndefined();
    expect(v.tierNames).toEqual([]);
  });

  it('returns an empty vocabulary for an empty or non-mapping document', () => {
    expect(extractConfigVocabulary('').tierNames).toEqual([]);
    expect(extractConfigVocabulary('- a\n- b\n').tierNames).toEqual([]);
  });

  it('ignores a non-string version, matching the config parser', () => {
    expect(extractConfigVocabulary('version: 5\n').version).toBeUndefined();
  });
});

describe('configVocabularyChanged', () => {
  it('is false when the file is byte-identical', () => {
    expect(configVocabularyChanged(BASE_CONFIG, BASE_CONFIG)).toBe(false);
  });

  it('is false for churn outside the vocabulary (prompt chars, parallelism, debug)', () => {
    const head = BASE_CONFIG.replace('parallel: 4', 'parallel: 8')
      .replace('debug: false', 'debug: true')
      .replace('max_prompt_chars: 50000', 'max_prompt_chars: 90000')
      .replace('model: opus', 'model: opus-latest');
    expect(configVocabularyChanged(BASE_CONFIG, head)).toBe(false);
  });

  it('is false when only key ORDER or formatting differs', () => {
    const head = `reviewer:
  tiers:
    deep: {provider: claude-code, model: opus}
    fast: {provider: claude-code, model: sonnet, max_prompt_chars: 50000}
  default: fast
coverage:
  type_level: true
  excluded: [vendor/]
  required: ["/"]
version: "5"
parallel: 4
debug: false
`;
    expect(configVocabularyChanged(BASE_CONFIG, head)).toBe(false);
  });

  it('is true when the version changes', () => {
    expect(configVocabularyChanged(BASE_CONFIG, BASE_CONFIG.replace('version: "5"', 'version: "6"'))).toBe(true);
  });

  it('is true when the coverage block changes', () => {
    expect(configVocabularyChanged(BASE_CONFIG, BASE_CONFIG.replace('- vendor/', '- third_party/'))).toBe(true);
  });

  it('is true when a tier is added or removed', () => {
    const removed = BASE_CONFIG.replace('    deep:\n      provider: claude-code\n      model: opus\n', '');
    expect(configVocabularyChanged(BASE_CONFIG, removed)).toBe(true);
    expect(configVocabularyChanged(removed, BASE_CONFIG)).toBe(true);
  });

  it('is true when the file did not exist at the merge base', () => {
    expect(configVocabularyChanged(null, BASE_CONFIG)).toBe(true);
  });

  it('is true when either side cannot be parsed (fail closed)', () => {
    const broken = 'reviewer:\n  tiers:\n   - [unclosed\n';
    expect(configVocabularyChanged(BASE_CONFIG, broken)).toBe(true);
    expect(configVocabularyChanged(broken, BASE_CONFIG)).toBe(true);
  });
});

// --- Defensive edges (paths git can produce that no burn row should crash on) ---

describe('computeBurnSet — defensive edges', () => {
  it('a file directly under model/ belongs to no node and burns nothing', () => {
    const result = burn(['.yggdrasil/model/README.md']);
    expect(result.pairKeys).toEqual(new Set());
    expect(result.nodePaths).toEqual(new Set());
    expect(result.files).toEqual(new Set(['.yggdrasil/model/README.md']));
  });

  it('a log.md directly under model/ is not a node log and burns nothing', () => {
    const result = burn(['.yggdrasil/model/log.md']);
    expect(result.logOnlyNodePaths).toEqual(new Set());
    expect(result.pairKeys).toEqual(new Set());
  });

  it('a top-level node directory that no longer exists burns nothing pair-wise', () => {
    const result = burn(['.yggdrasil/model/ghost/yg-node.yaml']);
    expect(result.pairKeys).toEqual(new Set());
    expect(result.nodePaths).toEqual(new Set());
  });

  it('a bare yg-node.yaml / yg-flow.yaml under the prefix proposes no graph observation', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs, {
      [K('x', 'node:lonely')]: [
        ['graph:', 'h'],
        ['graph-flow:', 'h'],
      ],
    });
    const result = burn(['.yggdrasil/model/yg-node.yaml', '.yggdrasil/flows/yg-flow.yaml'], {
      pairs,
      lists,
    });
    expect(result.pairKeys).toEqual(new Set());
  });

  it('an aspects/ path with no aspect segment burns nothing', () => {
    expect(burn(['.yggdrasil/aspects/']).pairKeys).toEqual(new Set());
  });

  it('skips the cold estimate for a component that may read nothing at all', () => {
    const graph = makeGraph({
      nodes: new Map([['bare', makeNode('bare', { meta: { name: 'bare', type: 'library' } })]]),
      aspects: [makeAspect('x', { reviewer: { type: 'deterministic' } })],
    });
    const pairs = [makePair('x', 'bare', [])];
    const result = burn(['src/anything.ts'], {
      graph,
      pairs,
      lists: new Map(), // cold
    });
    expect(result.pairKeys).toEqual(new Set());
  });
});

describe('extractConfigVocabulary — malformed reviewer shapes', () => {
  it('reads no tier names when reviewer is not a mapping', () => {
    expect(extractConfigVocabulary('reviewer: fast\n').tierNames).toEqual([]);
    expect(extractConfigVocabulary('reviewer:\n  - fast\n').tierNames).toEqual([]);
  });

  it('reads no tier names when reviewer.tiers is not a mapping', () => {
    expect(extractConfigVocabulary('reviewer:\n  tiers: fast\n').tierNames).toEqual([]);
    expect(extractConfigVocabulary('reviewer:\n  tiers:\n    - fast\n').tierNames).toEqual([]);
  });
});

describe('configVocabularyChanged — absent coverage on both sides', () => {
  it('is false when neither side declares any vocabulary key', () => {
    expect(configVocabularyChanged('debug: true\n', 'debug: false\n')).toBe(false);
  });

  it('is true when one side gains a coverage block', () => {
    expect(configVocabularyChanged('debug: true\n', 'coverage:\n  required: [/]\n')).toBe(true);
  });
});

describe('computeBurnSet — repeated and empty reach', () => {
  it('resolves each aspect closure once across several changed rule files', () => {
    const result = burn([
      '.yggdrasil/aspects/x/content.md',
      '.yggdrasil/aspects/x/yg-aspect.yaml',
    ]);
    expect(result.pairKeys.has(K('z', 'node:lonely'))).toBe(true);
    expect(result.changedInputCount).toBe(2);
  });

  it('tolerates a flow participant that carries no pairs at all', () => {
    const graph = makeBurnGraph();
    graph.flows = [{ path: 'f', name: 'Flow F', nodes: ['top/mid', 'lonely'], aspects: ['y'] }];
    const pairs = [makePair('y', 'top/mid', ['src/top/mid/f.ts'])];
    const result = burn(['.yggdrasil/flows/f/yg-flow.yaml'], { graph, pairs });
    expect(result.pairKeys).toEqual(new Set([K('y', 'node:top/mid')]));
  });
});

// --- Row: a verdict the change DELETED from the committed lock ---

describe('computeBurnSet — removed-verdict row', () => {
  it('burns a pair whose stored verdict existed at the reference and is gone now', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs);
    lists.delete(K('y', 'node:top/mid')); // the change dropped this lock entry
    const result = burn(['src/nowhere/orphan.ts'], {
      pairs,
      lists,
      baseVerdictPairKeys: new Set([K('y', 'node:top/mid')]),
    });
    expect(result.pairKeys.has(K('y', 'node:top/mid'))).toBe(true);
  });

  it('burns a deleted PLAIN-LLM verdict, which no allowed-reads estimate would reach', () => {
    // The exact hole the estimate cannot see: a plain LLM pair is excluded from
    // the cold estimate on purpose, and nothing changed inside its reach either.
    const graph = makeBurnGraph();
    graph.aspects = [makeAspect('y', { reviewer: { type: 'llm' } })];
    const pairs = [makePair('y', 'top/mid', ['src/top/mid/f.ts'], { kind: 'llm' })];
    const withoutBase = burn(['README.md'], { graph, pairs, lists: new Map() });
    expect(withoutBase.pairKeys).toEqual(new Set());

    const withBase = burn(['README.md'], {
      graph,
      pairs,
      lists: new Map(),
      baseVerdictPairKeys: new Set([K('y', 'node:top/mid')]),
    });
    expect(withBase.pairKeys).toEqual(new Set([K('y', 'node:top/mid')]));
  });

  it('fires even when nothing at all was touched — the deletion is the change', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs);
    lists.delete(K('x', 'node:lonely'));
    const result = burn([], { pairs, lists, baseVerdictPairKeys: new Set([K('x', 'node:lonely')]) });
    expect(result.pairKeys).toEqual(new Set([K('x', 'node:lonely')]));
    expect(result.changedInputCount).toBe(0);
  });

  it('does not fire for a pair that still holds its verdict', () => {
    const pairs = makeBurnPairs();
    const result = burn(['README.md'], {
      pairs,
      baseVerdictPairKeys: new Set(pairs.map((p) => K(p.aspectId, p.unitKey))),
    });
    expect(result.pairKeys).toEqual(new Set());
  });

  it('does not fire for a pair that never had a verdict at the reference', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs);
    lists.delete(K('y', 'node:top/mid'));
    const result = burn(['README.md'], { pairs, lists, baseVerdictPairKeys: new Set() });
    expect(result.pairKeys).toEqual(new Set());
  });
});

// --- Row: children membership observed from somewhere other than the parent ---

describe('computeBurnSet — graph-children membership', () => {
  it('burns a pair that observed children(B) when a new child node appears under B', () => {
    // The observing unit is `lonely`; the observed parent is `top/mid`. Adding
    // top/mid/newchild moves the membership lonely's check recorded.
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs, { [K('x', 'node:lonely')]: [['graph-children:top/mid', 'h']] });
    const result = burn(['.yggdrasil/model/top/mid/newchild/yg-node.yaml'], { pairs, lists });
    expect(result.pairKeys.has(K('x', 'node:lonely'))).toBe(true);
  });

  it('burns it on a DELETED child too — both directions move the membership', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs, { [K('x', 'node:lonely')]: [['graph-children:top/mid', 'h']] });
    const result = burn(['.yggdrasil/model/top/mid/leaf/yg-node.yaml'], { pairs, lists });
    expect(result.pairKeys.has(K('x', 'node:lonely'))).toBe(true);
  });

  it('does not burn it for a node two levels down — that moves the INTERMEDIATE node’s children', () => {
    const pairs = makeBurnPairs();
    const lists = warmAll(pairs, { [K('x', 'node:lonely')]: [['graph-children:top', 'h']] });
    const result = burn(['.yggdrasil/model/top/mid/leaf/yg-node.yaml'], { pairs, lists });
    expect(result.pairKeys.has(K('x', 'node:lonely'))).toBe(false);
  });

  it('agrees with touchedReferencesFile on the direct-child form', () => {
    expect(
      touchedReferencesFile(
        [['graph-children:top/mid', 'h']],
        '.yggdrasil/model/top/mid/newchild/yg-node.yaml',
      ),
    ).toBe(true);
    expect(
      touchedReferencesFile(
        [['graph-children:top', 'h']],
        '.yggdrasil/model/top/mid/leaf/yg-node.yaml',
      ),
    ).toBe(false);
  });
});

// --- Row: engine outputs that are not lock files ---

describe('computeBurnSet — verdict-event outputs', () => {
  it('ignores the committed and local verdict-event streams', () => {
    const result = burn(['.yggdrasil/yg-events.llm.jsonl', '.yggdrasil/.yg-events.jsonl']);
    expect(result.files).toEqual(new Set());
    expect(result.changedInputCount).toBe(0);
    expect(result.pairKeys).toEqual(new Set());
  });
});

// --- Config vocabulary: the two ingredients a tier-name set cannot see ---

describe('configVocabularyChanged — reviewer.default', () => {
  it('is true when the default is repointed between two EXISTING tiers', () => {
    const head = BASE_CONFIG.replace('default: fast', 'default: deep');
    expect(extractConfigVocabulary(BASE_CONFIG).tierNames).toEqual(
      extractConfigVocabulary(head).tierNames,
    );
    expect(configVocabularyChanged(BASE_CONFIG, head)).toBe(true);
  });

  it('is true when an explicit default is added or removed', () => {
    const withoutDefault = BASE_CONFIG.replace('  default: fast\n', '');
    expect(configVocabularyChanged(BASE_CONFIG, withoutDefault)).toBe(true);
  });

  it('resolves a lone tier as the default even with no explicit default', () => {
    const single = `reviewer:
  tiers:
    only:
      provider: claude-code
      model: sonnet
`;
    expect(extractConfigVocabulary(single).defaultTier).toBe('only');
  });

  it('reads no default when several tiers exist and none is named', () => {
    const noDefault = BASE_CONFIG.replace('  default: fast\n', '');
    expect(extractConfigVocabulary(noDefault).defaultTier).toBeUndefined();
  });
});

describe('configVocabularyChanged — the progressive block', () => {
  it('is true when the reference is repointed', () => {
    const base = `${BASE_CONFIG}progressive:\n  reference: origin/main\n`;
    const head = `${BASE_CONFIG}progressive:\n  reference: HEAD\n`;
    expect(configVocabularyChanged(base, head)).toBe(true);
  });

  it('is true when the block is added or removed', () => {
    const withBlock = `${BASE_CONFIG}progressive:\n  reference: origin/main\n`;
    expect(configVocabularyChanged(BASE_CONFIG, withBlock)).toBe(true);
    expect(configVocabularyChanged(withBlock, BASE_CONFIG)).toBe(true);
  });

  it('is false when the block is present and identical on both sides', () => {
    const same = `${BASE_CONFIG}progressive:\n  reference: origin/main\n`;
    expect(configVocabularyChanged(same, same)).toBe(false);
  });

  it('escalates a repointed reference all the way to a global burn', () => {
    const base = `${BASE_CONFIG}progressive:\n  reference: origin/main\n`;
    const head = `${BASE_CONFIG}progressive:\n  reference: HEAD\n`;
    const result = burn(['.yggdrasil/yg-config.yaml'], {
      configVocabularyChanged: configVocabularyChanged(base, head),
    });
    expect(result.global).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The byte guard: git's answer, checked against the files' own content.
//
// Every case below hands the decision plain values — a fabricated object-id map
// and buffers — because that is the whole point of the split: the gathering
// half reads the disk, this half only compares. The ONE claim these tests
// cannot make on their own is that the id it computes is really git's; that is
// proved against a real repository in tests/unit/utils/git-introspect.test.ts,
// and end-to-end through the built binary in tests/e2e/cli-progressive-byte-guard.
// ---------------------------------------------------------------------------

/** A burn set with nothing burned, for the guard to widen (or not). */
function emptyBurn(overrides: Partial<BurnSet> = {}): BurnSet {
  return {
    global: false,
    pairKeys: new Set(),
    nodePaths: new Set(['untouched-node']),
    files: new Set(['src/touched.ts']),
    logOnlyNodePaths: new Set(['logged-node']),
    changedInputCount: 1,
    ...overrides,
  };
}

const bytesOf = (text: string): Buffer => Buffer.from(text, 'utf-8');

/** The object id a tree listing would record for exactly this content. */
const oidOf = (text: string): string => hashGitBlob(bytesOf(text));

/** The 64-hex form the same content gets in a repository created with sha256 ids. */
const oid256Of = (text: string): string => hashGitBlob(bytesOf(text), 'sha256');

/** Shorthand for the scope shape the guard receives. */
const scopeOf = (
  burn: BurnSet,
  listing: ReadonlyMap<string, string> | null,
): { burn: BurnSet; blobOidByPath: ReadonlyMap<string, string> | null } => ({
  burn,
  blobOidByPath: listing,
});

describe('hashGitBlob', () => {
  it('is the git object-header form: sha1 over "blob <byteLength>\\0" then the raw bytes', () => {
    // Pinned against a value produced by git itself for this exact content
    // (`printf 'hello\nworld\n' | git hash-object --stdin`), so a refactor that
    // silently changed the header, the length units, or the encoding fails here
    // rather than by making every file in a repository look modified.
    expect(hashGitBlob(bytesOf('hello\nworld\n'))).toBe(
      '94954abda49de8615a048f8d2e64b5de848e27a1',
    );
  });

  it('produces the newer, longer form when the repository uses it', () => {
    // Pinned against git itself in a repository created with
    // `git init --object-format=sha256`:
    //   printf 'hello\nworld\n' | git hash-object --stdin
    // Assuming the older digest on such a repository mismatches every file at
    // once, which forces every inherited finding back in scope and leaves the
    // mode inert with nothing said about it.
    expect(hashGitBlob(bytesOf('hello\nworld\n'), 'sha256')).toBe(
      'fe76325aa5521b207ebe01e12fd8e9e3abf030cacd5398e3744a3a56a81ad1bd',
    );
  });

  it('counts BYTES, not characters', () => {
    // A multi-byte character is where a character-count header goes wrong, and
    // it goes wrong for every file at once.
    const multibyte = Buffer.from('héllo\n', 'utf-8');
    expect(multibyte.length).toBe(7);
    expect(hashGitBlob(multibyte)).not.toBe(hashGitBlob(Buffer.from('hello\n', 'utf-8')));
  });

  it('distinguishes two binary buffers a text decoding would flatten together', () => {
    // 0xFE and 0xFF are both invalid UTF-8 starts and both decode to the SAME
    // replacement character. A text-based comparer calls these two files equal;
    // hashing raw bytes does not.
    const a = Buffer.from([0x00, 0xfe, 0x01]);
    const b = Buffer.from([0x00, 0xff, 0x01]);
    expect(a.toString('utf-8')).toBe(b.toString('utf-8'));
    expect(hashGitBlob(a)).not.toBe(hashGitBlob(b));
  });
});

describe('gitObjectDigest', () => {
  it('reads the repository object format off the recorded ids', () => {
    expect(gitObjectDigest(new Map([['a', oidOf('x')]]))).toBe('sha1');
    expect(gitObjectDigest(new Map([['a', oid256Of('x')]]))).toBe('sha256');
  });

  it('refuses a width it cannot reproduce rather than guessing one', () => {
    expect(gitObjectDigest(new Map([['a', 'deadbeef']]))).toBeNull();
  });

  it('answers for an empty listing, where the answer cannot matter', () => {
    // Nothing is ever hashed against an empty listing — every subject takes the
    // absent-from-the-reference branch — so this only has to be non-null.
    expect(gitObjectDigest(new Map())).toBe('sha1');
  });
});

describe('forceInScopeOnByteMismatch — what it re-admits', () => {
  it('re-admits a pair whose subject bytes moved while git reported no change', () => {
    // The evasion this exists for: the file is edited, the index is told to
    // ignore it, so it never reaches the touched set and its pair falls outside
    // the change. Its content says otherwise.
    const result = forceInScopeOnByteMismatch(
      scopeOf(emptyBurn(), new Map([['src/hidden.ts', oidOf('original\n')]])),
      [{ pairKey: K('a', 'node:hidden'), subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n') }] }],
    );
    expect(result.pairKeys).toEqual(new Set([K('a', 'node:hidden')]));
  });

  it('re-admits the FILE and its owning component, not only the rule check', () => {
    // The class the first shape of this guard missed entirely: a finding keyed
    // by a component or by a file is decided by these two sets, never by the
    // rule-check keys, so widening only those left the whole class released on
    // git's false report.
    const result = forceInScopeOnByteMismatch(
      scopeOf(emptyBurn(), new Map([['src/hidden.ts', oidOf('original\n')]])),
      [{ subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n'), owner: 'svc' }] }],
    );
    expect(result.files.has('src/hidden.ts')).toBe(true);
    expect(result.nodePaths.has('svc')).toBe(true);
    // No rule check was named, so none was invented.
    expect(result.pairKeys).toEqual(new Set());
  });

  it('counts a re-admitted file as the changed input it is', () => {
    // The header quotes this number as "N changed input(s)". Leaving it at
    // git's count would have the run claim it gated fewer files than it did.
    const result = forceInScopeOnByteMismatch(
      scopeOf(emptyBurn(), new Map([['src/hidden.ts', oidOf('original\n')]])),
      [{ subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n') }] }],
    );
    expect(result.changedInputCount).toBe(2);
    expect(result.changedInputCount).toBe(result.files.size);
  });

  it('re-admits only the files that actually moved, never a candidate’s whole list', () => {
    // `files` means "changed paths this run accounted for". A file that did not
    // change is not one of them, and putting it there would make the count in
    // front of a person a claim about their diff that is not true.
    const result = forceInScopeOnByteMismatch(
      scopeOf(
        emptyBurn(),
        new Map([
          ['src/one.ts', oidOf('same\n')],
          ['src/two.ts', oidOf('original\n')],
        ]),
      ),
      [
        {
          pairKey: K('a', 'node:multi'),
          subjects: [
            { path: 'src/one.ts', bytes: bytesOf('same\n'), owner: 'one' },
            { path: 'src/two.ts', bytes: bytesOf('edited\n'), owner: 'two' },
          ],
        },
      ],
    );
    expect(result.pairKeys).toEqual(new Set([K('a', 'node:multi')]));
    expect(result.files.has('src/two.ts')).toBe(true);
    expect(result.files.has('src/one.ts')).toBe(false);
    expect(result.nodePaths.has('two')).toBe(true);
    expect(result.nodePaths.has('one')).toBe(false);
  });

  it('leaves a pair alone when every subject still hashes to the recorded id', () => {
    const burnSet = emptyBurn();
    const result = forceInScopeOnByteMismatch(
      scopeOf(burnSet, new Map([['src/quiet.ts', oidOf('same\n')]])),
      [{ pairKey: K('a', 'node:quiet'), subjects: [{ path: 'src/quiet.ts', bytes: bytesOf('same\n') }] }],
    );
    // The very same object, not an equal copy: a run where the guard finds
    // nothing must be indistinguishable from one where it never ran.
    expect(result).toBe(burnSet);
  });

  it('compares against the REPOSITORY’s object format, not one it assumed', () => {
    // A repository created with the newer format records 64-hex ids. Hard-wiring
    // the older digest made every file mismatch, which forced every inherited
    // finding back in scope and left the mode inert with nothing said about it.
    const burnSet = emptyBurn();
    const listing = new Map([['src/quiet.ts', oid256Of('same\n')]]);
    expect(
      forceInScopeOnByteMismatch(scopeOf(burnSet, listing), [
        { pairKey: K('a', 'node:quiet'), subjects: [{ path: 'src/quiet.ts', bytes: bytesOf('same\n') }] },
      ]),
    ).toBe(burnSet);
    // …and a real edit is still caught under that format.
    expect(
      forceInScopeOnByteMismatch(scopeOf(burnSet, listing), [
        { pairKey: K('a', 'node:quiet'), subjects: [{ path: 'src/quiet.ts', bytes: bytesOf('edited\n') }] },
      ]).pairKeys,
    ).toEqual(new Set([K('a', 'node:quiet')]));
  });

  it('compares BINARY subjects correctly instead of forcing them in forever', () => {
    // The trap that would make the guard permanently noisy: deterministic rules
    // keep binary files among their subjects, and a text-decoding comparer
    // mismatches every one of them on every run.
    const logo = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x00, 0x42]);
    const burnSet = emptyBurn();
    const listing = new Map([['src/logo.bin', hashGitBlob(logo)]]);
    const unchanged = forceInScopeOnByteMismatch(scopeOf(burnSet, listing), [
      { pairKey: K('a', 'node:art'), subjects: [{ path: 'src/logo.bin', bytes: logo }] },
    ]);
    expect(unchanged).toBe(burnSet);

    // …and a real edit to those same bytes is still caught.
    const edited = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x00, 0x43]);
    const moved = forceInScopeOnByteMismatch(scopeOf(burnSet, listing), [
      { pairKey: K('a', 'node:art'), subjects: [{ path: 'src/logo.bin', bytes: edited }] },
    ]);
    expect(moved.pairKeys).toEqual(new Set([K('a', 'node:art')]));
  });
});

describe('forceInScopeOnByteMismatch — which way an unanswerable comparison falls', () => {
  it('re-admits a subject whose bytes could not be read at all', () => {
    const result = forceInScopeOnByteMismatch(
      scopeOf(emptyBurn(), new Map([['src/gone.ts', oidOf('was here\n')]])),
      [{ pairKey: K('a', 'node:gone'), subjects: [{ path: 'src/gone.ts', bytes: null }] }],
    );
    expect(result.pairKeys).toEqual(new Set([K('a', 'node:gone')]));
  });

  it('re-admits a subject the reference tree never listed', () => {
    // The file did not exist at the reference, yet the change is reported as
    // never having touched it. Both cannot be true.
    const result = forceInScopeOnByteMismatch(scopeOf(emptyBurn(), new Map()), [
      { pairKey: K('a', 'node:new'), subjects: [{ path: 'src/new.ts', bytes: bytesOf('added\n') }] },
    ]);
    expect(result.pairKeys).toEqual(new Set([K('a', 'node:new')]));
  });

  it('says nothing about a pair with no subject files', () => {
    // Nothing to disagree about, so nothing is proved either way — and the
    // guard never re-admits on an absence of evidence.
    const burnSet = emptyBurn();
    const result = forceInScopeOnByteMismatch(scopeOf(burnSet, new Map()), [
      { pairKey: K('a', 'type:everything'), subjects: [] },
    ]);
    expect(result).toBe(burnSet);
  });
});

describe('forceInScopeOnByteMismatch — when it declines to run', () => {
  it('is skipped entirely when the reference listing could not be obtained', () => {
    // A null listing is NOT an empty one: reading it as empty would re-admit
    // every candidate, inventing a second failure mode where the measurement
    // already fails closed elsewhere.
    const burnSet = emptyBurn();
    const result = forceInScopeOnByteMismatch(scopeOf(burnSet, null), [
      { pairKey: K('a', 'node:hidden'), subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n') }] },
    ]);
    expect(result).toBe(burnSet);
  });

  it('is skipped when the recorded ids are in a format it cannot reproduce', () => {
    // Comparing against ids this build cannot make would mismatch every file and
    // force everything in scope; the run declines instead, and the caller says so.
    const burnSet = emptyBurn();
    const result = forceInScopeOnByteMismatch(scopeOf(burnSet, new Map([['src/hidden.ts', 'deadbeef']])), [
      { pairKey: K('a', 'node:hidden'), subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n') }] },
    ]);
    expect(result).toBe(burnSet);
  });

  it('is skipped under a global scope, which already gates everything', () => {
    const burnSet = emptyBurn({ global: true });
    const result = forceInScopeOnByteMismatch(
      scopeOf(burnSet, new Map([['src/hidden.ts', oidOf('original\n')]])),
      [{ pairKey: K('a', 'node:hidden'), subjects: [{ path: 'src/hidden.ts', bytes: bytesOf('edited\n') }] }],
    );
    expect(result).toBe(burnSet);
  });
});

describe('forceInScopeOnByteMismatch — it can only ADD scope', () => {
  // The one property the whole guard rests on, checked over every combination
  // of the inputs that decide an outcome rather than on one hand-picked case: a
  // wrong "force" costs someone reading a finding that was not theirs, while a
  // wrong "release" ships a real violation green. Every rung of the
  // classification ladder is monotone in these sets, so a superset can only ever
  // keep a finding blocking that would otherwise have been released.
  it('never drops a pair key, a component or a file, and never lowers a count', () => {
    const listings: Array<ReadonlyMap<string, string> | null> = [
      null,
      new Map(),
      new Map([['src/a.ts', 'deadbeef']]),
      new Map([['src/a.ts', oidOf('original\n')]]),
      new Map([['src/a.ts', oidOf('same\n')]]),
      new Map([['src/a.ts', oid256Of('same\n')]]),
    ];
    const subjectSets = [
      [],
      [{ path: 'src/a.ts', bytes: bytesOf('same\n') }],
      [{ path: 'src/a.ts', bytes: bytesOf('edited\n'), owner: 'owner-a' }],
      [{ path: 'src/a.ts', bytes: null, owner: 'owner-a' }],
      [{ path: 'src/missing.ts', bytes: bytesOf('x\n') }],
    ];
    const starts = [
      emptyBurn(),
      emptyBurn({ global: true }),
      emptyBurn({ pairKeys: new Set([K('kept', 'node:one'), K('kept', 'node:two')]) }),
    ];

    for (const start of starts) {
      for (const listing of listings) {
        for (const subjects of subjectSets) {
          for (const pairKey of [K('candidate', 'node:x'), undefined]) {
            const result = forceInScopeOnByteMismatch(scopeOf(start, listing), [{ pairKey, subjects }]);
            for (const key of start.pairKeys) expect(result.pairKeys.has(key)).toBe(true);
            for (const node of start.nodePaths) expect(result.nodePaths.has(node)).toBe(true);
            for (const file of start.files) expect(result.files.has(file)).toBe(true);
            expect(result.global).toBe(start.global);
            expect(result.logOnlyNodePaths).toBe(start.logOnlyNodePaths);
            expect(result.changedInputCount).toBeGreaterThanOrEqual(start.changedInputCount);
            expect(result.changedInputCount).toBe(result.files.size);
            // The only rule check it may ever have added is the candidate's own.
            for (const key of result.pairKeys) {
              if (!start.pairKeys.has(key)) expect(key).toBe(K('candidate', 'node:x'));
            }
            // …and the only component and file, the candidate's own.
            for (const node of result.nodePaths) {
              if (!start.nodePaths.has(node)) expect(node).toBe('owner-a');
            }
            for (const file of result.files) {
              if (!start.files.has(file)) expect(subjects.some((s) => s.path === file)).toBe(true);
            }
          }
        }
      }
    }
  });
});
