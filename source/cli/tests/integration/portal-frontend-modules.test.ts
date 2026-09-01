import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { extractPortalData } from '../../src/portal/extract.js';
import type { PortalData } from '../../src/portal/contract.js';

/**
 * Unit/integration tests for the vanilla portal FRONTEND modules (Phase-3 foundation).
 *
 * These modules are browser IIFEs that attach to one window.YgPortal global; they use no
 * Node imports (the no-node-imports-in-frontend aspect forbids it), so they are loaded HERE
 * by reading the REAL committed module source and evaluating it in a node:vm sandbox over a
 * minimal DOM shim — the actual module code runs, not a reimplementation. The data driven
 * through them is the REAL portal-basic fixture's PortalData produced by the REAL pipeline
 * (no fabricated contract). We assert: the honest 8-state model maps every state to a
 * distinct color-class + glyph + label; the hash router round-trips every route grammar; the
 * ⌘K palette fuzzy-matches and routes real entities; the consumer reads the inlined snapshot
 * and detects served-vs-static; and the tree builds the real fixture's hierarchy.
 */

/** A router route — a view plus the optional entity fields the grammar can carry. */
interface Route {
  view: string;
  node?: string;
  aspect?: string;
  flow?: string;
  file?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/portal-basic');
const MODULE_DIR = path.resolve(__dirname, '../../src/templates/portal/js');

// The module load order the serializer uses (namespace first, bootstrap excluded — it boots
// the DOM, which we drive piecewise here).
const PURE_MODULES = [
  'namespace.js',
  'state-model.js',
  'glossary.js',
  'router.js',
  'palette.js',
  'palette-overlay.js',
  'consumer.js',
  'tree.js',
];

/** A tiny DOM node sufficient for the modules' element-building helpers. */
function makeNode(tag: string): Record<string, unknown> {
  const children: Array<Record<string, unknown>> = [];
  const attrs: Record<string, string> = {};
  const classSet = new Set<string>();
  const node: Record<string, unknown> = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    _children: children,
    _attrs: attrs,
    textContent: '',
    style: {},
    get className() {
      return Array.from(classSet).join(' ');
    },
    set className(v: string) {
      classSet.clear();
      String(v)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classSet.add(c));
    },
    classList: {
      add: (c: string) => classSet.add(c),
      remove: (c: string) => classSet.delete(c),
      contains: (c: string) => classSet.has(c),
    },
    setAttribute: (k: string, v: string) => {
      attrs[k] = String(v);
    },
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    appendChild: (c: Record<string, unknown>) => {
      children.push(c);
      return c;
    },
    addEventListener: () => undefined,
  };
  return node;
}

/** Build the minimal window/document sandbox the pure modules need. */
function makeSandbox(hash: string, protocol: string): { window: Record<string, unknown> } {
  const documentObj: Record<string, unknown> = {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: String(text) }),
    getElementById: () => null,
    addEventListener: () => undefined,
    documentElement: makeNode('html'),
  };
  const windowObj: Record<string, unknown> = {
    location: { hash, protocol },
    addEventListener: () => undefined,
    document: documentObj,
  };
  windowObj.window = windowObj;
  // In a browser `document` and `window` are both global identifiers; in the vm sandbox the
  // top-level scope IS the context object, so expose `document` at the top level too (the
  // modules reference the bare `document` global, exactly as a browser does).
  (windowObj as Record<string, unknown>).document = documentObj;
  return { window: windowObj, document: documentObj } as unknown as { window: Record<string, unknown> };
}

/** Load all pure modules into a fresh sandbox and return its window.YgPortal. */
async function loadYg(hash = '', protocol = 'http:'): Promise<{ Yg: Record<string, unknown>; sandbox: Record<string, unknown> }> {
  const sandbox = makeSandbox(hash, protocol);
  const context = vm.createContext(sandbox);
  for (const file of PURE_MODULES) {
    const src = await readFile(path.join(MODULE_DIR, file), 'utf-8');
    new vm.Script(src, { filename: file }).runInContext(context);
  }
  const win = sandbox.window as Record<string, unknown>;
  return { Yg: win.YgPortal as Record<string, unknown>, sandbox: sandbox as Record<string, unknown> };
}

describe('portal frontend modules (real source, real fixture data)', () => {
  let data: PortalData;

  beforeAll(async () => {
    data = await extractPortalData(FIXTURE_ROOT, { writeEnabled: false });
  }, 60_000);

  it('sanity — the fixture produced real PortalData (no fabrication)', () => {
    expect(data.meta.counts.nodes).toBe(3);
    expect(data.nodes.some((n) => n.path === 'api/orders')).toBe(true);
  });

  it('the honest state model maps every state to a DISTINCT color-class + glyph + label', async () => {
    const { Yg } = await loadYg();
    const states = Yg.states as {
      ORDER: string[];
      glyph: (s: string) => string;
      label: (s: string) => string;
      plain: (s: string) => string;
      cssClass: (s: string) => string;
    };
    // All eight honest states (+ boundary) are present and distinct.
    expect(states.ORDER.length).toBeGreaterThanOrEqual(8);
    const glyphs = new Set<string>();
    const classes = new Set<string>();
    const labels = new Set<string>();
    for (const s of states.ORDER) {
      const g = states.glyph(s);
      const c = states.cssClass(s);
      const l = states.label(s);
      expect(g, `state ${s} has a glyph`).toBeTruthy();
      expect(states.plain(s), `state ${s} has plain text`).toBeTruthy();
      glyphs.add(g);
      classes.add(c);
      labels.add(l);
    }
    // Glyphs and css classes are unique per state (color is never the only signal).
    expect(glyphs.size).toBe(states.ORDER.length);
    expect(classes.size).toBe(states.ORDER.length);
    expect(labels.size).toBe(states.ORDER.length);
    // verified is the only green class.
    expect(states.cssClass('verified')).toBe('state-verified');
    // An unknown state never throws; it falls back to no-rule (never to a green).
    expect(states.cssClass('totally-unknown')).toBe('state-no-rule');
  });

  it('the hash router round-trips every route grammar', async () => {
    const { Yg } = await loadYg();
    const router = Yg.router as {
      parse: (h: string) => Route;
      serialize: (r: Route) => string;
    };
    // Empty hash -> overview default.
    expect(router.parse('')).toEqual({ view: 'overview' });
    expect(router.parse('#')).toEqual({ view: 'overview' });
    // View, node, aspect, flow, and per-verdict file-unit round-trip losslessly.
    const routes = [
      { view: 'coverage' },
      { view: 'tree', node: 'api/orders' },
      { view: 'tree', node: 'api/orders', aspect: 'no-todo-comments', file: 'src/orders/orders.service.ts' },
      { view: 'rulebook', aspect: 'no-todo-comments' },
      { view: 'flows', flow: 'order placement' },
    ];
    for (const r of routes) {
      const hash = router.serialize(r);
      expect(router.parse(hash), `round-trip ${hash}`).toEqual(r);
    }
    // A node path's slashes survive the encode/decode.
    const deep = router.serialize({ view: 'tree', node: 'a/b/c/d' });
    expect(router.parse(deep)).toEqual({ view: 'tree', node: 'a/b/c/d' });
    // An unknown view id degrades to overview (never a blank page) but carries the unknown token
    // so the page can say "nothing here" honestly instead of a silent redirect.
    expect(router.parse('#/view/does-not-exist')).toEqual({ view: 'overview', notFound: 'does-not-exist' });
  });

  it('the ⌘K palette fuzzy-matches and routes real fixture entities', async () => {
    const { Yg } = await loadYg();
    const pal = Yg.paletteSearch as {
      buildIndex: (d: PortalData) => Array<{ id: string; label: string; kind: string; route: Record<string, string> }>;
      search: (items: unknown[], q: string, limit?: number) => Array<{ id: string; route: Record<string, string> }>;
      fuzzyScore: (q: string, t: string) => number;
    };
    const index = pal.buildIndex(data);
    // View actions are always present (palette is never empty) + every real node/aspect/flow.
    expect(index.some((i) => i.id === 'view:overview')).toBe(true);
    expect(index.some((i) => i.id === 'node:api/orders')).toBe(true);
    // Empty query returns something (view actions first) — never an empty palette.
    expect(pal.search(index, '', 50).length).toBeGreaterThan(0);
    // A query matches the real node and routes to it.
    const hits = pal.search(index, 'orders', 50);
    const ordersHit = hits.find((h) => h.id === 'node:api/orders');
    expect(ordersHit).toBeTruthy();
    expect(ordersHit!.route).toEqual({ view: 'tree', node: 'api/orders' });
    // A non-subsequence query scores below zero (not a match).
    expect(pal.fuzzyScore('zzzz', 'orders')).toBeLessThan(0);
    // Contiguous/boundary matches outrank a scattered one.
    expect(pal.fuzzyScore('ord', 'orders')).toBeGreaterThan(pal.fuzzyScore('ord', 'o_r_d'));
  });

  it('the consumer reads the inlined snapshot and detects served-vs-static', async () => {
    // Served (http) — isServed true.
    const served = await loadYg('', 'http:');
    expect((served.Yg.consumer as { isServed: () => boolean }).isServed()).toBe(true);
    // Static file:// — isServed false (no /data endpoint; refresh rejects).
    const staticLoad = await loadYg('', 'file:');
    const consumer = staticLoad.Yg.consumer as { isServed: () => boolean; refresh: () => Promise<unknown> };
    expect(consumer.isServed()).toBe(false);
    await expect(consumer.refresh()).rejects.toThrow();
    // readInlined parses the data <script> when present.
    const win = staticLoad.sandbox.window as { document: { getElementById: (id: string) => unknown } };
    const blob = JSON.stringify(data);
    win.document.getElementById = (id: string) =>
      id === 'portal-data' ? { textContent: blob } : null;
    const read = (staticLoad.Yg.consumer as { readInlined: () => PortalData | null }).readInlined();
    expect(read).not.toBeNull();
    expect(read!.meta.counts.nodes).toBe(data.meta.counts.nodes);
  });

  it('the tree builds the real fixture hierarchy under one synthetic root', async () => {
    const { Yg } = await loadYg();
    const tree = Yg.tree as {
      buildForest: (nodes: PortalData['nodes']) => { node: { path: string }; children: unknown[] };
      flattenLayout: (forest: unknown, d3: unknown) => Array<{ node: { path: string }; depth: number }>;
    };
    const forest = tree.buildForest(data.nodes);
    expect(forest.node.path).toBe(''); // synthetic root
    // Flatten with no d3 (the fallback DFS path) yields every real node, parents before children.
    const rows = tree.flattenLayout(forest, null);
    const paths = rows.map((r) => r.node.path);
    expect(paths).toContain('api');
    expect(paths).toContain('api/orders');
    expect(paths).toContain('api/users');
    // 'api' (a parent) appears before its children.
    expect(paths.indexOf('api')).toBeLessThan(paths.indexOf('api/orders'));
    // depth reflects path nesting (api at 0, api/orders at 1).
    const apiRow = rows.find((r) => r.node.path === 'api');
    const ordersRow = rows.find((r) => r.node.path === 'api/orders');
    expect(ordersRow!.depth).toBe(apiRow!.depth + 1);
  });

  it('the glossary returns plain definitions for engine terms', async () => {
    const { Yg } = await loadYg();
    const glossary = Yg.glossary as { lookup: (t: string) => string | null };
    expect(glossary.lookup('aspect')).toMatch(/rule/i);
    expect(glossary.lookup('no-rule')).toMatch(/unguarded|nothing/i);
    expect(glossary.lookup('not-a-real-term')).toBeNull();
  });

  it('.cov-seg carries a min-width so a tiny non-zero bar segment stays visible instead of vanishing', async () => {
    // A segment's width is otherwise proportional to its share of the total, so a handful of
    // refusals or advisories in a project with thousands of expected checks could round to a
    // fraction of a pixel and disappear — a real problem rendering as if it did not exist. This
    // pins the CSS rule that keeps that from happening; deleting it regresses the bug with no
    // other test noticing (a DOM-only assertion can't see a computed CSS width in this sandbox).
    const css = await readFile(path.join(MODULE_DIR, '../views-worklist.css'), 'utf-8');
    const rule = css.match(/\.cov-seg\s*\{([^}]*)\}/);
    expect(rule, '.cov-seg rule exists in views-worklist.css').toBeTruthy();
    expect(rule![1]).toMatch(/min-width\s*:\s*[1-9]/);
  });
});
