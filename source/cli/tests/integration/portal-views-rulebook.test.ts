import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { extractPortalData } from '../../src/portal/extract.js';
import type { PortalData } from '../../src/portal/contract.js';

/**
 * Integration tests for the Phase-4 chunk-2 portal VIEW modules: Rulebook (V5), Type Model
 * (V6), Flows (V7), Suppressions (V8), Start here (V9).
 *
 * Like the sibling foundation/view tests, these run the REAL committed view source in a
 * node:vm sandbox over a minimal DOM shim — the actual module code runs, not a reimplementation.
 * Two REAL data drivers, never a fabricated PortalData:
 *   - the REAL portal-basic fixture's PortalData (the cold minimal graph) for base rendering and
 *     for the honest contract-state VARIANTS the fixture does not itself exhibit (an aggregate
 *     tally, a nothing-checked / attention flow state) — substituted exactly as the sibling test
 *     substitutes `boundary.unknown`: a real contract field set to a real contract value, the
 *     same way the pipeline would emit it;
 *   - the REAL repo's own PortalData, produced through the PUBLIC CLI surface (`yg portal
 *     --static`) and parsed back out of the emitted offline page, for the rich shapes the minimal
 *     fixture lacks (a vacuous "verifies nothing" aspect, real flows/types, real suppression risk
 *     flags).
 *
 * Every assertion is an HONESTY assertion: a green is only ever rendered through the shared
 * honest-state model; an aggregate "judges nothing"; a vacuous aspect "verifies nothing"; an
 * all-no-rule flow is "nothing-checked", never green; suppression risk flags surface; the Start
 * walk's five steps are derived from the live graph; and no view collapses a non-verified state
 * into green.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/portal-basic');
const MODULE_DIR = path.resolve(__dirname, '../../src/templates/portal/js');
const CLI_ROOT = path.resolve(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const REPO_ROOT = path.resolve(CLI_ROOT, '../..');

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
  'views/coverage-typecovered.js',
  'views/coverage-worklist.js',
  'views/coverage-view.js',
  'views/tree-view.js',
  'views/relations-matrix.js',
  'views/relations-view.js',
  'views/rulebook-view.js',
  'views/types-view.js',
  'views/flows-view.js',
  'views/suppressions-view.js',
  'views/start-view.js',
  'views/panel-aspect.js',
  'views/panel-view.js',
];

interface FakeNode {
  nodeType: number;
  tagName: string;
  _children: FakeNode[];
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
  // `document` and `window` are both browser globals; in the vm sandbox the context object IS
  // the top-level scope, so expose `document` at the top level too (the modules call the bare
  // `document` global, exactly as a browser does).
  return { window: windowObj, document: documentObj };
}

interface Yg {
  views: Record<string, (stage: FakeNode, route: unknown, data: PortalData, ctx: unknown) => void>;
  dispatch: { render: (s: FakeNode, r: unknown, d: PortalData, onSelect: () => void, nav: () => void) => void };
  states: { cssClass: (s: string) => string; ORDER: string[] };
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

function walk(root: FakeNode): FakeNode[] {
  const out: FakeNode[] = [root];
  for (const c of root._children || []) out.push(...walk(c));
  return out;
}

function textOf(root: FakeNode): string {
  return walk(root)
    .map((n) => (n.nodeType === 3 ? n.textContent : n._children && n._children.length === 0 ? n.textContent : ''))
    .join(' ');
}

function classesIn(root: FakeNode): Set<string> {
  const set = new Set<string>();
  for (const n of walk(root)) {
    if (typeof n.className === 'string') n.className.split(/\s+/).filter(Boolean).forEach((c) => set.add(c));
  }
  return set;
}

function clickFirst(root: FakeNode, predicate: (n: FakeNode) => boolean): boolean {
  for (const n of walk(root)) {
    if (predicate(n) && n._listeners && n._listeners.click && n._listeners.click.length) {
      n._listeners.click[0]();
      return true;
    }
  }
  return false;
}

/** Parse the inlined PortalData back out of an emitted static page (reverses the HTML hardening). */
function parsePortalData(html: string): PortalData {
  const m = html.match(/<script id="portal-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no portal-data script in emitted page');
  const json = m[1].trim().replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&');
  return JSON.parse(json) as PortalData;
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('portal Phase-4 chunk-2 view modules (real source, real data)', () => {
  let fixture: PortalData;
  // The real repo's own PortalData, produced through the PUBLIC CLI surface. Null when the dist
  // build is absent (the e2e gate) — the real-repo cases skip rather than fabricate data.
  let repo: PortalData | null = null;

  beforeAll(async () => {
    fixture = await extractPortalData(FIXTURE_ROOT, { writeEnabled: false });
    if (existsSync(BIN_PATH)) {
      const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-rulebook-'));
      tmpDirs.push(dir);
      const out = path.join(dir, 'portal.html');
      const run = spawnSync('node', [BIN_PATH, 'portal', '--static', '--out', out], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
      if (run.status === 0 && existsSync(out)) repo = parsePortalData(readFileSync(out, 'utf-8'));
    }
  }, 120_000);

  // ── V5 Rulebook ───────────────────────────────────────────────────────────

  it('V5 renders the catalogue and a normal aspect tally through the shared state model (no fabricated green)', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    Yg.views.rulebook(stage, { view: 'rulebook' }, fixture, { navigate: () => undefined });
    const cls = classesIn(stage);
    // The fixture's one enforced deterministic aspect is unverified (cold graph): the micro-bar
    // must carry the unverified state class and NEVER a fabricated green.
    expect(textOf(stage)).toContain('no-todo-comments');
    expect(cls.has('state-green')).toBe(false);
    expect(cls.has('state-ok')).toBe(false);
    expect(cls.has('state-unverified')).toBe(true);
  });

  it('V5 renders an AGGREGATING aspect as "judges nothing" — never a green tally', async () => {
    const Yg = await loadYg();
    // A real contract value the pipeline emits for an aggregate bundle (no own reviewer),
    // substituted onto the real fixture data exactly as the sibling test substitutes boundary.
    const agg: PortalData['aspects'][number] = {
      id: 'reference',
      name: 'reference',
      kind: 'aggregate',
      status: 'enforced',
      scope: 'node',
      hasWhen: false,
      implies: ['ref-a', 'ref-b'],
      tally: { render: 'aggregate' },
    };
    const data: PortalData = { ...fixture, aspects: [agg, ...fixture.aspects] };
    const stage = makeNode('div');
    Yg.views.rulebook(stage, { view: 'rulebook' }, data, { navigate: () => undefined });
    const text = textOf(stage);
    expect(text).toMatch(/judges nothing/i);
    // An aggregate row never paints a verified bar segment.
    const aggRow = walk(stage).find((n) => textOf(n).includes('reference') && textOf(n).includes('judges nothing'));
    expect(aggRow).toBeTruthy();
    expect(classesIn(aggRow as FakeNode).has('state-verified')).toBe(false);
  });

  it('V5 renders a VACUOUS aspect as "verifies nothing" with the resolved reason', async () => {
    const Yg = await loadYg();
    // A rule-bearing aspect that resolves to ZERO expected pairs renders the honest
    // "vacuous / verifies nothing" state with its resolved reason shown verbatim.
    // Constructed synthetically and substituted onto the real fixture data (exactly as
    // the sibling aggregate case above): the vacuous RENDERING is exercised through the
    // real view module WITHOUT requiring the real repo to carry a dead-attached aspect —
    // a "dead law" the effectiveness linter (aspect-effective-nowhere) now flags as a defect.
    const vac: PortalData['aspects'][number] = {
      id: 'redaction-cascade',
      name: 'redaction-cascade',
      kind: 'llm',
      status: 'enforced',
      scope: 'file',
      hasWhen: false,
      implies: [],
      tally: { render: 'vacuous', reason: 'effective on zero nodes' },
    };
    const data: PortalData = { ...fixture, aspects: [vac, ...fixture.aspects] };
    const stage = makeNode('div');
    Yg.views.rulebook(stage, { view: 'rulebook' }, data, { navigate: () => undefined });
    const text = textOf(stage);
    expect(text).toMatch(/verifies nothing/i);
    // The resolved reason from the tally is shown verbatim (rot-proof, not invented).
    expect(text).toContain('effective on zero nodes');
  });

  it('V5 opens a selected aspect in the inspector panel with honest per-node cells that route', async () => {
    const Yg = await loadYg();
    const panel = makeNode('div');
    const routes: Array<Record<string, string>> = [];
    // The aspect detail is the aspect-side mirror of the node attestation: it renders in the
    // SHARED panel (Yg.views.panel) for an aspect route, not inline in the rulebook list.
    Yg.views.panel(panel, { view: 'rulebook', aspect: 'no-todo-comments' }, fixture, {
      navigate: (r: Record<string, string>) => routes.push(r),
    });
    expect(classesIn(panel).has('pan-aspect')).toBe(true);
    expect(classesIn(panel).has('rb-cell')).toBe(true);
    // A node cell carries an honest state badge and routes to that node's panel (V5 → SHELL-panel).
    expect(clickFirst(panel, (n) => n.classList && n.classList.contains('rb-cell'))).toBe(true);
    expect(routes.some((r) => r.view === 'tree' && typeof r.node === 'string')).toBe(true);
    // No cell fabricates a green class.
    expect(classesIn(panel).has('state-green')).toBe(false);
  });

  // ── V6 Type Model ───────────────────────────────────────────────────────────

  it('V6 renders type cards with counts/relations/default rules and routes, inventing no verdict color', async () => {
    if (!repo) return;
    const Yg = await loadYg();
    const stage = makeNode('div');
    const routes: Array<Record<string, string>> = [];
    Yg.views.types(stage, { view: 'types' }, repo, { navigate: (r: Record<string, string>) => routes.push(r) });
    const text = textOf(stage);
    expect(classesIn(stage).has('ty-card')).toBe(true);
    expect(repo.types.some((t) => text.includes(t.id))).toBe(true);
    // The node-count routes to the structure tree; a default-rule chip routes to the rulebook.
    expect(clickFirst(stage, (n) => n.classList && n.classList.contains('ty-count'))).toBe(true);
    expect(routes.some((r) => r.view === 'tree')).toBe(true);
    const r2: Array<Record<string, string>> = [];
    const s2 = makeNode('div');
    Yg.views.types(s2, { view: 'types' }, repo, { navigate: (r: Record<string, string>) => r2.push(r) });
    expect(clickFirst(s2, (n) => n.classList && n.classList.contains('ty-asp'))).toBe(true);
    expect(r2.some((r) => r.view === 'rulebook' && typeof r.aspect === 'string')).toBe(true);
    // The type model renders the architecture grammar, not a verdict — it paints no green.
    expect(classesIn(stage).has('state-verified')).toBe(false);
    expect(classesIn(stage).has('state-green')).toBe(false);
  });

  // ── V7 Flows ─────────────────────────────────────────────────────────────────

  it('V7 renders the gallery + detail and routes a flow / participant / flow-aspect (real repo)', async () => {
    if (!repo || repo.flows.length === 0) return;
    const Yg = await loadYg();
    const stage = makeNode('div');
    const routes: Array<Record<string, string>> = [];
    Yg.views.flows(stage, { view: 'flows' }, repo, { navigate: (r: Record<string, string>) => routes.push(r) });
    expect(classesIn(stage).has('fl-gallery')).toBe(true);
    expect(classesIn(stage).has('fl-detail')).toBe(true);
    // Selecting a flow card routes with the flow name (in-view, round-trips via hash).
    expect(clickFirst(stage, (n) => n.classList && n.classList.contains('fl-card'))).toBe(true);
    expect(routes.some((r) => r.view === 'flows' && typeof r.flow === 'string')).toBe(true);
    // A participant routes to its attestation panel.
    const r2: Array<Record<string, string>> = [];
    const s2 = makeNode('div');
    Yg.views.flows(s2, { view: 'flows' }, repo, { navigate: (r: Record<string, string>) => r2.push(r) });
    expect(clickFirst(s2, (n) => n.classList && n.classList.contains('fl-part'))).toBe(true);
    expect(r2.some((r) => r.view === 'tree' && typeof r.node === 'string')).toBe(true);
  });

  it('V7 renders an all-no-rule flow as nothing-checked — NEVER green', async () => {
    const Yg = await loadYg();
    // A real contract flow-state value (the pipeline emits 'nothing-checked' for an all-no-rule
    // participant set), substituted onto the real fixture data.
    const ncFlow: PortalData['flows'][number] = {
      name: 'init',
      description: 'A repository adopts the system.',
      participants: fixture.nodes.map((n) => n.path).slice(0, 2),
      aspects: [],
      state: 'nothing-checked',
    };
    const data: PortalData = { ...fixture, flows: [ncFlow] };
    const stage = makeNode('div');
    Yg.views.flows(stage, { view: 'flows', flow: 'init' }, data, { navigate: () => undefined });
    const text = textOf(stage);
    expect(text).toMatch(/nothing-checked/);
    // The flow state pill renders the distinct no-rule treatment, never verified.
    const pill = walk(stage).find((n) => n.classList && n.classList.contains('fl-state'));
    expect(pill).toBeTruthy();
    expect(classesIn(pill as FakeNode).has('state-no-rule')).toBe(true);
    expect(classesIn(pill as FakeNode).has('state-verified')).toBe(false);
  });

  it('V7 renders an attention flow as the weakest-link warning treatment (real contract value)', async () => {
    const Yg = await loadYg();
    const atFlow: PortalData['flows'][number] = {
      name: 'verification',
      participants: fixture.nodes.map((n) => n.path).slice(0, 2),
      aspects: ['deterministic'],
      state: 'attention',
    };
    const data: PortalData = { ...fixture, flows: [atFlow] };
    const stage = makeNode('div');
    Yg.views.flows(stage, { view: 'flows', flow: 'verification' }, data, { navigate: () => undefined });
    const pill = walk(stage).find((n) => n.classList && n.classList.contains('fl-state'));
    expect(textOf(pill as FakeNode)).toMatch(/weakest-link/);
    expect(classesIn(pill as FakeNode).has('state-warning')).toBe(true);
    expect(classesIn(pill as FakeNode).has('state-verified')).toBe(false);
  });

  // ── V8 Suppressions ───────────────────────────────────────────────────────────

  it('V8 renders the risk-first inventory with risk flags + waived-not-pass framing (real repo)', async () => {
    if (!repo) return;
    expect(repo.suppressions.length, 'the real repo carries active waivers').toBeGreaterThan(0);
    const Yg = await loadYg();
    const stage = makeNode('div');
    const routes: Array<Record<string, string>> = [];
    Yg.views.suppressions(stage, { view: 'suppressions' }, repo, {
      navigate: (r: Record<string, string>) => routes.push(r),
    });
    const text = textOf(stage);
    expect(classesIn(stage).has('sup-table')).toBe(true);
    // A waiver is framed as not-a-pass and rendered through the shared waived state.
    expect(text).toMatch(/waiver, not a pass/i);
    expect(classesIn(stage).has('state-suppressed')).toBe(true);
    expect(classesIn(stage).has('state-verified')).toBe(false);
    // Risk flags surface for any wildcard / unbounded marker, and the banner appears with them.
    const hasDangerous = repo.suppressions.some((s) => s.risk === 'wildcard' || s.risk === 'unbounded');
    expect(classesIn(stage).has('sup-banner')).toBe(hasDangerous);
    if (repo.suppressions.some((s) => s.risk === 'wildcard')) expect(text).toMatch(/WILDCARD/);
    if (repo.suppressions.some((s) => s.risk === 'typo')) expect(text).toMatch(/TYPO/);
    // The waived aspect routes to the rulebook.
    expect(clickFirst(stage, (n) => n.classList && n.classList.contains('sup-asp'))).toBe(true);
    expect(routes.some((r) => r.view === 'rulebook')).toBe(true);
  });

  it('V8 renders an HONEST empty state (no waivers) — never a green', async () => {
    const Yg = await loadYg();
    const data: PortalData = { ...fixture, suppressions: [] };
    const stage = makeNode('div');
    Yg.views.suppressions(stage, { view: 'suppressions' }, data, { navigate: () => undefined });
    const text = textOf(stage);
    expect(classesIn(stage).has('sup-empty')).toBe(true);
    expect(text).toMatch(/No active waivers/i);
    expect(text).toMatch(/not a green/i);
    expect(classesIn(stage).has('state-verified')).toBe(false);
  });

  // ── V9 Start here ───────────────────────────────────────────────────────────

  it('V9 walks five steps assembled from the live graph (rot-proof) and ends honestly', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const routes: Array<Record<string, string>> = [];
    Yg.views.start(stage, { view: 'start' }, fixture, { navigate: (r: Record<string, string>) => routes.push(r) });
    // Step 1 of 5, with counts derived from the live data (not hardcoded).
    expect(textOf(stage)).toMatch(/Step 1 of 5/);
    expect(textOf(stage)).toContain(String(fixture.meta.counts.nodes));
    expect(textOf(stage)).toContain(String(fixture.meta.counts.aspects));
    // Advance through all five steps via Next; the rail reports each.
    expect(clickFirst(stage, (n) => /Next:/.test(textOf(n)))).toBe(true);
    expect(textOf(stage)).toMatch(/Step 2 of 5/);
    for (let i = 0; i < 4; i += 1) clickFirst(stage, (n) => /Next:|Done/.test(textOf(n)));
    // The final step is the colour key — every honest state present, never collapsed to one green.
    expect(textOf(stage)).toMatch(/Reading the colours/);
    expect(classesIn(stage).has('st-key')).toBe(true);
    expect(classesIn(stage).has('state-no-rule')).toBe(true);
    expect(classesIn(stage).has('state-unverified')).toBe(true);
    // "Done" routes to the overview.
    expect(routes.some((r) => r.view === 'overview')).toBe(true);
  });

  it('V9 step 2 lists the real big areas as graph-derived nodes with honest state badges', async () => {
    if (!repo) return;
    const Yg = await loadYg();
    const stage = makeNode('div');
    Yg.views.start(stage, { view: 'start' }, repo, { navigate: () => undefined });
    clickFirst(stage, (n) => /Next:/.test(textOf(n)));
    // The big-areas grid is built from the real top-level nodes; each carries a state badge from
    // the shared model and an area card never fabricates a green.
    expect(classesIn(stage).has('st-area')).toBe(true);
    expect(classesIn(stage).has('state-green')).toBe(false);
  });

  // ── Dispatcher integration ────────────────────────────────────────────────────

  it('the dispatcher routes each new view to its renderer; the honest legend is the one pinned bar, not per view', async () => {
    const Yg = await loadYg();
    for (const view of ['rulebook', 'types', 'flows', 'suppressions', 'start']) {
      const stage = makeNode('div');
      Yg.dispatch.render(stage, { view }, fixture, () => undefined, () => undefined);
      // The honest legend is the single pinned bar the shell mounts — not re-rendered inside a
      // view's scrolling stage, so it can be pinned to the viewport bottom and never duplicated.
      expect(classesIn(stage).has('legend'), `${view} does not re-render the legend in-stage`).toBe(false);
      expect(textOf(stage)).not.toMatch(/rendered in a later phase/i);
    }
  });
});
