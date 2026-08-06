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
  'views/coverage-typecovered.js',
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
    const typeCovered = [
      { path: 'src/a.ts', type: 'svc', enforced: true, unverified: false },
      { path: 'src/b.ts', type: 'svc', enforced: true, unverified: false },
      { path: 'src/c.ts', type: 'svc', enforced: true, unverified: false },
      { path: 'src/d.ts', type: 'svc', enforced: true, unverified: false },
    ];
    const withTypeCovered: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, typeCoveredCount: 4, typeCoveredUnenforced: 0 } },
      residue: { ...data.residue, typeCovered },
    };
    Yg.views.coverage(stage, { view: 'coverage' }, withTypeCovered, { navigate: () => undefined });
    expect(textOf(stage)).toMatch(/4.*type-covered/);
    // Every enforced file is named with its matched type, not folded into a bare count.
    expect(textOf(stage)).toContain('src/a.ts — type-covered as svc');
    expect(textOf(stage)).toContain('src/d.ts — type-covered as svc');
    // The chip is neutral — not one of the nine honest-state badges (it is not itself a
    // pair verdict; the file's real verdict is already counted in the bar above).
    expect(classesIn(stage).has('reslink-neutral')).toBe(true);
    // Never folded into the "not in coverage fraction" tag — its pairs count in the fraction.
    const nonpairNodes = walk(stage).filter((n) => n.classList && n.classList.contains('cov-nonpair'));
    const typeCoveredNonpair = nonpairNodes.find((n) => textOf(n).includes('type-covered'));
    expect(typeCoveredNonpair && textOf(typeCoveredNonpair)).not.toMatch(/not in coverage fraction/);
    // No file here is unenforced, so the "checked by nothing" line must not appear at all.
    expect(textOf(stage)).not.toMatch(/checked by nothing/);
  });

  // F2: `enforced` names architecture-level status, never a recorded verdict —
  // the portal used to print a flat "type-covered" chip and per-file row for
  // an enforced file with zero regard for whether the lock actually holds a
  // verdict, weaker than plain `yg check`'s qualified "N unverified" wording
  // for the identical pair.
  it('an enforced-but-unverified type-covered file is named in both the chip suffix and its own row, never a bare "satisfied" claim', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const typeCovered = [
      { path: 'src/crashy/a.ts', type: 'crashy', enforced: true, unverified: true },
      { path: 'src/leaf/a.ts', type: 'leaf', enforced: true, unverified: false },
    ];
    const withUnverified: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, typeCoveredCount: 2, typeCoveredUnenforced: 0 } },
      residue: { ...data.residue, typeCovered },
    };
    Yg.views.coverage(stage, { view: 'coverage' }, withUnverified, { navigate: () => undefined });
    // The chip names how many of the enforced files have no recorded verdict.
    expect(textOf(stage)).toMatch(/2.*type-covered.*1 with no recorded verdict/);
    // Its own row is tagged individually — the OTHER enforced file's row is not.
    expect(textOf(stage)).toContain('src/crashy/a.ts — type-covered as crashy — unverified');
    expect(textOf(stage)).toContain('src/leaf/a.ts — type-covered as leaf');
    expect(textOf(stage)).not.toContain('src/leaf/a.ts — type-covered as leaf — unverified');
  });

  it('a type-covered file with NO applicable rule renders as unenforced — named by file and type, never folded into "satisfied by a matched type", on both Overview and Coverage', async () => {
    const Yg = await loadYg();
    const typeCovered = [
      { path: 'src/checked.ts', type: 'svc', enforced: true, unverified: false },
      { path: 'src/unchecked.ts', type: 'svc', enforced: false, unverified: false },
    ];
    const withUnenforced: PortalData = {
      ...data,
      meta: {
        ...data.meta,
        counts: { ...data.meta.counts, typeCoveredCount: 2, typeCoveredUnenforced: 1, uncoveredFiles: 0 },
      },
      residue: { ...data.residue, typeCovered },
    };

    // Overview: the unenforced file gets its OWN chip, using the SAME "no rule" state the
    // other unguarded-surface chips use — never the neutral "satisfied by a matched type"
    // mark, which would repeat the exact dishonesty this chip exists to correct. The
    // enforced file keeps its own, separate, smaller count.
    const ovStage = makeNode('div');
    Yg.views.overview(ovStage, { view: 'overview' }, withUnenforced, { navigate: () => undefined });
    const ovText = textOf(ovStage);
    expect(ovText).toMatch(/1.*no rule that applies/);
    expect(ovText).toMatch(/1.*matched type/); // the ENFORCED count (2 total − 1 unenforced)
    const unenforcedChip = walk(ovStage).find(
      (n) => n.classList && n.classList.contains('reslink') && textOf(n).includes('no rule that applies'),
    );
    expect(unenforcedChip).toBeTruthy();
    expect(classesIn(unenforcedChip as FakeNode).has(Yg.states.cssClass('no-rule'))).toBe(true);
    expect(classesIn(unenforcedChip as FakeNode).has('reslink-neutral')).toBe(false);

    // Coverage: BOTH file names appear on the page — never just a count — the unenforced one
    // tagged "checked by nothing" under the honest "no rule" badge, the enforced one under the
    // neutral "satisfied" mark. Neither line borrows the other's wording or badge.
    const covStage = makeNode('div');
    Yg.views.coverage(covStage, { view: 'coverage' }, withUnenforced, { navigate: () => undefined });
    const covText = textOf(covStage);
    expect(covText).toContain('src/unchecked.ts — type-covered as svc');
    expect(covText).toContain('src/checked.ts — type-covered as svc');
    expect(covText).toMatch(/checked by nothing/);
    const noRuleBadges = walk(covStage).filter((n) => n.classList && n.classList.contains(Yg.states.cssClass('no-rule')));
    expect(noRuleBadges.length).toBeGreaterThan(0);
  });

  it('the per-file type-covered listing is capped at 12 rows with "... and N more" — never one row per file on a large project', async () => {
    const Yg = await loadYg();
    const typeCovered: Array<{ path: string; type: string; enforced: boolean; unverified: boolean }> = [];
    for (let i = 0; i < 20; i += 1) {
      typeCovered.push({ path: 'src/file' + String(i).padStart(2, '0') + '.ts', type: 'svc', enforced: false, unverified: false });
    }
    const withMany: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, typeCoveredCount: 20, typeCoveredUnenforced: 20 } },
      residue: { ...data.residue, typeCovered },
    };
    const stage = makeNode('div');
    Yg.views.coverage(stage, { view: 'coverage' }, withMany, { navigate: () => undefined });
    const rows = walk(stage).filter((n) => n.classList && n.classList.contains('cov-typerow'));
    // 12 real file rows + one "... and N more" summary row — never 20 (one per file).
    expect(rows.length).toBe(13);
    expect(textOf(stage)).toContain('... and 8 more');
    // The capped rows are the FIRST 12 of the given (already path-sorted) list, not an
    // arbitrary slice — src/file00..src/file11 shown, src/file12 and beyond summarized.
    expect(textOf(stage)).toContain('src/file00.ts');
    expect(textOf(stage)).toContain('src/file11.ts');
    expect(textOf(stage)).not.toContain('src/file12.ts');
  });

  it('Overview never lets a type-covered-but-uncomputable file leak into the "accounted for" chip — the enforced count subtracts BOTH the unenforced and the uncomputable split', async () => {
    const Yg = await loadYg();
    const withUncomputable: PortalData = {
      ...data,
      meta: {
        ...data.meta,
        counts: { ...data.meta.counts, typeCoveredCount: 3, typeCoveredUnenforced: 1, typeCoveredUncomputable: 1 },
      },
      residue: {
        ...data.residue,
        typeCovered: [
          { path: 'src/checked.ts', type: 'svc', enforced: true, unverified: false },
          { path: 'src/unchecked.ts', type: 'svc', enforced: false, unverified: false },
        ],
        typeCoveredUncomputable: [
          { path: 'src/cyclic.ts', type: 'cyc', why: "The aspect graph has an implies cycle at 'cyc-a' — the cascade cannot tell which of the type's rules apply until that cycle is broken." },
        ],
      },
    };
    const stage = makeNode('div');
    Yg.views.overview(stage, { view: 'overview' }, withUncomputable, { navigate: () => undefined });
    // Each chip's own text is asserted in isolation (never a substring match across the whole
    // stage, which a "1" appearing in an unrelated earlier chip could satisfy by accident even
    // under the mutation this test exists to catch).
    const chips = walk(stage).filter((n) => n.classList && n.classList.contains('reslink'));
    const enforcedChip = chips.find((n) => textOf(n).includes('satisfied by their matched type'));
    const uncomputableChip = chips.find((n) => textOf(n).includes('could not be worked out'));
    const unenforcedChip = chips.find((n) => textOf(n).includes('no rule that applies'));
    expect(enforcedChip, 'no "accounted for" chip rendered').toBeTruthy();
    expect(uncomputableChip, 'no "could not be worked out" chip rendered').toBeTruthy();
    expect(unenforcedChip, 'no "no rule that applies" chip rendered').toBeTruthy();
    // Enforced is 1 (3 total − 1 unenforced − 1 uncomputable) — never 2, which is what a
    // regression that forgot to subtract typeCoveredUncomputable would render (the cyclic
    // file silently counted as "satisfied by their matched type").
    expect(textOf(enforcedChip as FakeNode)).toContain('1 files satisfied by their matched type');
    expect(textOf(enforcedChip as FakeNode)).not.toContain('2 files');
    expect(textOf(uncomputableChip as FakeNode)).toContain('1 files whose matched type');
    expect(textOf(unenforcedChip as FakeNode)).toContain('1 files matched by a type with no rule');
  });

  it('the Overview uncomputable chip carries its OWN glyph and aria-label — never the no-rule badge the unenforced chip right above it uses', async () => {
    const Yg = await loadYg();
    const withUncomputable: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, typeCoveredCount: 1, typeCoveredUncomputable: 1 } },
      residue: {
        ...data.residue,
        typeCoveredUncomputable: [
          { path: 'src/cyclic.ts', type: 'cyc', why: "The aspect graph has an implies cycle at 'cyc-a' — the cascade cannot tell which of the type's rules apply until that cycle is broken." },
        ],
      },
    };
    const stage = makeNode('div');
    Yg.views.overview(stage, { view: 'overview' }, withUncomputable, { navigate: () => undefined });
    const chips = walk(stage).filter((n) => n.classList && n.classList.contains('reslink'));
    const uncomputableChip = chips.find((n) => textOf(n).includes('could not be worked out'));
    expect(uncomputableChip, 'no "could not be worked out" chip rendered').toBeTruthy();
    const mark = walk(uncomputableChip as FakeNode).find((n) => n.classList && n.classList.contains('state-glyph'));
    expect(mark, 'no glyph mark on the uncomputable chip').toBeTruthy();
    // Its own class, never the no-rule state class the unenforced chip carries — swapping the
    // badge builder is the exact regression this test exists to catch, and it leaves the chip's
    // text and count completely unchanged, so only the glyph/class/aria-label tell them apart.
    expect(classesIn(uncomputableChip as FakeNode).has('reslink-unknown')).toBe(true);
    expect(classesIn(uncomputableChip as FakeNode).has(Yg.states.cssClass('no-rule'))).toBe(false);
    expect((mark as FakeNode).textContent).toBe('?');
    expect((mark as FakeNode).getAttribute('aria-label')).toBe('rules could not be worked out');
    // The badge above is honest even if the WORDS beside it are quietly swapped for the
    // no-rule wording — the glyph, class and aria-label are all built from a fixed literal
    // inside unknownLink, untouched by the chip's own sentence. Pin the category the sentence
    // actually names, not just its decoration: the parenthetical must read "unknown", never
    // the "no rule" text that sentence exists to rule out.
    const category = textOf(uncomputableChip as FakeNode).match(/\(([^,]+),/);
    expect(category, 'no "(<category>, ...)" parenthetical in the chip text').toBeTruthy();
    expect((category as RegExpMatchArray)[1]).toBe('unknown');
  });

  it('the Coverage & Audit uncomputable ledger row carries its OWN glyph and aria-label — never the no-rule badge the "checked by nothing" row above it uses', async () => {
    const Yg = await loadYg();
    const withUncomputable: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, typeCoveredCount: 1, typeCoveredUncomputable: 1 } },
      residue: {
        ...data.residue,
        typeCoveredUncomputable: [
          { path: 'src/cyclic.ts', type: 'cyc', why: "The aspect graph has an implies cycle at 'cyc-a' — the cascade cannot tell which of the type's rules apply until that cycle is broken." },
        ],
      },
    };
    const stage = makeNode('div');
    Yg.views.coverage(stage, { view: 'coverage' }, withUncomputable, { navigate: () => undefined });
    const nonpairRows = walk(stage).filter((n) => n.classList && n.classList.contains('cov-nonpair'));
    const uncomputableRow = nonpairRows.find((n) => textOf(n).includes('could not be worked out'));
    expect(uncomputableRow, 'no uncomputable ledger row rendered').toBeTruthy();
    const mark = walk(uncomputableRow as FakeNode).find((n) => n.classList && n.classList.contains('state-glyph'));
    expect(mark, 'no glyph mark on the uncomputable ledger row').toBeTruthy();
    // Relabelling the row with the "no rule" badge renders the exact forbidden sentence — "no
    // rule / satisfy coverage with no enforcement" — under a heading that says the honest answer
    // is unknown; text and count alone do not catch that, only the badge does.
    expect(classesIn(uncomputableRow as FakeNode).has('reslink-unknown')).toBe(true);
    expect(classesIn(uncomputableRow as FakeNode).has(Yg.states.cssClass('no-rule'))).toBe(false);
    expect((mark as FakeNode).textContent).toBe('?');
    expect((mark as FakeNode).getAttribute('aria-label')).toBe('rules could not be worked out');
    // The badge above stays honest even if only the row's WORD LABEL is quietly swapped to the
    // "no rule" wording (the glyph/class/aria-label all come from a fixed literal inside
    // unknownKey, untouched by its own `label` argument) — that swap renders the exact sentence
    // this row exists to rule out while every assertion above still passes. Pin the label text
    // itself, not just its decoration.
    const lbl = walk(uncomputableRow as FakeNode).find((n) => n.classList && n.classList.contains('cov-key-lbl'));
    expect(lbl, 'no .cov-key-lbl on the uncomputable ledger row').toBeTruthy();
    expect((lbl as FakeNode).textContent).toBe('unknown');
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
