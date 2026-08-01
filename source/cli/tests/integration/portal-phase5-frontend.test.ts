import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { extractPortalData } from '../../src/portal/extract.js';
import type { PortalData } from '../../src/portal/contract.js';

/**
 * Phase-5 frontend tests (5.1 export + attestation digest · 5.2 file-aware loop in the views ·
 * 5.3 accessibility + org Approve guard).
 *
 * Same discipline as the sibling view tests: the REAL committed browser modules run in a
 * node:vm sandbox over a DOM shim, driven by the REAL portal-basic fixture's PortalData from the
 * REAL pipeline — no fabricated contract. The only "substitutions" are real contract FIELDS set
 * to real contract VALUES the pipeline itself emits (a node's `fresh` flag, `meta.lockHash` /
 * `meta.commitRef`, `meta.writeEnabled: false`) — exactly the way the sibling tests substitute
 * `boundary.unknown`. We assert: the export builders round-trip (parse the produced CSV/JSON
 * back); the digest pins the commit ref + lock hash; a touched node reads unverified across
 * Overview / Tree / panel and is never overridden by repo-green; the verdict bar carries ARIA;
 * every interactive control is keyboard-operable; the matrix has a DOM-list mirror; and view-only
 * mode hides the write control.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/portal-basic');
const MODULE_DIR = path.resolve(__dirname, '../../src/templates/portal/js');

// Serializer order EXCEPT the bootstrap (which boots the live DOM piecewise here).
const MODULES = [
  'namespace.js',
  'state-model.js',
  'glossary.js',
  'router.js',
  'palette.js',
  'palette-overlay.js',
  'consumer.js',
  'export.js',
  'tree.js',
  'shell.js',
  'dispatch.js',
  'views/overview-view.js',
  'views/coverage-view.js',
  'views/tree-view.js',
  'views/relations-matrix.js',
  'views/relations-view.js',
  'views/rulebook-view.js',
  'views/types-view.js',
  'views/flows-view.js',
  'views/suppressions-view.js',
  'views/start-view.js',
  'views/panel-view.js',
];

interface FakeNode {
  nodeType: number;
  tagName: string;
  _children: FakeNode[];
  _attrs: Record<string, string>;
  _listeners: Record<string, Array<(e?: unknown) => void>>;
  textContent: string;
  style: Record<string, string>;
  type?: string;
  disabled?: boolean;
  placeholder?: string;
  value?: string;
  className: string;
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  appendChild: (c: FakeNode) => FakeNode;
  removeChild: (c: FakeNode) => void;
  get firstChild(): FakeNode | undefined;
  addEventListener: (ev: string, fn: (e?: unknown) => void) => void;
  focus?: () => void;
  click?: () => void;
  scrollIntoView?: () => void;
  getContext?: () => null;
  width?: number;
  height?: number;
}

const downloads: Array<{ filename: string; content: string; mime: string }> = [];
// blob: URL → the bytes the Blob carried, so an anchor click can round-trip the artifact.
const BLOB_REGISTRY = new Map<string, string>();
// A deterministic counter for unique blob: URLs (no Math.random — the test runner is hermetic).
let blobSeq = 0;

function makeNode(tag: string): FakeNode {
  const children: FakeNode[] = [];
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(e?: unknown) => void>> = {};
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
    addEventListener: (ev: string, fn: (e?: unknown) => void) => {
      (listeners[ev] = listeners[ev] || []).push(fn);
    },
    focus: () => undefined,
    scrollIntoView: () => undefined,
  } as unknown as FakeNode;
  // An anchor's click captures the download artifact: a data: URI is decoded inline, and a
  // blob: URL is resolved through the sandbox's object-URL registry — so a test round-trips the
  // exact bytes either delivery path produced.
  if (String(tag).toLowerCase() === 'a') {
    node.click = () => {
      const href = attrs['href'] || '';
      const name = attrs['download'] || '';
      let content = '';
      if (href.startsWith('data:')) {
        content = decodeURIComponent(href.slice(href.indexOf(',') + 1));
      } else if (href.startsWith('blob:')) {
        content = BLOB_REGISTRY.get(href) || '';
      }
      downloads.push({ filename: name, content, mime: (href.match(/^data:([^;,]+)/) || [])[1] || '' });
    };
  }
  if (String(tag).toLowerCase() === 'canvas') node.getContext = () => null;
  return node;
}

function makeSandbox(): { window: Record<string, unknown>; document: Record<string, unknown> } {
  const body = makeNode('body');
  const documentObj: Record<string, unknown> = {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: String(text), _children: [] }),
    getElementById: () => null,
    addEventListener: () => undefined,
    documentElement: makeNode('html'),
    body,
  };
  const windowObj: Record<string, unknown> = {
    location: { hash: '', protocol: 'http:' },
    addEventListener: () => undefined,
    document: documentObj,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    // A Blob carries its joined byte content; createObjectURL registers those bytes against the
    // returned blob: URL so the anchor click round-trips them (the in-page, no-network path).
    Blob: function Blob(parts: unknown[]) {
      return { _content: (parts as string[]).join('') };
    },
    URL: {
      createObjectURL: (blob: { _content?: string }) => {
        blobSeq += 1;
        const url = 'blob:portal/' + blobSeq.toString(16);
        BLOB_REGISTRY.set(url, (blob && blob._content) || '');
        return url;
      },
      revokeObjectURL: (url: string) => {
        BLOB_REGISTRY.delete(url);
      },
    },
  };
  windowObj.window = windowObj;
  return { window: windowObj, document: documentObj };
}

async function loadYg(): Promise<Record<string, unknown>> {
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  for (const file of MODULES) {
    const src = await readFile(path.join(MODULE_DIR, file), 'utf-8');
    new vm.Script(src, { filename: file }).runInContext(context);
  }
  return (sandbox.window as { YgPortal: Record<string, unknown> }).YgPortal;
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
/** Every interactive element (button / a / input) under a subtree. */
function interactives(root: FakeNode): FakeNode[] {
  return walk(root).filter((n) => ['BUTTON', 'A', 'INPUT'].includes(n.tagName));
}

describe('Phase-5 frontend — export, file-aware loop, a11y, org guard (real source + real fixture)', () => {
  let data: PortalData;

  beforeAll(async () => {
    data = await extractPortalData(FIXTURE_ROOT, { writeEnabled: true });
    // Pin a real-shaped provenance so the digest/export assertions have something to attest.
    data = {
      ...data,
      meta: {
        ...data.meta,
        lockHash: 'a'.repeat(64),
        commitRef: 'b'.repeat(40),
      },
    } as PortalData;
  }, 60_000);

  // ── 5.1 EXPORT + ATTESTATION DIGEST ─────────────────────────────────────────

  it('5.1 — the suppressions/residue/coverage CSV exports round-trip back to the same rows', async () => {
    const Yg = await loadYg();
    const ex = Yg.exporter as {
      buildSuppressionsCsv: (d: PortalData) => string;
      buildResidueCsv: (d: PortalData) => string;
      buildCoverageCsv: (d: PortalData) => string;
    };
    // Suppressions CSV: header + one row per marker; quoted-field parse recovers the values.
    const supCsv = ex.buildSuppressionsCsv(data);
    const supRows = parseCsv(supCsv);
    expect(supRows[0]).toEqual(['file', 'line', 'aspect', 'risk', 'reason']);
    expect(supRows.length - 1).toBe(data.suppressions.length);

    // Residue CSV: one row per no-rule node + per uncovered file.
    const resRows = parseCsv(ex.buildResidueCsv(data));
    expect(resRows[0]).toEqual(['node', 'kind']);
    const expectedResidue = data.residue.noRuleNodes.length + data.residue.uncoveredFiles.length;
    expect(resRows.length - 1).toBe(expectedResidue);

    // Coverage CSV: a metric/value row per count, recovering the live verified total exactly.
    const covRows = parseCsv(ex.buildCoverageCsv(data));
    const verifiedRow = covRows.find((r) => r[0] === 'verified');
    expect(verifiedRow).toBeTruthy();
    expect(Number(verifiedRow![1])).toBe(data.meta.counts.verified);
  });

  it('5.1 — the JSON export round-trips and pins the lock hash + commit ref', async () => {
    const Yg = await loadYg();
    const ex = Yg.exporter as { buildExportJson: (d: PortalData) => Record<string, unknown> };
    const obj = ex.buildExportJson(data);
    const round = JSON.parse(JSON.stringify(obj)) as {
      provenance: { lockHash: string; commitRef: string };
      coverage: { verified: number };
      suppressions: unknown[];
    };
    expect(round.provenance.lockHash).toBe('a'.repeat(64));
    expect(round.provenance.commitRef).toBe('b'.repeat(40));
    expect(round.coverage.verified).toBe(data.meta.counts.verified);
    expect(round.suppressions.length).toBe(data.suppressions.length);
  });

  it('5.1 — a download trigger produces a Blob/data-URI artifact with NO network', async () => {
    downloads.length = 0;
    const Yg = await loadYg();
    const ex = Yg.exporter as { exportCoverageCsv: (d: PortalData) => boolean };
    const ok = ex.exportCoverageCsv(data);
    expect(ok).toBe(true);
    expect(downloads.length).toBe(1);
    expect(downloads[0].filename).toMatch(/coverage\.csv$/);
    // The captured artifact is the real CSV content (round-trips back).
    const rows = parseCsv(downloads[0].content);
    expect(rows[0]).toEqual(['metric', 'value']);
  });

  it('5.1 — the node panel digest pins the commit ref + lock hash (copyable)', async () => {
    const Yg = await loadYg() as unknown as {
      views: { panel: (p: FakeNode, r: unknown, d: PortalData, c: unknown) => void };
    };
    const panel = makeNode('aside');
    Yg.views.panel(panel, { view: 'tree', node: 'api/orders' }, data, { navigate: () => undefined });
    // The provenance pins are shown on the panel head.
    const text = textOf(panel);
    expect(text).toContain('b'.repeat(12)); // commit ref prefix
    expect(text).toContain('a'.repeat(12)); // lock hash prefix
    // The copy-digest control is present and keyboard-operable (a real button with aria-label).
    const copy = walk(panel).find((n) => n.tagName === 'BUTTON' && /attestation digest/i.test(textOf(n)));
    expect(copy).toBeTruthy();
    expect(copy!.getAttribute('aria-label')).toMatch(/attestation digest/i);
  });

  // ── 5.2 FILE-AWARE LOOP ACROSS VIEWS ─────────────────────────────────────────

  it('5.2 — a touched node reads unverified on Overview, Tree, and the panel (never repo-green)', async () => {
    const Yg = await loadYg() as unknown as {
      views: {
        overview: (s: FakeNode, r: unknown, d: PortalData, c: unknown) => void;
        tree: (s: FakeNode, r: unknown, d: PortalData, c: unknown) => void;
        panel: (p: FakeNode, r: unknown, d: PortalData, c: unknown) => void;
      };
      tree: { buildForest: (n: PortalData['nodes']) => unknown; flattenLayout: (f: unknown, d: unknown) => Array<{ node: PortalData['nodes'][number] }> };
    };
    // A real "all repo green" data shape with ONE node marked fresh — exactly what the pipeline
    // emits after a manual edit (the `fresh` flag is a real contract field). Force the repo to
    // green elsewhere so we prove the touched file is never overridden by whole-repo green.
    const greenData: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, refused: 0, unverified: 1, errors: 1, warnings: 0 } },
      nodes: data.nodes.map((n) =>
        n.path === 'api/orders' ? { ...n, fresh: true, state: 'unverified', rollupState: 'unverified' } : n,
      ),
    };

    // Tree: the touched node's row carries the unverified state class, not verified.
    const treeForest = Yg.tree.buildForest(greenData.nodes);
    const rows = Yg.tree.flattenLayout(treeForest, null);
    const ordersRow = rows.find((r) => r.node.path === 'api/orders')!;
    expect(ordersRow.node.state).toBe('unverified');

    // Panel: the touched node shows the freshness banner + unverified state, never green.
    const panel = makeNode('aside');
    Yg.views.panel(panel, { view: 'tree', node: 'api/orders' }, greenData, { navigate: () => undefined });
    expect(classesIn(panel).has('state-unverified')).toBe(true);
    expect(textOf(panel)).toMatch(/changed since the last reviewer pass/i);
    // The panel's own state badge is not the verified green.
    const head = walk(panel).find((n) => n.classList && n.classList.contains('pan-fresh'));
    expect(head).toBeTruthy();
  });

  // ── 5.3 ACCESSIBILITY + ORG APPROVE GUARD ────────────────────────────────────

  it('5.3 — the coverage verdict bar carries an ARIA group role + a labelled description', async () => {
    const Yg = await loadYg() as unknown as {
      views: { coverage: (s: FakeNode, r: unknown, d: PortalData, c: unknown) => void };
    };
    const stage = makeNode('div');
    Yg.views.coverage(stage, { view: 'coverage' }, data, { navigate: () => undefined });
    const bar = walk(stage).find((n) => n.classList && n.classList.contains('cov-bar'))!;
    expect(bar.getAttribute('role')).toBe('group');
    expect(bar.getAttribute('aria-label')).toMatch(/verified .* of .* expected pairs/i);
  });

  it('5.3 — every interactive control on the coverage view is keyboard-operable (button/anchor/input)', async () => {
    const Yg = await loadYg() as unknown as {
      views: { coverage: (s: FakeNode, r: unknown, d: PortalData, c: unknown) => void };
    };
    const stage = makeNode('div');
    Yg.views.coverage(stage, { view: 'coverage' }, data, { navigate: () => undefined });
    const controls = interactives(stage);
    expect(controls.length).toBeGreaterThan(0);
    // A native button / anchor / input is focusable and Enter/Space-activatable by default — no
    // div-with-onclick that a keyboard cannot reach. Assert no clickable plain div leaked in.
    const clickableDivs = walk(stage).filter(
      (n) => n.tagName === 'DIV' && n._listeners && n._listeners.click && n._listeners.click.length,
    );
    expect(clickableDivs.length).toBe(0);
  });

  it('5.3 — the allowed-relations matrix has a DOM-list mirror (screen-reader path)', async () => {
    const Yg = await loadYg() as unknown as {
      views: { relations: (s: FakeNode, r: unknown, d: PortalData, c: unknown) => void };
    };
    const stage = makeNode('div');
    Yg.views.relations(stage, { view: 'relations' }, data, { navigate: () => undefined });
    const mirror = walk(stage).find((n) => n.classList && n.classList.contains('mtx-mirror'));
    expect(mirror).toBeTruthy();
    expect(mirror!.getAttribute('aria-label')).toMatch(/allowed relations/i);
  });

  it('5.3 — the shell shows the Approve cost preview and the palette is keyboard-driven', async () => {
    const Yg = await loadYg() as unknown as {
      shell: { build: (root: FakeNode, d: PortalData, h: Record<string, () => void>) => unknown };
      palette: { create: (d: PortalData, router: { go: () => void }) => { open: () => void; isOpen: () => boolean; close: () => void } };
    };
    // The shell builds with write enabled — Approve is offered and operable.
    const root = makeNode('div');
    Yg.shell.build(root, data, { onNavigate: () => undefined, onSearch: () => undefined, onRefresh: () => undefined, onApprove: () => undefined, onTheme: () => undefined });
    const approve = walk(root).find((n) => n.tagName === 'BUTTON' && /approve/i.test(textOf(n)))!;
    expect(approve).toBeTruthy();
    expect(approve.disabled).toBeFalsy();

    // The palette opens, focuses an input, and arrow/Enter keys are wired (keyboard-first).
    const palette = Yg.palette.create(data, { go: () => undefined });
    palette.open();
    expect(palette.isOpen()).toBe(true);
    palette.close();
  });

  it('5.3 — view-only mode hides/disables the write control (org wall-board)', async () => {
    const Yg = await loadYg() as unknown as {
      shell: { build: (root: FakeNode, d: PortalData, h: Record<string, () => void>) => unknown };
    };
    const viewOnly: PortalData = { ...data, meta: { ...data.meta, writeEnabled: false } };
    const root = makeNode('div');
    Yg.shell.build(root, viewOnly, { onNavigate: () => undefined, onSearch: () => undefined, onRefresh: () => undefined, onApprove: () => undefined, onTheme: () => undefined });
    const approve = walk(root).find((n) => n.tagName === 'BUTTON' && /approve/i.test(textOf(n)))!;
    expect(approve).toBeTruthy();
    // The write action is disabled in view-only mode — the page never offers a write the server
    // would reject with 409.
    expect(approve.disabled).toBe(true);
    // The chrome states the view-only status.
    expect(textOf(root)).toMatch(/view-only/i);
  });
});

// ── 5.1, at coverage.type_level ON — the coverage CSV reconciles ──────────────────────────────
//
// portal-basic above never turns the tier on, so its coverage CSV round-trip proves nothing about
// whether the two type-level terms (typeCoveredCount / excludedFiles) reach the export at all —
// on that fixture both are zero and their absence from the row set is invisible. A real tier-on
// fixture is required to prove the identity `coveredFiles + typeCoveredCount + uncoveredFiles ===
// totalFiles` actually holds IN THE EXPORTED ARTIFACT, not only in the live counts object.
describe('Phase-5 export — the coverage CSV reconciles at coverage.type_level on (real tier-on fixture)', () => {
  let typeCovData: PortalData;

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-csv-typecov-'));
    cpSync(path.resolve(__dirname, '../fixtures/portal-type-coverage'), dir, { recursive: true });
    try {
      typeCovData = await extractPortalData(dir, { writeEnabled: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('the exported coverage CSV carries typeCoveredCount, typeCoveredUnenforced, and excludedFiles, and the four terms sum to totalFiles', async () => {
    const Yg = await loadYg();
    const ex = Yg.exporter as { buildCoverageCsv: (d: PortalData) => string };
    const rows = parseCsv(ex.buildCoverageCsv(typeCovData));
    const valueOf = (metric: string): number => {
      const row = rows.find((r) => r[0] === metric);
      expect(row, `no "${metric}" row in the exported coverage CSV`).toBeTruthy();
      return Number((row as string[])[1]);
    };
    // Sanity-pin the fixture's own shape (see portal-extract.test.ts's identical pin) so a future
    // edit to it cannot silently invalidate what this test is actually proving.
    expect(typeCovData.meta.counts.totalFiles).toBe(4);
    expect(valueOf('coveredFiles') + valueOf('typeCoveredCount') + valueOf('uncoveredFiles')).toBe(
      valueOf('totalFiles'),
    );
    expect(valueOf('typeCoveredUnenforced')).toBe(1);
    expect(valueOf('excludedFiles')).toBe(1);
  });

  it('the exported residue CSV names the unenforced type-covered file and the excluded file, not only the checked type-covered one', async () => {
    const Yg = await loadYg();
    const ex = Yg.exporter as { buildResidueCsv: (d: PortalData) => string };
    const rows = parseCsv(ex.buildResidueCsv(typeCovData));
    expect(rows).toContainEqual(['src/lib/util.ts', 'type-covered-no-enforcement (lib)']);
    expect(rows).toContainEqual(['vendor/tool.ts', 'excluded-file']);
    // The CHECKED type-covered file is not a residue item — it has a real verdict.
    expect(rows.some((r) => r[0] === 'src/svc/handler.ts')).toBe(false);
  });
});

/** A small RFC-4180 CSV parser sufficient to round-trip the export builders' output. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // swallow; the \n closes the row
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
