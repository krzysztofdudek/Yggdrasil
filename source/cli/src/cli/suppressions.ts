import { Command } from 'commander';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { walkRepoFiles, NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js';
import { initDebugLog } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { runSuppressionsScan, formatSuppressionsOutput } from '../portal/api/suppress-scan.js';
import { collectMappingEntries, collectTypeCoveredFiles } from '../portal/api/suppress-eligibility.js';
import { scanUncoveredFiles } from '../core/check.js';
import { computeTypeCoverage } from '../core/type-coverage.js';
import { FileContentCache } from '../io/file-content-cache.js';
import type { Graph } from '../model/graph.js';

/**
 * The type-level classification lattice's `covered` files (coverage.type_level),
 * reduced to the plain path set the suppression eligibility rule needs — mirrors
 * the same per-command hoist `yg impact`/`yg advise`/`yg aspects --health` each do
 * their own. Undefined-flag ⇒ empty set, so a project that never turned the
 * setting on pays no classification cost and the inventory behaves exactly as
 * it always has.
 */
async function computeTypeCoveredFilesForSuppressions(graph: Graph, gitFiles: string[]): Promise<Set<string>> {
  if (!graph.config.coverage?.typeLevel) return new Set();
  const uncovered = scanUncoveredFiles(graph, gitFiles);
  const result = await computeTypeCoverage(graph, uncovered, new FileContentCache());
  return collectTypeCoveredFiles(result.covered);
}

// Re-export the relocated scan + formatter so existing importers (and tests) that
// reference them via this command module keep resolving to the same implementation.
export { runSuppressionsScan, formatSuppressionsOutput };

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
    .action(async () => {
      try {
        const cwd = process.cwd();
        const graph = await loadGraphOrAbort(cwd);
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);

        const projectRoot = path.dirname(graph.rootPath);
        const gitFiles = await walkRepoFiles(projectRoot);
        const knownAspectIds = new Set(graph.aspects.map(a => a.id));
        // Aspects whose deterministic check is labeled under-approximating — a
        // waiver targeting one is a footgun the scan flags as a non-blocking warning.
        const underApproximatingAspectIds = new Set(
          graph.aspects.filter(a => a.errs === 'under').map(a => a.id),
        );
        const report = await runSuppressionsScan(
          projectRoot,
          gitFiles,
          knownAspectIds,
          collectMappingEntries(graph),
          underApproximatingAspectIds,
          await computeTypeCoveredFilesForSuppressions(graph, gitFiles),
          graph.config.coverage ?? NO_COVERAGE_EXCLUDED,
        );
        process.stdout.write(formatSuppressionsOutput(report));
        // Always exit 0 — this is a purely informational command
      } catch (error) {
        abortOnUnexpectedError(error, 'scanning suppressions');
      }
    });
}
