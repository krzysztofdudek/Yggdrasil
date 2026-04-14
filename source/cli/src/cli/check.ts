import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { initDebugLog } from '../utils/debug-log.js';
import { runCheck } from '../core/check.js';
import type { CheckIssue, CheckResult } from '../core/check.js';
import { execSync } from 'node:child_process';
import path from 'node:path';

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Unified graph gate — errors, drift, coverage, completeness')
    .action(async () => {
      try {
        const cwd = process.cwd();
        const graph = await loadGraph(cwd, { tolerateInvalidConfig: true });
        initDebugLog(graph.rootPath, graph.config.debug ?? false);

        // Get git-tracked files for unmapped-files check
        let gitFiles: string[] | null = null;
        try {
          const projectRoot = path.dirname(graph.rootPath);
          const output = execSync('git ls-files .', {
            cwd: projectRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          gitFiles = output.trim().split('\n').filter(f => f.length > 0);
        } catch {
          // Not a git repo or git not available — skip unmapped-files check
        }

        const result = await runCheck(graph, gitFiles);
        process.stdout.write(formatOutput(result));

        const hasErrors = result.issues.some(i => i.severity === 'error');
        process.exit(hasErrors ? 1 : 0);
      } catch (error) {
        const msg = (error as Error).message;
        if (msg.includes('No .yggdrasil/ directory found') || msg.includes('does not exist')) {
          process.stderr.write(chalk.red(`Error: No .yggdrasil/ directory found. Run 'yg init' first.\n`));
        } else {
          process.stderr.write(chalk.red(`Error: ${msg}\n`));
        }
        process.exit(1);
      }
    });
}

// ── Output formatting ──────────────────────────────────────

export function formatOutput(result: CheckResult): string {
  const lines: string[] = [];

  // Header
  const typeStr = [...result.nodeTypeCounts.entries()]
    .map(([t, c]) => `${c} ${t}`)
    .join(', ');
  const nodeInfo = typeStr ? `${result.nodeCount} nodes (${typeStr})` : `${result.nodeCount} nodes`;
  lines.push(`${result.projectName} — ${nodeInfo}, ${result.aspectCount} aspects, ${result.flowCount} flows`);

  if (result.totalFiles > 0) {
    const pct = Math.round((result.coveredFiles / result.totalFiles) * 100);
    lines.push(`Coverage: ${result.coveredFiles}/${result.totalFiles} source files (${pct}%)`);
  }

  lines.push('');

  // Separate by severity
  const errors = result.issues.filter(i => i.severity === 'error');
  const warnings = result.issues.filter(i => i.severity === 'warning');

  // Code category sets for grouping
  const STRUCTURAL_CODES = new Set(['yaml-invalid', 'type-invalid', 'relation-broken', 'flow-node-broken', 'aspect-undefined', 'overlapping-mapping', 'structural-cycle', 'config-invalid', 'duplicate-aspect-id', 'node-yaml-missing', 'implied-aspect-missing', 'aspect-implies-cycle', 'event-unpaired', 'schema-missing']);
  const ARCHITECTURE_CODES = new Set(['relation-target-forbidden', 'parent-type-forbidden', 'type-undefined', 'port-missing-aspect', 'port-missing-consumes', 'port-undefined', 'consumes-without-ports']);
  const COVERAGE_CODES = new Set(['unmapped-files', 'mapping-path-missing']);
  const COMPLETENESS_CODES = new Set(['description-missing']);

  if (errors.length > 0) {
    lines.push(chalk.red(`Errors (${errors.length}):`));
    lines.push('');

    // Group by category
    const drift = errors.filter(i => i.code === 'source-drift' || i.code === 'unapproved');
    const cascade = errors.filter(i => i.code === 'upstream-drift');
    const structural = errors.filter(i => STRUCTURAL_CODES.has(i.code));
    const architecture = errors.filter(i => ARCHITECTURE_CODES.has(i.code));
    const coverage = errors.filter(i => COVERAGE_CODES.has(i.code));
    const completeness = errors.filter(i => COMPLETENESS_CODES.has(i.code));

    if (drift.length > 0) {
      lines.push('  Drift:');
      for (const issue of sortByNodePath(drift)) {
        const stateMap: Record<string, string> = {
          'ok': 'source drift',
          'missing': 'source missing',
          'unapproved': 'not yet approved',
        };
        const stateLabel = stateMap[issue.lifecycleState ?? ''] ?? 'source drift';
        lines.push(`  ${issue.code} ${issue.nodePath ?? ''} — ${stateLabel}`);
        for (const line of issue.message.split('\n')) {
          lines.push(`       ${line}`);
        }
      }
      lines.push('');
    }

    if (cascade.length > 0) {
      lines.push('  Cascade:');
      // Sort by cause first (group cascades from same source), then by node path
      const sortedCascade = [...cascade].sort((a, b) => {
        const causeA = a.cascadeCauses?.[0]?.description ?? '';
        const causeB = b.cascadeCauses?.[0]?.description ?? '';
        if (causeA !== causeB) return causeA.localeCompare(causeB);
        return (a.nodePath ?? '').localeCompare(b.nodePath ?? '');
      });
      for (const issue of sortedCascade) {
        lines.push(`  ${issue.code} ${issue.nodePath ?? ''} — cascade drift`);
        for (const line of issue.message.split('\n')) {
          lines.push(`       ${line}`);
        }
      }
      // Cascade tree summary
      const causeMap = new Map<string, Set<string>>();
      for (const issue of cascade) {
        for (const cause of issue.cascadeCauses ?? []) {
          const key = cause.description.split('(')[0].trim();
          const nodes = causeMap.get(key) ?? new Set<string>();
          if (issue.nodePath) nodes.add(issue.nodePath);
          causeMap.set(key, nodes);
        }
      }
      if (causeMap.size > 0) {
        lines.push('');
        lines.push(`  Cascade summary: ${causeMap.size} upstream change${causeMap.size === 1 ? '' : 's'} → ${cascade.length} cascaded node${cascade.length === 1 ? '' : 's'}`);
        for (const [cause, nodes] of causeMap) {
          lines.push(`    ${cause} → ${[...nodes].join(', ')}`);
        }
      }
      lines.push('');
    }

    if (structural.length > 0) {
      lines.push('  Structural:');
      for (const issue of sortByNodePath(structural)) {
        lines.push(`  ${issue.code} ${issue.nodePath ?? ''} — ${issue.rule}`);
        for (const line of issue.message.split('\n')) {
          lines.push(`       ${line}`);
        }
      }
      lines.push('');
    }

    if (architecture.length > 0) {
      if (architecture.length > 10) {
        // Summary header — group by unique dangling aspect
        lines.push(`  Architecture (${architecture.length} errors):`);
        const aspectNodes = new Map<string, Set<string>>();
        for (const issue of architecture) {
          const match = issue.message.match(/Aspect '([^']+)'/);
          if (match) {
            const nodes = aspectNodes.get(match[1]) ?? new Set<string>();
            if (issue.nodePath) nodes.add(issue.nodePath);
            aspectNodes.set(match[1], nodes);
          }
        }
        for (const [aspect, nodes] of [...aspectNodes.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 5)) {
          lines.push(`    '${aspect}' not defined — referenced by ${nodes.size} nodes`);
        }
        lines.push('');
      } else {
        lines.push('  Architecture:');
      }
      for (const issue of sortByNodePath(architecture)) {
        lines.push(`  ${issue.code} ${issue.nodePath ?? ''} — ${issue.rule}`);
        for (const line of issue.message.split('\n')) {
          lines.push(`       ${line}`);
        }
      }
      lines.push('');
    }

    if (coverage.length > 0) {
      lines.push('  Coverage:');
      for (const issue of coverage) {
        lines.push(`  ${issue.code} — ${issue.message.split('\n')[0]}`);
        for (const line of issue.message.split('\n').slice(1)) {
          lines.push(`       ${line}`);
        }
      }
      lines.push('');
    }

    if (completeness.length > 0) {
      lines.push('  Completeness:');
      for (const issue of sortByNodePath(completeness)) {
        lines.push(`  ${issue.code} ${issue.nodePath ?? ''} — ${issue.rule}`);
        for (const line of issue.message.split('\n')) {
          lines.push(`       ${line}`);
        }
      }
      lines.push('');
    }
  }

  if (warnings.length > 0) {
    lines.push(chalk.yellow(`Warnings (${warnings.length}):`));
    // Group: Structure (wide-node, high-fan-out) then Other (orphaned-drift-state, orphaned-aspect)
    const structureWarnings = warnings.filter(i => i.code === 'wide-node' || i.code === 'high-fan-out');
    const otherWarnings = warnings.filter(i => i.code !== 'wide-node' && i.code !== 'high-fan-out');
    for (const group of [structureWarnings, otherWarnings]) {
      for (const issue of sortByNodePath(group)) {
        lines.push(`  ${issue.code} ${issue.nodePath ?? ''} — ${issue.rule}`);
        for (const line of issue.message.split('\n')) {
          lines.push(`       ${line}`);
        }
      }
    }
    lines.push('');
  }

  // Result line with category counts
  const errorCount = errors.length;
  const warningCount = warnings.length;

  if (errorCount === 0) {
    if (warningCount > 0) {
      lines.push(chalk.green(`Result: PASS`) + ` (0 errors, ${warningCount} warning${warningCount === 1 ? '' : 's'})`);
    } else {
      lines.push(chalk.green('Result: PASS') + ' (0 errors, 0 warnings)');
    }
  } else {
    const cats: string[] = [];
    const driftCount = errors.filter(i => i.code === 'source-drift' || i.code === 'unapproved').length;
    const cascadeCount = errors.filter(i => i.code === 'upstream-drift').length;
    const structuralCount = errors.filter(i => STRUCTURAL_CODES.has(i.code)).length;
    const archCount = errors.filter(i => ARCHITECTURE_CODES.has(i.code)).length;
    const cov = errors.filter(i => COVERAGE_CODES.has(i.code)).length;
    const comp = errors.filter(i => COMPLETENESS_CODES.has(i.code)).length;
    if (driftCount) cats.push(`${driftCount} drift`);
    if (cascadeCount) cats.push(`${cascadeCount} cascade`);
    if (structuralCount) cats.push(`${structuralCount} structural`);
    if (archCount) cats.push(`${archCount} architecture`);
    if (cov) cats.push(`${cov} coverage`);
    if (comp) cats.push(`${comp} completeness`);
    lines.push(chalk.red(`Result: FAIL`) + ` (${cats.join(', ')} — ${errorCount} error${errorCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'})`);
  }

  // Suggested next command
  if (result.suggestedNext) {
    lines.push('');
    lines.push(`Next: ${result.suggestedNext}`);
  }

  lines.push('');
  return lines.join('\n');
}

function sortByNodePath(issues: CheckIssue[]): CheckIssue[] {
  return [...issues].sort((a, b) => (a.nodePath ?? '').localeCompare(b.nodePath ?? ''));
}
