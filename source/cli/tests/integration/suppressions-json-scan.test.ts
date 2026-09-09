import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { loadPortalGraph, walkPortalFiles, NO_COVERAGE_EXCLUDED } from '../../src/portal/engine-api.js';
import { runSuppressionsScan, formatSuppressionsOutput } from '../../src/portal/api/suppress-scan.js';
import type { SuppressionsReport } from '../../src/portal/api/suppress-scan.js';
import { collectMappingEntries } from '../../src/portal/api/suppress-eligibility.js';
import { buildSuppressionsJson } from '../../src/cli/suppressions.js';

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

// The pre-change text output for this exact fixture, captured from a real run
// of `yg suppressions` against `portal-suppress-forms` before `ranges` and
// `warningRecords` were added to the report — `formatSuppressionsOutput` reads
// neither new field, so this string must stay byte-identical after the change.
const GOLDEN_TEXT = `Active suppression markers:

  src/line.ts
    line 2: single(no-todo)  — tracked in TICKET-403, single-line waiver

  src/range.ts
    line 5: disable(no-todo)  — intentional legacy rounding, tracked in TICKET-402
    line 8: enable(no-todo)

  src/under.ts
    line 2: single(no-console)  — debug logging temporarily needed, tracked in TICKET-404

  src/whole.ts
    line 1: file-level(no-todo)  — legacy file, whole-file waiver — tracked in TICKET-401

Total: 5 markers across 4 files.

Warnings (1):
  yg-suppress(no-console) at src/under.ts:2 waives a check labeled errs: under.
  suppress targets an under-approximating check — such checks produce no false positives by design; either the errs label is wrong or this code path deserves a second look.
  Remove the waiver and re-examine the flagged code, or correct the aspect's errs label if 'under' is inaccurate.
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

  it('report.warningRecords has exactly as many entries as report.warnings, each message identical (one source of classification)', async () => {
    const report = await scanFixture('portal-suppress-forms');
    expect(report.warningRecords).toBeDefined();
    expect(report.warningRecords).toHaveLength(report.warnings.length);
    for (let i = 0; i < report.warnings.length; i++) {
      expect(report.warningRecords![i].message).toBe(report.warnings[i]);
    }
    // This fixture's only footgun: under.ts's single-line marker waives no-console (errs: under).
    expect(report.warnings).toHaveLength(1);
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

  it('formatSuppressionsOutput(report) is byte-identical to the pre-change golden — the text formatter reads neither new field', async () => {
    const report = await scanFixture('portal-suppress-forms');
    expect(formatSuppressionsOutput(report)).toBe(GOLDEN_TEXT);
  });
});
