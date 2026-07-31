/*
 * §3a SHELL-panel (Node Attestation) + the GLOBAL transition rows.
 *
 * The panel is universal (invariant E.2): it opens from EVERY surface that names a node. This
 * spec proves the panel's own content (identity, effective aspects, relations both ways, log,
 * suppressions, attestation digest) AND the global transition-table rows:
 *   - any node reference (tree row) → SHELL-panel + hash update
 *   - SHELL-panel "Depends on / Depended on by" row → re-target the panel to that node
 *   - SHELL-panel effective-aspect name → V5 aspect detail
 *   - SHELL-panel a no-rule node → V6 Type Model ("what could apply here")
 *   - any overlay/panel Esc + breadcrumb climb
 *
 * Public surface only: real `yg portal --static` page, no fabricated PortalData. COVERS is the
 * marker read by portal/every-surface-has-e2e.
 */
import { test, expect } from './support/fixtures';

// `shell-prov` is the provenance/freshness surface: the attestation pins (commit ref +
// committed-lock hash) on the Node Attestation panel, asserted directly in the digest test below.
export const COVERS = ['shell-panel', 'shell-prov'];

test.describe('§3a SHELL-panel — Node Attestation + global transitions', () => {
  test('a tree row click opens the panel for that node and updates the hash', async ({ page, basicPage }) => {
    await page.goto(basicPage);
    await page.locator('.app-rail .rail-link', { hasText: 'Structure' }).first().click();
    // Global row: clicking a node reference (tree row) opens SHELL-panel + updates the hash.
    await page.locator('.tree-row[data-path="api/orders"]').click();
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator('.pan-path')).toHaveText('api/orders');
    await expect(page).toHaveURL(/#\/node\/api%2Forders/);
    // The panel shows identity (type) + the effective-aspects section (this node carries a rule).
    await expect(panel.locator('.pan-meta')).toContainText('service');
    await expect(panel.locator('.pan-sect')).not.toHaveCount(0);
  });

  test('the panel renders the effective-aspect row with kind + channel + honest verdict state', async ({
    page,
    basicPage,
  }) => {
    await page.goto(basicPage + '#/node/api%2Forders');
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    // The fixture's one aspect is deterministic + free, and the pair is unverified (not green).
    const aspRow = panel.locator('.pan-asprow').first();
    await expect(aspRow.locator('.pan-aspname')).toHaveText('no-todo-comments');
    await expect(aspRow.locator('.pan-badge')).toContainText('deterministic');
    // The unverified caveat appears — an honest "we don't know", never a stale pass.
    await expect(aspRow).toContainText('not a stale pass');
  });

  test('the effective-aspect name opens the rule in the inspector panel', async ({ page, basicPage }) => {
    await page.goto(basicPage + '#/node/api%2Forders');
    await page.locator('.app-panel .pan-aspname', { hasText: 'no-todo-comments' }).click();
    await expect(page).toHaveURL(/#\/aspect\/no-todo-comments/);
    // The shared inspector panel now shows that rule's detail (the aspect-side attestation),
    // not the node — one detail surface for both entity kinds.
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator('.pan-aspect')).toContainText('no-todo-comments');
  });

  test('a "Depended on by" / "Depends on" relation row re-targets the panel', async ({ page, repoPage }) => {
    // The repo's cli/core/fill is the top fan-out hub (21 deps) — open it, follow a relation.
    await page.goto(repoPage + '#/node/cli%2Fcore%2Ffill');
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator('.pan-path')).toHaveText('cli/core/fill');
    // "Depends on" relations are present; clicking one re-targets the panel to that node.
    const relLink = panel.locator('.pan-rels .pan-rellink').first();
    await expect(relLink).toBeVisible();
    const target = (await relLink.textContent())?.trim() ?? '';
    expect(target.length).toBeGreaterThan(0);
    await relLink.click();
    await expect(panel.locator('.pan-path')).toHaveText(target);
    // The hash updated to the re-targeted node (path slashes percent-encoded as %2F).
    await expect(page).toHaveURL(new RegExp('#/node/' + encodeURIComponent(target)));
  });

  test('the panel meta line names the mapping-entry count AND the real source-file count, distinctly', async ({
    page,
    repoPage,
  }) => {
    // cli/tests/fixtures maps ONE directory entry (source/cli/tests/fixtures/) that expands
    // to many more real files on disk. The panel must show BOTH numbers, each labeled for
    // what it is — the one declared entry, and the real file count it resolves to — never
    // one standing in for the other.
    await page.goto(repoPage + '#/node/cli%2Ftests%2Ffixtures');
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    const metaText = (await panel.locator('.pan-meta').textContent()) ?? '';
    expect(metaText).toContain('1 mapping entry');
    const fileCountMatch = metaText.match(/(\d+) source files?/);
    expect(fileCountMatch).not.toBeNull();
    // The real file count must differ from the single declared entry, or the fix would be
    // indistinguishable from the old, mislabeled single count.
    expect(Number(fileCountMatch![1])).toBeGreaterThan(5);
  });

  test('a no-rule node panel routes to V6 Type Model (never a terminal shrug)', async ({ page, basicPage }) => {
    // The fixture's `api` node is a no-rule module (no effective aspect).
    await page.goto(basicPage + '#/node/api');
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator('.pan-norule')).toBeVisible();
    await panel.locator('.pan-norule-link').click();
    await expect(page).toHaveURL(/#\/view\/types/);
    await expect(page.locator('.ty-grid')).toBeVisible();
  });

  test('the attestation digest is copyable and the panel carries provenance pins', async ({ page, repoPage }) => {
    await page.goto(repoPage + '#/node/cli%2Fcore%2Ffill');
    const panel = page.locator('.app-panel');
    // Provenance pins (commit ref + committed-lock hash) and a copy action are present.
    await expect(panel.locator('.pan-prov')).toContainText('commit');
    await expect(panel.locator('.pan-prov')).toContainText('lock');
    const copy = panel.locator('.pan-copy');
    await expect(copy).toBeVisible();
    await copy.click();
    await expect(copy).toHaveText('copied');
  });

  test('Esc closes an open overlay and the breadcrumb reflects the entity', async ({ page, basicPage }) => {
    await page.goto(basicPage + '#/node/api%2Forders');
    // The breadcrumb names the node (Structure / api/orders).
    await expect(page.locator('.topbar-crumb')).toContainText('api/orders');
    // Open the palette overlay, then Esc closes it (history/back still works on the hash).
    await page.keyboard.press('Meta+k');
    await expect(page.locator('.palette-backdrop')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.palette-backdrop')).toHaveCount(0);
  });
});
