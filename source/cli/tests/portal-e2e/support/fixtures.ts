/*
 * Playwright test fixtures (Chromium) for the portal e2e — the shared, torn-down harness.
 *
 * Exposes:
 *   t          — a per-worker Teardown registry; every server/temp-dir created in a test is
 *                tracked here and killed/removed in the worker-scoped afterAll, so a run always
 *                terminates (no orphan server, no leaked browser — Playwright owns the browser).
 *   basicPage  — the file:// URL of the REAL `yg portal --static` page over the frozen
 *                `portal-basic` fixture (the small, exact-count surface).
 *   repoPage   — the file:// URL of the REAL `yg portal --static` page over THIS repo's own
 *                graph through the public CLI (the rich surface: flows, suppressions, hubs,
 *                many types — for the transition rows that need real data). Generated once.
 *
 * All test specs import `test` / `expect` from here, so they share one Chromium project and one
 * teardown. No portal internal is imported; no PortalData is fabricated.
 */
import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import { newTeardown, teardown, staticPage, freshFixtureCopy, approveDeterministic, CLI_ROOT, type Teardown } from './harness';

// All three fixtures are WORKER-scoped (the second generic arg of extend) so a server spawned in
// one test is still reachable for cleanup and the static pages are generated once per worker.
// Playwright introspects the object-pattern first parameter (`{}` / `{ t }`) to build the fixture
// dependency graph, so it must stay a destructuring pattern; the `use` callbacks are left to
// Playwright's own inference (the canonical worker-fixture form).
export const test = base.extend<
  Record<never, never>,
  { t: Teardown; basicPage: string; repoPage: string; typeCoveragePage: string }
>({
  t: [
    async ({}, use) => {
      const reg = newTeardown();
      await use(reg);
      teardown(reg);
    },
    { scope: 'worker' },
  ],
  basicPage: [
    async ({ t }, use) => {
      await use(staticPage(t, { fixture: 'portal-basic' }));
    },
    { scope: 'worker' },
  ],
  repoPage: [
    async ({ t }, use) => {
      // staticPage runs the CLI in CLI_ROOT/../.. (the repo root) so it reads THIS repo's graph.
      const repoRoot = path.join(CLI_ROOT, '..', '..');
      await use(staticPage(t, { cwd: repoRoot }));
    },
    { scope: 'worker' },
  ],
  // The one portal page with coverage.type_level ON: a fresh copy of portal-type-coverage,
  // deterministically filled BEFORE the static emit so the type-covered file carries a real
  // refused verdict, not merely an unverified one — the exact shape the portal must never
  // call "unguarded" in the same payload that reports the refusal.
  typeCoveragePage: [
    async ({ t }, use) => {
      const project = freshFixtureCopy(t, 'portal-type-coverage');
      approveDeterministic(project);
      await use(staticPage(t, { cwd: project }));
    },
    { scope: 'worker' },
  ],
});

export { expect };
