import chalk from 'chalk';
import type { SuppressionMarkerInfo } from '../../ast/suppress.js';
import type { SuppressionsReport } from './suppress-scan.js';

/**
 * portal/api/suppress-format — renders the suppression scan (suppress-scan.ts's
 * `SuppressionsReport`) as the `yg suppressions` text inventory, naming the lines each
 * marker actually waives. Split out of suppress-scan.ts so that scan module stays within its
 * file-size boundary, the same reason suppress-adapt.ts and suppress-coverage.ts were split
 * out; it lives in the same portal facade node as the scan it renders.
 */

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

export function formatSuppressionsOutput(report: SuppressionsReport): string {
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
      const wildcardTag = m.wildcard ? chalk.yellow(' [wildcard]') : '';
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
  lines.push(`Total: ${report.totalMarkers} marker${report.totalMarkers === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'}.`);

  // Warnings
  // Each warning as a block of the one grammar: `warning[<code>] <what>`,
  // then its labelled why and its fix.
  const records = report.warningRecords ?? report.warnings.map((message) => ({ code: '', message }));
  for (const w of records) {
    const [what, ...rest] = w.message.split('\n');
    lines.push('');
    lines.push(chalk.yellow(`warning${w.code !== '' ? `[${w.code}]` : ''} ${what}`));
    for (const l of rest) {
      lines.push(l.startsWith('next: ') ? `  fix:  ${l.slice('next: '.length)}` : l.startsWith('      ') ? `  ${l}` : l);
    }
  }

  return lines.join('\n') + '\n';
}
