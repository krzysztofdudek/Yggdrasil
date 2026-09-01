import { describe, it, expect, beforeAll } from 'vitest';
import { extractPortalData } from '../../src/portal/extract.js';
import type { PortalData, PortalTypeCoveredFile } from '../../src/portal/contract.js';
import { FIXTURE_ROOT, makeNode, walk, textOf, classesIn, clickFirst, loadYg, type FakeNode } from './portal-views-support.js';

/**
 * Integration tests for the Phase-4 type-covered file listing: the Overview accounting chips
 * (matched/unmatched/uncomputable type-covered counts) and the Coverage & Audit view's own
 * per-file listing, badges, and caps. Both surfaces render the SAME underlying `residue.typeCovered`
 * / `typeCoveredUncomputable` data, so the honesty assertions for it are kept together here rather
 * than split by which view happens to render them.
 *
 * One of six sibling files split out of the former `portal-views.test.ts` — see
 * `portal-views-support.ts` for the shared DOM shim / sandboxed module loader / tree-walking
 * helpers all of them use. Like the other siblings, these run the REAL committed view source in
 * a node:vm sandbox over a minimal DOM shim, driven by the REAL portal-basic fixture's
 * PortalData produced by the REAL pipeline (no fabricated contract, no mocking).
 */

describe('portal Phase-4 view modules (real source, real fixture data) — type-covered file listing', () => {
  let data: PortalData;

  beforeAll(async () => {
    data = await extractPortalData(FIXTURE_ROOT, { writeEnabled: false });
  }, 60_000);

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

  it('Coverage never renders a type-covered line when the count is zero (flag-off stays unchanged)', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    Yg.views.coverage(stage, { view: 'coverage' }, data, { navigate: () => undefined });
    expect(textOf(stage)).not.toContain('type-covered');
  });

  it('Coverage shows a nonzero type-covered count on its OWN line — never inside "not in coverage fraction" (its pairs ARE counted in the bar)', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const typeCovered: PortalTypeCoveredFile[] = [
      { path: 'src/a.ts', type: 'svc', enforced: true, pairState: 'verified' },
      { path: 'src/b.ts', type: 'svc', enforced: true, pairState: 'verified' },
      { path: 'src/c.ts', type: 'svc', enforced: true, pairState: 'verified' },
      { path: 'src/d.ts', type: 'svc', enforced: true, pairState: 'verified' },
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
  //
  // Migrated off the removed `unverified: boolean` field onto the real `pairState` the
  // backend now supplies (contract.ts's `PortalTypeCoveredFile.pairState`). The per-row
  // text suffix (`— unverified`) is gone too — the row's real state is now a badge from
  // the shared state model, never an ad-hoc text marker.
  it('an enforced-but-unverified type-covered file is named in both the chip suffix and its own row, badged with its real pairState — never a bare "satisfied" claim', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const typeCovered: PortalTypeCoveredFile[] = [
      { path: 'src/crashy/a.ts', type: 'crashy', enforced: true, pairState: 'unverified' },
      { path: 'src/leaf/a.ts', type: 'leaf', enforced: true, pairState: 'verified' },
    ];
    const withUnverified: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, typeCoveredCount: 2, typeCoveredUnenforced: 0 } },
      residue: { ...data.residue, typeCovered },
    };
    Yg.views.coverage(stage, { view: 'coverage' }, withUnverified, { navigate: () => undefined });
    // The chip names how many of the enforced files are refused vs have no recorded
    // verdict — two SEPARATE numbers, never folded into one.
    expect(textOf(stage)).toMatch(/2.*type-covered.*0 refused.*1 with no recorded verdict/);
    // Its own row is badged individually — the OTHER (verified) enforced file's row
    // carries a DIFFERENT state class, never the same badge.
    const rows = walk(stage).filter((n) => n.classList && n.classList.contains('cov-typerow') && n.classList.contains('mono'));
    const crashyRow = rows.find((r) => textOf(r).includes('src/crashy/a.ts'));
    const leafRow = rows.find((r) => textOf(r).includes('src/leaf/a.ts'));
    expect(crashyRow, 'no row rendered for src/crashy/a.ts').toBeTruthy();
    expect(leafRow, 'no row rendered for src/leaf/a.ts').toBeTruthy();
    expect(classesIn(crashyRow as FakeNode).has(Yg.states.cssClass('unverified'))).toBe(true);
    expect(classesIn(crashyRow as FakeNode).has(Yg.states.cssClass('verified'))).toBe(false);
    expect(classesIn(leafRow as FakeNode).has(Yg.states.cssClass('verified'))).toBe(true);
    expect(classesIn(leafRow as FakeNode).has(Yg.states.cssClass('unverified'))).toBe(false);
  });

  it('an enforced REFUSED type-covered file shows a refused badge on its own row AND its refusal reason beneath it — never dropped', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const typeCovered: PortalTypeCoveredFile[] = [
      {
        path: 'src/svc/handler.ts',
        type: 'svc',
        enforced: true,
        pairState: 'refused',
        reasons: ['Missing the required error-boundary wrapper around the handler body.'],
      },
    ];
    const withRefused: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, typeCoveredCount: 1, typeCoveredUnenforced: 0 } },
      residue: { ...data.residue, typeCovered },
    };
    Yg.views.coverage(stage, { view: 'coverage' }, withRefused, { navigate: () => undefined });
    const row = walk(stage).find(
      (n) => n.classList && n.classList.contains('cov-typerow') && n.classList.contains('mono') && textOf(n).includes('src/svc/handler.ts'),
    );
    expect(row, 'no row rendered for src/svc/handler.ts').toBeTruthy();
    expect(classesIn(row as FakeNode).has(Yg.states.cssClass('refused'))).toBe(true);
    const badge = walk(row as FakeNode).find((n) => n.classList && n.classList.contains('state-glyph'));
    expect(badge, 'no state badge on the refused row').toBeTruthy();
    expect((badge as FakeNode).getAttribute('aria-label')).toBe('refused');
    // The reason is rendered beneath the row via the same `.cov-member-what` treatment the
    // worklist already uses — never dropped just because this file has no component of its own.
    expect(textOf(row as FakeNode)).toContain('Missing the required error-boundary wrapper around the handler body.');
    const reasonEl = walk(row as FakeNode).find((n) => n.classList && n.classList.contains('cov-member-what'));
    expect(reasonEl, 'no .cov-member-what reason element on the refused row').toBeTruthy();
  });

  it('an enforced WARNING (advisory-refused) type-covered file shows its own reason too — an advisory refusal is signal, not silence, just because it does not block', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const typeCovered: PortalTypeCoveredFile[] = [
      {
        path: 'src/lib/util.ts',
        type: 'svc',
        enforced: true,
        pairState: 'warning',
        reasons: ['Advisory style rule flagged an unusual export pattern.'],
      },
    ];
    const withWarning: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, typeCoveredCount: 1, typeCoveredUnenforced: 0 } },
      residue: { ...data.residue, typeCovered },
    };
    Yg.views.coverage(stage, { view: 'coverage' }, withWarning, { navigate: () => undefined });
    const row = walk(stage).find(
      (n) => n.classList && n.classList.contains('cov-typerow') && n.classList.contains('mono') && textOf(n).includes('src/lib/util.ts'),
    );
    expect(row, 'no row rendered for src/lib/util.ts').toBeTruthy();
    expect(classesIn(row as FakeNode).has(Yg.states.cssClass('warning'))).toBe(true);
    // Never the blocking `refused` class — an advisory refusal is non-blocking signal.
    expect(classesIn(row as FakeNode).has(Yg.states.cssClass('refused'))).toBe(false);
    expect(textOf(row as FakeNode)).toContain('Advisory style rule flagged an unusual export pattern.');
    // The chip suffix names the advisory count as its OWN figure — never silently added to
    // "refused", and never folded into a bare total.
    expect(textOf(stage)).toMatch(/1.*type-covered.*0 refused.*1 advisory.*0 with no recorded verdict/);
  });

  it('an unenforced type-covered file still shows the honest no-rule badge on its summary line, and its OWN row carries no per-row state badge — it has no pairState to badge', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const typeCovered: PortalTypeCoveredFile[] = [{ path: 'src/unchecked.ts', type: 'svc', enforced: false }];
    const withUnenforced: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, typeCoveredCount: 1, typeCoveredUnenforced: 1 } },
      residue: { ...data.residue, typeCovered },
    };
    Yg.views.coverage(stage, { view: 'coverage' }, withUnenforced, { navigate: () => undefined });
    // The summary line's own key still carries the honest "no rule" badge.
    const noRuleBadges = walk(stage).filter((n) => n.classList && n.classList.contains(Yg.states.cssClass('no-rule')));
    expect(noRuleBadges.length).toBeGreaterThan(0);
    // Its own row (the plain-text unenforced list) carries NO state badge at all — a missing
    // `pairState` must never fall through to a fabricated verified-looking badge.
    const row = walk(stage).find(
      (n) => n.classList && n.classList.contains('cov-typerow') && n.classList.contains('mono') && textOf(n).includes('src/unchecked.ts'),
    );
    expect(row, 'no row rendered for src/unchecked.ts').toBeTruthy();
    const badgeInRow = walk(row as FakeNode).find((n) => n.classList && n.classList.contains('state-glyph'));
    expect(badgeInRow).toBeFalsy();
  });

  it('a type-covered file with NO applicable rule renders as unenforced — named by file and type, never folded into "satisfied by a matched type", on both Overview and Coverage', async () => {
    const Yg = await loadYg();
    const typeCovered: PortalTypeCoveredFile[] = [
      { path: 'src/checked.ts', type: 'svc', enforced: true, pairState: 'verified' },
      { path: 'src/unchecked.ts', type: 'svc', enforced: false },
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
    const typeCovered: Array<{ path: string; type: string; enforced: boolean }> = [];
    for (let i = 0; i < 20; i += 1) {
      typeCovered.push({ path: 'src/file' + String(i).padStart(2, '0') + '.ts', type: 'svc', enforced: false });
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
    // The capped rows are sorted worst-pairState-first, path as the tie-break (see
    // coverage-typecovered.js's `pairStateRank`). None of these entries carry a `pairState`
    // (all `enforced: false`, the unenforced list), so every entry ties and the sort falls
    // straight through to path order — src/file00..src/file11 shown, src/file12 and beyond
    // summarized, same as a plain path-ordered cap would give.
    expect(textOf(stage)).toContain('src/file00.ts');
    expect(textOf(stage)).toContain('src/file11.ts');
    expect(textOf(stage)).not.toContain('src/file12.ts');
  });

  it('a refused row sorts into view instead of being cut by the cap, even when its path would place it last', async () => {
    const Yg = await loadYg();
    // 13 enforced, type-covered files — one cap's worth plus one. In raw path order the
    // single refused file (src/z-refused.ts) sorts LAST and would be the one row the 12-row
    // cap cuts, while 12 verified rows show — the exact "refused row invisible, verified
    // rows visible" defect this sort exists to prevent.
    const typeCovered: PortalTypeCoveredFile[] = [];
    for (let i = 0; i < 12; i += 1) {
      typeCovered.push({
        path: 'src/a-verified' + String(i).padStart(2, '0') + '.ts',
        type: 'svc',
        enforced: true,
        pairState: 'verified',
      });
    }
    typeCovered.push({
      path: 'src/z-refused.ts',
      type: 'svc',
      enforced: true,
      pairState: 'refused',
      reasons: ['does not satisfy the matched type\'s aspect'],
    });
    const withRefused: PortalData = {
      ...data,
      meta: { ...data.meta, counts: { ...data.meta.counts, typeCoveredCount: 13 } },
      residue: { ...data.residue, typeCovered },
    };
    const stage = makeNode('div');
    Yg.views.coverage(stage, { view: 'coverage' }, withRefused, { navigate: () => undefined });
    const rows = walk(stage).filter((n) => n.classList && n.classList.contains('cov-typerow'));
    expect(rows.length).toBe(13); // 12 shown + one "... and 1 more" summary row
    expect(textOf(stage)).toContain('... and 1 more');
    // The refused row is IN the shown 12, not summarized away.
    expect(textOf(stage)).toContain('src/z-refused.ts');
    // Exactly one verified row was bumped past the fold to make room for it — which one is
    // unasserted (path tie-break among equal-ranked verified rows), only that some was.
    const shownVerifiedCount = typeCovered
      .slice(0, 12)
      .filter((f) => textOf(stage).includes(f.path)).length;
    expect(shownVerifiedCount).toBe(11);
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
          { path: 'src/checked.ts', type: 'svc', enforced: true, pairState: 'verified' },
          { path: 'src/unchecked.ts', type: 'svc', enforced: false },
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
});
