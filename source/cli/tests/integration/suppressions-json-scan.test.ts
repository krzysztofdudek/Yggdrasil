import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { loadPortalGraph, walkPortalFiles, NO_COVERAGE_EXCLUDED } from '../../src/portal/engine-api.js';
import { runSuppressionsScan, formatSuppressionsOutput } from '../../src/cli/suppressions.js';
import type { SuppressionsReport } from '../../src/core/suppressions/scan.js';
import { collectMappingEntries } from '../../src/core/suppressions/eligibility.js';
import { buildSuppressionsJson } from '../../src/cli/suppressions.js';
import { suppressionWarningText } from '../../src/cli/suppressions.js';
/** The scan's warnings in the words the inventory prints them in. */
const warningTexts = (r: { warningRecords?: Parameters<typeof suppressionWarningText>[0][] }): string[] => (r.warningRecords ?? []).map(suppressionWarningText);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.resolve(__dirname, '../fixtures');

/**
 * `portal-suppress-forms` is a real, working project (its own `.yggdrasil/`
 * graph + real source), loaded and scanned exactly like the CLI command would
 * — never a hand-built report literal. One node (`code`, mapping the whole
 * `src/` tree) carries two deterministic aspects: `no-console` (errs: under)
 * and `no-todo` (no errs label). Its four files each carry a DIFFERENT waiver
 * shape (see each file's own comment below), so a single real scan exercises
 * every `ranges` / `warningRecords` case this integration proves against the
 * facade's real scan+build path.
 *
 * `runSuppressionsScan` is called directly (not through the portal's
 * `scanPortalSuppressions` adapter) so the RAW report — `ranges` and
 * `warningRecords` included — is available to assert against; the adapted,
 * risk-resolved shape is already covered by `portal-derive-rest.test.ts`.
 */
async function scanFixture(name: string): Promise<SuppressionsReport> {
  const root = path.join(FIXTURES_ROOT, name);
  const graph = await loadPortalGraph(root);
  const repoFiles = await walkPortalFiles(root);
  const knownAspectIds = new Set(graph.aspects.map((a) => a.id));
  const underApproximatingAspectIds = new Set(graph.aspects.filter((a) => a.errs === 'under').map((a) => a.id));
  return runSuppressionsScan(
    root,
    repoFiles,
    knownAspectIds,
    collectMappingEntries(graph),
    underApproximatingAspectIds,
    new Set(),
    graph.config.coverage ?? NO_COVERAGE_EXCLUDED,
  );
}

// The text output for this exact fixture, captured from a real run of
// `yg suppressions` against `portal-suppress-forms`. Each single/disable marker
// names the lines it actually waives (a disable's span comes from
// `report.ranges`); `warningRecords` never reaches the text output.
const GOLDEN_TEXT = `Active suppression markers:

  src/line.ts
    line 2: single(no-todo) → waives line 3  — tracked in TICKET-403, single-line waiver

  src/range.ts
    line 5: disable(no-todo) → waives lines 6-7  — intentional legacy rounding, tracked in TICKET-402
    line 8: enable(no-todo)

  src/under.ts
    line 2: single(no-console) → waives line 3  — debug logging temporarily needed, tracked in TICKET-404

  src/whole.ts
    line 1: file-level(no-todo) → waives lines 2-end of file  — legacy file, whole-file waiver — tracked in TICKET-401

Total: 5 markers across 4 files.

warning[waives-under] yg-suppress(no-console) at src/under.ts:2 waives a check labeled errs: under.
  why:  suppress targets an under-approximating check — such checks produce no false positives by design; either the errs label is wrong or this code path deserves a second look.
  fix:  Remove the waiver and re-examine the flagged code, or correct the aspect's errs label if 'under' is inaccurate.
`;


describe('suppressions --json report fields — real fixture scan (portal-suppress-forms)', () => {
  it('report.ranges matches the real disable/enable pairs: a closed range.ts pair, and whole.ts open at the file head', async () => {
    const report = await scanFixture('portal-suppress-forms');
    expect(report.ranges).toBeDefined();
    const sorted = [...(report.ranges ?? [])].sort((a, b) => a.file.localeCompare(b.file));
    expect(sorted).toEqual([
      { file: 'src/range.ts', aspect: 'no-todo', from: 5, to: 8 },
      { file: 'src/whole.ts', aspect: 'no-todo', from: 1, to: null },
    ]);
    // line.ts and under.ts carry only `single` markers — no disable, no range entry.
    expect(sorted.some((r) => r.file === 'src/line.ts' || r.file === 'src/under.ts')).toBe(false);
  });

  it('every warningRecord carries its finding as structured what / why / next, rendered in the one grammar (one source of classification)', async () => {
    const report = await scanFixture('portal-suppress-forms');
    expect(report.warningRecords).toBeDefined();
    expect(warningTexts(report)).toHaveLength(report.warningRecords!.length);
    report.warningRecords!.forEach((w, i) => {
      expect(w.messageData.what).not.toBe('');
      expect(warningTexts(report)[i].split('\n')[0]).toBe(w.messageData.what);
    });
    // This fixture's only footgun: under.ts's single-line marker waives no-console (errs: under).
    expect(warningTexts(report)).toHaveLength(1);
    expect(report.warningRecords![0]).toMatchObject({
      code: 'waives-under',
      file: 'src/under.ts',
      line: 2,
      aspect: 'no-console',
    });
  });

  it('buildSuppressionsJson(report).totals matches report.totalMarkers and report.fileEntries.length', async () => {
    const report = await scanFixture('portal-suppress-forms');
    const doc = buildSuppressionsJson(report);
    expect(report.totalMarkers).toBe(5);
    expect(report.fileEntries.length).toBe(4);
    expect(doc.totals.markers).toBe(report.totalMarkers);
    expect(doc.totals.files).toBe(report.fileEntries.length);
    expect(doc.totals.fileLevel).toBe(1); // whole.ts's file-head unclosed disable
  });

  it('formatSuppressionsOutput(report) is byte-identical to the golden, naming the lines each marker waives', async () => {
    const report = await scanFixture('portal-suppress-forms');
    expect(formatSuppressionsOutput(report)).toBe(GOLDEN_TEXT);
  });
});
