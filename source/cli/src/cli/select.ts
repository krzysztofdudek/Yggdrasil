import { Command } from 'commander';
import { loadGraph } from '../core/graph-loader.js';
import { selectTask } from '../core/node-selector.js';
import type { EnrichedSelectResult, AspectMatch, FlowMatch } from '../core/node-selector.js';
import { findYggRoot } from '../utils/paths.js';

export function registerSelectCommand(program: Command): void {
  program
    .command('select')
    .description('Find graph nodes, aspects, and flows relevant to a task description')
    .argument('<query>', 'Natural-language task description')
    .option('--limit <n>', 'Maximum results per section (nodes, aspects, flows)', '5')
    .action(async (query: string, options: { limit: string }) => {
      try {
        const yggRoot = await findYggRoot(process.cwd());
        const graph = await loadGraph(yggRoot);
        const limit = parseInt(options.limit, 10);
        if (isNaN(limit) || limit < 1) {
          process.stderr.write('Error: --limit must be a positive integer\n');
          process.exit(1);
        }
        const result = selectTask(graph, query, limit);
        process.stdout.write(formatEnrichedResult(result, query));
      } catch (error) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
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
