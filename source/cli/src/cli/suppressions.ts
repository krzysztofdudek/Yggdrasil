import { Command } from 'commander';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { walkRepoFiles, NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js';
import { initDebugLog } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { runSuppressionsScan } from '../core/suppressions/scan.js';
import type { SuppressionsReport, SuppressionMarkerInfo } from '../core/suppressions/scan.js';
import { collectMappingEntries, collectTypeCoveredFiles } from '../core/suppressions/eligibility.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { count } from '../utils/count.js';
import { scanUncoveredFiles } from '../core/check.js';
import { computeTypeCoverageCached } from '../core/type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import type { Graph } from '../model/graph.js';
import { toPosixPath } from '../utils/posix.js';
import { formatSuppressionsJson, SUPPRESSIONS_JSON_SCHEMA } from '../formatters/suppressions-json.js';
import type { SuppressionsJsonDocument, SuppressionsJsonMarker, SuppressionsJsonRange, SuppressionsJsonWarning } from '../formatters/suppressions-json.js';
import { paint, writeOut } from './output.js';

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

// ── The inventory's words ─────────────────────────────────
//
// The scan is engine code and words nothing: each warning comes back as a
// structured what / why / next. The inventory is rendered here, in the command
// layer, for the same reason the JSON builder below is: it reaches into the
// scan's own report type, which a formatter may not.

/** One scan warning in the CLI's what / why / next grammar — the text the inventory and its JSON both carry. */
export function suppressionWarningText(record: NonNullable<SuppressionsReport['warningRecords']>[number]): string {
  return buildIssueMessage(record.messageData);
}

/**
 * The lines a marker actually waives, as `yg check` resolves them: a single
 * marker waives the next line, or its own line when it trails code; a disable
 * waives from the line after it (its own line when trailing) up to the line
 * before its matching enable (the enable's own line when that trails code), or
 * to the end of the file when nothing closes it. Empty for an enable.
 */
function describeWaivedLines(file: string, m: SuppressionMarkerInfo, report: SuppressionsReport, markers: SuppressionMarkerInfo[]): string {
  const from = m.trailing ? m.line : m.line + 1;
  if (m.kind === 'single') return ` → waives line ${from}`;
  if (m.kind !== 'disable') return '';
  const range = report.ranges?.find((r) => r.file === file && r.aspect === m.aspectId && r.from === m.line);
  if (range === undefined) return '';
  if (range.to === null) return ` → waives lines ${from}-end of file`;
  const enable = markers.find((e) => e.kind === 'enable' && e.aspectId === m.aspectId && e.line === range.to);
  const to = enable?.trailing ? range.to : range.to - 1;
  return to >= from ? ` → waives lines ${from}-${to}` : ' → waives nothing (the enable closes it at once)';
}

/**
 * The `yg suppressions` text inventory. `highlight` decorates the wildcard tag
 * and the warning headings; the command passes the output layer's colour, so
 * this module decides the words and never imports a colour library itself.
 * Left out, the text is plain.
 */
export function formatSuppressionsOutput(report: SuppressionsReport, highlight: (text: string) => string = (text) => text): string {
  const lines: string[] = [];

  if (report.fileEntries.length === 0) {
    lines.push('No active suppression markers found.');
    return lines.join('\n') + '\n';
  }

  // Inventory section
  lines.push('Active suppression markers:');
  lines.push('');

  for (const { file, markers } of report.fileEntries) {
    lines.push(`  ${file}`);
    for (const m of markers) {
      const wildcardTag = m.wildcard ? highlight(' [wildcard]') : '';
      // A file-head unclosed disable renders as the sanctioned whole-file form.
      const isFileLevel = report.fileLevelKeys?.has(`${file}:${m.line}`) ?? false;
      const kindTag = isFileLevel ? 'file-level' : m.kind === 'single' ? 'single' : m.kind === 'disable' ? 'disable' : 'enable';
      const reasonPart = m.reason ? `  — ${m.reason}` : '';
      lines.push(`    line ${m.line}: ${kindTag}(${m.aspectId})${wildcardTag}${describeWaivedLines(file, m, report, markers)}${reasonPart}`);
    }
    lines.push('');
  }

  // Tally
  const fileCount = report.fileEntries.length;
  lines.push(`Total: ${count(report.totalMarkers, 'marker')} across ${count(fileCount, 'file')}.`);

  // Warnings
  // Each warning as a block of the one grammar: `warning[<code>] <what>`,
  // then its labelled why and its fix.
  for (const w of report.warningRecords ?? []) {
    const [what, ...rest] = suppressionWarningText(w).split('\n');
    lines.push('');
    lines.push(highlight(`warning[${w.code}] ${what}`));
    for (const l of rest) {
      lines.push(l.startsWith('next: ') ? `  fix:  ${l.slice('next: '.length)}` : l.startsWith('      ') ? `  ${l}` : l);
    }
  }

  return lines.join('\n') + '\n';
}

// Re-export the scan so existing importers (and tests) that reference it via
// this command module keep resolving to the same implementation.
export { runSuppressionsScan };

/**
 * Build the `yg-suppressions/1` document from a scan report — pure, no I/O, so
 * it is testable without a scan. Lives here rather than in
 * `formatters/suppressions-json.ts` because it reaches into `SuppressionsReport`
 * (the suppression scan's own type): a `formatter`-type node may only `uses` a
 * plain data type and `calls` a utility, never reach into the engine, so the
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
    message: suppressionWarningText(w),
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
 * The scan is the engine's own, the one every surface reads — the portal's
 * live inventory and `yg check`'s reason-less marker warning among them. This
 * command is a thin shell: it loads the graph, walks the repo, runs the scan,
 * and renders it. Always exits 0 — purely informational.
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
        writeOut(options.json === true ? formatSuppressionsJson(buildSuppressionsJson(report)) : formatSuppressionsOutput(report, paint.yellow));
        // Always exit 0 — this is a purely informational command
      } catch (error) {
        abortOnUnexpectedError(error, 'scanning suppressions');
      }
    });
}
