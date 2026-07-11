import { test } from '@playwright/test';

test('renders the surface', async ({ page }) => {
  await page.goto('/');
});
