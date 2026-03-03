import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { detectDrift } from '../core/drift-detector.js';
import type { DriftEntry, DriftReport } from '../model/types.js';

export function registerDriftCommand(program: Command): void {
  program
    .command('drift')
    .description('Detect divergences between graph and mapped files')
    .option('--scope <scope>', 'Scope: "all" or node path', 'all')
    .option('--drifted-only', 'Show only nodes with drift (hide ok entries)')
    .option('--limit <n>', 'Maximum number of entries to show per section', parseInt)
    .action(async (opts: { scope: string; driftedOnly?: boolean; limit?: number }) => {
      try {
        const graph = await loadGraph(process.cwd());
        const rawScope = (opts.scope ?? 'all').trim() || 'all';
        const scope = rawScope === 'all' ? 'all' : rawScope.replace(/^\.\//, '').replace(/\/+$/, '');

        if (scope !== 'all') {
          const node = graph.nodes.get(scope);
          if (!node) {
            process.stderr.write(`Error: Node not found: ${scope}\n`);
            process.exit(1);
          }
          // Check if scope or any descendant has a mapping
          const hasAnyMapping = node.meta.mapping ||
            [...graph.nodes.entries()].some(([p, n]) => p.startsWith(scope + '/') && n.meta.mapping);
          if (!hasAnyMapping) {
            process.stderr.write(`Error: Node has no mapping: ${scope}\n`);
            process.exit(1);
          }
        }

        const scopeNode = scope === 'all' ? undefined : scope;
        const report = await detectDrift(graph, scopeNode);
        printReport(report, opts.driftedOnly ?? false, opts.limit);

        const hasIssues =
          report.sourceDriftCount > 0 ||
          report.graphDriftCount > 0 ||
          report.fullDriftCount > 0 ||
          report.missingCount > 0 ||
          report.unmaterializedCount > 0;
        process.exit(hasIssues ? 1 : 0);
      } catch (error) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
        process.exit(1);
      }
    });
}

function printReport(report: DriftReport, driftedOnly: boolean, limit?: number): void {
  const sourceEntries = classifyForSection(report.entries, 'source', driftedOnly);
  const graphEntries = classifyForSection(report.entries, 'graph', driftedOnly);

  const sourceShown = limit !== undefined ? sourceEntries.slice(0, limit) : sourceEntries;
  const graphShown = limit !== undefined ? graphEntries.slice(0, limit) : graphEntries;

  process.stdout.write('Source drift:\n');
  printSectionEntries(sourceShown, 'source');
  if (limit !== undefined && sourceEntries.length > limit) {
    process.stdout.write(chalk.dim(`  ... ${sourceEntries.length - limit} more (${sourceEntries.length} total)\n`));
  }

  process.stdout.write('\nGraph drift:\n');
  printSectionEntries(graphShown, 'graph');
  if (limit !== undefined && graphEntries.length > limit) {
    process.stdout.write(chalk.dim(`  ... ${graphEntries.length - limit} more (${graphEntries.length} total)\n`));
  }

  // Summary line
  const parts: string[] = [
    `${report.sourceDriftCount} source-drift`,
    `${report.graphDriftCount} graph-drift`,
    `${report.fullDriftCount} full-drift`,
    `${report.missingCount} missing`,
    `${report.unmaterializedCount} unmaterialized`,
  ];

  let summary = `\nSummary: ${parts.join(', ')}`;
  if (driftedOnly && report.okCount > 0) {
    summary += ` (${report.okCount} ok hidden)`;
  } else {
    summary += `, ${report.okCount} ok`;
  }
  process.stdout.write(summary + '\n');
}

/**
 * Classify entries for a given section (source or graph).
 * Source section shows: source-drift, full-drift, missing, unmaterialized, ok
 * Graph section shows: graph-drift, full-drift, ok
 */
function classifyForSection(
  entries: DriftEntry[],
  section: 'source' | 'graph',
  driftedOnly: boolean,
): DriftEntry[] {
  return entries.filter((entry) => {
    if (section === 'source') {
      // Source section: source-drift, full-drift, missing, unmaterialized, ok
      if (entry.status === 'graph-drift') return false;
      if (entry.status === 'ok' && driftedOnly) return false;
      return true;
    } else {
      // Graph section: graph-drift, full-drift, ok
      if (
        entry.status === 'source-drift' ||
        entry.status === 'missing' ||
        entry.status === 'unmaterialized'
      )
        return false;
      if (entry.status === 'ok' && driftedOnly) return false;
      return true;
    }
  });
}

function printSectionEntries(entries: DriftEntry[], section: 'source' | 'graph'): void {
  if (entries.length === 0) {
    process.stdout.write(chalk.dim('  (none)\n'));
    return;
  }

  for (const entry of entries) {
    printEntryLine(entry);
    printChangedFiles(entry, section);
  }
}

function printEntryLine(entry: DriftEntry): void {
  const pad = 13; // width for status label column
  switch (entry.status) {
    case 'ok':
      process.stdout.write(chalk.green(`  ${'[ok]'.padEnd(pad)}${entry.nodePath}\n`));
      break;
    case 'source-drift':
      process.stdout.write(chalk.red(`  ${'[drift]'.padEnd(pad)}${entry.nodePath}\n`));
      break;
    case 'graph-drift':
      process.stdout.write(chalk.magenta(`  ${'[drift]'.padEnd(pad)}${entry.nodePath}\n`));
      break;
    case 'full-drift':
      process.stdout.write(chalk.red(`  ${'[drift]'.padEnd(pad)}${entry.nodePath}\n`));
      break;
    case 'missing':
      process.stdout.write(chalk.yellow(`  ${'[missing]'.padEnd(pad)}${entry.nodePath}\n`));
      break;
    case 'unmaterialized':
      process.stdout.write(chalk.dim(`  ${'[unmat.]'.padEnd(pad)}${entry.nodePath}\n`));
      break;
  }
}

function printChangedFiles(entry: DriftEntry, section: 'source' | 'graph'): void {
  if (!entry.changedFiles || entry.changedFiles.length === 0) return;

  const indent = ' '.repeat(15); // align under node path
  const relevantFiles = entry.changedFiles.filter((f) => {
    if (section === 'source') return f.category === 'source';
    return f.category === 'graph';
  });

  for (const file of relevantFiles) {
    process.stdout.write(chalk.dim(`${indent}${file.filePath}  (changed)\n`));
  }
}
