import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraph } from '../core/graph-loader.js';
import { initDebugLog } from '../utils/debug-log.js';
import { selectTask } from '../core/node-selector.js';
import type { EnrichedSelectResult, AspectMatch, FlowMatch } from '../core/node-selector.js';

export function registerSelectCommand(program: Command): void {
  program
    .command('select')
    .description('Find graph nodes, aspects, and flows relevant to a task description')
    .argument('<query>', 'Natural-language task description')
    .option('--limit <n>', 'Maximum results per section (nodes, aspects, flows)', '5')
    .action(async (query: string, options: { limit: string }) => {
      try {
        const graph = await loadGraph(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false);
        const limit = parseInt(options.limit, 10);
        if (isNaN(limit) || limit < 1) {
          process.stderr.write(chalk.red('Error: --limit must be a positive integer\n'));
          process.exit(1);
        }
        const result = selectTask(graph, query, limit);
        process.stdout.write(formatEnrichedResult(result, query));
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

function formatAnnotation(item: AspectMatch | FlowMatch): string {
  const parts: string[] = [];
  if (item.matched) parts.push('matched');
  if (item.nodeCount > 0) parts.push(`${item.nodeCount} node${item.nodeCount === 1 ? '' : 's'}`);
  return parts.length > 0 ? `(${parts.join(', ')})` : '';
}

export function formatEnrichedResult(result: EnrichedSelectResult, query: string): string {
  const lines: string[] = [];
  lines.push(`Results for "${query}":\n`);

  lines.push('Nodes:');
  if (result.nodes.length === 0) {
    lines.push('  (none)');
  } else {
    for (const node of result.nodes) {
      lines.push(`  ${node.node} — ${node.name}`);
    }
  }
  lines.push('');

  lines.push('Aspects:');
  if (result.aspects.length === 0) {
    lines.push('  (none)');
  } else {
    for (const aspect of result.aspects) {
      const ann = formatAnnotation(aspect);
      const parts = [aspect.aspectId];
      if (ann) parts.push(ann);
      const reads = aspect.readPaths.map((p) => `\n    read: ${p}`).join('');
      lines.push(`  ${parts.join(' ')}${reads}`);
    }
  }
  lines.push('');

  lines.push('Flows:');
  if (result.flows.length === 0) {
    lines.push('  (none)');
  } else {
    for (const flow of result.flows) {
      const ann = formatAnnotation(flow);
      const parts = [flow.flowPath];
      if (ann) parts.push(ann);
      lines.push(`  ${parts.join(' ')}\n    read: ${flow.readPath}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
