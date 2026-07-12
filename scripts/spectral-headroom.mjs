#!/usr/bin/env node
// spectral-headroom (RZ-15) — DOGFOOD structural report. An OFFLINE, deterministic
// instrument that asks ONE question of the codebase's dependency graph: how much
// tighter is its natural module boundary than the directory layout it actually
// ships? Read-only — it NEVER writes the lock, any telemetry sidecar, or any graph
// file, and nothing it computes folds into any verdict hash. It is an OBSERVATION,
// never a gate: it always exits 0.
//
// WHAT: it takes the SAME structural edge universe `yg structure` reports (declared
// structural relations calls|uses|extends|implements ∪ statically detected code
// dependencies; event relations excluded), projects it to an undirected simple
// graph, keeps the giant connected component, and computes:
//   * the normalized-Laplacian second eigenvalue λ₂ and its Fiedler vector, via
//     deterministic power iteration (fixed seed, fixed iteration count, sorted
//     node-id tie-breaks — identical output on any host and across runs);
//   * φ*  — the tightest natural split's conductance, found by sweeping cut
//     positions along the Fiedler ordering and taking the minimum;
//   * φ(dir) — the conductance of each ACTUAL top-level-directory cut (nodes
//     partitioned by their first path segment);
//   * headroom = min_dir φ(dir) / φ*  — how many times looser the best
//     directory-aligned boundary is than the natural one.
//
// WHY: a low φ* beside much-higher directory cuts says the code has a cohesive
// natural module boundary the directory tree does not follow — a candidate for a
// human to look at, NOT a defect. Conductance rewards BALANCED cuts, so a small
// cohesive module legitimately scores low; that is a property of the metric, not a
// fault in the module.
//
// SINGLE SOURCE OF TRUTH: the edge universe is obtained by importing the built
// `computeStructuralEdgeUniverse` (source/cli/dist/structure-universe.js) — the very
// function the `yg structure` command runs (it loads the graph, runs the read-only
// relation pass through the portal facade, and unions detected edges with declared
// structural relations). There is no second, drifting graph reader here.
//
// BUILD DEPENDENCY: main() dynamic-imports the built accessor from
// source/cli/dist/, which in turn loads the built tree-sitter WASM grammars from
// source/cli/dist/grammars/. Run `npm run build` in source/cli first (the repo
// quality gate builds before it runs anything). The PURE analysis below has no such
// dependency and is unit-tested directly.
//
// USAGE:
//   node scripts/spectral-headroom.mjs        # analyze THIS repo and print the report

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const out = (m = '') => process.stdout.write(m + '\n');

// ---------------------------------------------------------------------------
// Deterministic spectral constants. NONE of these depend on the host, the wall
// clock, or any random source — the output is byte-identical on any machine and
// across repeated runs.
// ---------------------------------------------------------------------------

/**
 * Fixed number of power-iteration steps. The sweep cut only needs a good Fiedler
 * ORDERING (it scans every prefix and takes the minimum), which stabilizes well
 * before the eigenvalue itself; this count is generous for graphs of this repo's
 * scale and is a documented CONSTANT so the result never varies run to run.
 */
const POWER_ITERATIONS = 4000;

// ---------------------------------------------------------------------------
// Undirected projection + giant component (pure).
// ---------------------------------------------------------------------------

/**
 * Build an undirected simple graph over `nodeIds` from directed structural edges.
 * Self-edges are dropped and each unordered pair is counted once; only endpoints
 * that are themselves nodes participate.
 */
function buildUndirected(nodeIds, edges) {
  const nodes = [...new Set(nodeIds)].sort();
  const present = new Set(nodes);
  const adj = new Map();
  for (const id of nodes) adj.set(id, new Set());
  for (const e of edges) {
    const from = e.from;
    const to = e.to;
    if (from === to) continue;
    if (!present.has(from) || !present.has(to)) continue;
    adj.get(from).add(to);
    adj.get(to).add(from);
  }
  return { nodes, adj };
}

/**
 * The giant (largest) connected component of the undirected graph, returned as a
 * sorted node-id list. Deterministic: components are discovered in sorted-id order,
 * and on a size tie the earliest-discovered (smallest-min-id) component wins.
 */
function giantComponent(nodes, adj) {
  const seen = new Set();
  let best = [];
  for (const start of nodes) {
    if (seen.has(start)) continue;
    const comp = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const cur = queue.shift();
      comp.push(cur);
      for (const nb of [...adj.get(cur)].sort()) {
        if (!seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return best.sort();
}

// ---------------------------------------------------------------------------
// Normalized-Laplacian λ₂ + Fiedler vector via deterministic power iteration.
// ---------------------------------------------------------------------------

/**
 * Compute λ₂ (the second-smallest eigenvalue of the normalized Laplacian
 * L = I − D^{-1/2} A D^{-1/2}) and its Fiedler eigenvector, over the component
 * subgraph. Power-iterates the shifted operator M = 2I − L (whose largest
 * eigenvalue 2 belongs to the trivial vector d^{1/2}); deflating every step against
 * that trivial vector makes 2 − λ₂ dominant, so the iteration converges to the
 * Fiedler eigenvector. Fully deterministic: fixed centered-ramp seed, fixed step
 * count, sorted node order, and a canonical sign (the smallest-id entry is made
 * non-negative) so the returned numbers are reproducible, not merely a partition.
 */
function fiedlerOnAdj(compNodes, neighborsIdx) {
  const n = compNodes.length;
  const deg = neighborsIdx.map((nb) => nb.length);
  const sqrtDeg = deg.map((d) => Math.sqrt(d));

  // Trivial eigenvector u0 = d^{1/2}, normalized.
  const u0 = sqrtDeg.slice();
  const u0norm = Math.sqrt(u0.reduce((s, v) => s + v * v, 0));
  for (let i = 0; i < n; i++) u0[i] /= u0norm;

  const dot = (a, b) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  };
  const deflateAndNormalize = (x) => {
    const c = dot(x, u0);
    for (let i = 0; i < n; i++) x[i] -= c * u0[i];
    const nrm = Math.sqrt(dot(x, x));
    if (nrm > 0) for (let i = 0; i < n; i++) x[i] /= nrm;
    return nrm;
  };
  // M x = (2I − L) x ⇒ (Mx)[i] = x[i] + Σ_{j~i} x[j] / (√deg_i · √deg_j).
  const applyM = (x) => {
    const y = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = x[i];
      const si = sqrtDeg[i];
      for (const j of neighborsIdx[i]) s += x[j] / (si * sqrtDeg[j]);
      y[i] = s;
    }
    return y;
  };

  // Deterministic centered-ramp seed, then project out the trivial component.
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = i + 1 - (n + 1) / 2;
  deflateAndNormalize(x);

  let v = x;
  for (let it = 0; it < POWER_ITERATIONS; it++) {
    v = applyM(v);
    const nrm = deflateAndNormalize(v);
    if (nrm === 0) break; // degenerate; leave v as the last non-trivial direction
  }

  const rayleigh = dot(v, applyM(v)); // v is unit ⇒ Rayleigh quotient of M
  const lambda2 = 2 - rayleigh;

  // Canonical sign: make the smallest-id entry (index 0, compNodes is sorted)
  // non-negative so the numbers are reproducible.
  if (v[0] < 0) for (let i = 0; i < n; i++) v[i] = -v[i];

  const vec = {};
  for (let i = 0; i < n; i++) vec[compNodes[i]] = v[i];
  return { lambda2, vecArr: v, vec };
}

// ---------------------------------------------------------------------------
// Conductance, sweep cut, directory cuts (pure).
// ---------------------------------------------------------------------------

/**
 * Conductance of a node subset S within the component graph:
 *   φ(S) = cut(S, S̄) / min(vol(S), vol(S̄))
 * where cut counts boundary edges once and vol sums component degrees. Returns
 * null when a side is empty or has zero volume (no meaningful cut).
 */
function conductance(setIdx, neighborsIdx, deg, totalVol) {
  let volA = 0;
  let cut = 0;
  for (const i of setIdx) {
    volA += deg[i];
    for (const j of neighborsIdx[i]) if (!setIdx.has(j)) cut++;
  }
  const volB = totalVol - volA;
  const denom = Math.min(volA, volB);
  if (denom <= 0) return null;
  return cut / denom;
}

/**
 * Sweep cut: order the component nodes by Fiedler value (ascending; ties by node
 * id), and over every prefix cut take the minimum conductance → φ*. The reported
 * side is canonicalized to the one containing the smallest node id so it is stable.
 */
function sweepCut(compNodes, neighborsIdx, deg, totalVol, vecArr) {
  const n = compNodes.length;
  const order = compNodes.map((id, i) => i).sort((a, b) => {
    if (vecArr[a] !== vecArr[b]) return vecArr[a] - vecArr[b];
    return compNodes[a] < compNodes[b] ? -1 : 1;
  });

  let bestPhi = Infinity;
  let bestK = 0;
  const prefix = new Set();
  for (let k = 1; k < n; k++) {
    prefix.add(order[k - 1]);
    const phi = conductance(prefix, neighborsIdx, deg, totalVol);
    if (phi !== null && phi < bestPhi) {
      bestPhi = phi;
      bestK = k;
    }
  }

  const sideIdx = new Set(order.slice(0, bestK));
  // Canonical side: the one containing index 0 (the smallest-id node).
  const chosen = sideIdx.has(0) ? sideIdx : new Set(order.slice(bestK));
  const nodes = [...chosen].map((i) => compNodes[i]).sort();
  return { phiStar: bestPhi, nodes };
}

/**
 * Length of the longest whole-segment path prefix shared by EVERY id — the common
 * root the component sits under (e.g. all nodes under a single `cli/` root ⇒ 1).
 */
function commonPrefixLen(ids) {
  if (ids.length === 0) return 0;
  let parts = ids[0].split('/');
  let len = parts.length;
  for (const id of ids) {
    const p = id.split('/');
    let i = 0;
    while (i < len && i < p.length && p[i] === parts[i]) i++;
    len = i;
  }
  return len;
}

/**
 * Conductance of each ACTUAL top-level-directory cut. "Top-level directory" is the
 * first path segment that DISTINGUISHES the component's nodes — i.e. the segment
 * just past any path prefix shared by every component node. On a multi-root graph
 * (ids like `billing/…`, `orders/…`) the shared prefix is empty and this is exactly
 * the first path segment; on a graph whose component sits under one root (all ids
 * `cli/…`) it is the segment under that root (`cli/portal`, `cli/core`, …), the
 * genuine module boundary — a literal first segment would be a single degenerate
 * group with no cut to measure. For every directory that forms a proper subset
 * (0 < |S| < |component|) compute φ(S). Sorted tightest (lowest φ) first.
 */
function directoryCuts(compNodes, neighborsIdx, deg, totalVol) {
  const n = compNodes.length;
  const cpl = commonPrefixLen(compNodes);
  const byDir = new Map();
  compNodes.forEach((id, i) => {
    const dir = id.split('/').slice(0, cpl + 1).join('/');
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir).add(i);
  });
  const cuts = [];
  for (const [dir, setIdx] of byDir) {
    if (setIdx.size === 0 || setIdx.size === n) continue; // trivial: no cut
    const phi = conductance(setIdx, neighborsIdx, deg, totalVol);
    if (phi === null) continue;
    cuts.push({ dir, size: setIdx.size, conductance: phi });
  }
  cuts.sort((a, b) => {
    if (a.conductance !== b.conductance) return a.conductance - b.conductance;
    return a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0;
  });
  return cuts;
}

// ---------------------------------------------------------------------------
// Orchestration (pure) — the single entry the unit test drives.
// ---------------------------------------------------------------------------

/**
 * Run the full structural analysis over a node-id list and directed structural
 * edges. Returns plain data: the giant component, λ₂, the Fiedler vector, the
 * sweep-cut optimum φ*, the per-directory cut conductances, the tightest directory
 * cut, and the headroom ratio. Deterministic and byte-identical across runs.
 */
export function analyzeStructure(nodeIds, edges) {
  const { nodes, adj } = buildUndirected(nodeIds, edges);
  const componentNodes = giantComponent(nodes, adj);
  const componentSize = componentNodes.length;

  const base = {
    totalNodes: nodes.length,
    componentNodes,
    componentSize,
    lambda2: null,
    fiedler: {},
    phiStar: null,
    sweepCut: { nodes: [] },
    directoryCuts: [],
    minDir: null,
    headroom: null,
  };

  // No meaningful spectrum on a component of fewer than two nodes.
  if (componentSize < 2) return base;

  const index = new Map(componentNodes.map((id, i) => [id, i]));
  const neighborsIdx = componentNodes.map((id) =>
    [...adj.get(id)]
      .filter((nb) => index.has(nb))
      .map((nb) => index.get(nb))
      .sort((a, b) => a - b),
  );
  const deg = neighborsIdx.map((nb) => nb.length);
  const totalVol = deg.reduce((s, d) => s + d, 0);
  if (totalVol === 0) return base; // component has no internal edges

  const { lambda2, vecArr, vec } = fiedlerOnAdj(componentNodes, neighborsIdx);
  const sweep = sweepCut(componentNodes, neighborsIdx, deg, totalVol, vecArr);
  const cuts = directoryCuts(componentNodes, neighborsIdx, deg, totalVol);

  let minDir = null;
  for (const c of cuts) {
    if (minDir === null || c.conductance < minDir.conductance) {
      minDir = { dir: c.dir, conductance: c.conductance };
    }
  }
  const headroom =
    minDir !== null && sweep.phiStar > 0 ? minDir.conductance / sweep.phiStar : null;

  return {
    totalNodes: nodes.length,
    componentNodes,
    componentSize,
    lambda2,
    fiedler: vec,
    phiStar: sweep.phiStar,
    sweepCut: { nodes: sweep.nodes },
    directoryCuts: cuts,
    minDir,
    headroom,
  };
}

// ---------------------------------------------------------------------------
// Plain-language report (pure).
// ---------------------------------------------------------------------------

/** Verbatim RZ-15 label — printed on every run, no matter the numbers. */
const HONESTY_LABEL =
  'conductance rewards balanced cuts — a small cohesive module legitimately scores low; ' +
  'these are candidates for human eyes, never defects.';

const f3 = (x) => x.toFixed(3);

/** Render the analysis as the plain-language report (§6.6d). */
export function formatReport(r) {
  const lines = [];
  lines.push('spectral-headroom (RZ-15) — natural module boundary vs directory layout');
  lines.push('');
  lines.push(
    `  Graph: ${r.totalNodes} components; giant connected component ${r.componentSize}. ` +
      `Edges = declared structural relations ∪ statically detected dependencies; ` +
      `event relations excluded.`,
  );
  lines.push('');

  if (r.phiStar === null) {
    lines.push('  The giant component is too small to have a natural split — nothing to compare.');
    lines.push('');
    lines.push('— honesty label —');
    lines.push(`  ${HONESTY_LABEL}`);
    return lines.join('\n') + '\n';
  }

  if (r.minDir === null || r.headroom === null) {
    lines.push(
      `  The tightest natural split has conductance ${f3(r.phiStar)}. Every component ` +
        `node shares one top-level directory — no directory-aligned split to compare.`,
    );
  } else {
    const ratio = r.headroom.toFixed(1);
    const headroom = r.headroom.toFixed(2);
    lines.push(
      `  The tightest natural split has conductance ${f3(r.phiStar)}. The best ` +
        `directory-aligned split is ${f3(r.minDir.conductance)} (${r.minDir.dir}), ` +
        `${ratio}× looser — headroom ${headroom}.`,
    );
  }
  lines.push('');

  // Per-directory φ table (sorted by directory name), tightest marked.
  lines.push('  Directory cuts (φ, lower = tighter boundary):');
  if (r.directoryCuts.length === 0) {
    lines.push('    (none — the component spans a single top-level directory)');
  } else {
    const wDir = Math.max(...r.directoryCuts.map((c) => c.dir.length), 3);
    for (const c of r.directoryCuts) {
      const mark = r.minDir && c.dir === r.minDir.dir ? '  ← tightest' : '';
      const nodeWord = c.size === 1 ? 'node' : 'nodes';
      lines.push(
        `    ${c.dir.padEnd(wDir)}  φ ${f3(c.conductance)}  (${c.size} ${nodeWord})${mark}`,
      );
    }
  }
  lines.push('');
  lines.push('— honesty label —');
  lines.push(`  ${HONESTY_LABEL}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// main() — the ONLY impure part: pull the authoritative edge universe from the
// built CLI and print the report. Dynamic-imported so importing the pure functions
// (the unit test) loads nothing heavy and needs no built dist.
// ---------------------------------------------------------------------------

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distPath = path.resolve(here, '../source/cli/dist/structure-universe.js');
  const { computeStructuralEdgeUniverse } = await import(pathToFileURL(distPath).href);
  const { nodeIds, edges } = await computeStructuralEdgeUniverse(process.cwd());
  const result = analyzeStructure(nodeIds, edges);
  process.stdout.write(formatReport(result));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    // A genuine infrastructure failure (e.g. the built accessor is missing because
    // the project was not built) is reported to stderr; this observation script
    // still never gates, but it cannot fabricate a structural picture it could not
    // compute.
    process.stderr.write(`spectral-headroom: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
