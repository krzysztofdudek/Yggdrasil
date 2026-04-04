import { Command } from 'commander';
import { loadGraph } from '../core/graph-loader.js';
import { findYggRoot } from '../utils/paths.js';
import type { Graph } from '../model/types.js';

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
        const yggRoot = await findYggRoot(process.cwd());
        const graph = await loadGraph(yggRoot);
        process.stdout.write(formatFlowsOutput(graph));
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          process.stderr.write(
            `Error: No .yggdrasil/ directory found. Run 'yg init' first.\n`,
          );
        } else {
          process.stderr.write(`Error: ${(error as Error).message}\n`);
        }
        process.exit(1);
      }
    });
}
