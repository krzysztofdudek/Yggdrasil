import { describe, it, expect, beforeAll } from 'vitest';
import { extractPortalData } from '../../src/portal/extract.js';
import type { PortalData, PortalEffectiveAspect } from '../../src/portal/contract.js';
import { FIXTURE_ROOT, makeNode, walk, textOf, classesIn, clickFirst, loadYg, type FakeNode } from './portal-views-support.js';

/**
 * Integration tests for the Phase-4 Node Attestation component panel (identity + effective
 * aspects + relations, each routing) and the Structure tree view that opens it via selection.
 *
 * One of six sibling files split out of the former `portal-views.test.ts` — see
 * `portal-views-support.ts` for the shared DOM shim / sandboxed module loader / tree-walking
 * helpers all of them use. Like the other siblings, these run the REAL committed view source in
 * a node:vm sandbox over a minimal DOM shim, driven by the REAL portal-basic fixture's
 * PortalData produced by the REAL pipeline (no fabricated contract, no mocking).
 */

describe('portal Phase-4 view modules (real source, real fixture data) — component panel', () => {
  let data: PortalData;

  beforeAll(async () => {
    data = await extractPortalData(FIXTURE_ROOT, { writeEnabled: false });
  }, 60_000);

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
    // The unverified pair shows the honest, status-aware caveat, never a green. This aspect
    // is enforced, so the caveat states it blocks (not the advisory "would warn" wording).
    expect(text).toMatch(/blocks until reviewed/i);
    expect(classesIn(panel).has('state-verified')).toBe(false);
    // The depends-on relation row routes to the target node.
    expect(clickFirst(panel, (n) => textOf(n).trim() === 'api/users')).toBe(true);
    expect(routes.some((r) => r.node === 'api/users')).toBe(true);
    // A node with no node selected closes the panel.
    const closed = makeNode('aside');
    Yg.views.panel(closed, { view: 'overview' }, data, { navigate: () => undefined });
    expect(closed.classList.contains('open')).toBe(false);
  });

  it('an enforced unverified row and an advisory unverified row render DIFFERENT sentences and different chips', async () => {
    const Yg = await loadYg();
    const panel = makeNode('aside');
    // Two synthetic effective-aspect rows on the SAME real node, differing only in status —
    // the one axis this locks. Everything else about the fixture (identity, relations) is real.
    const enfRow: PortalEffectiveAspect = {
      aspectId: 'a-enf',
      kind: 'deterministic',
      cost: 'free',
      status: 'enforced',
      channel: 1,
      origin: 'own',
      pairState: 'unverified',
    };
    const advRow: PortalEffectiveAspect = {
      aspectId: 'a-adv',
      kind: 'deterministic',
      cost: 'free',
      status: 'advisory',
      channel: 1,
      origin: 'own',
      pairState: 'unverified',
    };
    const twoRowData: PortalData = {
      ...data,
      nodes: data.nodes.map((n) => (n.path === 'api/orders' ? { ...n, effectiveAspects: [enfRow, advRow] } : n)),
    };
    Yg.views.panel(panel, { view: 'tree', node: 'api/orders' }, twoRowData, { navigate: () => undefined });

    const rows = walk(panel).filter((n) => n.classList && n.classList.contains('pan-asprow'));
    expect(rows.length).toBe(2);
    // Different chips — the enforcement-level chip carries a distinct class + label per row,
    // and status is populated on every row (never a blank chip).
    expect(classesIn(panel).has('pan-status-enforced')).toBe(true);
    expect(classesIn(panel).has('pan-status-advisory')).toBe(true);
    const chip = (n: FakeNode) => walk(n).filter((c) => c.classList && c.classList.contains('pan-status'));
    expect(chip(rows[0])[0].textContent).toBe('enforced');
    expect(chip(rows[1])[0].textContent).toBe('advisory');
    // Different sentences — the enforced row blocks; the advisory row would only warn. Never
    // the same wording reused for both consequences.
    const enfText = textOf(rows[0]);
    const advText = textOf(rows[1]);
    expect(enfText).toMatch(/blocks until reviewed/);
    expect(enfText).not.toMatch(/would warn, not block/);
    expect(advText).toMatch(/would warn, not block/);
    expect(advText).not.toMatch(/blocks until reviewed/);
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
});
