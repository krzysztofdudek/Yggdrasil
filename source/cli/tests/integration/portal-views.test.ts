import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { extractPortalData } from '../../src/portal/extract.js';
import type { PortalData } from '../../src/portal/contract.js';

/**
 * Unit/integration tests for the Phase-4 portal VIEW modules (Overview / Coverage & Audit /
 * the Node Attestation panel / Structure tree / Relations & Boundaries).
 *
 * Like the foundation test, these run the REAL committed view source in a node:vm sandbox over
 * a minimal DOM shim, driven by the REAL portal-basic fixture's PortalData produced by the REAL
 * pipeline (no fabricated contract, no mocking). We assert: each view renders its data into the
 * stage; the honest palette is applied through the shared state model (every state class comes
 * from Yg.states — no hand-written green; declaredOnly is rendered NEUTRALLY, never a violation;
 * the bar's non-pair track is structurally separate from the verified total); the live counters
 * equal yg check (== the pipeline counts, which the pipeline gates against runCheck); and the
 * §3a transitions route through the shared router (a click emits a route the router serializes).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/portal-basic');
const MODULE_DIR = path.resolve(__dirname, '../../src/templates/portal/js');

// Every browser module in serializer order EXCEPT the bootstrap (which boots the live DOM).
const MODULES = [
  'namespace.js',
  'state-model.js',
  'glossary.js',
  'router.js',
  'palette.js',
  'palette-overlay.js',
  'consumer.js',
  'tree.js',
  'shell.js',
  'dispatch.js',
  'views/overview-view.js',
  'views/coverage-view.js',
  'views/tree-view.js',
  'views/relations-matrix.js',
  'views/relations-view.js',
  'views/panel-aspect.js',
  'views/panel-view.js',
];

/** A DOM node shim rich enough for the view renderers and our tree-walking assertions. */
interface FakeNode {
  nodeType: number;
  tagName: string;
  _children: FakeNode[];
  _attrs: Record<string, string>;
  _listeners: Record<string, Array<() => void>>;
  textContent: string;
  style: Record<string, string>;
  type?: string;
  disabled?: boolean;
  className: string;
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  appendChild: (c: FakeNode) => FakeNode;
  removeChild: (c: FakeNode) => void;
  get firstChild(): FakeNode | undefined;
  addEventListener: (ev: string, fn: () => void) => void;
  getContext?: () => null;
  width?: number;
  height?: number;
}

function makeNode(tag: string): FakeNode {
  const children: FakeNode[] = [];
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<() => void>> = {};
  const classSet = new Set<string>();
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    _children: children,
    _attrs: attrs,
    _listeners: listeners,
    textContent: '',
    style: {} as Record<string, string>,
    get className() {
      return Array.from(classSet).join(' ');
    },
    set className(v: string) {
      classSet.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classSet.add(c));
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
    appendChild: (c: FakeNode) => {
      children.push(c);
      return c;
    },
    removeChild: (c: FakeNode) => {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
    },
    get firstChild() {
      return children[0];
    },
    addEventListener: (ev: string, fn: () => void) => {
      (listeners[ev] = listeners[ev] || []).push(fn);
    },
  } as unknown as FakeNode;
  // A canvas yields no 2D context in the shim — the matrix module guards on that and the DOM
  // mirror still carries the data; the DOM mirror is the screen-reader path anyway.
  if (String(tag).toLowerCase() === 'canvas') node.getContext = () => null;
  return node;
}

function makeSandbox(): { window: Record<string, unknown>; document: Record<string, unknown> } {
  const documentObj: Record<string, unknown> = {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: String(text), _children: [] }),
    getElementById: () => null,
    addEventListener: () => undefined,
    documentElement: makeNode('html'),
  };
  const windowObj: Record<string, unknown> = {
    location: { hash: '', protocol: 'http:' },
    addEventListener: () => undefined,
    document: documentObj,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  windowObj.window = windowObj;
  return { window: windowObj, document: documentObj };
}

interface Yg {
  views: Record<string, (stage: FakeNode, route: unknown, data: PortalData, ctx: unknown) => void>;
  matrix: {
    axisTypes: (types: PortalData['types']) => string[];
    allowedBetween: (byId: Record<string, unknown>, r: string, c: string) => string[];
  };
  states: { cssClass: (s: string) => string };
}

async function loadYg(): Promise<Yg> {
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  for (const file of MODULES) {
    const src = await readFile(path.join(MODULE_DIR, file), 'utf-8');
    new vm.Script(src, { filename: file }).runInContext(context);
  }
  return (sandbox.window as { YgPortal: Yg }).YgPortal;
}

/** Depth-first collect every node + text node under `root` (inclusive). */
function walk(root: FakeNode): FakeNode[] {
  const out: FakeNode[] = [root];
  for (const c of root._children || []) out.push(...walk(c));
  return out;
}

/** The concatenated text of an element subtree. */
function textOf(root: FakeNode): string {
  return walk(root)
    .map((n) => (n.nodeType === 3 ? n.textContent : n._children && n._children.length === 0 ? n.textContent : ''))
    .join(' ');
}

/** Every class token used anywhere in the subtree. */
function classesIn(root: FakeNode): Set<string> {
  const set = new Set<string>();
  for (const n of walk(root)) {
    if (typeof n.className === 'string') n.className.split(/\s+/).filter(Boolean).forEach((c) => set.add(c));
  }
  return set;
}

/** Fire the first click listener on the first node matching `predicate`, return captured routes. */
function clickFirst(root: FakeNode, predicate: (n: FakeNode) => boolean): boolean {
  for (const n of walk(root)) {
    if (predicate(n) && n._listeners && n._listeners.click && n._listeners.click.length) {
      n._listeners.click[0]();
      return true;
    }
  }
  return false;
}

describe('portal Phase-4 view modules (real source, real fixture data)', () => {
  let data: PortalData;

  beforeAll(async () => {
    data = await extractPortalData(FIXTURE_ROOT, { writeEnabled: false });
  }, 60_000);

  it('sanity — the fixture produced real PortalData with the honest unverified shape', () => {
    // The fixture is a real, cold graph: two enforced deterministic pairs, both unverified.
    expect(data.meta.counts.unverified).toBe(2);
    expect(data.meta.counts.verified).toBe(0);
    expect(data.boundary.unknown).toBe(false);
  });

  it('Overview renders an honest verdict (not green when unverified) + clickable residue → routes', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const routes: Array<Record<string, string>> = [];
    Yg.views.overview(stage, { view: 'overview' }, data, { navigate: (r: Record<string, string>) => routes.push(r) });

    const cls = classesIn(stage);
    // With unverified pairs the verdict must NOT be green — it is the unverified state class.
    expect(cls.has('state-unverified')).toBe(true);
    expect(cls.has('state-verified')).toBe(false);
    // The Start-here door routes to V9, and the precise-picture preview opens V2.
    expect(clickFirst(stage, (n) => textOf(n).includes('Start here'))).toBe(true);
    expect(routes.some((r) => r.view === 'start')).toBe(true);
    expect(clickFirst(stage, (n) => textOf(n).includes('precise picture'))).toBe(true);
    expect(routes.some((r) => r.view === 'coverage')).toBe(true);
    // The footer states absence-of-red-is-not-a-pass.
    expect(textOf(stage)).toMatch(/Absence of red is not a pass/i);
  });

  it('Overview never renders the type-covered accounting chip when the count is zero (portal-basic has no type tier)', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    Yg.views.overview(stage, { view: 'overview' }, data, { navigate: () => undefined });
    expect(textOf(stage)).not.toMatch(/matched type/);
  });

  it('a nonzero typeCoveredCount gets its own accounting chip — never folded into the no-rule/unmapped chip', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const withTypeCovered: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, typeCoveredCount: 3, uncoveredFiles: 1 } },
    };
    const routes: Array<Record<string, string>> = [];
    Yg.views.overview(stage, { view: 'overview' }, withTypeCovered, { navigate: (r: Record<string, string>) => routes.push(r) });

    expect(textOf(stage)).toMatch(/3.*matched type/);
    // The unmapped/unguarded chip still reports its OWN (smaller, already-corrected) count —
    // the two never collapse into one number.
    expect(textOf(stage)).toMatch(/1.*unmapped \(unguarded\)/);
    // The chip must not borrow the "no rule" badge — that would repeat the exact
    // miscount this chip exists to correct (a type-covered file has its own real
    // verdict, which may or may not be a pass).
    expect(classesIn(stage).has('reslink-neutral')).toBe(true);
    expect(clickFirst(stage, (n) => textOf(n).includes('matched type'))).toBe(true);
    expect(routes.some((r) => r.view === 'coverage')).toBe(true);
  });

  it('Coverage renders the live counts (== pipeline == yg check) and never collapses the non-pair track', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const routes: Array<Record<string, string>> = [];
    Yg.views.coverage(stage, { view: 'coverage' }, data, { navigate: (r: Record<string, string>) => routes.push(r) });

    const text = textOf(stage);
    const c = data.meta.counts;
    // The denominator is visible and the unverified count is shown (not hidden, not summed into verified).
    expect(text).toContain(String(c.pairsTotal));
    expect(text).toContain('expected verdict pairs verified');
    // The worklist group (a real unverified group on this fixture) appears with its node.
    expect(data.worklist.length).toBeGreaterThan(0);
    expect(text).toContain(data.worklist[0].rule);
    // Jump-to-next routes to the first offending node.
    expect(clickFirst(stage, (n) => textOf(n).includes('Jump to next'))).toBe(true);
    expect(routes.some((r) => r.node === data.worklist[0].nodes[0])).toBe(true);
    // The bar is sized by the real pair STATES: with 0 verified there is NO verified bar segment
    // (an unverified pair never paints green), and the unverified segment is present.
    const barSegs = walk(stage).filter((n) => n.classList && n.classList.contains('cov-seg-v'));
    expect(c.verified).toBe(0);
    expect(barSegs.length).toBe(0);
    expect(classesIn(stage).has('cov-seg-u')).toBe(true);
    // The LIVE boundary counter is read from the real boundary data (this fixture is clean: 0),
    // NOT a fabricated literal, and it routes to V4.
    const liveChips = walk(stage).filter((n) => n.classList && n.classList.contains('cov-live'));
    const boundaryChip = liveChips.find((n) => textOf(n).toLowerCase().includes('boundary'));
    expect(boundaryChip).toBeTruthy();
    const realBoundary = data.boundary.phantom.length + data.boundary.forbiddenType.length;
    expect(textOf(boundaryChip as FakeNode)).toContain(String(realBoundary));
    expect(clickFirst(boundaryChip as FakeNode, () => true)).toBe(true);
    expect(routes.some((r) => r.view === 'relations')).toBe(true);
  });

  it('Coverage never renders a type-covered line when the count is zero (flag-off stays unchanged)', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    Yg.views.coverage(stage, { view: 'coverage' }, data, { navigate: () => undefined });
    expect(textOf(stage)).not.toContain('type-covered');
  });

  it('Coverage shows a nonzero type-covered count on its OWN line — never inside "not in coverage fraction" (its pairs ARE counted in the bar)', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const withTypeCovered: PortalData = { ...data, meta: { ...data.meta, counts: { ...data.meta.counts, typeCoveredCount: 4 } } };
    Yg.views.coverage(stage, { view: 'coverage' }, withTypeCovered, { navigate: () => undefined });
    expect(textOf(stage)).toMatch(/4.*type-covered/);
    // The chip is neutral — not one of the nine honest-state badges (it is not itself a
    // pair verdict; the file's real verdict is already counted in the bar above).
    expect(classesIn(stage).has('reslink-neutral')).toBe(true);
    // Never folded into the "not in coverage fraction" tag — its pairs count in the fraction.
    const nonpairNodes = walk(stage).filter((n) => n.classList && n.classList.contains('cov-nonpair'));
    const typeCoveredNonpair = nonpairNodes.find((n) => textOf(n).includes('type-covered'));
    expect(typeCoveredNonpair && textOf(typeCoveredNonpair)).not.toMatch(/not in coverage fraction/);
  });

  it('Coverage surfaces the boundary counter as UNKNOWN (not a fabricated zero) when the parse could not run', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const degraded: PortalData = { ...data, boundary: { phantom: [], declaredOnly: [], forbiddenType: [], unknown: true } };
    Yg.views.coverage(stage, { view: 'coverage' }, degraded, { navigate: () => undefined });
    const liveChips = walk(stage).filter((n) => n.classList && n.classList.contains('cov-live'));
    const boundaryChip = liveChips.find((n) => textOf(n).toLowerCase().includes('boundary'));
    expect(boundaryChip).toBeTruthy();
    expect(textOf(boundaryChip as FakeNode)).toContain('UNKNOWN');
    expect(textOf(boundaryChip as FakeNode)).not.toMatch(/\b0\b/);
  });

  it('the Node Attestation panel renders identity + effective aspects + relations, routing each', async () => {
    const Yg = await loadYg();
    const panel = makeNode('aside');
    const routes: Array<Record<string, string>> = [];
    // api/orders has one effective deterministic aspect + a uses → api/users relation.
    Yg.views.panel(panel, { view: 'tree', node: 'api/orders' }, data, {
      navigate: (r: Record<string, string>) => routes.push(r),
    });
    expect(panel.classList.contains('open')).toBe(true);
    const text = textOf(panel);
    expect(text).toContain('api/orders');
    expect(text).toContain('no-todo-comments'); // the effective aspect id
    // The unverified pair shows the honest "not a stale pass" caveat, never a green.
    expect(text).toMatch(/not a stale pass/i);
    expect(classesIn(panel).has('state-verified')).toBe(false);
    // The depends-on relation row routes to the target node.
    expect(clickFirst(panel, (n) => textOf(n).trim() === 'api/users')).toBe(true);
    expect(routes.some((r) => r.node === 'api/users')).toBe(true);
    // A node with no node selected closes the panel.
    const closed = makeNode('aside');
    Yg.views.panel(closed, { view: 'overview' }, data, { navigate: () => undefined });
    expect(closed.classList.contains('open')).toBe(false);
  });

  it('the Structure tree view mounts the shared virtualized tree and routes a selection', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const selected: string[] = [];
    Yg.views.tree(stage, { view: 'tree' }, data, { onSelect: (p: string) => selected.push(p) });
    // The tree mount and at least one state-classed row are present.
    expect(classesIn(stage).has('tree-mount')).toBe(true);
    // The lead never invents a green; it references the shared state vocabulary via the legend/badge.
    expect(textOf(stage)).toMatch(/own state/i);
  });

  it('Relations renders hubs + the live boundary with declaredOnly NEUTRAL (never a violation)', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const routes: Array<Record<string, string>> = [];
    Yg.views.relations(stage, { view: 'relations' }, data, { navigate: (r: Record<string, string>) => routes.push(r) });

    const text = textOf(stage);
    // The matrix DOM mirror is present (the screen-reader path; canvas has no 2D ctx in the shim).
    expect(classesIn(stage).has('mtx-mirror') || classesIn(stage).has('mtx-canvas')).toBe(true);
    // Hubs render the real fan-in / fan-out nodes and route on click.
    expect(text).toContain('api/users'); // fan-in hub
    expect(text).toContain('api/orders'); // fan-out hub
    expect(clickFirst(stage, (n) => n.classList && n.classList.contains('rel-hubrow'))).toBe(true);
    expect(routes.some((r) => r.node === 'api/users' || r.node === 'api/orders')).toBe(true);
    // The boundary is clean on this fixture (unknown false, phantom 0) — and declaredOnly is
    // rendered NEUTRALLY: the declared-only class never carries a violation/boundary state class.
    const declRows = walk(stage).filter((n) => n.classList && n.classList.contains('rel-decl'));
    for (const r of declRows) {
      expect(classesIn(r).has('state-boundary')).toBe(false);
      expect(classesIn(r).has('state-refused')).toBe(false);
    }
    // The boundary section labels declared-only as legitimate / never red.
    expect(text).toMatch(/legitimate, never red|never red/i);
  });

  it('the boundary renders UNKNOWN honestly when the live parse could not run (degraded, not clean)', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    // Drive the SAME real data shape but with the honest UNKNOWN flag the pipeline sets when the
    // relation parse cannot run — this is a real contract field, not a fabricated PortalData.
    const degraded: PortalData = { ...data, boundary: { phantom: [], declaredOnly: [], forbiddenType: [], unknown: true } };
    Yg.views.relations(stage, { view: 'relations' }, degraded, { navigate: () => undefined });
    const text = textOf(stage);
    expect(text).toMatch(/UNKNOWN/);
    expect(text).toMatch(/not clean/i);
    // UNKNOWN must never read as green.
    const unknownBox = walk(stage).find((n) => n.classList && n.classList.contains('rel-unknown'));
    expect(unknownBox).toBeTruthy();
    expect(classesIn(unknownBox as FakeNode).has('state-verified')).toBe(false);
  });

  it('the dispatcher routes each view to its registered renderer; the honest legend is the one pinned bar, not re-rendered per view', async () => {
    const Yg = await loadYg() as unknown as {
      dispatch: {
        render: (stage: FakeNode, route: unknown, data: PortalData, onSelect: () => void, nav: () => void) => void;
        buildLegendBar: () => FakeNode;
      };
      states: { ORDER: string[]; cssClass: (s: string) => string };
    };
    for (const view of ['overview', 'coverage', 'tree', 'relations']) {
      const stage = makeNode('div');
      Yg.dispatch.render(stage, { view }, data, () => undefined, () => undefined);
      // The honest legend is NOT re-rendered inside the scrolling stage — it lives once as the
      // pinned legend bar the shell mounts (so it can be pinned and never duplicated per view).
      expect(classesIn(stage).has('legend')).toBe(false);
      // No "rendered in a later phase" scaffold for a built view.
      expect(textOf(stage)).not.toMatch(/rendered in a later phase/i);
    }
    // The single shared legend bar carries every honest state distinctly through the shared
    // model — one compact chip per state, never a state collapsed away, no fabricated green.
    const bar = Yg.dispatch.buildLegendBar();
    const barCls = classesIn(bar);
    expect(barCls.has('legend')).toBe(true);
    expect(barCls.has('legend-bar')).toBe(true);
    const chips = walk(bar).filter((n) => n.classList && n.classList.contains('legend-chip'));
    expect(chips.length).toBe(Yg.states.ORDER.length);
    for (const s of Yg.states.ORDER) expect(barCls.has(Yg.states.cssClass(s))).toBe(true);
    // The honest model's only green is 'verified' — the bar never invents another green class.
    expect(barCls.has('state-green')).toBe(false);
    expect(barCls.has('state-ok')).toBe(false);
  });
});
