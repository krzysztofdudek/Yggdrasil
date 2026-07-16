/*
 * §3a SHELL-top loop + OV-approve — the SERVED page: Refresh, Approve, cost preview, view-only.
 *
 * Drives the REAL loopback portal server (spawned `yg portal --port 0` over a FRESH temp copy of
 * the portal-basic fixture) in Chromium. This is the only way the write paths are honest: Approve
 * re-enters the running bin (process.argv[1] is the yg bin), so the dry-run cost preview and the
 * real fill genuinely run the CLI, never a stub.
 *
 *   - shell-refresh : Refresh re-fetches /data and writes NOTHING (the committed lock is byte-equal
 *                     before/after); the page re-renders from the fresh data.
 *   - ov-approve    : the Approve flow shows the dry-run cost preview FIRST (reviewer-call budget),
 *                     then — confirmed — runs the deterministic fill via the spawned CLI, and the
 *                     next data reflects it (the fixture goes all-green: 0 unverified).
 *   - shell-approve : the write control is enabled in a live (write-enabled) page; with --no-write
 *                     it is DISABLED, and a stray POST /approve is rejected 409.
 *
 * Always tears down (server killed, temp dir removed) via the worker Teardown fixture. Public
 * surface only — spawns dist/bin.js, drives the rendered page + reads the committed file it wrote;
 * no fabricated PortalData. COVERS is read by portal/every-surface-has-e2e.
 */
import { test, expect } from './support/fixtures';
import { servedPortal, freshFixtureCopy } from './support/harness';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const COVERS = ['shell-refresh', 'shell-approve', 'ov-approve'];

test.describe('§3a SHELL-top — Refresh (read-only) + Approve (the one write)', () => {
  test('Refresh re-fetches /data and writes nothing; Approve runs the fill and goes all-green', async ({
    page,
    t,
  }) => {
    const project = freshFixtureCopy(t, 'portal-basic');
    const { baseUrl } = await servedPortal(t, { cwd: project });
    await page.goto(baseUrl + '/');

    // The served page is live + write-enabled: Refresh is enabled (disabled only on a static page).
    const refresh = page.locator('.topbar-refresh');
    await expect(refresh).toBeEnabled();
    const approve = page.locator('.topbar-approve');
    await expect(approve).toBeEnabled();

    // Snapshot the committed lock before any action (Refresh must not touch it).
    const committedLock = path.join(project, '.yggdrasil', 'yg-lock.nondeterministic.json');
    const lockBefore = existsSync(committedLock)
      ? { bytes: readFileSync(committedLock, 'utf-8'), mtimeMs: statSync(committedLock).mtimeMs }
      : null;

    // Refresh: re-runs the free checks read-only and re-renders. The freshness pill reflects it.
    await refresh.click();
    await expect(page.locator('.topbar-live')).toContainText(/Refreshed|re-checked/i);
    if (lockBefore) {
      const lockAfter = readFileSync(committedLock, 'utf-8');
      expect(lockAfter, 'Refresh must not write the committed lock').toBe(lockBefore.bytes);
    }

    // Before Approve the fixture is all-unverified: the overview verdict says so.
    await page.goto(baseUrl + '/#/view/overview');
    await expect(page.locator('.ov-verdict')).toContainText('waiting to be checked');

    // OV-approve: the dry-run cost preview fires via window.confirm. Accept it; assert the
    // confirm text carries the engine's reviewer-call budget (never a blanket claim).
    let confirmText = '';
    page.on('dialog', async (dialog) => {
      confirmText = dialog.message();
      await dialog.accept();
    });
    await page.locator('.topbar-approve').click();
    // The confirm dialog showed a pending-check / reviewer-call budget.
    await expect.poll(() => confirmText).toContain('reviewer call');
    // After the deterministic fill + the re-extract, the page reflects the new truth: all-green.
    await expect(page.locator('.topbar-live')).toContainText(/Approved|re-checked/i, { timeout: 60_000 });
    await page.goto(baseUrl + '/#/view/coverage');
    // The verified segment now exists and the unverified segment is gone (0 unverified).
    await expect(page.locator('.cov-bar .cov-seg-v')).toHaveCount(1);
    await expect(page.locator('.cov-bar .cov-seg-u')).toHaveCount(0);

    // The deterministic fill wrote only the gitignored cache, never the committed lock.
    const detCache = path.join(project, '.yggdrasil', '.yg-lock.deterministic.json');
    expect(existsSync(detCache)).toBe(true);
    if (lockBefore) {
      expect(readFileSync(committedLock, 'utf-8')).toBe(lockBefore.bytes);
    }
  });

  test('--no-write view-only mode disables the write control and rejects a stray POST 409', async ({ page, t }) => {
    const project = freshFixtureCopy(t, 'portal-basic');
    const { baseUrl } = await servedPortal(t, { cwd: project, noWrite: true });
    await page.goto(baseUrl + '/');

    // The Approve control is disabled in view-only mode.
    await expect(page.locator('.topbar-approve')).toBeDisabled();
    // The brand sub + live pill announce view-only.
    await expect(page.locator('.rail-brand-sub')).toHaveText('view-only');

    // A page-originated POST /approve (carrying the portal marker header) is rejected 409 by
    // the view-only guard — the write is disabled, not merely hidden. (A forged cross-site POST
    // without the marker would be refused even earlier, 403, by the cross-origin guard.)
    const res = await page.request.post(baseUrl + '/approve', {
      data: { llm: false },
      headers: { 'x-yg-portal': '1' },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(409);
  });

  test('the loading shell paints an instant spinner, then swaps in the full page', async ({ page, t }) => {
    const project = freshFixtureCopy(t, 'portal-basic');
    const { baseUrl } = await servedPortal(t, { cwd: project });

    // Delay the heavy render so the instant shell is observable — this is the whole point:
    // the browser must show progress immediately, not a blank page, while /render runs.
    await page.route('**/render*', async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      await route.continue();
    });

    await page.goto(baseUrl + '/');
    // Before the swap: a spinner + a plain-language "what's happening" message are visible.
    await expect(page.locator('#yg-boot .yg-spinner')).toBeVisible();
    await expect(page.locator('#yg-boot')).toContainText(/Reading your architecture/i);

    // After /render resolves, the real page boots in place (URL stays /, hash route preserved).
    await expect(page.locator('.topbar-refresh')).toBeVisible({ timeout: 15_000 });
    await page.unroute('**/render*');
  });

  test('when /render fails, the shell swaps the HTML error page into the document (no blank page, no JSON)', async ({
    page,
    t,
  }) => {
    // The server's real error-page HTML for a failed /render is covered at the HTTP level in the
    // integration suite (GET /render on a graph-less project → 500 text/html, readable, no JSON).
    // Here we cover the CLIENT half: the shell's boot must swap a 500 /render response into the
    // document as a readable page — the fetch resolves for a 500, so the same document.write path
    // runs — instead of leaving the spinner up or exposing a JSON body. We stand in a 500 HTML
    // response that mirrors the server's error page.
    const project = freshFixtureCopy(t, 'portal-basic');
    const { baseUrl } = await servedPortal(t, { cwd: project });

    await page.route('**/render*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head><meta charset="utf-8"><title>err</title></head><body><div class="yg-box"><div class="yg-title">The portal couldn’t load your architecture</div><div class="yg-sub">Run <code>yg check</code> in your terminal.</div></div></body></html>',
      }),
    );

    await page.goto(baseUrl + '/');
    await expect(page.locator('body')).toContainText(/couldn.?t load your architecture/i);
    // The spinner is gone (the document was replaced) and no raw JSON error is exposed.
    await expect(page.locator('#yg-boot .yg-spinner')).toHaveCount(0);
    expect(await page.content()).not.toContain('{"error"');
    await page.unroute('**/render*');
  });
});
