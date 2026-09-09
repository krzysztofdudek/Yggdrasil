import { describe, it, expect } from 'vitest';
import { computeEffectiveAspectStatuses } from '../../../src/core/graph/aspects.js';
import type {
  Graph,
  GraphNode,
  AspectDef,
  ArchitectureDef,
  FlowDef,
  AspectStatus,
} from '../../../src/model/graph.js';
import type { WhenPredicate } from '../../../src/model/when.js';

// ============================================================================
// Bug-bounty exhaustive tests for:
//   computeEffectiveAspectStatuses — effective aspect status =
//   strictest (max) across all cascading channels (draft < advisory < enforced),
//   plus status_inherit on implies edges, downgrade attempts, and the
//   "enforced via one channel, advisory via another → enforced" resolution.
//
// The function is PURE (no filesystem access — it never reads node mappings or
// reference files), so these tests build small in-memory graphs directly,
// matching the established style in
// tests/unit/core/graph/aspect-status.test.ts. No temp dirs are required.
// ============================================================================

// --- Local convenience builders (mirror existing aspect-status.test.ts) -----

function makeAspect(
  id: string,
  status: AspectStatus = 'enforced',
  extra: Partial<AspectDef> = {},
): AspectDef {
  return {
    id,
    name: id,
    reviewer: { type: 'llm' },
    artifacts: [{ filename: 'content.md', content: 'rule' }],
    status,
    ...extra,
  } as AspectDef;
}

function makeNode(
  path: string,
  type: string,
  aspects: string[] = [],
  aspectStatus?: Record<string, AspectStatus>,
): GraphNode {
  return {
    path,
    meta: { name: path, type, aspects, aspectStatus },
    children: [],
    parent: null,
  } as GraphNode;
}

function link(parent: GraphNode, child: GraphNode): void {
  child.parent = parent;
  parent.children.push(child);
}

function makeGraph(
  aspects: AspectDef[],
  nodes: GraphNode[] = [],
  opts: { flows?: FlowDef[]; architecture?: ArchitectureDef | null } = {},
): Graph {
  return {
    aspects,
    nodes: new Map(nodes.map((n) => [n.path, n])),
    flows: opts.flows ?? [],
    architecture: opts.architecture ?? null,
  } as unknown as Graph;
}

// A when predicate matching the node by type. `{ node: { type: T } }`.
function whenType(type: string): WhenPredicate {
  return { node: { type } } as WhenPredicate;
}

const FALSE_WHEN: WhenPredicate = { node: { type: '__nope__' } } as WhenPredicate;

// ============================================================================
// 1. The maxStatus core: strictest wins between two channels
// ============================================================================

describe('strictest (max) across channels — pairwise', () => {
  it('draft + advisory → advisory', () => {
    const aspect = makeAspect('a', 'advisory');
    const parent = makeNode('p', 'module', ['a'], { a: 'draft' });
    const child = makeNode('p/c', 'service', ['a'], { a: 'advisory' });
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(r.get('a')).toBe('advisory');
  });

  it('advisory + enforced → enforced', () => {
    const aspect = makeAspect('a', 'advisory');
    const parent = makeNode('p', 'module', ['a'], { a: 'advisory' });
    const child = makeNode('p/c', 'service', ['a'], { a: 'enforced' });
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(r.get('a')).toBe('enforced');
  });

  it('draft + enforced → enforced', () => {
    const aspect = makeAspect('a', 'draft');
    const parent = makeNode('p', 'module', ['a'], { a: 'draft' });
    const child = makeNode('p/c', 'service', ['a'], { a: 'enforced' });
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(r.get('a')).toBe('enforced');
  });

  it('enforced + enforced → enforced (idempotent)', () => {
    const aspect = makeAspect('a', 'enforced');
    const parent = makeNode('p', 'module', ['a'], { a: 'enforced' });
    const child = makeNode('p/c', 'service', ['a'], { a: 'enforced' });
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(r.get('a')).toBe('enforced');
  });

  it('draft + draft → draft', () => {
    const aspect = makeAspect('a', 'draft');
    const parent = makeNode('p', 'module', ['a'], { a: 'draft' });
    const child = makeNode('p/c', 'service', ['a'], { a: 'draft' });
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(r.get('a')).toBe('draft');
  });

  it('advisory + advisory → advisory', () => {
    const aspect = makeAspect('a', 'advisory');
    const parent = makeNode('p', 'module', ['a'], { a: 'advisory' });
    const child = makeNode('p/c', 'service', ['a'], { a: 'advisory' });
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(r.get('a')).toBe('advisory');
  });
});

// ============================================================================
// 2. Channel-order independence — max is commutative regardless of which
//    channel supplies the higher status.
// ============================================================================

describe('strictest is order-independent (the headline case)', () => {
  it('enforced on own channel, advisory on parent channel → enforced', () => {
    const aspect = makeAspect('a', 'advisory');
    const parent = makeNode('p', 'module', ['a'], { a: 'advisory' });
    const child = makeNode('p/c', 'service', ['a'], { a: 'enforced' });
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(r.get('a')).toBe('enforced');
  });

  it('advisory on own channel, enforced on parent channel → enforced (mirror)', () => {
    const aspect = makeAspect('a', 'advisory');
    const parent = makeNode('p', 'module', ['a'], { a: 'enforced' });
    const child = makeNode('p/c', 'service', ['a'], { a: 'advisory' });
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(r.get('a')).toBe('enforced');
  });

  it('enforced via flow, advisory via own → enforced', () => {
    const aspect = makeAspect('a', 'advisory');
    const node = makeNode('n', 'service', ['a'], { a: 'advisory' });
    const flow: FlowDef = {
      path: 'f', name: 'f', nodes: ['n'], aspects: ['a'], aspectStatus: { a: 'enforced' },
    } as FlowDef;
    const r = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node], { flows: [flow] }));
    expect(r.get('a')).toBe('enforced');
  });

  it('advisory via flow, enforced via own → enforced (mirror)', () => {
    const aspect = makeAspect('a', 'advisory');
    const node = makeNode('n', 'service', ['a'], { a: 'enforced' });
    const flow: FlowDef = {
      path: 'f', name: 'f', nodes: ['n'], aspects: ['a'], aspectStatus: { a: 'advisory' },
    } as FlowDef;
    const r = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node], { flows: [flow] }));
    expect(r.get('a')).toBe('enforced');
  });

  it('enforced via architecture type, advisory via own → enforced', () => {
    const aspect = makeAspect('a', 'advisory');
    const node = makeNode('n', 'service', ['a'], { a: 'advisory' });
    const architecture: ArchitectureDef = {
      node_types: { service: { description: 's', aspects: ['a'], aspectStatus: { a: 'enforced' } } },
    };
    const r = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node], { architecture }));
    expect(r.get('a')).toBe('enforced');
  });

  it('enforced via port, advisory via own → enforced', () => {
    const aspect = makeAspect('a', 'advisory');
    const target: GraphNode = {
      path: 'svc',
      meta: { name: 'svc', type: 'service', ports: { p: { description: '', aspects: ['a'], aspectStatus: { a: 'enforced' } } } },
      children: [], parent: null,
    } as GraphNode;
    const consumer = makeNode('c', 'service', ['a'], { a: 'advisory' });
    consumer.meta.relations = [{ target: 'svc', type: 'calls', portNames: ['p'] }];
    const r = computeEffectiveAspectStatuses(consumer, makeGraph([aspect], [target, consumer]));
    expect(r.get('a')).toBe('enforced');
  });
});

// ============================================================================
// 3. Status defaults vs explicit override per channel
// ============================================================================

describe('per-channel declared status vs aspect default', () => {
  it('aspect default enforced + no override on any channel → enforced', () => {
    const aspect = makeAspect('a', 'enforced');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node]));
    expect(r.get('a')).toBe('enforced');
  });

  it('aspect default draft + no override → draft', () => {
    const aspect = makeAspect('a', 'draft');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node]));
    expect(r.get('a')).toBe('draft');
  });

  it('aspect default undefined → treated as enforced', () => {
    const aspect = { ...makeAspect('a'), status: undefined } as AspectDef;
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node]));
    expect(r.get('a')).toBe('enforced');
  });

  it('aspect with no def at all → falls back to enforced default', () => {
    const node = makeNode('n', 'service', ['orphan']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([], [node]));
    expect(r.get('orphan')).toBe('enforced');
  });

  it('default advisory + one channel bumps to enforced → enforced', () => {
    const aspect = makeAspect('a', 'advisory');
    const parent = makeNode('p', 'module', ['a'], { a: 'enforced' });
    const child = makeNode('p/c', 'service', ['a']); // own channel uses default (advisory)
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(r.get('a')).toBe('enforced');
  });

  it('default enforced + one channel uses default while another declares advisory → enforced (cannot downgrade below default)', () => {
    // The advisory declaration is below the aspect default; the default-applying
    // channel keeps it at enforced. max() therefore yields enforced.
    const aspect = makeAspect('a', 'enforced');
    const parent = makeNode('p', 'module', ['a']); // default enforced
    const child = makeNode('p/c', 'service', ['a'], { a: 'advisory' }); // attempted downgrade
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(r.get('a')).toBe('enforced');
  });
});

// ============================================================================
// 4. Downgrade attempt — a single attach site declaring a status LOWER than the
//    aspect default does NOT lower the effective status when another path
//    supplies the default (or a higher value). The cascade is a pure max.
// ============================================================================

describe('downgrade attempts never lower the effective status', () => {
  it('single channel declaring advisory on an enforced-default aspect → advisory (only one source; nothing else raises it)', () => {
    // With exactly one channel and an explicit advisory override, the effective
    // status is advisory. (Whether such a downgrade is a *validator* error is a
    // separate concern — this function just computes max across present sources.)
    const aspect = makeAspect('a', 'enforced');
    const node = makeNode('n', 'service', ['a'], { a: 'advisory' });
    const r = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node]));
    expect(r.get('a')).toBe('advisory');
  });

  it('downgrade on own + default on parent → max keeps enforced default', () => {
    const aspect = makeAspect('a', 'enforced');
    const parent = makeNode('p', 'module', ['a']); // default enforced
    const child = makeNode('p/c', 'service', ['a'], { a: 'draft' }); // downgrade attempt to draft
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(r.get('a')).toBe('enforced');
  });

  it('downgrade to draft on own, advisory on flow → advisory (max ignores the lower draft)', () => {
    const aspect = makeAspect('a', 'enforced');
    const node = makeNode('n', 'service', ['a'], { a: 'draft' });
    const flow: FlowDef = {
      path: 'f', name: 'f', nodes: ['n'], aspects: ['a'], aspectStatus: { a: 'advisory' },
    } as FlowDef;
    const r = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node], { flows: [flow] }));
    expect(r.get('a')).toBe('advisory');
  });

  it('three channels with mixed downgrade attempts → strictest survives', () => {
    const aspect = makeAspect('a', 'advisory');
    const grand = makeNode('g', 'module', ['a'], { a: 'enforced' });
    const parent = makeNode('g/p', 'module', ['a'], { a: 'draft' });
    const child = makeNode('g/p/c', 'service', ['a'], { a: 'advisory' });
    link(grand, parent);
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [grand, parent, child]));
    expect(r.get('a')).toBe('enforced');
  });
});

// ============================================================================
// 5. implies edges + status_inherit (strictest vs own-default)
// ============================================================================

describe('implies propagation — strictest (default) inherit mode', () => {
  it('A enforced implies B(advisory default) strictest → B enforced', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'] });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('a')).toBe('enforced');
    expect(r.get('b')).toBe('enforced');
  });

  it('A advisory implies B(enforced default) strictest → B keeps enforced (max(advisory, enforced))', () => {
    const a = makeAspect('a', 'advisory', { implies: ['b'] });
    const b = makeAspect('b', 'enforced');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('a')).toBe('advisory');
    expect(r.get('b')).toBe('enforced');
  });

  it('A advisory implies B(draft default) strictest → B advisory (implier raises it)', () => {
    const a = makeAspect('a', 'advisory', { implies: ['b'] });
    const b = makeAspect('b', 'draft');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('b')).toBe('advisory');
  });

  it('explicit strictest inherit behaves identically to omitted', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'strictest' } });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('b')).toBe('enforced');
  });
});

describe('implies propagation — own-default inherit mode', () => {
  it('A enforced implies B(advisory default) own-default → B advisory', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('b')).toBe('advisory');
  });

  it('A enforced implies B(draft default) own-default → B draft', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'draft');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('b')).toBe('draft');
  });

  it('A enforced implies B(enforced default) own-default → B enforced', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'enforced');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('b')).toBe('enforced');
  });

  it('own-default does not LOWER B below a direct channel value (max still applies)', () => {
    // B arrives directly as enforced on the node AND is implied with own-default
    // (advisory default). The direct enforced must win.
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a', 'b'], { b: 'enforced' });
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('b')).toBe('enforced');
  });
});

// ============================================================================
// 6. Draft implier does NOT propagate
// ============================================================================

describe('draft implier does not propagate implies', () => {
  it('A draft implies B → B not present (unless independently attached)', () => {
    const a = makeAspect('a', 'draft', { implies: ['b'] });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('a')).toBe('draft');
    expect(r.has('b')).toBe(false);
  });

  it('A draft via own but bumped to advisory via parent → now propagates B', () => {
    // A's effective status is advisory (parent bumps it), so it is no longer
    // draft and DOES propagate B.
    const a = makeAspect('a', 'draft', { implies: ['b'] });
    const b = makeAspect('b', 'draft');
    const parent = makeNode('p', 'module', ['a'], { a: 'advisory' });
    const child = makeNode('p/c', 'service', ['a']);
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([a, b], [parent, child]));
    expect(r.get('a')).toBe('advisory');
    expect(r.get('b')).toBe('advisory');
  });

  it('A draft implies B, B also attached directly advisory → B advisory (direct only)', () => {
    const a = makeAspect('a', 'draft', { implies: ['b'] });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a', 'b']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('b')).toBe('advisory');
  });
});

// ============================================================================
// 7. Multi-level implies chains
// ============================================================================

describe('multi-level implies chains', () => {
  it('A enforced → B(advisory) → C(draft), all strictest → all enforced', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'] });
    const b = makeAspect('b', 'advisory', { implies: ['c'] });
    const c = makeAspect('c', 'draft');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b, c], [node]));
    expect(r.get('a')).toBe('enforced');
    expect(r.get('b')).toBe('enforced');
    expect(r.get('c')).toBe('enforced');
  });

  it('chain breaks at draft node: A enforced → B own-default(draft) stops propagation to C', () => {
    // A enforced implies B own-default → B becomes draft. A draft B does not
    // propagate to C.
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'draft', { implies: ['c'] });
    const c = makeAspect('c', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b, c], [node]));
    expect(r.get('a')).toBe('enforced');
    expect(r.get('b')).toBe('draft');
    expect(r.has('c')).toBe(false);
  });

  it('mixed own-default mid-chain: A enf → B own-default(advisory) → C strictest(draft) → C advisory', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'advisory', { implies: ['c'] });
    const c = makeAspect('c', 'draft');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b, c], [node]));
    expect(r.get('a')).toBe('enforced');
    expect(r.get('b')).toBe('advisory');
    expect(r.get('c')).toBe('advisory');
  });

  it('all own-default chain keeps each at own default', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'advisory', { implies: ['c'], impliesStatusInherit: { c: 'own-default' } });
    const c = makeAspect('c', 'draft');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b, c], [node]));
    expect(r.get('a')).toBe('enforced');
    expect(r.get('b')).toBe('advisory');
    expect(r.get('c')).toBe('draft');
  });

  it('diamond implies: A→B, A→C, B→D, C→D — D gets strictest across both paths', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b', 'c'] });
    const b = makeAspect('b', 'advisory', { implies: ['d'], impliesStatusInherit: { d: 'own-default' } });
    const c = makeAspect('c', 'enforced', { implies: ['d'] }); // strictest → enforced wins
    const d = makeAspect('d', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b, c, d], [node]));
    // Via B (own-default): advisory. Via C (strictest, C=enforced): enforced. max → enforced.
    expect(r.get('d')).toBe('enforced');
  });
});

// ============================================================================
// 8. Implies fix-point: a later raise of the implier raises the implied too.
//    The monotone fix-point must re-propagate when an implier's status rises.
// ============================================================================

describe('implies fix-point re-propagation when implier rises', () => {
  it('B implied advisory first, then A bumps so B should be enforced — final B enforced', () => {
    // A is enforced via parent (bump) but advisory on own. A implies B strictest.
    // Effective A is enforced, so B must end enforced regardless of iteration order.
    const a = makeAspect('a', 'advisory', { implies: ['b'] });
    const b = makeAspect('b', 'advisory');
    const parent = makeNode('p', 'module', ['a'], { a: 'enforced' });
    const child = makeNode('p/c', 'service', ['a'], { a: 'advisory' });
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([a, b], [parent, child]));
    expect(r.get('a')).toBe('enforced');
    expect(r.get('b')).toBe('enforced');
  });

  it('long chain converges within fix-point bound (5 aspects)', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'] });
    const b = makeAspect('b', 'draft', { implies: ['c'] });
    const c = makeAspect('c', 'draft', { implies: ['d'] });
    const d = makeAspect('d', 'draft', { implies: ['e'] });
    const e = makeAspect('e', 'draft');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b, c, d, e], [node]));
    // strictest: enforced flows all the way down.
    expect(r.get('e')).toBe('enforced');
  });
});

// ============================================================================
// 9. `when` filters suppress a channel entirely (so it cannot contribute a status)
// ============================================================================

describe('when filters interact with strictest', () => {
  it('global when=false suppresses the aspect on every channel', () => {
    const aspect = { ...makeAspect('a', 'enforced'), when: FALSE_WHEN } as AspectDef;
    const node = makeNode('n', 'service', ['a'], { a: 'enforced' });
    const r = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node]));
    expect(r.has('a')).toBe(false);
  });

  it('attach-site when=false on the HIGHER channel drops it; the lower channel wins', () => {
    // Parent declares enforced but with attachWhen=false → suppressed. Own
    // declares advisory and passes. Effective = advisory.
    const aspect = makeAspect('a', 'advisory');
    const parent = makeNode('p', 'module', ['a'], { a: 'enforced' });
    parent.meta.aspectWhens = { a: FALSE_WHEN };
    const child = makeNode('p/c', 'service', ['a'], { a: 'advisory' });
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(r.get('a')).toBe('advisory');
  });

  it('attach-site when=true (matching) keeps the channel', () => {
    const aspect = makeAspect('a', 'advisory');
    const node = makeNode('n', 'service', ['a'], { a: 'enforced' });
    node.meta.aspectWhens = { a: whenType('service') };
    const r = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node]));
    expect(r.get('a')).toBe('enforced');
  });

  it('per-implies when=false drops the implied edge — B not propagated', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesWhens: { b: FALSE_WHEN } });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.has('b')).toBe(false);
  });

  it('implied aspect global when=false drops it even when implier passes', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'] });
    const b = { ...makeAspect('b', 'advisory'), when: FALSE_WHEN } as AspectDef;
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.has('b')).toBe(false);
  });
});

// ============================================================================
// 10. Many channels at once + comprehensive resolution
// ============================================================================

describe('all channels combined', () => {
  it('aspect arrives via 1/2/3/4/5/6 at mixed statuses → strictest overall', () => {
    const aspect = makeAspect('a', 'draft');
    const architecture: ArchitectureDef = {
      node_types: {
        module: { description: 'm', aspects: ['a'], aspectStatus: { a: 'draft' } }, // ch 4
        service: { description: 's', aspects: ['a'], aspectStatus: { a: 'advisory' } }, // ch 3
      },
    };
    const target: GraphNode = {
      path: 'svc',
      meta: { name: 'svc', type: 'service', ports: { p: { description: '', aspects: ['a'], aspectStatus: { a: 'enforced' } } } },
      children: [], parent: null,
    } as GraphNode;
    const parent = makeNode('p', 'module', ['a'], { a: 'draft' }); // ch 2
    const child = makeNode('p/c', 'service', ['a'], { a: 'advisory' }); // ch 1
    child.meta.relations = [{ target: 'svc', type: 'calls', portNames: ['p'] }]; // ch 6 enforced
    link(parent, child);
    const flow: FlowDef = { path: 'f', name: 'f', nodes: ['p'], aspects: ['a'], aspectStatus: { a: 'advisory' } } as FlowDef; // ch 5
    const r = computeEffectiveAspectStatuses(
      child,
      makeGraph([aspect], [parent, child, target], { flows: [flow], architecture }),
    );
    // Highest among draft/advisory/draft/draft/advisory/enforced = enforced (port).
    expect(r.get('a')).toBe('enforced');
  });

  it('all channels advisory, none enforced → advisory', () => {
    const aspect = makeAspect('a', 'advisory');
    const architecture: ArchitectureDef = {
      node_types: {
        module: { description: 'm', aspects: ['a'] },
        service: { description: 's', aspects: ['a'] },
      },
    };
    const parent = makeNode('p', 'module', ['a']);
    const child = makeNode('p/c', 'service', ['a']);
    link(parent, child);
    const flow: FlowDef = { path: 'f', name: 'f', nodes: ['p'], aspects: ['a'] } as FlowDef;
    const r = computeEffectiveAspectStatuses(
      child,
      makeGraph([aspect], [parent, child], { flows: [flow], architecture }),
    );
    expect(r.get('a')).toBe('advisory');
  });
});

// ============================================================================
// 11. Empty / degenerate inputs
// ============================================================================

describe('degenerate inputs', () => {
  it('node with no aspects and no ancestors → empty map', () => {
    const node = makeNode('n', 'service');
    const r = computeEffectiveAspectStatuses(node, makeGraph([], [node]));
    expect(r.size).toBe(0);
  });

  it('only-draft node → present as draft, not omitted', () => {
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([makeAspect('a', 'draft')], [node]));
    expect(r.get('a')).toBe('draft');
    expect(r.size).toBe(1);
  });

  it('two independent aspects keep their own statuses', () => {
    const node = makeNode('n', 'service', ['a', 'b']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([makeAspect('a', 'draft'), makeAspect('b', 'enforced')], [node]));
    expect(r.get('a')).toBe('draft');
    expect(r.get('b')).toBe('enforced');
  });
});

// ============================================================================
// 12. Cycle detection — implies fix-point must throw on a cycle.
// ============================================================================

describe('cycle handling in the implies fix-point', () => {
  it('a non-draft implies cycle converges without throwing or hanging', () => {
    // A(advisory) implies B, B(advisory) implies A — a genuine propagation cycle.
    // computeEffectiveAspectStatuses intentionally does NOT throw (it runs in
    // validation-path checks BEFORE the authoritative cycle detector). Its
    // monotone max-only fix-point saturates (both advisory) and returns. The
    // cyclic graph is rejected separately by the global validator with a
    // blocking aspect-implies-cycle error; computeEffectiveAspects (DFS) is the
    // one that throws, only on wrapped drift/approve paths.
    const a = makeAspect('a', 'advisory', { implies: ['b'] });
    const b = makeAspect('b', 'advisory', { implies: ['a'] });
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('a')).toBe('advisory');
    expect(r.get('b')).toBe('advisory');
  });
});
