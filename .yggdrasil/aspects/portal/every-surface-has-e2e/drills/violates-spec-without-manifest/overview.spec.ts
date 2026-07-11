// Fail-closed guard: a spec that declares and genuinely drives a surface, but with NO
// readable SURFACE_MANIFEST present, must be REFUSED — never silently read as "everything
// covered". (drill v1 runs one file per case, so the manifest and a covering spec cannot be
// coupled into a single positive-coverage case here; that positive path is exercised live on
// the real portal-e2e node, which maps both support/surfaces.ts and the specs together.)
export const COVERS = ['overview'];

test('overview renders its verdict rollup', async ({ page }) => {
  await page.goto('#/view/overview');
  await expect(page.locator('.ov-verdict')).toBeVisible();
});
