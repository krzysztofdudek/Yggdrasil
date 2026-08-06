/**
 * graph-metrics — pure computation core for the `yg structure` instrument (C7).
 *
 * These are plain-data-in / plain-data-out functions: no I/O, no filesystem,
 * no console, no graph mutation, no randomness, no clock. The caller (the
 * `yg structure` command) is responsible for turning the loaded graph model
 * into the plain inputs below and for rendering the returned data.
 *
 * Only STRUCTURAL relation types participate in the edge universe:
 *   calls | uses | extends | implements
 * Event relation types (emits / listens) are deliberately excluded — they are
 * a different (asynchronous, decoupled) kind of dependency and would distort
 * the structural-coupling picture the instrument reports.
 *
 * Determinism: every returned collection is sorted by node id (edges by
 * (from, to); blocks by id; per-node maps inserted in sorted id order) so that
 * output never depends on Map/Set iteration order.
 */

/** The four structural relation types that form the edge universe. */
const STRUCTURAL_TYPES: ReadonlySet<string> = new Set([
  'calls',
  'uses',
  'extends',
  'implements',
]);

/** How a structural edge between two nodes came to exist. */
export type EdgeOrigin = 'declared' | 'detected' | 'both';

/** One structural edge in the deduped-per-pair universe. */
export interface StructEdge {
  from: string;
  to: string;
  /** True iff some declared relation for this pair carries a non-empty `consumes`. */
  viaContract: boolean;
  origin: EdgeOrigin;
}

/** A declared relation as loaded from a node's `yg-node.yaml` (plain data). */
export interface DeclaredRelation {
  from: string;
  to: string;
  type: string;
  consumes: string[];
}

// ---------------------------------------------------------------------------
// Hierarchy helpers — the path-segment math the instrument is defined against.
// Exposed so callers pass these exact functions as the injected callbacks below
// (single source of truth for the hierarchy semantics; no divergent copies).
// ---------------------------------------------------------------------------

/** Depth of a node = number of `/`-separated path segments. `a/b/c` → 3. */
export function depthOfPath(id: string): number {
  return id.split('/').length;
}

/**
 * Depth of the lowest common ancestor of two nodes = number of shared leading
 * whole path segments. Whole-segment only: `ab` is not a prefix of `abc`.
 */
export function lcaDepthOfPaths(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  const limit = Math.min(as.length, bs.length);
  let shared = 0;
  for (let i = 0; i < limit; i++) {
    if (as[i] !== bs[i]) break;
    shared++;
  }
  return shared;
}

/**
 * The ancestor of `id` at depth `d` = the first `d` path segments joined back.
 * A depth at or beyond the node's own depth returns the whole id.
 */
export function ancestorAtDepth(id: string, d: number): string {
  return id.split('/').slice(0, d).join('/');
}

// ---------------------------------------------------------------------------
// edgeUniverse
// ---------------------------------------------------------------------------

/** Stable comparator: order by `from`, then `to` (code-point order). */
function byFromTo(
  a: { from: string; to: string },
  b: { from: string; to: string },
): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  return 0;
}

const pairKey = (from: string, to: string): string => `${from}\u0000${to}`;

interface PairAccumulator {
  from: string;
  to: string;
  declaredStructural: boolean;
  detected: boolean;
  viaContract: boolean;
}

/**
 * The structural edge universe: structural declared relations ∪ detected edges,
 * deduped per node pair. Event relation types are excluded. `origin` reflects
 * whether the pair is declared-only, detected-only, or both; `viaContract` is
 * true iff any declared relation for the pair carries a non-empty `consumes`.
 * Result is sorted by (from, to).
 */
export function edgeUniverse(
  declared: DeclaredRelation[],
  detected: Map<string, Set<string>>,
): StructEdge[] {
  const pairs = new Map<string, PairAccumulator>();

  const ensure = (from: string, to: string): PairAccumulator => {
    const key = pairKey(from, to);
    let acc = pairs.get(key);
    if (acc === undefined) {
      acc = { from, to, declaredStructural: false, detected: false, viaContract: false };
      pairs.set(key, acc);
    }
    return acc;
  };

  // Declared relations. `viaContract` folds in every declared relation for the
  // pair (a port is consumed via its declaring relation); structural presence
  // is tracked separately so an event-only declared pair never becomes an
  // origin of 'declared'/'both'.
  for (const rel of declared) {
    const structural = STRUCTURAL_TYPES.has(rel.type);
    const hasConsumes = rel.consumes.length > 0;
    if (!structural && !hasConsumes) continue; // event with no port — irrelevant
    const acc = ensure(rel.from, rel.to);
    if (structural) acc.declaredStructural = true;
    if (hasConsumes) acc.viaContract = true;
  }

  // A pair recorded only because an event relation carried `consumes` but has
  // no structural declared edge and no detected edge is not part of the
  // structural universe — drop it below via the origin check.

  // Detected edges.
  for (const [from, targets] of detected) {
    for (const to of targets) {
      ensure(from, to).detected = true;
    }
  }

  const out: StructEdge[] = [];
  for (const acc of pairs.values()) {
    let origin: EdgeOrigin;
    if (acc.declaredStructural && acc.detected) origin = 'both';
    else if (acc.declaredStructural) origin = 'declared';
    else if (acc.detected) origin = 'detected';
    else continue; // consumes-only-on-event pair: not a structural edge
    out.push({ from: acc.from, to: acc.to, viaContract: acc.viaContract, origin });
  }

  out.sort(byFromTo);
  return out;
}

// ---------------------------------------------------------------------------
// tunnelSpans
// ---------------------------------------------------------------------------

/**
 * How many of the widest-spanning tunnels the structural view LISTS — and thus
 * the exact count the advise attention line reports. Shared here as the single
 * source of truth so `yg structure`'s displayed tunnel count and `yg advise`'s
 * attention count can never drift out of step: both slice / cap the tunnel set to
 * this same N.
 */
export const TOP_TUNNELS = 10;

/**
 * Annotate each edge with its hierarchy `span`:
 *   span = depth(from) + depth(to) − 2·lcaDepth(from, to)
 * i.e. the number of hierarchy hops the edge traverses (0 for siblings' parent,
 * larger for edges that reach across distant subtrees). Sorted by (from, to).
 */
export function tunnelSpans(
  edges: StructEdge[],
  depthOf: (id: string) => number,
  lcaDepth: (a: string, b: string) => number,
): Array<StructEdge & { span: number }> {
  return [...edges]
    .sort(byFromTo)
    .map((e) => ({
      ...e,
      span: depthOf(e.from) + depthOf(e.to) - 2 * lcaDepth(e.from, e.to),
    }));
}

/**
 * Depth/LCA functions for a WIDENED universe, where some edge endpoints are real
 * architecture-node ids (measured by their true hierarchy depth) and others are
 * type-covered file paths that happen to share the same `/`-delimited string
 * space but carry no architecture position of their own. `depthOfPath` on a file
 * id would instead measure its INCIDENTAL directory nesting — a different, and
 * typically much deeper, unit than a node's hierarchy depth (a real project's
 * node ids stay shallow by design; its source tree does not). Ranking spans
 * computed from the two units side by side lets filesystem nesting alone
 * outrank a genuine architectural tunnel, which is exactly the confusion the
 * tunnels section must not present.
 *
 * A file id (anything not in `realNodeIds`) is fixed at depth 1 — the shallowest
 * meaningful level, the same as any bare top-level node — rather than its raw
 * segment count. Its LCA with anything is capped at `min(depthOf(a), depthOf(b))`
 * so the span formula never goes negative (an LCA can never exceed either
 * endpoint's own depth). When every id in play belongs to `realNodeIds` this
 * reduces to exactly `depthOfPath` / `lcaDepthOfPaths` — byte-identical spans to
 * the node-only universe.
 */
export function widenedTunnelMetrics(realNodeIds: ReadonlySet<string>): {
  depthOf: (id: string) => number;
  lcaDepth: (a: string, b: string) => number;
} {
  const depthOf = (id: string): number => (realNodeIds.has(id) ? depthOfPath(id) : 1);
  const lcaDepth = (a: string, b: string): number =>
    Math.min(depthOf(a), depthOf(b), lcaDepthOfPaths(a, b));
  return { depthOf, lcaDepth };
}

/**
 * Rank edges by hierarchy span, widest first, ties broken by (from, to) —
 * the SAME ranking both `yg structure` and the portal's structure panel apply
 * before slicing to `TOP_TUNNELS`, so the two surfaces can never compute the
 * tunnels ranking two different ways.
 */
export function rankTunnels(
  edges: StructEdge[],
  depthOf: (id: string) => number,
  lcaDepth: (a: string, b: string) => number,
): Array<StructEdge & { span: number }> {
  const spanned = tunnelSpans(edges, depthOf, lcaDepth);
  return [...spanned].sort((a, b) => {
    if (b.span !== a.span) return b.span - a.span;
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// quotientAtDepth
// ---------------------------------------------------------------------------

/** A hierarchy quotient of the structural graph collapsed to a fixed depth. */
export interface QuotientView {
  depth: number;
  /** Distinct depth-d blocks touched by the edges, sorted by id. */
  blocks: string[];
  /** Distinct inter-block edges (from-block ≠ to-block), sorted by (from, to). */
  interBlockEdges: Array<{ from: string; to: string }>;
  /**
   * Share of inter-block edges that connect two DIFFERENT strongly-connected
   * components of the quotient graph (i.e. are not part of a quotient cycle).
   * 1.0 when the quotient is acyclic; 0.0 when every crossing edge is inside a
   * cycle; 0 when there are no inter-block edges.
   */
  sccOutsideShare: number;
}

/**
 * Collapse each node to its depth-`d` ancestor and describe the resulting
 * quotient graph: the blocks, the distinct inter-block edges, and the fraction
 * of those edges that cross between distinct SCCs of the quotient.
 */
export function quotientAtDepth(
  edges: StructEdge[],
  depth: number,
  ancestorAt: (id: string, d: number) => string,
): QuotientView {
  const blockSet = new Set<string>();
  const interKeys = new Set<string>();
  const interBlockEdges: Array<{ from: string; to: string }> = [];

  for (const e of edges) {
    const bf = ancestorAt(e.from, depth);
    const bt = ancestorAt(e.to, depth);
    blockSet.add(bf);
    blockSet.add(bt);
    if (bf === bt) continue; // intra-block: collapses to a self-loop, dropped
    const key = pairKey(bf, bt);
    if (interKeys.has(key)) continue;
    interKeys.add(key);
    interBlockEdges.push({ from: bf, to: bt });
  }

  const blocks = [...blockSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  interBlockEdges.sort(byFromTo);

  const sccOutsideShare = computeSccOutsideShare(blocks, interBlockEdges);

  return { depth, blocks, interBlockEdges, sccOutsideShare };
}

/**
 * The strongly-connected components of the block graph (blocks + inter-block
 * edges), each returned as an array of block ids. Runs the iterative Tarjan SCC
 * over the block graph — the SINGLE source of truth for "which quotient blocks
 * form a cycle", shared by the cycle statistic below and by any caller that needs
 * the cyclic groups themselves (e.g. the advise architecture-cut nomination).
 *
 * Deterministic: adjacency is built in `edges` order then sorted ascending, each
 * component's members are sorted, and the components are sorted by their smallest
 * member — so the result never depends on Map/Set iteration order. A component of
 * size ≥ 2 is a cycle (its blocks are mutually reachable); a size-1 component is
 * acyclic (self-loops never occur — the quotient drops intra-block edges).
 */
export function quotientSccs(
  blocks: string[],
  edges: Array<{ from: string; to: string }>,
): string[][] {
  const index = new Map<string, number>();
  blocks.forEach((b, i) => index.set(b, i));

  // Sorted adjacency (neighbor indices ascending) for deterministic traversal.
  const adj: number[][] = blocks.map(() => []);
  for (const e of edges) {
    const u = index.get(e.from);
    const v = index.get(e.to);
    if (u === undefined || v === undefined) continue;
    adj[u].push(v);
  }
  for (const list of adj) list.sort((a, b) => a - b);

  const comp = tarjanScc(blocks.length, adj);

  // Group block ids by component id, then canonicalize (sorted members; groups
  // sorted by first member) so the output is order-independent.
  const groups = new Map<number, string[]>();
  for (let i = 0; i < blocks.length; i++) {
    const c = comp[i];
    let g = groups.get(c);
    if (g === undefined) {
      g = [];
      groups.set(c, g);
    }
    g.push(blocks[i]);
  }
  const out = [...groups.values()].map((g) => [...g].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

/**
 * Fraction of the given inter-block edges whose endpoints land in DIFFERENT
 * strongly-connected components. Reuses `quotientSccs` (the shared Tarjan) so the
 * cycle statistic and the cyclic-group enumeration can never disagree. Returns 0
 * when there are no edges.
 */
function computeSccOutsideShare(
  blocks: string[],
  edges: Array<{ from: string; to: string }>,
): number {
  if (edges.length === 0) return 0;

  const compOf = new Map<string, number>();
  quotientSccs(blocks, edges).forEach((group, ci) => {
    for (const b of group) compOf.set(b, ci);
  });

  let outside = 0;
  for (const e of edges) {
    const cf = compOf.get(e.from);
    const ct = compOf.get(e.to);
    if (cf === undefined || ct === undefined) continue;
    if (cf !== ct) outside++;
  }
  return outside / edges.length;
}

/**
 * Iterative Tarjan strongly-connected-components. Returns an array mapping each
 * node index to its component id. Deterministic given sorted adjacency: nodes
 * are visited in ascending index order and neighbors in ascending order.
 */
function tarjanScc(n: number, adj: number[][]): number[] {
  const UNVISITED = -1;
  const idx = new Array<number>(n).fill(UNVISITED);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const comp = new Array<number>(n).fill(UNVISITED);
  const stack: number[] = [];
  let counter = 0;
  let compCount = 0;

  for (let start = 0; start < n; start++) {
    if (idx[start] !== UNVISITED) continue;

    // Explicit work stack of (node, next-neighbor-cursor) frames.
    const work: Array<{ v: number; ci: number }> = [{ v: start, ci: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame.v;

      if (frame.ci === 0) {
        idx[v] = counter;
        low[v] = counter;
        counter++;
        stack.push(v);
        onStack[v] = true;
      }

      let recursed = false;
      while (frame.ci < adj[v].length) {
        const w = adj[v][frame.ci];
        frame.ci++;
        if (idx[w] === UNVISITED) {
          work.push({ v: w, ci: 0 });
          recursed = true;
          break;
        } else if (onStack[w]) {
          if (idx[w] < low[v]) low[v] = idx[w];
        }
      }
      if (recursed) continue;

      // All neighbors processed: fold child low-links, then maybe close a root.
      if (low[v] === idx[v]) {
        for (;;) {
          const w = stack.pop() as number;
          onStack[w] = false;
          comp[w] = compCount;
          if (w === v) break;
        }
        compCount++;
      }

      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].v;
        if (low[v] < low[parent]) low[parent] = low[v];
      }
    }
  }

  return comp;
}

// ---------------------------------------------------------------------------
// changeReach
// ---------------------------------------------------------------------------

/**
 * Forward-closure change reach: for each node, the fraction of OTHER nodes it
 * can reach by following structural edges forward, and the mean of that
 * fraction across all nodes. `perNode` is inserted in sorted node-id order so
 * iteration is deterministic. With ≤ 1 node every value is 0 (no other nodes).
 *
 * Assumes every edge endpoint is a member of `nodeIds` (the caller passes the
 * structural universe over these same nodes); given that, a per-node fraction
 * can never exceed 1.
 */
export function changeReach(
  edges: StructEdge[],
  nodeIds: string[],
): { mean: number; perNode: Map<string, number> } {
  const sortedIds = [...nodeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = sortedIds.length;

  // Forward adjacency keyed by node id.
  const out = new Map<string, string[]>();
  for (const e of edges) {
    let list = out.get(e.from);
    if (list === undefined) {
      list = [];
      out.set(e.from, list);
    }
    list.push(e.to);
  }

  const perNode = new Map<string, number>();
  if (n <= 1) {
    for (const id of sortedIds) perNode.set(id, 0);
    return { mean: 0, perNode };
  }

  let sum = 0;
  for (const start of sortedIds) {
    // BFS/DFS forward closure excluding the start node itself.
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      const nexts = out.get(cur);
      if (nexts === undefined) continue;
      for (const nx of nexts) {
        if (nx === start) continue;
        if (seen.has(nx)) continue;
        seen.add(nx);
        queue.push(nx);
      }
    }
    const fraction = seen.size / (n - 1);
    perNode.set(start, fraction);
    sum += fraction;
  }

  return { mean: sum / n, perNode };
}
