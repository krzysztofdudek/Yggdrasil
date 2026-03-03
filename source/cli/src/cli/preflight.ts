import { Command } from 'commander';
import { loadGraph } from '../core/graph-loader.js';
import { detectDrift } from '../core/drift-detector.js';
import { validate } from '../core/validator.js';
import { readJournal } from '../io/journal-store.js';
import { findYggRoot } from '../utils/paths.js';
import { normalizeMappingPaths } from '../utils/paths.js';

export function registerPreflightCommand(program: Command): void {
  program
    .command('preflight')
    .description('Unified diagnostic report: journal, drift, status, validation')
    .option('--quick', 'Skip drift detection for faster results')
    .action(async (options: { quick?: boolean }) => {
      try {
        const cwd = process.cwd();
        const graph = await loadGraph(cwd);
        const yggRoot = await findYggRoot(cwd);

        // --- Journal ---
        const journalEntries = await readJournal(yggRoot);

        // --- Drift ---
        const driftedEntries = options.quick
          ? []
          : (await detectDrift(graph)).entries.filter((e) => e.status !== 'ok');

        // --- Status counts ---
        const nodeCount = graph.nodes.size;
        const aspectCount = graph.aspects.length;
        const flowCount = graph.flows.length;
        let mappedPathCount = 0;
        for (const node of graph.nodes.values()) {
          mappedPathCount += normalizeMappingPaths(node.meta.mapping).length;
        }

        // --- Validation ---
        const validation = await validate(graph, 'all');
        const errors = validation.issues.filter((i) => i.severity === 'error');
        const warnings = validation.issues.filter((i) => i.severity === 'warning');

        // --- Build output ---
        const lines: string[] = [];
        lines.push('=== Preflight Report ===');
        lines.push('');

        // Journal section
        if (journalEntries.length === 0) {
          lines.push('Journal:    clean');
        } else {
          lines.push(`Journal:    ${journalEntries.length} pending entries`);
          for (const entry of journalEntries) {
            const target = entry.target ? ` [${entry.target}]` : '';
            lines.push(`            - ${entry.note}${target}`);
          }
        }
        lines.push('');

        // Drift section
        if (options.quick) {
          lines.push('Drift:      skipped (--quick)');
        } else if (driftedEntries.length === 0) {
          lines.push('Drift:      clean');
        } else {
          lines.push(`Drift:      ${driftedEntries.length} nodes need attention`);
          for (const entry of driftedEntries) {
            lines.push(`            - ${entry.nodePath}: ${entry.status}`);
          }
        }
        lines.push('');

        // Status section
        lines.push(
          `Status:     ${nodeCount} nodes, ${aspectCount} aspects, ${flowCount} flows, ${mappedPathCount} mapped paths`,
        );
        if (nodeCount === 0) {
          lines.push('');
          lines.push('            ⚡ No nodes found. Enter BOOTSTRAP MODE:');
          lines.push('            Create nodes under .yggdrasil/model/ for your active work area.');
          lines.push('            See: yg help build-context');
        }
        lines.push('');

        // Validation section
        if (errors.length === 0 && warnings.length === 0) {
          lines.push('Validation: clean');
        } else {
          const parts: string[] = [];
          if (errors.length > 0) parts.push(`${errors.length} errors`);
          if (warnings.length > 0) parts.push(`${warnings.length} warnings`);
          lines.push(`Validation: ${parts.join(', ')}`);
          for (const issue of [...errors, ...warnings]) {
            const code = issue.code ? `[${issue.code}] ` : '';
            const loc = issue.nodePath ? `${issue.nodePath} -> ` : '';
            lines.push(`            - ${code}${loc}${issue.message}`);
          }
        }
        lines.push('');

        process.stdout.write(lines.join('\n'));

        // Exit code: 1 if journal entries, drift, or validation errors exist.
        // Warnings alone do not cause exit 1.
        const hasIssues =
          journalEntries.length > 0 || (!options.quick && driftedEntries.length > 0) || errors.length > 0;
        process.exit(hasIssues ? 1 : 0);
      } catch (error) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
        process.exit(1);
      }
    });
}
