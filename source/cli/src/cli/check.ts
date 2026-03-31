import { Command } from 'commander';
import { loadGraph } from '../core/graph-loader.js';
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

        // Get git-tracked files for E022
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
          // Not a git repo or git not available — skip E022
        }

        const result = await runCheck(graph, gitFiles);
        formatOutput(result);

        const hasErrors = result.issues.some(i => i.severity === 'error');
        process.exit(hasErrors ? 1 : 0);
      } catch (error) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
        process.exit(1);
      }
    });
}

// ── Output formatting ──────────────────────────────────────

function formatOutput(result: CheckResult): void {
  const lines: string[] = [];

  // Header
  const typeStr = [...result.nodeTypeCounts.entries()]
    .map(([t, c]) => `${c} ${c === 1 ? t : t + 's'}`)
    .join(', ');
  const nodeInfo = typeStr ? `${result.nodeCount} nodes (${typeStr})` : `${result.nodeCount} nodes`;
  lines.push(`${result.projectName} — ${nodeInfo}, ${result.aspectCount} aspects, ${result.flowCount} flows`);

  if (result.totalFiles > 0) {
    const pct = Math.round((result.coveredFiles / result.totalFiles) * 100);
    lines.push(`Coverage: ${result.coveredFiles}/${result.totalFiles} source files (${pct}%)`);
  }
  lines.push(`Health: ${result.healthScore}/100`);
  lines.push('');

  // Separate by severity
  const errors = result.issues.filter(i => i.severity === 'error');
  const warnings = result.issues.filter(i => i.severity === 'warning');

  if (errors.length > 0) {
    lines.push(`Errors (${errors.length}):`);
    lines.push('');

    // Group by category
    const drift = errors.filter(i => i.code === 'E020');
    const cascade = errors.filter(i => i.code === 'E021');
    const structural = errors.filter(i => i.code >= 'E001' && i.code <= 'E013');
    const coverage = errors.filter(i => i.code === 'E022');
    const completeness = errors.filter(i => i.code >= 'E030' && i.code <= 'E041');

    if (drift.length > 0) {
      lines.push('  Drift:');
      for (const issue of sortByNodePath(drift)) {
        // Map DriftStatus to display label per CLI messages spec
        const subtypeMap: Record<string, string> = {
          'source-drift': 'source drift',
          'graph-drift': 'graph drift',
          'full-drift': 'full drift',
          'missing': 'source missing',
          'unmaterialized': 'not yet materialized',
        };
        const subtypeLabel = subtypeMap[issue.driftSubtype ?? ''] ?? issue.driftSubtype ?? '';
        lines.push(`  ${issue.code} ${issue.nodePath ?? ''} — ${subtypeLabel}`);
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
      const causeMap = new Map<string, string[]>();
      for (const issue of cascade) {
        for (const cause of issue.cascadeCauses ?? []) {
          const key = cause.description.split('(')[0].trim();
          const nodes = causeMap.get(key) ?? [];
          if (issue.nodePath) nodes.push(issue.nodePath);
          causeMap.set(key, nodes);
        }
      }
      if (causeMap.size > 0) {
        lines.push('');
        lines.push(`  Cascade summary: ${causeMap.size} upstream change${causeMap.size === 1 ? '' : 's'} → ${cascade.length} cascaded node${cascade.length === 1 ? '' : 's'}`);
        for (const [cause, nodes] of causeMap) {
          lines.push(`    ${cause} → ${nodes.join(', ')}`);
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
    lines.push(`Warnings (${warnings.length}):`);
    // Group: Budget (W001, W002) then Structure (W003, W004) then Other (W005+)
    const budgetWarnings = warnings.filter(i => i.code === 'W001' || i.code === 'W002');
    const structureWarnings = warnings.filter(i => i.code === 'W003' || i.code === 'W004');
    const otherWarnings = warnings.filter(i => i.code >= 'W005');
    for (const group of [budgetWarnings, structureWarnings, otherWarnings]) {
      for (const issue of sortByNodePath(group)) {
        lines.push(`  ${issue.code} ${issue.nodePath ?? ''} — ${issue.rule}`);
        lines.push(`       ${issue.message.split('\n')[0]}`);
      }
    }
    lines.push('');
  }

  // Result line with category counts
  const errorCount = errors.length;
  const warningCount = warnings.length;

  if (errorCount === 0) {
    if (warningCount > 0) {
      lines.push(`Result: PASS (0 errors, ${warningCount} warning${warningCount === 1 ? '' : 's'})`);
      for (const w of warnings.slice(0, 3)) {
        // Compact summary: first line of message truncated to 60 chars
        const firstLine = w.message.split('\n')[0];
        const summary = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
        lines.push(`  ${w.code} ${w.nodePath ?? ''} — ${summary}`);
      }
    } else {
      lines.push('Result: PASS (0 errors, 0 warnings)');
    }
  } else {
    const cats: string[] = [];
    const driftCount = errors.filter(i => i.code === 'E020').length;
    const cascadeCount = errors.filter(i => i.code === 'E021').length;
    const structuralCount = errors.filter(i => i.code >= 'E001' && i.code <= 'E013').length;
    const cov = errors.filter(i => i.code === 'E022').length;
    const comp = errors.filter(i => i.code >= 'E030').length;
    if (driftCount) cats.push(`${driftCount} drift`);
    if (cascadeCount) cats.push(`${cascadeCount} cascade`);
    if (structuralCount) cats.push(`${structuralCount} structural`);
    if (cov) cats.push(`${cov} coverage`);
    if (comp) cats.push(`${comp} completeness`);
    lines.push(`Result: FAIL (${cats.join(', ')} — ${errorCount} error${errorCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'})`);
  }

  // Suggested next command
  if (result.suggestedNext) {
    lines.push('');
    lines.push(`Next: ${result.suggestedNext}`);
  }

  lines.push('');
  process.stdout.write(lines.join('\n'));
}

function sortByNodePath(issues: CheckIssue[]): CheckIssue[] {
  return [...issues].sort((a, b) => (a.nodePath ?? '').localeCompare(b.nodePath ?? ''));
}
