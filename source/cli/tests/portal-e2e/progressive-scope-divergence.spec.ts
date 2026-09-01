/*
 * PROGRESSIVE SCOPE — the command answers for the change; the portal answers for the project.
 *
 * `yg check` on a project with a configured reference branch gates only what the CURRENT change
 * is accountable for: a violation already present on the reference, that the change never
 * touched, is named and counted but does not block (it renders as an `enforced (outside
 * changes)` WARNING and the run still exits 0). The portal, over the SAME on-disk project, was
 * deliberately wired the opposite way (`portal/engine-api.ts::runPortalCheck` passes
 * `changeScope: undefined` unconditionally, threaded and pinned inert since the parity-aspect
 * task that introduced `changeScope` — see that call site's own comment): it always renders the
 * whole project's standing picture, so the SAME violation renders as a plain blocking ERROR
 * there, with no "(outside changes)" annotation at all.
 *
 * This is the intended split, not a bug to reconcile: the command is read by whoever made the
 * change and is judged against it; the page is read by someone who did not necessarily make that
 * change (a reviewer, a teammate skimming project health) and would be misled by a page that
 * quietly excused debt just because it happened to sit outside one particular working tree's
 * diff. This spec drives BOTH surfaces for real — the built binary's scoped gate, then the real
 * `--static` page in real Chromium — over one committed reference-branch fixture, and pins the
 * disagreement between them as the DESIGN. If a future change ever makes these two agree, that
 * is a regression: it means the portal started answering for a change scope it was deliberately
 * never given, and the one surface that still showed the whole truth has quietly disappeared.
 *
 * Public surface only — spawns dist/bin.js, opens the page it wrote; no fabricated PortalData.
 * The fixture (tests/support/progressive-fixture.ts) is the same real-git-repo-with-a-reference-
 * branch support earlier progressive-mode tasks built; reused here rather than duplicated. COVERS
 * adds no new manifest surface — it re-asserts coverage/overview honesty (both already covered
 * elsewhere: views-render.spec.ts).
 */
import { test, expect } from './support/fixtures';
import { staticPage, runCheck, approveDeterministic } from './support/harness';
import { createProgressiveFixture, type ProgressiveFixture } from '../support/progressive-fixture.js';

export const COVERS: string[] = [];

test.describe('progressive scope divergence: the CLI excuses inherited debt, the portal never does', () => {
  test('a violation the change never reached passes the scoped CLI gate but still renders as a blocking error in the portal', async ({ page, t }) => {
    // A real git repo with a reference branch (`main`) and a real pre-existing failure
    // (`beta`'s TODO) that no branch cut from it ever touches — the fixture every other
    // progressive-mode e2e in this repo already builds around; see its own docstring. Its
    // own `cleanup()` (below, in `finally`) removes the temp dir; it is not registered with
    // the shared `t` teardown because it owns a second, shallow-clone-tracking cleanup of
    // its own that `t.tmpDirs`' plain `rmSync` sweep does not know about.
    const fixture: ProgressiveFixture = createProgressiveFixture({ label: 'portal-divergence', progressiveReference: 'main' });

    try {
      // Record the reference branch's own verdicts first (deterministic recording is
      // whole-project and free) — beta's TODO becomes a real, RECORDED, pre-existing
      // refusal on `main`, exactly as a CI run would leave it before any later branch
      // is gated against it.
      const approveRef = approveDeterministic(fixture.dir);
      expect(approveRef.status, approveRef.out).toBe(0);

      // Cut a branch that edits ONLY alpha, cleanly. beta is never touched by this diff.
      fixture.branchWithEdit('feature', 'src/alpha/alpha.ts', 'export const alpha = 1;\nexport const alphaAgain = 3;\n');
      const approveBranch = approveDeterministic(fixture.dir);
      expect(approveBranch.status, approveBranch.out).toBe(0);

      // THE COMMAND, scoped (the plain gate a person on this branch runs): PASSES. beta's
      // pre-existing TODO is real, named, and counted — but outside this change — so it
      // does not block. This is the "K outside" half of the pin: exit 0 with exactly one
      // obligation reported as inherited, never silently dropped.
      const scoped = runCheck(fixture.dir);
      expect(scoped.status, `expected the scoped gate to PASS (beta's TODO predates this branch and was never touched by it):\n${scoped.out}`).toBe(0);
      expect(scoped.out).toContain('1 obligation outside your changes vs main (1 changed input)');
      expect(scoped.out).toContain('enforced (outside changes)');

      // THE PORTAL, over the IDENTICAL on-disk project (same branch checked out, same
      // recorded lock) — opened for real in Chromium. It must show beta's TODO as a plain
      // blocking error, never annotated "(outside changes)", because runPortalCheck never
      // receives a change scope at all.
      const url = staticPage(t, { cwd: fixture.dir });
      await page.goto(url + '#/view/coverage');

      const group = page.locator('.cov-worow-wrap', { hasText: 'no-todo-comments' });
      await expect(
        group,
        'the portal must still show a worklist row for the pre-existing TODO — silently dropping it would hide real, outstanding project debt, which is the whole reason this page is never scoped to a change',
      ).toHaveCount(1);
      await expect(
        group.locator('.cov-pill'),
        'DIVERGENCE IS INTENTIONAL, not a parity bug: the scoped command above just reported this exact violation as a non-blocking WARNING ("enforced (outside changes)") because the current branch never touched beta — but the portal answers for the PROJECT, not for one working tree\'s diff, so the identical violation must still read as a blocking ERROR here. If this ever renders "warning" instead, the portal has started scoping itself to a change like the CLI does, and the one surface that still shows the whole truth to a reader who did not make that change has quietly disappeared.',
      ).toContainText('error');
      await expect(
        group.locator('.cov-worow-id'),
        'the group label must be the BASE label ("enforced"), with no "(outside changes)" suffix — that suffix exists only on the twin issue a change SCOPE produces, and the portal is deliberately never given one (see runPortalCheck)',
      ).toContainText('enforced');
      await expect(group.locator('.cov-worow-id')).not.toContainText('outside changes');
      await expect(group).toContainText(/beta/i);
      await expect(group).toContainText('TODO comment found');

      // The plain-language overview head agrees with the portal's own worklist, not with
      // the command a developer on this branch just ran: the command said PASS, but the
      // page still says the project broke a rule. That gap between what the two surfaces
      // say IS the design — the command answers for the diff, the page answers for the repo.
      await page.goto(url + '#/view/overview');
      await expect(
        page.locator('.ov-verdict-head'),
        'the scoped CLI run above exited 0 (a clean PASS for this branch), yet the portal\'s own plain-language verdict must still say the project broke a rule — the page is deliberately never told about the change scope that let the command pass',
      ).toContainText('broke a rule');
    } finally {
      fixture.cleanup();
    }
  });
});
