/*
 * CONSISTENCY WITH `yg check` — the count-parity release blocker, proven end-to-end.
 *
 * The portal must NEVER diverge from the CLI. This spec parses the verdict counts the page
 * actually RENDERS in Chromium (the Coverage ledger fraction + the LIVE blocking-errors
 * counter + the worklist), then spawns `yg check` on the SAME real fixture through the public
 * CLI and asserts the rendered numbers equal what the CLI reports. If the portal ever drifts
 * from `yg check`, this fails.
 *
 * Two real fixtures, distinct states:
 *   - portal-basic out of the box → 2 unverified, 2 blocking errors (the page must say so).
 *   - the same fixture after a real deterministic Approve through the served bin → 0 unverified,
 *     0 errors, all verified (the page must follow the CLI to green, never independently).
 *
 * Public surface only — the page is a real CLI emit and `yg check` is the real CLI; nothing is
 * fabricated. COVERS adds no new manifest surface (it re-asserts coverage/overview honesty).
 */
import { test, expect } from './support/fixtures';
import { runCheck, staticPage, freshFixtureCopy, servedPortal } from './support/harness';

export const COVERS: string[] = [];

/** Parse the integer aggregate `Errors (N)` the grouped `yg check` output prints, or 0. */
function parseCheckErrors(out: string): number {
  const m = out.match(/Errors\s*\((\d+)\)/);
  return m ? parseInt(m[1], 10) : 0;
}

function parseCheckWarnings(out: string): number {
  const m = out.match(/Warnings\s*\((\d+)\)/);
  return m ? parseInt(m[1], 10) : 0;
}

test.describe('the page counts EQUAL `yg check` on the same fixture', () => {
  test('portal-basic: rendered errors / verified / unverified == yg check', async ({ page, t }) => {
    const fixtureCwd = (await import('./support/harness')).fixtureRoot('portal-basic');
    const url = staticPage(t, { fixture: 'portal-basic' });

    // What the CLI reports (the source of truth).
    const check = runCheck(fixtureCwd);
    const cliErrors = parseCheckErrors(check.out);
    expect(cliErrors).toBe(2); // 2 unverified pairs → 2 blocking errors (sanity-pin the fixture)

    // What the page RENDERS — read the Coverage ledger + the LIVE blocking-errors counter.
    await page.goto(url + '#/view/coverage');
    // The verified fraction "<verified> / <pairsTotal>".
    const fracText = (await page.locator('.cov-frac').first().textContent())?.replace(/\s+/g, ' ').trim() ?? '';
    const fracM = fracText.match(/(\d+)\s*\/\s*(\d+)/);
    expect(fracM, `could not parse the rendered fraction "${fracText}"`).not.toBeNull();
    const renderedVerified = parseInt((fracM as RegExpMatchArray)[1], 10);
    const renderedTotal = parseInt((fracM as RegExpMatchArray)[2], 10);

    // The LIVE "blocking errors (== yg check)" counter.
    const liveErrText = (await page.locator('.cov-livewrap .cov-live', { hasText: 'blocking errors' }).textContent()) ?? '';
    const liveErrM = liveErrText.match(/(\d+)/);
    const renderedErrors = liveErrM ? parseInt(liveErrM[1], 10) : NaN;

    // PARITY: the page's blocking-errors equals the CLI's; verified is 0; total is the real 2.
    expect(renderedErrors).toBe(cliErrors);
    expect(renderedVerified).toBe(0);
    expect(renderedTotal).toBe(2);

    // The worklist mirrors the same blocking truth: same-rule issues are grouped, so the 2
    // unverified pairs collapse into ONE rule group covering 2 nodes (== yg check grouping).
    await expect(page.locator('.cov-worow')).toHaveCount(1);
    await expect(page.locator('.cov-worow-meta')).toContainText('2 nodes');
  });

  test('after a real Approve the page follows the CLI to green (0 errors, all verified)', async ({ page, t }) => {
    const project = freshFixtureCopy(t, 'portal-basic');
    const { baseUrl } = await servedPortal(t, { cwd: project });

    // Run the real deterministic fill through the served bin (POST /approve {llm:false}). The
    // portal marker header lets it past the server's cross-origin guard, as the page's own call does.
    const approveRes = await page.request.post(baseUrl + '/approve', {
      data: { llm: false },
      headers: { 'x-yg-portal': '1' },
    });
    expect(approveRes.ok()).toBeTruthy();

    // The CLI now reports clean on the same project.
    const check = runCheck(project);
    expect(parseCheckErrors(check.out)).toBe(0);

    // The served page, re-fetched, follows the CLI to green: verified fraction is 2 / 2, no errors.
    await page.goto(baseUrl + '/#/view/coverage');
    const fracText = (await page.locator('.cov-frac').first().textContent())?.replace(/\s+/g, ' ').trim() ?? '';
    const fracM = fracText.match(/(\d+)\s*\/\s*(\d+)/) as RegExpMatchArray;
    expect(parseInt(fracM[1], 10)).toBe(2); // verified
    expect(parseInt(fracM[2], 10)).toBe(2); // total
    const liveErrText = (await page.locator('.cov-livewrap .cov-live', { hasText: 'blocking errors' }).textContent()) ?? '';
    expect(parseInt((liveErrText.match(/(\d+)/) as RegExpMatchArray)[1], 10)).toBe(0);
  });

  test('repo: rendered blocking-errors + warnings == yg check on this repo', async ({ page, repoPage }) => {
    // The rich real-repo graph: parity must hold there too, at whatever the live numbers are.
    const repoRoot = (await import('node:path')).join((await import('./support/harness')).CLI_ROOT, '..', '..');
    const check = runCheck(repoRoot);
    const cliErrors = parseCheckErrors(check.out);
    const cliWarnings = parseCheckWarnings(check.out);

    await page.goto(repoPage + '#/view/coverage');
    const liveErrText = (await page.locator('.cov-livewrap .cov-live', { hasText: 'blocking errors' }).textContent()) ?? '';
    const renderedErrors = parseInt((liveErrText.match(/(\d+)/) as RegExpMatchArray)[1], 10);
    expect(renderedErrors).toBe(cliErrors);

    // The overview verdict's plain-language head agrees with the CLI's severity (errors >
    // warnings > clean), so the human-facing summary never reads greener than `yg check`.
    await page.goto(repoPage + '#/view/overview');
    const verdict = (await page.locator('.ov-verdict-head').textContent()) ?? '';
    if (cliErrors > 0) {
      expect(verdict).toMatch(/broke a rule|waiting to be checked/);
    } else if (cliWarnings > 0) {
      expect(verdict).toMatch(/advisor/i);
    } else {
      expect(verdict).toMatch(/passed/i);
    }
  });
});
