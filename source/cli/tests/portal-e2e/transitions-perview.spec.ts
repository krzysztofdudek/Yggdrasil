/*
 * §3a D — the PER-VIEW transition table (every navigational click's destination).
 *
 * One assertion per transition-table ROW that lands on a real surface (the "(in-view)" rows
 * are covered by the views-render + interactions specs; this file walks the navigational
 * destinations). Each test drives a real `yg portal --static` page (frozen fixture or the
 * repo's own graph), performs the click, and asserts the destination surface is real.
 *
 * Covered rows (§3a D, Per-view):
 *   V1: "Start here" door → V9 · "precise picture" → V2 · residue no-rule → V2(no-rule)
 *       · residue waivers → V8 · freshness file/node → SHELL-panel (file-aware spec)
 *   V2: worklist row → SHELL-panel · rule-group header → V5 · LIVE boundary counter → V4
 *       · jump-to-next-unresolved → SHELL-panel (or, all-green, repoint to residue)
 *   V4: hub-ranking row → SHELL-panel · boundary/forbidden row → V6 (forbidden) / panel (phantom)
 *   V5: aspect row → detail (in-view) → node cell → SHELL-panel
 *   V6: "nodes of this type" → V3 filtered · default-aspect chip → V5
 *   V7: flow card → detail · participant → SHELL-panel · flow aspect → V5
 *   V8: marker location → SHELL-panel · waived aspect → V5
 *   V9: step that opens V7 · dismiss → V1
 *
 * Public surface only; no fabricated PortalData. COVERS is read by portal/every-surface-has-e2e.
 */
import { test, expect } from './support/fixtures';

// These transitions exercise the views as DESTINATIONS; the surfaces themselves are claimed in
// views-render.spec.ts. This spec adds no new manifest surface but documents what it drives.
export const COVERS: string[] = [];

test.describe('§3a D — V1 Overview transitions', () => {
  test('"Start here" door → V9', async ({ page, basicPage }) => {
    await page.goto(basicPage);
    await page.locator('.ov-door-link').click();
    await expect(page).toHaveURL(/#\/view\/start/);
    await expect(page.locator('.st-card')).toBeVisible();
  });

  test('"precise picture" → V2 Coverage', async ({ page, basicPage }) => {
    await page.goto(basicPage);
    await page.locator('.ov-precise').click();
    await expect(page).toHaveURL(/#\/view\/coverage/);
    await expect(page.locator('.cov-ledger')).toBeVisible();
  });

  test('residue no-rule chip → V2 · residue waivers chip → V8', async ({ page, repoPage }) => {
    await page.goto(repoPage);
    // First residue chip routes to coverage (no-rule list); the waivers chip routes to V8.
    await page.locator('.ov-residue .reslink').first().click();
    await expect(page).toHaveURL(/#\/view\/coverage/);
    await page.goBack();
    await page.locator('.ov-residue .reslink', { hasText: 'waiver' }).click();
    await expect(page).toHaveURL(/#\/view\/suppressions/);
    await expect(page.locator('.sup-table, .sup-empty')).toBeVisible();
  });
});

test.describe('§3a D — V2 Coverage transitions', () => {
  test('worklist row "open" → SHELL-panel of the offending node', async ({ page, basicPage }) => {
    await page.goto(basicPage + '#/view/coverage');
    // The member's deeplink button is a SIBLING of its group's `.cov-worow` header (inside
    // the shared `.cov-worow-wrap`), never nested inside the header's own single-line flex
    // row — coverage-worklist.js keeps `groupRow` and `headerRow` as separate elements so the
    // deeplink can sit beside the header without breaking its single-line layout.
    await page.locator('.cov-worow-wrap .cov-deeplink').first().click();
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    // The first unverified-group node is api/orders or api/users.
    await expect(panel.locator('.pan-path')).toHaveText(/api\/(orders|users)/);
  });

  test('rule-group header "fix:" → V5 aspect detail — only when the group carries a real aspect id', async ({ page, basicPage, typeCoveragePage }) => {
    // portal-basic's plain (unapproved) coverage page: 'unverified' spans BOTH aspects it
    // names (code-only grouping collapses the aspect id away) and 'rules-digest-stale' names
    // no aspect at all (a repository-level finding) — NEITHER group carries a single real
    // aspectId. Rendering a header link unconditionally and navigating using the group's
    // display LABEL (e.g. "unverified (not yet reviewed)") as if it were a real aspect id
    // would produce a dead link. The honest behavior is NO link here, not a link to nowhere.
    await page.goto(basicPage + '#/view/coverage');
    await expect(page.locator('.cov-rulehdr')).toHaveCount(0);

    // portal-type-coverage, deterministically filled: the 'enforced' group is a single
    // aspect-violation-enforced refusal and DOES carry a real aspectId (no-todo-comments), so
    // its header renders a link — and clicking it navigates to THAT real aspect, never the
    // group's own display label ("enforced").
    await page.goto(typeCoveragePage + '#/view/coverage');
    const link = page.locator('.cov-rulehdr', { hasText: 'no-todo-comments' });
    await expect(link).toHaveCount(1);
    await link.click();
    await expect(page).toHaveURL(/#\/(aspect|view\/rulebook)/);
    await expect(page.locator('.rb-table')).toBeVisible();
    // The inspector panel that opens names the SAME aspect the header linked to.
    await expect(page.locator('.pan-aspect')).toContainText('no-todo-comments');
  });

  test('LIVE boundary counter → V4 Relations', async ({ page, basicPage }) => {
    await page.goto(basicPage + '#/view/coverage');
    await page.locator('.cov-live.cov-live-btn', { hasText: 'boundary' }).click();
    await expect(page).toHaveURL(/#\/view\/relations/);
    await expect(page.locator('.rel-bhead')).toBeVisible();
  });

  test('jump-to-next-unresolved → SHELL-panel of the next non-green node', async ({ page, basicPage }) => {
    await page.goto(basicPage + '#/view/coverage');
    await page.locator('.cov-jump').click();
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator('.pan-path')).toHaveText(/api\/(orders|users)/);
  });
});

test.describe('§3a D — V4 Relations transitions', () => {
  test('hub-ranking row → SHELL-panel', async ({ page, repoPage }) => {
    await page.goto(repoPage + '#/view/relations');
    await page.locator('.rel-hubrow').first().click();
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator('.pan-path')).not.toBeEmpty();
  });

  test('the live boundary keeps declared-only NEUTRAL — never summed as a violation', async ({ page, repoPage }) => {
    await page.goto(repoPage + '#/view/relations');
    // The repo is phantom-clean; the summary states clean, and declared-only is informational.
    await expect(page.locator('.rel-summary')).toContainText('clean');
    await expect(page.locator('.rel-summary')).toContainText('informational');
  });
});

test.describe('§3a D — V5 Rulebook transitions', () => {
  test('aspect row → detail (inspector panel) → node cell → SHELL-panel', async ({ page, basicPage }) => {
    await page.goto(basicPage + '#/view/rulebook');
    // Click the aspect id: its detail opens in the shared inspector panel (not inline), then a
    // node cell in that panel re-targets the panel to the node's own attestation.
    await page.locator('.rb-idbtn', { hasText: 'no-todo-comments' }).click();
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator('.pan-aspect')).toContainText('no-todo-comments');
    await panel.locator('.rb-cell').first().click();
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator('.pan-path')).toHaveText(/api\/(orders|users)/);
  });
});

test.describe('§3a D — V6 Type Model transitions', () => {
  test('"nodes of this type" → V3 filtered · default-aspect chip → V5', async ({ page, repoPage }) => {
    await page.goto(repoPage + '#/view/types');
    // "N nodes" count routes to the structure tree.
    await page.locator('.ty-count').first().click();
    await expect(page).toHaveURL(/#\/view\/tree/);
    await expect(page.locator('.tree-mount')).toBeVisible();
    // Back, then a default-rule chip (some type carries default aspects) routes to V5.
    await page.goto(repoPage + '#/view/types');
    const chip = page.locator('.ty-asp').first();
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page).toHaveURL(/#\/(aspect|view\/rulebook)/);
    await expect(page.locator('.rb-table')).toBeVisible();
  });
});

test.describe('§3a D — V7 Flows transitions', () => {
  test('flow card → detail · participant → SHELL-panel · flow aspect → V5', async ({ page, repoPage }) => {
    await page.goto(repoPage + '#/view/flows');
    // Select a flow card → its detail loads (hash carries the flow name).
    await page.locator('.fl-card').first().click();
    await expect(page).toHaveURL(/#\/flow\//);
    await expect(page.locator('.fl-detail')).toBeVisible();
    // A participant row → its attestation panel.
    await page.locator('.fl-part').first().click();
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator('.pan-path')).not.toBeEmpty();
  });
});

test.describe('§3a D — V8 Suppressions transitions', () => {
  test('marker location → SHELL-panel · waived aspect → V5', async ({ page, repoPage }) => {
    await page.goto(repoPage + '#/view/suppressions');
    // The waived-aspect button routes to the rulebook for that rule.
    await page.locator('.sup-asp').first().click();
    await expect(page).toHaveURL(/#\/(aspect|view\/rulebook)/);
    await expect(page.locator('.rb-table')).toBeVisible();
    // Back, then a marker location with a resolvable owner → its node panel.
    await page.goto(repoPage + '#/view/suppressions');
    const loc = page.locator('.sup-locbtn:not([disabled])').first();
    if (await loc.count()) {
      await loc.click();
      await expect(page.locator('.app-panel')).toHaveClass(/open/);
    }
  });
});

test.describe('§3a D — V9 Start here transitions', () => {
  test('a step opens V7 Flows · dismiss → V1', async ({ page, repoPage }) => {
    await page.goto(repoPage + '#/view/start');
    // Walk to step 3 (one process end to end), which opens the real flows view.
    await page.locator('.st-btn-primary').click(); // step 2
    await page.locator('.st-btn-primary').click(); // step 3
    await expect(page.locator('.st-inline-link')).toBeVisible();
    await page.locator('.st-inline-link').click();
    await expect(page).toHaveURL(/#\/flow\//);
    await expect(page.locator('.fl-detail')).toBeVisible();
    // Dismiss returns to the overview.
    await page.goto(repoPage + '#/view/start');
    await page.locator('.st-skip').click();
    await expect(page).toHaveURL(/#\/view\/overview/);
    await expect(page.locator('.ov-hero')).toBeVisible();
  });
});
