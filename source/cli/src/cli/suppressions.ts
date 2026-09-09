import { Command } from 'commander';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { walkRepoFiles, NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js';
import { initDebugLog } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { runSuppressionsScan, formatSuppressionsOutput } from '../portal/api/suppress-scan.js';
import type { SuppressionsReport } from '../portal/api/suppress-scan.js';
import { collectMappingEntries, collectTypeCoveredFiles } from '../portal/api/suppress-eligibility.js';
import { scanUncoveredFiles } from '../core/check.js';
import { computeTypeCoverageCached } from '../core/type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import type { Graph } from '../model/graph.js';
import { toPosixPath } from '../utils/posix.js';
import { formatSuppressionsJson, SUPPRESSIONS_JSON_SCHEMA } from '../formatters/suppressions-json.js';
import type { SuppressionsJsonDocument, SuppressionsJsonMarker, SuppressionsJsonRange, SuppressionsJsonWarning } from '../formatters/suppressions-json.js';

/**
 * The type-level classification lattice's `covered` files (coverage.type_level),
 * reduced to the plain path set the suppression eligibility rule needs — mirrors
 * the same per-command hoist `yg impact`/`yg advise`/`yg aspects --health` each do
 * their own. Undefined-flag ⇒ empty set, so a project that never turned the
 * setting on pays no classification cost and the inventory behaves exactly as
 * it always has.
 */
async function computeTypeCoveredFilesForSuppressions(graph: Graph, repoFiles: string[]): Promise<Set<string>> {
  if (!graph.config.coverage?.typeLevel) return new Set();
  const uncovered = scanUncoveredFiles(graph, repoFiles);
  const result = await computeTypeCoverageCached(graph, uncovered, new FileContentCache());
  return collectTypeCoveredFiles(result.covered);
}

// Re-export the relocated scan + formatter so existing importers (and tests) that
// reference them via this command module keep resolving to the same implementation.
export { runSuppressionsScan, formatSuppressionsOutput };

/**
 * Build the `yg-suppressions/1` document from a scan report — pure, no I/O, so
 * it is testable without a scan. Lives here rather than in
 * `formatters/suppressions-json.ts` because it reaches into `SuppressionsReport`
 * (the portal facade's domain type): a `formatter`-type node may only `uses` a
 * plain data type and `calls` a utility, never reach into a facade, so the
 * builder sits in the command layer instead — the same reason `yg aspects
 * --json`'s `buildAspectsJson` lives in `cli/aspects.ts` rather than in
 * `formatters/aspects-json.ts`.
 *
 * `report.fileLevelKeys`, `report.ranges` and `report.warningRecords` are all
 * optional on `SuppressionsReport` (legacy literal test reports may omit them);
 * an absent one is treated as empty here, exactly like the rest of the report
 * already treats an absent `fileLevelKeys`.
 */
export function buildSuppressionsJson(report: SuppressionsReport): SuppressionsJsonDocument {
  const fileLevelKeys = report.fileLevelKeys ?? new Set<string>();
  const ranges = report.ranges ?? [];

  // Keyed by (file, aspect, from) — a disable marker's own line is unique per
  // (file, aspect), so this key can never collide between two distinct disables.
  const rangeByKey = new Map<string, SuppressionsJsonRange>();
  for (const r of ranges) {
    rangeByKey.set(`${r.file} ${r.aspect} ${r.from}`, { from: r.from, to: r.to });
  }

  const markers: SuppressionsJsonMarker[] = [];
  let fileLevelCount = 0;
  for (const { file, markers: fileMarkers } of report.fileEntries) {
    for (const m of fileMarkers) {
      const isFileLevel = fileLevelKeys.has(`${file}:${m.line}`);
      const kind: SuppressionsJsonMarker['kind'] = isFileLevel ? 'file-level' : m.kind;
      if (isFileLevel) fileLevelCount++;

      // A `disable`'s own range (closed or open) — `single`/`enable` never
      // carry one. `file-level` is a classification of a `disable`, so it
      // looks up its range the same way.
      const range: SuppressionsJsonRange | null =
        m.kind === 'disable' ? (rangeByKey.get(`${file} ${m.aspectId} ${m.line}`) ?? null) : null;

      markers.push({
        aspect: m.aspectId,
        file: toPosixPath(file),
        line: m.line,
        kind,
        wildcard: m.wildcard,
        reason: m.reason ? m.reason : null,
        range,
      });
    }
  }

  const warnings: SuppressionsJsonWarning[] = (report.warningRecords ?? []).map((w) => ({
    code: w.code,
    file: toPosixPath(w.file),
    line: w.line,
    aspect: w.aspect,
    message: w.message,
  }));

  return {
    schema: SUPPRESSIONS_JSON_SCHEMA,
    markers,
    warnings,
    totals: {
      markers: report.totalMarkers,
      files: report.fileEntries.length,
      fileLevel: fileLevelCount,
    },
  };
}

/**
 * `yg suppressions` — read-only inventory of active yg-suppress waivers.
 *
 * The scan implementation now lives behind the portal facade
 * (`portal/api/suppress-scan.ts`) so the facade is the single owner of the
 * suppression scan (the portal's live inventory reuses the exact same scan). This
 * command is a thin shell: it loads the graph, walks the repo, runs the relocated
 * scan, and renders its output unchanged. Always exits 0 — purely informational.
 */
export function registerSuppressionsCommand(program: Command): void {
  program
    .command('suppressions')
    .description('Inventory active yg-suppress waivers and warn about footguns')
    .option('--json', `Machine-readable output: one ${SUPPRESSIONS_JSON_SCHEMA} document on stdout instead of the listing.`)
    .action(async (options: { json?: boolean }) => {
      try {
        const cwd = process.cwd();
        const graph = await loadGraphOrAbort(cwd);
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);

        const projectRoot = path.dirname(graph.rootPath);
        const repoFiles = await walkRepoFiles(projectRoot);
        const knownAspectIds = new Set(graph.aspects.map(a => a.id));
        // Aspects whose deterministic check is labeled under-approximating — a
        // waiver targeting one is a footgun the scan flags as a non-blocking warning.
        const underApproximatingAspectIds = new Set(
          graph.aspects.filter(a => a.errs === 'under').map(a => a.id),
        );
        const report = await runSuppressionsScan(
          projectRoot,
          repoFiles,
          knownAspectIds,
          collectMappingEntries(graph),
          underApproximatingAspectIds,
          await computeTypeCoveredFilesForSuppressions(graph, repoFiles),
          graph.config.coverage ?? NO_COVERAGE_EXCLUDED,
        );
        process.stdout.write(options.json === true ? formatSuppressionsJson(buildSuppressionsJson(report)) : formatSuppressionsOutput(report));
        // Always exit 0 — this is a purely informational command
      } catch (error) {
        abortOnUnexpectedError(error, 'scanning suppressions');
      }
    });
}
