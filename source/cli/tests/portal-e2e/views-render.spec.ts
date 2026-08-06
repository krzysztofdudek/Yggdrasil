/*
 * §3a full views V1–V9 — each view RENDERS its real data + its honest palette.
 *
 * Drives the REAL `yg portal --static` page (frozen portal-basic fixture for exact assertions,
 * the repo's own graph for the rich surfaces that need flows/suppressions/types). Each view is
 * reached the way a user reaches it — a click on the nav rail — and asserted to render its real
 * content AND to carry the always-present honest-state legend (the palette), proving no state
 * collapses to a single "green".
 *
 * Public surface only: the page is a real CLI emit; no PortalData is fabricated, no internal
 * imported. COVERS is the stable marker the `portal/every-surface-has-e2e` aspect reads.
 */
import { test, expect } from './support/fixtures';
import { freshFixtureCopy, staticPage } from './support/harness';

// Surfaces this spec covers (the §3a manifest ids). Read by portal/every-surface-has-e2e.
export const COVERS = [
  'overview',
  'coverage',
  'tree',
  'relations',
  'structure',
  'rulebook',
  'types',
  'flows',
  'suppressions',
  'start',
  // The persistent left navigation rail (SHELL-nav): exercised by every navTo() below and
  // asserted directly in the first test (the always-present grouped rail links).
  'shell-nav',
];

/** Click a nav-rail link by its visible label and wait for the stage to settle. */
async function navTo(page: import('@playwright/test').Page, label: string) {
  await page.locator('.app-rail .rail-link', { hasText: label }).first().click();
}

/** Assert the honest-state legend (the palette) is present with every state shown distinctly. */
async function expectHonestPalette(page: import('@playwright/test').Page) {
  // The honest key is the single pinned legend bar (present once, not re-rendered per view).
  const legend = page.locator('.legend-bar');
  await expect(legend).toHaveCount(1);
  await expect(legend).toBeVisible();
  // Its always-visible compact row shows all nine honest states as distinct glyph+label chips;
  // the expandable grid repeats them with full descriptions. Neither collapses a state away.
  await expect(page.locator('.legend-chip')).toHaveCount(9);
  await expect(page.locator('.legend .legend-item')).toHaveCount(9);
  // "verified" is the only green and must be labelled as the only green.
  await expect(legend).toContainText('verified');
  await expect(legend).toContainText('no rule');
  await expect(legend).toContainText('live boundary');
}

test.describe('§3a views V1–V9 — render real data + honest palette', () => {
  test('V1 Overview renders the plain-language verdict + residue + palette', async ({ page, basicPage }) => {
    await page.goto(basicPage);
    // SHELL-nav: the persistent left navigation rail is always present, with its grouped one-click
    // rail links into the full views (this is the surface every navTo() below clicks).
    await expect(page.locator('.app-rail')).toBeVisible();
    await expect(page.locator('.app-rail .rail-link', { hasText: 'Coverage & audit' })).toHaveCount(1);
    // Match the label span EXACTLY: the rail now also carries a "Dependency structure" link, whose
    // label contains the substring "Structure", so a loose hasText would match two links.
    await expect(page.locator('.app-rail .rail-link span', { hasText: /^Structure$/ })).toHaveCount(1);
    await expect(page.locator('.app-rail .rail-link')).not.toHaveCount(0);
    // Default hash → overview. portal-basic has 2 unverified pairs → "waiting to be checked".
    await expect(page.locator('.ov-verdict')).toBeVisible();
    await expect(page.locator('.ov-verdict')).toContainText('waiting to be checked');
    // The residue is the honest unguarded surface, made clickable.
    await expect(page.locator('.ov-residue .reslink')).not.toHaveCount(0);
    // The precise-picture preview shows the real fraction (0 / 2 verified for this fixture).
    await expect(page.locator('.ov-precise')).toContainText('/ 2');
    await expectHonestPalette(page);
  });

  test('V2 Coverage & Audit renders the verdict bar, non-pair track, LIVE counters', async ({ page, basicPage }) => {
    await page.goto(basicPage);
    await navTo(page, 'Coverage & audit');
    await expect(page.locator('.cov-ledger')).toBeVisible();
    // The bar is sized by real pair STATES; portal-basic is all-unverified so the unverified
    // segment exists and there is NO verified segment (an unverified pair never paints green).
    await expect(page.locator('.cov-bar .cov-seg-u')).toHaveCount(1);
    await expect(page.locator('.cov-bar .cov-seg-v')).toHaveCount(0);
    // The separated non-pair track is present and barred from the coverage fraction.
    await expect(page.locator('.cov-nonpair')).toContainText('not in coverage fraction');
    // LIVE counters equal yg check (boundary + blocking errors).
    await expect(page.locator('.cov-live').first()).toContainText('LIVE');
    await expect(page.locator('.cov-livewrap')).toContainText('blocking errors');
    // The rule-grouped worklist surfaces the unverified group (2 nodes).
    await expect(page.locator('.cov-worow')).not.toHaveCount(0);
    await expectHonestPalette(page);
  });

  test('V1/V2 on the tier-on fixture: a type-covered file with a real refusal is never called unmapped, and one with no applicable rule is never called satisfied', async ({ page, typeCoveragePage }) => {
    // portal-type-coverage: coverage.type_level ON, one node-owned file, one
    // type-covered file carrying a REAL refused verdict (a live deterministic
    // check, no committed lock), one type-covered file matched by a type with
    // NO rule at all (zero enforcement), one excluded-root file. The one
    // committed portal fixture with the tier enabled — without it this whole
    // spec suite is structurally incapable of observing either class of bug.
    await page.goto(typeCoveragePage);
    // Overview: the CHECKED type-covered file is accounted for on its own chip,
    // distinct from the "unmapped (unguarded)" chip, which must NOT count it.
    await expect(page.locator('.ov-residue')).toContainText('matched type');
    const unmappedChip = page.locator('.ov-residue .reslink', { hasText: 'unmapped (unguarded)' });
    await expect(unmappedChip).toContainText('0'); // the excluded + BOTH type-covered files all left this chip
    const typeCoveredChip = page.locator('.ov-residue .reslink', { hasText: 'matched type' });
    await expect(typeCoveredChip).toContainText('1');
    // The UNENFORCED type-covered file gets its OWN, distinctly-worded chip — never folded
    // into the "satisfied" chip above, and never silently dropped.
    const unenforcedChip = page.locator('.ov-residue .reslink', { hasText: 'no rule that applies' });
    await expect(unenforcedChip).toContainText('1');

    // Coverage & Audit: the checked file's refusal renders in the verdict bar (it IS
    // being checked)...
    await navTo(page, 'Coverage & audit');
    await expect(page.locator('.cov-bar .cov-seg-r')).toHaveCount(1);
    // ...and the type-covered count renders on its own line, never inside "not in
    // coverage fraction" (its pairs ARE counted in the bar above).
    await expect(page.locator('.cov-ledger')).toContainText('type-covered');
    const nonpairText = (await page.locator('.cov-nonpair').first().textContent()) ?? '';
    expect(nonpairText).not.toContain('type-covered');
    // The unenforced file is named on the page — never just a number — under its own
    // "checked by nothing" line, using the honest "no rule" state, not the neutral mark.
    await expect(page.locator('.cov-ledger')).toContainText('src/lib/util.ts');
    await expect(page.locator('.cov-ledger')).toContainText('checked by nothing');
    await expectHonestPalette(page);
  });

  // The same tier-on fixture, emitted BEFORE any fill ever runs: src/svc/handler.ts's own
  // rule has no lock entry at all yet — cold, not yet refused, the one state
  // typeCoveragePage's own always-approved-first setup never leaves on disk. The ledger's
  // "enforced by architecture" chip and per-file row must both say so, never render as
  // though a currently valid verdict were on record just because the file is enforced.
  test('V2 Coverage & Audit: a type-covered file with no recorded lock entry at all is marked unverified on both the chip and its own row', async ({ page, typeCoverageUnverifiedPage }) => {
    await page.goto(typeCoverageUnverifiedPage);
    await navTo(page, 'Coverage & audit');
    await expect(page.locator('.cov-ledger')).toContainText('with no recorded verdict');
    const enforcedRow = page.locator('.cov-typelist-ok .cov-typerow', { hasText: 'src/svc/handler.ts' });
    await expect(enforcedRow).toContainText('unverified');
    await expectHonestPalette(page);
  });

  test('V3 Structure renders the real node hierarchy', async ({ page, basicPage }) => {
    await page.goto(basicPage);
    await navTo(page, 'Structure');
    await expect(page.locator('.tree-mount')).toBeVisible();
    // The three real fixture nodes appear in the tree, identified by their stable data-path.
    await expect(page.locator('.tree-row[data-path="api"]')).toHaveCount(1);
    await expect(page.locator('.tree-row[data-path="api/orders"]')).toHaveCount(1);
    await expect(page.locator('.tree-row[data-path="api/users"]')).toHaveCount(1);
    await expectHonestPalette(page);
  });

  test('V4 Relations & Boundaries renders matrix (Canvas + DOM mirror), hubs, live boundary', async ({
    page,
    repoPage,
  }) => {
    await page.goto(repoPage);
    await navTo(page, 'Relations & boundaries');
    // (a) the allowed-relations matrix: a Canvas grid AND its screen-reader DOM-list mirror.
    await expect(page.locator('canvas.mtx-canvas')).toHaveCount(1);
    await expect(page.locator('.mtx-mirror')).toBeVisible();
    await expect(page.locator('.mtx-mirror .mtx-mirror-row')).not.toHaveCount(0);
    // (b) the fan-in / fan-out hubs (the real repo has load-bearing nodes).
    await expect(page.locator('.rel-hubcol')).toHaveCount(2);
    await expect(page.locator('.rel-hubrow')).not.toHaveCount(0);
    // (c) the live boundary, LIVE-badged, recomputed now.
    await expect(page.locator('.rel-bhead')).toContainText('LIVE');
    // Declared-only edges are NEUTRAL, not violations (the repo has 100+ of them).
    await expect(page.locator('.rel-class-info')).toContainText('legitimate, never red');
    await expectHonestPalette(page);
  });

  test('V5 Rulebook renders the catalogue with honest tallies', async ({ page, repoPage }) => {
    await page.goto(repoPage);
    await navTo(page, 'Rulebook');
    await expect(page.locator('table.rb-table')).toBeVisible();
    await expect(page.locator('.rb-table tbody .rb-row')).not.toHaveCount(0);
    // The kind badges distinguish LLM / deterministic / aggregating — never one collapsed cell.
    await expect(page.locator('.rb-badge')).not.toHaveCount(0);
    await expectHonestPalette(page);
  });

  test('V6 Type Model renders the architecture vocabulary as capability discovery', async ({ page, repoPage }) => {
    await page.goto(repoPage);
    await navTo(page, 'Type model');
    await expect(page.locator('.ty-grid .ty-card')).not.toHaveCount(0);
    // It is the grammar, not a verdict — the lead states it paints no green/red.
    await expect(page.locator('.view-lead')).toContainText('grammar');
    await expectHonestPalette(page);
  });

  test('V7 Flows renders the gallery + a flow detail with honest flow state', async ({ page, repoPage }) => {
    await page.goto(repoPage);
    await navTo(page, 'Flows');
    await expect(page.locator('.fl-gallery .fl-card')).not.toHaveCount(0);
    await expect(page.locator('.fl-detail')).toBeVisible();
    // A flow state pill is present (verified / weakest-link / nothing-checked — never just green).
    await expect(page.locator('.fl-state').first()).toBeVisible();
    await expectHonestPalette(page);
  });

  test('V8 Suppressions renders the risk-first waiver inventory', async ({ page, repoPage }) => {
    await page.goto(repoPage);
    await navTo(page, 'Suppressions');
    // The repo has 20+ active waivers including risk-flagged ones.
    await expect(page.locator('table.sup-table')).toBeVisible();
    await expect(page.locator('.sup-table tbody .sup-row')).not.toHaveCount(0);
    // At least one risk flag is surfaced (the repo has wildcard / unbounded / typo markers).
    await expect(page.locator('.sup-flag').first()).toBeVisible();
    await expectHonestPalette(page);
  });

  test('V9 Start here renders the five-step graph-derived on-ramp', async ({ page, repoPage }) => {
    await page.goto(repoPage);
    await navTo(page, 'Start here');
    await expect(page.locator('.st-card .st-h1')).toContainText('What this system is');
    await expect(page.locator('.st-steps .st-step')).toHaveCount(5);
    await expectHonestPalette(page);
  });

  test('V10 Dependency structure renders the legend, tunnels-in-words, module groups, and the reach caption', async ({
    page,
    repoPage,
  }) => {
    // The real repo is well above the small-N floor and has real cross-tree dependencies, so the
    // full panel (legend + tunnels + module groups + the interpretive reach caption) must render.
    await page.goto(repoPage);
    await navTo(page, 'Dependency structure');
    // The verbatim edge-universe legend is always printed and states that event relations are excluded.
    await expect(page.locator('.str-legend')).toContainText('event relations excluded');
    // Tunnels are named in words — a span reads as "spans N levels across the tree", never jargon.
    await expect(page.locator('.str-tunnels')).toBeVisible();
    await expect(page.locator('.str-tunnels .str-tunnel').first()).toContainText('across the tree');
    // The module-groups section is present with at least one level.
    await expect(page.locator('.str-modules .str-layer').first()).toBeVisible();
    // Above the floor: the interpretive change-reach caption renders (small-N panel absent).
    await expect(page.locator('.str-reach .str-reach-cap')).toContainText('average component');
    await expect(page.locator('.str-smalln')).toHaveCount(0);
    await expectHonestPalette(page);
  });

  test('V10 Dependency structure on a tier-on project reports the SAME tunnels, node count, and reach `yg structure` prints — never a node-only panel while the CLI widens', async ({
    page,
    t,
  }) => {
    // type-relation-gate: one real node ("owner") and two type-covered files with real static
    // imports touching all three — the widened universe `yg structure` reports has 3 nodes and
    // 3 tunnels, none of which exist without the type-level widening. If the panel stayed
    // node-only (as it did before this widening was wired in), it would report 1 node and 0
    // tunnels here — the exact disagreement this test exists to rule out.
    const project = freshFixtureCopy(t, 'type-relation-gate');
    const url = staticPage(t, { cwd: project });

    await page.goto(url);
    await navTo(page, 'Dependency structure');
    // Small-N: 3 nodes is below the interpretive-caption floor, so the raw-figure panel renders
    // instead of the "average component" sentence — this is the SAME honest floor `yg structure`
    // has no equivalent gate for (it always prints the interpretive line), so the panel's own
    // smallGraph flag is asserted directly rather than the caption text.
    await expect(page.locator('.str-smalln')).toContainText('50% average forward reach');
    await expect(page.locator('.str-smalln')).toContainText('components or type-covered files');

    // Every tunnel `yg structure` reports is present, by name, on the page.
    const tunnelsText = (await page.locator('.str-tunnels').textContent()) ?? '';
    expect(tunnelsText).toContain('src/svc/handler.ts → owner');
    expect(tunnelsText).toContain('src/util/plain-util.ts → owner');
    expect(tunnelsText).toContain('src/svc/handler.ts → src/util/plain-util.ts');
    // Exactly 3 tunnel rows — never 0 (the node-only regression this test guards against).
    await expect(page.locator('.str-tunnels .str-tunnel')).toHaveCount(3);

    await expectHonestPalette(page);
  });
});
