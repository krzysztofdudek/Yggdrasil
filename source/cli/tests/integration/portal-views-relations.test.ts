import { describe, it, expect, beforeAll } from 'vitest';
import { extractPortalData } from '../../src/portal/extract.js';
import type { PortalData } from '../../src/portal/contract.js';
import { FIXTURE_ROOT, makeNode, walk, textOf, classesIn, clickFirst, loadYg, type FakeNode } from './portal-views-support.js';

/**
 * Integration tests for the Phase-4 component-kind Type Model and Relations & Boundaries view —
 * the resolved allow-list rendering (named targets / 'any' / genuinely forbidden / a data gap),
 * the dependency matrix's row-collapsing for unrestricted types, the fan-in/fan-out hubs, and
 * the live boundary counter (declaredOnly kept neutral, UNKNOWN surfaced honestly when the
 * parse could not run).
 *
 * One of six sibling files split out of the former `portal-views.test.ts` — see
 * `portal-views-support.ts` for the shared DOM shim / sandboxed module loader / tree-walking
 * helpers all of them use. Like the other siblings, these run the REAL committed view source in
 * a node:vm sandbox over a minimal DOM shim, driven by the REAL portal-basic fixture's
 * PortalData produced by the REAL pipeline (no fabricated contract, no mocking).
 */

describe('portal Phase-4 view modules (real source, real fixture data) — component-kinds view and dependency matrix', () => {
  let data: PortalData;

  beforeAll(async () => {
    data = await extractPortalData(FIXTURE_ROOT, { writeEnabled: false });
  }, 60_000);

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
    // The greyed diagonal (same-kind-to-same-kind cells, never drawn as allowed or forbidden)
    // gets its own legend key — without it the grey square reads exactly like the "empty cell =
    // forbidden" key right next to it, which is backwards on a permissive project where a
    // same-kind dependency IS allowed.
    expect(classesIn(stage).has('mtx-swatch-diag')).toBe(true);
    expect(text).toMatch(/grey diagonal.*not a restriction/i);
  });

  /** The `.ty-card` whose `.ty-name` textContent is exactly `id` — never a substring match on
   *  the card's full text (a type's own description can innocently contain another type's name,
   *  e.g. "module"'s "grouping of related services" containing "service"). */
  function typeCard(stage: FakeNode, id: string): FakeNode | undefined {
    return walk(stage)
      .filter((n) => n.classList && n.classList.contains('ty-card'))
      .find((c) => {
        const nameEl = walk(c).find((n) => n.classList && n.classList.contains('ty-name'));
        return !!nameEl && nameEl.textContent === id;
      });
  }

  /**
   * A mixed architecture, shared by the types-view and relations-matrix tests below so both
   * exercise the identical resolved shape: `A` is fully unrestricted (all six relation types
   * resolve to `'any'` — collapses); `B` is a REAL mix — a named target list for `uses` plus a
   * lone `'any'` entry for `calls` (only two of six relation types present at all, so it must
   * NEVER collapse); `C` has every relation type explicitly forbidden (`allowed: []` — the
   * genuine "structural parent only" case).
   */
  function mixedTypes(): PortalData['types'] {
    const allAny = (['uses', 'calls', 'extends', 'implements', 'emits', 'listens'] as const).map((t) => ({
      type: t,
      targets: 'any' as const,
    }));
    return [
      { id: 'A', parents: [], allowed: allAny, classifying: false, defaultAspects: [], strict: false, logRequired: false, nodeCount: 1 },
      {
        id: 'B',
        parents: [],
        allowed: [
          { type: 'uses', targets: ['A'] },
          { type: 'calls', targets: 'any' },
        ],
        classifying: true,
        defaultAspects: [],
        strict: false,
        logRequired: false,
        nodeCount: 1,
      },
      { id: 'C', parents: [], allowed: [], classifying: false, defaultAspects: [], strict: false, logRequired: false, nodeCount: 1 },
    ];
  }

  it('V6 Type Model reads the RESOLVED allow-list honestly: an all-\'any\' type renders the any-kind sentence (never "structural parent only"), and the classifying badge keys off type.classifying, not the relations', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    Yg.views.types(stage, { view: 'types' }, data, { navigate: () => undefined });

    // portal-basic's `module` and `service` both declare no relations table at all, so the
    // engine resolves EVERY one of the six relation types to 'any' for both — the fresh-setup,
    // no-restrictions-declared state that must render as unrestricted, never as "structural
    // parent only". Neither card may render the old default-deny wording, which used to appear
    // here because the view read a field (`allowedRelations`) the pipeline no longer emits.
    const moduleCard = typeCard(stage, 'module');
    const serviceCard = typeCard(stage, 'service');
    expect(moduleCard, 'no card rendered for the module type').toBeTruthy();
    expect(serviceCard, 'no card rendered for the service type').toBeTruthy();
    for (const card of [moduleCard, serviceCard] as FakeNode[]) {
      expect(textOf(card)).toContain('no restriction declared — may depend on any component type');
      expect(textOf(card)).not.toContain('structural parent only');
    }

    // The classifying/organizational badge is `type.classifying` — the type's OWN file-
    // classification predicate (`def.when !== undefined`) — never derived from the (identically
    // permissive) resolved relations both types share: `module` has no `when` (organizational),
    // `service` does (classifying), even though their allow-lists are byte-identical.
    expect(walk(moduleCard as FakeNode).some((n) => n.classList && n.classList.contains('ty-badge-org'))).toBe(true);
    expect(walk(moduleCard as FakeNode).some((n) => n.classList && n.classList.contains('ty-badge-cls'))).toBe(false);
    expect(walk(serviceCard as FakeNode).some((n) => n.classList && n.classList.contains('ty-badge-cls'))).toBe(true);
    expect(walk(serviceCard as FakeNode).some((n) => n.classList && n.classList.contains('ty-badge-org'))).toBe(false);

    // Renders no verdict color regardless.
    expect(classesIn(stage).has('state-verified')).toBe(false);
    expect(classesIn(stage).has('state-green')).toBe(false);
  });

  it('V6 Type Model renders the non-collapsed outcomes honestly: a named target list, an \'any\' entry inside a MIXED (not fully unrestricted) row, and a genuinely empty (forbidden) list', async () => {
    const Yg = await loadYg();
    const mixed: PortalData = { ...data, types: mixedTypes() };
    const stage = makeNode('div');
    Yg.views.types(stage, { view: 'types' }, mixed, { navigate: () => undefined });

    const cardB = typeCard(stage, 'B');
    const cardC = typeCard(stage, 'C');
    expect(cardB, 'no card rendered for the mixed type B').toBeTruthy();
    expect(cardC, 'no card rendered for the fully-forbidden type C').toBeTruthy();

    // B mixes a NAMED target list ('uses' → only 'A') with a per-entry 'any' ('calls' → any
    // component type) — a real mix, never collapsed (only 2 of the 6 relation types are even
    // present, so `isUnrestricted` cannot be satisfied). Deleting the ternary that renders
    // `a.targets === 'any' ? 'any component type' : a.targets.join(' · ')` (types-view.js:82)
    // would throw on this exact shape — a mixed row is the only shape that reaches the
    // `.join(...)` branch, so this test is what guards it.
    const bText = textOf(cardB as FakeNode);
    expect(bText).toContain('A'); // the named target of B's 'uses' entry
    expect(bText).toContain('any component type'); // B's 'calls' entry, individually, not collapsed
    expect(bText).not.toContain('no restriction declared — may depend on any component type');

    // C's allow-list is genuinely empty (every one of the six relation types explicitly
    // forbidden) — the one case that legitimately still reads "structural parent only".
    expect(textOf(cardC as FakeNode)).toContain('structural parent only (no code dependency permitted)');
  });

  it('V6 Type Model never renders "no restriction declared" for a type with a REAL restriction — five \'any\' entries plus one relation type explicitly forbidden (omitted) is not "every one of the six"', async () => {
    const Yg = await loadYg();
    // Five of the six relation types resolve to 'any'; 'listens' is OMITTED — a real, explicit
    // restriction, never present as a sixth entry. Weakening `isUnrestricted`'s guard from
    // `allowed.length === REL_TYPE_COUNT && allowed.every(...)` down to just `allowed.every(...)`
    // would let this five-entry array satisfy `every()` vacuously-adjacent (5/5 present entries
    // are 'any') and wrongly collapse into the false "no restriction" claim — on the
    // missing-sixth-entry axis, distinct from the missing-field axis the sibling test above locks.
    const fiveAnyOneForbidden: PortalData['types'][number] = {
      id: 'D',
      parents: [],
      allowed: (['uses', 'calls', 'extends', 'implements', 'emits'] as const).map((t) => ({ type: t, targets: 'any' as const })),
      classifying: false,
      defaultAspects: [],
      strict: false,
      logRequired: false,
      nodeCount: 1,
    };
    const withD: PortalData = { ...data, types: [...mixedTypes(), fiveAnyOneForbidden] };
    const stage = makeNode('div');
    Yg.views.types(stage, { view: 'types' }, withD, { navigate: () => undefined });

    const cardD = typeCard(stage, 'D');
    expect(cardD, 'no card rendered for type D').toBeTruthy();
    const textD = textOf(cardD as FakeNode);
    // The five present entries each still read individually...
    expect(textD).toContain('any component type');
    // ...but the row must never collapse — 'listens' is genuinely forbidden.
    expect(textD).not.toContain('no restriction declared');
  });

  it('V6 Type Model treats an ABSENT allow-list as a visible GAP, never as "structural parent only" — the exact substitution that caused the original defect', async () => {
    const Yg = await loadYg();
    // Forces the contract-required `allowed` field to be missing — impossible today (the
    // pipeline always populates it), which is exactly why this is a regression lock: a future
    // field rename must fall into the GAP branch, never silently back into the old "nothing is
    // permitted" reading — a real allow-list restriction and an absent field must never render
    // identically, or a data gap gets reported as if it were a deliberate architectural rule.
    const gapType = { ...mixedTypes()[0], id: 'GAP', allowed: undefined } as unknown as PortalData['types'][number];
    const withGap: PortalData = { ...data, types: [gapType] };
    const stage = makeNode('div');
    Yg.views.types(stage, { view: 'types' }, withGap, { navigate: () => undefined });

    const cardGap = typeCard(stage, 'GAP');
    expect(cardGap, 'no card rendered for the gap type').toBeTruthy();
    const text = textOf(cardGap as FakeNode);
    expect(text).toContain('allow-list unavailable — data missing, not a restriction');
    expect(text).not.toContain('structural parent only');
  });

  it('the matrix mirror treats an ABSENT allow-list as a visible GAP row, never a forbidden cell — same regression lock as the types view, and never confused with C\'s real, resolved empty list', async () => {
    const Yg = await loadYg();
    const gapType = { ...mixedTypes()[0], id: 'GAP', allowed: undefined } as unknown as PortalData['types'][number];
    const realC = mixedTypes()[2]; // allowed: [] — a REAL, resolved "everything forbidden" answer
    const withGap: PortalData = { ...data, types: [gapType, realC] };

    const typesById: Record<string, unknown> = { GAP: gapType, C: realC };
    // `allowedBetween` returns `null` — never `[]` — for a row with no allow-list data at all.
    expect(Yg.matrix.allowedBetween(typesById, 'GAP', 'C')).toBeNull();
    // C's own (real, resolved) empty list is unaffected — still `[]`, not `null`.
    expect(Yg.matrix.allowedBetween(typesById, 'C', 'GAP')).toEqual([]);

    const stage = makeNode('div');
    Yg.views.relations(stage, { view: 'relations' }, withGap, { navigate: () => undefined });
    const rows = walk(stage).filter((n) => n.classList && n.classList.contains('mtx-mirror-row'));
    const gapRow = rows.find((r) => textOf(r).trim().indexOf('GAP') === 0);
    expect(gapRow, 'no gap row rendered for the GAP type').toBeTruthy();
    expect(textOf(gapRow as FakeNode)).toContain('allow-list unavailable — data missing, not a restriction');
    // The whole-mirror "everything forbidden" fallback must never fire just because a real empty
    // list (C) sits alongside a data gap (GAP) — the two are structurally different findings and
    // neither one's rendering may mask or stand in for the other.
    const forbiddenFallback = walk(stage).find(
      (n) => n.classList && n.classList.contains('mtx-empty') && textOf(n).includes('every pair is a forbidden cell'),
    );
    expect(forbiddenFallback).toBeFalsy();
  });

  it('the matrix mirror collapses an all-\'any\' row to one line, and the whole mirror + canvas lead to one sentence when EVERY type is unrestricted — never one row per (row, rel, col) triple', async () => {
    const Yg = await loadYg();

    // portal-basic: both `module` and `service` resolve every relation type to 'any' (see the
    // V6 test above) — every type on the axis is unrestricted, so the WHOLE matrix collapses.
    const stageAll = makeNode('div');
    Yg.views.relations(stageAll, { view: 'relations' }, data, { navigate: () => undefined });
    const leadAll = walk(stageAll).find((n) => n.classList && n.classList.contains('view-lead'));
    expect(leadAll && textOf(leadAll)).toContain(
      'this architecture declares no relation restrictions yet — every dependency is currently allowed',
    );
    // The "allowed, not actual" caveat is APPENDED to the unrestricted lead sentence, never
    // dropped in favor of it — "every dependency is currently allowed" is what the architecture
    // permits, not a claim about what the code actually does.
    expect(leadAll && textOf(leadAll)).toContain('This is allowed, not actual');
    expect(walk(stageAll).filter((n) => n.classList && n.classList.contains('mtx-mirror-row')).length).toBe(0);
    const emptyAll = walk(stageAll).find((n) => n.classList && n.classList.contains('mtx-empty'));
    expect(emptyAll && textOf(emptyAll)).toContain('every dependency is currently allowed');
    // The canvas is still painted — the collapse is a text economy, never a missing grid.
    expect(classesIn(stageAll).has('mtx-canvas')).toBe(true);

    // Not every type is unrestricted in the shared mixed architecture (see `mixedTypes` above),
    // so only A's OWN row collapses — the mirror as a whole must still enumerate B's real edges.
    const mixed: PortalData = { ...data, types: mixedTypes() };
    const typesById: Record<string, unknown> = { A: mixed.types[0], B: mixed.types[1], C: mixed.types[2] };
    // 'any' membership: B's 'calls' entry targets every column, including one that carries no
    // OWN named list for B ('C' is not named under B's 'uses' list).
    expect(Yg.matrix.allowedBetween(typesById, 'B', 'A')).toEqual(['uses', 'calls']);
    expect(Yg.matrix.allowedBetween(typesById, 'B', 'C')).toEqual(['calls']);
    // C's allow-list is empty (every relation type explicitly forbidden) — never any membership.
    expect(Yg.matrix.allowedBetween(typesById, 'C', 'A')).toEqual([]);

    const stageMixed = makeNode('div');
    Yg.views.relations(stageMixed, { view: 'relations' }, mixed, { navigate: () => undefined });
    const leadMixed = walk(stageMixed).find((n) => n.classList && n.classList.contains('view-lead'));
    expect(leadMixed && textOf(leadMixed)).not.toContain('no relation restrictions yet');
    const rowsMixed = walk(stageMixed).filter((n) => n.classList && n.classList.contains('mtx-mirror-row'));
    // A's row collapses to ONE line; B contributes its two real column rows (→A, →C); C
    // contributes none (empty allow-list) — 3 total, never one row per (row, rel, col) triple.
    expect(rowsMixed.length).toBe(3);
    const aRow = rowsMixed.find((r) => textOf(r).trim().indexOf('A') === 0);
    expect(aRow, 'no collapsed row for the all-\'any\' type A').toBeTruthy();
    expect(textOf(aRow as FakeNode)).toContain('any component type (no restriction declared)');
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
});
