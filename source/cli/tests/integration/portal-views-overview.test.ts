import { describe, it, expect, beforeAll } from 'vitest';
import { extractPortalData } from '../../src/portal/extract.js';
import type { PortalData } from '../../src/portal/contract.js';
import { FIXTURE_ROOT, makeNode, walk, textOf, classesIn, clickFirst, loadYg, type FakeNode } from './portal-views-support.js';

/**
 * Integration tests for the Phase-4 Overview VIEW module: the honest verdict sentence (never
 * green when pairs are unverified), its blocking/advisory count breakdown, and the shared
 * dispatcher + legend bar that every registered view routes through.
 *
 * One of six sibling files split out of the former `portal-views.test.ts` — see
 * `portal-views-support.ts` for the shared DOM shim / sandboxed module loader / tree-walking
 * helpers all of them use. Like the other siblings, these run the REAL committed view source in
 * a node:vm sandbox over a minimal DOM shim, driven by the REAL portal-basic fixture's
 * PortalData produced by the REAL pipeline (no fabricated contract, no mocking).
 */

describe('portal Phase-4 view modules (real source, real fixture data) — overview verdict', () => {
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

  it('the overview verdict sentence reports blocking and advisory counts SEPARATELY, derived from meta.counts', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    // Distinct numbers in every slot so a slot printing the wrong count cannot hide behind a
    // coincidental match. errors=5, refused=2 -> "other blocker(s)" = errors - refused = 3;
    // warnings=4 is its own, separate advisory figure.
    const withBoth: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, errors: 5, refused: 2, warnings: 4, unverified: 3 } },
    };
    Yg.views.overview(stage, { view: 'overview' }, withBoth, { navigate: () => undefined });
    const text = textOf(stage);
    expect(text).toMatch(/5 blocking item\(s\)/);
    expect(text).toMatch(/2 refusal\(s\)/);
    expect(text).toMatch(/3 other blocker\(s\)/);
    expect(text).toMatch(/4 advisory signal\(s\)/);
  });

  it('a project whose only failure is a coverage finding still reports a non-zero blocking count (never derived from the worklist)', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    // No pair failed (refused=0, unverified=0) — the ONLY error is a coverage finding (e.g. an
    // unmapped-file error), which `check.issues`/meta.counts.errors counts but the worklist
    // deliberately excludes. The worklist is emptied too, so a worklist-derived sentence would
    // wrongly read 0 blocking here while the real blocking figure is 1.
    const coverageOnly: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, errors: 1, refused: 0, unverified: 0, warnings: 0 } },
      worklist: [],
    };
    Yg.views.overview(stage, { view: 'overview' }, coverageOnly, { navigate: () => undefined });
    const text = textOf(stage);
    expect(text).toMatch(/1 blocking item\(s\)/);
    expect(text).toMatch(/0 refusal\(s\)/);
    expect(text).toMatch(/1 other blocker\(s\)/);
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
