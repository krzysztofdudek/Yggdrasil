import { describe, it, expect } from 'vitest';
import {
  impliesClosure,
  buildReverseTargetIndex,
  collectFlowParticipants,
  computeBurnSet,
  progressivePairKey,
  extractConfigVocabulary,
  configVocabularyChanged,
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
    // Node-keyed issues scope to the node whose declaration changed, not to the
    // whole fan-out — an ancestor did not itself change.
    expect(result.nodePaths).toEqual(new Set(['top/mid']));
    expect(result.logOnlyNodePaths).toEqual(new Set());
  });

  it('resolves a non-node file inside a node directory to the nearest enclosing node', () => {
    const result = burn(['.yggdrasil/model/top/mid/notes/scratch.md']);
    expect(result.nodePaths).toEqual(new Set(['top/mid']));
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
    expect(result.nodePaths).toEqual(new Set(['top/mid']));
    expect(result.pairKeys.has(K('x', 'node:top/mid'))).toBe(true);
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
