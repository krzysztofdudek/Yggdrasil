import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import type { PortalData } from '../../src/portal/contract.js';

/**
 * Shared test infrastructure for the Phase-4 chunk-1 portal VIEW module tests: Overview,
 * Coverage & Audit (needs-attention worklist / type-covered file listing / boundary counter),
 * the Node Attestation panel, the Structure tree, Relations & Boundaries (hubs, live boundary,
 * the dependency matrix), and the component-kind Type Model. These were originally one file
 * (`portal-views.test.ts`) and are now split one-file-per-surface so each stays comfortably
 * under this repo's own reviewer prompt-size ceiling; this module holds the DOM shim, the
 * sandboxed module loader, and the tree-walking helpers every sibling file needs, so none of
 * them keeps its own copy to drift out of sync with the others.
 *
 * `loadYg` runs the REAL committed view source in a node:vm sandbox over a minimal DOM shim —
 * the actual module code executes, not a reimplementation of it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/portal-basic');
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
  'views/coverage-worklist.js',
  'views/coverage-view.js',
  'views/tree-view.js',
  'views/relations-matrix.js',
  'views/relations-view.js',
  'views/types-view.js',
  'views/panel-aspect.js',
  'views/panel-view.js',
  'views/suppressions-view.js',
];

/** A DOM node shim rich enough for the view renderers and our tree-walking assertions. */
export interface FakeNode {
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

export function makeNode(tag: string): FakeNode {
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

export interface Yg {
  views: Record<string, (stage: FakeNode, route: unknown, data: PortalData, ctx: unknown) => void> & {
    /** The worklist group/member renderer: renders each needs-attention group's rows and
     *  resolves a group's badge state from its issue code. coverage-view.js delegates
     *  worklist rendering to this sub-module; exposed here so a test can call
     *  `badgeState`/`renderRows` directly instead of only exercising them indirectly
     *  through the full coverage view. */
    coverageWorklist: {
      badgeState: (group: { code: string; severity: 'error' | 'warning' }) => string;
      renderRows: (stage: FakeNode, data: PortalData, nav: (r: Record<string, string>) => void) => void;
    };
  };
  matrix: {
    axisTypes: (types: PortalData['types']) => string[];
    // `null` (never `[]`) signals a data gap — a row with no allow-list data at all — kept
    // distinct from `[]`, the real, resolved "this row permits nothing here" answer.
    allowedBetween: (byId: Record<string, unknown>, r: string, c: string) => string[] | null;
  };
  states: { cssClass: (s: string) => string };
}

export async function loadYg(): Promise<Yg> {
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  for (const file of MODULES) {
    const src = await readFile(path.join(MODULE_DIR, file), 'utf-8');
    new vm.Script(src, { filename: file }).runInContext(context);
  }
  return (sandbox.window as { YgPortal: Yg }).YgPortal;
}

/** Depth-first collect every node + text node under `root` (inclusive). */
export function walk(root: FakeNode): FakeNode[] {
  const out: FakeNode[] = [root];
  for (const c of root._children || []) out.push(...walk(c));
  return out;
}

/** The concatenated text of an element subtree. */
export function textOf(root: FakeNode): string {
  return walk(root)
    .map((n) => (n.nodeType === 3 ? n.textContent : n._children && n._children.length === 0 ? n.textContent : ''))
    .join(' ');
}

/** Every class token used anywhere in the subtree. */
export function classesIn(root: FakeNode): Set<string> {
  const set = new Set<string>();
  for (const n of walk(root)) {
    if (typeof n.className === 'string') n.className.split(/\s+/).filter(Boolean).forEach((c) => set.add(c));
  }
  return set;
}

/** Fire the first click listener on the first node matching `predicate`, return captured routes. */
export function clickFirst(root: FakeNode, predicate: (n: FakeNode) => boolean): boolean {
  for (const n of walk(root)) {
    if (predicate(n) && n._listeners && n._listeners.click && n._listeners.click.length) {
      n._listeners.click[0]();
      return true;
    }
  }
  return false;
}
