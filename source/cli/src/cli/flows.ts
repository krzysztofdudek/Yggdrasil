import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { initDebugLog } from '../utils/debug-log.js';
import type { Graph } from '../model/graph.js';

export function formatFlowsOutput(graph: Graph): string {
  if (graph.flows.length === 0) return '';

  const lines: string[] = [];

  for (const flow of graph.flows.sort((a, b) => a.name.localeCompare(b.name))) {
    const displayName = flow.description
      ? `${flow.name} — ${flow.description}`
      : flow.name;
    lines.push(displayName);
    lines.push(`  Participants: ${flow.nodes.length} nodes (${flow.nodes.sort().join(', ')})`);
    if (flow.aspects && flow.aspects.length > 0) {
      lines.push(`  Aspects: ${flow.aspects.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function registerFlowsCommand(program: Command): void {
  program
    .command('flows')
    .description('List flows with participant counts and aspects')
    .action(async () => {
      try {
        const graph = await loadGraph(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false);
        process.stdout.write(formatFlowsOutput(graph));
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          process.stderr.write(
            chalk.red(`Error: No .yggdrasil/ directory found. Run 'yg init' first.\n`),
          );
        } else {
          process.stderr.write(chalk.red(`Error: ${(error as Error).message}\n`));
        }
        process.exit(1);
      }
    });
}
