import { describe, it, expect, beforeAll } from 'vitest';
import { extractPortalData } from '../../src/portal/extract.js';
import type { PortalData } from '../../src/portal/contract.js';
import { FIXTURE_ROOT, makeNode, walk, textOf, classesIn, clickFirst, loadYg, type FakeNode } from './portal-views-support.js';

/**
 * Integration tests for the Phase-4 Coverage & Audit needs-attention worklist: the live pair
 * counts / bar segments, `badgeState`'s code-keyed (never label-keyed) classification, group
 * rendering (divergent-why, severity glyphs, file vs. node members, sibling layout), and the
 * live boundary counter this view surfaces alongside the worklist.
 *
 * One of six sibling files split out of the former `portal-views.test.ts` — see
 * `portal-views-support.ts` for the shared DOM shim / sandboxed module loader / tree-walking
 * helpers all of them use. Like the other siblings, these run the REAL committed view source in
 * a node:vm sandbox over a minimal DOM shim, driven by the REAL portal-basic fixture's
 * PortalData produced by the REAL pipeline (no fabricated contract, no mocking).
 */

describe('portal Phase-4 view modules (real source, real fixture data) — needs-attention worklist', () => {
  let data: PortalData;

  beforeAll(async () => {
    data = await extractPortalData(FIXTURE_ROOT, { writeEnabled: false });
  }, 60_000);

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
    expect(routes.some((r) => r.node === data.worklist[0].members.find((m) => m.node)?.node)).toBe(true);
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

  it('badgeState keys off the CODE, never the display label — unverified-family vs any other error vs warning', async () => {
    const Yg = await loadYg();
    const badgeState = Yg.views.coverageWorklist.badgeState;
    expect(badgeState({ code: 'unverified', severity: 'error' })).toBe('unverified');
    expect(badgeState({ code: 'prompt-too-large', severity: 'error' })).toBe('unverified');
    expect(badgeState({ code: 'aspect-companion-runtime-error', severity: 'error' })).toBe('unverified');
    // Any other error code — refused, never inferred from a label that happens to read "unverified".
    expect(badgeState({ code: 'aspect-violation', severity: 'error' })).toBe('refused');
    // A warning is always the warning glyph, regardless of code.
    expect(badgeState({ code: 'aspect-violation-advisory', severity: 'warning' })).toBe('warning');
    expect(badgeState({ code: 'unverified', severity: 'warning' })).toBe('warning');
    // A code colliding with an inherited Object.prototype member name must not read as
    // unverified via the prototype chain (M1: hasOwnProperty-guarded lookup).
    expect(badgeState({ code: 'constructor', severity: 'error' })).toBe('refused');
    expect(badgeState({ code: 'toString', severity: 'error' })).toBe('refused');
  });

  it('a coverage-only red build (empty worklist, nonempty worklistCoverage) never reads "All clear" — regression lock for C1', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const coverageOnly: PortalData = {
      ...data,
      worklist: [],
      worklistCoverage: [
        { code: 'unmapped-files', severity: 'error', files: ['src/b.ts'], why: 'files are not mapped to any node', fix: 'map or exclude them' },
      ],
      meta: { ...data.meta, counts: { ...data.meta.counts, errors: 1, warnings: 0 } },
    };
    Yg.views.coverage(stage, { view: 'coverage' }, coverageOnly, { navigate: () => undefined });

    // The count folds worklistCoverage in — "Needs attention (1)", never (0) — and the calm
    // panel never renders on a build the live counts say is failing.
    const countEl = walk(stage).find((n) => n.classList && n.classList.contains('cov-section-count'));
    expect(countEl && textOf(countEl)).toContain('(1)');
    expect(classesIn(stage).has('cov-calm')).toBe(false);
    // The jump button: this synthetic worklist has no groups at all (only a coverage block,
    // which carries no navigable node), so there is nothing to jump to — the button must fall
    // back to a NON-calm label. It must never say "clear" on a build with a live error.
    const jumpBtn = walk(stage).find((n) => n.classList && n.classList.contains('cov-jump'));
    expect(jumpBtn).toBeTruthy();
    expect(textOf(jumpBtn as FakeNode).toLowerCase()).not.toContain('clear');
    expect(classesIn(stage).has('cov-jump-residue')).toBe(false);
    // The coverage block itself still renders, findable by file.
    expect(textOf(stage)).toContain('src/b.ts');
  });

  it('a repo-level member\'s own "what" text renders — never an empty row — regression lock for C2', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    Yg.views.coverage(stage, { view: 'coverage' }, data, { navigate: () => undefined });
    // portal-basic's real `rules-digest-stale` group is repo-level (no node, no file) and
    // single-member — its member's `what` IS the finding's entire content (derive-rest.ts).
    const staleGroup = data.worklist.find((g) => g.code === 'rules-digest-stale');
    expect(staleGroup).toBeTruthy();
    const member = staleGroup!.members[0];
    expect(member.what).toBeTruthy();
    expect(textOf(stage)).toContain(member.what as string);
  });

  it('a divergent-why group never shows one member\'s reason as the shared header line', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const divergentGroup: PortalData['worklist'][number] = {
      code: 'relation-undeclared-dependency',
      rule: 'relation-undeclared-dependency',
      severity: 'error',
      pairCount: 2,
      nodeCount: 2,
      fileCount: 0,
      // sharedWhy is only ever the FIRST member's own reason (group-issues.ts) — a
      // divergentWhy group must never print this as if every member agreed on it.
      why: 'member-1-only reason',
      fix: 'declare it',
      divergentWhy: true,
      divergentNext: false,
      perMemberReason: false,
      members: [
        { node: 'api/orders', why: 'member-1-only reason' },
        { node: 'api/users', why: 'a totally different reason for the other member' },
      ],
    };
    const withDivergent: PortalData = { ...data, worklist: [divergentGroup], worklistCoverage: [] };
    Yg.views.coverage(stage, { view: 'coverage' }, withDivergent, { navigate: () => undefined });

    // No group-level reason line (there is no coverage block here either, so every
    // `.cov-worow-reason` in the page would have to be this suppressed header line).
    const headerReasons = walk(stage).filter((n) => n.classList && n.classList.contains('cov-worow-reason'));
    expect(headerReasons.length).toBe(0);
    // Each member's own, distinct reason renders instead.
    expect(textOf(stage)).toContain('member-1-only reason');
    expect(textOf(stage)).toContain('a totally different reason for the other member');
  });

  it('a coverage block\'s severity is conveyed by glyph + word, never colour alone', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const withCoverage: PortalData = {
      ...data,
      worklist: [],
      worklistCoverage: [
        { code: 'unmapped-files', severity: 'error', files: ['src/b.ts'], why: 'err why', fix: 'err fix' },
        { code: 'uncovered-advisory', severity: 'warning', files: ['src/c.ts'], why: 'warn why', fix: 'warn fix' },
      ],
      meta: { ...data.meta, counts: { ...data.meta.counts, errors: 1, warnings: 1 } },
    };
    Yg.views.coverage(stage, { view: 'coverage' }, withCoverage, { navigate: () => undefined });

    const blocks = walk(stage).filter((n) => n.classList && n.classList.contains('cov-covblock'));
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      const glyph = walk(block).find((n) => n.classList && n.classList.contains('state-glyph'));
      expect(glyph).toBeTruthy();
      expect(glyph!.getAttribute('role')).toBe('img');
    }
    expect(classesIn(blocks[0]).has('state-refused')).toBe(true);
    expect(classesIn(blocks[1]).has('state-warning')).toBe(true);
    expect(textOf(blocks[0])).toContain('error');
    expect(textOf(blocks[1])).toContain('warning');
  });

  it('a file member renders as named text, never a button — no per-file surface to navigate to', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    const fileGroup: PortalData['worklist'][number] = {
      code: 'type-relation-forbidden',
      rule: 'type-relation-forbidden',
      severity: 'error',
      pairCount: 1,
      nodeCount: 0,
      fileCount: 1,
      why: 'forbidden by type policy',
      fix: 'remove the dependency',
      divergentWhy: false,
      divergentNext: false,
      perMemberReason: false,
      members: [{ file: 'src/leaf.ts' }],
    };
    const withFileMember: PortalData = { ...data, worklist: [fileGroup], worklistCoverage: [] };
    Yg.views.coverage(stage, { view: 'coverage' }, withFileMember, { navigate: () => undefined });

    const fileText = walk(stage).find((n) => n.classList && n.classList.contains('cov-member-file'));
    expect(fileText).toBeTruthy();
    expect(fileText!.tagName).toBe('SPAN');
    expect(fileText!.tagName).not.toBe('BUTTON');
    expect(textOf(fileText as FakeNode)).toContain('src/leaf.ts');
  });

  it('member rows are siblings of the group header, never nested inside its single-line flex row (I2 layout fix)', async () => {
    const Yg = await loadYg();
    const stage = makeNode('div');
    Yg.views.coverage(stage, { view: 'coverage' }, data, { navigate: () => undefined });

    const headers = walk(stage).filter((n) => n.classList && n.classList.contains('cov-worow'));
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      // walk(header) includes `header` itself at index 0; everything after that is a
      // descendant. None of them may carry '.cov-member' — that would mean a member row
      // was squeezed inside the header's own non-wrapping flex row instead of rendering
      // as its sibling inside `.cov-worow-wrap`.
      const nestedMembers = walk(header).slice(1).filter((n) => n.classList && n.classList.contains('cov-member'));
      expect(nestedMembers.length).toBe(0);
    }
    // Sanity: member rows DO exist somewhere on the page (the real `unverified` group has
    // 2 node members) — this isn't vacuously true because nothing rendered.
    expect(walk(stage).filter((n) => n.classList && n.classList.contains('cov-member')).length).toBeGreaterThan(0);
    // Each header's members render as its sibling, one shared `.cov-worow-wrap` per group.
    const wraps = walk(stage).filter((n) => n.classList && n.classList.contains('cov-worow-wrap'));
    expect(wraps.length).toBe(headers.length);
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
});
