/*
 * §3a V1 freshness row + the file-aware honesty model — RENDERED in the real browser.
 *
 * The heartbeat (design §0b.1, §2): after a real edit, a touched file reads "unverified"
 * EVERYWHERE — the whole-repo cached green never overrides a file you just touched. The vitest
 * e2e proves the data; this Playwright spec proves the RENDERING and the §3a V1 transition:
 *   - close a baseline through the public CLI (`yg check --approve`) over a temp copy of the real
 *     portal-fresh fixture, emit a `--static` page → both nodes render verified, no freshness strip.
 *   - edit one mapped source file, re-emit → the Overview freshness strip appears (touched =
 *     unverified, not a pass), a strip chip routes to the touched node's panel (V1 → SHELL-panel),
 *     the Tree row reads unverified, and the panel banner says "source changed … not a pass".
 *
 * Public surface only — spawns dist/bin.js, opens the pages it wrote; no fabricated PortalData.
 * COVERS adds no new manifest surface — it hardens overview + shell-panel with the live loop.
 */
import { test, expect } from './support/fixtures';
import { BIN_PATH, fixtureRoot } from './support/harness';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const COVERS: string[] = [];

test.describe('§3a V1 freshness — a touched file reads unverified everywhere', () => {
  test('baseline renders verified (no strip); after an edit the touched node is unverified', async ({ page, t }) => {
    // A fresh temp copy of the real fixture (its type opts into the log gate → a clean baseline).
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-e2e-fileaware-'));
    t.tmpDirs.push(dir);
    cpSync(fixtureRoot('portal-fresh'), dir, { recursive: true });

    // Close the baseline through the public CLI (writes the committed source fingerprint).
    const approve = spawnSync('node', [BIN_PATH, 'check', '--approve'], { cwd: dir, encoding: 'utf-8' });
    expect(approve.status, `${approve.stdout}\n${approve.stderr}`).toBe(0);

    // Page 1 — the closed baseline.
    const before = path.join(dir, 'before.html');
    expect(spawnSync('node', [BIN_PATH, 'portal', '--static', '--out', before], { cwd: dir }).status).toBe(0);
    await page.goto('file://' + before);
    // Both nodes verified; NO freshness strip (no fabricated "all fresh" claim either way).
    await expect(page.locator('.ov-fresh')).toHaveCount(0);
    await page.goto('file://' + before + '#/node/api%2Forders');
    // The panel title's state badge announces "verified" (aria-label), and there is no fresh banner.
    await expect(page.locator('.app-panel .pan-title .state-glyph')).toHaveAttribute('aria-label', 'verified');
    await expect(page.locator('.app-panel .pan-fresh')).toHaveCount(0);

    // Edit one mapped source file (a real byte change) — no re-approve.
    appendFileSync(path.join(dir, 'src/orders/orders.service.ts'), '\n// a manual edit since the reviewer pass\n');

    // Page 2 — after the edit.
    const after = path.join(dir, 'after.html');
    expect(spawnSync('node', [BIN_PATH, 'portal', '--static', '--out', after], { cwd: dir }).status).toBe(0);
    const afterUrl = 'file://' + after;

    // Overview: the freshness strip appears FIRST, framing the touched file as unverified.
    await page.goto(afterUrl);
    const strip = page.locator('.ov-fresh');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText(/file.*changed since the last reviewer pass/i);
    await expect(strip).toContainText('not a pass');

    // §3a V1 freshness file/node → SHELL-panel: the strip chip routes to the touched node's panel.
    await strip.locator('.ov-fresh-chip', { hasText: 'api/orders' }).click();
    const panel = page.locator('.app-panel');
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator('.pan-path')).toHaveText('api/orders');
    // The panel banner makes the touched-not-a-pass status explicit (unverified).
    await expect(panel.locator('.pan-fresh')).toBeVisible();
    await expect(panel.locator('.pan-fresh')).toContainText('not a pass');

    // The same unverified truth reads on the Tree row (everywhere, not just the strip).
    await page.goto(afterUrl + '#/view/tree');
    await expect(page.locator('.tree-row[data-path="api/orders"]')).toHaveClass(/state-unverified/);
    // The untouched node stays verified — repo-green never overrides only the touched file.
    await expect(page.locator('.tree-row[data-path="api/users"]')).toHaveClass(/state-verified/);
  });
});
