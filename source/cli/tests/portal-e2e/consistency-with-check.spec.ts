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
import { mkdtempSync} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from './support/fixtures';
import { runCheck, runCheckJson, type CheckJsonDoc, staticPage, freshFixtureCopy, servedPortal, readInlinedData, approveDeterministic, fixtureRoot, runSuppressions } from './support/harness';
import { copyFixtureTree } from '../support/fixture-copy.js';

export const COVERS: string[] = [];

/** The blocking-error total `yg check` reports (`totals.errors` of its JSON document). */
function checkErrors(doc: CheckJsonDoc): number {
  return doc.totals.errors;
}

/** The warning total `yg check` reports (`totals.warnings` of its JSON document). */
function checkWarnings(doc: CheckJsonDoc): number {
  return doc.totals.warnings;
}

/**
 * The flag-on coverage split's three honest terms — node-owned, type-covered, excluded —
 * out of the total, as `yg check` reports them (`coverage` of its JSON document; the text
 * verdict line prints the same numbers as `N/M files covered (A node-owned · B
 * type-covered · C excluded)`). Throws when the split is absent (a flag-off project).
 */
function checkTypeSplit(doc: CheckJsonDoc): { nodeOwned: number; typeCovered: number; excluded: number; total: number } {
  const c = doc.coverage;
  if (c.nodeOwned === null || c.typeCovered === null || c.excluded === null) throw new Error(`yg check reports no type-level coverage split: ${JSON.stringify(c)}`);
  return { nodeOwned: c.nodeOwned, typeCovered: c.typeCovered, excluded: c.excluded, total: c.files };
}

/** Parse `yg check`'s repo-wide "N file(s) matched by a type could not have its rules worked out" count, or 0. */
function parseCheckUncomputableCount(out: string): number {
  const m = out.match(/(\d+) files? matched by a type could not have (?:its|their) rules worked out/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Parse `yg check`'s repo-wide "N file(s) ... satisfy coverage with no enforcement" count, or 0. */
function parseCheckZeroEnforcementCount(out: string): number {
  const m = out.match(/(\d+) files? matched by a type ha(?:s|ve) no rules that apply to (?:it|them)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Coverage findings `yg check` reports as coverage blocks, never as rule groups (the portal's `worklistCoverage`). */
const COVERAGE_CODES = new Set(['unmapped-files', 'uncovered-advisory', 'unmapped-files-outside', 'uncovered-advisory-outside']);

/**
 * Every rule GROUP `yg check` reports — one `error[<label>]` / `warning[<label>]` block each in
 * the text report, one `groups[]` entry each in its JSON document — with its label, its cause
 * (an unverified group names why its pairs have no verdict: `deterministic-not-run`, `stale`,
 * …) and the SEVERITY it is reported under, so a page comparison can verify not just that a
 * group exists but that it renders under the right severity. Read from the CLI's own report,
 * never a hardcoded literal, so the page cannot silently drift from the command line without
 * this failing. The SAME code (e.g. `unverified`, split by the pair's enforced/advisory status)
 * comes back as two DISTINCT groups with different severities, never flattened together.
 * Coverage blocks (`unmapped`, `uncovered`) are left out: the portal renders those as
 * `.cov-covblock`, asserted directly, never as worklist rows.
 */
function checkRuleGroups(doc: CheckJsonDoc): Array<{ label: string; cause: string | undefined; severity: 'error' | 'warning'; why: string }> {
  return doc.groups.filter((g) => !COVERAGE_CODES.has(g.code)).map((g) => ({ label: g.label, cause: g.cause, severity: g.severity, why: g.why }));
}

test.describe('the page counts EQUAL `yg check` on the same fixture', () => {
  test('portal-basic: rendered errors / verified / unverified == yg check', async ({ page, t }) => {
    const fixtureCwd = (await import('./support/harness')).fixtureRoot('portal-basic');
    const url = staticPage(t, { fixture: 'portal-basic' });

    // What the CLI reports (the source of truth).
    const { doc: check } = runCheckJson(fixtureCwd);
    const cliErrors = checkErrors(check);
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

    // The worklist mirrors the CLI's grouping exactly — the SAME rule groups, derived from the
    // CLI's own output rather than pinned to a literal, so the page can neither drop a group the
    // CLI reports nor invent one. On this fixture that is the blocking unverified group plus the
    // non-blocking agent-rules-digest group (the fixture ships no agent-rules install, and the
    // page must say so exactly as the CLI does — a page that showed only the blocking group would
    // be reading greener than the command line).
    const cliGroups = checkRuleGroups(check);
    const unverifiedGroup = cliGroups.find((g) => g.label === 'unverified' && g.cause === 'deterministic-not-run');
    expect(unverifiedGroup, JSON.stringify(cliGroups)).toBeDefined();
    expect(cliGroups.map((g) => g.label)).toContain('rules-digest-stale');
    // The two groups carry DIFFERENT severities — the blocking finding is an error, the
    // agent-rules gap is a warning — never folded together under one severity.
    const digestGroup = cliGroups.find((g) => g.label === 'rules-digest-stale');
    expect(unverifiedGroup?.severity).toBe('error');
    expect(digestGroup?.severity).toBe('warning');
    await expect(page.locator('.cov-worow')).toHaveCount(cliGroups.length);
    // The blocking group leads the priority cascade and still covers both unverified nodes,
    // rendered with the 'error' pill.
    const firstRow = page.locator('.cov-worow').first();
    await expect(firstRow.locator('.cov-worow-meta')).toContainText('2 nodes');
    await expect(firstRow.locator('.cov-pill')).toContainText('error');
    // The row id is the CLI's own group label (`unverified`, `rules-digest-stale`), and the
    // unverified row carries the CLI's own why for its cause — here a deterministic check
    // that has not run on this fresh checkout.
    await expect(page.locator('.cov-worow')).toContainText(['unverified', 'rules-digest-stale']);
    await expect(firstRow.locator('.cov-worow-id')).toContainText((unverifiedGroup as { why: string }).why);
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
    expect(checkErrors(runCheckJson(project).doc)).toBe(0);

    // The served page, re-fetched, follows the CLI to green: verified fraction is 2 / 2, no errors.
    await page.goto(baseUrl + '/#/view/coverage');
    const fracText = (await page.locator('.cov-frac').first().textContent())?.replace(/\s+/g, ' ').trim() ?? '';
    const fracM = fracText.match(/(\d+)\s*\/\s*(\d+)/) as RegExpMatchArray;
    expect(parseInt(fracM[1], 10)).toBe(2); // verified
    expect(parseInt(fracM[2], 10)).toBe(2); // total
    const liveErrText = (await page.locator('.cov-livewrap .cov-live', { hasText: 'blocking errors' }).textContent()) ?? '';
    expect(parseInt((liveErrText.match(/(\d+)/) as RegExpMatchArray)[1], 10)).toBe(0);
  });

  test('portal-type-coverage: counts.typeCoveredCount / excludedFiles / uncoveredFiles reconcile with yg check\'s honest terms — a type-covered file with a real refusal is never called unmapped', async ({ page, t }) => {
    // A fresh copy, deterministically filled BEFORE either side reads it, so the CLI header
    // and the portal extraction see the identical committed state — including the type-covered
    // file's REAL refused verdict (a live deterministic check, not a fabricated one).
    const project = freshFixtureCopy(t, 'portal-type-coverage');
    approveDeterministic(project);

    const check = runCheck(project);
    const split = checkTypeSplit(runCheckJson(project).doc);
    // Sanity-pin the fixture's own shape so a future edit to it cannot silently
    // invalidate what this test is actually proving.
    expect(split).toEqual({ nodeOwned: 1, typeCovered: 2, excluded: 1, total: 4 });

    const url = staticPage(t, { cwd: project });
    // Field-level parity against the exact contract the page emits.
    const portal = readInlinedData(url) as {
      meta: { counts: { typeCoveredCount: number; typeCoveredUnenforced: number; excludedFiles: number; coveredFiles: number; uncoveredFiles: number; totalFiles: number; refused: number } };
    };
    expect(portal.meta.counts.typeCoveredCount).toBe(split.typeCovered);
    expect(portal.meta.counts.excludedFiles).toBe(split.excluded);
    // coveredFiles is NOT redefined — it stays nodeOwned + excluded, exactly as
    // CheckResult.coveredFiles already is.
    expect(portal.meta.counts.coveredFiles).toBe(split.nodeOwned + split.excluded);
    // Every file is spoken for: node-owned, type-covered, or excluded — nothing left uncovered.
    expect(portal.meta.counts.uncoveredFiles).toBe(0);
    expect(portal.meta.counts.totalFiles).toBe(split.total);
    // The heart of it: the type-covered file's refusal IS in this same payload.
    expect(portal.meta.counts.refused).toBe(1);
    // The SECOND type-covered file matches yg check's own "satisfy coverage with no
    // enforcement" bucket — exactly one file, the same one the CLI names by sample below.
    expect(portal.meta.counts.typeCoveredUnenforced).toBe(1);

    // The same numbers RENDER in real Chromium, on the Overview residue chips — split into
    // two distinct chips, never one bare "matched type" count folding both together.
    await page.goto(url);
    const enforcedChip = page.locator('.ov-residue .reslink', { hasText: 'satisfied by their matched type' });
    await expect(enforcedChip).toContainText('1'); // src/svc/handler.ts, checked (has a real pair)
    const unenforcedChip = page.locator('.ov-residue .reslink', { hasText: 'no rule that applies' });
    await expect(unenforcedChip).toContainText('1'); // src/lib/util.ts, checked by nothing

    // `yg check` names the unenforced file BY NAME under "satisfy coverage with no
    // enforcement" — the portal must name it too, not just count it. Read straight off
    // the page (Coverage & Audit), the real emitted output, not the inlined JSON.
    expect(check.out).toContain('src/lib/util.ts');
    expect(check.out).toMatch(/satisf(?:y|ies) coverage with no enforcement/);
    await page.goto(url + '#/view/coverage');
    await expect(page.locator('.cov-ledger')).toContainText('src/lib/util.ts');
    await expect(page.locator('.cov-ledger')).toContainText('type-covered as lib');
    await expect(page.locator('.cov-ledger')).toContainText('checked by nothing');
    // The checked file is ALSO named, under its own, differently-worded line — never the
    // "checked by nothing" wording, and never absent just because the unenforced one is now
    // rendered too.
    await expect(page.locator('.cov-ledger')).toContainText('src/svc/handler.ts');
    await expect(page.locator('.cov-ledger')).toContainText('type-covered as svc');

    // The unenforced file gets the honest "no rule" badge (the same one a no-rule NODE gets),
    // never the neutral "satisfied" mark reserved for a file that actually has a pair.
    const noRuleRow = page.locator('.cov-nonpair', { hasText: 'checked by nothing' });
    await expect(noRuleRow.locator('.state-no-rule')).not.toHaveCount(0);

    // The deliberately excluded file has a home too: it is named on the page, not only
    // folded into a count nobody can trace back to a file.
    await expect(page.locator('.cov-ledger')).toContainText('vendor/tool.ts');
    await expect(page.locator('.cov-ledger')).toContainText('deliberately excluded from coverage');
  });

  test('a real aspect implies cycle: the portal calls the cycle file "unknown", never "no rule applies", and the counts equal yg check', async ({ page, t }) => {
    // type-level-engine + its variants/cyclic-type overlay: the one committed fixture
    // combination with a real aspect `implies` cycle reaching a type-covered file
    // (src/cyclic/z.ts, type 'cyclic', cyclic-a <-> cyclic-b) alongside a genuinely
    // zero-enforcement one (src/ep/e.ts, type 'emptyparents', which declares no aspects
    // at all). `yg check` on this combination reports exactly ONE uncomputable file and
    // ONE zero-enforcement file — the two must never share a count, on either surface.
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-e2e-cyclic-'));
    t.tmpDirs.push(dir);
    copyFixtureTree(fixtureRoot('type-level-engine'), dir);
    copyFixtureTree(path.join(fixtureRoot('type-level-engine'), 'variants', 'cyclic-type'), dir);

    const check = runCheck(dir);
    const cliUncomputable = parseCheckUncomputableCount(check.out);
    const cliZeroEnforcement = parseCheckZeroEnforcementCount(check.out);
    // Sanity-pin the fixture combination's own shape.
    expect(cliUncomputable).toBe(1);
    expect(cliZeroEnforcement).toBe(1);

    const url = staticPage(t, { cwd: dir });
    const portal = readInlinedData(url) as {
      meta: { counts: { typeCoveredUnenforced: number; typeCoveredUncomputable: number } };
      residue: {
        typeCovered: Array<{ path: string; type: string; enforced: boolean }>;
        typeCoveredUncomputable: Array<{ path: string; type: string; why: string }>;
      };
    };
    // Field-level parity: the portal's split equals the CLI's, never conflated into one number.
    expect(portal.meta.counts.typeCoveredUncomputable).toBe(cliUncomputable);
    expect(portal.meta.counts.typeCoveredUnenforced).toBe(cliZeroEnforcement);
    expect(portal.residue.typeCoveredUncomputable.map((f) => f.path)).toEqual(['src/cyclic/z.ts']);
    // The cycle file never also appears in the enforced/unenforced list — the two are disjoint.
    expect(portal.residue.typeCovered.map((f) => f.path)).not.toContain('src/cyclic/z.ts');
    expect(portal.residue.typeCovered.filter((f) => !f.enforced).map((f) => f.path)).toEqual(['src/ep/e.ts']);

    // The SAME facts render on the page, in real Chromium — Overview first.
    await page.goto(url);
    const unknownChip = page.locator('.ov-residue .reslink', { hasText: 'could not be worked out' });
    await expect(unknownChip).toContainText('1');
    const unenforcedChip = page.locator('.ov-residue .reslink', { hasText: 'no rule that applies' });
    await expect(unenforcedChip).toContainText('1');

    // Coverage & Audit: the cycle file is named, WITH the cycle itself named — never the
    // "satisfies coverage with no enforcement" sentence docs/configuration.md forbids for
    // this exact case, and never folded into the "checked by nothing" bucket below it.
    await page.goto(url + '#/view/coverage');
    const ledgerText = (await page.locator('.cov-ledger').textContent()) ?? '';
    expect(ledgerText).toContain('src/cyclic/z.ts');
    expect(ledgerText).toContain('could not be worked out');
    expect(ledgerText).toMatch(/implies cycle/);
    expect(ledgerText).toContain('cyclic-a');

    const unknownBlock = page.locator('.cov-nonpair', { hasText: 'could not be worked out' });
    await expect(unknownBlock.locator('.cov-key b')).toHaveText('1');
    // The genuinely zero-enforcement file is still named, distinctly, under "checked by
    // nothing" — the honest "no rule" badge, count exactly 1 (never 2).
    const noRuleBlock = page.locator('.cov-nonpair', { hasText: 'checked by nothing' });
    await expect(noRuleBlock.locator('.cov-key b')).toHaveText('1');
    await expect(page.locator('.cov-typelist-bad')).toContainText('src/ep/e.ts');
    await expect(page.locator('.cov-typelist-bad')).not.toContainText('src/cyclic/z.ts');
    await expect(page.locator('.cov-typelist-unknown')).toContainText('src/cyclic/z.ts');
  });

  test('repo: rendered blocking-errors + warnings == yg check on this repo', async ({ page, repoPage }) => {
    // The rich real-repo graph: parity must hold there too, at whatever the live numbers are.
    const repoRoot = (await import('node:path')).join((await import('./support/harness')).CLI_ROOT, '..', '..');
    const { doc: check } = runCheckJson(repoRoot);
    const cliErrors = checkErrors(check);
    const cliWarnings = checkWarnings(check);

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

    // Whole-file waivers: an INVARIANT, never a literal. This repo's own unverified/error
    // counts above are wiped clean by the round's final `yg check --approve`, so a count
    // pinned to today's live state would be self-defeating the moment that runs — the CLI's
    // own `yg suppressions` output is the one source of truth, read fresh at test time. A
    // whole-file waiver is rendered by the CLI as `file-level(<aspectId>)` (never `single(...)`
    // / `disable(...)` / `enable(...)`, which are the line/range/closing forms); the portal's
    // Suppressions view renders the SAME set of markers with the honest 'whole file' form label
    // (never the blanket "bounded" claim a line/range waiver gets) — as long as none of them
    // also carries a risk flag (wildcard / typo / inert / errs-under), which would replace the
    // clean form badge with a risk badge instead. This repo's own file-level markers are all
    // clean today; a future risky one would rightly break this assertion until fixed.
    const suppressionsOut = runSuppressions(repoRoot);
    const fileLevel = (suppressionsOut.out.match(/file-level\(/g) ?? []).length;
    await page.goto(repoPage + '#/view/suppressions');
    await expect(page.locator('.sup-flag-ok', { hasText: 'whole file' })).toHaveCount(fileLevel);
  });

  test('portal-mixed: worklist splits severities and badges match the CLI sections', async ({ page, t }) => {
    const url = staticPage(t, { fixture: 'portal-mixed' });
    const { doc: check } = runCheckJson(fixtureRoot('portal-mixed'));

    // Sanity-pin the fixture's own known shape (a FIXTURE, not the repo — this state never
    // gets wiped): the enforced aspect's 2 pairs are errors; the advisory aspect's 2 pairs
    // PLUS the ever-present rules-digest-stale warning make 3 warnings.
    const cliErrors = checkErrors(check);
    const cliWarnings = checkWarnings(check);
    expect(cliErrors).toBe(2);
    expect(cliWarnings).toBe(3);

    const cliGroups = checkRuleGroups(check);
    const errorGroups = cliGroups.filter((g) => g.severity === 'error');
    const warningGroups = cliGroups.filter((g) => g.severity === 'warning');
    // The regression this fixture locks: the SAME issue code ('unverified') fires on BOTH
    // severities at once — one node×aspect pair enforced, one advisory — and must render as
    // two SEPARATE groups, never folded into one (the round's central defect).
    expect(errorGroups).toHaveLength(1);
    expect(errorGroups[0]).toMatchObject({ label: 'unverified', cause: 'deterministic-not-run' });
    expect(warningGroups).toContainEqual(expect.objectContaining({ label: 'unverified', cause: 'deterministic-not-run', severity: 'warning' }));
    const warningUnverified = warningGroups.find((g) => g.label === 'unverified') as { why: string };

    // The CLI's own block order on this fixture: the error, then the advisory unverified
    // group, then the digest warning. The worklist must follow the same order.
    expect(cliGroups.map((g) => `${g.severity}[${g.label}]`)).toEqual(['error[unverified]', 'warning[unverified]', 'warning[rules-digest-stale]']);

    await page.goto(url + '#/view/coverage');
    await expect(page.locator('.cov-worow')).toHaveCount(cliGroups.length);
    // The error group leads (errors always sort before warnings in the worklist).
    await expect(page.locator('.cov-worow').nth(0).locator('.cov-pill')).toContainText('error');
    await expect(page.locator('.cov-worow').nth(0).locator('.cov-worow-id')).toContainText('unverified');
    await expect(page.locator('.cov-worow').nth(0).locator('.cov-worow-id')).toContainText(errorGroups[0].why);
    // The FIRST warning group is the SAME 'unverified' code, now advisory severity — proof the
    // page renders it as its own distinct row, not merged with the error row above. Checking
    // the pill alone would not prove this: 'rules-digest-stale' is ALSO a warning-severity
    // group on this fixture, so a pill-only check would still pass if the two warning rows'
    // order ever swapped. Asserting the row's own id/label closes that gap.
    await expect(page.locator('.cov-worow').nth(1).locator('.cov-pill')).toContainText('warning');
    await expect(page.locator('.cov-worow').nth(1).locator('.cov-worow-id')).toContainText('unverified');
    await expect(page.locator('.cov-worow').nth(1).locator('.cov-worow-id')).toContainText(warningUnverified.why);

    // The overview's plain-language split sentence agrees with the CLI's own counts.
    await page.goto(url + '#/view/overview');
    await expect(page.locator('.ov-verdict')).toContainText(cliErrors + ' blocking item(s)');
    await expect(page.locator('.ov-verdict')).toContainText(cliWarnings + ' advisory signal(s)');
  });

  test('portal-coverage-only: a coverage-only red build with an EMPTY worklist never reads "All clear"', async ({ page, t }) => {
    const url = staticPage(t, { fixture: 'portal-coverage-only' });
    const { doc: check } = runCheckJson(fixtureRoot('portal-coverage-only'));
    expect(checkErrors(check)).toBeGreaterThan(0);
    // This fixture carries its own agent-rules install (AGENTS.md / CLAUDE.md /
    // .clinerules/yggdrasil.md — the CLI's own `yg init --upgrade`, excluded from
    // coverage in the fixture's own config so they never become a SECOND unmapped
    // finding), so rules-digest-stale never fires here. That makes `data.worklist`
    // genuinely EMPTY — the coverage gap (unmapped-files) is a `worklistCoverage`
    // block, never a `worklist` group — while the build stays red on the unmapped
    // file alone. Sanity-pin: no rule groups, exactly one coverage block, one error.
    expect(checkWarnings(check)).toBe(0);
    const cliGroups = checkRuleGroups(check);
    expect(cliGroups).toHaveLength(0);
    expect(check.groups.filter((g) => g.code === 'unmapped-files')).toHaveLength(1);

    await page.goto(url + '#/view/coverage');
    // THE lock: the pre-round calm gate was `worklist.length === 0`, which this exact
    // shape (empty worklist, real red build) would have satisfied — rendering BOTH the
    // calm panel AND the jump button's "All clear" copy on a build that is failing. The
    // round's fix keyed calm off the live error/warning counts instead
    // (`errors === 0 && warnings === 0`), which stays false here (1 error), so NEITHER
    // must ever appear — the worst-failure-mode this fixture exists to lock.
    await expect(page.locator('.cov-calm')).toHaveCount(0);
    const jump = page.locator('.cov-jump');
    await expect(jump).not.toContainText('All clear');
    await expect(jump).not.toHaveClass(/cov-jump-residue/);
    // No group carries a component to jump to (the worklist is empty), so the honest
    // button says so — never a dead "clear" claim standing in for "nothing to click".
    await expect(jump).toContainText('No component to jump to');

    await expect(page.locator('.cov-covblock')).toContainText('src/b.ts');
    // "Needs attention" counts worklist groups (0, now that rules-digest-stale is gone)
    // PLUS this one coverage block — (1), not the "(2)" it would have read before the
    // agent-rules install removed the digest warning, and never "(0)" — a red build can
    // never show a zero count here.
    await expect(page.locator('.cov-section-count')).toContainText('(1)');
  });

  test('portal-type-coverage: a refused nodeless pair is a named file member with its violation detail, and a refused badge with its reason in the coverage listing', async ({ page, typeCoveragePage }) => {
    await page.goto(typeCoveragePage + '#/view/coverage');

    // The worklist: no node maps src/svc/handler.ts, so its refusal is a NAMED FILE subject,
    // never silently dropped for lack of a node — with the full multi-line violation detail
    // (never truncated to a bare count).
    await expect(page.locator('.cov-member-file')).toContainText('src/svc/handler.ts');
    const enforcedGroup = page.locator('.cov-worow-wrap', { hasText: 'no-todo-comments' });
    await expect(enforcedGroup.locator('.cov-member-what')).toHaveCount(1);
    await expect(enforcedGroup.locator('.cov-member-what')).toContainText('FIXME');

    // The type-covered listing: the SAME file, a REFUSED badge (never the neutral
    // "satisfied" mark reserved for a checked-but-clean file), with its reason.
    const listRow = page.locator('.cov-typelist-ok .cov-typerow', { hasText: 'src/svc/handler.ts' });
    await expect(listRow.locator('.state-refused')).toHaveCount(1);
    await expect(listRow).toContainText('src/svc/handler.ts:4');
  });

  test('portal-basic: default-allow matrix renders any-type, module stays organizational', async ({ page, basicPage }) => {
    await page.goto(basicPage + '#/view/types');
    // Exact type-id match (not a substring `hasText`) — 'module's own description mentions
    // "related services", which would otherwise falsely match a 'service' substring filter.
    const serviceCard = page.locator('.ty-card').filter({ has: page.locator('.ty-name', { hasText: /^service$/ }) });
    const moduleCard = page.locator('.ty-card').filter({ has: page.locator('.ty-name', { hasText: /^module$/ }) });
    await expect(serviceCard).toContainText('any component type');
    await expect(serviceCard).not.toContainText('structural parent only');
    // 'module' declares no `when:` — no file-classification predicate — so it must still
    // read organizational, never flip to "classifying" just because the project is permissive.
    await expect(moduleCard).toContainText('organizational');
  });

  test('coverage bar renders exactly one segment per non-zero pair state — never a phantom zero-count segment, never a missing non-zero one', async ({ page, basicPage }) => {
    // A WIDTH-based probe cannot discriminate here: portal-basic (unapproved) has exactly
    // ONE non-zero pair state (unverified: 2 — verified/refused/advisoryRefused are all 0),
    // so a single flex child always fills the whole 1500px bar regardless of whether the
    // renderer is honoring the "zero-count states never paint" rule — no committed fixture
    // produces a genuinely lopsided multi-segment bar to make width meaningful. Worse: this
    // round's `views-worklist.css` sets `.cov-seg { min-width: 6px }`, so if the
    // `flex <= 0 -> return null` guard in `coverage-view.js`'s `barSeg` were ever removed, ALL
    // FOUR candidate segments (including the three zero-count ones) would render at a real,
    // on-screen, comfortably-over-5px width — a width-only assertion would keep passing while
    // actively certifying the exact regression it exists to catch.
    //
    // The SHAPE is what actually carries the guarantee: the number of rendered `.cov-seg`
    // elements must equal the number of NON-ZERO pair states in the page's own data — derived
    // fresh from the inlined PortalData, never a literal — which locks both halves at once: a
    // zero-count state never paints (bounds the count from above) and every non-zero state
    // does (bounds it from below).
    const portal = readInlinedData(basicPage) as {
      meta: { counts: { verified: number; refused: number; advisoryRefused: number; unverified: number } };
    };
    const c = portal.meta.counts;
    const nonZeroCount = [c.verified, c.refused, c.advisoryRefused, c.unverified].filter((n) => n > 0).length;
    expect(nonZeroCount).toBeGreaterThan(0); // sanity: never assert a vacuous "0 == 0" here

    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto(basicPage + '#/view/coverage');
    const segs = page.locator('.cov-bar .cov-seg');
    await expect(segs).toHaveCount(nonZeroCount);
    // Still real, on-screen geometry for each of the (correctly-shaped) segments — not merely
    // present in the DOM but collapsed to nothing.
    for (const seg of await segs.all()) {
      const box = await seg.boundingBox();
      expect(box).not.toBeNull();
      expect((box as { width: number }).width).toBeGreaterThan(0);
    }
  });
});
