import { describe, it, expect, beforeAll } from 'vitest';
import { extractPortalData } from '../../src/portal/extract.js';
import type { PortalData } from '../../src/portal/contract.js';
import { FIXTURE_ROOT, makeNode, walk, textOf, loadYg } from './portal-views-support.js';

/**
 * Integration tests for the Phase-4 Suppressions VIEW module (the waiver inventory): the real
 * bounded span read from `form` (never the old blanket "bounded" claim, and never on a
 * whole-file waiver), risk-first sorting + risk labels taking precedence over the form span, and
 * the marker-total clause appearing only when it actually differs from the waiver count.
 *
 * One of six sibling files split out of the former `portal-views.test.ts` — see
 * `portal-views-support.ts` for the shared DOM shim / sandboxed module loader / tree-walking
 * helpers all of them use. Like the other siblings, these run the REAL committed view source in
 * a node:vm sandbox over a minimal DOM shim, driven by the REAL portal-basic fixture's
 * PortalData produced by the REAL pipeline (no fabricated contract, no mocking).
 */

describe('portal Phase-4 view modules (real source, real fixture data) — waiver inventory', () => {
  let data: PortalData;

  beforeAll(async () => {
    data = await extractPortalData(FIXTURE_ROOT, { writeEnabled: false });
  }, 60_000);

  it('a clean waiver reads its real span from `form` — never the old blanket "bounded" claim, and a whole-file waiver never reads "bounded"', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const suppressions: PortalData['suppressions'] = [
      { aspectId: 'a-line', file: 'src/a.ts', line: 3, reason: 'r1', form: 'line' },
      { aspectId: 'a-range', file: 'src/b.ts', line: 10, reason: 'r2', form: 'range' },
      { aspectId: 'a-file', file: 'src/c.ts', line: 1, reason: 'r3', form: 'file' },
    ];
    const withSup: PortalData = {
      ...data,
      suppressions,
      meta: { ...data.meta, counts: { ...data.meta.counts, suppressionMarkers: suppressions.length } },
    };
    Yg.views.suppressions(stage, { view: 'suppressions' }, withSup, { navigate: () => undefined });

    const flags = walk(stage)
      .filter((n) => n.classList && n.classList.contains('sup-flag-ok'))
      .map((n) => textOf(n));
    expect(flags).toContain('single line · bounded');
    expect(flags).toContain('range · bounded');
    expect(flags).toContain('whole file');
    // The whole-file waiver must never read "bounded" — that is the false claim being removed:
    // a waiver that switches a rule off for an entire file is not bounded.
    const wholeFileFlag = flags.find((t) => t === 'whole file');
    expect(wholeFileFlag).toBeTruthy();
    expect(wholeFileFlag).not.toMatch(/bounded/i);
  });

  it('an errs-under waiver shows its own risk label (never the form span beside it) and sorts ahead of an unbounded waiver, per the backend precedence', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const suppressions: PortalData['suppressions'] = [
      { aspectId: 'unb', file: 'src/z.ts', line: 5, reason: 'r-unb-marker', form: 'range', risk: 'unbounded' },
      { aspectId: 'eu', file: 'src/y.ts', line: 5, reason: 'r-eu-marker', form: 'line', risk: 'errs-under' },
    ];
    const withSup: PortalData = {
      ...data,
      suppressions,
      meta: { ...data.meta, counts: { ...data.meta.counts, suppressionMarkers: suppressions.length } },
    };
    Yg.views.suppressions(stage, { view: 'suppressions' }, withSup, { navigate: () => undefined });

    const rows = walk(stage).filter((n) => n.classList && n.classList.contains('sup-row'));
    expect(rows.length).toBe(2);
    // Sorted risk-first — the backend's own precedence (wildcard > typo > inert > errs-under >
    // unbounded) puts errs-under ahead of unbounded.
    expect(textOf(rows[0])).toContain('r-eu-marker');
    expect(textOf(rows[1])).toContain('r-unb-marker');
    // The errs-under row shows its own plain-language risk label...
    expect(textOf(rows[0])).toContain('WAIVES A RULE THAT CANNOT FALSE-ALARM');
    // ...and NEVER the form span beside it — a risk present wins the cell outright, so a row
    // can never read "single line · bounded" and a risk label at once.
    expect(textOf(rows[0])).not.toContain('single line · bounded');
  });

  it('the header line mentions the marker total ONLY when it actually differs from the waiver count', async () => {
    const Yg = await loadYg();
    const suppressions: PortalData['suppressions'] = [{ aspectId: 'a', file: 'src/a.ts', line: 1, reason: 'r', form: 'line' }];

    // Equal counts: the marker-total clause is a no-op sentence here and must be ABSENT.
    const equalStage = makeNode('div');
    const equalData: PortalData = {
      ...data,
      suppressions,
      meta: { ...data.meta, counts: { ...data.meta.counts, suppressionMarkers: suppressions.length } },
    };
    Yg.views.suppressions(equalStage, { view: 'suppressions' }, equalData, { navigate: () => undefined });
    expect(textOf(equalStage)).not.toMatch(/markers on disk/);

    // A marker total that exceeds the waiver count (e.g. a range-closing marker on disk, which
    // is not itself a waiver) — the clause must be PRESENT and name the real total.
    const diffStage = makeNode('div');
    const diffData: PortalData = {
      ...data,
      suppressions,
      meta: { ...data.meta, counts: { ...data.meta.counts, suppressionMarkers: suppressions.length + 1 } },
    };
    Yg.views.suppressions(diffStage, { view: 'suppressions' }, diffData, { navigate: () => undefined });
    expect(textOf(diffStage)).toMatch(new RegExp(`${suppressions.length + 1} markers on disk \\(a closing marker is not a waiver\\)`));
  });
});
