import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Wrap the REAL relation pass so a single portal render's pass count can be measured — the
// ≤2-pass invariant (runCheck's relation-conformance pass + the boundary pass, and NO third).
// `vi.fn(actual.runRelationPass)` still runs the genuine parse (no fabricated data): this is a
// COUNTER around the real function, not a stand-in for it.
vi.mock('../../src/relations/pass.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/relations/pass.js')>();
  return { ...actual, runRelationPass: vi.fn(actual.runRelationPass) };
});

import { runRelationPass } from '../../src/relations/pass.js';
import { extractPortalData } from '../../src/portal/extract.js';
import { deriveStructure, REACH_CAPTION_MIN_NODES, type StructureTypeWidening } from '../../src/portal/derive-metrics.js';
import { renderStructure, cyclePhrase } from '../../src/cli/structure.js';
import { loadGraph } from '../../src/core/graph-loader.js';
import { computeDetectedEdges, computeTypedEdges } from '../../src/portal/api/boundary.js';
import { walkRepoFiles } from '../../src/io/repo-scanner.js';
import { scanUncoveredFiles } from '../../src/core/check.js';
import { computeTypeCoverage } from '../../src/core/type-coverage.js';
import { FileContentCache } from '../../src/io/file-content-cache.js';
import type { PortalData, PortalStructure } from '../../src/portal/contract.js';
import type { Graph } from '../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The REAL repo root (real .yggdrasil/ graph + real source). tests/integration → cli → source → repo.
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** A minimal Graph carrying only what deriveStructure reads: node ids + declared relations. */
function graphOf(
  nodeIds: string[],
  relations: Record<string, Array<{ target: string; type: string; consumes?: string[] }>> = {},
): Graph {
  const nodes = new Map<string, unknown>();
  for (const id of nodeIds) nodes.set(id, { meta: { relations: relations[id] ?? [] } });
  return { nodes } as unknown as Graph;
}

// ── deriveStructure — pure, hand-built plain-data fixtures (no repo, no I/O) ─────────────────

describe('deriveStructure — honest UNKNOWN on a null (thrown) relation parse', () => {
  it('renders an explicit unknown state, never a fabricated zero graph', () => {
    // A 3-node graph WITH declared relations is available, but the detected half is null (parse
    // threw). The panel must say "unknown", not fabricate an all-declared graph.
    const graph = graphOf(['a', 'a/x', 'b'], { 'a/x': [{ target: 'b', type: 'uses' }] });
    const s = deriveStructure(graph, null);
    expect(s.unknown).toBe(true);
    expect(s.edgeCount).toBe(0);
    expect(s.tunnels).toEqual([]);
    expect(s.layers).toEqual([]);
    expect(s.reachMean).toBe(0);
  });
});

describe('deriveStructure — small-N floor suppresses the interpretive caption (raw numbers stay)', () => {
  it('flags smallGraph below the node-count floor while still reporting the raw figures', () => {
    // 3 nodes < REACH_CAPTION_MIN_NODES → the "average component" sentence is not meaningful,
    // so smallGraph is true; the raw edge count and reach fraction are still present.
    const graph = graphOf(['a', 'a/x', 'b'], { 'a/x': [{ target: 'b', type: 'calls' }] });
    const s = deriveStructure(graph, []);
    expect(REACH_CAPTION_MIN_NODES).toBeGreaterThan(3);
    expect(s.unknown).toBe(false);
    expect(s.smallGraph).toBe(true);
    expect(s.nodeCount).toBe(3);
    expect(s.edgeCount).toBe(1); // a/x → b (declared, structural)
    expect(typeof s.reachMean).toBe('number');
    expect(s.reachMean).toBeGreaterThan(0); // a/x reaches b
  });
});

describe('deriveStructure — a normal (above-floor) graph with a cross-tree dependency', () => {
  // 11 nodes (≥ floor). Two declared structural edges reach across distant subtrees; one detected
  // edge lives elsewhere. The widest span must rank first.
  const nodeIds = ['a', 'a/x', 'a/x/y', 'b', 'b/p', 'b/p/q', 'c', 'd', 'e', 'f', 'g'];
  const graph = graphOf(nodeIds, {
    'a/x/y': [{ target: 'b/p/q', type: 'uses' }], // span 6 — the deepest cross-tree tunnel
    'a/x': [{ target: 'b/p', type: 'calls', consumes: ['port'] }], // span 4, via a declared contract
  });
  // Detected-only edge (the flattened seam shape): c → d.
  const detected = [{ from: 'c', targets: ['d'] }];
  const s: PortalStructure = deriveStructure(graph, detected);

  it('is not unknown and not small-N', () => {
    expect(s.unknown).toBe(false);
    expect(s.smallGraph).toBe(false);
    expect(s.nodeCount).toBe(11);
  });

  it('ranks tunnels widest-span first, in plain-data form', () => {
    expect(s.edgeCount).toBe(3);
    expect(s.tunnels.length).toBe(3);
    expect(s.tunnels[0].from).toBe('a/x/y');
    expect(s.tunnels[0].to).toBe('b/p/q');
    expect(s.tunnels[0].span).toBe(6);
    expect(s.tunnels[0].origin).toBe('declared');
    expect(s.tunnels[0].viaContract).toBe(false);
    // Spans are non-increasing down the list (the ranking the panel reads).
    for (let i = 1; i < s.tunnels.length; i++) {
      expect(s.tunnels[i].span).toBeLessThanOrEqual(s.tunnels[i - 1].span);
    }
    // The port-contract-backed edge is flagged as such.
    const contractEdge = s.tunnels.find((t) => t.from === 'a/x' && t.to === 'b/p');
    expect(contractEdge?.viaContract).toBe(true);
    // The detected-only edge carries the detected origin.
    const detectedEdge = s.tunnels.find((t) => t.from === 'c' && t.to === 'd');
    expect(detectedEdge?.origin).toBe('detected');
  });

  it('reports module-group layers per depth (only depths with 2+ groups)', () => {
    expect(s.layers.length).toBeGreaterThan(0);
    for (const layer of s.layers) {
      expect(layer.groups.length).toBeGreaterThanOrEqual(2);
      expect(layer.crossings).toBeGreaterThan(0);
      expect(layer.loopShare).toBeGreaterThanOrEqual(0);
      expect(layer.loopShare).toBeLessThanOrEqual(1);
    }
  });

  it('reports a mean forward-reach fraction in [0, 1]', () => {
    expect(s.reachMean).toBeGreaterThan(0);
    expect(s.reachMean).toBeLessThanOrEqual(1);
  });

  it('is fully JSON-flat: no Map/Set survives a JSON round-trip (deep-equal)', () => {
    // The JSON seam is safeJsonForScript(JSON.stringify). A Map/Set would serialize to `{}` and
    // break this deep-equal — so the structure must already be plain arrays/objects.
    const roundTripped = JSON.parse(JSON.stringify(s));
    expect(roundTripped).toEqual(s);
  });
});

// ── extractPortalData on the REAL repo — the ≤2-pass invariant + the live structure panel ────

describe('portal structure panel — real repo, ≤2 relation passes, JSON-flat seam', () => {
  let data: PortalData;
  let passCalls: number;

  beforeAll(async () => {
    vi.mocked(runRelationPass).mockClear();
    data = await extractPortalData(REPO_ROOT, { writeEnabled: false });
    passCalls = vi.mocked(runRelationPass).mock.calls.length;
  }, 180_000);

  it('runs the relation pass AT MOST twice across one full render (reuses the boundary pass)', () => {
    // runCheck's live relation-conformance pass + the boundary pass = 2. The structure panel
    // reuses the boundary pass's detected-edge set, so it adds NO third pass.
    expect(passCalls).toBeGreaterThanOrEqual(1); // the pass really ran (not a silent no-op)
    expect(passCalls).toBeLessThanOrEqual(2);
  });

  it('carries a live structure panel (not unknown) on the real repo', () => {
    expect(data.structure.unknown).toBe(false);
    expect(data.structure.nodeCount).toBe(data.meta.counts.nodes);
    expect(data.structure.smallGraph).toBe(false); // the real repo is well above the floor
    expect(data.structure.edgeCount).toBeGreaterThan(0);
    expect(data.structure.tunnels.length).toBeGreaterThan(0);
    expect(data.structure.layers.length).toBeGreaterThan(0);
    expect(data.structure.reachMean).toBeGreaterThan(0);
    expect(data.structure.reachMean).toBeLessThanOrEqual(1);
  });

  it('the structure panel round-trips through JSON.stringify losslessly (no Map/Set at the seam)', () => {
    const roundTripped = JSON.parse(JSON.stringify(data.structure));
    expect(roundTripped).toEqual(data.structure);
  });

  it('tunnels are ranked widest-span first and name real graph nodes', () => {
    const paths = new Set(data.nodes.map((n) => n.path));
    for (let i = 0; i < data.structure.tunnels.length; i++) {
      const t = data.structure.tunnels[i];
      expect(paths.has(t.from)).toBe(true);
      expect(paths.has(t.to)).toBe(true);
      if (i > 0) expect(t.span).toBeLessThanOrEqual(data.structure.tunnels[i - 1].span);
    }
  });
});

// ── portal ↔ `yg structure` PARITY — the drift guard for the verbatim-duplicated feeders ─────
//
// `portal/derive-metrics.deriveStructure` and the `yg structure` command (`cli/structure.ts`)
// each carry their OWN verbatim copy of `isLineage` and `collectDeclaredRelations`, and each
// renders tunnels / module groups / change reach independently. The product promise — "the
// portal shows the same picture as `yg structure`" — rests on those copies staying identical.
// This test binds them: on ONE real fixture graph with ONE shared detected-edge set it drives
// BOTH feeders and asserts the structured portal output matches the rendered command output. A
// future drift in either copy (a diverged lineage filter, a changed ranking, a reworded module
// block) makes the two pictures disagree and fails here.

const SAMPLE_FIXTURE = path.resolve(__dirname, '../fixtures/sample-project');

/** Parse the command's rendered tunnel lines into `{ from, to, span }`, in printed order. */
function parseTunnels(text: string): Array<{ from: string; to: string; span: number }> {
  const out: Array<{ from: string; to: string; span: number }> = [];
  for (const line of text.split('\n')) {
    const m = /^ {2}(\S+) → (\S+) — jumps (\d+) levels? across the tree, /.exec(line);
    if (m) out.push({ from: m[1], to: m[2], span: Number(m[3]) });
  }
  return out;
}

/** Parse the command's rendered module blocks (one per printed depth), in order. */
function parseModuleBlocks(
  text: string,
): Array<{ depth: number; groupCount: number; groupNames: string; crossings: number; cyclePhraseLine: string }> {
  const lines = text.split('\n');
  const out: Array<{ depth: number; groupCount: number; groupNames: string; crossings: number; cyclePhraseLine: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const dm = /^ {2}At depth (\d+):$/.exec(lines[i]);
    if (!dm) continue;
    const gm = /^ {4}(\d+) groups?: (.+)$/.exec(lines[i + 1] ?? '');
    const cm = /^ {4}(\d+) (?:dependency|dependencies) between groups$/.exec(lines[i + 2] ?? '');
    out.push({
      depth: Number(dm[1]),
      groupCount: gm ? Number(gm[1]) : NaN,
      groupNames: gm ? gm[2] : '',
      crossings: cm ? Number(cm[1]) : NaN,
      cyclePhraseLine: (lines[i + 3] ?? '').replace(/^ {4}/, ''),
    });
  }
  return out;
}

/** Parse the command's change-reach percentage (the same integer `Math.round` the panel derives). */
function parseReachPct(text: string): number {
  const m = /From an average component, (\d+)% of the system is reachable through dependencies\./.exec(text);
  return m ? Number(m[1]) : NaN;
}

describe.skipIf(!existsSync(SAMPLE_FIXTURE))(
  'portal ↔ yg structure parity — same graph, same detected edges, one picture',
  () => {
    let tmp: string;
    let s: PortalStructure;
    let text: string;

    beforeAll(async () => {
      // Copy to a temp dir so the relation pass's symbol cache never touches the committed fixture.
      tmp = mkdtempSync(path.join(tmpdir(), 'yg-structure-parity-'));
      cpSync(SAMPLE_FIXTURE, tmp, { recursive: true });
      const graph = await loadGraph(tmp);
      const projectRoot = path.dirname(graph.rootPath);
      const detectedMap =
        (await computeDetectedEdges(graph, projectRoot)) ?? new Map<string, Set<string>>();
      // The SAME detected edges, in each feeder's own shape — the portal takes the flattened seam
      // form, the command takes the Map — so the only remaining variable is the duplicated code.
      const detectedFlat = [...detectedMap].map(([from, targetSet]) => ({
        from,
        targets: [...targetSet],
      }));
      s = deriveStructure(graph, detectedFlat);
      text = renderStructure(graph, detectedMap);
    }, 60_000);

    afterAll(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    it('the fixture actually exercises tunnels and module groups (the guard is not vacuous)', () => {
      expect(s.unknown).toBe(false);
      expect(s.tunnels.length).toBeGreaterThan(0);
      expect(s.layers.length).toBeGreaterThan(0);
    });

    it('tunnels match — same ranked list of (from, to, span) in the same order', () => {
      expect(parseTunnels(text)).toEqual(
        s.tunnels.map((t) => ({ from: t.from, to: t.to, span: t.span })),
      );
    });

    it('change reach matches — the panel and the command round the same mean identically', () => {
      expect(parseReachPct(text)).toBe(Math.round(s.reachMean * 100));
    });

    it('module groups match — same depths, group counts/names, crossings, and loop/cycle share', () => {
      const blocks = parseModuleBlocks(text);
      expect(blocks.length).toBe(s.layers.length);
      for (let i = 0; i < s.layers.length; i++) {
        const layer = s.layers[i];
        expect(blocks[i].depth).toBe(layer.depth);
        expect(blocks[i].groupCount).toBe(layer.groups.length);
        expect(blocks[i].crossings).toBe(layer.crossings);
        // Group names are printed in full below the collapse threshold — compare them directly then.
        if (!blocks[i].groupNames.includes('(+')) {
          expect(blocks[i].groupNames).toBe(layer.groups.join(', '));
        }
        // The rendered cycle sentence must be exactly what the command's own phrasing produces from
        // the panel's loopShare — binding the loop-share value across the two surfaces.
        expect(blocks[i].cyclePhraseLine).toBe(cyclePhrase(layer.crossings, 1 - layer.loopShare));
      }
    });
  },
);

// ── portal ↔ `yg structure` PARITY, at coverage.type_level ON ────────────────────────────────
//
// The parity block above proves the two surfaces agree on the NODE-ONLY universe. It says
// nothing about the WIDENED one: `deriveStructure`'s `widened` parameter and `renderStructure`'s
// `widened` parameter are each assembled by their own caller (the pipeline's `extractPortalData`
// vs the command's `computeTypeWidening`) from the SAME underlying facade call
// (`computeTypedEdges` / `computePortalTypedEdges` — one function, two re-export names), through
// the SAME ranking (`widenedTunnelMetrics` / `rankTunnels`, shared in `core/graph-metrics.ts`).
// This binds the two callers directly: feed both the identical widening and assert the rendered
// picture and the structured one still agree — a type-covered file's tunnels, node count, and
// reach wording included.

const RELATION_GATE_FIXTURE = path.resolve(__dirname, '../fixtures/type-relation-gate');

describe.skipIf(!existsSync(RELATION_GATE_FIXTURE))(
  'portal ↔ yg structure parity — the type-level widening (coverage.type_level on)',
  () => {
    let tmp: string;
    let s: PortalStructure;
    let text: string;

    beforeAll(async () => {
      tmp = mkdtempSync(path.join(tmpdir(), 'yg-structure-parity-typecov-'));
      cpSync(RELATION_GATE_FIXTURE, tmp, { recursive: true });
      const graph = await loadGraph(tmp);
      const projectRoot = path.dirname(graph.rootPath);
      const detectedMap = (await computeDetectedEdges(graph, projectRoot)) ?? new Map<string, Set<string>>();
      const detectedFlat = [...detectedMap].map(([from, targetSet]) => ({ from, targets: [...targetSet] }));

      // The SAME type-level widening each surface computes independently through its own
      // permitted facade call — computeTypedEdges (structure.ts) and computePortalTypedEdges
      // (the portal pipeline) are the identical underlying function, seeded with the identical
      // classification here, so the only remaining variable under test is the two callers' own
      // assembly and rendering.
      const files = await walkRepoFiles(projectRoot);
      const uncovered = scanUncoveredFiles(graph, files);
      const coverage = await computeTypeCoverage(graph, uncovered, new FileContentCache());
      const typedEdges = await computeTypedEdges(graph, projectRoot, coverage.covered);
      const widened: StructureTypeWidening = { edges: typedEdges, nodeIds: [...coverage.covered.keys()] };

      s = deriveStructure(graph, detectedFlat, widened);
      text = renderStructure(graph, detectedMap, { ...widened, hasTypeCovered: widened.nodeIds.length > 0 });
    }, 60_000);

    afterAll(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    it('the widening actually adds a type-covered file to the universe (the guard is not vacuous)', () => {
      expect(s.hasTypeCovered).toBe(true);
      expect(s.tunnels.length).toBeGreaterThan(0);
      expect(s.nodeCount).toBeGreaterThan(1); // more than the fixture's one real node ("owner")
    });

    it('tunnels match — same ranked list of (from, to, span) in the same order, type-covered file endpoints included', () => {
      expect(parseTunnels(text)).toEqual(
        s.tunnels.map((t) => ({ from: t.from, to: t.to, span: t.span })),
      );
    });

    it('node count and change reach match, with the widened "component or type-covered file" wording on the rendered side', () => {
      expect(text).toContain('From an average component or type-covered file,');
      const reachMatch = /From an average component or type-covered file, (\d+)% of the system is reachable/.exec(text);
      expect(reachMatch).not.toBeNull();
      expect(Number((reachMatch as RegExpExecArray)[1])).toBe(Math.round(s.reachMean * 100));
    });
  },
);
